#!/usr/bin/env node
/**
 * check-typeless-reexport-trap.mjs — EI-19306560664954248.
 *
 * THE BUG THIS CATCHES
 * A workspace package with no `"type"` field in its package.json ("typeless") is transpiled
 * to CJS by tsx. Node then links named imports of it through **cjs-module-lexer**, which
 * cannot follow `export … from` / `export * from` re-export chains. The namespace links
 * EMPTY, so every named import throws:
 *
 *     SyntaxError: The requested module '.../rerank/src/index.ts'
 *     does not provide an export named 'LOCAL_RERANKER_MODEL'
 *
 * The vicious part: it breaks imports of symbols that are NOT re-exported and previously
 * worked. Adding one re-export line takes down call sites you never touched.
 *
 * WHY A LINT AND NOT JUST A FIX
 * This failure is invisible to every check we run. When it happened live (2026-08-02,
 * @papercusp/rerank), all four affected vitest suites were green 51/51 and `tsc --noEmit`
 * exited 0 on both the lib and its consumer — because vitest/vite BUNDLE rather than link,
 * so the lexer never runs. It reproduced only under an out-of-band `npx tsx` load. Trusting
 * the documented, normally-sufficient verification loop is what ships it; the first symptom
 * is :3070 route/tool 500s hours later, in someone else's lane, naming a module nobody edited.
 *
 * THE THREE CONDITIONS (all required)
 *   (a) the package is TYPELESS — no `"type"` in package.json;
 *   (b) its sources contain `export … from` / `export * from` (a re-export chain);
 *   (c) a `"type":"module"` package NAMED-imports it FROM A `.ts`/`.mts` FILE.
 *
 * Condition (c)'s file extension is the whole precision story, not a detail:
 *   `.ts`/`.mts` are what tsx/node LINK  → the lexer path → the bug bites.
 *   `.tsx`        is Vite/esbuild-BUNDLED → no lexer      → cannot bite.
 * That is why @papercusp/git-graph, @papercusp/ui-primitives and @papercusp/papergrid are
 * correctly SILENT here: they are typeless AND have re-export chains, but are consumed only
 * from `.tsx` and retired code. They are latent, not broken, and a guard that shouted about
 * them would be noise that gets ignored — and then misses the real one.
 *
 * WHY NOT THE CHEAPER (a)+(b) VARIANT (measured 2026-08-03, before building this)
 * Failing on (a)+(b) alone was the originally-proposed shortcut. It flags SIX packages,
 * including `papercusp` (libs/papercusp, 67 chains) and `@papercusp/web` (apps/operator, 25
 * chains, 4654 files). For a borrowable lib the fix genuinely is the one-line
 * `"type":"module"`, but flipping an app package or the libs/papercusp root is a large, risky
 * change — so that guard could only ship permanently red or with a six-entry allowlist, i.e.
 * the parking-lot shape this repo rejects elsewhere. The full three-condition rule has ZERO
 * violations today, so it ships GREEN with an EMPTY allowlist and fails the day someone
 * actually re-creates the outage.
 *
 *   node scripts/check-typeless-reexport-trap.mjs             # report + exit 1 on violations
 *   node scripts/check-typeless-reexport-trap.mjs --list      # list typeless pkgs + why quiet
 *   node scripts/check-typeless-reexport-trap.mjs --self-test # analyzer teeth on fixtures
 *
 * THE FIX when it fires: add `"type": "module"` to the offending package's package.json.
 */
