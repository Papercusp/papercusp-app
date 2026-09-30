/**
 * enforcement-gate — the flush-integrity ENFORCEMENT tier over the P-012..P-015
 * tracking surfaces (deterministic-context-carry-2026-07-14 P-016, Phase 5 close).
 *
 * P-003 (staleCheckpointWarnings, in session:request-compaction) DETECTS unflushed
 * state at a compaction boundary but only WARNS — a deliberate choice, because a
 * hard-refuse on the very tool an agent calls BECAUSE it is at its context limit
 * would strand it there on any gate bug (a worse failure than the one it catches).
 *
 * P-016 adds teeth WITHOUT reintroducing that strand: the boundary REFUSES once,
 * naming exactly what to flush; if the agent still won't flush and retries, the
 * system writes a MECHANICAL fallback checkpoint ITSELF and lets the operation
 * proceed. The ladder is therefore bounded — the worst case for any gate bug is
 * ONE bounced call, after which the operation always proceeds with system-written
 * durable state. The wiring layer (enforcement-gate-io.ts) additionally runs the
 * whole gate fail-OPEN, so an evaluation error degrades to `clear`, never a block.
 *
 * This module is PURE (brief → tripwires → verdict → refusal text); the IO layer
 * owns the brief read, the refusal-marker state, and the fallback writes.
 *
 * The three tripwires named in the P-016 item map here as:
 *   - "stale checkpoint after N hops"     → 'stale-checkpoint' / 'missing-checkpoint'
 *       There is no per-hop counter at these seams and D-001 forbids deriving one
 *       from history/telemetry. The detector instead compares the checkpoint write
 *       to the writer-backed item activity anchor (`last_progress_at`): a material
 *       post-checkpoint lag ({@link STALE_CHECKPOINT_WARN_MS}) proves later work;
 *       absolute wall age alone does not. 'missing-checkpoint' is the never-written case.
 *   - "unflushed state past soft threshold" → the BOUNDARY itself. A compaction seam
 *       fires at/near the soft threshold by construction (the agent calls it because
 *       it is near its limit); a handoff is the analogous hand-off boundary. So the
 *       "past soft threshold" condition is satisfied by BEING at the seam — the
 *       missing/stale tripwires above ARE the unflushed state at that threshold. No
 *       token gauge is read here (D-001).
 *   - "armed COLD loop without loop:checkpoint" → 'armed-loop-no-carry-note'.
 */
import type { CarryBrief } from './carry-brief';
import { parseCarryNote } from './carry-note';

/** A held item's last recorded progress materially newer than its checkpoint is
 *  STALE — that item-scoped work cannot be represented by the checkpoint across
 *  the boundary. 15 min ≈ several monitor wakes / a full task step. Absolute
 *  checkpoint age is deliberately ignored: untouched held items can retain an
 *  old but still complete checkpoint. (Formerly owned by session:request-compaction;
 *  this is now the single source, re-exported there for its existing warn path.) */
export const STALE_CHECKPOINT_WARN_MS = 15 * 60_000;

/**
 * A held work-item flagged by the flush-integrity check (P-003 shape, kept
 * byte-compatible so session:request-compaction's warn path re-exports it):
 *   - 'missing' — NO checkpoint at all (highest-risk genuine state loss);
 *   - 'stale'   — written, but long enough ago that the turns since will not carry.
 */
export interface CheckpointFlushWarning {
  id: string;
  title: string | null;
  reason: 'missing' | 'stale';
  /** Minutes that item progress leads the checkpoint write — only on reason:'stale'. */
  ageMinutes?: number;
}

/**
 * Best-effort flush-integrity scan over a carry brief's held work-items (P-003).
 * Pure; an absent brief yields an empty list. This is the detector both the WARN
 * path (request-compaction) and the ENFORCEMENT gate (below) share. `nowMs` remains
 * in the signature for callers that provide a boundary clock; relative freshness
 * intentionally does not use it.
 */
