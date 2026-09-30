#!/usr/bin/env node
/**
 * check-workspace-deps-complete.mjs — shrink-only guard against workspaces that import
 * a local @papercusp/* package without declaring it (EI-9831, generalizing
 * lint-affected-gate.mjs's check #4 from @papercusp/memory-only to every local package).
 *
 * WHY THIS MATTERS: scripts/affected-tests.mjs builds its reverse-dependency walk from
 * each workspace's package.json dependencies/devDependencies/peerDependencies. An
 * UNDECLARED local import is invisible to that walk — a change to the imported package
 * will NOT mark the importing workspace affected, so its tests silently do not run on
 * that change. This is the same failure class lint-affected-gate.mjs was hardened for
 * (memory-only), generalized to the whole @papercusp/* namespace.
 *
 * A 2026-07-11 repo-wide scan found 54 such undeclared edges (worst offender:
 * @papercusp/operator-core omits ~24). Fixing all 54 at once was out of scope for the
 * task that found them and would touch many unrelated packages in one sweep — so this
 * guard is SHRINK-ONLY: the 54 known-at-authoring-time violations are grandfathered into
 * BASELINE and must not grow; any NEW undeclared edge is a hard failure.
 *
 *   node scripts/check-workspace-deps-complete.mjs        # check (used by npm run lint:workspace-deps-complete)
 *   node scripts/check-workspace-deps-complete.mjs --list  # print the current offender set (regenerate BASELINE)
 *
 * BASELINE entries shrink as each is fixed (declare the dependency + regenerate
 * package-lock.json) — remove the entry when its edge is declared. Do NOT add new
 * entries; a NEW undeclared edge must be fixed, not grandfathered.
 *
 * ⚠ ONE EXCEPTION, and it is narrow: a BASELINE CORRECTION, when this guard's VISION widens
 * and edges that existed all along become visible for the first time. That is not the same
 * act as grandfathering a new edge — nothing was added to the repo, something was finally
 * seen — and refusing it would mean keeping a measurement knowingly wrong. It happened once,
 * 55 -> 58 (EI-20028225708881148, 2026-08-10), when the target-side lookup stopped being
 * limited to root workspaces; the three entries carry an inline BASELINE CORRECTION note.
 * The same distinction, with the same reasoning, is documented for CLAUDE.md's
 * module-singleton allowlist growing 14 -> 32. If you are widening this guard: extend
 * BASELINE IN THE SAME CHANGE. It is registered in REPO_WIDE_INVARIANT_GUARDS, so a widened-
 * but-unbaselined guard exits 1 on every change and red-pins the fleet gate on arrival.
 *
 * Target-side scope + that trap are pinned by
 * packages/operator-core/lib/__tests__/check-workspace-deps-complete-target-scope.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * BASELINE (TEMPORARY — must shrink to EMPTY): `${importerPkgName}->${importedPkgName}`
 * edges that exist today without a declared dependency. Seeded 2026-07-12 from the
 * repo-wide scan referenced in EI-9831 (54 edges). Fix an edge (declare the dependency +
 * `npm install` to regenerate package-lock.json) and REMOVE its entry here — that is how
 * this guard ratchets to zero. Do NOT add new entries.
 *
 * 2026-08-10 (EI-20026978310669562): burned down 58 -> 5. The 53 removed edges were declared
 * in their importers' package.json and package-lock.json was regenerated in the same change.
 *
 * ⚠ 13 of those 53 were declared as **devDependencies**, not `dependencies`. The naive fix is
 * to put every edge in `dependencies`; doing that here promoted ~200 packages out of dev-only
 * in package-lock.json, because each of those 13 is `@papercusp/test-config` imported from
 * nothing but that package's own `vitest.config.ts`. This guard deliberately EXCLUDES
 * `*.test.ts`/`*.spec.ts` from its scan (see importsInWorkspace), which makes a config-file
 * import look exactly like a production import — so the dep placement has to be decided from
 * the IMPORTING FILE, not from the guard's output alone. Classify before you declare.
 *
 * THE BASELINE IS NOW EMPTY (2026-08-10, WI-37624). This guard is a pure never-regress
 * ratchet: any entry appearing here again is a REGRESSION, not backlog.
 */
