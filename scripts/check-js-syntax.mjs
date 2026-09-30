#!/usr/bin/env node
/**
 * check-js-syntax.mjs — fail-loud guard for a syntactically BROKEN tracked
 * `.mjs` module (EI-20035436440627349).
 *
 * The sibling of `check-shell-syntax.mjs` (EI-13192), for the language that had
 * no such guard: `lint:shell-syntax` parses every tracked `.sh`, and nothing
 * parsed any of the 277 tracked `.mjs`.
 *
 *   node scripts/check-js-syntax.mjs
 *   node scripts/check-js-syntax.mjs --files=a.mjs,/tmp/b.mjs   # scoped / out-of-tree
 *
 * WHY THIS CLASS IS EXPENSIVE HERE, specifically. One unparseable module reds
 * every test file that transitively imports it. All of those produce real FAIL
 * rows, all attribute cleanly to a file, and the runner therefore stamps its
 * most confident label — `coverage=complete` — over a list of entirely INNOCENT
 * files, with the real culprit absent from it. CLAUDE.md documents that
 * consequence and `AFFECTED_TESTS_FAILING_FILES` now carries
 * `transformCulpritCount` to name the culprit, but both are downstream: they
 * describe the blast radius after a peer has already paid for it. This is the
 * upstream detector.
 *
 * Measured 2026-08-10 (the incident that prompted it): a regex pasted verbatim
 * into a JSDoc block — `.replace(/\/\/[^\n]*&#47;g, '')` — contains the comment
 * terminator, which ended the comment early and made
 * scripts/lib/strip-comments-and-strings.mjs unparseable tree-wide. A peer
 * found and fixed it before git-sync swept it, so no broken commit landed, but
 * that module is imported by guard scripts and their tests.
 *
 * DETECTOR: a real `node --check`, never a regex — the same
 * detector-not-a-heuristic rule D-003 set for the shell guard. `--check` uses
 * node's own parser and honours the module goal implied by the `.mjs`
 * extension, so `import`/`export` parse as ESM rather than as script-mode
 * syntax errors. (`new vm.Script(src)` would flag every ESM file, which is why
 * it is not used here.)
 *
 * Scope: tracked `.mjs`. Excludes _retired/, node_modules, dist. `.js`/`.cjs`
 * are deliberately OUT of scope — that surface includes large vendored bundles
 * (e.g. the desktop sidecar's monaco) whose baseline is unmeasured; this guard
 * ships ENFORCING because the `.mjs` baseline was measured clean first.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const isJsSyntaxScanned = (f) =>
  f.endsWith('.mjs') &&
  !f.startsWith('_retired/') &&
  !f.includes('/_retired/') &&
  !f.includes('/node_modules/') &&
  !f.includes('/dist/');

/**
 * The pure detector: resolves to `null` when the file parses, else a
 * `{ line, reason }` describing node's own parse error.
 *
 * Reads the exit CODE, never the output text. `node --check f 2>&1 | head -3`
 * reports HEAD's status (0) and reads exactly like a pass — the mistake made
 * while first measuring this class.
 */
export function findJsSyntaxError(absPath) {
  return new Promise((done) => {
    execFile(process.execPath, ['--check', absPath], { encoding: 'utf8' }, (err, _out, stderr) => {
      if (!err) return done(null);
      const text = String(stderr || '');
      // node prints `<path>:<line>` then the offending source, then `SyntaxError: <reason>`.
      const line = text.match(/^.*?:(\d+)$/m)?.[1];
      const reason = text.match(/^\s*(SyntaxError:.*)$/m)?.[1] ?? 'failed `node --check` (no SyntaxError line)';
      done({ line: line ? Number(line) : null, reason });
    });
  });
}

/**
 * The SECOND failure class (EI-21892432987434951): a module that PARSES but
 * cannot LOAD.
 *
 * `node --check` only parses. Assignment to an UNDECLARED binding is not a parse
 * error — it is a ReferenceError raised when the module is evaluated, and every
 * `.mjs` is strict-mode, so it is unconditional rather than environment-dependent.
 * This guard therefore printed `✓ all N tracked .mjs parse cleanly` over a module
 * that nothing could import — a confident false clean, which is worse than no
 * guard because it is the shape that ENDS an investigation.
 *
 * Measured 2026-08-30, the incident that prompted it: a `replace_all` of
 * `'export const '` -> `'const'` dropped the trailing space and produced
 * `constEMPTY_MARKER_DEBRIS_MS = 5000;` in scripts/test-files.mjs. That file IS
 * `npm run test:file`, so every peer's test runs broke for ~17 minutes while
 * `node --check` — and therefore this guard — reported the tree clean.
 *
 * PREDICATE: an unresolved reference that is a WRITE. Writes ONLY, deliberately:
 *   - an undeclared WRITE is a ReferenceError in every host, so it is always fatal;
 *   - an undeclared READ is not. `document` inside a playwright
 *     `page.evaluate(() => ...)` callback is correct code that resolves in the
 *     browser, and apps/operator/probe-adv-tmp.mjs is exactly that. A
 *     read-flagging predicate reported it as an offender; the write-only one does
 *     not. That is why this needs NO globals list and NO allowlist — measured
 *     ZERO offenders across all 358 tracked `.mjs`.
 *
 * A real `import()` load probe would also catch it and is REJECTED: it EVALUATES
 * module top-level, and the two files this guard most protects
 * (scripts/test-files.mjs, scripts/affected-tests.mjs) are test runners with
 * top-level side effects. A guard that runs the test runner to check the test
 * runner is not acceptable.
 */
