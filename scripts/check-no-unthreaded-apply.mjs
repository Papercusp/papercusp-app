#!/usr/bin/env node
/**
 * lint:no-unthreaded-apply — every PRODUCTION call into the hyperbee op-apply seam
 * must thread the frame's own log key (`ownLogKeyHex`), so provenance is resolved by
 * proof rather than by fallback.
 *
 * ## The class this closes (EI-7667, the residue of a 7-item cluster)
 *
 * `resolveOpProvenance` (packages/operator-core/lib/sync/hyperbee/projection.ts) decides
 * whether an op is `origin='local'` or `'remote'`. WITH `ownLogKeyHex` threaded it is
 * fail-CLOSED and correct:
 *
 *     origin = op.sourceLogKeyHex === applyOpts.ownLogKeyHex ? 'local' : 'remote'
 *
 * WITHOUT it, the resolver falls through to `origin='local'` attributed by the FORGEABLE
 * `writerPubkey`. A remote publisher's row is then re-stamped as a local write with a
 * locally-generated clock NEWER than the wire, after which every redelivery of the
 * publisher's genuine op loses the LWW compare and the record stays permanently shadowed.
 *
 * Observed live on the p2p first-green rig (2026-07-27): frame A applied B's
 * publisher-signed seat offer correctly, then re-applied its own echo ~120ms later
 * through an un-threaded path. It was invisible in BOTH the logs and the database, which
 * is the only reason it survived four gate runs and three wrong diagnoses.
 *
 * ## Why the existing WI-6210 detector is NOT this guard
 *
 * This is the specific conflation that got EI-7667 wrongly closed once (comment 55898,
 * retracted in 55906), so it is worth stating precisely. `projection.ts` already carries
 * an un-threaded-apply DETECTOR — and it is genuinely good — but it cannot fail a build:
 *
 *   - it is RUNTIME-only: it fires when an un-threaded apply actually executes, so a new
 *     un-threaded call site on a cold path ships undetected;
 *   - it is CAPPED at `UNTHREADED_APPLY_WARN_CAP = 20`;
 *   - and its default sink `return`s early under `process.env.VITEST` (projection.ts:272)
 *     — deliberately, so `vitest-fail-on-console` does not red the legitimate single-peer
 *     fixtures. A detector that is silent in CI blocks nothing.
 *
 * A runtime detector for a CLASS and a build-time census over CALL SITES are different
 * instruments. This guard is the second one. Prior art is only prior art when it acts on
 * the same population AND the same code path.
 *
 * ## What it flags
 *
 *   1. `applyOpVia(lookup, op)` — fewer than 3 arguments, i.e. no `ApplyOpOpts` at all.
 *   2. `applyOpVia(lookup, op, { ... })` — a 3rd argument that is an OBJECT LITERAL with
 *      no `ownLogKeyHex` key. `{ hlcClock }` alone is a real miss and reads as threaded.
 *
 * ## What it deliberately does NOT flag (and why)
 *
 *   - A 3rd argument that is a VARIABLE (`applyOpVia(lookup, op, applyOpts)`). Whether
 *     that object carries the key is not statically decidable here, and guessing would
 *     trade a real guard for false positives on the correct call sites. Bounding the
 *     guard at what it can actually prove is what keeps it credible; the runtime detector
 *     above covers the dynamic remainder.
 *   - TEST files. Several suites legitimately drive an un-threaded apply — that is how
 *     the WI-6210 detector itself is tested (`projection-unthreaded-apply-detector.test.ts`
 *     asserts `applyHyperbeeOpToPg` increments the counter). The invariant is about
 *     PRODUCTION fold paths.
 *   - Bare REFERENCES to `applyHyperbeeOpToPg` used as a default sink
 *     (`opts?.applyImpl ?? applyHyperbeeOpToPg` in read-merge.ts). Boot overrides that
 *     default with its scoped, threaded apply (boot.ts `applyImpl: enforcedApply`), so
 *     the reference is not itself an un-threaded apply.
 *
 * ## The allowlist
 *
 * ALLOW is SHRINK-ONLY and currently holds exactly ONE entry: the global-registry path
 * `applyHyperbeeOpToPg`, which is un-threaded BY DESIGN (projection.ts L219-220: "legacy /
 * global-registry path … safe for single-peer use"). Do not add to it — a new un-threaded
 * production call site re-opens the hole this guard closes. Re-seed it from
 * `--list`, never from a hand-run grep: a proxy measurement's negative covers only the
 * conditions it reproduced.
 *
 * Usage:
 *   node scripts/check-no-unthreaded-apply.mjs           # exit 0 clean / 1 on a violation
 *   node scripts/check-no-unthreaded-apply.mjs --list     # print the full measured population
 *
 * Exit 0 clean / 1 on a new violation.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * D-034 (WI-9434 / EI-19388389386110890): a guard whose SCAN spans several workspaces but
 * whose ENFORCEMENT point sits in one workspace is enforced only for that workspace. The
 * scan below covers all three roots, and the enforcement point is a spawn of THIS script
 * (see check-no-unthreaded-apply.test.ts), so coverage and enforcement agree.
 */