export function staleCheckpointWarnings(
  brief: CarryBrief | null,
  nowMs: number = Date.now(),
): CheckpointFlushWarning[] {
  void nowMs;
  if (!brief) return [];
  const out: CheckpointFlushWarning[] = [];
  for (const h of brief.heldItems) {
    if (h.checkpoint === null) {
      out.push({ id: h.id, title: h.title, reason: 'missing' });
    } else if (
      typeof h.checkpointUpdatedAtMs === 'number' &&
      Number.isFinite(h.checkpointUpdatedAtMs) &&
      typeof h.lastProgressAtMs === 'number' &&
      Number.isFinite(h.lastProgressAtMs) &&
      h.lastProgressAtMs - h.checkpointUpdatedAtMs > STALE_CHECKPOINT_WARN_MS
    ) {
      const progressLagMs = h.lastProgressAtMs - h.checkpointUpdatedAtMs;
      out.push({
        id: h.id,
        title: h.title,
        reason: 'stale',
        ageMinutes: Math.round(progressLagMs / 60_000),
      });
    }
  }
  return out;
}

/** The boundaries the gate protects. Both are stale-snapshot cut-overs: compaction
 *  drops unparked context; a handoff hands the receiver whatever the offerer flushed. */
export type GateBoundary = 'compaction' | 'handoff';

/** The enforcement tripwire kinds (the three P-016 detectors, split by cause). */
export type FlushTripwireKind =
  | 'missing-checkpoint'
  | 'stale-checkpoint'
  | 'armed-loop-no-carry-note'
  | 'cold-successor-no-progress';

export interface FlushTripwire {
  kind: FlushTripwireKind;
  /** The subject: a held work-item id, or the loop's harness for the armed-loop case. */
  subject: string;
  /** Human-facing one-liner for the refusal text. */
  detail: string;
  /** Minutes of item progress after the checkpoint write — only on 'stale-checkpoint'. */
  ageMinutes?: number;
}

/**
 * The minimal loop shape the carry-note question is asked of. Structurally
 * compatible with `CarryBrief['loop']` AND with a raw LoopStatus + carry-note
 * pair, so a caller that has only those two narrow reads need not build a whole
 * brief to ask it.
 */
export interface ArmedLoopFlushState {
  active: boolean;
  /** Persisted loop lifecycle; an ABSENT mode fails open (see below). */
  carry?: 'warm' | 'cold' | null;
  carryNote?: string | null;
}

/**
 * Does this armed loop still owe a `loop:checkpoint` carry-note?
 *
 * THE single definition of that condition. A cold wake reconstructs its entire
 * context from the carry-note, so a cold loop with no note is a guaranteed-blind
 * successor; an active WARM loop intentionally carries its transcript and is not
 * flagged (the warm-loop contract). An absent `carry` mode — an injected or
 * legacy brief — fails OPEN rather than inventing a requirement.
 *
 * Exported because TWO surfaces must agree on it, and until EI-20218251557859818
 * they did not. The BOUNDARY gate ({@link detectFlushTripwires}, which refuses
 * `session:request-compaction` with `flush-required`) tested this condition; the
 * PRE-boundary flush-gate line rendered into the coord injection at
 * FLUSH_GATE_PCT classified work-item claims ONLY. So an agent whose item
 * checkpoints were all fresh was told NOTHING at 75/80/85% and first learned the
 * loop prerequisite existed from a refused boundary call — the two surfaces
 * disagreeing about what "flushed" means. Deriving both from this one predicate
 * is what keeps the warning and the refusal denominated in the same condition:
 * a change here moves both, and neither can drift onto its own copy.
 */
export function armedLoopNeedsCarryNote(
  loop: ArmedLoopFlushState | null | undefined,
): boolean {
  return Boolean(
    loop && loop.active && loop.carry === 'cold' && !(loop.carryNote ?? '').trim(),
  );
}

/**
 * Does a carry-note's FIRST next action describe this same self-compaction
 * boundary?
 *
 * `countAgentToolCallsInWindow` deliberately stops before the current tool call
 * is recorded. That means a successor whose next action is the carry-respawn
 * itself has a truthful zero count at the compaction boundary. Treating that
 * zero as evidence that it must run the carry-respawn first is a self-refusing
 * loop; only the compaction boundary gets this narrow exception. A note that
 * starts with an ordinary action (even if it mentions compaction later) still
 * trips the guard.
 */
