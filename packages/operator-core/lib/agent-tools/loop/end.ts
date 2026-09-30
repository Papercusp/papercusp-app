/**
 * loop:end — end the engine-managed loop on your own session (or another owner's,
 * with `ownerId`): stop the recurring warm wake (loop-routines-interval-recurrence-
 * 2026-06-20, B-LOOP-5 / P-008). The routine is DEACTIVATED (the row is kept for
 * fire-history + a quick re-arm). Deliberately NOT flag-gated — you must always be
 * able to stop a loop you armed, even if the loop feature flag was later turned off.
 *
 * P-002 (goal-mode-design-intent-hardening-2026-08-16): a GOAL-mode owner whose
 * goal is still ACTIVE must pass `disposition` (achieved | killed | handoff) —
 * the platform then records it on the goal and delivers the owner report built
 * from the loop carry-note + `reason`. The gate itself is flag-gated
 * (GOAL_WINDDOWN_DISPOSITION_GATE, fail-CLOSED) so the stop path can never be
 * wedged by flag infra; the STOP itself stays unflagged.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity, resolveSelfLiteral } from '../coordination/identity';
import { deactivateLoop, getLoopStatus } from '../../harness/routines/loop';
import { activeWorkspaceId } from '../../workspace-registry';
import { refreshControlAnchorAfterMutation } from '../coordination/control-anchor';
import {
  GOAL_DISPOSITIONS,
  activeGoalForOwner,
  applyGoalDisposition,
  buildDispositionRefusal,
  evaluateGoalAcceptanceGate,
  buildGoalWindDownReport,
  deliverGoalWindDownReport,
  windDownDispositionGateEnabled,
} from '../../goals/wind-down-disposition';
import { evaluateGoalWindDownOutputs } from '../../goals/goal-io-validation';
import { getLoopCarryNote } from '../../carry-note';
import { listActiveAwaits, listParkedAwaitsForSubscribers, INBOX_WAKE_KEY_PREFIX } from '../../events/await/store';
import { listActiveComposedRoots } from '../../events/await/compose-store';
import { getModes } from '../../modes/store';
import { modeImpliesAutonomy } from '../../modes/registry';
import {
  readFleetParkResumePathForOwner,
  readFleetWindDownLoopEndRequirement,
  readFleetWindDownLoopEndAuthorization,
} from '../coordination/tools/continuation-gate';
import { describeParkResumePath } from '../../fleet-park-resume-path';

/** Bound the receipt's surviving-awaits enumeration (the count stays exact). */
const SURVIVING_AWAITS_LISTED_CAP = 10;

/**
 * EI-21349668185386229: the receipt used to say "no further wakes will fire",
 * which is false for the OTHER wake sources the same owner may hold — event
 * awaits (events:await, work-item interest watches, timed awaits) are a
 * SEPARATE lifecycle and survive loop:end, and a queued loop fire can still
 * land (delivery-time supersession banner, EI-18825117783927950 in
 * wake-executor.ts). Observed live: an owner ended the loop, was told nothing
 * would fire, and was woken minutes later by a surviving await it then had to
 * hunt down via events:status. So the receipt scopes its claim to LOOP wakes
 * and enumerates the surviving awaits itself. The always-armed
 * `coord:inbox-wake:` self-wake is liveness plumbing every live agent holds —
 * excluded, not a deliberate bench (but by SHAPE, not by key alone — see
 * isKeepaliveInboxWake).
 */

