/**
 * spec-pool-preview.ts — write-time EFFECT preview for a dynamic claim spec (WI-5212).
 *
 * WHY THIS EXISTS. Both 2026-07-16/17 fleet starvations shared one root pattern: the
 * system VALIDATED the spec's intention (vocabulary, shape → ok:true) but never MEASURED
 * its effect. A spec scoped to kinds with zero rows, and a NULL-poisoned `not:{plan}`
 * fence that hid 99% of the pool (EI-13306), both armed silently and then presented as
 * honest-looking scoped misses that blamed the spec's members. Each was caught only by a
 * leader hand-running a COUNT against the pool before/after arming — this module is that
 * COUNT, institutionalized at the write path.
 *
 * WHAT IT MEASURES. For a candidate spec: how many rows of the CLAIMABLE POOL its
 * view.filter matches, using the SAME compiled WHERE fragment `get_next` executes
 * (compileFilter — so preview and pull cannot drift), against neutral floors:
 * status ∈ spec.states, unclaimed, not observation-lane (D-005), not claim-held.
 * Per-BEE floors (release cooldown, DAG-blocking, rig, admission) are deliberately NOT
 * applied — they vary by puller and by minute; the preview is a pool-shape check, not a
 * claim simulation. Both sides of every comparison (matched vs pool, new vs previous)
 * use the same basis, so the collapse ratios are meaningful even though the absolute
 * numbers slightly overcount what one specific bee could claim right now.
 *
 * THE GUARD (evaluateCollapseGuard — pure, unit-tested). Two refusal shapes, both
 * overridable with confirmCollapse:true:
 *  1. matched = 0 of a nonempty pool — the starved-by-construction shape (a kind/state
 *     scoping that matches nothing). Legit only for a pre-staged lane whose items have
 *     not been promoted yet, which is exactly what the confirm flag is for.
 *  2. an AUTHORED spec revision that craters the match count (< max(5, 5%) of the
 *     previous revision's) — the NULL-poisoned-fence shape. Narrowing from the DEFAULT
 *     spec never refuses (authoring a deliberately narrow lane is normal); only a
 *     revision of an existing lane that suddenly hides its own backlog does.
 *
 * Fail-open: a preview/count error must NEVER block a spec write (the guard is a safety
 * net, not a new single point of failure) — callers report previewError instead.
 *
 * KNOWN GAP (EI-18655873409999215, 2026-07-25): this is a WRITE-TIME check only — it can
 * be legitimately bypassed by design (the `isProvableSuperset` short-circuit above, and
 * the `noDelta` exemption for a previously-authored spec that already matched 0), so a
 * corrective widening write CAN silently land as a still-0-match no-op with nothing but a
 * low-visibility `warning` field on that one tool-call response. Confirmed live: a
 * `{any:[oldFilter, newClause]}` widening revision of an already-0-matching lane sat at 0
 * for 4.5h, unrefused (both exemptions applied), with the fleet reading it as a clean
 * scoped miss the whole time. The durable backstop for THIS shape is NOT here — it is the
 * STANDING alert `computeSpecStarvedFleetAlert` in
 * agent-tools/fleet/leader-brief.ts, which re-checks the fleet's live effective spec
 * against the live pool on every leader-brief call instead of relying on catching a
 * one-shot write-time warning. If you are tempted to make this write-time guard "smarter"
 * to close the gap instead, consider whether the standing check is the more robust fix —
 * a write-time-only guard can always be raced by the pool itself changing shape afterward.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { ClaimSpec, FilterLeaf, FilterNode } from './claim-spec';
import { compileFilter } from './get-next';
import { observationLaneExclusionSql, type OrgSql } from '../work-items';
import { issuesScopeWorkspace } from '../issues-engineer';

export interface SpecPoolEffect {
  /** Rows of the pool the spec's view.filter matches. */
  matched: number;
  /** The claimable pool under neutral floors (see module doc — slight overcount vs per-bee reality). */
  pool: number;
  /** The states the count ran under (spec.states ?? ['open']), after claim-path normalization. */
  states: string[];
  /** Harness the count was scoped to; null = whole workspace. */
  harness: string | null;
}

