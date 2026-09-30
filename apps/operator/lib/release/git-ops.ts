/**
 * Git primitives for the release-gating system — plan
 * release-gate-ready-branch-2026-06-04.
 *
 * Pure git wrappers (no operator/DB deps) so the green-checkpoint + deploy +
 * rollback scripts share one tested implementation, and so they run standalone
 * even when the operator is down.
 *
 * Invariant: the green pin (`releaseRef` — the **`main` branch** since the
 * staging→main cutover, `staging-branch-pipeline-2026-06-06`) only ever
 * FAST-FORWARDS along the integration branch (`staging`) — never a merge,
 * never backward. The release worktree is DETACHED and the integration tree
 * lives on `staging`, so `git branch -f main` is always free to move.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const pexec = promisify(execFile);

export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', ['-C', repo, ...args], {
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function revParse(repo: string, ref: string): Promise<string> {
  return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

export async function currentSha(repo: string): Promise<string> {
  return revParse(repo, 'HEAD');
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  try {
    await revParse(repo, ref);
    return true;
  } catch {
    return false;
  }
}

/** Newest commit on `ref` whose commit time is ≤ `beforeUnixSec` (first-parent walk),
 *  or null when none qualifies. The quiet-cut primitive: "the tip as of T". */
export async function revListBefore(repo: string, ref: string, beforeUnixSec: number): Promise<string | null> {
  const out = await git(repo, ['rev-list', '-1', '--first-parent', `--before=${beforeUnixSec}`, ref]);
  return out || null;
}

/** Unix commit time (seconds) of `ref`. */
export async function commitUnixTime(repo: string, ref: string): Promise<number> {
  return Number(await git(repo, ['show', '-s', '--format=%ct', ref]));
}

/** True iff `ancestor` is an ancestor of (or equal to) `descendant`.
 *
 * A non-ancestor is a normal negative result (git exit 1). Any other git
 * failure is indeterminate — notably exit 128 when a SHA belongs to a
 * different repository — and must remain visible to callers instead of being
 * misreported as a normal negative result.
 */
export async function isAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error: unknown) {
    const code = (error as { code?: unknown })?.code;
    if (Number(code) === 1) return false;
    throw error;
  }
}

export interface AdvanceResult {
  advanced: boolean;
  from: string | null;
  to: string;
  /** created | fast-forwarded | already-at-candidate | not-fast-forward */
  reason: 'created' | 'fast-forwarded' | 'already-at-candidate' | 'not-fast-forward';
}

/**
 * Move `ready` to `candidate` — ONLY as a fast-forward (candidate must be a
 * descendant of current ready). Creates `ready` if it doesn't exist. Never
 * merges, never rewinds. This is the green-checkpoint's only write to a BRANCH; `recordJudgedRed`
 * below also writes, but to a refs/papercusp/ marker that is not a branch and carries no promotion
 * meaning (WI-42350).
 */
export async function advanceReady(
  repo: string,
  candidate: string,
  readyRef = 'ready',
): Promise<AdvanceResult> {
  const to = await revParse(repo, candidate);
  if (!(await refExists(repo, readyRef))) {
    await git(repo, ['branch', readyRef, to]);
    return { advanced: true, from: null, to, reason: 'created' };
  }
  const from = await revParse(repo, readyRef);
  if (from === to) return { advanced: false, from, to, reason: 'already-at-candidate' };
  if (!(await isAncestor(repo, from, to))) {
    return { advanced: false, from, to, reason: 'not-fast-forward' };
  }
  await git(repo, ['branch', '-f', readyRef, to]);
  return { advanced: true, from, to, reason: 'fast-forwarded' };
}

/** The ref the gate stamps with the sha of the last candidate it actually reached a RED verdict
 *  on. Namespaced under refs/papercusp/ so it is not a branch: it never appears in `git branch`,
 *  is not pushed by default, and cannot be confused with the green pin. */
export const JUDGED_RED_REF = 'refs/papercusp/judged-red';

