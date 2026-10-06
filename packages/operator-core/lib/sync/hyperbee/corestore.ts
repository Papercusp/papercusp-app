/**
 * Per-harness Corestore factory.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-030.
 * v5 §7.1 — Hyperbee storage layout.
 *
 * Each harness gets its own Corestore at
 * `<workspaceRoot>/.papercusp/<harness>/hyperbee/`. Stores are
 * created lazily on first access + cached in a process-local map so
 * subsequent harness opens reuse the same store.
 *
 * Cleanup: callers explicitly close stores via `closeHarnessStore`
 * on harness-remove (rare); the process exit handler closes any
 * stale stores.
 */

import Corestore from 'corestore';
import { mkdir, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { join } from 'node:path';
import { readProcessIdentity } from '../../process-identity';
import { processMonotonicClock } from '../../process-monotonic-clock';
import { forgetStore, registerStoreMachine } from './remote-core-host';
import { healRelocatedDeviceFileAndLog } from './device-file-heal';

const stores = new Map<string, Promise<Corestore>>();
const storeLocks = new Map<string, HarnessStoreLock>();

/** Observational only: subscribe through Node's existing diagnostic transport.
 * A timeout needs the last started stage, not just a later boot_fail message. */
export const CORESTORE_OPEN_CHANNEL = 'papercusp.corestore.open';
export interface CorestoreOpenObservation {
  workspaceRoot: string;
  harnessSlug: string;
  stage: 'directory' | 'lock' | 'device-heal' | 'native-ready' | 'ready';
  outcome: 'started' | 'succeeded' | 'failed';
  atMs: number;
  elapsedMs: number;
}
const corestoreOpenChannel = channel(CORESTORE_OPEN_CHANNEL);

interface HarnessStoreLock {
  release(): Promise<void>;
}

interface HarnessStoreLockHolder {
  pid?: number;
  token?: string;
  /** Kernel-backed process incarnation. Absent on locks written before EI-218488. */
  processIdentity?: string | null;
  startedAt?: string;
}

const LEGACY_LOCK_START_TOLERANCE_MS = 2_000;

export interface HarnessStoreOpts {
  /** Workspace root — typically resolved from `getWorkspaceRoot()`. */
  workspaceRoot: string;
  /** Harness slug (already validated by the caller). */
  harnessSlug: string;
}

function storagePath(opts: HarnessStoreOpts): string {
  // Mirror the existing per-harness layout under .papercusp/<slug>/.
  return join(opts.workspaceRoot, '.papercusp', opts.harnessSlug, 'hyperbee');
}

/**
 * P-006 §5.1/§5.3: the SCOPED store lives in a SEPARATE Corestore at a sibling
 * path (`hyperbee-scoped/`), NOT a `.namespace()` of the main store. This is
 * load-bearing for the fail-closed serve gate: `store.replicate(socket)` serves
 * every core in ITS OWN `this.cores`/storage via the lazy `ondiscoverykey`
 * path, so a scoped core sharing the main store would be served to any peer
 * that knows its key (fail-OPEN). A distinct instance keeps scoped cores out of
 * the main store's replicate scope entirely — they are served ONLY by the
 * explicit per-core×connection attach in scope-cores.ts. This store is NEVER
 * `.replicate()`d.
 */
function scopedStoragePath(opts: HarnessStoreOpts): string {
  return join(opts.workspaceRoot, '.papercusp', opts.harnessSlug, 'hyperbee-scoped');
}

function cacheKey(opts: HarnessStoreOpts): string {
  return `${opts.workspaceRoot}::${opts.harnessSlug}`;
}

/**
 * Block cache size (in blocks) for each per-harness Corestore.
 *
 * P-005 (bg-host-freeze-eventloop-stall-2026-06-30): the DEFAULT Corestore
 * block cache is 16 384 blocks per store. With 25+ harnesses each holding
 * multiple Hypercores, the theoretical in-process RSS ceiling from block data
 * alone is tens of GB (blocks are typically 32–64 KB each). Reducing the cache
 * to 256 blocks (≈8–16 MB per store, ≈200–400 MB across 25 harnesses) bounds
 * the growth while still giving the per-harness merge loop a warm L1 for its
 * sequential append reads. Override via PAPERCUSP_CORESTORE_CACHE_BLOCKS.
 *
 * If the env-override is ≤0 or non-finite, falls back to the 256 default (no
 * footgun where CACHE=0 disables caching and hammers disk on every read).
 */
const DEFAULT_CORESTORE_CACHE_BLOCKS = 256;
// ⚠ VERIFIED INERT on the CURRENT corestore/hypercore (2026-07-01, WI-1088 hunt): this
// version's ctor consumes only `globalCache` (a Rache INSTANCE; corestore index.js:252,
// hypercore lib/core.js:48 — default null ⇒ NO block cache at all), so the `{ cache: N }`
// option below is silently ignored and the 16 384-block-default premise above is FALSE
// for this version. Kept for a future corestore that re-adds the option; do NOT count on
// it bounding anything today.
function resolveCacheBlocks(): number {
  const env = Number(process.env.PAPERCUSP_CORESTORE_CACHE_BLOCKS);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return DEFAULT_CORESTORE_CACHE_BLOCKS;
}

/**
 * P-003 (own-log-fork-guard, WI-3535): the supported own-log-fork recovery is
 * a per-harness STORE RESET (delete this directory so Corestore lazily mints
 * a fresh keypair on next open) — exported so own-log-fork-recovery.ts (and
 * anything else that needs to name/verify the on-disk path) doesn't have to
 * re-derive the `.papercusp/<slug>/hyperbee` layout by hand.
 */
export function harnessStorePath(opts: HarnessStoreOpts): string {
  return storagePath(opts);
}

/** The advisory lock held while the writable harness Corestore is open. */
export function harnessStoreLockPath(opts: HarnessStoreOpts): string {
  return `${storagePath(opts)}.single-instance.lock`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by this user.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * A durable PID is only an address in the process table, not an identity. On
 * long-lived desktop rigs macOS routinely reuses a crashed operator's PID for
 * an unrelated process; treating `kill(pid, 0)` as proof of ownership then
 * strands every harness Corestore behind the stale lock forever.
 *
 * Fail closed for legacy locks (no process identity) and unreadable process
 * identity: only a dead PID or a positively mismatched incarnation is stale.
 */
function lockHolderIsProvablyStale(
  holder: HarnessStoreLockHolder,
  deps: {
    isAlive?: (pid: number) => boolean;
    readIdentity?: (pid: number) => string | null;
  } = {},
): boolean {
  if (!Number.isInteger(holder.pid) || holder.pid! <= 0) return false;
  const isAlive = deps.isAlive ?? processIsAlive;
  if (!isAlive(holder.pid!)) return true;

  if (typeof holder.processIdentity !== 'string' || holder.processIdentity.length === 0) {
    // Locks written before processIdentity was introduced still carry an ISO
    // `startedAt`. On macOS, compare that timestamp with `ps lstart` from the
    // currently live PID. This is the only safe way to recover the legacy
    // locks already stranded on upgraded rigs; an age-only heuristic would
    // eventually delete a genuinely long-lived owner's lock.
    if (typeof holder.startedAt !== 'string' || holder.startedAt.trim() === '') return false;
    const currentIdentity = (deps.readIdentity ?? readProcessIdentity)(holder.pid!);
    if (!currentIdentity || !currentIdentity.startsWith('darwin:')) return false;
    const recordedMs = Date.parse(holder.startedAt);
    const currentMs = Date.parse(currentIdentity.slice('darwin:'.length));
    return (
      Number.isFinite(recordedMs) &&
      Number.isFinite(currentMs) &&
      Math.abs(recordedMs - currentMs) > LEGACY_LOCK_START_TOLERANCE_MS
    );
  }
  const currentIdentity = (deps.readIdentity ?? readProcessIdentity)(holder.pid!);
  return currentIdentity !== null && currentIdentity !== holder.processIdentity;
}

async function releaseLockFile(
  handle: FileHandle,
  lockPath: string,
  token: string,
): Promise<void> {
  try {
    const contents = await readFile(lockPath, 'utf8');
    if (contents.includes(token)) await unlink(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  } finally {
    await handle.close();
  }
}

async function acquireHarnessStoreLock(
  opts: HarnessStoreOpts,
): Promise<HarnessStoreLock> {
  const lockPath = harnessStoreLockPath(opts);

  // O_EXCL gives us an atomic cross-process claim without depending on a
  // platform-specific flock executable. The PID makes a lock left by a crash
  // recoverable while still refusing a live duplicate loudly.
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;

      let holder: HarnessStoreLockHolder;
      try {
        holder = JSON.parse(await readFile(lockPath, 'utf8')) as typeof holder;
      } catch {
        throw new Error(
          `Harness Corestore lock is busy or corrupt: ${lockPath}. ` +
            'Stop the duplicate operator process and remove the lock only after verifying no owner is running.',
        );
      }

      if (!lockHolderIsProvablyStale(holder)) {
        throw new Error(
          `Harness Corestore is already open by process ${holder.pid ?? 'unknown'} ` +
            `(lock: ${lockPath}). Stop the duplicate operator/sidecar process before retrying.`,
        );
      }

      // Atomically move the stale lock out of the well-known path before
      // removing it. This prevents a concurrent opener from creating a fresh
      // lock and then having that new owner's lock unlinked by our cleanup.
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, stalePath);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
        continue;
      }
      await unlink(stalePath).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      });
      continue;
    }

    const token = randomUUID();
    try {
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          token,
          processIdentity: readProcessIdentity(process.pid),
          startedAt: new Date().toISOString(),
        }),
        'utf8',
      );
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
      throw error;
    }

    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        await releaseLockFile(handle, lockPath, token);
      },
    };
  }
}

