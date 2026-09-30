#!/usr/bin/env node
/**
 * check-vacuous-flag-guard.mjs — mechanical detector for the VACUOUS FLAG GUARD
 * class (WI-38269, routed from the acceptance scorecard for
 * retire-mug-kettle-su-only-2026-08-09, criterion `guards-bind-not-vacuous`).
 *
 * WHY THIS EXISTS
 * A test can gate an absence/refusal assertion on a feature flag that NOTHING
 * READS. The mock toggles, the assertion passes, and it proves nothing — and it
 * is indistinguishable, from the outside, from a guard that genuinely binds.
 *
 * That is not hypothetical. `AdvNowRunning.test.tsx` carried a mutable `tierLive`
 * knob that the retirement cases flipped, while `AdvNowRunning.tsx` had stopped
 * importing `useFlag` entirely. The knob "drove NOTHING — which silently made the
 * D-010 absence case pass for the wrong reason". It was found BY ACCIDENT: an
 * unrelated red pulled the implementer into that file. Nothing was looking for it,
 * which is the actual defect this closes — the instance was repaired, the CLASS
 * was not.
 *
 *   node scripts/check-vacuous-flag-guard.mjs            # gate
 *   node scripts/check-vacuous-flag-guard.mjs --report   # + the non-gating bucket
 *   node scripts/check-vacuous-flag-guard.mjs --census   # the full measured population
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO RULES, AND WHY ONLY ONE OF THEM GATES
 *
 * RULE B — MOCK WITHOUT A CONSUMER (the motivating shape).
 * A test mocks a flag module (`vi.mock('@papercusp/flags/client', …)`) but NONE of
 * the modules it pulls in — followed transitively, see MAX_IMPORT_DEPTH — contains
 * a flag read. Two verdicts, because they are not equally dangerous:
 *
 *   VACUOUS-TOGGLE (GATES) — the mock exposes a MUTABLE knob the test reassigns
 *       (`let tierLive = false; vi.mock(… useFlag: () => tierLive …)` with a later
 *       `tierLive = true`). The test is asserting that flipping the flag CHANGES
 *       something, against a subject that cannot see the flag. Both branches run
 *       identical code, so one of the two cases passes for the wrong reason. This
 *       is exactly the motivating instance.
 *
 *   INERT-MOCK (report)  — the mock is a CONSTANT (`useFlag: () => false`) and no
 *       subject reads a flag. Nothing is being proven by the flag, but nothing is
 *       being falsely proven either: it is usually a leftover from a real hook the
 *       component has since dropped, or defensive insulation against a transitive
 *       import. Harmless today, misleading to the next reader. Reported, never
 *       gated — gating this would fail the tree on tidy-up debt and train people
 *       to add suppressions, which is how a detector becomes noise.
 *
 * RULE A — TEST-ONLY FLAG KEY (report).
 * A `FLAGS.<KEY>` / `"papercusp-<slug>"` literal referenced by test files and by
 * ZERO non-test files. The flag exists, tests exercise it, nothing consumes it.
 * Reported rather than gated because it has a legitimate stable form: a flag
 * declared ahead of the code that will read it, and the retirement case — a flag
 * whose consumers were deliberately removed while the key stays declared so the
 * registry keeps refusing it. Both are correct states to be in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FALSE-POSITIVE DISCRIMINATORS (why this is not noise). A test is NOT flagged
 * when:
 *   - it lives in the flags library itself, or in a file whose subject IS the flag
 *     machinery (libs/flags/**) — mocking a flag read is the point there;
 *   - any module reachable from its local imports (depth ≤ MAX_IMPORT_DEPTH) reads
 *     a flag — the mock is insulating a real transitive consumer;
 *   - the test asserts on the flag REGISTRY rather than a flag's effect
 *     (`'X' in FLAGS`, `FLAGS.X` inside an expect) — that is the retirement-ratchet
 *     shape, which is a genuine guard and must keep passing;
 *   - the mock target is not resolvable to a flag module at all.
 *
 * SUPPRESSION: put `vacuous-flag-ok: <reason>` on the `vi.mock` line or in the
 * contiguous comment block directly above it. A deliberate exception then carries
 * its justification at the site — which is itself the improvement, because it turns
 * an invisible always-passes into a documented intentional choice.
 *
 * ⚠ VERIFIED-CLEAN BASELINE, DELIBERATELY NO BASELINE FILE. When this was written
 * the gating population was ZERO: the grader had already swept
 * `apps/operator-vite/src` + `packages/operator-core/lib` for zero-call-site flag
 * reads and found none, and this detector independently agrees. A guard introduced
 * against a clean population needs no allowlist, and adding an empty one would only
 * create somewhere for the next violation to be parked. If this ever gates, the
 * answer is to fix the test or to write the suppression pragma with a reason — not
 * to open a baseline.
 */
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listTrackedFiles, describeUnscanned } from './lib/tracked-files.mjs';
import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const CODE_RE = /\.[cm]?[jt]sx?$/;

