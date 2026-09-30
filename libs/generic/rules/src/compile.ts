/**
 * compile.ts — the mingo-backed condition evaluator
 * (rules-engine-wrap-mingo-2026-06-05).
 *
 * The leaf evaluator used to be a hand-rolled operator switch (operators.ts's
 * `evaluateOperatorTest`). It is now backed by **mingo** — "MongoDB query
 * language for in-memory objects" — so we stop owning the operator edge-cases
 * (regex / null / coercion / array semantics): mingo's mature, well-tested
 * predicates do that work. The authoring surface is UNCHANGED — authors still
 * write the curated, non-`$`, YAML-clean MatchMap (`{ 'args.kind': { gte: 5 } }`);
 * this module is the *only* place the `$`-operators live (D-002).
 *
 * Two public artifacts:
 *   - `evaluateOperatorTest(test, value)` — evaluate ONE leaf test against ONE
 *     resolved value (the per-leaf entry point matcher.ts calls; re-exported by
 *     operators.ts so the operator vocabulary stays one file).
 *   - `compileToMingo(when)` — translate a whole declarative `when` (MatchMap +
 *     combinators) into a single mingo query. The vocabulary map in one place,
 *     and the artifact a future whole-query indexer can build on.
 *
 * Vocabulary → mingo (D-002):
 *   equals→$eq · notEquals→$ne · in→$in · notIn→$nin · gt/gte/lt/lte→$gt/$gte/
 *   $lt/$lte · matches→$regex · all/any/not→$and/$or/$nor. `exists` is our
 *   not-null semantics, translated to `$ne null` / `$eq null` (NOT mongo's
 *   key-presence `$exists`). The genuinely non-mongo ops — `truthy`, `contains`,
 *   `notContains` — are registered as mingo CUSTOM query operators so they run
 *   inside the same engine. `startsWith` / `endsWith` translate to anchored,
 *   escaped `$regex`.
 *
 * Behaviour (D-003): byte-identical to the old hand-rolled evaluator for every
 * operator on scalar values + every existing test. Where mingo's semantics
 * legitimately differ from the old hand-rolled ones — null≡undefined for `$eq`,
 * implicit array-element matching, BSON-typed (non-coercing) comparison,
 * string-only `$regex` — those are mingo's documented MongoDB semantics, now
 * adopted on purpose and pinned by edge-case tests (see compile.edge.test.ts).
 *
 * Pure. No I/O. The engine wraps `match()` in try/catch so a single bad rule
 * (e.g. an un-compilable operand) cannot break matching.
 */

import { Query, Context } from 'mingo';
import * as queryOps from 'mingo/operators/query';
import { resolve, isEqual as mingoIsEqual } from 'mingo/util';
import { isOperatorTest, type OperatorTest } from './operators';
import type { DataCondition, MatchMap } from './types';

/** A single mingo field-fragment, e.g. `{ $eq: 5 }` or `{ $gt: 3, $lt: 10 }`. */
type MingoFragment = Record<string, unknown>;
/** A compiled mingo query (criteria) — the shape `new Query(...)` accepts. */
export type MingoQuery = Record<string, unknown>;

/* ───────────────────────── custom operators ───────────────────────── */

/**
 * array-value includes the member (deep), or string-value includes the
 * substring. Uses mingo's own deep-equality (the one `$eq`/`$in` use) so
 * `contains` membership stays consistent with the rest of the operator set.
 */
function containsMember(value: unknown, member: unknown): boolean {
  if (Array.isArray(value)) return value.some((el) => mingoIsEqual(el, member));
  if (typeof value === 'string') return value.includes(String(member));
  return false;
}

/** A mingo query-operator: `(selector, operand, options) => (doc) => boolean`. */
type QueryOpFn = (selector: string, operand: unknown, options?: unknown) => (doc: unknown) => boolean;

/** `truthy` — `Boolean(value) === expected`. Not a mongo concept (custom op). */
const $pcTruthy: QueryOpFn = (selector, operand) => (doc) =>
  Boolean(resolve(doc as never, selector)) === Boolean(operand);

/** `contains` — array-includes-member OR string-includes-substring (custom op). */
const $pcContains: QueryOpFn = (selector, operand) => (doc) =>
  containsMember(resolve(doc as never, selector), operand);

/** `notContains` — the negation of `contains` (custom op). */
const $pcNotContains: QueryOpFn = (selector, operand) => (doc) =>
  !containsMember(resolve(doc as never, selector), operand);

/**
 * The mingo evaluation context: every built-in query operator PLUS our three
 * custom ops. Built once at module load. (mingo's default context is empty
 * unless seeded, so we seed it with the full built-in query-op set.)
 */
