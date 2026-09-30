/**
 * `system:worker-breaker-watch` — the routine-engine registration for the embed
 * sidecar's two persistent-worker crash-breakers (WI-37700, follow-on to WI-37696).
 *
 * The parse/decide logic lives in `../../worker-breaker-watch.ts` (pure + testable, no
 * PG/DBOS/fetch); this module is the thin adapter that wires it into the
 * ephemeral-executor's dispatch (`system-actions.ts`) with production deps — a real
 * `fetch` of the sidecar's `/healthz` and the coord broadcast. Same split as
 * `supervision-reconcile-action.ts` + `../../supervision/unit-reconciler.ts`.
 *
 * Seeded as a bespoke `tier:'ephemeral'` routine by `seed-worker-breaker-watch-routine.ts`
 * — an operator-HOME-level concern (the sidecar process on ONE box), not a per-blueprint-
 * install cadence, mirroring `supervision-reconcile-action.ts`'s documented deviation.
 *
 * ⚠ Watches the SIDECAR's two workers only. The third breaker (`cpuWorker`) announces
 * itself from inside the operator host instead — it is per-cluster-worker state that
 * `/api/health/deep` can only SAMPLE, so polling it here would be wrong. See
 * `../../worker-breaker-watch.ts`'s header and `configureCpuWorkerBreakerNotifier`.
 *
 * ⚠ REPORT-ONLY by inheritance from WI-37696: a fallen-back worker still returns correct
 * vectors and scores. This never restarts the sidecar and never gates readiness.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import {
  embedSidecarEnabled,
  embedSidecarLocalUrl,
  probeSidecarHealth,
} from '../../memory/embed-sidecar-spawn';
import {
  createWorkerBreakerWatchState,
  workerBreakerWatchTick,
  type WorkerBreakerWatchState,
} from '../../worker-breaker-watch';

/** Coord identity for this watcher's broadcasts (mirrors supervision-reconcile-action). */
const WORKER_BREAKER_IDENTITY: AgentIdentity = {
  ownerId: 'worker-breaker-watch',
  ownerLabel: 'worker-breaker-watch',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/**
 * Cross-tick dedupe memory (see `WorkerBreakerWatchState`) — module-scoped so a
 * PERMANENT latch is announced once, not on every fire.
 *
 * Deliberately NOT pinned via `@papercusp/module-singleton`: a duplicated module record
 * would give each copy its own memory, and the only consequence is that a trip is
 * announced twice — strictly better than the alternative failure (a shared record that
 * suppresses a real trip). The ephemeral executor also dispatches this from one process,
 * so the split cannot arise from the cadence itself.
 */
let state: WorkerBreakerWatchState = createWorkerBreakerWatchState();

/** Test seam — drop the dedupe memory so a re-run announces again. */
export function _resetWorkerBreakerWatchState(): void {
  state = createWorkerBreakerWatchState();
}

/**
 * Where this host's sidecar is, or null when it has none — mirroring rules 1 and 2 of
 * `embed-sidecar-wiring.ts`'s resolution order, but WITHOUT `ensureEmbedSidecar`.
 *
 * Deliberately non-spawning: a health WATCHER that spawns the thing it watches would
 * manufacture the process on hosts that had chosen not to run one, and would make an
 * unreachable sidecar self-heal on observation — the observer changing what it observes.
 * If the URL is set but nothing answers, the tick simply reads unreachable and stays
 * quiet (the supervision reconciler owns "a supervised unit is down").
 */
function watchedSidecarUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.PAPERCUSP_EMBED_SIDECAR_URL?.trim();
  if (explicit) return explicit;
  return embedSidecarEnabled(env) ? embedSidecarLocalUrl(env) : null;
}

registerSystemAction('worker-breaker-watch', async (ctx: SystemActionCtx) => {
  const url = watchedSidecarUrl();
  // No sidecar configured for this host ⇒ nothing to watch. Not an error: plenty of
  // hosts run the pure in-process engine (see embed-sidecar-spawn's "no sidecar
  // configured" path), and announcing on those would be noise, not signal.
  if (!url) return;

  await workerBreakerWatchTick(
    {
      sidecarUrl: url,
      fetchSidecarHealth: () => probeSidecarHealth(url),
      notify: async ({ summary }) =>
        void (await sendMessage(WORKER_BREAKER_IDENTITY, {
          to: ['*'],
          summary,
          category: 'health',
          kind: 'message',
          harnessSlug: ctx.installSlug,
        })),
    },
    state,
  );
});
