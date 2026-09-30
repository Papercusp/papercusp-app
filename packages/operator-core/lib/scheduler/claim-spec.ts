/**
 * Per-bee claim SPEC — the versioned, blueprint-style scheduling artifact the
 * Queen hands each bee (`hybrid-bee-scheduler-work-stealing-2026-06-22`,
 * Phases 1–2).
 *
 * A claim spec is a declarative, validated JSON artifact = a scoped **VIEW**
 * (filter) + an **ORDERING** (rank) over the live work-item DAG. A bee calls
 * `get_next`; the resolver compiles `(global hard floors AND spec.view.filter)`,
 * orders the survivors by `spec.rank`, and leases the top item (D-002, D-003).
 *
 * This module is ONLY the spec schema + the `validateClaimSpec` validator. The
 * `get_next` resolver is deliberately NOT here — it depends on the maintained
 * `ready` column owned by `work-item-deps-and-readiness-2026-06-22` (D-010).
 *
 * Design invariants this schema encodes:
 *  - **View, not copy** (D-003): the filter is a query over the live DAG, never
 *    a frozen subgraph. The schema describes the query; evaluation is the
 *    resolver's job.
 *  - **Versioned, not immutable** (D-003/D-006): `revision` bumps on every Queen
 *    re-steer; `get_next` records `specId@revision` per claim for provenance.
 *  - **Floors are not in the spec** (D-002): a spec can only NARROW + REORDER;
 *    `ready`/`cursed`/lease/dedup/risk-ceiling/admission/file-lock floors are
 *    ANDed in by the resolver and CANNOT appear in `view.filter`. The validator
 *    rejects a `blocked`/`cursed` filter term so a spec can never "un-floor"
 *    itself by re-asserting a floor it doesn't control.
 *
 * The vocabulary (item/bee fields, predicate ops, rank terms) is fixed: the
 * plan's "primitive vocabulary" + "global hard floors" sections. Adding a field
 * or term is a deliberate edit here (and a matching resolver change), so a
 * malformed spec is caught at author time with a clear error.
 */
import { z } from 'zod';
// Imported from the dependency-free leaf module, NOT '../work-items' — work-items.ts sits
// at the center of a long pre-existing transitive import cycle that runs back through
// sync/hyperbee/projections/register-all.ts -> projections/bee-claim-spec.ts ->
// scheduler/claim-spec.ts (this file). Importing the allowlist from '../work-items'
// directly closed that loop and crashed on the module-eval-time undefined binding
// (see scheduler/claim-states.ts's header for the full trace). Do NOT re-point this
// import back at '../work-items'.
import { CLAIM_STATES_ALLOWLIST } from './claim-states';
// p2p-lane-fence.ts only imports `type { FilterNode }` from THIS module (erased at
// compile time — no runtime dependency), so importing its runtime export here does not
// reopen the cycle above. Safe, one-directional at runtime: claim-spec.ts -> p2p-lane-fence.ts.
import { buildP2pLaneFence, buildP2pPlanLaneFence } from './p2p-lane-fence';

