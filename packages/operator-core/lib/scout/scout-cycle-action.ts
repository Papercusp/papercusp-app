/**
 * scout-cycle-action.ts — Scout P-008: the `system:scout-cycle` routine action —
 * the autonomous cadence PRIMITIVE (resolves b6c3f's invariants-contract Risk A).
 *
 * A `routines` row with `trigger_kind='cron'` + `target_role='system:scout-cycle'`
 * ticks FREQUENTLY (provisioned INACTIVE per-hive at pot:create —
 * lib/hive/provision-learning-loop.ts). On each tick the
 * routines engine runs THIS handler inline (one durable DBOS step), which calls
 * {@link runScoutTick} — and runScoutTick SELF-GATES on {@link shouldRunScoutCycle}
 * (idle capacity OR friction) + the budget + the autoloop fire-gate. So the
 * effective cadence is idle/friction-triggered even though the trigger is a cron:
 * most ticks no-op cheaply, a real (budgeted) cycle fires only when the gate says
 * so. That is the "system: action that gates on idle capacity" Risk A asked for —
 * a bare cron is NOT the plan's cadence; this gate is.
 *
 * Decoupled from cb4b9's `cycle-deps`: the per-harness cycle runner is INJECTED
 * ({@link ScoutCycleRunner}), so this handler unit-tests with a fake runner and
 * the production registration (wiring cb4b9's runScoutCycle + its ports) is a
 * one-line {@link registerScoutCycleAction} call at boot. Idempotent/re-runnable
 * (the routines engine replays a handler on crash): a no-fire tick is a no-op, and
 * recordRoutedIdea upserts.
 */

import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import { checkHiveSingleRunner } from '../hive-single-runner';
import { recordScoutTickToGovernor } from '../learning-governor/registrants';
import { scoutWorkspaceCeilingGate } from '../learning-governor/scout-ceiling';
import { readWorkItemAdmissionProducerPressure } from '../work-items-admission-promoter';
import { scoutConfigDelta, scoutPotGate } from '../learning/pot-gate/gates';
import {
  runScoutCycleTick,
  parseScoutCycleConfig,
  productionDepsBuilder,
  type ScoutCycleRunner,
  type ScoutTickDepsBuilder,
  type ScoutCycleActionConfig,
} from './run';

/**
 * The cadence-gated tick orchestration this action runs is SHARED with the
 * `blender:cycle` deterministic blueprint step via `runScoutCycleTick`
 * (deterministic-blueprints-migration-2026-06-13 P-121 / D-004 — provably
 * behavior-neutral: one self-gated tick, two callers, the SAME production deps).
 * Re-exported here so the action's existing test contract (which imports them from
 * this module) keeps working.
 */
export { parseScoutCycleConfig, type ScoutCycleRunner, type ScoutTickDepsBuilder, type ScoutCycleActionConfig };

/** The action name; a routine targets it via `target_role: 'system:scout-cycle'`. */
export const SCOUT_CYCLE_ACTION = 'scout-cycle';

/**
 * Build the `system:scout-cycle` handler from an injected per-harness cycle
 * runner. The handler wires the production cadence signals + the P-013 ledger via
 * {@link productionDepsBuilder}, then runs one self-gated tick (via the shared
 * {@link runScoutCycleTick}). `buildDeps` is an injection seam for unit tests
 * (default = production wiring).
 */
