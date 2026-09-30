/**
 * Install provenance for `~/.papercusp/**` (WI-37405, changes #2 and #3).
 *
 * Two problems, one record:
 *
 *  1. **"Which build are my hooks?" took an md5 hunt across four checkouts.** Diagnosing
 *     EI-19956921121874213 meant hashing every installed hook and comparing it against
 *     staging, release and three sandbox trees to discover the answer was "an 8-day-old
 *     gym probe". A sibling `.installed-from` stamp makes that one read.
 *
 *  2. **A stale source could silently overwrite a newer install.** The scratch-source
 *     guard closes the sandbox case, but two *canonical* trees still race — a release
 *     checkout booting after staging installed a fix would quietly revert it. The stamp
 *     gives the ordering needed to refuse that.
 *
 * ## Fail-safe posture
 *
 * Everything here is best-effort and degrades to "proceed with the install":
 *  - no git available (packaged app) → no commit date → no downgrade check, install runs;
 *  - no existing stamp (first install, or one predating this code) → install runs;
 *  - unreadable/corrupt stamp → install runs.
 *
 * The downgrade refusal only fires when BOTH sides are known AND the incoming source is
 * older by a wide margin. That margin is deliberate: it must catch the eight-day case
 * decisively while never firing on ordinary near-simultaneous installs or a small
 * deliberate rollback.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const INSTALLED_FROM_BASENAME = '.installed-from';

/**
 * How much OLDER an incoming source must be than the installed one before the install
 * is refused as a downgrade. Wide on purpose — see the fail-safe note above.
 */
export const DOWNGRADE_REFUSAL_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** A stranded `*.psu-install.<pid>.tmp` must be at least this old before GC removes it. */
export const STRANDED_TMP_MIN_AGE_MS = 10 * 60 * 1000;

export type InstallStamp = {
  /** Absolute path of the source tree this dest was installed from. */
  sourceDir: string;
  /** Git sha of the source tree, when resolvable. */
  sourceSha?: string;
  /** Committer date of that sha (ISO), when resolvable — the ordering key. */
  sourceCommittedAt?: string;
  /** When the install ran (ISO). */
  installedAt: string;
  /** Writing process, for attributing a surprising install. */
  pid: number;
  /** Runtime unit/host label that performed the install. */
  unit?: string;
  /** argv[1] basename — names the unit/script that performed the install. */
  installedBy?: string;
  /** Basenames written in that pass. */
  files?: string[];
  /**
   * Basenames whose SOURCE bytes differed from `sourceSha` when they were installed —
   * i.e. what is on disk here is NOT what that commit contains (EI-21974793277035753).
   *
   * Tri-state on purpose, and the distinction is load-bearing:
   *   `undefined` → could not be determined (no git, not a repo, no HEAD) — an in-band
   *                 unknown, NOT a clean verdict;
   *   `[]`        → positively checked, everything matched its commit;
   *   non-empty   → these files are uncommitted, so `sourceSha` does not describe them.
   *
   * Collapsing unknown into `[]` would make the stamp lie in the one direction that
   * matters, which is the defect this field exists to fix.
   */
  uncommittedFiles?: string[];
};

