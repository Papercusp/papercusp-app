/**
 * WebKit localStorage WAL checkpoint guard (WI-4189 follow-on).
 *
 * The 2026-07-11 root-disk-100% incident (WI-4189) found its single dominant
 * leak was NOT any of the app's own on-disk stores — it was the Tauri desktop
 * webview's WebKit `localStorage` backing store: a ~5MB *logical* database
 * carrying a ~34GB WAL file, because a long-lived `WebKitNetworkProcess` reader
 * pins an old snapshot indefinitely and nothing ever checkpoints the WAL back
 * down (SQLite in WAL mode only ever APPENDS new frames; only an explicit
 * `wal_checkpoint` reclaims them, and nothing in this codebase ever ran one).
 * The manual mitigation that day confirmed a `TRUNCATE`-mode checkpoint
 * reclaims the overwhelming majority of frames even while WebKit still holds a
 * read mark (8.69M of 8.82M frames that time) — this module is the durable,
 * unattended version of that one-off fix: a periodic, best-effort checkpoint
 * of every localStorage WAL file that has grown past a size floor.
 *
 * Safety model:
 *   - `TRUNCATE` checkpoint mode is the SQLite-documented non-destructive,
 *     best-effort operation: it commits every frame it CAN without waiting on
 *     a stubborn reader, reports `{ busy, log, checkpointed }`, and simply
 *     leaves the WAL file at its current size when it can't fully drain (never
 *     corrupts, never blocks indefinitely, never throws on contention — see
 *     `checkpointOne`'s doc for the exact SQLite semantics this relies on).
 *   - We only ever open a db file we DISCOVERED via its paired `-wal` file on
 *     disk (`discoverWalCandidates`) — `checkpointOne` never opens a path that
 *     doesn't already exist, so this can never silently CREATE a phantom
 *     sqlite file (`node:sqlite`'s `DatabaseSync` does that by default on a
 *     missing path, so the existence check is load-bearing, not decorative).
 *   - Read-only discovery + best-effort checkpoint only — this module never
 *     deletes anything; the WAL file's own DB engine reclaims the space when
 *     a checkpoint succeeds. Every public entry point is fail-soft (a single
 *     bad candidate never sinks the sweep).
 *
 * Server-only (node:sqlite; the desktop webview's data lives in the local
 * user's home dir, which only makes sense to inspect from the same host).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** A discovered `*.localstorage-wal` file, paired with its main db. */
export interface WalCandidate {
  /** the `*.localstorage-wal` file itself. */
  walPath: string;
  /** the paired main db (walPath with the `-wal` suffix stripped). */
  dbPath: string;
  /** current size of `walPath` in bytes. */
  sizeBytes: number;
}

/** Checkpoint any WAL that has grown past this floor. 200MB is well above any
 *  healthy localStorage's normal WAL churn but far below the point where an
 *  unbounded leak becomes a disk emergency (the incident's WAL was ~34GB). */
export const DEFAULT_WAL_CHECKPOINT_THRESHOLD_BYTES = 200 * 1024 * 1024;

/**
 * Pure filter + priority order — unit-testable without touching a filesystem.
 * Largest-first so a single sweep reclaims the most space first if it is ever
 * time-bounded.
 */