/**
 * Count the claimable pool and the spec's matched subset in ONE query, using the same
 * compiled filter fragment `get_next` runs. Throws on SQL failure — the CALLER decides
 * fail-open (the set_claim_spec tool reports previewError and proceeds).
 */
export async function previewSpecPoolEffect(
  spec: ClaimSpec,
  opts: { workspaceId: string; harness?: string | null },
): Promise<SpecPoolEffect> {
  const sql = getOrgPg().sql;
  // Mirrors claimFloorsWhereSql's unified ['open'] default (work-item-status-full-unify P-004/P-005)
  // so the WI-5212 pool-effect preview counts the SAME pool the real claim runs against.
  const states = specPoolStates(spec);
  const harness = opts.harness ?? null;
  const filter = compileFilter(sql, spec.view.filter);
  const rows = (await sql`
    SELECT count(*)::int AS pool,
           (count(*) FILTER (WHERE ${filter}))::int AS matched
      FROM harness_shared.work_items wi
     WHERE ${specPoolFloors(sql, { workspaceId: opts.workspaceId, harness, states })}
  `) as Array<{ pool: number; matched: number }>;
  const row = rows[0] ?? { pool: 0, matched: 0 };
  return { matched: row.matched, pool: row.pool, states, harness };
}

/** The states a spec's pool count runs under: `spec.states ?? ['open']`. */
export function specPoolStates(spec: ClaimSpec): string[] {
  return [...(spec.states ?? ['open'])];
}

/**
 * The neutral pool floors as ONE parenthesised WHERE conjunct — the single definition
 * {@link previewSpecPoolEffect} COUNTS under and the predicate-partition adapter
 * (spec-predicate-partition.ts, EI-23760081161304754) PARTITIONS under. Extracted rather than
 * copied: a second hand-written copy of these floors is exactly how a preview and a pull come to
 * measure different pools.
 *
 * Columns are deliberately UNQUALIFIED (no `wi.`), the same way FIELD_MAP's column fragments
 * are: the partition surface re-renders this text into `FROM <relation> t …` statements whose
 * alias is not `wi`, and a qualified reference there fails with a missing-FROM-entry error that
 * the fail-open probe then swallows (the preview silently degrades to statements-only). Every
 * caller reads one table, so an unqualified column resolves identically.
 *
 * The conjunct names `workspace_id`, which is what lets planPredicatePartition classify it as a
 * SCOPE predicate carried into the partition's WHERE rather than as a discriminating dimension.
 */
export function specPoolFloors(
  sql: OrgSql,
  opts: { workspaceId: string; harness: string | null; states: string[] },
) {
  const { harness, states } = opts;
  // EI-18675972728146330: the real issue-family claim path (issueClaimCandidateSubquery /
  // aggregateIssueClaimExclusions, which backs work_items:claimable's matchedByFilter) admits
  // BOTH `wi.harness_slug = harness` AND the operator-scope alias `operator:<issuesScopeWorkspace()>`
  // — a harness-less/operator-authored row lands under that alias, not the bare harness slug.
  // This preview was missing the alias branch entirely, so it silently EXCLUDED every
  // operator-scoped row from both `pool` and `matched` — confirmed live on the
  // nonp2p-bug-drain-0725 fleet spec: 78 papercusp-slug rows + 37 operator:papercusp-workspace-
  // slug rows both count toward work_items:claimable's matchedByFilter (~115), but this
  // function only ever counted the 78, undercounting the guard's own basis pool by ~30% and
  // making its reported `matched`/`pool` disagree with the real claim path for no structural
  // reason (the doc above promises "cannot drift" from `get_next` — this closes that gap).
  const operatorScopeSlug = harness ? `operator:${issuesScopeWorkspace()}` : null;
  // The storage-boundary compatibility fold below is identical to claimFloorsWhereSql's: legacy
  // feature rows at "todo" are admitted when callers request the unified claimable token "open",
  // so a plan-scoped recovery preview cannot report 0 for work the real claim path would offer.
  // The fold is restricted to the feature family — issue-family claims compare their stored
  // status directly. D-005: observation-lane rows are never claimable (the same NULL-safe floor
  // the claim path applies; a raw count without it overstates the pool ~7x). WI-2797 claim-holds
  // are parked out of self-select, with the same IS DISTINCT FROM idiom. (These notes are JS
  // comments, not SQL ones, on purpose: this text is re-parsed by the partition planner and an
  // apostrophe inside a SQL comment is exactly what a literal-stripper can misread.)
  return sql`(
    workspace_id = ${opts.workspaceId}
    AND (
      ${harness}::text IS NULL
      OR harness_slug = ${harness}
      OR harness_slug = ${operatorScopeSlug}
    )
    AND (
      CASE
        WHEN item_kind NOT IN ('bug', 'change', 'task') AND status = 'todo' THEN 'open'
        ELSE status
      END
    ) = ANY(${states}::text[])
    AND taken_by IS NULL
    AND ${observationLaneExclusionSql(sql, 'payload')}
    AND COALESCE(payload, '{}'::jsonb) ->> '_claimHold' IS DISTINCT FROM 'true'
  )`;
}

