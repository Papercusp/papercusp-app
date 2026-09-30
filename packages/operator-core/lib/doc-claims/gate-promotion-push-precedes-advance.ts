/**
 * CLAUDE.md's gate-triage box opens with the premise every recipe beneath it leans on:
 * the candidate is cut from the LOCAL integration branch, the gate never fetches, and so
 * pushing is not a precondition for the gate to SELECT A CANDIDATE or to RUN.
 *
 * That is true of the gate's INPUT. Until EI-20626763969105622 it was stated UNSCOPED —
 * "PUSHING IS NOT A GATE PRECONDITION" — which reads as the blanket claim that the push
 * does not matter to the gate at all.
 *
 * It matters to the OUTPUT, and load-bearingly. Promotion publishes the tested candidate
 * to origin BEFORE advancing the local green pin, and a push failure is deliberately
 * fatal: `pushGreenCandidateOrThrow`'s own comment states that swallowing it "lets local
 * `main` advance, emits a false deployable verdict, and makes every later run look
 * up-to-date even though origin is still stale". So while the push credential is broken,
 * the run throws before any promotion decision — no advance, no `GATE_PROMOTION` trailer,
 * and no green is recordable at all.
 *
 * ── Why an over-broad claim cost more than a wrong one ──
 *
 * Measured 2026-08-16 (found during WI-39450 gate-red triage). With GitHub 403ing every
 * push ("You must verify your email address"), an agent read the unscoped sentence and
 * told BOTH a peer and the owner that the 403 did not block the gate and that firing
 * `release:checkpoint-run` was safe. Both wrong: the 11:22Z run had already shown the
 * signature — green=true logged, then not-green 4ms after the push 403, no trailer.
 * Firing would have bought a 4th consecutive red plus a ~55min suite on a thrashing host.
 *
 * The trap is that the sentence was doing its job for the recipes beneath it, which
 * really are about candidate selection, while mis-arming anyone reasoning about the gate
 * as a whole. Both halves are true at once and the doc must now say so: an unpushed
 * commit IS in the candidate, AND a failing push hard-freezes promotion.
 *
 * ── What this module pins ──
 *
 * The doc claim is a claim about CODE, so it is checkable against code. Three properties,
 * each anchored to the PROPERTY rather than to a spelling:
 *
 *   1. the push helper RETHROWS — a best-effort push would make promotion survive a
 *      failed publish, which is the exact false-green its comment forbids
 *   2. every promotion advance is PRECEDED by a push on its own path
 *   3. no push CALL SITE swallows the rejection — one call already attaches `.catch(...)`
 *      to stamp `push-failed` before rethrowing, and a future edit dropping that rethrow
 *      would break the invariant while still looking deliberate
 *
 * If someone legitimately makes the push best-effort, (1)-(3) fail here and the doc must
 * be updated in the same change. The guard fails on DRIFT, not on today's answer.
 *
 * ⚠ STATED BOUND: this is textual, not a TS parse — the same bound the sibling
 * `gate-candidate-ref` states, and sufficient for the same reason: the properties are
 * about call ordering and the presence of a `throw`, not about types.
 *
 * ⚠ CONTINUATION-AWARENESS IS LOAD-BEARING, not a nicety. In the real file one promotion
 * path is formatted `await deps\n  .advance(candidate)`. A detector matching `deps.advance(`
 * therefore sees ONE of the two promotion paths, finds it correctly guarded, and reports a
 * clean pass — a vacuous guard indistinguishable from a real one. Matching `.advance(`
 * independently of its receiver line is what keeps both paths in view; the fixture controls
 * below include a split-receiver case for exactly this reason.
 */
import { stripComments } from './gate-candidate-ref';

/** A source line implicated in one of the three properties. */
export interface PromotionFinding {
  /** 1-based line in the source. */
  line: number;
  text: string;
}

export interface GatePromotionPushVerdict {
  /** True when the push helper's failure path ends in a rethrow. */
  pushHelperRethrows: boolean;
  /** CALL sites of the push helper (its definition is excluded). */
  pushSites: PromotionFinding[];
  /** Sites advancing the green pin, receiver-line-independent. */
  advanceSites: PromotionFinding[];
  /** Push call sites whose attached `.catch(...)` does not rethrow. */
  swallowedPushSites: PromotionFinding[];
  /** Advance sites with no push between them and the previous advance. */
  unguardedAdvanceSites: PromotionFinding[];
  /** Human-readable violations; empty when the doc claim holds. */
  violations: string[];
  ok: boolean;
}

