/**
 * Fleet opus-budget policy (live-configurability-audit-2026-06-20 P-005).
 *
 * The opus-budget governor's shed bands (reserveStart/reserveHard/nearCap/staleMs) are a
 * `DEFAULT_OPUS_BUDGET_POLICY` literal that the pure governor functions ALREADY accept as a `policy`
 * param — but the two live call sites (evaluateOpusBudgetForSpawn, summarizeOpusBudget) never
 * populated it, so the bands were un-tunable. This module is the store: those call sites now read
 * `readOpusBudgetPolicy()`, and fleet:opus_budget writes it.
 *
 * Empty store ⇒ DEFAULT_OPUS_BUDGET_POLICY ⇒ byte-identical behavior, so this is safe-by-default.
 * Registers as a runtime-config override concern (config:list-overrides / reset-overrides).
 *
 * NOTE: the criticality role lists (CRITICAL_ROLES / BACKGROUND_ROLES) stay code consts for now —
 * making them settable is a separate spawn-path change (classifyRoleCriticality), tracked as a
 * follow-up. This concern governs the numeric SHED BANDS (the incident lever).
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';
import { DEFAULT_OPUS_BUDGET_POLICY, type OpusBudgetPolicy } from './opus-budget-governor';

/** Effective policy = stored override merged over the baked DEFAULT_OPUS_BUDGET_POLICY. */
export async function readOpusBudgetPolicy(): Promise<OpusBudgetPolicy> {
  const stored = await readOperatorState<Partial<OpusBudgetPolicy>>('operator_opus_budget_policy');
  return { ...DEFAULT_OPUS_BUDGET_POLICY, ...(stored ?? {}) };
}

/** Merge a patch over the current policy + persist; returns the new effective policy. */
export async function writeOpusBudgetPolicy(patch: Partial<OpusBudgetPolicy>): Promise<OpusBudgetPolicy> {
  const next = { ...(await readOpusBudgetPolicy()), ...patch };
  await writeOperatorState<OpusBudgetPolicy>('operator_opus_budget_policy', next);
  return next;
}

/** Reset to baked defaults (clears the override). */
export async function resetOpusBudgetPolicy(): Promise<OpusBudgetPolicy> {
  await writeOperatorState<OpusBudgetPolicy>('operator_opus_budget_policy', DEFAULT_OPUS_BUDGET_POLICY);
  return DEFAULT_OPUS_BUDGET_POLICY;
}

registerOverrideConcern({
  name: 'opus-budget-policy',
  description: 'fleet opus-budget shed bands (reserveStart/reserveHard/nearCap/staleMs)',
  auditAction: 'fleet:opus_budget',
  diff: async () => {
    const pol = await readOpusBudgetPolicy();
    const entries: OverrideEntry[] = [];
    for (const k of Object.keys(DEFAULT_OPUS_BUDGET_POLICY) as (keyof OpusBudgetPolicy)[]) {
      if (pol[k] !== DEFAULT_OPUS_BUDGET_POLICY[k]) {
        entries.push({ key: k, effective: pol[k], default: DEFAULT_OPUS_BUDGET_POLICY[k], layer: 'pg-settings' });
      }
    }
    return entries;
  },
  capture: () => readOpusBudgetPolicy(),
  reset: () => resetOpusBudgetPolicy(),
  restore: (snap) => writeOpusBudgetPolicy(snap as OpusBudgetPolicy).then(() => {}),
});
