/**
 * work_items:list — cross-kind list over the unified surface (unify-work-items,
 * D-007). Default = top-level items only; chunks surface under their parent (D-004,
 * pass `parent` or includeChildren). Filter by harness / kind / state / q.
 */
import { z } from "zod";
import { DATATYPE_NATURES } from '../../datatype-registry-store';
import { defineTool } from "@papercusp/agent-mcp";
import { COORD_ROLES } from "../coordination/roles";
import { resolveAgentIdentity } from "../coordination/identity";
import {
  countWorkItems,
  listWorkItems,
  type WorkItemKind,
} from "../../work-items";
import { WORK_AUDIENCE_FILTERS } from "../../work-nature/agent-work-predicate";
import { isOwnerUiCaller, type AgentWorkDoorCaller } from "../../work-nature/agent-work-door-gate";
import { boundRowField } from "../_bound-output";
import {
  WORK_ITEM_AUDITS,
  COMPLETION_AUTHORITY_FILTERS,
  type CompletionAuthorityFilter,
} from "../../completion-audit";
import { cachedRead, type CachedReadCtx } from "../../cache";
import { attachHolderContext } from "./_holder-lens";
import { holderContextReader, HOLDER_CONTEXT_SCHEMA } from "../coordination/holder-advisory";

/**
 * SWR backstop for work_items:list (cache-expensive-tool-reads-2026-06-22 P-005).
 * The unified work-item table (harness_features_consolidated) carries the generic
 * .changed trigger, so any work-item write auto-invalidates the entry via the
 * cache-ECA (table tag below) — this short soft TTL only bounds staleness for any
 * dependency dimension a trigger doesn't cover. work_items:list is an OVERVIEW read,
 * decoupled from the scheduler claim hot path (claim_next), so caching it does NOT
 * touch the maintained readiness floor (D-004).
 */
const WORK_ITEMS_LIST_SOFT_TTL_MS = 20_000;

/**
 * Output `data` schema (token-efficient-tool-result-formats P-011). The result
 * is the bare WorkItem array — the row count rides in TOON's self-describing
 * `[N]{…}:` header, so the old `{ ok, count, items }` wrapper is redundant. This
 * unlocks the compact format for a high-traffic list tool (≈ −32% tokens for
 * agents). `payload` is `unknown`, so the schema proves TOON-eligibility but not
 * CSV; rows that happen to have a null payload still serialize as CSV on an
 * explicit request via the serializer's runtime flatness check.
 */
const WORK_ITEM_ROW = z.object({
  id: z.string(),
  kind: z.string(),
  family: z.string(),
  harness: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  /** EI-1597: in list rows the summary is EXCERPTED (budget-aware) so a large backlog
   *  can't overflow the agent result cap; these flag a cut row. Full body via work_items:get. */
  summary_truncated: z.literal(true).optional(),
  summary_full_chars: z.number().optional(),
  state: z.string(),
  /** Physical authoring provenance. `remote` rows cannot be mutated on this node. */
  origin: z.string().nullable(),
  assignee: z.string().nullable(),
  assignedBy: z.string().nullable(),
  severity: z.string().nullable(),
  parent: z.string().nullable(),
  payload: z.unknown(),
  /** Shared backlog priority (feature_order) — LOWER = claimed sooner; null = unprioritized.
   *  Feature-family only (the Queen's steer lever, B7); issue-family is always null. */
  priority: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The completion prose recorded at terminal transition (work_items:complete's
   *  `completion.summary`), if any — always present on the row. */
  terminalCompletionRef: z.string().nullable().optional(),
  /** Structured verification evidence (testsRun/testResult/verifiedHow/filesChanged/
   *  addedTests), if the completion supplied any. P-004 makes this REQUIRED for a close
   *  to reach `committed`; a close without it lands `authority:'proposed'` instead. */
  terminalCompletionEvidence: z.record(z.string(), z.unknown()).nullable().optional(),
  /** P-004's judgement about this row's completion evidence ('committed' | 'proposed' |
   *  'validated' | 'pending_human' | 'invalid'), or null when the close was never judged
   *  — only `work_items:complete` stamps it, so a bare state-write close reads null
   *  regardless of how well evidenced it was. Declared here so the `completionAuthority`
   *  FILTER's own value is visible on the rows it returns (the schema strips undeclared
   *  keys, so an omitted field would silently blank a column the caller just filtered on). */
  completionAuthority: z.string().nullable().optional(),
  /**
   * P-030 / D-060 — WHO holds this row and WHAT they are trying to do, on the
   * ORDINARY read rather than only when a claim is refused. The shared P-026
   * projection (`coord/holder-context.ts`), resolved through
   * `getCell('agent.goal', reader)` so this surface adds a LENS and never a
   * second derivation.
   *
   * Present only on rows with a LIVE (non-terminal) holder whose goal is
   * disclosable to the caller. Its absence is deliberately ambiguous between
   * "no goal declared" and "not readable by you" (D-056) — the row itself is
   * NEVER dropped either way.
   */
  holder: HOLDER_CONTEXT_SCHEMA.optional(),
  /** P-030 — the distinct-holder cap bit, so this row's holder was never looked
   *  up. A fact about the READ, never about access (see the lens). */
  holderOmitted: z.literal("cap").optional(),
});