const PUSH_HELPER_DEF = /function\s+pushGreenCandidateOrThrow\s*\(/;
const PUSH_CALL = /pushGreenCandidateOrThrow\s*\(/;
const ADVANCE_CALL = /\.advance\s*\(/;
const THROWS = /\bthrow\b/;
const CATCH_ATTACHED = /\.catch\s*\(/;

/** Lines from `start` until the first column-0 `}` — the helper's own body. */
function functionBody(lines: readonly string[], start: number, maxLines = 80): string {
  const out: string[] = [];
  for (let i = start; i < Math.min(lines.length, start + maxLines); i += 1) {
    const line = lines[i] ?? '';
    out.push(line);
    if (i > start && /^\}/.test(line)) break;
  }
  return out.join('\n');
}

/**
 * Rejoin a call expression that Prettier has wrapped, without losing the opening line.
 *
 * Bounded by PAREN DEPTH, not by "the first line that looks like it closes a call". The
 * naive line-shape test terminates on the first INNER call instead: for the live
 * `...).catch(\n (error) => {\n stampPromotion(false, "push-failed");\n throw error;` the
 * window would end at the `stampPromotion(...);` line and miss the rethrow one line later,
 * reporting a correctly-guarded push as a swallowed one. That was a real false positive
 * this guard produced on first run against green-checkpoint.ts.
 *
 * ⚠ STATED BOUND: depth counting is textual, so a parenthesis inside a string literal can
 * skew it, and `maxLines` caps how far a skew can run. The cap is what keeps the failure
 * bounded — a widened window could only credit a later, unrelated `throw` to this call.
 */
function callWindow(lines: readonly string[], start: number, maxLines = 24): string {
  const out: string[] = [];
  let depth = 0;
  let opened = false;
  for (let i = start; i < Math.min(lines.length, start + maxLines); i += 1) {
    const line = lines[i] ?? '';
    out.push(line);
    for (const ch of line) {
      if (ch === '(') {
        depth += 1;
        opened = true;
      } else if (ch === ')') {
        depth -= 1;
      }
    }
    if (opened && depth <= 0) break;
  }
  return out.join('\n');
}

/**
 * Judge a green-checkpoint-shaped source against CLAUDE.md's scoped promotion claim.
 *
 * THROWS on a source too small to be the real file. A read that silently returned empty
 * would otherwise produce `ok: true` with zero findings — indistinguishable from a clean
 * pass, which is the false-absence shape this repo keeps paying for.
 */
export function judgeGatePromotionPush(source: string, minLines = 100): GatePromotionPushVerdict {
  const rawLineCount = source.split('\n').length;
  if (rawLineCount < minLines) {
    throw new Error(
      `judgeGatePromotionPush: source has ${rawLineCount} lines (< ${minLines}). ` +
        'Refusing to judge — an empty/short read must not be reported as a clean pass.',
    );
  }

  const codeLines = stripComments(source);
  const at = (i: number, text: string): PromotionFinding => ({ line: i + 1, text: text.trim() });

  const pushSites: PromotionFinding[] = [];
  const advanceSites: PromotionFinding[] = [];
  const swallowedPushSites: PromotionFinding[] = [];
  let pushHelperRethrows = false;
  let sawHelperDefinition = false;

  codeLines.forEach((line, i) => {
    if (PUSH_HELPER_DEF.test(line)) {
      sawHelperDefinition = true;
      if (THROWS.test(functionBody(codeLines, i))) pushHelperRethrows = true;
      return; // the definition is not a call site
    }
    if (PUSH_CALL.test(line)) {
      const window = callWindow(codeLines, i);
      pushSites.push(at(i, line));
      if (CATCH_ATTACHED.test(window) && !THROWS.test(window)) {
        swallowedPushSites.push(at(i, window));
      }
    }
    if (ADVANCE_CALL.test(line)) advanceSites.push(at(i, line));
  });

  // Each advance must have a push on its own path: one strictly between it and the
  // previous advance (or the start of file for the first).
  const unguardedAdvanceSites: PromotionFinding[] = [];
  let previousAdvanceLine = 0;
  for (const advance of advanceSites) {
    const guarded = pushSites.some(
      (push) => push.line > previousAdvanceLine && push.line < advance.line,
    );
    if (!guarded) unguardedAdvanceSites.push(advance);
    previousAdvanceLine = advance.line;
  }

  const violations: string[] = [];
  if (!sawHelperDefinition) {
    violations.push(
      'No `pushGreenCandidateOrThrow` definition found. CLAUDE.md claims promotion pushes ' +
        '`main` to origin before advancing — that claim no longer holds.',
    );
  } else if (!pushHelperRethrows) {
    violations.push(
      'The push helper no longer rethrows: a failed publish would let the local green pin ' +
        'advance anyway, emitting the false deployable verdict its own comment forbids.',
    );
  }
  if (advanceSites.length === 0) {
    violations.push('No site advances the green pin — the promotion path this claim describes is gone.');
  }
  for (const site of unguardedAdvanceSites) {
    violations.push(`Line ${site.line} advances the green pin with no preceding push: ${site.text}`);
  }
  for (const site of swallowedPushSites) {
    violations.push(
      `Line ${site.line} swallows a push rejection instead of rethrowing it: ${site.text}`,
    );
  }

  return {
    pushHelperRethrows,
    pushSites,
    advanceSites,
    swallowedPushSites,
    unguardedAdvanceSites,
    violations,
    ok: violations.length === 0,
  };
}
