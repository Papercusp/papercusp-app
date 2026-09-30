/**
 * @papercusp/seed-bundle — the manifest: the self-describing index of a seed.
 *
 * A seed is a CHECKPOINT of one or more replicated stores (a git repo, a
 * hypercore corestore, …) shipped ahead of a live sync so a fresh host
 * pre-positions the bytes and the UNMODIFIED sync protocol then transfers only
 * the delta on top. The manifest names each store, how to fetch its payload,
 * how to verify it, and (optionally) how it is encrypted at rest.
 *
 * This module is PURE DATA + VALIDATION — no I/O, no crypto, no git, no
 * hypercore. Substrate specifics live in host-supplied {@link SeedProvider}s.
 */

/** Schema version of the manifest artifact. Bump on a breaking shape change. */
export const SEED_FORMAT_VERSION = 1;

/**
 * WHERE a store's payload bytes come from. Deliberately open-ended so a later
 * version can CDN- or swarm-fetch a seed WITHOUT a manifest schema change
 * (only `resource` — a bytes-in-the-installer resource — is used in v1).
 */
export type SeedSource =
  | { readonly type: 'resource'; readonly path: string }
  | { readonly type: 'url'; readonly url: string; readonly bytes: number }
  | { readonly type: 'swarm'; readonly topic: string };

/**
 * HOW the decrypt key for an encrypted store is obtained. The key is NEVER in
 * the seed itself — it is delivered by the live join/admission, which is what
 * keeps a bundled-in-a-public-installer seed confidential until the host is
 * actually admitted to the hive.
 */
export type SeedKeyRef =
  | { readonly via: 'epoch'; readonly potId: string; readonly epoch: number }
  | { readonly via: 'seed-key-op'; readonly potId: string };

/** Present on a store entry ⇒ the payload is ciphertext at rest. */
export interface SeedEncryptionEnvelope {
  readonly scheme: string;
  readonly keyRef: SeedKeyRef;
  readonly nonce?: string;
}

/** One replicated store carried by the seed. */
export interface SeedStoreEntry {
  /** Provider id, e.g. "git" | "corestore". Resolved against the registry. */
  readonly kind: string;
  /** Content hash of the payload — the verify gate before restore. */
  readonly hash: string;
  readonly sizeBytes: number;
  readonly source: SeedSource;
  /** Present ⇒ payload is encrypted at rest (key via `encryption.keyRef`). */
  readonly encryption?: SeedEncryptionEnvelope;
  /** Provider-specific metadata (e.g. corestore per-core lengths). */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** The self-describing index of a seed. */
export interface SeedManifest {
  readonly seedFormatVersion: number;
  /** Which hive this seed reconstitutes. */
  readonly potId: string;
  /** Hive epoch at cut time — a member decrypts seeded content only if it holds
   *  this epoch's key (see the design memo, Q-4). */
  readonly cutAtEpoch: number;
  /** HLC stamp of the cut — the ordering anchor. */
  readonly cutHlc: string;
  /** Wall-clock ms of the cut — provenance only. */
  readonly cutTs: number;
  readonly stores: readonly SeedStoreEntry[];
}

export interface ManifestValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/** Thrown by {@link encodeManifest} / {@link decodeManifest} on an invalid manifest. */
export class SeedManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedManifestError';
  }
}

function validateKeyRef(k: unknown, p: string, errors: string[]): void {
  if (typeof k !== 'object' || k === null) {
    errors.push(`${p} must be an object`);
    return;
  }
  const kr = k as Record<string, unknown>;
  if (kr.via === 'epoch') {
    if (typeof kr.potId !== 'string' || kr.potId.length === 0) errors.push(`${p}.potId must be a non-empty string`);
    if (!Number.isInteger(kr.epoch) || (kr.epoch as number) < 0) errors.push(`${p}.epoch must be a non-negative integer`);
  } else if (kr.via === 'seed-key-op') {
    if (typeof kr.potId !== 'string' || kr.potId.length === 0) errors.push(`${p}.potId must be a non-empty string`);
  } else {
    errors.push(`${p}.via must be one of epoch|seed-key-op`);
  }
}

function validateEncryption(enc: unknown, p: string, errors: string[]): void {
  if (typeof enc !== 'object' || enc === null) {
    errors.push(`${p} must be an object`);
    return;
  }
  const e = enc as Record<string, unknown>;
  if (typeof e.scheme !== 'string' || e.scheme.length === 0) errors.push(`${p}.scheme must be a non-empty string`);
  validateKeyRef(e.keyRef, `${p}.keyRef`, errors);
  if (e.nonce !== undefined && typeof e.nonce !== 'string') errors.push(`${p}.nonce must be a string when present`);
}

