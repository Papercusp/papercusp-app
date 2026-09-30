/**
 * work_items:claimable — the ONE authoritative "what issue-family work can I actually
 * claim right now" read (work-item-claimability-clarity / claimable-read-tool-and-sql-
 * encapsulation-audit-2026-07-21, P-001).
 *
 * WHY this tool exists: `status='open'` is NOT claimability. The real claim path applies
 * ~12 unconditional floors (taken, claim-hold, needs-human, observation-lane, external
 * blocker, plan-lane reservation, federation, loop-noise, terminal-completion, cross-
 * machine-rig, blocked-dep, release-cooldown), so a hand-rolled `WHERE status='open'`
 * overcounts ~13×. The SSOT floors previously lived only in a SQL VIEW + the scheduler's
 * own miss-diagnosis, so every guidance surface pointed agents at raw `dev:pg_query`
 * (still SQL) — and three surfaces disagreed (8 vs 2 vs 0). This tool wraps the SAME
 * `aggregateIssueClaimExclusions` oracle that `scheduler:get_next`'s miss-path and the
 * fleet drain-stamp already call, plus its companions `listIssueClaimableRows` and
 * `sampleIssueClaimExclusions` (all three built on one shared inner subquery + one shared
 * all-floors-pass predicate), so the count, the row list, the sample, and what `get_next`
 * would actually hand out cannot diverge in what they MEAN.
 *
 * ...and they are read at ONE INSTANT, which is a separate guarantee this originally
 * lacked (WI-5947). The shared predicate makes the three reads semantically identical; it
 * does not make three round-trips atomic. Against a table the fleet is actively claiming
 * from, a row counted by the first query could be gone by the second — surfacing as
 * `claimableCount:1, returned:0` under a limit of 50, which downstream read as a defect in
 * the claim path and instructed an agent to file a bug that did not exist. All three now go
 * through `readIssueClaimability`, one read-only REPEATABLE READ transaction.
 *
 * READ-ONLY: reports claimability; it never claims. Take one with work_items:claim /
 * work_items:claim_next / scheduler:get_next.
 */
import { z } from 'zod';
import { defineTool, readJsonResult } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { readIssueClaimability } from '../../scheduler/get-next';
import { formatLowSeverityShare } from '../../scheduler/admitted-composition-format';
import { planItemLaneBlockReason } from '../../scheduler/plan-item-lane-guard';
import { filingGraceSec } from '../../work-items';
import { potHomeSlugForHarness } from '../../hive-federation';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import {
  getClaimSpecRecord,
  resolveFleetClaimSpec,
  listFleetClaimSpecCandidates,
  resolveClaimSpecWorkspace,
} from '../../scheduler/claim-spec-store';
import { readFleetPauseState } from '../../scheduler/fleet-scope-admission';
import type { ClaimSpec, FilterNode } from '../../scheduler/claim-spec';
import {
  COUNT_EVIDENCE_COMPARISON_RULE,
  COUNT_EVIDENCE_SCHEMA_VERSION,
  type CountContractDimension,
  type CountEvidenceBundle,
  type CountExactness,
} from '../../count-evidence-contract';

const ISSUE_KINDS = ['bug', 'change', 'task'] as const;

export interface ClaimableHarnessScope {
  requested: string;
  resolved: string;
  resolution: 'requested' | 'hive-home';
}