import { firstLiveMatch, stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Globs (as literal parent dirs) whose immediate children are workspace packages. */
export const WORKSPACE_PARENTS = [
  'libs/generic',
  'libs/papercusp/libs',
  'libs/papercusp/packages',
  'packages',
  'apps',
  'libs',
];

/**
 * Deliberately EMPTY. A typeless package that is genuinely named-imported by an ESM `.ts`
 * consumer is a live outage waiting to happen, and the fix is one line — there is no
 * legitimate standing exception. If you are about to add one, add `"type": "module"` instead.
 */
export const ALLOW = new Set([]);

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs']);
/** Extensions node/tsx LINK (lexer path). `.tsx` is deliberately absent — it is bundled. */
export const LINKED_EXT = new Set(['.ts', '.mts']);

/**
 * Generated/static trees are not package module sources. Walking them is both semantically
 * wrong (a vendored browser bundle cannot be a tsx-linked workspace consumer) and expensive:
 * apps/operator/public alone is hundreds of MB of minified JavaScript, while Rust's target/
 * and local .papercusp state can be many GB. Keep this exported so the gating test pins the
 * boundary that makes the live-tree scan deterministic under fleet load.
 */
export const SOURCE_SKIP_DIR = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '_retired',
  '.git',
  '.papercusp',
  '.turbo',
  'out',
  'public',
  'target',
]);

/** `export * from '…'` / `export { a, b } from '…'` — the shapes the lexer cannot follow. */
const REEXPORT_RE = /^\s*export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm;

/**
 * Count re-export chains in one source text. Exported for tests.
 *
 * Counted over the MASKED text: `REEXPORT_RE` is `^`-anchored per line, and a multi-line
 * template literal puts arbitrary text at a line start, so a doc string quoting
 * `export * from '…'` was counted as a real chain (WI-37717). Masking strings is safe HERE
 * precisely because this function only COUNTS — it never reads the captured specifier, and a
 * real chain still matches with its quotes intact and blanks between them.
 *
 * @param {string} text
 * @param {string} [fileName]
 */
export function countReexportChains(text, fileName) {
  // Cheap RAW pre-filter first: masking is MONOTONIC (it only ever removes matches), so a text
  // with no raw match has no masked one either, and the TS parse is skipped for every file that
  // re-exports nothing.
  REEXPORT_RE.lastIndex = 0;
  if (REEXPORT_RE.exec(text) === null) return 0;
  const scan = stripCommentsAndStrings(text, fileName);
  REEXPORT_RE.lastIndex = 0;
  let n = 0;
  while (REEXPORT_RE.exec(scan) !== null) n += 1;
  return n;
}

/**
 * Names of workspace packages NAMED-imported by this text (`import { x } from 'pkg'`).
 * A default or namespace import (`import p from`, `import * as p from`) is NOT affected by
 * the lexer gap in the same way, so it is deliberately not matched. Exported for tests.
 *
 * @param {string} text
 * @param {Iterable<string>} candidateNames
 * @param {string} [fileName]  BRACKETS ARE THE CONTRACT: without them the generated .d.mts
 *        declares this REQUIRED, and every pre-existing two-argument caller (this guard's own
 *        test calls it four times that way) fails with TS2554 — which reads as "fix the callers"
 *        when the real defect is the missing brackets here.
 * @returns {Set<string>}
 */
export function namedImportedPackages(text, candidateNames, fileName) {
  const found = new Set();
  // MATCH ON RAW, VALIDATE THE ANCHOR. Unlike countReexportChains above, this pattern SPANS
  // code and string content — the package NAME it is searching for sits inside the specifier —
  // so masking strings would blank the very evidence and find nothing. Anchoring on the
  // `import` keyword instead keeps a real import while rejecting one quoted inside a template.
  const rawMatches = [];
  for (const name of candidateNames) {
    const re = new RegExp(
      `import\\s*\\{[^}]*\\}\\s*from\\s*['"]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/[^'"]*)?['"]`,
    );
    // Most candidate-name substring hits are prose (especially the root package `papercusp`).
    // Do not pay for a full TS-aware mask unless named-import syntax exists in the raw text.
    if (!re.test(text)) continue;
    rawMatches.push([name, re]);
  }
  if (rawMatches.length === 0) return found;
  const masked = stripCommentsAndStrings(text, fileName);
  for (const [name, re] of rawMatches) {
    if (firstLiveMatch(text, masked, re)) found.add(name);
  }
  return found;
}

