#!/usr/bin/env node
/**
 * check-integration-teardown-nullsafe — an `afterAll` teardown in an
 * `*.integration.test.ts` must not dereference a fixture the `beforeAll` may
 * never have assigned.
 *
 * THE FAILURE THIS EXISTS TO STOP (EI-18681640518868156, follow-up to
 * EI-18680404964770187). The widespread shape is:
 *
 *     let db: FreshPgDb;
 *     beforeAll(async () => { db = await createFreshPgDb(); });
 *     afterAll(async () => { await db.cleanup(); });   // <- unguarded
 *
 * When `beforeAll` throws — the shared test-PG substrate down or recovering,
 * which is an ENVIRONMENT fault, not the author's diff — `db` is never
 * assigned and the `afterAll` throws
 * `TypeError: Cannot read properties of undefined (reading 'cleanup')`.
 * That TypeError is emitted AFTER the real beforeAll failure, so a `tail` of
 * the log shows the CASCADE, not the CAUSE. An agent who just edited the files
 * under test then misattributes an infrastructure outage to their own change.
 * (It happened exactly that way during EI-18680404964770187, and was
 * disambiguated only because all assertions in the run were SKIPPED.)
 *
 * The fix is `await db?.cleanup()`: identical behaviour when the fixture IS
 * assigned, and a no-op instead of a cause-masking TypeError when it is not.
 *
 * WHY A GUARD AND NOT JUST THE FIX. The 2026-08-30 sweep converted 131 sites
 * across 127 files. Without a guard the class regrows one new suite at a time,
 * and the next substrate outage buries its own cause again. The baseline here
 * is deliberately EMPTY: the population was measured to zero before this guard
 * landed, so any hit is a genuine regression rather than a number to ratchet.
 *
 * DETECTOR INDEPENDENCE. The detector must not share a failure mode with its
 * subject, or the real failure silences the guard. This one scans raw source
 * text for the absence of a guard, so it does not depend on the fixture
 * helper, on `FreshPgDb`, on the test runner, or on the substrate being up —
 * i.e. every condition under which the bug actually fires still leaves the
 * detector working. It is also deliberately identifier-AGNOSTIC: the first
 * pass of the sweep fixed only `db` and left 35 bare sites behind
 * `orgDb`/`authorDb`/`dbB`/`org`/`legacyDb`/`hdb`, so a `db`-only detector
 * would have shipped a guard with a 35-site hole.
 *
 * STATED BLIND SPOTS (deliberate, not oversights):
 *  - Only `.cleanup()` teardowns. A fixture torn down via `.close()`/`.drop()`
 *    /`.end()` has the same hazard and is NOT covered; widen the METHODS set
 *    below if such a pattern becomes common.
 *  - Single-line guard recognition. `if (db) await db.cleanup();` is accepted;
 *    a multi-line `if (db) {\n  await db.cleanup();\n}` is recognised only via
 *    the immediately-preceding line. A guard spread further than that reads as
 *    a violation — fix it with `?.` rather than widening this parser.
 *  - Text-level, not type-level: it cannot tell a genuinely non-nullable
 *    fixture from a nullable one. `?.` on an always-assigned fixture is
 *    harmless (and `@typescript-eslint/no-unnecessary-condition` is not
 *    enabled in this repo), so over-application costs nothing.
 *
 * Usage:
 *   node scripts/check-integration-teardown-nullsafe.mjs          # fail on any violation
 *   node scripts/check-integration-teardown-nullsafe.mjs --list   # print the measured population
 */

import { readFileSync } from 'node:fs';
import { presentOnDisk } from './lib/tracked-files.mjs';
import { execFileSync } from 'node:child_process';

import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';

/** Teardown methods considered hazardous when dereferenced unguarded. */
const METHODS = ['cleanup'];

const ROOTS = ['apps', 'packages', 'libs'];

/**
 * `await <ident>.<method>()` — the unguarded dereference we are hunting.
 *
 * The empty argument list is a load-bearing discriminator, not tidiness. A
 * fixture teardown is always zero-arg (`await db.cleanup()`); a same-named
 * module/class helper that takes arguments — e.g.
 * `await cls.cleanup(h.sql, planted)` in red-queen.integration.test.ts — is a
 * different thing entirely and is NOT the `let db` + `beforeAll` hazard. The
 * first draft of this guard omitted the `()` and reported exactly that line as
 * a violation on a tree already measured to zero, which is how the
 * over-match was caught.
 */
