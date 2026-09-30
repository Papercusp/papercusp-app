/**
 * turn-end-tracking-io — the IO wiring for the P-015 turn-end sweeps
 * (pure logic: ./turn-end-tracking.ts; seam: journal:record-turn).
 *
 * Every leg is bounded and fail-soft: the sweeps are advisory tracking, the
 * journal write they ride on is not allowed to slow down or fail because of
 * them (same contract as the carry-surface provenance stamp).
 */
import { withBoundedTimeout } from './bounded-timeout';
import { modeImpliesAutonomy } from './modes/registry';
import {
  awaitGuaranteesRewake,
  composeMechanicalCheckpoint,
  decideOpenTaskReminder,
  detectUnguardedHalt,
  isStaleHeldCheckpoint,
  mergeMechanicalCheckpoint,
  settledMessagesCursor,
  unregisteredArtifactTripwire,
  type UnguardedHaltTripwire,
  type UnregisteredArtifactTripwire,
  type OpenTaskReminderDecision,
  type OpenTaskReminderTripwire,
} from './turn-end-tracking';

/** Total budget for each sweep — advisory work riding a fire-and-forget hook. */
export const TURN_END_SWEEP_BUDGET_MS = 4_000;

/** Held items auto-checkpointed per turn end (readHeldWorkItems' own cap is 6). */
const MAX_AUTO_CHECKPOINTS = 4;

/** Tool-log tail folded into a mechanical checkpoint. */
const AUTO_CHECKPOINT_LOG_LINES = 12;

export interface AutoCheckpointResult {
  id: string;
  /** 'written' | 'skipped-fresh' is never reported (only written ids return). */
  mechanical: true;
}

/**
 * Auto-checkpoint the caller's held work-items whose checkpoints are missing
 * or stale: compose a mechanical block from the turn's journal note + the
 * P-013 tool-call log tail, merge it under the agent-authored prose (replacing
 * only a previous mechanical block), and write it back. Returns the item ids
 * written. Never throws.
 */
export async function autoCheckpointStaleHeldItems(input: {
  ownerId: string;
  workspaceId: string;
  sessionId: string;
  sinceIso: string;
  journalNote: string | null;
  nowMs?: number;
}): Promise<AutoCheckpointResult[]> {
  try {
    const [{ readHeldWorkItems }, { setWorkItemCheckpoint }, { toolCallRowsFor }, { renderToolCallLog }] =
      await Promise.all([
        import('./carry-brief'),
        import('./work-item-checkpoint'),
        import('./tool-call-log-store'),
        import('./tool-call-log'),
      ]);
    const nowMs = input.nowMs ?? Date.now();
    const held = await readHeldWorkItems(input.ownerId, input.workspaceId);
    const stale = held.filter((h) => isStaleHeldCheckpoint(h, nowMs)).slice(0, MAX_AUTO_CHECKPOINTS);
    if (stale.length === 0) return [];

    // One tool-log render for the turn window — shared across the stale items
    // (the snapshot is holder-session-level by design; the block says so).
    let toolLog = '';
    try {
      const rows = await toolCallRowsFor({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        sinceIso: input.sinceIso,
        limit: 400,
      });
      toolLog = renderToolCallLog(rows, { maxLines: AUTO_CHECKPOINT_LOG_LINES });
    } catch {
      /* the block is still useful with the journal note alone */
    }
    const block = composeMechanicalCheckpoint({
      atIso: new Date(nowMs).toISOString(),
      journalNote: input.journalNote,
      toolLog,
      sessionId: input.sessionId,
    });

    const written: AutoCheckpointResult[] = [];
    for (const item of stale) {
      try {
        await setWorkItemCheckpoint(
          { harness: item.harness, workItemId: item.id, workspaceId: input.workspaceId },
          mergeMechanicalCheckpoint(item.checkpoint, block),
        );
        written.push({ id: item.id, mechanical: true });
      } catch {
        /* per-item fail-soft */
      }
    }
    return written;
  } catch {
    return [];
  }
}