export interface CollapseGuardInput {
  matched: number;
  pool: number;
  /** Matched count under the previously-stored spec at the same target key; null = not measurable. */
  previousMatched: number | null;
  /** 'authored' = a cup/fleet row existed (someone set this lane); 'default' = no stored spec. */
  previousSource: 'authored' | 'default';
  /** The caller's confirmCollapse flag. */
  confirm: boolean;
  /** The candidate revision's view.filter — optional; enables the provable-superset short-circuit below. */
  filter?: FilterNode;
  /** The incumbent (previously-stored) spec's view.filter — same-key requirement as `filter`. */
  previousFilter?: FilterNode;
}

/**
 * Structural equality over the filter AST — order-independent for combinator arrays'
 * ELEMENTS content (not position: `all`/`any` are still compared positionally, since a
 * differently-ORDERED equivalent tree is a distinct-but-equivalent revision, not the
 * literal syntactic match `isProvableSuperset` needs). Leaves compare field/op/value;
 * an array `value` (an `in` leaf) compares element-wise.
 */
export function filterNodesEqual(a: FilterNode, b: FilterNode): boolean {
  const aAny = (a as { any?: FilterNode[] }).any;
  const bAny = (b as { any?: FilterNode[] }).any;
  if (aAny || bAny) {
    if (!aAny || !bAny || aAny.length !== bAny.length) return false;
    return aAny.every((child, i) => filterNodesEqual(child, bAny[i]));
  }
  const aAll = (a as { all?: FilterNode[] }).all;
  const bAll = (b as { all?: FilterNode[] }).all;
  if (aAll || bAll) {
    if (!aAll || !bAll || aAll.length !== bAll.length) return false;
    return aAll.every((child, i) => filterNodesEqual(child, bAll[i]));
  }
  const aNot = (a as { not?: FilterNode }).not;
  const bNot = (b as { not?: FilterNode }).not;
  if (aNot || bNot) {
    if (!aNot || !bNot) return false;
    return filterNodesEqual(aNot, bNot);
  }
  const al = a as FilterLeaf;
  const bl = b as FilterLeaf;
  if (al.field !== bl.field || al.op !== bl.op) return false;
  return filterValuesEqual(al.value, bl.value);
}

function filterValuesEqual(a: FilterLeaf['value'], b: FilterLeaf['value']): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * EI-18653814284166347 (SUPERSET BLINDNESS): a revision of the shape `{ any: [X, ...] }`
 * where `X` structurally equals the INCUMBENT filter is statically provable to match a
 * SUPERSET of the incumbent's rows — an `any` over the old filter plus more can only ever
 * match the same rows or more, never fewer. That is a cheap syntactic check, independent of
 * the measured counts, so a candidate satisfying it can never be the narrowing/starvation
 * shape the guard exists to catch (recurses into a nested `any` so `{any:[{any:[X,Y]},Z]}`
 * is still recognised as a superset of X).
 */
export function isProvableSuperset(candidate: FilterNode, previous: FilterNode): boolean {
  const children = (candidate as { any?: FilterNode[] }).any;
  if (!children) return false;
  return children.some((child) => filterNodesEqual(child, previous) || isProvableSuperset(child, previous));
}

