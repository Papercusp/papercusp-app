/**
 * Gym system action (learning-system-audit-improvements-2026-06-09 P-031/P-032)
 * — `system:gym-cycle`, the routine that gives the gym a PULSE: continuous
 * operation as a switch (the per-harness autoloop row), not a manual CLI run.
 *
 * Thin glue over the pure tick core (`lib/gym/autoloop-tick.ts` — selection,
 * round-robin, budget floor, routed-ideas assembly, status transitions; all
 * unit-tested with injected deps). Per tick, AT MOST ONE harness runs AT MOST
 * ONE bounded gym cycle, picked least-recently-run among autoloops that are
 * enabled + idle + explicitly budgeted with remaining > the floor (~$0.50).
 *
 * Gates honored, in order:
 *   - enabled/status/budget eligibility (the tick core — the hard cost guard;
 *     a null budget is INELIGIBLE: unattended spend requires an explicit cap),
 *   - the shared autoloop fire-gate (error backoff / circuit breaker, D-009,
 *     role 'gym-cycle') — an erroring harness degrades to backoff probes and
 *     never starves its peers (the tick walks past it),
 *   - inside the cycle: the loop's hard budget cap (= the row's remaining
 *     budget), the rate-limit pause+resume, and the arithmetic circuit breaker.
 *
 * autoPromote stays FALSE — the cycle records proposals; humans decide (D-020).
 *
 * The handler runs as ONE durable step (system-actions contract) and NEVER
 * throws for a failed cycle: the fire-gate's error counter is the backoff
 * signal, and a step failure would invite engine-level replays (= double
 * cycles = double spend). A replayed tick sees the row at status 'running' and
 * skips it. The per-hive gym autoloop ROWS it sweeps are now provisioned inline
 * at pot:create (lib/hive/provision-learning-loop.ts, dark by default) — the
 * standalone `?? operatorHomeHarnessSlug()` seed-gym-routine.ts env-slug script was RETIRED
 * (per-hive-learning-loops-2026-06-14 P-022 / D-003).
 */
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { blueprintRetirement, type BlueprintRetirementInfo } from '@papercusp/orchestrator/blueprint';
import { registerSystemAction } from './system-actions';
import { checkFireGate, recordFire } from '../../autoloop';
import { listAutoloopsForWorkspace, setAutoloop } from '../../gym/control-plane';
import { resolveProject } from '../../harness-core';
import { getEffectiveBlueprint } from '../../blueprint/project-to-pg';
import {
  gymBudgetFloorUsd,
  runGymAutoloopTick,
  selectRoutedGymIdeas,
  type GymCycleRequest,
  type GymCycleResult,
} from '../../gym/autoloop-tick';
import { readImprovementItems } from '../improvements/read-items';
import { finalizePendingChampionOutcomes } from '../../gym/post-acceptance-outcomes';
import { recordGymTickToGovernor } from '../../learning-governor/registrants';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import {
  launchDetachedGymCycle,
  type LaunchGymCycleResult,
} from '../../gym/gym-cycle-launch';

export { gymBudgetFloorUsd };

/** The autoloop_state role the gym tick's fire-gate/backoff is keyed under. */
export const GYM_CYCLE_FIRE_ROLE = 'gym-cycle';

/** The cycle-runner seam — injectable for tests (mirrors the implement fire seam). */
export type GymCycleRunFn = (req: GymCycleRequest) => Promise<GymCycleResult>;

let _runCycle: GymCycleRunFn | null = null;
/** Override the cycle runner (tests). Pass null to restore the default in-process run. */
export function setGymCycleRunner(fn: GymCycleRunFn | null): void {
  _runCycle = fn;
}

/**
 * Default: run ONE cycle in-process via the factored `runOneAutoloopCycle`
 * (lib/gym/autoloop-cycle.ts) — the SAME machinery as the manual CLI, no
 * shell-out. Imported lazily so the routines boot path never loads
 * testcontainers / the gym runner graph. The tick core owns the autoloop row
 * (running→idle + spend ACCUMULATION), so the cycle is told not to
 * (manageAutoloopRow:false); the control plane (proposals / QD archive) writes
 * to the LIVE operator DB through the shared admin client.
 */