export function makeScoutCycleAction(
  runCycle: ScoutCycleRunner,
  buildDeps: ScoutTickDepsBuilder = productionDepsBuilder,
  // No production default ON PURPOSE: this factory's unit-test contract is
  // PG-free (see the header), and the real glue resolves the live admin pool.
  // The boot path (registerScoutCycleAction) wires recordScoutTickToGovernor +
  // workspaceCeilingGate.
  recordGovernor?: typeof recordScoutTickToGovernor,
  // P-051: the workspace-wide scout spend ceiling preflight. Same PG-free
  // contract — unwired in unit tests, wired at boot.
  workspaceCeilingGate?: typeof scoutWorkspaceCeilingGate,
  // P-010: reuse P-005's queue-health writer to bound producer fan-out. Unwired
  // keeps the PG-free factory contract; boot wires the production reader.
  admissionPressureGate?: typeof readWorkItemAdmissionProducerPressure,
  // learning-pot-scope-gate D-001: the per-pot learning master switch. Same
  // PG-free contract — unwired in unit tests, wired at boot (and, separately,
  // in the blueprint op that also runs Scout; both must carry it, see gates.ts).
  potGate?: (input: { workspaceId: string; installSlug: string }) => Promise<{ enabled: boolean }>,
  // WI-1664060: the pot's settings-resident scout/cadence/budget deltas. Same
  // PG-free contract as the gates above — unwired in unit tests, wired at boot,
  // and wired IDENTICALLY in the blueprint op (see gates.ts: a concern carried by
  // only one of Scout's two entrypoints silently no-ops in the other).
  resolveConfigDelta?: (input: {
    workspaceId: string;
    installSlug: string;
  }) => Promise<Record<string, Record<string, unknown>> | null>,
  // WI-1728261: P-019's cross-node SINGLE-RUNNER gate. The FOURTH instance of this
  // file's recurring defect, and the first in the OTHER direction — the blueprint op
  // has wired it since 2026-06-19 and this path never had it at all, so on a shared
  // Hive every node's `system:scout-cycle` loop fired instead of only the elected
  // runner. Same PG-free contract as the gates above: unwired in unit tests, wired at
  // boot. Appended LAST so no positional caller shifts.
  hiveRunnerGate?: (input: { workspaceId: string; installSlug: string }) => Promise<{ run: boolean; reason?: string }>,
) {
  return async function scoutCycleAction(ctx: SystemActionCtx): Promise<void> {
    // Owner idle-activity toggle (queen-steering-panel P-006): the owner can gate
    // Scout idea-grading OFF for the home hive. Fail-soft → runs (default ON).
    const { idleActivityAllowed } = await import('../owner-steering');
    if (!(await idleActivityAllowed(ctx.workspaceId, 'scout'))) {
      console.log(`[scout-cycle] ${ctx.installSlug}: skipped — owner idle-activity toggle (scout) is OFF`);
      return;
    }
    // P-015 (domain-generic-hive-architecture-2026-06-18 / D-005): the hive's
    // settings-resident `scout` / `cadence` / `budget` deltas are layered onto the
    // routine payload by `runScoutCycleTick` via the injected `resolveConfigDelta`
    // seam (production wiring: learning/pot-gate/gates.ts `scoutConfigDelta`).
    //
    // That merge USED TO LIVE HERE, in this action's body, which is exactly why it
    // was missing from the `blender:cycle` blueprint op — the path that actually
    // runs Scout in production. The owner's per-pot tuning was written to
    // hive_settings and never read (WI-1664060), the same one-lane-two-entrypoints
    // shape as the P-051 ceiling regression. Do NOT re-add a read here: one merge
    // site on the shared tick is what keeps the two entry points identical.
    const { isWorkspaceCoordinationOn } = await import('../workspace-brain-scope');
    const admissionQueueScope = (await isWorkspaceCoordinationOn())
      ? ({ kind: 'workspace' } as const)
      : ({ kind: 'harness', harnessSlug: ctx.installSlug } as const);

    const result = await runScoutCycleTick(
      {
        workspaceId: ctx.workspaceId,
        installSlug: ctx.installSlug,
        admissionQueueScope,
        payloadTemplate: ctx.payloadTemplate,
      },
      {
        runCycle,
        buildDeps,
        ...(recordGovernor ? { recordGovernor } : {}),
        ...(workspaceCeilingGate ? { workspaceCeilingGate } : {}),
        ...(admissionPressureGate ? { admissionPressureGate } : {}),
        ...(potGate ? { potGate } : {}),
        ...(resolveConfigDelta ? { resolveConfigDelta } : {}),
        ...(hiveRunnerGate ? { hiveRunnerGate } : {}),
      },
    );

    if (result.fired) {
      console.log(
        `[scout-cycle] ${ctx.installSlug}: fired (${result.reason}) cycle=${result.cycleId} routed=${result.routedCount}`,
      );
    } else if (result.reason === 'cycle-error') {
      console.warn(`[scout-cycle] ${ctx.installSlug}: cycle error — ${result.error}`);
    } else if (result.reason === 'workspace-ceiling') {
      console.warn(`[scout-cycle] ${ctx.installSlug}: refused — workspace-wide scout spend ceiling reached (P-051)`);
    }
    // A withheld tick (min-interval / no-trigger / circuit) is the common, silent no-op.
  };
}

/**
 * Register `system:scout-cycle` with the routines engine, wiring the given
 * per-harness cycle runner (built from cb4b9's runScoutCycle + its ports). Call
 * once at boot (alongside the other registerSystemAction calls). Last wins.
 */
export function registerScoutCycleAction(runCycle: ScoutCycleRunner): void {
  registerSystemAction(
    SCOUT_CYCLE_ACTION,
    // Wire BOTH governor seams at boot: the post-tick spend mirror
    // (recordScoutTickToGovernor) and the P-051 workspace-wide ceiling preflight
    // (scoutWorkspaceCeilingGate). Both flag-gated + best-effort/fail-open.
    // Plus the per-pot master switch (learning-pot-scope-gate D-001) — Scout's
    // FIRST real preflight; the blueprint op wires the same helper.
    makeScoutCycleAction(
      runCycle,
      undefined,
      recordScoutTickToGovernor,
      scoutWorkspaceCeilingGate,
      readWorkItemAdmissionProducerPressure,
      scoutPotGate,
      // WI-1664060: the per-pot scout/cadence/budget layering. The blueprint op
      // wires this SAME helper — that parity is the whole point of the seam.
      scoutConfigDelta,
      // WI-1728261: P-019's cross-node single-runner gate, wired with the SAME helper
      // the blueprint op uses. `lint:deps-wiring-parity` now fails the build if these
      // two deps objects ever diverge again.
      ({ workspaceId, installSlug }) => checkHiveSingleRunner(workspaceId, installSlug),
    ),
  );
}
