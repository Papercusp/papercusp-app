/**
 * deferred-git-restore — the POST-ADMISSION git-restore trigger (plan
 * hive-seed-bundle-2026-07-04 P-010 live-wire 2; design memo
 * agent-insights/hive-seed-bundle-design).
 *
 * THE ADMISSION-TIMING SPLIT, second half. restore-hive-seed.ts restores the
 * plaintext-container corestore seed BEFORE the join, but DEFERS an ENCRYPTED git
 * seed because its decryption key arrives only POST-ADMISSION. This module is what
 * runs AFTER the join has admitted this device and delivered the hive epoch keys:
 * it resolves the deferred git store's key and re-restores just that store, so the
 * repo checkout is pre-positioned and the subsequent code fetch carries only the
 * delta — the seed=BYTES / join=DELTA property for the code half too.
 *
 * KEY RESOLUTION reuses the epoch-key machinery that already works, rather than a
 * new delivery mechanism: a git seed sealed with `keyRef.via='epoch'` is decryptable
 * with the hive epoch key at `cutAtEpoch`, which a newly-admitted member is
 * GUARANTEED to hold (Q-4 / grantEpochKeysToMembers grants past-epoch keys [0..cur]).
 * The joiner already unwraps that key via the member-side EpochKeyProvider
 * (hive-epoch-key-provider.ts) — so this trigger just asks it for the key and, when
 * it's there, re-restores. The alternative `via='seed-key-op'` (a standalone
 * seed-key content op) has no delivery path yet — it resolves to null (stays
 * deferred) with a clear log, so a seed cut that way cold-paths its code half rather
 * than failing.
 *
 * FAIL-SOFT + IDEMPOTENT-SAFE like the pre-join restore: the key not being available
 * yet (a slow admission, a removed member) leaves the store deferred (the host
 * cold-clones the repo later / retries next boot); a resolve or restore failure
 * never throws. A single decryptable store is re-restored scoped to its kind
 * (onlyKinds) so the already-restored corestore is not re-copied.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeManifest, type SeedKeyRef, type SeedManifest } from '@papercusp/seed-bundle';
import type { EpochKeyProvider } from './hive-epoch-serving';
import { EpochKeyUnavailableError } from './hive-epoch-key-provider';
import { restoreHiveSeed, SEED_MANIFEST_FILE, type RestoreHiveSeedResult, type SeedLog } from './restore-hive-seed';

export interface ResolveSeedKeyDeps {
  /** The member-side epoch-key resolver (hive-epoch-boot-deps assembles the live
   *  one). Absent ⇒ a `via='epoch'` key cannot be resolved (⇒ stays deferred). */
  readonly epochKeyProvider?: EpochKeyProvider;
  readonly log?: SeedLog;
}

/**
 * Resolve an encrypted store's {@link SeedKeyRef} to the raw decryption key bytes,
 * or null when the key is not (yet) obtainable — in which case the store stays
 * deferred rather than failing.
 *
 *   - `via='epoch'`     → the hive epoch key at `keyRef.epoch`, via the member-side
 *     EpochKeyProvider. `EpochKeyUnavailableError` (not-yet-distributed / removed
 *     member) ⇒ null (defer). No provider wired ⇒ null.
 *   - `via='seed-key-op'` → not yet deliverable (no standalone seed-key content op
 *     exists); resolves to null with a log. `via='epoch'` is the shipping path.
 */
