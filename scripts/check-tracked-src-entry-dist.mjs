#!/usr/bin/env node
/**
 * check-tracked-src-entry-dist.mjs — fail-loud guard against a package TRACKING its
 * own build output under `dist/` while its package.json entrypoints resolve only to
 * `src/` (WI-10002064).
 *
 * WHY THIS IS A GUARD AND NOT A STYLE RULE
 * ----------------------------------------
 * A src-as-entry package's `dist/` is unreachable by construction: `exports`/`main`
 * route every subpath to `./src/*`, so node never loads the emitted copy. That makes
 * a tracked `dist/` not merely redundant but ACTIVELY WRONG over time — it is a
 * second copy of a truth the source owns, and it drifts (the derived-truth ladder).
 *
 * The measured instance: `packages/agent-mcp/dist/` tracked 144 files, last emitted
 * 2026-09-07, still exporting the hard-coded success envelope
 *
 *     return { ok: true, results, counts: { ok, failed } };   // dist/_bulk.js:148
 *
 * thirteen days after src/_bulk.ts:200 replaced it with `ok: failed === 0`. That
 * removal exists precisely because a top-level `ok:true` beside a failed item is a
 * false-success report. The stale artifact re-taught the retired contract — to a
 * grep, to a reader, to the next agent — with no error anywhere. Its own docblock
 * documented the removed rule verbatim. It was also emitted by a build config that
 * no longer exists: `tsconfig.build.json` sets `declaration: false`, yet 66 of the
 * tracked files were `.d.ts`.
 *
 * WHY THE .gitignore RULE ALONE IS NOT THE FIX
 * -------------------------------------------
 * A tracked path is NEVER ignored: adding the rule while the path stays in the index
 * leaves the rule inert and the artifact live — the same contradiction that killed
 * git-sync's commit leg in WI-39630. The cleanup (`git rm -r packages/agent-mcp/dist`
 * plus the `.gitignore` entry) closes today's instance; this guard catches the next
 * package to arrive the same way, which a `.gitignore` entry for ONE path cannot.
 *
 * SCOPE — deliberately narrow, and measured before it was chosen. The general form
 * ("no tracked path is also gitignored") is NOT usable as a gate guard: on this box
 * `git ls-files -i -c --exclude-standard` reports 1,972 paths, and the matching rules
 * come from `.git/info/exclude` and the USER's `~/.config/git/ignore` — machine-local
 * files, so the verdict would differ per checkout and per agent. (Note also that the
 * intuitive probe `git ls-files | git check-ignore --stdin` returns a TAUTOLOGICAL 0:
 * check-ignore consults the index by default, where a tracked file is never ignored.
 * Use `--no-index`, or this flag pair, or you will measure an empty set and conclude
 * the tree is clean.) The predicate below is instead conditioned on what the package
 * itself declares, which is deterministic everywhere.
 *
 *   node scripts/check-tracked-src-entry-dist.mjs          # verdict
 *   node scripts/check-tracked-src-entry-dist.mjs --list   # print full offender paths
 *
 * The predicate (`findOffenders`) takes injected inputs and is unit-tested, so the
 * "fails on a NEW tracked src-entry dist" property is durably verified rather than
 * merely green-on-a-clean-tree.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { declaredSubmodules, describeUnscanned } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Packages permanently allowed to track a dist/ they do not consume.
 *
 * Deliberately EMPTY. If the emitted output is genuinely needed, the package should
 * CONSUME it (point an entrypoint at `./dist/*`), which takes it out of this guard's
 * population honestly. An entry here does not tolerate a style violation — it
 * re-arms a stale artifact that will contradict its own source and teach the
 * contradiction to whoever reads it next.
 */
export const ALLOWLIST = new Set([]);

/**
 * Does anything this package DECLARES point into dist/?
 *
 * Checked across every entrypoint-ish field rather than `exports` alone: a package
 * can legitimately reach its build output through `main`, `module`, `types`, `bin`,
 * or ship it via `files`. Any one of those makes dist/ consumed, and consumed dist/
 * is out of scope for this guard.
 *
 * @param {Record<string, unknown>} pkgJson
 * @returns {boolean}
 */
