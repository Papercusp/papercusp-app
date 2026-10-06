/**
 * session:request-compaction — cut THIS session at a clean stopping point and
 * respawn it on fresh context, carrying the deterministic carry document.
 *
 * agent-managed-compaction-2026-07-01, rebuilt under deterministic-context-carry
 * P-018/P-022 (WI-4998, owner terminal state 2026-07-14 "remove the compact call
 * entirely"): native `/compact` — Claude Code's LLM summarizer — is RETIRED. The
 * agent still calls this tool at a good stopping point (typically near its soft
 * compaction limit — see config:set-compaction-limit and the per-turn
 * `context: N/limit` signal), but the harness no longer types a slash command.
 * Instead it sends the psu-pty host a `carry-respawn`: after this turn ends the
 * host KILLS the CLI child and RELAUNCHES it in the same pane with
 *
 *   1. the deterministic carry document (P-009/P-010/P-011 producers, rendered to
 *      the constant budget) as the successor's system-prompt addendum, and
 *   2. a first prompt — the owner's final message when it is still OPEN (the
 *      P-010 contract: an unanswered owner turn arrives as a live prompt, never
 *      quoted history), else a continue+re-orient note derived from `focus`.
 *
 * No native summarizer runs anywhere in this path; the transitional residual LLM
 * pass (P-019) audits deterministic-carry boundaries separately and stays armed
 * until its per-class evidence retires it. A host that predates the
 * `carry-respawn` capability gets a loud error, NOT a `/compact` fallback —
 * fresh launches always carry the capability, and the hard-wall death detector
 * (improvements watchdog) recovers the rare straggler.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveWakeMode } from '../coordination/wake-mode';
import { injectIntoHost, selfCompactionAvailability } from '../../events/await/psu-pty-discovery';
import { tagTurnForInjection } from '../../turn-provenance/turn-provenance';
import { carryProvenanceFields } from '../../carry-surface-provenance-stamp';
import { buildOwnerRespawnLaunchSpec } from '../../carry-respawn';
import { estimateContextWindowForOwner, resolveModelSpecForOwner } from '../../compaction-usage';
import { modelWindowForSpec } from '../../agent-config-constants';
import {
  staleCheckpointWarnings,
  STALE_CHECKPOINT_WARN_MS,
  type CheckpointFlushWarning,
} from '../../enforcement-gate';
import { runFlushGate } from '../../enforcement-gate-io';
import { markRespawnExpected } from '../../carry-respawn-marker';
import { detectRespawnStorm, escalateRespawnStorm, RESPAWN_STORM_ERROR } from '../../carry-respawn-storm';
import { releaseOwnerHookFileLocks } from '../locks/release-hook-locks';
import { readPriorRespawnOutcome, priorRespawnNote } from '../../carry-respawn-outcome';
import { bumpSessionEpoch } from '../../memory/session-epoch-ledger';
import { getOrgPg } from '@papercusp/db-org';
import { clearPendingCarryRespawn, savePendingCarryRespawn } from '../../session-brief';
import {
  getLoopStatus,
  materializeLoop,
  readActiveLoopFacts,
  type LoopStatus,
  type PriorLoopFacts,
} from '../../harness/routines/loop';
import { getLoopCarryNoteWithMeta, setLoopCarryNoteWithPrior, shortCarryHash } from '../../carry-note';
import { renderFocusIntegrityWarning, unverifiedFocusRefs } from '../../carry-brief';
import {
  isJudgeCarryRole,
  postCompactionRecoveryInstruction,
  renderRetractionGuard,
} from '../../carry-doc';
import { MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION } from '../coordination/compaction-recovery';
import { addressContinuationToOwner } from '../../carry-respawn-addressing';
import {
  readLiveNativeBgTasks,
  renderNativeBgTaskWarning,
  type NativeBgTaskReport,
} from '../../native-bg-task-ledger';
import {
  evaluateFrozenLineageCarryText,
  frozenLineageCarryViolationPayload,
} from '../../release/frozen-lineage-execution-policy';
import { resolveHomeGateVerdictTarget } from '../../release/gate-verdict-target';

// Preserve the established import surface while sharing the pure guard with
// loop-turn-outcome and the compaction watchdog.
export { addressContinuationToOwner };

// Re-exported for back-compat: the flush-integrity detector + its shape now live
// in enforcement-gate.ts (the single source shared with the P-016 enforcement
// tier), but this tool's warn path — and any importer — keeps its old surface.
export { staleCheckpointWarnings, STALE_CHECKPOINT_WARN_MS, type CheckpointFlushWarning };

/** Focus applied when the agent names none AND the carry-brief read fails —
 *  the static floor under the session-specific default (P-003 below). */
const DEFAULT_FOCUS =
  'keep the identity block, the active plan and its open items, unverified claims awaiting owner confirmation, and owner-gated walls; drop resolved tool output and superseded state.';

/** Window fallback when the model spec cannot be resolved — the conservative
 *  200k default every ≤200k Claude session actually runs. */
const FALLBACK_EFFECTIVE_WINDOW_TOKENS = 200_000;

/**
 * EI-18686525818431054: `injectIntoHost`'s DEFAULT client-side socket timeout
 * (2000ms) is sized for an ordinary wake `turn` — the psu-pty-host acks
 * 'accepted' immediately after early validation (payload/ownerId/coalesce
 * checks), before ever entering the human-idle + agent-busy GATES, which can
 * legitimately run up to `TURN_INJECT_BUSY_CAP_MS` (production default 180s)
 * — doubled for a carry-respawn's one re-arm retry (psu-pty-host.mjs
 * `makeCarryRearmController`) — before the actual write/recycle proceeds as a
 * detached background continuation. A HOST RUNNING CODE FROM BEFORE THAT
 * ack-early fix landed (WI-5872 follow-up #2, EI-18679050054551625) instead
 * awaits the FULL gated pipeline before writing anything back — and since a
 * psu-pty-host process is never restarted by a carry-respawn (only its CHILD
 * CLI is; the host persists for the life of the psu session), a session whose
 * host predates that fix hits the 2000ms client timeout on every single
 * `session:request-compaction` call: "Failed to reach the session TUI host
 * socket" — the ONE sanctioned context-shedding path, failing exactly when a
 * long-running session needs it most (this is literally that filing's
 * reproduction). A carry-respawn is inherently latency-INSENSITIVE from the
 * caller's point of view — the agent is ending its turn regardless — so
 * there is no cost to waiting substantially longer here: on a FIXED host the
 * ack still returns in milliseconds; on a STALE pre-fix host (or one merely
 * scheduling-delayed on a loaded box) this gives the full gated pipeline room
 * to actually complete and report truthfully instead of timing out on a
 * false negative. Sized comfortably past the doubled busy-gate cap
 * (2 * 180_000 = 360_000ms) with wide margin for host scheduling jitter. Keep
 * this below the tool's 600s dispatch budget so a legacy-host acknowledgement
 * can reach the caller before dispatch turns it into an unknown outcome.
 */
