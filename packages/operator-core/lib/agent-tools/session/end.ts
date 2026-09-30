/**
 * session:end — wind THIS session down and close its terminal window (WI-6638).
 *
 * ## The problem this exists to solve
 *
 * A psu agent session whose work is finished does not stop. It returns to its CLI
 * prompt and sits there, holding a real `claude` process and a real terminal tab,
 * forever. Measured 2026-08-03: **52 psu-launcher trees from fleets that finished
 * days ago — the oldest 14 days — holding 14.4 GB of RSS**, while the box ran at PSI
 * memory-full avg60 of 10.5–12.5 against a threshold of 5.
 *
 * ## Why no reaper can fix it (three measured dead ends — do not re-chase)
 *
 *  1. **The task ledger cannot see them.** `classifyScope()` returns
 *     `exempt:'human-terminal'` for any `vte-spawn-*.scope`, deliberately, so the
 *     owner's live terminal is never reported as residue. psu runs inside a terminal
 *     by construction, so every terminal-launched session is permanently exempt.
 *  2. **The idle-session reaper never sees them either.** Measured:
 *     `findIdleLiveSessions()` returns **0** for this whole cohort. The funnel — 58
 *     candidates, 58 heartbeat-fresh, 36 idle past 4h — collapses at
 *     `classifyLiveIdle`, because 53 carry `agent_role:'su'` and the rest are
 *     role-less `su-…` ids, and `classifyAgentPane` rule 5 makes every one of them
 *     `driveMode:'responsive'`. The queen-fleet-authority-boundary ruling
 *     (P-001/D-001) excludes responsive sessions outright: *"killing an owner's own
 *     session out from under them is the exact authority violation this plan fixes."*
 *  3. **Even past that, the window guard would spare them — correctly.**
 *     `terminalWindowAlive()` reads 55 of 55 stale scopes as ALIVE, because they
 *     genuinely are: real shells parented by the live terminal app. That guard exists
 *     because an earlier wmctrl-based leg twice SIGKILLed a session the owner had on
 *     screen (WI-1586, WI-1641). It may only ever PREVENT a kill.
 *
 * Two of those are deliberate, owner-ratified protections and the third is a design
 * exemption. None may be loosened. So the fix cannot be a system killing a session
 * from outside — it has to be the session ending itself. That is what this verb is.
 *
 * ## Why it is safe
 *
 * This tool sends an ASK down the session's own managed-pty control socket. It
 * signals nothing and opens no process handle. The psu host decides, from its OWN
 * process state, which no caller can spoof (`shutdownRefusalReason`):
 *
 *  - **agent-launched only** — `PAPERCUSP_LAUNCHED_BY` must be set. `injectLaunchedByArg`
 *    stamps `--launched-by=<caller ownerId>` onto every tool-driven psu launch; an
 *    owner-typed `psu` never carries one. Structural, not heuristic.
 *  - **never human-attended** — any stdin byte ever seen on a bridged TTY
 *    (`makeActivityTracker.touchInput`) permanently disqualifies the session.
 *    Socket-injected agent wakes never reach stdin, so they cannot mask a human.
 *  - **never mid-turn** — refused while the agent is still emitting, unless `force`.
 *
 * psu runs as `exec <psu …>` inside `gnome-terminal --wait`, so the host exiting IS
 * the window closing. Nothing new gains the power to kill anything.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { findLiveHost, hostSupports, shutdownViaPty } from '../../events/await/psu-pty-discovery';
import { getLoopStatus } from '../../harness/routines/loop';
import { activeWorkspaceId } from '../../workspace-registry';
import { markAdvSessionShutdownAcceptedByOwner } from '../../adv-sessions';
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

/** The note recorded in the host event log + printed into the closing terminal. */
const MAX_REASON_CHARS = 300;

/**
 * PURE: the caller-facing explanation for each host verdict. Exported for tests.
 * `loop-armed` is decided operator-side (the psu host has no DB), the rest by the host.
 */
