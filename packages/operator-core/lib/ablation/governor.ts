/**
 * Prompt-ablation ⇄ learning-governor glue (self-learning-frontier P-023 /
 * FB-09) — the D-004 unattended-refusal gate the `system:prompt-ablation`
 * action calls after its own flag check. Mirrors lib/negative-space/governor.ts
 * (the frontier-loop precedent), with one difference that matters: THIS loop
 * spends real LLM tokens (SUT + sim-user + judge per scenario arm), so its
 * per-cycle budget is a genuine spend bound, not just an arming bit — the
 * runner hard-caps the cycle at the governor's per-cycle budget and the action
 * ledgers the realized spend (`recordLearningSpend`, accumulate, the scout
 * pattern).
 *
 * Contract (FB-01's frontier-loop rule, enforcement 'governor'):
 *
 *   - The preflight is THE gate: governor flag OFF ⇒ 'governor-dark';
 *     unregistered / disabled / unbudgeted / exhausted ⇒ refuse; IO failure ⇒
 *     fail-CLOSED. The cycle runs unattended only past it.
 *   - First armed contact SELF-REGISTERS the loop with `budgetUsd` OMITTED —
 *     the row lands unbudgeted on the D-004 watch list while the preflight
 *     keeps refusing. Setting the per-cycle budget is the owner's P-001
 *     arming act; registration fires only on an 'unregistered' verdict, so an
 *     owner-set budget is never re-written.
 */
import type { GovernorVerdict } from '../learning-governor/core';
import { learningGovernorPreflight, type GovernorGlueDeps } from '../learning-governor/registrants';
import { registerLearningLoop } from '../learning-governor/store';

/** Governor registry identity — one ablation loop per workspace. */
export const PROMPT_ABLATION_LOOP_ID = 'prompt-ablation';

/** The registration row first armed contact (or the seed CLI) writes — budget deliberately OMITTED. */
export function promptAblationRegistrationInput(workspaceId: string): {
  workspaceId: string;
  loopId: string;
  displayName: string;
  budgetKind: 'per-cycle';
  enforcement: 'governor';
} {
  return {
    workspaceId,
    loopId: PROMPT_ABLATION_LOOP_ID,
    displayName: 'Prompt sedimentology (weekly shadow ablation)',
    budgetKind: 'per-cycle',
    enforcement: 'governor',
  };
}

/**
 * Preflight + first-contact self-registration. Returns the preflight verdict
 * unchanged (a tick that registered still refuses 'unregistered' this round;
 * the next reads 'unbudgeted' until the owner budgets it at P-001). On an
 * allow, `verdict.remainingUsd` IS the per-cycle cap the runner enforces.
 */
export async function promptAblationGovernorGate(
  workspaceId: string,
  deps?: GovernorGlueDeps,
): Promise<GovernorVerdict> {
  const verdict = await learningGovernorPreflight(
    { workspaceId, loopId: PROMPT_ABLATION_LOOP_ID },
    deps,
  );
  if (verdict.reason !== 'unregistered') return verdict;
  const register = deps?.register ?? registerLearningLoop;
  // Lazy like registrants.ts: the pool module must not load before the flag
  // check in a PG-free process (the verdict above already passed it).
  const getSql =
    deps?.getSql ?? (async () => (await import('@papercusp/db-org')).getOrgPg().sql);
  const log = deps?.log ?? ((m: string) => console.log(`[prompt-ablation] ${m}`));
  try {
    await register(await getSql(), promptAblationRegistrationInput(workspaceId));
    log(
      `self-registered loop ${PROMPT_ABLATION_LOOP_ID} UNBUDGETED on the learning governor ` +
        '(D-004 watch list) — refusing until the owner sets a per-cycle budget (P-001 arming act)',
    );
  } catch (e) {
    // Best-effort: the verdict already refuses; the next tick retries.
    log(`governor self-registration failed (next tick retries): ${e instanceof Error ? e.message : e}`);
  }
  return verdict;
}