export interface CollapseGuardVerdict {
  refuse: boolean;
  errors: string[];
  warning?: string;
}

/**
 * The GOAL lane's scope guard (EI-22389918023611568).
 *
 * A pool-count collapse is not the only unsafe re-steer. A goal-drain spec can
 * be replaced with a broader, kind-only spec and the count can go UP (the exact
 * rev2 -> rev3 incident), so {@link evaluateCollapseGuard} quite correctly does
 * not call that change a collapse. The broader lane nevertheless drops the
 * ownership boundary and can consume another active goal's work.
 *
 * The incumbent positive goal predicate is also a deliberate *stand-down brake*:
 * a paused/winding-down fleet may intentionally match zero. This guard therefore
 * protects the replacement operation, not the current zero count: keep a
 * guaranteed positive goal predicate, or explicitly acknowledge the transition to
 * an independently verified exclusion fence with `confirmGoalFenceDrop:true`.
 */
export interface GoalFenceGuardInput {
  /** The incumbent effective filter at this target (undefined = no filter). */
  previousFilter?: FilterNode;
  /** The proposed replacement filter. */
  candidateFilter?: FilterNode;
  /** `authored` means a stored cup/fleet row exists; `default` means no incumbent. */
  previousSource: 'authored' | 'default';
  /** Explicit operator acknowledgement of a scope transition. */
  confirm: boolean;
}

/**
 * Return true only when every satisfying branch of a filter requires a positive
 * goal predicate. Merely mentioning `goal` below an `any`/`not` is not enough:
 * `{ any:[{field:'goal',op:'=',value:'g'}, {field:'kind',op:'=',value:'bug'}] }`
 * still admits the whole bug backlog. `all` needs one positive child because
 * conjunction with that child makes the whole expression goal-scoped.
 *
 * This is intentionally structural and conservative. It does not try to prove
 * that the values equal the caller's own goal (the target may be a fleet sentinel
 * whose goal provenance is outside the claim-spec JSON); it only prevents the
 * known unsafe *drop-all-goal-scope* edit. A separate active-goal exclusion fence
 * can be acknowledged explicitly at the write door.
 */
export function hasGuaranteedPositiveGoalFence(filter: FilterNode | undefined): boolean {
  if (!filter) return false;
  if ('field' in filter) {
    if (filter.field !== 'goal' || (filter.op !== '=' && filter.op !== 'in')) return false;
    // An empty `in` is a vacuous/no-row selector, not a useful ownership fence.
    return filter.op === '='
      ? String(filter.value).trim().length > 0
      : Array.isArray(filter.value) && filter.value.some((value) => String(value).trim().length > 0);
  }
  if ('all' in filter) return filter.all.some((child) => hasGuaranteedPositiveGoalFence(child));
  if ('any' in filter) {
    return filter.any.length > 0 && filter.any.every((child) => hasGuaranteedPositiveGoalFence(child));
  }
  // A negation can exclude a goal, but it cannot guarantee that an admitted row
  // belongs to one. In particular, `not:{goal != g}` is not a positive fence.
  return false;
}

/**
 * The rows a single leaf admits when it is a BOUNDED id selector, else `null`.
 *
 * An id leaf admits at most the rows it names, so it cannot widen a lane into another
 * goal's CLASS of work — the one harm {@link evaluateGoalFenceGuard} exists to prevent.
 * `op:'='` names one row; `op:'in'` names a finite enumerated set, the shape `claim-spec`
 * itself documents for an OR lane. An empty value names nothing and is a vacuous
 * selector rather than an escape, so it does not qualify.
 */
function boundedIdLeafIds(node: FilterNode): string[] | null {
  if (!('field' in node) || node.field !== 'id') return null;
  if (node.op === '=') {
    const value = String(node.value).trim();
    return value.length > 0 ? [value] : null;
  }
  if (node.op === 'in') {
    if (!Array.isArray(node.value)) return null;
    const ids = node.value.map((value) => String(value).trim()).filter((value) => value.length > 0);
    return ids.length > 0 ? ids : null;
  }
  return null;
}