/** Read a dest dir's provenance stamp. Returns null when absent or unparseable. */
export async function readInstallStamp(destDir: string): Promise<InstallStamp | null> {
  try {
    const raw = await fs.readFile(path.join(destDir, INSTALLED_FROM_BASENAME), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const stamp = parsed as InstallStamp;
    return typeof stamp.sourceDir === 'string' ? stamp : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the git sha + committer date of a source tree. When `paths` is provided,
 * the result is the latest commit touching those source-relative paths rather than
 * the repository HEAD. That distinction is load-bearing for shared hook installs:
 * an unrelated commit can move a checkout's HEAD without changing the hooks that
 * are about to overwrite the machine-wide copy.
 *
 * Best-effort: returns `{}` when git is unavailable (packaged app), the dir is not a
 * repo, no requested path has history, or the call fails.
 */
export async function resolveSourceGitProvenance(
  sourceDir: string,
  paths?: readonly string[],
): Promise<{ sourceSha?: string; sourceCommittedAt?: string }> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const args = ['-C', sourceDir, 'log', '-1', '--format=%H%n%cI'];
    if (paths && paths.length > 0) args.push('--', ...paths);
    const { stdout } = await run('git', args, {
      timeout: 5_000,
    });
    const [sha, committedAt] = String(stdout).trim().split('\n');
    if (!sha) return {};
    const committedMs = committedAt ? Date.parse(committedAt) : NaN;
    return {
      sourceSha: sha,
      sourceCommittedAt: Number.isFinite(committedMs)
        ? new Date(committedMs).toISOString()
        : committedAt || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Which of `paths` differ from HEAD in `sourceDir` — the question
 * `resolveSourceGitProvenance` deliberately does not answer, and whose absence made the
 * install stamp actively misleading (EI-21974793277035753).
 *
 * `resolveSourceGitProvenance` reports the last commit *touching* these paths. It never
 * asks whether the bytes about to be installed *match* that commit, so a hook edited but
 * not committed was stamped with a `sourceSha` whose blob differs from what landed on
 * disk. Measured 2026-08-31: a PreToolUse gate edit was live for every agent on the box
 * ~4.5h before it was committed, stamped the whole time with a sha that did not contain
 * it. A record that answers "which build are my hooks?" with the wrong sha is worse than
 * no record, because it looks authoritative.
 *
 * Two narrow questions rather than one `status --porcelain` parse: porcelain emits
 * repo-root-relative paths, shell-quotes anything unusual, and uses a two-field form for
 * renames — more parsing, and more ways to be quietly wrong, than asking git directly.
 *
 * Best-effort, and returns `undefined` (not `[]`) on every failure so an unknown is never
 * mistaken for a clean verdict: no git, not a repo, and a repo with no HEAD all land here.
 */
export async function resolveUncommittedSources(
  sourceDir: string,
  paths?: readonly string[],
): Promise<string[] | undefined> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const pathArgs = paths && paths.length > 0 ? ['--', ...paths] : [];
    const [tracked, untracked] = await Promise.all([
      // Working tree vs HEAD, so a staged-but-uncommitted edit counts as uncommitted too.
      run('git', ['-C', sourceDir, 'diff', '--name-only', 'HEAD', ...pathArgs], {
        timeout: 5_000,
      }),
      // A brand-new hook has no HEAD blob at all, so `diff` cannot see it.
      run(
        'git',
        ['-C', sourceDir, 'ls-files', '--others', '--exclude-standard', '--full-name', ...pathArgs],
        { timeout: 5_000 },
      ),
    ]);
    // Both commands emit repo-relative paths; the stamp speaks in basenames (as `files`
    // does), so normalize to basenames and keep only what the caller actually asked about.
    const requested = paths && paths.length > 0 ? new Set(paths.map((p) => path.basename(p))) : null;
    const dirty = new Set<string>();
    for (const stdout of [tracked.stdout, untracked.stdout]) {
      for (const line of String(stdout).split('\n')) {
        const name = path.basename(line.trim());
        if (!name) continue;
        if (requested && !requested.has(name)) continue;
        dirty.add(name);
      }
    }
    return [...dirty].sort();
  } catch {
    return undefined;
  }
}

export type DowngradeVerdict =
  | { downgrade: false; reason: 'no-existing-stamp' | 'dates-unknown' | 'not-older' }
  | { downgrade: true; installedAt: string; incomingAt: string; olderByMs: number };

/**
 * Decide whether installing `incoming` over `existing` would be a stale downgrade.
 *
 * Pure, so the threshold semantics are unit-testable without touching a filesystem.
 */
export function classifyDowngrade(
  existing: InstallStamp | null,
  incoming: { sourceCommittedAt?: string },
  thresholdMs: number = DOWNGRADE_REFUSAL_THRESHOLD_MS,
): DowngradeVerdict {
  if (!existing) return { downgrade: false, reason: 'no-existing-stamp' };
  const prev = existing.sourceCommittedAt ? Date.parse(existing.sourceCommittedAt) : NaN;
  const next = incoming.sourceCommittedAt ? Date.parse(incoming.sourceCommittedAt) : NaN;
  if (!Number.isFinite(prev) || !Number.isFinite(next)) {
    return { downgrade: false, reason: 'dates-unknown' };
  }
  const olderByMs = prev - next;
  if (olderByMs <= thresholdMs) return { downgrade: false, reason: 'not-older' };
  return {
    downgrade: true,
    installedAt: existing.sourceCommittedAt as string,
    incomingAt: incoming.sourceCommittedAt as string,
    olderByMs,
  };
}

/** Write the provenance stamp. Best-effort — never fails an otherwise-good install. */
export async function writeInstallStamp(destDir: string, stamp: InstallStamp): Promise<void> {
  try {
    const dst = path.join(destDir, INSTALLED_FROM_BASENAME);
    const tmp = `${dst}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o644 });
    await fs.rename(tmp, dst);
  } catch {
    /* provenance is diagnostic, never load-bearing */
  }
}

/**
 * Remove stranded `*.psu-install.<pid>.tmp` files an interrupted install left behind.
 *
 * Age-gated rather than pid-gated on purpose: PIDs wrap roughly daily under fleet load
 * here, so a liveness probe can match an unrelated recycled process. A rename(2) into
 * place takes milliseconds, so anything older than the threshold is unambiguously
 * stranded and cannot be a live install's in-flight temp file.
 *
 * @returns basenames removed.
 */
export async function gcStrandedInstallTmp(
  destDir: string,
  minAgeMs: number = STRANDED_TMP_MIN_AGE_MS,
): Promise<string[]> {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(destDir);
  } catch {
    return removed;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!/\.psu-install\.\d+\.tmp$/.test(name)) continue;
    const full = path.join(destDir, name);
    try {
      const st = await fs.stat(full);
      if (now - st.mtimeMs < minAgeMs) continue;
      await fs.unlink(full);
      removed.push(name);
    } catch {
      /* raced with another GC or a real install — fine either way */
    }
  }
  return removed;
}
