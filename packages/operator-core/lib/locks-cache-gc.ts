/**
 * WI-10005187: retention sweep for the per-owner hook state in
 * `~/.papercusp/locks-cache` (override: PAPERCUSP_LOCKS_CACHE_DIR, same as the hooks).
 *
 * The Claude/Codex/OMP hooks write one file per owner per purpose there
 * (`owner-<sid>-last-<kind>.json`, `activity-hook-bundle-<owner>.json`,
 * `coord-cursor-<owner>.json`, `tip-notice-<owner>.json`, `activity-last-<phase>-<key>`,
 * `wi-nudge-<owner>.*`, `<tool_use_id>.lock|.paths`, ...) and nothing ever removed
 * them. Measured 2026-10-02: 32,171 entries in one flat directory (131 MB), 17,133
 * of them older than 30 days. A flat directory that size makes every open/lookup in
 * it slow, and coord:orient reads Codex lock markers from it on the request path
 * (WI-10004754: a 10s D-state stall in open_last_lookups on that directory).
 *
 * Every entry is a recomputable cursor or cache: losing one only resets a hook
 * cursor or re-derives a bundle. Only REGULAR files older than the retention window
 * are removed: an owner that fired no hook for 14 days is ended or dormant, and a
 * dormant one rebuilds its state on its next hook. Subdirectories, symlinks and
 * anything fresh are left alone.
 *
 * The sweep is asynchronous and streams the directory (`opendir`), so it never
 * holds a 32k-entry synchronous readdir on whichever thread runs it. Driven by
 * the daily scratch GC workflow (dbos/periodic-workflows.ts, scratchGcTick).
 */
import { lstat, opendir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LOCKS_CACHE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export function locksCacheDir(): string {
  return process.env.PAPERCUSP_LOCKS_CACHE_DIR || join(homedir(), '.papercusp', 'locks-cache');
}

export interface LocksCacheGcResult {
  dir: string;
  scanned: number;
  removed: number;
  kept: number;
  /** Entries that vanished or could not be removed mid-sweep (a live hook racing us). */
  skipped: number;
  /** Set when the directory itself could not be opened (absent is NOT an error). */
  error: string | null;
}

export async function runLocksCacheGc(
  opts: { dir?: string; retentionMs?: number; now?: () => number } = {},
): Promise<LocksCacheGcResult> {
  const dir = opts.dir ?? locksCacheDir();
  const cutoff = (opts.now ?? Date.now)() - (opts.retentionMs ?? LOCKS_CACHE_RETENTION_MS);
  const result: LocksCacheGcResult = { dir, scanned: 0, removed: 0, kept: 0, skipped: 0, error: null };

  let handle;
  try {
    handle = await opendir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') result.error = (err as Error).message;
    return result;
  }

  for await (const entry of handle) {
    result.scanned += 1;
    if (!entry.isFile()) {
      result.kept += 1;
      continue;
    }
    const path = join(dir, entry.name);
    try {
      const st = await lstat(path);
      if (!st.isFile() || st.mtimeMs >= cutoff) {
        result.kept += 1;
        continue;
      }
      await unlink(path);
      result.removed += 1;
    } catch {
      result.skipped += 1;
    }
  }
  return result;
}