// EI-1597: bound each list row's summary so a large backlog can't overflow the agent
// result cap (work_items:list returns the full WorkItem array; a 40-item backlog hit
// 73KB of summaries on one line). Per-row cap = min(SUMMARY_ROW_CAP, floor(BUDGET/n))
// — the budget-aware bound coord:inbox (EI-1752) + plans:get (WI-274) use: total
// summary text stays <= BUDGET at ANY list size, while small lists keep most rows full.
// Full body is always available via work_items:get { id }.
export const SUMMARY_ROW_CAP = 240;
export const SUMMARIES_TOTAL_BUDGET = 16_000;

// EI-1597: a thin semantic wrapper over the shared budget-aware bound — single
// source of truth for the per-field excerpt (was an inlined copy of the loop).
export function boundSummaries<T extends { summary?: string | null }>(
  rows: T[],
): T[] {
  return boundRowField(
    rows,
    "summary",
    SUMMARY_ROW_CAP,
    SUMMARIES_TOTAL_BUDGET,
  );
}

/**
 * Payload-tier shapers (context-trimming-tiers-2026-07-01 P-012). A trimmed/
 * standard session projects each row to its placement-relevant core — the
 * summary excerpt, timestamps, and the fat `payload` subtree are the measured
 * token sinks (~1 token/char over a UUID-dense backlog in the 2026-07-01 fleet
 * incident). Rows keep a UNIFORM key set per tier (null over absent) so TOON's
 * tabular form still applies; `payload.plan_item` is flattened to a short
 * `plan_ref` string ("slug#P-NNN"). No silent caps (D-004): a sliced list
 * appends a visible `(truncated)` notice row carrying the fetch-pointer.
 */
const LIST_TIER_CAPS = {
  trimmed: { rows: 40, title: 90, summary: 0, holder: false },
  standard: { rows: 120, title: 160, summary: 140, holder: true },
} as const;

/** The slice of P-030's `HolderContext` the tier shapers project. Structural, so
 *  the shaper stays free of the shared projection's import. */
type HolderProjection = { goalRef: string | null; stale: boolean | null; competing: string[] };

export function shapeWorkItemsList(
  data: unknown,
  tier: keyof typeof LIST_TIER_CAPS,
): unknown {
  if (!Array.isArray(data)) return data;
  const c = LIST_TIER_CAPS[tier];
  const clip = (s: unknown, n: number): string | null =>
    typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;
  const project = (row: unknown): unknown => {
    if (!row || typeof row !== "object") return row;
    const r = row as Record<string, unknown>;
    const planItem = (
      r.payload as
        | { plan_item?: { plan_slug?: unknown; item_id?: unknown } | null }
        | null
        | undefined
    )?.plan_item;
    const planRef =
      planItem && typeof planItem === "object"
        ? `${String(planItem.plan_slug ?? "?")}#${String(planItem.item_id ?? "?")}`
        : typeof r.sourcePlanSlug === "string" &&
            r.sourcePlanSlug.trim() &&
            Array.isArray(r.sourcePlanItemIds) &&
            typeof r.sourcePlanItemIds[0] === "string" &&
            r.sourcePlanItemIds[0].trim()
          ? `${r.sourcePlanSlug.trim()}#${r.sourcePlanItemIds[0].trim()}`
          : null;
    // P-030 in the trimmed tiers: the holder's goal is TWO SHORT SCALARS, not the
    // whole projection. `goalRef` is a ref (~10 chars) and `stale` a boolean —
    // together they are exactly what D-060's acceptance asks a reader to see
    // ("each holder's goal + staleness") at a cost these tiers can carry, while
    // `goalText`, the assumption keys and `competing` ride the full tier. Null on
    // every row that has no disclosable holder, so the key set stays UNIFORM and
    // TOON's tabular form still applies.
    const holder = r.holder as HolderProjection | undefined;
    return {
      id: r.id ?? null,
      kind: r.kind ?? null,
      harness: r.harness ?? null,
      title: clip(r.title, c.title),
      ...(c.summary > 0 ? { summary: clip(r.summary, c.summary) } : {}),
      state: r.state ?? null,
      origin: r.origin ?? null,
      assignee: r.assignee ?? null,
      severity: r.severity ?? null,
      priority: r.priority ?? null,
      plan_ref: planRef,
      ...(c.holder
        ? {
            holder_goal: holder?.goalRef ?? null,
            holder_stale: holder?.stale ?? null,
            // D-092/D-093 survive the trim as a COUNT: a reader must not be told
            // "this is their goal" while the fact that they hold other claims is
            // silently dropped by a payload tier. 0 when there are none.
            holder_competing: holder ? holder.competing.length : null,
          }
        : {}),
    };
  };
  const rows = data.slice(0, c.rows).map(project);
  if (data.length > c.rows) {
    rows.push({
      id: "(truncated)",
      kind: "notice",
      harness: null,
      title: `showing ${c.rows} of ${data.length} — narrow with state/kind/limit, work_items:get {id} for detail, or payloadTier:"full"`,
      ...(c.summary > 0 ? { summary: null } : {}),
      state: null,
      origin: null,
      assignee: null,
      severity: null,
      priority: null,
      plan_ref: null,
      ...(c.holder ? { holder_goal: null, holder_stale: null, holder_competing: null } : {}),
    });
  }
  return rows;
}

