/**
 * Transfer harness ⇄ learning-governor glue (P-022 / FB-08) — the D-004
 * unattended-refusal gate the `system:transfer-distill` action calls after
 * its own flag check. Mirrors lib/negative-space/governor.ts, with one
 * difference: this loop SPENDS (distillation LLM + replay batteries + the
 * frozen judge), so its budget is a real LIFETIME cap and every tick ledgers
 * spend via recordLearningSpend (accumulate:true — the governor is this
 * loop's only spend store).
 *
 *   - First armed contact SELF-REGISTERS the loop with `budgetUsd` OMITTED:
 *     the row inserts unbudgeted, lands on the D-004 watch list
 *     (summarizeLearningSpend.unbudgetedLoopIds), and the preflight keeps
 *     refusing. Setting the budget is the owner's P-001 arming act.
 *   - Registration fires only on an 'unregistered' verdict, so an owner-set
 *     budget is never re-written (the store upsert also preserves omitted
 *     fields — belt and braces).
 */
import type { GovernorVerdict } from '../learning-governor/core';
import { learningGovernorPreflight, type GovernorGlueDeps } from '../learning-governor/registrants';
import { registerLearningLoop } from '../learning-governor/store';
import { TRANSFER_LOOP_ID } from './types';

/** The registration row first armed contact (or the seed CLI) writes — budget deliberately OMITTED. */
export function transferRegistrationInput(workspaceId: string): {
  workspaceId: string;
  loopId: string;
  displayName: string;
  budgetKind: 'lifetime';
  enforcement: 'governor';
} {
  return {
    workspaceId,
    loopId: TRANSFER_LOOP_ID,
    displayName: 'Transfer harness (lesson distillation + student-transfer tests)',
    budgetKind: 'lifetime',
    enforcement: 'governor',
  };
}

/**
 * Preflight + first-contact self-registration. Returns the preflight verdict
 * unchanged (a tick that registered still refuses 'unregistered' this round;
 * the next reads 'unbudgeted' until the owner budgets it at P-001).
 */
export async function transferGovernorGate(
  workspaceId: string,
  deps?: GovernorGlueDeps,
): Promise<GovernorVerdict> {
  const verdict = await learningGovernorPreflight({ workspaceId, loopId: TRANSFER_LOOP_ID }, deps);
  if (verdict.reason !== 'unregistered') return verdict;
  const register = deps?.register ?? registerLearningLoop;
  // Lazy like registrants.ts: the pool module must not load before the flag
  // check in a PG-free process (the verdict above already passed it).
  const getSql =
    deps?.getSql ?? (async () => (await import('@papercusp/db-org')).getOrgPg().sql);
  const log = deps?.log ?? ((m: string) => console.log(`[transfer-distill] ${m}`));
  try {
    await register(await getSql(), transferRegistrationInput(workspaceId));
    log(
      `self-registered loop ${TRANSFER_LOOP_ID} UNBUDGETED on the learning governor ` +
        '(D-004 watch list) — refusing until the owner sets a budget (P-001 arming act)',
    );
  } catch (e) {
    // Best-effort: the verdict already refuses; the next tick retries.
    log(`governor self-registration failed (next tick retries): ${e instanceof Error ? e.message : e}`);
  }
  return verdict;
}