/**
 * WI-42350 — read the sha this repo last reached a RED verdict on, or null.
 *
 * WHY A REF AND NOT THE DATABASE: the gate's candidate decision runs before any DB is consulted,
 * and `gate_health` (which does hold the last verdict) is written by the ROUTINE, not read inside
 * the run's decision path. Reaching for it there would put a new Postgres dependency into the one
 * code path that must work on a filesystem alone — which is exactly why this item stalled. The
 * green pin already proves the pattern: `lastReady` is a plain `revParse` of a ref.
 */
export async function lastJudgedRed(repo: string, ref = JUDGED_RED_REF): Promise<string | null> {
  return (await refExists(repo, ref)) ? revParse(repo, ref) : null;
}

/**
 * Stamp `sha` as the last RED-judged candidate.
 *
 * Deliberately NOT fast-forward-only, unlike `advanceReady`: reds are not monotonic. A later red
 * can land on a commit that is not a descendant of the previous red (the tip moves, a repair
 * queue rewinds, a quiet-cut judges an older commit), and refusing those would freeze the marker
 * at a stale sha — which reads as "we already judged this" for a commit we never judged. That is
 * the one failure mode that could make the caller SKIP real work, so this write always sets.
 *
 * Fail-open by contract: the caller treats a throw as "no marker", costing one redundant run.
 * Never let a marker write turn into a gate verdict.
 */
export async function recordJudgedRed(repo: string, sha: string, ref = JUDGED_RED_REF): Promise<void> {
  await git(repo, ['update-ref', ref, await revParse(repo, sha)]);
}

/** Files changed between two commits (name-only). `from` null → empty. */
export async function changedFiles(
  repo: string,
  from: string | null,
  to: string,
  options: { deletedOnly?: boolean } = {},
): Promise<string[]> {
  if (!from) return [];
  // Treat rename sources as deletions for an explicit-file compiler selection.
  // Default callers still receive every change, including deletions.
  const out = await git(repo, [
    'diff', '--name-only',
    ...(options.deletedOnly ? ['-z', '--no-renames', '--diff-filter=D'] : []),
    `${from}..${to}`,
  ]);
  return out ? out.split(options.deletedOnly ? '\0' : '\n').filter(Boolean) : [];
}

/** SQL migration files newly added/changed between commits (deploy-staged schema).
 *
 * EI-856: submodule-aware. `libs/papercusp` (which holds `libs/db/sql/`) is a
 * git SUBMODULE — a migration landing entirely inside it shows up in the
 * SUPERPROJECT's own `git diff` only as the gitlink pointer moving, never as
 * the actual `.sql` path, so the plain `changedFiles` filter above silently
 * reports `[]` for a real migration. Two consumers relied on this being
 * accurate and were both wrong for a submodule-only migration: the deploy
 * plan's displayed `migrationCount`, and deploy.ts's `plan.migrations.length
 * > 0` gate that decides whether `rollback-db` (restoreSnapshot) runs at all —
 * so a submodule migration both under-reported AND silently disabled the
 * DB-rollback safety net. Fixed by ALSO diffing the submodule's own commit
 * history between its two pinned shas (submodulePins) and folding in any
 * matched migration paths (fail-soft: a diff hiccup there degrades to the
 * superproject-only result, never throws — this is a gate INPUT, and a
 * probe fault must never block the deploy pipeline it feeds). */
export async function migrationsBetween(
  repo: string,
  from: string | null,
  to: string,
): Promise<string[]> {
  const files = await changedFiles(repo, from, to);
  const superprojectMigrations = files.filter((f) => /(^|\/)libs\/papercusp\/libs\/db\/sql\/\d[^/]*\.sql$/.test(f));
  if (!from) return superprojectMigrations;
  const submoduleMigrations = await migrationsBetweenInSubmodule(repo, from, to, 'libs/papercusp');
  return [...new Set([...superprojectMigrations, ...submoduleMigrations])];
}

