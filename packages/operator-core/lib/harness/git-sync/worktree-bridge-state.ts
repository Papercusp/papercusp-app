import type { EpochSeq } from '../../sync/pot-git/staging-advance';
import {
  decideWorktreeBridgeCursor,
  type WorktreeBridgeCursorRow,
} from '../../sync/pot-git/worktree-bridge-tick';

/**
 * EI-19332963201820362 — the COMPLETE persisted shape of
 * `routines.metadata.worktree_bridge`, plus the one function allowed to build it.
 *
 * ## Why this module exists (read before adding a field or a writer)
 *
 * `patchRoutineMetadata` is:
 *
 * ```sql
 * SET metadata = COALESCE(metadata,'{}'::jsonb) || $3::jsonb
 * ```
 *
 * `||` is a **TOP-LEVEL** jsonb merge. It merges at the first level only, so
 * writing the `worktree_bridge` key REPLACES that whole object rather than
 * deep-merging into it. Every write is therefore a read-modify-write contract,
 * and **any field a writer omits is DELETED**, silently, with no type error and
 * no runtime complaint.
 *
 * That is not hypothetical. The accept-free census was added to the main writer
 * and omitted from the malformed-row writer, so a single unparseable fed-event
 * row wiped `acceptFreeTicks`/`acceptFreeSince` mid-freeze and restarted the
 * streak from zero — meaning the detector built to catch a stalled bridge would
 * itself have gone quiet during the stall it existed to report. A detector that
 * erases its own state is worse than no detector, because it reads as green.
 *
 * The per-writer fix (re-state the fields at each site) is a mitigation: the
 * next person to add a writer, or a field, can forget again. This module is the
 * structural fix — if every writer must go through {@link nextWorktreeBridgeState}
 * to obtain a {@link WorktreeBridgeState}, omitting a field stops being possible
 * rather than merely being discouraged. Credit to su-a0e1afb5, who both caught
 * the defect and argued for the structural form over the local patch.
 *
 * ## Adding a field
 *
 * Add it to {@link WorktreeBridgeState} and populate it in
 * {@link nextWorktreeBridgeState}. Do NOT add it at a call site — a call site
 * that spreads its own extra keys reintroduces exactly the omission hazard this
 * module removes.
 */
export interface WorktreeBridgeState {
  /** Fed-event-log cursor: the last row id durably consumed. */
  lastEventId: number;
  /** Last ACCEPTED announcement's (epoch, seq) — null before the first accept. */
  epochSeq: EpochSeq | null;
  /** Last ACCEPTED staging sha — null before the first accept. */
  stagingSha: string | null;
  /** Wall-clock ms of the tick that wrote this. ⚠ Only ticks that had something
   *  to do write at all: a bridge with nothing pending returns early, so a stale
   *  `at` means "no traffic since", not "not running". */
  at: number;
  /** Announcements this tick actually processed. `0` means the tick had nothing
   *  to consume, which is the discriminator between a healthy IDLE bridge and a
   *  STARVING one — "accepted 0" alone cannot tell them apart. */
  consumed: number;
  /** Announcements this tick ACCEPTED. */
  accepted: number;
  /** Terminal (non-retryable) rejections this tick, by reason. Empty on a tick
   *  that consumed nothing. */
  rejectedTerminal: Record<string, number>;
  /**
   * Consecutive ticks that CONSUMED >=1 announcement and ACCEPTED none.
   *
   * A single such tick is ordinary (one stale or replayed envelope). A sustained
   * streak never is: it means the cursor is draining the announcement log while
   * the watermark stands still — canonical is frozen.
   *
   * ⚠ Read together with `at`. Ticks with nothing pending do not update either,
   * so a high streak beside a stale `at` is a HISTORICAL freeze that stopped
   * receiving announcements, not a live one.
   */
  acceptFreeTicks: number;
  /** Wall-clock ms when the current accept-free streak began; null when not in
   *  one. Lets a reader age the streak without counting ticks of unknown period. */
  acceptFreeSince: number | null;
}

/** What one tick observed. `consumed: 0` is the legitimate "nothing to do" case
 *  — it is NOT evidence about acceptance and must not disturb the streak. */
export interface WorktreeBridgeTickFacts {
  lastEventId: number;
  epochSeq: EpochSeq | null;
  stagingSha: string | null;
  consumed: number;
  accepted: number;
  rejectedTerminal: Record<string, number>;
  nowMs: number;
}

/** The outcome fields that jointly determine the cursor and persisted bridge
 * state. Kept structural so this decision seam does not depend on runtime-only
 * dial/fetch details from the full tick outcome. */