export default defineTool({
  name: "work_items:list",
  profile: "engineer",
  description:
    // ⛔ DO NOT add a "re-read after a change" rail here expecting it to fix the compact
    // tier's lost re-read disposition — that was MEASURED and it does not work (D-048/D-049).
    // An 85-char `⚠ Rows are a SNAPSHOT…` rail, verified DELIVERED UNCUT to the compact arm,
    // left su-S25 at 4/12 against a full-tier control at 12/12 (Fisher p=0.0013), and the
    // failing runs still made exactly ONE work_items:list call instead of two. It also cost
    // +90 B, which evicted coord:read from the 100,000 B shipping seed. Re-proposing it needs
    // new evidence, not a retry.
    "List work-items across kinds (feature/chunk/bug/change/task). Default shows top-level items (chunks are hidden — pass parent or includeChildren). Filter by harness, kind, state, or q (a case-insensitive literal substring over title and body/summary). Returns the WorkItem array directly — each row's summary is EXCERPTED to keep the list bounded (a row carries summary_truncated + summary_full_chars when cut); use work_items:get { id } for a full body.",
  guidance: {
    when: "You want the current work-items in a harness (or operator-wide). Default hides chunks; pass `parent` to see a parent's chunks. Pass `q` for a case-insensitive literal substring over title and body/summary. Each row carries `priority` (the shared backlog order, LOWER = claimed sooner) so a steerer can read the whole backlog's order in one call before steering it with work_items:set_priority.",
    chaining:
      "work_items:list → work_items:get { id } for detail; work_items:claim to take one; work_items:set_priority to re-order the backlog.",
    notWhen:
      "Do not treat `assignee:null` on an item carrying `plan_ref`/`payload.plan_item` as unclaimed: `plans:items { slug }` may show live coverage. `sourcePlanSlug` filters persisted item provenance only; it does not include ad-hoc work merely performed while a session/fleet declared that plan. Scheduler `plan` predicates use item provenance too; for current lane status use scheduler:get_next or work_items:claimable.",
    seeAlso: [
      'work_items:claimable (issue-family: how many / which are ACTUALLY claimable — the full claim floors, unlike admissibleOnly here)',
      'work_items:set_priority (steer the backlog order you just read)',
      'work_items:get (full detail on specific ids)',
      'work_items:claim_next (take the next claimable item)',
      'plans:items (the effectiveStatus / live-coverage source of truth for a plan-linked row)',
    ],
  },
  capability: "work_items:read",
  requirePrincipal: false,
  // EI-20226779878046151: coord:orient re-dispatches this read inside a
  // sequential compound. It resolves its own stores and never reads ctx.tx;
  // do not hold an ambient org-app transaction across cache/enrichment awaits.
  skipWorkspaceTx: true,
  // Acceptance judges inspect completion evidence as part of their rubric method.
  // Keep this explicit instead of adding judge to COORD_ROLES, which would expose
  // unrelated coordination/write tools.
  agentRoles: [...COORD_ROLES, 'judge'],
  args: z.object({
    harness: z.string().max(80).optional(),
    q: z
      .string()
      .max(200)
      .optional()
      .describe("case-insensitive literal substring matched against title and body/summary"),
    // P-001/P-011 generic-kind: a built-in kind OR a workspace-registered generic-kind
    // datatype (declared via meta:define-datatype). familyOf() maps any non-issue kind to
    // the feature family + featureFamilyKindClause admits registered generic kinds, so the
    // filter works downstream; an unknown kind simply lists empty. Enum-locking this arg
    // was the observability gap — the queue could hold demo-bet rows the list tool refused
    // to filter by. Free string mirrors work_items:create.
    kind: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'built-in kind (feature, chunk, bug, change, task) OR a workspace-registered generic-kind datatype',
      ),
    state: z
      .union([z.string().max(40), z.array(z.string().max(40)).max(20)])
      .optional()
      .describe(
        "WI-38339: ONE state, or an ARRAY of states (matches any of them). Alias: `states` (alias-group:state|states). An empty array is NO filter, never 'match nothing'. For the dominant question — everything still open — prefer `notTerminal`, which cannot drift as the terminal spellings change.",
      ),
    // EI-22638011562769666: neighboring work-item readers and claim tools use the
    // plural spelling. Keep it as a schema-visible compatibility alias so callers do
    // not get an invalid_args response merely for using that established vocabulary.
    states: z
      .array(z.string().max(40))
      .max(20)
      .optional()
      .describe(
        "Alias for the ARRAY form of `state` (alias-group:state|states) — matches any supplied state. Passing both names is rejected unless the caller uses only one spelling.",
      ),
    notTerminal: z
      .boolean()
      .optional()
      .describe(
        "WI-38339: exclude every state terminal in EITHER family (done/passed/resolved/closed/deprecated/dropped), derived from the canonical union rather than a copied list. The 'everything not finished' filter agents otherwise hand-write as `status NOT IN (…)` in raw SQL.",
      ),
    createdSince: z
      .string()
      .max(40)
      .optional()
      .describe("ISO timestamp — rows created at or after it (INCLUSIVE, like plans:list)."),
    updatedSince: z
      .string()
      .max(40)
      .optional()
      .describe("ISO timestamp — rows updated at or after it (INCLUSIVE, like plans:list)."),
    sourcePlanSlug: z
      .string()
      .max(120)
      .optional()
      .describe(
        "Persisted item provenance only: rows produced or stamped by this plan. It does NOT include ad-hoc work merely performed while a session/fleet declared that plan; scheduler `plan` predicates are item-provenance filters too. Alias: `plan` (alias-group:sourcePlanSlug|plan).",
      ),
    // EI-21592729279587188 (tool-contract-repair-2026-09-05 P-008): `plan` is the name
    // callers reach for, and this tool's OWN describe text above says "scheduler `plan`
    // predicates" — so the schema rejected the very word its documentation uses. The
    // filing is the symptom; the missing alias is the defect (plan Framing). Same
    // shape as work_items:create/update's body↔summary pair (_body-alias.ts): one
    // logical filter under either name, with a differing-pair conflict rejected loudly
    // rather than silently picking a winner.
    plan: z
      .string()
      .max(120)
      .optional()
      .describe(
        "Alias for `sourcePlanSlug` (alias-group:sourcePlanSlug|plan) — the SAME item-provenance filter. Passing both with different values is rejected.",
      ),
    assignee: z
      .string()
      .max(120)
      .optional()
      .describe(
        "Filter to items assigned to this agent (feature → taken_by; issue → assignee). The literal \"self\" resolves to YOU (as it does in work_items:claim / claim_next / create's assign_to); `mine: true` is the same request.",
      ),
    assignedBy: z
      .string()
      .max(120)
      .optional()
      .describe(
        "Filter issue-family items by the owner who delegated them (the durable `assigned_by` field). This filter is ignored for feature-family rows, which have no delegator column.",
      ),
    mine: z
      .boolean()
      .optional()
      .describe(
        "Filter to items assigned to the CALLER (resolves your own agent identity) — EI-6506: a leader's 'see your work item' handoff, findable without raw PG or knowing your own ownerId string. Overridden by an explicit `assignee` if both are passed.",
      ),
    parent: z
      .string()
      .max(80)
      .optional()
      .describe("list children (chunks) of this parent id"),
    includeChildren: z
      .boolean()
      .optional()
      .describe("include child items (chunks) in the list"),
    admissibleOnly: z
      .boolean()
      .optional()
      .describe(
        "EI-7841/WI-3649: a cheap pre-filter, NOT the full claim-floor verdict. Feature-family: the G2 admission/trust gate (remote, un-admitted, untrusted-author) work_items:claim/claim_next enforce. Issue-family (bug/change/task): every ROW-INTRINSIC claim floor — remote origin, observation lane, replication-liveness detector, claim-hold, needs-human, reserved-plan-lane, loop-noise, already-terminally-completed, active external blocker (WI-4405/WI-37761/WI-37774). It does NOT apply the floors needing live claim context (blocked-dep / cooldown / rig / swarm-affinity / redundancy), so a row it admits may STILL be unclaimable — the origin+lane-only version caused the 2026-07-12 idle-fleet miss. ⚠ NOT the claimable verdict: for 'what issue-family work can I claim right now' use work_items:claimable (the full floors). Default false (full backlog incl. gated items, for overview/leader reads).",
      ),
    audit: z
      .enum(WORK_ITEM_AUDITS)
      .optional()
      .describe(
        "Work-item integrity diagnostics. Every bucket judges a CLOSE and matches TERMINAL rows only, EXCEPT 'worked-then-abandoned' (below) which judges an OPEN row's lifecycle and matches only NON-terminal ones — the scope belongs to the bucket, so you never pass a `state` to get it right. 'worked-then-abandoned' (EI-19320339017813143) = a still-open item that was claimed, worked, and RELEASED more than 21 days ago: the release-instead-of-complete failure, where a holder verifies an item needs no change and releases it, returning it to the backlog for the next agent to re-derive (WI-5623 sat open+critical for 6 days after being verified fixed, its evidence unread in its checkpoint). ⚠ A DETECTOR, NOT A VERDICT — \"released and untouched for 3 weeks\" is a fact about lifecycle columns, and already-delivered is only ONE of its causes (also: genuinely hard, deprioritized, externally blocked). Adjudicate by reading each row; never bulk-close on it. Complements work_items:stranded, which instead asks whether an open item's CHECKPOINT declares the work finished: measured 2026-08-30, 211 of 406 matches here carry no checkpoint at all and are structurally unreachable by that scan. NOTE (P-006): the old 'no-evidence' bareness sweep is GONE — evidence is now required at WRITE time, so a close without it lands `authority:'proposed'` (out of burn-down, still owned by its closer) rather than needing a later audit. Every bucket below fires on rows that PASS that gate. 'no-completion-record' = no completionRef AND no authority: a legacy/pre-gate close — mostly the benign, EXPECTED system skipCompletionGate flips (watchdog/hygiene/orphan/bee-exit/revert). 'no-completion-record-suspicious' = the ACTIONABLE subset, scoped to origin='local' (EI-18821460229478708): same shape but NOT credited to one of those recognized system identities — structurally impossible for a gated LOCAL caller, so a hit means an undiscovered write path on THIS install slipped past the gate; investigate directly. 'no-completion-record-federated' = the NON-actionable federated sibling (same shape, origin='remote') — visible for count/awareness, but says nothing about this install's write paths; it reflects federation transport or the ORIGIN pot's own completion integrity (measured 2026-08-02: 82% of the pre-split bucket was this, dominated by a federation-authority gap mig 708 fixed forward-only). 'geometry-unverified' = touches a layout-bearing file (*.css/*.tsx/*.jsx) with verifiedHow 'unit' or absent — structure-passing, pixel-failing risk. 'intermittent-underevidenced' = titled intermittent/flaky/racy, carries evidence, but only a streak of consecutive passes — no failure rate, root cause, or deterministic repro, which cannot falsify 'we sampled the passing branch N times'. 'reconciler-sourced' = closed by the plan-item reconciler, which MIRRORS a linked plan item's status and is by construction never independently verified — a mis-flipped plan item silently marks a live defect fixed. Newest-first. Composes with `state`.",
      ),
    completionAuthority: z
      .enum(COMPLETION_AUTHORITY_FILTERS)
      .optional()
      .describe(
        "Filter TERMINAL rows by the completion-authority judgement the P-004 gate stamped: 'committed' (evidence sufficient — verifiedHow PLUS testsRun/testResult), 'proposed' (closed but under-evidenced: recorded, out of burn-down, still owned by its closer), 'validated'/'pending_human'/'invalid', or 'unjudged' for a close carrying NO judgement. This is how you LIST under-evidenced closes — the read D-012 left open when P-006/D-003 deleted the 'no-evidence' audit bucket. ⚠ 'unjudged' measures the INSTRUMENT, not the agents: only work_items:complete stamps an authority, so a close made via the bare state-write path lands NULL however well evidenced it was (that path records its evidence in terminalCompletionRef instead, and complete's structured evidence lands in payload._completionEvidence — three places, so no single field is a complete evidence test). Measured 2026-07-27: 38.2% of that day's agent closes were gate-judged vs 0.1% the day before, so an 'unjudged' hit means \"never judged\", NOT \"unevidenced\". Non-terminal rows never match. Composes with `state` and `audit`.",
      ),
    includeObservations: z
      .boolean()
      .optional()
      .describe(
        "EI-10422: by default a payload.lane:'observation' row (a turn-end reflection / rubric scorecard filed via improvements:capture { lane:'observation' }) is EXCLUDED — by design (D-005) it never enters the work queue/triage. Pass true to include raw observations in this read (a curation surface); the default keeps the backlog/triage view free of the ~2,700 open notes that otherwise masquerade as claimable `change` work.",
      ),
    natures: z
      .array(z.enum(DATATYPE_NATURES))
      .optional()
      .describe(
        "P-010/D-011: natures to return (work|record|document|event). Default: work only, unless kind is named. ['record'] reads record rows such as pipeline deals.",
      ),
    audience: z
      .enum(WORK_AUDIENCE_FILTERS)
      .optional()
      .describe(
        "D-041: 'agent' = only rows an agent may claim/close; 'human' = human-audience rows; 'any' = both. Default for agent callers: 'agent', unless kind or natures is named.",
      ),
    limit: z.number().int().positive().max(500).optional(),
  }),
  result: z.array(WORK_ITEM_ROW),
  // Freshness negotiation (agent-tool-delta-client-rollout-2026-06-23, P-001) — the #1
  // LLM-agent re-read by total bytes×repeats (queen/bee/overwatch poll the backlog ~3×/wake,
  // ~25KB/call). The diffable unit is the WorkItem row set (the data IS the array), keyed by
  // `id`; `kind` is the row type. The framework folds the filter args (harness/q/kind/state/
  // parent/includeChildren/limit) into the view fingerprint; `scope` adds the workspace.
  // NOTE: row summaries are budget-EXCERPTED by list size, so a row's content-hash can shift
  // when the list size changes — that just re-sends the row as `updated` (still checksum-correct,
  // never wrong). NOT dormant (WI-3153, corrected 2026-08-04): the MCP transport's delta proxy
  // sends `_meta.delta` and reconstructs full rows before the model sees them; in-process callers
  // send no cursor, so `negotiateDelta` returns full (reason:'no_request'). The model never merges.
  delta: {
    rows: (data) => (Array.isArray(data) ? data : null),
    itemKey: (row) => (row as { id: string }).id,
    itemKeyField: "id",
    rowType: (row) => (row as { kind: string }).kind,
    orderKey: "priority",
    scope: (_args, ctx) => (ctx as { workspaceId?: string }).workspaceId ?? "",
    schemaVersion: "work-items-list-v1",
    maxDeltaAge: 5 * 60_000,
  },
  // context-trimming-tiers P-012: trimmed/standard sessions get projected rows
  // (see shapeWorkItemsList). The cache stores the UNSHAPED rows (shaping runs
  // post-handler in defineTool dispatch), so one cached read serves every tier.
  shape: {
    standard: (data) => shapeWorkItemsList(data, "standard"),
    trimmed: (data) => shapeWorkItemsList(data, "trimmed"),
  },
  async handler(args, ctx) {
    const q = args.q?.trim() || undefined;
    // EI-21592729279587188: resolve the sourcePlanSlug/plan alias pair ONCE, here, so
    // every downstream site (the cache key AND the store filter) sees the same value.
    // Resolving per-site is how an alias half-lands: the filter would narrow while the
    // cache key stayed null, so one caller's `plan` read could be served to another
    // caller's unfiltered read from cache — a wrong-rows bug, not a missing-filter one.
    if (
      args.sourcePlanSlug !== undefined &&
      args.plan !== undefined &&
      args.sourcePlanSlug !== args.plan
    ) {
      throw new Error(
        "`plan` and `sourcePlanSlug` are the SAME filter (alias-group:sourcePlanSlug|plan) — pass only one. You passed both with different values, so which one wins would be ambiguous.",
      );
    }
    const sourcePlanSlug = args.sourcePlanSlug ?? args.plan;
    // EI-22638011562769666: `states` is a compatibility alias for the array form
    // of `state`. Reject both spellings rather than silently choosing one (or
    // accidentally turning an alias into an undocumented intersection filter).
    if (args.state !== undefined && args.states !== undefined) {
      throw new Error(
        "`state` and `states` are the SAME filter (alias-group:state|states) — pass only one. You passed both, so which one wins would be ambiguous.",
      );
    }
    // WI-42508: the result shaper runs AFTER the handler, so a trimmed/standard
    // response must choose a lean SQL projection BEFORE postgres-js materializes
    // rows.  No ctx tier is the UI/sync path and intentionally keeps the historical
    // full read; an explicit payloadTier:"full" is the documented detail escape.
    const tierCtx = ctx as {
      contextTier?: "trimmed" | "standard" | "full";
      payloadTierOverride?: "trimmed" | "standard" | "full";
    };
    const leanSource =
      tierCtx.payloadTierOverride !== "full" &&
      (tierCtx.contextTier === "trimmed" || tierCtx.contextTier === "standard");
    const includeBody = !leanSource;
    const includePayload = !leanSource;
    // EI-6506: `mine` resolves to the CALLER's own agent identity — an explicit
    // `assignee` wins if both are passed (mine is the no-args-needed convenience,
    // not an override of a deliberate lookup of someone else's work).
    //
    // EI-18821495781915490: `assignee: 'self'` means the CALLER too. Every sibling
    // that takes an owner resolves that literal — work_items:claim, claim_next and
    // create's `assign_to` (EI-9274) — so an agent taught the token by one of them
    // reasonably spells it here. This tool alone passed it through verbatim, asking
    // PG for an ownerId of "self", which no row can have.
    //
    // RESOLVED rather than rejected because of the DIRECTION it failed in: the
    // result was `[]`, which reads as "you hold nothing" — the exact answer an agent
    // acts on when deciding whether anything needs flushing before a compaction,
    // handoff, or wind-down. Observed live: it produced a false "nothing to
    // checkpoint" immediately before a session:request-compaction, and only the
    // compaction tripwire caught it. A wrong empty list is not recoverable by the
    // caller; a hard error would have been, but silence was worse than either.
    // WI-38339: the tool takes `state` as one value OR an array (the ergonomic surface);
    // the store keeps them as two fields, because every existing read site there casts
    // the single-valued `state`. Split once, here, so neither side carries a union.
    const stateOne = typeof args.state === "string" ? args.state : undefined;
    const stateMany = Array.isArray(args.state) ? args.state : args.states;
    const selfOwnerId = (): string => resolveAgentIdentity(ctx).ownerId;
    const assignee =
      args.assignee === "self"
        ? selfOwnerId()
        : (args.assignee ?? (args.mine ? selfOwnerId() : undefined));
    // D-041 (enterprise-data-sources-2026-10-01, WI-10005358): an AGENT's default listing
    // shows only rows the write doors accept (the category half of the agent-work
    // predicate). S36 measured the failure this closes: the default list showed a
    // human-audience row, the model attempted to close it, and the D-035 door refused.
    // The owner's own Queue UI (D-038) and any caller that names kind/natures/audience
    // keep the unfiltered read, mirroring the natures default ("unless kind is named").
    const audienceExplicit =
      args.audience !== undefined || (args.natures?.length ?? 0) > 0 || args.kind !== undefined;
    const audience =
      args.audience ??
      (audienceExplicit || isOwnerUiCaller(ctx as AgentWorkDoorCaller) ? undefined : "agent");
    const audienceDefaulted = args.audience === undefined && audience === "agent";
    // Cache the expensive list read (cache-expensive-tool-reads P-005). Non-principal-
    // scoped (depends only on workspace + the filter args). The bounding is folded INTO
    // the cached factory so the stored value is the final, deterministic-per-args result.
    const cached = await cachedRead(
      ctx as CachedReadCtx,
      {
        tool: "work_items:list",
        key: {
          harness: args.harness ?? null,
          q: q ?? null,
          kind: args.kind ?? null,
          state: stateOne ?? null,
          // WI-38339 ⚠ EVERY filter arg must appear in this key. It is hand-enumerated,
          // so an arg added above but forgotten here does not fail — it silently serves
          // ANOTHER caller's cached rows for a different filter, which is unfalsifiable
          // from the result. `states` is order-insensitive (it compiles to `= ANY(…)`),
          // so it is sorted to keep the key stable across equivalent calls.
          states: stateMany ? [...stateMany].sort().join(",") : null,
          notTerminal: args.notTerminal === true,
          createdSince: args.createdSince ?? null,
          updatedSince: args.updatedSince ?? null,
          sourcePlanSlug: sourcePlanSlug ?? null,
          assignee: assignee ?? null,
          assignedBy: args.assignedBy ?? null,
          parent: args.parent ?? null,
          includeChildren: args.includeChildren === true,
          admissibleOnly: args.admissibleOnly === true,
          audit: args.audit ?? null,
          completionAuthority: args.completionAuthority ?? null,
          includeObservations: args.includeObservations === true,
          natures: args.natures ?? null,
          audience: audience ?? null,
          // WI-42508: cache full and lean SQL projections separately.  The
          // ambient/session tier is otherwise deliberately outside this key because
          // shaping is a post-cache operation; the source projection is not.
          includeBody,
          includePayload,
          limit: args.limit ?? null,
        },
        // WI-4491: tag with the base TABLE `work_items` (the emit_change_notify producer,
        // bumped on EVERY work-item write), NOT the compat VIEW `harness_features_consolidated`
        // (relkind 'v' post-mig-374 — emits no `.changed`, so tagging it left this list
        // TTL-only-invalidated and serving stale backlogs after a write). Table-level is
        // correct for a list read: any work-item write can change the result set.
        tags: ["work_items"],
        softTtlMs: WORK_ITEMS_LIST_SOFT_TTL_MS,
      },
      async () => {
        const filter = {
          harness: args.harness,
          q,
          kind: args.kind as WorkItemKind | undefined,
          state: stateOne,
          states: stateMany,
          notTerminal: args.notTerminal,
          createdSince: args.createdSince,
          updatedSince: args.updatedSince,
          sourcePlanSlug,
          assignee,
          assignedBy: args.assignedBy,
          parent: args.parent,
          includeChildren: args.includeChildren,
          admissibleOnly: args.admissibleOnly,
          audit: args.audit,
          completionAuthority: args.completionAuthority as CompletionAuthorityFilter | undefined,
          includeObservations: args.includeObservations,
          natures: args.natures,
          audience,
          includeBody,
          includePayload,
          limit: args.limit,
        };
        // D-041: when the agent default narrowed the read, count what it withheld, so the
        // narrowing is visible instead of reading as the whole backlog. Both counts use the
        // SAME filter minus `audience`, so their difference is exactly the withheld set.
        // countWorkItems has no `q` (a known count-vs-list parity gap), so a q search
        // cannot be counted and reports an unknown population instead of a wrong number.
        const countable = audienceDefaulted && q === undefined;
        const [rows, agentCount, anyCount] = await Promise.all([
          listWorkItems(filter),
          countable ? countWorkItems(filter) : Promise.resolve(null),
          countable ? countWorkItems({ ...filter, audience: undefined }) : Promise.resolve(null),
        ]);
        // EI-1597: excerpt per-row summaries so a large backlog can't overflow the agent
        // result cap. Full body via work_items:get { id }.
        return { rows: boundSummaries(rows), agentCount, anyCount };
      },
    );
    const items = cached.rows;
    const withheld =
      cached.agentCount !== null && cached.anyCount !== null
        ? Math.max(0, cached.anyCount - cached.agentCount)
        : null;
    const denominator = !audienceDefaulted
      ? undefined
      : withheld === null
        ? {
            matched: items.length,
            population: "unknown" as const,
            of: "work-items",
            note: "the default agent filter applied; human-audience rows matching q were not counted. Pass audience:'any' to include them.",
          }
        : withheld > 0
          ? {
              matched: cached.agentCount as number,
              population: cached.anyCount as number,
              of: "work-items",
              note: `${withheld} human-audience row(s) withheld by the default agent filter; pass audience:'any' to include them.`,
            }
          : undefined;
    // P-030: the holder lens runs OUTSIDE the cache, and that placement is an
    // access requirement rather than a style choice — the cache key above is
    // deliberately non-principal-scoped, so resolving reader-relative holder
    // context inside the factory would store one reader's answer and serve it to
    // every other reader. Total + fail-soft: on any failure the rows are returned
    // exactly as the cache produced them.
    // `holderContextReader` returns null rather than throwing for a caller this tool
    // cannot attribute (`requirePrincipal: false` makes such a caller legitimate),
    // so the enrichment can never fail the read it decorates.
    const reader = holderContextReader(ctx as Parameters<typeof holderContextReader>[0]);
    const withHolders = await attachHolderContext(items, reader).catch(() => items);
    return denominator ? { data: withHolders, denominator } : { data: withHolders };
  },
});
