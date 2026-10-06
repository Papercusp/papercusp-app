/**
 * POST /api/admin/plan-cleanup — owner-side run control for the Plans-pane
 * cleanup flow (cleanup-report-flows-2026-08-24 P-005).
 *
 * The client posts the exact visible plan slugs: membership is a click-time
 * snapshot, never a server-side filter re-derivation. Start/accept act and are
 * feature-gated; stop/dismiss remain reachable when the kill switch is off.
 */
import { randomUUID } from 'node:crypto';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { requireAllowedOriginOr403 } from '../../cors';
import { gateApiRoute } from '../../../require-flag';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';
import {
  getRun,
  restartRun,
  resumeReviewRun,
  setRunPhase,
  settleRunPhase,
} from '../../../attention/bulk-run-store';
import {
  getRunFindings,
  markCleanupFindingAccepted,
  markCleanupFindingDismissed,
  reclassifyLegacyFindings,
} from '../../../plan-cleanup/run-store';
import { scanCleanupRun } from '../../../plan-cleanup/deterministic-runner';
import {
  invalidateCleanupRun,
  launchCleanupResolver,
  normalizePlanSlugs,
  selectPlansLeastRecentlyScanned,
  startPlanCleanupRun,
} from '../../../plan-cleanup/start-run';
import { preflightResolverLaunch, resolvePersistedResolverLaunch } from './attention-bulk-resolve';
import { bulkAutomationSnapshot } from '../../../attention/bulk-dispositions';
import { readStandingBulkAutomationPolicy } from '../../../attention/automation-policy';

