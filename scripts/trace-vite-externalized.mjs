#!/usr/bin/env node
/**
 * trace-vite-externalized.mjs — ATTRIBUTION companion to check-vite-externalized-warnings.mjs
 * (WI-4518).
 *
 * The count gate (check-vite-externalized-warnings.mjs) tells you the SPA bundle references N
 * externalized node/server modules, but not WHICH client code is responsible, nor — crucially —
 * whether a given reach is an eval-time WHITE-PAGE RISK or benign lazy-chunk erosion. Those are
 * very different: an externalized stub THROWS on property access at module-eval, so a server
 * module reached EAGERLY (via static `import` edges from the SPA entry, no lazy/`await import`
 * boundary in between) blanks the WHOLE app the moment any route evaluates it — that is exactly
 * what shipped on 2026-07-04 (tooldef run-script's top-level `import {Worker} from
 * 'node:worker_threads'`) and 2026-07-12. The same server module reached only through a
 * `await import()` route-split boundary sits in its own lazy chunk and is harmless-but-noisy.
 *
 * This tool runs the REAL operator-vite build (write:false — no dist emit) with a tracer plugin
 * and classifies every externalized builtin by HOW the SPA reaches it:
 *   - EAGER   — a client `src/` module statically reaches a module that STATICALLY imports the
 *               builtin (importedIds, i.e. non-`import type`, non-`await import`). White-page risk.
 *               This set should stay ~empty (only intentional polyfills, e.g. buffer).
 *   - LAZY    — reachable only across an `await import()` / route-split boundary. Erosion, not a
 *               crash. This is the bulk of the count.
 * For each EAGER reach it prints the shortest static import chain from a client entry — the P-010
 * "name the file" philosophy (same as lint:tsc's per-file attribution).
 *
 * The graph logic is pure + unit-tested (check-vite-externalized-warnings has no build to mock);
 * see trace-vite-externalized.test.ts.
 *
 * Usage:  npm run trace:vite-externalized                         # full report
 *         npm run trace:vite-externalized -- --json               # machine-readable stdout
 *         npm run trace:vite-externalized:json-file -- /tmp/report.json
 *                                                                  # machine-readable file
 */
