/**
 * Pot control policy (live-configurability-audit-2026-06-20 P-015).
 *
 * The placement-watchdog thresholds (breakerThreshold / recoveryDebounceMs / dormancyGraceMs /
 * infraBreakerThreshold) were PAPERCUSP_HIVE_PLACEMENT_* env gates read synchronously by
 * placementConfig() (consumed by the watchdog sweep, the sync-resolver UI read, and supervision
 * metrics — not all async). This store holds the runtime OVERRIDE; placementConfig() overlays a
 * SYNC-cached read of it over the env defaults, so every consumer sees the override without each
 * becoming async. Empty store ⇒ env/baked defaults ⇒ byte-identical.
 *
 * The cache is refreshed on first use + reload signals + a periodic timer + every write (same-process
 * immediate). The import stays pure: no DB read starts until a sync reader arms the lazy refresh.
 * Cross-process freshness is bounded by the periodic timer. Registers a runtime-config override
 * concern.
 *
 * NOTE (D-005): placement AFFINITY weights are homed in pot:set-steering, NOT here — this carries only
 * the watchdog/liveness/health thresholds. (Work-distribution + system-health alarm thresholds can be
 * added to this same row incrementally — JSONB, no further migration.)
 *
 * NOTE (cup-lexicon-full-rename-2026-07-09 E6): only the TS-level identifiers below were renamed
 * Hive→Pot; the backing DB table/state-key (`operator_hive_control_policy`, migration
 * 350-operator-hive-control-policy.sql) is real schema and stays as-is — that rename is P-009
 * (DB rename), scoped separately and intentionally LAST in this plan.
 */
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';
import { lazyFlagRefresh } from './lazy-flag-refresh';
import type { WorkScopePolicy } from './work-scope-policy';

export interface PotControlPolicy {
  breakerThreshold?: number;
  recoveryDebounceMs?: number;
  dormancyGraceMs?: number;
  infraBreakerThreshold?: number;
  /**
   * Workspace WORK-SCOPE policy (workspace-work-scope-policy-2026-09-04): which
   * harnesses agents may be launched into / pull work from. Read sync via
   * `workScopePolicy()` in ./work-scope-policy; absent ⇒ every harness allowed.
   * Rides this same JSONB row so it needs no migration and shares the cache/refresh.
   */
  workScope?: WorkScopePolicy;
}

/** The consumers' baked defaults — for diff/display + the tool's "default" reporting. */
export const POT_CONTROL_DEFAULTS = {
  breakerThreshold: 3,
  recoveryDebounceMs: 5 * 60_000,
  dormancyGraceMs: 10 * 60_000,
  infraBreakerThreshold: 12,
} as const;

// Sync cache so placementConfig() (sync, hot-ish per-sweep) can overlay the override without awaiting.
let cached: PotControlPolicy = {};

// The policy is written through a control-plane tool and read by every operator
// process. The writer updates its own cache synchronously, but the other
// processes need the existing sync_invalidate bus to learn about the change
// before the 60s safety refresh. Keep this subscription lazy so importing this
// low-level config module stays side-effect free until a reader actually needs
// the cache.
let workScopeInvalidationSubscription: Promise<void> | null = null;

function armWorkScopeInvalidationSubscription(): void {
  if (workScopeInvalidationSubscription) return;
  workScopeInvalidationSubscription = import('./sync-sse')
    .then(async ({ subscribe }) => {
      await subscribe(
        () => {
          void refreshPotControlPolicy();
        },
        { filter: (event) => event.name === 'workScope.policy' },
      );
    })
    .catch(() => {
      // The timer remains the bounded fallback if the LISTEN bus is not ready.
      workScopeInvalidationSubscription = null;
    });
}

/** The current override (sync) — overlaid by placementConfig() over its env defaults. */
export function placementOverride(): PotControlPolicy {
  armPotControlPolicyRefresh();
  armWorkScopeInvalidationSubscription();
  return cached;
}

export async function refreshPotControlPolicy(): Promise<void> {
  try {
    cached = (await readOperatorState<PotControlPolicy>('operator_pot_control_policy')) ?? {};
  } catch {
    /* keep the last value (empty at boot ⇒ env defaults) — never throw on the config path */
  }
}

// The policy is not flag-gated, but it still needs the same import-safe lazy boot/reload wiring as
// the flag-backed config caches. Omitting `keys` means the shared flag-bus reload signal (key=null)
// refreshes this store without making any individual flag a dependency of the policy.
const armPotControlPolicyRefresh = lazyFlagRefresh(refreshPotControlPolicy, {
  unpopulated: {
    kind: 'not-flag-gated',
    serves:
      'the empty policy override, so placementConfig() continues to use its baked/env defaults until the first async refresh completes',
  },
});

// Bounded cross-process freshness. The managed registry keeps this timer visible to schedule
// inventory and owns its lifecycle; it never performs work during module evaluation.
//
// D-004 classification: 'must-sample'. The writers above (writePotControlPolicy /
// setPotControlPolicy) update `cached` for the SAME process and emit NOTHING cross-process —
// unlike the flag-override store, which publishes a deliberate `flag_override_changed` signal
// (WI-37494). So for any OTHER process there is no change event to subscribe to and a timer is
// the only freshness mechanism, which is exactly what 'must-sample' denotes. This is not a
// standing endorsement: if the writers ever publish a cross-process change signal the way flag
// overrides do, this becomes a 'violation' and should convert to invalidate-on-write.
managedSetInterval('config-refresh:pot-control-policy', 60_000, () => refreshPotControlPolicy(), {
  category: 'cache',
  classification: 'must-sample',
});

export async function readPotControlPolicy(workspaceId?: string): Promise<PotControlPolicy> {
  return (await readOperatorState<PotControlPolicy>('operator_pot_control_policy', workspaceId)) ?? {};
}

export async function writePotControlPolicy(patch: PotControlPolicy): Promise<PotControlPolicy> {
  const next = { ...(await readPotControlPolicy()), ...patch };
  await writeOperatorState<PotControlPolicy>('operator_pot_control_policy', next);
  cached = next; // same-process immediate effect
  return next;
}

export async function setPotControlPolicy(cfg: PotControlPolicy): Promise<void> {
  await writeOperatorState<PotControlPolicy>('operator_pot_control_policy', cfg);
  cached = cfg;
}

export async function resetPotControlPolicy(): Promise<void> {
  await setPotControlPolicy({});
}

registerOverrideConcern({
  name: 'pot-control-policy',
  description: 'pot placement-watchdog thresholds (breaker / recovery-debounce / dormancy-grace / infra-breaker)',
  auditAction: 'pot:control_policy',
  diff: async () => {
    const c = await readPotControlPolicy();
    const entries: OverrideEntry[] = [];
    for (const k of Object.keys(POT_CONTROL_DEFAULTS) as (keyof typeof POT_CONTROL_DEFAULTS)[]) {
      if (c[k] !== undefined) entries.push({ key: k, effective: c[k], default: POT_CONTROL_DEFAULTS[k], layer: 'pg-settings' });
    }
    if (c.workScope) {
      entries.push({
        key: 'workScope',
        effective: { mode: c.workScope.mode, allowHarnesses: c.workScope.allowHarnesses, exceptions: c.workScope.exceptions?.length ?? 0, setBy: c.workScope.setBy ?? null },
        default: null,
        layer: 'pg-settings',
      });
    }
    return entries;
  },
  capture: () => readPotControlPolicy(),
  reset: () => resetPotControlPolicy(),
  restore: (snap) => setPotControlPolicy((snap as PotControlPolicy) ?? {}),
});
