/**
 * Runtime per-(tool,role) quota overrides (live-configurability-audit-2026-06-20 P-018).
 *
 * Each tool bakes a `rolesQuota[role]` cap ({ perChunk?, perRun?, perDay? }) read SYNC on the dispatch
 * hot path by `papercuspComputeQuotaWindow` (agent-mcp/quota-policy.ts) to resolve a call's window +
 * ceiling. Those caps were tunable only by editing the literal + deploying — so a tool throttling a
 * role mid-incident (or one that wants a temporary raise for a planned burst) forced a redeploy.
 *
 * This module is the runtime OVERRIDE: a per-workspace operator-state row keyed `"<toolName>|<role>"`,
 * MERGED OVER the baked `rolesQuota[role]` at the projected-tool-deps `computeQuotaWindow` wrapper
 * (which now receives the toolName via the extended tooldef seam). Read through a D-010-style module
 * SYNC cache (zero-await on the hot path), refreshed on (a) the flag-reload signal (onFlagChange(null),
 * subscribed on FIRST USE — see ensureFlagSubscriptionArmed), (b) local write (same-process immediate),
 * and (c) a ~60s .unref()'d timer for bounded cross-process + restart freshness. The import touches NO
 * flag binding and does no IO, so importing it on the hot path is free — and, per EI-19416650993725684,
 * so that a test which partially mocks `@papercusp/flags/server` can still collect.
 *
 * NOT flag-gated: a quota cap rate-limits call COUNT within a window — it never widens WHICH tools a
 * role may call, so it is operational tuning, not an auth/escalation surface (contrast P-009/P-010).
 * An EMPTY override map (the default) ⇒ the baked rolesQuota applies ⇒ byte-identical. The override
 * only bites once an operator sets a value. Lowering a cap below the baked value is honoured (tighten),
 * raising it is honoured (loosen the throttle) — both are call-rate policy, not capability grants.
 */
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { lazyFlagRefresh } from './lazy-flag-refresh';
import type { RolesQuota } from '@papercusp/tooldef';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

const STATE_TABLE = 'operator_quota_overrides' as const;

/** A per-(tool,role) quota override — a partial RolesQuota merged over the baked one. */
export type QuotaOverride = Pick<RolesQuota, 'perChunk' | 'perRun' | 'perDay'>;

/** The operator_quota_overrides payload: a map keyed `"<toolName>|<role>"`. */
export interface QuotaOverrides {
  overrides?: Record<string, QuotaOverride>;
}

export const quotaOverrideKey = (toolName: string, role: string): string => `${toolName}|${role}`;

const finiteNonNeg = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** Keep only the finite ≥ 0 numeric fields — defends the hot path against a malformed stored row. */
function sanitize(q: QuotaOverride | undefined): QuotaOverride | undefined {
  if (!q) return undefined;
  const out: QuotaOverride = {};
  if (finiteNonNeg(q.perChunk)) out.perChunk = q.perChunk;
  if (finiteNonNeg(q.perRun)) out.perRun = q.perRun;
  if (finiteNonNeg(q.perDay)) out.perDay = q.perDay;
  return Object.keys(out).length ? out : undefined;
}

// ── D-010 sync cache ──────────────────────────────────────────────────────────
let cached: Record<string, QuotaOverride> = {};

/** The per-(tool,role) override for the dispatch step, or undefined. SYNC, zero-await. */
export function quotaOverrideFor(toolName: string, role: string | undefined): QuotaOverride | undefined {
  armFlagRefresh(); // first use installs the flag-reload subscription — see ./lazy-flag-refresh
  if (!role) return undefined;
  return cached[quotaOverrideKey(toolName, role)];
}

/**
 * MERGE the runtime override over a tool's baked rolesQuota[role] — the function the
 * projected-tool-deps computeQuotaWindow wrapper calls before the engine resolves the window/ceiling.
 * Override fields WIN over the baked cap; absent fields keep the baked value. SYNC.
 */
