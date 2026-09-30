/**
 * inbox-flush-gate — the FLUSH-FRESHNESS gate line prepended to the coord injection
 * near a compaction boundary (flush-to-proceed-stretch-discipline-2026-07-04 P-002).
 *
 * The load-bearing invariant of the stretch discipline is "never hold unexternalized
 * state longer than one unit of work" (plan D-001). The single surface guaranteed in
 * front of the agent at the moment that matters is the per-turn coord injection — the
 * same surface the context-usage line rides. So this renders a second line there: when
 * context is at/above {@link FLUSH_GATE_PCT} AND the caller holds a work-item claim whose
 * CHECKPOINT is stale relative to its activity (unflushed work), the line NAMES THE
 * ACTION — call `work_items:checkpoint` on each stale claim BEFORE starting new work or
 * ending the turn, because a compaction or a reclaim here would lose that state.
 *
 * Pure/presentation split (mirrors inbox-context-usage.ts): the DB read lives in the
 * inbox handler behind the pct gate (so the extra query fires ONLY on near-limit turns),
 * and the classification + rendering here are unit-testable without a DB.
 *
 * v1 is a NAMED-ACTION injection line — the same enforcement strength as the 85%
 * compaction hint (text the agent sees, not a hard tool block). A v2 escalation to
 * REFUSING mutating tool calls under a stale gate would be a PreToolUse hook reading the
 * same classifier (deliberately out of scope here; see the spec).
 */

/**
 * At/above this percent-of-soft-limit the flush gate engages. Deliberately BELOW
 * {@link COMPACTION_HINT_PCT} (85): you want unflushed state externalized BEFORE the
 * compaction-urgent zone, not at the same moment you're being told to compact.
 */
export const FLUSH_GATE_PCT = 75;

/**
 * How far a claim's work can outrun its last checkpoint before the state counts as
 * "unflushed" (ms). Long enough not to nag on genuinely fresh work; short enough to
 * catch real drift within a single ~30-min work-item TTL. Default 10 min.
 */
export const FLUSH_STALE_MS = 10 * 60_000;

/** One active claim held by the caller, with the timestamps the gate reasons over. */
export interface ClaimFreshness {
  /** Work-item id (WI-/F-/EI-…) the claim is on. */
  workItemId: string;
  /** ms since epoch of the claim's last activity (work_item_claims.last_activity_ts). */
  lastActivityMs: number;
  /** ms since epoch when the claim was acquired (work_item_claims.acquired_ts). */
  acquiredMs: number;
  /** ms since epoch the checkpoint was last written (work_item_checkpoints.updated_ts),
   *  or null when no checkpoint exists for this claim. */
  checkpointUpdatedMs: number | null;
}

/** A claim classified as holding unflushed state, with the reason it's stale. */
export interface StaleClaim {
  workItemId: string;
  /** 'never' = a held claim that was never checkpointed; 'drift' = worked since the last
   *  checkpoint by more than the threshold. */
  reason: 'never' | 'drift';
  /** How long the unflushed state has been accumulating (ms) — since acquire (never) or
   *  since the last checkpoint write (drift). */
  staleMs: number;
}

/**
 * Classify which of the caller's active claims hold unflushed state as of `nowMs`.
 * Pure: the caller supplies the claim rows + clock. A claim is stale when it was NEVER
 * checkpointed and has been held past the threshold, OR its work advanced past its last
 * checkpoint by more than the threshold. `staleMs` is the accumulation window.
 */
export function classifyStaleClaims(
  claims: readonly ClaimFreshness[],
  nowMs: number,
  staleMs: number = FLUSH_STALE_MS,
): StaleClaim[] {
  const out: StaleClaim[] = [];
  for (const c of claims) {
    if (c.checkpointUpdatedMs == null) {
      const heldMs = nowMs - c.acquiredMs;
      if (heldMs > staleMs) out.push({ workItemId: c.workItemId, reason: 'never', staleMs: heldMs });
      continue;
    }
    const driftMs = c.lastActivityMs - c.checkpointUpdatedMs;
    if (driftMs > staleMs) out.push({ workItemId: c.workItemId, reason: 'drift', staleMs: driftMs });
  }
  return out;
}

function fmtMins(ms: number): string {
  const mins = Math.round(ms / 60_000);
  return mins <= 0 ? '<1m' : `${mins}m`;
}

/**
 * Render the flush-gate line, or null when the gate does not engage. Engages when
 * `pct >= FLUSH_GATE_PCT` AND there is something unflushed: at least one stale claim,
 * or an armed COLD loop still owing a carry-note. The line names the exact subjects and
 * the exact action (`work_items:checkpoint` / `loop:checkpoint`), so the agent flushes
 * rather than narrating a stop. `pct` is the already-computed context percent (from
 * contextUsagePct); passing it in keeps this a single-source consumer, not a re-deriver.
 *
 * EI-20218251557859818 — why the loop half exists. This line and the BOUNDARY gate
 * (`detectFlushTripwires`, which refuses `session:request-compaction` with
 * `flush-required`) are the warning and the refusal for the same invariant, but they
 * classified different populations: this one saw work-item claims only. An agent whose
 * item checkpoints were all fresh therefore saw NOTHING here at 75/80/85% and first
 * discovered the loop-checkpoint prerequisite from a REFUSED boundary call — spending
 * the boundary attempt itself on learning the rule. The condition is deliberately NOT
 * re-implemented here: `opts.loopNeedingCarryNote` is supplied by the caller from
 * {@link armedLoopNeedsCarryNote}, the single predicate the boundary also uses, so the
 * warning cannot drift away from the refusal it is warning about.
 */
export function renderFlushGateLine(
  pct: number | null | undefined,
  staleClaims: readonly StaleClaim[],
  opts: {
    gatePct?: number;
    /**
     * The armed loop's HARNESS when that loop still owes a `loop:checkpoint`
     * carry-note (i.e. `armedLoopNeedsCarryNote` said true), else null/undefined.
     * A harness string is what the boundary tripwire uses as its subject, so the
     * warning names the same thing the refusal will.
     */
    loopNeedingCarryNote?: string | null;
  } = {},
): string | null {
  const gatePct = opts.gatePct ?? FLUSH_GATE_PCT;
  const loopHarness = (opts.loopNeedingCarryNote ?? '').trim() || null;
  if (pct == null || pct < gatePct) return null;
  if (staleClaims.length === 0 && !loopHarness) return null;
  const sentences: string[] = [];
  if (staleClaims.length > 0) {
    const parts = staleClaims
      .map((s) => `${s.workItemId} (${s.reason === 'never' ? `no checkpoint, held ${fmtMins(s.staleMs)}` : `checkpoint ${fmtMins(s.staleMs)} stale`})`)
      .join(', ');
    const n = staleClaims.length;
    sentences.push(
      `you hold ${n} work-item claim${n === 1 ? '' : 's'} with unflushed state — ${parts}. ` +
      `CALL work_items:checkpoint on each NOW, before new work or a compaction/reclaim loses it.`,
    );
  }
  if (loopHarness) {
    sentences.push(
      `your armed COLD loop @${loopHarness} has NO loop:checkpoint carry-note — a cold wake rebuilds ` +
      `solely from that note, and session:request-compaction REFUSES the boundary until it exists. ` +
      `CALL loop:checkpoint { did, left, insight, next } NOW.`,
    );
  }
  return (
    `flush-gate: at ${pct}% context ${sentences.join(' ')} ` +
    `(flush-to-proceed: never hold unexternalized state across a unit boundary).`
  );
}
