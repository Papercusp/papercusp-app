/**
 * `system:idle-backend-reaper` — stop on-demand local inference backends idle past their TTL.
 * Plan: on-demand-local-inference-lifecycle-2026-08-17 (P-007). Seeded by
 * `seed-idle-backend-reaper-routine.ts`.
 *
 * This file is COMPOSITION ONLY. Every decision lives in `inference-gateway/idle-backend-reaper`
 * (pure, injectable, unit-tested without systemd/PG/GPU); the actual effects come from the
 * gateway registry (`local-backend-store`) and the provisioner's lifecycle seam
 * (`provisioner/provision`). Wiring them here rather than inside the reaper keeps the dependency
 * direction one-way: the provisioner reads the gateway registry, never the reverse.
 *
 * `tier: 'durable'` — the sweep STOPS PROCESSES and writes the shared watermark, so it must be
 * claimed once through `routinesTick` rather than armed per host by the ephemeral executor. On a
 * multi-host install an ephemeral row would have every host racing to stop the same unit.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import {
  listOnDemandLocalBackends,
  markLocalBackendBusy,
  type LocalBackendRecord,
} from '../../inference-gateway/local-backend-store';
import {
  runIdleBackendReap,
  probeLlamaServerSlots,
  type BusyObservation,
} from '../../inference-gateway/idle-backend-reaper';
import { stopLocalBackend } from '../../provisioner/provision';

/** Fallback TTL for an on-demand backend whose row sets none. 30 min: long enough that a user
 *  stepping away mid-conversation does not pay a cold reload on their next message, short enough
 *  that an abandoned session gives the card back inside a coffee break. */
export const DEFAULT_IDLE_TTL_SEC = 1800;

/**
 * Kind-dispatched busy probe.
 *
 * Only `llama-server` has a probe today. The other kinds return `unreadable` rather than `idle`
 * ON PURPOSE: `idle` would make them reapable on a signal we do not actually have, and a reaper
 * that stops a vLLM container because it cannot see its slots is worse than one that leaves it
 * alone and says why.
 */
async function probeBusy(backend: LocalBackendRecord): Promise<BusyObservation> {
  if (backend.kind === 'llama-server') return probeLlamaServerSlots(backend.baseUrl);
  return {
    state: 'unreadable',
    detail: `no busy-probe implemented for kind '${backend.kind}' — not reaping what cannot be observed`,
  };
}

registerSystemAction('idle-backend-reaper', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const dryRun = cfg.dry_run === true;
  const defaultIdleTtlSec =
    typeof cfg.default_idle_ttl_sec === 'number' && cfg.default_idle_ttl_sec > 0
      ? cfg.default_idle_ttl_sec
      : DEFAULT_IDLE_TTL_SEC;
  const pollIntervalSec = typeof cfg.poll_interval_sec === 'number' ? cfg.poll_interval_sec : undefined;

  const result = await runIdleBackendReap(
    {
      listOnDemand: () => listOnDemandLocalBackends({ workspaceId: ctx.workspaceId }),
      probeBusy,
      stopBackend: async (backend) => {
        const r = await stopLocalBackend(backend);
        return { ok: r.ok, error: r.error };
      },
      markBusy: (id) => markLocalBackendBusy(id, { workspaceId: ctx.workspaceId }),
    },
    { defaultIdleTtlSec, dryRun, pollIntervalSec },
  );

  // Nothing registered on-demand is the expected state until P-008 backfills ornith — say so
  // once and cheaply, so an operator reading logs can tell "armed and idle" from "armed and broken".
  if (result.scanned === 0) {
    console.log('[idle-backend-reaper] no enabled on-demand backends registered — nothing to sweep');
    return;
  }

  const parts = [
    `scanned ${result.scanned}`,
    result.stopped.length ? `${dryRun ? 'WOULD STOP' : 'stopped'} ${result.stopped.join(', ')}` : null,
    result.busy.length ? `busy ${result.busy.join(', ')}` : null,
    result.waiting.length ? `waiting ${result.waiting.map((w) => `${w.id}(${w.idleSec}/${w.ttlSec}s)`).join(', ')}` : null,
    result.down.length ? `down ${result.down.join(', ')}` : null,
  ].filter(Boolean);
  console.log(`[idle-backend-reaper] ${parts.join(' · ')}`);

  // Both of these mean the reaper is running but cannot do its job — the "armed and silently
  // does nothing" shape. Warn every sweep rather than letting it read as healthy quiet.
  for (const u of result.unreadable) {
    console.warn(`[idle-backend-reaper] ⚠ ${u.id} is UNREADABLE — never reaped while this persists: ${u.detail}`);
  }
  for (const w of result.warnings) console.warn(`[idle-backend-reaper] ⚠ ${w}`);
  for (const f of result.failures) console.error(`[idle-backend-reaper] ✗ ${f.id}: ${f.error}`);
});
