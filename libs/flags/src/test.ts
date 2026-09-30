// Test helpers. Lets tests force flag values without standing up PostHog.
// Server-side: `initFlagBackend(null)` then `setFlagOverridesForTest({...})`.
// Client-side: assign `globalThis.__PAPERCUSP_FLAGS__` before importing client.

import type { FlagKey, FlagValues } from "./types";
import { FLAG_DEFAULTS } from "./types";
// Deliberate circular import: server.ts imports resolveTestOverrides from this
// module, and this module imports emitFlagChange back from server.ts. Safe
// under ESM because BOTH bindings are only used inside function bodies (never
// at module-top-level), so by the time either is actually called both modules
// have finished evaluating.
import { emitFlagChange } from "./server";

let overrides: Partial<Record<FlagKey, boolean>> | null = null;

/**
 * EI-9464: several server-side consumers (workspace-brain-scope.ts and other
 * onFlagChange()-based readers — grep the repo for `onFlagChange` to find the
 * whole class) deliberately cache a flag's resolved value PROCESS-STICKY and
 * only re-read it when `emitFlagChange` fires (a real flag-bus flip). Flipping
 * `setFlagOverridesForTest` between two `it()`s in the same suite IS an
 * intentional flag change for test purposes, but previously never emitted
 * that signal — so a sticky reader initialized during an earlier test (or an
 * earlier leg of the same test) kept serving its FIRST-ever resolved value
 * forever, silently ignoring every later override. Symptom: a K1
 * (FLAGS.WORKSPACE_COORDINATION) "flag ON" leg run before a "flag OFF" leg in
 * routed-ledger.integration.test.ts kept persisting to the workspace-sentinel
 * row in the OFF leg too (the OFF override was set but never observed).
 * Emitting on every override change (both a real map AND a `null` clear)
 * fixes the whole class at once, not just this one caller.
 */
export function setFlagOverridesForTest(
  values: Partial<Record<FlagKey, boolean>> | null,
): void {
  overrides = values;
  emitFlagChange(null);
}

export function resolveTestOverrides(): FlagValues | null {
  if (!overrides) return null;
  return { ...FLAG_DEFAULTS, ...overrides };
}
