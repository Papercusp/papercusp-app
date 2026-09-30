#!/usr/bin/env node
/**
 * check-green-checkpoint-tag — WI-37605.
 *
 * THE INVARIANT: no executable line may hardcode the green-checkpoint production tag. Narration
 * goes through `orchestratorStdoutTag()` (packages/operator-core/lib/release/checkpoint-log-tags.ts),
 * which resolves to the FIXTURE tag when the emitting process is under a test runner.
 *
 * WHY IT MATTERS. The gate's own suites drive production code paths, and vitest captures their
 * stdout VERBATIM into the persisted verdict log. A hardcoded prefix therefore emits a line
 * byte-identical to a real gate decision, with the only provenance (vitest's `stdout | <file>`
 * header) on a SEPARATE line that no line-oriented grep returns. WI-7274 closed this for
 * green-checkpoint.ts's `log()` funnel; it stayed open everywhere else for eight days and three
 * independent sightings (EI-19377144204204163, EI-19381230214830901, WI-37605).
 *
 * TWO ROUTES, both measured on real verdict logs on 2026-08-10 and both fixed by WI-37605:
 *   A. a `log()` call site that ALSO hardcodes the prefix -> the line is emitted DOUBLE-tagged
 *      (`[green-checkpoint:TEST-FIXTURE] [green-checkpoint] ...`). It carries the fixture tag AND
 *      the production tag, so it still answers a plain grep. Measured 6 such lines in EACH of the
 *      4 newest verdict logs, all from one call site.
 *   B. a direct `console.*` site with no funnel at all -> emitted untagged under test, i.e. a
 *      perfect impostor. All 24 sites in release-actions.ts were this.
 *
 * ⚠ Route A is why the pre-existing guard did not catch this. That test asserts
 * `ORCHESTRATOR_STDOUT_TAG_UNDER_TEST` does not CONTAIN `ORCHESTRATOR_STDOUT_TAG` — true, and a
 * property of the two CONSTANTS. The property its doc-comment claims ("so `grep [green-checkpoint]`
 * drops fixtures") is about emitted LINES, and a line can contain both tags no matter how distinct
 * the constants are. Anchoring on the constants could never see it; this scans the EMIT SITES.
 *
 * SELF-MATCH. A guard that scans whole files eventually flags its own fixtures. The needle here is
 * therefore ASSEMBLED AT RUNTIME from fragments, so this file — banner, allowlist, error strings —
 * contains no literal occurrence of it and needs no self-exclusion carve-out (a carve-out is itself
 * a hole: it would exempt any future real emit added to this file).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

/** Roots that can contain gate narration.
 *  ⚠ MIRRORED as `GC_TAG_SOURCE_ROOTS` in scripts/affected-tests.mjs so the repo-wide guard
 *  attaches on the same set. The mirror is ASSERTED equal to this export by
 *  affected-tests-repo-wide-invariant-guards.test.ts — widen the scan and that list must follow,
 *  or the guard silently stops firing on the new root. */
export const GC_TAG_SOURCE_ROOTS = ['packages/operator-core/lib', 'apps/operator/lib'];

/** The ONE file allowed to contain the literal in executable code: it DEFINES it.
 *  Deliberately the only entry. Every other legitimate mention lives in a comment, and comments
 *  are stripped before matching — so quoting the tag in prose never needs an allowlist entry, and
 *  an allowlist that stays at length 1 is evidence the invariant is real rather than negotiated. */
export const ALLOWLIST = new Set(['packages/operator-core/lib/release/checkpoint-log-tags.ts']);

/** Assembled at runtime — see SELF-MATCH above. */
export function productionTag() {
  return `${'['}green-${'checkpoint'}${']'}`;
}

// Comment-blanking lives in scripts/lib/strip-comments-and-strings.mjs — imported above as
// `stripCommentsOnly`, NOT re-implemented here. This guard needs the comments-ONLY variant
// because the thing it detects IS a string literal (a hardcoded tag inside a console.* call);
// `stripCommentsAndStrings` would empty exactly the text this scanner has to read and turn the
// guard into a silent no-op. The two properties this call site depends on — quote-awareness
// (a `//` inside a URL must not blank the rest of a real line) and line-preservation (violations
// are reported by line number) — are asserted in guard-string-literal-blindness.test.ts.
//
// This file used to carry its own `stripComments`; that copy-paste is the phantom-offender root
// cause (EI-19991116787260658) and is now blocked by a shrink-only guard.

function isScannable(rel) {
  if (!/\.[cm]?tsx?$/.test(rel)) return false;
  if (/\.d\.ts$/.test(rel)) return false;
  if (/\.(test|spec)\.[cm]?tsx?$/.test(rel)) return false; // a test may legitimately build fixture lines
  return true;
}

function walk(dir, repoRoot, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, repoRoot, acc);
    else if (e.isFile()) {
      const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
      if (isScannable(rel)) acc.push(rel);
    }
  }
  return acc;
}

/** @returns {{file:string,line:number,text:string}[]} */
export function findViolations(repoRoot, roots = GC_TAG_SOURCE_ROOTS) {
  const needle = productionTag();
  const out = [];
  for (const root of roots) {
    const abs = path.join(repoRoot, root);
    try { if (!statSync(abs).isDirectory()) continue; } catch { continue; }
    for (const rel of walk(abs, repoRoot, [])) {
      if (ALLOWLIST.has(rel)) continue;
      let src;
      try { src = readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { continue; }
      if (!src.includes(needle)) continue; // cheap pre-filter before the scanner
      const lines = stripCommentsOnly(src, rel).split('\n');
      lines.forEach((text, idx) => {
        if (text.includes(needle)) out.push({ file: rel, line: idx + 1, text: text.trim().slice(0, 160) });
      });
    }
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const violations = findViolations(repoRoot);
  if (violations.length === 0) {
    console.log(`lint:green-checkpoint-tag: clean — no hardcoded production tag in ${GC_TAG_SOURCE_ROOTS.join(', ')}`);
    process.exit(0);
  }
  console.error(
    `lint:green-checkpoint-tag: ${violations.length} hardcoded production tag(s) in executable code.\n` +
      `Narration must go through orchestratorStdoutTag() so a line emitted UNDER TEST is marked as a\n` +
      `fixture. A hardcoded prefix is captured verbatim into the persisted verdict log and reads as a\n` +
      `real gate decision (WI-37605). Note a log() call site must NOT add the prefix at all — log()\n` +
      `already prepends the resolved tag, and adding it again emits a line carrying BOTH tags.\n`,
  );
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  process.exit(1);
}