const defaultRunCycle: GymCycleRunFn = async (req) => {
  const { runOneAutoloopCycle } = await import('../../gym/autoloop-cycle');
  const { sql } = getOrgPg();
  const out = await runOneAutoloopCycle(req.harnessSlug, {
    workspaceId: req.workspaceId,
    maxCycles: 1,
    budgetUsd: req.budgetUsd,
    candidateDirections: req.candidateDirections,
    controlSql: sql, // caller-owned: runOneAutoloopCycle never closes it
    manageAutoloopRow: false,
    log: (m) => console.log(`[gym-cycle] ${m}`),
  });
  if (!out.result) {
    throw new Error(`gym cycle failed before completing: ${String(out.report.error ?? 'unknown error')}`);
  }
  const r = out.result;
  return { spentUsd: r.spentUsd, breakerTripped: r.breakerTripped, cycles: r.cycles, accepts: r.accepts, skipped: r.skipped };
};

/**
 * WI-5645 (no-retirement-launch-guard) live wiring: does this harness's effective
 * blueprint (or any ancestor in its `extends` chain) resolve to RETIRED? Mirrors
 * `getEffectiveBlueprint`'s use in `resolveHarnessDispatchGate` (dbos/orchestrator-loop.ts)
 * — the same PG-cache-first, lazy-project-on-miss read, so this and the DBOS
 * per-feature dispatcher never disagree about a given harness's retirement.
 * Best-effort: an unresolvable project/blueprint returns null (not-retired) so a
 * bad slug never stalls the gym tick — the tick core's `isBlueprintRetired` dep
 * already fails open on a thrown error.
 */
async function isHarnessBlueprintRetired(workspaceId: string, slug: string): Promise<BlueprintRetirementInfo | null> {
  const { sql } = getOrgPg();
  const project = await resolveProject(slug, workspaceId);
  if (!project) return null;
  const bp = await getEffectiveBlueprint(sql as never, {
    workspaceId,
    harnessSlug: slug,
    blueprintPath: join(project.path, '.papercusp', 'blueprint.yaml'),
  }).catch((error) => {
    console.warn(
      `[gym-cycle] effective-blueprint resolve failed (${slug}): ` +
        `${error instanceof Error ? error.message : error}`,
    );
    return null;
  });
  return bp ? blueprintRetirement(bp) : null;
}