export async function getHarnessStore(opts: HarnessStoreOpts): Promise<Corestore> {
  const key = cacheKey(opts);
  const cached = stores.get(key);
  if (cached) return cached;

  const path = storagePath(opts);
  const startedAt = processMonotonicClock.now();
  let stage: CorestoreOpenObservation['stage'] = 'directory';
  const observe = (next: CorestoreOpenObservation['stage'], outcome: CorestoreOpenObservation['outcome'] = 'started') => {
    stage = next;
    if (!corestoreOpenChannel.hasSubscribers) return;
    const atMs = processMonotonicClock.now();
    corestoreOpenChannel.publish({
      workspaceRoot: opts.workspaceRoot, harnessSlug: opts.harnessSlug,
      stage, outcome, atMs, elapsedMs: atMs - startedAt,
    } satisfies CorestoreOpenObservation);
  };
  const pending = (async () => {
    observe('directory');
    await mkdir(path, { recursive: true });
    observe('lock');
    const lock = await acquireHarnessStoreLock(opts);
    storeLocks.set(key, lock);
    try {
      // A store directory relocated with its metadata intact keeps its
      // device-file xattr but changes inode, which bricks every later open with
      // "Invalid device file, was modified". No-op unless that exact fault is
      // present. Must run while we hold the lock and before the open.
      observe('device-heal');
      await healRelocatedDeviceFileAndLog(path, cacheKey(opts));
      const store = new Corestore(path, { cache: resolveCacheBlocks() });
      observe('native-ready');
      await store.ready();
      observe('ready', 'succeeded');
      // WI-5673: declare which MACHINE this store belongs to so remote peer
      // logs are opened in exactly ONE store per machine. Sibling harnesses in
      // the same Hive admit the same keys, and a Protomux carries at most one
      // hypercore/alpha channel per discovery key — two local replicas of one
      // key on a shared peer socket means one of them replicates and the other
      // starves forever. See remote-core-host.ts.
      registerStoreMachine(store, opts.workspaceRoot);
      return store;
    } catch (error) {
      storeLocks.delete(key);
      await lock.release();
      throw error;
    }
  })();
  stores.set(key, pending);
  // Keep the failed stage visible even when directory creation or lock
  // acquisition fails before the native-open try/catch is reached.
  void pending.catch(() => { observe(stage, 'failed'); });
  // EI-20584279536840151: evict a REJECTED open so the next caller genuinely
  // retries. Without this the rejected promise stays cached and every later
  // `getHarnessStore` re-returns the SAME rejection, so the substrate can never
  // recover from a transient or since-repaired fault without a process restart —
  // observed on the macOS rig as a boot_fail repeating byte-identically every
  // ~10min for hours AFTER the on-disk cause had been fixed. Attached after the
  // `set` so a concurrent caller still shares this in-flight attempt, and it
  // deletes only its own entry so a later successful open is never evicted.
  void pending.catch(() => {
    if (stores.get(key) === pending) stores.delete(key);
  });
  return pending;
}

