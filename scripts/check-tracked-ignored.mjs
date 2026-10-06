#!/usr/bin/env node
/**
 * check-tracked-ignored.mjs — fail-loud guard against tracked paths matched by a REPO-sourced
 * .gitignore rule, plus reserved scratch roots that may have no matching rule yet (WI-10002095,
 * EI-24493767544777917).
 *
 * This is the GENERAL form of lint:no-tracked-node-modules (WI-39630) and
 * lint:no-tracked-src-entry-dist (WI-10002064), which each cover one class. WI-10002095
 * measured four more at once — 1,969 superproject paths: `.papercup-console-active.*` (685),
 * `.next/` (576), `**​/.papercusp/scratch/` (529), `**​/.tmp-claude/` (137), plus `out/`,
 * `__pycache__`, `*.wav`, `test-results/`, `junit.xml` — and only the measurement found them.
 *
 * WHY IT MATTERS: a tracked path is never ignored, so the rule goes INERT while the file keeps
 * behaving as tracked content. Nothing errors. When churn deletes such a file it surfaces as a
 * ` D` row, git-sync hands git an explicit pathspec for an ignored path, git refuses
 * ("use -f"), and that repo's ENTIRE sync leg dies every tick (16 consecutive failing ticks
 * measured in WI-39630).
 *
 * INSTRUMENT TRAP (measured, WI-10002095): the intuitive probe
 *     git ls-files | git check-ignore --stdin
 * is TAUTOLOGICAL — check-ignore consults the index by default, where a tracked file is never
 * ignored, so it reports a clean 0 that reads exactly like "no contradictions". This guard uses
 * `git ls-files -i -c --exclude-standard` and `check-ignore --no-index -v`.
 *
 * Only REPO-sourced rules count (a relative `.gitignore` source). `.git/info/exclude` and the
 * user's global excludesFile are MACHINE-LOCAL — a checkout-specific opinion the next clone
 * does not share — so a path matched only by those is not actionable and is reported apart.
 *
 * FIX (index-only; the worktree is untouched):
 *     node scripts/check-tracked-ignored.mjs --print0 [--repo <submodule>] \
 *       | git [-C <submodule>] rm -q --cached --ignore-unmatch --pathspec-from-file=- --pathspec-file-nul
 * `--print0` also includes tracked reserved scratch paths even when no ignore rule matches;
 * then let git-sync commit the index-only removals.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { declaredSubmodules, describeUnscanned } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/** Tracked-on-purpose exceptions, as `<repo>:<path>`. Shrink-only: a new entry needs a reason. */
export const ALLOWLIST = new Set([]);

const git = (args, cwd, input) =>
  spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Parse `git check-ignore -v -z` output: NUL-terminated (source, line, pattern, pathname) tuples. */
export function parseCheckIgnoreVerbose(stdout) {
  const f = stdout.split('\0');
  const rows = [];
  for (let i = 0; i + 3 < f.length; i += 4) {
    rows.push({ source: f[i], line: f[i + 1], pattern: f[i + 2], path: f[i + 3] });
  }
  return rows;
}

/**
 * A rule is repo-sourced iff it lives in a RELATIVE `.gitignore` inside the worktree. Anything
 * else — `.git/info/exclude` (absolute, or `../../.git/modules/<n>/info/exclude` in a
 * submodule), or a global excludesFile — is machine-local.
 */
export function isRepoSourced(source) {
  return !isAbsolute(source) && basename(source) === '.gitignore';
}

/**
 * Tracked paths in `cwd` that an ignore rule also matches, split by rule provenance.
 * Throws on an instrument fault so a dead probe can never read as a clean verdict.
 */
