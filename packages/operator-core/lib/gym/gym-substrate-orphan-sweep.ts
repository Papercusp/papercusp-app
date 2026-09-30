/**
 * Crash-safe cleanup for the large, hard-linked substrate trees used by gym
 * autoloop cycles (WI-40255).
 *
 * The cycle's `finally` block removes its substrate on a graceful return, but a
 * SIGKILL/OOM/host restart skips that block. A new cycle therefore sweeps only
 * the parent-level `gym-substrate-*` namespace before creating its own tree.
 * Every live cycle writes an owner sentinel containing both its PID and Linux
 * process start token; the token prevents a reused PID from protecting an old
 * orphan. A short age floor protects the tiny window between mkdtemp and the
 * atomic sentinel rename (or a process killed during that window).
 */
import { lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

export const GYM_SUBSTRATE_PREFIX = 'gym-substrate-';
export const GYM_SUBSTRATE_OWNER_FILE = '.gym-substrate-owner.json';
/** Do not reap a just-created root that has not published its sentinel yet. */
export const DEFAULT_GYM_SUBSTRATE_ORPHAN_AGE_MS = 60 * 1000;

export interface GymSubstrateOwner {
  pid: number;
  /** Linux `/proc/<pid>/stat` starttime; null on platforms without `/proc`. */
  processStartToken: string | null;
  createdAtMs: number;
}

export interface GymSubstrateCandidate {
  name: string;
  path: string;
  ageMs: number;
  owner: GymSubstrateOwner | null;
}

export interface GymSubstrateSweepResult {
  swept: string[];
  retained: string[];
  errors: Array<{ path: string; error: string }>;
}

export interface SweepOrphanedGymSubstratesOptions {
  /** Parent containing the `gym-substrate-*` roots (the repo's parent). */
  parentDir: string;
  /** A root younger than this may still be in its sentinel-publish window. */
  maxAgeMs?: number;
  /** Injectable for deterministic tests; defaults to wall clock time. */
  nowMs?: number;
  /** Injectable liveness check; production uses PID + process start token. */
  isOwnerAlive?: (owner: GymSubstrateOwner) => boolean;
}

/**
 * Read Linux's process starttime field. `stat` has a parenthesized comm field,
 * so split only after the final `)`; field 22 is index 19 in the remainder.
 */
export function readProcessStartToken(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commEnd = stat.lastIndexOf(')');
    if (commEnd < 0) return null;
    return stat.slice(commEnd + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

/** The current process identity persisted in a substrate root's sentinel. */
export function currentGymSubstrateOwner(nowMs = Date.now()): GymSubstrateOwner {
  return {
    pid: process.pid,
    processStartToken: readProcessStartToken(process.pid),
    createdAtMs: nowMs,
  };
}

/**
 * Publish the owner sentinel with a temp-file + rename, so a reaper never sees
 * a partially-written JSON document. The root is expected to be freshly made.
 */
export function writeGymSubstrateOwner(root: string, nowMs = Date.now()): GymSubstrateOwner {
  const owner = currentGymSubstrateOwner(nowMs);
  const ownerPath = join(root, GYM_SUBSTRATE_OWNER_FILE);
  const tempPath = join(root, `${GYM_SUBSTRATE_OWNER_FILE}.tmp-${process.pid}`);
  writeFileSync(tempPath, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx' });
  renameSync(tempPath, ownerPath);
  return owner;
}

function readGymSubstrateOwner(root: string): GymSubstrateOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, GYM_SUBSTRATE_OWNER_FILE), 'utf8')) as Partial<GymSubstrateOwner>;
    const pid = parsed.pid;
    const processStartToken = parsed.processStartToken;
    const createdAtMs = parsed.createdAtMs;
    if (
      typeof pid !== 'number' ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof createdAtMs !== 'number' ||
      !Number.isFinite(createdAtMs) ||
      (processStartToken !== null && typeof processStartToken !== 'string')
    ) {
      return null;
    }
    return {
      pid,
      processStartToken: processStartToken ?? null,
      createdAtMs,
    };
  } catch {
    // A missing/partial sentinel is treated like an unowned root; age gating
    // prevents reaping the tiny startup window while still cleaning bad debris.
    return null;
  }
}

/**
 * True only when the sentinel owner is still this exact process instance.
 * `kill(pid, 0)` catches a dead PID; `/proc` starttime catches PID reuse.
 */
export function isGymSubstrateOwnerAlive(owner: GymSubstrateOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }

  if (owner.processStartToken !== null) {
    const currentToken = readProcessStartToken(owner.pid);
    if (currentToken !== null && currentToken !== owner.processStartToken) return false;
  }
  return true;
}

/**
 * Selection policy kept pure so the recurrence guard can exercise the safety
 * boundary without making a multi-GB tree or consulting the live process table.
 */
export function shouldReapGymSubstrate(
  candidate: Pick<GymSubstrateCandidate, 'ageMs' | 'owner'>,
  opts: Pick<SweepOrphanedGymSubstratesOptions, 'maxAgeMs' | 'isOwnerAlive'> = {},
): boolean {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_GYM_SUBSTRATE_ORPHAN_AGE_MS;
  if (candidate.ageMs < maxAgeMs) return false;
  if (!candidate.owner) return true;
  return !(opts.isOwnerAlive ?? isGymSubstrateOwnerAlive)(candidate.owner);
}

/**
 * Remove stale gym substrate roots without ever following an unrelated entry.
 * Best-effort: a filesystem race or permission failure is returned as evidence
 * and never prevents the current cycle from starting.
 */
export function sweepOrphanedGymSubstrates(opts: SweepOrphanedGymSubstratesOptions): GymSubstrateSweepResult {
  const result: GymSubstrateSweepResult = { swept: [], retained: [], errors: [] };
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_GYM_SUBSTRATE_ORPHAN_AGE_MS;

  let entries: Dirent[];
  try {
    entries = readdirSync(opts.parentDir, { withFileTypes: true });
  } catch (error) {
    result.errors.push({ path: opts.parentDir, error: String(error) });
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(GYM_SUBSTRATE_PREFIX)) continue;
    const path = join(opts.parentDir, entry.name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory()) continue;
      const candidate: GymSubstrateCandidate = {
        name: entry.name,
        path,
        ageMs: Math.max(0, nowMs - (stat.birthtimeMs || stat.mtimeMs)),
        owner: readGymSubstrateOwner(path),
      };
      if (!shouldReapGymSubstrate(candidate, { maxAgeMs, isOwnerAlive: opts.isOwnerAlive })) {
        result.retained.push(entry.name);
        continue;
      }
      rmSync(path, { recursive: true, force: true });
      result.swept.push(entry.name);
    } catch (error) {
      result.errors.push({ path, error: String(error) });
    }
  }
  return result;
}

/**
 * Make a fresh substrate root and publish its owner before any expensive work.
 * Kept as a tiny helper so callers cannot accidentally forget the sentinel.
 */
export function createGymSubstrateRoot(parentDir: string, nowMs = Date.now()): { root: string; owner: GymSubstrateOwner } {
  const root = mkdtempSync(join(parentDir, GYM_SUBSTRATE_PREFIX));
  try {
    const owner = writeGymSubstrateOwner(root, nowMs);
    return { root, owner };
  } catch (error) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* preserve the original failure */ }
    throw error;
  }
}