import { isBuiltin, createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = resolve(ROOT, 'apps/operator-vite');
const SRC = resolve(APP_DIR, 'src');

/**
 * Modules reachable from `eagerRoots` following STATIC edges only (never crossing a dynamic
 * `await import()` boundary). Pure — takes a plain adjacency map.
 * @param {Iterable<string>} eagerRoots
 * @param {Map<string,string[]>} staticEdges  parent id -> static child ids
 * @returns {Set<string>}
 */
export function reachableStatic(eagerRoots, staticEdges) {
  const seen = new Set();
  const q = [...eagerRoots];
  for (const r of q) seen.add(r);
  while (q.length) {
    const cur = q.shift();
    for (const child of staticEdges.get(cur) || []) {
      if (!seen.has(child)) {
        seen.add(child);
        q.push(child);
      }
    }
  }
  return seen;
}

/**
 * Classify each externalized builtin as EAGER (statically reachable from an eager root and
 * statically importing the builtin) vs not. Pure.
 * @param {object} p
 * @param {Iterable<string>} p.eagerRoots
 * @param {Map<string,string[]>} p.staticEdges
 * @param {Map<string,Set<string>>} p.builtinStaticImporters  builtin -> modules with a STATIC import of it
 * @returns {{ reachCount:number, eager:Array<{builtin:string, eagerImporters:string[]}> }}
 */
export function computeEagerExternalized({ eagerRoots, staticEdges, builtinStaticImporters }) {
  const reach = reachableStatic(eagerRoots, staticEdges);
  const eager = [];
  for (const [builtin, importers] of builtinStaticImporters) {
    const eagerImporters = [...importers].filter((id) => reach.has(id));
    if (eagerImporters.length) eager.push({ builtin, eagerImporters });
  }
  eager.sort((a, b) => b.eagerImporters.length - a.eagerImporters.length);
  return { reachCount: reach.size, eager };
}

/**
 * Builtins that are ALLOWED to be reached eagerly because they are genuinely browser-polyfilled
 * (not server-only stubs that throw). `buffer` has a real polyfill (src/buffer-polyfill.ts + the
 * vite buffer shim) that the SPA intentionally loads at boot. Everything else reaching the eager
 * graph is a white-page risk. Shrink-only: adding a builtin here needs a justification, like the
 * dark-flags allowlist.
 */
export const ALLOWED_EAGER_BUILTINS = new Set(['buffer']);

/**
 * Gate decision for the eager-reach guard. Pure. A non-allowlisted eager externalized reach is a
 * VIOLATION (eval-time white-page risk). Mirrors lint-tsc's "named regression" shape.
 * @param {object} p
 * @param {Array<{builtin:string, eagerImporters:string[]}>} p.eager
 * @param {Set<string>} [p.allowlist]
 * @returns {{ ok:boolean, violations:Array<{builtin:string, eagerImporters:string[]}>, allowed:string[] }}
 */
export function decideEager({ eager, allowlist = ALLOWED_EAGER_BUILTINS }) {
  const violations = eager.filter((e) => !allowlist.has(e.builtin));
  const allowed = eager.filter((e) => allowlist.has(e.builtin)).map((e) => e.builtin);
  return { ok: violations.length === 0, violations, allowed };
}

/** Shortest static chain from any eager root down to `target`. Pure. */
export function shortestStaticChain(eagerRoots, staticEdges, target) {
  const seen = new Set(eagerRoots);
  const q = [...eagerRoots].map((r) => [r]);
  let guard = 0;
  while (q.length && guard++ < 1_000_000) {
    const path = q.shift();
    const cur = path[path.length - 1];
    if (cur === target) return path;
    for (const child of staticEdges.get(cur) || []) {
      if (!seen.has(child)) {
        seen.add(child);
        q.push([...path, child]);
      }
    }
  }
  return null;
}

/**
 * Parse the optional machine-readable output path. The path is deliberately a separate
 * argument so `npm run` lifecycle text can never be written into the report itself.
 * @param {string[]} args
 * @returns {string|null}
 */
export function parseJsonFileArg(args) {
  const matches = args
    .map((arg, index) => ({ arg, index }))
    .filter(({ arg }) => arg === '--json-file' || arg.startsWith('--json-file='));
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error('--json-file may be specified only once');

  const { arg, index } = matches[0];
  const path = arg.startsWith('--json-file=') ? arg.slice('--json-file='.length) : args[index + 1];
  if (!path || (arg === '--json-file' && path.startsWith('--'))) {
    throw new Error('--json-file requires a path argument');
  }
  return path;
}

/** Write one complete, parseable report document. */
export async function writeJsonReport(path, report) {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main() {
  const jsonOut = process.argv.includes('--json');
  const jsonFile = parseJsonFileArg(process.argv.slice(2));
  const checkMode = process.argv.includes('--check');
  const appRequire = createRequire(APP_DIR + '/package.json');
  const { build } = await import(appRequire.resolve('vite'));

  /** @type {Map<string,string[]>} */ const staticEdges = new Map(); // parent -> static child module ids
  const entryIds = new Set();
  // Externalized builtins are rewritten to virtual ids (\0vite-browser-external:…) so they never
  // appear in moduleParsed.importedIds — capture them at RESOLVE time instead. A `await import()`
  // routes through resolveDynamicImport FIRST; when it returns null it ALSO reaches resolveId, so
  // we record the dynamic occurrences and SUBTRACT them to get the purely-static importers.
  const staticBuiltinPairs = new Set(); // `${builtin}\0${importer}`
  const dynamicBuiltinPairs = new Set();
  const key = (b, imp) => `${b}\0${imp}`;
  const norm = (s) => s.replace(/^node:/, '');

  const tracer = {
    name: 'externalized-attribution-tracer',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer && isBuiltin(source)) staticBuiltinPairs.add(key(norm(source), importer));
      return null;
    },
    resolveDynamicImport(source, importer) {
      if (importer && typeof source === 'string' && isBuiltin(source)) {
        dynamicBuiltinPairs.add(key(norm(source), importer));
      }
      return null;
    },
    moduleParsed(info) {
      staticEdges.set(info.id, info.importedIds.filter((c) => !isBuiltin(c)));
      if (info.isEntry) entryIds.add(info.id);
    },
  };

  await build({
    root: APP_DIR,
    configFile: resolve(APP_DIR, 'vite.config.ts'),
    logLevel: 'error',
    plugins: [tracer],
    build: { write: false },
  });

  // Purely-static importers of each builtin = seen at resolveId, NOT (only) via a dynamic import.
  /** @type {Map<string,Set<string>>} */ const builtinStaticImporters = new Map();
  for (const pair of staticBuiltinPairs) {
    if (dynamicBuiltinPairs.has(pair)) continue; // dynamic-only reach — a lazy chunk, not eval-time
    const [builtin, importer] = pair.split('\0');
    if (!builtinStaticImporters.has(builtin)) builtinStaticImporters.set(builtin, new Set());
    builtinStaticImporters.get(builtin).add(importer);
  }
  if (process.env.TRACE_VITE_DEBUG) {
    console.error(
      `[debug] staticPairs=${staticBuiltinPairs.size} dynamicPairs=${dynamicBuiltinPairs.size} ` +
        `staticImporterBuiltins=${builtinStaticImporters.size} modules=${staticEdges.size} entries=${entryIds.size}`,
    );
  }

  const eagerRoots = [...entryIds];
  const { reachCount, eager } = computeEagerExternalized({ eagerRoots, staticEdges, builtinStaticImporters });
  const rel = (id) => (id.startsWith('/') ? relative(ROOT, id) : id);
  const isSrc = (id) => id.startsWith(SRC + '/');

  const report = {
    entries: eagerRoots.map(rel),
    eagerReachableModules: reachCount,
    distinctExternalizedBuiltins: builtinStaticImporters.size,
    eagerExternalized: eager.map(({ builtin, eagerImporters }) => {
      // Attribute: shortest static chain from an entry to the first eager static importer.
      const chain = shortestStaticChain(eagerRoots, staticEdges, eagerImporters[0]) || [];
      const clientEntry = [...chain].reverse().find(isSrc) || chain.find(isSrc) || null;
      return {
        builtin,
        eagerImporterCount: eagerImporters.length,
        exampleImporter: rel(eagerImporters[0]),
        clientEntry: clientEntry ? rel(clientEntry) : null,
        chain: chain.map(rel),
      };
    }),
  };

  if (jsonFile) {
    await writeJsonReport(jsonFile, report);
    console.error(`JSON trace report written to ${jsonFile}`);
  }

  if (checkMode) {
    const { ok, violations, allowed } = decideEager({ eager });
    if (ok) {
      console.log(
        `✓ eager externalized-reach guard: no server/node builtin reaches the SPA entry EAGERLY` +
          (allowed.length ? ` (allowlisted, browser-polyfilled: ${allowed.join(', ')})` : '') +
          `. No eval-time white-page risk.`,
      );
      process.exit(0);
    }
    console.error(`❌ eager externalized-reach guard: ${violations.length} NEW server builtin(s) reach the SPA EAGERLY —`);
    console.error(`   each blanks the WHOLE desktop app when its module evaluates (the 2026-07-04 / 2026-07-12 class).`);
    for (const v of violations.map((e) => report.eagerExternalized.find((r) => r.builtin === e.builtin) ?? e)) {
      console.error(`\n   • node:${v.builtin}  client entry: ${v.clientEntry ?? v.eagerImporters?.[0] ?? '?'}`);
      for (const step of v.chain ?? []) console.error(`        → ${step}`);
    }
    console.error(`\n   Fix: import type, lazy \`await import()\` inside the fn, or a browser-safe subpath/shim.`);
    console.error(`   If genuinely browser-polyfilled, add it to ALLOWED_EAGER_BUILTINS with a justification.`);
    process.exit(1);
  }

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 1));
  } else {
    console.log(`\nEAGER externalized-module reach — the WHITE-PAGE-RISK subset (WI-4518)\n`);
    console.log(`  build entries: ${report.entries.join(', ')}`);
    console.log(`  eager-reachable modules: ${reachCount}   distinct externalized builtins (any): ${builtinStaticImporters.size}`);
    if (report.eagerExternalized.length === 0) {
      console.log(`\n  ✓ No server/node builtin is reached EAGERLY (static-only) from the SPA entry.`);
      console.log(`    (The count gate's remaining warnings are all behind lazy import boundaries.)`);
    } else {
      console.log(`\n  ⚠ ${report.eagerExternalized.length} builtin(s) reached EAGERLY — each blanks the app if its module evaluates:\n`);
      for (const e of report.eagerExternalized) {
        console.log(`  • node:${e.builtin}  (${e.eagerImporterCount} eager importer(s))  client entry: ${e.clientEntry ?? '?'}`);
        for (const step of e.chain) console.log(`        → ${step}`);
      }
      console.log(`\n  Fix each: import type, lazy \`await import()\`, or a browser-safe subpath/shim.`);
    }
    console.log('');
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