export async function closeHarnessStore(opts: HarnessStoreOpts): Promise<void> {
  const key = cacheKey(opts);
  const cached = stores.get(key);
  if (!cached) return;
  stores.delete(key);
  const store = await cached;
  // WI-5673: stop hosting this store's admitted remote logs BEFORE the close,
  // so a sibling that opens one of those keys next re-homes it onto a live
  // store instead of getting a session on a dead one.
  forgetStore(store);
  try {
    await store.close();
  } finally {
    const lock = storeLocks.get(key);
    storeLocks.delete(key);
    await lock?.release();
  }
}

const scopedStores = new Map<string, Promise<Corestore>>();

/**
 * The per-harness SCOPED Corestore (P-006 §5.1) — a distinct instance from
 * {@link getHarnessStore}, lazily created + cached, NEVER `.replicate()`d. See
 * {@link scopedStoragePath} for why this must not be a namespace of the main
 * store.
 */
export async function getHarnessScopedStore(opts: HarnessStoreOpts): Promise<Corestore> {
  const key = cacheKey(opts);
  const cached = scopedStores.get(key);
  if (cached) return cached;
  const path = scopedStoragePath(opts);
  const pending = (async () => {
    await mkdir(path, { recursive: true });
    // Same relocation fault as getHarnessStore — the scoped store sits in a
    // sibling directory and was found equally bricked on the macOS rig.
    await healRelocatedDeviceFileAndLog(path, `${cacheKey(opts)} (scoped)`);
    const store = new Corestore(path, { cache: resolveCacheBlocks() });
    await store.ready();
    return store;
  })();
  scopedStores.set(key, pending);
  // Same poisoned-cache eviction as getHarnessStore — see the note there.
  void pending.catch(() => {
    if (scopedStores.get(key) === pending) scopedStores.delete(key);
  });
  return pending;
}

export async function closeHarnessScopedStore(opts: HarnessStoreOpts): Promise<void> {
  const key = cacheKey(opts);
  const cached = scopedStores.get(key);
  if (!cached) return;
  scopedStores.delete(key);
  const store = await cached;
  await store.close();
}

/** For tests: forget all cached stores without closing them. */
export function _resetCacheForTests(): void {
  stores.clear();
  scopedStores.clear();
}

/**
 * Test seam: read the current resolved cache-block count (respects
 * PAPERCUSP_CORESTORE_CACHE_BLOCKS). Exported only for the recurrence-guard
 * test in corestore-cache.test.ts — never call from production code.
 */
export function _resolveCorestoreCacheBlocksForTests(): number {
  return resolveCacheBlocks();
}

/** Test seam: read the default block cache constant. */
export const _DEFAULT_CORESTORE_CACHE_BLOCKS_FOR_TESTS = DEFAULT_CORESTORE_CACHE_BLOCKS;

/** Test seam for the PID-reuse safety boundary above. */
export const _lockHolderIsProvablyStaleForTests = lockHolderIsProvablyStale;