const CARRY_RESPAWN_SOCKET_TIMEOUT_MS = 9 * 60_000;

/**
 * compaction-continuity-hardening-2026-07-07 P-003 + EI-8987: ONE best-effort
 * carry-brief build, shared by the default-focus derivation AND the stale-
 * checkpoint warning below (was two separate buildCarryBrief calls — wasteful,
 * since both want the SAME held-items read). Any failure yields `null`; every
 * caller treats that as "brief unavailable", never a thrown error.
 */
async function loadCarryBrief(
  ownerId: string,
  workspaceId?: string | null,
): Promise<import('../../carry-brief').CarryBrief | null> {
  try {
    const { buildCarryBrief } = await import('../../carry-brief');
    return await buildCarryBrief(ownerId, { workspaceId: workspaceId ?? undefined });
  } catch {
    return null;
  }
}

/** The session's CARRY BRIEF (held work-item ids, armed loop, standing facts,
 *  awaits, fleet pointer — as pointers, not copies) rendered as a focus string,
 *  so an agent that names no focus still hands the successor its real
 *  continuity anchors instead of the generic preserve set. Falls back to the
 *  static DEFAULT_FOCUS when the brief is empty/unavailable. */
async function carryBriefFocus(brief: import('../../carry-brief').CarryBrief | null): Promise<string> {
  if (!brief) return DEFAULT_FOCUS;
  try {
    const { renderCarryBriefFocus } = await import('../../carry-brief');
    const focus = renderCarryBriefFocus(brief).trim();
    if (focus.length > 0) return focus;
  } catch {
    /* fall through to the static floor */
  }
  return DEFAULT_FOCUS;
}

/**
 * A caller-authored focus that names state outside the recipient's brief is
 * unsafe to carry verbatim. Keep the successor on recipient-owned anchors;
 * when there are no such anchors, say so explicitly instead of turning a
 * peer's work-item into an executable `Then resume:` directive.
 */
async function safeFocusAfterIntegrityCheck(
  brief: import('../../carry-brief').CarryBrief | null,
): Promise<string> {
  if (brief?.heldItems.length || brief?.loop?.carryNote) return carryBriefFocus(brief);
  return (
    'No recipient-owned held work-item or loop carry-note is available; do not infer or claim a ' +
    'lane from the rejected focus; continue only from live role context.'
  );
}

/**
 * A no-PTY loop cannot be cut through a host socket. An ACTIVE WARM loop can,
 * however, make the same boundary through its next COLD wake — provided the
 * carry anchor exists before the loop is retuned. Keep this recovery here,
 * beside the host-gated path, so callers do not have to spend a second model
 * turn discovering the loop:arm + loop:checkpoint recipe.
 *
 * The note write deliberately precedes the retune. If either write fails, the
 * session remains warm and therefore retains its live context; a verified note
 * left on a still-warm loop is harmless and makes the next retry idempotent.
 */
async function retuneWarmLoopForColdSettle(
  ownerId: string,
  workspaceId: string | null | undefined,
  loop: LoopStatus,
  focus: string,
): Promise<
  | {
      ok: true;
      carryNote: { seeded: boolean; verified: true; contentHash: string };
      loop: { harness: string; intervalSec: number | null; goal: string | null; mode: string; customWakePrompt: boolean };
    }
  | { ok: false; phase: 'read-loop' | 'write-carry' | 'verify-carry' | 'retune-loop'; message: string }