/**
 * Diff a submodule's OWN history between its gitlink pin at `from` and its pin
 * at `to` (both commit-ish in the SUPERPROJECT `repo`), returning EVERY changed
 * path prefixed with `submodulePath` so it reads consistently with the
 * superproject-relative paths callers already collect.
 *
 * Deliberately does NOT catch: the two callers want opposite things from a
 * failure. `migrationsBetween` wants to degrade silently to the superproject
 * result; `changedFilesRecursive` needs to KNOW it failed so it can report the
 * range as skew-undetermined rather than claiming nothing changed (see
 * EI-19365565179927273 — a silent [] there is exactly the false confidence that
 * sends agents to chase phantom regressions). A `[]` from this function means
 * "the pin genuinely moved and no files differ"; a throw means "could not tell".
 *
 * Pass `pins` when the caller has already read them, so a sweep over N
 * submodules does not re-run `ls-tree -r` 2N times.
 */
export async function changedFilesInSubmodule(
  repo: string,
  from: string,
  to: string,
  submodulePath: string,
  pins?: { from: Map<string, string>; to: Map<string, string> },
  options: { deletedOnly?: boolean } = {},
): Promise<string[]> {
  const [pinsFrom, pinsTo] = pins
    ? [pins.from, pins.to]
    : await Promise.all([submodulePins(repo, from), submodulePins(repo, to)]);
  const fromPin = pinsFrom.get(submodulePath);
  const toPin = pinsTo.get(submodulePath);
  // Gone at `to` — its files do not exist at tip, so nothing there can be a failing
  // test that a reader could re-verify. Unchanged pin — genuinely nothing changed.
  if (!toPin || fromPin === toPin) return [];
  const submoduleRepo = join(repo, submodulePath);
  // ADDED in range (no pin at `from`): every file in it is new, so every file changed.
  // Skipping this case would put a failing test in a newly-vendored submodule right back
  // in the blind spot — reported as "not modified in range", i.e. presumptively a real red.
  const files = fromPin
    ? await changedFiles(submoduleRepo, fromPin, toPin, options)
    : options.deletedOnly ? []
      : (await git(submoduleRepo, ['ls-tree', '-r', '--name-only', toPin])).split('\n').filter(Boolean);
  // Paths here are relative to the SUBMODULE root (e.g. `libs/papercusp/`), so a
  // migration reads as `libs/db/sql/...` from inside it — re-prefix with the mount
  // path for a consistent, superproject-relative result callers can compare directly.
  return files.map((f) => `${submodulePath}/${f}`);
}

/**
 * Migration paths inside a submodule. Fail-soft (a shallow clone missing the pin
 * commit, a detached/uninitialized submodule, a pin that didn't move) — returns
 * `[]` rather than throwing, since this only ENRICHES the superproject diff and
 * must never block the deploy pipeline it feeds.
 */
async function migrationsBetweenInSubmodule(
  repo: string,
  from: string,
  to: string,
  submodulePath: string,
): Promise<string[]> {
  try {
    const files = await changedFilesInSubmodule(repo, from, to, submodulePath);
    return files.filter((f) => /(^|\/)libs\/db\/sql\/\d[^/]*\.sql$/.test(f));
  } catch {
    return [];
  }
}

/** The result of a range diff that also looked INSIDE submodules. */
export interface RangeChangeSet {
  /** Superproject paths, plus every changed submodule file prefixed with its mount path. */
  files: string[];
  /** Submodules whose pin MOVED but whose contents could not be diffed. Non-empty
   *  means "some of this range is unknown" — never report such a range as clean. */
  unexpandedSubmodules: string[];
}

/**
 * `changedFiles`, with moved gitlinks EXPANDED into the files inside them.
 *
 * EI-19365565179927273: a plain superproject `git diff --name-only` reports a
 * submodule bump as the bare gitlink DIRECTORY (`libs/generic/memory`) and NEVER
 * as the files inside it. Any consumer that matches a file path against that diff
 * is therefore structurally blind to every one of this repo's 39 submodules —
 * silently, and only ever in the direction of "nothing changed here".
 *
 * That blindness has now cost real time twice, in two different consumers, from
 * the same root cause: EI-856 (a migration inside `libs/papercusp` both
 * under-reported `migrationCount` AND silently disabled the DB-rollback safety
 * net) and EI-19365565179927273 (the green-checkpoint skew detector reported a
 * submodule-pinned test fix as "presumptively a real red", sending agents to
 * re-diagnose 6 already-correct embedder tests). Hence one shared expansion here
 * rather than a third per-consumer workaround.
 *
 * Only submodules whose pin actually MOVED are diffed, so the cost scales with
 * the bump count, not the 39 submodules. Fail-soft: a probe fault degrades to the
 * superproject-only list, but names the submodule in `unexpandedSubmodules` so the
 * caller can say "undetermined" instead of "unchanged".
 */
