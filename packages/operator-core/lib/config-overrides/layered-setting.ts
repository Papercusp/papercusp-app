/**
 * Reusable layered-setting merge (override-unification, sentinel-herald Phase 8 P-038).
 *
 * Generalizes the user-over-workspace merge that lived voice-only in user-preferences.ts
 * (`mergeUserOverWorkspace` + `VOICE_USER_OVERRIDE_KEYS`) so ANY concern can declare its
 * own user-overridable key set and layer a per-user override on top of a workspace-default
 * base — not just voice prefs.
 *
 * The merge rule is intentionally minimal and shared by every consumer:
 *   • A key is overridden ONLY when it appears in the concern's declared override-key set
 *     (the allowlist) AND the override object has a value present for it.
 *   • `null` / `undefined` are treated as "not set" → fall through to the base. This lets a
 *     user explicitly clear an override (set it null) and inherit the workspace default.
 *   • `false`, `0`, `''` ARE real values and DO override — only null/undefined are "unset".
 *
 * Semantics are byte-identical to the original voice-only `mergeUserOverWorkspace`; this is
 * a pure rename-and-lift so voice-prefs (and future concerns) consume one helper.
 */

/** A loosely-typed override payload (e.g. a per-user prefs JSONB blob). */
export type OverridePayload = Record<string, unknown>;

/**
 * Merge an override layer over a base layer for a declared set of override-eligible keys.
 *
 * Generic over the BASE shape `B`; `overrideKeys` must be keys of `B` (so an override can
 * only ever replace a value the base already defines, keeping the fallback meaningful).
 * Keys outside the allowlist in the override payload are ignored.
 */
export function mergeLayered<B extends Record<string, unknown>>(
  base: B,
  override: OverridePayload,
  overrideKeys: ReadonlyArray<keyof B & string>,
): B {
  const merged: Record<string, unknown> = { ...base };
  for (const k of overrideKeys) {
    if (k in override && override[k] !== null && override[k] !== undefined) {
      merged[k] = override[k];
    }
  }
  return merged as B;
}
