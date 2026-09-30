/**
 * The census diff — pure, DB-free, and the heart of P-002.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-002).
 *
 * Kept pure on purpose: every dangerous property of a census run is a property of the DIFF, not
 * of the SQL that applies it, so all of them are unit-testable without a database. The applier
 * is a thin executor of what this returns.
 *
 * THE DANGEROUS DIRECTION IS RETIREMENT. Upserting a wrong row shows up as a surface nobody
 * tested; retiring a right row DELETES a gate's knowledge that the surface exists, and the gate
 * then reports full coverage of a shrunken world. A crashed provider that enumerates nothing is
 * indistinguishable, at the SQL level, from a provider correctly reporting "these surfaces are
 * gone" — so the distinction is drawn HERE, structurally: retirement is scoped to kinds that a
 * provider actually enumerated successfully this run.
 */

import {
  FIDELITY_RANK,
  type ExistingSurface,
  type Fidelity,
  type ObservedSurface,
  type ProviderRun,
} from './types.js';

export interface ResolvedSurface extends ObservedSurface {
  provider: string;
}

export interface CensusUpsert {
  kind: string;
  surfaceId: string;
  provider: string;
  fidelity: Fidelity;
  sourceFile: string | null;
  schemaRef: unknown;
  attrs: Record<string, unknown>;
  /** True when a currently-retired row is coming back. The applier must clear retired_at and
   *  MUST NOT touch first_seen — a returning surface keeps its original first_seen. */
  unretire: boolean;
}

export interface CensusRetire {
  id: number;
  kind: string;
  surfaceId: string;
  provider: string;
}

export interface IdentityCollision {
  kind: string;
  surfaceId: string;
  winner: string;
  losers: string[];
  reason: 'fidelity' | 'provider-order';
}

export interface DuplicateEmission {
  provider: string;
  kind: string;
  surfaceId: string;
  count: number;
}

export interface CensusDiff {
  upserts: CensusUpsert[];
  retires: CensusRetire[];
  /** Kinds this run may retire within: enumerated by >=1 ok provider AND by no failed provider. */
  retirableKinds: string[];
  /** Kinds deliberately left alone because a provider owning them failed. */
  skippedKinds: string[];
  collisions: IdentityCollision[];
  duplicates: DuplicateEmission[];
  failedProviders: { provider: string; error: string }[];
}

/**
 * Composite map key for (kind, surfaceId).
 *
 * The separator is NUL because a surfaceId legitimately contains spaces, slashes and colons
 * ("POST /api/widgets", "widgets:list") — any printable separator is ambiguous and would collide
 * two distinct surfaces into one key. It is written as the ESCAPE `\x00`, never as a raw NUL
 * byte: a literal NUL makes file(1) classify this valid UTF-8 source as `data`/binary and makes
 * grep refuse to search it, while tsc and esbuild compile it happily — so the breakage is
 * invisible locally and only surfaces at the shared gate (git-sync's `nul-bytes` detector
 * quarantines such a file, which is exactly what it did to the first draft of this line).
 */
const SEP = '\x00';
const identityKey = (kind: string, surfaceId: string) => `${kind}${SEP}${surfaceId}`;

/**
 * Fold provider runs against the live census into an applyable diff.
 *
 * @param providerRuns one entry per provider that was ASKED to run — a provider that threw must
 *   still appear, with status 'failed'. Omitting it silently converts a crash into a mass
 *   retirement, which is the failure this signature exists to make impossible to express.
 * @param existing the live rows (retired ones included, so a returning surface is un-retired
 *   rather than re-created with a fresh first_seen).
 */
