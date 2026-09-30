#!/usr/bin/env node
/**
 * check-submodule-coverage-ignore.mjs — fail-loud guard ensuring every coverage-capable
 * submodule (a repo with its own package.json or Cargo.toml) actually ignores generated
 * coverage reports (EI-22201289307647151).
 *
 * WHY THIS IS A GUARD AND NOT A STYLE RULE
 * ----------------------------------------
 * A superproject `.gitignore` does NOT govern inside a submodule: `git check-ignore`
 * run from the repo root answers "Pathspec ... is in submodule <p>" and declines. The
 * root `.gitignore` has carried a `coverage/` rule set since EI-22195215129102176 (a
 * non-ignored coverage dir swept 74 files / +54,104 lines into the tree during P-012),
 * but that rule stops dead at every submodule boundary — each submodule needs its OWN
 * copy of the rule.
 *
 * MEASURED 2026-09-03: walking .gitmodules and keeping repos with a coverage-capable
 * surface (package.json or Cargo.toml) found 22 of 38 submodules with NO local ignore
 * rule for `coverage/`. `--coverage` is opt-in today (scripts/affected-tests.mjs), so
 * nothing fires automatically yet — but the first tree-wide `--coverage` run would drop
 * a generated report into each of those 22 repos, where git-sync (which commits the
 * superproject AND every submodule) sweeps it in. That is EI-22195215129102176 at 22x.
 * One of the 22 (libs/papercusp/packages/cli/coverage/.tmp/) already had 10 raw V8
 * coverage JSON files sitting TRACKED in its index from an earlier accidental sweep —
 * the exact "tracked wins over .gitignore" contradiction check-tracked-node-modules.mjs
 * exists to catch, just for a different file class. That instance was untracked
 * (`git rm --cached`) as part of landing this guard; this script only asserts the
 * .gitignore RULE, not index cleanliness — check-tracked-node-modules.mjs already owns
 * the "is anything under a should-be-ignored path still tracked" question generally.
 *
 * A new submodule added later, or a submodule that gains its first package.json/
 * Cargo.toml, silently re-arms this class with NO source-pattern warning — nothing
 * about ADDING a submodule needs to touch scripts/affected-tests.mjs or any coverage
 * config. That is why this guard, like its node_modules sibling, enumerates the
 * declared topology fresh every run instead of relying on anyone remembering to copy
 * the rule forward.
 *
 *   node scripts/check-submodule-coverage-ignore.mjs
 *   node scripts/check-submodule-coverage-ignore.mjs --list   # print full offender paths
 *
 * The predicate (`findOffenders`) takes injected coverage-capability + ignore-check
 * functions and is unit-tested, so the "flags a submodule missing the rule" property is
 * durably verified rather than merely green-on-a-clean-tree.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { declaredSubmodules, describeUnscanned } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Repos permanently exempt from needing their own coverage-ignore rule.
 *
 * Deliberately EMPTY. Every coverage-capable submodule can produce a coverage report
 * (that is what "coverage-capable" means), so every one needs the rule. If you believe
 * you need an entry here, add the ignore rule instead — it is four lines.
 */
export const ALLOWLIST = new Set([]);

/** The exact probe path checked in every repo — see git-check-ignore(1); any generated
 * lcov/V8-coverage filename under `coverage/` matches the same rule set. */
const PROBE_PATH = 'coverage/lcov.info';

/**
 * Pure predicate: given repos, a coverage-capability check, and an ignore check, return
 * the repos that are coverage-capable but do NOT ignore the probe path.
 *
 * @param {object} opts
 * @param {string[]} opts.repos                        repo identifiers (submodule paths)
 * @param {(repo: string) => boolean} opts.isCoverageCapable
 * @param {(repo: string) => boolean} opts.isIgnored
 * @param {Set<string>} [opts.allowlist]
 * @returns {string[]}
 */
export function findOffenders({ repos, isCoverageCapable, isIgnored, allowlist = ALLOWLIST }) {
  const offenders = [];
  for (const repo of repos) {
    if (allowlist.has(repo)) continue;
    if (!isCoverageCapable(repo)) continue;
    if (!isIgnored(repo)) offenders.push(repo);
  }
  return offenders;
}