export function shutdownNote(result: string): string {
  switch (result) {
    case 'loop-armed':
      return 'REFUSED — an engine loop is still armed on this session, so it WILL be woken again and closing it now just strands the next fire. Call loop:end first, then retry.';
    case 'sent':
      return 'Shutdown accepted. This session is winding down and its terminal window will close; do not expect another turn.';
    case 'no-host':
      return 'No live psu-pty host for this session, so there is no window to close (headless / non-psu launch). Nothing to do.';
    case 'no-cap':
      return 'This psu-pty host predates the shutdown capability (WI-6638). It cannot close its own window; the session will keep idling until it is relaunched onto a current host.';
    case 'refused-not-agent-launched':
      return 'REFUSED — this session carries no PAPERCUSP_LAUNCHED_BY, so it was started by a human, not by another agent. A hand-started session is the owner\'s to close.';
    case 'refused-human-attended':
      return 'REFUSED — a human has typed into this terminal, so it belongs to the owner. This is the correct answer, not an error to retry around.';
    case 'refused-agent-busy':
      return 'REFUSED — the agent is still emitting output (mid-turn). Reach a settled prompt and retry, or pass force:true if you are certain the turn is finished.';
    default:
      return 'The shutdown request did not reach the host (transport miss). The session is unchanged; retry, or leave it — nothing was killed.';
  }
}