export const BASELINE = new Set([
  // EMPTY — and it must stay that way. Shrink-to-empty reached 2026-08-10 (WI-37624).
  //
  // The last 5 edges were closed after their two stated blockers were MEASURED, and BOTH
  // turned out to be false. Recorded here because each is the kind of plausible claim that
  // would otherwise be re-derived and re-believed by the next reader:
  //
  //   (a) CLAIMED: "declaring these closes a dependency CYCLE, so it's a design question."
  //       A cycle is harmless to BOTH consumers of this graph, verified:
  //         - affected-tests.mjs walks reverse-deps with a visited set (`if (!affected.has(d))`),
  //           so a cycle terminates — it cannot loop or overrun.
  //         - npm resolves cyclic WORKSPACE deps by symlinking. `npm install --package-lock-only`
  //           accepted operator-core<->agent-mcp AND the 3-hop
  //           plugin-loader->agent-mcp->operator-core->plugin-loader cycle, exit 0.
  //       The IMPORT cycle already existed in the code. Declaring it only makes the graph
  //       honest; leaving it undeclared never prevented a cycle, it just hid one.
  //
  //   (b) CLAIMED: "`*` cannot resolve a non-root-workspace target, so `npm ci` breaks."
  //       Falsified by the tree itself: `"@papercusp/sse": "*"` was ALREADY in use by 5
  //       packages (flags, agent-chat, tooldef-http, sync, desktop-ipc), and file-claim by 2
  //       (orchestrator, locks). These 3 were declared with `file:` specifiers regardless, to
  //       match what apps/operator and packages/agent-mcp already use for the SAME targets.
  //
  // ⚠ DECLARING A NEW EDGE? DIFF THE AFFECTED SET IN BOTH DIRECTIONS. Widening this graph can
  // SUPPRESS behaviour keyed on a workspace NOT being affected — that is exactly how
  // EI-20026978310669562 silently detached repo-wide invariant guards. Measured for THIS batch:
  // operator-core->agent-mcp did suppress 3 standalone guard tasks (chunk-safe,
  // partial-index-alignment, drop-database-force) for packages/agent-mcp paths — and that is
  // CORRECT: all 3 declare a hostSuiteRatchet into operator-core, whose `:: test` task was
  // GAINED in the same diff. No guard lacking a ratchet was suppressed.
]);

function expandWorkspaces(patterns, root = ROOT) {
  const out = [];
  for (const p of patterns) {
    if (p.includes('*')) {
      const base = p.replace(/\/\*$/, '');
      if (!existsSync(join(root, base))) continue;
      for (const entry of readdirSync(join(root, base))) {
        const dir = `${base}/${entry}`;
        if (existsSync(join(root, dir, 'package.json'))) out.push(dir);
      }
    } else if (existsSync(join(root, p, 'package.json'))) {
      out.push(p);
    }
  }
  return out;
}

/** Directories that never contain a first-party package we care about. */
const WALK_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'build',
  'target',
  'coverage',
  '.turbo',
]);

/**
 * EI-20028225708881148 — every local package ON DISK, root-workspace or not.
 *
 * WHY THIS EXISTS: the target-side test below used to be `byName.has(importedName)`, i.e.
 * "is this a ROOT WORKSPACE", with the comment "not a local workspace (published-only or
 * typo) — out of scope". That comment states an assumption which is FALSE for a package
 * that exists on disk but was never added to root.workspaces. Such edges were silently
 * discarded, so the guard's own headline count understated BY CONSTRUCTION — independently
 * of the BASELINE backlog, and invisibly, because a dropped edge produces no output at all.
 *
 * MEASURED 2026-08-10: 3 such edges existed (operator-core->sse, operator-vite->sse,
 * operator-core->file-claim), all three targeting real packages symlinked into node_modules.
 * Both targets were genuinely unrouted in affected-tests.mjs at the time: a change to
 * libs/generic/sse selected ZERO workspaces (EI-20027740706934564) and so did
 * libs/papercusp/packages/file-claim — i.e. the class this guard exists to detect was
 * occurring in exactly the packages the guard could not see.
 *
 * WHY A DISK WALK rather than probing node_modules for a symlink: determinism. A guard
 * registered in REPO_WIDE_INVARIANT_GUARDS must give the SAME answer in the gate's checkout
 * as on a dev box, and node_modules content differs between checkouts (and two of the local
 * non-workspace packages — papergrid, cli — are not symlinked in at all, so a node_modules
 * probe would miss them). The tree is the same everywhere; node_modules is not.
 * Cost is negligible and was measured, not assumed: 2611 dirs / 118 package.json in 0.15s.
 */