/** The original in-process action body, also used by the detached CLI fallback. */
export async function runGymCycleInline(workspaceId: string): Promise<void> {
  const { sql } = getOrgPg();
  // Owner idle-activity toggle (queen-steering-panel P-006): the owner can gate gym
  // spend OFF for the home hive from the 👑 tab. Fail-soft → runs (default ON).
  const { idleActivityAllowed } = await import('../../owner-steering');
  if (!(await idleActivityAllowed(workspaceId, 'gym'))) {
    console.log('[gym-cycle] skipped — owner idle-activity toggle (gym) is OFF');
    return;
  }
  const outcome = await runGymAutoloopTick(
    {
      listAutoloops: () => listAutoloopsForWorkspace(sql, { workspaceId }),
      checkFireGate: (slug) => checkFireGate(slug, GYM_CYCLE_FIRE_ROLE),
      recordFire: (slug, status, oc) => recordFire(slug, GYM_CYCLE_FIRE_ROLE, status, oc),
      setAutoloop: (input) => setAutoloop(sql, input),
      // P-032: open improvements the triage pass routed to the gym
      // (payload.ideaLifecycle.triageDecision='gym') → proposer candidate directions.
      readRoutedIdeas: async () => selectRoutedGymIdeas(await readImprovementItems({ state: 'open' })),
      runCycle: _runCycle ?? defaultRunCycle,
      // P-020 cross-node single-runner: in a SHARED Hive each node sweeps its own
      // node-local autoloop rows, so without this two nodes could each fire a cycle
      // for the same Hive member (double spend). Keep only autoloops whose Hive THIS
      // node is the elected authority for. At N=1 / standalone this is always true
      // (authority / not-in-hive), so the standalone gym path is unchanged.
      isHiveRunner: async (slug) => {
        const { checkHiveSingleRunner } = await import('../../hive-single-runner');
        return (await checkHiveSingleRunner(workspaceId, slug)).run;
      },
      // WI-5645: refuse to fire a gym cycle against a harness whose effective
      // blueprint (or an ancestor) is retired — the hard cost guard for the exact
      // scenario EI-18177667809538623 hit (spend via a retired ancestor blueprint).
      isBlueprintRetired: (slug) => isHarnessBlueprintRetired(workspaceId, slug),
      // learning-pot-scope-gate-2026-08-30 D-001: the per-pot learning master
      // switch. Gym's governor rows are enforcement:'native', so the tick's own
      // eligibility filter IS gym's gate — this is where the pot switch has to
      // reach it. One indexed read per tick; an absent row means enabled.
      disabledPots: async () => {
        const { gymDisabledPots } = await import('../../learning/pot-gate/gates');
        return gymDisabledPots(sql, workspaceId);
      },
      // P-030 (B-09): settle elapsed post-acceptance champion-outcome windows each tick.
      finalizeOutcomes: () =>
        finalizePendingChampionOutcomes(sql, { workspaceId, log: (m) => console.log(`[gym-cycle] ${m}`) }),
      log: (m) => console.log(`[gym-cycle] ${m}`),
    },
    { budgetFloorUsd: gymBudgetFloorUsd() },
  );

  // FB-01 (self-learning-frontier P-003): mirror the autoloop budgets onto the
  // shared learning-governor ledger as sub-budgets + ledger this tick's spend.
  // Flag-gated (papercusp-learning-governor — the kill-switch) and best-effort
  // by contract — recordGymTickToGovernor never throws, so governor
  // bookkeeping can never fail (or durably replay) the gym tick.
  await recordGymTickToGovernor({
    workspaceId,
    sql,
    listAutoloops: () => listAutoloopsForWorkspace(sql, { workspaceId }),
    ran:
      outcome.action === 'ran' && outcome.result
        ? {
            harnessSlug: outcome.harnessSlug!,
            spentUsd: outcome.result.spentUsd,
            runRef: `gym-cycle:${outcome.harnessSlug}`,
          }
        : null,
  });

  if (outcome.action === 'idle') {
    console.log(
      `[gym-cycle] idle — ${outcome.reason}` +
        (outcome.gateBlocked.length ? ` (fire-gate withheld: ${outcome.gateBlocked.join(', ')})` : '') +
        (outcome.retiredBlocked?.length
          ? ` (retired-blueprint withheld: ${outcome.retiredBlocked.map((r) => r.harnessSlug).join(', ')})`
          : '') +
        ` (${outcome.eligibleCount} eligible autoloop(s))`,
    );
  } else if (outcome.action === 'ran') {
    const r = outcome.result!;
    console.log(
      `[gym-cycle] ${outcome.harnessSlug}: ${r.cycles} cycle(s), ${r.accepts} accept(s), ${r.skipped} skipped, ` +
        `$${r.spentUsd.toFixed(2)} spent → status ${outcome.settledStatus}` +
        (outcome.candidateDirections?.length ? `, ${outcome.candidateDirections.length} routed idea(s) in proposer context` : ''),
    );
  } else {
    // Logged, NOT thrown — the fire-gate's error backoff is the retry brake;
    // a thrown step would invite a durable replay (= a second paid cycle).
    console.error(`[gym-cycle] cycle FAILED for ${outcome.harnessSlug}: ${outcome.error} (status settled back to idle)`);
  }
}

export interface GymCycleSystemActionDeps {
  launch?: (workspaceId: string) => Promise<LaunchGymCycleResult>;
  runInline?: (workspaceId: string) => Promise<void>;
}

/**
 * Detach on systemd hosts. Only a proved-unavailable service manager falls back
 * inline; an ambiguous launch failure never retries paid work in-process.
 */
export async function runGymCycleSystemAction(
  workspaceId: string,
  deps: GymCycleSystemActionDeps = {},
): Promise<void> {
  const launch = deps.launch ?? ((id: string) => launchDetachedGymCycle({ workspaceId: id }));
  const runInline = deps.runInline ?? runGymCycleInline;
  let result: LaunchGymCycleResult;
  try {
    result = await launch(workspaceId);
  } catch (error) {
    console.error(
      `[gym-cycle] detached launch threw; refusing inline retry to avoid duplicate spend: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  if (result.status === 'unavailable') {
    console.warn(`[gym-cycle] detached services unavailable (${result.reason ?? 'unknown'}); running inline`);
    await runInline(workspaceId);
    return;
  }
  if (result.status === 'launched') {
    console.log(`[gym-cycle] launched detached unit ${result.unit} for workspace ${workspaceId}`);
    return;
  }
  if (result.status === 'already_running') {
    console.log(`[gym-cycle] ${result.unit} already running; duplicate routine fire skipped`);
    return;
  }
  console.error(
    `[gym-cycle] detached launch refused (${result.reason ?? 'unknown'}); refusing inline retry to avoid duplicate spend`,
  );
}

registerSystemAction('gym-cycle', async (ctx) => runGymCycleSystemAction(ctx.workspaceId));