export function diffCensus(
  providerRuns: readonly ProviderRun[],
  existing: readonly ExistingSurface[],
): CensusDiff {
  const failedProviders = providerRuns
    .filter((r): r is Extract<ProviderRun, { status: 'failed' }> => r.status === 'failed')
    .map((r) => ({ provider: r.provider, error: r.error }));

  // ---- Retirement scope -------------------------------------------------------------------
  // A kind is retirable only if some provider enumerated it successfully AND no provider that
  // owns it failed. Two providers can share a kind; if either is blind this run, the kind is not
  // fully enumerated and an absent row means "unknown", never "gone".
  const okKinds = new Set<string>();
  const failedKinds = new Set<string>();
  for (const run of providerRuns) {
    for (const kind of run.kinds) {
      (run.status === 'ok' ? okKinds : failedKinds).add(kind);
    }
  }
  const retirableKinds = [...okKinds].filter((k) => !failedKinds.has(k)).sort();
  const skippedKinds = [...okKinds].filter((k) => failedKinds.has(k)).sort();
  const retirable = new Set(retirableKinds);

  // ---- Resolve this run's observed set ------------------------------------------------------
  const duplicates: DuplicateEmission[] = [];
  const collisions: IdentityCollision[] = [];
  const resolved = new Map<string, ResolvedSurface>();
  const contenders = new Map<string, ResolvedSurface[]>();

  for (const run of providerRuns) {
    if (run.status !== 'ok') continue;
    const seenThisProvider = new Map<string, number>();

    for (const surface of run.surfaces) {
      const key = identityKey(surface.kind, surface.surfaceId);
      seenThisProvider.set(key, (seenThisProvider.get(key) ?? 0) + 1);

      const candidate: ResolvedSurface = { ...surface, provider: run.provider };
      const list = contenders.get(key);
      if (list) list.push(candidate);
      else contenders.set(key, [candidate]);
    }

    for (const [key, count] of seenThisProvider) {
      if (count <= 1) continue;
      const sep = key.indexOf(SEP);
      duplicates.push({
        provider: run.provider,
        kind: key.slice(0, sep),
        surfaceId: key.slice(sep + 1),
        count,
      });
    }
  }

  for (const [key, list] of contenders) {
    // Deterministic winner: strongest fidelity, then lexicographic provider so two runs over an
    // unchanged tree produce byte-identical diffs (a census that reshuffles on every run makes
    // first_seen meaningless).
    const sorted = [...list].sort(
      (a, b) =>
        FIDELITY_RANK[b.fidelity] - FIDELITY_RANK[a.fidelity] ||
        a.provider.localeCompare(b.provider),
    );
    const winner = sorted[0];
    resolved.set(key, winner);

    const distinctProviders = new Set(list.map((c) => c.provider));
    if (distinctProviders.size > 1) {
      const losers = sorted.slice(1).map((c) => c.provider);
      collisions.push({
        kind: winner.kind,
        surfaceId: winner.surfaceId,
        winner: winner.provider,
        losers: [...new Set(losers)],
        reason:
          FIDELITY_RANK[winner.fidelity] > FIDELITY_RANK[sorted[1].fidelity]
            ? 'fidelity'
            : 'provider-order',
      });
    }
  }

  // ---- Upserts ------------------------------------------------------------------------------
  const existingByIdentity = new Map<string, ExistingSurface>();
  for (const row of existing) {
    existingByIdentity.set(identityKey(row.kind, row.surfaceId), row);
  }

  const upserts: CensusUpsert[] = [];
  for (const [key, surface] of resolved) {
    const prior = existingByIdentity.get(key);
    upserts.push({
      kind: surface.kind,
      surfaceId: surface.surfaceId,
      provider: surface.provider,
      fidelity: surface.fidelity,
      sourceFile: surface.sourceFile ?? null,
      schemaRef: surface.schemaRef ?? null,
      attrs: surface.attrs ?? {},
      unretire: Boolean(prior?.retiredAt),
    });
  }

  // ---- Retirements --------------------------------------------------------------------------
  const retires: CensusRetire[] = [];
  for (const row of existing) {
    if (row.retiredAt) continue; // already retired — not a transition
    if (!retirable.has(row.kind)) continue; // blind this run: absent means unknown, not gone
    if (resolved.has(identityKey(row.kind, row.surfaceId))) continue;
    retires.push({
      id: row.id,
      kind: row.kind,
      surfaceId: row.surfaceId,
      provider: row.provider,
    });
  }

  const byIdentity = (
    a: { kind: string; surfaceId: string },
    b: { kind: string; surfaceId: string },
  ) => a.kind.localeCompare(b.kind) || a.surfaceId.localeCompare(b.surfaceId);

  return {
    upserts: upserts.sort(byIdentity),
    retires: retires.sort(byIdentity),
    retirableKinds,
    skippedKinds,
    collisions: collisions.sort(byIdentity),
    duplicates: duplicates.sort(byIdentity),
    failedProviders,
  };
}

/**
 * Run a provider, converting a throw into a `failed` ProviderRun rather than letting it
 * propagate. A crashing provider must degrade this run to "blind for its kinds", never abort the
 * whole census (which would leave every other provider's surfaces unrefreshed and stale).
 */
export async function runProvider(
  provider: {
    provider: string;
    kinds: readonly string[];
    enumerate: (ctx: never) => Promise<ObservedSurface[]> | ObservedSurface[];
  },
  ctx: never,
): Promise<ProviderRun> {
  try {
    const surfaces = await provider.enumerate(ctx);
    if (!Array.isArray(surfaces)) {
      return {
        provider: provider.provider,
        kinds: provider.kinds,
        status: 'failed',
        error: `enumerate() returned ${typeof surfaces}, expected an array`,
      };
    }
    return { provider: provider.provider, kinds: provider.kinds, status: 'ok', surfaces };
  } catch (err) {
    return {
      provider: provider.provider,
      kinds: provider.kinds,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
