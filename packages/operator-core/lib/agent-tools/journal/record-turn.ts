/**
 * journal:record-turn — ingest one per-turn journal note at turn end
 * (deterministic-context-carry-2026-07-14 P-012, plan D-003).
 *
 * Called by the per-CLI turn-end hooks (the cc/ Stop hook for Claude/Codex;
 * the OMP in-process turn_end port) with the session id + transcript path.
 * The SERVER does the extraction — one extractor across every client: the
 * agent's trailing `⟦journal⟧ …` line when it wrote one (source='agent'),
 * else the first line of the last assistant message (source='mechanical',
 * flagged). The claim-vs-ledger tripwire runs at ingest: a success claim in
 * the note contradicted by an error in the same turn's agent_activity ledger
 * stamps `tripwire` on the row (journals are never graded — the diff audits
 * honesty; ambient-semantic-push D-008).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { requireWorkspaceId, resolveAgentIdentity } from '../coordination/identity';
import {
  detectClaimLedgerMismatch,
  extractJournalFromAssistantText,
  readLastAssistantTurn,
  resolveTranscriptPath,
} from '../../turn-journal';
import { latestJournalCreatedAt, ledgerEntriesSince, recordTurnJournal } from '../../turn-journal-store';
import { resolveCurrentTurnStamp } from '../../turn-provenance/turn-ref';

/** Without a previous journal row the turn window falls back to this. */
const DEFAULT_TURN_WINDOW_MS = 6 * 60 * 60 * 1000;

