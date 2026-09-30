/**
 * Shared signed-context contract for the v2 pot-git envelopes (P-513/F2).
 *
 * The v1 envelopes intentionally remain readable for an explicit migration
 * window.  A v2 envelope binds the stable hive identity, federated repository
 * key, and store lineage to the device signature; receivers can therefore
 * reject a valid signature that belongs to another hive/repository/lineage.
 */
export const SIGNED_PROTOCOL_SCHEMA_VERSION = 2;

export interface SignedProtocolScope {
  /** Federated hive identity (never a local install slug). */
  hive_id: string;
  /** Federated repository key (`canonicalRepoKey`). */
  repo_key: string;
}

/** Generation belongs to the signing device, not to the receiving store. */
export interface SignedProtocolContext extends SignedProtocolScope {
  /** Stable identity for the current bare-store lineage. */
  store_generation: string;
}

export type ExpectedSignedProtocolContext = SignedProtocolScope & Partial<Pick<SignedProtocolContext, 'store_generation'>>;

/** Accepted materialization watermark; persist outside fetch-overwritten refs. */
export interface SignedSnapshotFloor extends SignedProtocolContext {
  version: number;
  sigrefs_oid: string;
}

/** The ordinal survives store deletion; the nonce identifies the physical store. */
export function storeGenerationOrdinal(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^sg2-([1-9][0-9]*)-([0-9a-f]{40}|[0-9a-f]{64})$/.exec(value);
  if (!match) return null;
  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal) ? ordinal : null;
}

/** null means an invalid or equivocating generation, never an ordering tie. */
export function compareGenerationVersion(
  incoming: { version: number; store_generation?: string },
  prior: { version: number; store_generation?: string },
): -1 | 0 | 1 | null {
  if (incoming.store_generation !== prior.store_generation) {
    if (!incoming.store_generation) return -1;
    if (!prior.store_generation) return storeGenerationOrdinal(incoming.store_generation) === null ? null : 1;
    const next = storeGenerationOrdinal(incoming.store_generation);
    const old = storeGenerationOrdinal(prior.store_generation);
    if (next === null || old === null || next === old) return null;
    return next > old ? 1 : -1;
  }
  return incoming.version === prior.version ? 0 : incoming.version > prior.version ? 1 : -1;
}

function validPart(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isSignedProtocolContext(value: unknown): value is SignedProtocolContext {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return validPart(v.hive_id) && validPart(v.repo_key) && storeGenerationOrdinal(v.store_generation) !== null;
}

/** Compare only the signed identity tuple; callers decide whether v1 is allowed. */
export function signedProtocolContextMatches(
  value: Partial<SignedProtocolContext> | null | undefined,
  expected: ExpectedSignedProtocolContext,
): boolean {
  return (
    value?.hive_id === expected.hive_id &&
    value?.repo_key === expected.repo_key &&
    (expected.store_generation === undefined || value?.store_generation === expected.store_generation)
  );
}

export function makeSignedProtocolContext(hiveId: string, repoKey: string, generation: string): SignedProtocolContext {
  const context = { hive_id: hiveId, repo_key: repoKey, store_generation: generation };
  if (!isSignedProtocolContext(context)) throw new Error('pot-git: invalid signed protocol context');
  return context;
}
