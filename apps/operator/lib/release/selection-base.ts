/**
 * selection-base.ts — P-011 / D-009 (gate-verdict-liveness-and-repair-reliability-2026-08-31).
 *
 * Resolves the affected-test SELECTION base for a gate suite run. Historically the gate
 * pinned AFFECTED_BASE to `lastReady` (the green pin), so across a long red the selection
 * radius `affected(main..candidate)` grew with the AGE of the outage (~6,653 files by day
 * 11 of the 2026-08 streak) — recovery cost coupled to outage age is why it never
 * self-healed. The last COMPLETED verdict's candidate is a sound, closer base, and the
 * two kinds of completed verdict already have durable anchors carrying exactly the
 * bookkeeping their soundness needs:
 *
 *   - test-leg-GREEN completed verdicts → the P-047 test-certified watermark
 *     (`refs/papercusp/test-certified`, scripts/lib/test-certified-base.mjs): it advances
 *     exactly when every file in that run's radius holds a PASS verdict at that sha
 *     (`decideWatermarkAdvance` refuses scoped / failed / undetermined / timed-out runs).
 *   - test-leg-RED completed verdicts → the frozen repair queue's candidate
 *     (freeze-and-converge): the freeze-time run was a full-radius completed verdict; its
 *     failures live ON the queue (failingTests / stillBroken), its passes are inheritable.
 *
 * PROMOTION STAYS FULL-CANDIDATE — ASSEMBLED, NOT RE-EXECUTED. Green ⇔ the delta
 * (anchor..head) suite is green ∧ (on queue runs) stillBroken is empty. Coverage of
 * lastReady..anchor is inherited through the chain of completed verdicts, each rendered
 * against its predecessor anchor, grounding at lastReady. Non-test gate legs (lint:tsc,
 * perf, desktop, delta) never read AFFECTED_BASE — this narrows TEST SELECTION only.
 *
 * FAIL-SAFE IN ONE DIRECTION ONLY (the P-047 doctrine): every branch that cannot be
 * positively verified falls back to `lastReady` — the historical behaviour. A silently
 * NARROWED run would under-test; that outcome must remain impossible here. The result's
 * `reason` names the branch taken so a test can tell a working guard from a resolver
 * that merely always returns `lastReady`.
 */

import { git as runGit } from "./git-ops";

/** Must equal `TEST_CERTIFIED_REF` in scripts/lib/test-certified-base.mjs — a hand-copied
 *  pair is exactly the drift the derived-truth ladder warns about, so selection-base.test.ts
 *  imports BOTH and compares (the same guard style P-047 uses for SCOPE_FLAGS). */
export const TEST_CERTIFIED_REF = "refs/papercusp/test-certified";

/** Same kill-switch as P-047, same value semantics ("0" disables): one switch, one
 *  semantic — the operator turning the watermark off turns off BOTH read sites.
 *  Equality with the mjs is guarded by selection-base.test.ts. */
export const SELECTION_BASE_DISABLE_ENV = "AFFECTED_TEST_CERTIFIED_BASE";

export type SelectionBaseSource = "last-ready" | "frozen-verdict" | "watermark";

export interface SelectionBaseResult {
  /** What to pass to runGreen as the AFFECTED_BASE. `null` only when lastReady is null. */
  base: string | null;
  source: SelectionBaseSource;
  /** Names the branch taken. Load-bearing for tests: "refused because the anchor is
   *  behind main" and "refused because the function does nothing" must be
   *  distinguishable, or every negative case passes against total breakage. */
  reason: string;
  /** The anchor a guard REJECTED, when one was considered and turned down. */
  rejectedAnchor?: string;
}

/** Read-only git runner in the checkout the suite runs in. MUST return `null` for ANY
 *  failure (non-zero exit, missing binary, wrong dir) — every `null` falls back.
 *  `merge-base --is-ancestor` answers via exit status and prints nothing, so `''` means
 *  a VERIFIED true and `null` means "not an ancestor OR could not tell" — both of which
 *  are unverified, and unverified means fall back. */
export type SelectionBaseGit = (argv: string[]) => Promise<string | null>;

