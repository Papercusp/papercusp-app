/**
 * `system:plan-cleanup-sweep` — the DETERMINISTIC recurring plan clean-up
 * (plan-cleanup-system-repair-2026-10-01 P-004, WI-10004728).
 *
 * Replaces the LLM plan-run template `plan-cleanup-recurring-sweep-2026-09-01`,
 * whose weekly `system:plan-run` fire never produced a single cleanup run. This
 * action runs the SAME start path as the Plans pane's Clean-up button
 * (`startPlanCleanupRun`): create the run → deterministic pass to a fixed point
 * → launch an LLM resolver ONLY when judgment residue remains. A fire whose
 * plans are all clean therefore costs zero model turns.
 *
 * Population: every non-archived plan whose lifecycle is still open (not
 * shipped/superseded). Selection: least-recently-scanned first, capped at
 * MAX_RUN_PLANS, so consecutive fires rotate through the whole population.
 *
 * Every skip logs WHY (the inbox backstop's lesson, WI-10004720: a bare
 * `return` made "a run is executing" and "the backstop is wedged"
 * indistinguishable for 37 days), and the fire's outcome is returned as
 * `diagnostics` so it is visible in the routine's DBOS output.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { readStandingBulkAutomationPolicy } from '../../attention/automation-policy';
import { bulkAutomationSnapshot } from '../../attention/bulk-dispositions';
import { getRunningRun } from '../../attention/bulk-run-store';
import { resolveBulkResolverLaunch, type BulkResolverLaunchProfile } from '../../agent-config-constants';
import { readAgentConfig } from '../../agent-config';
import {
  listSweepablePlanSlugs,
  MAX_RUN_PLANS,
  PLAN_CLEANUP_SWEEP_REQUESTER,
  selectPlansLeastRecentlyScanned,
  startPlanCleanupRun,
} from '../../plan-cleanup/start-run';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';

export const PLAN_CLEANUP_SWEEP = 'plan-cleanup-sweep';

export interface PlanCleanupSweepDeps {
  enabled: () => Promise<boolean>;
  /** Single-flight: pending/running only. A run waiting in `review` waits on
   *  the OWNER and must never gate the sweep (WI-10004720). */
  runningRun: (workspaceId: string) => Promise<{ runId: string; phase: string } | null>;
  listPlans: typeof listSweepablePlanSlugs;
  select: typeof selectPlansLeastRecentlyScanned;
  readPolicy: typeof readStandingBulkAutomationPolicy;
  /** The standing Plans-pane resolver profile (`resolverProfiles['plan-cleanup']`):
   *  the model / effort / account / carry the owner chose for clean-up resolvers.
   *  The pane's Clean-up button posts exactly this profile, so the sweep must
   *  launch the same agent. Before WI-10004814 the sweep never read it and fell
   *  back to the built-in defaults (claude on `default`), so a Claude usage limit
   *  parked the resolver and the run watchdog failed the run. */
  readLaunchProfile: () => Promise<Partial<BulkResolverLaunchProfile> | null>;
  start: typeof startPlanCleanupRun;
  log: (message: string) => void;
}

function maxPlansFrom(cfg: Record<string, unknown>): number {
  const raw = Number(cfg.max_plans);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_RUN_PLANS) : MAX_RUN_PLANS;
}