export default defineTool({
  name: 'work_items:claimable',
  profile: 'engineer',
  description:
    // PROMPT-WEIGHT (EI-10966): was 1805 — 205 over the 1600 HARD CAP, redding the green gate
    // and freezing deploys fleet-wide. Trimmed; the detail moved here:
    //   · The full row shape is { id, kind, title, status, severity, plan, featureOrder, createdTs }.
    //   · `status='open'` alone overcounts ~13× — it is not claimability.
    //   · excludedBreakdown buckets OVERLAP, so they never sum to matched − claimable.
    //   · sampleExcluded (1-10) → excludedSample, N ids PER FLOOR, for stale-hold triage without
    //     raw SQL. Raw SQL is the trap it replaces: harness_shared.work_items carries BOTH a
    //     legacy `kind` column and the real discriminator `item_kind`, so a hand-written
    //     kind='bug' filter matches ZERO rows and reads exactly like a drained queue.
    //   · An unrecognized or ambiguous `spec` returns { ok:false, error, candidates } — never a silent
    //     whole-backlog fallback, which would look like a suddenly-huge lane.
    "The authoritative issue-family \"claimable right now\" read — bug/change/task rows surviving the spec filter + all real claim floors, via the SAME oracle scheduler:get_next uses. READ-ONLY. `queueControl` separates active claims, hold-open leases, durable parks, and agent review (overlapping axes); `sampleExcluded` adds provenance, age, and UNPARK-condition detail without changing legacy floor fields.",
  guidance: {
    when: "How many/which issue-family items (bug/change/task) are ACTUALLY claimable — before a drain/wind-down call, a backlog read, or picking work. SSOT, not raw SQL or the claimable view.",
    notWhen:
      "Taking an item → work_items:claim / claim_next / scheduler:get_next (this only reports). Feature-family (F-…) claimability, or a backlog incl. gated rows → work_items:list. `includeObservations` is intentionally unsupported: observation-lane rows are never claimable. Curate them with work_items:list/work_items:search { includeObservations:true }, or pass sampleExcluded here to inspect them under the observationLane exclusion floor.",
    chaining:
      "→ work_items:claim { id } (take a surfaced row) · scheduler:get_next (top-ranked pick).",
    seeAlso: [
      'scheduler:get_next (claims the single top-ranked eligible item — same floors)',
      'work_items:observe (claimability of specific ids you already have)',
    ],
    /**
     * Base-rate stamp (EI-19375528138828761). Both numbers are ALREADY computed
     * here, so this costs nothing: `claimableCount` survived every floor,
     * `matchedByFilter` is what the spec's own filter selected before floors —
     * and floors only ever REMOVE, so population >= matched holds by
     * construction.
     *
     * What it buys: "3 claimable" alone cannot distinguish a nearly-drained
     * lane from a wide lane whose rows are almost all floored out — and those
     * two want opposite actions (wind down vs. fix the floors/spec). The ratio
     * says which. This is the drain-call read, which is exactly where a
     * filtered slice misread as a census is most expensive.
     */
    denominator: (result) => {
      const j = readJsonResult<{ claimableCount?: number; matchedByFilter?: number }>(result);
      // On the MCP transport the envelope may be TOON, where readJsonResult
      // returns undefined (presence.ts documents the same trap). TOON renders
      // nested scalars as `key: N` lines, so fall back to a cheap regex rather
      // than silently never stamping on the most common transport.
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      const read = (key: string, v: number | undefined): number | undefined => {
        if (typeof v === 'number') return v;
        const m = new RegExp(`\\b${key}\\b["']?\\s*:\\s*(\\d+)`).exec(text);
        return m ? Number(m[1]) : undefined;
      };
      const matched = read('claimableCount', j?.claimableCount);
      const population = read('matchedByFilter', j?.matchedByFilter);
      // Self-gate rather than guess: an unreadable envelope is not a zero.
      if (matched === undefined || population === undefined) return null;
      return {
        matched,
        population,
        of: 'in-lane rows the spec filter matched',
        note:
          matched < population
            ? `${population - matched} matched the filter but were removed by claim floors`
            : undefined,
      };
    },
    byRole: {
      mug: {
        when:
          "Before winding a fleet down confirm claimableCount===0 here (the drain-stamp records this oracle); `status='open'` alone risks a premature drain.",
      },
    },
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  // EI-20226779878046151: the claimability oracle owns its store reads and
  // never reads ctx.tx. Avoid retaining the ambient org-app transaction while
  // the multi-floor census runs inside coord:orient.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1).max(80).describe('the harness lane to read claimable issue-family work for'),
    rigAvailable: z
      .boolean()
      .optional()
      .describe(
        'WI-2796: pass true ONLY when you actually have/coordinate a live ≥2-machine or Hetzner federation rig. Default (false/omitted): items tagged payload.needs_2_machine_rig are excluded from this caller\'s claimable read.',
      ),
    kind: z
      .union([z.enum(ISSUE_KINDS), z.array(z.enum(ISSUE_KINDS)).min(1)])
      .optional()
      .describe("restrict to these issue-family kind(s); default all of bug/change/task"),
    spec: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "a fleet's claim-spec scoping the lane (its view.filter + states + rank ordering) — the FLEET SLUG, the spec's own `specId`, or a strict `revN` shorthand when that revision uniquely identifies one live fleet spec (ambiguous/unrecognized values error with candidates; they never silently widen to the whole backlog). Omit ⇒ the caller's effective per-bee/inherited fleet spec, or DEFAULT_CLAIM_SPEC for an unscoped caller.",
      ),
    states: z
      .array(z.string().min(1).max(40))
      .min(1)
      .optional()
      .describe("claimable-status floor override (default: the spec's states, else ['todo']-family claimable states)"),
    limit: z.number().int().positive().max(200).optional().describe('max claimable rows to return (default 20, cap 200)'),
    breakdownOnly: z
      .boolean()
      .optional()
      .describe('skip the row list — return only claimableCount + matchedByFilter + excludedBreakdown (cheaper)'),
    sampleExcluded: z
      .number()
      .int()
      .positive()
      .max(10)
      .optional()
      .describe(
        'also return `excludedSample`: up to this many ids PER FLOOR (taken/claimHold/needsHuman/…, same overlapping-bucket semantics as excludedBreakdown) — the ROW-LEVEL diagnostic companion to the counts, answering "which items" instead of just "how many" without raw SQL. Omit to skip (cheaper — one extra bounded query per call when set).',
      ),
  }),
  async handler(args, ctx) {
    const requestedHarness = args.harness;
    // Issue-family work is stored on the Hive home lane. A member harness is a valid
    // session scope, but passing it directly to the oracle reads an empty sibling lane
    // and makes "wrong scope" indistinguishable from "drained queue" (EI-20683725849634683).
    // Fail open to the requested lane if the resolver cannot answer; the scope envelope
    // still tells the caller exactly which lane was measured.
    let harness = requestedHarness;
    let claimableHarnessScope: ClaimableHarnessScope = {
      requested: requestedHarness,
      resolved: requestedHarness,
      resolution: 'requested',
    };
    try {
      const workspaceId = resolveConcreteWorkspaceId((ctx as { workspaceId?: string | null }).workspaceId);
      const hiveHome = await potHomeSlugForHarness(workspaceId, requestedHarness);
      if (hiveHome) {
        harness = hiveHome;
        claimableHarnessScope = {
          requested: requestedHarness,
          resolved: hiveHome,
          resolution: hiveHome === requestedHarness ? 'requested' : 'hive-home',
        };
      }
    } catch {
      /* Resolver failure must not turn a readable requested lane into a false zero. */
    }
    // The caller identity feeds the release-cooldown + reserved-plan-lane floors exactly
    // as the real claim path resolves them (a row THIS agent just released is on cooldown
    // for it, a plan-lane reserved for it is NOT excluded for it).
    const assignee = resolveAgentIdentity(ctx).ownerId;
    const ws = resolveClaimSpecWorkspace((ctx as { workspaceId?: string | null }).workspaceId);

    // Optionally resolve a fleet claim-spec to scope the lane (filter + states + rank).
    // EI-18672834165659298 / EI-21532823374563677: `args.spec` may be the fleet SLUG,
    // the spec's own specId, or a strict revN shorthand that identifies exactly one live
    // fleet spec. resolveFleetClaimSpec returns null when none match OR revN is ambiguous.
    // A miss is a hard error (candidates included), never a silent fall-through to
    // the whole-backlog DEFAULT_CLAIM_SPEC — that silent widening (safe→unsafe) is exactly
    // the bug this fixes.
    let specFilter: FilterNode | undefined;
    let spec: ClaimSpec | undefined;
    let specStates: readonly string[] | undefined;
    let specProvenance: {
      specId: string;
      revision: number | null;
      source: 'cup' | 'fleet' | 'default';
      fleetSlug?: string;
      matchedBy?: 'fleet-slug' | 'spec-id' | 'revision-shorthand' | 'caller-effective';
    } = {
      specId: 'default-fixed-ordering',
      revision: 0,
      source: 'default',
    };
    let fleetControl: { state: 'active' | 'winding-down'; reason: string | null } = {
      state: 'active',
      reason: null,
    };
    if (args.spec) {
      const resolved = await resolveFleetClaimSpec({ spec: args.spec, workspaceId: ws }).catch(() => undefined);
      if (resolved === undefined) {
        // A genuine lookup failure (e.g. DB hiccup) — distinguish from "no match" below by
        // erroring rather than silently proceeding on an unfiltered lane.
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `failed to resolve claim-spec '${args.spec}' — lookup error, not a not-found; retry`,
              }),
            },
          ],
        };
      }
      if (resolved === null) {
        // EI-21857753284071679: when `args.spec` was a `revN` shorthand, resolveFleetClaimSpec
        // can reject it as AMBIGUOUS (>=2 live fleet specs currently sit at that revision).
        // Show the ACTUAL match set that caused the ambiguity, not the generic
        // most-recently-updated-20 window — otherwise a caller can see only ONE revision-N row
        // in `candidates` (the rest fell outside the recency window) and reasonably conclude the
        // refusal is a bug rather than genuine, correctly-detected ambiguity.
        const revisionMatch = /^rev(\d+)$/i.exec(args.spec);
        const revision = revisionMatch ? Number(revisionMatch[1]) : undefined;
        const candidates = await listFleetClaimSpecCandidates({ workspaceId: ws, revision }).catch(() => []);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error:
                  `no unique fleet or claim-spec named '${args.spec}' found (checked fleet-slug, specId, and ` +
                  `unique revN namespaces) — refusing to fall back to the unfiltered whole-backlog lane. Pass a valid fleet ` +
                  `slug or specId from \`candidates\`, or omit \`spec\` to intentionally read the whole lane.` +
                  (revision !== undefined
                    ? ` \`candidates\` below is filtered to every live fleet spec currently at revision ${revision} — ` +
                      `2+ of them is why the shorthand was rejected as ambiguous.`
                    : ''),
                candidates,
              }),
            },
          ],
        };
      }
      const rec = resolved.record;
      spec = rec.spec;
      specFilter = rec.spec.view.filter;
      specStates = rec.spec.states;
      specProvenance = {
        specId: rec.spec.specId ?? args.spec,
        revision: rec.revision,
        source: rec.source,
        fleetSlug: resolved.fleetSlug,
        matchedBy: resolved.matchedBy,
      };
    } else {
      // scheduler:get_next resolves the caller's per-bee/inherited fleet spec before
      // applying the claim floors. A claimability read that silently falls back to
      // DEFAULT_CLAIM_SPEC answers a different question and can turn a paused/de-scoped
      // fleet lane into a false healthy count (EI-22395160648139412).
      const callerRecord = await getClaimSpecRecord({ cupId: assignee, workspaceId: ws }).catch(() => undefined);
      if (callerRecord === undefined) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'failed to resolve the caller-effective claim spec — lookup error, not a default lane; retry',
              }),
            },
          ],
        };
      }
      if (callerRecord.source === 'default' && callerRecord.fleetSlug) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error:
                  `blocked: caller membership names fleet '${callerRecord.fleetSlug}' but no valid inherited claim spec exists; ` +
                  'refusing to widen claimability to DEFAULT_CLAIM_SPEC during the fleet transition',
                specFallbackReason: 'fleet-transition',
                spec: {
                  specId: callerRecord.spec.specId,
                  revision: callerRecord.revision,
                  source: callerRecord.source,
                  fleetSlug: callerRecord.fleetSlug,
                },
              }),
            },
          ],
        };
      }
      if (callerRecord.source !== 'default') {
        spec = callerRecord.spec;
        specFilter = callerRecord.spec.view.filter;
        specStates = callerRecord.spec.states;
        specProvenance = {
          specId: callerRecord.spec.specId,
          revision: callerRecord.revision,
          source: callerRecord.source,
          ...(callerRecord.fleetSlug ? { fleetSlug: callerRecord.fleetSlug } : {}),
          matchedBy: 'caller-effective',
        };
        if (callerRecord.source === 'fleet' && callerRecord.fleetSlug) {
          const pause = await readFleetPauseState(
            {
              ownerId: assignee,
              fleetSlug: callerRecord.fleetSlug,
              fleetRole: 'member',
              record: callerRecord,
              workspaceId: ws ?? '',
            },
            ws,
          ).catch(() => ({ windingDown: false, reason: null }));
          if (pause.windingDown) {
            fleetControl = { state: 'winding-down', reason: pause.reason };
          }
        }
      }
    }

    // Effective filter = the spec's filter AND (optional) a kind restriction. Both are
    // validated FilterNodes over the closed spec vocabulary, so compileFilter is SQL-safe.
    const kinds = args.kind ? (Array.isArray(args.kind) ? args.kind : [args.kind]) : undefined;
    const kindFilter: FilterNode | undefined =
      kinds && kinds.length > 0
        ? kinds.length === 1
          ? { field: 'kind', op: '=', value: kinds[0]! }
          : { field: 'kind', op: 'in', value: [...kinds] }
        : undefined;
    const filter: FilterNode | undefined =
      specFilter && kindFilter ? { all: [specFilter, kindFilter] } : (specFilter ?? kindFilter);

    // undefined states ⇒ the oracle/lister apply their own ISSUE_FAMILY_CLAIMABLE_STATES default.
    const states = args.states ?? specStates;
    const limit = args.limit ?? 20;
    const filingGraceSeconds = filingGraceSec();

    // ONE read-only REPEATABLE READ snapshot for the counts, the row list, AND the
    // excluded sample (WI-5947). Issued as separate round-trips these observe different
    // snapshots of a concurrently-mutating table, and the response presents them as a
    // single verdict — which is how `claimableCount:1, returned:0` (under a limit of 50)
    // reached a caller and was read as a claim-path defect. A read failure THROWS here
    // rather than degrading to a partial or zeroed reading: "could not measure" must not
    // masquerade as "measured none" when the answer drives a drain/wind-down call.
    const { breakdown, rows: claimableRows, sample: excludedSample, admitted } = await readIssueClaimability(
      filter,
      { harness, states, assignee, rigAvailable: args.rigAvailable, spec },
      { limit, breakdownOnly: args.breakdownOnly, sampleLimit: args.sampleExcluded },
    );

    // EI-21834285144372521: `readIssueClaimability`'s SQL floors (ALL_ISSUE_CLAIM_FLOORS_PASS)
    // have no notion of a plan's PROSE owner-gate ("owner-gated" / "hard-deferred" / … in an
    // item's own text, its plan's `## Now` block, or a linked Decision) — that check only exists
    // as `planItemLaneBlockReason`, run POST-CLAIM by the real scheduler (get-next.ts), which
    // claims the row then immediately releases + retries when the linked plan item reads as
    // owner-gated. `work_items:claimable` is READ-ONLY (it never claims), so it never ran that
    // guard at all: a plan-linked row this caller can never actually keep reported itself as
    // claimable, which is exactly what a drain fleet uses this tool to rule out. Apply the SAME
    // guard here, over the already-bounded (<=200) returned page only — never over the full
    // matched population, which is exactly the unbounded JS-per-row cost the owner_gate_marker
    // column was added (migration 1059) to let a SQL floor avoid; that floor is not wired up yet
    // (tracked separately), so this is the safe, additive fix available without touching the hot
    // claim-candidate SQL every fleet's get_next depends on.
    // WI-7316: `staleBlockedHint` rides along per-row when the lane guard's resolver found a
    // CONTRADICTION on the plan item that excluded it — canonically a stored `blocked` token
    // whose every blocked-by dependency has already resolved. Without it this list says a row
    // was excluded but not that the exclusion is self-inflicted and one `plans:set-status`
    // call from clearing, which is the difference between "wait for the lane" and "fix the
    // lane". Omitted per-row when null, so an ordinary block reads exactly as it does today.
    const ownerGateExcluded: Array<{ id: string; plan: string; reason: string; staleBlockedHint?: string }> = [];
    const claimable: typeof claimableRows = [];
    for (const row of claimableRows) {
      if (!row.plan) {
        claimable.push(row);
        continue;
      }
      // Fails OPEN like every sibling guard in plan-item-lane-guard.ts: a lookup error here
      // must never turn a real claimable row into a false exclusion.
      const block = await planItemLaneBlockReason({ id: row.id, harness, family: 'issue', payload: null }).catch(
        () => null,
      );
      if (block) {
        ownerGateExcluded.push({
          id: row.id,
          plan: row.plan,
          reason: block.reason,
          ...(block.staleBlockedHint ? { staleBlockedHint: block.staleBlockedHint } : {}),
        });
      } else {
        claimable.push(row);
      }
    }
    // Exact when the whole matched population fit in this page (claimable.length < limit, or
    // the SQL count already equalled the page); a monotonic UNDER-correction (never negative,
    // never an over-exclusion) when the page was truncated — some owner-gated rows beyond the
    // page may still inflate the count in that case, which the note below says plainly.
    const correctedClaimableCount = Math.max(0, breakdown.claimable - ownerGateExcluded.length);
    const fleetWindingDown = fleetControl.state === 'winding-down';
    const effectiveClaimableCount = fleetWindingDown ? 0 : correctedClaimableCount;
    const effectiveClaimableRows = fleetWindingDown ? [] : claimable;
    // WI-7316: the "lane reads as drained when it isn't" case. The per-row hint already rides
    // on `ownerGateExcluded` above — but the field a caller ACTS on is `claimableCount`, and a
    // bare `0` gives them no reason to go read an exclusion list at all. That is exactly the
    // trap EI-19397307303043951 diagnosed at the plans:get-item/plans:lint layer and left open
    // here: a member polling by claim-spec calls neither of those tools, so the one surface it
    // does read must say plainly that the emptiness is self-inflicted. Escalated wording only
    // when nothing at all came back — a partially-drained lane still reports it, quietly.
    const staleBlockedExcluded = ownerGateExcluded.filter((r) => r.staleBlockedHint);
    const staleBlockedNote =
      staleBlockedExcluded.length === 0
        ? ''
        : (claimable.length === 0
            ? ` ⚠ NOT DRAINED — this empty result is self-inflicted: `
            : ` ⚠ `) +
          `${staleBlockedExcluded.length} of the ${ownerGateExcluded.length} excluded row(s) are gated by a plan item ` +
          `whose blockers have ALREADY resolved (a sticky stored 'blocked' token, not a live blocker): ` +
          staleBlockedExcluded
            .slice(0, 3)
            .map((r) => `${r.id} — ${r.staleBlockedHint}`)
            .join('; ') +
          (staleBlockedExcluded.length > 3 ? `, +${staleBlockedExcluded.length - 3} more` : '') +
          `. Each clears with one plans:set-status on the named plan item; do NOT read this as a drained lane (WI-7316).`;

    // count-contract-clarity P-002: every quoted number carries the identity that
    // makes it comparable (or not). `breakdown.claimable` is exact in SQL, but the
    // post-SQL plan-prose guard can inspect only the returned page. If that page did
    // not cover every SQL-admitted row, the corrected value is an honest UPPER bound
    // rather than a fabricated exact count.
    const planProseScanComplete = breakdown.claimable <= claimableRows.length;
    const claimableExactness: CountExactness = fleetWindingDown || planProseScanComplete
      ? { status: 'exact' }
      : {
          status: 'bounded',
          bound: 'upper',
          limit,
          reason: args.breakdownOnly
            ? 'breakdownOnly skipped the row-bounded plan-prose guard'
            : `the plan-prose guard inspected ${claimableRows.length} of ${breakdown.claimable} SQL-admitted rows`,
        };
    const measuredAt = new Date().toISOString();
    const claimSpecSelector: Record<string, CountContractDimension> = {
      specId: specProvenance.specId,
      revision: specProvenance.revision,
      source: specProvenance.source,
    };
    if (specProvenance.fleetSlug) claimSpecSelector.fleetSlug = specProvenance.fleetSlug;
    if (specProvenance.matchedBy) claimSpecSelector.matchedBy = specProvenance.matchedBy;
    const countEvidence = {
      contract: {
        schemaVersion: COUNT_EVIDENCE_SCHEMA_VERSION,
        population: {
          id: 'current-claim-spec-issue-work-items',
          selector: {
            claimSpec: claimSpecSelector,
            filter: (filter ?? null) as CountContractDimension,
            kinds: kinds ?? [...ISSUE_KINDS],
            states: states ? [...states] : 'default-issue-family-claimable-states',
          },
          definition:
            'current issue-family work-item rows in the resolved harness that match the named claim-spec/kind filter',
        },
        cutoff: { kind: 'none' },
        writer: {
          id: 'readIssueClaimability+planItemLaneBlockReason',
          revision: 'repeatable-read-plus-bounded-plan-prose-guard-plus-fleet-control-v2',
        },
        unit: {
          id: 'canonical-work-item',
          definition: 'distinct canonical issue-family work-item ids',
        },
        scope: {
          requestedHarness: claimableHarnessScope.requested,
          resolvedHarness: claimableHarnessScope.resolved,
          harnessResolution: claimableHarnessScope.resolution,
          caller: assignee,
          callerRelative: true,
          filingGraceSeconds,
          rigAvailable: args.rigAvailable === true,
          planProseScanComplete,
          fleetControl,
        },
        measuredAt,
        comparisonRule: COUNT_EVIDENCE_COMPARISON_RULE,
      },
      metrics: {
        claimable: {
          value: effectiveClaimableCount,
          metric: {
            id: 'claimable-count',
            definition:
              'rows surviving the caller-effective spec filter, every scheduler hard floor, the measured plan-prose guard, and the fleet new-work control gate',
          },
          status: {
            id: 'claimable-for-caller',
            definition:
              'claimable now for the named caller under its cooldown, filing grace, rig, reserved-lane, and fleet-control context',
          },
          exactness: claimableExactness,
          zeroMeaning:
            'this live selector has no rows claimable for this caller at measuredAt; it does not mean a fixed batch completed or the harness backlog is empty',
        },
        matchedByFilter: {
          value: breakdown.matchedByFilter,
          metric: {
            id: 'matched-by-filter-count',
            definition: 'rows selected by the claim-spec/kind filter before scheduler hard floors',
          },
          status: {
            id: 'filter-match-before-floors',
            definition: 'in the selected population regardless of claimability floors',
          },
          exactness: { status: 'exact' },
          zeroMeaning:
            'the live filter matched no issue-family rows at measuredAt; it does not certify completion of any separately defined cohort',
        },
      },
    } satisfies CountEvidenceBundle;

    const payload = {
      ok: true as const,
      harness,
      claimableHarnessScope,
      /** Claimability includes caller-relative release cooldown and filing grace. A fleet
       * leader must not treat this caller's count as every peer's immediately-ready count. */
      claimableCallerScope: {
        assignee,
        callerRelative: true,
        filingGraceSeconds,
        peerReadinessMayDiffer: filingGraceSeconds > 0,
      },
      /** The authoritative count: rows passing spec_match AND every claim floor, MINUS any
       *  plan-linked row this page found to be owner-gated in plan prose (EI-21834285144372521;
       *  see ownerGateExcluded below) — exact when `returned < limit`; a safe under-correction
       *  (never an over-exclusion) when the page was truncated. */
      claimableCount: effectiveClaimableCount,
      /** EI-18835176695181727: alias of `claimableCount`. Sibling read tools (e.g.
       *  dev:pg_query) return `{ rows, count }`; a caller who guesses that shape here
       *  instead of `{ claimable, claimableCount }` gets `undefined`-keyed access —
       *  which silently yields `[]`/`0`, not an error, and `0` reads as "queue drained"
       *  at exactly the moment a drain/wind-down call is made on it. Purely additive. */
      count: effectiveClaimableCount,
      /** In-lane issue-family rows the spec's own filter matched, BEFORE floors. */
      matchedByFilter: breakdown.matchedByFilter,
      /** Self-identifying count contracts. Materialize one metric through
       * `materializeCountEvidence` before comparing it with another observation. */
      countEvidence,
      /** EI-16028: coverage of the affinity rank term's item-side path metadata over the
       * full claimable survivor set (never the returned, LIMIT-capped page). */
      affinityCoverage: breakdown.affinityCoverage,
      returned: effectiveClaimableRows.length,
      claimable: effectiveClaimableRows,
      /** EI-18835176695181727: alias of `claimable` — see `count` above. */
      rows: effectiveClaimableRows,
      /** Per-floor stranding counts (INDEPENDENT/overlapping — they do NOT sum). */
      excludedBreakdown: breakdown.excluded,
      /** P-018: additive, independent queue-control axes. A row may appear on more
       * than one axis; this is intentionally not a partition. */
      queueControl: breakdown.queueControl,
      /** WI-6673: what the admitted set is MADE OF — byKind, bySeverity, lowSeverityShare,
       *  degenerate, peakDay. The counterpart to excludedBreakdown (what was REJECTED).
       *  Always present, because the failure this prevents is a caller quoting the count
       *  without having thought to ask what is in it. */
      admittedBreakdown: admitted,
      /** Only present when `sampleExcluded` was passed: up to that many ids PER FLOOR
       *  (same overlapping-bucket semantics as excludedBreakdown) — which rows, not just
       *  how many. */
      ...(excludedSample ? { excludedSample } : {}),
      /** Plan-linked rows this page found to be owner-gated in plan PROSE (an item's own text,
       *  its plan's `## Now` block, or a linked Decision) — the same check the real scheduler
       *  runs post-claim, applied here read-only so this tool never reports a row as claimable
       *  that a real claim would immediately release. Only present when non-empty. */
      ...(ownerGateExcluded.length > 0 ? { ownerGateExcluded } : {}),
      spec: specProvenance,
      ...(fleetWindingDown
        ? {
            fleetControl: {
              state: 'winding-down',
              reason: fleetControl.reason,
              newWork: 'blocked',
            },
          }
        : {}),
      states: states ? [...states] : null,
      note:
        '`claimableCount` is authoritative for THIS CALLER (spec_match AND all ~12 floors, MINUS any plan-prose owner-gated row this page detected — the SAME oracle scheduler:get_next runs, plus the post-claim plan-lane guard it also applies). Caller-relative release cooldown and filing grace mean another fleet member may have a different total; a fresh row is visible to its filer before peers for up to ' +
        `${filingGraceSeconds}s. excludedBreakdown buckets OVERLAP, so they do NOT sum to matched−claimable. READ ONLY — nothing was claimed; take one via work_items:claim / scheduler:get_next.` +
        (fleetWindingDown
          ? ` ⚠ FLEET WINDING DOWN${fleetControl.reason ? `: ${fleetControl.reason}` : ''} — the caller-effective spec is still reported above, but fleet control blocks NEW work, so claimableCount/rows are forced to zero; matchedByFilter is diagnostic only.`
          : '') +
        // WI-7316: leads the warning block on purpose — it is the only one that changes the
        // reader's CONCLUSION about an empty result rather than qualifying a number in it.
        staleBlockedNote +
        (ownerGateExcluded.length > 0 && claimableRows.length >= limit
          ? ` ⚠ This page was truncated at limit=${limit} — ${ownerGateExcluded.length} owner-gated row(s) were excluded from THIS page, but the matched population beyond it was not checked, so claimableCount can still be an OVER-count if more owner-gated rows exist past the page.`
          : '') +
        (breakdown.affinityCoverage.belowFloor
          ? ` ⚠ AFFINITY PATH COVERAGE WARNING: ${breakdown.affinityCoverage.nonEmptyPaths}/${breakdown.affinityCoverage.denominator} claimable row(s) carry non-empty payload.paths, below the ${Math.round(breakdown.affinityCoverage.floor * 100)}% floor; affinity ranking is under-informed (EI-16028).`
          : '') +
        (admitted.degenerate
          ? ` ⚠ COMPOSITION WARNING: ${formatLowSeverityShare(admitted, 'row(s) in this lane')}` +
            (admitted.peakDay ? `, and ${admitted.peakDay.count} of them were filed on a single day (${admitted.peakDay.day})` : '') +
            `. A count this size is NOT a workload — read admittedBreakdown before quoting it as one (WI-6673).`
          : ''),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
