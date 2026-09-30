#!/usr/bin/env node
/**
 * check-fake-timers-in-integration-tests.mjs — fail-loud guard against
 * `vi.useFakeTimers()` faking the TIMER FUNCTIONS inside an integration/browser test,
 * where an unmocked real-infra async path (PG, testcontainers, DBOS, a driver's own
 * backoff) depends on those timers ever firing.
 *
 * WHY THIS EXISTS (EI-18697393226276295). A unit test may fake timers freely: every
 * async dependency is mocked, so nothing is waiting on a real timer. An INTEGRATION test
 * runs against real infrastructure, and faking `setTimeout` there stops that
 * infrastructure's internal timers dead. The failure mode is the reason this is a guard
 * and not a doc note:
 *
 *     no assertion failure. no error. no timeout. the suite simply never returns.
 *
 * The original incident had to be killed with `kill -9` on the process tree, and the
 * cause is invisible in the output because there IS no output — you cannot grep your way
 * to it, and nothing points at fake timers specifically. That is a lot of burned time for
 * a two-word edit, and it is exactly the shape a cheap textual guard can end permanently.
 *
 * ── THE RULE IS ABOUT THE CLOCK vs THE SCHEDULER, NOT ABOUT FAKE TIMERS ─────────────
 *
 * The naive rule ("no fake timers in integration tests") is WRONG, and measurably so: it
 * would red-line `cross-plan-federation-seam.integration.test.ts`, which is correct code.
 * That file calls
 *
 *     vi.useFakeTimers({ toFake: ['Date'] });
 *
 * to freeze the CLOCK for deterministic federation timestamps. It never fakes
 * `setTimeout`, so every real timer still fires and the real PG paths underneath advance
 * normally. It is also `try/finally`-wrapped with `useRealTimers()`. Nothing about it is
 * hazardous.
 *
 * So the guard polices the `toFake` list, not the call:
 *
 *   PASS  vi.useFakeTimers({ toFake: ['Date'] })          — reads the clock, schedules nothing
 *   FAIL  vi.useFakeTimers()                              — no toFake ⇒ fakes EVERYTHING, incl. setTimeout
 *   FAIL  vi.useFakeTimers({ shouldAdvanceTime: true })   — still no toFake ⇒ same
 *   FAIL  vi.useFakeTimers({ toFake: ['Date','setTimeout'] })
 *
 * POLARITY IS DELIBERATE: `SAFE_FAKES` is an ALLOWLIST of the clock-reading fakes, and
 * anything not in it fails. A denylist of known scheduler names would silently admit the
 * next name sinon/vitest adds; an allowlist fails closed on an unrecognized entry and
 * costs one line of review to widen. Fail-closed is the correct direction for a guard
 * whose miss costs a silent infinite hang.
 *
 * ── BASELINE IS EMPTY, AND THAT IS A MEASUREMENT ────────────────────────────────────
 *
 * Measured on 2026-08-30 across the tracked tree (incl. submodules):
 *   982 *.integration.test.ts files
 *     1 calls useFakeTimers — and it is the safe `toFake: ['Date']` form above
 *   188 unit-test files call useFakeTimers (the control: the scan is not simply blind)
 *
 * So the tree is already 100% clean and the BASELINE is empty. That is the strongest
 * state a guard can start in — there is no grandfathered debt, so any future offender is
 * genuinely new. Keep it empty: an intentional exception belongs here in code with a
 * stated reason, not silently in a test file.
 *
 *   node scripts/check-fake-timers-in-integration-tests.mjs
 *   node scripts/check-fake-timers-in-integration-tests.mjs --report   # list, exit 0
 *
 * ── DETECTION ───────────────────────────────────────────────────────────────────────
 *
 * TEXTUAL, not an AST parse — mirroring `check-no-raw-setinterval.mjs` and
 * `check-timer-classification.mjs`, whose approximation this shares.
 *
 * Like those siblings it masks through `stripCommentsAndStrings` from
 * `./lib/strip-comments-and-strings.mjs`, so a call-shaped token quoted in prose is not
 * read as a real call site (EI-19989853369726696 — a guard's own error text, quoted in
 * another file, produced a phantom offender that red-pinned the gate).
 *
 * This guard has an extra requirement, and it is worth stating because it once looked
 * like grounds for a private copy: the thing it must READ — `toFake: ['Date']` — lives
 * INSIDE a string literal, so a mask that deleted string contents would erase the
 * evidence and turn every safe Date-only call into a false offender. The shared mask
 * does not delete: it replaces contents with spaces and KEEPS the delimiters, so it is
 * LENGTH-PRESERVING and indices in the masked text and the original stay aligned. That
 * is all this guard ever needed. Call sites and the balanced-paren walk run over the
 * MASKED text (prose-safe, and no stray paren inside a string can throw off the depth
 * count), while the argument text is sliced from the ORIGINAL at those same indices, so
 * `toFake` is readable. False-positive immunity without the blindness, and no second
 * implementation to keep in step.
 *
 * This file previously carried its own `maskCommentsAndStrings` on the belief that the
 * shared one could not do this. That belief was wrong, and the copy was strictly weaker:
 * it scanned by hand, so it could not tell a regex literal from division, and it blanked
 * `${...}` template expressions along with the surrounding template — hiding real code
 * from detection, which is the false-NEGATIVE direction. The shared module masks through
 * the TypeScript parser and preserves `${...}` as code, so migrating removed a documented
 * limit rather than trading one. The export is kept as a delegating alias because a
 * sibling test pins the length-preservation property through this name.
 *
 * KNOWN LIMIT, stated rather than papered over:
 *   • A `toFake` list built dynamically (a variable, a spread) is not statically
 *     readable; it is reported rather than assumed safe, for a fail-closed reason: this
 *     guard fails toward reporting an offender (a human reads one line), never toward
 *     silently passing a hang.
 */

