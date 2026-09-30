/**
 * gate-artifact-verdict-tail.ts — the EI-19940993365684927 invariant, as code.
 *
 *   A gate artifact's LAST line must BE its verdict, or must be MORE alarming
 *   than its verdict — never less. Readers (human and agent) read the tail.
 *
 * Lifted out of its test file so the checker can be (a) replayed over git
 * HISTORY as a falsifiability proof against the REAL pre-fix artifact rather
 * than only against synthetic controls, and (b) reused for this class's other
 * confirmed instances (the from-repo smoke's `OVERALL: PASS` tail on a run whose
 * witness recorded a C-001 breach — WI-37222; green-checkpoint's hardcoded
 * "type regressions" banner printed above an OOM crash — WI-37503).
 *
 * ⚠ Replaying a COPY of the logic over history proves nothing about the guard
 * that actually runs. That is why this is a module both callers import, rather
 * than a rule re-expressed in a script.
 */

/**
 * Returns the payload of the LAST `echo "…"` emitted on the replication soak's
 * FAILURE path — i.e. the line a reader's `tail` actually lands on.
 *
 * Anchored to `^\s*echo "` so quoted strings inside the drv_exec/grep heredocs in
 * this region are not mistaken for emitted output.
 */
export function lastEmittedLineOnFailPath(src: string): string | null {
  const start = src.indexOf('replication-liveness soak FAIL');
  if (start < 0) return null;
  // Anchor the end on the `return "$rc"` STATEMENT (line-start), not on the first
  // textual occurrence: the script's own comments quote `return "$rc"` in prose, and
  // an indexOf() would end the region there — silently excluding the very lines this
  // guard exists to inspect. (Not hypothetical: it is exactly how this guard failed
  // on its first run, reporting the ✗ branch as the final emitted line while the
  // unconditional verdict sat just past the truncation point.)
  const rest = src.slice(start);
  const endMatch = /^[ \t]*return "\$rc"/m.exec(rest);
  if (!endMatch) return null;
  const region = rest.slice(0, endMatch.index);
  const echoes = [...region.matchAll(/^[ \t]*echo "([^"]*)"/gm)].map((m) => m[1]);
  return echoes.length > 0 ? echoes[echoes.length - 1]! : null;
}

/**
 * The invariant as a predicate, so controls, the real file, and a history replay
 * all exercise the SAME rule.
 *
 * Note what this is really asserting. In the pre-fix shape the textually-last echo
 * is the `✗` branch, not the `✓` — the emitted tail is decided by WHICH BRANCH
 * FIRES, so on a run where the detector pin passed, the tail was the reassuring ✓.
 * The property that holds on EVERY path is therefore: an UNCONDITIONAL verdict must
 * follow the ✓/✗ branch.
 */
export function tailIsVerdictNotReassurance(src: string): boolean {
  const last = lastEmittedLineOnFailPath(src);
  if (last === null) return false;
  if (/^\s*✓/.test(last)) return false; // a reassuring tail on a failure path
  return /^OVERALL:/.test(last);
}

/**
 * Drop whole-line shell comments before any structural check.
 *
 * This is load-bearing, not hygiene. A guard that parses source must not be
 * SATISFIABLE — or DEFEATABLE — by prose ABOUT that source, and both directions
 * have already bitten this very module: its sibling checker ended its search
 * region on the first textual `return "$rc"`, which matched that string quoted
 * inside a newly-written COMMENT, truncating the region before the exact lines
 * the guard existed to inspect. The comments added alongside the fix below quote
 * both `tail -1` and `OVERALL:`, so without this the check would read its own
 * explanation as evidence and pass for the wrong reason.
 */
export function stripShellComments(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^[ \t]*#/.test(line))
    .join('\n');
}