const ROOTS = ['packages', 'libs', 'apps'];

/**
 * Falsifiability seam. When set, scan THIS directory instead of the repo roots.
 *
 * Proving a guard can fail is mandatory discipline, and on this repo the obvious way to
 * prove it is unsafe: mutating a tracked file races git-sync's whole-tree sweep, which
 * commits the mutant even when nothing goes wrong and no trap fires (measured —
 * db6d7b02b1 committed an inert mutant of a shell script that way). This one line makes
 * the safe form available: point the guard at a fixture OUTSIDE the tree, mutate that,
 * and the shared checkout is never dirtied for even a moment.
 *
 * Read-only and test-only — it narrows what is scanned, so it can never cause a MISS in
 * the real run, only in a run that deliberately asked for a different subject.
 */
const SCAN_ROOT = process.env.PC_UNTHREADED_APPLY_SCAN_ROOT ?? null;

/** Directories never worth walking. */
const SKIP_DIR = new Set([
  'node_modules', 'dist', 'dist-sidecar', 'dist-host', 'build', '.next', 'target',
  '_retired', 'coverage', '.git', 'out',
]);

/**
 * Un-threaded production call sites that are CORRECT and permanent. SHRINK-ONLY.
 *
 * `applyHyperbeeOpToPg` is the global-registry dispatch. It has no frame identity to
 * thread — it exists for the single-peer / global-registry context where every op IS
 * local, which is exactly why defaulting that path to `origin='local'` is right rather
 * than a fail-open bug. Flipping it would misclassify every genuinely-local op in those
 * contexts (the falsifier EI-7667's own D-006 names).
 */
const ALLOW = new Map([
  [
    'packages/operator-core/lib/sync/hyperbee/projection.ts',
    'applyHyperbeeOpToPg — the global-registry path; deliberate per projection.ts L219-220 ("legacy / global-registry path … safe for single-peer use"). No frame identity exists to thread.',
  ],
]);

const IS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (/\.[cm]?tsx?$/.test(name) && !IS_TEST.test(name)) yield full;
  }
}

/**
 * The masking this guard depends on comes from the SHARED stripper
 * (`scripts/lib/strip-comments-and-strings.mjs`), not a private lexer.
 *
 * WHY THE PRIVATE COPY HAD TO GO. Prose describing a rule is textually identical to the rule
 * being applied — a doc comment naming `applyOpVia(lookup, op)`, of which this file's own
 * header has several, would otherwise scan as a real call site. The hand-rolled lexer that
 * lived here got comments and strings right but had NO regex-literal handling, so the quote
 * in an ordinary `/['"]/` opened a phantom string that ran to end-of-line and DELETED
 * whatever followed it — including a real call site. Telling a regex from a division needs
 * a parser, which is exactly what the shared module delegates to TypeScript.
 *
 * IT WAS ALSO INVISIBLE TO THE GUARD-OF-GUARDS, and that is the part worth remembering.
 * `guard-string-literal-blindness.test.ts` classifies a guard by looking for a stripper NAMED
 * `strip*Comments*`. This one was called `maskCommentsAndStrings`, so the file read as masking
 * NOTHING: it sat in SCANS_UNMASKED_SOURCE (false — it did mask) while escaping the
 * hand-rolled shrink-only baseline (false — it was a copy-paste of the exact defect). One
 * name-specific regex, two wrong answers, inside the registry built to prevent this class.
 * The classifier is widened alongside this migration so the next `mask*` spelling cannot hide.
 *
 * BEHAVIOUR NOTE: the shared stripper KEEPS string delimiters (`''`) where the private one
 * blanked them entirely. That fixes a latent arity bug — `splitArgs` drops an empty first
 * argument, so a call whose FIRST argument was a string literal used to be counted one
 * argument short and could be reported unthreaded when it was not.
 */

/**
 * Split a call's argument list at TOP-LEVEL commas only, so an object literal or a nested
 * call counts as ONE argument. `src` must already be masked.
 *
 * Returns null when the parens do not balance before EOF (a truncated/partial file), so a
 * caller can decline to judge rather than report a confident wrong arity.
 */