export function mergeRoleQuota(
  roleQuota: RolesQuota | undefined,
  toolName: string,
  role: string | undefined,
): RolesQuota | undefined {
  const override = quotaOverrideFor(toolName, role);
  if (!override) return roleQuota;
  return { ...(roleQuota ?? {}), ...override };
}

export async function refreshQuotaOverrides(): Promise<void> {
  try {
    const row = (await readOperatorState<QuotaOverrides>(STATE_TABLE)) ?? {};
    const next: Record<string, QuotaOverride> = {};
    for (const [k, v] of Object.entries(row.overrides ?? {})) {
      const clean = sanitize(v);
      if (clean) next[k] = clean;
    }
    cached = next;
  } catch {
    cached = {};
  }
}
/**
 * Refresh-on-flag-reload, armed on FIRST USE rather than at import (EI-19416650993725684) — the
 * `key === null` bus reload is used purely as a "refresh now" signal here, since this feature is NOT
 * gated by any flag (hence no keys). The import touches no flag binding, which is what keeps this
 * module collectable under a partial `@papercusp/flags/server` mock; see ./lazy-flag-refresh for the
 * mechanism, the measured dead-ends, and the two guards that hold it in place.
 */
const armFlagRefresh = lazyFlagRefresh(refreshQuotaOverrides, {
  unpopulated: {
    kind: 'not-flag-gated',
    serves:
      'the empty override map ⇒ every quota read falls through to its baked literal. No flag ' +
      'gates this cache at all; the key === null bus reload is used purely as a "refresh now" signal.',
  },
});
// Bounded cross-process + restart freshness. .unref() so it never holds the process (or a test) open.
// P-008: visible in schedule:inventory as a 'cache' timer (per-process config memo refresh).
managedSetInterval('config-refresh:quota', 60_000, () => refreshQuotaOverrides(), {
  category: 'cache',
});

// ── async read/write (the tool) ───────────────────────────────────────────────
export async function readQuotaOverrides(): Promise<QuotaOverrides> {
  return (await readOperatorState<QuotaOverrides>(STATE_TABLE)) ?? {};
}

async function persist(next: QuotaOverrides): Promise<QuotaOverrides> {
  await writeOperatorState<QuotaOverrides>(STATE_TABLE, next);
  await refreshQuotaOverrides(); // same-process immediacy
  return next;
}

/** Set (or clear, when quota=null) the per-(tool,role) quota override. */
export async function setToolQuotaOverride(
  toolName: string,
  role: string,
  quota: QuotaOverride | null,
): Promise<QuotaOverrides> {
  const cur = await readQuotaOverrides();
  const overrides = { ...(cur.overrides ?? {}) };
  const key = quotaOverrideKey(toolName, role);
  if (quota === null) delete overrides[key];
  else {
    const clean = sanitize(quota);
    if (!clean) throw new Error('quota override must set at least one finite ≥ 0 field (perChunk/perRun/perDay)');
    overrides[key] = clean;
  }
  return persist({ ...cur, overrides });
}

export async function setQuotaOverrides(o: QuotaOverrides): Promise<void> {
  await persist(o ?? {});
}
export async function resetQuotaOverrides(): Promise<void> {
  await persist({});
}

// ── config:list-overrides / config:reset-overrides registration (D-005) ───────
registerOverrideConcern({
  name: 'tool-quota-overrides',
  description:
    'runtime per-(tool,role) quota overrides (quota:set_tool), merged over each tool\'s baked rolesQuota at the dispatch quota step',
  auditAction: 'quota:set_tool',
  diff: async () => {
    const o = await readQuotaOverrides();
    return Object.entries(o.overrides ?? {}).map(
      ([key, v]): OverrideEntry => ({ key, effective: v, default: 'rolesQuota baked', layer: 'pg-settings' }),
    );
  },
  capture: () => readQuotaOverrides(),
  reset: () => resetQuotaOverrides(),
  restore: (snap) => setQuotaOverrides((snap as QuotaOverrides) ?? {}),
});