> {
  let facts: PriorLoopFacts | null;
  try {
    facts = await readActiveLoopFacts(ownerId);
  } catch (error) {
    return {
      ok: false,
      phase: 'read-loop',
      message: `Could not read the active loop configuration before the no-PTY recovery: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!facts?.active || !loop.active || loop.carry === 'cold') {
    return {
      ok: false,
      phase: 'read-loop',
      message: 'The active warm loop changed while compaction recovery was being prepared; re-read loop:status and retry.',
    };
  }

  const harness = facts.harnessSlug ?? loop.harnessSlug;
  const intervalSec = facts.intervalSec ?? loop.intervalSec;
  if (!harness || intervalSec == null || !Number.isFinite(intervalSec) || intervalSec <= 0) {
    return {
      ok: false,
      phase: 'read-loop',
      message: 'The active loop has no stable harness or cadence to preserve; it was left warm and unmodified.',
    };
  }

  const seededNote = [
    '## Did',
    'Prepared this active warm loop for a no-PTY deterministic compaction boundary.',
    '',
    '## Left',
    focus,
    '',
    '## Key insight',
    'A no-PTY session cannot receive an in-place carry-respawn; the active loop configuration is preserved while its next wake changes to cold carry.',
    '',
    '## Next action',
    'Resume the loop mission from this verified carry-note on the next cold wake.',
  ].join('\n');

  let stored: string | null = null;
  try {
    const write = await setLoopCarryNoteWithPrior(
      { harness, ownerId, workspaceId: workspaceId ?? undefined },
      seededNote,
      {
        // Preserve an existing, richer checkpoint. This makes the automatic
        // seed additive and avoids replacing a note the agent already wrote.
        transform: (priorNote, incomingNote) => priorNote?.trim() || incomingNote,
      },
    );
    if (write.blockedReason && !write.stored) {
      return {
        ok: false,
        phase: 'write-carry',
        message: `Could not seed the cold-loop carry-note (${write.blockedReason}); the loop was left warm and unmodified.`,
      };
    }
    stored = write.stored?.trim() || null;
  } catch (error) {
    return {
      ok: false,
      phase: 'write-carry',
      message: `Could not seed the cold-loop carry-note: ${error instanceof Error ? error.message : String(error)}. The loop was left warm and unmodified.`,
    };
  }

  if (!stored) {
    return {
      ok: false,
      phase: 'write-carry',
      message: 'The carry-note write returned no durable note; the loop was left warm and unmodified.',
    };
  }
  const verified = await getLoopCarryNoteWithMeta({
    harness,
    ownerId,
    workspaceId: workspaceId ?? undefined,
  }).catch(() => ({ note: null, updatedAtMs: null }));
  if (verified.note !== stored) {
    return {
      ok: false,
      phase: 'verify-carry',
      message:
        `The cold-loop carry-note could not be verified through the wake-reader path (stored ${stored.length} chars, read back ${verified.note === null ? 'null' : `${verified.note.length} chars`}); ` +
        'the loop was left warm and unmodified.',
    };
  }

  try {
    await materializeLoop({
      workspaceId: workspaceId ?? undefined,
      harnessSlug: harness,
      ownerId,
      intervalSec,
      // Keep the exact kickoff, including an explicit custom wake prompt. The
      // successor may not see a loop-fire kickoff during this boundary.
      kickoff: facts.kickoff,
      customWakePrompt: facts.customWakePrompt === true,
      goal: facts.goal ?? loop.goal,
      costCapCents: loop.costCapCents,
      maxFires: loop.maxFires,
      maxDurationSec: loop.maxDurationSec,
      carry: 'cold',
      continuation: facts.continuation,
      mode: facts.mode,
      ...(facts.monitor ? { monitor: facts.monitor } : {}),
      active: true,
    });
  } catch (error) {
    return {
      ok: false,
      phase: 'retune-loop',
      message:
        `The carry-note is verified, but retuning the active loop to cold failed: ${error instanceof Error ? error.message : String(error)}. ` +
        'The loop remains warm; retry session:request-compaction at the next clean boundary.',
    };
  }

  return {
    ok: true,
    carryNote: { seeded: stored === seededNote, verified: true, contentHash: shortCarryHash(stored) },
    loop: {
      harness,
      intervalSec,
      goal: facts.goal ?? loop.goal,
      mode: facts.mode,
      customWakePrompt: facts.customWakePrompt === true,
    },
  };
}

/**
 * The successor's first prompt when no owner message is open (WI-1804 lineage):
 * derived from `focus` so the fresh context resumes THIS unit of work.
 * Recovery is already boundary-pushed. The successor inspects the stamped marker
 * and falls back to a full recovery-orient only when the marker contract says so.
 */
function defaultContinueNote(focus: string, role?: string | null): string {
  const judgeSafe = isJudgeCarryRole(role);
  const recoveryInstruction = judgeSafe
    ? postCompactionRecoveryInstruction(role)
    : MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION;
  return (
    'Continue where you left off — this is your fresh successor process right after a ' +
    'deterministic carry-respawn; your carry document is in the system prompt. ' +
    recoveryInstruction +
    (judgeSafe
      ? ' Use only the evidence and tools explicitly permitted to the judge role. '
      : ' Anything ' +
        "the carry dropped is still searchable: sessions:search { session:'self', mode:'verbatim' }. ") +
    `Then resume: ${focus}`
  );
}

function retractionSafeContinueNote(refs: readonly string[], role?: string | null): string {
  const ids = refs.join(', ');
  const body = isJudgeCarryRole(role)
    ? `Continue only the assigned evaluation using permitted evidence; do NOT execute, claim, or re-broadcast the withdrawn directive for ${ids}.`
    : `Re-orient from the automatically delivered carry document and your live lane; do NOT execute or claim the withdrawn directive for ${ids}.`;
  return `${renderRetractionGuard(refs)}\n\n${body}`;
}

/**
 * EI-7032: `focus` / `continueNote` are HINTS folded into the successor's first
 * prompt, not load-bearing data. Rejecting an over-long one FAILED the whole
 * boundary — and that failure lands at the worst possible moment (the agent
 * called this BECAUSE it is at its context limit), forcing a wasted retry with a
 * shorter string. Live data: 40% of calls (130/321 in 24h) 400ed on "focus: Too
 * big <=600 chars", nothing else. Fix: truncate an over-long hint to the cap
 * (…-marked) instead of rejecting, so the boundary ALWAYS proceeds. A within-cap
 * hint is returned unchanged, and the published schema still advertises the cap
 * so well-behaved clients keep it short.
 */
export function truncateHint(value: string, max: number): string {
  return value.length > max ? value.slice(0, Math.max(0, max - 1)) + '…' : value;
}

/** A string field that TRUNCATES to `max` (via truncateHint) instead of rejecting. */
function hintString(max: number) {
  return z.preprocess((v) => (typeof v === 'string' ? truncateHint(v, max) : v), z.string().max(max));
}

/** Refuse an unsafe successor instruction before it reaches a loop carry-note
 * or the psu host. Empty text is not a carry instruction and stays on the
 * existing fast path. */
function frozenCompactionCarryRefusal(text: string) {
  if (!text.trim()) return null;
  const verdict = evaluateFrozenLineageCarryText({
    surface: 'compaction-continuation',
    text,
    target: resolveHomeGateVerdictTarget(),
  });
  const payload = frozenLineageCarryViolationPayload(verdict);
  if (!payload) return null;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}

export default defineTool({
  name: 'session:request-compaction',
  description:
    'Compact THIS session now, at a clean stopping point (near your soft compaction limit). After this turn ends the harness cuts the process and respawns it on fresh context with the deterministic carry document as launch context (P-018 — native /compact is retired); the successor resumes automatically. Pass focus to name what to resume. Supported wire fields are focus, autoContinue, respawn, continueNote, and legacy reason (ignored).',
  capability: 'coord:write',
  guidance: {
    when: 'You are near your compaction limit AND at a clean stopping point (a finished unit of work — tests green, an edit landed, a decision logged).',
    notWhen:
      'Mid-task — reach a stopping point first. To change WHEN this fires — config:set-compaction-limit.',
    seeAlso: ['config:set-compaction-limit (tune when this fires)'],
  },
  requirePrincipal: false,
  // EI-20228659908672442: this boundary performs carry assembly, transcript
  // ingest, and host I/O; it never reads ctx.tx. Do not hold the ambient
  // org-app workspace transaction while waiting for those operations, or a
  // saturated pool can reject the compaction request before it queues the cut.
  skipWorkspaceTx: true,
  // EI-23098800759403082: a legacy host that predates ack-early can hold the
  // control socket through the doubled 180s busy-gate window. The former 120s
  // budget aborted first, then discarded the handler's eventual successful
  // queue acknowledgement as outcome-unknown while the carry remained live.
  // Keep dispatch beyond the bounded 9m compatibility wait; ptool sits beyond
  // the transport's +5s settlement buffer.
  timeoutSec: 600,
  agentRoles: [...AGENT_ROLES],
  rolesQuota: { operator: { perRun: 10 } },
  args: z.object({
    focus: hintString(600)
      .optional()
      .describe(
        'What to resume/emphasize after the respawn (defaults to your carry-brief anchors). Keep it ≤600 chars; an over-long focus is truncated, never rejected (EI-7032).',
      ),
    autoContinue: z
      .boolean()
      .optional()
      .describe(
        'Deprecated no-op: a carry-respawn always resumes (the successor launches with a first prompt). Accepted for wire-compat with older callers.',
      ),
    // EI-21441319994873793: an older caller sent resumeMode:"same". The
    // boundary now always resumes the same logical session via carry-respawn,
    // so preserve that exact stale literal as a bounded wire-compat no-op
    // instead of widening the strict schema to arbitrary mode strings.
    resumeMode: z
      .literal('same')
      .optional()
      .describe(
        'Deprecated no-op: carry-respawn always resumes the same logical session. Accepted only as the legacy literal "same" for wire compatibility.',
      ),
    // EI-20252809455491677: some generic boundary callers annotate the request
    // with `reason`. This boundary has no reason-dependent behavior, but rejecting
    // the annotation at the schema edge causes a needless failed compaction at the
    // point where the caller most needs a reliable continuation path. Preserve the
    // field as a bounded no-op so the accepted wire shape is explicit and stable.
    reason: hintString(600)
      .optional()
      .describe(
        'Deprecated no-op: an optional caller annotation accepted for wire compatibility; it does not affect carry assembly or the successor prompt.',
      ),
    // EI-20250117090491411: older carry instructions called this boundary
    // with respawn:true. The boundary always respawns now, so preserve that
    // legacy wire shape as an explicit no-op instead of rejecting a stale
    // carried caller before the handler can run.
    respawn: z
      .boolean()
      .optional()
      .describe(
        'Deprecated no-op: a carry-respawn is always requested. Accepted for wire-compat with older callers.',
      ),
    continueNote: hintString(1000)
      .optional()
      .describe(
        "Override the successor's first prompt used when no owner message is open. Defaults to a \"continue + re-orient\" note derived from focus. Over-long is truncated, never rejected (EI-7032).",
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    let wakeMode: 'auto' | 'manual';
    try {
      wakeMode = await resolveWakeMode(identity.ownerId);
    } catch {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            requested: false,
            error: 'wake_mode_unavailable',
            note: 'The current wake mode could not be read, so no carry-respawn was queued.',
          }),
        }],
        isError: true,
      };
    }
    if (wakeMode === 'manual') {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            requested: false,
            error: 'wake_mode_manual',
            note: 'Carry-respawn is paused by the current manual wake mode. The session remains intact.',
          }),
        }],
        isError: true,
      };
    }
    // Check caller-authored hints before ANY fallback can seed them into a cold
    // loop carry-note. A later check covers generated/default carry text too.
    const explicitCarryRefusal = frozenCompactionCarryRefusal(
      [args.focus, args.continueNote].filter((text): text is string => Boolean(text?.trim())).join('\n'),
    );
    if (explicitCarryRefusal) return explicitCarryRefusal;
    // EI-20209826138488049: the host gate is read through the SHARED predicate the
    // continuation gate / context gauge / inbox use to decide whether to RECOMMEND
    // self-compaction — so a recommendation and this refusal cannot drift apart.
    // Loop state can prepare durable carry, but it cannot prove a fresh turn
    // will be delivered without a host. Keep the no-host response explicit.
    const availability = selfCompactionAvailability(identity.ownerId);
    if (!availability.available && availability.reason === 'no_live_pty_host') {
      // A saved carry-note and an armed cold loop are registration evidence,
      // not proof that this process can receive a fresh turn. The no-host cold
      // wake path can park without resume, so never call that configuration a
      // successful compaction request.
      const loop = await getLoopStatus(identity.ownerId).catch(() => null);
      if (loop?.active && loop.carry === 'cold' && loop.harnessSlug) {
        const carry = await getLoopCarryNoteWithMeta({
          harness: loop.harnessSlug,
          ownerId: identity.ownerId,
          workspaceId: identity.workspaceId ?? undefined,
        });
        if (carry.note) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  requested: false,
                  respawn: false,
                  error: 'no_live_pty_host',
                  carry: 'cold',
                  carryNote: { verified: true },
                  note:
                    'No live psu-pty host is available, so no carry-respawn was queued. An armed cold loop and saved carry-note do not prove the next turn can be delivered. Keep this process active after flushing state, or relaunch through a managed psu host before relying on a fresh-context boundary.',
                }),
              },
            ],
            isError: true,
          };
        }
      }
      if (loop?.active && loop.carry !== 'cold') {
        const recovery = await retuneWarmLoopForColdSettle(
          identity.ownerId,
          identity.workspaceId,
          loop,
          (args.focus ?? '').trim() || DEFAULT_FOCUS,
        );
        if (!recovery.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  requested: false,
                  error: 'cold_loop_recovery_failed',
                  phase: recovery.phase,
                  note: recovery.message,
                }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                requested: false,
                respawn: false,
                error: 'no_live_pty_host',
                carry: 'cold',
                retuned: true,
                carryNote: recovery.carryNote,
                loop: recovery.loop,
                note:
                  'The active warm loop was retuned to cold and its carry-note was verified, but no live psu-pty host is available to trigger or verify a fresh successor. This is preparation only, not a respawn. Keep this process active after flushing state, or relaunch through a managed psu host before relying on a fresh-context boundary.',
              }),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_live_pty_host',
              requested: false,
              respawn: false,
              note: 'No live psu-pty host is available, so no carry-respawn was queued. Keep this process active after flushing state, or relaunch through a managed psu host before expecting a fresh-context successor.',
            }),
          },
        ],
        isError: true,
      };
    }
    // P-022: native /compact is retired — there is deliberately NO fallback for a
    // host that predates the carry-respawn capability. Fresh launches always
    // carry it; a stale host rides until the hard wall, where the improvements
    // watchdog's death detector ("Prompt is too long") recovers the session.
    if (!availability.available) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'host_predates_carry_respawn',
              note: 'This psu-pty host predates the carry-respawn capability and native /compact is retired (P-022). Flush your state (work_items:checkpoint / loop:checkpoint) and keep working — the watchdog death-detector recovers the session at the wall — or have the session relaunched to pick up a current host.',
            }),
          },
        ],
        isError: true,
      };
    }
    const host = availability.host;
    // ONE best-effort brief build feeds both the default-focus derivation AND the
    // EI-8987 stale-checkpoint warning below (was two separate buildCarryBrief
    // calls before this pass).
    const brief = await loadCarryBrief(identity.ownerId, identity.workspaceId);
    // WI-10002530: break managed carry-respawn STORMS. A successor that asks for
    // another cut before taking a single real turn — repeatedly — is alive but
    // doing no work, and every queued cut used to return 'queued' silently for
    // hours (WI-10002522: 14 cuts in 11 min on a gate-lane holder). Refuse the
    // cut (the process stays intact) and raise ONE coalescing owner-facing alert
    // naming the held items. Bounded + fail-OPEN; cleared by the next real call.
    const storm = await detectRespawnStorm(identity.ownerId);
    if (storm.storm) {
      await escalateRespawnStorm({
        ownerId: identity.ownerId,
        workspaceId: identity.workspaceId,
        verdict: storm,
        heldItems: brief?.heldItems ?? [],
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              requested: false,
              error: RESPAWN_STORM_ERROR,
              storm,
              note:
                `Carry-respawn refused: ${storm.cutsSinceRealTurn} cut(s) were queued for this session since its ` +
                'last real tool call, so each successor is asking for another cut before doing any work. This ' +
                'process stays intact and an owner-facing escalation was raised. If you are reading this, take a ' +
                'real turn instead — any other tool call clears the breaker — and raise set_compaction_limit if ' +
                'your fresh-context baseline sits at your limit.',
            }),
          },
        ],
        isError: true,
      };
    }
    const focus = (args.focus ?? '').trim() || (await carryBriefFocus(brief));
    const focusCarryRefusal = frozenCompactionCarryRefusal(focus);
    if (focusCarryRefusal) return focusCarryRefusal;
    const focusIntegrityRefs = unverifiedFocusRefs(
      [focus, args.continueNote ?? ''].join('\n'),
      brief,
    );
    const hasUnverifiedFocusRefs =
      focusIntegrityRefs.workItemIds.length > 0 || focusIntegrityRefs.carryHashes.length > 0;
    const safeFocus = hasUnverifiedFocusRefs
      ? await safeFocusAfterIntegrityCheck(brief)
      : focus;
    const rawStaleCheckpoints = staleCheckpointWarnings(brief);
    // P-016 enforcement gate: the WARN above becomes teeth. Unflushed state
    // (missing/stale held checkpoint, or an armed loop with no carry-note) HOLDS
    // the boundary ONCE, naming the flush; a retry that still hasn't flushed
    // gets a system-written mechanical fallback and proceeds. The gate is bounded,
    // fail-OPEN, and env-disable-able (enforcement-gate-io), so it can never
    // reintroduce the strand this tool's warn-only design was avoiding.
    const gateNowMs = Date.now();
    const gate = await runFlushGate({
      boundary: 'compaction',
      ownerId: identity.ownerId,
      workspaceId: identity.workspaceId ?? '*',
      sessionId: identity.ownerId,
      sinceIso: new Date(gateNowMs - 30 * 60_000).toISOString(),
      brief,
      nowMs: gateNowMs,
    });
    // The gate's terminal-state re-check is authoritative when it completed:
    // do not warn the caller to checkpoint an item that is already terminal.
    // If the gate was disabled or its bounded wrapper failed open, the
    // provenance field is absent and the original best-effort advisory survives.
    const staleCheckpoints = gate.droppedTerminalHeldItemIds
      ? rawStaleCheckpoints.filter(
          (warning) => !gate.droppedTerminalHeldItemIds!.includes(warning.id),
        )
      : rawStaleCheckpoints;
    if (gate.verdict === 'refuse') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              requested: false,
              error: 'flush-required',
              tripwires: gate.tripwires,
              note: gate.refusalText,
            }),
          },
        ],
        isError: true,
      };
    }
    // compaction-context-loss-2026-07-05 P-001: force-ingest the caller's
    // transcript into the episodic index AT the moment of (deliberate) loss —
    // the server-mediated write-time flush that works for EVERY client
    // (claude/omp/codex), no PreCompact hook required. Fail-soft: the 2-min
    // ingest tick + the read-time self live-tail (D-002) cover any miss.
    let self: Awaited<
      ReturnType<typeof import('../../search/self-session').resolveSelfSession>
    > | null = null;
    try {
      const { resolveSelfSession } = await import('../../search/self-session');
      self = await resolveSelfSession(identity.ownerId);
      if (self) {
        const { ingestFileNow } = await import('../../search/session-ingest');
        await ingestFileNow(self.filePath);
      }
    } catch { /* best-effort */ }
    // P-018: assemble the successor launch spec from the deterministic carry
    // producers. Assembly failure leaves the CURRENT session intact (a loud
    // error, never a blind cut) — the agent retries after addressing it.
    let effectiveWindowTokens = FALLBACK_EFFECTIVE_WINDOW_TOKENS;
    try {
      const observedWindow = await estimateContextWindowForOwner(identity.ownerId);
      if (observedWindow != null) {
        effectiveWindowTokens = observedWindow;
      } else {
        const spec = await resolveModelSpecForOwner(identity.ownerId);
        if (spec) effectiveWindowTokens = modelWindowForSpec(spec);
      }
    } catch { /* conservative fallback stands */ }
    const spec = await buildOwnerRespawnLaunchSpec(identity.ownerId, {
      effectiveWindowTokens,
      role: (ctx as { role?: string | null }).role,
      buildOpts: {
        workspaceId: identity.workspaceId ?? undefined,
        transcriptPath: self?.filePath,
        transcriptSourceKind: self?.sourceKind,
        boundaryDeliberate: true,
        // This tool runs INSIDE the turn being compacted, so the final tail turn
        // is ours and still executing — it cannot carry the `delivered` receipt
        // yet (EI-23580220186598636). Attest it, so the owner message this turn
        // is answering is not re-delivered to the successor as a duplicate.
        finalTurnInFlight: true,
      },
    });
    if (!spec) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              requested: false,
              error: 'carry_build_failed',
              note: 'The deterministic carry could not be assembled; this session remains alive and uncut. Flush state (work_items:checkpoint) and retry.',
            }),
          },
        ],
        isError: true,
      };
    }
    // P-010: an OPEN owner message becomes the successor's first prompt (a live
    // ask, never quoted history) — spec.firstPrompt already carries it through
    // the ONE shared kickoff source (deriveLaunchPromptText). Otherwise the
    // successor opens on the continue+re-orient note, envelope-tagged
    // `self-compaction` so the turn-provenance hook classifies it machine-origin
    // (turn-provenance-owner-vs-agent P-002).
    // P-010's transcript-tail gate covers an unanswered human turn. An
    // immediately-created coord:ask-owner question has no such turn: it lives
    // in the conversation ledger and is carried in the spec's asks slot. Keep
    // the two predicates separate in the respawn spec, but report the union so
    // callers do not receive a false "no open owner question" immediately after
    // opening a ledger-backed owner ask.
    const openOwnerMessageQuestion = spec.openOwnerQuestion.crossesOpenOwnerMessage;
    const openOwnerAskCount = spec.openOwnerAskCount ?? 0;
    const openOwnerQuestion = openOwnerMessageQuestion || openOwnerAskCount > 0;
    const firstPrompt =
      spec.firstPrompt ??
      (await (async () => {
        // EI-22131227584499489: `focus`/`continueNote` are free text the
        // CALLING owner wrote itself — nothing else verifies it actually names
        // that owner's own state before it becomes a confident "resume: <text>"
        // instruction. Flag a WI-/EI-/F- id or carry-note hash this owner does
        // not itself hold (fail-open: a hit only PREPENDS a caution, never
        // rewrites or blocks the caller's text).
        const role = (ctx as { role?: string | null }).role;
        const hint = args.continueNote ?? focus;
        const retractedHintRefs = (spec.retractedContinuationRefs ?? []).filter((id) =>
          hint.toUpperCase().includes(id.toUpperCase()),
        );
        const integrityWarning = retractedHintRefs.length
          ? ''
          : renderFocusIntegrityWarning(focusIntegrityRefs);
        const rawNote = retractedHintRefs.length
          ? retractionSafeContinueNote(retractedHintRefs, role)
          : hasUnverifiedFocusRefs
            ? defaultContinueNote(safeFocus, role)
            : (args.continueNote ?? defaultContinueNote(focus, role)).trim();
        // WI-2140968: address the note to the owner it was written for BEFORE
        // tagging, so the line is inside the payload the ledger hashes and
        // travels with the text down whichever path delivers it.
        const note = addressContinuationToOwner(
          integrityWarning ? `${integrityWarning}\n\n${rawNote}` : rawNote,
          identity.ownerId,
        );
        try {
          return (await tagTurnForInjection({ sid: identity.ownerId, origin: 'self-compaction', text: note }))
            .taggedText;
        } catch {
          return note; // provenance must never break a boundary
        }
      })());
    // Only the first prompt is live caller-authored successor input at this
    // boundary. The deterministic system addendum may contain immutable
    // transcript/history prose that names a stale candidate while documenting
    // what the carry contains; scanning it again turns historical evidence into
    // an executable instruction and can strand compaction permanently.
    const hostCarryRefusal = frozenCompactionCarryRefusal(firstPrompt);
    if (hostCarryRefusal) return hostCarryRefusal;
    // Persist the exact carry before the host can accept the socket request.
    // A host may recover this same owner through a fresh bootstrap instead of
    // its in-place respawn path, so socket-only delivery is not sufficient.
    let pendingCarryRespawn: Awaited<ReturnType<typeof savePendingCarryRespawn>>;
    try {
      pendingCarryRespawn = await savePendingCarryRespawn(identity, {
        firstPrompt,
        systemPromptAddendum: spec.systemPromptAddendum,
      });
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            requested: false,
            error: 'carry_persist_failed',
            note: `The carry-respawn was not sent because its durable continuation could not be saved: ${(error as Error)?.message ?? error}`,
          }),
        }],
        isError: true,
      };
    }
    if (!pendingCarryRespawn) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            requested: false,
            error: 'carry_persist_failed',
            note: 'The carry-respawn was not sent because its durable continuation could not be saved.',
          }),
        }],
        isError: true,
      };
    }
    // EI-19480099650947832: read what happened to this session's PREVIOUS
    // carry-respawn BEFORE injecting this one, so the verdict describes prior
    // history rather than the request we are about to make. `respawn: true` only
    // ever meant "the socket write was accepted" — the host still has to win a
    // busy-gate and can terminally drop the carry, and until now every one of
    // those drops was invisible to the caller (they land in a per-owner JSONL
    // the tool layer never read). Fail-soft by construction: an unreadable log
    // reports `none` and changes nothing.
    const priorRespawn = await readPriorRespawnOutcome(identity.ownerId);
    const ok = await injectIntoHost(
      host.sock,
      {
        mode: 'carry-respawn',
        data: firstPrompt,
        systemPromptAddendum: spec.systemPromptAddendum,
        ...(self?.sourceKind === 'codex' && self.filePath ? { sourceTranscriptPath: self.filePath } : {}),
        ownerId: identity.ownerId,
      },
      // EI-18686525818431054: NOT the 2000ms default — see
      // CARRY_RESPAWN_SOCKET_TIMEOUT_MS's doc comment above.
      CARRY_RESPAWN_SOCKET_TIMEOUT_MS,
    );
    if (!ok) {
      // Clear only this attempt. A newer concurrent compaction request owns a
      // different nonce and must survive this host refusal.
      try {
        await clearPendingCarryRespawn(identity.ownerId, pendingCarryRespawn.nonce);
      } catch {
        /* short expiry is the backstop if this best-effort cleanup misses */
      }
    }
    // EI-18676518990229124 (session-death-claim-release-2026-07-11 P-002 false
    // positive): the cut we just queued will end THIS process under the SAME
    // ownerId and relaunch it in seconds — the killed child's ordinary
    // SessionEnd/Stop hook must NOT be read as "this owner is confirmed dead"
    // and force-release every work-item lease it holds. Mark the owner
    // "respawn expected" now (only once the respawn is genuinely queued, i.e.
    // the socket write succeeded) so report.ts's P-002 branch skips the
    // release for this transition; a respawn that never lands still frees the
    // owner's claims via the P-001 scheduled backstop (the marker's short TTL).
    // Awaited (WI-6756 follow-on): the mark is a PG row now, not a heap entry —
    // the operator is clustered, so the worker that handles the imminent
    // SessionEnd is usually NOT this one. It must be durably written before the
    // respawn's SessionEnd can race it; markRespawnExpected never throws.
    if (ok) await markRespawnExpected(identity.ownerId);
    // EI-21878494442396728: the marker above deliberately stops the SessionEnd path
    // from releasing this owner's state — right for work-item leases, WRONG for the
    // automatic `PreToolUse:*` edit locks. Those denote an edit that dies with this
    // process, nothing else frees them (the delayed session-end hook returns
    // `owner-resumed` the instant the successor registers), and git-sync correctly
    // skips live-locked dirty paths — so the agent's own just-written files are
    // silently passed over for the full 20-minute TTL and `work_items:complete` then
    // stamps `completionAuthority:'proposed'` on otherwise-green work.
    //
    // HERE and nowhere later: a lock row carries no session id, so this release can
    // only tell the dead session's locks from a successor's while exactly one session
    // exists. The cut is idle-gated (it fires after THIS turn ends), so the successor
    // is not up yet and every hook lock held now belongs to an edit that already
    // returned. Deliberate `locks:acquire` holds and named-resource locks are left
    // alone — the successor is meant to resume holding those.
    //
    // Fail-soft exactly like markRespawnExpected above and bumpSessionEpoch below: a
    // missed release degrades to today's behaviour (the lease expires) rather than
    // failing the compaction the caller asked for.
    if (ok) {
      try {
        await releaseOwnerHookFileLocks({ ownerId: identity.ownerId });
      } catch {
        /* never block the cut on lock hygiene — the 20-minute lease is the backstop */
      }
    }
    // WI-36074 (context-injection P-023): THE MEMORY EPOCH BOUNDARY.
    //
    // The per-session surfaced ledger (memory_session_surfaced) suppresses
    // re-injecting a memory this session has already been shown, on the premise
    // that a WARM session still HAS it in context. `bumpSessionEpoch` is the only
    // thing that clears that suppression, and its whole design is "bump at the
    // moment context is wiped, so the pool becomes injectable again".
    //
    // Until now its ONLY production reach was compact-reprime.ts, called from the
    // session-recovery-brief route, fetched ONLY by the SessionStart hook gated on
    // `source === 'compact'`. psu sessions launch with DISABLE_COMPACT=1 +
    // DISABLE_AUTO_COMPACT=1 (psu-pty-host.mjs, the P-022 cutover), so native
    // compaction NEVER fires and that hook NEVER runs — the P-022 cutover moved the
    // compaction boundary HERE (carry-respawn) and silently orphaned the bump.
    //
    // Measured 2026-08-08 before this fix: last bump ever 2026-08-02 (6 days, 0 in
    // 24h) while ~29 agents ran continuously; 56,734 of 57,154 ledger rows (99.3%)
    // frozen at epoch 0; every one of the 12 most-active sessions of the prior 48h
    // absent from memory_session_epochs entirely. Net effect: every memory ever
    // injected stayed suppressed for the 14-day GC horizon — ACROSS the respawn that
    // wiped the context, i.e. precisely when re-priming matters most. That is the
    // mechanism behind D-071's dedup=42.6% and its zeroed recalls (returned 12 →
    // admitted 0).
    //
    // Fail-soft exactly like markRespawnExpected above: bumpSessionEpoch swallows its
    // own errors and returns null, and a missed bump degrades to the (broken) prior
    // behavior rather than failing the compaction the caller asked for.
    if (ok) {
      try {
        const { sql } = getOrgPg();
        await bumpSessionEpoch(sql, identity.ownerId);
      } catch {
        /* never block the cut on memory hygiene */
      }
    }
    // EI-8987: the cut is already QUEUED at this point (idle-gated — it fires
    // after THIS turn ends), so a warning here is still actionable: the turn
    // hasn't ended yet, so the agent reading this result can fire one more
    // work_items:checkpoint call for the flagged item(s) before it truly stops.
    // The carry ADDENDUM was already assembled above, but a late checkpoint
    // still reaches the successor through the work-item's own re-injection
    // surface on next invocation — checkpoints never ride the addendum alone.
    const missing = staleCheckpoints.filter((s) => s.reason === 'missing');
    const stale = staleCheckpoints.filter((s) => s.reason === 'stale');
    const staleNote =
      ok && staleCheckpoints.length > 0
        ? ` ⚠ flush-integrity:${
            missing.length > 0
              ? ` ${missing.length} held work-item(s) have NO checkpoint written (${missing.map((s) => s.id).join(', ')}) — write one now (work_items:checkpoint) before you actually stop, or that state will not carry.`
              : ''
          }${
            stale.length > 0
              ? ` ${stale.length} held work-item(s) have a STALE checkpoint (${stale
                  .map((s) => `${s.id} ${s.ageMinutes}m of progress after checkpoint`)
                  .join(', ')}) — everything since it was written will NOT carry; refresh it now if this unit progressed since.`
              : ''
          }`
        : '';
    // WI-5936 / EI-16611: native `run_in_background` Bash jobs live in the CLI
    // CHILD process's memory, so THIS cut SIGTERMs them — the logical session
    // continues while the job dies silently, and a carry-note citing its task id
    // is a dead reference to the successor. Warn (never refuse): the cut is
    // idle-gated and fires after this turn ends, so the agent reading this still
    // has time to wait for the job or re-launch it under capability:bash. The
    // liveness claim is an OS-level fd scan, not an inference from the record's
    // age. Fail-soft — bookkeeping must never block a cut. The scan is async and
    // deadline-bounded (WI-10005283): it walks all of /proc, so a synchronous
    // read here stalled this handler's event loop for seconds.
    let nativeBgTasks: NativeBgTaskReport = {
      live: [],
      unattributed: [],
      degraded: false,
    };
    try {
      nativeBgTasks = await readLiveNativeBgTasks({ sid: identity.ownerId });
    } catch {
      /* never block the cut on bg bookkeeping */
    }
    const nativeBgNote = ok ? renderNativeBgTaskWarning(nativeBgTasks) : '';
    // P-010 informative note: when the owner's final message is open, the cut
    // does NOT lose it — it IS the successor's first prompt.
    //
    // The wording MUST track the gate's `basis`. A `history-uncertain` gate is an
    // ABSENCE of evidence — the tail reader's byte window truncated the history — not
    // evidence that an owner spoke, and an agent-launched session may have no owner
    // speech at all (WI-10002032). Emitting the known-unanswered wording there asserts
    // that an owner message EXISTS, which is precisely the "manufacture an owner
    // directive" failure the carry-provenance rules exist to prevent.
    const openQuestionNote =
      ok && openOwnerMessageQuestion
        ? spec.openOwnerQuestion.basis === 'history-uncertain'
          ? ` ⚠ open-owner-question: owner-request history is ${(
              spec.openOwnerQuestion.historyStatus ?? 'bounded'
            ).toUpperCase()}, so whether anything is owed is UNKNOWN at this DELIBERATE boundary.` +
            ' This is NOT a finding that an owner message exists — an agent-launched session may' +
            ' have no owner speech at all. Nothing is lost across the cut: any such message becomes' +
            " your successor's first prompt. Do not answer, and do not infer an owner directive," +
            ' from an unknown.'
          : " ⚠ open-owner-question: your owner's final message looks UNANSWERED at this DELIBERATE" +
            ' boundary. It is NOT lost — it becomes your successor’s first prompt — but if you' +
            ' have room, answer it before you stop.'
        : ok && openOwnerAskCount > 0
          ? ` ⚠ open-owner-question: ${openOwnerAskCount} owner ask(s) remain OPEN in the conversation ledger at this DELIBERATE boundary. They are carried in the deterministic document; do not self-answer them after the respawn.`
          : '';
    // WI-3801 lint + P-014 turn-ref verification/origin stamp over the two
    // free-text carry hints this call writes (focus always; continueNote only
    // when the caller passed one explicitly — the synthesized
    // defaultContinueNote is machine-authored, nothing to lint).
    const provenanceFields = await carryProvenanceFields(
      [focus, args.continueNote].filter((s): s is string => Boolean(s && s.trim())).join('\n'),
      identity.ownerId,
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok,
            requested: ok,
            // EI-19326331501849713: 'queued', NOT `true`. This field only ever
            // meant "the socket write was accepted" (see the comment at the
            // readPriorRespawnOutcome call above) — the host still has to win the
            // busy gate and can terminally DROP the carry. A BOOLEAN here read as
            // a statement about an OUTCOME, which is exactly what let a dropped
            // respawn pass for a successful one: told `true`, the agent stops
            // managing its own context and waits for a successor that never comes.
            // A string states the intent honestly. It stays TRUTHY, so any existing
            // `if (res.respawn)` is unaffected.
            respawn: ok ? 'queued' : false,
            budgetChars: spec.budgetChars,
            firstPromptSource: spec.firstPrompt ? 'open-owner-message' : 'continuation-note',
            staleCheckpoints,
            // WI-5936: present only when this cut would actually kill something,
            // so a clean session pays no payload for it.
            ...(nativeBgTasks.live.length > 0 ||
            nativeBgTasks.unattributed.length > 0 ||
            nativeBgTasks.degraded
              ? { nativeBgTasks }
              : {}),
            openOwnerQuestion,
            priorRespawn,
            ...(gate.verdict === 'mechanical-fallback' && gate.fallback
              ? { mechanicalFallback: gate.fallback }
              : {}),
            ...provenanceFields,
            ...(!ok ? { hostSock: host.sock, hostPid: host.pid } : {}),
            note:
              (!ok
                ? // EI-18686525818431054 ask #3: name the socket path + host pid tried,
                  // so the next diagnosis doesn't have to reverse-engineer it from `ps`
                  // + `find` (this filing's own investigation cost ~6 tool calls on that
                  // alone). `identity.ownerId` is already on the caller's side to compare.
                  `Failed to reach the session TUI host socket (${host.sock}, host pid ${host.pid}) ` +
                  `even after waiting up to ${CARRY_RESPAWN_SOCKET_TIMEOUT_MS}ms; try again. If this ` +
                  'recurs, the host process may predate the ack-early carry-respawn fix (WI-5872 ' +
                  'follow-up #2) — it never restarts on its own (only its child CLI does via ' +
                  'carry-respawn), so a genuinely stale host requires ending this session and ' +
                  'relaunching to pick up a current one.'
                : // EI-19326331501849713: state the QUEUE, never the outcome. The old
                  // wording ("the host cuts this process ... it resumes automatically")
                  // described a cut that had not happened yet as though it had, and
                  // told the agent to stop — so a carry that was then DROPPED left it
                  // waiting for a successor that did not exist, still holding unflushed
                  // state. Name the precondition (pty quiet) and the falsifier (you are
                  // still here) so the failure is self-diagnosing from the agent's side.
                  'Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting.') +
              staleNote +
              nativeBgNote +
              openQuestionNote +
              // EI-19480099650947832: only ever emitted on evidence from the
              // host's own event log — silent when the last respawn delivered.
              (ok ? priorRespawnNote(priorRespawn) : ''),
          }),
        },
      ],
    };
  },
});