// ────────────────────────────────────────────────────────────────────────────
// Vocabulary — the fixed primitive set the Queen composes a spec from.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Item fields a `view.filter` predicate or a `rank` term may reference. Grounded
 * in `work_items` columns + derived fields (the plan's "Item fields" list).
 *
 * `blocked` + `cursed` are DERIVED/floor fields — readable conceptually but
 * NOT filterable in a spec (they are global floors the resolver owns); they are
 * excluded from `FILTERABLE_ITEM_FIELDS` below.
 */
export const ITEM_FIELDS = [
  'priority',
  'tags',
  'kind',
  'risk_tier',
  'paths',
  'plan',
  'plan_item',
  // `fleet` — EI-13524. A filter-only authorization field carried by
  // `payload.fleet_slug` on work-items promoted for a fleet-owned plan lane. It lets
  // a fleet spec explicitly adopt a stamped lane without making the fleet slug a
  // meaningful ordering dimension. The shared claim floors consume the same field
  // reference as an authorization signal; see claimSpecReferencesField below.
  'fleet',
  'age',
  'blocked',
  'cursed',
  'redundancy',
  'est_cost',
  'assignee',
  // `id` — the work-item id (feature_id). Filterable so a spec can PIN a specific
  // finite set (`id in [...]`), composing with the rest of the grammar. It is a STATIC
  // pin (no auto-inflow / work-stealing — a frozen candidate set), so it is the
  // exception for a fixed wave (hotfix / cutover / re-drive), NOT a standing lane (use a
  // property filter for that). NOT rankable (ordering by id is meaningless) and the
  // observability tripwire `isIdOnlySelector` flags specs that select on id ALONE.
  'id',
  // `title` — the work-item title text. Filterable (WI-3268) so a constrained fleet can
  // durably EXCLUDE a class of work the `tags`/`redundancy` columns don't classify — e.g.
  // `{ not: { field:'title', op:'word', value:'p2p' } }` to stop re-encountering p2p work
  // whose items carry no `tags` at all (the pre-existing tag-based exclusion path is a
  // no-op when tags are unpopulated, which is the common case today). Composes with `not`/
  // `any`/`all` like every other leaf. NOT rankable (ordering by title text is meaningless,
  // same rationale as `id`) — excluded from `RANKABLE_ITEM_FIELDS` below.
  // EI-18690730909662985: prefer `word` (whole-word, case-insensitive) over `glob` for a
  // bare keyword exclusion like this — `glob`'s `*p2p*` is a raw SUBSTRING match, so it
  // false-positives on any title merely CONTAINING "p2p" as part of a longer word (e.g. a
  // fleet named "nonp2p-bug-drain" excluding itself). `word` anchors to word boundaries
  // (`\bp2p\b`) so "P2P sync fails" still matches but "nonp2p-bug-drain" does not. `glob`
  // remains right for wildcard/prefix/suffix shapes (`lib/p2p/*`, `*.test.ts`).
  'title',
  // `summary` — EI-20240035377782004. The work-item summary/body text. Filterable for
  // exactly `title`'s reason (WI-3268), one layer deeper: a keyword exclusion fence
  // (p2p-lane-fence.ts's `buildP2pLaneFence`) that matches ONLY `title` admits an item
  // whose TITLE is generic but whose SUMMARY explicitly names the excluded class — a
  // live scope leak (fleet nonp2p-bug-drain-luna-max-0811 rev3 admitted EI-20239498607103954,
  // titled generically but summarized "accepted P-205 Mac peer", "federation drills",
  // "vm-rig MCP parity"). Same column as `harness_features_consolidated.summary` / the
  // issue-family `work_items.summary`, so it is a real physical column on the base table
  // for BOTH families — no COALESCE/payload fallback needed (mirrors `goal`'s note above).
  // Composes with `not`/`any`/`all` like `title`. NOT rankable — ordering by summary text
  // is meaningless, same rationale as `title`/`id` — excluded from `RANKABLE_ITEM_FIELDS`.
  'summary',
  // `severity` — WI-6675. The issue-family severity (critical|major|minor|nit), read from
  // `payload._ei.severity` with a `payload.severity` fallback (the WI-6674 two-path hazard:
  // the accessor differs by RELATION, and the wrong one returns NULL for every row without
  // erroring). Filterable so a drain lane can finally say what it most needs to say —
  // `{ field:'severity', op:'in', value:['critical','major'] }`. Before this, severity was
  // absent from the vocabulary entirely, so a spec could not scope by it at all and the
  // DEFAULT spec's rank collapsed to plain oldest-first (affinity is NEUTRAL for a bee
  // holding no paths; feature_order is NULL on issue-family rows) — serving 19 critical +
  // 215 major bugs strictly behind ~980 minor/nit changes that merely happened to be older.
  // NOT rankable — see RANKABLE_ITEM_FIELDS below for why a bare sort on it is a trap.
  'severity',
  // `goal` — WI-37711. The goal a work-item was filed under (`work_items.goal_id`,
  // migration 785 / P-002, stamped by `stampGoalProvenance`). Filterable so a STANDING
  // PER-GOAL DRAIN FLEET can finally be expressed — `{ field:'goal', op:'=', value:<goalId> }`
  // — which is the whole point: an agent in goal mode files bugs/changes/tasks STRAIGHT onto
  // the queue, so those rows carry a goal_id and NO plan, and the `plan`/`tags` approximations
  // miss exactly them.
  //
  // ⚠ NULLABLE and sparsely stamped. The POSITIVE `=`/`in` form excludes every unstamped row,
  // so it can starve a newly-created goal whose queue has no stamped rows yet. The compiler's
  // NULL-safe `not`/`!=` form admits unstamped rows; use that polarity only as a measured
  // exclusion fence (with the active-goal set verified), never as an unexamined substitute for
  // this goal's own positive fence. See the GOAL contract and scheduler:set_claim_spec's
  // positive-fence replacement guard (EI-22389918023611568).
  //
  // NOT rankable — an opaque goal id has no meaningful order, same rationale as `id`/`title`.
  'goal',
  // `triage_gate` — EI-16052. The improvement-triage decision from
  // `payload.ideaLifecycle.triageDecision` ('place'|'gate'|'gym'|'reject'), where 'gate'
  // means a HUMAN gate: triage decided this needs a design draft or an owner before anyone
  // implements it. Filterable so a drain lane can finally fence gated work OUT —
  // `{ not: { field:'triage_gate', op:'=', value:'gate' } }`.
  //
  // WHY IT HAD TO BE ADDED. Nothing else in the system expresses this. There is no gate
  // entry in the 19-key floor vocabulary (`ISSUE_FLOOR_EXPLANATIONS`), and no field here
  // reached into `ideaLifecycle`, so a gated row was claimable by any spec that otherwise
  // matched it. Measured on the live queue: 418 open non-observation issue-family rows carry
  // triageDecision='gate' with no `_claimHold`. They are held back today only INCIDENTALLY —
  // by admission-pending and by ad-hoc `_claimHold` — and admission clears on the promoter's
  // own cadence, so the exposure GROWS rather than settles. The filing item is its own
  // reproduction: EI-16052 is triageDecision='gate' + ideaType='needs-design', and
  // scheduler:get_next served it to a drain member under spec rev 15.
  //
  // ⚠ POLARITY. Unlike `goal` (whose positive `=`/`in` form starves on unstamped rows), the
  // useful form here is the NEGATIVE one, and it is null-safe by the same compiler leg: most
  // rows carry no `ideaLifecycle` at all, so `not(triage_gate = 'gate')` admits every
  // unstamped row and excludes only the deliberately gated ones. Prefer that polarity; a
  // positive `triage_gate = 'place'` fence would silently exclude the whole untriaged backlog.
  //
  // NOT rankable — a triage decision is a category, not an order; excluded from
  // `RANKABLE_ITEM_FIELDS` alongside `fleet`/`risk_tier`.
  'triage_gate',
] as const;
export type ItemField = (typeof ITEM_FIELDS)[number];

/**
 * Bee/context fields — the pulling bee's own state, available to filters and
 * rank terms (the plan's "Bee/context fields" list). Referenced in the spec as
 * `bee.<field>` (e.g. `bee.held_paths` inside an `affinity(...)` term).
 */
export const BEE_FIELDS = ['model', 'held_paths', 'load', 'current_plan'] as const;
export type BeeField = (typeof BEE_FIELDS)[number];

/**
 * Fields a `view.filter` predicate may target. EXCLUDES the floor/derived fields
 * `blocked` + `cursed`: those are global hard floors the resolver ANDs in, never
 * spec-controlled (D-002). A spec that filters on them is rejected — it would be
 * either redundant (re-asserting a floor) or, worse, an attempt to widen past one.
 */
export const FILTERABLE_ITEM_FIELDS = ITEM_FIELDS.filter((f) => f !== 'blocked' && f !== 'cursed') as Exclude<
  ItemField,
  'blocked' | 'cursed'
>[];

/**
 * Predicate operators usable in a `view.filter` leaf (the plan's "Predicates").
 * `word` (EI-18690730909662985) is a case-insensitive WHOLE-WORD substring match
 * (`\bvalue\b`) — unlike `glob`'s `*value*`, which is a bare, unanchored substring
 * match that false-positives when the literal appears inside a larger word (e.g.
 * `*p2p*` matching "nonp2p-bug-drain"). Prefer `word` for a bare keyword exclusion;
 * `glob` stays right for wildcard/prefix/suffix shapes.
 */
export const FILTER_OPS = ['=', '!=', '<', '<=', '>', '>=', 'in', 'contains', 'glob', 'word'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/**
 * Rank term expressions (the plan's "Rank terms"). Two flavours:
 *  - a bare item field name (`priority`, `age`, `est_cost`, …) — order by that column;
 *  - a function term — `affinity(bee.held_paths,item.paths)`,
 *    `model_fit(bee.model,item)`, `tag_weight(tags)`, `redundancy_need`.
 *
 * Function terms are matched by their *head* (the identifier before `(`), so the
 * Queen may write the documented argument forms verbatim. `redundancy_need` is
 * accepted both bare and called. `model_fit` is in the vocabulary (so specs that
 * reference it validate) even though the resolver leaves it neutral until the
 * per-MODEL capability lane ships behind its own flag (D-010).
 */
export const RANK_FUNCTIONS = [
  'affinity',
  'model_fit',
  'tag_weight',
  'redundancy_need',
  // `severity_rank` (EI-19286355119013384) — the ORDINAL severity term, and the supported
  // way to order by severity. It exists because the bare `severity` field is deliberately
  // NOT rankable: severity is stored as TEXT, so `severity desc` compiles to a LEXICAL sort
  // (nit > minor > major > critical — exactly backwards) that reads as though it prioritizes
  // criticals. Rather than leave that capability gap open, this term compiles to an explicit
  // CASE (critical=4, major=3, minor=2, nit=1, absent/unrecognized=0), which is a real
  // integer and therefore both correctly ordered and safe in `weighted` mode.
  //
  // Feature-family rows carry no severity (work-items.ts maps them `severity: null`), so the
  // CASE yields 0 for every one of them — a clean, error-free NULL leg on a relation where
  // severity is structurally absent, matching how the `severity` FILTER already behaves.
  'severity_rank',
  // `dependency_unlock_score` (work-item-deps-and-readiness Phase 5) — one-hop dependency
  // leverage: how many present non-terminal downstream items would become dependency-ready
  // if this candidate completed now. This is intentionally NOT descendant centrality; a
  // descendant that remains blocked at the next hop is not unlocked and earns no credit.
  // The SQL oracle reads the existing work_item_deps graph and the same per-family endpoint /
  // terminal semantics as the readiness floor. It returns an integer, so the term is safe in
  // both lexicographic and weighted modes. The score is also projected by
  // work_items:claimable as `dependencyUnlockScore`, making the ordering inspectable.
  'dependency_unlock_score',
  // `cluster_priority` (silent-intake-central-resolution P-008) — the size of the
  // largest resolver cause-cluster this item belongs to. The whole-corpus resolver
  // computes the cluster and persists this numeric projection as
  // payload.clusterPriority on the cluster parent and each member. The scheduler
  // deliberately does NO clustering or graph traversal at assignment time; it only
  // reads the projection. Missing/malformed values score 0, so the term is safe on
  // every ordinary item and in both lexicographic and weighted modes.
  'cluster_priority',
] as const;
export type RankFunction = (typeof RANK_FUNCTIONS)[number];

/**
 * Item fields whose underlying column is NUMERICALLY orderable — and therefore the
 * only fields a `weighted` rank may name as a bare term.
 *
 * This is not a stylistic list. `weighted` mode compiles Σ wᵢ·termᵢ into ONE sort key,
 * and get-next.ts's `compileRank` casts every contributing term to `::numeric`. On a
 * non-numeric column that cast is a hard Postgres ERROR that aborts the entire claim
 * query — so the failure mode is not a mis-ordering, it is a spec that VALIDATED and
 * then wedges the lane it was written for. Measured against the live tables 2026-08-01:
 *
 *   (source_plan_item_ids)::numeric      ⇒ ERROR: cannot cast type text[] to numeric
 *   (COALESCE(item_kind,kind))::numeric  ⇒ ERROR: invalid input syntax for type numeric: "feature"
 *
 * and the text legs (`assignee`, `plan`, `risk_tier`) are worse still: they cast
 * cleanly while the column is NULL and start erroring the moment a row carries real
 * data — green on an empty fixture, red in production, on a schedule nobody chose.
 *
 * The exposure is live, not theoretical: 4 specs rank on `plan_item` today. They are
 * `lexicographic`, so they are fine — but flipping one to `weighted` is a ONE-WORD edit
 * away from that error, with nothing between the author and the outage. Hence the
 * validator rejects the combination instead of trusting authors to know the cast rule.
 *
 * All four members cast cleanly: `priority` ⇒ feature_order and `redundancy` are
 * `integer`; `age` ⇒ created_ts and `est_cost` ⇒ expected_cost_cents are `bigint`.
 * Rank FUNCTIONS are exempt by construction — `affinity` compiles to a `count(*)`, and
 * the descoped terms (`model_fit`/`tag_weight`/`redundancy_need`) compile to NEUTRAL and
 * never reach the cast.
 */
export const NUMERIC_ITEM_FIELDS = ['priority', 'age', 'est_cost', 'redundancy'] as const;

/** Item fields that may be used as a bare rank term (everything sortable). `id` is
 *  filterable (pin a set) but NOT rankable — ordering by id is meaningless, and an
 *  id-pin is about WHICH items, never their order (use priority/age for that). `title`
 *  is the same shape: filterable for keyword exclusion (WI-3268), not a sort key.
 *
 *  `severity` (WI-6675) is excluded for a SHARPER reason than "meaningless": a bare sort
 *  on it is meaningful-looking and WRONG. Severity is stored as TEXT, so `severity desc`
 *  compiles to a LEXICAL ordering — nit > minor > major > critical — i.e. exactly
 *  backwards, serving nits first while the spec reads as though it prioritizes criticals.
 *  A silently-inverted ordering is worse than the capability gap it would close, so the
 *  bare form is REJECTED at validation rather than accepted-and-neutralized (an unknown
 *  rank head compiles to NEUTRAL in get-next.ts's compileRankExpr, which would make a
 *  typo'd severity rank silently do nothing — the same failure in a quieter costume).
 *  Correct ordinal ranking needs a `severity_rank` FUNCTION term compiling to an explicit
 *  CASE (critical=4…nit=1); until that ships, filtering is the supported lever.
 *
 *  `risk_tier` (EI-19286311763526137) is excluded for EXACTLY severity's reason — it was
 *  flagged here as "the next domino" when severity landed, and this is that domino. It
 *  lives in `payload` jsonb, so `payload->>'risk_tier'` is TEXT however numeric the value
 *  looks, and a bare sort is therefore lexical: '10' orders before '2', and a word-valued
 *  tier orders high < low < medium. Same silent inversion, same rejection. Verified safe
 *  to remove 2026-08-01: 0 of 146 bee specs and 0 of 146 cup specs rank on it, and no row
 *  in `work_items` carries a `risk_tier` key at all — it remains FILTERABLE, which is the
 *  only way it has ever been used. */
export const RANKABLE_ITEM_FIELDS = FILTERABLE_ITEM_FIELDS.filter(
  (f) =>
    f !== 'id' &&
    f !== 'title' &&
    f !== 'summary' &&
    f !== 'severity' &&
    f !== 'risk_tier' &&
    f !== 'goal' &&
    f !== 'fleet' &&
    f !== 'triage_gate',
);

export const CURRENT_SPEC_VERSION = '1.0' as const;
/** Schema versions this validator understands. Bump + branch when the shape changes. */
export const SUPPORTED_SPEC_VERSIONS = ['1.0'] as const;

/**
 * Unambiguous human-readable "which spec, which revision" label
 * (work-item-claimability-clarity-2026-07-20 / EI-18676258006299036).
 *
 * The bare `"<specId>@<revision>"` form used to be interpolated all over the scheduler's
 * diagnostic/refusal messages. `"<name>@<number>"` overwhelmingly reads as a size/replica
 * annotation in ops tooling — a fleet member misread `nonp2p-bug-drain-0725@5` as "5 live
 * members" against a real roster of 10, escalated a false "duplicate session" anomaly to
 * the leader, and it will recur in the opposite direction too (revision > member count
 * reads as "sessions are missing"). Every scheduler/fleet message that names a spec+revision
 * MUST go through this helper instead of hand-rolling the `@` form.
 */
export function formatSpecRef(specId: string, revision: number | null | undefined): string {
  return revision == null ? `${specId} (spec rev unknown)` : `${specId} (spec rev ${revision})`;
}

// ────────────────────────────────────────────────────────────────────────────
// Zod schema — the wire/persisted shape of a claim spec.
// ────────────────────────────────────────────────────────────────────────────

const filterableFieldSchema = z.enum(FILTERABLE_ITEM_FIELDS as [string, ...string[]]);
const filterOpSchema = z.enum(FILTER_OPS);

/** A scalar a predicate compares against: a number, string, boolean, or list thereof. */
const filterScalarSchema = z.union([z.number(), z.string(), z.boolean()]);
const filterValueSchema = z.union([filterScalarSchema, z.array(filterScalarSchema)]);

/**
 * A single comparison leaf: `{ field, op, value }`. The op/value coherence (e.g.
 * `in` wants an array; `<=` wants a number) is checked semantically in
 * `validateClaimSpec` so the error names the field, not a deep Zod union path.
 */
export const filterLeafSchema = z
  .object({
    field: filterableFieldSchema,
    op: filterOpSchema,
    value: filterValueSchema,
  })
  .strict();

export type FilterLeaf = z.infer<typeof filterLeafSchema>;

/**
 * The boolean combinator tree. A node is exactly ONE of: a leaf, `{ all: [...] }`,
 * `{ any: [...] }`, or `{ not: <node> }`. Recursive, so `z.lazy`.
 */
export type FilterNode = FilterLeaf | { all: FilterNode[] } | { any: FilterNode[] } | { not: FilterNode };

/**
 * Positive targeting predicate shared by the goal/plan fleet watchdog and
 * portfolio receipts. AND narrows; every OR arm must retain the target;
 * negation is never positive scope. An IN allowlist may name multiple targets:
 * this proves targeting, not exclusive ownership or a matching worker claim.
 */
export function claimSpecFilterPositivelyTargets(filter: unknown, field: ItemField, value: string): boolean {
  if (!filter || typeof filter !== 'object') return false;
  const node = filter as Record<string, unknown>;
  if (Array.isArray(node.all)) return node.all.some((n) => claimSpecFilterPositivelyTargets(n, field, value));
  if (Array.isArray(node.any)) return node.any.length > 0 && node.any.every((n) => claimSpecFilterPositivelyTargets(n, field, value));
  if ('not' in node || node.field !== field) return false;
  if (node.op === '=') return node.value === value;
  return node.op === 'in' && Array.isArray(node.value) && node.value.includes(value);
}

/**
 * True when a claim spec's filter tree references `field` anywhere, including
 * below `all` / `any` / `not`. This is intentionally structural: callers that
 * use a field reference as an authorization signal must not re-implement a
 * shallower predicate walk and silently disagree on nested specs.
 */
export function claimSpecReferencesField(spec: unknown, field: ItemField): boolean {
  function walk(node: unknown): boolean {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
    const obj = node as { field?: unknown; all?: unknown; any?: unknown; not?: unknown };
    if (typeof obj.field === 'string') return obj.field === field;
    if (Array.isArray(obj.all)) return obj.all.some(walk);
    if (Array.isArray(obj.any)) return obj.any.some(walk);
    if ('not' in obj) return walk(obj.not);
    return false;
  }
  const filter = (spec as { view?: { filter?: unknown } } | null | undefined)?.view?.filter;
  return walk(filter);
}

export const filterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    filterLeafSchema,
    z.object({ all: z.array(filterNodeSchema).min(1) }).strict(),
    z.object({ any: z.array(filterNodeSchema).min(1) }).strict(),
    z.object({ not: filterNodeSchema }).strict(),
  ]),
);

