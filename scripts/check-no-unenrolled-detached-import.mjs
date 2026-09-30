#!/usr/bin/env node
/**
 * check-no-unenrolled-detached-import.mjs — fail-loud guard against a NEW untracked
 * fire-and-forget dynamic import (follow-up hardening for EI-20349773342925327).
 *
 * A detached `void import('...')` returns without awaiting, so the import can still be
 * walking its module graph after the test file that started it has finished. When Vitest
 * tears that file's environment down mid-graph, the module runner throws
 *
 *     EnvironmentTeardownError: Cannot load '<mod>' imported from '<mod>' after the
 *     environment was torn down.
 *
 * In the PURE lane (`isolate: false`, so files share a fork) the failure is attributed to
 * whichever CO-RESIDENT file happens to be collecting when it lands — the victim reports
 * `(0 test)` and passes again in a fresh process. Measured on the 2026-08-18 gate
 * (candidate 079cd254): 8 failed suites with a rotating cast, none of them the culprit.
 *
 * ⚠ A `.catch()` ON THE FLOATING IMPORT DOES NOT PREVENT THIS, so "it has a catch, so it
 * is safe" is not a valid exemption. Both sites in `harness/improvements/decay.ts` already
 * had `.catch(() => {})` and still reddened the gate: the throw happens on an INNER module
 * request inside the static re-export graph, and Vitest raises it through its own error
 * channel rather than rejecting the outer promise.
 *
 * THE ENROLMENT: wrap the promise in `trackDetached` from
 * `packages/operator-core/lib/detached-imports/` — a PURE PASS-THROUGH (it returns the same
 * promise, changes no control flow) that registers it so `drainDetached()` can await it from
 * the unit-layer `afterEach`/`afterAll`. Production semantics are unchanged; nothing calls
 * `drainDetached()` outside tests.
 *
 *     -void import('../../sync-sse').then((m) => m.notifySyncInvalidate(x)).catch(() => {});
 *     +void trackDetached(import('../../sync-sse').then((m) => m.notifySyncInvalidate(x))).catch(() => {});
 *
 *   node scripts/check-no-unenrolled-detached-import.mjs
 *   node scripts/check-no-unenrolled-detached-import.mjs --list   # measured population
 *
 * ⚠ SCOPE LIMIT, STATED SO IT IS NOT MISTAKEN FOR COVERAGE. This guard detects the
 * `void import(...)` idiom — the only detached-import spelling this repo actually uses
 * (measured: every enrolled site and every baseline site below). A bare
 * `import('x').then(...)` expression STATEMENT is equally detached and is NOT flagged,
 * because distinguishing one from an `import()` sitting in an array/argument position needs
 * a parser, and a heuristic there produced false positives on measurement. `--list` reports
 * those separately as UNVERIFIED advisories; they are not failures. So a clean run means
 * "no new `void import(`", NOT "no new detached import".
 *
 * ⚠ SECOND SCOPE LIMIT, for the same reason. A green run says nothing about workspaces
 * outside the lane split. Those run isolate:true, which removes the CO-RESIDENCY pathology
 * (a victim file failing for a stranger's import) — not every possible teardown fault: a
 * floating import can still fault while its own file tears down. `--list` enumerates that
 * residue so it stays measured. Do not read "out of scope" as "safe".
 *
 * The predicate (findUnenrolledDetachedImports) is exported + unit-tested
 * (packages/operator-core/lib/detached-imports/no-unenrolled-detached-import-guard.test.ts),
 * with permanently-wrong control implementations in the test file, so the "fails on a NEW
 * untracked void import(" property is durably verified rather than only green-on-clean-tree.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listFilesIncludingUntracked } from './lib/tracked-files.mjs';
import { stripCommentsAndStrings, stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * THE FAILING SCOPE IS DERIVED, NOT HARDCODED — this is the whole anti-regression design.
 *
 * A detached import can only poison a CO-RESIDENT file where Vitest runs `isolate: false`,
 * and that happens only in a workspace whose vitest.config.ts opts into the pure/stateful
 * lane split (`laneSplit: true` → libs/test-config resolveRequestedLane). Measured 2026-08-18:
 * `packages/operator-core` is the ONLY such workspace.
 *
 * Hardcoding `packages/operator-core/` would therefore be correct TODAY and would silently
 * stop being correct the moment a second workspace opts in — the coverage would be lost with
 * no failure anywhere. So the scope is read back out of the configs on every run: opt a
 * workspace into laneSplit and it joins this guard automatically.
 *
 * The same read enforces the other half of the invariant: a workspace that opts into
 * laneSplit but does NOT wire `lib/detached-imports/setup-vitest.ts` into its setupFiles has
 * no drain, so every `trackDetached` in it is INERT. That is a hard failure here rather than
 * a quiet no-op, because an inert enrolment looks exactly like a working one at the call site.
 */
