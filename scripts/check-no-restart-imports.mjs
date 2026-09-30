#!/usr/bin/env node
/**
 * check-no-restart-imports.mjs — fail-loud guard for the @restart retirement.
 *
 * The shared libs were migrated from the `@restart/*` npm scope to
 * `@papercusp/*` (org transfer + scope rename; see
 * papercusp-systems-abstraction-2026-05-29). The code was *renamed*, not
 * deleted — every lib lives under `@papercusp/*`. This guard keeps the
 * retirement permanent: if any `@restart/*` import or dependency reappears
 * in Papercup, CI fails with a clear "use @papercusp/<name>" message
 * instead of silently resolving (or silently breaking) at runtime.
 *
 *   node scripts/check-no-restart-imports.mjs
 *
 * Scope: tracked code (ts/tsx/mjs/cjs/js) + json (package.json deps, tsconfig
 * path maps, build-config arrays like next transpilePackages / astro noExternal,
 * command tables). Excludes node_modules, dist, _retired, the auto-generated
 * package-lock.json, and historical docs/plans (prose mentions of the old names
 * are history, not live references).
 *
 * Matches ANY @restart/<pkg> reference, not just import syntax — bare config
 * strings are a real miss-class (they pass a running dev server, which cached
 * the old config, but break a fresh build). Learned migrating Restart's sibling
 * libs (Restart scripts/check-migrated-scope.mjs caught exactly these).
 */
import { readFileSync } from 'node:fs';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

// WI-6730: enumerate via the shared helper, which recurses into submodules. A bare
// `git ls-files` does not — it emits one gitlink entry per submodule — so this
// retirement guard never checked a single file inside any of the 39, which is
// exactly where a revived @restart/* import would be least likely to be noticed.
const { files: tracked, unscanned } = listTrackedFiles(ROOT);

const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.startsWith('apps/operator/docs/plans/') ||
  f.startsWith('apps/operator/public/internal/docs/') ||
  f === 'package-lock.json' ||
  f.endsWith('/package-lock.json') ||
  f === 'scripts/check-no-restart-imports.mjs' ||
  // WI-6730: PROSE fixtures, not code. corpus.v1.json is the memory-benchmark text
  // corpus — its documents legitimately *discuss* the Restart codebase ("In the shared
  // Restart checkout…"), and rewriting a benchmark corpus to satisfy an import guard
  // would corrupt the benchmark. Same rationale as the docs/plans + internal/docs
  // exclusions above: this guard polices IMPORTS, and these files contain none.
  /\/(fixtures|__fixtures__)\//.test(f);

// Any @restart/<pkg> reference (imports, deps, tsconfig paths, config strings).
const RE = /@restart\/[a-z0-9-]+/;

/**
 * WI-37717: match against COMMENT-MASKED source, but deliberately NOT string-masked.
 *
 * Comments must be masked: a line like `// migrated from @restart/db` is HISTORY, not a
 * live reference, and failing CI with "✗ @restart/* is RETIRED" while pointing at a
 * migration note is a phantom offender. Measured before this change: both `//` and jsdoc
 * ` * ` mentions flagged. The pre-existing self-exclusion of this very file (see isExcluded)
 * is the same bug patched one-off — the author hit the phantom on their own header.
 *
 * Strings must NOT be masked: the guard's stated miss-class is "bare config strings" —
 * package.json deps, tsconfig path maps, transpilePackages arrays — which ARE string
 * literals. stripCommentsAndStrings would blind the guard to its primary target.
 * (stripCommentsOnly is string-aware, so a `https://` inside a JSON string is not
 * mistaken for a line comment, and it preserves line numbering by blanking in place.)
 *
 * The self-exclusion above still stands and must: this file holds @restart/ in a regex
 * literal and in console.error strings, which comment-masking correctly leaves intact.
 */
const scannableText = (raw) => stripCommentsOnly(raw);

