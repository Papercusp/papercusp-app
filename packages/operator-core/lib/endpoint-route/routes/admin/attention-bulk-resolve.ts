/**
 * POST /api/admin/attention-bulk-resolve — start a BULK RESOLVE run over the
 * items the Inbox pane is currently showing (inbox-bulk-resolve-2026-08-23,
 * P-002).
 *
 * Same admin-tier posture as coord-inbox-reply: the desktop webview hits the
 * operator loopback with no cookie/bearer, so `unverified-loopback` stays
 * admitted, with the CORS/CSRF backstop refusing a browser cross-origin POST.
 *
 * WHY THE CLIENT POSTS ITEM IDS RATHER THAN ITS FILTERS. `plans.attention` is a
 * live, SSE-invalidated feed. Re-deriving the owner's filtered set server-side
 * would resolve against a set that has moved since they looked, so the run could
 * silently act on an item they never saw — the one thing a bulk action must
 * never do. The client therefore posts the concrete id list it is rendering, and
 * `filter` rides along as human-readable provenance for the record only.
 *
 * Body: { items:[{ itemId, kind?, title?, ref?, ownerAgentId? }], filter?, harness? }
 *     → { ok, runId, phase, totalItems, launched, launchError? }
 *
 * A LAUNCH FAILURE IS NOT A REQUEST FAILURE. The run row is created first and
 * returned even when the resolver could not be launched: the owner then sees a
 * failed run naming the reason, with every item untouched and still resolvable
 * by hand, instead of a click that silently did nothing.
 *
 * THE OWNER-SIDE OPS ride the same route under an `op` discriminator (P-006),
 * because they share this route's admin-tier posture, its CSRF backstop and its
 * one sync invalidation — a separate route per verb would duplicate all three:
 *   { op:'stop',    runId }                     → settle the run where it stands
 *   { op:'accept',  runId, itemId, actionId }   → record an accepted recommendation
 *   { op:'reconcile-item', runId, itemId }       → record a verified hand resolution
 *   { op:'dismiss-item', runId, itemId }         → deliberately dismiss one review row
 *   { op:'undo-item', runId, itemId }            → execute its bounded compensation handle
 *   { op:'dismiss', runId }                     → close the run without acting
 *
 * `accept` RECORDS ONLY. The resolution itself is dispatched CLIENT-side through
 * the same `resolveAttentionAction` / `replyToAttentionItem` helpers a hand
 * resolve uses, so asker-wake, provenance and the triage audit note are produced
 * by exactly one code path (D-003). Re-deriving the resolve here would fork that
 * behavior into a second implementation that drifts silently.
 */

import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { requireAllowedOriginOr403 } from '../../cors';
import { gateApiRoute } from '../../../require-flag';
import { buildAgentLaunchCommand } from '../../../agent-launch-core';
import { resolveBulkResolverLaunch, type EffectiveBulkResolverLaunch } from '../../../agent-config-constants';
import type { SpawnConsoleResult } from '../../../console-spawn';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';
import {
  BulkRunAlreadyActiveError,
  createRun,
  failRunIfExecuting,
  getRun,
  restartRun,
  resumeReviewRun,
  markItemAccepted,
  markItemDismissed,
  reclassifyLegacySkipped,
  setRunPhase,
  settleRunPhase,
  type BulkRunLaunchSnapshot,
  type BulkRunSeedItem,
} from '../../../attention/bulk-run-store';
import { notifyBulkRunChanged } from '../../../attention/bulk-run-sync';
import {
  bulkAutomationSnapshot,
  normalizeBulkAutomationPolicy,
  type BulkAutomationPolicy,
} from '../../../attention/bulk-dispositions';
import { readStandingBulkAutomationPolicy } from '../../../attention/automation-policy';

/** Cap one run so a mis-click on an unfiltered inbox cannot enqueue thousands. */
const MAX_RUN_ITEMS = 200;

function parseItems(raw: unknown): BulkRunSeedItem[] {
  if (!Array.isArray(raw)) return [];
  const out: BulkRunSeedItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const itemId = typeof o.itemId === 'string' ? o.itemId.trim() : '';
    if (!itemId) continue;
    out.push({
      itemId,
      kind: typeof o.kind === 'string' ? o.kind : null,
      title: typeof o.title === 'string' ? o.title.slice(0, 1000) : null,
      ref: o.ref && typeof o.ref === 'object' ? (o.ref as Record<string, unknown>) : {},
      ownerAgentId: typeof o.ownerAgentId === 'string' ? o.ownerAgentId : null,
    });
    if (out.length >= MAX_RUN_ITEMS) break;
  }
  return out;
}