/**
 * The unregistered-artifact sweep for one turn window: the turn's file-write
 * ledger vs the artifact registrations in the same window. Null on the clean
 * (overwhelmingly common) case. Never throws.
 */
export async function sweepUnregisteredArtifacts(
  sessionId: string,
  sinceIso: string,
): Promise<UnregisteredArtifactTripwire | null> {
  try {
    const { fileWritesSince, artifactRelPathsSince } = await import('./turn-journal-store');
    const writes = await fileWritesSince(sessionId, sinceIso);
    if (writes.length === 0) return null;
    const registered = await artifactRelPathsSince(sinceIso);
    return unregisteredArtifactTripwire(writes, registered);
  } catch {
    return null;
  }
}

/** Bounded wrappers — the record-turn handler calls these. */
export async function boundedArtifactSweep(
  sessionId: string,
  sinceIso: string,
): Promise<UnregisteredArtifactTripwire | null> {
  const { value } = await withBoundedTimeout(sweepUnregisteredArtifacts(sessionId, sinceIso), {
    fallback: null,
    timeoutMs: TURN_END_SWEEP_BUDGET_MS,
    label: 'turn-end-artifact-sweep',
  });
  return value;
}

export async function boundedAutoCheckpoint(
  input: Parameters<typeof autoCheckpointStaleHeldItems>[0],
): Promise<AutoCheckpointResult[]> {
  const { value } = await withBoundedTimeout(autoCheckpointStaleHeldItems(input), {
    fallback: [] as AutoCheckpointResult[],
    timeoutMs: TURN_END_SWEEP_BUDGET_MS,
    label: 'turn-end-auto-checkpoint',
  });
  return value;
}

/** How far back to look for a release-time tool-log tail — generous, since a
 *  releasing holder's OWN session length is unknown (unlike the turn-end
 *  sweep, which has the exact `sinceIso` of the last journal row). */
const RELEASE_CHECKPOINT_LOOKBACK_MS = 3 * 60 * 60 * 1000;

/**
 * EI-18734870651452334: mechanically checkpoint a work-item AT THE MOMENT its
 * claim is released, whenever the releasing holder left NO agent-written
 * checkpoint. Covers every release path that routes through
 * `releaseWorkItem` — the voluntary `work_items:release` tool, the P-002
 * SessionEnd fast-path force-release, and the P-001 stale-claim reaper
 * backstop (`releaseAllWorkItemLeasesForOwner`) — because all three call the
 * SAME function. Without this, a holder that compacts/dies/gets reaped mid-
 * work with no checkpoint yet written releases a claim that is
 * INDISTINGUISHABLE from never-started, actively inviting the next claimant
 * to rebuild already-shipped work (the exact failure this item reports:
 * `TimerClassification` + its CI wiring were fully built and never recorded
 * anywhere before the claim lapsed).
 *
 * A no-op (fail-soft, bounded) when a real checkpoint already exists — this
 * NEVER overwrites agent-authored prose, only fills the gap when there is
 * none. Best-effort tool-log tail by `ownerId` (not `sessionId`: a release
 * path only knows the pre-release holder's ownerId, not which of its
 * sessions is ending) over a generous lookback window, since the exact
 * turn-boundary `sinceIso` the turn-end sweep has isn't available here.
 */
export async function checkpointOnRelease(input: {
  releasingOwnerId: string;
  workspaceId: string;
  harness: string | null;
  workItemId: string;
}): Promise<{ written: boolean }> {
  const { value } = await withBoundedTimeout(checkpointOnReleaseImpl(input), {
    fallback: { written: false },
    timeoutMs: TURN_END_SWEEP_BUDGET_MS,
    label: 'release-time-mechanical-checkpoint',
  });
  return value;
}

