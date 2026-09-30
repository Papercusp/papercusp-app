/**
 * Negative-space miner ⇄ learning-governor glue (self-learning-frontier
 * P-010 / FB-04 follow-up, unblocked by FB-01) — the D-004 unattended-refusal
 * gate the `system:negative-space-mine` action calls after its own flag check.
 *
 * Contract (FB-01's frontier-loop rule, enforcement 'governor'):
 *
 *   - The preflight is THE gate: governor flag OFF ⇒ 'governor-dark';
 *     unregistered / disabled / unbudgeted / exhausted ⇒ refuse; IO failure ⇒
 *     fail-CLOSED ('governor-error'). The miner runs unattended only past it.
 *   - First armed contact SELF-REGISTERS the loop — with `budgetUsd` OMITTED,
 *     so the row inserts unbudgeted and lands on the governor's D-004 watch
 *     list (summarizeLearningSpend.unbudgetedLoopIds) while the preflight
 *     keeps refusing. Setting the budget is the owner's P-001 arming act.
 *     Registration fires only on an 'unregistered' verdict, so an owner-set
 *     budget is never re-written (the store upsert also preserves omitted
 *     fields — belt and braces).
 *   - budgetKind 'per-cycle': the miner is SQL-only (zero LLM spend), so the
 *     cap is a conscious arming bit, not a real spend bound — per-cycle
 *     verdicts allow on any non-null budget (0 is an honest cap here) and
 *     never exhaust. No spend events are ledgered (gym/scout precedent:
 *     only positive spend lands on the ledger).
 *
 * Deps are injectable (GovernorGlueDeps, the registrants.ts seam) so
 * governor.test.ts covers the gate with zero PG / zero flags IO.
 */
import type { GovernorVerdict } from '../learning-governor/core';
import { learningGovernorPreflight, type GovernorGlueDeps } from '../learning-governor/registrants';
import { registerLearningLoop } from '../learning-governor/store';

/** Governor registry identity — one miner per workspace (the workspace is the other half of the row key). */
export const NEGATIVE_SPACE_LOOP_ID = 'negative-space-miner';

/** The registration row first armed contact (or the seed CLI) writes — budget deliberately OMITTED. */
export function negativeSpaceRegistrationInput(workspaceId: string): {
  workspaceId: string;
  loopId: string;
  displayName: string;
  budgetKind: 'per-cycle';
  enforcement: 'governor';
} {
  return {
    workspaceId,
    loopId: NEGATIVE_SPACE_LOOP_ID,
    displayName: 'Negative-space miner (zero-hit search demand)',
    budgetKind: 'per-cycle',
    enforcement: 'governor',
  };
}

/**
 * Preflight + first-contact self-registration. Returns the preflight verdict
 * unchanged (a tick that registered still refuses 'unregistered' this round;
 * the next reads 'unbudgeted' until the owner budgets it at P-001).
 */
export async function negativeSpaceGovernorGate(
  workspaceId: string,
  deps?: GovernorGlueDeps,
): Promise<GovernorVerdict> {
  const verdict = await learningGovernorPreflight({ workspaceId, loopId: NEGATIVE_SPACE_LOOP_ID }, deps);
  if (verdict.reason !== 'unregistered') return verdict;
  const register = deps?.register ?? registerLearningLoop;
  // Lazy like registrants.ts: the pool module must not load before the flag
  // check in a PG-free process (the verdict above already passed it).
  const getSql =
    deps?.getSql ?? (async () => (await import('@papercusp/db-org')).getOrgPg().sql);
  const log = deps?.log ?? ((m: string) => console.log(`[negative-space-mine] ${m}`));
  try {
    await register(await getSql(), negativeSpaceRegistrationInput(workspaceId));
    log(
      `self-registered loop ${NEGATIVE_SPACE_LOOP_ID} UNBUDGETED on the learning governor ` +
        '(D-004 watch list) — refusing until the owner sets a budget (P-001 arming act)',
    );
  } catch (e) {
    // Best-effort: the verdict already refuses; the next tick retries.
    log(`governor self-registration failed (next tick retries): ${e instanceof Error ? e.message : e}`);
  }
  return verdict;
}