/**
 * The ids a candidate admits ALONGSIDE a retained positive goal fence, or `null` when the
 * candidate is not that shape.
 *
 * This shape is the platform's OWN sanctioned repair: `fleet-scope-admission`'s
 * `fencePreservingWidenFilter` emits `{ any: [ <current fence>, { field:'id', … } ] }`, and
 * the `fleet_scope_violation` notice tells a leader to send exactly that through
 * `scheduler:set_claim_spec`. Judged by {@link hasGuaranteedPositiveGoalFence} alone it is
 * refused — every `any` arm must be fenced and an id leaf never is — so the platform
 * recommended a repair its own write door rejected (WI-10005683; independently observed as
 * EI-24769116390470623, where the strict every-arm rule "misreads sanctioned fleets").
 *
 * The carve-out is deliberately narrow, and both halves are load-bearing: at least one arm
 * must still GUARANTEE the goal fence, and every other arm must name bounded rows. So
 * `{ any: [ <fence>, {kind in …} ] }` stays refused, because a kind arm admits another
 * active goal's whole backlog, which is exactly the drop-all-goal-scope edit this guard
 * was built for.
 */
export function boundedRowEscapeIds(filter: FilterNode | undefined): string[] | null {
  if (!filter || !('any' in filter) || filter.any.length === 0) return null;
  let fencedArms = 0;
  const admitted: string[] = [];
  for (const arm of filter.any) {
    if (hasGuaranteedPositiveGoalFence(arm)) {
      fencedArms += 1;
      continue;
    }
    const ids = boundedIdLeafIds(arm);
    if (!ids) return null;
    admitted.push(...ids);
  }
  if (fencedArms === 0 || admitted.length === 0) return null;
  return admitted;
}

/**
 * Pure decision for the positive-goal-fence replacement guard.
 *
 * The guard is deliberately independent of pool counts: a widening replacement
 * can increase `matched` while still violating goal ownership. `confirm` is a
 * separate acknowledgement from `confirmCollapse`; callers must say they have
 * verified an explicit exclusion-fence transition rather than accidentally
 * reusing a starvation override.
 */
export function evaluateGoalFenceGuard(input: GoalFenceGuardInput): CollapseGuardVerdict {
  const previousHasFence =
    input.previousSource === 'authored' && hasGuaranteedPositiveGoalFence(input.previousFilter);
  if (!previousHasFence || hasGuaranteedPositiveGoalFence(input.candidateFilter)) {
    return { refuse: false, errors: [] };
  }

  // The fence-preserving row escape is ALLOWED but still DISCLOSED: the incumbent goal
  // fence survives and the extra arms name bounded rows, so refusing it would reject the
  // platform's own `fencePreservingWidenFilter` recommendation (WI-10005683). It is not
  // routed through confirmGoalFenceDrop on purpose — that flag asserts the fence was
  // DROPPED, which is false here, and habituating leaders to pass it on a routine
  // platform-recommended admission would hollow out the acknowledgement where it matters.
  const escapedIds = boundedRowEscapeIds(input.candidateFilter);
  if (escapedIds) {
    const shown = escapedIds.slice(0, 5).join(', ');
    const more = escapedIds.length > 5 ? `, +${escapedIds.length - 5} more` : '';
    return {
      refuse: false,
      errors: [],
      warning:
        'the proposed claim-spec revision RETAINS the incumbent positive goal fence and admits ' +
        `${escapedIds.length} explicitly named row(s) alongside it (${shown}${more}). This is the ` +
        'fence-preserving shape fleet-scope admission recommends for a verified cross-scope ' +
        'dependency, so it is allowed without confirmGoalFenceDrop:true. The admitted rows are ' +
        'bounded by enumeration and cannot pull in another active goal\'s class of work; verify ' +
        'each named row is one this lane genuinely needs.',
    };
  }

  const message =
    'the proposed claim-spec revision DROPS the incumbent positive goal fence: the stored lane is ' +
    'goal-scoped, but the replacement has no filter shape that guarantees a positive `goal` =/in ' +
    'predicate. A broader kind-only lane can admit another active goal\'s work even when its pool count ' +
    'increases; a positive fence that matches 0 is also a valid stand-down brake, not proof it should be ' +
    'removed. Keep the goal predicate, or replace it with a verified active-goal EXCLUSION fence. ';
  if (input.confirm) {
    return {
      refuse: false,
      errors: [],
      warning:
        `${message}The scope transition was explicitly confirmed with confirmGoalFenceDrop:true; ` +
        'verify that the replacement excludes every other active goal and admits the unowned frontier.',
    };
  }
  return {
    refuse: true,
    errors: [
      `${message}Re-send with confirmGoalFenceDrop:true only after checking that exclusion; ` +
        'do not widen a live GOAL drain merely to make a zero-match lane look productive (EI-22389918023611568).',
    ],
  };
}

