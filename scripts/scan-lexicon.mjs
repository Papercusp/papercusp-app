#!/usr/bin/env node
/**
 * scan-lexicon.mjs — repo-wide scan for retired bee/hive/queen/sentinel
 * terminology (cup-lexicon-full-rename-2026-07-09, P-011).
 *
 * Codifies the ad-hoc grep methodology used throughout this plan's Slices
 * B/E/F/H (see WI-3466's P-010 prep checkpoint) into a durable, reusable
 * script instead of re-deriving the exclude/keep sets by hand each time.
 *
 * Run:  node scripts/scan-lexicon.mjs             (report, exit 0 always)
 *       node scripts/scan-lexicon.mjs --check      (exit 1 if any non-kept hit)
 *       node scripts/scan-lexicon.mjs --json       (machine-readable report)
 *       node scripts/scan-lexicon.mjs --dir <path> (scan a subtree only)
 *
 * Scope: uses `git ls-files` (tracked files only — respects .gitignore
 * automatically, so generated/build artifacts that aren't tracked are never
 * false-flagged). Word-bounded, case-insensitive match on: hive, bee,
 * beekeeper, queen, sentinel.
 *
 * KEEP-SET (D-002 of cup-lexicon-full-rename-2026-07-09 + prior restore-pot
 * decisions) — a line is treated as a deliberate keeper, not a rename miss,
 * when it ALSO contains one of these on the same line:
 *   - scout, overwatch, planner, red-queen / red_queen (role+table names kept)
 *   - THE_HIVE, RED_QUEEN (flag names kept)
 *   - the-hive (the flag-gated skin-pack brand, libs/generic/lexicon)
 *   - hyperswarm, hyperbee (the underlying npm library terms — NOT ours to rename)
 * This is a heuristic, not a guarantee — always eyeball the flagged hits in
 * a genuinely ambiguous file before treating a "clean" result as final.
 *
 * EXCLUDE-SET (paths never scanned — historical/frozen/out-of-scope per
 * D-002 and the plan's own exclude list):
 *   node_modules/, dist/, dist-host, .nx/, _retired/, scratchpad/,
 *   libs/generic/lexicon/, public/internal/, .materialized/,
 *   src-tauri/sidecar, env-sidecars/staging, .wi*-cargo-target/,
 *   .papercusp/, .git/, and all historical migration SQL
 *   (libs/papercusp/libs/db/sql/**) — those are frozen, never hand-edited.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const args = process.argv.slice(2);
const checkMode = args.includes('--check');
const jsonMode = args.includes('--json');
const dirIdx = args.indexOf('--dir');
const scanDir = dirIdx >= 0 ? args[dirIdx + 1] : null;

const EXCLUDE_PATH_RE =
  /(^|\/)(node_modules|dist|dist-host|\.nx|_retired|scratchpad|libs\/generic\/lexicon|public\/internal|\.materialized|src-tauri\/sidecar|env-sidecars\/staging|\.wi[0-9]+-cargo-target|\.papercusp|\.git)(\/|$)/;
const EXCLUDE_MIGRATION_SQL_RE = /^libs\/papercusp\/libs\/db\/sql\//;

const TERM_RE = /\b(hive|hives|beekeeper|beekeepers|bee|bees|queen|queens|sentinel|sentinels)\b/i;
const KEEP_RE =
  /\b(scout|overwatch|planner|red-queen|red_queen|the-hive|hyperswarm|hyperbee)\b|THE_HIVE|RED_QUEEN/i;

const root = resolve(import.meta.dirname, '..');

// WI-6666: plain `git ls-files` STOPS AT THE SUPERPROJECT BOUNDARY — a submodule
// (libs/generic/**, libs/papercusp/**, papercusp-desktop/**) is a single gitlink
// entry with no extension, so it and everything inside it was never opened. This
// scan is explicitly repo-wide (it carves out only the frozen migration-SQL
// subfolder of libs/papercusp, implying the REST of that submodule is in scope),
// so the old enumerator silently skipped ~24% of the tree it claimed to cover.
// `listTrackedFiles` recurses into submodules; `unscanned` is surfaced in the
// report so a genuinely-uninitialized submodule (libs/zero-harness) still reads
// as "not checked" rather than silently "clean".
function trackedFiles() {
  const { files: out, unscanned } = listTrackedFiles(root);
  const filtered = out.filter((f) => {
    if (EXCLUDE_PATH_RE.test(f)) return false;
    if (EXCLUDE_MIGRATION_SQL_RE.test(f)) return false;
    if (scanDir && !f.startsWith(scanDir.replace(/^\.?\//, ''))) return false;
    return true;
  });
  return { files: filtered, unscanned };
}

function isBinaryLike(path) {
  return /\.(png|jpg|jpeg|gif|webp|ico|svg|woff2?|ttf|eot|pdf|lock|map)$/i.test(path);
}

// Generated test-run reports (junit.xml, coverage/**) — accidentally tracked
// build/CI artifacts, not source; they echo whatever test names existed at
// the last local run and are regenerated on every run. Never a rename target.
function isGeneratedReport(path) {
  return /(^|\/)junit\.xml$/.test(path) || /(^|\/)coverage\//.test(path);
}

const { files, unscanned } = trackedFiles();
const hits = []; // { file, line, text, kept }
let scanned = 0;

for (const file of files) {
  if (isBinaryLike(file)) continue;
  if (isGeneratedReport(file)) continue;
  let content;
  try {
    content = readFileSync(resolve(root, file), 'utf8');
  } catch {
    continue; // deleted/symlink race, unreadable binary, etc — skip
  }
  scanned++;
  if (!TERM_RE.test(content)) continue;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!TERM_RE.test(line)) continue;
    hits.push({ file, line: i + 1, text: line.trim().slice(0, 200), kept: KEEP_RE.test(line) });
  }
}

const nonKept = hits.filter((h) => !h.kept);
const kept = hits.filter((h) => h.kept);
const isDocFile = (f) => f.endsWith('.mdx') || f.endsWith('.md');
const nonKeptDocs = nonKept.filter((h) => isDocFile(h.file));
const nonKeptCode = nonKept.filter((h) => !isDocFile(h.file));

if (jsonMode) {
  console.log(
    JSON.stringify(
      { scannedFiles: scanned, totalHits: hits.length, nonKeptHits: nonKept.length, keptHits: kept.length, unscanned, hits },
      null,
      2,
    ),
  );
} else {
  console.log(
    `scan-lexicon: ${scanned} tracked files scanned, ${hits.length} hits ` +
      `(${nonKept.length} non-kept [${nonKeptCode.length} code, ${nonKeptDocs.length} docs/mdx — ` +
      `docs are frequently HISTORICAL runbooks describing past file paths, D-002 "historical plans/briefs untouched" ` +
      `— review before treating as a rename miss], ${kept.length} kept-set)` +
      (scanDir ? '' : describeUnscanned(unscanned)),
  );
  if (nonKept.length > 0) {
    console.log('\nNon-kept hits (review each — real rename miss vs. a keep-set case this heuristic missed):');
    const byFile = new Map();
    for (const h of nonKept) {
      if (!byFile.has(h.file)) byFile.set(h.file, []);
      byFile.get(h.file).push(h);
    }
    for (const [file, fileHits] of byFile) {
      console.log(`\n  ${file} (${fileHits.length}):`);
      for (const h of fileHits.slice(0, 5)) console.log(`    ${h.line}: ${h.text}`);
      if (fileHits.length > 5) console.log(`    … +${fileHits.length - 5} more`);
    }
  }
}

if (checkMode && nonKept.length > 0) {
  console.error(`\n❌ scan-lexicon --check: ${nonKept.length} non-kept old-lexicon hit(s) remain.`);
  process.exit(1);
}
