/**
 * Translate a claim-spec `view.filter` into an events `payload_filter`
 * (a @papercusp/rules DataCondition) scoped to the fields the canonical
 * `work-item:claimable` event payload actually carries (EI-15185).
 *
 * The gap this closes: a winding-down fleet member, told to park
 * `events:await { event: 'work-item:claimable', payload_filter: <your claim
 * spec's view> }`, had NO concrete way to build that filter from its opaque
 * spec (specId/revision are just provenance; nothing surfaced the `view.filter`
 * as an events payload_filter). So it registered an UNSCOPED await and got a
 * full wake/turn on every system-wide claimable emit (an unrelated p2p bug, a
 * tracking issue) — each of which scheduler:get_next then immediately re-rejected
 * as out-of-scope. This function is the missing derivation: a ready-made,
 * copy-pasteable payload_filter the miss response hands back, so the await only
 * fires on items the member's spec could actually admit.
 *
 * SOUNDNESS — the derived filter is a deliberate OVER-APPROXIMATION (a superset)
 * of the spec's admit-set restricted to the payload fields: it must NEVER
 * suppress an item the spec would admit (a false-negative would strand the member
 * on a real wake), but it MAY let through an item the spec later rejects (a cheap
 * re-miss — get_next stays the single authoritative claim path). Consequences:
 *   - a leaf on a field the payload does NOT carry (plan_item, paths, priority,
 *     age, risk_tier, redundancy, est_cost) is dropped permissively;
 *   - a leaf whose op cannot be evaluated soundly on the payload scalar
 *     (relational `< <= > >=`, which only target numeric non-payload fields) is
 *     dropped permissively;
 *   - an `any` (OR) is only narrowed when EVERY arm narrows — a permissive arm
 *     could be the one that admits the item, so requiring the rest would suppress
 *     it;
 *   - a `not` is only narrowed when its inner subtree translates EXACTLY (no
 *     dropped leaves) — negating a superset would UNDER-cover the admit-set.
 * When nothing can be narrowed the result is `undefined` (an unscoped await is
 * the caller's decision, never re-recommended by the miss advice — the other half
 * of the EI-15185 fix).
 *
 * The `glob` → regex translation mirrors claim-spec-match.ts's `globRegex`
 * byte-for-byte (case-insensitive, anchored) so a translated glob leaf matches
 * exactly what the spec evaluator would; `contains` maps to a case-insensitive
 * literal-substring regex, matching the spec's case-insensitive `includes` — EXCEPT
 * on the array-valued `tags` field, where claim-spec-match.ts's array leaf branch
 * treats `contains` as EXACT membership (same as `=`), so it is mapped to `equals`
 * there instead (EI-14161; see ARRAY_VALUED_FIELDS below — a substring mapping would
 * be sound un-negated but UNDER-cover once wrapped in a `not`). `=`/`!=`/`in`/`glob`
 * need no field-type branch: `@papercusp/rules`'s mingo backend already does the same
 * implicit per-element array matching claim-spec-match.ts's array branch does, for
 * every one of those ops (verified directly against mingo — see the test suite).
 *
 * Pure. No I/O.
 */
import type { DataCondition } from '@papercusp/rules';
import type { FilterLeaf, FilterNode } from './claim-spec';

/**
 * Claim-spec filter fields that appear (under the SAME key) on the
 * `work-item:claimable` event payload (`{ id, kind, severity, harness, title,
 * state, reason, assignee, plan, tags, goal }` — see emitWorkItemClaimableEvent).
 * The emitter only announces unassigned rows, but it carries that guaranteed
 * `assignee: null` explicitly so an assignee leaf remains observable when it is
 * nested under `any`/`not` rather than being silently dropped. `severity`,
 * `harness`, `state`, `reason` are payload-only (no claim-spec leaf references
 * them). `plan` is carried on the payload specifically so a plan-drain spec can
 * narrow here (EI-15185); `tags` likewise so a spec that EXCLUDES a whole tagged
 * category (p2p / rig-needed / etc — the class the title-glob workaround stood
 * in for when tags went unpopulated) can narrow here too (EI-14161). `goal` is
 * carried from `WorkItem.goalId` so a goal-drain spec can narrow here as well
 * (EI-21834327391666056).
 */
const PAYLOAD_FILTERABLE_FIELDS = new Set<FilterLeaf['field']>(['id', 'kind', 'title', 'assignee', 'plan', 'tags', 'goal']);

/** Array-VALUED payload fields — mingo/DataCondition still does implicit
 *  per-element matching for these (verified: `equals`/`notEquals`/`in`/`matches`
 *  on an array field behave exactly like claim-spec-match.ts's array leaf branch),
 *  so the switch below is unchanged for them EXCEPT `contains`: claim-spec-match's
 *  array branch treats `contains` as EXACT membership (same as `=`), never a
 *  substring test — reusing the scalar `contains` → regex-substring mapping here
 *  would over-approximate un-negated (harmless) but UNDER-cover once wrapped in a
 *  `not` (a tag `'p2p-experimental'` substring-matches `/p2p/` yet is NOT exactly
 *  `'p2p'`, so `not(contains)` would wrongly suppress an item the spec truly
 *  admits) — unsound. See leafToCondition. */
