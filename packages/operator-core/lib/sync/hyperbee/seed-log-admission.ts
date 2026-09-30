/**
 * seed-log-admission — WI-3288 (the offline "full pot"): resolve the SEED's author-log
 * core keys so boot can ADMIT them into the read-merge WITHOUT a swarm.
 *
 * Why this exists: boot.ts's admitted-set gains logs in exactly two ways — the own log
 * (structural) and swarm announce frames (runtime). A packaged install that cannot join
 * the swarm (fresh offline box, `gh` unauthenticated → `swarm_join_failed` forever)
 * therefore merges NOTHING: the WI-3232 seed restore faithfully replicates the hive's
 * cores into the local store, but no admission ever names them, so the read-merge reads
 * only the own (empty) log and every projection stays empty — the owner-reported
 * "pot visible but empty" Windows VM state.
 *
 * Trust anchor: the installer-shipped seed manifest. The seed already ships the hive
 * EPOCH KEY readable (bundled-epoch-key-provider.ts, owner-authorised for alpha), so the
 * content-trust decision for everything the manifest names was made at cut time; the
 * hash-verified manifest's `coreKeys` list is the same authority. Admission is gated on
 * `manifest.potId === <this boot's hive home>` so a seed never leaks logs into an
 * unrelated hive/harness boot.
 *
 * Member-content note (why admission alone suffices for the dogfood pot): the WI-259
 * member-content guard's own-slug fast path (`rowHarnessSlug === opts.harnessSlug` →
 * 'apply', member-content-guard.ts:73) means hive-home content applies with NO
 * source-log identity; only CROSS-member-slug ops would need `admittedIdentities`
 * entries, which announce frames supply online. A seed-admitted log without an
 * identity entry degrades exactly to the online no-announce behavior (defer/drop of
 * cross-member ops), never worse.
 *
 * Fail-soft by contract: any missing/unreadable/mismatched manifest resolves to []
 * (a boot must never fail because a seed is absent — that IS the common cold path).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeManifest } from '@papercusp/seed-bundle';
import { resolveSeedDir, SEED_MANIFEST_FILE } from './restore-hive-seed';

/** 32-byte hypercore key as hex — the shape of manifest `meta.coreKeys` entries. */
const CORE_KEY_HEX = /^[0-9a-f]{64}$/i;

export interface ResolveSeedLogKeysOpts {
  /** The hive home this boot is peered on; admission requires manifest.potId to match. */
  readonly potHomeSlug: string;
  /** Injected for tests; defaults to the real filesystem read. */
  readonly readFileImpl?: (path: string) => Promise<string>;
  /** Injected for tests; defaults to the real env-based seed-dir resolution. */
  readonly resolveSeedDirImpl?: () => { seedDir: string | null; disabled: boolean };
}

/**
 * Provenance carried from the corestore seed manifest for one admitted log.
 *
 * `coreKeys` alone is not enough to establish that a log belongs to this boot:
 * a stale/incorrect seed directory can name a perfectly well-formed key while
 * the restored target core has no blocks at all.  The cutter already records
 * the authenticated writer high-water (`coreLengths`) and, for sparse cuts,
 * the first block actually shipped (`coreSparseFrom`).  Keep those values
 * attached to the key so boot can validate the local replica before adding it
 * to the read-merge.
 */
export interface SeedLogAdmission {
  /** 64-character lowercase hypercore key. */
  readonly keyHex: string;
  /** Writer length recorded by the seed cutter. */
  readonly expectedLength: number;
  /** First block the payload promises to carry (0 for a full seed). */
  readonly shippedFrom: number;
  /** Seed directory selected for this manifest (diagnostic provenance). */
  readonly seedDir: string;
}

/** Minimal local-replica view used by the boot admission guard. */
export interface SeedReplicaForAdmission {
  readonly keyHex: string;
  readonly length: number;
  readonly contiguousLength?: number;
  /** Async, as Hypercore 11's `has` is (WI-10003092: a sync read of it is always truthy). */
  has?(index: number): Promise<boolean>;
  close?(): Promise<void>;
}

interface CorestoreSeedMetaForAdmission {
  readonly coreKeys?: unknown;
  readonly coreLengths?: unknown;
  readonly coreSparseFrom?: unknown;
}

function numberRecord(value: unknown): Record<string, number> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null;
    out[key.toLowerCase()] = raw;
  }
  return out;
}

/**
 * Resolve manifest log keys together with the length/range claims boot must
 * verify against the restored local replica.  Invalid or incomplete metadata
 * is rejected as a whole: admitting a key without a trustworthy high-water
 * would recreate the stale seed-only admission bug this seam exists to stop.
 */
