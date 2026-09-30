/**
 * Mockup-to-implementation validation: the host↔plugin bridge.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-006, D-017).
 *
 * ─── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * The design-phase plugin is hand-written CommonJS living in the `libs/papercusp`
 * submodule; the comparison engine adapter is app-side ESM TypeScript here. The
 * obvious move — `require()` from the plugin into this package — was MEASURED and
 * refused (D-017): under plain node it fails on constructor parameter properties
 * and extensionless relative specifiers, working only because the operator host
 * happens to run under tsx. That is a dependency on the host runtime dressed up
 * as an import, and it cannot be exercised from vitest, so the production path
 * would have been permanently stood in for by a fake.
 *
 * So the direction is inverted. The APP publishes into a slot; the LIBRARY reads
 * it. The plugin needs only `@papercusp/module-singleton`, which requires
 * cleanly under both runtimes.
 *
 * ─── WHY `pinModuleState` AND NOT A MODULE-LEVEL `let` ───────────────────────
 *
 * The writer and the reader are, by construction, different module records —
 * one reached through an ESM import from operator-core, the other through a
 * CommonJS `require` from a plugin. A module-scoped variable would give each of
 * them its own copy, and the plugin would read `null` from a slot the host had
 * definitely populated. `pinModuleState` pins to `globalThis` under a
 * `Symbol.for` key, which is correct under every loader seam, and it counts
 * evaluations so a split is REPORTED by `listModuleDuplications()` rather than
 * rediscovered the expensive way. Hand-rolling the `Symbol.for` pair would work
 * and be invisible to that report, which is why `lint:no-hand-rolled-module-pin`
 * refuses it.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import type { DesignCompareVerbs } from './verbs';

/**
 * The pinned key.
 *
 * Exported because the plugin reads the same slot and must use the identical
 * string — this is the one place it is written down, so the two sides cannot
 * drift onto different keys and silently fail to rendezvous.
 */
export const DESIGN_COMPARE_HOST_SLOT = '@papercusp/design-compare.host';

interface HostSlot {
  /** Per-harness verb surfaces. A host serves more than one harness. */
  verbs: Map<string, DesignCompareVerbs>;
}

function slot(): HostSlot {
  return pinModuleState<HostSlot>(DESIGN_COMPARE_HOST_SLOT, () => ({ verbs: new Map() }));
}

/**
 * Publish the verb surface for one harness.
 *
 * Idempotent by harness: re-installing replaces. A host that reloads plugins in
 * dev must not accumulate stale surfaces bound to a closed database handle.
 */
export function installDesignCompareVerbs(harnessSlug: string, verbs: DesignCompareVerbs): void {
  if (!harnessSlug) {
    throw new TypeError('installDesignCompareVerbs: harnessSlug must be a non-empty string');
  }
  slot().verbs.set(harnessSlug, verbs);
}

/**
 * Read the verb surface for one harness, or `undefined`.
 *
 * `undefined` is a first-class answer meaning "no design-compare engine is
 * installed in this host" — a standalone `libs/papercusp` install with no
 * operator, or a boot that never called `installDesignCompareVerbs`. Callers
 * must refuse loudly on it and MUST NOT synthesise a comparison verdict: an
 * absent engine is a host misconfiguration, not evidence about a render.
 */
export function readDesignCompareVerbs(harnessSlug: string): DesignCompareVerbs | undefined {
  return slot().verbs.get(harnessSlug);
}

/** Which harnesses currently have a surface installed. For diagnostics. */
export function installedDesignCompareHarnesses(): string[] {
  return [...slot().verbs.keys()].sort();
}

/** Drop every installed surface. Tests only. */
export function resetDesignCompareHostForTest(): void {
  slot().verbs.clear();
}
