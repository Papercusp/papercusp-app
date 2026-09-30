#!/usr/bin/env node
/**
 * check-scope-defaults.mjs — the recurrence guard for silent workspace/harness/scope
 * defaults (workspace-data-isolation-leaks-2026-06-17 P-007 / D-003).
 *
 * The rule (D-003): a function designed to take a workspace / harness / scope must
 * REQUIRE it, or fail loud via the existing fail-loud resolvers (`_harness-scope.ts
 * resolveHarnessScope`, `_pot-scope.ts resolvePotScope`, `plans/source.ts
 * resolvePlanScope`). A silent `?? 'default'` / `|| DEFAULT_WORKSPACE_ID` / `?? 'operator'`
 * on a SCOPE value is the smell — the shared root cause of BOTH cross-workspace data
 * mixing AND the null-harness work-item invisibility. An empty/missing scope collapsed to
 * a single bucket silently reads/writes the WRONG partition.
 *
 * What this flags: a nullish/or default whose IMMEDIATE left-hand identifier names a
 * workspace / harness / hive / scope value AND defaults to one of the scope sentinels
 * `'default'` / `DEFAULT_WORKSPACE_ID` / `'operator'` (incl. the `"…"` forms) OR the
 * home-harness resolver call `operatorHomeHarnessSlug()` (a NAMED silent default — the
 * function-call form this lint was blind to, which is exactly how the WI-374 plan-attribution
 * mis-attribution slipped past it), in source `.ts` (not `.tsx` UI, not tests). A
 * genuinely-global default ("operator/home/all is the explicit documented scope here") is
 * allowed — mark it with an inline `allow-scope-default` comment (reason at the site), or add
 * an inherently-exempt file to FILE_ALLOW.
 *
 * What it deliberately does NOT flag: a bare `?? ''` / `?? ""`. The empty-string default is
 * too ambiguous for a static lint (a controlled-input value, a copy-text fallback, and a
 * scope collapse all look identical); those are fixed at the specific sites (P-003) and
 * caught in review. This lint targets the unambiguous scope LITERALS.
 *
 *   node scripts/check-scope-defaults.mjs           # report (advisory)
 *   node scripts/check-scope-defaults.mjs --strict  # exit 1 on any un-allowed default
 *
 * Advisory by default (scope-LHS detection is a heuristic, like lint:generic-first /
 * lint:env-feature-gates). Flip the CI wiring to --strict once the Phase-3 remediation
 * (P-001..P-006) lands clean.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');

// Inline marker (same line, or the line above) that documents an intentional, explicit
// global/local scope default and suppresses the finding. Keep the reason at the site.
const ALLOW_MARKER = 'allow-scope-default';

// Whole files inherently exempt: the constant's own home, the lexical browser fallback,
// the process-pin reader, the global-workspace resolver, and the fail-loud resolvers
// themselves (which reference the literals only in their operator-home branch / error text).
const FILE_ALLOW = new Set([
  'packages/operator-core/lib/workspace-id-constant.ts',
  'packages/operator-core/lib/browser-workspace.ts',
  'packages/operator-core/lib/dock-layouts.ts',
  'packages/operator-core/lib/workspace-registry.ts', // resolves THE global/current workspace
  'packages/operator-core/lib/agent-tools/_harness-scope.ts',
  'packages/operator-core/lib/agent-tools/_pot-scope.ts',
  'packages/operator-core/lib/agent-tools/plans/source.ts',
  'packages/operator-core/lib/llm-testing/targets/operator.ts', // LLM-test target's test-workspace header
]);

// The scope sentinels a `??`/`||` may silently default to (the unambiguous ones): the
// literal workspace/scope strings AND the home-harness RESOLVER CALL. `operatorHomeHarnessSlug()`
// is a named silent default exactly like `'default'`/`DEFAULT_WORKSPACE_ID` — an omitted harness
// collapsed to the operator home mis-attributes data across harnesses (WI-374, the function-call
// form this lint was previously BLIND to — the detector failure behind the plan-attribution leak).
const LITERAL =
  "(?:DEFAULT_WORKSPACE_ID\\b|operatorHomeHarnessSlug\\(\\)|'default'|\"default\"|'operator'|\"operator\")";
const OP_LITERAL_RE = new RegExp(`(\\?\\?|\\|\\|)\\s*${LITERAL}`);
// The IMMEDIATE left-hand identifier chain (the token run just before the operator).
const LHS_TOKEN_RE = /([\w.$?![\]'"]+)\s*$/;
// That LHS must name a scope value.
const SCOPE_LHS_RE = /(workspace|harness|hive|scope|callerWs|\bws\b)/i;

// Test / test-support files poke scope freely — not production leaks.
function isTestFile(file) {
  return (
    file.endsWith('.test.ts') ||
    file.endsWith('.test.tsx') ||
    file.includes('/__tests__/') ||
    file.includes('/test/') ||
    /testbed|_test|\.bench\./.test(file)
  );
}

// WI-37717: comment-masking moved from a hand-rolled per-line heuristic to the shared,
// string-aware stripper. The old version claimed to find a `//` "not inside a string" but
// performed no string check — so ANY `//` earlier on the line (a URL in a string literal,
// `'https://…'`, `log('see http://docs/x')`) was read as the start of a trailing comment and
// the whole line was SUPPRESSED. That ran in the FALSE-NEGATIVE direction: a real scope
// default silently vanished from the report, which is exactly the "a detector that dies must
// not look quiet" failure this script's own ENOBUFS note warns about. Measured before the
// change: `const u = 'https://x.com'; const ws = scope ?? 'default';` reported NOTHING.
//
// Masking the whole FILE (not the line) also fixes block comments properly: the old ` * `
// prefix test was a guess about being inside /* */, and stripCommentsOnly actually tracks it.
// Strings stay UNMASKED deliberately — the scanned expression `?? 'default'` IS a string
// literal, so stripCommentsAndStrings would blind this guard completely.