export function makePlanCleanupSweepAction(overrides: Partial<PlanCleanupSweepDeps> = {}) {
  const deps: PlanCleanupSweepDeps = {
    enabled: () => getFlag(FLAGS.PLAN_CLEANUP, PLAN_CLEANUP_SWEEP_REQUESTER).catch(() => false),
    runningRun: (workspaceId) => getRunningRun(workspaceId, 'plan-cleanup'),
    listPlans: listSweepablePlanSlugs,
    select: selectPlansLeastRecentlyScanned,
    readPolicy: readStandingBulkAutomationPolicy,
    readLaunchProfile: async () => (await readAgentConfig()).resolverProfiles?.['plan-cleanup'] ?? null,
    start: startPlanCleanupRun,
    log: (message) => console.log(`[${PLAN_CLEANUP_SWEEP}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<SystemActionResult> => {
    const skip = (reason: string, extra: Record<string, unknown> = {}): SystemActionResult => {
      deps.log(`skip: ${reason}`);
      return { diagnostics: { outcome: 'skipped', reason, ...extra } };
    };
    if (!(await deps.enabled())) return skip('plan clean-up feature flag is off');
    const running = await deps.runningRun(ctx.workspaceId);
    if (running) return skip(`run=${running.runId} is ${running.phase} (single-flight)`, { runId: running.runId });

    const population = await deps.listPlans({ workspaceId: ctx.workspaceId, harnessSlug: ctx.installSlug });
    if (population.length === 0) return skip('no open plans to sweep');
    const selection = await deps.select({
      workspaceId: ctx.workspaceId,
      harnessSlug: ctx.installSlug,
      planSlugs: population,
      max: maxPlansFrom(ctx.triggerConfig ?? {}),
    });

    const policy = bulkAutomationSnapshot(await deps.readPolicy(ctx.workspaceId));
    // A read failure THROWS (red fire) rather than falling back to the built-in
    // defaults: a silent fallback is exactly how the sweep came to launch an agent
    // the owner never chose (WI-10004814).
    const profile = await deps.readLaunchProfile();
    const resolved = resolveBulkResolverLaunch({
      model: profile?.model ?? null,
      effort: profile?.effort ?? null,
      ...(profile?.account ? { account: profile.account } : {}),
      ...(profile?.carry ? { carry: profile.carry } : {}),
      // Authority comes from the standing automation policy, never the profile.
      automationMode: policy.mode,
      minConfidence: policy.minConfidence,
    });
    if (!resolved.ok || !resolved.effective) {
      return skip(`launch settings refused: ${resolved.message ?? 'invalid standing resolver settings'}`);
    }

    const coverage = {
      requested: selection.requested,
      accepted: selection.accepted,
      truncated: selection.truncated,
    };
    const started = await deps.start({
      planSlugs: selection.planSlugs,
      harness: ctx.installSlug,
      workspaceId: ctx.workspaceId,
      filter: { source: PLAN_CLEANUP_SWEEP_REQUESTER, ...coverage },
      launch: resolved.effective,
      automationPolicy: policy,
      requestedBy: PLAN_CLEANUP_SWEEP_REQUESTER,
    });
    if (started.kind === 'already-active') {
      return skip(`lost the single-flight race (${started.error.message})`, { runId: started.error.activeRunId });
    }
    if (started.kind === 'authority-revoked') {
      deps.log(`run=${started.runId} authority revoked (${started.refusal})`);
      return { diagnostics: { outcome: 'authority-revoked', runId: started.runId, refusal: started.refusal, ...coverage } };
    }
    deps.log(
      `run=${started.runId} plans=${selection.accepted}/${selection.requested} phase=${started.phase} ` +
        `applied=${started.deterministic.applied} resolver=${started.resolverNeeded ? (started.launched ? 'launched' : 'launch-failed') : 'not-needed'}` +
        (started.launchError ? ` error=${started.launchError}` : ''),
    );
    if (started.phase === 'failed') {
      // The run row already records the failure; throwing makes the ROUTINE
      // fire red too, so routine health shows a failing sweep instead of a
      // success-shaped fire (the P-003 masking class).
      throw new Error(
        `plan-cleanup sweep run ${started.runId} failed: ${started.launchError ?? 'unknown error'}`,
      );
    }
    return {
      diagnostics: {
        outcome: 'started',
        runId: started.runId,
        phase: started.phase,
        applied: started.deterministic.applied,
        resolverNeeded: started.resolverNeeded,
        launched: started.launched,
        ...(started.launchError ? { error: started.launchError } : {}),
        ...coverage,
      },
    };
  };
}

registerSystemAction(PLAN_CLEANUP_SWEEP, makePlanCleanupSweepAction());