/**
 * Named `view.fence` macros a spec may reference by name — each expands, at
 * validate/write time, into a `FilterNode` ANDed onto `view.filter` (WI-6050).
 *
 * WHY a name instead of requiring the term list inline: a claim spec is authored
 * over MCP as raw JSON (`scheduler:set_claim_spec`), a surface a human or agent
 * leader works from directly — they cannot `import buildP2pLaneFence()` from
 * TypeScript. Before this, the p2p/federation/rig exclusion could only ever be
 * hand-retyped into the spec's `title`/`word` clauses, which is exactly the
 * drift `p2p-lane-fence.ts` was created to stop and then regressed THREE times
 * anyway (WI-5265/5272/WI-5639) because nothing forced a hand-edit through the
 * shared source. Referencing `fence:'p2p-lane'` instead makes the shared source
 * the path of least resistance: expansion always reads the CURRENT
 * `P2P_LANE_EXCLUSION_TERMS`, so a future addition to that list benefits every
 * spec re-authored with the macro without anyone hand-copying terms again.
 *
 * Add a new entry here (never a second ad hoc term list elsewhere) when another
 * class of work needs the same "author can't import the builder" treatment.
 */
export const CLAIM_SPEC_FENCE_MACROS = {
  'p2p-lane': buildP2pLaneFence,
  'p2p-plan-lane': buildP2pPlanLaneFence,
} satisfies Record<string, () => FilterNode>;

