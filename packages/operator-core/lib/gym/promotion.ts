/**
 * Immediate, autonomous promotion (P-020, D-012).
 *
 * Writes the champion's overlay into the DEDICATED gym harness's promptOverrides via
 * setPromptOverride — and clears any role the prior champion set that the new overlay
 * omits, so the harness's overrides become EXACTLY the champion's overlay (a clean
 * replace, and the baseline overlay clears everything → back to repo defaults). NEVER
 * the shared default prompt files (that would race the live fleet). Effects injected;
 * the wiring binds these to setPromptOverride/clearPromptOverride against the gym PG.
 */
import type { VariantOverlay } from './variant-overlay';

export interface PromotionDeps {
  listExistingOverrideRoles(harnessSlug: string): Promise<string[]>;
  setOverride(harnessSlug: string, role: string, promptMd: string): Promise<void>;
  clearOverride(harnessSlug: string, role: string): Promise<void>;
  /** Behavior-change-ledger hook (self-learning-frontier P-004 / D-003) — bind
   *  `gymPromotionRecorder(...)` from lib/change-ledger so autonomous
   *  promotions ledger every set/clear. Optional: promotion never fails on it. */
  recordChange?(entry: { role: string; action: 'set' | 'clear' }): Promise<void>;
}

export async function promoteChampion(
  harnessSlug: string,
  overlay: VariantOverlay,
  deps: PromotionDeps,
): Promise<{ rolesSet: string[]; rolesCleared: string[] }> {
  const target = Object.keys(overlay.promptOverrides).sort();
  const existing = await deps.listExistingOverrideRoles(harnessSlug);
  const targetSet = new Set(target);

  for (const role of target) {
    await deps.setOverride(harnessSlug, role, overlay.promptOverrides[role]);
    await deps.recordChange?.({ role, action: 'set' });
  }
  const rolesCleared: string[] = [];
  for (const role of existing.slice().sort()) {
    if (!targetSet.has(role)) {
      await deps.clearOverride(harnessSlug, role);
      await deps.recordChange?.({ role, action: 'clear' });
      rolesCleared.push(role);
    }
  }
  return { rolesSet: target, rolesCleared };
}