export function declaresDist(pkgJson) {
  const declared = [
    pkgJson?.exports,
    pkgJson?.main,
    pkgJson?.module,
    pkgJson?.types,
    pkgJson?.typings,
    pkgJson?.bin,
    pkgJson?.files,
    pkgJson?.publishConfig,
  ];
  return /(^|[^\w-])dist(\/|"|$)/.test(JSON.stringify(declared));
}

/**
 * Pure predicate: given each package's declaration and its tracked dist/ paths,
 * return the offenders.
 *
 * @param {object} opts
 * @param {{ repo: string, dir: string, pkgJson: object, trackedDist: string[] }[]} opts.packages
 * @param {Set<string>} [opts.allowlist]
 * @returns {{ repo: string, dir: string, paths: string[] }[]}
 */
export function findOffenders({ packages, allowlist = ALLOWLIST }) {
  const offenders = [];
  for (const { repo, dir, pkgJson, trackedDist } of packages) {
    if (allowlist.has(dir)) continue;
    const paths = trackedDist ?? [];
    if (paths.length === 0) continue;
    if (declaresDist(pkgJson)) continue;
    offenders.push({ repo, dir, paths });
  }
  return offenders;
}

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();

/**
 * Repos to scan: the superproject plus every declared submodule that is actually
 * checked out. A submodule keeps its own index, so the superproject's `ls-files`
 * cannot see a package that regressed inside one.
 */
export function discoverRepos(root = ROOT) {
  return [
    '.',
    ...declaredSubmodules(root).filter((repo) => existsSync(join(root, repo, '.git'))),
  ];
}

/**
 * One `git ls-files` per repo, then grouped in memory. Deliberately NOT a git call
 * per package: this guard runs on the release gate, where ~100 extra subprocess
 * spawns would cost more than the check is worth.
 */
function collectPackages(repo) {
  const cwd = repo === '.' ? ROOT : join(ROOT, repo);
  const tracked = git(['ls-files'], cwd).split('\n').filter(Boolean);

  const pkgDirs = tracked
    .filter((p) => p === 'package.json' || p.endsWith('/package.json'))
    .filter((p) => !p.includes('node_modules/'))
    .map((p) => (p === 'package.json' ? '' : p.slice(0, -'/package.json'.length)));

  // Longest-prefix match: a dist/ belongs to the DEEPEST package that encloses it,
  // so a nested workspace's output is never attributed to the repo root.
  const byDir = new Map(pkgDirs.map((d) => [d, []]));
  const sortedDirs = [...pkgDirs].sort((a, b) => b.length - a.length);
  for (const p of tracked) {
    if (!p.includes('dist/')) continue;
    if (p.includes('node_modules/')) continue;
    const owner = sortedDirs.find((d) => isDistOf(d, p));
    if (owner === undefined) continue;
    byDir.get(owner).push(p);
  }

  const packages = [];
  for (const [dir, trackedDist] of byDir) {
    if (trackedDist.length === 0) continue;
    let pkgJson;
    try {
      pkgJson = JSON.parse(readFileSync(join(cwd, dir, 'package.json'), 'utf8'));
    } catch {
      continue; // unreadable manifest is not this guard's verdict to make
    }
    packages.push({ repo, dir: dir === '' ? '.' : dir, pkgJson, trackedDist });
  }
  return packages;
}

/** Is `p` a tracked file under `<dir>/dist/`? */
function isDistOf(dir, p) {
  const prefix = dir === '' ? 'dist/' : `${dir}/dist/`;
  return p.startsWith(prefix);
}

function main() {
  const showList = process.argv.includes('--list');
  const repos = discoverRepos();
  const unscanned = declaredSubmodules(ROOT).filter((repo) => !repos.includes(repo));
  const coverageNote = describeUnscanned(unscanned, ROOT);

  // Positive control: a probe that can only ever return "clean" is not a guard. If the
  // superproject reports zero tracked files AT ALL, `git ls-files` is not doing what we
  // think it is (wrong cwd, broken checkout) and a clean verdict is meaningless — fail
  // loudly rather than certifying the tree on a dead instrument.
  const superprojectTrackedAny = git(['ls-files'], ROOT).split('\n').filter(Boolean).length;
  if (superprojectTrackedAny === 0) {
    console.error(
      '✖ check-tracked-src-entry-dist: `git ls-files` reported ZERO tracked files in the ' +
        'superproject. The probe is broken (wrong cwd or a bad checkout), so a "clean" ' +
        'result would be a false negative. Refusing to pass.',
    );
    process.exit(2);
  }

  const packages = repos.flatMap((repo) => collectPackages(repo));
  const offenders = findOffenders({ packages });

  if (offenders.length === 0) {
    console.log(
      `✓ check-tracked-src-entry-dist: ${repos.length} repo(s) scanned, ` +
        `${packages.length} package(s) with a tracked dist/, none of them src-as-entry.` +
        `${coverageNote}`,
    );
    return;
  }

  const total = offenders.reduce((n, o) => n + o.paths.length, 0);
  console.error(
    `✖ check-tracked-src-entry-dist: ${total} path(s) under dist/ are TRACKED in ` +
      `${offenders.length} package(s) whose entrypoints resolve only to src/:\n`,
  );
  // `dir` is '.' for a package that IS its repo root (every submodule-root package),
  // so join the two carefully — a naive `${repo}/${dir}` renders `libs/generic/x/.`.
  const joinPath = (repo, dir) =>
    repo === '.' ? (dir === '.' ? '.' : dir) : dir === '.' ? repo : `${repo}/${dir}`;

  for (const { repo, dir, paths } of offenders) {
    const where = joinPath(repo, dir);
    console.error(`  ${where}  (${paths.length} path(s))`);
    const sample = showList ? paths : paths.slice(0, 5);
    for (const p of sample) console.error(`      ${p}`);
    if (!showList && paths.length > sample.length) {
      console.error(`      ... ${paths.length - sample.length} more (re-run with --list)`);
    }
  }
  console.error(
    '\nWHY THIS MATTERS: nothing can load these files — package.json routes every\n' +
      'entrypoint to ./src/*. So the tracked copy is a second copy of a truth the\n' +
      'source owns, and it drifts: agent-mcp/dist/_bulk.js spent 13 days exporting a\n' +
      '`ok: true` envelope that src had already replaced with `ok: failed === 0`,\n' +
      're-teaching a contract that was deliberately removed (WI-10002064).\n' +
      '\nFIX: untrack the output and add the ignore rule — BOTH halves, because a\n' +
      'tracked path is never ignored and the rule alone goes inert:\n\n' +
      offenders
        .map(({ repo, dir }) => {
          // Untrack from the repo that OWNS the path, and put the rule in THAT repo's
          // own .gitignore: a superproject rule does not reach inside a submodule.
          const c = repo === '.' ? '' : `-C ${repo} `;
          const rel = dir === '.' ? 'dist' : `${dir}/dist`;
          const ignoreFile = repo === '.' ? '.gitignore' : `${repo}/.gitignore`;
          const ruleBody = repo === '.' ? `${rel}/` : `${dir === '.' ? 'dist' : `${dir}/dist`}/`;
          return `  git ${c}rm -r ${rel}\n  echo '${ruleBody}' >> ${ignoreFile}`;
        })
        .join('\n') +
      '\n\nIf the output IS genuinely needed, point an entrypoint at ./dist/* instead —\n' +
      'a consumed dist/ is out of this guard\'s population honestly.',
  );
  if (coverageNote) console.error(`\nCoverage:${coverageNote}`);
  process.exit(1);
}

if (isCliEntry(import.meta.url)) main();
