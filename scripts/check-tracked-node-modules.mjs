#!/usr/bin/env node
/**
 * check-tracked-node-modules.mjs — fail-loud guard against a repo (the superproject
 * or ANY submodule) TRACKING files under `node_modules/` in its git index (WI-39630).
 *
 * WHY THIS IS A GUARD AND NOT A STYLE RULE
 * ----------------------------------------
 * A path that is BOTH tracked in the index AND matched by a `.gitignore` rule is a
 * contradiction git resolves in the worst possible direction: **a tracked file is
 * never ignored**, so the ignore rule goes inert while the file keeps behaving like
 * tracked content. Nothing errors. The tree looks fine.
 *
 * It stops looking fine the moment peer `npm install` churn deletes those files from
 * the worktree. They then surface as ` D` rows, git-sync's `dirtyFiles()` enumerates
 * them, and the attributed-commit phase (`run-git-sync.ts`, the
 * `git add -- <paths>` call) hands git an explicit pathspec for an IGNORED path.
 * git refuses:
 *
 *     The following paths are ignored by one of your .gitignore files:
 *     node_modules
 *     hint: Use -f if you really want to add them.
 *
 * ...and the whole repo's sync leg fails. Not one file — the leg. Every tick.
 * Commits stop landing, which means code stops reaching :3070 at all.
 *
 * Measured 2026-08-17: SEVENTEEN submodules were in this state simultaneously
 * (~6,500 tracked paths; dock-workbench alone 1,660), and the git-sync routine for
 * `papercusp/libs/generic/dock-workbench` had 16 consecutive failing ticks. Every one
 * of those submodules already had `node_modules/` in its `.gitignore` — which is
 * exactly why nobody caught it by reading `.gitignore` files. The ignore rule being
 * present is not evidence the class is closed; only the INDEX is.
 *
 * The cleanup (`git rm -r --cached node_modules`) closes today's instance. This guard
 * closes the CLASS, because nothing stops the next accidental `git add -f`, or the
 * next submodule vendored in from a repo that committed its node_modules, from
 * re-arming it — silently, for however long it takes someone to notice commits have
 * stopped.
 *
 *   node scripts/check-tracked-node-modules.mjs
 *   node scripts/check-tracked-node-modules.mjs --list   # print full offender paths
 *
 * The predicate (`findOffenders`) takes an injected lister and is unit-tested, so the
 * "fails on a NEW tracked node_modules path" property is durably verified rather than
 * merely green-on-a-clean-tree.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { declaredSubmodules, describeUnscanned } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Repos permanently allowed to track node_modules content.
 *
 * Deliberately EMPTY. A vendored dependency belongs in the dependency manifest, not
 * in the index under node_modules — and an entry here does not merely tolerate a
 * style violation, it re-arms the sync-leg outage described above for that repo.
 * If you believe you need one, fix the manifest instead.
 */
export const ALLOWLIST = new Set([]);

/**
 * Pure predicate: given repo names and a lister returning each repo's tracked
 * node_modules paths, return the offenders.
 *
 * @param {object} opts
 * @param {string[]} opts.repos            repo identifiers ('.' for the superproject)
 * @param {(repo: string) => string[]} opts.listTracked
 * @param {Set<string>} [opts.allowlist]
 * @returns {{ repo: string, paths: string[] }[]}
 */
export function findOffenders({ repos, listTracked, allowlist = ALLOWLIST }) {
  const offenders = [];
  for (const repo of repos) {
    if (allowlist.has(repo)) continue;
    const paths = listTracked(repo) ?? [];
    if (paths.length > 0) offenders.push({ repo, paths });
  }
  return offenders;
}

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * Every git-backed repo this checkout can honestly scan.
 *
 * Enumerate the declared topology rather than asking `git submodule foreach` to
 * infer it from the index. A stray mode-160000 entry that is not in `.gitmodules`
 * makes `foreach` abort the WHOLE guard before it checks a single repository. That
 * exact shape is produced if git-sync sees a gate-owned repair worktree before its
 * path is ignored (WI-39450). An undeclared gitlink is not a submodule and must not
 * be allowed to disable this unrelated node_modules guard.
 */
export function discoverRepos(root = ROOT) {
  return [
    '.',
    ...declaredSubmodules(root).filter((repo) => existsSync(join(root, repo, '.git'))),
  ];
}

function listTrackedFromGit(repo) {
  const cwd = repo === '.' ? ROOT : join(ROOT, repo);
  const out = git(['ls-files', '--', '*node_modules/*'], cwd);
  return out.split('\n').filter(Boolean);
}

function main() {
  const showList = process.argv.includes('--list');
  const repos = discoverRepos();
  const unscanned = declaredSubmodules(ROOT).filter((repo) => !repos.includes(repo));
  const coverageNote = describeUnscanned(unscanned, ROOT);

  // Positive control: a probe that can only ever return "clean" is not a guard. If
  // the superproject reports zero tracked files AT ALL, `git ls-files` is not doing
  // what we think it is (wrong cwd, broken checkout) and a clean verdict is
  // meaningless — fail loudly rather than certifying the tree on a dead instrument.
  const superprojectTrackedAny = git(['ls-files'], ROOT).split('\n').filter(Boolean).length;
  if (superprojectTrackedAny === 0) {
    console.error(
      '✖ check-tracked-node-modules: `git ls-files` reported ZERO tracked files in the ' +
        'superproject. The probe is broken (wrong cwd or a bad checkout), so a "clean" ' +
        'result would be a false negative. Refusing to pass.',
    );
    process.exit(2);
  }

  const offenders = findOffenders({ repos, listTracked: listTrackedFromGit });

  if (offenders.length === 0) {
    console.log(
      `✓ check-tracked-node-modules: ${repos.length} repo(s) scanned, none tracks node_modules.${coverageNote}`,
    );
    return;
  }

  const total = offenders.reduce((n, o) => n + o.paths.length, 0);
  console.error(
    `✖ check-tracked-node-modules: ${total} path(s) under node_modules are TRACKED in ` +
      `${offenders.length} repo(s).\n`,
  );
  for (const { repo, paths } of offenders) {
    console.error(`  ${repo}  (${paths.length} tracked)`);
    const sample = showList ? paths : paths.slice(0, 3);
    for (const p of sample) console.error(`      ${p}`);
    if (!showList && paths.length > sample.length) {
      console.error(`      ... ${paths.length - sample.length} more (re-run with --list)`);
    }
  }
  console.error(
    '\nWHY THIS MATTERS: a tracked path is never ignored, so the .gitignore rule for\n' +
      'node_modules is inert in these repos. Once npm churn deletes the files, git-sync\n' +
      "hands git an explicit pathspec for an ignored path, git refuses ('use -f'), and\n" +
      "that repo's ENTIRE sync leg fails every tick — commits stop landing.\n" +
      '\nFIX (index-only, does NOT touch your worktree):\n' +
      offenders.map(({ repo }) => `  git -C ${repo} rm -r --cached --ignore-unmatch node_modules`).join('\n') +
      '\n\nThen let git-sync commit the removal.',
  );
  if (coverageNote) console.error(`\nCoverage:${coverageNote}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