// Keep the wire schema in lockstep with the registry above. A free-form string
// here advertises names the validator can never expand and makes raw MCP callers
// discover the closed vocabulary only after a rejected write.
const CLAIM_SPEC_FENCE_MACRO_KEYS = Object.keys(CLAIM_SPEC_FENCE_MACROS) as [
  keyof typeof CLAIM_SPEC_FENCE_MACROS,
  ...(keyof typeof CLAIM_SPEC_FENCE_MACROS)[],
];

/**
 * `viewSchema` carries the filter as an UNVALIDATED record. The strict
 * `filterNodeSchema` above is a deeply-nested union, and Zod collapses any leaf
 * failure (an unknown `field`, a bad `op`) into a single useless
 * `"view.filter: Invalid input"` at the union root — it can't tell you *which*
 * leaf or *why*. Since the whole point of the validator is a CLEAR error, the
 * filter tree is instead walked semantically by `validateFilterNode`, which
 * names the offending field/op/combinator at its exact path. The exported
 * `filterNodeSchema` / `FilterNode` type stay available for consumers that want
 * a strict structural Zod parse (e.g. the resolver compiling the query).
 */
export const viewSchema = z
  .object({
    filter: z.record(z.string(), z.unknown()).optional(),
    /**
     * WI-6050: a named FENCE macro, expanded server-side into `filter` at
     * validate/write time — see {@link CLAIM_SPEC_FENCE_MACROS}. Lets an author
     * working in raw MCP JSON (who cannot `import buildP2pLaneFence()`) reference
     * a shared exclusion-term source BY NAME instead of hand-retyping its terms,
     * which is the exact drift that regressed the p2p-lane fence three times.
     */
    fence: z.enum(CLAIM_SPEC_FENCE_MACRO_KEYS).optional(),
  })
  .strict();

const rankDirSchema = z.enum(['asc', 'desc']);

/**
 * A rank term: an `expr` (a bare item field OR a function term) + a direction.
 * `weight` is required only in `mode: "weighted"` (checked semantically).
 */
export const rankTermSchema = z
  .object({
    expr: z.string().min(1),
    dir: rankDirSchema,
    weight: z.number().finite().optional(),
  })
  .strict();

export type RankTerm = z.infer<typeof rankTermSchema>;

export const rankSchema = z
  .object({
    mode: z.enum(['lexicographic', 'weighted']),
    terms: z.array(rankTermSchema).min(1),
  })
  .strict();

export type Rank = z.infer<typeof rankSchema>;

export const limitsSchema = z
  .object({
    maxConcurrentClaims: z.number().int().positive().optional(),
    claimTtlSec: z.number().int().positive().optional(),
  })
  .strict();

/**
 * `states` — the claimable-status subset (drain-claim-spec-hardening-2026-07-13 D-002,
 * fixes EI-11300). The SAME allowlist `scheduler:get_next`'s own `states` arg enforces
 * (`CLAIM_STATES_ALLOWLIST` — never widen past a floor: `blocked`/`cursed` stay
 * resolver-owned, terminal states stay settled). Drain-wide POLICY: a fleet leader sets
 * it ONCE on the fleet spec (`scheduler:set_claim_spec`) and every member inherits it via
 * `get_next` — instead of every member having to remember to pass its own `states` override
 * (the starve class EI-11300 names: an issue-family drain wants `states:['open']`, but the
 * per-call default is `['todo']`, so a member that cold-wakes back onto the default silently
 * pulls nothing from a backlog full of open bugs). An explicit per-call `states` on
 * `get_next` still WINS over this (member judgment overrides the spec, same precedence as
 * every other narrowing) — this field is only the fallback when the caller omits one.
 */
export const claimableStatesSchema = z
  .array(z.enum(CLAIM_STATES_ALLOWLIST as unknown as [string, ...string[]]))
  .max(20);

/**
 * The full claim spec. `specVersion` is validated against `SUPPORTED_SPEC_VERSIONS`
 * semantically (so the error is "unsupported spec version 0.9", not a Zod enum dump);
 * the Zod field only checks it is a non-empty string.
 */
