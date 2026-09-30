/**
 * Constant-forced `if` detector — "was this branch temporarily disabled and then
 * committed by the sweep" (EI-19446174755157221).
 *
 * On 2026-08-03 `stalled-loops-guard.ts:273` was committed as:
 *
 *   if (false && wall && wall.resumesInMs != null && wall.resumesInMs > 0) {
 *
 * It was never meant to reach `staging`. An agent flipped the branch off for ~90
 * seconds to prove a new exemption had teeth, and git-sync's whole-tree sweep
 * committed the experiment mid-flight. The author's own conclusion is the
 * general one, and it is why this detector lives at the COMMIT seam rather than
 * in CI: *on an auto-committing tree there is no safe temporary source
 * mutation*. A check that only runs later cannot help — by then the mutation is
 * already shared.
 *
 * Two independent defects, and the second is the expensive one:
 *
 * 1. A literal `false` in the FIRST position of an `&&` chain suppresses the
 *    narrowing the later operands would perform. `wall &&` therefore stopped
 *    narrowing `wall` from `T | null` to `T`, and every dereference inside the
 *    provably-unreachable block became "possibly null" — 7 fresh TS18047 errors
 *    on a file whose baseline was 0, i.e. a COMMITTED standing red for the whole
 *    fleet. The failure is invisible to the author (the code still "obviously"
 *    does nothing) and surfaces as somebody else's gate red.
 * 2. A committed constant-forced branch is dead code hiding a LIVE behaviour
 *    change. That particular veto is what stops `stalled-loops-guard` disarming
 *    a loop that is merely backed off behind a provider wall; disabled, the
 *    guard could make a self-healing backoff permanent. Nothing in the tree
 *    showed that the behaviour had changed.
 *
 * SCOPE — deliberately narrow, so it cannot fight a legitimate idiom:
 *   - `IfStatement` ONLY. `while (true)` / `for (;;)` are real idioms and are
 *     never inspected (the repo has several, with eslint-disable comments).
 *   - Only a LITERAL `true`/`false` TOKEN in the condition's leftmost position.
 *     A named constant (`if (ENABLED && …)`) is the RECOMMENDED way to gate a
 *     block and is never flagged — it is greppable, reviewable, and survives a
 *     sweep honestly, which a raw literal does not.
 *
 * Measured over all tracked .ts/.tsx in this repo: ZERO hits for every form it
 * matches, so the baseline is empty by construction and no existing file has to
 * be allowlisted. AST-based (`ts.createSourceFile`, the same pure parse
 * `ts-parse` and `smart-quotes` in this directory already perform) rather than a
 * regex, so comments, string literals and formatting can never produce a false
 * positive.
 *
 * No `autoFix`. The repair is genuinely ambiguous — a disabled branch may be
 * meant to be re-enabled OR deleted, and only the author knows which — so this
 * quarantines for a human/LLM decision exactly as `ts-parse`, `shell-syntax`
 * and `conflict-markers` do.
 */
import ts from 'typescript';

/** A single constant-forced `if` condition: 1-based source position + what forced it. */
export interface ConstantConditionalHit {
  line: number | null;
  col: number | null;
  /** The literal that forces the branch. */
  constant: 'true' | 'false';
  /** `&&`/`||` when the literal leads a chain; null for a bare `if (false)`. */
  operator: '&&' | '||' | null;
  /** The condition's source text, bounded for a one-line error message. */
  text: string;
}

/** The literal `true`/`false` a node is, or null when it is anything else. */
function literalBoolean(node: ts.Expression): 'true' | 'false' | null {
  if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (node.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  return null;
}

/**
 * The forcing literal at the head of a condition, or null.
 *
 * A bare `if (false)` is forced outright. Otherwise only the LEFTMOST operand of
 * an `&&`/`||` chain is considered, because that is the position that both
 * short-circuits the whole condition AND suppresses narrowing: `a && false` is a
 * normal (if odd) expression and is not flagged. `false && …` and `true || …`
 * are the two shapes that make the rest of the condition dead.
 */
function forcingLiteral(
  test: ts.Expression,
): { constant: 'true' | 'false'; operator: '&&' | '||' | null } | null {
  const bare = literalBoolean(test);
  if (bare) return { constant: bare, operator: null };

  if (!ts.isBinaryExpression(test)) return null;
  const op = test.operatorToken.kind;
  const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
  const isOr = op === ts.SyntaxKind.BarBarToken;
  if (!isAnd && !isOr) return null;

  // `false && a && b` parses as `((false && a) && b)` — descend the left spine
  // through same-family operators to reach the true leftmost operand.
  let leftmost: ts.Expression = test;
  while (
    ts.isBinaryExpression(leftmost) &&
    (leftmost.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      leftmost.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    leftmost = leftmost.left;
  }

  const constant = literalBoolean(leftmost);
  if (!constant) return null;
  // Only the combinations that make the REST of the condition dead:
  //   `false && …` can never be true; `true || …` can never be false.
  // `true && …` and `false || …` are redundant but harmless — the condition
  // still depends on its other operands, so they are not disabled branches.
  if (isAnd && constant !== 'false') return null;
  if (isOr && constant !== 'true') return null;
  return { constant, operator: isAnd ? '&&' : '||' };
}

/**
 * Pure detector: the FIRST constant-forced `if` in `text`, or null when clean.
 *
 * Never throws on a syntax error — a file that does not parse is `ts-parse`'s
 * job, and this detector simply reports clean rather than double-reporting the
 * same break (the guard runs both; two quarantine reasons for one cause is
 * noise).
 */
export function findConstantConditional(fileName: string, text: string): ConstantConditionalHit | null {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /*setParentNodes*/ false, scriptKind);

  let hit: ConstantConditionalHit | null = null;
  const visit = (node: ts.Node): void => {
    if (hit) return; // first hit wins — keep the message single-cause
    if (ts.isIfStatement(node)) {
      const forced = forcingLiteral(node.expression);
      if (forced) {
        const start = node.expression.getStart(sf);
        const pos = sf.getLineAndCharacterOfPosition(start);
        const raw = text.slice(start, node.expression.end).replace(/\s+/g, ' ').trim();
        hit = {
          line: pos.line + 1,
          col: pos.character + 1,
          constant: forced.constant,
          operator: forced.operator,
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
