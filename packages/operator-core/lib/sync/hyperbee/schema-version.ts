/**
 * D-024 — schema-version handling for Hyperbee ops.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-030d.
 * v5 D-024 — every Autobase op carries `schema_version BIGINT`; peers
 * ignore ops with newer-than-known schemas + raise an
 * "upgrade Papercusp available" toast.
 *
 * Per-harness, per-process state:
 *   getKnownMaxSchemaVersion(harnessSlug) — read by the merge gate
 *                                           (boot.ts `versionGatedLog`)
 *   acceptOpVersion(slug, version)        — the gate decision; drops an
 *                                           unknown-newer op + emits the
 *                                           "upgrade Papercusp available"
 *                                           alert once per (slug, version)
 *
 * LOAD-BEARING INVARIANT — read before changing how `known` grows:
 * `known` is `CURRENT_SCHEMA_VERSION` (a compile-time const) until a NEW
 * BUILD raises it; raising the build means a PROCESS RESTART. There is
 * deliberately NO in-session writer that grows `knownByHarness` (an earlier
 * draft of this doc referenced a `notedHigherSchemaVersion` — it was never
 * built, on purpose). This matters because the merge driver ADVANCES THE
 * CURSOR PAST a version-gated drop (read-merge.ts: `if (!op) continue;`),
 * and the merge cursor is in-memory + non-persisted (boot.ts creates a
 * FRESH one every boot). So an op gate-dropped earlier in a session is NOT
 * re-read later in that same session — it is recovered ONLY by the cursor
 * rebuild a restart performs. Because the only way `known` rises IS a
 * restart, the upgraded peer re-folds every log from 0 and recovers every
 * formerly-newer op → rolling public upgrades lose nothing.
 *
 * THEREFORE: if you ever add in-session schema-version learning (raise
 * `known` without a restart), you MUST reset every live merge cursor in the
 * same step, or every op gate-dropped earlier in the session is lost
 * permanently. Regression guard: __tests__/schema-skew-rolling-upgrade.test.ts
 * (Phase 3). The "known_schema_versions" LOCAL table may one day persist
 * `known` across restarts; the worst case today is one extra alert per
 * session.
 */

import { EventEmitter } from 'node:events';

/**
 * The current version this build of the operator knows. Bump when
 * adding a backwards-incompatible field to any Hyperbee op shape.
 */
export const CURRENT_SCHEMA_VERSION = 1 as const;

const knownByHarness = new Map<string, number>();
const alertedKeys = new Set<string>();        // `${slug}::${version}`

export const schemaVersionEvents = new EventEmitter();

export type SchemaVersionAlert = {
  harnessSlug: string;
  observed_version: number;
  known_version: number;
};

export function getKnownMaxSchemaVersion(harnessSlug: string): number {
  return knownByHarness.get(harnessSlug) ?? CURRENT_SCHEMA_VERSION;
}

/**
 * Decide whether an incoming op's schema_version is acceptable.
 * Returns:
 *   - true  → apply this op
 *   - false → drop this op (and an alert may have fired)
 */
export function acceptOpVersion(harnessSlug: string, version: number | undefined): boolean {
  if (version === undefined) return true;        // legacy / not yet versioned
  const known = getKnownMaxSchemaVersion(harnessSlug);
  if (version <= known) return true;
  // Newer-than-known — drop + alert once per (slug, version).
  const alertKey = `${harnessSlug}::${version}`;
  if (!alertedKeys.has(alertKey)) {
    alertedKeys.add(alertKey);
    const alert: SchemaVersionAlert = {
      harnessSlug,
      observed_version: version,
      known_version: known,
    };
    schemaVersionEvents.emit('alert', alert);
  }
  return false;
}

/** For tests. */
export function _resetForTests(): void {
  knownByHarness.clear();
  alertedKeys.clear();
  schemaVersionEvents.removeAllListeners();
}