/**
 * The resolver's brief. Written here rather than in a prompt file because it has
 * to name THIS run id, and because its policy half is the plan's D-001/D-002
 * decisions restated where the launch can actually enforce them.
 */
export function buildResolverBrief(
  runId: string,
  itemCount: number,
  policy: BulkAutomationPolicy = { mode: 'safe-high', minConfidence: 'high' },
): string {
  return [
    `You are the BULK RESOLVE resolver for run ${runId}. The owner is clearing their Inbox and has`,
    `asked you to settle ${itemCount} attention item(s) they filtered down to.`,
    '',
    'LOOP:',
    `1. inbox:bulk-run-manifest { runId: "${runId}" } — read the run and every item, each with the`,
    '   LIVE options it actually offers. An option with terminal:false only opens a sub-surface and',
    '   resolves nothing; never treat one as a resolution.',
    `2. For EVERY item, produce one typed disposition and a next-step recommendation. The run policy is ${policy.mode} (minimum confidence ${policy.minConfidence}).`,
    '   A recommendation may carry an actionId only when the manifest offers that real terminal',
    '   action; owner_action, cleanup_candidate, retry_needed, routed, and investigate may omit it.',
    '   Never leave an item as an unexplained skip.',
    '   For each item, decide:',
    '   - AUTO-RESOLVE when you can settle it from evidence: the ask is moot (its blocker already',
    '     cleared, the work already landed), it duplicates another item, it is a stale FYI, or it is a',
    '     plain acknowledgement. You have full authority to take the terminal action, INCLUDING',
    '     delivering a derivable answer to the asking agent (which wakes them). Record WHY — that',
    "     rationale is the audit note for something done on the owner's behalf.",
    '   - CONSULT when you cannot settle it alone AND the item names an asking agent that is live or',
    '     parked (check coord:presence). Send them a directed coord:send asking them to either resolve',
    '     or withdraw their own ask right now, or reply with their recommended option id and a one-line',
    '     why. Give them a bounded window (~10 min). A reply that arrives lets you report the item',
    '     auto_resolved or recommended with confidence:"high"; a lapse means you recommend anyway with',
    '     confidence:"low" so the owner sees it is an inference, not evidence.',
    '   - RECOMMEND otherwise: choose recommendationKind from owner_action, cleanup_candidate,',
    '     retry_needed, routed, or investigate; provide a concise label, evidenceBasis, responsibility,',
    '     confidence (high|medium|low|insufficient), and rationale. Include a proposed actionId only',
    '     when it is genuinely offered by the manifest.',
    '   - RETRY-NEEDED when the item detail/actions are unavailable; this is a typed recommendation,',
    '     not the legacy skipped outcome. Use skipped only for backward-compatible reporting when a',
    '     caller cannot yet provide the typed fields, and always include its specific error.',
    `3. AUTO-RESOLVE only through inbox:bulk-run-act { runId: "${runId}", itemId, actionId,`,
    "   rationale, ... }. It is intentionally one action per call: the tool holds the run's revocable",
    '   authority lock across the real terminal dispatch, required audit row, outcome and counters.',
    '   Report all non-action outcomes through inbox:bulk-run-report { items:[...] } with the typed',
    '   disposition/recommendation fields. Batch them; do not call report once per item.',
    `4. inbox:bulk-run-settle { runId: "${runId}" } when every item is reported.`,
    '',
    'RULES:',
    '- NEVER invent an option id. Only ids the manifest listed for that item are accepted.',
    '- A rationale is REQUIRED on every auto_resolved outcome; bulk-run-act is the only verb that',
    '  can write one. A reason is REQUIRED on skipped/failed reports.',
    "- inbox:bulk-run-report rejects auto_resolved. Never dispatch an item's backing verb directly;",
    '  only bulk-run-act can prove Stop had not revoked your authority before the action began.',
    "- Prefer recommending over resolving when the item turns on the owner's preference, money, an",
    '  irreversible action, or anything only they can know. Speed is not worth a wrong resolution.',
    '- Look for cross-item structure: several escalations with one root cause should be resolved',
    '  consistently, not judged independently.',
    '- If you must give up, inbox:bulk-run-settle { failed: true, error } so the owner sees why.',
    '',
    'STOPPING (WI-41022) — Stop is authoritative at the bulk-run-act boundary:',
    "- Every manifest/action/report call refreshes this resolver owner's run heartbeat. Re-read the",
    '  manifest before each batch; that is both the authority check and the liveness cadence.',
    '- The manifest carries `stopped`. Re-read the manifest before each BATCH of terminal actions,',
    '  and the moment `stopped` is true, HALT: take no further terminal action on any item, do not',
    "  report, and do not re-route the work to an item's own verb outside the run. Stopping is the",
    '  owner withdrawing your authority, not a hint to finish faster.',
    '- bulk-run-act and Stop take the SAME run-row lock. If Stop commits first, bulk-run-act refuses',
    '  BEFORE entering the terminal callback. If an action commits first, Stop waits for its required',
    '  audit + outcome + counters, then settles with that action visible. There is no cooperative',
    '  check-then-act gap. A post_dispatch_persistence_failed response is a loud partial incident:',
    '  do NOT retry the terminal action; report its reconciliationRequired payload immediately.',
    '- inbox:bulk-run-report can still refuse non-action reports after Stop; nothing in that report',
    '  was recorded, and you must halt rather than route around the run.',
  ].join('\n');
}

