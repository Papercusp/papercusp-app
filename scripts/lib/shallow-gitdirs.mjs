/**
 * Detect a git repository in this checkout that has silently become SHALLOW.
 *
 * WHY THIS EXISTS (measured 2026-08-18, self-inflicted and repaired the same day)
 * An agent probing what a submodule's remote contains ran `git fetch --depth=1` against
 * four submodules OF THE SHARED CHECKOUT. That converts each one into a shallow repository.
 * There is no error, no output, and nothing for `git status` or the git-sync sweep to show,
 * because the damage lives entirely inside the gitdir:
 *
 *     papercusp-desktop  1595 -> 71 commits      libs/generic/sync   539 -> 38
 *     libs/papercusp     2963 -> 120 commits     libs/agent-chat     104 -> 3
 *
 * Two consequences, both of which mislead rather than fail loudly:
 *
 *   1. EVERY history-dependent read in that repo silently answers WRONG — `git log`,
 *      `git blame`, `merge-base`, "is my fix an ancestor of the candidate", the delta gate.
 *      They do not error at the graft boundary; they just stop, and report the truncated
 *      answer with full confidence.
 *   2. A shallow repository CANNOT PUSH ("shallow update not allowed"). On this tree that
 *      is worse than it sounds: it produces a push failure indistinguishable from whatever
 *      else is blocking pushes, and it lands on exactly the repos someone was investigating.
 *      The 2026-08-18 instance shallowed the four submodules whose unpublished gitlinks
 *      were under investigation, so the self-inflicted damage read as the incident guard's.
 *
 * WHAT THIS ASSERTS. No repository reachable from this checkout's gitdir — the superproject
 * or any submodule at any nesting depth — carries a `shallow` graft file. The check is over
 * the gitdir layout rather than a hardcoded submodule list, so a submodule added tomorrow is
 * covered by construction.
 *
 * THE REPAIR IS CHEAP, WHICH IS THE OTHER REASON TO DETECT IT. `--depth` writes grafts but
 * DELETES NOTHING, so the boundary commits' parents are almost always still in the object
 * store and no network fetch is needed — see repairInstructions() for the exact sequence.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A `shallow` file lists one graft sha per line. Git deletes the file on unshallow, but an
 * empty leftover is not a shallow repository and reporting one would be a false positive.
 *
 * @returns {string[]} the graft shas, or [] if the file is absent/empty/unreadable.
 */
export function readGrafts(shallowPath) {
  try {
    return readFileSync(shallowPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** How the superproject is named in a report, distinct from any submodule path. */
export const SUPERPROJECT_LABEL = '(superproject)';

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * A gitdir is a directory containing a `HEAD` file. Under `<gitdir>/modules` the entries are
 * a MIX of gitdirs and bare path components: `libs/sync` stores the gitdir at
 * `.git/modules/libs/sync`, where `libs` is only a directory in the path. Discriminating on
 * HEAD walks both without needing to know which is which, and recursing through a gitdir's
 * own `modules/` picks up submodules-of-submodules at any depth.
 *
 * Only `modules/` is ever descended into, so this never walks `objects/` — the check stays
 * a handful of stats even on a large tree.
 */
function collectGitdirs(gitdir, label, out) {
  out.push({ gitdir, label });
  const modules = join(gitdir, 'modules');
  if (!isDir(modules)) return;

  // A submodule's own submodules are labelled UNDER it (`libs/papercusp/libs/db`), not by
  // their bare inner path: two parents can each carry a `libs/db`, and a report that named
  // both the same would send someone to repair the wrong gitdir.
  const qualify = (name) => (label === SUPERPROJECT_LABEL ? name : `${label}/${name}`);

  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (existsSync(join(child, 'HEAD'))) collectGitdirs(child, qualify(name), out);
      else walk(child, name);
    }
  };
  walk(modules, '');
}

/**
 * @param {{ gitCommonDir: string }} args `git rev-parse --git-common-dir`, made absolute.
 * @returns {Array<{ label: string, gitdir: string, shallowFile: string, grafts: string[] }>}
 *   one entry per shallow repository. Empty === healthy.
 */
export function findShallowGitdirs({ gitCommonDir }) {
  if (!isDir(gitCommonDir)) return [];

  const gitdirs = [];
  collectGitdirs(gitCommonDir, SUPERPROJECT_LABEL, gitdirs);

  const problems = [];
  for (const { gitdir, label } of gitdirs) {
    const shallowFile = join(gitdir, 'shallow');
    const grafts = readGrafts(shallowFile);
    if (grafts.length > 0) problems.push({ label, gitdir, shallowFile, grafts });
  }
  return problems;
}

/**
 * The repair, spelled out because the obvious one is wrong. `git fetch --unshallow` needs
 * the network and fails outright when the remote no longer carries the history — but it is
 * usually unnecessary: the objects never left. Verify that first, and the fix is deleting a
 * file. Deleting it WITHOUT verifying is the one way to turn a recoverable state into a
 * corrupt one, which is why the parent check leads.
 */
export function repairInstructions(problem) {
  return [
    `${problem.label}: shallow (${problem.grafts.length} graft${problem.grafts.length === 1 ? '' : 's'}) — ${problem.shallowFile}`,
    '      1. confirm the history is still local — for each graft sha in that file:',
    '           git cat-file commit <graft> | awk \'/^parent /{print $2} /^$/{exit}\'',
    '           git -C <repo> cat-file -e <parent>^{commit}   # every parent must be PRESENT',
    '      2. if all present: back the file up, then delete it (no network needed)',
    '      3. verify: rev-parse --is-shallow-repository = false, rev-list --count HEAD',
    '         restored, and fsck --connectivity-only clean',
    '      if a parent is genuinely absent, use `git -C <repo> fetch --unshallow origin` instead',
  ].join('\n');
}

/** Formats problems for a human staring at a failing check. Exported for the test. */
export function formatShallowProblems(problems) {
  return [
    problems.map(repairInstructions).join('\n    '),
    '',
    '    A shallow repo answers history queries (log/blame/merge-base/delta gate) WRONG',
    '    without erroring, and cannot push ("shallow update not allowed").',
    '    Never run `git fetch --depth=N` against this tree — clone to /tmp to probe a remote.',
  ].join('\n');
}
