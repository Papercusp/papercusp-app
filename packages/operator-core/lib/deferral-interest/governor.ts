/**
 * Deferral-interest ⇄ learning-governor glue (self-learning-frontier P-042 /
 * FB-14) — the D-004 unattended-refusal gate the
 * `system:deferral-interest-refit` action calls after its own flag check.
 * Mirrors lib/negative-space/governor.ts (the FB-04 follow-up pattern):
 *
 *   - learningGovernorPreflight is THE gate (governor dark / unregistered /
 *     disabled / unbudgeted / exhausted ⇒ refuse; IO failure ⇒ fail-CLOSED).
 *   - First armed contact SELF-REGISTERS the loop with budgetUsd OMITTED —
 *     the row lands unbudgeted on the D-004 watch list and keeps refusing;
 *     setting the (per-cycle) budget is the owner's P-001 arming act. The
 *     refit is SQL-only (zero LLM spend), so 0 is an honest cap and no spend
 *     events are ledgered (gym/scout precedent: only positive spend).
 */
import type { GovernorVerdict } from '../learning-governor/core';
import { learningGovernorPreflight, type GovernorGlueDeps } from '../learning-governor/registrants';
import { registerLearningLoop } from '../learning-governor/store';

/** Governor registry identity — one refit loop per workspace. */
export const DEFERRAL_INTEREST_LOOP_ID = 'deferral-interest-refit';

/** The registration row first armed contact (or the seed CLI) writes — budget deliberately OMITTED. */
export function deferralInterestRegistrationInput(workspaceId: string): {
  workspaceId: string;
  loopId: string;
  displayName: string;
  budgetKind: 'per-cycle';
  enforcement: 'governor';
} {
  return {
    workspaceId,
    loopId: DEFERRAL_INTEREST_LOOP_ID,
    displayName: 'Deferral-interest refit (learned deferral pricing)',
    budgetKind: 'per-cycle',
    enforcement: 'governor',
  };
}

/**
 * Preflight + first-contact self-registration. Returns the preflight verdict
 * unchanged (a tick that registered still refuses 'unregistered' this round;
 * the next reads 'unbudgeted' until the owner budgets it at P-001).
 */
export async function deferralInterestGovernorGate(
  workspaceId: string,
  deps?: GovernorGlueDeps,
): Promise<GovernorVerdict> {
  const verdict = await learningGovernorPreflight({ workspaceId, loopId: DEFERRAL_INTEREST_LOOP_ID }, deps);
  if (verdict.reason !== 'unregistered') return verdict;
  const register = deps?.register ?? registerLearningLoop;
  // Lazy like registrants.ts: the pool module must not load before the flag
  // check in a PG-free process (the verdict above already passed it).
  const getSql =
    deps?.getSql ?? (async () => (await import('@papercusp/db-org')).getOrgPg().sql);
  const log = deps?.log ?? ((m: string) => console.log(`[deferral-interest-refit] ${m}`));
  try {
    await register(await getSql(), deferralInterestRegistrationInput(workspaceId));
    log(
      `self-registered loop ${DEFERRAL_INTEREST_LOOP_ID} UNBUDGETED on the learning governor ` +
        '(D-004 watch list) — refusing until the owner sets a budget (P-001 arming act)',
    );
  } catch (e) {
    // Best-effort: the verdict already refuses; the next tick retries.
    log(`governor self-registration failed (next tick retries): ${e instanceof Error ? e.message : e}`);
  }
  return verdict;
}
