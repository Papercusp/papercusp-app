/**
 * su-cold-loop — the cold-auto wake DECISION (su-cold-auto-mode-2026-07-03
 * Phase 2; P-005 HYBRID cadence + P-006 carry-note precondition). PURE: the wake
 * executor calls this at its live-psu-host inject branch to decide whether a loop
 * wake goes COLD (a `reset`/`recycle` control verb — psu-pty-host.mjs P-004)
 * instead of the default WARM `turn`, and which cold verb. No DB / no spawn / no
 * flag store lives here — the caller resolves the flag + the carry-note and hands
 * them in, exactly like the bee fresh-context fork (wake-executor-fresh-context).
 *
 * WHY the su loop can go cold in-place while the bee can't: a bee is ALWAYS
 * process-exited between tasks (bee-fresh-context-delta D-021 ⇒ fresh-context ≡
 * cold spawn), so it has no warm process to reset. A su AUTO loop KEEPS its warm
 * session across wakes (loop:arm re-wakes the SAME session), so RESET-CONTEXT
 * (drop transcript, keep the process + MCP warm) is a real, cheaper-than-respawn
 * cold path — and RECYCLE is the periodic hard reset that sheds process cruft.
 *
 * SAFETY (D-006 / D-001 / D-005): cold fires ONLY when the loop was explicitly
 * armed `carry:'cold'` (opt-in), cold-auto is enabled at all (master gate), AND a
 * carry-note EXISTS to reconstruct from — otherwise WARM. Never drop a session's
 * context with no anchor to rebuild it from.
 */

/**
 * The cold-auto marker the loop fire stamps on a cold loop's wake-delivery
 * payload (mirrors the bee fresh-context marker: presence signals the mode).
 * Absent / carry!=='cold' ⇒ a warm loop (or not a loop) ⇒ never cold.
 */
export interface ColdLoopMarker {
  /** 'cold' selects the cold lifecycle; 'warm' / absent = today's warm inject. */
  carry?: string;
  /** Total fires so far on this loop (1-based) — drives the recycle-after-N
   *  cadence. Absent / 0 ⇒ treated as a plain RESET-CONTEXT (no recycle). */
  wakeCount?: number;
  /** The loop's harness — the carry-note scope key (loopScope(harness, ownerId)).
   *  Stamped by the loop fire so the wake executor can resolve getLoopCarryNote
   *  without a separate routine lookup. Absent ⇒ the caller cannot scope the
   *  carry-note ⇒ stays warm (fail-safe). */
  harness?: string;
  /** WI-5510: the loop's stable `routines` row id — the loop-INSTANCE identity
   *  the delivery-side stale-fire guard (psu-pty-host.mjs's makeStaleFireGuard)
   *  keys on, so a loop that was `loop:end`ed and later re-armed (fire numbers
   *  restart at 1) is never mistaken for a stale delivery of a PRIOR loop's
   *  higher fire count. Stamped by loop-fire.ts alongside `wakeCount`. Absent ⇒
   *  the delivery-side guard is a no-op for this wake (unchanged behavior). */
  routineId?: string;
}

export interface ColdLoopCaps {
  /** Force a hard RECYCLE every Nth cold wake (sheds process cruft); the other
   *  wakes are the cheap in-place RESET-CONTEXT. Ported from the cup transcript-cap's
   *  maxTasks recycle cadence (D-002 HYBRID) — that sweep is now retired (P-059, D-090:
   *  `_retired/mug-kettle-deciders/`), but the cadence idea was COPIED here, never
   *  imported, so this is unaffected. ≤0 ⇒ never recycle (reset-only). */
  recycleEveryNWakes: number;
}

/** Conservative default: reset each wake, a hard recycle every 8th — inherited from the
 *  (now retired) cup transcript-cap DEFAULT (maxTasks: 8). Editable via the loop's config. */
export const DEFAULT_COLD_LOOP_CAPS: ColdLoopCaps = { recycleEveryNWakes: 8 };

/** Read the cold-loop marker off a wake-delivery payload. Returns null when the
 *  payload carries neither field (an ordinary warm wake). Pure. */