export const LANE_SPLIT_RE = /\blaneSplit\s*:\s*true\b/;
export const DRAIN_SETUP_RE = /detached-imports\/setup-vitest/;

/**
 * Classify one vitest.config.ts source.
 *
 * @returns {{ laneSplit: boolean, drainWired: boolean }}
 */
export function classifyVitestConfig(text, fileName = 'vitest.config.ts') {
  // Two different maskings, because the two facts live in different syntax:
  //  - `laneSplit: true` is CODE, so mask comments AND strings.
  //  - the setup path is a STRING argument, so strings must survive — but comments must NOT,
  //    or a config that merely DESCRIBES the wiring in prose (operator-core's does) reads as
  //    wired. That would turn this check into one that can only pass, which is worse than
  //    not having it.
  return {
    laneSplit: LANE_SPLIT_RE.test(stripCommentsAndStrings(text, fileName)),
    drainWired: DRAIN_SETUP_RE.test(stripCommentsOnly(text, fileName)),
  };
}

/**
 * Never scanned: retired code (preserved-not-active, per CLAUDE.md), vendored trees, and
 * build output. These are not "allowed to regress" — they are not live source at all.
 */
export const EXCLUDED_DIRS = [
  '_retired/',
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  'papercup-release/',
  'target/',
];

/**
 * Permanently allowed: places where `trackDetached` is structurally UNREACHABLE, so the
 * enrolment this guard demands cannot exist there. Each entry carries its reason.
 */
export const ALLOWLIST_DIRS = [
  // The enrolment primitive itself — its own doc/tests spell the raw idiom deliberately.
  'packages/operator-core/lib/detached-imports/',
  // Domain-free borrowable libs: they must NOT depend on operator-core (layering rule,
  // CLAUDE.md § borrowable libraries). They cannot import trackDetached even in principle.
  'libs/generic/',
  // Standalone .mjs/.ts processes launched as their OWN process (psu-launcher, pty-host,
  // bghost-watchdog). No Vitest environment is ever torn down under them.
  'apps/operator/scripts/',
  'libs/testing-shell/',
];

/**
 * BASELINE (TEMPORARY — must shrink to EMPTY). Live-source sites that still fire an
 * unenrolled `void import(`. SEEDED FROM THE MEASURED POPULATION (`--list`), never from a
 * hand-run grep — same discipline `check-no-hand-rolled-module-pin.mjs` documents.
 *
 * NEW files may NOT be added here. The remedy is enrolment (wrap in `trackDetached`), never
 * an append: these all sit in graphs shallower than the three that were observed failing, so
 * they are LOWER risk, not NO risk — the race is load-dependent and the gate box runs at
 * load1 70+.
 */
export const BASELINE = new Set([]);

/** Is `file` outside the scanned surface entirely? */
export function isExcluded(file) {
  return EXCLUDED_DIRS.some((d) => file.startsWith(d) || file.includes(`/${d}`));
}

/** Is `file` permanently exempt (trackDetached structurally unreachable)? */
export function isAllowlisted(file) {
  return ALLOWLIST_DIRS.some((d) => file.startsWith(d));
}

/**
 * Find unenrolled detached imports in one file's source.
 *
 * Comments and string literals are masked FIRST, so prose describing the idiom (this repo
 * has plenty — the incident is documented in several headers) is never flagged. Matching
 * runs over the whole masked text rather than line-by-line so a call split across lines is
 * still caught.
 *
 * @param {string} text raw file source
 * @param {string} fileName used only to pick the masking dialect
 * @returns {{ line: number, column: number }[]} one entry per unenrolled site
 */
