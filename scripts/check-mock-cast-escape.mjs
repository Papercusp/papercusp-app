#!/usr/bin/env node
/**
 * check-mock-cast-escape.mjs — ratchet guard against NEW `as never` / `as any` casts
 * that close a vitest `.mock*(...)` call (EI-19282401068515102).
 *
 * THE TRAP: `vi.mocked(realFn)` is meant to typecheck whatever you install via
 * `.mockImplementation(...)` / `.mockResolvedValue(...)` / `.mockReturnValue(...)` /
 * `.mockRejectedValue(...)` (and their `Once` siblings) against `realFn`'s OWN real
 * signature — that is the entire point of calling `vi.mocked()` instead of using a bare
 * `vi.fn()`. Casting the installed value `as never` (or `as any`) defeats that check
 * completely: the argument becomes assignable to ANY signature, so a fixture that goes
 * stale the moment the real function's return type changes (most commonly: a shared
 * interface gains a REQUIRED field) is invisible to tsc. It fails at RUNTIME instead, in
 * a file the actual change never touched, and `test:affected` will not even select it.
 *
 * CONFIRMED LIVE (2026-08-01, WI-6673): adding the required `admitted` field to
 * `IssueClaimabilityReading` silently broke 14 tests across two files — both committed
 * red — precisely because each fixture's mocked return value was cast `as never`. See
 * `claimable.test.ts`'s own `HEALTHY_ADMITTED` comment, which now documents the trap at
 * the site it bit. CLAUDE.md already documents the required-field trap in general terms
 * ("Tests after editing" / `lint:required-field-strands`); this guard targets the
 * SPECIFIC idiom that makes tsc blind to it even when a fixture DOES go stale.
 *
 * NOT a mandate to fix the ~750 pre-existing occurrences across ~515 files — `as never`
 * on a vitest mock argument is the dominant idiom in this codebase's tests, in no small
 * part because a complex async signature is genuinely awkward to type by hand without a
 * helper (see `packages/operator-core/lib/testing/typed-mock.ts`, added alongside this
 * guard as the ergonomic typed alternative). This is the SAME ratchet-only-down pattern
 * as `lint:vite-externalized` / `lint:tsc` / `KNOWN_DARK_FLAGS`: a single committed
 * baseline (`.mock-cast-escape-baseline.json`) gives every offender file its own budget.
 * A deletion in one file therefore cannot pay for a new escape in another. A bare run
 * below a file budget is check-only and never silently locks in the lower number — only
 * `--update`, run deliberately, ratchets those file budgets down. `targetCount` retains
 * the original aggregate debt target while `count` reports the reconciled allocation.
 *
 * Usage:
 *   node scripts/check-mock-cast-escape.mjs             # gate: fail iff the count rose above baseline
 *   node scripts/check-mock-cast-escape.mjs --update     # ratchet the baseline down to the current count
 *   node scripts/check-mock-cast-escape.mjs --json       # machine-readable report
 *   node scripts/check-mock-cast-escape.mjs --migrate-per-file # one-time legacy scalar migration
 *
 * Exit codes:
 *   0 — at or below baseline (below-baseline only locks in with --update)
 *   1 — count exceeded baseline (a NEW escape was added), or the baseline file is unreadable
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = resolve(ROOT, '.mock-cast-escape-baseline.json');

/**
 * WHY THIS IS AN AST WALK AND NOT A REGEX OVER MASKED TEXT (EI-20059456952698638).
 *
 * Until 2026-08-10 this file lexed by hand: a `maskStringsAndComments()` helper blanked
 * comments and string/template literals, then `/\.mock(…)\s*\(/` found call sites and
 * `/\bas\s+(never|any)\s*$/` tested the argument text. That shape had TWO independent
 * defects, and BOTH failed silently toward "clean" — the expensive direction for a guard:
 *
 *   1. NO REGEX-LITERAL HANDLING. The masker had no concept of a regex literal, so the
 *      quote inside an ordinary `/['"]/` opened a string state that ran to the next
 *      matching quote — often EOF. Measured on a 2-line fixture: the mask blanked the
 *      whole rest of the file and the detector returned ZERO findings for a file whose
 *      second line was a real `as never` escape. Everything after such a regex was
 *      invisible; worse, on re-entry the desynced state scanned COMMENT PROSE as live code.
 *      Telling a regex literal from division needs real parsing — the masker's own docs
 *      admitted this as a "KNOWN LIMIT" rather than fixing it.
 *   2. THE `$` ANCHOR VS A TRAILING COMMA. `mockReturnValue(\n  x as never,\n)` — i.e.
 *      what prettier emits for any multi-line call — ends in `as never,`, so the anchored
 *      regex did not match. 13 real escapes in this repo's own test corpus were invisible
 *      for this reason alone (measured 2026-08-10 against the AST detector below).
 *
 * The AST has no such states to desync: a comment, a string, and a regex literal are
 * structurally not `AsExpression`s, and argument position is a tree edge rather than a
 * paren-counting guess. Trailing commas are the parser's problem, not ours.
 *
 * SEMANTICS, chosen by measurement rather than taste. The rule below is a strict SUPERSET
 * of what the regex matched: over 6,372 tracked test files it reproduced every one of the
 * old detector's findings (zero coverage lost) and recovered 13 more. Two argument shapes
 * count as installing an escaped value, because both defeat `vi.mocked()`'s type check for
 * the same reason:
 *   (a) the argument IS the cast          — `.mockResolvedValue(fixture as never)`
 *   (b) the argument is a function whose concise body is the cast
 *                                          — `.mockImplementation((x) => ({…}) as never)`
 * A cast NESTED deeper inside an argument (`mockResolvedValue(make({ a: 1 as never }))`)
 * is deliberately NOT counted: it is a different, much broader policy (+168 occurrences
 * here) and not what this ratchet was built to hold.
 */

