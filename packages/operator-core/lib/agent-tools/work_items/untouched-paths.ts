/**
 * P-005 (plan `design-to-code-coverage-seam-2026-09-02`), governed by D-016.
 *
 * Decide whether a completion's `filesChanged` names a path that is REAL BUT UNTOUCHED —
 * a file that genuinely exists in this tree and that this unit of work never changed.
 *
 * ## Why this exists beside P-001 rather than inside it
 *
 * D-016 ruled that `filesChanged` is graded on GIT HISTORY, not filesystem existence, and
 * built `fabricatedPathsInCompletion` on the one absence that is a defect: a path absent
 * from disk AND unknown to git has never existed here. That closes the fabrication hole
 * for INVENTED paths, and D-016 names this module as its "strictly stronger successor":
 * once a path must exist, the cheapest way to satisfy the check is to name a real file
 * you did not touch. That is the gaming surface P-001 moved rather than removed, and it
 * is what D-011 means by "A is a ladder, not one step".
 *
 * The two populations are DISJOINT BY CONSTRUCTION: P-001 judges only paths absent from
 * disk, this module only paths present on disk. A path is never reported by both, so the
 * grades cannot double-count one defect.
 *
 * ## Why the working-tree check is the load-bearing part
 *
 * The obvious predicate — "this path's last commit predates the work-item" — is already
 * implemented as `preExistingChangedPathsInCompletion` (complete.ts, EI-20288629053504794)
 * and is WARN-ONLY. It must stay warn-only, because on its own it is wrong in the one
 * direction that matters: this repo has ONE shared working tree and a git-sync routine
 * that commits it on a schedule, so at the moment an agent closes, its edit is usually
 * still UNCOMMITTED. Git history alone therefore reports an honest, in-flight change as
 * "not touched since the item was created" — a confident false accusation against exactly
 * the agent who did the work. That is tolerable in a nudge and disqualifying in a gate.
 *
 * So this module clears a path on EITHER of two independent proofs of work:
 *
 *   1. the working tree is DIRTY at that path (modified, staged, or untracked) — the edit
 *      exists and git-sync has simply not swept it yet; or
 *   2. a commit touched the path INSIDE the work window — git-sync already swept it.
 *
 * Only a path that fails both — present on disk, clean against HEAD, and last committed
 * before this work began — is reported. Those are the two ways real work can look, and a
 * path matching neither was not changed by this close.
 *
 * ## The window, and why it is widened
 *
 * The window opens at the work-item's own start (`since`, the caller passes the earliest
 * of created/claimed) and is widened by {@link UNTOUCHED_GRACE_SEC}, reusing the existing
 * `LANDING_RACE_WINDOW_SEC` — the constant this repo already uses for "a commit may have
 * landed either side of this boundary". The widening is deliberately one-directional: it
 * can only ever CLEAR a path, never accuse one, and it absorbs the honest case where an
 * agent edited a file shortly before the item existed and git-sync swept it in between.
 *
 * ## Biased toward generosity, deliberately
 *
 * Same asymmetry D-016 states: a false accusation lowers an honest agent's grade and
 * teaches the fleet the signal is noise, while a false clean verdict merely leaves today's
 * behaviour in place. Every ambiguity therefore resolves to "cannot judge":
 *
 *   - a path under a declared submodule prefix is NEVER judged. `lastCommitTimes` runs
 *     `git log` from the SUPERPROJECT, which reports NOTHING for a real file inside a
 *     submodule (EI-21138854971082896) — the one shape that would otherwise manufacture a
 *     confident false accusation against every submodule edit, migrations included;
 *   - an UNKNOWN last-commit time is never an exoneration and never an accusation. This is
 *     the rule `isUnchangedForAttribution` states for the same data: "`null` (unknown) is
 *     deliberately NOT unchanged ... treating unknown as unchanged would manufacture an
 *     exoneration out of an absence of evidence." Here the same absence must not
 *     manufacture an ACCUSATION either, so it is silence;
 *   - an unreadable working tree is silence: without proof-of-work route 1 the remaining
 *     evidence cannot distinguish an in-flight edit from an untouched file;
 *   - a glob, an absolute path, an escaping path, an unresolvable root, a missing window,
 *     or any throw is silence;
 *   - under multiple candidate roots, being cleared under ANY root clears the path.
 *
 * PURE via injected probes, so every branch above is unit-testable without a real tree.
 */
