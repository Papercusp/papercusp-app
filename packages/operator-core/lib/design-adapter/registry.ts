/**
 * Adapter registry — install / lookup / dispatch.
 *
 * Plan §20.2: adapters activate lazily on first reference. If two
 * adapters claim the same ecosystem, harness must explicitly pick one
 * (via `pickAdapter`); otherwise listing flags the conflict.
 */
import type { DesignEcosystemAdapter, AdapterCapability } from './contract';

const installed = new Map<string, DesignEcosystemAdapter>();
/** ecosystem → adapter id, when explicitly picked */
const picks = new Map<string, string>();

export class AdapterConflictError extends Error {
  readonly ecosystem: string;
  readonly candidates: readonly string[];
  constructor(ecosystem: string, candidates: readonly string[]) {
    super(
      `multiple adapters claim ecosystem "${ecosystem}": ${candidates.join(', ')}. ` +
        `pick one via design-adapter pickAdapter().`,
    );
    this.name = 'AdapterConflictError';
    this.ecosystem = ecosystem;
    this.candidates = candidates;
  }
}

export class IrVersionMismatchError extends Error {
  readonly adapterId: string;
  readonly required: string;
  readonly supported: readonly string[];
  constructor(adapterId: string, required: string, supported: readonly string[]) {
    super(
      `adapter "${adapterId}" does not support irVersion "${required}" ` +
        `(supports: ${supported.join(', ')})`,
    );
    this.name = 'IrVersionMismatchError';
    this.adapterId = adapterId;
    this.required = required;
    this.supported = supported;
  }
}

/** Install a built adapter. Idempotent on (id) — repeated installs of
 *  the same id replace the prior copy (useful for plugin reload). */
export function installAdapter(adapter: DesignEcosystemAdapter): void {
  installed.set(adapter.id, adapter);
}

export function uninstallAdapter(id: string): void {
  installed.delete(id);
  for (const [eco, picked] of picks) {
    if (picked === id) picks.delete(eco);
  }
}

/** All installed adapters; insertion order. */
export function listAdapters(): DesignEcosystemAdapter[] {
  return [...installed.values()];
}

/** Find adapters that claim a particular ecosystem. */
export function adaptersForEcosystem(ecosystem: string): DesignEcosystemAdapter[] {
  return [...installed.values()].filter((a) => a.ecosystem === ecosystem);
}

/** Explicit harness pick when conflict resolution requires it. */
export function pickAdapter(ecosystem: string, adapterId: string): void {
  if (!installed.has(adapterId)) {
    throw new Error(`pickAdapter: no adapter "${adapterId}" installed`);
  }
  picks.set(ecosystem, adapterId);
}

export function clearAdapterPick(ecosystem: string): void {
  picks.delete(ecosystem);
}

/**
 * Resolve the active adapter for an ecosystem, honoring explicit picks.
 * Throws on conflict (no pick + multiple candidates).
 */
export function getAdapter(ecosystem: string): DesignEcosystemAdapter | null {
  const picked = picks.get(ecosystem);
  if (picked) return installed.get(picked) ?? null;
  const candidates = adaptersForEcosystem(ecosystem);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  throw new AdapterConflictError(
    ecosystem,
    candidates.map((c) => c.id),
  );
}

/**
 * Get the adapter, asserting it supports the given IR version. Throws
 * IrVersionMismatchError if not.
 */
export function getAdapterFor(ecosystem: string, irVersion: string): DesignEcosystemAdapter {
  const a = getAdapter(ecosystem);
  if (!a) throw new Error(`no adapter installed for ecosystem "${ecosystem}"`);
  if (!supportsIrVersion(a, irVersion)) {
    throw new IrVersionMismatchError(a.id, irVersion, a.irVersionsSupported);
  }
  return a;
}

/** True if `version` (e.g. "0.1") matches any of the adapter's
 *  declared semver ranges (e.g. "0.x", "1.x", or exact "0.1"). */
export function supportsIrVersion(
  adapter: DesignEcosystemAdapter,
  version: string,
): boolean {
  const major = version.split('.')[0];
  return adapter.irVersionsSupported.some((range) => {
    if (range === version) return true;
    const m = /^(\d+)\.x$/.exec(range);
    if (m && m[1] === major) return true;
    return false;
  });
}

/** Capability-narrowed lookup; convenient for dispatch sites that
 *  expect a particular surface. */
export function getAdapterWithCapability<C extends AdapterCapability>(
  ecosystem: string,
  capability: C,
): DesignEcosystemAdapter | null {
  const a = getAdapter(ecosystem);
  if (!a) return null;
  if (!a.capabilities.includes(capability)) return null;
  // surface presence is asserted by the conformance check at install
  return a;
}

/** Union of UI globs declared by every installed adapter — used by the
 *  needsDesign heuristic so backend-only adapters don't pull
 *  refactors into the design queue. */
export function unionUiGlobs(): string[] {
  const set = new Set<string>();
  for (const a of installed.values()) {
    for (const g of a.uiPaths) set.add(g);
  }
  return [...set];
}

/** Test-only: wipe the registry between tests. */
export function _resetAdapterRegistryForTests(): void {
  installed.clear();
  picks.clear();
}