/** Every vitest mock-install verb — the calls `vi.mocked()` is supposed to typecheck. */
const MOCK_VERBS = new Set([
  'mockImplementation',
  'mockImplementationOnce',
  'mockReturnValue',
  'mockReturnValueOnce',
  'mockResolvedValue',
  'mockResolvedValueOnce',
  'mockRejectedValue',
  'mockRejectedValueOnce',
]);

/** `as never` / `as any` — and ONLY those two. `as SomeRealType` still typechecks. */
function escapeKindOf(typeNode) {
  if (!typeNode) return null;
  if (typeNode.kind === ts.SyntaxKind.NeverKeyword) return 'never';
  if (typeNode.kind === ts.SyntaxKind.AnyKeyword) return 'any';
  return null;
}

/**
 * @typedef {object} MockCastEscape
 * @property {number} line - 1-based line number of the `.mockXxx(` call itself.
 * @property {string} verb - e.g. 'mockResolvedValue'.
 * @property {'never'|'any'} kind
 * @property {string} snippet - the source line, trimmed, for display.
 */

/**
 * Every `.mock*(...)` call in `rawText` that installs a value cast `as never` / `as any`,
 * regardless of how many lines the call spans or how it is formatted.
 *
 * `line`/`snippet` are anchored to the `.mockXxx` NAME token, not to the start of the
 * enclosing expression — in a chain (`m.mockReturnValueOnce(a).mockReturnValueOnce(b)`)
 * the CallExpression starts back at `m`, which would report every link on one line and
 * break the hook's before/after snippet matching.
 *
 * @param {string} rawText
 * @param {string} [fileName] - used only to choose TS vs TSX parsing. Callers that have a
 *   path SHOULD pass it; the default parses JSX, which is the safe end of that trade (a
 *   `.tsx` fixture parsed as TS loses whole subtrees, while the `.ts`-only shape TSX
 *   misreads — an angle-bracket `<never>x` assertion — is not the `as` idiom this counts).
 * @returns {MockCastEscape[]}
 */