export const RULES_CONTEXT = Context.init({
  query: { ...queryOps, $pcTruthy, $pcContains, $pcNotContains },
} as never);

/* ───────────────────────── regex helpers ───────────────────────── */

/** Escape a literal string for safe interpolation into a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the RegExp a `matches` test compiles to. Stateful flags (`g`/`y`) are
 * stripped — a leaf test asks "does this value match this pattern", which must
 * be stateless; keeping `g`/`y` would let `lastIndex` leak across evaluations
 * of a cached, reused regex.
 */
function toRegExp(spec: string | { source: string; flags?: string }): RegExp {
  if (typeof spec === 'string') return new RegExp(spec);
  const flags = (spec.flags ?? '').replace(/[gy]/g, '');
  return new RegExp(spec.source, flags);
}

/* ───────────────────────── leaf compilation ───────────────────────── */

/**
 * Compile one leaf test → the mingo field-fragments that, ALL together (implicit
 * AND), reproduce it. One fragment per operator so distinct operators never
 * collide on a `$`-key (e.g. `notEquals` + `exists:true` both want `$ne`).
 *
 * A non-OperatorTest value is the bare-value shorthand → `$eq` (deep-equals).
 */
export function compileLeafClauses(test: unknown): MingoFragment[] {
  if (!isOperatorTest(test)) return [{ $eq: test }];
  const t = test as OperatorTest;
  const out: MingoFragment[] = [];

  if ('equals' in t) out.push({ $eq: t.equals });
  if ('notEquals' in t) out.push({ $ne: t.notEquals });
  // `exists` is our not-null semantics, NOT mongo key-presence ($exists):
  //   exists:true  ⇒ value is neither undefined nor null ⇒ $ne null
  //   exists:false ⇒ value IS undefined or null          ⇒ $eq null
  if ('exists' in t) out.push(t.exists ? { $ne: null } : { $eq: null });
  if ('truthy' in t) out.push({ $pcTruthy: t.truthy });
  if ('in' in t) out.push({ $in: t.in ?? [] });
  if ('notIn' in t) out.push({ $nin: t.notIn ?? [] });
  if ('contains' in t) out.push({ $pcContains: t.contains });
  if ('notContains' in t) out.push({ $pcNotContains: t.notContains });

  // Numeric comparisons share one fragment (distinct `$`-keys, no collision).
  const cmp: MingoFragment = {};
  if ('gt' in t) cmp.$gt = t.gt;
  if ('gte' in t) cmp.$gte = t.gte;
  if ('lt' in t) cmp.$lt = t.lt;
  if ('lte' in t) cmp.$lte = t.lte;
  if (Object.keys(cmp).length) out.push(cmp);

  if ('matches' in t && t.matches !== undefined) out.push({ $regex: toRegExp(t.matches) });
  if ('startsWith' in t && t.startsWith !== undefined) out.push({ $regex: new RegExp('^' + escapeRegExp(t.startsWith)) });
  if ('endsWith' in t && t.endsWith !== undefined) out.push({ $regex: new RegExp(escapeRegExp(t.endsWith) + '$') });

  return out;
}

/* ───────────────────────── whole-`when` compilation (D-002) ───────────────────────── */

type Combinator =
  | { kind: 'all'; subs: DataCondition[] }
  | { kind: 'any'; subs: DataCondition[] }
  | { kind: 'some'; require: number; subs: DataCondition[] }
  | { kind: 'not'; sub: DataCondition };

/** Sole-key combinator detection — mirrors matcher.ts so the two agree. */
function soleCombinator(cond: DataCondition): Combinator | null {
  if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) return null;
  const keys = Object.keys(cond);
  if (keys.length !== 1) return null;
  const key = keys[0];
  if (key === 'all' || key === 'any') {
    const subs = (cond as Record<string, unknown>)[key];
    if (!Array.isArray(subs)) return null;
    return { kind: key, subs: subs as DataCondition[] };
  }
  if (key === 'some') {
    const spec = (cond as Record<string, unknown>).some;
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      const s = spec as Record<string, unknown>;
      if (typeof s.require === 'number' && Array.isArray(s.of)) {
        return { kind: 'some', require: s.require, subs: s.of as DataCondition[] };
      }
    }
    return null;
  }
  if (key === 'not') {
    const sub = (cond as Record<string, unknown>).not;
    if (sub !== null && typeof sub === 'object' && !Array.isArray(sub)) return { kind: 'not', sub: sub as DataCondition };
  }
  return null;
}