export function loadLocalPackagesOnDisk(root = ROOT) {
  const byName = new Map();
  const walk = (abs, rel, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
      try {
        const pkg = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'));
        if (pkg.name && !byName.has(pkg.name)) byName.set(pkg.name, { dir: rel || '.', pkg });
      } catch {
        /* unparseable package.json is not this guard's business */
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (WALK_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk(root, '', 0);
  return byName;
}

function loadWorkspaces(root = ROOT) {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const wsDirs = expandWorkspaces(rootPkg.workspaces, root);
  const byDir = new Map();
  const byName = new Map();
  for (const dir of wsDirs) {
    const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    byDir.set(dir, pkg);
    if (pkg.name) byName.set(pkg.name, { dir, pkg });
  }
  // Root workspaces WIN on a name collision (@papercusp/desktop resolves to two dirs on
  // disk); the workspace copy is the one npm and affected-tests.mjs actually resolve.
  const localByName = loadLocalPackagesOnDisk(root);
  for (const [name, meta] of byName) localByName.set(name, meta);
  return { byDir, byName, localByName };
}

/** Match a real `@papercusp/x` module specifier (import/require/dynamic-import + subpaths),
 * never a bare substring hit inside prose/doc comments. Comments are stripped first. */
const SPECIFIER_RE = /(?:from|require\(|import\()\s*['"](@papercusp\/[a-zA-Z0-9._-]+)(?:\/[^'"]*)?['"]/g;

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Local @papercusp/* imports found in one workspace's TS/TSX source (excludes tests/dist/node_modules). */
function importsInWorkspace(dir, root = ROOT) {
  let files = '';
  try {
    files = execFileSync(
      'grep',
      [
        '-rlE',
        '--include=*.ts',
        '--include=*.tsx',
        '--exclude-dir=node_modules',
        '--exclude-dir=dist',
        '--exclude-dir=.next',
        String.raw`@papercusp/`,
        join(root, dir),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return new Set(); // grep exit 1 = no matches
  }
  if (!files) return new Set();
  const found = new Set();
  for (const f of files.split('\n')) {
    if (/\.(test|spec)\.[cm]?tsx?$/.test(f)) continue; // test-only imports don't gate the reverse-dep walk
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const stripped = stripComments(text);
    for (const m of stripped.matchAll(SPECIFIER_RE)) found.add(m[1]);
  }
  return found;
}

/** Scan every workspace for undeclared local @papercusp/* imports. Returns [{ importer, imported, edge }]. */
export function findOffenders(root = ROOT) {
  const { byDir, byName, localByName } = loadWorkspaces(root);
  const offenders = [];
  for (const [dir, pkg] of byDir) {
    const imported = importsInWorkspace(dir, root);
    if (imported.size === 0) continue;
    const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    for (const importedName of imported) {
      if (importedName === pkg.name) continue; // self-import (rare, re-exports)
      // Out of scope only if the target is not a local package ANYWHERE on disk — i.e.
      // genuinely published-only, or a typo. Testing root-workspace membership here (the
      // pre-EI-20028225708881148 behaviour) silently dropped real edges; see
      // loadLocalPackagesOnDisk() above.
      if (!localByName.has(importedName)) continue;
      if (declared[importedName]) continue; // already declared — fine
      const edge = `${pkg.name}->${importedName}`;
      offenders.push({
        importer: pkg.name,
        importerDir: dir,
        imported: importedName,
        edge,
        // The remedy DIFFERS by target kind, so carry it to the failure message rather than
        // making the reader re-derive it (see main()).
        targetIsWorkspace: byName.has(importedName),
        targetDir: localByName.get(importedName)?.dir ?? null,
      });
    }
  }
  return offenders.sort((a, b) => a.edge.localeCompare(b.edge));
}

function main() {
  const listMode = process.argv.includes('--list');
  const offenders = findOffenders();

  if (listMode) {
    console.log(JSON.stringify(offenders.map((o) => o.edge), null, 2));
    console.log(`\n${offenders.length} total edge(s).`);
    // NOT process.exit(): --list is how the baseline is re-seeded, and exit() does not
    // drain an async pipe write — a truncated re-seed silently shrinks the baseline.
    // See scripts/check-undrained-stdout-exit.mjs.
    process.exitCode = 0;
    return;
  }

  const baselineSet = BASELINE;
  const newOffenders = offenders.filter((o) => !baselineSet.has(o.edge));
  const stillInBaseline = offenders.filter((o) => baselineSet.has(o.edge));
  const fixedFromBaseline = [...baselineSet].filter((e) => !offenders.some((o) => o.edge === e));

  if (fixedFromBaseline.length > 0) {
    console.log(`ℹ ${fixedFromBaseline.length} BASELINE edge(s) no longer reproduce (fixed but not removed from BASELINE):`);
    for (const e of fixedFromBaseline) console.log(`    ${e}`);
    console.log('  Remove these from BASELINE in scripts/check-workspace-deps-complete.mjs.\n');
  }

  if (newOffenders.length === 0) {
    console.log(
      `✓ no NEW undeclared local @papercusp/* import (${stillInBaseline.length} pre-existing edge(s) still in the shrink-to-empty BASELINE).`,
    );
    process.exit(0);
  }

  console.error('');
  console.error('✗ lint:workspace-deps-complete FAILED — NEW undeclared local @papercusp/* import(s):');
  console.error('  The affected-set reverse-dep walk is built from package.json — an undeclared import');
  console.error('  means a change to the imported package will NOT run the importer\'s tests.');
  console.error('');
  for (const o of newOffenders) {
    const kind = o.targetIsWorkspace ? '' : `  ⚠ target is NOT a root workspace (on disk at ${o.targetDir})`;
    console.error(`    ${o.edge}  (${o.importerDir})${kind}`);
  }

  const wsTargets = newOffenders.filter((o) => o.targetIsWorkspace);
  const nonWsTargets = newOffenders.filter((o) => !o.targetIsWorkspace);

  if (wsTargets.length > 0) {
    console.error(`\n  Fix (target IS a root workspace): add "${wsTargets[0].imported}": "*" (etc.) to the`);
    console.error('  importer\'s dependencies, then `npm run install:safe` to regenerate package-lock.json.');
    console.error('  Do NOT add these to BASELINE.');
  }

  if (nonWsTargets.length > 0) {
    // EI-20028225708881148 — the generic advice above is WRONG for a non-workspace target and
    // breaks the repo if followed. package-lock.json carries its OWN copy of the workspaces
    // array (84 entries) and CI runs `npm ci` strict, so declaring `"<name>": "*"` for a package
    // npm does not treat as a workspace sends npm to the REGISTRY for a private package.
    console.error(`\n  ⚠ Fix (target is NOT a root workspace — ${nonWsTargets.length} above): do NOT use "*".`);
    console.error('  npm resolves "*" from the registry for a package it does not know as a workspace, and');
    console.error('  package-lock.json carries its own workspaces array while CI runs `npm ci` strict — so');
    console.error('  the "*" form breaks the install. Pick one:');
    console.error('    (a) declare it as a path dep, the pattern apps/operator already uses:');
    console.error(`        "${nonWsTargets[0].imported}": "file:<relative-path-to-package>"`);
    console.error('    (b) promote the package to a real root workspace — add it to root package.json');
    console.error('        `workspaces` AND regenerate the lockfile via `npm run install:safe`. Cleanest');
    console.error('        end-state; do it in a QUIET window, since it rewrites node_modules/.bin under');
    console.error('        every concurrent agent\'s in-flight test run.');
    console.error('  Either way ALSO confirm the package is reachable by the affected-set walk:');
    console.error('    node scripts/affected-tests.mjs --changed-paths <pkg>/src/index.ts --print-affected');
    console.error('  Zero AFFECTED_WS lines means changing it runs NOTHING — add it to');
    console.error('  STANDALONE_PACKAGE_DIRS in scripts/affected-tests.mjs (that is the lockfile-free route).');
  }
  process.exit(1);
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}