/**
 * PURE analyzer — the guard's teeth, independent of the filesystem so it can be tested on
 * synthetic fixtures rather than only on a tree that currently has zero violations.
 *
 * @param {Array<{name:string, dir:string, isEsm:boolean, reexportChains:number,
 *                namedImports:Array<{pkg:string, file:string, linked:boolean}>}>} packages
 * @returns {Array<{pkg:string, dir:string, chains:number,
 *                  consumers:Array<{pkg:string, file:string}>}>}
 */
export function analyzeTypelessReexportTrap(packages) {
  const typeless = new Map();
  for (const p of packages) if (!p.isEsm && p.reexportChains > 0) typeless.set(p.name, p);

  const violations = new Map();
  for (const consumer of packages) {
    // Only an ESM consumer links through the lexer; a typeless consumer is CJS throughout.
    if (!consumer.isEsm) continue;
    for (const imp of consumer.namedImports) {
      // `linked` false ⇒ a .tsx (bundled) import ⇒ the lexer never runs ⇒ not a violation.
      if (!imp.linked) continue;
      const target = typeless.get(imp.pkg);
      if (!target || ALLOW.has(target.name)) continue;
      if (!violations.has(target.name)) {
        violations.set(target.name, {
          pkg: target.name,
          dir: target.dir,
          chains: target.reexportChains,
          consumers: [],
        });
      }
      violations.get(target.name).consumers.push({ pkg: consumer.name, file: imp.file });
    }
  }
  return [...violations.values()];
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SOURCE_SKIP_DIR.has(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (SOURCE_EXT.has(extname(e)) && !e.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * I/O shell: build the package model the pure analyzer consumes.
 *
 * The gate only needs to know whether a typeless package has any re-export chain. Exact
 * counts are retained for the human-facing --list diagnostic, but making every gate run
 * compute them parsed thousands of files after the answer was already known.
 */
export function scanWorkspace(root = ROOT, { exactChains = false } = {}) {
  const dirs = new Map();
  for (const parent of WORKSPACE_PARENTS) {
    let entries;
    try {
      entries = readdirSync(join(root, parent));
    } catch {
      continue;
    }
    for (const e of entries) {
      const dir = join(parent, e);
      if (dirs.has(dir)) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      if (pkg?.name) dirs.set(dir, pkg);
    }
  }
  // Only TYPELESS packages can be a trap target, and only ESM packages can be a trapping
  // consumer — so scan each package for the ONE thing it could contribute, and match imports
  // against the ~7 typeless names rather than all ~95. Scanning everything for everything
  // meant ~95 regex executions per file across ~10k files (a 19s test on the critical path of
  // every affected run — the serial-fs-loop anti-pattern in /internal/docs/performance).
  const typelessNames = [...dirs.values()].filter((p) => p.type !== 'module').map((p) => p.name);
  const packages = [];
  for (const [dir, pkg] of dirs) {
    const isEsm = pkg.type === 'module';
    const targets = typelessNames.filter((n) => n !== pkg.name);
    let chains = 0;
    const namedImports = [];
    for (const file of walk(join(root, dir))) {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      // A typeless package contributes its re-export count; an ESM one cannot be a target.
      if (!isEsm && text.includes('export')) {
        chains += countReexportChains(text, file);
        if (chains > 0 && !exactChains) break;
      }
      // Only an ESM consumer links through the lexer, and only an `import` line can trap.
      if (!isEsm || !text.includes('import')) continue;
      // Cheap substring pre-filter before the per-name regex — most files name none of them.
      const present = targets.filter((n) => text.includes(n));
      if (present.length === 0) continue;
      const rel = relative(root, file);
      const linked = LINKED_EXT.has(extname(file));
      for (const target of namedImportedPackages(text, present, file)) {
        namedImports.push({ pkg: target, file: rel, linked });
      }
    }
    packages.push({ name: pkg.name, dir, isEsm, reexportChains: chains, namedImports });
  }
  return packages;
}

function selfTest() {
  const esmConsumer = (imports) => ({
    name: '@x/consumer',
    dir: 'p/consumer',
    isEsm: true,
    reexportChains: 0,
    namedImports: imports,
  });
  const trap = {
    name: '@x/trap',
    dir: 'p/trap',
    isEsm: false,
    reexportChains: 3,
    namedImports: [],
  };
  const cases = [
    [
      'fires on the real rerank shape (typeless + chains + ESM .ts named-import)',
      [trap, esmConsumer([{ pkg: '@x/trap', file: 'a.ts', linked: true }])],
      1,
    ],
    [
      'silent when the consumer is .tsx (bundled, no lexer) — the 3 latent libs',
      [trap, esmConsumer([{ pkg: '@x/trap', file: 'a.tsx', linked: false }])],
      0,
    ],
    [
      'silent when the target has no re-export chain',
      [{ ...trap, reexportChains: 0 }, esmConsumer([{ pkg: '@x/trap', file: 'a.ts', linked: true }])],
      0,
    ],
    [
      'silent when the target is ESM',
      [{ ...trap, isEsm: true }, esmConsumer([{ pkg: '@x/trap', file: 'a.ts', linked: true }])],
      0,
    ],
    [
      'silent when the consumer is itself typeless (CJS throughout)',
      [trap, { ...esmConsumer([{ pkg: '@x/trap', file: 'a.ts', linked: true }]), isEsm: false }],
      0,
    ],
  ];
  let bad = 0;
  for (const [label, pkgs, want] of cases) {
    const got = analyzeTypelessReexportTrap(pkgs).length;
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`${ok ? '  ✓' : '  ✗'} ${label} (want ${want}, got ${got})`);
  }
  if (countReexportChains(`export { a } from './x';\nexport * from './y';\nconst z = 1;`) !== 2) {
    console.log('  ✗ countReexportChains miscounted'); bad += 1;
  } else console.log('  ✓ countReexportChains counts both re-export shapes');
  console.log(bad === 0 ? '\n✓ self-test passed' : `\n✗ ${bad} self-test failure(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const packages = scanWorkspace(ROOT, { exactChains: argv.includes('--list') });
  const violations = analyzeTypelessReexportTrap(packages);

  if (argv.includes('--list')) {
    const typeless = packages.filter((p) => !p.isEsm);
    console.log(`typeless workspace packages: ${typeless.length} of ${packages.length}`);
    for (const p of typeless.sort((a, b) => b.reexportChains - a.reexportChains)) {
      const why = p.reexportChains === 0 ? 'no re-export chains' : 'no ESM .ts/.mts named-importer';
      console.log(`  ${String(p.reexportChains).padStart(3)} chains  ${p.name}  (${p.dir}) — quiet: ${why}`);
    }
  }

  if (violations.length === 0) {
    console.log(
      `✓ typeless-reexport-trap: no typeless package with re-export chains is named-imported ` +
        `by an ESM .ts/.mts module (${packages.length} workspace packages scanned).`,
    );
    process.exit(0);
  }

  console.error(
    `✗ typeless-reexport-trap: ${violations.length} package(s) will link an EMPTY namespace under tsx.\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.pkg}  (${v.dir}) — typeless, ${v.chains} re-export chain(s), named-imported by:`);
    for (const c of v.consumers.slice(0, 8)) console.error(`      ${c.pkg}  ${c.file}`);
    if (v.consumers.length > 8) console.error(`      … +${v.consumers.length - 8} more`);
    console.error(`    FIX: add "type": "module" to ${v.dir}/package.json\n`);
  }
  console.error(
    '  Why your tests did not catch this: vitest/vite BUNDLE, so cjs-module-lexer never runs.\n' +
      '  `tsc --noEmit` passes too. It reproduces only under a real tsx/node load (EI-19306560664954248).',
  );
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