/**
 * The ONE place an incumbent claim-spec RECORD becomes goal-fence guard input, so the write door
 * (`scheduler:set_claim_spec`) and the read-only preview door (`scheduler:preview_spec_delta`)
 * cannot disagree about a proposed filter (WI-10005785). Before this existed only the write door
 * ran the guard, so a fence-DROPPING revision previewed as clean counts and was then refused at
 * the write, and the fence-preserving widen shape previewed without the disclosure the write adds.
 * A `default` incumbent (no stored row) carries no fence, whatever the baseline spec contains.
 */
export function evaluateGoalFenceGuardForIncumbent(input: {
  incumbent: { source: string; spec: { view: { filter?: FilterNode } } };
  candidateFilter?: FilterNode;
  confirm: boolean;
}): CollapseGuardVerdict {
  const authored = input.incumbent.source !== 'default';
  return evaluateGoalFenceGuard({
    previousFilter: authored ? input.incumbent.spec.view.filter : undefined,
    candidateFilter: input.candidateFilter,
    previousSource: authored ? 'authored' : 'default',
    confirm: input.confirm,
  });
}

/**
 * A `not:` predicate the STORED lane guaranteed, which the candidate revision no longer
 * carries. `describe` is for the caller-facing warning; `node` is the operand of the
 * dropped `not` (i.e. what it was excluding), kept so a caller can re-apply it verbatim.
 */
export interface DroppedExclusion {
  describe: string;
  node: FilterNode;
}

/**
 * Every exclusion the filter GUARANTEES — a `not:` reachable from the root through `all`
 * chains only. A `not:` inside an `any` arm is deliberately NOT collected: the sibling arm
 * can admit the very rows it excludes, so dropping it is not provably a widening and
 * reporting it would cry wolf on ordinary lane re-authoring.
 *
 * Mirrors {@link hasGuaranteedPositiveGoalFence}'s conjunctive-position rule, one polarity over.
 */
export function collectGuaranteedExclusions(filter: FilterNode | undefined): FilterNode[] {
  if (!filter) return [];
  if ('not' in filter) return [filter.not];
  if ('all' in filter) return filter.all.flatMap((child) => collectGuaranteedExclusions(child));
  // A leaf excludes nothing, and an `any` guarantees nothing (see doc above).
  return [];
}

/** Compact, bounded human rendering of a filter node for a warning string. */
export function describeFilterNode(node: FilterNode, depth = 0): string {
  if (depth > 3) return '…';
  if ('not' in node) return `not:{ ${describeFilterNode(node.not, depth + 1)} }`;
  if ('all' in node) return `all:[ ${node.all.map((c) => describeFilterNode(c, depth + 1)).join(', ')} ]`;
  if ('any' in node) return `any:[ ${node.any.map((c) => describeFilterNode(c, depth + 1)).join(', ')} ]`;
  const value = Array.isArray(node.value) ? `[${node.value.join(', ')}]` : String(node.value);
  return `${node.field} ${node.op} ${JSON.stringify(value).slice(0, 80)}`;
}

export interface WideningDisclosureInput {
  matched: number;
  previousMatched: number | null;
  previousSource: 'authored' | 'default';
  filter?: FilterNode;
  previousFilter?: FilterNode;
  /** How to address this exact lane on the READ side, for the undo pointer. */
  target?: { kind: 'cup' | 'fleet'; id: string };
}