export function planWalCheckpoints(
  candidates: WalCandidate[],
  thresholdBytes: number = DEFAULT_WAL_CHECKPOINT_THRESHOLD_BYTES,
): WalCandidate[] {
  return candidates
    .filter((c) => c.sizeBytes >= thresholdBytes)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/**
 * Known Linux XDG roots that host this app's WebKit-backed localStorage (every
 * `localstorage` subdir of a `~/.local/share/com.papercusp.<bundle-id>` dir —
 * globbed by prefix rather than a hardcoded single bundle id, since the GUI/server bundles carry
 * distinct identifiers — `com.papercusp.gui` today — and old build dirs from a
 * prior identifier can still be sitting on disk). Best-effort: a missing dir is
 * skipped, never an error. No-op (empty result) on a non-Linux host — WebKit2
 * GTK's XDG layout is Linux-specific; macOS/Windows equivalents are future
 * work if this host ever runs the desktop app there.
 */
export function defaultLocalstorageRoots(): string[] {
  if (platform() !== 'linux') return [];
  const shareDir = join(homedir(), '.local', 'share');
  if (!existsSync(shareDir)) return [];
  let names: string[];
  try {
    names = readdirSync(shareDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith('com.papercusp.'))
    .map((n) => join(shareDir, n, 'localstorage'))
    .filter((p) => existsSync(p));
}

/**
 * Discover `*.localstorage-wal` files under the given roots (default: {@link
 * defaultLocalstorageRoots}). Real fs, best-effort — an unreadable root or a
 * raced-away file is skipped, never thrown.
 */
export function discoverWalCandidates(roots: string[] = defaultLocalstorageRoots()): WalCandidate[] {
  const out: WalCandidate[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.localstorage-wal')) continue;
      const walPath = join(root, name);
      try {
        const st = statSync(walPath);
        if (!st.isFile()) continue;
        out.push({
          walPath,
          dbPath: join(root, name.slice(0, -'-wal'.length)),
          sizeBytes: st.size,
        });
      } catch {
        continue; // raced removal between readdir and stat
      }
    }
  }
  return out;
}

export interface WalCheckpointOutcome {
  dbPath: string;
  ok: boolean;
  /** raw `wal_checkpoint` result row when the pragma ran (absent on an open failure). */
  busy?: boolean;
  framesInWal?: number;
  framesCheckpointed?: number;
  walBytesBefore: number;
  walBytesAfter: number;
  error?: string;
}

function walSizeOf(dbPath: string): number {
  const walPath = `${dbPath}-wal`;
  try {
    return existsSync(walPath) ? statSync(walPath).size : 0;
  } catch {
    return 0;
  }
}

/**
 * Best-effort `TRUNCATE`-mode checkpoint of one localStorage db. Per the
 * SQLite WAL docs, `TRUNCATE` (like `RESTART`) checkpoints every frame it can
 * WITHOUT waiting on a reader holding an older snapshot — it commits what it
 * can, reports `busy` when it couldn't drain everything, and only truncates
 * the WAL file to zero bytes when the drain was complete. It briefly waits
 * only on another WRITER's in-flight transaction (never a reader), so this is
 * safe to run unattended against a db the live desktop app may have open: it
 * can degrade to "checkpointed nothing" under contention, but it cannot
 * corrupt the store or block indefinitely (verified empirically — see the
 * accompanying test for both the clean-checkpoint and stubborn-reader cases).
 *
 * `dbPath` MUST already exist on disk — this never opens (and so never
 * `node:sqlite`-creates) a path it hasn't verified. Never throws.
 */
export function checkpointOne(dbPath: string): WalCheckpointOutcome {
  const before = walSizeOf(dbPath);
  if (!existsSync(dbPath)) {
    return { dbPath, ok: false, walBytesBefore: before, walBytesAfter: before, error: 'db_file_missing' };
  }
  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(dbPath);
    const rows = db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').all() as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const row = rows[0];
    return {
      dbPath,
      ok: true,
      busy: row ? row.busy !== 0 : undefined,
      framesInWal: row?.log,
      framesCheckpointed: row?.checkpointed,
      walBytesBefore: before,
      walBytesAfter: walSizeOf(dbPath),
    };
  } catch (err) {
    return {
      dbPath,
      ok: false,
      walBytesBefore: before,
      walBytesAfter: walSizeOf(dbPath),
      error: (err as Error)?.message ?? String(err),
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
  }
}

export interface WalGuardSweepResult {
  /** total WAL files discovered under the watched roots. */
  checked: number;
  /** of those, how many exceeded the threshold and were attempted. */
  overThreshold: number;
  /** how many attempts opened + ran the checkpoint pragma without error (may
   *  still have reclaimed 0 bytes if a reader held everything pinned). */
  checkpointed: number;
  /** total bytes the WAL files shrank by across all attempts. */
  bytesReclaimed: number;
  errors: Array<{ dbPath: string; error: string }>;
}

/**
 * Full sweep: discover → filter by threshold → checkpoint each, largest
 * first. Synchronous (each checkpoint is a fast local fs+sqlite call) and
 * fail-soft throughout — a single bad candidate is recorded in `errors` and
 * never sinks the rest of the sweep. Never throws.
 */
export function runWalCheckpointSweep(
  opts: { thresholdBytes?: number; roots?: string[] } = {},
): WalGuardSweepResult {
  const result: WalGuardSweepResult = {
    checked: 0,
    overThreshold: 0,
    checkpointed: 0,
    bytesReclaimed: 0,
    errors: [],
  };
  let candidates: WalCandidate[];
  try {
    candidates = discoverWalCandidates(opts.roots);
  } catch (err) {
    result.errors.push({ dbPath: '(discover)', error: (err as Error)?.message ?? String(err) });
    return result;
  }
  result.checked = candidates.length;
  const plan = planWalCheckpoints(candidates, opts.thresholdBytes);
  result.overThreshold = plan.length;
  for (const c of plan) {
    const outcome = checkpointOne(c.dbPath);
    if (outcome.ok) {
      result.checkpointed += 1;
      result.bytesReclaimed += Math.max(0, outcome.walBytesBefore - outcome.walBytesAfter);
    } else {
      result.errors.push({ dbPath: outcome.dbPath, error: outcome.error ?? 'unknown' });
    }
  }
  return result;
}