export default defineTool({
  name: 'session:end',
  description:
    'Wind THIS session down and CLOSE its terminal window. For an agent session whose work is genuinely finished — no armed loop, no held claims, nothing left to wake for. The psu host refuses unless the session was agent-launched and no human has ever typed into it, so an owner-attended window is never closed.',
  capability: 'coord:write',
  guidance: {
    when: 'Your work is finished and nothing will wake you again: loop ended, claims released and checkpointed, fleet wound down. Leaving the session idling holds a real process and terminal tab indefinitely.',
    notWhen:
      'A loop is still armed, you hold a claim, you are parked on an events:await, or a human is driving this session — end those first, or just keep working.',
    seeAlso: ['loop:end (stop the wake source first)', 'work_items:complete (release your claims first)'],
  },
  requirePrincipal: false,
  // EI-20228659661229322: shutdown is a recovery/control-path operation that
  // never reads ctx.tx. Do not hold an org-app transaction while checking the
  // loop and sending the host shutdown request: under a saturated pool the
  // ambient acquisition can strand the very session that is trying to exit.
  // Privileged role callers therefore run tx-less; signed callers still use the
  // short principal-synthesis probe enforced by the dispatch seam.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    reason: z
      .string()
      .max(MAX_REASON_CHARS)
      .optional()
      .describe('Why this session is finished — recorded in the host event log and printed as the terminal closes.'),
    force: z
      .boolean()
      .optional()
      .describe(
        'Waive ONLY the mid-turn (agent-busy) refusal. It can never waive the agent-launched / no-human-input guards — the host evaluates those from its own process state.',
      ),
    disposition: z
      .enum(GOAL_DISPOSITIONS)
      .optional()
      .describe(
        "GOAL-mode wind-down verdict, REQUIRED when this owner's goal is still active and no loop is armed (a looped owner hits the same gate at loop:end): 'achieved' | 'killed' | 'handoff'. Recorded on the goal; the owner report is auto-generated.",
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
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const host = findLiveHost(identity.ownerId);
    // An ARMED LOOP is a guaranteed future wake, which makes "nothing will wake me
    // again" false by construction — so this is a real precondition, not advice, and
    // it is enforced HERE because the psu host has no DB to read it from. Closing a
    // looping session only strands the next fire (the wake-executor then has to
    // --resume a session that did not need to die). Fail-OPEN on a read error: a
    // flaky loop read must not block a legitimate wind-down.
    let loopReadFailed = false;
    const loop = await getLoopStatus(identity.ownerId).catch(() => {
      loopReadFailed = true;
      return null;
    });
    // P-002 (goal-mode-design-intent-hardening-2026-08-16): a LOOPLESS goal-mode
    // owner whose goal is still active winds down WITH a disposition or not at
    // all (a LOOPED one is already forced through loop:end by the loop-armed
    // refusal below, and hits the same gate there). skipWorkspaceTx holds here:
    // the helpers run on the org pool, never ctx.tx. Flag check fails CLOSED —
    // a broken flag read disables the gate, never wedges the wind-down.
    let dispositionWarning: string | null = null;
    if (!loop?.active && (await windDownDispositionGateEnabled())) {
      const workspaceId =
        ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
      const activeGoal = workspaceId
        ? await activeGoalForOwner({ workspaceId, ownerId: identity.ownerId }).catch(() => null)
        : null;
      // A historical goal disposition is not a standing permit for a later
      // loopless holder to close its session.  It covers only a re-entrant
      // cleanup after this owner's loop is already known inactive.  Preserve
      // the stop path's fail-open contract when the loop read itself failed;
      // a successful null means "no loop", not "already disposed".
      const recordedDispositionCoversInactiveLoop =
        Boolean(activeGoal?.recordedDisposition) && (loop?.active === false || loopReadFailed);
      if (activeGoal && !args.disposition && !recordedDispositionCoversInactiveLoop) {
        const refusal = buildDispositionRefusal({
          action: 'session:end',
          goalId: activeGoal.goalId,
          goalTitle: activeGoal.title,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(refusal) }],
          isError: true,
        };
      }
      // P-009 (consult-min-max-and-rubric-vetting-2026-08-17 D-004 §2): 'achieved'
      // is a CLAIM — the acceptance gate demands the vetted, independently-graded
      // rubric. Positive-finding-only (infra faults pass); killed/handoff exempt.
      if (activeGoal && workspaceId && args.disposition === 'achieved') {
        const acceptance = await evaluateGoalAcceptanceGate({
          goalId: activeGoal.goalId,
          goalTitle: activeGoal.title,
          goalOwner: identity.ownerId,
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
      // ── P-021: the outputs gate — a REFUSAL, before anything is applied
      // (the fail-soft below is for the REPORT leg, never for an invalid
      // product claim). 'achieved' with a declared output_schema demands every
      // declared output filled; 'killed' validates leniently; 'handoff'
      // records nothing. Datatype-ref checks not yet threaded — see loop:end.
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
      if (activeGoal && args.disposition) {
        // Apply + report FAIL-SOFT: a report failure downgrades to a warning —
        // it must never strand a session that is legitimately winding down.
        try {
          await applyGoalDisposition({
            workspaceId,
            goalId: activeGoal.goalId,
            disposition: args.disposition,
            dispositionBy: identity.ownerId,
            handoffTo: args.handoffTo ?? null,
            outputs: windDownOutputs,
          });
          const carryNote = loop
            ? await getLoopCarryNote({ harness: loop.harnessSlug, ownerId: identity.ownerId }).catch(
                () => null,
              )
            : null;
          const report = buildGoalWindDownReport({
            goalId: activeGoal.goalId,
            goalTitle: activeGoal.title,
            disposition: args.disposition,
            endedBy: identity.ownerId,
            action: 'session:end',
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
        } catch (e) {
          dispositionWarning = `recording/reporting the goal disposition failed: ${
            e instanceof Error ? e.message : String(e)
          }. Record it via goals:update and report to the owner manually.`;
        }
      }
    }
    const result = loop?.active
      ? 'loop-armed'
      : await shutdownViaPty(identity.ownerId, {
          reason: args.reason,
          force: args.force === true,
        });
    if (result === 'sent') {
      // The host has positively accepted shutdown, but the child-exit report may
      // arrive later. Persist the in-between signal so force-release can reclaim
      // a claim without trusting the lingering loop heartbeat.
      await markAdvSessionShutdownAcceptedByOwner(identity.ownerId);
    }
    const ok = result === 'sent';
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok,
            result,
            note: shutdownNote(result),
            ...(dispositionWarning ? { dispositionWarning } : {}),
            // Surfaced so a refusal is self-explaining without a second call: these
            // are the two inputs to the host's own agent-vs-human verdict.
            agentLaunched: host ? !!String(host.launchedBy ?? '').trim() : null,
            hostSupportsShutdown: host ? hostSupports(host, 'shutdown') : null,
          }),
        },
      ],
      isError: !ok && result !== 'no-host',
    };
  },
});
