/**
 * Recovery-debris filesystem janitor (EI-1032).
 *
 * PG/kopia recovery events (a restore, a rollback, a corruption-audit wipe)
 * rename the OLD copy of a directory aside with a `<name>.<tag>-<timestamp>`
 * suffix instead of deleting it outright — a deliberate safety margin so a
 * bad recovery can be inspected/undone. Nothing ever reaps these once the
 * recovery is confirmed good: ~66G of dead debris (embedded-pg-data.broken-*,
 * kopia-repo.broken-*, .zz-recover-*, .half-restored-*, .audit-wipe-*) had
 * accumulated in the `default` workspace since early May, contributing to a
 * disk hitting 91% full. `policy.ts`'s SELF_EXCLUSION_RULES stops kopia from
 * snapshotting this debris going forward, but does nothing about what
 * already exists on disk — that's this module's job.
 *
 * Deliberately conservative: only a directory whose BASENAME matches one of
 * the known recovery-debris patterns, sitting directly under a workspace
 * root, older than the threshold, is ever touched. Nothing else in a
 * workspace is scanned or considered.
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { backupHost } from './config';

/** Basename patterns recognised as recovery debris (mirrors policy.ts's
 *  SELF_EXCLUSION_RULES recovery-tag set — kept as regexes here since this
 *  module matches real directory names, not kopia ignore-globs). */
const DEBRIS_NAME_PATTERNS: RegExp[] = [
  /\.broken-.+$/, // covers both `.broken-*` and `<name>.broken-*`
  /\.zz-recover-.+$/,
  /\.half-restored-.+$/,
  /\.audit-wipe-.+$/,
  /\.rolled-back-.+$/,
];

function isDebrisName(name: string): boolean {
  return DEBRIS_NAME_PATTERNS.some((re) => re.test(name));
}

/** Default reap threshold: debris older than this many ms is swept.
 *  Conservative (14 days) — comfortably past any plausible "did the
 *  recovery actually work" inspection window. */
export const DEFAULT_DEBRIS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface DebrisSweepResult {
  /** Absolute paths actually removed. */
  removed: string[];
  /** Absolute paths matched the debris naming pattern but were younger
   *  than the threshold — kept, reported for visibility. */
  kept: string[];
  /** Total bytes freed (best-effort; a `stat` failure mid-walk is skipped,
   *  not fatal to the sweep). */
  bytesFreed: number;
}

/**
 * Scan every immediate child of `workspacesRoot` (each workspace) for
 * immediate children matching a recovery-debris name pattern, and `rm -rf`
 * any older than `maxAgeMs`. Pure `node:fs`, no PG — safe to unit-test
 * against a scratch directory tree.
 */
export async function sweepRecoveryDebris(
  workspacesRoot: string,
  opts: { maxAgeMs?: number; dryRun?: boolean } = {},
): Promise<DebrisSweepResult> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_DEBRIS_MAX_AGE_MS;
  const cutoff = Date.now() - maxAgeMs;
  const removed: string[] = [];
  const kept: string[] = [];
  let bytesFreed = 0;

  let workspaceDirs: string[];
  try {
    workspaceDirs = await readdir(workspacesRoot);
  } catch {
    // Workspaces root doesn't exist / isn't readable yet — nothing to sweep.
    return { removed, kept, bytesFreed };
  }

  for (const wsName of workspaceDirs) {
    const wsPath = join(workspacesRoot, wsName);
    let children: string[];
    try {
      children = await readdir(wsPath);
    } catch {
      continue; // not a directory / raced with something else — skip, not fatal
    }
    for (const childName of children) {
      if (!isDebrisName(childName)) continue;
      const childPath = join(wsPath, childName);
      let info;
      try {
        info = await stat(childPath);
      } catch {
        continue; // raced with something else removing it — fine
      }
      if (info.mtimeMs >= cutoff) {
        kept.push(childPath);
        continue;
      }
      if (opts.dryRun) {
        removed.push(childPath);
        continue;
      }
      const sizeBefore = await dirSizeBestEffort(childPath);
      try {
        await rm(childPath, { recursive: true, force: true });
        removed.push(childPath);
        bytesFreed += sizeBefore;
      } catch {
        // Best-effort: a permission error / concurrent removal shouldn't
        // abort the rest of the sweep.
        kept.push(childPath);
      }
    }
  }

  return { removed, kept, bytesFreed };
}

/** Best-effort recursive size (used only for the reported bytesFreed
 *  metric — never allowed to fail the actual removal). */
async function dirSizeBestEffort(path: string): Promise<number> {
  try {
    let total = 0;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) {
        total += await dirSizeBestEffort(entryPath);
      } else {
        try {
          total += (await stat(entryPath)).size;
        } catch {
          /* skip */
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Host-wired tick: sweep the configured `workspacesRoot()` using the
 * default threshold. The single-run tick a scheduled workflow calls
 * (mirrors `sweepOrphanSnapshots`'s shape).
 */
export async function sweepRecoveryDebrisTick(): Promise<DebrisSweepResult> {
  const root = backupHost().workspacesRoot();
  return sweepRecoveryDebris(root);
}