export const claimSpecSchema = z
  .object({
    specVersion: z.string().min(1),
    specId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    basedOn: z.string().min(1).optional(),
    boundModel: z.string().min(1).optional(),
    view: viewSchema,
    rank: rankSchema,
    limits: limitsSchema.optional(),
    states: claimableStatesSchema.optional(),
  })
  .strict();

/**
 * The full claim spec type. The Zod schema keeps `view.filter` permissive (an
 * unvalidated record — see `viewSchema`) so leaf errors stay clear, but consumers
 * (notably the `get_next` resolver) want the structured tree, so the exported
 * type narrows `view.filter` to the typed `FilterNode` — the semantic walk in
 * `validateClaimSpec` guarantees that shape at runtime once `ok === true`.
 */
export type ClaimSpec = Omit<z.infer<typeof claimSpecSchema>, 'view'> & {
  view: { filter?: FilterNode };
};

// ────────────────────────────────────────────────────────────────────────────
// Validator — returns issues, never throws (mirrors blueprint:validate).
// ────────────────────────────────────────────────────────────────────────────

export interface ClaimSpecValidation {
  /** True only when there are zero errors. Warnings still allow `ok`. */
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** The parsed spec, present when the Zod shape passed (even if semantics added errors). */
  spec?: ClaimSpec;
}

/** Operators whose `value` must be a list. */
const ARRAY_OPS = new Set<string>(['in']);
/** Operators whose `value` must be a single scalar. */
const SCALAR_OPS = new Set<string>(['=', '!=', '<', '<=', '>', '>=', 'contains', 'glob', 'word']);
/** Operators that require a numeric `value`. */
const NUMERIC_OPS = new Set<string>(['<', '<=', '>', '>=']);

const FILTERABLE_FIELD_SET = new Set<string>(FILTERABLE_ITEM_FIELDS);
const FILTER_OP_SET = new Set<string>(FILTER_OPS);
/** Floor/derived fields that are never spec-controlled — named so the error explains WHY. */
const FLOOR_FIELDS = new Set<string>(['blocked', 'cursed']);

/**
 * Parse the `expr` head of a rank term: `model_fit(...)` → `model_fit`,
 * `priority` → `priority`. Returns the bare identifier before any `(`.
 */
function rankExprHead(expr: string): string {
  const paren = expr.indexOf('(');
  return (paren === -1 ? expr : expr.slice(0, paren)).trim();
}

const FILTER_SCALAR_TYPES = new Set(['number', 'string', 'boolean']);
function isFilterScalar(v: unknown): boolean {
  return FILTER_SCALAR_TYPES.has(typeof v);
}

/**
 * Walk the filter combinator tree, pushing a CLEAR, path-named error for each
 * problem (the reason this is hand-walked rather than left to a Zod union — see
 * `viewSchema`). A node is exactly one of: a `{field,op,value}` leaf, `{all:[…]}`,
 * `{any:[…]}`, or `{not:…}`. Anything else (multiple keys, unknown key, non-object)
 * is reported at its path. `node` is `unknown` because `viewSchema` keeps the
 * filter unvalidated.
 */
function validateFilterNode(node: unknown, path: string, errors: string[]): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(
      `${path}: filter node must be an object (a leaf, or all/any/not), got ${Array.isArray(node) ? 'array' : typeof node}`,
    );
    return;
  }
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Combinators — each takes exactly its own key.
  if ('all' in obj || 'any' in obj || 'not' in obj) {
    const combinator = ('all' in obj ? 'all' : 'any' in obj ? 'any' : 'not') as 'all' | 'any' | 'not';
    if (keys.length !== 1) {
      errors.push(`${path}: combinator "${combinator}" must be the only key, found {${keys.join(', ')}}`);
      return;
    }
    if (combinator === 'not') {
      validateFilterNode(obj.not, `${path}.not`, errors);
      return;
    }
    const children = obj[combinator];
    if (!Array.isArray(children) || children.length === 0) {
      errors.push(`${path}.${combinator}: must be a non-empty array of filter nodes`);
      return;
    }
    children.forEach((child, i) => validateFilterNode(child, `${path}.${combinator}[${i}]`, errors));
    return;
  }

  // Otherwise it must be a leaf: {field, op, value}.
  const extraKeys = keys.filter((k) => k !== 'field' && k !== 'op' && k !== 'value');
  if (extraKeys.length > 0) {
    errors.push(`${path}: unknown filter key(s) {${extraKeys.join(', ')}} — a leaf is {field, op, value}`);
  }
  const { field, op, value } = obj as { field?: unknown; op?: unknown; value?: unknown };

  if (typeof field !== 'string') {
    errors.push(`${path}: leaf "field" is required and must be a string`);
  } else if (FLOOR_FIELDS.has(field)) {
    errors.push(
      `${path}: field "${field}" is a global hard floor, not spec-controlled — a spec can only narrow+reorder, never re-assert a floor`,
    );
  } else if (!FILTERABLE_FIELD_SET.has(field)) {
    errors.push(`${path}: unknown filter field "${field}" (allowed: ${FILTERABLE_ITEM_FIELDS.join(', ')})`);
  }

  if (typeof op !== 'string' || !FILTER_OP_SET.has(op)) {
    // EI-21906739799895413: the single most common filter-authoring confusion —
    // treating "any"/"all"/"not" as a leaf OPERATOR (`{ op:'any', of:[...] }`)
    // instead of the actual top-level COMBINATOR key (`{ any: [...] }`, a sibling
    // shape to a leaf, handled earlier in this function). The DSL has always
    // supported OR/AND/NOT composition this way — this is a mis-syntax report,
    // not a missing-feature one — but the prior generic "unknown filter op"
    // message gave no hint that a combinator (rather than an operator) was what
    // the author actually wanted. Name the correct shape explicitly so this
    // exact confusion (measured live: an author who KNEW they needed OR
    // semantics still could not find the working syntax from this message
    // alone) resolves itself instead of reading as "no boolean composition
    // exists".
    if (op === 'all' || op === 'any' || op === 'not') {
      errors.push(
        `${path}: "${op}" is not a filter operator — "all"/"any"/"not" are top-level COMBINATOR keys, ` +
          `not values of "op". Boolean composition already exists: write { ${op}: [...] } as a SIBLING shape ` +
          'to a leaf (never nested inside one), e.g. ' +
          '{ any: [ { field:"plan", op:"=", value:"<slug>" }, { field:"id", op:"in", value:[…] } ] } for OR, ' +
          'or { all: [...] } for AND, or { not: <node> } for NOT. A leaf itself is always exactly ' +
          `{field, op, value} with op one of: ${FILTER_OPS.join(', ')}.`,
      );
      return;
    }
    errors.push(`${path}: unknown filter op ${JSON.stringify(op)} (allowed: ${FILTER_OPS.join(', ')})`);
    return; // op-dependent value checks below are meaningless without a known op
  }

  // value coherence — only meaningful once field+op are sane.
  const isArray = Array.isArray(value);
  if (isArray) {
    if (!(value as unknown[]).every(isFilterScalar)) {
      errors.push(`${path}: every element of an array value must be a number, string, or boolean`);
    }
  } else if (!isFilterScalar(value)) {
    errors.push(`${path}: value must be a number, string, boolean, or array thereof`);
  }
  if (ARRAY_OPS.has(op) && !isArray) {
    errors.push(`${path}: op "${op}" on field "${String(field)}" requires an array value`);
  }
  if (SCALAR_OPS.has(op) && isArray) {
    errors.push(`${path}: op "${op}" on field "${String(field)}" requires a single scalar value, got an array`);
  }
  if (NUMERIC_OPS.has(op) && !isArray && typeof value !== 'number') {
    errors.push(`${path}: op "${op}" on field "${String(field)}" requires a numeric value`);
  }
}