const LOAD_CHECK_CONFIG = { languageOptions: { ecmaVersion: 'latest', sourceType: 'module' }, rules: {} };

/**
 * A CONSTANT synthetic name, never the file's real path.
 *
 * Passing an absolute path here makes eslint treat the file as outside its base
 * path and skip it: `verify` returns a message and `getSourceCode()` returns
 * null, so the analyser silently examines NOTHING. That is how the first draft of
 * this check reported every file clean — including a deliberately broken control.
 * A bare basename cannot match an ignore pattern (it has no slash), and the name
 * is never surfaced: offenders are reported against their real path.
 */
const LOAD_PROBE_FILENAME = 'check-js-syntax-load-probe.mjs';

/**
 * The load leg builds a full AST + scope graph; `node --check` only parses and
 * retains nothing. That difference is not academic here: the tree contains a
 * 44.7 MB vendored bundle (papercusp-desktop/src-tauri/env-sidecars/staging/serve.mjs),
 * and scope-analysing it — 32 files wide, via availableParallelism() — exhausted the
 * default 4 GB heap and killed the guard with a V8 OOM.
 *
 * 1 MB is chosen against the measured distribution, not guessed: the largest
 * hand-edited `.mjs` in the tree is apps/operator/scripts/psu-launcher.mjs at 0.54 MB,
 * and only 3 files exceed 0.5 MB. Everything this leg exists to protect stays in
 * scope; what falls out is vendored bundles, which are not hand-edited and cannot
 * acquire a glued-keyword typo from an interrupted refactor.
 *
 * Files over the cap are still fully covered by the `node --check` leg, and are
 * REPORTED as skipped rather than folded silently into the ✓ — an unmeasured file
 * quietly counted as clean is the exact defect this whole check was added to fix.
 */
export const LOAD_CHECK_MAX_BYTES = 1_000_000;

/** The shared analysis both the calibration and the real check run. */
function undeclaredWriteIn(linter, text) {
  const messages = linter.verify(text, LOAD_CHECK_CONFIG, LOAD_PROBE_FILENAME);
  if (messages.some((m) => m.fatal)) return { unparseable: true, hit: null };
  const globalScope = linter.getSourceCode()?.scopeManager?.globalScope;
  if (!globalScope) return { scopeUnavailable: true, hit: null };
  const ref = globalScope.through.find((r) => r.isWrite?.());
  return { hit: ref ? { line: ref.identifier?.loc?.start?.line ?? null, name: ref.identifier?.name ?? '<unknown>' } : null };
}

let linterPromise;
function loadLinter() {
  // eslint is a declared root dependency (^10.4.1). Imported lazily so this module
  // stays importable by tests, and so a missing install surfaces as a NAMED failure
  // rather than an import-time crash of the whole guard.
  linterPromise ??= import('eslint').then(({ Linter }) => {
    const linter = new Linter();
    // CALIBRATION — the instrument proves it still detects before it is trusted to
    // report clean. A detector that has silently stopped detecting is the exact
    // failure this whole check exists to fix, so it must not be possible here:
    // the absolute-path bug above produced a perfectly clean run over a broken file.
    const bad = undeclaredWriteIn(linter, 'undeclaredCalibrationTarget = 1;\n');
    if (bad.hit?.name !== 'undeclaredCalibrationTarget') {
      throw new Error(
        'check-js-syntax: load-check CALIBRATION FAILED — the analyser did not flag a known undeclared write, ' +
          'so a clean result from it would be meaningless. Refusing to run it.',
      );
    }
    const good = undeclaredWriteIn(linter, 'const declared = 1;\nexport default declared;\n');
    if (good.hit) {
      throw new Error('check-js-syntax: load-check CALIBRATION FAILED — the analyser flagged a clean control.');
    }
    return linter;
  });
  return linterPromise;
}

/**
 * Resolves to `null` when the module has no undeclared-write, else
 * `{ line, name }` naming the binding that will throw on load.
 *
 * Returns `null` for a file that does not PARSE: that is the `--check` leg's
 * class, and double-reporting one break as two would misstate the offender count.
 *
 * @param {string} absPath
 * @param {string | null} [source] Pass the module's source text directly to skip
 *   the disk read (callers that already hold it, e.g. tests). Defaults to
 *   reading `absPath` — bare `= null` alone left the generated declaration
 *   inferring `source` as `null`-only, rejecting every real string caller.
 */
export async function findJsLoadError(absPath, source = null) {
  const linter = await loadLinter();
  const text = source ?? readFileSync(absPath, 'utf8');
  const result = undeclaredWriteIn(linter, text);
  if (result.unparseable) return null; // findJsSyntaxError owns the parse class
  if (result.scopeUnavailable) {
    // A checker that cannot run must not turn a broken file into a clean one.
    throw new Error(`check-js-syntax: eslint scope graph unavailable for ${absPath} — the load check cannot run`);
  }
  return result.hit;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
    }),
  );
  return out;
}