export function readColdLoopMarker(payload: unknown): ColdLoopMarker | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { carry?: unknown; wakeCount?: unknown; harness?: unknown; routineId?: unknown };
  const carry = typeof p.carry === 'string' ? p.carry : undefined;
  const wakeCount =
    typeof p.wakeCount === 'number' && Number.isFinite(p.wakeCount) ? p.wakeCount : undefined;
  // The carry-note scope key (loopScope(harness, ownerId)) — the wake executor needs
  // it to resolve getLoopCarryNote without a separate routine lookup. A blank/missing
  // harness ⇒ undefined ⇒ decideColdWake's caller cannot scope the note ⇒ stays warm.
  const harness = typeof p.harness === 'string' && p.harness.length > 0 ? p.harness : undefined;
  // WI-5510: the loop-instance id (see ColdLoopMarker.routineId doc).
  const routineId = typeof p.routineId === 'string' && p.routineId.length > 0 ? p.routineId : undefined;
  // Harness is also ordinary metadata on many event payloads (for example
  // work-item:* events). It is only a loop marker when paired with one of the
  // loop-specific marker fields; treating a bare event `harness` as a marker
  // makes the wake executor apply loop lifecycle gates to ordinary wakes.
  if (carry === undefined && wakeCount === undefined && routineId === undefined)
    return null;
  return { carry, wakeCount, harness, routineId };
}

export type ColdWakeDecision =
  | { cold: false; reason: string }
  | { cold: true; mode: 'reset' | 'recycle'; carryNote: string };

/**
 * The HYBRID cadence (D-002 / P-005): a hard RECYCLE every Nth cold wake to shed
 * process cruft (wedged MCP / slow leak), the cheap in-place RESET-CONTEXT the
 * rest. `wakeCount` is the 1-based fire number; the Nth, 2Nth… recycle. An
 * unknown/0 wakeCount, or a non-positive cap, ⇒ 'reset' (never a surprise hard
 * kill). Pure — exported for tests.
 */
export function coldWakeMode(
  wakeCount: number,
  caps: ColdLoopCaps = DEFAULT_COLD_LOOP_CAPS,
): 'reset' | 'recycle' {
  const n = caps.recycleEveryNWakes;
  if (!Number.isFinite(wakeCount) || wakeCount <= 0 || n <= 0) return 'reset';
  return wakeCount % n === 0 ? 'recycle' : 'reset';
}

/**
 * Decide the cold-auto disposition of a loop wake. COLD requires ALL of:
 *   (1) an ELIGIBILITY route — either:
 *       (a) the loop was armed `carry:'cold'` (marker.carry === 'cold') — the
 *           opt-in (D-001 / P-003); or
 *       (b) P-021 verdict-gated cold-by-default: the caller resolved
 *           `classDefaultCold:true` (this wake's session belongs to a class whose
 *           cold-boot drills prove the carry sufficient, the kill-switch flag is
 *           on, and no active interactive exchange) AND the marker is a
 *           harness-scoped LOOP marker with NO explicit carry (a future
 *           `carry:'warm'` stamp opts a loop out of the default). A non-loop
 *           wake (no marker) is never cold on either route;
 *   (2) NO ACTIVE INTERACTIVE EXCHANGE — no human keystroke landed on this session's
 *       bridged TTY inside the active-exchange window (EI-21572316039386007). This
 *       applies to BOTH routes. Route (b) already carried it inside its own verdict;
 *       route (a) — the explicit opt-in — carried NOTHING, so a cold-armed loop reset
 *       a live session mid-conversation while its owner was typing, destroying an
 *       answer the owner was waiting to read. loop:arm's own description states the
 *       rule ("NEVER use 'cold' for an interactive/human-present session (D-005)")
 *       and, until this guard, no code enforced it on the path most likely to hit it:
 *       an agent that explicitly asked for cold. A human at the keyboard now outranks
 *       the opt-in exactly as it already outranked the drill verdict;
 *   (3) cold-auto is enabled at all (`coldEnabled` — the P-007 master gate the
 *       caller resolves; defence-in-depth over the per-loop opt-in);
 *   (4) a carry-note EXISTS to reconstruct from (P-006) — cold-start loses
 *       whatever the note fails to capture, so with NO anchor we MUST stay warm.
 * Otherwise WARM, with a reason (the caller injects the normal turn). When cold,
 * the cadence picks RECYCLE every Nth wake, else RESET-CONTEXT. Pure.
 */
