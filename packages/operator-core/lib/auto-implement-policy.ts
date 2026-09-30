/**
 * Auto-implement risk policy + dispatch limits (live-configurability-audit-2026-06-20 P-011).
 *
 * The auto-implement lane's risk policy (RiskTierPolicy: autoKinds + protected path/keyword TCB) is a
 * `DEFAULT_RISK_TIER_POLICY` literal, and its dispatch limits (maxPerRun/maxAttempts) were env
 * value-gates — none settable live. CLAUDE.md frames Phase-4 graduation (widening autoKinds) as "a
 * CONFIG change, not a code change", yet there was no config surface. This is that store; the
 * auto-implement routine (improvement-actions.ts) now reads `readAutoImplementPolicy()` and threads
 * it into planImplementRun (which already accepts a `policy`).
 *
 * D-002 SAFETY BOUNDARY: the protected path/keyword patterns are a TCB floor — this store may only
 * ADD to them (tighten), never remove the baked set. So the stored shape carries `*Additions`, unioned
 * over DEFAULT_RISK_TIER_POLICY. autoKinds (the graduation dial) is replaceable but operator-gated +
 * audited + inert until FLAGS.IMPROVEMENT_AUTO_IMPLEMENT is armed; the release-manager at deploy
 * (D-005) remains the real guarantee on any actual change.
 *
 * Empty store ⇒ DEFAULT_RISK_TIER_POLICY + env/default limits ⇒ byte-identical. Registers an override
 * concern (config:list-overrides / reset-overrides).
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';
import { DEFAULT_RISK_TIER_POLICY, type RiskTierPolicy, type WorkItemKind } from './harness/improvements/policy';

/** The raw stored override shape. Protections are ADD-only (D-002) → `*Additions`. */
export interface StoredAutoImplementPolicy {
  autoKinds?: WorkItemKind[];
  protectedPathAdditions?: string[];
  protectedKeywordAdditions?: string[];
  maxPerRun?: number;
  maxAttempts?: number;
}

/** The resolved policy the dispatch routine consumes. */
export interface EffectiveAutoImplementPolicy {
  riskTier: RiskTierPolicy;
  /** undefined ⇒ the routine falls back to its env/default. */
  maxPerRun?: number;
  maxAttempts?: number;
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

export async function readStoredAutoImplementPolicy(): Promise<StoredAutoImplementPolicy> {
  return (await readOperatorState<StoredAutoImplementPolicy>('operator_auto_implement_policy')) ?? {};
}

/** Effective policy = stored merged over DEFAULT_RISK_TIER_POLICY; protections are UNIONED (tighten-only). */
export async function readAutoImplementPolicy(): Promise<EffectiveAutoImplementPolicy> {
  const s = await readStoredAutoImplementPolicy();
  return {
    riskTier: {
      autoKinds: s.autoKinds ?? DEFAULT_RISK_TIER_POLICY.autoKinds,
      protectedPathPatterns: dedupe([...DEFAULT_RISK_TIER_POLICY.protectedPathPatterns, ...(s.protectedPathAdditions ?? [])]),
      protectedKeywords: dedupe([...DEFAULT_RISK_TIER_POLICY.protectedKeywords, ...(s.protectedKeywordAdditions ?? [])]),
    },
    maxPerRun: s.maxPerRun,
    maxAttempts: s.maxAttempts,
  };
}

/**
 * Apply a patch. Protections are APPEND-only (D-002 tighten): `addProtectedPaths` / `addProtectedKeywords`
 * union into the stored additions; there is deliberately no "remove a baked protection" path. autoKinds
 * replaces; maxPerRun/maxAttempts set. Returns the new stored shape.
 */
export async function writeAutoImplementPolicy(patch: {
  autoKinds?: WorkItemKind[];
  addProtectedPaths?: string[];
  addProtectedKeywords?: string[];
  maxPerRun?: number;
  maxAttempts?: number;
}): Promise<StoredAutoImplementPolicy> {
  const cur = await readStoredAutoImplementPolicy();
  const next: StoredAutoImplementPolicy = { ...cur };
  if (patch.autoKinds !== undefined) next.autoKinds = patch.autoKinds;
  if (patch.addProtectedPaths?.length) next.protectedPathAdditions = dedupe([...(cur.protectedPathAdditions ?? []), ...patch.addProtectedPaths]);
  if (patch.addProtectedKeywords?.length) next.protectedKeywordAdditions = dedupe([...(cur.protectedKeywordAdditions ?? []), ...patch.addProtectedKeywords]);
  if (patch.maxPerRun !== undefined) next.maxPerRun = patch.maxPerRun;
  if (patch.maxAttempts !== undefined) next.maxAttempts = patch.maxAttempts;
  await writeOperatorState<StoredAutoImplementPolicy>('operator_auto_implement_policy', next);
  return next;
}

/** Write a full stored shape (used by the tool's control-harness revert path). */
export async function setStoredAutoImplementPolicy(s: StoredAutoImplementPolicy): Promise<void> {
  await writeOperatorState<StoredAutoImplementPolicy>('operator_auto_implement_policy', s);
}

/** Reset to baked defaults (clears all overrides + additions). */
export async function resetAutoImplementPolicy(): Promise<void> {
  await setStoredAutoImplementPolicy({});
}

registerOverrideConcern({
  name: 'auto-implement-policy',
  description: 'auto-implement risk policy (autoKinds graduation, protected-path/keyword ADDITIONS, maxPerRun, maxAttempts)',
  auditAction: 'improvements:set-auto-policy',
  diff: async () => {
    const s = await readStoredAutoImplementPolicy();
    const entries: OverrideEntry[] = [];
    if (s.autoKinds !== undefined && s.autoKinds.join(',') !== DEFAULT_RISK_TIER_POLICY.autoKinds.join(',')) {
      entries.push({ key: 'autoKinds', effective: s.autoKinds, default: DEFAULT_RISK_TIER_POLICY.autoKinds, layer: 'pg-settings' });
    }
    if (s.protectedPathAdditions?.length) {
      entries.push({ key: 'protectedPathAdditions', effective: s.protectedPathAdditions, default: [], layer: 'pg-settings' });
    }
    if (s.protectedKeywordAdditions?.length) {
      entries.push({ key: 'protectedKeywordAdditions', effective: s.protectedKeywordAdditions, default: [], layer: 'pg-settings' });
    }
    if (s.maxPerRun !== undefined) entries.push({ key: 'maxPerRun', effective: s.maxPerRun, default: 'env/default', layer: 'pg-settings' });
    if (s.maxAttempts !== undefined) entries.push({ key: 'maxAttempts', effective: s.maxAttempts, default: 'env/default', layer: 'pg-settings' });
    return entries;
  },
  capture: () => readStoredAutoImplementPolicy(),
  reset: () => resetAutoImplementPolicy(),
  restore: (snap) => writeOperatorState<StoredAutoImplementPolicy>('operator_auto_implement_policy', (snap as StoredAutoImplementPolicy) ?? {}).then(() => {}),
});
