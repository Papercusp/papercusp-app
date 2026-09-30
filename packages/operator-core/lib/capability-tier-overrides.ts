/**
 * Runtime capability→tier overrides (live-configurability-audit-2026-06-20 P-010).
 *
 * The baked capability→tier table (agent-mcp/capability-tiers-papercusp.ts EXACT) classifies every
 * capability low|medium|high. Mis-tierings have historically been fixable only by editing the table +
 * deploying (EI-99: activity:recent mis-tiered medium→low; EI-111: activity:report → low). This dial
 * (capability_tier:set) makes the classification runtime-settable: a per-capability override map read
 * through a D-010 module SYNC cache GATED by the DARK papercusp-auth-config-overrides flag (the §G
 * auth-config umbrella — owner ratifies by flipping it), installed into papercuspTierFor's override
 * seam so it is consulted BEFORE the baked table. OFF (default) ⇒ cache empty ⇒ papercuspTierFor uses
 * its baked table ⇒ byte-identical.
 *
 * SCOPE (the honest boundary, surfaced on the tool + the migration): the override is LIVE for every
 * consumer that calls papercuspTierFor/tierFor at RUNTIME — the capability catalog/palette projection
 * and the decision-ledger posture. Consumers that read a tool's LOAD-TIME-STAMPED `tier` (the
 * endpoint-auth-tiers exposure gate + the watchdog per-tool timeout) re-stamp on the next operator
 * BOOT, so a re-tier reaches THEM after a restart, not live. Widening to live consumer-side
 * re-resolution on those AUTH-ADJACENT gates is a deliberate owner decision (plan D-010 cluster), NOT
 * done autonomously — hence this dial ships the runtime-caller override dark, with the scope documented.
 *
 * The import is PURE (no import-time IO); the getter is a plain cache read. Refresh on
 * onFlagChange(null | the flag), local write, and a ~60s unref timer.
 */
import { getFlag } from '@papercusp/flags/server';
import { lazyFlagRefresh } from './lazy-flag-refresh';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { FLAGS } from '@papercusp/flags';
import { setCapabilityTierOverride, type CapabilityTier } from '@papercusp/agent-mcp';
import { systemDistinctId } from './flag-distinct-id';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

const STATE_TABLE = 'operator_capability_tiers' as const;
const TIERS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
const isTier = (v: unknown): v is CapabilityTier => typeof v === 'string' && TIERS.has(v);

export interface CapabilityTierOverrides {
  /** Per-capability tier override map, consulted before the baked EXACT table. */
  tiers?: Record<string, CapabilityTier>;
}

/** Drop any non-tier values — defends the hot path against a malformed stored row. */
function sanitize(tiers: Record<string, unknown> | undefined): Record<string, CapabilityTier> {
  const out: Record<string, CapabilityTier> = {};
  for (const [cap, t] of Object.entries(tiers ?? {})) {
    if (cap && isTier(t)) out[cap] = t;
  }
  return out;
}

// ── D-010 sync cache ──────────────────────────────────────────────────────────
let enabled = false;
let cached: Record<string, CapabilityTier> = {};

/** The tier override for a capability, or null (fall through to the baked table). SYNC, zero-await. */
export function capabilityTierOverrideFor(capability: string): CapabilityTier | null {
  armFlagRefresh(); // first use installs the flag subscription — see ./lazy-flag-refresh
  if (!enabled) return null;
  return cached[capability] ?? null;
}
// Install the seam into agent-mcp's papercuspTierFor (consulted before the baked EXACT table).
setCapabilityTierOverride((cap) => capabilityTierOverrideFor(cap));

export async function refreshCapabilityTierOverrides(): Promise<void> {
  try {
    enabled = await getFlag(FLAGS.AUTH_CONFIG_OVERRIDES, systemDistinctId());
    const row = enabled ? (await readOperatorState<CapabilityTierOverrides>(STATE_TABLE)) ?? {} : {};
    cached = sanitize(row.tiers);
  } catch {
    enabled = false;
    cached = {};
  }
}
// Armed on FIRST USE, not at import (EI-19416650993725684) — the import touches no flag binding, so
// a test that partially mocks `@papercusp/flags/server` can still collect. The one reader above is
// also what the `setCapabilityTierOverride` seam delegates to, so installing the seam at module
// scope does NOT bypass arming. See ./lazy-flag-refresh for the mechanism + guards.
const armFlagRefresh = lazyFlagRefresh(refreshCapabilityTierOverrides, {
  keys: [FLAGS.AUTH_CONFIG_OVERRIDES],
  unpopulated: {
    kind: 'gates-an-override-store',
    serves:
      'the empty auth-config override set ⇒ every surface uses its baked literal (byte-identical). ' +
      'The flag is DEFAULT OFF (dark, owner-authority: it can WIDEN the all-gates bypass set), so ' +
      'the pre-refresh value IS the production value and the window opens nothing up.',
  },
});
// P-008: visible in schedule:inventory as a 'cache' timer (per-process config memo refresh).
managedSetInterval('config-refresh:capability-tier', 60_000, () => refreshCapabilityTierOverrides(), {
  category: 'cache',
});

// ── async read/write (the tool) ───────────────────────────────────────────────
export async function readCapabilityTierOverrides(): Promise<CapabilityTierOverrides> {
  return (await readOperatorState<CapabilityTierOverrides>(STATE_TABLE)) ?? {};
}

async function persist(next: CapabilityTierOverrides): Promise<CapabilityTierOverrides> {
  await writeOperatorState<CapabilityTierOverrides>(STATE_TABLE, next);
  await refreshCapabilityTierOverrides(); // same-process immediacy
  return next;
}

/** Set (or clear, when tier=null) the tier override for one capability. */
export async function setCapabilityTier(capability: string, tier: CapabilityTier | null): Promise<CapabilityTierOverrides> {
  const cur = await readCapabilityTierOverrides();
  const tiers = { ...(cur.tiers ?? {}) };
  if (tier === null) delete tiers[capability];
  else {
    if (!isTier(tier)) throw new Error('tier must be low | medium | high');
    tiers[capability] = tier;
  }
  return persist({ ...cur, tiers });
}

export async function setCapabilityTierOverrides(o: CapabilityTierOverrides): Promise<void> {
  await persist(o ?? {});
}
export async function resetCapabilityTierOverrides(): Promise<void> {
  await persist({});
}

// ── config:list-overrides / config:reset-overrides registration (D-005) ───────
registerOverrideConcern({
  name: 'capability-tier-overrides',
  description:
    'runtime capability→tier overrides (capability_tier:set), consulted before the baked EXACT table by papercuspTierFor. DARK: papercusp-auth-config-overrides',
  auditAction: 'capability_tier:set',
  diff: async () => {
    const o = await readCapabilityTierOverrides();
    return Object.entries(o.tiers ?? {}).map(
      ([cap, tier]): OverrideEntry => ({ key: `tier.${cap}`, effective: tier, default: 'EXACT baked', layer: 'pg-settings' }),
    );
  },
  capture: () => readCapabilityTierOverrides(),
  reset: () => resetCapabilityTierOverrides(),
  restore: (snap) => setCapabilityTierOverrides((snap as CapabilityTierOverrides) ?? {}),
});