export function decideColdWake(input: {
  payload: unknown;
  coldEnabled: boolean;
  carryNote: string | null;
  caps?: ColdLoopCaps;
  /** P-021: caller-resolved verdict that this wake's session class is drill-proven
   *  cold-by-default (flag + sufficientClasses + no active interactive exchange —
   *  see su-cold-by-default.ts). Absent/false ⇒ only the explicit opt-in colds. */
  classDefaultCold?: boolean;
  /** EI-21572316039386007: caller-resolved "a human typed into this session recently"
   *  (activeInteractiveExchangeForWake, su-cold-by-default.ts — the SAME window route
   *  (b) uses, read from the same helper so the two can never drift apart). True ⇒ WARM
   *  on EVERY route, opt-in included. Absent/false ⇒ unchanged behavior, which is what
   *  a headless session (no bridged TTY, no keystroke timestamp) always resolves to. */
  activeInteractiveExchange?: boolean;
}): ColdWakeDecision {
  const marker = readColdLoopMarker(input.payload);
  const optIn = marker?.carry === 'cold';
  const byVerdict =
    !optIn &&
    input.classDefaultCold === true &&
    marker != null &&
    marker.carry === undefined && // an explicit non-cold carry stamp opts out
    typeof marker.harness === 'string';
  if (!optIn && !byVerdict) {
    return { cold: false, reason: 'warm loop (or not a cold loop wake)' };
  }
  // A PRESENT HUMAN OUTRANKS THE OPT-IN (D-005). Checked before the master gate so the
  // reason names the human rather than a downstream precondition, and placed on the
  // shared path so route (a) cannot bypass it the way it bypasses classDefaultCold.
  if (input.activeInteractiveExchange === true) {
    return {
      cold: false,
      reason: 'active interactive exchange (recent human input) — stays warm (D-005)',
    };
  }
  if (!input.coldEnabled) {
    return { cold: false, reason: 'cold-auto disabled (master gate off)' };
  }
  const note = (input.carryNote ?? '').trim();
  if (!note) {
    return { cold: false, reason: 'no carry-note anchor — cannot safely cold-start (P-006)' };
  }
  const mode = coldWakeMode(marker!.wakeCount ?? 0, input.caps ?? DEFAULT_COLD_LOOP_CAPS);
  return { cold: true, mode, carryNote: note };
}

/** Compact absolute stamp (mm-ddThh:mm:ssZ) — mirrors loop-fire.ts's isoStamp (EI-13592).
 *  A cold successor computes the TRUE age of its carry-note against its own wall-clock,
 *  independent of how long the composed wake sat in the host busy-gate before flush. Pure. */
function coldNoteStamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(5, 19)}Z`;
}

/**
 * How far a turn-completion must fall AFTER the carry-note write before the cold wake
 * calls it un-checkpointed work (EI-19294445744419497). Sized to clear the mechanical
 * "checkpoint, then end the turn" tail (seconds) without needing the gap to be dramatic
 * — the live near-miss that motivated this had a 37-minute gap, and the cases that
 * actually burn an agent are minutes-to-hours, never seconds.
 */
export const COLD_NOTE_POST_TURN_FLOOR_MS = 5 * 60_000;

/** Human-readable elapsed span (mirrors loop-fire.ts's humanAge). Pure. */
function coldNoteAge(ms: number): string {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 36 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

const TRANSIENT_EXEC_TOOL_RE = /\b(?:exec_command|write_stdin|unified[\s_-]+exec)\b/i;
const TRANSIENT_EXEC_WORKLOAD_RE =
  /\b(?:type[\s_-]?check|lint(?:ing)?|build|test[\s_-]+(?:run|suite|command)|vitest|jest|pytest|playwright|tsc|shell|command)\b/i;
const NUMERIC_EXEC_HANDLE_RE =
  /\b(?:session|process)(?:\s*[/]\s*(?:session|process))?(?:[\s_-]+(?:id|handle))?\s*(?:is|:|=|#)?\s*`?\d+`?(?=\W|$)/i;

/**
 * A numeric exec/write_stdin handle is process-local, unlike a native agent-session id.
 * Cold carry deliberately preserves the note verbatim, but must frame this handle before
 * the note can prompt the successor to call write_stdin on an id from the dead process.
 */
/**
 * Detect a numeric native exec handle in carried text. The same warning is
 * used by the cold-loop note renderer and the shared carry-brief renderer so
 * warm carry-respawns cannot hand a successor a stale write_stdin id silently.
 */
export function transientExecHandleWarning(note: string): string | null {
  if (!NUMERIC_EXEC_HANDLE_RE.test(note)) return null;
  if (!TRANSIENT_EXEC_TOOL_RE.test(note) && !TRANSIENT_EXEC_WORKLOAD_RE.test(note)) return null;
  return (
    '⚠ CARRIED TRANSIENT EXEC HANDLE: this note names a numeric session/process handle for ' +
    '`exec_command`, `write_stdin`, unified exec, or a command-like workload. It is process-local and cannot be assumed ' +
    'to survive a cold respawn. DO NOT call `write_stdin` with the carried id; use durable ' +
    'spill/log/work-item evidence or rerun the command with a fresh exec.'
  );
}

/**
 * Render the text a COLD wake injects (P-002 producer half): the agent's carry-note
 * framed as its reconstructed working state, plus the STANDING re-checkpoint mandate.
 *
 * On a cold wake the injected `data` is the agent's ENTIRE opening context — the prior
 * transcript is gone. So the carry-note alone is not enough: the fresh agent must also
 * be told (a) that the note IS its continuity (continue from its "Next action"), and
 * (b) to refresh the note via `loop:checkpoint` before ending, or the NEXT cold wake
 * restarts from this same stale note. This closes the loop that keeps a cold loop's
 * anchor fresh across wakes. Pure — the wake executor calls it at the inject boundary.
 *
 * `extras` (compaction-continuity-hardening-2026-07-07 P-003): the session's wider
 * carry brief beyond the loop note — held work-items + checkpoints, standing facts
 * (walls), armed awaits, fleet pointer — rendered by carry-brief.ts's
 * renderCarryBriefColdExtras and appended after the note. Optional and additive:
 * a failed brief read injects the note alone, exactly as before.
 *
 * `wakeCount` (EI-15799): the FIRE-time 1-based fire number this cold decision was
 * computed for, stamped into the header when known. Fire → delivery can lag by an
 * arbitrary amount (the target session may be mid-turn and only reads the queued
 * wake once it settles, or a delivery can be delayed/re-queued past a newer fire —
 * live-witnessed EI-15799: a stale queued cold-wake was flushed mid-turn, telling
 * the agent its transcript was "just reset" when it demonstrably was not). This
 * does not by itself DROP a superseded delivery (that requires the delivery
 * pipeline itself to track "last fire number actually delivered" and is out of
 * scope for this pure render function — same limitation renderLoopCheckpointBlock's
 * EI-13592 fix documents) — but it gives the receiving agent (or a future
 * delivery-side dedup check) the marker needed to DETECT staleness: "this reset
 * claim is fire #N; if I have already seen a later fire, this delivery is stale —
 * reconcile against my actual live transcript before trusting the reset framing."
 * Absent/non-finite ⇒ omitted (byte-identical to before this fix).
 *
 * `updatedAtMs` (EI-18224278118395857): the carry-note's ABSOLUTE last-write instant
 * (carry_notes.updated_ts), stamped into the header when known. The cold-wake text is
 * COMPOSED (the note read) at executeWake/fire time and then STAGED behind the psu-pty-host
 * agent-busy-gate — which can hold it for minutes before it is flushed into the pty. If the
 * agent wrote a FRESHER loop:checkpoint in that fire→flush gap, the flushed note is stale by
 * the time the cold successor reads it (live-witnessed: a cold reset delivered a note ~35min
 * older than the last checkpoint write, about a task the agent had already moved on from).
 * A cold reset drops the transcript, so — unlike the fire-number caveat above, which relies
 * on the successor seeing later tool calls it no longer has — the successor has NO in-context
 * signal to notice this. Stamping the absolute write-time (mirroring renderLoopCheckpointBlock's
 * EI-13592 fix for warm wakes) gives it the one thing it CAN check: the note's age against its
 * own wall-clock. Absent/non-finite ⇒ omitted (byte-identical to before this fix).
 *
 * `lastTurnAtMs` (EI-19294445744419497): the owner's most recent turn-COMPLETION instant
 * (the loop's `last_turn_at`). Where `updatedAtMs` above lets the successor judge the note's
 * age — a subjective call, since "older than you would expect" needs a baseline it does not
 * have — this one answers the objective question the age heuristic only gestures at: did I
 * do work that this note does not describe? The note is rewritten ONLY by loop:checkpoint,
 * so a turn completing well after that write is proof of un-checkpointed work, and the note's
 * "Next action" may already be DONE rather than merely stale.
 *
 * Live near-miss (2026-08-01, fire #51): a session wrote its note at 21:04Z, kept working to
 * 21:42Z, then hit a usage limit and died without re-checkpointing. Ten fires landed in a
 * session that could not take turns. The cold successor was told to "continue from its Next
 * action" — an action the dead session had already completed and committed, and which the note
 * explicitly said needed no re-checking. Only a manual reconciliation caught it. `updatedAtMs`
 * was present and did NOT prevent this: a 2h age looked plausible enough to explain away.
 *
 * This is checkable precisely because the successor is not the one checking: its transcript is
 * gone, but the completion marker survives server-side and this render runs at compose time.
 * Absent/non-finite, or within COLD_NOTE_POST_TURN_FLOOR_MS of the note write ⇒ omitted
 * (byte-identical to before this fix).
 *
 * `agentToolCallsSinceNote` (EI-19984789589075138): evidence, not just existence — the strong
 * form of the check above. `lastTurnAtMs` proves a turn COMPLETED after the note write, but a
 * turn is well-formed (and moves `lastRealTurnAt`) even when it is a usage-wall / withheld-fire
 * bounce that made zero tool calls: the model emits refusal text, the turn ends, nothing happened.
 * That shape fires the banner on precisely the wakes that follow an outage, sending the successor
 * on a reconciliation hunt for work that never occurred — measured live (su-04c552b7, cold wake
 * #6, 2026-08-09): two consecutive fires each bounced off a session-limit wall with ZERO tool
 * calls, and the banner still reported "you completed a turn ... ~4h AFTER this note was written."
 * When the caller can positively COUNT agent-authored tool calls (excluding the automatic hook/
 * status set) in (updatedAtMs, lastTurnAtMs] and that count is exactly 0, this downgrades the
 * banner to a bounced-fire notice instead of the un-checkpointed-work alarm — the successor is
 * told its recent fires produced no work rather than sent hunting for work that isn't there.
 * `undefined`/`null` (evidence unavailable — the count query wasn't run or failed) or any
 * positive count preserves the EXISTING banner unchanged: this is strictly additive, and silence
 * about the evidence never suppresses a real warning.
 */
export function renderColdWakeInjection(
  carryNote: string,
  extras?: string,
  wakeCount?: number,
  updatedAtMs?: number | null,
  lastTurnAtMs?: number | null,
  agentToolCallsSinceNote?: number | null,
): string {
  const note = (carryNote ?? '').trim();
  const extraBlock = (extras ?? '').trim();
  const fireTag = typeof wakeCount === 'number' && Number.isFinite(wakeCount) && wakeCount > 0 ? ` (fire #${wakeCount})` : '';
  const hasStamp = typeof updatedAtMs === 'number' && Number.isFinite(updatedAtMs) && updatedAtMs > 0;
  const ageMs = hasStamp ? Math.max(0, Date.now() - updatedAtMs!) : null;
  const writeAgeLine = hasStamp
    ? `This carry-note was last written [${coldNoteStamp(updatedAtMs!)}] — ~${coldNoteAge(ageMs!)} ago as of NOW. A ` +
      'cold wake can be flushed LATE from the host busy-gate, so if that write-time is much older than you would expect ' +
      'for your most recent work, this note is likely a STALE/superseded snapshot: reconcile against live state (your ' +
      'held work-items via work_items:get, your latest loop:checkpoint) before trusting the note below as your current task.'
    : null;
  // EI-19294445744419497: the OBJECTIVE staleness signal, as opposed to the subjective
  // age heuristic above ("older than you would expect" — a judgement the successor has
  // to make with no baseline, and which was live-dismissed once because 2h merely
  // *looked* plausible). A turn that COMPLETED after the note was written is proof that
  // work happened which the note cannot describe, because the note is only rewritten by
  // loop:checkpoint. That is decidable from data the successor still has: its transcript
  // is gone, but the turn-completion marker survives server-side (last_turn_at), which
  // is why the `wakeCount` doc's "relies on tool calls it no longer has" reasoning does
  // NOT apply here — this check runs at compose time, not in the successor's head.
  const hasTurn = typeof lastTurnAtMs === 'number' && Number.isFinite(lastTurnAtMs) && lastTurnAtMs > 0;
  // The turn that WRITES the checkpoint necessarily ends after it, so a bare `>` would
  // fire on every cold wake and train the reader to skip it. The floor separates that
  // mechanical same-turn tail from genuine post-note work. Note the semantics deliberately
  // do NOT require a SUBSEQUENT turn: an agent that checkpointed and then kept working for
  // another 20 minutes in the SAME turn has also left the note behind, and that is a true
  // positive worth flagging, not a false one.
  const postNoteMs = hasTurn && hasStamp ? lastTurnAtMs! - updatedAtMs! : 0;
  // EI-19984789589075138: evidence, not just existence. `hasEvidence` is true only when the
  // caller actually ran the tool-call count (never on undefined/null — evidence unavailable
  // must NOT be read as zero, or a query failure would silently suppress a real warning).
  const hasEvidence = typeof agentToolCallsSinceNote === 'number' && Number.isFinite(agentToolCallsSinceNote);
  const confirmedNoWork = hasEvidence && agentToolCallsSinceNote! <= 0;
  // EI-23796602281828820 — CITE THE EVIDENCE, and never state an unverified case as a fact.
  //
  // The banner used to open "you completed a turn at [<lastTurnAt>]", which names the latest turn
  // BOUNDARY — not the work. Those differ: `lastTurnAt` is routinely an errored/bounced turn while
  // the tool calls that actually licensed the warning sit EARLIER in the window. A reader who
  // checks the cited turn, finds an API error, and concludes the detector is broken is reading the
  // banner exactly as written. That misreading was filed as a defect (measured: the window's real
  // work was plans:get / dev:pg_query / improvements:capture / work_items:comment at 15:14-15:20,
  // while the cited turn at 15:33 was a 502). So state the COUNT, which is the actual evidence.
  //
  // The `null` case is a genuinely different epistemic state and must not borrow the confident
  // wording. Evidence-unavailable still WARNS — deliberately, since reading a failed query as zero
  // would silently suppress a real warning — but it is labelled UNVERIFIED rather than asserted.
  const evidencedWork = hasEvidence && agentToolCallsSinceNote! > 0;
  const evidenceClause = evidencedWork
    ? `${agentToolCallsSinceNote} agent tool call(s) ran AFTER this note was written.`
    : 'a turn completed after this note was written, but the tool-call evidence query did NOT return, ' +
      'so whether any work actually happened is UNVERIFIED — treat this as a prompt to check, not as proof.';
  const staleWorkLine =
    postNoteMs >= COLD_NOTE_POST_TURN_FLOOR_MS
      ? confirmedNoWork
        ? `ℹ bounced fire(s) since the note: a turn completed at [${coldNoteStamp(lastTurnAtMs!)}] — ` +
          `~${coldNoteAge(postNoteMs)} after this note was written — but it made ZERO agent tool calls. ` +
          'That shape is a usage-wall / withheld-delivery bounce (the model emitted refusal text and the ' +
          'turn ended), not un-checkpointed work — the note above is CURRENT. No recovery hunt needed.'
        : `⚠⚠ UN-CHECKPOINTED WORK EXISTS: ${evidenceClause} The most recent turn completed at ` +
          `[${coldNoteStamp(lastTurnAtMs!)}] — ~${coldNoteAge(postNoteMs)} AFTER this note was written. ` +
          'The note is refreshed ONLY by ' +
          'loop:checkpoint, so it does NOT describe that work, and its "Next action" may ALREADY BE DONE ' +
          'or have been superseded by it. Before executing that action, VERIFY IT IS STILL NEEDED against ' +
          'live state — read the code/work-item it names and check whether the thing already exists. ' +
          'Re-implementing finished work is the specific failure this warns about. ⚠ That turn STAMP is only ' +
          'the latest turn BOUNDARY, and may itself be an errored/bounced turn while the real work sits EARLIER ' +
          'in the window — so do not dismiss this warning because the last turn looks like a failure. ' +
          'Recover what you did with ' +
          "sessions:timeline { owner:'self', since:'<the note write-time above>' }."
      : null;
  const transientExecLine = transientExecHandleWarning(note);
  return [
    `❄️ COLD LOOP WAKE${fireTag} — a context reset was REQUESTED for this session: the host was asked to drop your`,
    'prior transcript and bring you back on the carry-note below. If it took, that note IS your continuity — treat it',
    'as your working state and continue from its "Next action". Confirm it took, via the invariant immediately below.',
    // WI-6849: this preamble used to ASSERT the reset as accomplished ("your context was just
    // reset ... your prior transcript is GONE"). The system cannot know that. wake-executor's
    // cold path books `channel: psu-socket-reset` on `injectPsuHost` returning ok — a
    // SOCKET-WRITE ack, not proof the CLI child re-execed. Observed live 2026-08-02 on
    // su-7854d874 fire #6: a genuine usage_limit kill triggered the reset, the socket write
    // succeeded (ledger: status=delivered, attempts=1, last_error=NULL), the RESPAWN then hit
    // the SAME usage wall 4s later and never completed, and the session resumed WARM holding
    // its full transcript with this notice on top. The failure is self-reinforcing: whatever
    // wedges a session (usage wall, wedged host) is also what can stop its respawn, so the
    // false claim lands exactly when it is most costly — the agent is told to discard live
    // context in favour of a carry-note that is, by construction, older than the work it did.
    //
    // The check is UNCONDITIONAL and deliberately does not reuse the word "stale": the
    // fire-gated block below is a DIFFERENT claim (this delivery was superseded by a LATER
    // fire, EI-15799), it needs a fire number to be decidable, and its no-wakeCount rendering
    // is asserted to stay stale-free. "The reset did not take" needs no fire number at all,
    // and gating it on one is precisely why the EI-15799 clause did not cover fire #6: the
    // visible turns were from BEFORE that fire, not after it.
    '⚠ THE RESET IS REQUESTED, NOT CONFIRMED. TOTAL INVARIANT: IF YOU CAN SEE ANY OF YOUR OWN PRIOR TURNS OR TOOL ' +
      'CALLS AT ALL, THE RESET DID NOT TAKE — your context is intact, this preamble is WRONG about you, and the note ' +
      'below is a LEAD, not the truth. Reconcile against your live transcript and DO NOT discard it. (A reset can be ' +
      'requested and still not happen: the delivery is booked on a socket-write ack, and the very conditions that ' +
      'trigger a reset — a usage wall, a wedged host — can also stop the respawn completing.)',
    ...(writeAgeLine ? [writeAgeLine] : []),
    ...(staleWorkLine ? [staleWorkLine] : []),
    ...(transientExecLine ? [transientExecLine] : []),
    ...(fireTag
      ? [
          'If you can see ANY tool calls or turns from AFTER this fire number in what looks like your own transcript, ' +
            'this delivery is ALSO STALE (superseded by a later fire) — reconcile against your ' +
            'actual live transcript instead of discarding it, and treat the note below as a lead, not the truth.',
        ]
      : []),
    '',
    note,
    ...(extraBlock ? ['', extraBlock] : []),
    '',
    '────────',
    'Before you END this turn you MUST refresh this carry-note so the NEXT cold wake can continue —',
    'otherwise the next wake restarts from this same note:',
    '    loop:checkpoint { did, left, insight, next }   (compressed facts, not a transcript)',
    'The carry-note dies with your session — so also persist what must OUTLIVE it:',
    '  • holding a work-item? REFRESH work_items:checkpoint { id, checkpoint } — a successor/reclaimer INHERITS it',
    '    if you die (the carry-note does not); refresh it at least as often as this note.',
    '  • reached a durable conclusion (root cause, repro, decision, a bug worth filing)? You MUST facts:assert it.',
    '    ⚠ A work-item COMMENT does NOT count — it is never folded into orient, so the next wake and every peer stay',
    '    BLIND to it. A fact is the ONLY thing folded VERBATIM into every future orient — don\'t let a comment stand',
    '    in for it (that reflex is exactly how conclusions get lost across cold wakes).',
    'If the goal is DONE or you are blocked, call loop:end instead of leaving the loop spinning.',
  ].join('\n');
}