export function findUnenrolledDetachedImports(text, fileName) {
  if (!text.includes('import(')) return [];
  const masked = stripCommentsAndStrings(text, fileName);
  const hits = [];
  // `void` <ws> `import` <ws> `(` — an enrolled site reads `void trackDetached(import(`,
  // where `trackDetached` sits between `void` and `import` and so cannot match.
  const re = /\bvoid\s+import\s*\(/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const before = masked.slice(0, m.index);
    const line = before.split('\n').length;
    const column = m.index - (before.lastIndexOf('\n') + 1) + 1;
    hits.push({ line, column });
  }
  return hits;
}

/**
 * ADVISORY ONLY — bare `import(...)` expression statements, which are detached too but which
 * this guard deliberately does not fail on (see the SCOPE LIMIT note in the header). Reported
 * by `--list` so the residual gap is measurable instead of merely asserted.
 */
export function findBareDetachedImportCandidates(text, fileName) {
  if (!text.includes('import(')) return [];
  const masked = stripCommentsAndStrings(text, fileName);
  const hits = [];
  const re = /(^|[;{}])\s*import\s*\(/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const before = masked.slice(0, m.index);
    hits.push({ line: before.split('\n').length + (m[1] === '\n' ? 1 : 0) });
  }
  return hits;
}

function read(file) {
  try {
    return readFileSync(new URL(file, pathToFileURL(ROOT)), 'utf8');
  } catch {
    return null; // a submodule git can't descend into surfaces as unscanned, not as a failure
  }
}

/**
 * Read the failing scope back out of the vitest configs (see LANE_SPLIT_RE above).
 *
 * @returns {{ scopes: string[], undrained: string[] }} workspace dir prefixes that run
 *   `isolate:false`, and any of them missing the drain wiring.
 */
export function resolveLaneSplitScopes(files) {
  const scopes = [];
  const undrained = [];
  for (const file of files) {
    if (!file.endsWith('vitest.config.ts') || isExcluded(file)) continue;
    const text = read(file);
    if (text === null) continue;
    const { laneSplit, drainWired } = classifyVitestConfig(text, file);
    if (!laneSplit) continue;
    const dir = file.slice(0, file.length - 'vitest.config.ts'.length);
    scopes.push(dir);
    if (!drainWired) undrained.push(file);
  }
  return { scopes, undrained };
}

function scan({ survey = false } = {}) {
  // listFilesIncludingUntracked, NOT listTrackedFiles: on this shared tree agents create files
  // that sit UNTRACKED for minutes until git-sync's sweep commits them (observed 2026-08-18 —
  // a peer's brand-new operator-core file was `??` while its type error was already live). A
  // tracked-only enumeration cannot see a new detached import during exactly that window, which
  // is when a local pre-commit run is the only thing that could still catch it.
  const { files, ...coverage } = listFilesIncludingUntracked(ROOT);
  const { scopes, undrained } = resolveLaneSplitScopes(files);
  const inScope = (f) => scopes.some((d) => f.startsWith(d));
  // The failing verdict depends ONLY on the lane-split scopes, so the ordinary run reads just
  // those files (~1k) instead of every tracked source file (~13.5k) — a lint leg every agent
  // pays for. `--list` sets survey:true to also enumerate the out-of-scope residue.
  const source = files.filter(
    (f) => /\.tsx?$/.test(f) && !isExcluded(f) && (survey || inScope(f)),
  );

  const offenders = [];
  const outOfScope = [];
  const baselineSeen = new Set();
  const advisories = [];

  for (const file of source) {
    if (isAllowlisted(file)) continue;
    const text = read(file);
    if (text === null) continue;

    const advisory = findBareDetachedImportCandidates(text, file);
    if (advisory.length > 0) advisories.push({ file, count: advisory.length });

    const hits = findUnenrolledDetachedImports(text, file);
    if (hits.length === 0) continue;
    if (!inScope(file)) {
      // Not failed, and the reason is bounded ON PURPOSE — do not upgrade it to "safe".
      // Without the lane split those files run isolate:true, one environment per file, so a
      // detached import CANNOT be charged to a co-resident victim: no shared fork, no rotating
      // cast, no `(0 test)`. That is the pathology this guard exists to stop.
      // It is NOT a claim of immunity: a floating import can still fault while its OWN file is
      // tearing down. That failure is at least attributed to the file that caused it, which is
      // an ordinary debuggable red rather than a false accusation against a stranger.
      // Enrolling them today would also be INERT — only a workspace that wires
      // setup-vitest.ts ever calls drainDetached — which is why these are reported, not failed.
      outOfScope.push({ file, hits });
      continue;
    }
    if (BASELINE.has(file)) {
      baselineSeen.add(file);
      continue;
    }
    offenders.push({ file, hits });
  }

  const staleBaseline = [...BASELINE].filter((f) => !baselineSeen.has(f));
  return {
    offenders,
    outOfScope,
    advisories,
    staleBaseline,
    undrained,
    scopes,
    coverage,
    scanned: source.length,
  };
}