export interface SelectionBaseInput {
  /** The green pin sha (releaseRef) — the historical base and the universal fallback. */
  lastReady: string | null;
  /** The sha the suite is about to judge (the candidate; repairHead on a repair run). */
  judgedHead: string | null;
  /** The frozen repair queue's immutable candidate on a repair-verification run —
   *  the red-verdict anchor. Pass null on fresh cuts. */
  frozenCandidate?: string | null;
  env?: Record<string, string | undefined>;
  git?: SelectionBaseGit;
}

/** A SelectionBaseGit over the real git binary in `repo`; every failure becomes null. */
export function selectionBaseGitFor(repo: string): SelectionBaseGit {
  return async (argv) => {
    try {
      return await runGit(repo, argv);
    } catch {
      return null;
    }
  };
}

export async function resolveSelectionBase(
  input: SelectionBaseInput,
): Promise<SelectionBaseResult> {
  const { lastReady, judgedHead, frozenCandidate = null, env = {}, git } = input;
  const fallback = (reason: string, rejectedAnchor?: string): SelectionBaseResult => ({
    base: lastReady,
    source: "last-ready",
    reason,
    ...(rejectedAnchor ? { rejectedAnchor } : {}),
  });

  if (env[SELECTION_BASE_DISABLE_ENV] === "0") return fallback("disabled");
  if (!lastReady) return fallback("no-last-ready");
  if (!judgedHead) return fallback("no-judged-head");
  if (typeof git !== "function") return fallback("no-git-runner");

  let anchor: string;
  let source: SelectionBaseSource;
  if (frozenCandidate) {
    anchor = frozenCandidate;
    source = "frozen-verdict";
  } else {
    const sha = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      `${TEST_CERTIFIED_REF}^{commit}`,
    ]);
    if (!sha) return fallback("no-watermark");
    anchor = sha;
    source = "watermark";
  }

  // No gain, and lets a caller distinguish "anchor mechanism dead" from "anchor simply
  // hasn't moved past the green pin yet" — the two read identically at the env level.
  if (anchor === lastReady) return fallback("anchor-at-last-ready");

  // Both ancestry checks are load-bearing (the P-047 pair):
  //  - the anchor must be an ANCESTOR OF THE JUDGED HEAD, or its diff describes a history
  //    this run is not judging (a rebase, a foreign ref, a salvage prefix behind it);
  //  - lastReady must be an ancestor of the ANCHOR, i.e. the anchor is at-or-ahead of the
  //    green pin. This makes the anchor only ever able to SHRINK the radius, never grow it.
  if ((await git(["merge-base", "--is-ancestor", anchor, judgedHead])) === null) {
    return fallback(`${source}-not-ancestor-of-head`, anchor);
  }
  if ((await git(["merge-base", "--is-ancestor", lastReady, anchor])) === null) {
    return fallback(`${source}-behind-last-ready`, anchor);
  }

  return { base: anchor, source, reason: source };
}

/** The provenance line for every resolution — a non-default radius must never be a
 *  silent difference to whoever reads the checkpoint transcript later (the
 *  AFFECTED_BASE_SOURCE doctrine from P-047). Emitted on EVERY resolution, fallback
 *  included, so a transcript always answers "which base did this run select against". */
export function selectionBaseLine(
  r: SelectionBaseResult,
  lastReady: string | null,
): string {
  const short = (s: string | null) => (s ? s.slice(0, 12) : "null");
  if (r.source === "last-ready") {
    return (
      `SELECTION_BASE source=last-ready base=${short(r.base)} reason=${r.reason}` +
      (r.rejectedAnchor ? ` rejected=${short(r.rejectedAnchor)}` : "") +
      ` (P-011/D-009: no usable completed-verdict anchor — full last-green radius)`
    );
  }
  return (
    `SELECTION_BASE source=${r.source} base=${short(r.base)} advancedFrom=${short(lastReady)} ` +
    `(P-011/D-009: coverage of the gap is inherited from the completed verdict at the anchor; ` +
    `set ${SELECTION_BASE_DISABLE_ENV}=0 to disable)`
  );
}
