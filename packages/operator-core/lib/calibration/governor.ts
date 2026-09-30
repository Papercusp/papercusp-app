/**
 * Calibration markets ⇄ learning-governor glue (P-041 / FB-13) — the D-004
 * unattended-refusal gate `system:calibration-resolve` calls after its own
 * flag check. Mirrors lib/negative-space/governor.ts (the FB-04 pattern):
 *
 *   - preflight is THE gate (governor dark / unregistered / disabled /
 *     unbudgeted / exhausted ⇒ refuse; IO failure ⇒ fail-CLOSED);
 *   - first armed contact self-registers with `budgetUsd` OMITTED so the row
 *     lands unbudgeted on the D-004 watch list while the preflight keeps
 *     refusing — setting the budget is the owner's P-001 arming act;
 *   - budgetKind 'per-cycle': the sweep is SQL-only (zero LLM spend), so the
 *     cap is a conscious arming bit (0 is honest) and no spend events are
 *     ledgered (gym/scout precedent: only positive spend).
 */
import type { GovernorVerdict } from '../learning-governor/core';
import { learningGovernorPreflight, type GovernorGlueDeps } from '../learning-governor/registrants';
import { registerLearningLoop } from '../learning-governor/store';

/** Governor registry identity — one calibration sweep per workspace. */
export const CALIBRATION_LOOP_ID = 'calibration-markets';

/** The registration row first armed contact (or the seed CLI) writes — budget deliberately OMITTED. */
export function calibrationRegistrationInput(workspaceId: string): {
  workspaceId: string;
  loopId: string;
  displayName: string;
  budgetKind: 'per-cycle';
  enforcement: 'governor';
} {
  return {
    workspaceId,
    loopId: CALIBRATION_LOOP_ID,
    displayName: 'Calibration markets (bet resolution sweep)',
    budgetKind: 'per-cycle',
    enforcement: 'governor',
  };
}

/**
 * Preflight + first-contact self-registration. Returns the preflight verdict
 * unchanged (a tick that registered still refuses 'unregistered' this round;
 * the next reads 'unbudgeted' until the owner budgets it at P-001).
 */
export async function calibrationGovernorGate(
  workspaceId: string,
  deps?: GovernorGlueDeps,
): Promise<GovernorVerdict> {
  const verdict = await learningGovernorPreflight({ workspaceId, loopId: CALIBRATION_LOOP_ID }, deps);
  if (verdict.reason !== 'unregistered') return verdict;
  const register = deps?.register ?? registerLearningLoop;
  // Lazy like registrants.ts: the pool module must not load before the flag
  // check in a PG-free process (the verdict above already passed it).
  const getSql =
    deps?.getSql ?? (async () => (await import('@papercusp/db-org')).getOrgPg().sql);
  const log = deps?.log ?? ((m: string) => console.log(`[calibration-resolve] ${m}`));
  try {
    await register(await getSql(), calibrationRegistrationInput(workspaceId));
    log(
      `self-registered loop ${CALIBRATION_LOOP_ID} UNBUDGETED on the learning governor ` +
        '(D-004 watch list) — refusing until the owner sets a budget (P-001 arming act)',
    );
  } catch (e) {
    // Best-effort: the verdict already refuses; the next tick retries.
    log(`governor self-registration failed (next tick retries): ${e instanceof Error ? e.message : e}`);
  }
  return verdict;
}