export interface WideningDisclosure {
  /** Measured pool widening vs the incumbent (null previousMatched ⇒ not measurable ⇒ false). */
  widened: boolean;
  droppedExclusions: DroppedExclusion[];
  warning?: string;
}

/**
 * WI-38283 — the direction {@link evaluateCollapseGuard} does not cover.
 *
 * `confirmCollapse` fires only on pool COLLAPSE. The 2026-07-26 incident went the opposite
 * way: a 31 → 1185 WIDENING that deleted a `not`-clause keeping one fleet off another's
 * lane. Nothing reported it, so the lane was destroyed silently and the writer never learned
 * the retained prior revision existed.
 *
 * This is deliberately a DISCLOSURE, not a refusal, and deliberately NOT a second confirm
 * flag. The evidence says another confirmation would not have helped: EI-18655873409999215
 * records `confirmCollapse` being passed TRUE on the very write that caused the incident,
 * and EI-18653814284166347 recorded the collapse guard over-refusing SAFE edits — which is
 * what trains callers to pass an override reflexively. A guard routinely overridden is a
 * guard already gone. What actually recovers the lane is the retained revision
 * (EI-18677010014746233 gap 2 / migration 810), so the job here is to REPORT the drop and
 * name the undo — retention the writer does not know about is only half a fix.
 */
export function evaluateWideningDisclosure(input: WideningDisclosureInput): WideningDisclosure {
  const { matched, previousMatched, previousSource, filter, previousFilter, target } = input;
  const none: WideningDisclosure = { widened: false, droppedExclusions: [] };
  // Only an AUTHORED lane can be destroyed — first authoring from the default lane has no
  // prior exclusions to drop and no prior revision worth pointing at.
  if (previousSource !== 'authored' || !previousFilter) return none;

  const widened = previousMatched !== null && matched > previousMatched;
  const kept = collectGuaranteedExclusions(filter);
  const droppedExclusions = collectGuaranteedExclusions(previousFilter)
    .filter((prev) => !kept.some((k) => filterNodesEqual(k, prev)))
    .map((node) => ({ node, describe: `not:{ ${describeFilterNode(node)} }` }));

  if (droppedExclusions.length === 0) return { widened, droppedExclusions };

  const list = droppedExclusions.map((d) => d.describe).join(', ');
  const counts =
    previousMatched !== null
      ? `the lane went from ${previousMatched} to ${matched} matched row(s)`
      : `the lane now matches ${matched} row(s) (the incumbent count was not measurable)`;
  // The count is the WEAKER half of this signal: an exclusion whose rows are not in the pool
  // right now drops with no visible movement, and the fence is gone either way.
  const effect = widened
    ? `${counts} — the rows those predicates fenced off are claimable by this lane now.`
    : `${counts}, so nothing moved yet — but the fence is gone, and rows matching it will be ` +
      `admitted as soon as they exist. A dropped exclusion with no count delta is the QUIETER shape, not the safer one.`;

  // The undo pointer. NOTE the scope-arg asymmetry (EI-20185841251188914): the READ takes
  // `workspace` and no `harness`, the write takes `harness` and no `workspace` — so this
  // names only the lane selector and lets the read resolve workspace from identity, rather
  // than echoing back a `harness` key that get_claim_spec would reject.
  const selector = target
    ? `{ ${target.kind === 'fleet' ? 'fleet' : 'cupId'}: ${JSON.stringify(target.id)}, history: 1 }`
    : '{ <cupId|fleet>, history: 1 }';

  return {
    widened,
    droppedExclusions,
    warning:
      `this revision DROPS ${droppedExclusions.length} exclusion predicate(s) the stored lane guaranteed: ` +
      `${list}. ${effect} If that was not intended, the superseded spec is RETAINED — read its exact bytes back ` +
      `with scheduler:get_claim_spec ${selector} and re-apply them (this is a report, not a refusal: the write ` +
      `has already been stored).`,
  };
}

/** Revision-collapse threshold: refuse when a previously ≥MIN_PREVIOUS-row lane drops below max(ABS_FLOOR, RATIO × previous). */
const MIN_PREVIOUS = 20;
const ABS_FLOOR = 5;
const RATIO = 0.05;