async function handleOwnerOp(op: string, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (!runId) {
    return Response.json({ error: { code: 'missing_run_id', message: `op "${op}" requires runId` } }, { status: 400 });
  }

  try {
    if (op === 'reclassify') {
      const findingIds = Array.isArray(body.findingIds)
        ? body.findingIds.filter((id): id is string => typeof id === 'string').slice(0, 500)
        : undefined;
      const result = await reclassifyLegacyFindings({ runId, findingIds });
      if (result.refused) {
        return Response.json(
          {
            error: {
              code: result.refused,
              message: `plan clean-up run ${runId} is not in owner review`,
              runId,
            },
          },
          { status: result.refused === 'run_not_found' ? 404 : 409 },
        );
      }
      await invalidateCleanupRun();
      return Response.json({
        ok: true,
        runId,
        reclassified: result.updated.length,
        findingIds: result.updated.map((finding) => finding.findingId),
        phase: result.run?.phase ?? null,
      });
    }

    if (op === 'stop') {
      const run = await settleRunPhase({ runId });
      await invalidateCleanupRun();
      return Response.json({ ok: true, runId, phase: run?.phase ?? null, stopped: true });
    }
    if (op === 'dismiss') {
      // Legacy close-view op. It must never force `complete` over unresolved
      // findings; current clients clear their takeover URL locally, while old
      // clients receive the same success shape without corrupting settlement.
      const run = await getRun(runId);
      return Response.json({ ok: true, runId, phase: run?.phase ?? null, dismissed: true, reviewPreserved: true });
    }
    if (op === 'restart') {
      const resolverOwner = `su-${randomUUID()}`;
      const restarted = await restartRun({ runId, resolverOwner });
      if (!restarted.ok) {
        return Response.json(
          {
            error: {
              code: restarted.reason,
              message:
                restarted.reason === 'run_not_found'
                  ? `plan clean-up run ${runId} was not found`
                  : `plan clean-up run ${runId} is still healthy or no longer restartable`,
              runId,
              phase: restarted.phase,
            },
          },
          { status: restarted.reason === 'run_not_found' ? 404 : 409 },
        );
      }
      const launch = resolvePersistedResolverLaunch(restarted.run.launchSnapshot);
      if (!launch.ok || !launch.effective) {
        await setRunPhase({
          runId,
          phase: 'failed',
          error: launch.message ?? 'persisted launch settings are no longer valid',
        });
        await invalidateCleanupRun();
        return Response.json(
          {
            error: {
              code: 'invalid_persisted_launch_settings',
              message: launch.message ?? 'persisted launch settings are no longer valid',
              runId,
            },
          },
          { status: 409 },
        );
      }
      const harness = restarted.run.harnessSlug ?? operatorHomeHarnessSlug();
      const launched = await launchCleanupResolver(
        runId,
        restarted.run.seedRefs,
        harness,
        launch.effective,
        resolverOwner,
      );
      const phase = launched.ok ? 'running' : 'failed';
      await setRunPhase({
        runId,
        phase,
        resolverOwner,
        ...(launched.ok ? {} : { error: launched.error ?? 'restart launch failed' }),
      });
      await invalidateCleanupRun();
      return Response.json({
        ok: true,
        runId,
        phase,
        restarted: true,
        launched: launched.ok,
        preservedOutcomes: restarted.preservedOutcomes,
        ...(launched.ok ? {} : { launchError: launched.error }),
      });
    }
    if (op === 'resume') {
      const findingIds = Array.isArray(body.findingIds)
        ? body.findingIds.filter((id): id is string => typeof id === 'string').slice(0, 500)
        : [];
      const resolverOwner = `su-${randomUUID()}`;
      const resumed = await resumeReviewRun({ runId, itemIds: findingIds, resolverOwner });
      if (!resumed.ok) {
        return Response.json(
          {
            error: {
              code: resumed.reason,
              message: `plan clean-up run ${runId} could not resume selected findings`,
              runId,
              phase: resumed.phase,
            },
          },
          { status: resumed.reason === 'run_not_found' ? 404 : 409 },
        );
      }
      const launch = resolvePersistedResolverLaunch(resumed.run.launchSnapshot);
      if (!launch.ok || !launch.effective) {
        await setRunPhase({
          runId,
          phase: 'failed',
          error: launch.message ?? 'persisted launch settings are no longer valid',
        });
        await invalidateCleanupRun();
        return Response.json(
          { error: { code: 'invalid_persisted_launch_settings', message: launch.message, runId } },
          { status: 409 },
        );
      }
      const harness = resumed.run.harnessSlug ?? operatorHomeHarnessSlug();
      const launched = await launchCleanupResolver(
        runId,
        resumed.run.seedRefs,
        harness,
        launch.effective,
        resolverOwner,
      );
      const phase = launched.ok ? 'running' : 'failed';
      await setRunPhase({
        runId,
        phase,
        resolverOwner,
        ...(launched.ok ? {} : { error: launched.error ?? 'resume launch failed' }),
      });
      await invalidateCleanupRun();
      return Response.json({
        ok: true,
        runId,
        phase,
        resumed: true,
        launched: launched.ok,
        requeuedIds: resumed.requeuedIds,
        preservedOutcomes: resumed.preservedOutcomes,
        ...(launched.ok ? {} : { launchError: launched.error }),
      });
    }
    if (op === 'accept') {
      const findingId = typeof body.findingId === 'string' ? body.findingId.trim() : '';
      if (!findingId) {
        return Response.json(
          { error: { code: 'missing_finding_id', message: 'op "accept" requires findingId' } },
          { status: 400 },
        );
      }
      const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
      const accepted = await markCleanupFindingAccepted({ runId, findingId, note });
      if (!accepted.finding) {
        return Response.json(
          {
            error: {
              code: 'finding_not_reviewable',
              message: `${findingId} is not a recommended finding in review for run ${runId}`,
            },
          },
          { status: 404 },
        );
      }
      const run = await settleRunPhase({ runId });
      await invalidateCleanupRun();
      return Response.json({ ok: true, runId, findingId, phase: run?.phase ?? null, accepted: true });
    }
    if (op === 'dismiss-finding') {
      const findingId = typeof body.findingId === 'string' ? body.findingId.trim() : '';
      if (!findingId) {
        return Response.json(
          { error: { code: 'missing_finding_id', message: 'op "dismiss-finding" requires findingId' } },
          { status: 400 },
        );
      }
      const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
      const dismissed = await markCleanupFindingDismissed({ runId, findingId, note });
      if (!dismissed.finding) {
        return Response.json(
          {
            error: {
              code: 'finding_not_reviewable',
              message: `${findingId} is not unresolved in review for run ${runId}`,
            },
          },
          { status: 409 },
        );
      }
      const run = await settleRunPhase({ runId });
      await invalidateCleanupRun();
      return Response.json({ ok: true, runId, findingId, phase: run?.phase ?? null, dismissed: true });
    }
    if (op === 'recheck-finding') {
      const findingId = typeof body.findingId === 'string' ? body.findingId.trim() : '';
      if (!findingId) {
        return Response.json(
          { error: { code: 'missing_finding_id', message: 'op "recheck-finding" requires findingId' } },
          { status: 400 },
        );
      }
      const run = await getRun(runId);
      if (!run || run.runKind !== 'plan-cleanup' || run.phase !== 'review') {
        return Response.json(
          { error: { code: 'run_not_in_review', message: `plan clean-up run ${runId} is not awaiting owner review` } },
          { status: 409 },
        );
      }
      const current = (await getRunFindings(runId)).find((finding) => finding.findingId === findingId);
      if (!current) {
        return Response.json(
          { error: { code: 'finding_not_in_run', message: `${findingId} is not part of run ${runId}` } },
          { status: 404 },
        );
      }
      if (current.kind === 'semantic') {
        return Response.json(
          {
            error: { code: 'finding_not_recheckable', message: 'semantic findings require Retry or explicit Dismiss' },
          },
          { status: 409 },
        );
      }
      const stillPresent = (await scanCleanupRun(run, [current.planSlug])).some(
        (finding) => finding.findingId === findingId,
      );
      if (stillPresent) {
        return Response.json({ ok: true, runId, findingId, phase: run.phase, resolved: false });
      }
      const accepted = await markCleanupFindingAccepted({
        runId,
        findingId,
        note: 'Owner recheck confirmed the finding no longer exists in live plan state',
      });
      if (!accepted.finding) {
        return Response.json(
          {
            error: { code: 'finding_not_reviewable', message: `${findingId} could not be reconciled in run ${runId}` },
          },
          { status: 409 },
        );
      }
      const settled = await settleRunPhase({ runId });
      await invalidateCleanupRun();
      return Response.json({ ok: true, runId, findingId, phase: settled?.phase ?? null, resolved: true });
    }
    return Response.json(
      {
        error: {
          code: 'unknown_op',
          message: `op must be start | stop | restart | resume | reclassify | accept | recheck-finding | dismiss-finding | dismiss (got "${op}")`,
        },
      },
      { status: 400 },
    );
  } catch (error) {
    return Response.json(
      { error: { code: 'plan_cleanup_op_failed', message: error instanceof Error ? error.message : String(error) } },
      { status: 500 },
    );
  }
}