const bareCall = (method) =>
  new RegExp(String.raw`await\s+([A-Za-z_$][\w$]*)\s*\.\s*${method}\s*\(\s*\)`);

function listIntegrationTestFiles() {
  // FALSIFIABILITY SEAM. Explicit paths override discovery, so this guard can
  // be proven to FAIL against a known-bad fixture living OUTSIDE the repo
  // (`/tmp/...`). That matters here: the tree is swept by git-sync every few
  // minutes, so mutating a tracked file to test the guard risks COMMITTING the
  // mutant even when nothing goes wrong and no handler fails. A guard that has
  // never been shown to fail is a guard nobody has tested.
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (explicit.length > 0) return explicit;

  // `git ls-files` rather than a filesystem walk: it respects .gitignore, so a
  // vendored/build-output copy (e.g. storybook-static, dist-host) can never
  // inflate the population with files nobody edits.
  const out = execFileSync(
    'git',
    ['ls-files', '--', ...ROOTS.map((r) => `${r}/**/*.integration.test.ts`)],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  // WI-10004176: drop index entries a peer's plain `rm` left until git-sync commits it.
  return presentOnDisk(out.split('\n').map((s) => s.trim()).filter(Boolean));
}

/**
 * A site is SAFE when it optional-chains, or when the same line (or the line
 * immediately above) opens an `if (<ident>)` truthiness guard on that exact
 * identifier.
 */
function isGuarded(line, prevLine, ident) {
  if (new RegExp(String.raw`${ident}\s*\?\s*\.`).test(line)) return true;
  const guard = new RegExp(String.raw`if\s*\(\s*${ident}\s*\)`);
  if (guard.test(line)) return true;
  if (prevLine && guard.test(prevLine) && /\{\s*$/.test(prevLine)) return true;
  return false;
}

function scan() {
  const violations = [];
  for (const file of listIntegrationTestFiles()) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // listed but unreadable (raced deletion) — not this guard's business
    }
    // DETECT over MASKED source, REPORT from the original. A guard's own error
    // text quotes the very token it detects, so an `await db.cleanup()` written
    // in a comment or inside a string mints a phantom offender and reds the gate
    // on prose (EI-20045405992394901). The shared mask is length- and
    // newline-preserving, so masked line `i` is the same line as original `i` —
    // which is what lets detection run masked while the human-facing `text`
    // still shows the real source rather than a blanked-out string.
    const lines = text.split('\n');
    const maskedLines = stripCommentsAndStrings(text, file).split('\n');
    for (const method of METHODS) {
      const re = bareCall(method);
      for (let i = 0; i < maskedLines.length; i += 1) {
        const m = re.exec(maskedLines[i]);
        if (!m) continue;
        const ident = m[1];
        // The truthiness guard is read from the masked text too: a commented-out
        // `if (db)` above the call must not launder an unguarded dereference.
        if (isGuarded(maskedLines[i], i > 0 ? maskedLines[i - 1] : '', ident)) continue;
        violations.push({ file, line: i + 1, ident, method, text: (lines[i] ?? '').trim() });
      }
    }
  }
  return violations;
}

const violations = scan();
const listOnly = process.argv.includes('--list');

if (listOnly) {
  for (const v of violations) {
    console.log(`${v.file}:${v.line}\t${v.ident}.${v.method}()`);
  }
  console.log(`\n${violations.length} unguarded teardown site(s).`);
  process.exit(0);
}

if (violations.length === 0) {
  console.log('check-integration-teardown-nullsafe: OK — 0 unguarded teardown sites.');
  process.exit(0);
}

console.error(
  `check-integration-teardown-nullsafe: ${violations.length} unguarded teardown site(s).\n\n` +
    `An \`afterAll\` that dereferences a fixture its \`beforeAll\` may never have assigned\n` +
    `throws a TypeError AFTER the real failure, burying the cause. Use optional chaining:\n\n` +
    `    await db.cleanup();     ->     await db?.cleanup();\n`,
);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.text}`);
}
console.error(
  `\nThe baseline for this guard is EMPTY by construction (the population was measured\n` +
    `to zero when it landed) — so each line above is a real regression, not a ratchet entry.\n`,
);
process.exit(1);