function listSites(label, rows) {
  const total = rows.reduce((n, r) => n + r.hits.length, 0);
  console.log(`\n${label} — ${total} site(s) across ${rows.length} file(s):`);
  for (const { file, hits } of [...rows].sort((a, b) => b.hits.length - a.hits.length)) {
    console.log(`  ${String(hits.length).padStart(3)}  ${file}  (lines ${hits.map((h) => h.line).join(', ')})`);
  }
}

function main() {
  const listMode = process.argv.includes('--list');
  const { offenders, outOfScope, advisories, staleBaseline, undrained, scopes, coverage, scanned } =
    scan({ survey: listMode });

  if (listMode) {
    console.log(`scanned ${scanned} tracked .ts/.tsx source file(s)`);
    console.log(`lane-split (isolate:false) scope(s): ${scopes.join(', ') || '(none)'}`);
    if (undrained.length > 0) console.log(`⚠ lane-split WITHOUT drain wiring: ${undrained.join(', ')}`);
    listSites('UNENROLLED `void import(` IN SCOPE (these FAIL)', offenders);
    listSites('out of scope (no lane split ⇒ no co-residency ⇒ not failed)', outOfScope);
    const advTotal = advisories.reduce((n, a) => n + a.count, 0);
    console.log(
      `\nADVISORY (NOT failed, NOT verified — see SCOPE LIMIT): ${advTotal} bare \`import(\` ` +
        `expression-statement candidate(s) across ${advisories.length} file(s).`,
    );
    const unscanned = describeUnscanned(coverage, ROOT);
    if (unscanned) console.log(`\n${unscanned}`);
    process.exitCode = 0;
    return;
  }

  const unscanned = describeUnscanned(coverage, ROOT);
  if (unscanned) console.error(unscanned);

  if (undrained.length > 0) {
    console.error(
      `❌ ${undrained.length} workspace(s) opt into the pure/stateful lane split (isolate:false)\n` +
        `   but do NOT wire lib/detached-imports/setup-vitest.ts into setupFiles, so nothing ever\n` +
        `   calls drainDetached() there and every trackDetached() in that workspace is INERT:\n` +
        undrained.map((f) => `     ${f}`).join('\n') +
        `\n   Fix: add the setup file to that config's setupFiles (see packages/operator-core/vitest.config.ts).\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (staleBaseline.length > 0) {
    console.error(
      `❌ ${staleBaseline.length} BASELINE entr(y|ies) no longer have an unenrolled detached ` +
        `import — the baseline is a RATCHET, so remove them:\n` +
        staleBaseline.map((f) => `     ${f}`).join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  if (offenders.length > 0) {
    const total = offenders.reduce((n, o) => n + o.hits.length, 0);
    console.error(
      `❌ ${total} unenrolled detached import(s) across ${offenders.length} file(s).\n` +
        `   A fire-and-forget \`void import(...)\` can outlive the test file that started it and\n` +
        `   poison a CO-RESIDENT file in the pure lane with EnvironmentTeardownError.\n` +
        `   Wrap it: void trackDetached(import('...')...)  — from lib/detached-imports/\n` +
        `   ⚠ Adding a \`.catch()\` does NOT fix this, and neither does adding the file to BASELINE.\n`,
    );
    for (const { file, hits } of offenders) {
      for (const h of hits) console.error(`     ${file}:${h.line}:${h.column}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `✅ no unenrolled detached imports (${scanned} file(s) scanned, ` +
      `${BASELINE.size} baseline, ${ALLOWLIST_DIRS.length} allowlisted dir(s))`,
  );
}

const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname);
if (invokedDirectly) main();
