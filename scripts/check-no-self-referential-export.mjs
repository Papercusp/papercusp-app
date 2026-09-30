#!/usr/bin/env node
/**
 * check-no-self-referential-export.mjs — fail-loud guard for a self-referential
 * `export const X = X;` shim (EI-8850).
 *
 * Hit twice in one wake (2026-07-09, WI-3577 side-quest): an in-flight rename
 * lane landed a "forward-compat alias" shim of the shape
 * `export const resolvePotHomeSlug = resolvePotHomeSlug;` — written AFTER the
 * function had already been renamed to the target name, so the shim collides
 * with the function's own export under the SAME identifier. This is always
 * either a no-op (a `const` shadowing itself, a TDZ ReferenceError at module
 * init) or, worse, a duplicate-export build break: esbuild fails loudly
 * ("Multiple exports with the same name") on `bundle-host.sh`, which
 * crash-loops the shared staging bg-host (:3170) for the WHOLE fleet — anyone
 * restarting staging hits it, not just the renaming agent, and the failure
 * only surfaces at restart time (no restart = no signal the tree is broken).
 *
 * A genuine back-compat alias exports the OLD name pointing at the NEW
 * implementation (`export const oldName = newName;` where oldName !== newName).
 * `export const X = X;` (same identifier both sides) is never that — it is a
 * mechanical, zero-false-positive mistake pattern, cheap to catch before it
 * ever reaches the shared tree.
 *
 *   node scripts/check-no-self-referential-export.mjs
 *   node scripts/check-no-self-referential-export.mjs --self-test
 */
import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs']);

// Matches `export const X = X;` / `export let X = X;` / `export var X = X;`,
// same bare identifier on both sides, optional whitespace, optional trailing
// semicolon. Deliberately narrow (bare identifier only, no member access / call
// / generic) to stay zero-false-positive — a legitimate rename alias always has
// two DIFFERENT identifiers (`export const oldName = newName;`), which this
// pattern never matches.
const SELF_REF_EXPORT = /^\s*export\s+(?:const|let|var)\s+(\w+)\s*=\s*\1\s*;?\s*$/;

/**
 * MATCH ON MASKED, REPORT RAW. `SELF_REF_EXPORT` is `^`-anchored per line, and a multi-line
 * template literal puts arbitrary text at the start of a line — so a doc string or a code
 * generator emitting `export const foo = foo;` minted a phantom offender (WI-37717). The shape
 * being detected is pure CODE, with no evidence read out of any string, so masking strings is
 * unambiguously right here. Reporting still reads the RAW line: the mask is length-preserving,
 * so line i of both texts is the same line, and an offender's `text` must show real source
 * rather than the blanked form.
 */
export function findSelfReferentialExports(path, text) {
  const hits = [];
  const lines = text.split('\n');
  // MASK LAZILY, ONLY FOR CANDIDATE FILES. Masking is MONOTONIC — blanking can only ever REMOVE
  // a match, never create one — so a line with no RAW match cannot produce a masked one, and the
  // TS parse behind the mask can be skipped outright. That is not a micro-optimisation: this
  // guard scans every tracked source file in the repo, and parsing all of them took this from
  // sub-second to over two minutes. A clean tree has zero hits, so the parse now runs ~never.
  let scan = null;
  for (let i = 0; i < lines.length; i++) {
    if (!SELF_REF_EXPORT.test(lines[i])) continue;
    scan ??= stripCommentsAndStrings(text, path).split('\n');
    const m = SELF_REF_EXPORT.exec(scan[i]);
    if (m) hits.push({ path, line: i + 1, identifier: m[1], text: lines[i].trim() });
  }
  return hits;
}

function extensionOf(file) {
  const slash = file.lastIndexOf('/');
  const dot = file.lastIndexOf('.');
  if (dot <= slash) return '';
  return file.slice(dot);
}

function isScannedPath(file) {
  return SOURCE_EXTENSIONS.has(extensionOf(file)) && !file.endsWith('.d.ts');
}

// WI-6730: enumerate via the shared helper, which recurses into submodules. The
// previous `git ls-files -z` did not — it emits one gitlink entry per submodule —
// so this guard never scanned a single source file inside any of the 39.
let unscannedSubmodules = [];
function trackedSourceFiles() {
  const { files, unscanned } = listTrackedFiles(ROOT);
  unscannedSubmodules = unscanned;
  return files.filter(isScannedPath);
}

function scanTree() {
  const offenders = [];
  for (const file of trackedSourceFiles()) {
    let text;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue; // File vanished between git ls-files and read, or is binary.
    }
    offenders.push(...findSelfReferentialExports(file, text));
  }
  return offenders;
}

function runSelfTest() {
  const cases = [
    { name: 'clean const export', text: 'export const foo = 1;\n', count: 0 },
    { name: 'genuine rename alias (different names)', text: 'export const oldName = newName;\n', count: 0 },
    { name: 'function declaration untouched', text: 'export function foo() {}\n', count: 0 },
    { name: 'flags self-referential const', text: 'export const resolvePotHomeSlug = resolvePotHomeSlug;\n', count: 1 },
    { name: 'flags self-referential let, no semicolon', text: 'export let x = x\n', count: 1 },
    { name: 'flags self-referential var, extra whitespace', text: 'export   var   y   =   y  ;\n', count: 1 },
    { name: 'ignores member-access rhs (not a bare self-ref)', text: 'export const foo = obj.foo;\n', count: 0 },
    { name: 'ignores call-expression rhs', text: 'export const foo = foo();\n', count: 0 },
  ];
  let failed = 0;
  for (const c of cases) {
    const hits = findSelfReferentialExports('fixture.ts', c.text);
    if (hits.length !== c.count) {
      failed++;
      console.error(`  x ${c.name} — expected ${c.count}, got ${hits.length}: ${JSON.stringify(hits)}`);
    }
  }
  if (failed) {
    console.error(`\ncheck-no-self-referential-export --self-test: ${failed} case(s) FAILED`);
    process.exit(1);
  }
  console.log(`check-no-self-referential-export --self-test: all ${cases.length} cases passed`);
}

function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const offenders = scanTree();
  if (offenders.length === 0) {
    console.log(
      `check-no-self-referential-export: clean — no \`export const X = X;\` shims in tracked source files${describeUnscanned(unscannedSubmodules)}`,
    );
    return;
  }
  console.error(
    `\ncheck-no-self-referential-export: ${offenders.length} self-referential export shim(s) found (EI-8850).\n` +
      'This pattern (`export const X = X;`, same identifier both sides) is always either a no-op or a duplicate-\n' +
      'export build break that crash-loops the shared bg-host bundle for the whole fleet. A genuine back-compat\n' +
      'alias exports the OLD name pointing at the NEW implementation: `export const oldName = newName;`.\n',
  );
  for (const o of offenders) {
    console.error(`  ${o.path}:${o.line}  ${o.text}`);
  }
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
