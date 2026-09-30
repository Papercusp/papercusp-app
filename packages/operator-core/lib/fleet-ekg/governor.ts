/**
 * Fleet EKG ⇄ learning-governor glue (self-learning-frontier-2026-06-12
 * P-030 / FB-10) — the D-004 unattended-refusal gate the
 * `system:fleet-ekg-scan` action calls after its own flag check. Mirrors
 * lib/negative-space/governor.ts (the FB-04 precedent for a SQL-only loop):
 *
 *   - The preflight is THE gate: governor flag OFF ⇒ 'governor-dark';
 *     unregistered / disabled / unbudgeted / exhausted ⇒ refuse; IO failure ⇒
 *     fail-CLOSED ('governor-error').
 *   - First armed contact SELF-REGISTERS the loop with `budgetUsd` OMITTED —
 *     unbudgeted, so it lands on the governor's D-004 watch list while the
 *     preflight keeps refusing. Setting the budget is the owner's P-001
 *     arming act; registration fires only on an 'unregistered' verdict so an
 *     owner-set budget is never re-written.
 *   - budgetKind 'per-cycle': the EKG is SQL-only (zero LLM spend) — the cap
 *     is a conscious arming bit (0 is an honest cap), and no spend events are
 *     ledgered (only positive spend lands on the ledger).
 */
import type { GovernorVerdict } from '../learning-governor/core';
import { learningGovernorPreflight, type GovernorGlueDeps } from '../learning-governor/registrants';
import { registerLearningLoop } from '../learning-governor/store';

/** Governor registry identity — one EKG per workspace. */
export const FLEET_EKG_LOOP_ID = 'fleet-ekg';

/** The registration row first armed contact (or the seed CLI) writes — budget deliberately OMITTED. */
export function fleetEkgRegistrationInput(workspaceId: string): {
  workspaceId: string;
  loopId: string;
  displayName: string;
  budgetKind: 'per-cycle';
  enforcement: 'governor';
} {
  return {
    workspaceId,
    loopId: FLEET_EKG_LOOP_ID,
    displayName: 'Fleet EKG (behavioral drift monitor)',
    budgetKind: 'per-cycle',
    enforcement: 'governor',
  };
}

/**
 * Preflight + first-contact self-registration. Returns the preflight verdict
 * unchanged (a tick that registered still refuses 'unregistered' this round;
 * the next reads 'unbudgeted' until the owner budgets it at P-001).
 */
export async function fleetEkgGovernorGate(
  workspaceId: string,
  deps?: GovernorGlueDeps,
): Promise<GovernorVerdict> {
  const verdict = await learningGovernorPreflight({ workspaceId, loopId: FLEET_EKG_LOOP_ID }, deps);
  if (verdict.reason !== 'unregistered') return verdict;
  const register = deps?.register ?? registerLearningLoop;
  // Lazy like registrants.ts: the pool module must not load before the flag
  // check in a PG-free process (the verdict above already passed it).
  const getSql = deps?.getSql ?? (async () => (await import('@papercusp/db-org')).getOrgPg().sql);
  const log = deps?.log ?? ((m: string) => console.log(`[fleet-ekg-scan] ${m}`));
  try {
    await register(await getSql(), fleetEkgRegistrationInput(workspaceId));
    log(
      `self-registered loop ${FLEET_EKG_LOOP_ID} UNBUDGETED on the learning governor ` +
        '(D-004 watch list) — refusing until the owner sets a budget (P-001 arming act)',
    );
  } catch (e) {
    // Best-effort: the verdict already refuses; the next tick retries.
    log(`governor self-registration failed (next tick retries): ${e instanceof Error ? e.message : e}`);
  }
  return verdict;
}
