/**
 * plan-implement.ts — the pure decision for the auto-implement loop
 * (papercusp-self-improvement-loop-2026-06-04, Phase 3 / D-004 / D-006 / D-007;
 * close-the-self-improvement-loop-2026-06-05 D-001).
 *
 * Given the captured backlog + the runtime gates (the flag, a dedicated runner
 * harness, the per-run cap), decide what — if anything — the implement routine
 * should dispatch. Pure + IO-free so every safety branch is unit-testable:
 *
 *   - `disabled`  — the master flag is OFF (the DEFAULT). Nothing is built; the
 *                   loop only captures + triages until an owner flips it on.
 *   - `noop`      — flag ON but nothing is dispatchable (no kind=bug in the safe
 *                   lane, or everything eligible is in-flight / attempts-exhausted).
 *   - `no-runner` — flag ON + work to do, but NO dedicated runner harness is
 *                   configured (D-006). We REFUSE to auto-implement in-process —
 *                   the loop must never modify the operator that runs it. Set
 *                   PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS to a separate harness/worktree.
 *   - `dispatch`  — flag ON + a runner + dispatchable items: dispatch up to the
 *                   per-run cap (D-007 anti-runaway). Each still lands via the
 *                   release gate (D-008) and the release-manager (D-005).
 *
 * The CLOSE-LOOP guards (close-the-self-improvement-loop D-001) keep an armed
 * loop from re-dispatching the same bug every cadence tick:
 *   - **in-flight** — an item claimed recently (assignee + fresh assignedAt) is a
 *     dispatch already running; skip it. A stale claim (the runner died) becomes
 *     eligible again after `staleClaimMs`.
 *   - **post-touch cooldown** (EI-8385) — an item touched (any claim, release, or
 *     state change) within `postTouchCooldownMs` is ALSO skipped, even with a
 *     null assignee. Guards a cross-lane race: the interactive backlog-drain
 *     fleet (scheduler:get_next / work_items:claim) can claim + release the
 *     SAME item the auto-implement lane has an open dispatch on; the instant
 *     assignee clears, `assignedAt`-based in-flight goes stale well before the
 *     underlying dispatch actually finishes, so the loop re-dispatches a
 *     duplicate worker. `updatedAt` (bumped by every touch, not just this
 *     lane's own claim) closes that gap with a short, cheap cooldown — NOT a
 *     substitute for a real dispatch-ledger join, just enough slack that a
 *     just-touched item doesn't look "long since abandoned".
 *   - **attempts cap** — an item already dispatched `maxAttempts` times never
 *     auto-dispatches again (improvements:resolve routes it to a human on the
 *     exhausted could-not-fix, so it also leaves the auto lane in triage).
 *   - the resolved back-edge itself (`improvements:resolve` → state=resolved)
 *     removes a FIXED bug from the open set entirely.
 */

import { buildDigest, type ScoredItem } from './digest';
import type { ImprovementCandidate, RiskTierPolicy } from './policy';
import { DEFAULT_MAX_ATTEMPTS } from './resolve-core';

/** How long a claim marks an item in-flight before it is considered stale
 *  (the runner died / never resolved). 4 cadence ticks at the 30-min default. */
export const DEFAULT_STALE_CLAIM_MS = 2 * 60 * 60 * 1000;

/** EI-8385: how long after ANY touch (claim, release, state change — not just
 *  this lane's own claim) an item stays treated as in-flight regardless of its
 *  current assignee. Short on purpose — this is slack for a racing claim/release
 *  from another consumer of the same backlog, not a real liveness check. */
export const DEFAULT_POST_TOUCH_COOLDOWN_MS = 15 * 60 * 1000;

