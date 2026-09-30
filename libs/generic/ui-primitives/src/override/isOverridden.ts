/**
 * isOverridden / effectiveValue — the pure backbone of the "workspace default vs
 * session override" pattern (sentinel-as-herald-2026-06-21 frontend foundation).
 *
 * Today ~8 settings hand-roll the same shape: a `base` (workspace / system
 * default), an `override` (the session-now lever, often null = "not overriding"),
 * a default-vs-override badge, and a reset ↺ that clears the override. This util
 * is the value half (the `<OverridableSetting>` component is the presentational
 * half); both are designed so the existing copies (ModelTiersOverride's per-tier
 * `isOverridden`, ThrottleSection's per-knob `!= null` checks) can migrate onto it
 * without a behavior change.
 *
 * `isOverridden` is null/undefined-safe and value-aware: a null/undefined override
 * is NEVER an override; scalars compare with `===`; objects/arrays deep-equal so an
 * override that merely re-states the base (a no-op) does NOT count as overridden
 * (mirrors ModelTiersOverride.withTierSpec collapsing a baseline-equal edit to
 * null). Pass `eq` to override the comparison (e.g. a name-keyed tier compare).
 */

/** Structural deep-equal for the override-vs-base check. Order-sensitive for
 *  arrays; key-set-sensitive for plain objects. Handles nested objects/arrays,
 *  NaN (treated equal to NaN), and null. Not a general-purpose deep-equal — it
 *  covers the JSON-ish shapes flag/steering overrides actually carry. */
export function defaultEq<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!defaultEq(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!defaultEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

/**
 * True when `override` is a real override of `base` — i.e. it is set
 * (not null/undefined) AND differs from `base`. A null/undefined override means
 * "not overriding" (⇒ false), and an override equal to the base is a no-op (⇒
 * false), so the default badge stays clean for re-stated defaults. Pure.
 */
export function isOverridden<T>(
  base: T,
  override: T | null | undefined,
  eq: (a: T, b: T) => boolean = defaultEq,
): boolean {
  if (override === null || override === undefined) return false;
  return !eq(base, override);
}

/** The value in effect: the override when set (not null/undefined), else the base.
 *  Pairs with `isOverridden` so callers read one source of truth. Pure. */
export function effectiveValue<T>(base: T, override: T | null | undefined): T {
  return override === null || override === undefined ? base : override;
}
