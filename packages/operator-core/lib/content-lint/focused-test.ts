/**
 * Focused-test (`.only`) detector — "did a debug focus get committed by the
 * sweep, silently disabling the rest of the suite" (EI-19447067535467975).
 *
 * The sibling of `constant-conditional`, from the same incident and the same
 * root cause: *on an auto-committing tree there is no safe temporary source
 * mutation*. `if (false && …)` disables a BRANCH; `it.only(…)` disables every
 * OTHER TEST IN THE FILE. Both are edits an agent makes intending to hold them
 * for seconds, and git-sync's whole-tree sweep commits them mid-experiment.
 *
 * WHY THIS ONE IS WORSE THAN THE BRANCH CASE, and why it belongs at the commit
 * seam rather than in CI: a committed `.only` does not fail anything. Vitest
 * runs the focused test, skips the rest of the file, and **exits 0**. The suite
 * reports PASSED. So the signal an agent uses to decide the work is done —
 * `test:affected` green — is precisely the signal this defect forges. A check
 * that runs later cannot help, because by then the green has already been
 * believed. Compare the constant-conditional case, which at least announced
 * itself as 7 tsc errors on somebody else's gate.
 *
 * Measured 2026-08-03 before writing this:
 *   - `allowOnly` is configured NOWHERE in the repo, so vitest permits `.only`
 *     and narrows the suite silently rather than failing the run.
 *   - ZERO tracked test files currently contain `.only`, so the baseline is
 *     empty by construction and no file needs allowlisting.
 *
 * SCOPE — `.only` ONLY. `.skip` is deliberately NOT flagged, and that is a
 * measured decision rather than an oversight: 50 tracked test files use
 * `.skip`, which is this repo's established quarantine idiom (a skipped test
 * announces itself in every run's output as skipped, so it is visible rather
 * than silent). Flagging it would fight a real convention and fire 50 false
 * positives on day one. The two patterns look alike and were filed together in
 * the originating item; they are not the same shape, and only `.only` has the
 * silent-green property that makes it dangerous.
 *
 * Precision comes from requiring BOTH:
 *   - the file is a test/spec file, and
 *   - the `.only` hangs off a known test global (`describe`/`it`/`test`/
 *     `suite`/`bench`) after descending any call/property chain, so
 *     `describe.only`, `test.concurrent.only`, `describe.each([…]).only` and
 *     Playwright's `test.describe.only` all match, while an unrelated
 *     `options.only` / `parsed.only` never does.
 * AST-based (`ts.createSourceFile`, as `ts-parse`, `smart-quotes` and
 * `constant-conditional` in this directory already do), so a `.only` inside a
 * comment or a string literal cannot false-fire.
 *
 * No `autoFix`. Stripping `.only` is a one-character edit but NOT a safe
 * automatic one: the focused test may be the only one the author has got
 * passing, and silently re-enabling its siblings mid-sweep would hand back a
 * red with no explanation. Quarantine for a decision, exactly as `ts-parse`,
 * `shell-syntax`, `conflict-markers` and `constant-conditional` do.
 */
import ts from 'typescript';

/** Test globals whose `.only` focuses a run. Playwright's `test.describe.only`
 *  and vitest's `test.concurrent.only` both reduce to a `test` root. */
const TEST_ROOTS: ReadonlySet<string> = new Set(['describe', 'it', 'test', 'suite', 'bench']);

/** A single focused-test accessor: 1-based source position + what was focused. */
export interface FocusedTestHit {
  line: number | null;
  col: number | null;
  /** The test global the `.only` resolves back to (e.g. `it`, `describe`). */
  root: string;
  /** The accessor as written, bounded for a one-line error message. */
  text: string;
}

/**
 * The root identifier of a member/call chain, or null when it is not a plain
 * identifier. `describe.each([1]).only` → `describe`; `opts.only` → `opts`.
 */
function rootIdentifier(expr: ts.Expression): string | null {
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isCallExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    break;
  }
  return ts.isIdentifier(cur) ? cur.text : null;
}

/**
 * Pure detector: the FIRST focused-test accessor in `text`, or null when clean.
 *
 * Never throws on a syntax error — a file that does not parse is `ts-parse`'s
 * job, and this detector reports clean rather than double-reporting one break.
 */
export function findFocusedTest(fileName: string, text: string): FocusedTestHit | null {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /*setParentNodes*/ false, scriptKind);

  let hit: FocusedTestHit | null = null;
  const visit = (node: ts.Node): void => {
    if (hit) return; // first hit wins — keep the message single-cause
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'only') {
      const root = rootIdentifier(node.expression);
      if (root && TEST_ROOTS.has(root)) {
        const start = node.getStart(sf);
        const pos = sf.getLineAndCharacterOfPosition(start);
        const raw = text.slice(start, node.end).replace(/\s+/g, ' ').trim();
        hit = {
          line: pos.line + 1,
          col: pos.character + 1,
          root,
          text: raw.length > 100 ? `${raw.slice(0, 100)}…` : raw,
        };
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hit;
}
