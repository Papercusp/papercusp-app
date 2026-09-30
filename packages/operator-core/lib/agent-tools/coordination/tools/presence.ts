/**
 * coord:presence — list active coordination agents and what they are
 * doing right now.
 *
 * Joins the live liveness layer (harness_shared.coord_presence) with
 * the durable record (harness_shared.power_user_sessions). Sessions
 * whose heartbeat is older than 10 min are returned in `stale`, not
 * `active`. agent-coordination-architecture-v2 §4.2 / §4.3.
 *
 * The scope-resolution + snapshot assembly live in `../presence-snapshot`
 * (shared with the coord:inbox P-010 re-bootstrap, so both read the SAME
 * hive-scoped roster); this tool is the thin read surface over it.
 */

import { z } from 'zod';
import { defineTool, readJsonResult, type SeeAlsoEntry } from '@papercusp/agent-mcp';
import { resolvePresenceScope, assemblePresenceSnapshot } from '../presence-snapshot';
import { readIdentity } from '../../locks/identity';
import { resolveSelfRef, markSelfRows } from '../self-marker';
import { shapeCoordPresence } from './presence-shape';
import { normalizeFullPresenceRows } from '../presence-payload';
import { COORD_ROLES } from '../roles';
import { getModesForOwners } from '../../../modes/store';
import { modeRegistrationLive } from '../../../modes/liveness';
import { classifyCoordDeafness, coordDeafBudgetMs, lastInboxReadAtBatch } from '../inbox-read-freshness';
import { listParkedAwaitsForSubscribers } from '../../../events/await/store';
import { buildParkedOnMap } from '../../fleet/assignments';
import { overlayPresenceCursors } from '../presence-cursor-overlay';
import { listCouplingsFor, resolveCoupledPeers } from '../../../coord/couplings';
import { buildCoupledExpansion } from '../../../coord/coupled-expansion';
import { deriveCouplings } from '../../../coord/coupling-derivation';
import { censusObserverFor } from '../../../coord/derived-signal-census';
import { couplingSourcesFor, presenceNeedsCoordinationDomain } from '../coupling-sources';
import { buildDispatchHandle, type DispatchCandidate } from '../dispatch-handle';

