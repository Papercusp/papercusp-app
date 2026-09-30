/**
 * A wake fan CANNOT report that its target picked up — the pure judge behind
 * `wake-pickup-unconfirmable.test.ts` (EI-22733985246154315).
 *
 * THE CLAIM BEING PINNED. `wakeRecipients` returns once a wake is ENQUEUED on the
 * await-event pump. The target has not been scheduled a turn at that moment, let alone
 * taken one, so `WakeRecipientsResult.pickupConfirmed` is unanswerable AT THAT SEAM BY
 * CONSTRUCTION — not merely unimplemented. Every producer in the tree returns the literal
 * `false`, and no future edit can honestly return `true` without first inventing an
 * execution handshake that reports back LATER, from a different seam.
 *
 * WHY IT NEEDS A GUARD. While the field was typed `boolean`, `release:checkpoint-run`
 * gated a gate-ownership stand-down on `wake.pickupConfirmed === true`. Production could
 * never enter that branch, but a unit test mocking `pickupConfirmed: true` exercised it
 * and passed — so the dead branch read as covered behaviour for as long as it existed.
 * That pairing is the actual defect this file exists to prevent: it is not enough to fix
 * the branch, because the mock that made it look tested is what hid it.
 *
 * The three shapes below are therefore judged together:
 *   1. a `boolean` declaration  — re-widens the type that makes shape 2 a compile error;
 *   2. an `=== true` comparison — the dead branch itself;
 *   3. a `: true` object literal — a producer, or a MOCK, asserting the impossible.
 *
 * Judging is textual and deliberately so; comments are stripped first, because the prose
 * explaining this rule necessarily quotes the very shapes it forbids (this file included).
 */
import { stripComments } from './gate-candidate-ref';

/** `pickupConfirmed?: boolean` — the widened declaration that permits the dead branch. */
const BOOLEAN_DECL = /pickupConfirmed\s*\??\s*:\s*boolean/;
/** `pickupConfirmed === true` (or `==`) — the branch production can never enter. */
const CONFIRMED_COMPARISON = /pickupConfirmed\s*===?\s*true|true\s*===?\s*[\w.]*\bpickupConfirmed/;
/** `pickupConfirmed: true` — a producer or a test mock claiming the impossible. */
const CONFIRMED_LITERAL = /pickupConfirmed\s*:\s*true/;

export interface WakePickupSite {
  /** 1-indexed source line. */
  line: number;
  text: string;
}

export interface WakePickupVerdict {
  ok: boolean;
  violations: string[];
  booleanDeclSites: WakePickupSite[];
  confirmedComparisonSites: WakePickupSite[];
  confirmedLiteralSites: WakePickupSite[];
}

export interface JudgeWakePickupOptions {
  /**
   * Label used in violation messages (usually the repo-relative path), so a failure names
   * the file a reader must open rather than only the offending text.
   */
  subject?: string;
  /**
   * Allow `pickupConfirmed: true` in this source. Reserved for a future seam that genuinely
   * observes pickup AFTER the fact (a later activity/checkpoint read) rather than claiming it
   * from an enqueue result. No caller sets this today; it exists so that adding a real
   * handshake is a deliberate, reviewable opt-in instead of a silent guard deletion.
   */
  allowConfirmedLiteral?: boolean;
}

const collect = (lines: readonly string[], re: RegExp): WakePickupSite[] => {
  const out: WakePickupSite[] = [];
  lines.forEach((line, i) => {
    if (re.test(line)) out.push({ line: i + 1, text: line.trim() });
  });
  return out;
};

/**
 * Judge one TypeScript source for the three forbidden `pickupConfirmed` shapes.
 * Returns every site rather than the first, so one run names the whole repair.
 */
export function judgeWakePickupUnconfirmable(
  source: string,
  opts: JudgeWakePickupOptions = {},
): WakePickupVerdict {
  const lines = stripComments(source);
  const where = opts.subject ? `${opts.subject}: ` : '';

  const booleanDeclSites = collect(lines, BOOLEAN_DECL);
  const confirmedComparisonSites = collect(lines, CONFIRMED_COMPARISON);
  const confirmedLiteralSites = opts.allowConfirmedLiteral ? [] : collect(lines, CONFIRMED_LITERAL);

  const violations: string[] = [];
  for (const s of booleanDeclSites) {
    violations.push(
      `${where}line ${s.line}: \`pickupConfirmed\` is declared \`boolean\`. A wake fan returns at ENQUEUE ` +
        'time and cannot know whether a turn started, so it must be typed as the literal `false` — the ' +
        'narrow type is what makes a stand-down branch a compile error instead of dead code.',
    );
  }
  for (const s of confirmedComparisonSites) {
    violations.push(
      `${where}line ${s.line}: compares \`pickupConfirmed\` against \`true\`, which no producer can ever ` +
        'return. This is the EI-22733985246154315 dead branch. Observe pickup afterwards instead (a fresh ' +
        'lastActiveAt / checkpoint / lastProgressAt that post-dates the wake).',
    );
  }
  for (const s of confirmedLiteralSites) {
    violations.push(
      `${where}line ${s.line}: sets \`pickupConfirmed: true\`. In production source that asserts something ` +
        'the seam cannot know; in a TEST it manufactures an input production cannot produce, which is how ' +
        'the dead stand-down branch stayed green. Assert the real path (`pickupConfirmed: false`) instead.',
    );
  }

  return {
    ok: violations.length === 0,
    violations,
    booleanDeclSites,
    confirmedComparisonSites,
    confirmedLiteralSites,
  };
}