/** Detect on one file's text exactly as the real scan does — 1-based offending line numbers. */
function detectLines(raw) {
  if (!raw.includes('@restart/')) return [];
  const masked = scannableText(raw).split('\n');
  const hits = [];
  raw.split('\n').forEach((_line, i) => {
    if (RE.test(masked[i] ?? '')) hits.push(i + 1);
  });
  return hits;
}

if (process.argv.includes('--self-test')) {
  const cases = [
    // POSITIVE CONTROLS — these must fire, or a clean run is vacuous. They are also the
    // TRIPWIRE: swapping stripCommentsOnly for stripCommentsAndStrings blanks string
    // contents, which kills exactly these, so that "upgrade" fails loudly here.
    { name: 'live import (code)', expect: [1], text: `import x from '@restart/live';` },
    { name: 'package.json dep (STRING — the stated miss-class)', expect: [2],
      text: `{\n  "@restart/config": "1.0.0"\n}` },
    { name: 'tsconfig path map (STRING)', expect: [2],
      text: `{\n  "paths": { "@restart/db": ["../db"] }\n}` },
    { name: 'transpilePackages array (STRING)', expect: [1],
      text: `const c = { transpilePackages: ['@restart/ui'] };` },
    // NEGATIVE CONTROLS — prose about the migration is history, not a live reference.
    { name: 'line comment mentioning the old scope', expect: [],
      text: `// migrated from @restart/db to @papercusp/db\nexport const a = 1;` },
    { name: 'jsdoc block mentioning the old scope', expect: [],
      text: `/**\n * historical: @restart/structured-concurrency was renamed\n */\nexport const b = 2;` },
    // Line 1's only @restart/ is in the TRAILING comment, so line 1 must stay clean while
    // the genuine import on line 2 still fires — the mixed case that proves masking is
    // per-position, not per-file (a whole-file "does it mention it" test would flag both).
    { name: 'trailing comment clean, real import next line still fires', expect: [2],
      text: `import y from '@papercusp/db'; // was @restart/db\nimport z from '@restart/real';` },
    // Line-number fidelity: masking blanks in place, so numbering must not shift.
    { name: 'line numbers survive masking', expect: [4],
      text: `// @restart/old\n// @restart/older\n\nimport q from '@restart/here';` },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = detectLines(c.text);
    const ok = JSON.stringify(got) === JSON.stringify(c.expect);
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : '✗'} ${c.name}${ok ? '' : ` (expected lines ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)})`}`);
  }
  if (failed) {
    console.error(`\n✗ self-test: ${failed} case(s) failed.`);
    console.error('  If the STRING cases failed, someone swapped in a string-masking stripper —');
    console.error('  that blinds this guard to config-string references, its primary target.');
    process.exit(1);
  }
  console.log('\n✓ self-test: comments masked, code + config strings still detected.');
  process.exit(0);
}

const offenders = [];
for (const f of tracked) {
  if (isExcluded(f)) continue;
  if (!/\.(ts|tsx|mjs|cjs|js|json)$/.test(f)) continue;
  let text;
  try {
    text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
  } catch {
    continue;
  }
  // Raw pre-filter is safe because masking is MONOTONIC — it only ever removes
  // occurrences, so a file with no raw hit can never gain one after masking.
  if (!text.includes('@restart/')) continue;
  const maskedLines = scannableText(text).split('\n');
  text.split('\n').forEach((line, i) => {
    // Test the MASKED line; report the ORIGINAL so the message stays readable.
    if (RE.test(maskedLines[i] ?? '')) offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}

if (offenders.length === 0) {
  console.log(
    `✓ no live @restart/* imports or deps — retirement intact (use @papercusp/* only).${describeUnscanned(unscanned)}`,
  );
  process.exit(0);
}

console.error('✗ @restart/* is RETIRED — these were migrated to @papercusp/*.');
console.error('  Replace each `@restart/<name>` with `@papercusp/<name>` (the code is the same, renamed):\n');
for (const o of offenders) console.error('    ' + o);
console.error(`\n  ${offenders.length} live @restart/* reference(s) found. See plan papercusp-systems-abstraction-2026-05-29.`);
process.exit(1);
