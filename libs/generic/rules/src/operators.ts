/**
 * The operator vocabulary for a single data-match leaf — the curated, inspectable
 * `$`-free authoring surface (D-002/D-006).
 *
 * An `OperatorTest` is a map of operator → expected value, e.g.
 * `{ exists: true }`, `{ equals: 'potato' }`, `{ in: ['a','b'], exists: true }`.
 * Every operator present must pass (implicit AND within a leaf). The vocabulary
 * is the ergonomic short-form set (equals, notEquals, in, notIn, contains,
 * gt/gte/lt/lte) plus a few additions we use in practice (exists, truthy,
 * matches, startsWith, endsWith).
 *
 * This file owns the **vocabulary** — the operator key list (the schema's
 * allowed keys), the `OperatorTest` type, and the `isPlainObject` /
 * `isOperatorTest` guards. The **evaluation** of a leaf is mingo-backed and
 * lives in `compile.ts` (rules-engine-wrap-mingo-2026-06-05 D-001); the
 * mingo-backed `evaluateOperatorTest` is re-exported here so the operator
 * vocabulary stays one import.
 *
 * Pure. No I/O.
 */

/** The mingo-backed leaf evaluator (impl in compile.ts; re-exported here). */
export { evaluateOperatorTest } from './compile';

/** Every operator key. A "test object" is recognised only if ALL its keys are here. */
export const OPERATOR_KEYS = [
  'equals',
  'notEquals',
  'exists',
  'truthy',
  'in',
  'notIn',
  'contains',
  'notContains',
  'gt',
  'gte',
  'lt',
  'lte',
  'matches',
  'startsWith',
  'endsWith',
] as const;

export type OperatorKey = (typeof OPERATOR_KEYS)[number];

export interface OperatorTest {
  /** Deep-equals the expected value. */
  equals?: unknown;
  /** Does NOT deep-equal the expected value. */
  notEquals?: unknown;
  /** `true`: value is neither undefined nor null. `false`: it is. */
  exists?: boolean;
  /** `true`: Boolean(value) is true. `false`: Boolean(value) is false. */
  truthy?: boolean;
  /** value deep-equals one of the listed members. */
  in?: readonly unknown[];
  /** value deep-equals none of the listed members. */
  notIn?: readonly unknown[];
  /** array-value includes the member, or string-value includes the substring. */
  contains?: unknown;
  /** negation of `contains`. */
  notContains?: unknown;
  /** numeric value > expected. */
  gt?: number;
  /** numeric value >= expected. */
  gte?: number;
  /** numeric value < expected. */
  lt?: number;
  /** numeric value <= expected. */
  lte?: number;
  /** String(value) matches the regex (string source, or `{ source, flags }`). */
  matches?: string | { source: string; flags?: string };
  /** String(value) starts with the prefix. */
  startsWith?: string;
  /** String(value) ends with the suffix. */
  endsWith?: string;
}

const OPERATOR_KEY_SET: ReadonlySet<string> = new Set(OPERATOR_KEYS);

/** Is `x` a plain object (not null, not array, not Date/RegExp/etc.)? */
export function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (x === null || typeof x !== 'object') return false;
  if (Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

/**
 * Is `x` an OperatorTest (a plain object whose keys are ALL operator names)?
 * An empty object is NOT a test — it would match everything ambiguously, so we
 * treat `{}` as a bare value (deep-equal to `{}`), matching intuition.
 */
export function isOperatorTest(x: unknown): x is OperatorTest {
  if (!isPlainObject(x)) return false;
  const keys = Object.keys(x);
  if (keys.length === 0) return false;
  return keys.every((k) => OPERATOR_KEY_SET.has(k));
}