async function main() {
  const filesArg = process.argv.find((a) => a.startsWith('--files='))?.slice('--files='.length);

  let targets;
  let unscanned = [];
  let scopeNote = '';
  if (filesArg) {
    // Scoped mode: takes paths verbatim (absolute ones too), so falsifiability
    // can be proved against a BROKEN COPY outside the tree — never by mutating
    // a tracked file, which git-sync would sweep mid-probe.
    targets = filesArg
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    scopeNote = ' (--files)';
  } else {
    // WI-6730: the shared helper recurses into submodules. A bare `git ls-files`
    // emits one gitlink per submodule, so a guard built on it silently parses
    // ZERO files inside all of them and prints ✓ regardless.
    const tracked = listTrackedFiles(ROOT);
    unscanned = tracked.unscanned ?? [];
    targets = tracked.files.filter(isJsSyntaxScanned);
  }

  // A zero denominator is a guard that measured NOTHING, which is not a pass.
  if (targets.length === 0) {
    console.error(`✗ check-js-syntax scanned 0 files${scopeNote} — that is a broken guard, not a clean tree.`);
    process.exit(1);
  }

  const results = await mapPool(targets, Math.max(4, availableParallelism()), async (f) => {
    const abs = isAbsolute(f) ? f : resolve(ROOT, f);
    const parseHit = await findJsSyntaxError(abs);
    // A file that does not PARSE cannot be scope-analysed, and reporting one break
    // as two offenders would misstate the count. The parse leg owns those.
    let loadHit = null;
    let loadCheckError = null;
    let loadSkippedBytes = null;
    if (!parseHit) {
      try {
        const { size } = statSync(abs);
        // Stat BEFORE reading: the 44.7 MB bundle must never be read or parsed here.
        if (size > LOAD_CHECK_MAX_BYTES) loadSkippedBytes = size;
        else loadHit = await findJsLoadError(abs);
      } catch (e) {
        loadCheckError = e?.message ?? String(e);
      }
    }
    return { f, parseHit, loadHit, loadCheckError, loadSkippedBytes };
  });

  const parseOffenders = results
    .filter((r) => r.parseHit)
    .map((r) => `${r.f}:${r.parseHit.line ?? '?'}  ${r.parseHit.reason}`);
  const loadOffenders = results
    .filter((r) => r.loadHit)
    .map((r) => `${r.f}:${r.loadHit.line ?? '?'}  ReferenceError on load — assignment to undeclared binding '${r.loadHit.name}'`);
  // A leg that could not RUN is not a pass; it is an unmeasured file.
  const unrunnable = results.filter((r) => r.loadCheckError).map((r) => `${r.f}  ${r.loadCheckError}`);

  // Named, never silent: a file the load leg did not measure must not read as one it cleared.
  const loadSkipped = results.filter((r) => r.loadSkippedBytes);
  const skipNote = loadSkipped.length
    ? `\n  load check skipped for ${loadSkipped.length} file(s) over ${(LOAD_CHECK_MAX_BYTES / 1e6).toFixed(1)} MB` +
      ` (parse-checked only): ${loadSkipped.map((r) => `${r.f} (${(r.loadSkippedBytes / 1e6).toFixed(1)} MB)`).join(', ')}`
    : '';

  if (parseOffenders.length === 0 && loadOffenders.length === 0 && unrunnable.length === 0) {
    console.log(
      `✓ all ${targets.length} tracked .mjs parse AND load cleanly ` +
        `(node --check + undeclared-write scope check)${scopeNote}.${describeUnscanned(unscanned)}${skipNote}`,
    );
    process.exit(0);
  }

  if (parseOffenders.length) {
    console.error(`✗ syntactically BROKEN .mjs module(s) — a hard \`node --check\` parse failure:\n`);
    for (const o of parseOffenders) console.error('    ' + o);
  }

  if (loadOffenders.length) {
    console.error(
      `${parseOffenders.length ? '\n' : ''}✗ UNLOADABLE .mjs module(s) — these PARSE, so \`node --check\` passes them,` +
        `\n  but they throw ReferenceError the moment anything imports them (EI-21892432987434951):\n`,
    );
    for (const o of loadOffenders) console.error('    ' + o);
  }

  if (unrunnable.length) {
    console.error(
      `${parseOffenders.length || loadOffenders.length ? '\n' : ''}✗ load check COULD NOT RUN for ${unrunnable.length} file(s)` +
        ` — unmeasured, which is not a pass:\n`,
    );
    for (const o of unrunnable) console.error('    ' + o);
  }

  console.error(
    `\n  ${parseOffenders.length + loadOffenders.length + unrunnable.length} offender(s) of ${targets.length} scanned. Until fixed, every test file that` +
      `\n  transitively imports one reds with a "coverage=complete" break set naming INNOCENT files.` +
      `\n  See EI-20035436440627349.`,
  );
  process.exit(1);
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