export default defineTool({
  name: 'journal:record-turn',
  profile: 'engineer',
  description:
    "Record the acting agent's per-turn journal note at turn end: extracts the trailing ⟦journal⟧ line from the session's last assistant message (mechanical first-line fallback, flagged), runs the claim-vs-ledger tripwire against the turn's tool ledger, and stores one row in session_turn_journal. Called by the per-CLI turn-end hooks; fire-and-forget.",
  capability: 'activity:report',
  guidance: {
    when: 'Almost never call this by hand — the per-CLI turn-end hooks (stop-turn-journal.sh / the OMP turn_end port) call it automatically at each turn end.',
    notWhen: 'To READ journal notes use `journal:recent`. To report a tool call use `activity:report`.',
    seeAlso: [
      'journal:recent (read the journal stream)',
      'activity:report (the tool ledger the tripwire diffs against)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    /** The journaling worker's coordination identity (PAPERCUSP_SID). */
    owner: z.string().min(1).max(256).optional(),
    /** Which CLI produced the turn: 'claude' | 'codex' | 'omp'. Best-effort. */
    agent: z.string().max(32).optional(),
    /** The CLI's native session id. */
    session_id: z.string().min(1).max(256),
    /** The transcript JSONL path (from the hook event). Must live under a
     *  known transcript root — anything else is refused, then the roots are
     *  walked by session id instead. */
    transcript_path: z.string().max(1024).optional(),
    /** Transcript adapter kind (default 'claude'). */
    source_kind: z.enum(['claude', 'omp', 'codex']).optional(),
    /** The harness the worker is in, when known. */
    harness: z.string().max(80).optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ownerId = args.owner ?? identity.ownerId ?? null;
    const sourceKind = args.source_kind ?? 'claude';
    // D-005 / P-007: the journal + cursor writers now REQUIRE an explicit
    // workspace. Resolved once here so both rows land in the same partition.
    const journalWorkspaceId = requireWorkspaceId(identity, 'journal:record-turn');

    let goalPlacementTurnEnd: { recorded: boolean; reason: string } | null = null;
    if (ownerId && ownerId === identity.ownerId) {
      const input = { ownerId, workspaceId: journalWorkspaceId, nativeSessionId: args.session_id, sourceKind };
      try {
        const receipts = await import('../../goal-placement-turn-receipts');
        goalPlacementTurnEnd = await receipts.boundedRecordGoalPlacementTurnEnd(input);
        if (!goalPlacementTurnEnd.recorded && goalPlacementTurnEnd.reason !== 'no-canonical-goal') {
          await receipts.boundedRecordGoalPlacementTurnEndOutcome(input, goalPlacementTurnEnd);
        }
      } catch {
        goalPlacementTurnEnd ??= { recorded: false, reason: 'turn-end-read-unavailable' };
      }
    }

    const filePath = await resolveTranscriptPath(sourceKind, args.session_id, args.transcript_path);
    if (!filePath) {
      return { data: { ok: false, recorded: false, reason: 'transcript_not_found', goalPlacementTurnEnd } };
    }
    // Journal prose itself is never completion or eligibility evidence.
    const turn = await readLastAssistantTurn(filePath, sourceKind);
    if (!turn) {
      return { data: { ok: false, recorded: false, reason: 'no_assistant_turn', goalPlacementTurnEnd } };
    }
    const currentTurn = ownerId
      ? await resolveCurrentTurnStamp(ownerId, { filePath, sessionId: args.session_id }).catch(() => null)
      : null;
    const machineTurn = currentTurn?.verdict === 'agent-injected' || currentTurn?.verdict === 'machine-surface';
    const extracted = extractJournalFromAssistantText(turn.text);
    if (!extracted) {
      return { data: { ok: false, recorded: false, reason: 'no_note', goalPlacementTurnEnd } };
    }

    // Turn window = everything since the previous journal row for this session
    // (first journal of a session falls back to a bounded window).
    const prev = await latestJournalCreatedAt(args.session_id);
    const since = prev ?? new Date(Date.now() - DEFAULT_TURN_WINDOW_MS);
    const sinceIso = typeof since === 'string' ? since : since.toISOString();
    const ledger = await ledgerEntriesSince(args.session_id, since);
    const claimTripwire = detectClaimLedgerMismatch(extracted.note, ledger);
    // P-015 turn-end sweep: deliverables written to scratch this turn with no
    // artifacts:save registration. The claim-mismatch tripwire outranks it on
    // the single tripwire slot (dishonesty > untracked output); the sweep is
    // bounded + fail-soft and only runs when the slot is free.
    const ioMod = await import('../../turn-end-tracking-io');
    const artifactTripwire = claimTripwire ? null : await ioMod.boundedArtifactSweep(args.session_id, sinceIso);
    // P-005 (pui-agent-context-cockpit): pending/in_progress canonical session
    // tasks require a visible, bounded continuation when no loop or bounded
    // await guarantees the next turn. The prior journal
    // tripwire carries the unchanged-task attempt count across turns.
    const openTaskReminder =
      ownerId && !claimTripwire
        ? await ioMod.boundedOpenTaskReminderSweep({
            ownerId,
            workspaceId: journalWorkspaceId,
          })
        : null;
    // P-015 turn-end sweep (re-wake guarantee): an AUTONOMOUS session ending a
    // turn with no armed loop, no real (non-inbox-wake) event-await, and no
    // owner present is about to SILENTLY HALT — the classic lost-session
    // failure ("ended a turn expecting a wake that was not armed"). Warn-only:
    // record a visible tripwire so the owner-report / successor / next orient
    // surfaces it (the continuation gate is the live nudge for an agent that
    // self-checks). Outranks the artifact sweep on the single slot (a lost
    // session > a lost file); never masks a dishonest note (claim wins).
    const unguardedHaltTripwire =
      ownerId && !claimTripwire && !openTaskReminder
        ? await ioMod.boundedUnguardedHaltSweep({
            ownerId,
            workspaceId: identity.workspaceId ?? '*',
            machineTurn,
          })
        : null;
    // Claim honesty always wins the single journal slot. A concrete open-task
    // continuation is more actionable than the generic unguarded-halt warning.
    const tripwire = claimTripwire ?? openTaskReminder?.tripwire ?? unguardedHaltTripwire ?? artifactTripwire;

    const { id, deduped } = await recordTurnJournal({
      workspaceId: journalWorkspaceId,
      ownerId,
      agent: args.agent ?? null,
      sourceKind,
      sessionId: args.session_id,
      turnTs: turn.ts,
      note: extracted.note,
      source: extracted.source,
      flagged: extracted.flagged,
      tripwire,
      harnessSlug: args.harness ?? null,
    });

    // Persist FIRST, then wake: the injected turn and every later reader can
    // recover the exact attempt/signature from session_turn_journal. A deduped
    // hook call never spends a second continuation attempt.
    let openTaskReminderWoken = false;
    if (ownerId && openTaskReminder && !deduped && tripwire === openTaskReminder.tripwire) {
      openTaskReminderWoken = await ioMod.boundedWakeOpenTaskReminder({
        ownerId,
        workspaceId: journalWorkspaceId,
        decision: openTaskReminder,
      });
    }

    // P-015 turn-end sweep: mechanically checkpoint the holder's stale held
    // work-items (missing checkpoint, or older than the staleness threshold)
    // from what the system already tracks — this turn's journal note + the
    // P-013 tool-call log tail. Marked ⟦auto-checkpoint mechanical⟧, never
    // overwrites agent-authored prose. Bounded + fail-soft; plan D-003.
    let autoCheckpointed: Array<{ id: string; mechanical: true }> = [];
    if (ownerId && !deduped) {
      const { boundedAutoCheckpoint } = await import('../../turn-end-tracking-io');
      autoCheckpointed = await boundedAutoCheckpoint({
        ownerId,
        workspaceId: identity.workspaceId ?? '*',
        sessionId: args.session_id,
        sinceIso,
        journalNote: extracted.note,
      });
    }

    // unread-count-truthfulness-2026-07-27 P-008 / D-008: SETTLE the coord
    // read cursor. `messages_since_ts` had exactly one writer (the OMP hook's
    // onTurnEnd), so on a Claude/Codex fleet it was never written at all and
    // read as "never read anything" — the 19k unread badge. This seam is the
    // one server-side turn-end moment shared by every CLI, so settling here
    // covers every client and a future transport inherits it. The value is
    // derived server-side from the authoritative receipt (`messages_shown_ts`),
    // monotone + clamped, so it can neither regress an OMP-reported cursor nor
    // advance past what was demonstrably shown. Abort-safety is inherited: this
    // seam does not fire for an interrupted/frozen turn, so aborted mail is
    // still re-delivered. Bounded + fail-soft; fresh (non-deduped) turns only.
    let coordCursorSettledTo: string | null = null;
    if (ownerId && !deduped) {
      const { boundedCoordWatermarkSettle } = await import('../../turn-end-tracking-io');
      coordCursorSettledTo = await boundedCoordWatermarkSettle({ ownerId });
    }

    // P-001 (ambient-semantic-push) turn-end lexical cursor: rebuild this
    // session's recency-decayed sparse term-weight cursor from its recent
    // journal notes (echo-guarded to the agent's OWN notes) and upsert it —
    // the join surface P-002/P-004 read. DEFAULT-OFF behind
    // PAPERCUSP_AMBIENT_CURSOR (the env check gates BEFORE the dynamic import,
    // so the off path never loads the cursor code); bounded + fail-soft like
    // the sweeps above. Only on a fresh (non-deduped) journal row.
    let cursorPersisted = false;
    if (!deduped) {
      const v = process.env.PAPERCUSP_AMBIENT_CURSOR;
      if (v === '1' || v === 'true') {
        const { boundedBuildAndPersistCursor } = await import('../../session-cursor-io');
        cursorPersisted = await boundedBuildAndPersistCursor({
          workspaceId: journalWorkspaceId,
          sessionId: args.session_id,
          ownerId,
          harnessSlug: args.harness ?? null,
          turnTs: turn.ts,
        });
        // P-004 (ambient-semantic-push) collision matcher: the fresh cursor is
        // one tick of the sustained-collision detector. Fold it against the live
        // peer-cursor index and enqueue a collision push to BOTH sides on each
        // enter edge (push-delivery rail). Same flag/gate, bounded + fail-soft;
        // only when a cursor actually landed (no cursor ⇒ no tick).
        if (cursorPersisted) {
          const { boundedCollisionTick } = await import('../../collision-matcher-io');
          const collisionTick = await boundedCollisionTick({
            selfSessionId: args.session_id,
            selfOwnerId: ownerId,
          });
          // P-013 (ambient-semantic-push) adjacency cross-feed: the band BELOW
          // collision — two cursors that stay similar WITHOUT being duplicates
          // (adjacent lanes). Rides the SAME collisionCandidates snapshot the
          // collision tick just computed (compute once, feed both matchers):
          // sustained in-band overlap auto-subscribes both sides to a shared
          // 'adj:…' topic, and this turn's on-topic journal note cross-posts to
          // the adjacent peer as one bounded line. Same flag/gate, bounded +
          // fail-soft; skipped when the collision tick timed out (no snapshot).
          if (collisionTick.ran && collisionTick.snapshot) {
            const { boundedAdjacencyTick } = await import('../../adjacency-cross-feed-io');
            await boundedAdjacencyTick({
              selfSessionId: args.session_id,
              selfOwnerId: ownerId,
              snapshot: collisionTick.snapshot,
              ownerBySession: collisionTick.ownerBySession,
              journalNote: extracted.note,
            });
          }
          // P-006 (ambient-semantic-push) dead-end matcher: the same fresh cursor
          // is one tick of the dead-end detector. Fold the in-scope dead-end facts
          // (the P-015 slot — agent_facts keyed 'dead-end:%') and enqueue a WARNING
          // push (handle → the fact) to SELF for each documented dead end the
          // cursor is drifting toward. Same flag/gate, bounded + fail-soft; only
          // when a cursor actually landed. Independent of the collision tick above.
          const { boundedDeadEndTick } = await import('../../dead-end-matcher-io');
          await boundedDeadEndTick({
            selfSessionId: args.session_id,
            selfOwnerId: ownerId,
            harnessSlug: args.harness ?? null,
            workspaceId: identity.workspaceId ?? undefined,
          });
          // P-008 (ambient-semantic-push) topic auto-subscribe: the same fresh
          // cursor is one tick of the subscribe/unsubscribe machine
          // (topic-hysteresis, D-009). Score the cursor against the live topic
          // centroids, advance the carried per-session hysteresis state, actuate
          // real subscription changes, and enqueue each applied change as a
          // typed 'topic-sub' notice to SELF on the delivery rail (visible,
          // never silent). Same flag/gate, bounded + fail-soft.
          const { boundedTopicTick } = await import('../../topic-matcher-io');
          await boundedTopicTick({
            selfSessionId: args.session_id,
            selfOwnerId: ownerId,
          });
        }
      }
    }

    return {
      data: {
        ok: true,
        recorded: !deduped,
        deduped,
        id,
        source: extracted.source,
        flagged: extracted.flagged,
        tripwire,
        turn_ts: turn.ts ? turn.ts.toISOString() : null,
        goalPlacementTurnEnd,
        ...(autoCheckpointed.length ? { autoCheckpointed } : {}),
        ...(unguardedHaltTripwire ? { unguardedHalt: unguardedHaltTripwire } : {}),
        ...(openTaskReminder
          ? {
              openTaskReminder: openTaskReminder.tripwire,
              openTaskReminderWoken,
            }
          : {}),
        ...(cursorPersisted ? { cursorPersisted } : {}),
        ...(coordCursorSettledTo ? { coordCursorSettledTo } : {}),
      },
    };
  },
});