/**
 * The flag-module specifiers a `vi.mock` can name. Matched as a PREFIX so
 * '@papercusp/flags/client', '@papercusp/flags/server' and bare '@papercusp/flags'
 * all count, without enumerating subpaths that may be added later.
 */
const FLAG_MODULE_PREFIXES = ['@papercusp/flags', '@/lib/flags', 'libs/flags'];

/**
 * A FLAG READ — the thing a subject must contain for a flag mock to bind to it.
 *
 * `FLAGS.` is deliberately NOT here. Referencing the registry is not reading a
 * flag's VALUE: `'MUG_KETTLE_SYSTEM' in FLAGS` is a registry assertion, and
 * counting it as a read would make the retirement ratchet — a guard that genuinely
 * binds — look like a consumer and mask a real vacuous mock next to it.
 */
const FLAG_READ_RE = /\b(?:useFlag|getFlag|requireFlag|gateApiRoute|flagEnabled|isFlagEnabled)\s*\(/;

/** Paths whose SUBJECT is the flag machinery — mocking a flag read is the point there. */
const FLAG_MACHINERY_RE = /(^|\/)libs\/flags\//;

const SUPPRESS_RE = /vacuous-flag-ok:/;

/** How far to follow a test's local imports before concluding nothing reads a flag. */
const MAX_IMPORT_DEPTH = 3;

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s*['"]([^'"]+)['"]/g;
const VI_MOCK_RE = /vi\.mock\s*\(\s*['"]([^'"]+)['"]/g;

const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Read a tracked file, tolerating a race with a concurrent peer edit. */
function readOrNull(abs) {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Resolve an import specifier to a repo-relative file, or null for anything this
 * guard deliberately does not follow (bare package specifiers, assets).
 *
 * The `@/` alias resolves against the nearest ancestor `src/` directory of the
 * importer rather than a hard-coded root: this repo has more than one `src` tree
 * with its own `@` alias, and hard-coding one of them is the documented cross-tree
 * alias trap (AGENT-ENV.md).
 */
function resolveImport(spec, fromRel, has) {
  let relNoExt;
  if (spec.startsWith('.')) {
    relNoExt = normalizeRel(join(dirname(fromRel), spec));
  } else if (spec.startsWith('@/')) {
    const srcRoot = nearestSrcRoot(fromRel);
    if (!srcRoot) return null;
    relNoExt = normalizeRel(join(srcRoot, spec.slice(2)));
  } else {
    return null;
  }
  for (const ext of ['', ...RESOLVE_EXTS]) {
    if (has(relNoExt + ext)) return relNoExt + ext;
  }
  for (const ext of RESOLVE_EXTS) {
    const cand = `${relNoExt}/index${ext}`;
    if (has(cand)) return cand;
  }
  return null;
}

function normalizeRel(p) {
  return p.split('/').filter((s) => s !== '.' && s !== '').join('/');
}

function nearestSrcRoot(rel) {
  const parts = rel.split('/');
  const i = parts.lastIndexOf('src');
  return i === -1 ? null : parts.slice(0, i + 1).join('/');
}

/**
 * Does anything reachable from `rel` read a flag? Bounded walk, memoized across
 * the whole run — the same subject tree is reached from many tests.
 *
 * ⚠ DELIBERATE ASYMMETRY: this walk reads RAW source, NOT masked source, while the
 * gating decision in `scan` reads masked. That is not an oversight, and the two
 * directions are not symmetric:
 *
 *   a `vi.mock` seen in a COMMENT → a finding invented out of prose → RED GATE.
 *       Must be masked. This is EI-20045405992394901.
 *   a flag read seen in a COMMENT → the subject counts as a CONSUMER → the mock is
 *       judged to BIND → NO finding. Fail-safe: it can only SUPPRESS a report, never
 *       manufacture one.
 *
 * So the expensive TypeScript parse is spent only where a false positive is possible.
 * Masking every module in every subject tree cost 45x the whole scan's runtime to buy
 * strictly more false negatives.
 */
function reachesFlagRead(rel, readSource, has, depth = MAX_IMPORT_DEPTH, seen = new Set()) {
  if (depth < 0 || seen.has(rel)) return false;
  seen.add(rel);
  const src = readSource(rel);
  if (src === null) return false;
  if (FLAG_READ_RE.test(src)) return true;
  if (depth === 0) return false;
  for (const m of src.matchAll(IMPORT_RE)) {
    const next = resolveImport(m[1], rel, has);
    if (next && CODE_RE.test(next) && reachesFlagRead(next, readSource, has, depth - 1, seen)) {
      return true;
    }
  }
  return false;
}

/** Is the identifier the mock factory returns reassigned anywhere in the file? */
function mockExposesMutableKnob(src, mockStart) {
  const factory = src.slice(mockStart, mockStart + 600);
  const ids = new Set();
  for (const m of factory.matchAll(/=>\s*([A-Za-z_$][\w$]*)\b/g)) ids.add(m[1]);
  for (const m of factory.matchAll(/:\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)\b/g)) ids.add(m[1]);
  for (const id of ids) {
    if (id === 'undefined' || id === 'null' || id === 'true' || id === 'false') continue;
    // A reassignment anywhere in the file: `id = ...` not preceded by let/const/var.
    const re = new RegExp(`(?<!\\b(?:let|const|var)\\s)\\b${id}\\s*=(?!=|>)`, 'g');
    if (re.test(src)) return id;
  }
  return null;
}

function isSuppressed(src, idx) {
  const lineStart = src.lastIndexOf('\n', idx) + 1;
  const lineEnd = src.indexOf('\n', idx);
  const line = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);
  if (SUPPRESS_RE.test(line)) return true;
  // The contiguous comment block directly above.
  let cursor = lineStart - 1;
  while (cursor > 0) {
    const start = src.lastIndexOf('\n', cursor - 1) + 1;
    const prev = src.slice(start, cursor).trim();
    if (!prev.startsWith('//') && !prev.startsWith('*') && !prev.startsWith('/*')) break;
    if (SUPPRESS_RE.test(prev)) return true;
    cursor = start - 1;
  }
  return false;
}

/**
 * @param root        repo root to enumerate (ignored when `files`+`readFile` are injected)
 * @param files       explicit repo-relative file list, instead of enumerating the tree
 * @param readFile    (rel) => string|null — injected so the guard's OWN test can drive it
 *                    over a synthetic in-memory tree. That is what makes this detector
 *                    falsifiable WITHOUT mutating the shared checkout: git-sync sweeps the
 *                    whole tree on a timer, so a probe that mutates a real file can be
 *                    COMMITTED mid-run even when nothing goes wrong and no handler fails.
 */
export function scan({ root = ROOT, files, readFile } = {}) {
  // `listTrackedFiles` already folds coverage in ({ files, unscanned, unscannedPresent, … }),
  // so it is used whole rather than re-run through `coverageOf` — which takes the FILE LIST,
  // not the wrapper, and fails loudly if handed the latter.
  const scan0 = files ? { files, unscanned: [], unscannedPresent: [] } : listTrackedFiles(root);
  const all = scan0.files;
  const unscanned = scan0.unscanned ?? [];
  // Keyed on unscannedPresent, not unscanned: this repo permanently carries one ABSENT
  // submodule (libs/zero-harness, retired and deliberately uninitialized), so an alarm on
  // bare `unscanned` fires on every run in a healthy tree and gets trained away.
  const unscannedPresent = scan0.unscannedPresent ?? [];

  const cache = new Map();
  const rawCache = new Map();
  const load = readFile ?? ((rel) => readOrNull(join(root, rel)));

  /** The ORIGINAL source — comments intact. Only the suppression pragma reads this. */
  const rawOf = (rel) => {
    if (!rawCache.has(rel)) rawCache.set(rel, load(rel));
    return rawCache.get(rel);
  };

  /**
   * The source a GATING decision is made against, with COMMENTS MASKED OUT.
   *
   * ⚠ Do not "simplify" this back to the raw text. A guard that text-matches code tokens
   * against unmasked source mints PHANTOM offenders out of prose: its own error strings and
   * doc comments quote the very tokens it detects, so a commented-out `vi.mock(...)` — or a
   * comment merely DISCUSSING the rule — reds the gate on a file that does nothing wrong
   * (EI-20045405992394901, and `guard-string-literal-blindness.test.ts` fails any new guard
   * that skips this).
   *
   * `stripCommentsOnly`, NOT `stripCommentsAndStrings`: the token this guard matches IS a
   * string literal (the `vi.mock('<specifier>')` argument), so masking string CONTENTS would
   * blind the detector entirely. That is the same per-guard call documented for the other
   * partial-mask guards.
   *
   * The mask is LENGTH-PRESERVING (comments become spaces), which is what lets `m.index`
   * offsets taken here stay valid against the raw text in `isSuppressed`.
   *
   * ⚠⚠ CALLED ONLY FOR CANDIDATE FILES — masking is a real TypeScript parse, and running it
   * over the whole tree took the scan from 2.4s to 107s (measured), which is fatal for a
   * guard attached to every `.ts` edit and blew the 60s vitest timeout on its own test. The
   * `mayMock` / `mayReadFlag` raw pre-filters below cut the parsed population to the handful
   * of files that could possibly match. That is SOUND, not a shortcut: masking only ever
   * REMOVES text, so a token absent from the raw source cannot appear in the masked source.
   */
  const maskedOf = (rel) => {
    if (!cache.has(rel)) {
      const raw = rawOf(rel);
      cache.set(rel, raw === null ? null : stripCommentsOnly(raw, rel));
    }
    return cache.get(rel);
  };

  /** Cheap raw pre-filter: could this file possibly carry a flag-module mock? */
  const mayMock = (raw) =>
    raw !== null && raw.includes('vi.mock') && FLAG_MODULE_PREFIXES.some((p) => raw.includes(p));

  const fileSet = new Set(all);
  const has = (rel) => fileSet.has(rel);

  const codeFiles = all.filter((f) => CODE_RE.test(f));
  const testFiles = codeFiles.filter((f) => TEST_RE.test(f));
  const nonTestFiles = codeFiles.filter((f) => !TEST_RE.test(f));

  const gating = [];
  const reported = [];

  // ── RULE B: a flag mock with no consumer anywhere in the subject tree ──────
  for (const rel of testFiles) {
    if (FLAG_MACHINERY_RE.test('/' + rel)) continue;
    // Cheap raw pre-filter FIRST — see maskedOf: the TS parse is the expensive step, and a
    // file with no `vi.mock` + flag-module mention in its RAW text cannot have one after
    // masking (masking only removes).
    if (!mayMock(rawOf(rel))) continue;
    const src = maskedOf(rel);
    if (src === null) continue;

    for (const m of src.matchAll(VI_MOCK_RE)) {
      const spec = m[1];
      if (!FLAG_MODULE_PREFIXES.some((p) => spec.startsWith(p))) continue;
      // The RAW source, deliberately: the `vacuous-flag-ok:` pragma lives in a COMMENT,
      // which `maskedOf` has masked away. Reading the masked text here would silently
      // disable every suppression in the repo. Safe because the mask is length-preserving,
      // so `m.index` addresses the same byte in both.
      if (isSuppressed(rawOf(rel), m.index)) continue;

      // Does ANY module this test pulls in read a flag? The test's own body is
      // excluded as a subject: a test that calls useFlag() itself is exercising
      // the mock, not being bound by it.
      let binds = false;
      let unresolved = 0;
      for (const im of src.matchAll(IMPORT_RE)) {
        const spec2 = im[1];
        const target = resolveImport(spec2, rel, has);
        if (target) {
          if (CODE_RE.test(target) && reachesFlagRead(target, rawOf, has)) {
            binds = true;
            break;
          }
        } else if (spec2.startsWith('.') || spec2.startsWith('@/')) {
          // A LOCAL import that did not resolve against the tracked-file set — a
          // generated or untracked module. We did not look inside it, so we cannot
          // claim it holds no flag read.
          unresolved += 1;
        }
      }
      if (binds) continue;

      const knob = mockExposesMutableKnob(src, m.index);
      const line = src.slice(0, m.index).split('\n').length;
      const row = { file: rel, line, spec, knob, unresolved };

      // ⚠ "I could not look" is NOT "there is nothing there". The subject set is the
      // tracked-file list, so a test importing a GENERATED or untracked module resolves
      // nothing and would otherwise read as a proven-empty subject tree — manufacturing a
      // gating verdict out of a blind spot. A gate may only fire on a subject tree this
      // guard actually read end to end; anything else is demoted to the report bucket,
      // which is the fail-safe direction and mirrors the EXIT_NOT_CHECKED distinction
      // scripts/affected-tests.mjs draws for the strand-guard family.
      if (knob && unresolved === 0) gating.push({ ...row, verdict: 'VACUOUS-TOGGLE' });
      else if (knob) reported.push({ ...row, verdict: 'UNPROVABLE-TOGGLE' });
      else reported.push({ ...row, verdict: 'INERT-MOCK' });
    }
  }

  // ── RULE A: a flag key referenced only by tests ───────────────────────────
  const keyRe = /\bFLAGS\.([A-Z][A-Z0-9_]*)/g;
  const inTests = new Map();
  const inSource = new Set();
  for (const rel of nonTestFiles) {
    // Raw, not masked: Rule A is REPORT-ONLY, and its error direction is the safe one — a
    // `FLAGS.X` mentioned in a source COMMENT counts as a consumer and merely suppresses a
    // report. Parsing 8,963 source files to tighten a non-gating bucket is not worth 45x.
    const src = rawOf(rel);
    if (src === null) continue;
    for (const m of src.matchAll(keyRe)) inSource.add(m[1]);
  }
  for (const rel of testFiles) {
    // The flags library's OWN tests declare synthetic fixture registries (ALPHA, BETA,
    // GAMMA, GRADUATED, …) that are keys of a fake FLAGS object, not of the real one.
    // Counting them produced 8 confident findings on the first run, every one of them a
    // false positive — and a detector whose entire visible output is noise is one nobody
    // reads, which is how the next real finding gets skipped.
    if (FLAG_MACHINERY_RE.test('/' + rel)) continue;
    const src = rawOf(rel);
    if (src === null) continue;
    for (const m of src.matchAll(keyRe)) {
      if (!inTests.has(m[1])) inTests.set(m[1], rel);
    }
  }
  const testOnlyKeys = [...inTests.entries()]
    .filter(([k]) => !inSource.has(k))
    .map(([key, file]) => ({ key, file, verdict: 'TEST-ONLY-FLAG-KEY' }));

  return {
    gating,
    reported,
    testOnlyKeys,
    unscanned,
    unscannedPresent,
    counts: {
      codeFiles: codeFiles.length,
      testFiles: testFiles.length,
      nonTestFiles: nonTestFiles.length,
    },
  };
}

function main() {
  const report = process.argv.includes('--report');
  const census = process.argv.includes('--census');
  const r = scan();

  const unscannedNote = r.unscannedPresent.length ? describeUnscanned(r.unscanned, ROOT) : '';

  if (census) {
    console.log(`scanned ${r.counts.testFiles} test files / ${r.counts.nonTestFiles} source files`);
    console.log(`gating (VACUOUS-TOGGLE):   ${r.gating.length}`);
    console.log(`reported (INERT-MOCK):     ${r.reported.length}`);
    console.log(`reported (TEST-ONLY KEYS): ${r.testOnlyKeys.length}`);
  }

  if (report || census) {
    for (const x of r.reported) {
      const why =
        x.verdict === 'UNPROVABLE-TOGGLE'
          ? `toggled via \`${x.knob}\`, but ${x.unresolved} local import(s) did not resolve — NOT judged`
          : 'no subject reads a flag';
      console.log(`  ${x.verdict.padEnd(17)} ${x.file}:${x.line} mocks ${x.spec} — ${why}`);
    }
    for (const x of r.testOnlyKeys) {
      console.log(`  TEST-ONLY-KEY     FLAGS.${x.key} — referenced by ${x.file}, by no source file`);
    }
  }

  // ⚠ `process.exitCode` + a natural end, NEVER `process.exit()`. Writes to a PIPE are
  // asynchronous in Node and `process.exit()` does not drain them, so an unbounded payload
  // (the findings list, `unscannedNote`) is TRUNCATED the moment this runs under `| tail`
  // or into a CI log — the report reads as short-but-clean rather than cut off.
  // `lint:no-undrained-stdout-exit` is a shrink-only ratchet that fails on the exit() form.
  if (r.gating.length === 0) {
    console.log(`✓ no vacuous flag guards${unscannedNote ? ` (${unscannedNote})` : ''}`);
    process.exitCode = 0;
    return;
  }

  console.error('\n✗ VACUOUS FLAG GUARD — a flag mock with a mutable knob that drives NOTHING:\n');
  for (const x of r.gating) {
    console.error(`  ${x.file}:${x.line}`);
    console.error(`      mocks ${x.spec}, toggled via \`${x.knob}\`, but no module this test`);
    console.error(`      imports reads a flag (checked ${MAX_IMPORT_DEPTH} import hops).`);
    console.error(`      Both branches of that toggle run identical code, so one of them`);
    console.error(`      passes for the wrong reason.\n`);
  }
  console.error('Fix the test so the assertion binds to something, or — if the mock is');
  console.error('deliberate — put `vacuous-flag-ok: <reason>` on the vi.mock line.\n');
  if (unscannedNote) console.error(unscannedNote);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
