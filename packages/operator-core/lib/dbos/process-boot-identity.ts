/**
 * Process boot identity for DBOS-owned watchdogs.
 *
 * This module is eagerly imported by `dbos/bootstrap.ts`, which is loaded while
 * the host is starting. The watchdog itself is intentionally lazy (it is
 * imported from the first `routinesTick`), so keeping these values there would
 * make a delayed first tick look like process boot and would sample the
 * checkout HEAD after the process had already been running.
 *
 * The wall-clock boot instant comes from `process.uptime()` rather than module
 * evaluation time. The commit lookup starts at module evaluation and is
 * memoized for the process lifetime, preserving the earliest stable bootstrap
 * seam while remaining fail-soft when the host is not a git checkout.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

let pexec: ((...args: any[]) => Promise<any>) | undefined;
const runExecFile = (...args: any[]) => (pexec ??= promisify(execFile) as any)(...args);

/** Best-effort current checkout HEAD resolver shared by boot and refresh reads. */
export async function resolveCurrentHeadCommit(): Promise<string | null> {
  try {
    const { stdout } = await runExecFile('git', ['rev-parse', 'HEAD'], { timeout: 5_000 });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    // Packaged hosts and non-checkout processes have no readable git HEAD.
    // Watchdogs must fail safe rather than turning that into a false alarm.
    return null;
  }
}

/**
 * Best-effort "how far behind is `bootCommit`?" — the COUNT of commits on
 * `currentCommit` that `bootCommit` does not have.
 *
 * Why a count and not a curated path filter: the stale-executor alarm used to
 * quantify only TIME ("has run 2h"), which reads as mild — the measured
 * 2026-08-30 incident was 2h of uptime but **109 commits** of code drift, and
 * the hours figure is what a reader anchors on. Magnitude is the actionable
 * number, so it belongs in the page.
 *
 * Deliberately NOT narrowed to a hand-listed set of "routine code" paths. A
 * curated directory list is a to-do list, not a detector: it has to be edited
 * every time code moves, and it silently under-reports until someone
 * remembers to (the exact defect class WI-1371132 removed from the
 * model-policy importer guard). A routines executor tsx-loads the WHOLE tree
 * at boot, so every commit since boot is genuinely code it is not running —
 * the uncurated total is both the honest number and the one that cannot rot.
 *
 * Fail-safe: returns null on anything unexpected (shallow clone, unrelated
 * histories, missing object, non-checkout host) so the caller degrades to its
 * pre-existing text rather than printing a wrong or fabricated magnitude.
 */