/**
 * EI-18699032970141084: a structural authoring footgun in `view.filter` — a bare
 * `kind` clause (matches broadly: virtually every issue-family item of that kind)
 * sitting as a SIBLING disjunct inside an `any` alongside scoping clauses (plan/
 * plan_item/tags/id/paths). Because `any` is OR, the broad `kind` disjunct alone
 * is sufficient for admission, silently defeating the scoping disjuncts — the
 * author almost always meant "these kinds, AND within this scope" (`all`), not
 * "these kinds, OR this scope" (`any`). Observed live: a fleet's plan/tag/id
 * scoping disjuncts were entirely dead weight because a `kind in [bug,change,task]`
 * leaf sat alongside them in the same `any`, so `scheduler:get_next` handed the
 * fleet unrelated backlog items.
 *
 * Detects the SHAPE only (any `any` node, anywhere in the tree, with a direct
 * `kind` leaf sibling next to a direct scoping-field leaf) — advisory, never a
 * hard rejection: an author may occasionally want the true OR semantics.
 */
const KIND_FOOTGUN_SCOPING_FIELDS = new Set<string>(['plan', 'plan_item', 'tags', 'id', 'paths']);

function isFilterLeafOnField(node: unknown, field: string): boolean {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
  const obj = node as Record<string, unknown>;
  return typeof obj.field === 'string' && obj.field === field;
}

function detectBroadKindDisjunctFootgun(node: unknown, path: string, warnings: string[]): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.any)) {
    const children = obj.any as unknown[];
    const hasKindLeaf = children.some((c) => isFilterLeafOnField(c, 'kind'));
    const hasScopingSibling = children.some((c) =>
      [...KIND_FOOTGUN_SCOPING_FIELDS].some((f) => isFilterLeafOnField(c, f)),
    );
    if (hasKindLeaf && hasScopingSibling) {
      warnings.push(
        `${path}.any: a bare "kind" clause sits alongside plan/tags/id/paths-scoping clause(s) inside this ` +
          '"any" (OR) — the kind clause alone admits virtually the whole backlog of that kind, silently ' +
          'defeating the scoping disjuncts (EI-18699032970141084). If you meant "these kinds, AND within this ' +
          'scope", nest instead: { all: [ { field:"kind", op:"in", value:[...] }, { any: [...scoping clauses...] } ] }.',
      );
    }
    children.forEach((c, i) => detectBroadKindDisjunctFootgun(c, `${path}.any[${i}]`, warnings));
    return;
  }
  if (Array.isArray(obj.all)) {
    (obj.all as unknown[]).forEach((c, i) => detectBroadKindDisjunctFootgun(c, `${path}.all[${i}]`, warnings));
    return;
  }
  if ('not' in obj) detectBroadKindDisjunctFootgun(obj.not, `${path}.not`, warnings);
}

/**
 * EI-18653031651840641: the third spec-authoring footgun — a `view.filter` that selects
 * on `id` ALONE. Such a spec is a FROZEN SNAPSHOT, not a standing lane: it admits exactly
 * the ids listed at authoring time and can never admit an item created afterwards, so it
 * presents purely as an idle agent rather than as an error.
 *
 * The filer hit this as a two-step trap while leading a fleet. Their real lane was a union
 * — "every work-item promoted from plan X" (a `plan` leaf) PLUS a handful of standalone
 * bugs carrying no plan. Believing the grammar had no OR, they replaced the plan leaf with
 * a hand-written `{op:'in', field:'id', value:[...]}`. It validated, looked right, and
 * ~10 minutes later starved a member on a freshly promoted plan item the ORIGINAL spec
 * would have admitted. The workaround for the first starvation caused the second.
 *
 * The union IS expressible — `{ any: [ <the plan leaf>, {field:'id', op:'in', value:[…]} ] }`
 * — so the warning names that shape directly rather than only describing the hazard.
 *
 * ADVISORY ONLY, and deliberately so: an id-only spec is the correct way to pin a FIXED
 * WAVE, which is a real and supported use (see {@link fixedCohortIds}, the read-side
 * counterpart that audits exactly such a cohort). This warns the author that they have
 * chosen a pin; it never refuses one. {@link isIdOnlySelector} — already denormalized onto
 * `bee_claim_specs.id_only` so over-reliance is countable — is the shape oracle, so the
 * warning and the stored tripwire can never disagree about what "id-only" means.
 */
function detectFrozenIdListFootgun(spec: { view?: { filter?: unknown } }, warnings: string[]): void {
  if (!isIdOnlySelector(spec)) return;
  warnings.push(
    'view.filter: this spec selects on `id` ALONE — a FROZEN SNAPSHOT, not a standing lane. ' +
      'It admits only the ids listed here and can NEVER admit an item created afterwards, which ' +
      'surfaces as a silently idle agent rather than an error. Deliberate for a fixed wave (see ' +
      '`fixedCohortIds`); if you meant a standing lane, filter on a PROPERTY instead — and note a ' +
      'lane spanning several shapes is expressible as a union, e.g. ' +
      '{ any: [ { field:"plan", op:"=", value:"<slug>" }, { field:"id", op:"in", value:[…] } ] }.',
  );
}

/**
 * WI-36743: a spec-authoring footgun sibling to the broad-kind-disjunct one above — a
 * spec that scopes to issue-family kinds (bug/change/task) but never adds a
 * `severity_rank` rank term. `severity_rank` (EI-19286355119013384) is what makes the
 * DEFAULT spec severity-aware; it is opt-IN per spec, so any custom spec authored before
 * (or without knowledge of) that fix silently reproduces the exact starvation it was
 * built to close. Measured live 2026-08-08: the `nonp2p-bug-drain` fleet spec (rank:
 * `[priority asc, age desc]`, no severity_rank) served a 279-item claimable queue whose
 * top-200 contained ZERO critical-severity items — WI-5601 (critical, fully spec-matched)
 * was structurally unreachable for the life of the drain.
 *
 * Advisory only (like the footgun above): a spec author may have a deliberate reason to
 * ignore severity (e.g. a lane scoped to a single severity already via `view.filter`, or
 * to a fixed id-pinned wave — see `isIdOnlySelector`). Detects the SHAPE only: any
 * positive (`=`/`in`) `kind` selector reaching an issue-family kind, with `rank.terms`
 * carrying no `severity_rank` head anywhere.
 */
const ISSUE_FAMILY_KINDS = new Set<string>(['bug', 'change', 'task']);

/** Collect every value asserted by a POSITIVE (`=`/`in`) leaf on `field`, anywhere in the
 *  tree. Skips the `not` branch entirely — a negated leaf excludes rather than selects,
 *  so it cannot be used to infer the spec targets that kind. `any`/`all` both recurse:
 *  a value reachable through either combinator is a value the spec CAN select. */