import { spawn } from 'node:child_process';
import {
  gitSidecarEnabled,
  isSidecarInfrastructureFault,
  noteSidecarFallback,
  runGitViaSpawnerSidecar,
} from '../../fleet/git-via-sidecar';
import { existsSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';

import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';

/**
 * Bounds the git work, matching `MAX_FABRICATION_PROBES` on the sibling detector. A
 * completion naming more paths than this is not judged past the cap.
 */
export const MAX_UNTOUCHED_PROBES = 12;

/**
 * How far before the work window opens a commit still counts as this work.
 *
 * It absorbs TWO independent sources of error in "when did this work begin", and must
 * cover the larger:
 *
 *   1. GIT-SYNC SWEEP LAG — bounded, and this repo already names it
 *      `LANDING_RACE_WINDOW_SEC` (20 min) in `scripts/lib/tsc-baseline-gate.mjs`.
 *   2. WORK THAT PREDATES ITS OWN WORK-ITEM — an agent fixes something and files or
 *      claims the item afterwards, so the commit legitimately lands before `since`. This
 *      one is not bounded by any mechanism, which is why the window is set by measurement
 *      rather than by borrowing the sweep constant.
 *
 * MEASURED 2026-09-02 over 30 days of `committed` closes in the `papercusp` harness that
 * declare `filesChanged` (24,403 declared paths across 7,181 closes), scoring the real
 * predicate — tracked, clean working tree, last commit before item creation. The gap
 * distribution decays through the race population (41 pairs under 20 min, 12 at 20-60 min,
 * 14 at 1-2h, 5 at 2-4h, 1 at 4-6h) and then RISES again into a genuinely stale population
 * (5 at 6-12h, 11 at 12-24h, 26 at 1-7d, 32 beyond). There is no empty band to cut at — an
 * earlier 7-day sample appeared to show one, and that was an artifact of n=6.
 *
 * So the cut is chosen on cost, and the cost of generosity here is small: moving the grace
 * from 20 minutes to 24 hours drops detections from 82 closes to 48 (1.14% -> 0.67% of
 * sampled closes) while removing EVERY pair whose gap is short enough for the two
 * mechanisms above to explain. That is the asymmetry D-016 states — a false accusation
 * costs an honest agent's grade and teaches the fleet the signal is noise, a miss merely
 * leaves today's behaviour — bought for 0.47 percentage points.
 *
 * A path last committed more than a DAY before its work-item existed is not a plausible
 * in-flight edit. That is the claim this constant makes, and the measurement above is what
 * it rests on.
 */
export const UNTOUCHED_GRACE_SEC = 24 * 60 * 60;

/**
 * Epoch SECONDS of the path's last commit · `null` = git answered but knows nothing ·
 * `undefined` = COULD NOT ASK. All three are distinct: only a real timestamp is ever
 * grounds for a finding, and neither of the other two may become one.
 */
export type GitLastCommitProbe = (repoRoot: string, relPath: string) => number | null | undefined;

/**
 * `true` = the working tree differs from HEAD at this path (modified/staged/untracked) ·
 * `false` = it is clean · `undefined` = COULD NOT ASK, which is silence rather than
 * "clean", because a clean reading is half of what produces a finding.
 */
export type GitDirtyProbe = (repoRoot: string, relPath: string) => boolean | undefined;

/**
 * Batch form used by the default probes so one checkout costs one git read per signal.
 *
 * Batch probes MAY be async, and the defaults ARE: this runs inside `work_items:complete`
 * on the shared operator process, where a synchronous git spawn freezes EVERY request on
 * the host for as long as git runs (WI-10002704: an unbounded `git log` under
 * `execFileSync` held the :3070 main thread for up to 5s per completion — 74.6% of one
 * event-loop cpuprofile). Never reintroduce a `*Sync` child_process call in this module.
 */
export type GitDirtyBatchProbe = (
  repoRoot: string,
  relPaths: readonly string[],
) => ReadonlyMap<string, boolean | undefined> | Promise<ReadonlyMap<string, boolean | undefined>>;

/** Batch form used by the default probes so one checkout costs one history read. */
export type GitLastCommitBatchProbe = (
  repoRoot: string,
  relPaths: readonly string[],
) =>
  | ReadonlyMap<string, number | null | undefined>
  | Promise<ReadonlyMap<string, number | null | undefined>>;

export interface UntouchedPathProbe {
  /** Candidate checkout roots. An explicit empty list means "cannot judge", never "guess". */
  repoRoots?: readonly string[];
  /** Does this absolute path exist on disk? */
  exists?: (abs: string) => boolean;
  /** Is the working tree dirty at this repo-relative path? */
  isDirty?: GitDirtyProbe;
  /** Batched working-tree read; ignored when the per-path seam above is injected. */
  isDirtyMany?: GitDirtyBatchProbe;
  /** When was this repo-relative path last committed? */
  lastCommitAt?: GitLastCommitProbe;
  /** Batched history read; ignored when the per-path seam above is injected. */
  lastCommitAtMany?: GitLastCommitBatchProbe;
  /** Repo-relative submodule directory prefixes; paths under one are never judged. */
  submodulePrefixes?: (repoRoot: string) => readonly string[];
}

export interface UntouchedPathHit {
  path: string;
  /** ISO-8601 of the path's last commit — what makes the verdict checkable by hand. */
  lastCommitAt: string;
}

function normalizedRepoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

/** Upper bound on one git probe; past it the probe answers "cannot judge" (`undefined`). */
export const GIT_PROBE_TIMEOUT_MS = 5_000;

export interface GitSpawnOptions {
  /** The git executable. Tests point it at a slow wrapper to prove the probe never blocks. */
  gitBinary?: string;
  timeoutMs?: number;
  /** Cancel a running child when its owning operation has exceeded its liveness budget. */
  signal?: AbortSignal;
  /**
   * Run git in the spawner sidecar when this host has one, so a hot repeating read
   * does not fork from the big host process (~40 ms of frozen event loop per GB of
   * its RSS; see fleet/git-via-sidecar). ONLY for reads with SMALL, BOUNDED output:
   * the sidecar buffers stdout, so an `onField` early stop no longer kills git.
   * Falls back to the local streaming spawn when the sidecar cannot run it.
   */
  preferSidecar?: boolean;
}

export type GitStreamOutcome = 'complete' | 'failed' | 'timeout';

/**
 * Run `git <args>` WITHOUT blocking the event loop and hand each NUL-separated stdout field
 * to `onField` as it arrives (the trailing fragment after the last NUL is delivered too, so
 * the field sequence is exactly `stdout.split('\0')`). `onField` returning `true` stops the
 * read and kills git — that is what bounds a history walk. Resolves `'complete'` on exit 0
 * or an early stop, `'failed'` on a spawn error or non-zero exit, `'timeout'` past the
 * deadline. Never rejects.
 */
export async function streamGitFields(
  args: readonly string[],
  onField: (field: string) => boolean | void,
  opts: GitSpawnOptions = {},
): Promise<GitStreamOutcome> {
  if (opts.preferSidecar && !opts.gitBinary && gitSidecarEnabled()) {
    const outcome = await streamGitFieldsViaSidecar(args, onField, opts);
    if (outcome !== 'fallback') return outcome;
  }
  return streamGitFieldsLocal(args, onField, opts);
}

/**
 * The sidecar half of {@link streamGitFields}: same field sequence
 * (`stdout.split('\0')`), same outcomes. `'fallback'` means the sidecar could
 * not run the command, so the caller forks locally; it is counted through
 * noteSidecarFallback so a sidecar outage shows up as a rate, not silence.
 */
async function streamGitFieldsViaSidecar(
  args: readonly string[],
  onField: (field: string) => boolean | void,
  opts: GitSpawnOptions,
): Promise<GitStreamOutcome | 'fallback'> {
  if (opts.signal?.aborted) return 'failed';
  const timeoutMs = opts.timeoutMs ?? GIT_PROBE_TIMEOUT_MS;
  const startedAt = Date.now();
  let res: Awaited<ReturnType<typeof runGitViaSpawnerSidecar>>;
  try {
    res = await runGitViaSpawnerSidecar([...args], process.cwd(), timeoutMs,
      { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, {
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (error) {
    noteSidecarFallback('completion-freshness', error);
    return 'fallback';
  }
  if (isSidecarInfrastructureFault(res)) {
    noteSidecarFallback('completion-freshness', new Error(res.stderr));
    return 'fallback';
  }
  if (opts.signal?.aborted) return 'failed';
  if (res.code !== 0) return Date.now() - startedAt >= timeoutMs ? 'timeout' : 'failed';
  for (const field of res.stdout.split('\0')) {
    if (onField(field) === true) break;
  }
  return 'complete';
}

/** Local streaming spawn: the default path, and the fallback when the sidecar cannot run git. */
function streamGitFieldsLocal(
  args: readonly string[],
  onField: (field: string) => boolean | void,
  opts: GitSpawnOptions,
): Promise<GitStreamOutcome> {
  return new Promise<GitStreamOutcome>((resolve) => {
    let settled = false;
    let carry = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;
    let onAbort: (() => void) | undefined;
    const finish = (outcome: GitStreamOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      resolve(outcome);
    };
    if (opts.signal?.aborted) {
      resolve('failed');
      return;
    }
    try {
      child = spawn(opts.gitBinary ?? 'git', [...args], {
        stdio: ['ignore', 'pipe', 'ignore'],
        // This helper serves read-only status/path probes; do not let Git's optional
        // index refresh create .git/index.lock in the shared checkout.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
    } catch {
      resolve('failed');
      return;
    }
    if (opts.signal) {
      onAbort = () => finish('failed');
      opts.signal.addEventListener('abort', onAbort, { once: true });
      if (opts.signal.aborted) {
        finish('failed');
        return;
      }
    }
    timer = setTimeout(() => finish('timeout'), opts.timeoutMs ?? GIT_PROBE_TIMEOUT_MS);
    child.on('error', () => finish('failed'));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (settled) return;
      const fields = (carry + chunk).split('\0');
      carry = fields.pop() ?? '';
      for (const field of fields) {
        if (onField(field) === true) {
          finish('complete');
          return;
        }
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish('failed');
        return;
      }
      onField(carry);
      finish('complete');
    });
  });
}

/** One `git status` read for every candidate path in a checkout. Async — see GitDirtyBatchProbe. */
export async function isDirtyManyViaGit(
  repoRoot: string,
  relPaths: readonly string[],
  opts: GitSpawnOptions = {},
): Promise<Map<string, boolean | undefined>> {
  const result = new Map<string, boolean | undefined>();
  const paths = [...new Set(relPaths)];
  for (const path of paths) result.set(normalizedRepoPath(path), undefined);
  const fields: string[] = [];
  const outcome = await streamGitFields(
    ['-C', repoRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths],
    (field) => {
      fields.push(field);
    },
    opts,
  );
  // not a repo, git missing, timeout → cannot judge every path
  if (outcome !== 'complete') return result;
  for (const path of paths) result.set(normalizedRepoPath(path), false);
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const changedPath = record.slice(3);
    if (changedPath) result.set(normalizedRepoPath(changedPath), true);
    // Porcelain -z emits the old and new names as adjacent NUL fields for renames/copies.
    if (/[RC]/.test(status)) {
      const secondPath = fields[index + 1];
      if (secondPath) result.set(normalizedRepoPath(secondPath), true);
      index += 1;
    }
  }
  return result;
}

const defaultIsDirtyMany: GitDirtyBatchProbe = (repoRoot, relPaths) => isDirtyManyViaGit(repoRoot, relPaths);

/**
 * One `git log` read maps each requested path to its newest touching commit. Async — see
 * GitLastCommitBatchProbe.
 *
 * git walks newest-first and only the FIRST sighting of a path is kept, so once every
 * requested path has been seen the rest of the walk cannot change the answer: stop there
 * and kill git. Without that stop the walk covered the repo's whole history on every
 * completion. A `--since` bound would NOT be equivalent — it would turn a path last
 * committed before the window (the exact finding this guard reports) into `null`.
 *
 * Outcomes: exit 0 or an early stop → unseen paths stay `null` (no history). A spawn error
 * or non-zero exit → every path `undefined` (unknown). A timeout → paths already seen keep
 * their commit time (a newest-first sighting is final), unseen paths are `undefined`.
 */
export async function lastCommitAtManyViaGit(
  repoRoot: string,
  relPaths: readonly string[],
  opts: GitSpawnOptions = {},
): Promise<Map<string, number | null | undefined>> {
  const result = new Map<string, number | null | undefined>();
  const paths = [...new Set(relPaths)];
  for (const path of paths) result.set(normalizedRepoPath(path), null);
  const marker = '__PAPERCUSP_LAST_COMMIT__';
  const requested = new Set(paths.map(normalizedRepoPath));
  let unseen = requested.size;
  let commitSec: number | undefined;
  const outcome = await streamGitFields(
    ['-C', repoRoot, 'log', `--pretty=format:${marker}%ct%x00`, '--name-only', '-z', '--', ...paths],
    (field) => {
      const record = field.trim();
      if (record.startsWith(marker)) {
        const parsed = Number.parseInt(record.slice(marker.length), 10);
        commitSec = Number.isFinite(parsed) ? parsed : undefined;
        return false;
      }
      if (commitSec === undefined || !record) return false;
      const path = normalizedRepoPath(record);
      if (requested.has(path) && result.get(path) === null) {
        result.set(path, commitSec);
        unseen -= 1;
      }
      return unseen === 0;
    },
    opts,
  );
  if (outcome === 'failed') {
    // Keep undefined distinct from null: git failure is unknown, while null is a valid
    // successful answer for a path with no history.
    for (const path of requested) result.set(path, undefined);
  } else if (outcome === 'timeout') {
    for (const path of requested) if (result.get(path) === null) result.set(path, undefined);
  }
  return result;
}

const defaultLastCommitAtMany: GitLastCommitBatchProbe = (repoRoot, relPaths) =>
  lastCommitAtManyViaGit(repoRoot, relPaths);

/** Submodule prefixes parsed from `.gitmodules`. Failure yields [] — see the caller. */
const defaultSubmodulePrefixes = (repoRoot: string): readonly string[] => {
  try {
    const raw = readFileSync(nodePath.join(repoRoot, '.gitmodules'), 'utf8');
    return [...raw.matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((m) => m[1].trim()).filter((p) => p.length > 0);
  } catch {
    return [];
  }
};

/**
 * Seconds since the epoch for a Date, an epoch number (s or ms), or a parseable string.
 * `undefined` for anything unparseable — which makes the whole check silent rather than
 * letting a malformed timestamp define a window.
 */
function epochSeconds(value: unknown): number | undefined {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms / 1000 : undefined;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return value > 1_000_000_000_000 ? value / 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1_000_000_000_000 ? numeric / 1000 : numeric;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : undefined;
}

/**
 * Paths in `filesChanged` that exist in this tree but that this work never touched.
 *
 * `since` is the moment the work began — the caller passes the EARLIEST of the item's
 * created/claimed timestamps, because a wider window can only clear paths.
 *
 * Returns `undefined` when there is nothing confident to say — no declared paths, no
 * usable root, no usable window, or every path was cleared or unjudgeable. A caller may
 * treat a returned finding as grade-bearing; `undefined` must always mean "grade as
 * before".
 */
export async function untouchedPathsInCompletion(
  evidence: CompletionVerificationEvidence | null | undefined,
  since: unknown,
  probe: UntouchedPathProbe = {},
): Promise<{ untouched: UntouchedPathHit[]; since: string } | undefined> {
  const declared = evidence?.filesChanged;
  if (!declared?.length) return undefined;

  // No window means no question to ask. Never fall back to "assume the work started now",
  // which would report every path as untouched.
  const sinceSec = epochSeconds(since);
  if (sinceSec === undefined) return undefined;
  const cutoffSec = sinceSec - UNTOUCHED_GRACE_SEC;

  // `in` rather than `??`, matching the sibling detector: an EXPLICIT empty roots list
  // means "I could not resolve a root, do not guess", which differs from omitting it.
  const rawRoots = 'repoRoots' in probe ? probe.repoRoots : undefined;
  const repoRoots = [
    ...new Set(
      (rawRoots ?? [])
        .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
        .map((r) => nodePath.resolve(r)),
    ),
  ];
  if (repoRoots.length === 0) return undefined;

  const exists = probe.exists ?? ((abs: string) => existsSync(abs));
  const isDirtyMany = probe.isDirtyMany ?? defaultIsDirtyMany;
  const lastCommitAtMany = probe.lastCommitAtMany ?? defaultLastCommitAtMany;
  const submodulePrefixes = probe.submodulePrefixes ?? defaultSubmodulePrefixes;

  const submodulesByRoot = new Map<string, readonly string[]>();
  const submodulesFor = (root: string): readonly string[] => {
    if (!submodulesByRoot.has(root)) {
      let prefixes: readonly string[] = [];
      try {
        prefixes = submodulePrefixes(root) ?? [];
      } catch {
        prefixes = [];
      }
      submodulesByRoot.set(root, prefixes);
    }
    return submodulesByRoot.get(root) ?? [];
  };

  // Build the batch inputs once. Invalid/escaping paths are excluded before invoking git,
  // while existence and submodule checks remain in the per-path decision loop below.
  const batchPathsByRoot = new Map<string, string[]>();
  for (const raw of declared.slice(0, MAX_UNTOUCHED_PROBES)) {
    const declaredPath = (raw ?? '').trim();
    if (
      !declaredPath ||
      declaredPath.includes('*') ||
      declaredPath.includes('?') ||
      nodePath.isAbsolute(declaredPath)
    ) {
      continue;
    }
    for (const repoRoot of repoRoots) {
      let abs: string;
      try {
        abs = nodePath.resolve(repoRoot, declaredPath);
      } catch {
        continue;
      }
      if (abs !== repoRoot && !abs.startsWith(repoRoot + nodePath.sep)) continue;
      const norm = declaredPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (submodulesFor(repoRoot).some((p) => norm === p || norm.startsWith(p.replace(/\/$/, '') + '/'))) {
        continue;
      }
      const paths = batchPathsByRoot.get(repoRoot) ?? [];
      if (!paths.includes(declaredPath)) paths.push(declaredPath);
      batchPathsByRoot.set(repoRoot, paths);
    }
  }

  const dirtyByRoot = new Map<string, ReadonlyMap<string, boolean | undefined>>();
  const commitsByRoot = new Map<string, ReadonlyMap<string, number | null | undefined>>();
  const dirtyAt = async (repoRoot: string, path: string): Promise<boolean | undefined> => {
    if (probe.isDirty) return probe.isDirty(repoRoot, path);
    if (!dirtyByRoot.has(repoRoot)) {
      try {
        dirtyByRoot.set(repoRoot, await isDirtyMany(repoRoot, batchPathsByRoot.get(repoRoot) ?? []));
      } catch {
        dirtyByRoot.set(repoRoot, new Map());
      }
    }
    const values = dirtyByRoot.get(repoRoot);
    return values?.get(normalizedRepoPath(path)) ?? values?.get(path);
  };
  const commitAt = async (repoRoot: string, path: string): Promise<number | null | undefined> => {
    if (probe.lastCommitAt) return probe.lastCommitAt(repoRoot, path);
    if (!commitsByRoot.has(repoRoot)) {
      try {
        commitsByRoot.set(repoRoot, await lastCommitAtMany(repoRoot, batchPathsByRoot.get(repoRoot) ?? []));
      } catch {
        commitsByRoot.set(repoRoot, new Map());
      }
    }
    const values = commitsByRoot.get(repoRoot);
    return values?.get(normalizedRepoPath(path)) ?? values?.get(path);
  };

  const untouched: UntouchedPathHit[] = [];

  for (const raw of declared.slice(0, MAX_UNTOUCHED_PROBES)) {
    const declaredPath = (raw ?? '').trim();
    // A glob describes many files; it is not a claim that one path was changed.
    if (!declaredPath || declaredPath.includes('*') || declaredPath.includes('?')) continue;
    // An absolute path names another tree we have no standing to judge.
    if (nodePath.isAbsolute(declaredPath)) continue;

    let verdictSec: number | undefined;
    let clearedByAnyRoot = false;

    for (const repoRoot of repoRoots) {
      let abs: string;
      try {
        abs = nodePath.resolve(repoRoot, declaredPath);
      } catch {
        continue;
      }
      // Escapes the root (`../`) → outside our standing to judge.
      if (abs !== repoRoot && !abs.startsWith(repoRoot + nodePath.sep)) continue;

      // Under a submodule the superproject tracks only the gitlink, so `git log` there is
      // empty for a REAL file and `git status` reports the gitlink rather than the file.
      // Judging here would manufacture a confident false accusation (EI-21138854971082896).
      const norm = declaredPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (submodulesFor(repoRoot).some((p) => norm === p || norm.startsWith(p.replace(/\/$/, '') + '/'))) {
        clearedByAnyRoot = true;
        break;
      }

      let onDisk: boolean;
      try {
        onDisk = exists(abs);
      } catch {
        continue; // fs error → cannot judge under this root
      }
      // Absent from disk is P-001's population, never this one. Clearing here is what keeps
      // the two findings disjoint, so one defect can never be graded twice.
      if (!onDisk) {
        clearedByAnyRoot = true;
        break;
      }

      // Proof-of-work route 1: the edit is present but not yet swept by git-sync.
      let dirty: boolean | undefined;
      try {
        dirty = await dirtyAt(repoRoot, declaredPath);
      } catch {
        dirty = undefined;
      }
      if (dirty === undefined) continue; // cannot judge under this root
      if (dirty) {
        clearedByAnyRoot = true;
        break;
      }

      // Proof-of-work route 2: git-sync already swept the edit into a commit.
      let commitSec: number | null | undefined;
      try {
        commitSec = await commitAt(repoRoot, declaredPath);
      } catch {
        commitSec = undefined;
      }
      // Unknown is neither an exoneration nor an accusation — it is silence.
      if (commitSec === undefined || commitSec === null || !Number.isFinite(commitSec)) continue;
      if (commitSec >= cutoffSec) {
        clearedByAnyRoot = true;
        break;
      }
      // Judged under this root: on disk, clean, and last committed before the work began.
      verdictSec = commitSec;
    }

    if (!clearedByAnyRoot && verdictSec !== undefined) {
      untouched.push({ path: declaredPath, lastCommitAt: new Date(verdictSec * 1000).toISOString() });
    }
  }

  return untouched.length > 0
    ? { untouched, since: new Date(sinceSec * 1000).toISOString() }
    : undefined;
}