export async function resolveSeedDecryptionKey(
  keyRef: SeedKeyRef,
  deps: ResolveSeedKeyDeps = {},
): Promise<Uint8Array | null> {
  const log = deps.log ?? (() => {});
  if (keyRef.via === 'seed-key-op') {
    log(`[seed] git seed keyRef via='seed-key-op' has no post-admission delivery path yet — deferring (use via='epoch')`);
    return null;
  }
  // via === 'epoch'
  if (!deps.epochKeyProvider) {
    log(`[seed] no epoch-key provider available — cannot resolve the git seed key yet (deferring)`);
    return null;
  }
  try {
    const key = await deps.epochKeyProvider.keyForEpoch(keyRef.potId, keyRef.epoch);
    // EpochKey is a branded Uint8Array; hand back a plain view for the decrypt seam.
    return Uint8Array.from(key);
  } catch (e) {
    if (e instanceof EpochKeyUnavailableError) {
      log(`[seed] epoch ${keyRef.epoch} key not yet held on this device — git seed stays deferred (retry next boot)`);
      return null;
    }
    log(`[seed] git seed key resolution errored (deferring): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export interface TriggerDeferredGitRestoreCtx {
  /** The installed seed resource dir (holds manifest.json + per-store subdirs). */
  readonly seedDir: string;
  readonly targetRepoDir: string;
  readonly targetStoreDir: string;
  readonly originUrl?: string;
  /** The member-side epoch-key resolver (see resolveSeedDecryptionKey). */
  readonly epochKeyProvider?: EpochKeyProvider;
  /** Seams (tests inject; defaults are the real filesystem + restore). */
  readonly readManifest?: (seedDir: string) => Promise<SeedManifest | null>;
  readonly restore?: (ctx: Parameters<typeof restoreHiveSeed>[0]) => Promise<RestoreHiveSeedResult>;
  readonly log?: SeedLog;
}

export interface TriggerDeferredGitRestoreResult {
  /** True ⇒ a manifest was found + at least one encrypted store was considered. */
  readonly ran: boolean;
  /** Store kinds re-restored this pass (key resolved + restore ok). */
  readonly restored: readonly string[];
  /** Encrypted store kinds still awaiting a key (or whose restore failed). */
  readonly stillDeferred: readonly string[];
}

/** Default manifest reader (mirrors restore-hive-seed's) — null ⇒ nothing to do. */
async function defaultReadManifest(seedDir: string): Promise<SeedManifest | null> {
  try {
    return decodeManifest(await readFile(join(seedDir, SEED_MANIFEST_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * After admission, restore any ENCRYPTED seed store whose key is now resolvable.
 * Reads the manifest, resolves each encrypted store's keyRef → key, and re-restores
 * (scoped to that kind so the pre-join corestore is not re-copied). NEVER throws.
 * A store whose key is not yet available stays deferred (reported in stillDeferred).
 */
export async function triggerDeferredGitRestore(
  ctx: TriggerDeferredGitRestoreCtx,
): Promise<TriggerDeferredGitRestoreResult> {
  const log = ctx.log ?? (() => {});
  const readManifest = ctx.readManifest ?? defaultReadManifest;
  const restore = ctx.restore ?? restoreHiveSeed;

  const manifest = await readManifest(ctx.seedDir).catch(() => null);
  if (!manifest) return { ran: false, restored: [], stillDeferred: [] };

  const encrypted = manifest.stores.filter((s) => s.encryption);
  if (encrypted.length === 0) return { ran: false, restored: [], stillDeferred: [] };

  const restored: string[] = [];
  const stillDeferred: string[] = [];
  for (const entry of encrypted) {
    const key = await resolveSeedDecryptionKey(entry.encryption!.keyRef, {
      epochKeyProvider: ctx.epochKeyProvider,
      log,
    });
    if (!key) {
      stillDeferred.push(entry.kind);
      continue;
    }
    try {
      const res = await restore({
        seedDir: ctx.seedDir,
        targetRepoDir: ctx.targetRepoDir,
        targetStoreDir: ctx.targetStoreDir,
        decryptionKey: key,
        onlyKinds: [entry.kind],
        ...(ctx.originUrl ? { originUrl: ctx.originUrl } : {}),
        log,
      });
      const ok = res.ran && res.outcomes.some((o) => o.kind === entry.kind && o.ok);
      if (ok) {
        restored.push(entry.kind);
        log(`[seed] post-admission restore of ${entry.kind} store succeeded`);
      } else {
        stillDeferred.push(entry.kind);
        // Carry the per-store failure reason (WI-5179: it was dropped here, so the
        // packaged install's 'gave up after retries' had no visible cause).
        const reason = res.outcomes.find((o) => o.kind === entry.kind)?.reason;
        // WI-9413 severity: unlike the key-unavailable branch above (a legitimate
        // pre-admission state that retries next boot), reaching HERE means the key
        // RESOLVED and the restore still failed. There is no later retry that fixes
        // it on its own, so it is always a defect.
        log(
          `[seed] post-admission restore of ${entry.kind} store did not complete — cold-pathing${reason ? `: ${reason}` : ''}`,
          'error',
        );
      }
    } catch (e) {
      stillDeferred.push(entry.kind);
      log(
        `[seed] post-admission restore of ${entry.kind} threw (cold-pathing): ${e instanceof Error ? e.message : String(e)}`,
        'error',
      );
    }
  }
  return { ran: true, restored, stillDeferred };
}