export function splitArgs(masked, openParenIdx) {
  const args = [];
  let depth = 0;
  let start = openParenIdx + 1;
  for (let i = openParenIdx; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        args.push(masked.slice(start, i));
        return args.map((a) => a.trim()).filter((a, idx) => !(idx === 0 && a === ''));
      }
    } else if (ch === ',' && depth === 1) {
      args.push(masked.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

/**
 * Find un-threaded `applyOpVia` call sites in one file's already-RAW source.
 *
 * Exported so a test can feed it controls — including a deliberately-wrong control that
 * MUST be flagged, which is what proves the detector can still fail.
 *
 * @param {string} src        raw source text
 * @param {string} [fileName] real path, used ONLY to pick a ScriptKind for the parse.
 *        OPTIONAL, and the brackets are load-bearing: `gen:declarations` emits the .d.mts
 *        straight from this JSDoc, so writing `@param {string} fileName` would declare it
 *        REQUIRED and break every caller that passes a bare source string — which is what
 *        the 9 single-argument control cases in this guard's test do, by design. The shared
 *        stripper handles an omitted fileName by parsing both ways, so omitting it is
 *        correct-but-slower, never wrong.
 */
export function findUnthreadedApplies(src, fileName) {
  const masked = stripCommentsAndStrings(src, fileName);
  const hits = [];
  const CALL = /\bapplyOpVia\s*\(/g;
  let m;
  while ((m = CALL.exec(masked)) !== null) {
    const openParen = masked.indexOf('(', m.index);
    // A declaration (`export async function applyOpVia(`) is not a call site.
    const before = masked.slice(Math.max(0, m.index - 40), m.index);
    if (/\b(function|const|let|var)\s*$/.test(before) || /\bfunction\s+$/.test(before)) continue;
    const args = splitArgs(masked, openParen);
    if (args === null) continue;
    const line = masked.slice(0, m.index).split('\n').length;
    if (args.length < 3) {
      hits.push({ line, reason: `applyOpVia called with ${args.length} argument(s) — no ApplyOpOpts, so ownLogKeyHex cannot be threaded` });
      continue;
    }
    const third = args[2];
    // Only an OBJECT LITERAL is statically decidable; a variable is not (see header).
    if (third.startsWith('{') && !/\bownLogKeyHex\b/.test(third)) {
      hits.push({ line, reason: `applyOpVia's ApplyOpOpts literal omits ownLogKeyHex — ${third.replace(/\s+/g, ' ').slice(0, 60)}` });
    }
  }
  return hits;
}

function main() {
  const listMode = process.argv.includes('--list');
  const found = new Map();

  const base = SCAN_ROOT ?? ROOT;
  const scanDirs = SCAN_ROOT ? [SCAN_ROOT] : ROOTS.map((r) => join(ROOT, r));

  for (const dir of scanDirs) {
    for (const file of walk(dir)) {
      let src;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!src.includes('applyOpVia')) continue;
      const hits = findUnthreadedApplies(src, file);
      if (hits.length) found.set(relative(base, file), hits);
    }
  }

  if (listMode) {
    console.log('# measured population — un-threaded applyOpVia call sites (production, non-test)\n');
    if (found.size === 0) console.log('(none)');
    for (const [file, hits] of [...found].sort()) {
      const allowed = ALLOW.has(file) ? '  [ALLOWED]' : '';
      for (const h of hits) console.log(`${file}:${h.line}${allowed}\n    ${h.reason}`);
    }
    console.log(`\ntotal files: ${found.size}  allowlisted: ${[...found].filter(([f]) => ALLOW.has(f)).length}`);
    return;
  }

  const violations = [...found].filter(([file]) => !ALLOW.has(file));

  // A stale allowlist entry is itself drift: the guard would keep excusing a site that no
  // longer violates, and the next real one there would be silently forgiven.
  //
  // Meaningless under a fixture scan (the real allowlisted paths are not in scope), and
  // reporting it there would make a falsifiability probe exit 1 for the WRONG reason —
  // which would look exactly like a caught mutant while proving nothing.
  const stale = SCAN_ROOT ? [] : [...ALLOW.keys()].filter((f) => !found.has(f));

  if (violations.length === 0 && stale.length === 0) {
    console.log(
      `lint:no-unthreaded-apply: OK — every production applyOpVia call site threads ownLogKeyHex ` +
        `(${ALLOW.size} allowlisted by design).`,
    );
    return;
  }

  if (violations.length) {
    console.error('\nlint:no-unthreaded-apply: un-threaded production apply call site(s)\n');
    for (const [file, hits] of violations) {
      for (const h of hits) console.error(`  ${file}:${h.line}\n      ${h.reason}`);
    }
    console.error(
      '\nWHY THIS FAILS: without ownLogKeyHex, resolveOpProvenance falls through to\n' +
        "origin='local' attributed by the FORGEABLE writerPubkey, so a remote peer's row is\n" +
        'restamped as a local write with a newer-than-wire clock and stays permanently\n' +
        'shadowed — invisible in both the logs and the database (observed 2026-07-27).\n\n' +
        'FIX: thread the frame\'s own log key —\n' +
        '  applyOpVia(lookup, op, { ownLogKeyHex })\n' +
        'or build the apply via buildHarnessProjectionApply({ ..., ownLogKeyHex }).\n' +
        'If the site is genuinely peerless, add it to ALLOW **with a reason**.\n',
    );
  }

  if (stale.length) {
    console.error(
      `\nlint:no-unthreaded-apply: ${stale.length} STALE allowlist entr(y/ies) — no longer violating, so remove them:\n` +
        stale.map((f) => `  ${f}`).join('\n') +
        '\n',
    );
  }

  process.exit(1);
}

// Only run when invoked directly, so a test can import the pure helpers above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
