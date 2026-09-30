/**
 * `system:gate-fire-drill` — the periodic gate fire drill
 * (gate-verdict-liveness-and-repair-reliability-2026-08-31, P-016).
 *
 * WIRING ONLY. Every decision — the green/idle/held/load skips, the launch→kill→assert
 * sequence, what counts as a detector failure — is pure and unit-tested in
 * `../../release/gate-fire-drill.ts`; the IO seams live in
 * `../../release/gate-fire-drill-deps.ts` (the sync-batch-delta-check shape,
 * lazy-imported so a broken leg can never poison engine boot).
 *
 * WHAT IT CLOSES: the 74.2h verdict blackout (plan D-001, loss class 2) went unpaged
 * because nothing ever proved the no-verdict alarm path could see a dead run. This drill
 * kills a checkpoint run on purpose — its own, launched for the occasion on a green idle
 * gate, killed seconds after start — and asserts the P-001 fire anchor, the absence of a
 * verdict row, and a firing `evaluateVerdictRateAlarm` verdict over the real ledger.
 * A failed drill pages as a detector regression (`gate-drill-detector:<harness>`).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

/** Launch + 30s up-wait + kill + 30s stop-wait + 10s grace + bounded SQL: 10 min is generous. */
export const GATE_FIRE_DRILL_ROUTINE_TIMEOUT_MS = 10 * 60_000;

registerSystemAction(
  'gate-fire-drill',
  async (ctx: SystemActionCtx) => {
    const home = operatorHomeHarnessSlug();
    if (ctx.installSlug && ctx.installSlug !== home) {
      console.log(`[gate-fire-drill] skip: not the operator-home harness (got "${ctx.installSlug}", home "${home}")`);
      return;
    }
    const [{ runGateFireDrill }, { buildGateFireDrillDeps }, { integrationRoot }] = await Promise.all([
      import('../../release/gate-fire-drill'),
      import('../../release/gate-fire-drill-deps'),
      import('../../release-deploy-launch'),
    ]);
    const deps = buildGateFireDrillDeps({
      installSlug: ctx.installSlug || home,
      workspaceId: ctx.workspaceId,
      root: integrationRoot(),
    });
    const outcome = await runGateFireDrill(deps);
    console.log(`[gate-fire-drill] ${outcome.status} (${outcome.reason}): ${outcome.detail}`);
  },
  { routineTimeoutMs: GATE_FIRE_DRILL_ROUTINE_TIMEOUT_MS },
);