/**
 * Is this await the always-armed `coord:inbox-wake:` KEEPALIVE — liveness plumbing
 * every live agent holds — as opposed to one a caller DELIBERATELY registered on
 * that same key?
 *
 * WI-2146110 / EI-22395297051930111: this exclusion used to be a KEY-PREFIX test
 * alone, which cannot tell those two apart. So a deliberate
 * `events:await { event: 'coord:inbox-wake:<owner>', timeout_sec: 3600, on_timeout: 'wake' }`
 * was filtered out of `survivingAwaits`, and the receipt then asserted "no independent
 * event awaits remain active for this owner" while that bounded await was live — it
 * woke the session ~16s later. A false statement about live state is worse than the
 * blanket claim EI-21349668185386229 already removed, because it reads as a checked one.
 *
 * The two populations separate cleanly by SHAPE, not by key: the keepalive is UNBOUNDED
 * and merely EXPIRES, while a deliberate await is BOUNDED and WAKES on its deadline.
 * Measured 2026-09-05: all 83 then-active `coord:inbox-wake:*` rows were uniformly
 * `timeout_behavior='expire'` with `expires_ts IS NULL`.
 *
 * Deliberately NOT `awaitGuaranteesRewake` (turn-end-tracking.ts): that helper excludes
 * EVERY inbox-wake key unconditionally, which is correct for its own question ("will I
 * be re-woken?") and wrong for this one ("what survives this stop and could still wake
 * me?"). Reusing it here would preserve the exact bug this fixes.
 *
 * An UNBOUNDED await deliberately placed on the keepalive key stays excluded: it is
 * indistinguishable from the keepalive by shape, and cannot be relied on to wake anyone
 * anyway (the same boundedness reasoning as WI-6604).
 */
export function isKeepaliveInboxWake(a: {
  eventKey: string;
  expiresTs?: string | null;
  timeoutBehavior?: string | null;
  explicitPark?: boolean;
}): boolean {
  if (!a.eventKey.startsWith(INBOX_WAKE_KEY_PREFIX)) return false;
  // coord:await-inbox deliberately annotates the same standing key. The marker
  // is authoritative even though this park is unbounded and therefore cannot
  // be recognized from timeout shape alone.
  if (a.explicitPark === true) return false;
  // `timeoutBehavior` defaults to 'wake' (the store's own default), matching
  // awaitGuaranteesRewake's reading of the same column.
  return a.expiresTs == null || (a.timeoutBehavior ?? 'wake') !== 'wake';
}

export function survivingAwaitsNote(
  surviving: { await_id: number; event_key: string; root_id?: number }[] | null,
): string {
  if (surviving === null) {
    // The read failed — still never restate the disproven blanket claim.
    return 'Loop ended — no further LOOP wakes will fire. Independent event awaits (if any) are a separate lifecycle and survive this stop — events:status to inspect; cancel ordinary awaits with events:cancel { await_ids } and composed trees with events:cancel { root_ids }.';
  }
  if (surviving.length === 0) {
    return 'Loop ended — no further loop wakes will fire, and no independent event awaits remain active for this owner.';
  }
  const listed = surviving
    .slice(0, SURVIVING_AWAITS_LISTED_CAP)
    .map((a) => (a.root_id == null ? `#${a.await_id} ${a.event_key}` : `root #${a.root_id} ${a.event_key}`))
    .join(', ');
  const more =
    surviving.length > SURVIVING_AWAITS_LISTED_CAP ? `, +${surviving.length - SURVIVING_AWAITS_LISTED_CAP} more` : '';
  const cancellationAdvice = [
    surviving.some((a) => a.root_id == null) ? 'ordinary awaits with events:cancel { await_ids }' : null,
    surviving.some((a) => a.root_id != null) ? 'composed trees with events:cancel { root_ids }' : null,
  ]
    .filter((advice): advice is string => advice !== null)
    .join(' and ');
  return (
    `Loop ended — no further LOOP wakes will fire, but ${surviving.length} independent event await(s) remain active and CAN still wake this session: ${listed}${more}. ` +
    `They are a separate lifecycle (loop:end never cancels them). Inspect via events:status; cancel ${cancellationAdvice} deliberately — leave interest watches you did not create.`
  );
}