function collectPositiveFieldValues(node: unknown, field: string, acc: Set<string>): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  if (obj.field === field && (obj.op === '=' || obj.op === 'in')) {
    const raw = Array.isArray(obj.value) ? obj.value : [obj.value];
    raw.forEach((v) => acc.add(String(v)));
    return;
  }
  if (Array.isArray(obj.all)) {
    obj.all.forEach((n) => collectPositiveFieldValues(n, field, acc));
    return;
  }
  if (Array.isArray(obj.any)) {
    obj.any.forEach((n) => collectPositiveFieldValues(n, field, acc));
    return;
  }
  // Deliberately no `not` recursion — see the doc comment above.
}

function detectMissingSeverityRankForIssueFamily(spec: z.infer<typeof claimSpecSchema>, warnings: string[]): void {
  const filter = spec.view.filter;
  if (!filter) return; // no filter = mixed pool (features included) — too ambiguous to advise
  const kindValues = new Set<string>();
  collectPositiveFieldValues(filter, 'kind', kindValues);
  if (kindValues.size === 0) return; // no positive kind selector — can't tell what family this targets
  const targetsIssueFamily = [...kindValues].some((k) => ISSUE_FAMILY_KINDS.has(k));
  if (!targetsIssueFamily) return;
  const hasSeverityRank = spec.rank.terms.some((t) => rankExprHead(t.expr) === 'severity_rank');
  if (hasSeverityRank) return;
  warnings.push(
    'rank.terms: view.filter selects issue-family kind(s) (bug/change/task) but no rank term is ' +
      '"severity_rank" — severity is not considered when ordering (WI-36743). Without it, a deep claimable ' +
      'queue can leave critical-severity items structurally unreachable behind endless major/minor/nit ' +
      'inflow, however that inflow is ordered. Add { expr:"severity_rank", dir:"desc" } to rank.terms ' +
      '(typically ranked ahead of priority/age, same slot as the DEFAULT spec) unless this lane ' +
      'deliberately ignores severity.',
  );
}

/**
 * Validate a claim spec, returning `{ ok, errors, warnings, spec }`. Never throws
 * (an authoring agent wants the issues back, not an exception — same contract as
 * `blueprint:validate`). Checks, in order:
 *   1. the Zod shape (unknown top-level keys, wrong types, bad rank mode/limits);
 *   2. `specVersion` ∈ supported versions;
 *   3. the filter tree — combinator structure, known/non-floor field, known op,
 *      op/value coherence — each problem named at its exact path;
 *   4. each rank term's `expr` resolves to a known field or rank function, and
 *      `weighted` mode supplies a finite weight on every term.
 */
export function validateClaimSpec(input: unknown): ClaimSpecValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const parsed = claimSpecSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const where = issue.path.join('.') || '(root)';
      errors.push(`${where}: ${issue.message}`);
    }
    return { ok: false, errors, warnings };
  }
  const spec = parsed.data;

  // (2) Spec version must be one this validator understands.
  if (!(SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(spec.specVersion)) {
    errors.push(
      `specVersion: unsupported spec version "${spec.specVersion}" (supported: ${SUPPORTED_SPEC_VERSIONS.join(', ')})`,
    );
  }

  // (2a) WI-6050: expand a named `view.fence` macro into `view.filter`, HERE, at
  // validate time — which is also write time (setClaimSpec persists `v.spec`, this
  // function's return value, never the caller's raw input) and read time (getClaimSpec
  // re-validates the stored spec on every load). Expansion ANDs the macro's FilterNode
  // onto any existing filter and then DELETES `fence` from the returned view, so
  // re-validating an already-expanded stored spec is a no-op rather than compounding.
  if (spec.view.fence !== undefined) {
    const build = CLAIM_SPEC_FENCE_MACROS[spec.view.fence];
    if (!build) {
      errors.push(
        `view.fence: unknown fence macro "${spec.view.fence}" (known: ${
          Object.keys(CLAIM_SPEC_FENCE_MACROS).join(', ') || '(none)'
        })`,
      );
    } else {
      const fenceNode = build();
      const existing = spec.view.filter as FilterNode | undefined;
      spec.view.filter = (existing ? { all: [existing, fenceNode] } : fenceNode) as Record<string, unknown>;
      delete (spec.view as { fence?: string }).fence;
    }
  }

  // (3) Filter op/value coherence.
  if (spec.view.filter) {
    validateFilterNode(spec.view.filter, 'view.filter', errors);
    // Only bother with the shape-advisory once the tree is structurally sound —
    // an already-broken filter doesn't need a second, noisier complaint.
    if (errors.length === 0) {
      detectBroadKindDisjunctFootgun(spec.view.filter, 'view.filter', warnings);
      detectFrozenIdListFootgun(spec, warnings);
    }
  }

  // (4) Rank term expressions + weighted-mode weights.
  const knownRankHeads = new Set<string>([...RANKABLE_ITEM_FIELDS, ...RANK_FUNCTIONS]);
  spec.rank.terms.forEach((term, i) => {
    const head = rankExprHead(term.expr);
    if (!knownRankHeads.has(head)) {
      errors.push(
        `rank.terms[${i}]: unknown rank term "${term.expr}" — expr head "${head}" is not a known field or rank function ` +
          `(fields: ${RANKABLE_ITEM_FIELDS.join(', ')}; functions: ${RANK_FUNCTIONS.join(', ')})`,
      );
    }
    if (spec.rank.mode === 'weighted' && (term.weight == null || !Number.isFinite(term.weight))) {
      errors.push(`rank.terms[${i}]: mode "weighted" requires a finite "weight" on every term`);
    }
    // A weighted sum casts EVERY contributing term to `::numeric` (get-next.ts compileRank),
    // which on a non-numeric column is a hard Postgres error that aborts the whole claim
    // query — not a mis-sort. Reject at authoring rather than at 3am on the lane that used
    // it. Functions are exempt (affinity ⇒ count(); the descoped heads ⇒ NEUTRAL, never
    // cast), and an already-unknown head is left to the single error above. See
    // NUMERIC_ITEM_FIELDS for the measured cast failures.
    if (
      spec.rank.mode === 'weighted' &&
      knownRankHeads.has(head) &&
      !(RANK_FUNCTIONS as readonly string[]).includes(head) &&
      !(NUMERIC_ITEM_FIELDS as readonly string[]).includes(head)
    ) {
      errors.push(
        `rank.terms[${i}]: mode "weighted" requires numerically-orderable terms — "${head}" is not one ` +
          `(numeric fields: ${NUMERIC_ITEM_FIELDS.join(', ')}). A weighted rank sums its terms, so a ` +
          `non-numeric column is a cast ERROR that fails the claim query outright. Use mode ` +
          `"lexicographic" to order by "${head}".`,
      );
    }
    if (spec.rank.mode === 'lexicographic' && term.weight != null) {
      warnings.push(`rank.terms[${i}]: "weight" is ignored in mode "lexicographic"`);
    }
  });

  // (5) WI-36743: advise when an issue-family-scoped spec has no severity_rank term.
  // Only meaningful once the filter tree is structurally sound (mirrors the footgun
  // advisory above) — an already-broken filter doesn't need a second, noisier complaint.
  if (errors.length === 0) {
    detectMissingSeverityRankForIssueFamily(spec, warnings);
  }

  // The semantic walk above guarantees `view.filter` (when present) is a valid
  // `FilterNode` once there are no errors; surface the narrowed `ClaimSpec` type.
  return { ok: errors.length === 0, errors, warnings, spec: spec as ClaimSpec };
}

// ────────────────────────────────────────────────────────────────────────────
// Observability tripwire — id-only specs (a static pin, not a lane).
// ────────────────────────────────────────────────────────────────────────────