export async function changedFilesRecursive(
  repo: string,
  from: string | null,
  to: string,
  options: { deletedOnly?: boolean } = {},
): Promise<RangeChangeSet> {
  const files = await changedFiles(repo, from, to, options);
  if (!from) return { files, unexpandedSubmodules: [] };

  let moved: string[];
  try {
    const [pinsFrom, pinsTo] = await Promise.all([submodulePins(repo, from), submodulePins(repo, to)]);
    // A submodule ADDED in range (absent from pinsFrom) counts as moved: all of its
    // files are new in this range. Only an UNCHANGED pin is skipped.
    moved = [...pinsTo].filter(([path, sha]) => pinsFrom.get(path) !== sha).map(([path]) => path);
    if (moved.length === 0) return { files, unexpandedSubmodules: [] };

    const expanded: string[] = [];
    const unexpandedSubmodules: string[] = [];
    for (const path of moved) {
      try {
        expanded.push(...(await changedFilesInSubmodule(repo, from, to, path, { from: pinsFrom, to: pinsTo }, options)));
      } catch {
        unexpandedSubmodules.push(path);
      }
    }
    return { files: [...new Set([...files, ...expanded])], unexpandedSubmodules };
  } catch {
    // Could not even enumerate the pins — the same read that just produced a
    // successful diff, so effectively unreachable. Degrade to superproject-only
    // rather than inventing an unexpanded list we have no evidence for.
    return { files, unexpandedSubmodules: [] };
  }
}

/** One line per commit between two shas (oldest-last), for the release review. */
export async function commitsBetween(
  repo: string,
  from: string | null,
  to: string,
): Promise<string[]> {
  if (!from) return [];
  const out = await git(repo, ['log', '--oneline', '--no-decorate', `${from}..${to}`]);
  return out ? out.split('\n').filter(Boolean) : [];
}

/**
 * Full-length (40-char) SHA of EVERY commit in `from..to` (EI-14601). A batched
 * fast-forward deploy lands N commits at once, but the deploy-landed event only ever
 * carried `payload.sha = targetSha` (the tip) — an agent awaiting the exact sha of an
 * earlier commit in the same batch (via `deploy:await{sha}`'s per-sha key, or a raw
 * `events:await` payload_filter on `sha`) would silently time out even though its
 * commit DID ship, because the exact-match never fires for anything but the tip. This
 * gives the deploy emitter the full commit list so it can fire the per-sha key for
 * every commit actually included, not just the target. `from: null` (first deploy —
 * no meaningful range) or an empty range returns `[]`.
 */
export async function commitShasBetween(
  repo: string,
  from: string | null,
  to: string,
): Promise<string[]> {
  if (!from) return [];
  const out = await git(repo, ['rev-list', `${from}..${to}`]);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Push a local ref to a remote (green-checkpoint publishes `ready`). */
export async function pushRef(repo: string, ref: string, remote = 'origin'): Promise<void> {
  await git(repo, ['push', remote, `${ref}:${ref}`]);
}

/** The gitlink sha each top-level submodule is pinned to at a given commit-ish. */
export async function submodulePins(
  repo: string,
  ref = 'HEAD',
): Promise<Map<string, string>> {
  const out = await git(repo, ['ls-tree', '-r', ref]);
  const pins = new Map<string, string>();
  for (const line of out.split('\n')) {
    // mode type sha\tpath  — gitlinks have type 'commit'
    const m = line.match(/^\d+ commit ([0-9a-f]{40})\t(.+)$/);
    if (m) pins.set(m[2], m[1]);
  }
  return pins;
}