export interface WorktreeBridgePersistenceOutcome {
  unprocessedFromIndex: number | null;
  watermark: { epochSeq: EpochSeq | null; stagingSha: string | null };
  results: readonly unknown[];
  acceptedCount: number;
  terminalRejections: Record<string, number>;
}

/** The prior persisted state, as read back from jsonb. Every field is optional:
 *  rows written before a field existed simply lack it, and a `null` from jsonb
 *  must read the same as absent. */
export interface PriorWorktreeBridgeState {
  acceptFreeTicks?: number | null;
  acceptFreeSince?: number | null;
}

/**
 * Build the COMPLETE next persisted state. The only sanctioned way to produce a
 * value for the `worktree_bridge` metadata key.
 *
 * The accept-free streak is a deliberate THREE-way decision, not a boolean:
 *
 * | this tick                      | streak      | why |
 * |--------------------------------|-------------|-----|
 * | consumed 0                     | **carried** | no acceptance information — a quiet tick is not evidence of health OR of fault |
 * | consumed >0, accepted 0        | +1          | draining the log while the watermark stands still |
 * | consumed >0, accepted >0       | reset to 0  | the bridge is demonstrably advancing |
 *
 * The carry case is the subtle one and the reason this is not a one-liner: a
 * quiet tick that RESET the streak would let any lull erase an in-progress
 * freeze signal, and a quiet tick that INCREMENTED it would fire on an idle
 * bridge that is perfectly healthy. Only carrying is correct.
 */
export function nextWorktreeBridgeState(
  prior: PriorWorktreeBridgeState | null | undefined,
  tick: WorktreeBridgeTickFacts,
): WorktreeBridgeState {
  const priorTicks = prior?.acceptFreeTicks ?? 0;
  const priorSince = prior?.acceptFreeSince ?? null;

  let acceptFreeTicks: number;
  let acceptFreeSince: number | null;
  if (tick.consumed === 0) {
    // Carried verbatim — this tick says nothing about acceptance.
    acceptFreeTicks = priorTicks;
    acceptFreeSince = priorSince;
  } else if (tick.accepted === 0) {
    acceptFreeTicks = priorTicks + 1;
    acceptFreeSince = priorSince ?? tick.nowMs;
  } else {
    acceptFreeTicks = 0;
    acceptFreeSince = null;
  }

  return {
    lastEventId: tick.lastEventId,
    epochSeq: tick.epochSeq,
    stagingSha: tick.stagingSha,
    at: tick.nowMs,
    consumed: tick.consumed,
    accepted: tick.accepted,
    rejectedTerminal: tick.rejectedTerminal,
    acceptFreeTicks,
    acceptFreeSince,
  };
}

/**
 * Decide the P-505 fed-event cursor and the COMPLETE metadata value as one
 * atomic pure decision. Production persists `bridgeState` only after this
 * returns. Consequently an invalid stop index throws before any state carrying
 * `maxRowId` can be constructed, while a retryable stop threads the held cursor
 * into `lastEventId` instead of accidentally persisting the collected maximum.
 */
export function decideWorktreeBridgePersistence(input: {
  prior: PriorWorktreeBridgeState | null | undefined;
  maxRowId: number;
  pendingRows: readonly WorktreeBridgeCursorRow[];
  outcome: WorktreeBridgePersistenceOutcome;
  nowMs: number;
}): {
  cursorDecision: ReturnType<typeof decideWorktreeBridgeCursor>;
  bridgeState: WorktreeBridgeState;
} {
  const cursorDecision = decideWorktreeBridgeCursor({
    maxRowId: input.maxRowId,
    pendingRows: input.pendingRows,
    unprocessedFromIndex: input.outcome.unprocessedFromIndex,
    nowMs: input.nowMs,
  });
  const bridgeState = nextWorktreeBridgeState(input.prior, {
    lastEventId: cursorDecision.cursor,
    epochSeq: input.outcome.watermark.epochSeq,
    stagingSha: input.outcome.watermark.stagingSha,
    consumed: input.outcome.results.length,
    accepted: input.outcome.acceptedCount,
    rejectedTerminal: input.outcome.terminalRejections,
    nowMs: input.nowMs,
  });
  return { cursorDecision, bridgeState };
}

/** Warn only once a streak is established — a single accept-free tick is
 *  ordinary and warning on it would train readers to ignore the line. */
export const ACCEPT_FREE_WARN_AFTER = 3;

/** True on the crossing tick and every 10th after, so a freeze that persists for
 *  hours keeps a live signal without flooding the log. */
export function shouldWarnAcceptFree(acceptFreeTicks: number): boolean {
  return acceptFreeTicks >= ACCEPT_FREE_WARN_AFTER && (acceptFreeTicks - ACCEPT_FREE_WARN_AFTER) % 10 === 0;
}