/**
 * Compose the actual resolver process command through the shared scripted-agent
 * builder. `spawnHeadless` only decides WHERE a command runs; it does not turn a
 * shell greeting into an agent. The old route handed it buildConsoleEnvelope's
 * default `papercup status` greeting, which printed the five-line status banner,
 * exited, and left the run labelled `running` forever.
 */
export function buildResolverLaunchCommand(input: {
  workspaceId: string;
  harness: string;
  ownerId: string;
  /** Preflighted click-time settings (P-004). Omitted ⇒ the pre-configuration
   *  defaults this route has always launched on, so an older client that posts
   *  no settings is byte-identical to before. `agent` comes from the DERIVED
   *  backend rather than a hardcoded 'claude' (D-002); `mode`, `headless` and
   *  `role` stay fixed launch invariants and are deliberately not configurable. */
  launch?: EffectiveBulkResolverLaunch | null;
}): string {
  const launch = input.launch ?? null;
  return buildAgentLaunchCommand({
    mode: 'fresh',
    agent: launch?.backend ?? 'claude',
    account: launch?.account ?? 'default',
    model: launch?.model ?? null,
    effort: launch?.effort ?? null,
    workspace: input.workspaceId,
    harness: input.harness,
    ownerId: input.ownerId,
    headless: true,
    carry: launch?.carry ?? 'warm',
    role: 'su',
  });
}

/**
 * Preflight the posted settings into a 400, or into the exact snapshot the run
 * records and launches with. Shared by both start routes so Inbox and Plans
 * cannot drift into validating the same profile differently.
 *
 * A body with no `launch` key resolves to the defaults rather than refusing:
 * a client that has not been updated must keep working.
 */
export function preflightResolverLaunch(
  raw: unknown,
): { ok: true; launch: EffectiveBulkResolverLaunch } | { ok: false; response: Response } {
  const posted = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const resolved = resolveBulkResolverLaunch(posted as Parameters<typeof resolveBulkResolverLaunch>[0]);
  if (!resolved.ok || !resolved.effective) {
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: 'invalid_launch_settings',
            message: resolved.message ?? 'resolver launch settings are not launchable',
            field: resolved.field,
          },
        },
        { status: 400 },
      ),
    };
  }
  return { ok: true, launch: resolved.effective };
}

/** Rehydrate the exact click-time profile for restart. `backend` is derived
 * again from the persisted model (D-002); nullable legacy fields inherit the
 * same defaults the original start route used. */
export function resolvePersistedResolverLaunch(snapshot: BulkRunLaunchSnapshot) {
  return resolveBulkResolverLaunch({
    model: snapshot.model ?? null,
    effort: snapshot.effort ?? null,
    account: snapshot.account ?? 'default',
    carry: snapshot.carry ?? 'warm',
    ...(snapshot.automationPolicy
      ? {
          automationMode: snapshot.automationPolicy.mode,
          minConfidence: snapshot.automationPolicy.minConfidence,
        }
      : {}),
  });
}