async function checkpointOnReleaseImpl(input: {
  releasingOwnerId: string;
  workspaceId: string;
  harness: string | null;
  workItemId: string;
}): Promise<{ written: boolean }> {
  try {
    const [{ getWorkItemCheckpointWithMeta, setWorkItemCheckpoint }, { toolCallRowsFor }, { renderToolCallLog }] =
      await Promise.all([import('./work-item-checkpoint'), import('./tool-call-log-store'), import('./tool-call-log')]);
    const ref = { harness: input.harness, workItemId: input.workItemId, workspaceId: input.workspaceId };
    const existing = await getWorkItemCheckpointWithMeta(ref);
    if (existing.checkpoint && existing.checkpoint.trim()) return { written: false };

    let toolLog = '';
    try {
      const sinceIso = new Date(Date.now() - RELEASE_CHECKPOINT_LOOKBACK_MS).toISOString();
      const rows = await toolCallRowsFor({
        ownerId: input.releasingOwnerId,
        workspaceId: input.workspaceId,
        sinceIso,
        limit: 400,
      });
      toolLog = renderToolCallLog(rows, { maxLines: AUTO_CHECKPOINT_LOG_LINES });
    } catch {
      /* the block is still useful with the release note alone */
    }
    const block = composeMechanicalCheckpoint({
      atIso: new Date().toISOString(),
      journalNote:
        `${input.releasingOwnerId}'s claim on this item was released with no agent-written checkpoint ` +
        `— look for already-completed work before rebuilding (EI-18734870651452334).`,
      toolLog,
    });
    await setWorkItemCheckpoint(ref, block);
    return { written: true };
  } catch {
    return { written: false };
  }
}

/**
 * The re-wake-guarantee sweep for one turn end: does this owner have a
 * guaranteed re-wake, or is an autonomous session about to silently halt? Reads
 * the three signals the compaction-strategy triad turns on — active
 * mode(s), the engine loop, and this owner's REAL (non-inbox-wake) event-awaits
 * — and returns the {@link UnguardedHaltTripwire} when none guarantee a wake.
 * Null (the common case) when a re-wake is guaranteed. Never throws.
 *
 * The `coord:inbox-wake:` keepalive is excluded on purpose: every live agent
 * always holds one (INBOX_WAKE_KEY_PREFIX), so counting it would mean the sweep
 * NEVER fires. It is liveness, not a deliberate wake for this session's work.
 */
export async function sweepUnguardedHalt(input: {
  ownerId: string;
  workspaceId: string;
  machineTurn?: boolean;
}): Promise<UnguardedHaltTripwire | null> {
  try {
    const [{ getModes }, { getLoopStatus }, { listActiveAwaits, INBOX_WAKE_KEY_PREFIX }] = await Promise.all([
      import('./modes/store'),
      import('./harness/routines/loop'),
      import('./events/await/store'),
    ]);
    const [modes, loop, awaits] = await Promise.all([
      getModes(input.workspaceId, input.ownerId).catch(() => []),
      getLoopStatus(input.ownerId).catch(() => null),
      listActiveAwaits(input.ownerId).catch(() => []),
    ]);
    const autonomousModeActive = modes.some((m) => modeImpliesAutonomy(m.mode));
    // WI-6604: an await counts as a re-wake GUARANTEE only if it is BOUNDED (has an
    // expiry) and set to WAKE on that deadline. An unbounded await, or one that merely
    // EXPIRES silently, wakes nobody when its event never fires — and "never fires" is a
    // routine outcome, not an exotic one: sleeping on `release:deployed` after a gate run
    // wakes nobody if the gate reds, because no deploy is ever attempted. Worse, a sleeping
    // await SUPPRESSES monitor-loop fires, so it takes an armed loop down with it and the
    // session reads active:true / parked:true while producing no turns. Counting such an
    // await as a guarantee is precisely how a session goes dark while every surface says
    // "safe to settle" — observed live 2026-07-28, ~26 minutes lost.
    const activeAwaitCount = awaits.filter((a) => awaitGuaranteesRewake(a, INBOX_WAKE_KEY_PREFIX)).length;
    return detectUnguardedHalt({
      autonomousModeActive,
      machineTurn: input.machineTurn,
      loopActive: Boolean(loop?.active),
      activeAwaitCount,
    });
  } catch {
    return null;
  }
}