export async function planCleanupHandler(req: Request, ctx: RouteContext): Promise<Response> {
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Response.json({ error: { code: 'invalid_json', message: 'request body must be JSON' } }, { status: 400 });
  }
  const op = typeof body.op === 'string' ? body.op : 'start';
  const STOP_OPS = new Set(['stop', 'dismiss', 'recheck-finding', 'dismiss-finding', 'reclassify']);
  if (!STOP_OPS.has(op)) {
    const gated = await gateApiRoute(req, FLAGS.PLAN_CLEANUP);
    if (gated) return gated;
  }
  if (op !== 'start') return handleOwnerOp(op, body);

  const offered = normalizePlanSlugs(body.planSlugs);
  if (offered.length === 0) {
    return Response.json(
      {
        error: {
          code: 'no_plans',
          message: 'planSlugs[] must contain the exact plans currently shown in the pane',
        },
      },
      { status: 400 },
    );
  }
  const harness =
    typeof body.harness === 'string' && body.harness.trim() ? body.harness.trim() : operatorHomeHarnessSlug();
  const filter = body.filter && typeof body.filter === 'object' ? (body.filter as Record<string, unknown>) : {};

  // P-004 — PREFLIGHT BEFORE createRun, via the SAME validator the Inbox route
  // uses, so the two panes cannot drift into judging one profile differently.
  const preflight = preflightResolverLaunch(body.launch);
  if (!preflight.ok) return preflight.response;
  // P-006: the workspace standing policy is the source of truth; profile
  // policy fields are legacy launch controls and do not override it.
  const standingPolicy = await readStandingBulkAutomationPolicy();
  const automationPolicy = bulkAutomationSnapshot(standingPolicy);
  const launch = {
    ...preflight.launch,
    automationMode: automationPolicy.mode,
    minConfidence: automationPolicy.minConfidence,
  };

  try {
    // P-005 (plan-cleanup-system-repair-2026-10-01) — more plans than one run
    // may carry are ordered least-recently-scanned first and cut at
    // MAX_RUN_PLANS, and the cut is REPORTED ({requested, accepted, truncated})
    // so the pane can say "first N of M" instead of silently dropping the tail.
    const selection = await selectPlansLeastRecentlyScanned({ harnessSlug: harness, planSlugs: offered });
    const coverage = {
      requested: selection.requested,
      accepted: selection.accepted,
      truncated: selection.truncated,
    };
    // P-004 — the ONE start path, shared with the scheduled sweep routine.
    const started = await startPlanCleanupRun({
      planSlugs: selection.planSlugs,
      harness,
      filter,
      launch,
      automationPolicy,
      requestedBy: 'owner',
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (started.kind === 'already-active') {
      return Response.json(
        {
          error: {
            code: started.error.code,
            message: started.error.message,
            runId: started.error.activeRunId,
            phase: started.error.activePhase,
          },
        },
        { status: 409 },
      );
    }
    if (started.kind === 'authority-revoked') {
      return Response.json(
        {
          error: {
            code: 'plan_cleanup_authority_revoked',
            message: `plan clean-up run ${started.runId} stopped accepting deterministic writes (${started.phase})`,
            runId: started.runId,
            phase: started.phase,
            refusal: started.refusal,
          },
          deterministic: started.deterministic,
          launched: false,
          resolverNeeded: false,
          ...coverage,
        },
        { status: 409 },
      );
    }
    const { kind: _kind, ...settled } = started;
    return Response.json({ ok: true, ...settled, ...coverage });
  } catch (error) {
    return Response.json(
      { error: { code: 'plan_cleanup_start_failed', message: error instanceof Error ? error.message : String(error) } },
      { status: 500 },
    );
  }
}

const route = defineTool({
  method: 'POST',
  path: '/admin/plan-cleanup',
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  timeoutSec: 300,
  handler: planCleanupHandler,
});

export default [route];