/**
 * Every size-`k` subset of `xs` (order-preserving) — the exact expansion basis
 * for `some{require:k}` → `$or` of (`$and` of a k-subset). Bounded by the caller
 * to `1 < k < n` (the presets short-circuit), so this only fires for genuine
 * k-of-n. C(n,k) can grow large; the rules-layer `some` is expected small and
 * this is the SECONDARY compile artifact (matcher.ts is the runtime evaluator),
 * so an exact-but-expanded query is the right trade here. Large event trees live
 * in the await store's counters (composable-event-awaits P-003), not this query.
 */
function kCombinations<T>(xs: T[], k: number): T[][] {
  if (k <= 0) return [[]];
  if (k > xs.length) return [];
  const [head, ...rest] = xs;
  return [...kCombinations(rest, k - 1).map((c) => [head!, ...c]), ...kCombinations(rest, k)];
}

/** A mingo query that matches NO document: NOR of the match-everything (`{}`) query. */
const UNSATISFIABLE: MingoQuery = { $nor: [{}] };

/** Compile a MatchMap (path → leaf test, implicit AND) into a mingo query. */
function compileMatchMap(map: MatchMap): MingoQuery {
  const clauses: MingoFragment[] = [];
  for (const path of Object.keys(map)) {
    for (const frag of compileLeafClauses(map[path])) clauses.push({ [path]: frag });
  }
  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0]!; // length===1 guarantees [0] (noUncheckedIndexedAccess-safe)
  return { $and: clauses };
}

/**
 * Translate a whole declarative `when` (MatchMap + combinators) into ONE mingo
 * query (D-002). Combinators map `all→$and`, `any→$or`, `not→$nor`; the MatchMap
 * maps each path's leaf via `compileLeafClauses`. The authored MatchMap stays
 * the inspectable surface (D-004) — this is the translated form, not the API.
 */
export function compileToMingo(when: DataCondition): MingoQuery {
  const combinator = soleCombinator(when);
  if (combinator) {
    if (combinator.kind === 'all') return { $and: combinator.subs.map(compileToMingo) };
    if (combinator.kind === 'any') return { $or: combinator.subs.map(compileToMingo) };
    if (combinator.kind === 'some') {
      // k-of-n. `any` (k=1) → $or; `all` (k=n) → $and; unreachable/empty (n=0 or
      // k>n) → match-nothing; the genuine middle 1<k<n → $or over every k-subset
      // (each an $and). Exactly what evaluateDataCondition's count>=require decides.
      const subs = combinator.subs.map(compileToMingo);
      const n = subs.length;
      const need = combinator.require;
      if (n === 0 || need > n) return UNSATISFIABLE;
      if (need <= 1) return { $or: subs };
      if (need === n) return { $and: subs };
      return { $or: kCombinations(subs, need).map((group) => ({ $and: group })) };
    }
    return { $nor: [compileToMingo(combinator.sub)] };
  }
  return compileMatchMap(when as MatchMap);
}

/* ───────────────────────── leaf evaluation ───────────────────────── */

/** The synthetic field a single resolved value is tested under. */
const FIELD = '__v';

/** Cache compiled leaf matchers by the (stable) test object — rule `when`s don't mutate. */
const leafCache = new WeakMap<object, (value: unknown) => boolean>();

/** Build a `(value) => boolean` matcher for one leaf test. */
function buildLeafMatcher(test: unknown): (value: unknown) => boolean {
  // compileLeafClauses + `new Query` may throw on an author bug in the operand —
  // a bad `matches` regex source, or a NaN expected-value (mingo's condition
  // clone rejects NaN). That mirrors the old evaluator (a bad regex threw at
  // `toRegExp`); the engine wraps `match()` in try/catch and routes it to
  // `onError`, so one bad rule cannot break matching.
  const clauses = compileLeafClauses(test);
  const condition: MingoQuery = clauses.length === 1 ? { [FIELD]: clauses[0] } : { $and: clauses.map((f) => ({ [FIELD]: f })) };
  const query = new Query(condition, { context: RULES_CONTEXT } as never);
  return (value) => query.test({ [FIELD]: value } as never);
}

/**
 * Evaluate one leaf test against a resolved value (the mingo-backed replacement
 * for the old hand-rolled `evaluateOperatorTest`). If `test` is an OperatorTest,
 * every present operator must pass (implicit AND). Otherwise `test` is a bare
 * expected value → deep-equals. May throw only on an author bug in the operand
 * (a bad regex source / a NaN expected-value) — the engine catches that.
 */
export function evaluateOperatorTest(test: unknown, value: unknown): boolean {
  if (test !== null && typeof test === 'object') {
    let matcher = leafCache.get(test);
    if (!matcher) {
      matcher = buildLeafMatcher(test);
      leafCache.set(test, matcher);
    }
    return matcher(value);
  }
  // Bare primitive expected-value (string/number/boolean) — cheap, uncached.
  return buildLeafMatcher(test)(value);
}
