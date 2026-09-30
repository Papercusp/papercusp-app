/**
 * Account scale-out trigger policy (live-configurability-audit-2026-06-20 P-006).
 *
 * `ScalePolicy` (windowMs / sustainedPenaltyThreshold) decides when an account is "sustainedly
 * limited" — the verdict that gates the PAID auto-scale-out. The pure core (account-pool.ts) already
 * accepts it as a `policy` param, but the host call sites always passed DEFAULT_SCALE_POLICY. This is
 * the store: the host (account-pool-store.ts) now reads `readScalePolicy()` at the trigger + decision
 * + read-model sites.
 *
 * Empty store ⇒ DEFAULT_SCALE_POLICY (re-probe-aligned 60min / 3) ⇒ safe-by-default for slow account probes.
 * Spend note: this only tunes WHEN scale-out fires; the provisioning itself stays owner-gated
 * (accounts:scale_out). Registers as a runtime-config override concern.
 *
 * FOLLOW-UP: EXHAUSTED_UTIL (1.0) / DRAIN_FULL_UTIL (0.97) are separate structural drain consts with
 * wide call-site fan-out — not part of ScalePolicy; making them settable is a larger follow-up.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';
import { DEFAULT_SCALE_POLICY, MIN_SCALE_POLICY_WINDOW_MS, type ScalePolicy } from './deployment/account-pool';

/** Keep persisted overrides aligned with the slow account re-probe cadence. */
export function normalizeScalePolicy(policy: Partial<ScalePolicy>): ScalePolicy {
  const requestedWindowMs = policy.windowMs;
  const windowMs =
    typeof requestedWindowMs === 'number' && Number.isFinite(requestedWindowMs)
      ? Math.max(MIN_SCALE_POLICY_WINDOW_MS, requestedWindowMs)
      : DEFAULT_SCALE_POLICY.windowMs;
  return { ...DEFAULT_SCALE_POLICY, ...policy, windowMs };
}

/** Effective policy = stored override merged over the baked DEFAULT_SCALE_POLICY.
 *  Truly safe-by-default: a store READ FAILURE (no DB / transient) ⇒ DEFAULT, never a
 *  throw. The account-scale observer calls this inside its exhaustion-emit + scale-out
 *  path; a policy read that threw would silently skip exhaustion handling entirely
 *  (and broke account-pool-store.test.ts's hermetic observer test). "Empty store ⇒
 *  DEFAULT" now extends to "unreadable store ⇒ DEFAULT". */
export async function readScalePolicy(): Promise<ScalePolicy> {
  try {
    const stored = await readOperatorState<Partial<ScalePolicy>>('operator_scale_policy');
    return normalizeScalePolicy(stored ?? {});
  } catch {
    return DEFAULT_SCALE_POLICY;
  }
}

/** Merge a patch over the current policy + persist; returns the new effective policy. */
export async function writeScalePolicy(patch: Partial<ScalePolicy>): Promise<ScalePolicy> {
  const next = normalizeScalePolicy({ ...(await readScalePolicy()), ...patch });
  await writeOperatorState<ScalePolicy>('operator_scale_policy', next);
  return next;
}

/** Reset to baked defaults (clears the override). */
export async function resetScalePolicy(): Promise<ScalePolicy> {
  await writeOperatorState<ScalePolicy>('operator_scale_policy', DEFAULT_SCALE_POLICY);
  return DEFAULT_SCALE_POLICY;
}

registerOverrideConcern({
  name: 'scale-policy',
  description: 'account scale-out trigger policy (windowMs / sustainedPenaltyThreshold)',
  auditAction: 'accounts:scale_policy',
  diff: async () => {
    const pol = await readScalePolicy();
    const entries: OverrideEntry[] = [];
    for (const k of Object.keys(DEFAULT_SCALE_POLICY) as (keyof ScalePolicy)[]) {
      if (pol[k] !== DEFAULT_SCALE_POLICY[k]) {
        entries.push({ key: k, effective: pol[k], default: DEFAULT_SCALE_POLICY[k], layer: 'pg-settings' });
      }
    }
    return entries;
  },
  capture: () => readScalePolicy(),
  reset: () => resetScalePolicy(),
  restore: (snap) => writeScalePolicy(snap as ScalePolicy).then(() => {}),
});