/** Collect every item-field referenced anywhere in a filter node tree. Defensive
 *  over the raw record shape so it works on a validated OR an as-stored filter. */
function collectFilterFields(node: unknown, acc: Set<string>): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.field === 'string') {
    acc.add(obj.field);
    return;
  }
  if (Array.isArray(obj.all)) {
    obj.all.forEach((n) => collectFilterFields(n, acc));
    return;
  }
  if (Array.isArray(obj.any)) {
    obj.any.forEach((n) => collectFilterFields(n, acc));
    return;
  }
  if ('not' in obj) collectFilterFields(obj.not, acc);
}

/**
 * True when a spec's `view.filter` selects on the `id` field ALONE — a STATIC pin
 * (a frozen, finite candidate set, e.g. `{ field:'id', op:'in', value:[...] }`), with
 * no property selector (plan / paths / tags / priority / …) to make it a standing,
 * auto-inflowing lane.
 *
 * The discipline tripwire: an id-pin is the intended EXCEPTION for a fixed wave
 * (hotfix / cutover / re-drive); a Queen who pins by id for ONGOING work has quietly
 * fallen back to hand-listing items. `setClaimSpec` records this per stored spec so
 * over-reliance is countable (`bee_claim_specs.id_only`), not silent. No filter at
 * all ⇒ false (the whole ready frontier — the opposite of a pin).
 */
export function isIdOnlySelector(spec: { view?: { filter?: unknown } } | null | undefined): boolean {
  const filter = spec?.view?.filter;
  if (filter == null) return false;
  const fields = new Set<string>();
  collectFilterFields(filter, fields);
  return fields.size > 0 && [...fields].every((f) => f === 'id');
}

/**
 * Return the exact, finite ID cohort selected by an id-only claim spec.
 *
 * This is the read-side counterpart to {@link isIdOnlySelector}: leaders need
 * the literal fixed wave to audit completion without maintaining a second list.
 * Positive `=`/`in` leaves compose exactly (`all` = intersection, `any` =
 * union). Negative/fuzzy leaves and `not` describe an unbounded complement, so
 * they return null instead of pretending a finite audit is authoritative.
 */
export function fixedCohortIds(spec: { view?: { filter?: unknown } } | null | undefined): string[] | null {
  if (!isIdOnlySelector(spec)) return null;

  function walk(node: unknown): Set<string> | null {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
    const obj = node as Record<string, unknown>;
    if (obj.field === 'id') {
      if (obj.op !== '=' && obj.op !== 'in') return null;
      const raw = Array.isArray(obj.value) ? obj.value : [obj.value];
      return new Set(
        raw
          .filter(
            (v): v is string | number | boolean =>
              typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
          )
          .map(String),
      );
    }
    if (Array.isArray(obj.all) && obj.all.length > 0) {
      const sets = obj.all.map(walk);
      if (sets.some((s) => s === null)) return null;
      const [head, ...rest] = sets as Set<string>[];
      return new Set([...head].filter((id) => rest.every((s) => s.has(id))));
    }
    if (Array.isArray(obj.any) && obj.any.length > 0) {
      const sets = obj.any.map(walk);
      if (sets.some((s) => s === null)) return null;
      return new Set((sets as Set<string>[]).flatMap((s) => [...s]));
    }
    return null;
  }

  const ids = walk(spec?.view?.filter);
  return ids ? [...ids] : null;
}

/**
 * Return the positive ID candidate set carried by the conservative fallback
 * shapes the scheduler can enforce across BOTH work-item families: a bare
 * `id =`/`id in` leaf, or one or more such leaves directly inside a top-level
 * `all`. Non-ID siblings may narrow the set at pull time, but cannot add to it.
 *
 * `any`/`not` are not simplified: their set can depend on non-ID predicates or
 * describe an unbounded complement. Multiple direct ID leaves in `all`
 * intersect, matching boolean semantics instead of letting the first leaf win.
 */
export function positiveIdCohortIds(filter: unknown): string[] | null {
  function leafSet(node: unknown): Set<string> | null {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
    const obj = node as Record<string, unknown>;
    if (obj.field !== 'id' || (obj.op !== '=' && obj.op !== 'in')) return null;
    const raw = Array.isArray(obj.value) ? obj.value : [obj.value];
    return new Set(
      raw
        .filter(
          (v): v is string | number | boolean =>
            typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
        )
        .map(String),
    );
  }

  const bare = leafSet(filter);
  if (bare) return [...bare];
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) return null;
  const all = (filter as { all?: unknown }).all;
  if (!Array.isArray(all)) return null;
  const sets = all.map(leafSet).filter((set): set is Set<string> => set !== null);
  if (sets.length === 0) return null;
  const [head, ...rest] = sets;
  return [...head].filter((id) => rest.every((set) => set.has(id)));
}

// ────────────────────────────────────────────────────────────────────────────
// The default spec — "no spec = today's behavior" (D-003).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The DEFAULT claim spec: an empty view (every ready item) ordered by the current
 * fixed `claim_next` ordering — swarm-affinity → priority/feature_order → age
 * (created_ts). Handing a bee no spec is equivalent to handing it this one, so
 * the feature is a strict superset and ships zero behavior change until the Queen
 * authors a narrower spec (D-003).
 *
 * `revision: 0` marks it as the unmodified baseline; `specId` is stable so the
 * provenance record reads `default-fixed-ordering@0` for a baseline pull.
 */
export const DEFAULT_CLAIM_SPEC: ClaimSpec = {
  specVersion: CURRENT_SPEC_VERSION,
  specId: 'default-fixed-ordering',
  revision: 0,
  view: {},
  rank: {
    mode: 'lexicographic',
    terms: [
      { expr: 'affinity(bee.held_paths,item.paths)', dir: 'desc' },
      // `severity_rank` (EI-19286355119013384) — WHY THIS TERM EXISTS HERE, and why it sits
      // in exactly this slot. Without it the default ordering IGNORED SEVERITY ENTIRELY on
      // issue-family rows, because all three of the other terms go inert there:
      //   affinity ⇒ compiles to NEUTRAL for a bee holding no paths (compileRankExpr returns
      //              null rather than a bare 0, so it drops out of the ORDER BY);
      //   priority ⇒ feature_order, which is NULL on every issue-family row;
      //   age      ⇒ the only survivor, leaving plain oldest-first.
      // Measured 2026-08-01 on the live open papercusp pool: the first six items served were
      // minor/null/major/minor/minor/minor while 19 criticals waited behind ~11,757 nits that
      // merely happened to be older.
      //
      // SLOT RATIONALE: after `affinity` so bee path-locality still wins first (a bee already
      // holding the relevant files is the cheapest one to do the work); before `priority`
      // because severity_rank is a constant 0 on feature-family rows — where severity is
      // structurally absent — so it cannot perturb feature ordering, leaving feature_order as
      // the meaningful term there. Net effect is scoped to issue-family rows, which is the
      // family that was mis-ordered.
      //
      // TRADEOFF, ACCEPTED DELIBERATELY: severity now outranks age, so low-severity work is
      // served strictly after higher-severity work rather than by arrival order. That is the
      // intended policy — a nit should not precede a critical because it is older — but it
      // does mean the nit tail advances only as higher-severity inflow allows.
      { expr: 'severity_rank', dir: 'desc' },
      { expr: 'priority', dir: 'desc' },
      { expr: 'age', dir: 'asc' },
    ],
  },
  limits: { maxConcurrentClaims: 1 },
};
