/**
 * Curator-operator cadence (plan curator-operator-2026-06-04, P0) as a DBOS
 * scheduled workflow — the routine half of the curation loop (the urgent half
 * is the event-driven `urgent-wake.ts`). Mirrors `routines-workflow.ts`: a
 * scheduled tick that, per orchestrated workspace, runs `runCurationTick`
 * honoring the adaptive interval ("faster when busy, slower when quiet").
 *
 * Flag-gated, OPT-IN (`dbosCurationActive()` ⇒ PAPERCUSP_DBOS_CURATION=1, gated
 * by the orchestrator switch) — mirroring how backup/routines started opt-in
 * before any live-verified default-on flip. A fresh background loop that writes
 * into the user's operator chat should not auto-arm on a shared dev box; the
 * owner flips it on.
 *
 * Default skip-missed mode (no ExactlyOncePerInterval) so a desktop closed for
 * hours doesn't backfill a storm of ticks (the autoloop's D-009).
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow } from './idempotent-register-workflow';
import { runWithWorkspace } from '../workspace-als';
import { orchestratorWorkspaceIds } from './orchestrator-loop';
import {
  runCurationTick,
  shouldRunTick,
  nextInterval,
  canEmitDigestNow,
} from '../curation/curation-loop';
import { readCurationState, writeCurationState } from '../curation/curation-state';
import { buildCurationDeps } from '../curation/deps';

// 6-field crontab (seconds). Base poll every 60s; the per-workspace adaptive
// interval (shouldRunTick) gates whether a tick actually does work.
const TICK_CRONTAB = process.env.PAPERCUSP_DBOS_CURATION_CRONTAB || '*/60 * * * * *';

/** One curation pass across every orchestrated workspace. Per-workspace errors
 *  are swallowed so one workspace can't fail the scheduled tick. */
async function curationTickImpl(): Promise<void> {
  const now = Date.now();
  for (const ws of orchestratorWorkspaceIds()) {
    try {
      await runWithWorkspace(ws, async () => {
        const state = await readCurationState();
        if (!shouldRunTick(state.lastRunAtMs, state.currentIntervalSeconds, now)) return;

        // Owner idle-activity toggle (queen-steering-panel P-006): the owner can gate
        // doc/memory curation OFF for the home hive. Fail-soft → runs (default ON).
        const { idleActivityAllowed } = await import('../owner-steering');
        if (!(await idleActivityAllowed(ws, 'curation'))) return;

        const deps = buildCurationDeps();
        const result = await runCurationTick(deps, {
          canEmitDigest: (size) => canEmitDigestNow(state.lastDigestAtMs, size, now),
        });

        const surfacedSomething = result.surfacedCount > 0 || result.digestEmitted;
        await writeCurationState({
          lastRunAtMs: now,
          ...(result.digestEmitted ? { lastDigestAtMs: now } : {}),
          currentIntervalSeconds: nextInterval(state.currentIntervalSeconds, surfacedSomething),
          consecutiveQuiet: surfacedSomething ? 0 : state.consecutiveQuiet + 1,
          lastSurfacedCount: result.surfacedCount,
        });
      });
    } catch (e) {
       
      console.warn(`[curation] tick failed for workspace ${ws}:`, e instanceof Error ? e.message : e);
    }
  }
}

const curationTickWorkflow = idempotentRegisterWorkflow('curationTick', () =>
  DBOS.registerWorkflow(curationTickImpl, { name: 'curationTick' }),
);

// Scheduled fn must also be a registered workflow. Skip-missed (no backfill).
DBOS.registerScheduled(curationTickWorkflow, { name: 'curationTick', crontab: TICK_CRONTAB });