function validateSource(s: unknown, p: string, errors: string[]): void {
  if (typeof s !== 'object' || s === null) {
    errors.push(`${p} must be an object`);
    return;
  }
  const src = s as Record<string, unknown>;
  switch (src.type) {
    case 'resource':
      if (typeof src.path !== 'string' || src.path.length === 0) errors.push(`${p}.path must be a non-empty string`);
      break;
    case 'url':
      if (typeof src.url !== 'string' || src.url.length === 0) errors.push(`${p}.url must be a non-empty string`);
      if (!Number.isInteger(src.bytes) || (src.bytes as number) < 0) errors.push(`${p}.bytes must be a non-negative integer`);
      break;
    case 'swarm':
      if (typeof src.topic !== 'string' || src.topic.length === 0) errors.push(`${p}.topic must be a non-empty string`);
      break;
    default:
      errors.push(`${p}.type must be one of resource|url|swarm`);
  }
}

function validateEntry(e: unknown, i: number, errors: string[]): void {
  const p = `stores[${i}]`;
  if (typeof e !== 'object' || e === null) {
    errors.push(`${p} must be an object`);
    return;
  }
  const entry = e as Record<string, unknown>;
  if (typeof entry.kind !== 'string' || entry.kind.length === 0) errors.push(`${p}.kind must be a non-empty string`);
  if (typeof entry.hash !== 'string' || entry.hash.length === 0) errors.push(`${p}.hash must be a non-empty string`);
  if (!Number.isInteger(entry.sizeBytes) || (entry.sizeBytes as number) < 0) errors.push(`${p}.sizeBytes must be a non-negative integer`);
  validateSource(entry.source, `${p}.source`, errors);
  if (entry.encryption !== undefined) validateEncryption(entry.encryption, `${p}.encryption`, errors);
}

/**
 * Validate an untrusted value as a {@link SeedManifest}. Pure; never throws.
 * Collects ALL errors so a caller sees every problem at once.
 */
export function validateManifest(m: unknown): ManifestValidation {
  const errors: string[] = [];
  if (typeof m !== 'object' || m === null) return { ok: false, errors: ['manifest must be an object'] };
  const man = m as Record<string, unknown>;
  if (man.seedFormatVersion !== SEED_FORMAT_VERSION) {
    errors.push(`seedFormatVersion must be ${SEED_FORMAT_VERSION} (got ${JSON.stringify(man.seedFormatVersion)})`);
  }
  if (typeof man.potId !== 'string' || man.potId.length === 0) errors.push('potId must be a non-empty string');
  if (!Number.isInteger(man.cutAtEpoch) || (man.cutAtEpoch as number) < 0) errors.push('cutAtEpoch must be a non-negative integer');
  if (typeof man.cutHlc !== 'string' || man.cutHlc.length === 0) errors.push('cutHlc must be a non-empty string');
  if (typeof man.cutTs !== 'number' || !Number.isFinite(man.cutTs)) errors.push('cutTs must be a finite number');
  if (!Array.isArray(man.stores) || man.stores.length === 0) {
    errors.push('stores must be a non-empty array');
  } else {
    man.stores.forEach((e, i) => validateEntry(e, i, errors));
  }
  return { ok: errors.length === 0, errors };
}

/** Deterministic, recursively key-sorted JSON — equal values stringify identically
 *  (so a manifest hash is stable regardless of key insertion order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    return Object.keys(src)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys(src[k]);
        return acc;
      }, {});
  }
  return v;
}

/** Serialize a manifest to canonical JSON. Throws {@link SeedManifestError} if invalid. */
export function encodeManifest(m: SeedManifest): string {
  const v = validateManifest(m);
  if (!v.ok) throw new SeedManifestError('cannot encode invalid manifest: ' + v.errors.join('; '));
  return canonicalJson(m);
}

/** Parse + validate a manifest. Throws {@link SeedManifestError} on bad JSON or shape. */
export function decodeManifest(s: string): SeedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    throw new SeedManifestError('manifest is not valid JSON: ' + (e as Error).message);
  }
  const v = validateManifest(parsed);
  if (!v.ok) throw new SeedManifestError('invalid manifest: ' + v.errors.join('; '));
  return parsed as SeedManifest;
}