/** Every declared submodule this checkout can honestly scan (checked out, has a .git). */
export function discoverRepos(root = ROOT) {
  return declaredSubmodules(root).filter((repo) => existsSync(join(root, repo, '.git')));
}

/** package.json or Cargo.toml present ⇒ this repo can produce a coverage report. */
export function isCoverageCapableFs(repo, root = ROOT) {
  const abs = join(root, repo);
  return existsSync(join(abs, 'package.json')) || existsSync(join(abs, 'Cargo.toml'));
}

/**
 * `git check-ignore` inside the submodule's own working tree. Exit 0 = ignored, exit 1
 * = not ignored (the expected two outcomes); anything else (bad path, corrupt repo) is
 * a genuine error and must not be swallowed into a false "ignored" or "not ignored".
 */
export function isIgnoredByGit(repo, root = ROOT) {
  try {
    execFileSync('git', ['check-ignore', '-q', PROBE_PATH], {
      cwd: join(root, repo),
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    if (err && typeof err.status === 'number' && err.status === 1) return false;
    throw err;
  }
}

function main() {
  const showList = process.argv.includes('--list');
  const repos = discoverRepos();
  const unscanned = declaredSubmodules(ROOT).filter((repo) => !repos.includes(repo));
  const coverageNote = describeUnscanned(unscanned, ROOT);

  // Positive control: if NOTHING in the whole tree is coverage-capable, the
  // package.json/Cargo.toml probe is broken (wrong cwd, bad checkout) and a clean
  // verdict would be meaningless — the superproject itself always has a package.json.
  if (!isCoverageCapableFs('.', ROOT)) {
    console.error(
      '✖ check-submodule-coverage-ignore: the superproject itself did not read as ' +
        'coverage-capable (no package.json found at repo root). The probe is broken ' +
        '(wrong cwd or a bad checkout), so a clean result would be a false negative. ' +
        'Refusing to pass.',
    );
    process.exit(2);
  }

  const offenders = findOffenders({
    repos,
    isCoverageCapable: (r) => isCoverageCapableFs(r, ROOT),
    isIgnored: (r) => isIgnoredByGit(r, ROOT),
  });

  if (offenders.length === 0) {
    console.log(
      `✓ check-submodule-coverage-ignore: ${repos.length} submodule(s) scanned, every ` +
        `coverage-capable one ignores '${PROBE_PATH}'.${coverageNote}`,
    );
    return;
  }

  console.error(
    `✖ check-submodule-coverage-ignore: ${offenders.length} coverage-capable submodule(s) ` +
      `do NOT ignore '${PROBE_PATH}':\n`,
  );
  const sample = showList ? offenders : offenders.slice(0, 10);
  for (const repo of sample) console.error(`  ${repo}`);
  if (!showList && offenders.length > sample.length) {
    console.error(`  ... ${offenders.length - sample.length} more (re-run with --list)`);
  }
  console.error(
    '\nWHY THIS MATTERS: the superproject .gitignore cannot reach across a submodule\n' +
      "boundary. Without a local rule, the first tree-wide `--coverage` run drops a\n" +
      'generated report here, and git-sync (which commits the superproject AND every\n' +
      'submodule) sweeps it into a commit — same class as EI-22195215129102176 (74\n' +
      'files / +54,104 lines swept).\n' +
      '\nFIX: append this block to each offending repo\'s own .gitignore:\n\n' +
      '  coverage/\n  coverage-*/\n  **/coverage/\n  **/coverage-*/\n\n' +
      'Then let git-sync commit it. If any of these repos already TRACKS a coverage\n' +
      'artifact, add the rule AND `git -C <repo> rm -r --cached <path>` — a tracked path\n' +
      'is never ignored (lint:no-tracked-node-modules is the general form of that check).',
  );
  if (coverageNote) console.error(`\nCoverage:${coverageNote}`);
  process.exit(1);
}

if (isCliEntry(import.meta.url)) main();