export function carryNoteStartsWithSelfCompaction(next: string): boolean {
  const action = next.trim().replace(/^[-*]\s+/, '');
  if (!action || /^(?:do not|don't|never|avoid)\b/i.test(action)) return false;
  return /^(?:(?:call|invoke|request|queue|perform|run|trigger)\s+)?(?:session:request-compaction|carry[- ]respawn|self[- ]compact|compact\s+now)\b/i.test(
    action,
  );
}

/**
 * Does a carry-note's FIRST next action explicitly defer work until a future
 * scheduled loop boundary?
 *
 * Every carry note's `next` field is intended for a successor wake, so the
 * words "next action" alone cannot excuse the no-progress tripwire. This
 * predicate is deliberately prefix-only and schedule-specific: it recognizes
 * an explicit future scheduled loop fire/wake/tick (or an instruction to wait
 * until one), while a later mention of a schedule in an otherwise immediately
 * runnable action still trips the guard. An ordinary "next wake" is not enough;
 * inbox and scheduled wakes are different lanes, and the incident this closes
 * was a git-sync wake incorrectly treated as the scheduled loop fire.
 */
export function carryNoteStartsWithDeferredFutureAction(next: string): boolean {
  const action = next.trim().replace(/^[-*]\s+/, '');
  if (!action || /^(?:do not|don't|never|avoid)\b/i.test(action)) return false;
  return /^(?:(?:on|at|after|when|once|upon)\s+)?(?:the\s+)?(?:next|upcoming|following)\s+scheduled\s+(?:loop\s+)?(?:fire|fires|firing|wake|wakes|tick|ticks)\b/i.test(
    action,
  ) || /^(?:wait|defer|hold)\s+until\s+(?:the\s+)?(?:next|upcoming|following)\s+scheduled\s+(?:loop\s+)?(?:fire|fires|firing|wake|wakes|tick|ticks)\b/i.test(
    action,
  );
}

/**
 * A carry writer that landed immediately before this boundary is positive
 * evidence that the owner did productive work even when the post-note tool
 * ledger is zero. The ledger deliberately excludes `loop:checkpoint` and
 * `work_items:checkpoint`, so those writes cannot be inferred from its count.
 *
 * Keep this window deliberately short: an old note/checkpoint must not let an
 * ordinary cold successor skip the no-progress tripwire. Timestamps are
 * accepted only from a readable, non-empty writer value, must be finite, and
 * may not be from the future. An absent/unknown/read-failed writer therefore
 * never proves a same-turn flush.
 */
export const SAME_TURN_CHECKPOINT_FRESHNESS_MS = 2 * 60_000;

export function hasFreshCheckpointWriterEvidence(
  brief: CarryBrief | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!brief || !Number.isFinite(nowMs)) return false;

  const writerTimestamps: Array<number | null | undefined> = [];
  const loop = brief.loop;
  if (loop && loop.carryNoteReadFailed !== true && (loop.carryNote ?? '').trim()) {
    writerTimestamps.push(loop.carryNoteUpdatedAtMs);
  }
  for (const item of brief.heldItems) {
    if (item.checkpointReadFailed === true || !(item.checkpoint ?? '').trim()) continue;
    writerTimestamps.push(item.checkpointUpdatedAtMs);
  }

  return writerTimestamps.some(
    (writtenAtMs) =>
      typeof writtenAtMs === 'number' &&
      Number.isFinite(writtenAtMs) &&
      writtenAtMs <= nowMs &&
      nowMs - writtenAtMs <= SAME_TURN_CHECKPOINT_FRESHNESS_MS,
  );
}

/**
 * The flush tripwires present at a boundary: missing/stale held-item checkpoints
 * (via {@link staleCheckpointWarnings}) plus an armed COLD loop carrying no
 * loop:checkpoint note ({@link armedLoopNeedsCarryNote}). Warm loops carry their
 * transcript and are not flagged. A current compaction boundary also accepts a
 * fresh writer-backed carry note/item checkpoint as proof that the zero-count
 * bookkeeping tail followed productive work. Pure; empty when the brief is
 * clean or unavailable.
 */
export function detectFlushTripwires(
  brief: CarryBrief | null,
  nowMs: number = Date.now(),
  /**
   * EI-21874665446367942: caller-resolved evidence (countAgentToolCallsInWindow)
 * of how many real agent tool calls this owner made since its armed COLD
 * loop's carry-note was last written. Only relevant to the
 * 'cold-successor-no-progress' tripwire below. undefined/null means
 * "evidence unavailable" and MUST NOT be read as zero — same fail-open
 * discipline as every other best-effort signal on this boundary; a query
 * failure must never manufacture a spurious refusal. `boundary` is optional
 * for callers that only need the pure historical detector; the IO boundary
 * passes it so a carry-respawn next action does not self-refuse.
  */
  agentToolCallsSinceNote?: number | null,
  boundary?: GateBoundary,
): FlushTripwire[] {
  if (!brief) return [];
  const out: FlushTripwire[] = [];
  for (const w of staleCheckpointWarnings(brief, nowMs)) {
    if (w.reason === 'missing') {
      out.push({
        kind: 'missing-checkpoint',
        subject: w.id,
        detail: `${w.id} has NO checkpoint written — its in-flight state will not carry.`,
      });
    } else {
      out.push({
        kind: 'stale-checkpoint',
        subject: w.id,
        ageMinutes: w.ageMinutes,
        detail: `${w.id} has a STALE checkpoint (${w.ageMinutes}m of progress after the checkpoint) — everything since it was written will not carry.`,
      });
    }
  }
  // Armed COLD loop with no carry-note — the condition itself now lives in
  // armedLoopNeedsCarryNote above, because the PRE-boundary flush-gate line has
  // to ask the identical question (EI-20218251557859818). The `brief.loop &&`
  // is kept for TS narrowing of `brief.loop.harness` below, not as a second copy
  // of the predicate.
  if (brief.loop && armedLoopNeedsCarryNote(brief.loop)) {
    out.push({
      kind: 'armed-loop-no-carry-note',
      subject: brief.loop.harness,
      detail: `armed loop @${brief.loop.harness} has NO loop:checkpoint carry-note — a cold wake would start blind.`,
    });
  } else if (
    // EI-21874665446367942 (cold-carry recurrence guard): the note EXISTS (the
    // branch above is mutually exclusive) and already names a concrete next
    // action, but this life is CONFIRMED to have made zero real tool calls
    // since that note was written. Left unguarded, a cold successor can
    // re-derive context / re-verify instead of running the named action, hit
    // its soft compaction limit having tried nothing, and compact again —
    // repeating indefinitely with no progress (the su-6627a incident: three
    // consecutive checkpoints, each recording that no acceptance leg or
    // mutation ran before another compaction boundary). Strictly `=== 0`:
    // even ONE real tool call already satisfies "at least one scoped tool
    // call before compaction" and must not re-trip this. A live deliberate
    // await is the other safe state: the named next action is intentionally
    // conditional on that event, so zero post-note calls means PARKED, not
    // spinning. `CarryBrief.awaits` already excludes the infrastructure
    // inbox-wake keepalive; any remaining entry is an agent-owned event await.
    brief.loop &&
    brief.loop.active &&
    brief.loop.carry === 'cold' &&
    brief.awaits.length === 0 &&
    agentToolCallsSinceNote === 0
  ) {
    const next = parseCarryNote(brief.loop.carryNote ?? '').next?.trim();
    const currentCompactionIsNextAction =
      boundary === 'compaction' && next && carryNoteStartsWithSelfCompaction(next);
    const currentCompactionIsDeferredFutureAction =
      boundary === 'compaction' && next && carryNoteStartsWithDeferredFutureAction(next);
    const currentCompactionHasFreshCheckpoint =
      boundary === 'compaction' && hasFreshCheckpointWriterEvidence(brief, nowMs);
    if (
      next &&
      !currentCompactionIsNextAction &&
      !currentCompactionIsDeferredFutureAction &&
      !currentCompactionHasFreshCheckpoint
    ) {
      out.push({
        kind: 'cold-successor-no-progress',
        subject: brief.loop.harness,
        detail:
          `your carry-note already names a next action ("${next.length > 140 ? `${next.slice(0, 139)}…` : next}") ` +
          'but you have made ZERO tool calls since it was written — run that action before compacting again ' +
          '(re-deriving/re-verifying context first is exactly the loop this tripwire exists to break).',
      });
    }
  }
  return out;
}

/** The gate's decision. `clear` = proceed; `refuse` = bounce once, naming the
 *  flush; `mechanical-fallback` = the agent already refused and still hasn't
 *  flushed, so the system writes the checkpoints itself and the caller proceeds. */
export type FlushGateVerdict = 'clear' | 'refuse' | 'mechanical-fallback';

/**
 * The pure ladder (P-016): no tripwires ⇒ clear; tripwires on a first encounter
 * ⇒ refuse; tripwires when the boundary was ALREADY refused for this owner and
 * they still weren't cleared ⇒ mechanical-fallback (write + proceed). Never a
 * permanent block — the second state is always terminal-and-proceeding.
 */
export function decideFlushGate(input: {
  tripwires: ReadonlyArray<FlushTripwire>;
  alreadyRefused: boolean;
}): FlushGateVerdict {
  if (input.tripwires.length === 0) return 'clear';
  return input.alreadyRefused ? 'mechanical-fallback' : 'refuse';
}

/** The actionable refusal text — names the exact flush command per tripwire, and
 *  states the escape (flush + retry, OR retry as-is and the system flushes for you).
 *  Written for the agent that reads the tool result, not a log. */
export function renderFlushRefusal(boundary: GateBoundary, tripwires: ReadonlyArray<FlushTripwire>): string {
  const noCheckpointIds = tripwires.filter((t) => t.kind === 'missing-checkpoint').map((t) => t.subject);
  const staleIds = tripwires
    .filter((t) => t.kind === 'stale-checkpoint')
    .map((t) => `${t.subject} (${t.ageMinutes}m of progress after checkpoint)`);
  const armedLoop = tripwires.find((t) => t.kind === 'armed-loop-no-carry-note');
  const coldNoProgress = tripwires.find((t) => t.kind === 'cold-successor-no-progress');
  const steps: string[] = [];
  if (noCheckpointIds.length > 0) {
    steps.push(
      `write a checkpoint for ${noCheckpointIds.join(', ')} — work_items:checkpoint { id, checkpoint } (no in-flight state survives without it)`,
    );
  }
  if (staleIds.length > 0) {
    // P-007/R-06: a STALE checkpoint has two honest remedies, and naming only the
    // expensive one is what produced the measured churn (48h to 2026-09-05: 261 of 347
    // compaction refusals provoked a flush, costing 339 checkpoint writes made solely
    // to clear this gate). If state genuinely moved, rewrite it; if it did not, attest
    // and keep your turn. The attestation is offered ONLY here, never for a MISSING
    // checkpoint below — there is nothing to attest to when nothing was ever written,
    // and offering it there would read as a way to skip the flush entirely.
    steps.push(
      `refresh the stale checkpoint(s) for ${staleIds.join(', ')} — work_items:checkpoint { id, checkpoint } ` +
        'if the state moved, or, if it genuinely has NOT, attest it instead of rewriting it: ' +
        'work_items:checkpoint { id, unchanged: true, contentHash } (the hash comes from work_items:get { id }; ' +
        'the attestation is bounded and refuses once the item itself has moved). ' +
        'If that attestation returns `attestation_exhausted`, use the atomic additive refresh instead: ' +
        'work_items:checkpoint { id, checkpoint: "brief current-state update", append: true }; ' +
        '`append:true` preserves the existing checkpoint and resets its attestation budget.',
    );
  }
  if (armedLoop) {
    steps.push(
      `write your loop carry-note — loop:checkpoint { did, left, insight, next } (your armed loop @${armedLoop.subject} has none, so a cold wake starts blind)`,
    );
  }
  if (coldNoProgress) {
    steps.push(coldNoProgress.detail);
  }
  const what = boundary === 'compaction' ? 'Compaction' : 'This handoff';
  return (
    `${what} is HELD: unflushed state would be lost across the boundary. Flush first, then retry:\n- ` +
    steps.join('\n- ') +
    `\nIf you retry WITHOUT flushing, the system will write a mechanical fallback checkpoint for you and proceed — but a checkpoint you write yourself carries far more than the mechanical one.`
  );
}