import { readFileSync } from 'node:fs';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';

/**
 * GUARD_ROOT makes the scanned tree overridable, which is what makes this guard
 * copy-out probeable at all (mutation-probe.sh tier 2).
 *
 * Without it this guard is LOCATION-DEPENDENT: ROOT derives from import.meta.url, so a
 * mutated COPY under /tmp would resolve ROOT to /tmp's parent, scan a tree with no
 * integration tests, find nothing, and exit 0 — scoring "MUTANT SURVIVED" and reporting a
 * perfectly good guard as weak. That is a false verdict from an inert instrument, not a
 * measurement (EI-21902332137059032). Any probe of this file must pass GUARD_ROOT and
 * calibrate that the copy still sees a non-empty population before trusting either verdict.
 */
const RAW_ROOT = process.env.GUARD_ROOT || new URL('..', import.meta.url).pathname;

/**
 * The trailing slash is load-bearing, not cosmetic: file paths are resolved with
 * `new URL(f, 'file://' + ROOT)`, and without it `new URL('a/b.ts', 'file:///tmp/fixture')`
 * resolves against `/tmp` — silently dropping the last segment, reading nothing, and
 * reporting a clean tree. `new URL('..', import.meta.url).pathname` already ends in '/',
 * so only an env-supplied root can be missing it.
 */
const ROOT = RAW_ROOT.endsWith('/') ? RAW_ROOT : `${RAW_ROOT}/`;

/**
 * Test files that run against REAL infrastructure. These are the lanes where a faked
 * `setTimeout` can strand a driver's internal timer. Plain `*.test.ts` is deliberately
 * NOT policed — that is the 188-file unit population where fake timers are correct.
 */
const POLICED_RE = /\.(?:integration|browser)\.test\.[cm]?tsx?$/;

/**
 * Fakes that only READ the clock — they schedule and cancel nothing, so real timers keep
 * firing underneath and real infra keeps advancing. Everything else is treated as a
 * scheduler (see the fail-closed note in the header).
 */
const SAFE_FAKES = new Set(['Date', 'performance', 'hrtime']);

/**
 * Files exempt from this guard. EMPTY, and measured empty (see header) — an entry here
 * needs a stated reason explaining why faking the scheduler cannot strand real infra in
 * that specific file.
 * @type {Set<string>}
 */
const BASELINE = new Set();

/**
 * Mask comments and string/template CONTENTS with spaces, preserving length and therefore
 * index alignment with the input. Delimiters are kept so nothing is concatenated across a
 * masked span.
 *
 * Single pass, because comments and strings are mutually escaping: `//` inside a string
 * does not open a comment ("http://x" must survive), and a quote inside a comment does not
 * open a string (`// don't` would otherwise eat the rest of the file).
 *
 * A DELEGATING ALIAS for the shared `stripCommentsAndStrings`, which already has exactly
 * these semantics. The name is kept because `fake-timers-integration-guard.test.ts` pins
 * the length-preservation property through it; there is deliberately no second
 * implementation here. See the header for why the private copy was removed.
 *
 * Written as a ONE-LINE arrow on purpose. `guard-string-literal-blindness.test.ts` judges
 * delegation on the definition's OWN line — deliberately conservative, so a multi-line
 * wrapper that merely forwards still scores as a hand-roll. Keep the call on this line.
 *
 * @param {string} text
 * @param {string} [file] the real path, so the parser picks the right ScriptKind.
 * @returns {string}
 */