export async function boundedUnguardedHaltSweep(input: {
  ownerId: string;
  workspaceId: string;
  machineTurn?: boolean;
}): Promise<UnguardedHaltTripwire | null> {
  const { value } = await withBoundedTimeout(sweepUnguardedHalt(input), {
    fallback: null,
    timeoutMs: TURN_END_SWEEP_BUDGET_MS,
    label: 'turn-end-unguarded-halt-sweep',
  });
  return value;
}

/**
 * Read the canonical per-owner task list and the concrete wake sources at turn
 * end, then apply the pure bounded continuation decision. The immediately
 * preceding journal row is the durable attempt counter; a different tripwire
 * or changed task signature resets the counter. Never throws.
 */
export async function sweepOpenTaskReminder(input: {
  ownerId: string;
  workspaceId: string;
}): Promise<OpenTaskReminderDecision | null> {
  try {
    const [db, tasksMod, loopMod, awaitMod, journalMod] = await Promise.all([
      import('@papercusp/db-org'),
      import('./session-tasks'),
      import('./harness/routines/loop'),
      import('./events/await/store'),
      import('./turn-journal-store'),
    ]);
    const { sql } = db.getOrgPg();
    const [view, loop, awaits, priorRows] = await Promise.all([
      // D-019: an SU attached to a PUI conversation keeps its list under the chat id.
      tasksMod.taskSessionIdForOwner(sql, input.workspaceId, input.ownerId).then((sessionId) =>
        tasksMod.applySessionTaskOp(sql, {
          op: 'view',
          workspaceId: input.workspaceId,
          sessionId,
          idFactory: () => 'turn-end-task-view',
        })),
      loopMod.getLoopStatus(input.ownerId).catch(() => null),
      awaitMod.listActiveAwaits(input.ownerId).catch(() => []),
      journalMod.recentTurnJournal({ ownerId: input.ownerId, limit: 1 }).catch(() => []),
    ]);
    const boundedAwaitActive = awaits.some((entry) => awaitGuaranteesRewake(entry, awaitMod.INBOX_WAKE_KEY_PREFIX));
    const prior = priorRows[0]?.tripwire;
    const priorTripwire: OpenTaskReminderTripwire | null = prior?.kind === 'open-task-reminder' ? prior : null;
    return decideOpenTaskReminder({
      tasks: view.tasks,
      wakeGuaranteed: Boolean(loop?.active) || boundedAwaitActive,
      priorTripwire,
    });
  } catch {
    return null;
  }
}

export async function boundedOpenTaskReminderSweep(
  input: Parameters<typeof sweepOpenTaskReminder>[0],
): Promise<OpenTaskReminderDecision | null> {
  const { value } = await withBoundedTimeout(sweepOpenTaskReminder(input), {
    fallback: null,
    timeoutMs: TURN_END_SWEEP_BUDGET_MS,
    label: 'turn-end-open-task-reminder-sweep',
  });
  return value;
}

/** Fire the already-persisted reminder back to this owner as one targeted turn. */
export async function wakeOpenTaskReminder(input: {
  ownerId: string;
  workspaceId: string;
  decision: OpenTaskReminderDecision;
}): Promise<boolean> {
  try {
    const { wakeRecipients } = await import('./agent-tools/coordination/inbox-wake');
    const result = await wakeRecipients([input.ownerId], {
      summary: input.decision.prompt,
      payload: input.decision.tripwire,
      source: 'turn-end-open-task-reminder',
      workspaceId: input.workspaceId,
    });
    return result.woken > 0;
  } catch {
    return false;
  }
}

