/**
 * Graduation tracker ⇄ learning-governor glue (self-learning-frontier
 * P-046 / FB-19) — the D-004 unattended-refusal gate `system:graduation-scan`
 * calls after its own flag check. Mirrors lib/negative-space/governor.ts
 * (FB-04's pattern) verbatim:
 *
 *   - The preflight is THE gate: governor flag OFF ⇒ 'governor-dark';
 *     unregistered / disabled / unbudgeted / exhausted ⇒ refuse; IO failure ⇒
 *     fail-CLOSED ('governor-error'). The tracker runs unattended only past it.
 *   - First armed contact SELF-REGISTERS the loop with `budgetUsd` OMITTED, so
 *     the row lands unbudgeted on the governor's D-004 watch list
 *     (summarizeLearningSpend.unbudgetedLoopIds) while the preflight keeps
 *     refusing. Setting the budget is the owner's P-001 arming act (0 is
 *     honest — the scan is SQL-only, zero LLM spend).
 *   - budgetKind 'per-cycle': allows on any non-null budget, never exhausts;
 *     no spend events are ledgered (only positive spend lands on the ledger).
 */
import type { GovernorVerdict } from '../learning-governor/core';
import { learningGovernorPreflight, type GovernorGlueDeps } from '../learning-governor/registrants';
import { registerLearningLoop } from '../learning-governor/store';

/** Governor registry identity — one tracker per workspace. */
export const GRADUATION_LOOP_ID = 'graduation-tracker';

/** The registration row first armed contact (or the seed CLI) writes — budget deliberately OMITTED. */
export function graduationRegistrationInput(workspaceId: string): {
  workspaceId: string;
  loopId: string;
  displayName: string;
  budgetKind: 'per-cycle';
  enforcement: 'governor';
} {
  return {
    workspaceId,
    loopId: GRADUATION_LOOP_ID,
    displayName: 'Graduation evidence tracker (per-class clean-pass counters)',
    budgetKind: 'per-cycle',
    enforcement: 'governor',
  };
}

/**
 * Preflight + first-contact self-registration. Returns the preflight verdict
 * unchanged (a tick that registered still refuses 'unregistered' this round;
 * the next reads 'unbudgeted' until the owner budgets it at P-001).
 */
export async function graduationGovernorGate(
  workspaceId: string,
  deps?: GovernorGlueDeps,
): Promise<GovernorVerdict> {
  const verdict = await learningGovernorPreflight({ workspaceId, loopId: GRADUATION_LOOP_ID }, deps);
  if (verdict.reason !== 'unregistered') return verdict;
  const register = deps?.register ?? registerLearningLoop;
  // Lazy like registrants.ts: the pool module must not load before the flag
  // check in a PG-free process (the verdict above already passed it).
  const getSql = deps?.getSql ?? (async () => (await import('@papercusp/db-org')).getOrgPg().sql);
  const log = deps?.log ?? ((m: string) => console.log(`[graduation-scan] ${m}`));
  try {
    await register(await getSql(), graduationRegistrationInput(workspaceId));
    log(
      `self-registered loop ${GRADUATION_LOOP_ID} UNBUDGETED on the learning governor ` +
        '(D-004 watch list) — refusing until the owner sets a budget (P-001 arming act)',
    );
  } catch (e) {
    // Best-effort: the verdict already refuses; the next tick retries.
    log(`governor self-registration failed (next tick retries): ${e instanceof Error ? e.message : e}`);
  }
  return verdict;
}