export type ResolverSpawnOutcome = { ok: true; sessionId: string; child: ChildProcess } | { ok: false; error: string };

/**
 * Translate the spawner's discriminated result instead of treating "the call
 * returned" as success. The incident's second fault was reading a nonexistent
 * `sessionId` property from BOTH result variants and returning ok:true even when
 * spawnHeadless had explicitly returned status:'error'.
 */
export function resolverSpawnOutcome(result: SpawnConsoleResult, resolverOwner: string): ResolverSpawnOutcome {
  if (result.status !== 'ok') return { ok: false, error: result.error };
  if (!result.child) {
    return {
      ok: false,
      error: 'headless resolver launch returned no process handle; liveness cannot be supervised',
    };
  }
  return { ok: true, sessionId: resolverOwner, child: result.child };
}

/**
 * Launch the resolver. Best-effort by design: every failure path returns a
 * reason rather than throwing, so the caller can record it on the run.
 */
/** Shared supervised launcher used by the owner route and the durable scheduled
 * resolver. Keeping this seam here means scheduled starts and click starts use
 * the exact same command, brief, child-exit supervision and failure handling. */
export async function launchResolver(
  runId: string,
  itemCount: number,
  harness: string | null,
  launch: EffectiveBulkResolverLaunch | null,
  resolverOwner: string,
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  try {
    const [{ buildConsoleEnvelope }, { spawnHeadless }, { activeWorkspaceId }, { resolveSpawnHostOperatorBaseUrl }] =
      await Promise.all([
        import('../../../console-launcher'),
        import('../../../console-spawn'),
        import('../../../workspace-registry'),
        import('../../../mcp-base-url'),
      ]);

    const workspaceId = activeWorkspaceId();
    // The middle-pane Inbox is workspace-scoped and therefore sends no harness.
    // A fresh psu launch without --harness is a plain agent (no su bootstrap or
    // inbox tools), so bind it to the workspace's canonical home harness.
    const effectiveHarness = harness?.trim() || operatorHomeHarnessSlug();
    const greetingCmd = buildResolverLaunchCommand({
      workspaceId,
      harness: effectiveHarness,
      ownerId: resolverOwner,
      launch,
    });

    const envelope = await buildConsoleEnvelope({
      workspaceId,
      slug: effectiveHarness,
      operatorBaseUrl: await resolveSpawnHostOperatorBaseUrl(),
      headless: true,
      role: 'su',
    } as Parameters<typeof buildConsoleEnvelope>[0]);

    // The brief rides PAPERCUSP_KICKOFF_PROMPT (never a `--kickoff=` value):
    // free-form prose inside a console one-liner is a quoting hazard, and the
    // env var is the spawn-safe path capability:launch-agent itself uses.
    const res = await spawnHeadless({
      envelope: {
        ...envelope,
        greetingCmd,
        env: {
          ...envelope.env,
          PAPERCUSP_KICKOFF_PROMPT: buildResolverBrief(
            runId,
            itemCount,
            normalizeBulkAutomationPolicy({
              mode: launch?.automationMode,
              minConfidence: launch?.minConfidence,
            }),
          ),
        },
      },
      label: `bulk-resolve-${runId.slice(0, 12)}`,
      coordOwnerId: resolverOwner,
      launchedBy: 'attention-bulk-resolve',
    });

    const outcome = resolverSpawnOutcome(res, resolverOwner);
    if (!outcome.ok) return outcome;

    // spawnHeadless catches boot-time death. This observer covers the next
    // window: if the real agent exits after launch was acknowledged but before
    // it settles the run, atomically fail the still-executing run and push the
    // terminal phase to the strip. Once review/complete wins, this is a no-op.
    let exitHandled = false;
    const failForExit = (detail: string): void => {
      if (exitHandled) return;
      exitHandled = true;
      void failRunIfExecuting({
        runId,
        workspaceId,
        resolverOwner,
        error: `resolver process ended before settling the run: ${detail}`,
      })
        .then(async (failed) => {
          if (failed) await invalidateBulkRun();
        })
        .catch(() => {
          // The run remains visible and Stop still works. Never crash the route
          // process from a detached child's late diagnostic callback.
        });
    };
    outcome.child.once('error', (error) => failForExit(error.message));
    outcome.child.once('exit', (code, signal) =>
      failForExit(signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`),
    );

    return { ok: true, sessionId: outcome.sessionId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Push the new run/item state to every mounted strip. Best-effort: the poll
 *  fallback still picks it up, so a notify failure must never fail the op. */
async function invalidateBulkRun(): Promise<void> {
  try {
    await notifyBulkRunChanged();
  } catch {
    /* the poll fallback still picks it up */
  }
}

/**
 * The three owner-side ops. Each returns the run's resulting phase so the strip
 * can render from the response without waiting for the SSE round-trip.
 */
async function handleOwnerOp(op: string, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (!runId) {
    return Response.json({ error: { code: 'missing_run_id', message: `op "${op}" requires runId` } }, { status: 400 });
  }

  try {
    if (op === 'reclassify') {
      const itemIds = Array.isArray(body.itemIds)
        ? body.itemIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_RUN_ITEMS)
        : undefined;
      const result = await reclassifyLegacySkipped({ runId, itemIds });
      if (result.refused) {
        return Response.json(
          {
            error: {
              code: result.refused,
              message: `bulk-resolve run ${runId} is not in owner review`,
              runId,
            },
          },
          { status: result.refused === 'run_not_found' ? 404 : 409 },
        );
      }
      await invalidateBulkRun();
      return Response.json({
        ok: true,
        runId,
        reclassified: result.updated.length,
        itemIds: result.updated.map((item) => item.itemId),
        phase: result.run?.phase ?? null,
      });
    }

    if (op === 'stop') {
      // Settle where it stands rather than forcing `complete`: settleRunPhase
      // derives the phase from the ITEM ROWS, so a stop mid-run parks in
      // `review` with whatever the resolver got through — including the items
      // it never reached, which stay `pending` and are shown as not-reached
      // rather than silently dropped (Requirement 2).
      const run = await settleRunPhase({ runId });
      await invalidateBulkRun();
      return Response.json({ ok: true, runId, phase: run?.phase ?? null, stopped: true });
    }

    if (op === 'dismiss') {
      // Legacy close-view op. Never force `complete` over unresolved rows:
      // current clients clear the report URL locally, while old clients get a
      // success response that preserves the honest review phase.
      const run = await getRun(runId);
      return Response.json({
        ok: true,
        runId,
        phase: run?.phase ?? null,
        dismissed: true,
        reviewPreserved: true,
      });
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
                  ? `bulk-resolve run ${runId} was not found`
                  : `bulk-resolve run ${runId} is still healthy or no longer restartable`,
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
        await invalidateBulkRun();
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
      const launched = await launchResolver(
        runId,
        restarted.run.totalItems,
        restarted.run.harnessSlug,
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
      await invalidateBulkRun();
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
      const itemIds = Array.isArray(body.itemIds)
        ? body.itemIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_RUN_ITEMS)
        : [];
      const resolverOwner = `su-${randomUUID()}`;
      const resumed = await resumeReviewRun({ runId, itemIds, resolverOwner });
      if (!resumed.ok) {
        return Response.json(
          {
            error: {
              code: resumed.reason,
              message: `bulk-resolve run ${runId} could not resume selected review rows`,
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
        await invalidateBulkRun();
        return Response.json(
          { error: { code: 'invalid_persisted_launch_settings', message: launch.message, runId } },
          { status: 409 },
        );
      }
      const launched = await launchResolver(
        runId,
        resumed.run.totalItems,
        resumed.run.harnessSlug,
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
      await invalidateBulkRun();
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
      const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : '';
      const actionId = typeof body.actionId === 'string' ? body.actionId.trim() : '';
      if (!itemId || !actionId) {
        return Response.json(
          {
            error: {
              code: 'missing_accept_fields',
              message: 'op "accept" requires itemId and actionId',
            },
          },
          { status: 400 },
        );
      }
      const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
      const item = await markItemAccepted({ runId, itemId, actionId, note });
      if (!item) {
        return Response.json(
          {
            error: {
              code: 'item_not_in_run',
              message: `item ${itemId} is not part of run ${runId}`,
            },
          },
          { status: 404 },
        );
      }
      // An accept can be the LAST one — re-settle so the strip leaves `review`
      // on its own instead of stranding the owner on an empty review list.
      const run = await settleRunPhase({ runId });
      await invalidateBulkRun();
      return Response.json({ ok: true, runId, itemId, phase: run?.phase ?? null, accepted: true });
    }

    if (op === 'undo-item') {
      const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : '';
      if (!itemId) {
        return Response.json(
          { error: { code: 'missing_undo_item_id', message: 'op "undo-item" requires itemId' } },
          { status: 400 },
        );
      }
      const [{ activeWorkspaceId }, { revertAttentionBulkItemHandle }] = await Promise.all([
        import('../../../workspace-registry'),
        import('../../../attention/bulk-run-reversal'),
      ]);
      const outcome = await revertAttentionBulkItemHandle({
        kind: 'attention-bulk-item',
        workspaceId: activeWorkspaceId(),
        runId,
        itemId,
      });
      if (!outcome.reverted) {
        return Response.json(
          { error: { code: 'undo_refused', message: outcome.note, runId, itemId } },
          { status: 409 },
        );
      }
      await invalidateBulkRun();
      return Response.json({ ok: true, runId, itemId, reverted: true, note: outcome.note });
    }

    if (op === 'reconcile-item' || op === 'dismiss-item') {
      const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : '';
      if (!itemId) {
        return Response.json(
          {
            error: {
              code: 'missing_review_item_id',
              message: `op "${op}" requires itemId`,
            },
          },
          { status: 400 },
        );
      }
      const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
      // Both operations are BOOKKEEPING for an explicit owner decision. A hand
      // resolution has already succeeded on the source surface before
      // `reconcile-item` is offered; `dismiss-item` deliberately declines only
      // this unresolved review row. Neither path dispatches a source action.
      const item =
        op === 'dismiss-item'
          ? await markItemDismissed({ runId, itemId, note })
          : await markItemAccepted({
              runId,
              itemId,
              actionId: 'manual',
              note: note ?? 'Owner rechecked the live source after resolving it manually',
            });
      if (!item) {
        return Response.json(
          {
            error: {
              code: 'review_item_not_actionable',
              message: `item ${itemId} is not an unresolved review row in run ${runId}`,
            },
          },
          { status: 409 },
        );
      }
      // This row can be the final owner obligation. Settlement must happen
      // AFTER its durable disposition or the run can remain stranded in review.
      const run = await settleRunPhase({ runId });
      await invalidateBulkRun();
      return Response.json({
        ok: true,
        runId,
        itemId,
        phase: run?.phase ?? null,
        ...(op === 'dismiss-item' ? { dismissed: true } : { reconciled: true }),
      });
    }

    return Response.json(
      {
        error: {
          code: 'unknown_op',
          message: `op must be one of start | stop | restart | resume | accept | undo-item | reconcile-item | dismiss-item | dismiss (got "${op}")`,
        },
      },
      { status: 400 },
    );
  } catch (e) {
    return Response.json(
      {
        error: {
          code: 'bulk_resolve_op_failed',
          message: e instanceof Error ? e.message : String(e),
        },
      },
      { status: 500 },
    );
  }
}

async function handler(req: Request, _ctx: RouteContext): Promise<Response> {
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;

  let body: Record<string, unknown> = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt) as Record<string, unknown>;
  } catch {
    return Response.json({ error: { code: 'invalid_json', message: 'request body must be JSON' } }, { status: 400 });
  }

  const op = typeof body.op === 'string' ? body.op : 'start';

  // WI-41021 — THE FLAG GATES ACTING, NEVER STOPPING.
  //
  // The flag still has to cut the WRITE SEAM and not just the strip: InboxPane
  // gates the UI with useFlag, but a client-only gate leaves this route reachable
  // while the feature is "off", and `op:'start'` LAUNCHES A REAL HEADLESS RESOLVER
  // AGENT that then acts on the owner's inbox. A kill switch that still spawns
  // agents is not a kill switch.
  //
  // But the previous version gated the WHOLE handler, above this point, and that
  // was backwards. Every owner op routes through here, so a blanket gate ALSO 404'd
  // `op:'stop'` — flipping the kill switch took away the owner's kill button. And
  // it bought nothing, because the resolver does not drive a run through this route
  // at all: it uses inbox:bulk-run-* (gated separately, same rule). So the flag-off
  // state was the worst of both — the owner could not stop the run, and the agent
  // could not be stopped.
  //
  // STOP_OPS are therefore ALWAYS reachable, flag or no flag. `stop` is the kill
  // path itself; `dismiss` only closes a review list the owner is already looking
  // at, and refusing it strands them with a list they cannot clear. Everything else
  // — `start` (spawns an agent) and `accept` (takes a terminal action on the
  // owner's behalf) — is ACTING, and stays gated. Nothing is lost by gating
  // `accept`: every recommended item remains resolvable by hand in the pane.
  const STOP_OPS = new Set(['stop', 'dismiss', 'undo-item', 'reconcile-item', 'dismiss-item', 'reclassify']);
  if (!STOP_OPS.has(op)) {
    const gated = await gateApiRoute(req, FLAGS.INBOX_BULK_RESOLVE);
    if (gated) return gated;
  }

  if (op !== 'start') return handleOwnerOp(op, body);

  const items = parseItems(body.items);
  if (items.length === 0) {
    return Response.json(
      {
        error: {
          code: 'no_items',
          message: 'items[] must carry at least one { itemId } — a run over nothing is never correct',
        },
      },
      { status: 400 },
    );
  }

  const harness = typeof body.harness === 'string' && body.harness.trim() ? body.harness.trim() : null;
  const filter = body.filter && typeof body.filter === 'object' ? (body.filter as Record<string, unknown>) : {};

  // P-004 — PREFLIGHT BEFORE createRun. An unlaunchable setting must not leave a
  // created-then-failed run in the owner's history when retyping one field fixes it.
  const preflight = preflightResolverLaunch(body.launch);
  if (!preflight.ok) return preflight.response;
  // P-006: launch policy comes from the standing workspace row. Any policy
  // fields in body.launch are legacy profile knobs and are ignored here; the
  // run stores this exact value as its immutable audit receipt.
  const standingPolicy = await readStandingBulkAutomationPolicy();
  const automationPolicy = bulkAutomationSnapshot(standingPolicy);
  const launch = {
    ...preflight.launch,
    automationMode: automationPolicy.mode,
    minConfidence: automationPolicy.minConfidence,
  };

  try {
    const run = await createRun({
      items,
      filterSnapshot: filter,
      launchSnapshot: launch,
      automationPolicy,
      requestedBy: 'owner',
      harnessSlug: harness,
    });

    const resolverOwner = `su-${randomUUID()}`;
    await setRunPhase({ runId: run.runId, phase: 'pending', resolverOwner });
    const launched = await launchResolver(run.runId, items.length, harness, launch, resolverOwner);
    if (launched.ok) {
      await setRunPhase({ runId: run.runId, phase: 'running', resolverOwner });
    } else {
      // Requirement 8: a failed launch is visible as a failed run with its items
      // intact — never a click that silently did nothing.
      await setRunPhase({ runId: run.runId, phase: 'failed', error: launched.error ?? 'launch failed' });
    }

    await invalidateBulkRun();

    return Response.json({
      ok: true,
      runId: run.runId,
      phase: launched.ok ? 'running' : 'failed',
      totalItems: run.totalItems,
      launched: launched.ok,
      ...(launched.ok ? {} : { launchError: launched.error }),
    });
  } catch (e) {
    // WI-41012 — a run is already pending/running. This is the ONE start-path
    // failure that is not an error in the caller: the owner (or a double-click)
    // asked for a second run while an agent is mid-flight over overlapping
    // items. Answer 409 naming the run already in flight so the strip can point
    // at it, rather than a 500 that reads like the feature broke.
    if (e instanceof BulkRunAlreadyActiveError) {
      return Response.json(
        {
          error: {
            code: e.code,
            message: e.message,
            runId: e.activeRunId,
            phase: e.activePhase,
          },
        },
        { status: 409 },
      );
    }
    return Response.json(
      {
        error: {
          code: 'bulk_resolve_start_failed',
          message: e instanceof Error ? e.message : String(e),
        },
      },
      { status: 500 },
    );
  }
}

const route = defineTool({
  method: 'POST',
  path: '/admin/attention-bulk-resolve',
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  handler,
});

export default [route];