export interface ImplementRunInput {
  items: ImprovementCandidate[];
  /** The master switch (FLAGS.IMPROVEMENT_AUTO_IMPLEMENT). Default OFF. */
  flagEnabled: boolean;
  /** The dedicated runner harness slug (D-006) — null/empty when unconfigured. */
  runnerHarness: string | null;
  /** Max items to dispatch per run (D-007 anti-runaway). */
  maxPerRun: number;
  /** Max dispatch attempts per item before it is human-only (close-loop D-001). */
  maxAttempts?: number;
  /** P-032: the lane is in a fleet credential/env outage (recent workers dying on
   *  rate-limit/auth) — PAUSE dispatching rather than burn dispatches on instantly-
   *  dying workers. Computed by the action from the dispatch ledger (laneInEnvOutage). */
  laneEnvOutage?: boolean;
  /** Claim freshness window for the in-flight skip (close-loop D-001). */
  staleClaimMs?: number;
  /** Post-touch cooldown window for the cross-lane race guard (EI-8385). */
  postTouchCooldownMs?: number;
  policy?: RiskTierPolicy;
  /**
   * The OWNER FULL-AUTONOMY grant (`FLAGS.MUG_FULL_AUTONOMY`, Phase 2). When true the
   * tier split lifts the protected-path/keyword TCB bars, so a kind=bug touching the
   * deploy gate / flags / capability dispatch / migrations / the loop's own code becomes
   * dispatchable. Read at the action boundary; default off. Still gated by `flagEnabled`
   * (IMPROVEMENT_AUTO_IMPLEMENT) + the runner harness + the release-manager at deploy.
   */
  ownerFullAutonomy?: boolean;
  nowMs?: number;
}

export type ImplementAction = 'disabled' | 'paused' | 'noop' | 'no-runner' | 'dispatch';

export interface ImplementRunPlan {
  action: ImplementAction;
  /** What would be / is dispatched (auto lane, dispatchable, capped). */
  candidates: ScoredItem[];
  /** Total auto-eligible open items (pre-cap, pre-skip), for visibility. */
  autoEligibleCount: number;
  /** Auto-eligible items skipped: claimed recently — a dispatch is in flight. */
  inFlightCount: number;
  /** Auto-eligible items skipped: dispatch attempts exhausted (human-only now). */
  attemptsExhaustedCount: number;
  /**
   * The attempts-exhausted items themselves (consume-edges P-012): still in the
   * auto lane (no `needsHuman` yet — a silent worker death never calls
   * improvements:resolve, so nothing flagged them) but never dispatchable again.
   * The implement routine flips each to the human tier; once flipped, the policy
   * moves it out of the auto lane, so it leaves this list on the next read.
   * Excludes items whose final claim is still fresh (the worker may yet resolve).
   */
  attemptsExhausted: ScoredItem[];
  /** EI-1404: auto-eligible items skipped because a prior death parsed an exact
   *  quota/rate-limit reset time still in the future (dispatchHoldUntil). */
  onHoldCount: number;
  message: string;
}