export async function resolveSeedLogAdmissions(
  opts: ResolveSeedLogKeysOpts,
): Promise<SeedLogAdmission[]> {
  try {
    const resolved = (opts.resolveSeedDirImpl ?? resolveSeedDir)();
    if (resolved.disabled || !resolved.seedDir) return [];
    const readFileImpl = opts.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
    const raw = await readFileImpl(join(resolved.seedDir, SEED_MANIFEST_FILE));
    const manifest = decodeManifest(raw); // throws on structural invalidity → catch → []
    if (manifest.potId !== opts.potHomeSlug) return [];
    const entry = manifest.stores.find((s) => s.kind === 'corestore');
    const meta = (entry?.meta ?? undefined) as CorestoreSeedMetaForAdmission | undefined;
    const keys = meta?.coreKeys;
    const lengths = numberRecord(meta?.coreLengths);
    if (!Array.isArray(keys) || !lengths) return [];
    const sparseFrom =
      meta?.coreSparseFrom === undefined ? {} : numberRecord(meta.coreSparseFrom);
    if (!sparseFrom) return [];
    const seen = new Set<string>();
    const admissions: SeedLogAdmission[] = [];
    for (const rawKey of keys) {
      if (typeof rawKey !== 'string' || !CORE_KEY_HEX.test(rawKey)) continue;
      const keyHex = rawKey.toLowerCase();
      if (seen.has(keyHex)) continue;
      seen.add(keyHex);
      const expectedLength = lengths[keyHex];
      const shippedFrom = sparseFrom[keyHex] ?? 0;
      // A key without a cutter high-water, or a sparse range outside that
      // high-water, is not provenance we can safely act on.  Cold/live swarm
      // admission remains available for the key instead.
      if (
        expectedLength === undefined ||
        !Number.isInteger(expectedLength) ||
        expectedLength <= 0 ||
        !Number.isInteger(shippedFrom) ||
        shippedFrom < 0 ||
        shippedFrom >= expectedLength
      ) {
        continue;
      }
      admissions.push({ keyHex, expectedLength, shippedFrom, seedDir: resolved.seedDir });
    }
    return admissions;
  } catch {
    return []; // no seed / bad seed ⇒ the cold path, never a boot failure
  }
}

/**
 * Check that a seed-advertised log is actually present in the local target
 * core before boot admits it.  Hypercore can expose a writer length from a
 * copied header even when none of the data blocks were restored; checking only
 * `length` therefore reproduces the 84f7 zero-byte admission failure.  The
 * first and last shipped blocks are cheap O(1) bitfield checks and catch that
 * stale/empty target while allowing sparse seeds whose prefix is intentionally
 * absent.  A replica without either a block probe or a complete contiguous
 * prefix is rejected rather than guessed usable.
 */
export async function validateSeedReplicaForAdmission(
  replica: SeedReplicaForAdmission,
  admission: SeedLogAdmission,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (replica.keyHex.toLowerCase() !== admission.keyHex) {
    return { ok: false, reason: 'replica key does not match manifest key' };
  }
  if (!Number.isInteger(replica.length) || replica.length < admission.expectedLength) {
    return {
      ok: false,
      reason: `local length ${String(replica.length)} is below manifest length ${admission.expectedLength}`,
    };
  }

  const last = admission.expectedLength - 1;
  try {
    if (typeof replica.has === 'function') {
      if (!(await replica.has(admission.shippedFrom))) {
        return {
          ok: false,
          reason: `shipped start block ${admission.shippedFrom} is not present locally`,
        };
      }
      if (!(await replica.has(last))) {
        return { ok: false, reason: `shipped tail block ${last} is not present locally` };
      }
      return { ok: true };
    }
  } catch (error) {
    return {
      ok: false,
      reason: `local block-presence probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // A full seed can be proven by a contiguous local prefix.  Sparse seeds
  // deliberately omit that prefix, so accepting one without `has()` would
  // silently turn an unverified manifest claim into an admission.
  if (admission.shippedFrom === 0 && (replica.contiguousLength ?? 0) >= admission.expectedLength) {
    return { ok: true };
  }
  return { ok: false, reason: 'replica exposes no usable local block-presence proof' };
}

/**
 * The seed's author-log core keys (lowercased hex), or [] when there is no applicable
 * seed: no seed dir, seed disabled, unreadable/invalid manifest, hive mismatch, or a
 * manifest without a corestore entry. Malformed key entries are dropped individually
 * (a partial list still merges the well-formed logs).
 */
export async function resolveSeedLogKeys(opts: ResolveSeedLogKeysOpts): Promise<string[]> {
  return (await resolveSeedLogAdmissions(opts)).map((admission) => admission.keyHex);
}