export function findMockCastEscapesInText(rawText, fileName = 'in-memory.tsx') {
  const sourceFile = ts.createSourceFile(
    fileName,
    rawText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  /** @type {(MockCastEscape & { pos: number })[]} */
  const results = [];

  /** @param {import('typescript').Node} call @param {'never'|'any'} kind @param {string} verb */
  const record = (call, kind, verb) => {
    const nameStart = call.expression.name.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(nameStart);
    const lineStart = rawText.lastIndexOf('\n', nameStart) + 1;
    const lineEndIdx = rawText.indexOf('\n', nameStart);
    results.push({
      pos: nameStart,
      line: line + 1,
      verb,
      kind,
      snippet: rawText.slice(lineStart, lineEndIdx === -1 ? rawText.length : lineEndIdx).trim(),
    });
  };

  /** @param {import('typescript').Node} node */
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && MOCK_VERBS.has(node.expression.name.text)) {
      const verb = node.expression.name.text;
      for (const arg of node.arguments) {
        // (a) the installed value itself is the cast
        const direct = ts.isAsExpression(arg) ? escapeKindOf(arg.type) : null;
        if (direct) {
          record(node, direct, verb);
          continue;
        }
        // (b) an installed FUNCTION whose concise body is the cast — the return value is
        //     what gets typechecked against the real signature, so this is the same escape.
        if (ts.isArrowFunction(arg) && arg.body && ts.isAsExpression(arg.body)) {
          const viaReturn = escapeKindOf(arg.body.type);
          if (viaReturn) record(node, viaReturn, verb);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  // A CHAINED call (`m.mockReturnValueOnce(a).mockReturnValueOnce(b)`) nests with the LAST
  // link outermost, so the walk meets it first and would emit descending line numbers.
  // Callers (the gate's per-file report, the PostToolUse nudge's diff) read this as source
  // order, so sort by position — not by line, which cannot separate two hits on one line.
  results.sort((a, b) => a.pos - b.pos);
  return results.map(({ pos: _pos, ...rest }) => rest);
}

/**
 * Pure gate decision — mirrors `check-vite-externalized-warnings.mjs`'s `decide()`
 * (the same ratchet-only-down, `--update`-only policy), unit-testable in isolation.
 * @param {{ count: number, baselineCount: number, updateFlag?: boolean }} args
 * @returns {{ verdict: 'fail-exceeds'|'ok-ratchet'|'ok-below'|'ok', newBaseline?: number, belowBy?: number }}
 */
export function decide({ count, baselineCount, updateFlag = false }) {
  if (count > baselineCount) return { verdict: 'fail-exceeds' };
  if (count < baselineCount) {
    return updateFlag ? { verdict: 'ok-ratchet', newBaseline: count } : { verdict: 'ok-below', belowBy: baselineCount - count };
  }
  return { verdict: 'ok' };
}

/**
 * Per-file ratchet decision. A tree-wide scalar lets a deletion in file A pay for a
 * new escape in file B, which is exactly how fresh debt hid while the old baseline
 * stayed red. File budgets are independent: decreases remain available only to that
 * file until an explicit --update locks them in, and a new offender starts at zero.
 *
 * @param {{ current: Record<string, number>, baseline: Record<string, number>, updateFlag?: boolean }} args
 */
export function decidePerFile({ current, baseline, updateFlag = false }) {
  const files = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  const increases = [];
  const decreases = [];
  for (const file of files) {
    const count = current[file] ?? 0;
    const baselineCount = baseline[file] ?? 0;
    if (count > baselineCount)
      increases.push({
        file,
        count,
        baselineCount,
        delta: count - baselineCount,
      });
    if (count < baselineCount)
      decreases.push({
        file,
        count,
        baselineCount,
        delta: baselineCount - count,
      });
  }
  increases.sort((a, b) => b.delta - a.delta || a.file.localeCompare(b.file));
  decreases.sort((a, b) => b.delta - a.delta || a.file.localeCompare(b.file));
  if (increases.length) return { verdict: 'fail-file-increase', increases, decreases };
  if (decreases.length) {
    return {
      verdict: updateFlag ? 'ok-ratchet-files' : 'ok-below-files',
      increases,
      decreases,
    };
  }
  return { verdict: 'ok', increases, decreases };
}

/**
 * WI-6666: the original pathspec form (`git ls-files '*.test.ts' '*.test.tsx'`) STOPS
 * AT THE SUPERPROJECT BOUNDARY exactly like a bare `git ls-files` — a pathspec glob
 * doesn't add recursion, it just filters what the (unrecursed) listing returns. So
 * every `.test.ts`/`.test.tsx` inside libs/generic/**, libs/papercusp/**, and
 * papercusp-desktop/** was invisible to this ratchet. `listTrackedFiles` recurses into
 * submodules; filtering by suffix here reproduces the same glob semantics.
 */
function listTestFiles() {
  const { files, unscanned } = listTrackedFiles(ROOT);
  return { files: files.filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx')), unscanned };
}

function readBaseline() {
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf-8'));
}

function writeBaseline({ count, targetCount, byFile, comment }) {
  writeFileSync(
    BASELINE_FILE,
    JSON.stringify(
      {
        count,
        targetCount,
        byFile,
        _comment: comment,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Baseline updated → ${count}`);
}

function main() {
  const argv = process.argv.slice(2);
  const updateFlag = argv.includes('--update');
  const migratePerFile = argv.includes('--migrate-per-file');
  const json = argv.includes('--json');

  const baseline = readBaseline();
  const baselineCount = baseline.count;
  const targetCount = baseline.targetCount ?? baselineCount;

  const { files, unscanned } = listTestFiles();
  /** @type {Record<string, MockCastEscape[]>} */
  const byFile = {};
  /** @type {Record<string, number>} */
  const countsByFile = {};
  let count = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(resolve(ROOT, file), 'utf-8');
    } catch {
      continue; // deleted/renamed since `git ls-files` ran — not a crash
    }
    const found = findMockCastEscapesInText(text, file);
    if (found.length) {
      byFile[file] = found;
      countsByFile[file] = found.length;
      count += found.length;
    }
  }

  if (migratePerFile) {
    if (baseline.byFile) {
      console.error('refused: per-file baseline already exists; use --update to ratchet it down');
      process.exitCode = 1;
      return;
    }
    writeBaseline({
      count,
      targetCount: baselineCount,
      byFile: countsByFile,
      comment:
        baseline._comment +
        ` MIGRATED GLOBAL -> PER-FILE (EI-21339862163229768): reconciled ${count} current escapes ` +
        `while retaining the ${baselineCount} debt target. The old scalar let a deletion in one file ` +
        'pay for a new escape in another; independent file budgets make every new offender fail again. ' +
        'This is a debt allocation, not a claim that the added escapes are acceptable or gone.',
    });
    console.log(`Baseline migrated to per-file budgets (${count} allocated; debt target ${baselineCount}).`);
    process.exitCode = 0;
    return;
  }

  const decision = baseline.byFile
    ? decidePerFile({
        current: countsByFile,
        baseline: baseline.byFile,
        updateFlag,
      })
    : decide({ count, baselineCount, updateFlag });

  if (json) {
    console.log(
      JSON.stringify(
        {
          count,
          baselineCount,
          targetCount,
          verdict: decision.verdict,
          increases: decision.increases ?? [],
          byFile,
        },
        null,
        2,
      ),
    );
  }

  switch (decision.verdict) {
    case 'fail-file-increase': {
      if (!json) {
        const added = decision.increases.reduce((n, row) => n + row.delta, 0);
        console.error(`❌ mock-cast-escape per-file ratchet exceeded in ${decision.increases.length} file(s) (+${added}).`);
        for (const row of decision.increases.slice(0, 25)) {
          console.error(`   ${row.file}: ${row.count} > ${row.baselineCount} (+${row.delta})`);
          for (const hit of (byFile[row.file] ?? []).slice(-Math.min(row.delta, 3))) {
            console.error(`     L${hit.line}: ${hit.snippet}`);
          }
        }
        console.error('   Fix the newly introduced fixture casts with packages/operator-core/lib/testing/typed-mock.ts.');
      }
      process.exitCode = 1;
      return;
    }
    case 'fail-exceeds': {
      if (!json) {
        console.error(`❌ mock-cast-escape count exceeded baseline: ${count} > ${baselineCount} (+${count - baselineCount}).`);
        console.error(`   A NEW \`as never\`/\`as any\` cast now closes a vitest .mock*() call — this is the exact`);
        console.error(`   idiom that made WI-6673's stale fixtures invisible to tsc (EI-19282401068515102).`);
        console.error('');
        const sorted = Object.entries(byFile).sort((a, b) => b[1].length - a[1].length);
        console.error('   Files carrying at least one occurrence (existing debt may be baselined; find the NEW one):');
        for (const [file, hits] of sorted.slice(0, 25)) {
          console.error(`     ${file} (${hits.length})`);
          for (const h of hits.slice(0, 3)) console.error(`       L${h.line}: ${h.snippet}`);
        }
        console.error('');
        console.error('   Fix the fixture instead of casting it away: use the typed helpers in');
        console.error('   packages/operator-core/lib/testing/typed-mock.ts (mockResolvedTyped / mockReturnTyped /');
        console.error('   mockImplementationTyped) so a stale fixture is a tsc error, not a silent runtime failure.');
        console.error('   If this genuinely cannot be typed, that is a deliberate exception — lower the count back');
        console.error('   down elsewhere, or raise the baseline with an explicit justification (never a silent bump).');
      }
      // `stdout` may contain a large JSON report. `process.exit()` can terminate
      // before a piped stream drains, so preserve the status and let Node exit
      // naturally after flushing the report.
      process.exitCode = 1;
      return;
    }
    case 'ok-ratchet':
      writeBaseline({
        count: decision.newBaseline,
        targetCount: decision.newBaseline,
        byFile: undefined,
        comment: baseline._comment,
      });
      process.exitCode = 0;
      return;
    case 'ok-ratchet-files':
      writeBaseline({
        count,
        targetCount: Math.min(targetCount, count),
        byFile: countsByFile,
        comment: baseline._comment,
      });
      if (!json) console.log(`Baseline ratcheted down in ${decision.decreases.length} file(s) → ${count} total.`);
      process.exitCode = 0;
      return;
    case 'ok-below-files':
      if (!json) {
        console.log(
          `✓ ${decision.decreases.length} file budget(s) are below baseline — NOT locked in. ` +
            'Run `node scripts/check-mock-cast-escape.mjs --update` on a quiet tree to lower them deliberately.' +
            describeUnscanned(unscanned),
        );
      }
      process.exitCode = 0;
      return;
    case 'ok-below':
      if (!json) {
        console.log(
          `✓ ${decision.belowBy} under baseline (${count} < ${baselineCount}) — NOT locked in. Run ` +
            '`node scripts/check-mock-cast-escape.mjs --update` on a quiet tree to lower it deliberately.' +
            describeUnscanned(unscanned),
        );
      }
      process.exitCode = 0;
      return;
    default:
      if (!json) {
        if (updateFlag) console.log('✓ --update: count equals baseline — nothing to lower.');
        console.log(`✓ mock-cast-escape count is at baseline (${count})` + describeUnscanned(unscanned));
      }
      process.exitCode = 0;
      return;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
