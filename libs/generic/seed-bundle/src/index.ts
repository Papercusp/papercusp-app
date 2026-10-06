/**
 * @papercusp/seed-bundle — a generic checkpoint-a-replicated-store primitive.
 *
 * Ship a CHECKPOINT of one or more replicated stores (a git repo, a hypercore
 * corestore, …) ahead of a live sync so a fresh host pre-positions the bytes and
 * the UNMODIFIED sync/join protocol then transfers only the DELTA on top. The
 * seed bootstraps BYTES; the live protocol bootstraps TRUST — every store
 * re-verifies natively, and any missing/corrupt/unverifiable seed degrades to
 * the plain cold path.
 *
 * This package is pure data + orchestration: a self-describing {@link SeedManifest},
 * a {@link SeedProviderRegistry} of host-supplied substrate adapters, and the
 * {@link restoreSeed} "restore-before-join" step. The git/hypercore specifics live
 * in host-side {@link SeedProvider}s — the injection seam.
 *
 * First consumer: the Papercusp dogfood installer (plan hive-seed-bundle-2026-07-04;
 * design memo agent-insights/hive-seed-bundle-design).
 */

export {
  SEED_FORMAT_VERSION,
  SeedManifestError,
  validateManifest,
  encodeManifest,
  decodeManifest,
  canonicalJson,
  type SeedManifest,
  type SeedStoreEntry,
  type SeedSource,
  type SeedKeyRef,
  type SeedEncryptionEnvelope,
  type ManifestValidation,
} from './manifest';

export {
  SeedProviderRegistry,
  type SeedProvider,
  type SeedPayload,
  type SeedCutContext,
  type SeedCutOutput,
  type SeedRestoreContext,
  type VerifyResult,
} from './registry';

export {
  restoreSeed,
  type RestoreResult,
  type StoreRestoreOutcome,
  type SeedPayloadResolver,
} from './restore';

export {
  SEED_CIPHER,
  SEED_KEY_LEN,
  SeedCryptoError,
  generateSeedKey,
  sealBytes,
  openBytes,
  sealFile,
  openFile,
  keysEqual,
} from './crypto';