export const maskCommentsAndStrings = (text, file) => stripCommentsAndStrings(text, file);

/**
 * Every `useFakeTimers(...)` call in `text`, as `{ argText, line }`.
 *
 * Call sites and the paren walk use the MASKED text (so a mention inside prose or a
 * string is not a call site, and a paren inside a string cannot unbalance the walk);
 * `argText` is sliced from the ORIGINAL at the same indices, so `toFake: ['Date']` is
 * readable — which works precisely because the shared mask preserves length. See the
 * header.
 *
 * @param {string} text
 * @param {string} [fileName] the real path, so the parser picks the right ScriptKind.
 */
export function findUseFakeTimersCalls(text, fileName) {
  const masked = maskCommentsAndStrings(text, fileName);
  const calls = [];
  const re = /\buseFakeTimers\s*\(/g;
  let m;
  while ((m = re.exec(masked))) {
    const start = re.lastIndex; // just after the opening '('
    let depth = 1;
    let i = start;
    for (; i < masked.length && depth > 0; i++) {
      if (masked[i] === '(') depth += 1;
      else if (masked[i] === ')') depth -= 1;
    }
    calls.push({
      argText: text.slice(start, i - 1),
      line: text.slice(0, m.index).split('\n').length,
    });
  }
  return calls;
}

/**
 * Classify one call's argument text.
 *
 * Returns `null` when the call is safe, else a human-readable reason it is not. Anything
 * not statically provable as clock-only is reported (fail-closed, per the header).
 */
export function classifyCall(argText) {
  const trimmed = argText.trim();

  // `useFakeTimers()` / `useFakeTimers({ shouldAdvanceTime: true })` — no toFake at all
  // means vitest fakes the full default set, which includes setTimeout.
  if (!/\btoFake\s*:/.test(trimmed)) {
    return trimmed === ''
      ? 'no toFake — fakes the full default set, including setTimeout'
      : 'no toFake key — fakes the full default set, including setTimeout';
  }

  const listMatch = trimmed.match(/\btoFake\s*:\s*\[([^\]]*)\]/);
  if (!listMatch) {
    return 'toFake is not a statically readable array literal';
  }

  const body = listMatch[1].trim();
  if (body === '') return 'toFake is empty';
  if (body.includes('...')) return 'toFake is spread from a variable — not statically readable';

  const entries = body
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');

  const unsafe = [];
  for (const raw of entries) {
    const quoted = raw.match(/^['"`](.*)['"`]$/);
    if (!quoted) {
      unsafe.push(`${raw} (not a string literal)`);
      continue;
    }
    if (!SAFE_FAKES.has(quoted[1])) unsafe.push(quoted[1]);
  }

  return unsafe.length > 0 ? `fakes the scheduler: ${unsafe.join(', ')}` : null;
}

/** Scan the tracked tree (incl. submodules) for offenders. */
export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  for (const f of tracked) {
    if (!POLICED_RE.test(f)) continue;
    if (BASELINE.has(f)) continue;

    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('useFakeTimers')) continue;

    for (const call of findUseFakeTimersCalls(text, f)) {
      const reason = classifyCall(call.argText);
      if (reason) offenders.push({ file: f, line: call.line, reason });
    }
  }
  return { offenders, unscanned };
}

function main() {
  const report = process.argv.includes('--report');
  const { offenders, unscanned } = findOffenders();

  if (offenders.length === 0) {
    console.log('✓ no integration/browser test fakes the timer functions');
    const note = describeUnscanned(unscanned);
    if (note) console.log(`  ${note}`);
    return;
  }

  const say = report ? console.log : console.error;
  say('✗ fake TIMERS in an integration/browser test (EI-18697393226276295):');
  for (const o of offenders) say(`    ${o.file}:${o.line} — ${o.reason}`);
  say('');
  say('  Faking setTimeout here stops real infra (PG/testcontainers/DBOS and their');
  say('  internal backoff timers) from ever firing. The suite then HANGS with no');
  say('  assertion failure, no error, and no output to grep — it just never returns.');
  say('');
  say('  If you only need a deterministic CLOCK, fake just the clock and leave the');
  say('  scheduler real:');
  say('');
  say("      vi.useFakeTimers({ toFake: ['Date'] });");
  say('      try { /* ... */ } finally { vi.useRealTimers(); }');
  say('');
  say('  If you genuinely need timer control, move the assertion to a unit test where');
  say('  every async dependency is mocked.');

  const note = describeUnscanned(unscanned);
  if (note) say(`  ${note}`);

  if (!report) process.exit(1);
}

if (isCliEntry(import.meta.url)) main();
