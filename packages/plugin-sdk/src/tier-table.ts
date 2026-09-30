import tierTable from './tier-table.json';

export type CapabilityTier = 'low' | 'medium' | 'high';

const TABLE: Readonly<Record<string, CapabilityTier>> = tierTable as Readonly<
  Record<string, CapabilityTier>
>;

/**
 * Resolve a capability string to its substrate-known tier.
 *
 * Lookup order:
 *   1. Exact match in the substrate tier table.
 *   2. Wildcard match (entry ends in `:*` and prefix matches).
 *   3. `null` — caller decides what to do (operator pipeline forces `high`).
 *
 * Plugin-defined capabilities that aren't in the substrate table return
 * `null` here. The operator pipeline treats `null` as `high` (fail-safe).
 * Plugin-tier resolution (walking plugin manifests for declared tiers)
 * is v1.5 work; until then, plugin caps always ask.
 */
export function lookupTier(capability: string): CapabilityTier | null {
  const exact = TABLE[capability];
  if (exact) return exact;
  const segs = capability.split(':');
  // Prefer the most-specific (most-segments) wildcard match.
  let best: { tier: CapabilityTier; specificity: number } | null = null;
  for (const [key, tier] of Object.entries(TABLE)) {
    if (!key.includes('*')) continue;
    const keySegs = key.split(':');
    if (keySegs.length !== segs.length) continue;
    let matches = true;
    let concrete = 0;
    for (let i = 0; i < keySegs.length; i++) {
      if (keySegs[i] === '*') continue;
      if (keySegs[i] !== segs[i]) {
        matches = false;
        break;
      }
      concrete++;
    }
    if (!matches) continue;
    if (!best || concrete > best.specificity) best = { tier, specificity: concrete };
  }
  return best?.tier ?? null;
}

export const TIER_TABLE: Readonly<Record<string, CapabilityTier>> = TABLE;
