/**
 * bundled-epoch-key-provider — WI-3232 (owner "Full pot, plaintext seed"): an
 * {@link EpochKeyProvider} that resolves the hive epoch key OFFLINE from the seed's
 * bundled `epoch-keys.json` (emitted by `cut-seed-cli --emit-epoch-key`), so a FRESH
 * packaged install can decrypt the seed — the encrypted git bundles AND the
 * epoch-encrypted corestore content (POT_REKEY is default-ON) — with NO federation
 * join / admission. This is the v1 local-self-admit key source; federation (the
 * PG-wrapped member provider, hive-epoch-key-provider.ts) layers onto the SAME seam
 * for v2, so both paths are interchangeable.
 *
 * Ships the hive epoch key READABLE inside the installer — owner-authorised for alpha
 * (no users yet). Fail-closed by contract: a missing file / hive / epoch throws
 * {@link EpochKeyUnavailableError} (the same signal the member provider uses), so a
 * caller that ALSO wired the member provider degrades to it and a wrong/absent bundled
 * key never becomes a hard boot failure — it just defers, exactly like today.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EpochKey } from './hive-epoch-crypto';
import type { EpochKeyProvider } from './hive-epoch-serving';
import { EpochKeyUnavailableError } from './hive-epoch-key-provider';

/** The bundled epoch-key file inside the seed dir (name matches cut-seed-cli's
 *  EPOCH_KEYS_FILE). Shape: { "<hive>": { "<epoch>": "<base64 32-byte key>" } }. */
export const SEED_EPOCH_KEYS_FILE = 'epoch-keys.json';

/** { hive: { epoch: base64(key) } } — the on-disk shape of epoch-keys.json. */
type EpochKeysDoc = Record<string, Record<string, string>>;

export interface BundledEpochKeyDeps {
  /** Injected for tests; defaults to the real filesystem read. */
  readonly readFileImpl?: (path: string) => Promise<string>;
}

/**
 * Build an {@link EpochKeyProvider} backed by `<seedDir>/epoch-keys.json`. The doc is
 * read + parsed ONCE (cached across calls, including the not-found result). Every
 * failure mode — no file, bad JSON, unknown hive/epoch, wrong key length — surfaces as
 * {@link EpochKeyUnavailableError} so the caller defers/falls back rather than crashing.
 */
export function createBundledEpochKeyProvider(
  seedDir: string,
  deps: BundledEpochKeyDeps = {},
): EpochKeyProvider {
  const readFileImpl = deps.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
  let docPromise: Promise<EpochKeysDoc | null> | undefined;
  const loadDoc = (): Promise<EpochKeysDoc | null> => {
    if (!docPromise) {
      docPromise = readFileImpl(join(seedDir, SEED_EPOCH_KEYS_FILE))
        .then((raw) => {
          const parsed = JSON.parse(raw) as unknown;
          return parsed && typeof parsed === 'object' ? (parsed as EpochKeysDoc) : null;
        })
        .catch(() => null); // no file / unreadable / bad JSON ⇒ no bundled keys (defer)
    }
    return docPromise;
  };
  return {
    async keyForEpoch(potId: string, epoch: number): Promise<EpochKey> {
      const doc = await loadDoc();
      const b64 = doc?.[potId]?.[String(epoch)];
      if (typeof b64 !== 'string' || !b64) throw new EpochKeyUnavailableError(potId, epoch);
      const key = Uint8Array.from(Buffer.from(b64, 'base64'));
      // A truncated/garbage key is worse than none — fail closed so a caller with the
      // member provider falls back instead of decrypting with a bad key.
      if (key.length !== 32) throw new EpochKeyUnavailableError(potId, epoch);
      return key as EpochKey;
    },
  };
}
