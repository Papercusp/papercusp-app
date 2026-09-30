/**
 * runCensus — the census job orchestration (P-002, second half).
 *
 * Plan: deterministic-coverage-census-2026-08-17.
 *
 * The store is INJECTED, following this package's existing seam convention (data-source.ts), so
 * the whole job is exercisable without a database and the package keeps no hard dependency on
 * the operator's pg client.
 *
 * ORDER OF OPERATIONS IS LOAD -> ENUMERATE -> DIFF -> APPLY, and the apply step is the only one
 * that writes. Everything that decides WHAT to write is pure (diffCensus), which is why the
 * dangerous properties are unit-testable.
 */

import { diffCensus, runProvider, type CensusDiff } from './diff.js';
import type {
  CensusContext,
  ExistingSurface,
  ProviderRun,
  SurfaceCensusProvider,
} from './types.js';

export interface ProviderRegistration {
  provider: string;
  config: Record<string, unknown>;
  enabled: boolean;
  source: 'template' | 'detected' | 'manual';
}

export interface CensusScope {
  workspaceId: string;
  harnessSlug: string;
}

export interface CensusStore {
  loadRegistrations(scope: CensusScope): Promise<ProviderRegistration[]>;
  /** Live rows INCLUDING retired ones — a returning surface must be un-retired, not re-created. */
  loadExisting(scope: CensusScope): Promise<ExistingSurface[]>;
  applyDiff(
    scope: CensusScope,
    diff: Pick<CensusDiff, 'upserts' | 'retires'>,
  ): Promise<{ upserted: number; retired: number }>;
}

export interface CensusReport {
  scope: CensusScope;
  ranProviders: string[];
  /** Registered but skipped because `enabled: false`. Their kinds are NOT retirable. */
  disabledProviders: string[];
  /** Registered with no implementation available in this build. Also not retirable. */
  unimplementedProviders: string[];
  failedProviders: { provider: string; error: string }[];
  diff: CensusDiff;
  applied: { upserted: number; retired: number } | null;
  /** Set when the circuit breaker refused the retirements. `applied.retired` is then 0. */
  retirementBlocked: null | {
    reason: 'mass-retirement';
    wouldRetire: number;
    liveRows: number;
    threshold: number;
  };
}

export interface RunCensusOptions {
  scope: CensusScope;
  store: CensusStore;
  /** Implementations available in this build, keyed by provider id. */
  providers: readonly SurfaceCensusProvider[];
  repoRoot: string;
  /**
   * Circuit breaker. If a run would retire more than this FRACTION of the live rows it is
   * allowed to touch, the retirements are refused and reported instead of applied.
   *
   * Retirement scoping (see diff.ts) already prevents the known cause of mass retirement — a
   * blind provider. This is defense-in-depth against the UNKNOWN cause: any future bug whose
   * symptom is "the census suddenly thinks most surfaces are gone" produces a loud refusal
   * rather than a gate that silently reports full coverage of a shrunken world. Set to 1 to
   * disable (e.g. a deliberate mass deprecation).
   */
  massRetirementThreshold?: number;
  /** Escape hatch for a deliberate large deletion — bypasses the breaker for THIS run only. */
  allowMassRetirement?: boolean;
}

export const DEFAULT_MASS_RETIREMENT_THRESHOLD = 0.5;

export async function runCensus(options: RunCensusOptions): Promise<CensusReport> {
  const {
    scope,
    store,
    providers,
    repoRoot,
    massRetirementThreshold = DEFAULT_MASS_RETIREMENT_THRESHOLD,
    allowMassRetirement = false,
  } = options;

  const registrations = await store.loadRegistrations(scope);
  const byId = new Map(providers.map((p) => [p.provider, p]));

  const disabledProviders: string[] = [];
  const unimplementedProviders: string[] = [];
  const runs: ProviderRun[] = [];
  const ranProviders: string[] = [];

  for (const registration of registrations) {
    if (!registration.enabled) {
      disabledProviders.push(registration.provider);
      continue;
    }
    const impl = byId.get(registration.provider);
    if (!impl) {
      // Registered but not implemented here. Deliberately NOT reported as a failed run: a failed
      // run marks its kinds un-retirable, and we do not know this provider's kinds, so there is
      // nothing to protect. It is surfaced so a misconfigured registration is visible.
      unimplementedProviders.push(registration.provider);
      continue;
    }

    const ctx: CensusContext = {
      workspaceId: scope.workspaceId,
      harnessSlug: scope.harnessSlug,
      config: registration.config,
      repoRoot,
    };
    runs.push(await runProvider(impl, ctx as never));
    ranProviders.push(registration.provider);
  }

  const existing = await store.loadExisting(scope);
  const diff = diffCensus(runs, existing);

  // ---- Circuit breaker ------------------------------------------------------------------------
  const liveInScope = existing.filter(
    (row) => !row.retiredAt && diff.retirableKinds.includes(row.kind),
  ).length;
  const wouldRetire = diff.retires.length;
  const breach =
    !allowMassRetirement &&
    massRetirementThreshold < 1 &&
    wouldRetire > 0 &&
    liveInScope > 0 &&
    wouldRetire / liveInScope > massRetirementThreshold;

  if (breach) {
    const applied = await store.applyDiff(scope, { upserts: diff.upserts, retires: [] });
    return {
      scope,
      ranProviders,
      disabledProviders,
      unimplementedProviders,
      failedProviders: diff.failedProviders,
      diff,
      applied,
      retirementBlocked: {
        reason: 'mass-retirement',
        wouldRetire,
        liveRows: liveInScope,
        threshold: massRetirementThreshold,
      },
    };
  }

  const applied = await store.applyDiff(scope, {
    upserts: diff.upserts,
    retires: diff.retires,
  });

  return {
    scope,
    ranProviders,
    disabledProviders,
    unimplementedProviders,
    failedProviders: diff.failedProviders,
    diff,
    applied,
    retirementBlocked: null,
  };
}