let raw = '';
try {
  raw = execFileSync(
    'git',
    [
      'grep',
      '-nE',
      `(\\?\\?|\\|\\|)\\s*(DEFAULT_WORKSPACE_ID|operatorHomeHarnessSlug\\(\\)|'default'|\"default\"|'operator'|\"operator\")`,
      '--',
      'packages/',
      'apps/',
      'libs/',
      // SOURCE only. Without these exclusions the scan pulls in the GENERATED docs
      // mirror under apps/operator/public/internal/docs (one .html per insight, plus
      // llms-small.txt), whose pages quote this very rule — 173MB of match output
      // against a 64MB maxBuffer, so execFileSync threw ENOBUFS and this guard was
      // DEAD, not clean. It reported nothing at all while the plan's `## Now` still
      // recorded it as "active (6 sites)". A detector that dies must not look quiet:
      // keep this list ahead of the docs build, and see the ENOBUFS re-raise below.
      ':(exclude)*/public/*',
      ':(exclude)*/dist/*',
      ':(exclude)*/.next/*',
      ':(exclude)*/node_modules/*',
      ':(exclude)*.html',
      ':(exclude)*.txt',
      ':(exclude)*.md',
      ':(exclude)*.mdx',
      ':(exclude)*.json',
      ':(exclude)*.map',
      ':(exclude)*.snap',
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
} catch (e) {
  if (e.status === 1) raw = ''; // git grep exits 1 on no matches
  else if (e.code === 'ENOBUFS') {
    // Never let this degrade into a silent/ambiguous pass: say plainly that the scan
    // did not run and what to do, rather than emitting a bare spawnSync stack that
    // reads like an infra hiccup. (The pathspec exclusions above are the fix; if a
    // new generated tree lands under packages/apps/libs, add it there.)
    console.error(
      'check-scope-defaults: SCAN DID NOT RUN — git grep output exceeded maxBuffer (ENOBUFS).\n' +
        'This is NOT a clean result. Something generated (a built docs mirror, a dist/ tree)\n' +
        'is being scanned; add it to the ":(exclude)…" pathspecs in this script.',
    );
    process.exit(2);
  } else throw e;
}

const lines = raw.split('\n');

// Read a hit file's lines (cached) so we can check the hit line + the line directly
// above for an allow marker — git grep only emits matching lines, so a marker on a plain
// comment line above is invisible without reading the file.
const fileLinesCache = new Map();
function fileLines(file) {
  if (!fileLinesCache.has(file)) {
    try {
      fileLinesCache.set(file, readFileSync(join(ROOT, file), 'utf8').split('\n'));
    } catch {
      fileLinesCache.set(file, []);
    }
  }
  return fileLinesCache.get(file);
}

// Same file, comment-masked (strings preserved — see the note above). stripCommentsOnly
// blanks in place and keeps newlines, so indices stay aligned with fileLines().
const maskedLinesCache = new Map();
function maskedLines(file) {
  if (!maskedLinesCache.has(file)) {
    try {
      maskedLinesCache.set(file, stripCommentsOnly(readFileSync(join(ROOT, file), 'utf8')).split('\n'));
    } catch {
      maskedLinesCache.set(file, []);
    }
  }
  return maskedLinesCache.get(file);
}

const hits = [];
for (const line of lines) {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) continue;
  const [, file, linenoStr, content] = m;
  const lineno = Number(linenoStr);
  if (!file.endsWith('.ts')) continue; // server .ts only — .tsx is UI render state
  if (isTestFile(file)) continue;
  if (FILE_ALLOW.has(file)) continue;

  // Match against the COMMENT-MASKED line (1-based lineno → 0-based idx). If the hit
  // survives masking it is real code; if it vanishes it was prose. Falling back to the raw
  // line when the file could not be read keeps a read failure from silently emptying the
  // report — an unreadable file must not look clean.
  const maskedLine = maskedLines(file)[lineno - 1] ?? content;
  const dm = maskedLine.match(OP_LITERAL_RE);
  if (!dm) continue;

  // The immediate LHS identifier must name a scope value (not, e.g., `role ?? 'operator'`).
  const lhs = maskedLine.slice(0, dm.index).match(LHS_TOKEN_RE)?.[1] ?? '';
  if (!SCOPE_LHS_RE.test(lhs)) continue;

  // marker on the hit line, or on the line directly above (1-based lineno → 0-based idx).
  const aboveLine = fileLines(file)[lineno - 2] ?? '';
  if (content.includes(ALLOW_MARKER) || aboveLine.includes(ALLOW_MARKER)) continue;

  hits.push({ file, lineno, content: content.trim() });
}

if (hits.length === 0) {
  console.log(
    "check-scope-defaults: clean — no silent workspace/harness scope default " +
      "(?? 'default' / || DEFAULT_WORKSPACE_ID / ?? 'operator') outside the allow-list.",
  );
  process.exit(0);
}

const byFileHits = new Map();
for (const h of hits) {
  if (!byFileHits.has(h.file)) byFileHits.set(h.file, []);
  byFileHits.get(h.file).push(h);
}

console.log(`\ncheck-scope-defaults: ${hits.length} silent scope-default(s) in ${byFileHits.size} file(s):\n`);
for (const [file, fhits] of [...byFileHits].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${file}`);
  for (const h of fhits) console.log(`    ${h.lineno}: ${h.content.slice(0, 110)}`);
}
console.log(
  `\nEach: route the value through a fail-loud resolver (resolveHarnessScope / resolvePotScope /\n` +
    `resolvePlanScope) or REQUIRE it (throw on missing) — never silently default a workspace/harness.\n` +
    `If a site genuinely means a specific global/local scope, add an inline \`${ALLOW_MARKER}\` marker\n` +
    `comment (with the reason), or add an inherently-exempt file to FILE_ALLOW in this script.\n` +
    `Rule: workspace-data-isolation-leaks-2026-06-17 P-007 / D-003.\n`,
);
process.exit(STRICT ? 1 : 0);
