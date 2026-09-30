/**
 * Regret mining ⇄ learning-governor glue (self-learning-frontier-2026-06-12
 * P-021 / FB-07) — the D-004 unattended-refusal gate the `system:regret-mine`
 * action calls after its own flag check. Mirrors the negative-space miner's
 * governor.ts (the FB-04 + FB-01 layering).
 *
 *   - The preflight is THE gate: governor flag OFF ⇒ 'governor-dark';
 *     unregistered / disabled / unbudgeted / exhausted ⇒ refuse; IO failure ⇒
 *     fail-CLOSED ('governor-error').
 *   - First armed contact SELF-REGISTERS the loop with `budgetUsd` OMITTED —
 *     the row lands unbudgeted on the D-004 watch list while the preflight
 *     keeps refusing; setting the budget is the owner's P-001 arming act.
 *   - budgetKind 'per-cycle': unlike the SQL-only miners, regret mining's
 *     replay leg SPENDS (counterfactual replays ride FB-06's lib/replay).
 *     The owner-set per-cycle cap becomes the tick's replayBudgetUsd, and the
 *     action ledgers realized spend via recordLearningSpend (origin=replay).
 *
 * Deps are injectable (GovernorGlueDeps) so governor.test.ts covers the gate
 * with zero PG / zero flags IO.
 */
import type { GovernorVerdict } from '../../learning-governor/core';
import { learningGovernorPreflight, type GovernorGlueDeps } from '../../learning-governor/registrants';
import { registerLearningLoop } from '../../learning-governor/store';

/** Governor registry identity — one regret miner per workspace. */
export const REGRET_LOOP_ID = 'regret-mining';

/** The registration row first armed contact (or the seed CLI) writes — budget deliberately OMITTED. */
export function regretRegistrationInput(workspaceId: string): {
  workspaceId: string;
  loopId: string;
  displayName: string;
  budgetKind: 'per-cycle';
  enforcement: 'governor';
} {
  return {
    workspaceId,
    loopId: REGRET_LOOP_ID,
    displayName: 'Regret mining (bad-session counterfactual replay)',
    budgetKind: 'per-cycle',
    enforcement: 'governor',
  };
}

/**
 * Preflight + first-contact self-registration. Returns the preflight verdict
 * unchanged (a tick that registered still refuses 'unregistered' this round;
 * the next reads 'unbudgeted' until the owner budgets it at P-001).
 */
export async function regretGovernorGate(workspaceId: string, deps?: GovernorGlueDeps): Promise<GovernorVerdict> {
  const verdict = await learningGovernorPreflight({ workspaceId, loopId: REGRET_LOOP_ID }, deps);
  if (verdict.reason !== 'unregistered') return verdict;
  const register = deps?.register ?? registerLearningLoop;
  // Lazy like registrants.ts: the pool module must not load before the flag
  // check in a PG-free process (the verdict above already passed it).
  const getSql = deps?.getSql ?? (async () => (await import('@papercusp/db-org')).getOrgPg().sql);
  const log = deps?.log ?? ((m: string) => console.log(`[regret-mine] ${m}`));
  try {
    await register(await getSql(), regretRegistrationInput(workspaceId));
    log(
      `self-registered loop ${REGRET_LOOP_ID} UNBUDGETED on the learning governor ` +
        '(D-004 watch list) — refusing until the owner sets a budget (P-001 arming act)',
    );
  } catch (e) {
    // Best-effort: the verdict already refuses; the next tick retries.
    log(`governor self-registration failed (next tick retries): ${e instanceof Error ? e.message : e}`);
  }
  return verdict;
}
