#!/usr/bin/env node
/**
 * lint:affected-gate — guard the affected-set computation against the class of bug
 * where TESTS SILENTLY STOP RUNNING and the gate goes green having verified nothing.
 *
 * Why this is a LINT and not a vitest test: a vitest test only runs when its own
 * workspace is in the affected set. The failure mode guarded here is precisely
 * "workspace X is never in the affected set" — so a test would be disarmed by the
 * very bug it exists to catch. CI runs the lint steps unconditionally; this always
 * runs.
 *
 * The bug it was written for (2026-07-11): `changedFiles()` passed
 * `--ignore-submodules=all` to every `git diff`. A submodule's files never appear as
 * superproject paths (they live in another repo) — the GITLINK is the only way its
 * changes surface. `=all` suppressed the gitlink, so a commit touching only
 * libs/generic/memory produced an EMPTY changed-file set → an EMPTY affected set →
 * ZERO tests ran. The memory lib's 286 tests had no protection on main, and the same
 * held for ~25 other submodule workspaces.
 *
 * Checks:
 *   1. changedFiles() must not reintroduce `--ignore-submodules=all`.
 *   2. The path→workspace mapping must keep its bare-directory arm (`file === ws.dir`),
 *      since a gitlink change is reported as the bare dir, not a path beneath it.
 *   3. Every submodule that is an npm workspace with a `test` script must be
 *      reachable: it is a real workspace, and its gitlink path maps to it.
 *   4. Any workspace importing @papercusp/memory must DECLARE it, or the reverse-dep
 *      walk cannot fan a memory change out to that workspace's tests.
 *
 * Exits non-zero with a specific message on violation. Run: npm run lint:affected-gate
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const note = (m) => errors.push(m);

const GATE = join(ROOT, 'scripts', 'affected-tests.mjs');

// Assert against CODE, never comments. The gate file necessarily *documents* the very
// patterns checked for below, so a naive substring scan is satisfied by the prose that
// explains the rule — the guard passes while the code is broken. (Caught by mutation
// test: deleting the `file === ws.dir` arm still linted clean, because the comment
// above it says `file === ws.dir`.)
//
// COMMENTS ONLY, deliberately — `--ignore-submodules=all` is a CLI flag that lives in the
// gate's argv ARRAY, i.e. inside a string literal. Masking strings too would convert this
// guard's positive into a silent false negative on the exact "gate verified nothing" defect
// it exists to catch. (The per-CALL-SITE split the shared module's header describes.)
const gateSrc = stripCommentsOnly(readFileSync(GATE, 'utf8'), GATE);

// ---------------------------------------------------------------- 1 + 2: the gate
if (gateSrc.includes('--ignore-submodules=all')) {
  note(
    'scripts/affected-tests.mjs uses `--ignore-submodules=all`, which SUPPRESSES gitlink\n' +
      '  changes. A commit touching only a submodule (e.g. libs/generic/memory) then yields an\n' +
      '  EMPTY affected set and ZERO tests run — the gate goes green having verified nothing.\n' +
      '  Use `--ignore-submodules=dirty`: it still tolerates broken/retired submodules (it skips\n' +
      '  the work-tree scan that throws) but still reports gitlink changes.',
  );
}
if (!/file === ws\.dir\b/.test(gateSrc)) {
  note(
    'scripts/affected-tests.mjs lost the bare-directory arm (`file === ws.dir`) of its\n' +
      '  path→workspace mapping. A gitlink change is reported as the bare directory\n' +
      '  ("libs/generic/memory"), never as a path beneath it, so without this arm no submodule\n' +
      '  workspace can ever be marked affected.',
  );
}

// ------------------------------------------------------------------- workspaces
function expandWorkspaces(patterns) {
  const out = [];
  for (const p of patterns) {
    if (p.includes('*')) {
      const base = p.replace(/\/\*$/, '');
      if (!existsSync(join(ROOT, base))) continue;
      for (const entry of readdirSync(join(ROOT, base))) {
        const dir = `${base}/${entry}`;
        if (existsSync(join(ROOT, dir, 'package.json'))) out.push(dir);
      }
    } else if (existsSync(join(ROOT, p, 'package.json'))) {
      out.push(p);
    }
  }
  return out;
}

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const wsDirs = expandWorkspaces(rootPkg.workspaces);
const wsByDir = new Map();
for (const dir of wsDirs) {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  wsByDir.set(dir, pkg);
}

// The gate's mapping predicate, mirrored. Kept in sync by check 2 above.
const mapsToWorkspace = (file) =>
  [...wsByDir.keys()].some((dir) => file === dir || file === `${dir}/package.json` || file.startsWith(`${dir}/`));

// ------------------------------------------------- 3: submodule workspaces reachable
let submodulePaths = [];
try {
  submodulePaths = execFileSync('git', ['config', '--file', '.gitmodules', '--get-regexp', 'path'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[1]);
} catch {
  // No .gitmodules — nothing to guard.
}

for (const path of submodulePaths) {
  const pkg = wsByDir.get(path);
  if (!pkg) continue; // submodule that isn't an npm workspace — not part of the gate
  if (!pkg.scripts?.test) continue; // no tests to protect
  if (!mapsToWorkspace(path)) {
    note(
      `submodule workspace ${path} (${pkg.name}) has a \`test\` script but its gitlink path does\n` +
        '  not map to any workspace — its tests can never be marked affected, so they never run.',
    );
  }
}

// ------------------------------- 4: importers of @papercusp/memory must declare it
// Generalising this to every @papercusp/* package would flag ~54 pre-existing
// violations across the repo (operator-core alone omits ~24). That is a real and
// separate problem — see the reverse-dep-integrity finding — but enforcing it here
// would redden main on unrelated packages. Scope the hard check to the memory lib,
// which is the system this gate was hardened for.
const MEMORY = '@papercusp/memory';
// Match a real module specifier only — `from '@papercusp/memory'`, `require(...)`,
// `import(...)`, plus subpath imports. A bare substring search also hits the package
// name inside doc comments (libs/generic/deployment-driver mentions it in prose), which
// would demand a dependency the code does not actually have.
const SPECIFIER = String.raw`(from|require\(|import\()[[:space:]]*['"]@papercusp/memory(/[^'"]*)?['"]`;
for (const [dir, pkg] of wsByDir) {
  if (pkg.name === MEMORY) continue;
  let imports = '';
  try {
    imports = execFileSync(
      'grep',
      ['-rlE', '--include=*.ts', '--include=*.tsx', '--exclude-dir=node_modules', SPECIFIER, join(ROOT, dir)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    continue; // grep exits 1 when there are no matches
  }
  if (!imports) continue;
  const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  if (!declared[MEMORY]) {
    note(
      `${pkg.name} (${dir}) imports ${MEMORY} but does not declare it as a dependency.\n` +
        `  The affected-set reverse-dep walk is built from package.json, so a change to the memory\n` +
        `  lib would NOT run ${pkg.name}'s tests. Add "${MEMORY}": "*" to its dependencies.`,
    );
  }
}

// ------------------------------------------------------------------------- report
if (errors.length) {
  console.error('');
  console.error('lint:affected-gate FAILED — the test gate would run fewer tests than it appears to.');
  console.error('');
  for (const e of errors) console.error(`✗ ${e}\n`);
  process.exit(1);
}
console.log(`lint:affected-gate ok — ${submodulePaths.length} submodules checked, gitlink mapping intact.`);
