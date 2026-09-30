#!/usr/bin/env node
/**
 * Scan for the WI-39377 signature: a commit that DELETED ~all of a repo's tracked
 * files and was committed anyway (by git-sync, which sweeps the whole tree on a timer
 * and cannot tell a catastrophic wipe from an intentional deletion).
 *
 * Why this needs a dedicated scanner: the destroyed state is the COMMITTED state, so
 * `git status` is clean in both the superproject and the submodule, `git submodule
 * status` reports the submodule as properly checked out at a SHA, and the only visible
 * symptom is a downstream resolution failure ("Failed to resolve import @papercusp/x")
 * that looks like a config problem. Nothing alarms. On SideStage this destroyed four
 * submodules and was pushed to GitHub before anyone noticed.
 *
 * Signature: for commit C with parent P,
 *     deletedFiles(P -> C) / treeSize(P) >= --threshold   (default 0.8)
 * and treeSize(P) >= --min-parent-files (default 5, so a 1-file repo cannot trip it).
 *
 * READ-ONLY. Runs `git` in each repo and writes nothing.
 *
 * Usage:
 *   node scripts/scan-catastrophic-deletion-commits.mjs [--since 2026-08-15T20:00:00Z]
 *        [--roots a,b] [--threshold 0.8] [--min-parent-files 5] [--json]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const SINCE = flag('since', '2026-08-15T20:00:00Z');
const THRESHOLD = Number(flag('threshold', '0.8'));
const MIN_PARENT_FILES = Number(flag('min-parent-files', '5'));
const AS_JSON = has('json');
const DEFAULT_ROOTS = [
  `${process.env.HOME}/papercupai-workspace`,
  `${process.env.HOME}/.papercusp/hives`,
];
const ROOTS = flag('roots', '')
  ? flag('roots', '').split(',').filter(Boolean)
  : DEFAULT_ROOTS;

/** Run git in `cwd`; return trimmed stdout, or null if git failed (missing object, corrupt repo, …). */
function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
    }).trim();
  } catch {
    return null;
  }
}

const lines = (s) => (s ? s.split('\n').filter(Boolean) : []);

/** A directory is a git working tree if it has a .git dir (repo) or .git file (submodule). */
const isRepo = (dir) => existsSync(join(dir, '.git'));

/** Repo working trees: each root's immediate children, plus each of their submodules. */
function discoverRepos(roots) {
  const found = new Set();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const dir = join(root, e.name);
      let real;
      try {
        real = statSync(dir).isDirectory() ? dir : null;
      } catch {
        continue; // broken symlink
      }
      if (!real || !isRepo(real)) continue;
      found.add(real);
      // one level of submodules — that is where the SideStage destruction landed
      for (const p of lines(git(real, ['config', '-f', '.gitmodules', '--get-regexp', 'submodule\\..*\\.path']))) {
        const rel = p.split(/\s+/)[1];
        if (!rel) continue;
        const sub = join(real, rel);
        if (isRepo(sub)) found.add(sub);
      }
    }
  }
  return [...found].sort();
}

function treeSize(cwd, rev) {
  const out = git(cwd, ['ls-tree', '-r', '--name-only', rev]);
  return out === null ? null : lines(out).length;
}

function scanRepo(cwd) {
  const commits = lines(git(cwd, ['log', `--since=${SINCE}`, '--format=%H %cI', '--all']));
  const hits = [];
  for (const line of commits) {
    const [sha, when] = line.split(' ');
    const parents = lines(git(cwd, ['rev-list', '--parents', '-n', '1', sha]))[0]?.split(' ').slice(1) ?? [];
    if (parents.length !== 1) continue; // merges have no single "before" to compare against
    const parent = parents[0];
    const parentFiles = treeSize(cwd, parent);
    if (parentFiles === null || parentFiles < MIN_PARENT_FILES) continue;
    const deleted = lines(git(cwd, ['diff', '--name-only', '--diff-filter=D', parent, sha])).length;
    const ratio = deleted / parentFiles;
    if (ratio < THRESHOLD) continue;
    const childFiles = treeSize(cwd, sha);
    hits.push({
      repo: cwd,
      sha: sha.slice(0, 10),
      when,
      parent: parent.slice(0, 10),
      parentFiles,
      deleted,
      childFiles,
      ratio: Number(ratio.toFixed(3)),
      subject: git(cwd, ['log', '-1', '--format=%s', sha]) ?? '',
      // Is the damage still LIVE? A wipe that was already restored is history, not an incident.
      headHasPackageJson: lines(git(cwd, ['ls-tree', '-r', '--name-only', 'HEAD'])).includes('package.json'),
      headFiles: treeSize(cwd, 'HEAD'),
      headIsDescendant: git(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD']) !== null,
    });
  }
  return hits;
}

const repos = discoverRepos(ROOTS);
const allHits = [];
for (const r of repos) allHits.push(...scanRepo(r));

if (AS_JSON) {
  console.log(JSON.stringify({ since: SINCE, threshold: THRESHOLD, reposScanned: repos.length, hits: allHits }, null, 2));
} else {
  console.log(`scanned ${repos.length} repos since ${SINCE} (threshold ${THRESHOLD})`);
  if (allHits.length === 0) {
    console.log('NO catastrophic-deletion commits found.');
  } else {
    console.log(`\n${allHits.length} SUSPECT COMMIT(S):\n`);
    for (const h of allHits) {
      const live = h.headIsDescendant && !h.headHasPackageJson ? '  <-- DAMAGE LIVE AT HEAD' : '';
      console.log(
        `${h.repo}\n  ${h.sha} ${h.when}  deleted ${h.deleted}/${h.parentFiles} (${(h.ratio * 100).toFixed(0)}%) -> tree ${h.childFiles}` +
          `\n  HEAD: ${h.headFiles} files, package.json=${h.headHasPackageJson}${live}\n  "${h.subject}"\n`,
      );
    }
  }
}
process.exit(allHits.length > 0 ? 1 : 0);