export function planImplementRun(input: ImplementRunInput): ImplementRunPlan {
  const cap = Math.max(0, Math.floor(input.maxPerRun));
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const staleClaimMs = input.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
  const postTouchCooldownMs = input.postTouchCooldownMs ?? DEFAULT_POST_TOUCH_COOLDOWN_MS;
  const nowMs = input.nowMs ?? Date.now();
  const digest = buildDigest(input.items, {
    policy: input.policy,
    nowMs,
    ...(input.ownerFullAutonomy !== undefined ? { ownerFullAutonomy: input.ownerFullAutonomy } : {}),
  });
  const auto = digest.autoEligible;

  // Close-loop dispatch guards (D-001): skip in-flight + attempts-exhausted.
  const inFlight = (s: ScoredItem): boolean => {
    if (s.assignee) {
      if (!s.assignedAt) return true; // claimed, age unknown → assume in flight
      const age = nowMs - Date.parse(s.assignedAt);
      if (!Number.isFinite(age) || age < staleClaimMs) return true;
    }
    // EI-8385: no CURRENT assignee doesn't mean nothing is in flight — another
    // consumer of the same backlog (the interactive drain fleet) may have just
    // claimed + released this exact item while the auto-implement lane's own
    // dispatch is still running. A very recent touch (any lifecycle update) is
    // treated as in-flight for this short cooldown regardless of assignee.
    if (s.updatedAt) {
      const touchedAge = nowMs - Date.parse(s.updatedAt);
      if (Number.isFinite(touchedAge) && touchedAge < postTouchCooldownMs) return true;
    }
    return false;
  };
  const exhausted = (s: ScoredItem): boolean => (s.attempts ?? 0) >= maxAttempts;
  // EI-1404: a prior death parsed an EXACT quota/rate-limit reset time still in the
  // future — hold THIS item until then instead of re-firing on the generic cadence
  // into the same closed window. An unparseable/garbled dispatchHoldUntil is treated
  // as "no hold" (fail open — never wedge an item on a corrupt payload value).
  const onHold = (s: ScoredItem): boolean => {
    if (!s.dispatchHoldUntil) return false;
    const holdMs = Date.parse(s.dispatchHoldUntil);
    return Number.isFinite(holdMs) && holdMs > nowMs;
  };
  const dispatchable = auto.filter((s) => !inFlight(s) && !exhausted(s) && !onHold(s));
  const inFlightCount = auto.filter(inFlight).length;
  const attemptsExhausted = auto.filter((s) => !inFlight(s) && exhausted(s));
  const attemptsExhaustedCount = attemptsExhausted.length;
  const onHoldCount = auto.filter((s) => !inFlight(s) && !exhausted(s) && onHold(s)).length;
  const skippedNote =
    inFlightCount || attemptsExhaustedCount || onHoldCount
      ? ` (skipped: ${inFlightCount} in-flight, ${attemptsExhaustedCount} attempts-exhausted, ${onHoldCount} on-hold)`
      : '';

  if (!input.flagEnabled) {
    return {
      action: 'disabled',
      candidates: [],
      autoEligibleCount: auto.length,
      inFlightCount,
      attemptsExhaustedCount,
      onHoldCount,
      attemptsExhausted,
      message:
        `auto-implement is OFF (default) — ${auto.length} auto-eligible bug(s) waiting. ` +
        `Flip the papercusp-improvement-auto-implement flag (and configure a runner harness) to enable.`,
    };
  }
  // P-032: fleet credential/env outage — PAUSE the lane (don't dispatch workers that
  // would die instantly on rate-limit/auth + generate orphan noise). The exhausted-flip
  // still runs above (env deaths don't charge attempts, EI-406, so attemptsExhausted are
  // genuine non-env exhaustions). The lane auto-resumes when env-failures age out of the
  // detection window (the action probes recovery on the next clean tick).
  if (input.laneEnvOutage) {
    return {
      action: 'paused',
      candidates: [],
      autoEligibleCount: auto.length,
      inFlightCount,
      attemptsExhaustedCount,
      onHoldCount,
      attemptsExhausted,
      message:
        `lane PAUSED — fleet credential/env outage (recent workers dying on rate-limit/auth); ` +
        `holding ${dispatchable.length} dispatchable bug(s) until the env recovers (P-032)`,
    };
  }
  if (dispatchable.length === 0) {
    return {
      action: 'noop',
      candidates: [],
      autoEligibleCount: auto.length,
      inFlightCount,
      attemptsExhaustedCount,
      onHoldCount,
      attemptsExhausted,
      message: `nothing dispatchable to implement${skippedNote}`,
    };
  }
  if (!input.runnerHarness) {
    return {
      action: 'no-runner',
      candidates: dispatchable.slice(0, cap),
      autoEligibleCount: auto.length,
      inFlightCount,
      attemptsExhaustedCount,
      onHoldCount,
      attemptsExhausted,
      message:
        `flag ON and ${dispatchable.length} bug(s) dispatchable, but NO dedicated runner harness is configured ` +
        `(set PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS — D-006). Refusing to auto-implement in-process.`,
    };
  }
  const candidates = dispatchable.slice(0, cap);
  return {
    action: candidates.length > 0 ? 'dispatch' : 'noop',
    candidates,
    autoEligibleCount: auto.length,
    inFlightCount,
    attemptsExhaustedCount,
    onHoldCount,
    attemptsExhausted,
    message:
      candidates.length > 0
        ? `dispatching ${candidates.length}/${dispatchable.length} dispatchable bug(s) to runner '${input.runnerHarness}'${skippedNote} (lands via the release gate)`
        : `cap is 0 — nothing dispatched (${dispatchable.length} waiting)${skippedNote}`,
  };
}