export default defineTool({
  name: 'loop:end',
  profile: 'engineer',
  description:
    "End the owner-scoped loop on your own session (or another owner's, with `ownerId`) — stops the recurring warm wake. The routine is deactivated (history kept); an optional `reason` is recorded in the transition log. A GOAL-mode owner with a still-active goal must also pass `disposition` (achieved | killed | handoff) — the wind-down report to the owner is generated from the loop carry-note + reason. Loops are keyed by owner, not by harness; a `harness` arg is accepted for compatibility but has no effect. Re-arm anytime with loop:arm.",
  guidance: {
    when: 'Stop a loop you armed with loop:arm — the goal is done, you are blocked on something external, or the user says stop. Pass `reason` when a durable stop explanation matters; the call is owner-scoped and ignores `harness`. In GOAL mode with the goal still active, also pass `disposition` (achieved | killed | handoff — handoff takes `handoffTo`). AUTO still on with no event await? The stop REFUSES until `acknowledgeWakeLessAutonomy:true` — pass it in the FIRST call (still required for a finished goal). Better to loop:end than burn empty wakes spinning.',
    notWhen:
      'Pause the WHOLE autoloop / routines engine — that is autoloop:control. End the autonomous hive loop — that is pot:pause.',
    chaining:
      'loop:arm to start; loop:status to check; events:await to preserve an independent wake before ending an autonomous loop; loop:end to stop.',
    seeAlso: [
      'loop:arm (start a loop)',
      'loop:status (check it)',
      'autoloop:control (pause the whole autoloop engine)',
    ],
  },
  capability: 'routines:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Accepted for compatibility and IGNORED — loops are keyed by owner, not by harness, so this has no effect. Present only because nearly every other tool in this catalog takes a `harness` arg and callers reasonably reach for it out of habit; omit it, or pass anything.',
      ),
    ownerId: z.string().max(120).optional().describe('End the loop for this owner id (default: yourself).'),
    reason: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Optional durable reason for ending the loop; recorded in the loop transition log.'),
    disposition: z
      .enum(GOAL_DISPOSITIONS)
      .optional()
      .describe(
        "GOAL-mode wind-down verdict, REQUIRED when the target owner's goal is still active: 'achieved' | 'killed' | 'handoff'. Recorded on the goal; the owner report is auto-generated from the loop carry-note + `reason`.",
      ),
    handoffTo: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("With disposition:'handoff' — who continues the goal (owner id / label). The goal stays active."),
    outputs: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "P-021: the goal's reported outputs, validated against its declared output_schema. With disposition:'achieved' every declared-required output must be filled (refused otherwise); 'killed' accepts partial/absent; 'handoff' records nothing.",
      ),
    acknowledgeOpenDirectives: z
      .boolean()
      .optional()
      .describe(
        'EI-11484 guard: open owner directives soft-block loop:end (ending removes their wake render surface). Pass true to consciously proceed with them still open.',
      ),
    acknowledgeWakeLessAutonomy: z
      .boolean()
      .optional()
      .describe(
        'P-012 safety override: consciously end the loop while an autonomy-implying mode remains active and no deliberate independent event await will wake the session.',
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ownerId = resolveSelfLiteral(args.ownerId, identity.ownerId) ?? identity.ownerId;
    // Read first so a no-op end on an already-inactive loop stays a no-op: it
    // cannot CREATE the unsafe state the open-directives guard exists to
    // prevent. This also remains the carry-note/report lookup for goal
    // disposition below.
    const statusBefore = await getLoopStatus(ownerId).catch(() => null);
    // EI-11484 P4: while OPEN owner directives exist, ending the loop silently
    // removes the surface that re-renders them every wake — warn first;
    // acknowledgeOpenDirectives:true proceeds. Fail-open on read errors (you
    // must always be able to stop a loop you armed). A confirmed inactive loop
    // is already stopped, so there is no surface to remove and this guard is
    // intentionally skipped for that ordinary no-op.
    // A successor cleaning up a demoted predecessor's duplicate loop is a
    // cross-owner lifecycle handoff. Its explicit successor keeps this narrow:
    // the workspace-level directive guard must not couple that single-leader
    // cleanup to an unrelated directive belonging to the active successor.
    // Same-owner and all non-handoff cross-owner ends retain the guard.
    const explicitCrossOwnerHandoff =
      ownerId !== identity.ownerId && args.disposition === 'handoff' && Boolean(args.handoffTo);
    if (statusBefore?.active !== false && !explicitCrossOwnerHandoff) {
      const { checkOpenDirectivesGuard } = await import('../orders/open-directives-guard');
      const guard = await checkOpenDirectivesGuard({
        workspaceId: ctx.workspaceId ?? ctx.principal?.workspaceId,
        acknowledged: args.acknowledgeOpenDirectives,
        action: 'loop:end',
        // The CALLER's banner, not the loop owner's: the guard asks whether the
        // session about to lose its wake surface still has directives on its
        // own agenda (P-008 / D-008).
        viewerOwnerId: identity.ownerId,
      });
      if (guard) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(guard) }],
          isError: true,
        };
      }
    }
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    // P-002 gate: a goal-mode owner with a still-active goal winds down WITH a
    // disposition or not at all. Positive-finding-only: every resolution miss
    // (not goal mode, goal not active, flag infra down) passes the gate.
    const activeGoal =
      workspaceId && (await windDownDispositionGateEnabled())
        ? await activeGoalForOwner({ workspaceId, ownerId }).catch(() => null)
        : null;
    // A recorded disposition belongs to the lifecycle that wrote it.  It may
    // suppress a repeated cleanup call only when there is no active arm left
    // to stop.  Treating it as permanent authorization lets a later holder (or
    // a later re-arm by the same holder) end a standing GOAL loop without a
    // current disposition.  EI-21842973962256368 reproduced exactly that
    // shape: an August 28 handoff stamp allowed an active August 30 loop:end.
    //
    // statusBefore=null is the fail-open/read-miss case already promised by
    // this stop path, so preserve the historical bypass there.  A positively
    // observed active arm is the case that must never inherit old authority.
    const recordedDispositionCoversNonActiveEnd =
      Boolean(activeGoal?.recordedDisposition) && statusBefore?.active !== true;
    if (activeGoal && !args.disposition && !recordedDispositionCoversNonActiveEnd) {
      const refusal = buildDispositionRefusal({
        action: 'loop:end',
        goalId: activeGoal.goalId,
        goalTitle: activeGoal.title,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(refusal) }],
        isError: true,
      };
    }
    // P-009 (consult-min-max-and-rubric-vetting-2026-08-17 D-004 §2): 'achieved' is a
    // CLAIM — the acceptance gate demands the vetted, independently-graded rubric.
    // Positive-finding-only (infra faults pass), and it runs BEFORE deactivateLoop so
    // a refusal never strands an already-ended loop. killed/handoff never reach it.
    if (activeGoal && workspaceId && args.disposition === 'achieved') {
      const acceptance = await evaluateGoalAcceptanceGate({
        goalId: activeGoal.goalId,
        goalTitle: activeGoal.title,
        goalOwner: ownerId,
        workspaceId,
      });
      if (!acceptance.satisfied) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: acceptance.code,
                message: acceptance.message,
                goalId: activeGoal.goalId,
                ...(acceptance.rubricId ? { rubricId: acceptance.rubricId } : {}),
              }),
            },
          ],
          isError: true,
        };
      }
    }
    // ── P-021: the outputs gate — BEFORE deactivateLoop, so a refusal never
    // strands an already-ended loop (same posture as the acceptance gate
    // above). 'achieved' with a declared output_schema demands every declared
    // output filled; 'killed' validates leniently; 'handoff' records nothing.
    // Canonical-datatype field checks (D-004) are not yet threaded here — the
    // seam takes `datatypeSchemas`, and plan publication already enforces it;
    // wiring the registry resolver through the wind-down doors is follow-up.
    let windDownOutputs: Record<string, unknown> | null = null;
    if (activeGoal && args.disposition) {
      const ov = evaluateGoalWindDownOutputs({
        outputSchema: activeGoal.outputSchema,
        outputs: args.outputs ?? null,
        disposition: args.disposition,
      });
      if (!ov.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: ov.code,
                message: ov.hint,
                missing: ov.missing,
                issues: ov.errors,
                goalId: activeGoal.goalId,
              }),
            },
          ],
          isError: true,
        };
      }
      windDownOutputs = ov.outputs;
    }
    // P-012 (loop-wake-reliability-2026-08-24 D-004): an autonomy posture is
    // authorization to keep moving, while the loop is its recurring wake source.
    // Ending the latter while the former remains registered — with no deliberate
    // event park to take over — silently strands a fully-authorized session.
    //
    // Both classifications come from their existing authorities:
    //   - modeImpliesAutonomy covers autonomy-axis modes AND overlays whose
    //     registry declaration implies one (goal/drain today, future modes free);
    //   - listParkedAwaitsForSubscribers is the deliberate-park read. It excludes
    //     inbox liveness plumbing, platform-armed claim/fleet interests,
    //     announcements, and expired rows, none of which means the agent chose an
    //     event as its next wake source. Its inbox-prefix exception includes only
    //     bounded wake-on-timeout awaits; the unbounded expiring keepalive remains
    //     liveness plumbing.
    //
    // Positive-finding-only: if either registry read fails, preserve loop:end's
    // always-stoppable contract. A confirmed unsafe state refuses BEFORE
    // deactivateLoop; the explicit acknowledgement is the escape hatch. Keep
    // this after the existing goal/output gates so their error precedence and
    // ordinary no-op paths remain unchanged.
    let deliberateParkedAwait: boolean | null = null;
    const wakeLessAutonomy =
      workspaceId && statusBefore?.active === true
        ? await Promise.all([getModes(workspaceId, ownerId), listParkedAwaitsForSubscribers([ownerId])])
            .then(([modes, parkedAwaits]) => {
              deliberateParkedAwait = parkedAwaits.length > 0;
              const autonomyModes = modes.map((row) => row.mode).filter((mode) => modeImpliesAutonomy(mode));
              return autonomyModes.length > 0 && parkedAwaits.length === 0 ? { autonomyModes } : null;
            })
            .catch(() => null)
        : null;
    const fleetMemberWindDown =
      deliberateParkedAwait === false &&
      !args.acknowledgeWakeLessAutonomy &&
      workspaceId &&
      statusBefore?.active === true
        ? await readFleetWindDownLoopEndRequirement({ ownerId, workspaceId }).catch(() => null)
        : null;
    const wakeLessStopRequiresGuard = wakeLessAutonomy !== null || fleetMemberWindDown === true;
    // A typed fleet wind-down is the one deliberate, fail-closed exception to
    // the wake-less autonomy guard. The fleet cue is only authoritative after
    // the member has released its claim; the helper independently verifies the
    // claimless/current-fleet/winding-down/typed-cue tuple. A read failure stays
    // denied here, while the explicit acknowledgement remains the escape hatch.
    const fleetWindDownLoopEndAuthorized =
      wakeLessStopRequiresGuard && !args.acknowledgeWakeLessAutonomy && workspaceId
        ? await readFleetWindDownLoopEndAuthorization({ ownerId, workspaceId }).catch(() => null)
        : null;
    if (wakeLessStopRequiresGuard && !args.acknowledgeWakeLessAutonomy && fleetWindDownLoopEndAuthorized !== true) {
      const recoveryArgs = {
        ...args,
        acknowledgeWakeLessAutonomy: true,
      };
      // WI-2034563: when the reason this session is stopping is a PARK DIRECTIVE, a
      // generic "register an events:await" is not enough — the member has to await
      // the ONE key the park declared, and a key retyped from prose never
      // rendezvouses. Read it on the refusal path only and hand it over verbatim.
      // Fail-soft: the refusal must still stand if the read misses.
      const parkedUnder = workspaceId
        ? await readFleetParkResumePathForOwner({ ownerId, workspaceId }).catch(() => null)
        : null;
      const parkGuidance = parkedUnder
        ? ` This session is parked under fleet '${parkedUnder.fleet}'. ${describeParkResumePath(parkedUnder.path)}`
        : '';
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'wake_less_autonomy_refused',
              message:
                (wakeLessAutonomy
                  ? `REFUSED — loop:end would leave ${ownerId} in autonomy-implying mode(s) ` +
                    `[${wakeLessAutonomy.autonomyModes.join(', ')}] with no deliberate independent event await. `
                  : `REFUSED — loop:end would leave fleet member ${ownerId} in a winding-down fleet with no deliberate independent event await. `) +
                'Action required: keep the loop armed, register an events:await wake, exit the autonomy-implying modes, or retry loop:end with the exact arguments in recovery.args to consciously create a wake-less autonomy state.' +
                parkGuidance,
              ownerId,
              autonomyModes: wakeLessAutonomy?.autonomyModes ?? [],
              requiredAcknowledgement: 'acknowledgeWakeLessAutonomy',
              ...(parkedUnder
                ? {
                    parkedUnder: {
                      fleet: parkedUnder.fleet,
                      resumeGate: parkedUnder.path.gate,
                      expiresAt: parkedUnder.path.expiresAt,
                      kind: parkedUnder.path.kind,
                      // The action that actually fixes this, ready to copy. Preferred
                      // over the acknowledgement: it leaves a wake source behind.
                      ...(parkedUnder.path.gate
                        ? { preferredRecovery: { tool: 'events:await', args: { event: parkedUnder.path.gate } } }
                        : {}),
                    },
                  }
                : {}),
              recovery: {
                action: 'retry',
                tool: 'loop:end',
                args: recoveryArgs,
              },
            }),
          },
        ],
        isError: true,
      };
    }
    // The routine row names the harness the carry-note is scoped by — statusBefore
    // was read BEFORE deactivation so the report leg can still find the note.
    const ended = await deactivateLoop(ownerId, { reason: args.reason });
    // Disposition apply + owner report, FAIL-SOFT: the loop is already ended and
    // stays ended — a report failure downgrades to a warning, never un-stops.
    let dispositionApplied = false;
    let dispositionWarning: string | null = null;
    if (activeGoal && args.disposition) {
      try {
        await applyGoalDisposition({
          workspaceId,
          goalId: activeGoal.goalId,
          disposition: args.disposition,
          dispositionBy: identity.ownerId,
          handoffTo: args.handoffTo ?? null,
          outputs: windDownOutputs,
        });
        const carryNote = statusBefore
          ? await getLoopCarryNote({ harness: statusBefore.harnessSlug, ownerId }).catch(() => null)
          : null;
        const report = buildGoalWindDownReport({
          goalId: activeGoal.goalId,
          goalTitle: activeGoal.title,
          disposition: args.disposition,
          endedBy: identity.ownerId,
          action: 'loop:end',
          reason: args.reason ?? null,
          carryNote,
          handoffTo: args.handoffTo ?? null,
        });
        await deliverGoalWindDownReport(identity, {
          workspaceId,
          goalId: activeGoal.goalId,
          disposition: args.disposition,
          summary: report.summary,
          body: report.body,
        });
        dispositionApplied = true;
      } catch (e) {
        dispositionWarning = `loop ended, but recording/reporting the goal disposition failed: ${
          e instanceof Error ? e.message : String(e)
        }. Record it via goals:update and report to the owner manually.`;
      }
    }
    const control = ended
      ? await refreshControlAnchorAfterMutation({
          ownerId,
          workspaceId,
          origin: 'agent',
          actorId: identity.ownerId,
          source: 'loop:end',
        })
      : null;
    // EI-21349668185386229: enumerate the wake sources that SURVIVE this stop
    // (see survivingAwaitsNote's header). Fail-soft — a read error must never
    // block the stop; the note then degrades to the scoped-claim wording.
    let survivingAwaits: { await_id: number; event_key: string; expires_ts: string | null; root_id?: number }[] | null = null;
    if (ended) {
      try {
        const [rows, activeRoots] = await Promise.all([
          listActiveAwaits(ownerId),
          listActiveComposedRoots(ownerId),
        ]);
        const activeRootIds = new Set(activeRoots.map((root) => root.id));
        survivingAwaits = rows
          // Composed leaves only feed their root; they do not independently wake
          // this subscriber. A root anchor can remain unfired while delivery is
          // queued after the composed root itself has already fired.
          .filter((r) => r.rootId == null || (r.nodeId == null && activeRootIds.has(r.rootId)))
          // WI-2146110: exclude the keepalive by SHAPE, not by key prefix alone — a
          // DELIBERATE bounded wake-on-timeout await on that same key must surface.
          .filter((r) => !isKeepaliveInboxWake(r))
          .map((r) => ({
            await_id: r.id,
            event_key: r.eventKey,
            expires_ts: r.expiresTs,
            ...(r.rootId != null ? { root_id: r.rootId } : {}),
          }));
      } catch {
        survivingAwaits = null;
      }
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            ownerId,
            ended,
            controlGeneration: control?.generation ?? null,
            ...(activeGoal && args.disposition
              ? {
                  goalId: activeGoal.goalId,
                  disposition: args.disposition,
                  dispositionApplied,
                  ...(dispositionWarning ? { warning: dispositionWarning } : {}),
                }
              : {}),
            ...(ended && survivingAwaits !== null ? { survivingAwaits } : {}),
            note: ended
              ? survivingAwaitsNote(survivingAwaits)
              : 'No active loop found for this owner (already ended or never armed).',
          }),
        },
      ],
    };
  },
});