/**
 * Pure guard decision — see module doc for the two refusal shapes. Exported separately
 * from the COUNT so the thresholds are unit-testable without Postgres.
 */
export function evaluateCollapseGuard(input: CollapseGuardInput): CollapseGuardVerdict {
  const { matched, pool, previousMatched, previousSource, confirm, filter, previousFilter } = input;

  // EI-18653814284166347 defect #2 (SUPERSET BLINDNESS): a statically-provable superset of
  // the incumbent filter cannot possibly be the narrowing shape either refusal below exists
  // to catch — skip the guard outright, whatever the measured matched/previousMatched say.
  // (If matched still comes back surprisingly low for a provable superset, that is a SEPARATE
  // bug — e.g. a SQL-vs-JS filter-evaluator disagreement — not a spec-authoring mistake, so
  // this guard must not conflate the two by refusing here.)
  if (filter && previousFilter && isProvableSuperset(filter, previousFilter)) {
    return {
      refuse: false,
      errors: [],
      ...(matched === 0 && pool > 0
        ? {
            warning:
              `spec matches 0 of ${pool} claimable row(s), but this revision is a statically-provable SUPERSET ` +
              `of the incumbent filter (an any:[...] containing it) — it cannot narrow the pool, so the ` +
              `pool-collapse guard does not apply. A still-zero match here points at a different bug (e.g. the ` +
              `SQL and JS filter evaluators disagreeing on a referenced field), not this spec revision.`,
          }
        : {}),
    };
  }

  // EI-18653814284166347 defect #1 (NO-DELTA REFUSAL): a revision that matches 0 changes
  // NOTHING about starvation when the INCUMBENT already matched 0 — refusing achieves no
  // protection (the pool was already just as starved under the spec being replaced) and only
  // trains callers to reflex-pass confirmCollapse:true, destroying the guard's value for a
  // revision that actually IS the first one to hide the backlog.
  const noDelta = previousSource === 'authored' && previousMatched === 0;
  const zeroMatch = matched === 0 && pool > 0 && !noDelta;
  const revisionCollapse =
    previousSource === 'authored' &&
    previousMatched !== null &&
    previousMatched >= MIN_PREVIOUS &&
    matched < Math.max(ABS_FLOOR, Math.ceil(previousMatched * RATIO));

  if (confirm) {
    return {
      refuse: false,
      errors: [],
      ...(zeroMatch || revisionCollapse
        ? {
            warning:
              `pool-collapse confirmed by caller (confirmCollapse:true): spec matches ${matched} of ${pool} ` +
              `claimable row(s)${previousMatched !== null ? ` (previous spec matched ${previousMatched})` : ''}.`,
          }
        : {}),
    };
  }

  if (zeroMatch) {
    return {
      refuse: true,
      errors: [
        `spec matches 0 of ${pool} claimable row(s) — the starved-fleet shape (EI-13306/EI-11291): every ` +
          `member's get_next would miss while the pool sits full, reported as a clean scoped miss. If this is ` +
          `intentional (a pre-staged lane whose items are not promoted yet), re-send with confirmCollapse:true. ` +
          `Otherwise check the filter: kind/states that exist in this harness, and NO not:/!= fence over a ` +
          `NULLABLE field (plan/assignee/risk_tier) until the EI-13306 null-safe compiler is deployed.`,
      ],
    };
  }

  if (revisionCollapse) {
    return {
      refuse: true,
      errors: [
        `this revision collapses the claimable match from ${previousMatched} to ${matched} of ${pool} row(s) — ` +
          `the poisoned-fence shape (EI-13306: a not:{...}/!= over a NULLABLE field silently drops every NULL row). ` +
          `If the narrowing is intended, re-send with confirmCollapse:true; otherwise fix the filter before arming ` +
          `it fleet-wide.`,
      ],
    };
  }

  if (matched < ABS_FLOOR && pool >= MIN_PREVIOUS) {
    return {
      refuse: false,
      errors: [],
      warning:
        `narrow lane: spec matches only ${matched} of ${pool} claimable row(s). Fine for a deliberate ` +
        `pinned/narrow lane; if members report scoped misses, this spec is why.`,
    };
  }

  return { refuse: false, errors: [] };
}
