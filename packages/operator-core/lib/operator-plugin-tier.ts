/**
 * Plugin-aware tier resolution for the Operator (final v5 polish item).
 *
 * The substrate `lookupTier()` knows about substrate-defined caps. For
 * plugin-defined caps it returns `null`, and the Operator forces `high`
 * (fail-safe). With this module, plugins that declare their own
 * `tierMap` get consulted before the fail-safe kicks in.
 *
 * Safety constraint: a plugin's tierMap CANNOT downgrade a cap that the
 * substrate already classifies. If `tier-table.json` says
 * `secrets:read:* = high`, no plugin can override it to `medium`. The
 * substrate is authoritative for substrate caps.
 */

import { lookupTier as substrateLookup, type CapabilityTier } from '@papercusp/plugin-sdk';
import { getPluginHost } from './plugin-host-runtime';
import { heuristicTier } from './operator-cap-tier-heuristic';

const TIER_RANK: Record<CapabilityTier, number> = { low: 0, medium: 1, high: 2 };

let cache: { ts: number; map: Map<string, CapabilityTier> } | null = null;
const CACHE_TTL_MS = 30_000;

async function buildPluginTierMap(): Promise<Map<string, CapabilityTier>> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.map;
  const map = new Map<string, CapabilityTier>();
  try {
    const host = await getPluginHost();
    for (const lp of host.loaded) {
      const tierMap = lp.plugin.tierMap;
      if (!tierMap) continue;
      for (const [cap, tier] of Object.entries(tierMap)) {
        if (!tier) continue;
        // Plugin overrides only apply to plugin-defined caps. If the
        // substrate already knows this cap, skip — substrate wins.
        if (substrateLookup(cap) !== null) continue;
        // First-declared wins on collision (deterministic across loads).
        if (!map.has(cap)) map.set(cap, tier);
      }
    }
  } catch {
    /* host not available (test / cold start) — return empty map */
  }
  cache = { ts: Date.now(), map };
  return map;
}

/**
 * Tier resolution priority (Phase 5 polish):
 *   1. Substrate `tier-table.json` (authoritative for substrate caps)
 *   2. Plugin-declared `tierMap` (plugin manifest)
 *   3. Capability-string heuristic (`secrets:*` → high, `*:read` → low, …)
 *   4. null — caller (suggestion parser) applies fail-safe `high`
 *
 * Heuristic rationale: the live tool catalog has 84 unique capabilities
 * (most plugin-defined); without a heuristic, every plugin-cap suggestion
 * would force the operator to ask the user, which makes the auto-dispatch
 * UX useless on workspaces that lean on plugin tools. The heuristic
 * mirrors the catalog's naming conventions documented at
 * /docs/endpoint-system/tool-catalog.
 */
export async function resolvePluginAwareTier(capability: string): Promise<CapabilityTier | null> {
  const sub = substrateLookup(capability);
  if (sub !== null) return sub;
  const map = await buildPluginTierMap();
  const fromManifest = map.get(capability);
  if (fromManifest) return fromManifest;
  const fromHeuristic = heuristicTier(capability);
  return fromHeuristic ? fromHeuristic.tier : null;
}

/**
 * Sync version for the suggestion parser hot path. Same priority chain;
 * the plugin-tierMap lookup falls back to "cold cache → empty" since we
 * can't await the host. Heuristic always available (pure function).
 */
export function resolvePluginAwareTierSync(capability: string): CapabilityTier | null {
  const sub = substrateLookup(capability);
  if (sub !== null) return sub;
  const fromManifest = cache?.map.get(capability);
  if (fromManifest) return fromManifest;
  const fromHeuristic = heuristicTier(capability);
  return fromHeuristic ? fromHeuristic.tier : null;
}

export function _resetPluginTierCacheForTests(): void {
  cache = null;
}

export function _maxTier(a: CapabilityTier, b: CapabilityTier): CapabilityTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}
