/**
 * SurfaceCensusProvider — the one stack-coupled seam in the coverage census.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-002), Decisions D-001, D-004.
 *
 * D-001 splits the system in two: the ledger, depth ladder, gates and gap queue are
 * framework-neutral, and the ONLY stack-coupled pieces are the census extractors that
 * enumerate surfaces. This module is that contract. A provider is keyed by STACK, not by
 * project — every pot running Hono reuses `hono-routes`; only its `config` differs.
 *
 * THE INVARIANT THAT MAKES THE CENSUS TRUSTWORTHY: a provider derives its rows from the same
 * registration code that serves production traffic (routeRegistrationOrder(), the agent-tools
 * index, the sync-resolver registry). It never reads a hand-maintained list. A hand-maintained
 * list drifts the first time someone forgets it, and drift here is SILENT FALSE CONFIDENCE —
 * the worst failure this system can have.
 */

/**
 * HOW a surface row was derived, strongest first. Carried into every verdict so a coverage
 * number computed over a weak census can never be read as one computed over a declared census.
 */
export type Fidelity = 'declared' | 'spec' | 'convention' | 'observed' | 'file-only';

export const FIDELITY_ORDER: readonly Fidelity[] = [
  'declared',
  'spec',
  'convention',
  'observed',
  'file-only',
] as const;

/** Higher is stronger. Used to resolve two providers claiming one identity. */
export const FIDELITY_RANK: Readonly<Record<Fidelity, number>> = Object.freeze({
  declared: 5,
  spec: 4,
  convention: 3,
  observed: 2,
  'file-only': 1,
});

export function isFidelity(value: unknown): value is Fidelity {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FIDELITY_RANK, value);
}

/** One surface as a provider observed it this run. Mirrors harness_shared.testing_surfaces. */
export interface ObservedSurface {
  /** Surface class — matches the provider that produced it (http-route, mcp-tool, ...). */
  kind: string;
  /**
   * Provider-stable identity within (harness, kind): "POST /api/widgets", "widgets:list".
   * MUST be stable across runs. An unstable id retires and re-creates the row every run,
   * resetting first_seen and defeating the new-surface gate — which is why `diffCensus`
   * reports churn rather than silently applying it.
   */
  surfaceId: string;
  /** Repo-relative implementing file — the reverse map from a plan's changed files. */
  sourceFile?: string | null;
  /** The surface's own schema (zod JSON / OpenAPI fragment), when it has one. Feeds L2 fuzz. */
  schemaRef?: unknown;
  attrs?: Record<string, unknown>;
  fidelity: Fidelity;
}

export interface CensusContext {
  workspaceId: string;
  harnessSlug: string;
  /** Provider-specific config from census_provider_registrations.config. */
  config: Record<string, unknown>;
  /** Repo root the provider should resolve its globs against. */
  repoRoot: string;
}

export interface SurfaceCensusProvider {
  /** Stack-keyed provider id — `hono-routes`, `mcp-tools`, `sync-queries`, ... */
  readonly provider: string;
  /**
   * The surface kinds this provider OWNS. This is the RETIREMENT SCOPE: a census run may only
   * retire rows whose kind is owned by a provider that reported successfully in that run.
   * Declaring a kind you do not fully enumerate will retire other providers' surfaces.
   */
  readonly kinds: readonly string[];
  enumerate(ctx: CensusContext): Promise<ObservedSurface[]> | ObservedSurface[];
}

/** What one provider produced this run. A THROWN provider becomes `status: 'failed'`. */
export type ProviderRun =
  | { provider: string; kinds: readonly string[]; status: 'ok'; surfaces: ObservedSurface[] }
  | { provider: string; kinds: readonly string[]; status: 'failed'; error: string };

/** A live census row as it exists in the DB today. */
export interface ExistingSurface {
  id: number;
  kind: string;
  surfaceId: string;
  provider: string;
  fidelity: Fidelity;
  sourceFile?: string | null;
  retiredAt?: string | null;
}