export default defineTool({
  name: 'coord:presence',
  description:
    "List the live coordination roster and who can take work. Read summary.wakeable plus row sessionState/wakeable; ended rows require targeting. Default scope is your Hive; use scope/pot for explicit scope. `owner`/`ownerId` targets one agent; `owners`/`ownerIds` a bounded set. In a hive-scoped SU session, scope:'workspace'/all returns hive_forbidden (use targeted owner); workspace-wide browsing needs an unscoped/admin session. Broad census: coord:roster { view:'live', project:'ids' }. Plan-scoped claims: coord:roster { view:'claims', plan } or fleet:assignments { plan }; fleet-scoped roster: fleet:assignments { fleet }. Legacy harness, plan, fleet, hive, agent, includeStale, and include_stale keys are invalid. Use since:<etag> for cheap unchanged reads.",
  guidance: {
    when: "Use before dispatch or handoff. Choose a parked + wakeable row. Before taking over draining/suspect rows, send a required coord:send wake and inspect its result; ended rows need relaunch. `recorded` is ALIVE but unwakeable (no control hook): judge it by lastActiveSecAgo, not a wake — its silence there is structural, so taking one over can duplicate a live lane.",
    notWhen:
      'Not for file ownership (locks:queue), historical ended-agent dumps, or every-turn polling when coord deltas suffice. Presence reports liveness, not file activity; use locks:queue plus git status/file mtimes to see who edits files.',
    chaining: 'Read once and follow coord deltas; if repolling, pass since:<etag> for a tiny unchanged stub.',
    // EI-21482956761170053 / EI-21474470155153658: the description above already names these
    // keys as invalid, but a description is not on the failure the agent is holding — the same
    // lesson code:run's clamp disclosure records (agent-tools/code/run.ts). Both filings passed
    // `harness` (one with `include_stale` + `limit`, one with `ownerIds`) and got back only the
    // generic key list plus a string-distance guess of `scope` — which is WORSE than silence
    // here: `scope` is an enum of hive|workspace|all, so a caller who follows it sends
    // `scope:'papercusp'` and fails a SECOND time on the enum. An authored redirect outranks
    // and suppresses that guess (invalidInputCorrections), so each key now answers with the
    // remedy the description states in prose. Zero prompt weight — argRedirects is excluded
    // from the projected tool text and is paid only on the failure path.
    // ⚠ Measured 2026-09-02: this tool projects 1466 chars against a 1500 budget — 34 chars
    // of headroom, after the same-day compression that already trimmed the description once.
    // Adding a sentence up there will breach the gate; add it HERE instead, where it costs
    // nothing and reaches the caller at the moment they actually get it wrong.
    argRedirects: {
      harness: {
        tool: 'coord:presence',
        args: { pot: '<hive-slug>' },
        note: 'coord:presence scopes by HIVE, not harness — a harness slug is not a scope selector. `pot` takes the explicit hive slug (implies scope=hive); omit it entirely to use your own hive, which is already the default. Do NOT reach for `scope`: it is an enum of hive|workspace|all, not a slug',
      },
      // Exact synonyms of a declared key: the terse string form renders "pass it as `X` instead".
      hive: 'pot',
      agent: 'owner',
      includeStale: 'owner',
      // EI-21480522630558604: a caller wanting a BOUNDED multi-owner lookup reached for
      // `items:[<ownerIds>]` — the work_items family's collection key — and, with no
      // redirect declared, got the corrected-call machinery's "this tool declares no
      // counterpart — the fix is to drop it, not to look for a synonym". Here that is the
      // opposite of the truth: `owners` IS the counterpart, and for want of it that filing
      // fell back to one call per owner, which is exactly the response-budget truncation
      // `owners` exists to prevent.
      items: 'owners',
      include_stale: {
        tool: 'coord:presence',
        args: { owner: '<agent-id>' },
        note: 'the full stale-roster dump was REMOVED, not renamed — `owner` (or `owners:[...]` for a bounded set) is its replacement and returns the row even when that agent is `ended`. Use it to inspect or wake ONE known-dead agent; there is no supported way to expand the whole stale roster',
      },
      includeEnded: {
        tool: 'coord:presence',
        args: { owner: '<agent-id>' },
        note: '`includeEnded` is not a supported filter — targeted `owner`/`owners` lookups already include ended rows. Pass `owner:<agent-id>` (or `owners:[...]`) without `includeEnded`',
      },
      limit: {
        tool: 'coord:roster',
        args: { view: 'live', project: 'ids' },
        note: 'coord:presence is a scope-bounded VIEW, not a paged query surface — narrow it with owner/owners/pot rather than a row cap. A broad census belongs in coord:roster, which projects ids cheaply',
      },
      sessionState: {
        tool: 'coord:roster',
        args: { view: 'live', states: ['live'], project: 'liveness' },
        note: 'coord:presence returns sessionState on each row but does not filter by it. Use coord:roster with states:["live"] (or the desired state) to filter the live view.',
      },
      plan: {
        tool: 'coord:roster',
        args: { view: 'claims', plan: '<plan-slug>' },
        note: 'presence reports liveness, not claims — plan-scoped claim ownership is coord:roster { view:\'claims\', plan } or fleet:assignments { plan }',
      },
      fleet: {
        tool: 'fleet:assignments',
        args: { fleet: '<fleet-slug>' },
        note: 'fleet membership + per-member lanes live in fleet:assignments; coord:presence has no fleet selector',
      },
    },
    // EI-13298: the roster array lives at the TOP-LEVEL key `active` — an agent guessing
    // `p?.agents || p?.presence || (Array.isArray(p) ? p : [])` in a code:run script misses
    // it entirely and silently gets `[]` (a live incident: 35 active agents read back as
    // "no defect... wait, zero agents", which was then nearly reported to the owner as a
    // coordination-layer bug). `summary.active` is a COUNT, not the roster — do not confuse
    // the two `active` keys at different nesting levels.
    // EI-21845811145701209: the guess recurred (agents/rows/roster/live all tried, all
    // silently []) despite the description above already naming `active` — so `agents`
    // is now a real alias of `active` (same array, same reference), not just documented.
    returns:
      "{ summary: { active: number (COUNT), byState, wakeable, ... }, active: AgentRow[] (the roster), agents: AgentRow[] (SAME array as `active` — an alias, kept for readers who guess this name; use either), activeTruncated?, self?, etag, as_of, scope }. A capped active[] cannot prove absence; target that owner instead. A since hit returns { unchanged:true, etag, as_of, scope, note }. Unless include_coupling:false, expanded[] appends reader-relative coupled peers without changing active — it is the NARROW coupled-peers subset, not the roster, and it is not etag-tracked. expanded.intent is declared intent, not a goal.",
    // Result-aware (D-003): the who-was-ever-here history pointer surfaces with the
    // REAL ended count ONLY when the roster has dead sessions — the "N ended → history"
    // discovery pointer WI-1348 asks for. The adjacent-lens pointers are always
    // relevant, so they stay static in the returned list.
    seeAlso: (result) => {
      const j = readJsonResult<{ summary?: { byState?: { ended?: number } } }>(result);
      // seeAlso runs on the SERIALIZED result — on the MCP transport the {data}
      // envelope may be TOON (readJsonResult → undefined). TOON renders nested
      // scalars as `ended: N` lines, so a cheap regex keeps the conditional
      // pointer alive on compact responses too (fail-open to 0).
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      const ended = j?.summary?.byState?.ended ?? Number(/\bended\b["']?\s*:\s*(\d+)/.exec(text)?.[1] ?? 0);
      // NB coord:dispatch is deliberately NOT listed here any more (P-012): this
      // read now returns a ready `dispatch` CALL in its payload when one is
      // resolvable. Re-adding the mention would restore the 1.7% mechanism the
      // handle replaced, and would advertise the verb in exactly the cases where
      // the handle correctly declined to (no lane / no wakeable peer).
      const out: SeeAlsoEntry[] = [
        'coord:roster { view:"live" } (the unified presence/roster door with lenses)',
        'coord:glance (one-line fleet headline for a status surface)',
      ];
      if (ended > 0) {
        out.push({
          tool: 'coord:roster',
          selector: '{ view:"history" }',
          reason: `${ended} ended — who-was-ever-here`,
        });
      }
      return out;
    },
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    scope: z
      .enum(['hive', 'workspace', 'all'])
      .optional()
      .describe(
        "hive (DEFAULT) = your Hive's agents + federated peers for it; workspace = the whole workspace, but only from an unscoped/admin session (a hive-scoped SU session gets hive_forbidden — use owner for one workspace peer); all = every workspace (unscoped admin/Mug). A caller with no Hive (SU/operator) falls back to workspace.",
      ),
    pot: z
      .string()
      .optional()
      .describe('Explicit Hive slug to scope to (overrides caller-hive resolution; implies scope=hive).'),
    workspace: z.string().optional().describe("Workspace id for workspace/hive scope; omit to use the caller's."),
    owner: z
      .string()
      .optional()
      .describe(
        'TARGETED lookup: return ONLY the row(s) matching this agent id/label (exact, else a substring either-way) — and INCLUDE it even if `ended`. The replacement for the removed `include_stale` full dump: use it to inspect/wake ONE specific dead agent, never to expand the whole stale roster.',
      ),
    ownerId: z
      .string()
      .optional()
      .describe(
        'Compatibility alias for `owner` for callers using the roster row field name; normalized to the canonical `owner` selector before lookup. Pass `owner` OR `ownerId`, not both, and do not combine either with `owners`.',
      ),
    owners: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .optional()
      .describe(
        'BOUNDED TARGETED lookup: return the union of rows matching these agent ids/labels, including ended rows. Use for an explicit dependency/holder set so response-budget truncation cannot omit a requested owner. Mutually exclusive with owner.',
      ),
    ownerIds: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .optional()
      .describe(
        'Compatibility alias for `owners` for callers using the roster row field name (mirrors the ownerId → owner singular alias). Normalized to the canonical `owners` selector before lookup. Pass `owners` OR `ownerIds`, not both, and do not combine either with `owner`/`ownerId`.',
      ),
    include_detail: z
      .boolean()
      .optional()
      .describe(
        "P-011 Tier-2/3 detail: add each agent's `heldFiles` (its live file-lock nodes, read from the separate papercusp_su lock DB — opt-in + fail-soft). Off by default; the lean roster already carries the Tier-1 scalars.",
      ),
    include_cursor: z
      .boolean()
      .optional()
      .describe(
        "ambient-semantic-push P-002: add each active agent's `cursor` — the top terms of its current lexical cursor (what it is working on, mined from its own journal), data-not-directive. Opt-in + fail-soft + snapshot-only (never a [coord+N] delta). DEFAULT-OFF and additionally gated by the PAPERCUSP_AMBIENT_CURSOR feature flag; absent unless both are on.",
      ),
    include_coupling: z
      .boolean()
      .optional()
      .describe(
        "ON BY DEFAULT — pass false to suppress. Appends `expanded[]`: the peers YOU are coupled to (coord:couple + signals derived from the roster you are already being sent), each with `expandedBecause`, their declared intent and staleness. Fail-soft. The base roster is byte-identical either way (D-053): coupling decides only who appears in the appended block, never what the base rows contain. A coupled peer outside this read's scope appears with inRoster:false and null state — coupling re-ranks what you can already see, it never widens it. Passing TRUE explicitly also arms the QUERYING signals (lock holds), which need the coordination domain.",
      ),
    since: z
      .string()
      .optional()
      .describe(
        "CHEAP UNCHANGED-READ (poll-storm guard): pass the `etag` from your PRIOR coord:presence read. If the roster's identity+state (intent / plan / claimed lane / await / fleet membership — NOT liveness) is unchanged, you get back a ~100B `{ unchanged:true, etag, as_of }` instead of the full 20KB roster. Read once, then re-read with `since:<etag>` and only pay the full payload when it actually changed. Liveness (live↔parked, lastActiveSecAgo) is deliberately NOT tracked by the etag — re-read WITHOUT `since:` right before you actually dispatch.",
      ),
  }).superRefine((args, issue) => {
    if (args.owner && args.ownerId) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerId'],
        message: 'Pass owner (the canonical selector) OR ownerId (the compatibility alias), not both.',
      });
    }
    if ((args.owner || args.ownerId) && args.owners?.length) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['owners'],
        message: 'Pass owner (or ownerId as its compatibility alias) for one target OR owners for a bounded target set, not both.',
      });
    }
    if ((args.owner || args.ownerId) && args.ownerIds?.length) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerIds'],
        message:
          'Pass owner (or ownerId as its compatibility alias) for one target OR ownerIds (the compatibility alias for owners) for a bounded target set, not both.',
      });
    }
    if (args.owners?.length && args.ownerIds?.length) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerIds'],
        message: 'Pass owners (the canonical bounded selector) OR ownerIds as its compatibility alias, not both.',
      });
    }
  }),
  result: z
    .object({
      summary: z.unknown().optional(),
      active: z.array(z.unknown()).optional(),
      agents: z.array(z.unknown()).optional(),
      // The tier shaper emits a structured disclosure object when it caps the
      // roster (see presence-shape.ts). Keep the advertised/structured result
      // schema aligned with that shaped payload; declaring this as boolean
      // makes MCP clients reject otherwise valid large-roster reads.
      activeTruncated: z
        .object({
          shown: z.number(),
          censusCount: z.number(),
          truncatedByLimit: z.literal(true),
          limit: z.number(),
          reason: z.literal('response_budget').optional(),
          more: z.string(),
        })
        .optional(),
      self: z.unknown().optional(),
      etag: z.string().optional(),
      as_of: z.string().optional(),
      scope: z.unknown().optional(),
      unchanged: z.boolean().optional(),
      note: z.string().optional(),
      expanded: z.array(z.unknown()).optional(),
      dispatch: z.unknown().optional(),
    })
    .passthrough(),
  // context-trimming-tiers P-022: trimmed/standard sessions get projected roster
  // rows (dispatch core only — see presence-shape.ts); summary stays verbatim.
  // The pui reads this over HTTP (no ctx_tier) → always full.
  // WI-2145871: opted in to the row contract. `project()` in presence-shape.ts
  // REBUILDS each row from a hand-written key list, so a field survives tiering
  // only by being named there — which is the axis `fields` actually holds. The
  // pinned set is not a guess: each one is a field that file's own comments
  // already declare must be kept at EVERY tier (confirmLiveness/WI-4400,
  // dormantScheduled/EI-22805550006169069, contextPressure/P-007, coordHook,
  // intentDivergent/EI-8988, fleetControlState/EI-22072194984361823), plus the
  // identity + liveness core a row is useless without. This only mechanizes a
  // promise the source states in prose.
  //
  // `preserve: ['agents']` pins the alias invariant from
  // EI-21845811145701209 — `agents` is rebuilt from the SAME tier-projected
  // rows as `active`, and deleting that line is the regression it guards.
  // Note the top-level axis is otherwise weak here: the shaper spreads
  // `{ ...d }` into `baseData`, so any OTHER top-level key would pass the
  // check by passthrough while asserting nothing the tool was shown to emit.
  shape: {
    contract: {
      rows: 'active',
      fields: [
        'ownerId',
        'state',
        'wakeable',
        'intent',
        'confirmLiveness',
        'dormantScheduled',
        'contextPressure',
        'coordHook',
        'intentDivergent',
        'fleetControlState',
        'canAcquireWork',
      ],
      preserve: ['agents'],
    },
    standard: (data) => shapeCoordPresence(data, 'standard'),
    trimmed: (data) => shapeCoordPresence(data, 'trimmed'),
  },
  async handler(args, ctx) {
    // P-004 hive-scoped read (D-002): resolve the effective scope from ctx + args
    // (hive default → caller's home Hive; SU/unmapped → workspace fallback), then
    // assemble the byte-stable snapshot (P-009). Both steps are the SAME functions
    // the coord:inbox re-bootstrap uses, so the roster never diverges.
    const c = (ctx ?? {}) as { workspaceId?: string | null; harnessSlug?: string | null; isSuperuser?: boolean };
    // Keep the public compatibility alias at the boundary: all downstream snapshot
    // and scope code consumes the canonical `owner`/`owners` selectors only.
    const owner = args.owner ?? args.ownerId;
    const owners = args.owners ?? args.ownerIds;
    // F-M2 (workspace-data-isolation-leaks): scope=all (EVERY workspace's roster) is an
    // admin/Mug view — gate it behind superuser. A non-SU caller asking for 'all' is
    // downgraded to 'workspace' (its own), so a bee can't snoop other workspaces' agents.
    const effScope = args.scope === 'all' && !c.isSuperuser ? 'workspace' : args.scope;
    const resolved = await resolvePresenceScope(c, {
      scope: effScope,
      hive: args.pot,
      workspace: args.workspace,
      // EI-18653888556683414: a targeted owner lookup defaults to workspace-wide
      // (not hive-narrowed) so a live peer outside the caller's own Hive is
      // still found instead of reading as "no such agent".
      targetedOwner: !!owner || !!owners?.length,
    });
    // The lock store is keyed by coordinationDomain (the repo root, not
    // workspaceId) — resolved defensively so an anonymous caller never breaks the
    // lean read.
    //
    // ⚠ TWO INDEPENDENT CONSUMERS NEED IT, and conflating them cost the
    // `holds-a-lock-on` signal every firing it ever had:
    //   · include_detail — P-011's held-files lane, which puts `heldFiles` on the
    //     roster rows themselves;
    //   · include_coupling — P-013's lock-hold DERIVATION, which never touches a
    //     roster row and only feeds the appended expanded[] block.
    // Resolving under `include_detail` alone made the second silently require the
    // first. Measured 2026-08-09 over the full retained history: ZERO
    // `coord:presence` calls have ever passed both flags, so the one automatic
    // "this agent is on this file" signal never fired in production. See
    // `presenceNeedsCoordinationDomain`, which owns this rule and its evidence.
    let coordinationDomain: string | undefined;
    if (presenceNeedsCoordinationDomain(args)) {
      try {
        coordinationDomain = readIdentity(ctx).coordinationDomain;
      } catch {
        coordinationDomain = undefined;
      }
    }
    // `detail` still gates the ROSTER lane on include_detail — widening the lock
    // read must not widen the base rows (D-053: the base roster is byte-identical
    // whether coupling is on or off).
    const detail = args.include_detail && coordinationDomain ? { coordinationDomain } : undefined;
    const snapshot = await assemblePresenceSnapshot(resolved, {
      ...(owner ? { owner } : {}),
      ...(owners?.length ? { owners } : {}),
      ...(detail ? { detail } : {}),
    });
    // Self-identification overlay (caller-dependent, so applied HERE, after the
    // shared/byte-stable snapshot — never inside it; see self-marker.ts): a
    // top-level `self` names the caller's own ownerId, and `isSelf:true` is
    // stamped on the caller's own row. A reader of its own roster can now tell
    // which agent is itself without a separate coord:whoami. Best-effort: an
    // unattributable caller just gets no marker (`self` omitted).
    const self = resolveSelfRef(ctx);
    // unified-agent-state-plane P-031 leg (d): THE UNION CONSUMER. Opt-in
    // `expanded[]` — the peers this caller is coupled to, resolved through the
    // ONE shared predicate (`resolveCoupledPeers` = derived ∪ declared −
    // suppressed) so no consumer re-implements the merge.
    //
    // ⚠ D-053: this APPENDS a top-level block and never touches the base rows.
    // The roster is byte-identical whether include_coupling is on or off —
    // coupling decides only WHO appears in the appended block. The block is
    // reader-relative BY DESIGN (that is what `expanded[]` is for), which is
    // also why it must never migrate INTO a row: `since:`/[coord+N] diff the raw
    // rows, and a reader-relative field there would break the byte-stable delta
    // contract.
    //
    // COMPUTED BEFORE THE `since:` SHORT-CIRCUIT, and deliberately so. The block
    // is not etag-tracked (a coupling change is not a roster change), so a
    // caller polling with `since:` + include_coupling would otherwise get a stub
    // that silently omits the very block it asked for — and could not tell that
    // from "I have no coupled peers". It projects from the PRE-overlay snapshot
    // rows, which carry every field it reads, so the block is identical on both
    // paths and provably independent of the modes/parkedOn/deafness/cursor
    // overlays below.
    //
    // ⚠ DEFAULT-ON since 2026-08-10 (D-098) — `!== false`, not `=== true`. The
    // opt-in gate was the reason the entire coupling payoff was invisible: measured
    // over the whole retained window, `include_coupling` was passed 11 times EVER,
    // by 4 agents, ALL of them this feature's own authors, out of 316 `coord:presence`
    // calls. A feature whose only callers are the people who wrote it is not deployed,
    // however green its tests — and no amount of correctness work downstream could
    // ever have surfaced through a flag nobody passes.
    //
    // The original opt-in rationale — "paying a query on every read of a hot poll
    // surface to append an empty array is the wrong trade" — died when P-013 built
    // the derived half (D-078): the roster signals are computed purely from snapshot
    // rows already in hand, so they add no query and the block is no longer provably
    // empty. What remained was a PAYLOAD SIZE trade, and `buildCoupledExpansion` caps
    // the block (presence-cost.test.ts leg d), so it is bounded rather than unbounded.
    //
    // The QUERYING legs stay behind `include_detail` / an EXPLICIT `include_coupling:
    // true`: they need `coordinationDomain`, which `presenceNeedsCoordinationDomain`
    // resolves only for those two. So a default read gets the free roster-derived
    // signals and pays nothing for the lock lane — the gate moved, it did not vanish.
    let coupling: Record<string, unknown> = {};
    if (args.include_coupling !== false && self) {
      try {
        const edges = await listCouplingsFor(self.ownerId, c.workspaceId ?? undefined);
        // P-013 (scoping ruling D-078): the derived half, plugged in exactly where
        // this module always said it would go. The roster signals (same fleet,
        // shared awaited event) are computed from the SAME pre-overlay snapshot
        // rows the block projects from and add no query at all.
        //
        // The QUERYING signals — overlapping lock holds, a plan `blocked-by` edge,
        // a recent directed coord exchange — are injected as bounded, caller-scoped
        // reads (coupling-sources.ts) and are fail-soft PER LEG, so a dead source
        // costs that one signal rather than the whole block. Each reads only what
        // this caller can already read, and `deriveCouplings` filters every derived
        // edge back through the roster, so coupling still cannot surface a peer
        // this caller could not otherwise see (D-044 / D-078 (c)).
        //
        // The lock-hold signal is what makes the file dimension real: `current_files`
        // is a live roster field but is empty for essentially every agent (measured
        // 2026-07-27 — 119 live rows, zero populated; EI-18772330418885814), so a
        // live lock is the only AUTOMATIC "this agent is on this file" signal.
        // P-007: publish the per-run DEAD-SIGNAL CENSUS on the EXISTING per-call
        // metadata channel (`tool_invocations.metadata_json`), so
        // `lint:derived-signal-firings` can answer "has this relation ever fired in
        // production?" — the question no unit test can, and the one that would have
        // caught `holds-a-lock-on` 12 days earlier (D-088). ⚠ THIS NOW RIDES THE
        // DEFAULT PATH (D-098) — it used to be bounded to the opt-in branch, all 11
        // calls of it, which is precisely why ZERO rows in `tool_invocations` have
        // ever carried `metadata_json.derivedSignals` and the detector built to
        // answer "has this relation ever fired in production?" could not answer it
        // for anyone. The census is a bounded per-call object on a path that already
        // writes metadata; the firings data it finally collects is the point.
        // P-009: the cast + key-wrapping now live in ONE place
        // (`censusObserverFor`), so the last-write-wins hazard behind them is
        // documented once instead of re-invited at each new wiring site. This path
        // is no longer the only one wired — `coord:send` and `topics:feed` carry the
        // same sink, which is what makes the census observable at volume.
        const observeCensus = censusObserverFor(c);
        const derived = await deriveCouplings(self.ownerId, snapshot.active, {
          ...couplingSourcesFor({
            selfOwnerId: self.ownerId,
            rosterOwnerIds: snapshot.active
              .map((r) => (r as { ownerId?: unknown }).ownerId)
              .filter((v): v is string => typeof v === 'string' && v.length > 0),
            // NOT `detail?.coordinationDomain` — that is the bug this replaced.
            ...(coordinationDomain ? { coordinationDomain } : {}),
            ...(c.harnessSlug ? { harnessSlug: c.harnessSlug } : {}),
            ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
          }),
          ...(observeCensus ? { observe: observeCensus } : {}),
        });
        const peers = resolveCoupledPeers(self.ownerId, derived, edges);
        const expansion = buildCoupledExpansion(peers, snapshot.active);
        coupling = {
          expanded: expansion.expanded,
          expandedTotal: expansion.total,
          ...(expansion.truncated
            ? { expandedTruncated: `showing ${expansion.expanded.length} of ${expansion.total} coupled peers` }
            : {}),
        };
      } catch {
        /* fail-soft — a coupling read must never degrade the roster */
      }
    }
    // P-006 `since:` short-circuit — if the caller passes the etag from its prior read
    // and the delta-eligible roster (identity+state) is byte-identical, return a ~100B
    // stub instead of the full payload. Liveness churn (heartbeat / live↔parked) is
    // deliberately excluded from the etag (D-005/D-006), so a poll that only wants "did
    // anything actionable change" stays cheap; a caller about to DISPATCH re-reads
    // without `since:` to get fresh liveness. An `owner`-targeted read still honors it.
    if (args.since && args.since === snapshot.etag) {
      return {
        data: {
          unchanged: true,
          etag: snapshot.etag,
          as_of: snapshot.as_of,
          scope: snapshot.scope,
          note: 'roster identity+state unchanged since your etag; liveness (live↔parked) is not tracked here — re-read without since: before you dispatch',
          // The opt-in coupling block rides the stub too (see above): it is not
          // etag-tracked, so withholding it here would be indistinguishable from
          // having no coupled peers.
          ...coupling,
        },
      };
    }
    // modes-and-intake-ux-2026-07-05 P-007: ambient mode visibility — attach each
    // ACTIVE row's official modes (e.g. modes:['auto','grade']) in ONE batched read,
    // AFTER the byte-stable snapshot (mode churn is deliberately etag-excluded, same
    // as liveness churn — a `since:` stub may lag a mode flip; mode:get is the fresh
    // point read). Best-effort: a mode-read failure never degrades the roster.
    let active = markSelfRows(snapshot.active, self);
    try {
      const ids = active.map((r) => String((r as { ownerId?: unknown }).ownerId ?? '')).filter(Boolean);
      if (ids.length) {
        const modeMap = await getModesForOwners(c.workspaceId ?? 'default', ids);
        if (modeMap.size) {
          active = active.map((r) => {
            const m = modeMap.get(String((r as { ownerId?: unknown }).ownerId ?? ''));
            // A targeted read can include an ended row. Its durable mode rows
            // are recovery/history, not current staffing, so do not project
            // them as active chips. Ambiguous/degraded liveness stays visible:
            // only positive `ended` evidence suppresses the modes.
            const sessionState = (r as { sessionState?: Parameters<typeof modeRegistrationLive>[0] }).sessionState;
            return m?.length && modeRegistrationLive(sessionState) !== false
              ? { ...r, modes: m.map((x) => x.mode) }
              : r;
          });
        }
      }
    } catch {
      /* fail-soft */
    }
    // WI-3715 (fleet-leader-frictions-six-improvements-2026-07-10, P-001): stamp
    // `parkedOn` — same derived-from-events:await, non-etag-tracked overlay
    // pattern as the `modes` block above (fleet:assignments already carries this
    // via decorateParkedOn; reuse its shared grouping helper here rather than a
    // second copy of the cap/dedup rule). An agent parked on a real event key is
    // DELIBERATELY idle (benched awaiting a pushed event), not abandoned — a
    // caller scanning presence sees who's parked without a separate fleet:assignments
    // read. Best-effort: an await-store hiccup never degrades the roster.
    try {
      const ids2 = active.map((r) => String((r as { ownerId?: unknown }).ownerId ?? '')).filter(Boolean);
      if (ids2.length) {
        const rows = await listParkedAwaitsForSubscribers(ids2);
        if (rows.length) {
          const byId = buildParkedOnMap(rows);
          active = active.map((r) => {
            const keys = byId.get(String((r as { ownerId?: unknown }).ownerId ?? ''));
            return keys && keys.length > 0 ? { ...r, parkedOn: keys } : r;
          });
        }
      }
    } catch {
      /* fail-soft */
    }
    // coord-delivery-residual-gaps-2026-07-11 P-001: coord-DEAFNESS overlay —
    // stamp `coordHook: 'stale' | 'missing'` (+ `coordLastReadAgoSec`) on LIVE
    // rows whose inbox-read freshness is over budget. Every delivery leg's
    // poll is a real coord:inbox/orient row in tool_invocations, so "is this
    // session actually seeing its mail?" is derivable server-side: live +
    // demonstrably active + no read for a whole budget window ⇒ deaf RIGHT NOW
    // (hook enrollment drifted, a runtime with no injection leg, or one long
    // foreground exec). Same batched, best-effort, non-etag-tracked overlay
    // pattern as `modes`/`parkedOn` above; unknowns fail toward unflagged.
    try {
      const liveRows = active.filter((r) => (r as { sessionState?: string | null }).sessionState === 'live');
      const liveIds = liveRows.map((r) => String((r as { ownerId?: unknown }).ownerId ?? '')).filter(Boolean);
      if (liveIds.length) {
        const reads = await lastInboxReadAtBatch(liveIds);
        const budget = coordDeafBudgetMs();
        const nowMs = Date.now();
        active = active.map((r) => {
          const row = r as {
            ownerId?: unknown;
            sessionState?: string | null;
            lastActiveSecAgo?: number | null;
            startedAt?: string | null;
          };
          if (row.sessionState !== 'live') return r;
          const verdict = classifyCoordDeafness(
            {
              sessionState: row.sessionState,
              lastActiveSecAgo: row.lastActiveSecAgo,
              startedAt: row.startedAt,
              lastReadAt: reads.get(String(row.ownerId ?? '')) ?? null,
            },
            nowMs,
            budget,
          );
          return verdict ? { ...r, coordHook: verdict.state, coordLastReadAgoSec: verdict.lastReadAgoSec } : r;
        });
      }
    } catch {
      /* fail-soft — deafness detection must never degrade the roster */
    }
    // ambient-semantic-push P-002: opt-in cursor overlay — stamp each active
    // row with its owner's current lexical cursor (top terms, data-not-directive)
    // so a peer/leader can read what a session is working on. Same best-effort,
    // batched, snapshot-only, non-etag-tracked overlay pattern as modes/parkedOn/
    // coordHook above (a cursor churns every turn — it must never ride the delta
    // channel). DOUBLE DEFAULT-OFF: the caller must pass include_cursor AND the
    // ambient feature flag must be on; the flag is read inline so the default
    // path adds no import/query and stays byte-identical.
    const cursorFlag = process.env.PAPERCUSP_AMBIENT_CURSOR;
    const cursorEnabled = args.include_cursor === true && (cursorFlag === '1' || cursorFlag === 'true');
    active = await overlayPresenceCursors(active, { enabled: cursorEnabled });

    // ── P-012: a ready coord:dispatch CALL, not a mention ────────────────────
    // (coordination-spec-adoption-2026-08-03, D-100 kept the verb / D-101 fixed
    // the mechanism.) The `seeAlso` below has pointed at coord:dispatch for
    // months and it bought 1 call in 30 days; a mention is the 1.7% lever. The
    // handle is built ONLY from the snapshot this read already computed — no
    // extra IO on a hot path — and emits nothing rather than a half-filled call
    // when either the lane or the target is unresolvable. See dispatch-handle.ts
    // for why a blank `items` is the specific shape that must never ship.
    const normalizedActive = normalizeFullPresenceRows(active as Array<Record<string, unknown>>);
    const selfRow = self
      ? normalizedActive.find((r) => r.ownerId === self.ownerId)
      : undefined;
    const dispatch = buildDispatchHandle(
      {
        planSlug: (selfRow?.currentPlanSlug as string | undefined) ?? null,
        items: (selfRow?.claimedItems as string[] | undefined) ?? null,
        harness: c.harnessSlug ?? null,
      },
      normalizedActive as unknown as DispatchCandidate[],
      { selfOwnerId: self?.ownerId ?? null },
    );

    const out = {
      ...snapshot,
      ...(self ? { self } : {}),
      active: normalizedActive,
      // EI-21845811145701209: `agents` is the name readers reach for FIRST when
      // guessing the roster key (the tool description already spells out
      // `active` — see EI-13298 above — but the guess persists). Alias it to
      // the SAME array rather than leaving a plausible key silently absent: a
      // miss on this key would otherwise fall through `|| []` and read as "zero
      // agents present" instead of "wrong key name", which is the exact
      // silent-false-absence failure both incidents hit. Kept as a reference to
      // `active`, never a second derivation, so the two can never diverge.
      agents: normalizedActive,
      ...coupling,
      ...(dispatch ? { dispatch } : {}),
    };
    // {data} envelope so the payload-tier shapers apply; HTTP consumers (the
    // pui roster panes) still read identical lossless JSON text.
    return { data: out };
  },
});