export function listTrackedIgnored(cwd) {
  const ls = git(['ls-files', '-i', '-c', '--exclude-standard', '-z'], cwd);
  if (ls.status !== 0) throw new Error(`git ls-files failed in ${cwd}: ${ls.stderr.trim()}`);
  const listed = ls.stdout.split('\0').filter(Boolean);
  if (listed.length === 0) return { listed: 0, offenders: [], machineLocal: [] };
  const ci = git(['check-ignore', '--no-index', '-v', '-z', '--stdin'], cwd, listed.join('\0') + '\0');
  if (ci.status !== 0 && ci.status !== 1) throw new Error(`git check-ignore failed in ${cwd}: ${ci.stderr.trim()}`);
  const rows = parseCheckIgnoreVerbose(ci.stdout);
  if (rows.length === 0) {
    throw new Error(`ls-files listed ${listed.length} tracked-ignored path(s) in ${cwd} but check-ignore attributed none — instrument disagreement`);
  }
  return {
    listed: listed.length,
    offenders: rows.filter((r) => isRepoSourced(r.source)),
    machineLocal: rows.filter((r) => !isRepoSourced(r.source)),
  };
}

const RESERVED_TOP_LEVEL_SCRATCH_ROOTS = new Set([
  '.agent-tmp',
  '.tsx-tmp',
  'scratch',
  'scratchpad',
]);

/**
 * Paths whose root names identify machine-local scratch in the superproject.
 * Keep ordinary nested `scratch/` and `.tmp-*` source paths out of this set;
 * `.papercusp` children are handled only for the measured generated families.
 */
export function isTrackedScratchPath(path) {
  const parts = path.split('/');
  const root = parts[0] ?? '';
  if (
    RESERVED_TOP_LEVEL_SCRATCH_ROOTS.has(root) ||
    root === '.tmp' ||
    root.startsWith('.tmp-') ||
    root.startsWith('scratch-')
  ) {
    return true;
  }

  for (let index = 0; index + 1 < parts.length; index += 1) {
    if (parts[index] !== '.papercusp') continue;
    const child = parts[index + 1];
    if (
      child === 'node-compile-cache' ||
      child.startsWith('tsx-') ||
      child.startsWith('tmp-')
    ) {
      return true;
    }
  }
  return false;
}

export function findTrackedScratchPaths(paths) {
  return [...new Set(paths.filter(isTrackedScratchPath))].sort();
}

function listTrackedPaths(cwd) {
  const ls = git(['ls-files', '-z'], cwd);
  if (ls.status !== 0) throw new Error(`git ls-files failed in ${cwd}: ${ls.stderr.trim()}`);
  return ls.stdout.split('\0').filter(Boolean);
}

export function listTrackedScratchPaths(cwd) {
  return findTrackedScratchPaths(listTrackedPaths(cwd));
}

export function findOffenders({ repos, listOffenders, allowlist = ALLOWLIST }) {
  const out = [];
  for (const repo of repos) {
    const rows = (listOffenders(repo) ?? []).filter((r) => !allowlist.has(`${repo}:${r.path}`));
    if (rows.length > 0) out.push({ repo, rows });
  }
  return out;
}

export function discoverRepos(root = ROOT) {
  return ['.', ...declaredSubmodules(root).filter((repo) => existsSync(join(root, repo, '.git')))];
}

const cwdOf = (repo) => (repo === '.' ? ROOT : join(ROOT, repo));