/**
 * Where the matrix summary table draws a FAILING scenario's human-readable
 * message from.
 *
 * The second half of EI-19940993365684927's original filing: the per-scenario row
 * rendered `FAIL  replication_soak  ✓ detector fire-path pin: …` because the
 * message was the log's last non-blank line regardless of verdict. Fixing one
 * scenario's tail does NOT fix this — the row stays wrong for any scenario that
 * fails while ending on a ✓ — so the invariant is enforced at the renderer.
 *
 *   'failure-lines' — FAIL branch derives from OVERALL:/✗ (correct)
 *   'last-line'     — a `tail -1` derivation reaches the FAIL row (the defect)
 *   null            — the region could not be located; the caller must FAIL,
 *                     never pass, on a shape this cannot read.
 */
/**
 * The banner green-checkpoint prints when its `lint:tsc` leg exits non-zero.
 *
 * Same class, third instance. The banner was a hardcoded string asserting
 * "operator-core type regressions block the release" — printed on ANY non-zero
 * exit, including the one where tsc CRASHED on V8's default heap and produced
 * zero diagnostics (WI-37503). Agents read the banner, went hunting for type
 * errors that did not exist, and the real cause (an OOM) was in the output they
 * had been told was a list of type regressions.
 *
 * Fixing the OOM was a mitigation: the banner still lies for the NEXT cause that
 * makes tsc exit non-zero without diagnostics (a config fault, a zero-file run).
 * So the banner is derived from what the run actually PRODUCED, never assumed.
 */
export function typecheckFailureBanner(exitCode: number, output: string): string {
  // tsc's own diagnostic format. If the leg failed while emitting none of these,
  // it did not identify a type regression — whatever else it did.
  if (/error TS\d+/.test(output)) {
    return '\n\n=== TYPECHECK FAILED (npm run lint:tsc) — operator-core type regressions block the release ===\n';
  }
  // ⚠ `TYPECHECK FAILED (npm run lint:tsc` is a LOAD-BEARING ANCHOR, not prose. Three
  // separate consumers key off this exact phrase: the WI-9613 greppability ratchet
  // (green-checkpoint-leg-banner-shape.test.ts), the real-path wiring tests
  // (green-checkpoint-real-deps.test.ts), and the triage grep CLAUDE.md documents
  // (`grep -oE 'FAILED \(npm run [a-z:-]+'`). Inserting a word between TYPECHECK and
  // FAILED — this branch read "TYPECHECK LEG FAILED" for ~3.5h on 2026-08-09 — breaks all
  // three at once and makes the gate's most important leg invisible to the triage path,
  // which is the very failure WI-9613 exists to prevent. The honesty this function was
  // built for (WI-37527) lives in the clause BELOW, never in the anchor.
  return (
    `\n\n=== TYPECHECK FAILED (npm run lint:tsc, exit=${exitCode}) — the run reported NO type diagnostics, ` +
    'so this is NOT a known type regression. A crash (V8 heap OOM — WI-37503), a config fault, or a run that ' +
    'checked zero files all produce this exact shape. Read the output below before hunting for type errors ' +
    'that may not exist. ===\n'
  );
}

export function failRowMessageSource(src: string): 'last-line' | 'failure-lines' | null {
  const body = stripShellComments(src);
  const start = body.indexOf('SCN_RC[$id]=$rc');
  if (start < 0) return null;
  const region = body.slice(start);
  const endMatch = /^[ \t]*fi\b/m.exec(region);
  if (!endMatch) return null;
  const scoped = region.slice(0, endMatch.index);

  const branchAt = scoped.search(/^[ \t]*if \[ "\$rc" -eq 0 \]/m);
  if (branchAt < 0) return null;
  const preBranch = scoped.slice(0, branchAt);

  // An assignment BEFORE the rc split reaches both rows, so a tail -1 there is
  // exactly the pre-fix defect no matter what the else-branch later does.
  if (/SCN_LINE\[\$id\]=/.test(preBranch) && /tail -1/.test(preBranch)) return 'last-line';

  const elseAt = scoped.search(/^[ \t]*else\b/m);
  if (elseAt < 0) return null;
  const failBranch = scoped.slice(elseAt);
  if (!/SCN_LINE\[\$id\]=/.test(failBranch)) return 'last-line';
  return /OVERALL:/.test(failBranch) || /✗/.test(failBranch) ? 'failure-lines' : 'last-line';
}