export async function boundedWakeOpenTaskReminder(input: Parameters<typeof wakeOpenTaskReminder>[0]): Promise<boolean> {
  const { value } = await withBoundedTimeout(wakeOpenTaskReminder(input), {
    fallback: false,
    timeoutMs: TURN_END_SWEEP_BUDGET_MS,
    label: 'turn-end-open-task-reminder-wake',
  });
  return value;
}

/**
 * Settle this agent's `messages_since_ts` to the read receipt
 * (unread-count-truthfulness-2026-07-27 P-008 / D-008). Returns the ts written,
 * or null when no advance was warranted. Never throws.
 *
 * WHY THIS RIDES THIS SEAM. `messages_since_ts` had exactly ONE writer in the
 * tree — `coord:watermark-set` — with exactly ONE caller, the OMP hook's
 * `onTurnEnd`. Claude Code and Codex have no equivalent (the cc PostToolUse
 * hook keeps its cursor in a per-session FILE that never reaches PG), so on a
 * non-OMP fleet the cursor was NEVER written at all: measured 2026-07-27, of
 * the 14 agents with a clean turn end in 24h, 14/14 had a `messages_shown_ts`
 * and 0/14 a current `messages_since_ts`. An empty settle cursor reads as
 * "never read anything" — i.e. count from log epoch — which is the 19k unread
 * badge this plan exists to fix.
 *
 * `journal:record-turn` is the one server-side moment that fires at every turn
 * end across every CLI, so settling HERE covers every client at once and a
 * future transport inherits it: only the seam must fire, and the value is
 * derived server-side from the authoritative receipt rather than reported by
 * the client. ABORT-SAFETY is inherited, not rebuilt — cc's `Stop` hook does
 * not fire on user interrupt and OMP's `turn_end` never fires for a mid-turn
 * freeze, so an aborted turn still leaves the cursor put and re-delivers its
 * mail on the next turn.
 */
async function settleCoordWatermark(ownerId: string): Promise<string | null> {
  const { readWatermark, writeWatermark } = await import('./agent-tools/coordination/watermarks');
  const wm = await readWatermark(ownerId);
  const next = settledMessagesCursor({
    sinceTs: wm?.messages_since_ts,
    shownTs: wm?.messages_shown_ts,
  });
  if (!next) return null;
  await writeWatermark(ownerId, { messages_since_ts: next });
  // EI-9389, relocated here from `coord:watermark-set` by plan
  // fleet-deltas-leader-primitives-2026-07-10 (D-014) when that verb was retired.
  //
  // A bulk `coord:inbox` read has already shown this agent every message up to
  // `next`, but any `coord:send { wake:true }` delivery queued for those SAME
  // messages while the agent was busy still sits pending/parked on its standing
  // inbox-wake key — each one would burn a full billable resume turn
  // re-delivering traffic already read and acted on. Settling at the
  // "I have now seen everything up to X" signal closes that.
  //
  // THIS SEAM IS STRICTLY BETTER THAN THE OLD ONE, not merely equivalent. The
  // docstring above explains that `coord:watermark-set` had exactly one caller,
  // the OMP hook's `onTurnEnd` — so on a non-OMP fleet (Claude Code, Codex) this
  // settle NEVER RAN. `journal:record-turn` fires at every turn end on every
  // CLI, so the coalescing now covers clients that never had it.
  //
  // Best-effort by design: an advisory cleanup must never fail the watermark
  // write above, which has already succeeded.
  try {
    const { settleCaughtUpInboxWakeDeliveries } = await import('./events/await/store');
    await settleCaughtUpInboxWakeDeliveries({ subscriberId: ownerId, cutoffTs: next });
  } catch {
    /* advisory only — the cursor advance stands regardless */
  }
  return next;
}

export async function boundedCoordWatermarkSettle(input: { ownerId: string }): Promise<string | null> {
  const { value } = await withBoundedTimeout(
    settleCoordWatermark(input.ownerId).catch(() => null),
    {
      fallback: null,
      timeoutMs: TURN_END_SWEEP_BUDGET_MS,
      label: 'turn-end-coord-watermark-settle',
    },
  );
  return value;
}