function main() {
  const argv = process.argv.slice(2);
  const showList = argv.includes('--list');
  const repoArg = argv.includes('--repo') ? argv[argv.indexOf('--repo') + 1] : null;
  const repos = repoArg ? [repoArg] : discoverRepos();

  if (argv.includes('--print0')) {
    const paths = new Set();
    try {
      for (const repo of repos) {
        const cwd = cwdOf(repo);
        for (const r of listTrackedIgnored(cwd).offenders) paths.add(r.path);
        if (repo === '.') {
          for (const path of listTrackedScratchPaths(cwd)) paths.add(path);
        }
      }
    } catch (err) {
      console.error(`✖ check-tracked-ignored: ${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
    for (const path of [...paths].sort()) process.stdout.write(`${path}\0`);
    return;
  }

  const unscanned = declaredSubmodules(ROOT).filter((repo) => !discoverRepos().includes(repo));
  const coverageNote = describeUnscanned(unscanned, ROOT);

  let machineLocalTotal = 0;
  const byRepo = new Map();
  const scratchByRepo = new Map();
  try {
    // Positive control: a probe that can only ever say "clean" is not a guard.
    const trackedPaths = listTrackedPaths(ROOT);
    if (trackedPaths.length === 0) {
      console.error('✖ check-tracked-ignored: `git ls-files` reported ZERO tracked files in the superproject — the probe is broken; refusing to certify.');
      process.exit(2);
    }
    if (repos.includes('.')) {
      const scratchPaths = findTrackedScratchPaths(trackedPaths);
      if (scratchPaths.length > 0) scratchByRepo.set('.', scratchPaths);
    }

    for (const repo of repos) {
      const res = listTrackedIgnored(cwdOf(repo));
      machineLocalTotal += res.machineLocal.length;
      const rows = res.offenders.filter((r) => !ALLOWLIST.has(`${repo}:${r.path}`));
      if (rows.length > 0) byRepo.set(repo, rows);
    }
  } catch (err) {
    console.error(`✖ check-tracked-ignored: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }

  if (byRepo.size === 0 && scratchByRepo.size === 0) {
    console.log(`✓ check-tracked-ignored: ${repos.length} repo(s) scanned, no tracked path is matched by a repo .gitignore rule and no reserved scratch path is tracked (${machineLocalTotal} machine-local match(es) not counted).${coverageNote}`);
    return;
  }

  const ignoredTotal = [...byRepo.values()].reduce((n, rows) => n + rows.length, 0);
  const scratchTotal = [...scratchByRepo.values()].reduce((n, paths) => n + paths.length, 0);
  if (ignoredTotal > 0) {
    console.error(`✖ check-tracked-ignored: ${ignoredTotal} tracked path(s) are ALSO matched by a repo .gitignore rule, in ${byRepo.size} repo(s).\n`);
    for (const [repo, rows] of byRepo) {
      const byRule = new Map();
      for (const r of rows) {
        const k = `${r.source}:${r.line}  ${r.pattern}`;
        byRule.set(k, [...(byRule.get(k) ?? []), r.path]);
      }
      console.error(`  ${repo}  (${rows.length} tracked)`);
      for (const [rule, paths] of [...byRule].sort((a, b) => b[1].length - a[1].length)) {
        console.error(`    ${String(paths.length).padStart(5)}  ${rule}`);
        for (const p of showList ? paths : paths.slice(0, 2)) console.error(`            ${p}`);
      }
    }
  }
  if (scratchTotal > 0) {
    console.error(`✖ check-tracked-ignored: ${scratchTotal} tracked path(s) live under reserved superproject scratch roots, including paths with no matching .gitignore rule.`);
    for (const [repo, paths] of scratchByRepo) {
      console.error(`  ${repo}  (${paths.length} tracked scratch path(s))`);
      for (const path of showList ? paths : paths.slice(0, 2)) console.error(`            ${path}`);
    }
  }
  console.error(
    '\nWHY THIS MATTERS: a tracked path remains versioned even if .gitignore matches it, while a\n' +
      'tracked scratch path with no matching rule is swept by git-sync as repository content.\n' +
      '\nFIX (index-only, worktree untouched):\n' +
      [...byRepo.keys()]
        .map((repo) => `  node scripts/check-tracked-ignored.mjs --print0 --repo ${repo} | git -C ${repo} rm -q --cached --ignore-unmatch --pathspec-from-file=- --pathspec-file-nul`)
        .join('\n') +
      '\n\nThen let git-sync commit the removal. (Re-run with --list for every path.)',
  );
  if (coverageNote) console.error(`\nCoverage:${coverageNote}`);
  process.exit(1);
}

if (isCliEntry(import.meta.url)) main();