export async function resolveCommitsBehind(
  bootCommit: string | null,
  currentCommit: string | null,
): Promise<number | null> {
  const sha = /^[0-9a-f]{40}$/i;
  // Validate before interpolating into argv: these reach `git` as a revision
  // range, and an unvalidated value is how a range turns into an option.
  if (!bootCommit || !currentCommit || !sha.test(bootCommit) || !sha.test(currentCommit)) return null;
  if (bootCommit === currentCommit) return 0;
  try {
    const { stdout } = await runExecFile('git', ['rev-list', '--count', `${bootCommit}..${currentCommit}`], {
      timeout: 5_000,
    });
    const n = Number(stdout.trim());
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * The routine source tree a ROUTINES=1 host executes IN-PROCESS. Everything under
 * it enters the module graph at boot and is never reloaded, so a diff of this
 * prefix between boot and HEAD is the drift a stale executor is actually suffering.
 *
 * ⚠ DELIBERATELY A LOWER BOUND, NOT A CENSUS. Routine handlers reach helpers all
 * over `operator-core`, and a frozen copy of one of those is just as wrong. So a
 * zero here means "nothing detected by this bounded probe", NEVER "this process is
 * fine" — which is why `resolveRoutineCodeDrift` reports empty arrays and callers
 * must fall back to the commit count rather than print a reassuring negative. A
 * bounded measurement rendered as a confident all-clear is the failure mode this
 * comment exists to prevent.
 */
export const ROUTINE_SOURCE_PREFIX = 'packages/operator-core/lib/harness/routines/';

export interface RoutineCodeDrift {
  /** Routine sources that CHANGED between boot and HEAD: this process still runs
   *  the older copy of each. */
  changed: string[];
  /** Routine sources that DO NOT RESOLVE at the boot commit — absent from this
   *  process's module graph entirely, so routines they define are not running here
   *  AT ALL. Strictly worse than executing old code, and the distinction a bare
   *  commit count cannot express: measured 2026-08-31, a bg-host 143 commits behind
   *  had four such files, two of them whole routines that had never once fired. */
  addedSinceBoot: string[];
}

/**
 * Best-effort "which routine code is this process actually wrong about?".
 *
 * Returns null when the question is unanswerable (bad shas, no checkout, git
 * failed) so the caller degrades to its commit-count wording instead of
 * fabricating an all-clear. Returns EMPTY ARRAYS when the probe ran and found
 * nothing in its bounded scope — a different thing from null, and still not a
 * clean bill of health (see ROUTINE_SOURCE_PREFIX).
 */
export async function resolveRoutineCodeDrift(
  bootCommit: string | null,
  currentCommit: string | null,
): Promise<RoutineCodeDrift | null> {
  const sha = /^[0-9a-f]{40}$/i;
  // Same argv-injection guard as resolveCommitsBehind: these become a revision range.
  if (!bootCommit || !currentCommit || !sha.test(bootCommit) || !sha.test(currentCommit)) return null;
  if (bootCommit === currentCommit) return { changed: [], addedSinceBoot: [] };
  try {
    // --no-renames on purpose: a moved file must report as D+A, because under its
    // NEW path it is genuinely absent from the booted module graph. A rename status
    // would hide that behind a similarity score and lose the severe case.
    const { stdout } = await runExecFile(
      'git',
      ['diff', '--name-status', '--no-renames', `${bootCommit}..${currentCommit}`, '--', ROUTINE_SOURCE_PREFIX],
      { timeout: 5_000 },
    );
    const changed: string[] = [];
    const addedSinceBoot: string[] = [];
    for (const line of String(stdout).split('\n')) {
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      const status = line.slice(0, tab).trim();
      const path = line.slice(tab + 1).trim();
      if (!status || !path) continue;
      // Test files are never loaded by the host, so counting them would inflate the
      // page with drift the executor does not actually execute. Covers
      // `*.integration.test.ts` too, which also ends in `.test.ts`.
      if (path.endsWith('.test.ts')) continue;
      if (status.startsWith('A')) addedSinceBoot.push(path);
      else if (status.startsWith('M') || status.startsWith('D')) changed.push(path);
    }
    return { changed, addedSinceBoot };
  } catch {
    return null;
  }
}

export interface ProcessBootIdentity {
  /** Wall-clock instant at which the process started (milliseconds). */
  bootTimeMs: number;
  /** Commit sampled at the bootstrap seam, memoized for this process. */
  bootCommit: Promise<string | null>;
}

/** Capture the two process-identity values together at one eager seam. */
export function captureProcessBootIdentity(opts: {
  nowMs?: number;
  uptimeSec?: number;
  resolveCommit?: () => Promise<string | null>;
} = {}): ProcessBootIdentity {
  const nowMs = opts.nowMs ?? Date.now();
  const uptimeSec = opts.uptimeSec ?? process.uptime();
  return {
    bootTimeMs: nowMs - Math.floor(uptimeSec * 1000),
    bootCommit: (opts.resolveCommit ?? resolveCurrentHeadCommit)(),
  };
}

// Start this read as soon as the DBOS bootstrap module graph evaluates. Do not
// move it behind the lazy watchdog import: that recreates EI-20338401938272036.
const PROCESS_BOOT_IDENTITY = captureProcessBootIdentity();

export function processBootTimeMs(): number {
  return PROCESS_BOOT_IDENTITY.bootTimeMs;
}

/** Memoized commit sampled at the eager DBOS bootstrap seam. */
export function processBootCommitSha(): Promise<string | null> {
  return PROCESS_BOOT_IDENTITY.bootCommit;
}