const ARRAY_VALUED_FIELDS = new Set<FilterLeaf['field']>(['tags']);

/** Mirror claim-spec-match.ts `globRegex` EXACTLY (anchored, case-insensitive). */
function globToRegexSource(pattern: string): string {
  return `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
}

/** Escape a literal string for a regex (used for the case-insensitive `contains` substring). */
function literalToRegexSource(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mirror claim-spec-match.ts's `wordBoundaryRegex` EXACTLY (EI-18690730909662985):
 * a case-insensitive WHOLE-WORD substring match, for the `word` op.
 *
 * Boundary is `[^A-Za-z0-9]`/string-edge, NOT `\b` — `\b` treats `_` as a word
 * char, so `\breplication\b` misses "replication_soak". See the full rationale on
 * claim-spec-match.ts's `wordBoundaryRegex`; these two and get-next.ts's Postgres
 * compiler must stay in sync.
 */
function wordBoundaryRegexSource(value: string): string {
  return `(?<![A-Za-z0-9])${literalToRegexSource(value)}(?![A-Za-z0-9])`;
}

interface Translated {
  /** null ⇒ permissive (matches every payload — no narrowing over this subtree). */
  cond: DataCondition | null;
  /** true ⇒ translated with NO information dropped (every leaf mapped cleanly). */
  exact: boolean;
}

const PERMISSIVE: Translated = { cond: null, exact: false };

/** Translate ONE leaf → a DataCondition MatchMap, or null when it cannot narrow the payload. */
function leafToCondition(leaf: FilterLeaf): DataCondition | null {
  if (!PAYLOAD_FILTERABLE_FIELDS.has(leaf.field)) return null;
  const { field, op, value } = leaf;
  switch (op) {
    case '=':
      return { [field]: { equals: value } };
    case '!=':
      return { [field]: { notEquals: value } };
    case 'in':
      return { [field]: { in: Array.isArray(value) ? value : [value] } };
    case 'glob':
      return { [field]: { matches: { source: globToRegexSource(String(value)), flags: 'i' } } };
    case 'word':
      // Word-boundary literal match — sound on both scalar and array-valued fields
      // (mingo's implicit per-element matching applies to `matches` too, same as
      // `glob` above), so no ARRAY_VALUED_FIELDS branch is needed here.
      return { [field]: { matches: { source: wordBoundaryRegexSource(String(value)), flags: 'i' } } };
    case 'contains':
      // Array fields (tags): `contains` is EXACT membership per claim-spec-match's
      // array leaf branch, not a substring test — map like `=` (see ARRAY_VALUED_FIELDS).
      return ARRAY_VALUED_FIELDS.has(field)
        ? { [field]: { equals: value } }
        : { [field]: { matches: { source: literalToRegexSource(String(value)), flags: 'i' } } };
    // Relational ops (< <= > >=) only target numeric fields the claimable payload
    // does not carry — drop permissively rather than risk an unsound coercion.
    default:
      return null;
  }
}

function translate(node: FilterNode): Translated {
  if ('field' in node) {
    const cond = leafToCondition(node);
    return cond ? { cond, exact: true } : PERMISSIVE;
  }
  if ('all' in node) {
    const kids = node.all.map(translate);
    // AND: keep the narrowable children (requiring FEWER necessary conditions is a
    // sound superset); exact only if none was dropped.
    const kept = kids.filter((k): k is { cond: DataCondition; exact: boolean } => k.cond !== null);
    const exact = kids.every((k) => k.exact);
    if (kept.length === 0) return PERMISSIVE;
    return { cond: kept.length === 1 ? kept[0]!.cond : { all: kept.map((k) => k.cond) }, exact };
  }
  if ('any' in node) {
    const kids = node.any.map(translate);
    // OR: sound to narrow only if EVERY arm narrows — a permissive arm could be the
    // one that admits the item, so requiring the others would suppress it.
    if (kids.some((k) => k.cond === null)) return PERMISSIVE;
    const conds = kids.map((k) => k.cond as DataCondition);
    return { cond: conds.length === 1 ? conds[0]! : { any: conds }, exact: kids.every((k) => k.exact) };
  }
  // NOT: needs an UNDER-approximation of the inner, so only sound when the inner
  // translates EXACTLY (no dropped leaves); otherwise negating a superset would
  // under-cover the admit-set and strand a real wake.
  const inner = translate(node.not);
  if (inner.cond !== null && inner.exact) return { cond: { not: inner.cond }, exact: true };
  return PERMISSIVE;
}

/**
 * The public entry point: a claim-spec `view.filter` (or undefined) → the events
 * `payload_filter` to hand a winding-down fleet member, or `undefined` when the
 * spec narrows only on fields the claimable payload does not carry (in which case
 * the caller must NOT recommend an unscoped await).
 */
export function claimSpecFilterToClaimablePayloadFilter(
  filter: FilterNode | undefined,
): DataCondition | undefined {
  if (!filter) return undefined;
  return translate(filter).cond ?? undefined;
}
