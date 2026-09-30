/**
 * Condition evaluation: the declarative data-matcher + the predicate hatch.
 *
 * `evaluateCondition(cond, event)`:
 *   - undefined        → true (no condition ⇒ always matches once `on` matched)
 *   - function         → predicate(event) (the escape-hatch)
 *   - { all: [...] }   → every sub-condition holds
 *   - { any: [...] }   → some sub-condition holds
 *   - { not: ... }     → the sub-condition does NOT hold
 *   - MatchMap         → every path's leaf test passes (implicit AND)
 *
 * Path resolution (`getPath`) and the combinator tree stay HERE (so the authored
 * MatchMap remains the inspectable surface — D-004); each leaf test is evaluated
 * by the mingo-backed `evaluateOperatorTest` (compile.ts, D-001).
 *
 * Pure. May throw only if a predicate throws or a leaf operand is an author bug
 * (a bad `matches` regex source / a NaN expected-value); the engine wraps
 * `match()` calls in try/catch so a single bad rule can't break matching
 * (RulesEngineOptions.onError).
 */

import { getPath } from './path';
import { evaluateOperatorTest, isPlainObject } from './operators';
import type { Condition, DataCondition, MatchMap } from './types';

type Combinator =
  | { kind: 'all'; subs: DataCondition[] }
  | { kind: 'any'; subs: DataCondition[] }
  | { kind: 'some'; require: number; subs: DataCondition[] }
  | { kind: 'not'; sub: DataCondition };

/** Combinator detection: a SOLE key of `all`/`any`/`some`/`not` with the right value type. */
function asCombinator(cond: DataCondition): Combinator | null {
  if (!isPlainObject(cond)) return null;
  const keys = Object.keys(cond);
  if (keys.length !== 1) return null;
  const key = keys[0];
  if (key === 'all' || key === 'any') {
    const subs = (cond as Record<string, unknown>)[key];
    if (Array.isArray(subs)) return { kind: key, subs: subs as DataCondition[] };
    return null;
  }
  if (key === 'some') {
    // { some: { require: k, of: [...] } } — k-of-n threshold. Both fields required
    // and well-typed, else it is NOT a combinator (falls through to match-map).
    const spec = (cond as Record<string, unknown>).some;
    if (isPlainObject(spec)) {
      const s = spec as Record<string, unknown>;
      if (typeof s.require === 'number' && Array.isArray(s.of)) {
        return { kind: 'some', require: s.require, subs: s.of as DataCondition[] };
      }
    }
    return null;
  }
  if (key === 'not') {
    const sub = (cond as Record<string, unknown>).not;
    if (isPlainObject(sub)) return { kind: 'not', sub: sub as DataCondition };
    return null;
  }
  return null;
}

/** Evaluate a declarative DataCondition (no predicates) against an event. */
export function evaluateDataCondition(cond: DataCondition, event: unknown): boolean {
  const combinator = asCombinator(cond);
  if (combinator) {
    if (combinator.kind === 'all') return combinator.subs.every((c) => evaluateDataCondition(c, event));
    if (combinator.kind === 'any') return combinator.subs.some((c) => evaluateDataCondition(c, event));
    if (combinator.kind === 'some') {
      // k-of-n: short-circuit as soon as `require` subs have passed. `require > n`
      // (or an empty `of`) can never reach the threshold ⇒ false, matching compile.ts.
      const need = combinator.require;
      let count = 0;
      for (const c of combinator.subs) {
        if (evaluateDataCondition(c, event) && ++count >= need) return true;
      }
      return false;
    }
    return !evaluateDataCondition(combinator.sub, event);
  }
  // A match-map: every path's leaf test must pass.
  const map = cond as MatchMap;
  for (const path of Object.keys(map)) {
    const value = getPath(event, path);
    if (!evaluateOperatorTest(map[path], value)) return false;
  }
  return true;
}

/** Evaluate any `when` (declarative or predicate). Omitted ⇒ true. */
export function evaluateCondition<E>(cond: Condition<E> | undefined, event: E): boolean {
  if (cond === undefined) return true;
  if (typeof cond === 'function') return (cond as (e: E) => boolean)(event);
  return evaluateDataCondition(cond, event);
}
