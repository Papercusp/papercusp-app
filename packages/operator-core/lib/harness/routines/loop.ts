/**
 * Loops — the engine-side row-construction + wakeup-prompt for a "loop" routine
 * (loop-routines-interval-recurrence-2026-06-20, B-LOOP-5 / P-006 + P-008).
 *
 * A LOOP is the THIRD recurrence kind: a routine that re-fires N seconds AFTER
 * its previous turn COMPLETES — the engine-managed, tracked replacement for
 * Claude Code's built-in `/loop` for su/interactive agents. Unlike `/loop`
 * (in-context, dies with the session, invisible to the operator), a loop is a
 * durable `harness_shared.routines` row: it survives restarts, is observable
 * (fire-history + the work-queue), and inherits the engine's guardrails
 * (failure-streak fire-gate + a cost-cap). It is NOT the autonomous queen/bee/
 * scout loop — that is its own system and is untouched (plan D-007).
 *
 * This mirrors materialize-plan-schedule.ts: a thin function over B-LOOP-1's
 * `upsertRoutine` (su-d5a84) so the loop:arm / loop:end verbs stay ergonomic
 * wrappers and the row shape lives in ONE place. The contract (confirmed with
 * the B-LOOP-1/2/3 owners) — a loop routine row is:
 *   - trigger_kind = 'cron'        → rides listDueCronRoutines + the 30s tick
 *   - trigger_config = {}          → no cron/rrule, so claim.ts treats it as a
 *                                    PURE loop (park at next_fire_at='infinity'
 *                                    in-flight; the completion-rebase re-arms it)
 *   - reschedule_interval_sec = N  → the loop interval (B-LOOP-1 column)
 *   - target_owner_id = ownerId    → the pinned WARM session's coord ownerId,
 *                                    the `coord:send {wake}` recipient (B-LOOP-1
 *                                    column). ownerId is the stable coord
 *                                    identity (survives `claude --resume`), so
 *                                    the loop keeps waking the SAME logical agent
 *   - payload_template.kickoff     → the wakeup prompt B-LOOP-3's fire delivers
 *                                    as the wake turn text
 *   - payload_template.costCapCents→ optional; B-LOOP-3's cost-cap auto-pauses
 *                                    the loop when its cumulative cost crosses it
 *
 * Pure-additive: this file is NEW and only IMPORTS upsertRoutine/setRoutineActive
 * (B-LOOP-1) — it never edits claim.ts / reconcile-plan-runs.ts / routines-
 * workflow.ts (the B-LOOP-2/3 lane), so it composes without collision.
 */
import type { Sql, TransactionSql } from 'postgres';
import { getOrgPg, normalizeNextFireAt, upsertRoutine } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { computeNextFireAt } from './cron';
import { stampLoopArmedAt } from './loop-dead-man';
import { extractGoalWorkItemIds } from './loop-goal-staleness';
import { recordLoopTransition } from './loop-transition-log';
import { SESSION_END_MARKER } from '../../agent-tools/activity/lifecycle-markers';
import { boundedPgReadTxn } from '../../pg-read-query';
// Import from the dependency-free automatic-tool-names.ts, NOT from
// '../../agent-tools/sessions/timeline' (which re-exports the same constant) — timeline.ts
// imports `@papercusp/agent-mcp`, whose index.ts unconditionally imports './bootstrap' and
// side-effect-registers the whole read-tool catalog (several of which read `generated.*`
// schema exports from '@papercusp/db-org' AT MODULE LOAD, EI-362). Importing from timeline.ts
// here pulled that entire chain into loop.ts's module graph and broke any test importing
// loop.ts whose db-org mock used a bare factory instead of spreading `importOriginal`
// (measured: loop.test.ts, EI-19986796515232861). loop.ts is a core routines module reached
// from many lightweight import graphs — keep this import light.
import {
  AUTOMATIC_TOOL_NAMES,
  CARRY_NOTE_BOOKKEEPING_TOOL_NAMES,
  agentToolInvocationPredicate,
} from '../../agent-tools/sessions/automatic-tool-names';
import type { PersistedMonitorConfig } from './monitor-policy';
import type { LoopBlockedOnRecord } from './loop-blocker-liveness';
import {
  readMonitorStanddownRecord,
  readPersistedMonitorConfig,
  type MonitorStanddownRecord,
} from './monitor-standdown';
// EI-22138154596110669: the loop:standdown-all bulk pause is a distinct marker from an
// ordinary per-loop pause (routines:set / loop:end) — isLoopStanddownPause gates on the raw
// jsonb marker before readRoutinePause/loopStanddownBanner are used to render it below.
import { isLoopStanddownPause, loopStanddownBanner, readRoutinePause } from './release-pause-ttl';

/**
 * The `target_role` a loop routine carries. The DBOS fire (B-LOOP-3) recognises
 * a loop by `reschedule_interval_sec IS NOT NULL` + `target_owner_id` (it then
 * delivers a `coord:send {wake}` to the owner instead of the normal loopback
 * fire); `target_role` is NOT NULL in the schema, so a loop gets this stable,
 * self-documenting value (cf. PLAN_RUN_ACTION = 'system:plan-run'). It also keys
 * the per-(install_slug, target_role) failure-streak fire-gate (checkFireGate).
 */
export const LOOP_WAKE_ACTION = 'system:loop-wake';

/**
 * Policy floor for a loop interval, in seconds — the same 60s floor Claude's
 * `/loop` enforces. The DB CHECK (migration 323) only forbids a non-positive
 * interval; this minimum is a policy concern enforced one layer up (the verb).
 * Sub-minute is intentionally NOT supported: the completion-rebase observes the
 * turn settle on the 30s reconcile tick, so the true period is interval +
 * up-to-30s — fine at ≥60s, meaningless below it.
 */
export const LOOP_INTERVAL_FLOOR_SEC = 60;

/** Stable per-session loop routine name — one loop per pinned owner. */
export function loopRoutineName(ownerId: string): string {
  // Routine ids are normalized to [a-z0-9_] by upsertRoutine; the name is the
  // upsert key, so keep it deterministic from the ownerId.
  return `loop-${ownerId}`;
}

export function loopRoutineId(harnessSlug: string, ownerId: string): string {
  return `rt_${harnessSlug}_${loopRoutineName(ownerId)}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

/**
 * The default per-wake instruction the loop fire delivers (payload_template.kickoff)
 * when the arming agent does not supply a custom `wakePrompt`. It is injected as
 * the looping agent's turn text, so it is addressed to that agent in the second
 * person and stays lean (the agent already carries its warm context across the
 * wake — this is a nudge, not a re-briefing). Placeholders are interpolated by
 * buildLoopWakePrompt at arm time.
 *
 * fleet-member-native-guidance-2026-07-10 P-008: the create-+-SELF-ASSIGN-+-FINISH
 * contract (D-006 / B-LOOP-4 / EI-7674 / EI-7478) is now NATIVE to every su session
 * via the base persona's "Working as a fleet MEMBER — the member operating loop"
 * section (P-001, same plan) — so re-spelling the full mechanics here every FULL-form
 * wake (isLoopWakeFullForm, 1-in-10 by default) was pure re-teaching. This template
 * now POINTS at that persona section instead of restating it; only the loop-specific
 * mechanics NOT covered by the persona (the wake cadence, the harness/owner ids to
 * fill in, the end-turn + loop:end/loop:status instructions) stay spelled out here.
 */
export const DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE = [
  '🔁 Loop wake (every ~{intervalSec}s after each turn settles). You are continuing your OWN warm session toward: {goal}',
  '',
  'Each wake:',
  '1. Decide the next concrete unit(s) of work. If the goal is DONE or there\'s nothing left to do, call `loop:end` and stop — do not spin on empty wakes. An idle SELF-PULLER (your scheduler:get_next / work_items:claim_next came back empty) parks on a standing wake watch instead of polling: register `watch:create { pattern: "work-item:claimable", wake:true, once:false, payload_filter: <your claim spec\'s view> }`, then `loop:end` — do not pass `targetKind` with `wake:true`; the watch re-invokes you on every matching claimable transition and remains armed after a re-miss, so your pull stays the authoritative claim. If AUTO (or another autonomy-implying mode) remains active without that deliberate wake watch, use `loop:end { acknowledgeOpenDirectives:true, acknowledgeWakeLessAutonomy:true }` so the wake-less safety guard does not refuse the stop.',
  '2. Work it per your persona\'s "Working as a fleet MEMBER — the member operating loop" contract — create + ' +
    'self-assign the unit atomically, pick `kind` by what it IS, finish with `work_items:complete { completion }` ' +
    'evidence (never a bare "done" assertion). harness:{harness}, assign_to:{ownerId}.',
  "3. When this iteration's work is done (or you are blocked), END YOUR TURN. The loop re-wakes this same session ~{intervalSec}s after the turn settles.",
  '',
  'To stop: `loop:end`. If AUTO (or another autonomy-implying mode) remains active without a deliberate event await, pass `acknowledgeOpenDirectives:true, acknowledgeWakeLessAutonomy:true`; otherwise the wake-less safety guard refuses the stop. If you are blocked on something external (a build, another agent, an owner decision), call `loop:end` and say why rather than burning wakes spinning. `loop:status` shows the loop state.',
].join('\n');

/**
 * MONITOR-mode wake template (compaction-continuity-hardening-2026-07-07 P-001c). A
 * leader/supervisor loop that WATCHES (a fleet, a pipeline, a soak) does not create +
 * self-assign work_items each wake — delivering the work-item contract to it every wake
 * is pure boilerplate burn (measured: a monitor loop re-received the full ~3KB work
 * contract on 263 consecutive wakes). This template is the lean monitoring contract:
 * check, steer/escalate only on deltas, checkpoint, end turn.
 */
export const MONITOR_LOOP_WAKE_PROMPT_TEMPLATE = [
  '🔁 Monitor wake (every ~{intervalSec}s after each turn settles). You are continuing your OWN warm session, MONITORING: {goal}',
  '',
  'Each wake:',
  '1. Check the watched state (coord:orient { mode:"monitor" } for a fleet; the relevant status tool otherwise). If the thing you are watching is FINISHED or no longer needs a monitor, call `loop:end` and stop — do not spin on empty wakes. If AUTO (or another autonomy-implying mode) remains active without a deliberate event await, pass `acknowledgeOpenDirectives:true, acknowledgeWakeLessAutonomy:true`.',
  '2. Act ONLY on deltas: something stalled/failed/blocked → unblock it, re-steer, or escalate. Nothing changed → write a one-line loop:checkpoint and END YOUR TURN — a quiet wake is a SUCCESS, not a license to invent work. Do NOT create work_items for routine checks; only file one when a delta needs real follow-up work.',
  '3. END YOUR TURN when this check settles. The loop re-wakes this same session ~{intervalSec}s after the turn settles.',
  '',
  'To stop: `loop:end`. If AUTO (or another autonomy-implying mode) remains active without a deliberate event await, pass `acknowledgeOpenDirectives:true, acknowledgeWakeLessAutonomy:true`; otherwise the wake-less safety guard refuses the stop. `loop:status` shows the loop state.',
].join('\n');

/**
 * COLD-loop bootstrap addendum (su-cold-auto-mode-2026-07-03 P-002 producer). Appended
 * to the wake prompt only for a `carry:'cold'` loop. Until the FIRST carry-note exists,
 * decideColdWake's P-006 no-anchor guard keeps the loop WARM, so these early wakes inject
 * THIS kickoff — which is exactly where the agent is told to write its first
 * loop:checkpoint. Once a carry-note exists, subsequent wakes go cold and the carry-note
 * (wrapped by renderColdWakeInjection) carries the same mandate. So this bootstraps the
 * anchor and the cold injection sustains it.
 */
export const COLD_LOOP_WAKE_ADDENDUM = [
  '',
  "❄️ This is a COLD loop (carry:'cold'): once a carry-note anchor exists, each wake RESETS your context",
  '(a periodic RECYCLE) to that note instead of carrying this transcript — so your transcript will NOT persist.',
  'Therefore, before you END this turn you MUST write/refresh your carry-note so the next (cold) wake can continue:',
  '    loop:checkpoint { did, left, insight, next }   (compressed facts — what you did, what is left, the key',
  '    non-obvious insight, and the single next action). This is REQUIRED on a cold loop: with no carry-note the',
  '    loop silently stays warm (and grows unbounded); a stale note makes the next wake repeat work.',
  'The carry-note is NOT the only thing to persist — it is LOST if your session dies, so also, before ending:',
  '  • if you hold a work-item, REFRESH work_items:checkpoint { id, checkpoint } at least as often as the',
  '    carry-note — the ITEM checkpoint is INHERITED by a successor/reclaimer when your session dies, while the',
  '    loop-note is not; it is your real death-resilience anchor, not a nice-to-have.',
  '  • reached a DURABLE conclusion this wake (a confirmed root cause / repro, a decision, a system bug)? You MUST',
  '    facts:assert it. ⚠ A work-item COMMENT (or a checkpoint) does NOT satisfy this and is the exact trap to',
  '    avoid: a comment is NEVER folded into orient, so the next cold wake and every peer start BLIND to your',
  '    conclusion. The reflex "I already wrote it up in a comment" is precisely why conclusions get lost — a fact',
  '    is the ONLY write folded VERBATIM into every future orient/brief. Comment too if you want an audit trail,',
  '    but the facts:assert is the non-negotiable one; a conclusion left only in a comment/carry-note dies with the loop.',
].join('\n');

/**
 * GATED-continuation addendum (flush-to-proceed-stretch-discipline-2026-07-04 P-005).
 * Appended to the wake prompt only for a `continuation:'gated'` loop. The default
 * template tells the agent to do ONE iteration's work and end the turn; a gated loop
 * inverts that — the runtime EXPECTS multiple units per turn, gated per-unit by the
 * continuation gate (spec rule 2), so the agent recovers the per-wake orient/re-read
 * boundary tax by settling several units back-to-back instead of one-per-wake.
 */
export const GATED_LOOP_WAKE_ADDENDUM = [
  '',
  "🔀 This is a GATED loop (continuation:'gated'): unlike the default one-unit-per-wake cadence, the",
  'runtime EXPECTS you to run MULTIPLE units in a single turn — gated per unit by the CONTINUATION GATE.',
  'After you SETTLE each unit (live-verified or explicitly deferred-with-reason):',
  '  1. FLUSH first — every work-item claim you hold gets a fresh work_items:checkpoint (never carry',
  '     unexternalized state across a unit boundary; the P-002 flush gate enforces this).',
  '  2. READ THE GATE — loop:checkpoint returns a `continuation` verdict (context headroom < ceiling?',
  '     any unread inbox / pending owner input?). CONTINUE in this same turn ONLY when the gate is OPEN',
  '     AND your next unit is already scoped; otherwise END THE TURN.',
  '  3. On any pending owner input, an inbox interrupt, or context past the ceiling — settle now; the',
  '     next wake re-opens the gate on fresh context.',
  'Because a gated turn does more work, arm a LONGER interval than a one-unit loop — the boundary-tax',
  'win comes from N-units-per-turn, not from a faster wake cadence.',
].join('\n');

/**
 * Detect the single work-item a loop is DRIVING from its free-text goal (WI-2429
 * fix A auto-detect leg). Matches a WI-/EI-/F- id and returns it ONLY when the
 * goal names exactly ONE distinct such id — a goal that mentions several (or none)
 * is ambiguous, so we return null rather than guess which one the loop drives (the
 * arming agent can still name it explicitly via loop:arm { workItem }). Pure +
 * exported for unit tests. Case-insensitive match, normalized to the canonical
 * upper-case id. Note: the returned id is a CANDIDATE — the caller's claim step
 * is what confirms it exists and is claimable (claimWorkItem never steals a live
 * peer's item), so a false-positive like a stray "F-16" simply fails the claim
 * non-fatally.
 */
export function detectDrivenWorkItemId(goal: string): string | null {
  // ⚠ EXTRACTION IS SHARED with the goal-staleness check (loop-goal-staleness.ts),
  // not re-implemented here. The two ask different questions — "which ONE item does
  // this loop drive?" vs "are the items this goal names still open?" — but off the
  // same notion of what a work-item id looks like, and two regexes obliged to agree
  // are two regexes that eventually disagree.
  const distinct = extractGoalWorkItemIds(goal);
  if (distinct.length !== 1) return null;

  // A cold-loop goal is often a compact carry note, and carry notes routinely
  // mention the item that must remain OUT of scope (for example, "continue the
  // plan; ignore WI-1774"). Treating that lone negative mention as the driven
  // item is worse than ambiguity: the arm-time auto-claim then grabs exactly the
  // item the goal and its scheduler lane excluded. Keep the general extractor
  // unchanged — staleness still needs every id a goal names — and narrow only
  // this auto-claim detector to positive/driving mentions.
  const id = distinct[0]!;
  const idIndex = goal.toUpperCase().indexOf(id);
  if (idIndex < 0) return null;
  const sentenceStart = Math.max(
    goal.lastIndexOf('\n', idIndex - 1),
    goal.lastIndexOf('.', idIndex - 1),
    goal.lastIndexOf(';', idIndex - 1),
    goal.lastIndexOf('!', idIndex - 1),
    goal.lastIndexOf('?', idIndex - 1),
  );
  const sentenceEndCandidates = ['\n', '.', ';', '!', '?']
    .map((boundary) => goal.indexOf(boundary, idIndex + id.length))
    .filter((index) => index >= 0);
  const sentenceEnd = sentenceEndCandidates.length > 0 ? Math.min(...sentenceEndCandidates) : goal.length;
  const sentence = goal.slice(sentenceStart + 1, sentenceEnd);
  const idInSentence = sentence.toUpperCase().indexOf(id);
  const beforeId = sentence.slice(0, idInSentence);
  const afterId = sentence.slice(idInSentence + id.length);
  const excludedBefore =
    /\b(?:ignore|ignored|ignoring|exclude|excluded|excluding|skip|skipped|skipping|avoid|avoided|avoiding|omit|omitted|omitting|defer|deferred|park|parked)\b[\s\S]{0,80}$/i.test(
      beforeId,
    ) ||
    /\b(?:do not|don't|never)\s+(?:work on|claim|touch|take|resume)\b[\s\S]{0,80}$/i.test(beforeId);
  const excludedAfter =
    /^\s*(?:is|was|remains|stays)?\s*(?:explicitly\s+)?(?:excluded|out of scope|outside (?:the )?scope|not in scope)\b/i.test(
      afterId,
    );
  return excludedBefore || excludedAfter ? null : id;
}

/**
 * A CONCRETE driven-work-item mandate (WI-2429 fix A), appended to a cold loop's
 * wake prompt when the loop drives a known, auto-claimed work-item. The generic
 * cold addendum says "IF you hold a work-item, refresh its checkpoint" — a soft
 * conditional the cold-auto experiment measured agents ignoring (WI-2429). Since
 * the loop now auto-CLAIMS the item at arm time, that condition is already TRUE,
 * so we can name the id and make the mandate unmissable instead of hypothetical.
 */
function renderDrivenWorkItemLine(workItem: string): string {
  return [
    '',
    `📌 This loop is DRIVING work-item ${workItem} — auto-claimed to you at arm time, so you ALREADY HOLD it. That`,
    `turns the work_items:checkpoint mandate above from an "if" into a REQUIREMENT each wake: work_items:checkpoint`,
    `{ id:'${workItem}', checkpoint } is the ONE piece of in-flight state a successor/reclaimer INHERITS if this`,
    'session dies mid-work — refresh it before every turn ends, at least as often as the carry-note. Finish it with',
    `work_items:complete { id:'${workItem}', … } when the goal is done (then loop:end; if AUTO or another autonomy-implying mode remains active without a deliberate event await, pass acknowledgeOpenDirectives:true and acknowledgeWakeLessAutonomy:true).`,
  ].join('\n');
}

/** Interpolate the default wakeup prompt with this loop's specifics. For a cold loop
 *  (`carry:'cold'`) the COLD_LOOP_WAKE_ADDENDUM is appended so the pre-anchor warm wakes
 *  bootstrap the first carry-note, and — when the loop drives a known auto-claimed
 *  work-item (`workItem`) — a CONCRETE per-item checkpoint mandate (WI-2429 fix A); for a
 *  gated loop (`continuation:'gated'`) the GATED_LOOP_WAKE_ADDENDUM is appended so the
 *  agent runs multi-unit turns behind the continuation gate. A plain warm/settle loop is
 *  byte-identical to before. The addenda compose (a cold gated loop gets both). */
export function buildLoopWakePrompt(opts: {
  ownerId: string;
  intervalSec: number;
  harness: string;
  goal: string;
  carry?: 'warm' | 'cold';
  continuation?: 'settle' | 'gated';
  /** 'work' (default) = the create+self-assign work-item contract; 'monitor' = the lean
   *  check/steer/checkpoint contract with NO work-item boilerplate (P-001c). */
  mode?: 'work' | 'monitor';
  /** The work-item this loop drives (auto-claimed at arm time, WI-2429 fix A). When set on
   *  a cold loop, its per-item checkpoint mandate is named concretely in the wake prompt. */
  workItem?: string | null;
}): string {
  const base = opts.mode === 'monitor' ? MONITOR_LOOP_WAKE_PROMPT_TEMPLATE : DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE;
  // The goal is replayed as part of a machine-injected `user` turn. Keep the
  // provenance adjacent to the text itself so a quoted fragment cannot be
  // mistaken for an owner-authored directive after it leaves this preamble.
  const agentAuthoredGoal = `⟦agent-authored-goal⟧${opts.goal}⟦/agent-authored-goal⟧`;
  let prompt = base
    .replace(/\{intervalSec\}/g, String(opts.intervalSec))
    .replace(/\{harness\}/g, opts.harness)
    .replace(/\{ownerId\}/g, opts.ownerId)
    .replace(/\{goal\}/g, () => agentAuthoredGoal);
  if (opts.carry === 'cold') prompt += COLD_LOOP_WAKE_ADDENDUM;
  if (opts.carry === 'cold' && opts.workItem) prompt += renderDrivenWorkItemLine(opts.workItem);
  if (opts.continuation === 'gated') prompt += GATED_LOOP_WAKE_ADDENDUM;
  return prompt;
}

export interface MaterializeLoopInput {
  workspaceId?: string;
  /** install_slug for the routine — the arming agent's harness. */
  harnessSlug: string;
  /** The pinned WARM session's coord ownerId (target_owner_id + the upsert key). */
  ownerId: string;
  /** Loop interval in seconds (the verb enforces ≥ LOOP_INTERVAL_FLOOR_SEC). */
  intervalSec: number;
  /** The wakeup prompt the fire delivers (payload_template.kickoff). */
  kickoff: string;
  /**
   * The stable work-item anchor this loop drives. Only non-empty anchors are persisted;
   * an omitted value on a re-arm carries the existing row's anchor forward so a cadence
   * retune cannot silently detach the loop from its death-resilience work-item claim.
   */
  workItem?: string | null;
  /**
   * Whether `kickoff` came from an explicit loop:arm `wakePrompt`. Only the true
   * marker is persisted so rows created by older callers remain byte-identical.
   * Missing/false is deliberately legacy-safe: an unknown kickoff is rebuilt.
   */
  customWakePrompt?: boolean;
  /**
   * The loop's GOAL, stored structurally (payload_template.goal) rather than only
   * embedded in the rendered `kickoff`.
   *
   * EI-20072281215342526: the mission WAS durable in the kickoff prose, but reachable
   * only by rendering that prose on a loop FIRE. A carry-respawn is a different wake
   * path, so a successor got the held work-items and not the mission that generated
   * them — and `loop:status`, the one place an agent would look up "what am I meant to
   * be doing", could not answer either. Optional so an older caller (or a loop armed
   * with no goal) leaves payload_template byte-identical, same convention as
   * carry/continuation/mode above.
   */
  goal?: string | null;
  /** Optional cost-cap in cents — B-LOOP-3 auto-pauses the loop on breach. */
  costCapCents?: number | null;
  /** Optional dead-man bounds (loop-wake-rate-limit-robustness P2a) — auto-pause the loop after
   *  this many total fires / this many seconds since arm. Ride payload_template (no new columns). */
  maxFires?: number | null;
  maxDurationSec?: number | null;
  /** Loop lifecycle (su-cold-auto-mode-2026-07-03 P-003 / D-001). 'warm' (default, absent) =
   *  today's behaviour — each fire re-wakes the SAME warm session in place. 'cold' = the opt-in
   *  fresh-context lifecycle: a cold fire stamps a {carry,wakeCount,harness} marker on the wake
   *  so the wake-executor RESETs / periodically RECYCLEs instead of a warm turn. Rides
   *  payload_template (no new column). Downstream stays dormant until the P-007 gate (Phase 3). */
  carry?: 'warm' | 'cold';
  /** Continuation policy (flush-to-proceed-stretch-discipline-2026-07-04 P-005). 'settle'
   *  (default, absent) = today's behaviour — one unit per wake, end the turn. 'gated' = the
   *  runtime expects MULTIPLE units per turn, each gated by the continuation gate (P-005 spec
   *  rule 2). Rides payload_template (no new column); a settle loop leaves it byte-identical. */
  continuation?: 'settle' | 'gated';
  /** Loop mode (WI-5345 — was previously threaded ONLY into buildLoopWakePrompt's template
   *  choice and never persisted anywhere, so no tool could recover it after arming). 'work'
   *  (default, absent) = today's behaviour. 'monitor' = the lean check/steer/checkpoint
   *  contract (P-001c). Rides payload_template (no new column); a 'work' loop leaves
   *  payload_template byte-identical to today. */
  mode?: 'work' | 'monitor';
  /**
   * anti-babysitting P-003: admitted monitor policy persisted on the existing
   * payload_template. Work loops omit it and remain byte-identical.
   */
  monitor?: PersistedMonitorConfig;
  /**
   * EI-21526226279199560: the blocker this loop declared at arm time, persisted so the
   * FIRE can re-resolve it. Rides payload_template (no new column); an unblocked loop
   * omits it and stays byte-identical.
   */
  blockedOn?: LoopBlockedOnRecord | null;
  /** Seed active (armed). Default true. */
  active?: boolean;
  /**
   * Recovery-only compare-and-swap guard. When true, an active row that wins the
   * row lock is returned unchanged instead of being overwritten. This protects
   * a stale repair read from clobbering an explicit loop:arm that committed
   * between the repair's read and its materialization.
   */
  onlyIfInactive?: boolean;
  /**
   * Seconds from now to the FIRST fire. Default = intervalSec, so the first wake
   * lands one interval after arming (giving the arming turn time to end first).
   * After the first fire the completion-rebase (B-LOOP-2) owns re-arming off each
   * turn's settle.
   */
  firstFireInSec?: number;
  /** Test seams. */
  sql?: Sql;
  now?: Date;
}

/**
 * Upsert the loop routine for an owner (the row B-LOOP-2's rebase + B-LOOP-3's
 * fire consume). Idempotent on (workspace_id, target_owner_id, name): re-arming
 * the same session updates the one logical row even if the resolved harness
 * namespace changes between a concrete slug and the operator wildcard fallback.
 */
export async function materializeLoop(input: MaterializeLoopInput): Promise<{
  id: string;
  name: string;
  nextFireAt: Date | null;
  targetRole: string;
  intervalSec: number | null;
  changed: boolean;
}> {
  const sql = input.sql ?? getOrgPg().sql;
  const workspaceId = input.workspaceId ?? activeWorkspaceId();
  const now = input.now ?? new Date();
  const firstFireSec = input.firstFireInSec ?? input.intervalSec;
  const workItemText = typeof input.workItem === 'string' ? input.workItem.trim().toUpperCase() : '';
  // Warm loops keep their finite first fire. A cold loop's first wake is different:
  // the arm turn must settle and write its first carry-note before the wake may be
  // staged, otherwise a long loop:arm turn can overlap the nominal first fire.
  const scheduledFirstFireAt = new Date(now.getTime() + firstFireSec * 1000);

  const payloadTemplate: Record<string, unknown> = { kickoff: input.kickoff };
  if (workItemText) payloadTemplate.workItem = workItemText;
  // EI-20256869903801099: preserve the distinction between an explicit custom
  // kickoff and the default template across loop:arm re-arms. Stamp only true
  // so legacy callers and default loops keep their historical payload shape.
  if (input.customWakePrompt === true) payloadTemplate.customWakePrompt = true;
  if (input.costCapCents != null) payloadTemplate.costCapCents = input.costCapCents;
  if (input.maxFires != null) payloadTemplate.maxFires = input.maxFires;
  if (input.maxDurationSec != null) payloadTemplate.maxDurationSec = input.maxDurationSec;
  // Only stamp a cold marker (su-cold-auto P-003); a warm loop leaves payload_template
  // byte-identical to today, so an existing warm loop re-armed by an older client is unchanged.
  if (input.carry === 'cold') payloadTemplate.carry = 'cold';
  // Same convention for the continuation policy (P-005): only stamp 'gated'; a settle loop
  // leaves payload_template unchanged.
  if (input.continuation === 'gated') payloadTemplate.continuation = 'gated';
  // WI-5345: same convention for mode — only stamp 'monitor'; a default 'work' loop's
  // payload_template stays byte-identical to today.
  if (input.mode === 'monitor') payloadTemplate.mode = 'monitor';
  if (input.mode === 'monitor' && input.monitor) payloadTemplate.monitor = input.monitor;
  // EI-20072281215342526: persist the GOAL as its own field.
  //
  // It was previously recoverable only by reading it back out of the rendered
  // `kickoff` prose, which is why the mission became unfindable after a carry-respawn:
  // `loop:status` could not report it, and a respawn renders the kickoff on a
  // different wake path entirely, so the ONE durable copy of "what am I supposed to be
  // doing" reached the successor through no channel at all. Storing it structurally is
  // what lets every reader answer that question without parsing prose.
  const goalText = typeof input.goal === 'string' ? input.goal.trim() : '';
  if (goalText) payloadTemplate.goal = goalText;
  // EI-21526226279199560: persist the DECLARED BLOCKER structurally, for the same reason
  // the goal above is persisted — until now `blockedOn` reached the next wake only as
  // frozen prose prepended to `kickoff`, so the fire could re-DELIVER the premise but
  // never re-EVALUATE it. A stamped record is what lets `assessBlockerLiveness` answer
  // "is the agent you are waiting on still alive?" at fire time. Same convention as
  // every field above: only stamped when present, so a loop with no declared blocker
  // leaves payload_template byte-identical to today.
  if (input.blockedOn) payloadTemplate.blockedOn = input.blockedOn;

  const name = loopRoutineName(input.ownerId);
  const desiredId = loopRoutineId(input.harnessSlug, input.ownerId);
  const triggerConfigStr = JSON.stringify({});
  const existing = await sql<
    Array<{
      id: string;
      name: string;
      install_slug: string;
      active: boolean;
      last_fired_at: Date | string | null;
      payload_template: Record<string, unknown> | null;
      next_fire_at: Date | string | null;
      target_role: string;
      reschedule_interval_sec: number | null;
    }>
  >`
    SELECT id, name, install_slug, active, last_fired_at, payload_template,
           next_fire_at, target_role, reschedule_interval_sec
      FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId}
       AND name = ${name}
       AND target_owner_id = ${input.ownerId}
       AND reschedule_interval_sec IS NOT NULL
     ORDER BY (install_slug = ${input.harnessSlug}) DESC, active DESC, updated_at DESC
     FOR UPDATE
  `;
  if (input.onlyIfInactive && existing[0]?.active === true) {
    const active = existing[0];
    return {
      id: active.id,
      name: active.name,
      nextFireAt: normalizeNextFireAt(active.next_fire_at),
      targetRole: active.target_role,
      intervalSec: active.reschedule_interval_sec == null ? null : Number(active.reschedule_interval_sec),
      changed: false,
    };
  }
  // EI-22079408866636029: a retune that omits workItem must preserve the durable
  // death-resilience anchor already stored on the loop row. The handler normally
  // passes the recovered anchor explicitly; this writer-side fallback also protects
  // auto-arm/recovery callers and older call sites that only re-state cadence/prompt.
  // A direct null is treated as an explicit clear for this low-level helper; the
  // public loop:arm path never sends null for an omitted field.
  if (!workItemText && input.workItem === undefined && existing.length > 0) {
    const priorWorkItem = existing[0]?.payload_template?.workItem;
    if (typeof priorWorkItem === 'string' && priorWorkItem.trim()) {
      payloadTemplate.workItem = priorWorkItem.trim().toUpperCase();
    }
  }
  // EI-20194544581627100: a retune/reset may intentionally omit the goal while
  // changing cadence or kickoff. Keep the durable mission instead of replacing
  // payload_template with a row whose goal is silently null. An explicit non-empty
  // goal still wins above; only a goal-omitting call inherits the prior one.
  if (!goalText && input.goal == null && existing.length > 0) {
    const priorGoal = existing[0]?.payload_template?.goal;
    if (typeof priorGoal === 'string' && priorGoal.trim()) payloadTemplate.goal = priorGoal.trim();
  }
  const initialColdFirePending =
    input.carry === 'cold' && (existing.length === 0 || existing[0]?.last_fired_at == null);
  const nextFireAt: Date | 'infinity' = initialColdFirePending ? 'infinity' : scheduledFirstFireAt;
  const nextFireAtStr = nextFireAt === 'infinity' ? 'infinity' : nextFireAt.toISOString();
  const payloadTemplateStr = JSON.stringify(payloadTemplate);

  let row: { id: string; name: string; nextFireAt: Date | null; targetRole: string };
  if (existing.length > 0) {
    const canonical = existing[0]!;
    // `SELECT ... FOR UPDATE` above is not sufficient on its own: callers pass a
    // pooled postgres.js client, so each tagged query commits independently and
    // the row lock is released before this UPDATE starts. Repeat the inactive
    // predicate in the write as a single-statement CAS so an explicit loop:arm
    // that wins the gap cannot be overwritten by this stale repair.
    const rows = await sql<Array<{ id: string; name: string; next_fire_at: Date | null; target_role: string }>>`
      UPDATE harness_shared.routines
         SET id = ${desiredId},
             install_slug = ${input.harnessSlug},
             trigger_kind = 'cron',
             trigger_config = ${triggerConfigStr}::text::jsonb,
             target_role = ${LOOP_WAKE_ACTION},
             payload_template = ${payloadTemplateStr}::text::jsonb,
             concurrency = 'skip',
             catchup = 'skip-old',
             active = ${input.active ?? true},
             -- P-011 / owner-reported missed wake (2026-08-24): infinity is
             -- an in-flight sentinel only while the existing row is ACTIVE.
             -- loop:end leaves next_fire_at untouched, so a later loop:arm of
             -- that INACTIVE row used to preserve a stale parked sentinel from
             -- an older fire. The new arm then had no finite first fire and
             -- reported after-turn-settle forever (firesSinceArm stayed 0).
             -- Preserve the sentinel for a genuine mid-turn retune, but treat
             -- an inactive row as a fresh lifecycle and schedule this arm's
             -- requested first fire.
             next_fire_at = CASE WHEN active = TRUE
                                      AND next_fire_at = 'infinity'::timestamptz
                                 THEN next_fire_at
                                 ELSE ${nextFireAtStr}::timestamptz END,
             reschedule_interval_sec = ${input.intervalSec},
             target_owner_id = ${input.ownerId},
             updated_at = now()
       WHERE id = ${canonical.id}
         AND (${input.onlyIfInactive !== true} OR active = FALSE)
      RETURNING id, name, next_fire_at, target_role
    `;
    if (rows.length === 0 && input.onlyIfInactive) {
      // The CAS lost to a concurrent explicit arm. Read back the winner so the
      // caller reports its live configuration and, importantly, does not stamp
      // or deactivate any shadow row as if the repair had changed the loop.
      const currentRows = await sql<
        Array<{
          id: string;
          name: string;
          next_fire_at: Date | null;
          target_role: string;
          reschedule_interval_sec: number | null;
        }>
      >`
        SELECT id, name, next_fire_at, target_role, reschedule_interval_sec
          FROM harness_shared.routines
         WHERE id = ${canonical.id}
      `;
      const current = currentRows[0] ?? canonical;
      return {
        id: current.id,
        name: current.name,
        nextFireAt: normalizeNextFireAt(current.next_fire_at),
        targetRole: current.target_role,
        intervalSec: current.reschedule_interval_sec == null ? null : Number(current.reschedule_interval_sec),
        changed: false,
      };
    }
    await sql`
      UPDATE harness_shared.routines
         SET active = FALSE, updated_at = now(),
             metadata = COALESCE(metadata, '{}'::jsonb) ||
               jsonb_build_object('loop_shadow_deactivated_at', now()::text, 'loop_shadow_deactivated_by', ${desiredId}::text)
       WHERE workspace_id = ${workspaceId}
         AND name = ${name}
         AND target_owner_id = ${input.ownerId}
         AND reschedule_interval_sec IS NOT NULL
         AND id <> ${desiredId}
         AND active = TRUE
    `;
    const updated = rows[0]!;
    row = {
      id: updated.id,
      name: updated.name,
      nextFireAt: normalizeNextFireAt(updated.next_fire_at),
      targetRole: updated.target_role,
    };
  } else {
    const inserted = await upsertRoutine(
      sql,
      {
        workspaceId,
        installSlug: input.harnessSlug,
        name,
        triggerKind: 'cron', // next_fire_at-driven; rides listDueCronRoutines + the 30s tick
        triggerConfig: {}, // PURE loop — no cron/rrule ⇒ claim.ts parks at 'infinity' in-flight
        targetRole: LOOP_WAKE_ACTION,
        payloadTemplate,
        concurrency: 'skip', // belt-and-suspenders; the 'infinity' park is the real skip-if-in-flight guard
        active: input.active ?? true,
        nextFireAt, // explicit override — upsertRoutine only auto-derives next_fire_at from a cron string
        rescheduleIntervalSec: input.intervalSec,
        targetOwnerId: input.ownerId,
      },
      computeNextFireAt,
    );
    row = { id: inserted.id, name: inserted.name, nextFireAt: inserted.nextFireAt, targetRole: inserted.targetRole };
  }
  // EI-7613 — refresh the dead-man clock's arm instant on EVERY materialize (a fresh arm
  // AND a re-arm alike): the upsert above never touches `created_at` on its ON CONFLICT DO
  // UPDATE path, so without this a re-armed loop's maxDurationSec bound kept measuring from
  // the loop's ORIGINAL arm — a fresh bound could breach on the very first post-re-arm fire.
  // Best-effort; a stamp failure must never fail the arm (materializeLoop already succeeded).
  try {
    await stampLoopArmedAt(sql, row.id, now.getTime());
  } catch (e) {
    console.warn(
      `[loop] stampLoopArmedAt failed for routine ${row.id} (loop still armed): ${e instanceof Error ? e.message : e}`,
    );
  }
  return {
    id: row.id,
    name: row.name,
    nextFireAt: row.nextFireAt,
    targetRole: row.targetRole,
    intervalSec: input.intervalSec,
    changed: true,
  };
}

/**
 * End an owner's loop — deactivate its routine so it never fires again (the row
 * is kept for fire-history + a quick re-arm). Keyed on the per-owner routine NAME
 * (`loop-<ownerId>`) so a session can stop its loop without re-supplying the exact
 * harness it armed under. Returns true if a routine was deactivated. Never
 * flag-gated by callers: you must always be able to stop an armed loop.
 *
 * EI-3748: also clears any stale `metadata.last_error` stamp. The watchdog's
 * `routine-failure` collector (harness/improvements/watchdog.ts) only sees
 * ACTIVE routines, but a transient error (e.g. a one-off DBOS-executor-reaper
 * "stuck fire" auto-requeue — expected, self-healing behavior, not a wedge) that
 * was recorded on this routine, followed by the OWNER ending the loop rather
 * than firing again, left the stamp in place forever: the reaper's own
 * clear-on-next-successful-fire (dbos-executor-reaper.ts) never gets a chance to
 * run once the routine stops firing entirely. That stranded stamp is cosmetic
 * (the routine can't fire — inactive — so it can't actually be wedged) but the
 * filed watchdog issue is confusing/stale noise for whoever triages it later.
 * Unconditional (not source-scoped like the reaper's clear): ending the loop
 * makes ANY residual error moot, regardless of who recorded it.
 *
 * WI-39786 (end-after-disarm, measured live by su-50a96a51 2026-08-18): `loop:end` also
 * stamps the pause family (`loop_paused_reason`/`loop_paused_at`/`pause{}`) with its OWN
 * reason — INCLUDING when the loop is already inactive, where the deactivation UPDATE
 * no-ops. Before this, an owner ending a guard-disarmed loop left the guard's turn-stalled
 * residue as the row's live down-cause: `armed_at` never advanced (nothing to supersede),
 * readRevivableLoops' reason-prefix predicate still matched, and the next sweep revived a
 * loop its owner had explicitly ended. `loop_paused_reason` is the system's answer to "why
 * is this row down", and OVERWRITING it on a new down-event is the key's normal semantics
 * (each later disarm already does); only DELETION is forbidden (see reviveDisarmedLoop's
 * doc). The prior words are preserved under `loop_end_superseded_pause_reason` — kept
 * across repeated ends, so the guard's original reason survives an idempotent re-end —
 * and the canonical `pause{reason, pausedAtMs}` shape is written so readStalePausedRoutines
 * reads a deliberately-ended loop as an EXPLAINED pause instead of reasonMissing.
 */
export const LOOP_END_PAUSE_PREFIX = 'loop:end (WI-39786): owner-deliberate:';

export async function deactivateLoop(
  ownerId: string,
  opts: { sql?: Sql; reason?: string; actor?: string } = {},
): Promise<boolean> {
  const sql = opts.sql ?? getOrgPg().sql;
  const reason = opts.reason?.trim() || 'loop:end — deactivated by its owner';
  // Keep direct loop:end calls backward-compatible while allowing supervisory callers
  // (for example goal-stop fan-out) to preserve who actually caused the disarm.
  const actor = opts.actor?.trim() || 'loop-end';
  const pauseReason = `${LOOP_END_PAUSE_PREFIX} ${reason}`;
  // The already-inactive stamp runs FIRST: after the deactivation UPDATE below flips the row,
  // this predicate would also match the row just ended and overwrite the superseded-copy key
  // with the reason we just wrote. Ordered this way, each row is stamped exactly once.
  await sql`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         -- Preserve the FIRST non-loop:end down-cause across repeated ends: a
                         -- second loop:end must not overwrite the copy with our own first stamp.
                         'loop_end_superseded_pause_reason',
                         CASE WHEN metadata->>'loop_paused_reason' LIKE ${LOOP_END_PAUSE_PREFIX + '%'}
                              THEN COALESCE(metadata->'loop_end_superseded_pause_reason', 'null'::jsonb)
                              ELSE COALESCE(metadata->'loop_paused_reason', 'null'::jsonb)
                         END,
                         'loop_paused_reason', ${pauseReason}::text,
                         'loop_paused_at', now()::text,
                         'pause', jsonb_build_object(
                           'reason', ${pauseReason}::text,
                           'pausedAtMs', (extract(epoch from now()) * 1000)::bigint
                         )
                       ),
           updated_at = now()
     WHERE name = ${loopRoutineName(ownerId)} AND active = FALSE
  `;
  const ended = await sql<
    Array<{
      id: string;
      workspace_id: string;
      install_slug: string;
      name: string | null;
      target_role: string | null;
      reschedule_interval_sec: number | null;
    }>
  >`
    UPDATE harness_shared.routines
       SET active = FALSE, updated_at = now(),
           -- WI-39786: the same pause-family stamp as the already-inactive path above, so after
           -- ANY loop:end the row reads "down because its owner ended it" — defence in depth
           -- beside the armed_at supersession bound for the end-after-re-arm shape.
           metadata = (COALESCE(metadata, '{}'::jsonb) - 'last_error' - 'last_error_at' - 'last_error_source')
                    || jsonb_build_object(
                         'loop_end_superseded_pause_reason',
                         CASE WHEN metadata->>'loop_paused_reason' LIKE ${LOOP_END_PAUSE_PREFIX + '%'}
                              THEN COALESCE(metadata->'loop_end_superseded_pause_reason', 'null'::jsonb)
                              ELSE COALESCE(metadata->'loop_paused_reason', 'null'::jsonb)
                         END,
                         'loop_paused_reason', ${pauseReason}::text,
                         'loop_paused_at', now()::text,
                         'pause', jsonb_build_object(
                           'reason', ${pauseReason}::text,
                           'pausedAtMs', (extract(epoch from now()) * 1000)::bigint
                         )
                       )
     WHERE name = ${loopRoutineName(ownerId)} AND active = TRUE
    RETURNING id, workspace_id, install_slug, name, target_role, reschedule_interval_sec
  `;

  // WI-37571 — record the deliberate disarm, the third path the `event` column comment
  // already advertises ("guard disarm / cost-cap / loop:end") and the only one an AGENT
  // chooses. Distinguishing the caller matters when reconstructing why a loop went quiet:
  // an agent ending its own loop is a healthy outcome, while a supervisory fan-out is a
  // deliberate external stop. Keep the direct loop:end default, but do not mislabel other
  // callers that use this shared primitive.
  //
  // No `was_active` check is needed here, unlike autoPauseLoopRoutine: this UPDATE is already
  // guarded `AND active = TRUE`, so every returned row genuinely crossed TRUE -> FALSE.
  // Iterated rather than indexed [0] because the predicate keys on `name` alone, and the
  // shadow-deactivation path above exists precisely because duplicate loop rows do occur.
  for (const row of ended) {
    void recordLoopTransition(sql, {
      workspaceId: row.workspace_id,
      installSlug: row.install_slug,
      routineId: row.id,
      routineName: row.name,
      targetRole: row.target_role,
      targetOwnerId: ownerId,
      event: 'disarmed',
      actor,
      newNextFireAt: null,
      intervalSec: row.reschedule_interval_sec,
      detail: { reason },
    });
  }

  return ended.length > 0;
}

/**
 * Deactivate the loop that is carrying a surrendered GOAL authority.
 *
 * A plain `deactivateLoop(ownerId)` is too broad for a mode clear: an owner can
 * legitimately have an AUTO loop for a different mission, and clearing GOAL
 * must not stop that unrelated work. The structured loop goal is the durable
 * join between the mode's subject and the wake text, so only rows whose frozen
 * goal mentions the surrendered subject are stopped.
 *
 * Inactive queued wakes are already superseded by the delivery choke point,
 * which means this single active=false transition covers both future fires and
 * wakes already queued when the authority was revoked.
 */
export async function deactivateLoopForGoal(
  ownerId: string,
  goalSubject: string,
  opts: { sql?: Sql; reason?: string; actor?: string } = {},
): Promise<boolean> {
  const subject = goalSubject.trim();
  if (!subject) return false;

  const sql = opts.sql ?? getOrgPg().sql;
  const reason = opts.reason?.trim() || `goal authority '${subject}' revoked`;
  const actor = opts.actor?.trim() || 'goal-authority-revocation';
  const ended = await sql<
    Array<{
      id: string;
      workspace_id: string;
      install_slug: string;
      name: string | null;
      target_role: string | null;
      target_owner_id: string | null;
      reschedule_interval_sec: number | null;
    }>
  >`
    UPDATE harness_shared.routines
       SET active = FALSE, updated_at = now(),
           metadata = (COALESCE(metadata, '{}'::jsonb) - 'last_error' - 'last_error_at' - 'last_error_source')
                    || jsonb_build_object(
                         'loop_paused_reason', ${reason}::text,
                         'loop_paused_at', now()::text,
                         'pause', jsonb_build_object(
                           'reason', ${reason}::text,
                           'pausedAtMs', (extract(epoch from now()) * 1000)::bigint
                         )
                       )
     WHERE name = ${loopRoutineName(ownerId)}
       AND target_owner_id = ${ownerId}
       AND active = TRUE
       AND position(lower(${subject}) in lower(COALESCE(payload_template->>'goal', ''))) > 0
    RETURNING id, workspace_id, install_slug, name, target_role, target_owner_id,
              reschedule_interval_sec
  `;

  for (const row of ended) {
    void recordLoopTransition(sql, {
      workspaceId: row.workspace_id,
      installSlug: row.install_slug,
      routineId: row.id,
      routineName: row.name,
      targetRole: row.target_role,
      targetOwnerId: row.target_owner_id ?? ownerId,
      event: 'disarmed',
      actor,
      newNextFireAt: null,
      intervalSec: row.reschedule_interval_sec,
      detail: { reason, goalSubject: subject, authorityRevoked: true },
    });
  }
  return ended.length > 0;
}

/**
 * Intentionally hand an active engine loop to another session without ending and
 * recreating it. The single UPDATE is the ownership cutover: cadence, fire
 * history, parked state, limits, and carry policy stay on the same routine row.
 *
 * A target that already owns an active loop is rejected rather than silently
 * merging two histories. Callers can end that target loop explicitly first.
 */
export async function transferLoopOwnership(
  fromOwnerId: string,
  toOwnerId: string,
  opts: { sql?: Sql } = {},
): Promise<{ transferred: boolean; routineId: string | null }> {
  if (!fromOwnerId.trim() || !toOwnerId.trim()) throw new Error('fromOwnerId and toOwnerId are required');
  if (fromOwnerId === toOwnerId) return { transferred: false, routineId: null };
  const sql = opts.sql ?? getOrgPg().sql;
  return (await sql.begin(async (tx) => {
    const rows = await tx<Array<{ id: string; install_slug: string }>>`
      UPDATE harness_shared.routines source
         SET target_owner_id = ${toOwnerId},
             name = ${loopRoutineName(toOwnerId)},
             updated_at = now(),
             metadata = COALESCE(source.metadata, '{}'::jsonb) || jsonb_build_object(
               'loop_transferred_from', ${fromOwnerId}::text,
               'loop_transferred_to', ${toOwnerId}::text,
               'loop_transferred_at', now()::text
             )
       WHERE source.name = ${loopRoutineName(fromOwnerId)}
         AND source.target_owner_id = ${fromOwnerId}
         AND source.reschedule_interval_sec IS NOT NULL
         AND source.active = TRUE
         AND NOT EXISTS (
           SELECT 1
             FROM harness_shared.routines target
            WHERE target.workspace_id = source.workspace_id
              AND target.target_owner_id = ${toOwnerId}
              AND target.reschedule_interval_sec IS NOT NULL
              AND target.active = TRUE
         )
      RETURNING source.id, source.install_slug`;
    const moved = rows[0];
    if (!moved || rows.length !== 1) return { transferred: false, routineId: null };

    // EI-20313321954782474 — a cold loop is not only its routine row. Its next
    // fresh-context wake reads the carry-note by OWNER scope, so transferring the
    // routine alone wakes the successor with either no continuity or an unrelated
    // stale note already left under the destination owner. Move both owner-scoped
    // carry surfaces in this SAME transaction. Updating only `scope` deliberately
    // preserves the complete row, including its journal and declared `deps`.
    //
    // A destination without an active loop may still have residue from an older
    // ended loop. The explicitly transferred source objective is authoritative:
    // clear that residue even when the source has no note, otherwise the successor
    // can resume the destination's stale goal. Scope is globally owner-unique, but
    // old producer versions wrote the same scope under different workspace ids, so
    // move/delete every workspace copy rather than assuming the pinned namespace.
    const fromCarryScope = `loop:${moved.install_slug}:${fromOwnerId}`;
    const toCarryScope = `loop:${moved.install_slug}:${toOwnerId}`;
    const fromNagScope = `loopnag:${moved.install_slug}:${fromOwnerId}`;
    const toNagScope = `loopnag:${moved.install_slug}:${toOwnerId}`;
    await tx`
      DELETE FROM harness_shared.carry_notes
       WHERE scope IN (${toCarryScope}, ${toNagScope})`;
    await tx`
      UPDATE harness_shared.carry_notes
         SET scope = CASE scope
                       WHEN ${fromCarryScope} THEN ${toCarryScope}
                       ELSE ${toNagScope}
                     END
       WHERE scope IN (${fromCarryScope}, ${fromNagScope})`;

    return { transferred: true, routineId: moved.id };
  })) as { transferred: boolean; routineId: string | null };
}

/** A lean view of an owner's loop, for loop:status / observability. */
export interface LoopStatus {
  name: string;
  ownerId: string;
  harnessSlug: string;
  active: boolean;
  intervalSec: number | null;
  /** Loop lifecycle (su-cold-auto-mode-2026-07-03 P-003/P-008): 'warm' (default) re-wakes the
   *  same session in place; 'cold' resets/recycles to the carry-note each wake. Observability so
   *  an operator can see whether a loop is cold and, if it looks lost, re-arm it warm. */
  carry: 'warm' | 'cold';
  /** Continuation policy (flush-to-proceed P-005): 'settle' (default) ends the turn after one
   *  unit; 'gated' runs multiple units per turn behind the continuation gate. Observability so an
   *  operator can see whether a loop is in gated mode. */
  continuation: 'settle' | 'gated';
  /** Loop mode (WI-5345): 'work' (default) = the create+self-assign work-item contract; 'monitor'
   *  = the lean check/steer/checkpoint contract with no work-item boilerplate (P-001c). Previously
   *  only used at arm-time to pick a wake-prompt template and never persisted/observable anywhere
   *  — a leader had no way to tell "wedged in a pure-monitor loop" from "healthy work loop,
   *  between items" without this. */
  mode: 'work' | 'monitor';
  /** P-004: the admitted monitor policy (predicate, stop condition, configured + REMAINING
   *  no-delta budget, authority) for a `mode:'monitor'` loop; null on a work loop or on a
   *  monitor armed before the policy existed. Exposed so an operator can see how many quiet
   *  wakes a monitor has left BEFORE the engine stands it down, rather than only afterwards. */
  monitor: PersistedMonitorConfig | null;
  /** P-004: why the engine stood this monitor down (budget exhausted / authority lost), or
   *  null when it never did. Survives the deactivation, so `active:false` is explicable. */
  monitorStanddown: MonitorStanddownRecord | null;
  /**
   * EI-22138154596110669: an active `loop:standdown-all` bulk pause on THIS loop, or null
   * when none is in force. Distinct from an ordinary per-loop pause (routines:set / loop:end
   * with no `standdownAll` marker) — those never populate this field, by design, so a
   * fleet-wide stand-down broadcast can be verified against real per-loop state instead of
   * trusted at face value (the bug this exists to close: a broadcast asserted "all engine
   * loops are paused" while only 2 loop routines had actually been touched).
   * `banner` is the ready-to-render `loop:status` line (`loopStanddownBanner`); the other
   * fields are the parsed `RoutinePauseRecord` a caller may want to compute its own message
   * from (e.g. a leader-brief aggregate).
   */
  standdown: {
    banner: string;
    reason: string | null;
    pausedBy: string | null;
    pausedAtMs: number | null;
    expiresAtMs: number | null;
  } | null;
  /**
   * The loop's GOAL text, or null for a loop armed without one (or armed before this
   * field existed — those keep only the kickoff prose and cannot be back-filled).
   *
   * EI-20072281215342526 — WHY THIS EXISTS. An AUTO agent's mission lived ONLY inside
   * the rendered wake kickoff. A carry-respawn delivers no kickoff, so a successor
   * inherited its held work-items WITHOUT the mission that generated them, could not
   * tell a mission-held item from an ambient claim, and — the expensive part — did not
   * halt: it re-oriented, saw unclaimed backlog, and started doing something else,
   * confidently. `loop:status` was the obvious place to look the mission up and
   * returned everything EXCEPT the goal.
   *
   * ⚠ FROZEN AT ARM TIME, NOT LIVE STATE. It is the least current thing in any payload
   * that carries it (the carry-note is rewritten every turn; work-item state is live),
   * so a reader must treat it as orientation and the checkpoint as the action — see
   * `loop-goal-staleness.ts`, which measures rather than merely cautions.
   */
  goal: string | null;
  /** Total delivered fires so far (metadata.fire_count) — for a cold loop this is the wakeCount
   *  cadence counter (a RECYCLE lands every Nth). 0 when never fired / not tracked.
   *  ⚠ EI-16202: this is FIRE history, not ARM history — calling loop:arm to (re-)arm an
   *  EXISTING loop does NOT touch it (only an actual delivered fire does). A re-arm that
   *  legitimately took (see `armedAt`) can leave `fireCount`/`lastFiredAt` byte-identical
   *  to before the arm — that is expected, not a sign the arm silently no-op'd.
   *  ⚠⚠ WI-36070: this is a LIFETIME counter and is NOT the number `maxFires` is compared
   *  against — read `firesSinceArm` for that. `fireCount > maxFires` on an `active` loop is
   *  the EXPECTED reading for any long-lived session, not a breached dead-man. */
  fireCount: number;
  /** WI-36070 — fires since the CURRENT arm: `max(0, fire_count - fire_count_at_arm)`, the exact
   *  expression `checkLoopDeadMan` decides on (loop-dead-man.ts). This is the ONLY count that may
   *  be compared against `maxFires`, and the reason it exists as its own field: `fireCount`
   *  (lifetime) used to be the only fire number reported, so a reader with an arm-relative bound
   *  beside a lifetime count could form exactly one comparison and it was the wrong one.
   *
   *  EI-19339729634604096 moved `maxFires` off the lifetime total and onto this since-arm delta,
   *  but left the reported payload unchanged — which turned a merely ambiguous pairing into a
   *  misleading one, since the two numbers still sit together looking like a comparison. Both
   *  misreadings cost: an active loop reads as already-breached (false alarm), and — the
   *  expensive direction — a loop ONE fire from its bound is indistinguishable from one with
   *  30 fires of headroom, while EI-19899671638499010 documents that hitting the bound puts an
   *  AUTO-mode session silently inert with no way to restart itself.
   *
   *  0 when never fired, when no `fire_count_at_arm` baseline exists (a loop armed before that
   *  stamp), or when the delta would go negative — clamped at 0 exactly as the guard clamps it,
   *  so this field can never report MORE headroom consumed than the guard itself counted. */
  firesSinceArm: number;
  /** True while the loop's turn is in flight (parked at next_fire_at='infinity'). */
  parked: boolean;
  /** Next scheduled fire (ISO), or null when parked / unset. */
  nextFireAt: string | null;
  /** ISO of the last DELIVERED fire, or null if the loop has never fired. Same EI-16202
   *  caveat as `fireCount` — a re-arm does not advance this. */
  lastFiredAt: string | null;
  /** ISO of the last time THIS routine row was (re-)armed via loop:arm / autoArmFleetMemberLoop
   *  (metadata.armed_at, stamped by stampLoopArmedAt on every materializeLoop call — arm AND
   *  re-arm alike). EI-16202: this is the field that actually moves on a re-arm — use it, not
   *  `fireCount`/`lastFiredAt`/`lastDeliveryOutcome`/`consecutiveErrors` (all fire-history, see
   *  their own docs), to verify a loop:arm call actually reached the underlying scheduler row
   *  — e.g. across a re-arm separated by a compaction/respawn. Null only if the row predates
   *  this stamp (EI-7613) and has never been re-armed since. */
  armedAt: string | null;
  costCapCents: number | null;
  /** P2a dead-man bound on fires (if configured). ⚠ ARM-RELATIVE: compare it against
   *  `firesSinceArm`, NEVER against `fireCount` (a lifetime counter). A re-arm resets the
   *  budget, so `maxFires: 40` always means "40 more fires from this arm". */
  maxFires: number | null;
  maxDurationSec: number | null;
  /** P2b (loop-wake-rate-limit-robustness): distinguish "parked, healthy in-flight" from
   *  "parked, last fire produced NO completion in ≥max(30min,4×interval)" — i.e. the wake turn
   *  likely died. `stalled` is the verdict; `stalledSinceMs` is how long it has been parked
   *  past the fire (null when healthy); `lastDeliveryOutcome` is the autoloop fire-state's last
   *  status (e.g. 'queued' / 'loop-lifecycle' / 'resume-turn-death:rate_limited'); and
   *  `consecutiveErrors` is the failure-streak the circuit watches. */
  stalled: boolean;
  stalledSinceMs: number | null;
  /** EI-16202: fire-DELIVERY history from `autoloop_state` (keyed by routine name), not
   *  arm history — a re-arm never touches this row, so it legitimately survives byte-identical
   *  across a loop:arm call (including one separated by a compaction/respawn). See `armedAt`. */
  lastDeliveryOutcome: string | null;
  /** Same caveat as `lastDeliveryOutcome` — the failure-streak counter only resets on the
   *  fire path (a successful delivery), never on a re-arm. */
  consecutiveErrors: number;
  /** WI-36792 — ISO of the last time the FIRE GATE denied this loop's claim
   *  (`autoloop_state.last_withheld_at`, written by loop-fire.ts's pre-`wake()` withhold path,
   *  EI-14483). Null when the gate has never withheld a fire — the normal case for most loops.
   *
   *  READ IT AGAINST `lastFiredAt`: the claim stamps `routines.last_fired_at` and the gate is
   *  consulted immediately after, so `lastWithheldAt >= lastFiredAt` means THE MOST RECENT
   *  fire never went out at all. That distinguishes "the agent was asked and did not answer"
   *  from "the agent was never asked", which every fire-history field here otherwise conflates:
   *  a withhold deliberately does NOT touch `lastFiredAt`/`consecutiveErrors` (so as not to
   *  reset the backoff clock it is enforcing), and it creates NO `event_wake_deliveries` row,
   *  so `lastWakeAt` stays frozen while `lastFiredAt` advances — byte-identical to a wake that
   *  black-holed on a dead session.
   *
   *  ⚠ These columns existed for three weeks with ZERO readers (EI-14483 built them as a
   *  durable trail; nothing consumed it), including `stalled-loops-guard`, which was deciding
   *  a PERMANENT disarm on exactly the distinction they carry. Surfacing it here is what lets
   *  that guard tell the two apart — see its withheld-fire veto.
   *
   *  OPTIONAL on semantics, not to dodge stranded fixtures (CLAUDE.md warns against the latter,
   *  and WI-36070/WI-6957 both stranded suites by adding a REQUIRED field to this ~38-referrer
   *  interface): most rows genuinely have `last_withheld_at IS NULL`, so a required field would
   *  force every construction site to assert a value that does not exist. */
  lastWithheldAt?: string | null;
  /** EI-16210: the most recent `event_wake_deliveries` row recorded for THIS loop's own
   *  wake (`source = 'loop:<routineId>'`) — the actual delivery-ladder outcome behind a
   *  generic `lastDeliveryOutcome:'loop-stuck-backstop'`. Distinguishes "the wake was
   *  genuinely never delivered" (lastWakeStatus stays 'pending'/'dropped'/'dead', or this
   *  is null — no wake row at all) from "the wake WAS delivered (e.g. `psu-socket-inject`)
   *  but no post-fire completion signal was ever detected" (lastWakeStatus='delivered') —
   *  the second case points at a reconcile-side completion-signal gap, not a dead session.
   *  Null when this loop has never fired (no wake row exists yet). */
  lastWakeChannel: string | null;
  lastWakeStatus: string | null;
  /** ISO of the wake row's `delivered_at` (or `created_at` if never delivered). */
  lastWakeAt: string | null;
  /** The delivery ladder's captured error text for that wake, if any (e.g. a spawn
   *  failure) — null on a clean delivery or when no wake row exists. */
  lastWakeError: string | null;
  /** EI-18712914572668391: ISO of the most recent Stop-hook 'ended' lifecycle marker for
   *  this OWNER, UNSCOPED by fire window (unlike the internal per-fire completion check) —
   *  the actual "a real turn last finished at…" signal. Null when this owner has never
   *  completed a turn (or the row predates lifecycle tracking). Compare against
   *  `lastFiredAt` to see whether fires are outpacing genuine turn production. */
  lastTurnAt: string | null;
  /** ISO of the most recent assistant output whose immediately preceding user
   *  prompt carried the authored `turn-origin:loop-fire` envelope. Unlike
   *  lastTurnAt/lastRealTurnAt, owner-prompted work cannot advance this clock;
   *  it is the completion signal used by turnsStalled. Optional for legacy
   *  fixture compatibility; production status rows always populate it. */
  lastLoopTurnAt?: string | null;
  /** WI-6951: ISO of the most recent GENUINE turn completion — the lifecycle session-end
   *  marker deliberately EXCLUDED (EI-19316779460752535 widened the SOURCE from the
   *  journal alone to journal ∪ session_turns assistant turns, because the journal covers
   *  only ~2.3% of turns; the exclusion WI-6951 cares about is unchanged). `lastTurnAt` above unions
   *  that marker in as a defensive fallback (WI-6069, so a lifecycle-only read cannot go
   *  perpetually stale), which is right for the liveness question it answers — "is this loop
   *  producing turns at all?" — because there any evidence of activity is better than none.
   *  It is WRONG for the stricter question "did a turn complete AFTER instant X?": '■ session
   *  ended' is a session DEATH, not a turn, and a cold reset kills its predecessor, so that
   *  marker lands at kill-time — by construction after the last loop:checkpoint write. Feeding
   *  it to the cold-wake staleness check reported the kill instant as "you completed a turn at
   *  …". Measured 2026-08-02 over 7d: 525 of 1,351 markers (38.9%, 118 owners) sat further than
   *  the check's 5-min floor from that owner's last real turn. Use THIS field for any
   *  "was a turn produced after T" test; never fall back to `lastTurnAt` for it. */
  lastRealTurnAt: string | null;
  /**
   * Cadence observability for the current arm. `expectedFiresSinceArm` is the number of
   * interval-sized opportunities that have elapsed since `armedAt`; compare it with
   * `firesSinceArm`, which is the number of attempted fires actually recorded. The
   * effective interval/ratio are derived from the arm-to-last-fire span, while the
   * longest gap is measured from the durable loop wake-delivery history. A null metric
   * means the source does not have enough timestamps yet, never "zero".
   */
  expectedFiresSinceArm: number | null;
  effectiveIntervalSec: number | null;
  cadenceRatio: number | null;
  longestObservedGapSec: number | null;
  /** True when the existing cadence-drift advisory has enough evidence of a late fire path. */
  cadenceDrift: boolean;
  /**
   * True when the current arm has crossed the fire-starvation floor without recording any
   * post-arm fire. Unlike `turnsStalled`, this covers a scheduler wedge before the arm ever
   * produced a fire (including an overdue unparked schedule). Exposed separately from the
   * unified `stalled` verdict so the stalled-loop actor can choose its reachable-owner repair
   * path instead of treating the owner as a turn-stalled corpse.
   */
  fireStarved: boolean;
  /** EI-18712914572668391: true when this loop keeps getting re-armed (fireCount climbing,
   *  `stalled` reading false because it isn't currently PARKED) while `lastTurnAt` has not
   *  kept pace — i.e. fires are being ATTEMPTED without turns actually being PRODUCED. This
   *  is the case `stalled` alone cannot see: `stalled` only fires while parked (an in-flight
   *  turn stuck past its dwell window); an ARMED loop has, by construction, already been
   *  judged "settled" by the reconciler for its most recent fire — including via the WEAKER
   *  presence-quiescence fallback, which can be satisfied without a genuine turn ever
   *  completing. A monitor reading `stalled:false` while `turnsStalled:true` is the exact
   *  "healthy reading while the thing it monitors is dead" failure this field exists to
   *  surface. Requires ≥3 fires (never flags a freshly-armed loop) — see computeTurnsStalled. */
  turnsStalled: boolean;
  /** EI-21219642654072321: age of the CURRENT park in seconds — non-null ONLY while
   *  parked. `parked:true` + `nextFireAt:null` is the DESIGNED in-flight sentinel
   *  (claim.ts parks a pure loop at 'infinity' while its fired turn runs), NOT a lost
   *  arm: judge health by THIS age against the recovery ladder (reconcile-loop-routines'
   *  quick-retry ≈10min, stuck-park backstop ≈max(30min, 4×interval)) plus
   *  `lastRealTurnAt`, never by the null nextFireAt alone — reading that null as "no
   *  wake armed" filed a healthy mid-turn loop as structural breakage. */
  parkedForSec: number | null;
  /** EI-19325288514307343: non-null iff the most recent recorded fire was a
   *  provider-wall lifecycle-death and the loop is waiting out its backoff before
   *  retrying — the "backed off until T (reason)" signal that lets a reader
   *  distinguish this from a genuinely dead loop without opening the escalation
   *  queue. See {@link computeLifecycleBackoff}. */
  lifecycleBackoff: LifecycleBackoffInfo | null;
}

/**
 * Pure stall verdict (P2b): a loop is "stalled" when it is PARKED (turn in flight) far past its
 * fire (≥ max(30min, 4×interval)) with NO completion marker AND no session activity since the
 * fire — the signature of a dead wake turn, distinct from a legitimately long turn (which keeps
 * producing activity). Mirrors the reconcile stuck-park backstop / the watchdog loop-stalled
 * predicate. Injectable inputs keep it unit-testable.
 */
export function computeLoopStall(input: {
  parked: boolean;
  parkedMs: number | null;
  intervalSec: number | null;
  hasCompletionSinceFire: boolean;
  /** WI-6639: the RAW timestamps, deliberately not a caller-computed `activeSinceFire`
   *  boolean. That boolean was the bug: every caller derived it as `presence > lastFired`,
   *  a comparison of two PAST instants, so a session that emitted one presence beat after
   *  its final fire and then died pinned it `true` forever — permanently disarming the
   *  stall check below no matter how many hours passed (measured live: 12 loops parked at
   *  'infinity' for 49h–160h, all reading `stalled: false`). Liveness is only meaningful
   *  against `now`, so the comparison happens HERE, under test, not at the call site. */
  lastFiredAtMs: number | null;
  lastActiveAtMs: number | null;
  nowMs?: number;
}): { stalled: boolean; stalledSinceMs: number | null } {
  const stuckParkMs = Math.max(30 * 60_000, (input.intervalSec ?? 60) * 4 * 1000);
  if (!input.parked || input.parkedMs == null) return { stalled: false, stalledSinceMs: null };
  if (input.hasCompletionSinceFire) return { stalled: false, stalledSinceMs: null };
  const now = input.nowMs ?? Date.now();
  // "Still legitimately working" needs BOTH terms: active since the fire (so a pre-fire
  // corpse never counts) AND active RECENTLY (so the judgement cannot freeze true once the
  // session dies). A genuinely long turn keeps its presence beat fresh and stays exempt.
  const activeSinceFire =
    input.lastActiveAtMs != null &&
    input.lastFiredAtMs != null &&
    input.lastActiveAtMs > input.lastFiredAtMs &&
    now - input.lastActiveAtMs < stuckParkMs;
  if (activeSinceFire) return { stalled: false, stalledSinceMs: null };
  if (input.parkedMs >= stuckParkMs) return { stalled: true, stalledSinceMs: input.parkedMs };
  return { stalled: false, stalledSinceMs: null };
}

/** Minimum arm-relative opportunities that must pass without a fire before the
 *  fire-starvation signal can say anything. A freshly armed loop may be parked
 *  while its first turn is legitimately settling; requiring several missed
 *  opportunities keeps that normal startup path quiet. */
export const LOOP_FIRE_STARVATION_MIN_MISSED_OPPORTUNITIES = 3;

/**
 * Pure verdict for the scheduler-wedge shape where an active loop has had
 * several configured fire opportunities without a fire since the current arm.
 * A parked loop has no concrete next fire while its turn is in flight; an
 * unparked loop must instead have a concrete next fire already overdue. This is
 * intentionally narrower than `computeLoopStall`: the latter reasons from the
 * most recent fire, while this signal covers a re-arm whose schedule was
 * orphaned before it produced one.
 *
 * Missing or contradictory timestamps fail quiet. A recent presence beat also
 * suppresses the signal because a live owner may simply be in a legitimately
 * long first turn; the stalled-loop actor can use its reachability evidence for
 * any stronger action. This function only contributes to the read-only
 * `loop:status` stalled verdict.
 */
export function computeLoopFireStarvation(input: {
  active: boolean;
  parked: boolean;
  firesSinceArm: number;
  expectedFiresSinceArm: number | null;
  armedAtMs: number | null;
  lastFiredAtMs: number | null;
  lastActiveAtMs?: number | null;
  /** Required for the unparked scheduler-wedge shape; parked loops use the infinity sentinel. */
  nextFireAtMs?: number | null;
  intervalSec: number | null;
  nowMs?: number;
}): boolean {
  if (!input.active) return false;

  const expected = input.expectedFiresSinceArm;
  if (expected == null || !Number.isFinite(expected) || expected < LOOP_FIRE_STARVATION_MIN_MISSED_OPPORTUNITIES) {
    return false;
  }

  const firesSinceArm = Number.isFinite(input.firesSinceArm) ? Math.max(0, input.firesSinceArm) : 0;
  if (expected - firesSinceArm < LOOP_FIRE_STARVATION_MIN_MISSED_OPPORTUNITIES || firesSinceArm !== 0) {
    return false;
  }

  const armedAtMs = input.armedAtMs;
  if (armedAtMs == null || !Number.isFinite(armedAtMs)) return false;
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs < armedAtMs) return false;

  // A valid fire at or after this arm disproves the "no post-arm fire" shape.
  // An invalid non-null timestamp is not evidence either way, so fail quiet;
  // null means the loop has never recorded a fire and is strong evidence here.
  if (input.lastFiredAtMs != null) {
    if (!Number.isFinite(input.lastFiredAtMs) || input.lastFiredAtMs >= armedAtMs) return false;
  }

  const lastActiveAtMs = input.lastActiveAtMs;
  const activeRecently =
    lastActiveAtMs != null &&
    Number.isFinite(lastActiveAtMs) &&
    nowMs - lastActiveAtMs < turnsStalledFloorMs(input.intervalSec);
  if (activeRecently) return false;

  // Parked loops carry no concrete nextFireAt by design: their current fire is
  // already in flight, so the no-post-arm-fire evidence is sufficient. An
  // unparked loop is only starved when the scheduler's concrete next fire is
  // overdue; a future or missing timestamp is not evidence of a wedge.
  if (input.parked) return true;
  const nextFireAtMs = input.nextFireAtMs;
  return nextFireAtMs != null && Number.isFinite(nextFireAtMs) && nextFireAtMs < nowMs;
}

/** Minimum fires before `computeTurnsStalled` will ever flag a loop — a freshly-armed loop
 *  (fire 1 or 2, still mid-flight) has no meaningful "fires vs turns" trend yet; flagging it
 *  would just be noise on ordinary startup latency. */
export const TURNS_STALLED_MIN_FIRE_COUNT = 3;

/**
 * Pure "fires outpacing turns" verdict (EI-18712524449804476 companion,
 * EI-18712914572668391): distinguishes fires ATTEMPTED (fireCount, which climbs on every
 * bare-interval re-arm regardless of whether a fire ever became a real turn) from turns
 * actually PRODUCED (lastTurnAt — the most recent genuine Stop-hook 'ended' marker for the
 * owner). Deliberately independent of `parked`/`computeLoopStall`: an ARMED loop has already
 * been judged "settled" for its most recent fire by the reconciler (possibly via the WEAKER
 * presence-quiescence fallback, which needs no genuine turn-completion text at all) — the
 * parked-only check can never see this class. Conservative by design (favors false-negative
 * over false-positive on a widely-consumed fleet-health signal): requires several fires
 * first, and only fires when the gap between the most recent fire and the most recent real
 * turn exceeds a generous multiple of the interval — the same "give it several real cycles"
 * floor `stuckParkMs`/`quickRetryParkMs` already use elsewhere in this system.
 */
/**
 * The "give it several real cycles" floor the turns-stalled verdict measures gaps against.
 * EXPORTED because `stalled-loops-guard.ts` — the ACTOR that disarms loops on this verdict —
 * sizes its own recent-real-turn veto window from the SAME floor. Two parties must agree on
 * this number, so it exists in exactly one place: a guard whose veto window silently drifted
 * from the verdict's floor would start disarming the very loops the veto exists to protect.
 */
export function turnsStalledFloorMs(intervalSec: number | null | undefined): number {
  return Math.max(30 * 60_000, (intervalSec ?? 60) * 4 * 1000);
}

/** EI-19325288514307343: a loop backed off on a provider usage-wall (a "lifecycle
 *  death" — see reconcile-loop-routines.ts's classifyLoopLifecycleTurn) is, from
 *  every liveness surface an owner actually looks at, PIXEL-IDENTICAL to a
 *  genuinely dead loop for the whole backoff — up to the `clampUsageRearmDelayMs`
 *  ceiling, which since EI-20544023385610622 is 6h for an INFERRED reset but up to
 *  7d for one the provider NAMED (a weekly wall). Widening that ceiling widens this
 *  window, which is precisely why `lifecycleBackoff` below is not optional: it is the
 *  only thing that distinguishes the two states, and the longer hold makes reading it
 *  (rather than `active`/`nextFireAt` alone) mandatory, not merely advisable. It
 *  reads `active:true` with a `nextFireAt` far in the future and nothing else
 *  distinguishes "walled, will resume" from "wedged, needs a human". The
 *  escalation the reconciler fires (defaultEscalateLifecycleDeath) is correctly
 *  advisory-severity and lands only in the passive alert-tier attention queue —
 *  it deliberately does not push a toast/OS notification, so it does not help an
 *  owner who is looking at loop:status / fleet:assignments instead of that queue. */
export interface LifecycleBackoffInfo {
  /** The provider-kill classification (`classifyLoopLifecycleTurn`'s reason, e.g.
   *  'usage_limit' / 'rate_limited') — the raw suffix of `lastDeliveryOutcome`. */
  reason: string;
  /** ISO of the fire this backoff is waiting for (mirrors `nextFireAt`), or null
   *  when the routine has no scheduled next fire (should not happen while active
   *  and un-parked, but defensive). */
  until: string | null;
  /** Milliseconds from `nowMs` until `until`, clamped to >=0. Null when `until`
   *  is null or unparseable. */
  resumesInMs: number | null;
}

/**
 * The two `lastDeliveryOutcome` prefixes that both mean "this fire was a provider-wall
 * backoff, not a normal cadence tick" — written by two INDEPENDENT observers of the same
 * underlying event:
 *  - `loop-lifecycle-death:` — the reconcile-loop backstop's own classification
 *    (`classifyLoopLifecycleTurn`, reconcile-loop-routines.ts), which catches an
 *    inject-path death or a case the fast observer below missed.
 *  - `resume-turn-death:` — the FAST observer (`harness/routines/loop-turn-outcome.ts`,
 *    P1a), which reacts the instant a detached resume turn's exit is seen and re-arms
 *    `next_fire_at` from the provider's `retry-after` — the common case, and the one this
 *    function originally did NOT recognize (EI-19381528967421062): a loop rate-limited
 *    into a ~100x-interval wait via THIS path read `lifecycleBackoff: null` (silently
 *    absent, not merely stale), because only the OTHER prefix was matched. Both name the
 *    SAME `TurnErrorClass` suffix (see turn-error.ts) for the SAME reason — recognizing
 *    only one is exactly the kind of path-specific gap this detector exists to close.
 */
const LIFECYCLE_BACKOFF_PREFIXES = ['loop-lifecycle-death:', 'resume-turn-death:'] as const;

/**
 * PURE derivation: is this loop's MOST RECENT recorded fire outcome a provider
 * lifecycle-death, and if so when is it due to retry. `lastDeliveryOutcome` is
 * overwritten on every fire (recordFire), so this clears itself the moment a
 * later fire produces a normal outcome — it is never a sticky/stale flag.
 * Gated on `active`: an ended/paused loop has nothing to "resume".
 */
export function computeLifecycleBackoff(input: {
  active: boolean;
  lastDeliveryOutcome: string | null;
  nextFireAtIso: string | null;
  nowMs?: number;
}): LifecycleBackoffInfo | null {
  if (!input.active) return null;
  const outcome = input.lastDeliveryOutcome;
  if (!outcome) return null;
  const prefix = LIFECYCLE_BACKOFF_PREFIXES.find((p) => outcome.startsWith(p));
  if (!prefix) return null;
  const reason = outcome.slice(prefix.length).trim() || 'unknown';
  const now = input.nowMs ?? Date.now();
  const untilMs = input.nextFireAtIso ? new Date(input.nextFireAtIso).getTime() : NaN;
  const resumesInMs = Number.isFinite(untilMs) ? Math.max(0, untilMs - now) : null;
  return { reason, until: input.nextFireAtIso, resumesInMs };
}

export function computeTurnsStalled(input: {
  active: boolean;
  fireCount: number;
  lastFiredAtMs: number | null;
  lastTurnAtMs: number | null;
  /** Strict loop-origin completion clock. When this property is present (even
   *  as null), manual/owner-prompted assistant turns in lastTurnAtMs do not
   *  count as progress. Omitted only by legacy pure callers. */
  lastLoopTurnAtMs?: number | null;
  /** WI-6639: presence beat, used ONLY to exempt a session that is demonstrably still
   *  alive right now. Without it the gap below is two frozen past instants (see the
   *  blind-spot note in the body). */
  lastActiveAtMs?: number | null;
  intervalSec: number | null;
  nowMs?: number;
}): boolean {
  if (!input.active) return false;
  if (input.fireCount < TURNS_STALLED_MIN_FIRE_COUNT) return false;
  if (input.lastFiredAtMs == null) return false;
  const floorMs = turnsStalledFloorMs(input.intervalSec);
  const now = input.nowMs ?? Date.now();
  const lastLoopTurnAtMs = Object.prototype.hasOwnProperty.call(input, 'lastLoopTurnAtMs')
    ? (input.lastLoopTurnAtMs ?? null)
    : input.lastTurnAtMs;
  // No turn has EVER completed for this owner, yet several fires have landed — the
  // strongest form of the signal (never masked by a stale-but-present lastTurnAt).
  if (lastLoopTurnAtMs == null) return true;
  const gapMs = input.lastFiredAtMs - lastLoopTurnAtMs;
  if (gapMs >= floorMs) return true;
  // WI-6639 — THE FROZEN-GAP BLIND SPOT. The gap above is a difference between two PAST
  // instants, so it only sees "fires kept landing while turns did not". When the scheduler
  // stops firing too, BOTH freeze and the gap stays small forever: measured live, 11 loops
  // dead for 49h–160h reported turnsStalled:false because their last turn happened moments
  // after their last fire. An armed loop that has not fired in a floor's worth of time and
  // whose session is not currently active is dead, regardless of how tidy that gap looks.
  //
  // ⚠ EI-19406534159939583 — this verdict is DELIBERATELY left claiming both populations, and
  // that is not an oversight. "No fire in a floor's worth of time" covers BOTH a dead agent
  // (WI-6639's measured 156h corpses) and a live agent the firing path stopped serving, and
  // NOTHING IN THIS INPUT SEPARATES THEM: both show a last turn shortly AFTER their last fire,
  // and both show stale presence (a live agent parked on an event beats no heartbeat either).
  // The only thing that tells them apart is whether the owner is still REACHABLE — an I/O
  // probe this pure function cannot and should not make. So the split lives in the ACTOR that
  // does the irreversible write: see stalled-loops-guard.ts, which consults
  // `probeWakeReachability` before disarming and RE-ARMS a reachable owner instead. Readers of
  // this verdict (loop:status, monitors) still get the honest "something is wrong here".
  const activeRecently = input.lastActiveAtMs != null && now - input.lastActiveAtMs < floorMs;
  return now - input.lastFiredAtMs >= floorMs && !activeRecently;
}

/**
 * EI-19406534159939583 — the REMEDY for a loop the firing path stopped serving, and the
 * deliberate dual of `autoPauseLoopRoutine` (loop-cost-cap.ts): where that one answers "this
 * agent stopped working, stop firing at it", this one answers "this agent kept working, start
 * firing at it again". Both are system-actor writes against another owner's routine row;
 * neither asks the owner, because a fire-starved agent cannot re-arm itself — it is asleep
 * waiting for the very fire that stopped coming.
 *
 * Makes the loop due IMMEDIATELY (`next_fire_at = now()`) rather than `now() + interval`,
 * which also makes this write a self-correcting EXPERIMENT rather than a bet:
 *   - the agent really was alive and fire-starved -> it answers the next fire, the loop
 *     resumes, and it never reaches this sweep again;
 *   - the agent was in fact dead and the discriminator was fooled -> the fire lands with no
 *     turn behind it, so on the NEXT sweep `lastTurnAt` is EARLIER than `lastFiredAt`, the
 *     verdict flips to `turnsStalled`, and the guard disarms it exactly as before.
 * The wrong answer therefore costs one extra fire and self-corrects within one sweep, whereas
 * a wrong DISARM is permanent (reconcileLoopRoutines gates its re-arm sweep on `active = TRUE`).
 * That asymmetry is the whole argument for re-arming rather than pausing when in doubt.
 *
 * Never clears `active` and never touches fire history — a re-armed loop must stay the same
 * routine, so `fireCount` keeps climbing and a repeat offender is still visible as one.
 */
export async function rearmFireStarvedLoop(sql: Sql, routineId: string, reason: string): Promise<void> {
  await sql`
    UPDATE harness_shared.routines
       SET next_fire_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'loop_rearmed_reason', ${reason}::text,
                         'loop_rearmed_at', now()::text,
                         -- OLD value (pre-update, same idiom as autoPauseLoopRoutine's
                         -- loop_paused_next_fire_at): what the loop was parked/scheduled at
                         -- before the nudge. 'infinity' here means it was parked awaiting a
                         -- completion-rebase that never came.
                         'loop_rearmed_from_next_fire_at', to_jsonb(next_fire_at::text)
                       ),
           updated_at = now()
     WHERE id = ${routineId} AND active = TRUE
  `;
}

/**
 * WI-37546 — UN-disarm a loop this system disarmed, when its owner turns out to still be
 * working. The third member of the family above: `autoPauseLoopRoutine` stops firing at an
 * agent, `rearmFireStarvedLoop` nudges a loop that is still ARMED, and this one is the only
 * write that crosses back over `active = FALSE`.
 *
 * WHY IT HAS TO EXIST AT ALL. Until now a disarm was a one-way door for everyone: the agent
 * cannot re-arm itself (it is asleep waiting for the fire that no longer comes), and
 * `reconcileLoopRoutines` gates its rescue sweep on `active = TRUE` (reconcile-loop-routines.ts),
 * so the one mechanism built to recover a stuck loop can never see a disarmed one. The only
 * remaining recovery was a human noticing and typing `loop:arm` by hand. Measured 2026-08-09
 * on this workspace: 19 loops were disarmed as turn-stalled and 18 of their owners were making
 * tool calls in the hour BEFORE the disarm — the population that door was closing on was
 * overwhelmingly alive. One of them was a fleet leader, and its reaping silently dropped a
 * standing owner directive for 1h45m.
 *
 * `next_fire_at = now()` for the same reason `rearmFireStarvedLoop` uses it: the revival is a
 * self-correcting EXPERIMENT, not a bet. If the owner really is working, it answers the next
 * fire and never reaches this sweep again; if the revival was wrong, the fire lands with no turn
 * behind it, the verdict flips back to `turnsStalled`, and the guard disarms it again on the
 * next sweep — with `loop_revived_count` now higher, which is what bounds the cycle.
 *
 * `loop_revived_count` is the ONLY new state, and it is a RATCHET, never reset here: it is what
 * stops a genuinely broken loop from flapping between this write and the disarm forever. The
 * caller refuses to revive past its own ceiling by reading this same counter.
 *
 * It ALSO restamps the arm epoch (`armed_at` / `fire_count_at_arm`, the same pair
 * stampLoopArmedAt writes) because a revival IS an arm. That is an overwrite of the arm-epoch
 * keys, not a deletion of census keys, so it does not conflict with the additivity constraint
 * below — and it is load-bearing for the revival predicate's supersession bound: without it, an
 * owner who `loop:end`s the revived loop leaves `armed_at` older than the pause instant, the row
 * re-matches `readRevivableLoops`, and the next sweep undoes the owner's explicit end (measured
 * live on loop-su-50a96a51, 2026-08-18).
 *
 * ⚠⚠ PURELY ADDITIVE ON METADATA — IT MUST NOT DELETE `loop_paused_reason`, AND THAT IS A
 * CORRECTNESS CONSTRAINT, NOT TIDINESS. This function's first draft cleared `pause` and
 * `loop_paused_reason` on the reasoning that they had become false. Both premises were wrong,
 * and the second one was expensive:
 *
 *   1. It bought nothing. `readStalePausedRoutines` (system-health/compute.ts:849) selects
 *      `WHERE r.active = false`, so a revived row is out of that reader's scope by construction
 *      whatever metadata it carries. Corroborated on live data the same day: 5 of the 26 rows
 *      stamped with a pause reason that day were already `active:true` and still carrying it,
 *      i.e. a stale pause reason on an active row is the system's normal, tolerated state.
 *   2. It would have BLINDED THE MEASUREMENT THAT JUDGES THIS VERY FIX. The census behind
 *      WI-37546 — and the Falsifier that item stakes itself on — selects
 *      `metadata->>'loop_paused_reason' ILIKE '%stalled-loops-guard%'`. Deleting that key drops
 *      every rescued row out of the population, so "the veto is working" and "the guard stopped
 *      disarming anybody" become the same shrinking number. Caught by a peer review before it
 *      could fire (su-145fd394, WI-37546 thread post 56734).
 *
 * That is WI-36792's lesson arriving through the MEASUREMENT rather than through the reaper: a
 * blunted guard still reports `checked: N`, and here a blinded census would still report a
 * plausible count. GENERALISE: when a fix writes to the same record its own falsifier reads,
 * check what the falsifier's predicate keys on BEFORE deciding what to clean up — a repair that
 * erases the evidence of the fault it repaired cannot be audited afterwards.
 *
 * Keeping both keys makes the census strictly RICHER than before: a row now carries the disarm
 * AND its reversal, so "disarmed and still down" and "disarmed then revived" are finally
 * distinguishable (`loop_revived_at` / `loop_revived_count`) where previously only the first
 * existed. `loop_revived_from_pause_reason` is retained as well — redundant while the original
 * survives, but it pins the words to THIS revival even after a later disarm overwrites
 * `loop_paused_reason` with a fresh one.
 *
 * Guarded `AND active = FALSE` so it is a no-op against a loop that is already running — this
 * write must never disturb the cadence of a healthy loop, and a concurrent `loop:arm` by the
 * owner should win rather than be re-stamped by the sweep.
 */
export async function reviveDisarmedLoop(sql: Sql, routineId: string, reason: string): Promise<void> {
  const revived = await sql<
    Array<{
      workspace_id: string;
      install_slug: string;
      name: string | null;
      target_role: string | null;
      target_owner_id: string | null;
      reschedule_interval_sec: number | null;
      revived_count: number | null;
      from_pause_reason: string | null;
    }>
  >`
    UPDATE harness_shared.routines
       SET active = TRUE,
           next_fire_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'loop_revived_reason', ${reason}::text,
                         'loop_revived_at', now()::text,
                         -- The disarm's own words, pinned to THIS revival. The original
                         -- loop_paused_reason is deliberately LEFT IN PLACE beside it (see the
                         -- doc above); this copy survives a later disarm overwriting it.
                         'loop_revived_from_pause_reason', COALESCE(metadata->'loop_paused_reason', 'null'::jsonb),
                         -- RATCHET. Never reset by this write; the caller's ceiling reads it.
                         'loop_revived_count', to_jsonb(COALESCE((metadata->>'loop_revived_count')::int, 0) + 1),
                         -- A revival IS an arm, so it stamps the arm epoch exactly as
                         -- stampLoopArmedAt does on every other arm. Without this the row keeps
                         -- its pre-disarm armed_at, and an owner who loop:end's the REVIVED loop
                         -- leaves armed_at < pause instant — which re-matches the revival
                         -- predicate's supersession bound (stalled-loops-guard
                         -- readRevivableLoops) and lets the next sweep undo the owner's explicit
                         -- end (measured live on loop-su-50a96a51, 2026-08-18).
                         'armed_at', now()::text,
                         'fire_count_at_arm', COALESCE((metadata->>'fire_count')::int, 0)
                       ),
           updated_at = now()
     WHERE id = ${routineId} AND active = FALSE
    RETURNING workspace_id, install_slug, name, target_role, target_owner_id,
              reschedule_interval_sec,
              (metadata->>'loop_revived_count')::int AS revived_count,
              metadata->>'loop_revived_from_pause_reason' AS from_pause_reason
  `;

  // WI-37571 — the counterpart to the `disarmed` row, and the reason this pair matters more
  // than either event alone: without it, "the veto is working so nobody needs reviving" and
  // "the revival pass never ran" are the SAME observation (zero). Measured 2026-08-09, that
  // was not hypothetical — `loop_revived_at` was 0 rows workspace-wide with no way to tell
  // those apart, which is precisely WI-36792's lesson (a blunted reaper still reports
  // `checked: N`) arriving through the measurement instead of the reaper.
  //
  // `revivedCount` is the RATCHET this function documents as its flap bound. Emitting it per
  // event turns the bound into something observable over time — a loop revived twice and
  // re-disarmed twice is a distinct, diagnosable shape, and the mutable counter alone can
  // never show the sequence because a later disarm overwrites the reason beside it.
  //
  // Guarded `AND active = FALSE`, so a returned row always crossed FALSE -> TRUE; a no-op
  // against an already-running loop correctly logs nothing.
  const row = revived[0];
  if (row) {
    void recordLoopTransition(sql, {
      workspaceId: row.workspace_id,
      installSlug: row.install_slug,
      routineId,
      routineName: row.name,
      targetRole: row.target_role,
      targetOwnerId: row.target_owner_id,
      event: 'revived',
      actor: 'stalled-loops-guard-revival',
      // The revival schedules its rescue fire for now() — recorded as the fire time this
      // transition WROTE, matching the column's documented contract for a re-arm.
      newNextFireAt: new Date().toISOString(),
      intervalSec: row.reschedule_interval_sec,
      detail: {
        reason,
        revivedCount: row.revived_count,
        fromPauseReason: row.from_pause_reason,
      },
    });
  }
}

/**
 * Derive configured-vs-observed cadence from arm-relative timestamps.
 *
 * `firesSinceArm` is an attempted-fire count, not a delivery count. Dividing the
 * arm-to-last-fire span by that count therefore answers the same question as the
 * incident report: 15 fires over 7h47m reads as roughly a 31-minute effective
 * interval, rather than the configured 60 seconds. `longestObservedGapSec` is
 * already aggregated by the status query from event_wake_deliveries; this pure
 * function only normalizes it so missing history stays visibly unknown.
 */
export function computeLoopCadence(input: {
  intervalSec: number | null;
  armedAtMs: number | null;
  firesSinceArm: number;
  lastFiredAtMs: number | null;
  longestObservedGapSec?: number | null;
  nowMs?: number;
}): {
  expectedFiresSinceArm: number | null;
  effectiveIntervalSec: number | null;
  cadenceRatio: number | null;
  longestObservedGapSec: number | null;
} {
  const intervalSec = input.intervalSec;
  const armedAtMs = input.armedAtMs;
  const nowMs = input.nowMs ?? Date.now();
  const expectedFiresSinceArm =
    intervalSec != null &&
    Number.isFinite(intervalSec) &&
    intervalSec > 0 &&
    armedAtMs != null &&
    Number.isFinite(armedAtMs) &&
    Number.isFinite(nowMs) &&
    nowMs >= armedAtMs
      ? Math.max(0, Math.floor((nowMs - armedAtMs) / (intervalSec * 1000)))
      : null;

  const firesSinceArm = Number.isFinite(input.firesSinceArm) ? Math.max(0, input.firesSinceArm) : 0;
  const lastFiredAtMs = input.lastFiredAtMs;
  const elapsedSinceArmMs =
    armedAtMs != null &&
    Number.isFinite(armedAtMs) &&
    lastFiredAtMs != null &&
    Number.isFinite(lastFiredAtMs) &&
    lastFiredAtMs >= armedAtMs
      ? lastFiredAtMs - armedAtMs
      : null;
  const effectiveIntervalSec =
    elapsedSinceArmMs != null && firesSinceArm > 0 ? elapsedSinceArmMs / 1000 / firesSinceArm : null;
  const cadenceRatio =
    effectiveIntervalSec != null && intervalSec != null && Number.isFinite(intervalSec) && intervalSec > 0
      ? effectiveIntervalSec / intervalSec
      : null;
  const longestObservedGapSec =
    input.longestObservedGapSec != null &&
    Number.isFinite(Number(input.longestObservedGapSec)) &&
    Number(input.longestObservedGapSec) >= 0
      ? Number(input.longestObservedGapSec)
      : null;

  return { expectedFiresSinceArm, effectiveIntervalSec, cadenceRatio, longestObservedGapSec };
}

/**
 * Minimum arm-relative fires before a cadence observation can be called sustained. A single
 * slow turn is expected to inflate `cadenceRatio` because pure loops re-arm after the turn
 * settles; the advisory needs several observed fires before it says anything.
 */
export const CADENCE_DRIFT_MIN_FIRES = 3;

/** A four-times interval is a diagnostic hint, not an outage verdict. */
export const CADENCE_DRIFT_RATIO_THRESHOLD = 4;

/**
 * EI-20479187852053440 — how overdue the NEXT scheduled fire must be before slow observed
 * cadence counts as unexplained. Expressed in intervals so it scales with the loop's own
 * configuration; reuses the ratio threshold so "sustained" means the same thing in both gates.
 * Below this, an overdue fire is scheduling granularity (the completion-rebase observes the
 * turn settle on the 30s reconcile tick), not a wedged fire path.
 */
export const CADENCE_DRIFT_OVERDUE_INTERVALS = CADENCE_DRIFT_RATIO_THRESHOLD;

/**
 * Pure advisory verdict for a loop whose observed cadence is persistently slower than configured.
 *
 * This deliberately requires independent arm-relative opportunity, fire, and gap evidence. The
 * cadence ratio alone is observational and can be high during a legitimate long turn. The result
 * is consumed by the stalled-loop sweep only as an advisory signal: it must never disarm or re-arm
 * a loop, and it intentionally remains separate from `computeTurnsStalled`.
 *
 * ⚠ EI-20479187852053440 — THE RATIO ALONE CANNOT DECIDE THIS, AND NO THRESHOLD ON IT CAN.
 * `intervalSec` is a POST-SETTLE DELAY, not a period: the next fire is scheduled `intervalSec`
 * after the turn settles, so the true period is `turnDuration + intervalSec + up-to-30s` (see
 * LOOP_INTERVAL_FLOOR_SEC). `cadenceRatio` divides the observed period by `intervalSec` alone,
 * so it is > 1 by construction for every loop that does any work at all, and its magnitude is
 * dominated by turn duration — which the loop's design deliberately excludes from the interval.
 * Turn duration is unbounded by design, so no ratio threshold can separate "long turns" from
 * "wakes not going out". Filed live: an ACTIVE 60s cold monitor loop with a reachable wake
 * socket, `turnsStalled:false`, `consecutiveErrors:0` and current wake delivery read
 * `cadenceRatio:9.90` — and 21 workspace loops tripped the same advisory at once, which is a
 * mis-specified metric, not 21 independent outages.
 *
 * THE FIX: require positive evidence that the FIRE PATH is late, rather than inferring it from a
 * long period. The loop parks at `next_fire_at='infinity'` for the whole time a turn is in
 * flight, so `parked` marks time that is settling BY CONSTRUCTION, and once re-armed a healthy
 * scheduler keeps `nextFireAt` at or near the future. A fire that is due and has stayed
 * undelivered for several intervals is the wedged-fire-path case this advisory exists for.
 * Missing evidence FAILS QUIET — an advisory must never assert drift it cannot establish.
 */
export function computeCadenceDrift(input: {
  active: boolean;
  intervalSec: number | null;
  firesSinceArm: number;
  expectedFiresSinceArm: number | null;
  cadenceRatio: number | null;
  longestObservedGapSec: number | null;
  /** True while the turn is in flight — that elapsed time is settling, not lost cadence. */
  parked?: boolean;
  /** ISO of the next scheduled fire (null when parked/unset). Overdue-ness is the drift evidence. */
  nextFireAt?: string | null;
  nowMs?: number;
}): boolean {
  const intervalSec = input.intervalSec;
  if (!input.active || intervalSec == null || !Number.isFinite(intervalSec) || intervalSec <= 0) return false;

  const firesSinceArm = Number.isFinite(input.firesSinceArm) ? Math.max(0, input.firesSinceArm) : 0;
  if (firesSinceArm < CADENCE_DRIFT_MIN_FIRES) return false;

  const expected = input.expectedFiresSinceArm;
  const ratio = input.cadenceRatio;
  const longestGap = input.longestObservedGapSec;
  if (
    expected == null ||
    !Number.isFinite(expected) ||
    expected < CADENCE_DRIFT_MIN_FIRES ||
    expected - firesSinceArm < CADENCE_DRIFT_MIN_FIRES ||
    ratio == null ||
    !Number.isFinite(ratio) ||
    ratio < CADENCE_DRIFT_RATIO_THRESHOLD ||
    longestGap == null ||
    !Number.isFinite(longestGap) ||
    longestGap < intervalSec * CADENCE_DRIFT_RATIO_THRESHOLD
  ) {
    return false;
  }

  // The settling gate. A parked loop is mid-turn: every second of that elapsed span is the
  // deliberate settling the interval is defined relative to, so it can never be drift.
  if (input.parked === true) return false;

  // Not parked ⇒ the loop is armed and its fire is scheduled. Drift requires that fire to be
  // demonstrably late. An unreadable/absent nextFireAt leaves that unestablished — stay quiet.
  const nextFireAtMs = input.nextFireAt == null ? NaN : new Date(input.nextFireAt).getTime();
  if (!Number.isFinite(nextFireAtMs)) return false;

  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) return false;

  const overdueSec = (nowMs - nextFireAtMs) / 1000;
  return overdueSec >= intervalSec * CADENCE_DRIFT_OVERDUE_INTERVALS;
}

/**
 * Read an owner's loop status (NULL if none). A lean shape rather than the full
 * RoutineRow — and it correctly reads the parked sentinel: postgres-js parses
 * `next_fire_at='infinity'::timestamptz` to an invalid Date, so we detect parked
 * in SQL and never hand a NaN-Date out.
 */
function loopStatusFromRow(r: any, fallbackOwnerId: string): LoopStatus {
  const pt = r.payload_template ?? {};
  const costCap = pt?.costCapCents;
  const intervalSec = r.reschedule_interval_sec == null ? null : Number(r.reschedule_interval_sec);
  const parked = Boolean(r.parked);
  const parkedMs = r.parked_ms == null ? null : Number(r.parked_ms);
  const lastFiredMs = r.last_fired_at ? new Date(r.last_fired_at).getTime() : null;
  const completedMs = r.lifecycle_completed_at ? new Date(r.lifecycle_completed_at).getTime() : null;
  const presenceMs = r.presence_last_active_at ? new Date(r.presence_last_active_at).getTime() : null;
  const lastTurnMs = r.last_turn_at ? new Date(r.last_turn_at).getTime() : null;
  const lastLoopTurnMs = r.last_loop_turn_at ? new Date(r.last_loop_turn_at).getTime() : null;
  const armedAtMs = r.armed_at ? new Date(r.armed_at).getTime() : null;
  const fireCount = r.fire_count == null ? 0 : Number(r.fire_count);
  // WI-36070 — mirror checkLoopDeadMan's own derivation exactly (loop-dead-man.ts), including the
  // clamp at 0: a loop armed before the fire_count_at_arm stamp reads baseline 0, and a negative
  // delta must never be reported as headroom the guard did not grant.
  const firesSinceArm = Math.max(0, fireCount - (r.fire_count_at_arm == null ? 0 : Number(r.fire_count_at_arm)));
  const stall = computeLoopStall({
    parked,
    parkedMs,
    intervalSec,
    hasCompletionSinceFire: completedMs != null,
    lastFiredAtMs: lastFiredMs,
    lastActiveAtMs: presenceMs,
  });
  const nextFireAtIso = r.next_fire_at ? new Date(r.next_fire_at).toISOString() : null;
  const lifecycleBackoff = computeLifecycleBackoff({
    active: Boolean(r.active),
    lastDeliveryOutcome: r.last_delivery_outcome ?? null,
    nextFireAtIso,
  });
  // EI-224576: a provider usage/rate wall is an expected, self-healing pause, not a
  // turn-stalled loop. The actor that can disarm loops uses this same backoff signal
  // as a veto; keep loop:status consistent with that decision while the provider's
  // retry window is still in the future. Once it has elapsed, preserve the ordinary
  // turnsStalled verdict so a genuinely wedged retry is still visible.
  const providerBackoffActive = lifecycleBackoff?.resumesInMs != null && lifecycleBackoff.resumesInMs > 0;
  const turnsStalled = computeTurnsStalled({
    active: Boolean(r.active) && !providerBackoffActive,
    fireCount: firesSinceArm,
    lastFiredAtMs: lastFiredMs,
    lastTurnAtMs: lastTurnMs,
    lastLoopTurnAtMs: lastLoopTurnMs,
    lastActiveAtMs: presenceMs,
    intervalSec,
  });
  const cadence = computeLoopCadence({
    intervalSec,
    armedAtMs,
    firesSinceArm,
    lastFiredAtMs: lastFiredMs,
    longestObservedGapSec: r.longest_observed_gap_sec == null ? null : Number(r.longest_observed_gap_sec),
  });
  const cadenceDrift = computeCadenceDrift({
    active: Boolean(r.active),
    intervalSec,
    firesSinceArm,
    expectedFiresSinceArm: cadence.expectedFiresSinceArm,
    cadenceRatio: cadence.cadenceRatio,
    longestObservedGapSec: cadence.longestObservedGapSec,
    parked,
    nextFireAt: nextFireAtIso,
  });
  const fireStarved = computeLoopFireStarvation({
    active: Boolean(r.active),
    parked,
    firesSinceArm,
    expectedFiresSinceArm: cadence.expectedFiresSinceArm,
    armedAtMs,
    lastFiredAtMs: lastFiredMs,
    lastActiveAtMs: presenceMs,
    nextFireAtMs: nextFireAtIso == null ? null : Date.parse(nextFireAtIso),
    intervalSec,
  });
  // EI-22138154596110669: gate on the RAW jsonb marker before parsing — isLoopStanddownPause
  // never matches an ordinary per-loop pause, so this stays null for those.
  const rawPause = r.metadata?.pause ?? null;
  const standdownPause = isLoopStanddownPause(rawPause) ? readRoutinePause(rawPause) : null;
  const standdown = standdownPause
    ? {
        banner: loopStanddownBanner({ pause: standdownPause, nowMs: Date.now() })!,
        reason: standdownPause.reason,
        pausedBy: standdownPause.pausedBy,
        pausedAtMs: standdownPause.pausedAtMs,
        expiresAtMs: standdownPause.expiresAtMs,
      }
    : null;
  return {
    name: r.name,
    ownerId: r.target_owner_id ?? fallbackOwnerId,
    harnessSlug: r.install_slug,
    active: r.active,
    intervalSec,
    carry: pt?.carry === 'cold' ? 'cold' : 'warm',
    continuation: pt?.continuation === 'gated' ? 'gated' : 'settle',
    mode: pt?.mode === 'monitor' ? 'monitor' : 'work',
    // P-004: read through the SAME parser the settlement path uses, so status can never
    // report a policy the reconciler would reject (or miss one it would enforce).
    monitor: readPersistedMonitorConfig(pt),
    monitorStanddown: readMonitorStanddownRecord(r.metadata),
    standdown,
    // Absent (a loop armed before this field, or with no goal) reads as null — an
    // honest "not recorded", never an empty string that would render as a blank goal.
    goal: typeof pt?.goal === 'string' && pt.goal.trim() ? pt.goal.trim() : null,
    fireCount,
    firesSinceArm,
    parked,
    nextFireAt: nextFireAtIso,
    lastFiredAt: r.last_fired_at ? new Date(r.last_fired_at).toISOString() : null,
    armedAt: r.armed_at ? new Date(r.armed_at).toISOString() : null,
    ...cadence,
    cadenceDrift,
    costCapCents: typeof costCap === 'number' ? costCap : null,
    maxFires: typeof pt?.maxFires === 'number' ? pt.maxFires : null,
    maxDurationSec: typeof pt?.maxDurationSec === 'number' ? pt.maxDurationSec : null,
    // `computeLoopStall` covers a parked turn after a delivered fire; the
    // starvation signal covers an active loop whose current arm has delivered
    // no fire at all (parked with a turn in flight, or unparked with an overdue
    // concrete next fire). Keep the public field unified so callers do not need
    // to know which scheduler failure produced the verdict.
    stalled: stall.stalled || fireStarved,
    stalledSinceMs: stall.stalledSinceMs,
    fireStarved,
    lastDeliveryOutcome: r.last_delivery_outcome ?? null,
    consecutiveErrors: r.consecutive_errors == null ? 0 : Number(r.consecutive_errors),
    lastWithheldAt: r.last_withheld_at ? new Date(r.last_withheld_at).toISOString() : null,
    lastWakeChannel: r.last_wake_channel ?? null,
    lastWakeStatus: r.last_wake_status ?? null,
    lastWakeAt: r.last_wake_at ? new Date(r.last_wake_at).toISOString() : null,
    lastWakeError: r.last_wake_error ?? null,
    lastTurnAt: r.last_turn_at ? new Date(r.last_turn_at).toISOString() : null,
    lastLoopTurnAt: r.last_loop_turn_at ? new Date(r.last_loop_turn_at).toISOString() : null,
    lastRealTurnAt: r.last_real_turn_at ? new Date(r.last_real_turn_at).toISOString() : null,
    turnsStalled,
    parkedForSec: parked && parkedMs != null ? Math.max(0, Math.round(parkedMs / 1000)) : null,
    lifecycleBackoff,
  };
}

/**
 * Batch loop-status read for roster/watchdog callers. The former per-owner
 * `getLoopStatus` loop made a fleet monitor pay one PG round-trip per member;
 * this returns the latest routine per owner in one query while preserving the
 * exact status/stall derivation used by loop:status.
 */
export async function getLoopStatuses(
  ownerIds: readonly string[],
  opts: { sql?: Sql | TransactionSql } = {},
): Promise<Map<string, LoopStatus>> {
  const out = new Map<string, LoopStatus>();
  const owners = [...new Set(ownerIds.filter(Boolean))];
  if (owners.length === 0) return out;
  const sql = opts.sql ?? getOrgPg().sql;
  const read = (client: Sql | TransactionSql) => client<any[]>`
    SELECT DISTINCT ON (r.target_owner_id)
           r.install_slug,
           r.name,
           r.active,
           r.reschedule_interval_sec,
           r.target_owner_id,
           r.payload_template,
           -- P-004: the whole metadata object, so the monitor standdown record survives
           -- into loop:status. Selected rather than key-extracted because the record is a
           -- typed OBJECT (code/authorityCode/reason/atMs), not a scalar.
           r.metadata,
           COALESCE((r.metadata->>'fire_count')::int, 0)                  AS fire_count,
           -- WI-36070: the dead-man's baseline, stamped by stampLoopArmedAt on every arm/re-arm.
           -- Selected so loop:status can report firesSinceArm — the number maxFires is actually
           -- compared against. Without it the payload offers only the lifetime fire_count, and
           -- the one comparison a reader can form against an arm-relative bound is the wrong one.
           COALESCE((r.metadata->>'fire_count_at_arm')::int, 0)           AS fire_count_at_arm,
           r.last_fired_at,
           r.metadata->>'armed_at'                                       AS armed_at,
           (r.next_fire_at = 'infinity'::timestamptz)                    AS parked,
           CASE WHEN r.next_fire_at = 'infinity'::timestamptz THEN NULL
                ELSE r.next_fire_at END                                  AS next_fire_at,
           CASE WHEN r.last_fired_at IS NULL THEN NULL
                ELSE (EXTRACT(EPOCH FROM (now() - r.last_fired_at)) * 1000)::bigint END AS parked_ms,
           a.last_status         AS last_delivery_outcome,
           a.consecutive_errors  AS consecutive_errors,
           -- WI-36792: the fire-gate's own DENIAL stamp (EI-14483 wrote it; nothing has ever
           -- read it). Selected here because it is the ONLY signal that separates "the fire went
           -- out and reached nobody" from "the fire never went out" — see LoopStatus.lastWithheldAt.
           a.last_withheld_at    AS last_withheld_at,
           (SELECT max(ag.created_at) FROM harness_shared.agent_activity ag
             WHERE ag.owner_id = r.target_owner_id AND ag.kind = 'lifecycle'
               AND ag.summary = ${SESSION_END_MARKER} AND ag.created_at > r.last_fired_at) AS lifecycle_completed_at,
           -- EI-18712914572668391: the most recent turn-completion marker for this owner,
           -- UNSCOPED by the "> r.last_fired_at" filter (unlike lifecycle_completed_at above,
           -- which only answers "did THIS fire's turn settle yet"). This is what lets loop:status tell
           -- fires ATTEMPTED (fire_count, keeps climbing on a bare-interval re-arm even when
           -- delivery never becomes a real turn) apart from turns actually PRODUCED — an armed
           -- (not parked) loop has, by construction, already been judged "settled" for its most
           -- recent fire by the reconciler, so the parked-only stall check below can never see
           -- a loop that keeps getting re-armed on a WEAK completion signal (e.g. stale/false
           -- presence-quiescence) without ever producing a genuine turn-completion marker.
           --
           -- WI-6069: the ORIGINAL version of this read consulted ONLY the kind='lifecycle'
           -- 'ended' marker, on the (verified-false, see reconcile-loop-routines.ts's module
           -- header) premise that Claude Code's Stop hook writes it every turn -- in reality
           -- lifecycle-report.sh is wired only to SessionStart/SessionEnd, so that marker only
           -- ever lands at a genuine session restart, making lastTurnAt read as perpetually
           -- stale (and turnsStalled fire) for any healthy session driven entirely by push
           -- wakes. UNION in session_turn_journal so this reads the real most-recent turn
           -- regardless of which signal happened to land. MAX ignores NULLs, so either source
           -- being empty for this owner is harmless.
           --
           -- ⚠ EI-19316779460752535 — WI-6069's premise for that union, "P-012's per-CLI
           -- Stop-hook journal write DOES fire every ordinary turn", is FALSE and is repeated
           -- verbatim in reconcile-loop-routines.ts. The journal:record-turn tool writes a row
           -- only when the turn text carries an extractable note (no_note ⇒ no row): measured
           -- 2026-08-02 over 24h, 17 rows against 750 assistant turns for one owner (2.3%) and
           -- 746 rows / 61 owners fleet-wide, 100% flagged=true.
           --
           -- ⚠⚠ WI-6639 FOLLOW-UP — "this union still WORKS (the lifecycle leg carries it)" was
           -- ALSO FALSE, and this is not a hypothetical: it was caught live by turning
           -- computeTurnsStalled's consumer from read-only (loop:status) into an ACTOR
           -- (stalled-loops-guard.ts) and dry-running it against the real fleet. A continuously
           -- WARM loop (carry:'warm', never restarted — the common case, not the exception) never
           -- writes the lifecycle 'ended' marker at all, so for that (dominant) population the
           -- lifecycle leg contributes NOTHING and last_turn_at rested on the sparse 2.3% journal
           -- leg alone. Measured live 2026-08-02 on a demonstrably-active owner (dozens of real
           -- turns in the prior hour, confirmed via last_real_turn_at below): last_turn_at read
           -- 38m54s STALE relative to last_fired_at — enough to cross computeTurnsStalled's 30-min
           -- floor and flag a genuinely healthy, actively-working loop as turnsStalled:true. Had
           -- the dry-run not been run first, this would have auto-disarmed it.
           --
           -- THE FIX: add the SAME session_turns (assistant-turn) leg last_real_turn_at already
           -- carries below — full coverage (100% of real turns, not 2.3%), so last_turn_at can
           -- no longer go stale for any session that is genuinely producing turns. Do NOT reach
           -- for the journal alone as a standalone "a turn happened" signal — see last_real_turn_at
           -- below for the STRICT, journal+session_turns-only sibling this column still differs
           -- from (last_turn_at additionally carries the lifecycle 'ended' marker, which a strict
           -- "did a turn complete after instant X" caller must NOT see — that marker fires at
           -- session DEATH, after the fact, not at a turn's completion).
           (SELECT max(ts) FROM (
              SELECT ag.created_at AS ts FROM harness_shared.agent_activity ag
               WHERE ag.owner_id = r.target_owner_id AND ag.kind = 'lifecycle'
                 AND ag.summary = ${SESSION_END_MARKER}
              UNION ALL
              SELECT j.created_at AS ts FROM harness_shared.session_turn_journal j
               WHERE j.owner_id = r.target_owner_id
              UNION ALL
              SELECT st2.ts AS ts FROM harness_shared.session_turns st2
               WHERE st2.owner = r.target_owner_id
                 AND st2.speaker = 'assistant'
            ) last_turn_sources) AS last_turn_at,
           -- WI-6951: the STRICT turn-completion signal — the journal alone, WITHOUT the
           -- lifecycle session-end marker unioned in above. Kept as a separate column rather
           -- than narrowing last_turn_at, because the two answer different questions and the
           -- union is correct for its own consumer (computeTurnsStalled: "producing turns at
           -- all?", where the marker is a deliberate WI-6069 fallback against a stale read).
           -- A caller asking "did a turn complete after instant X?" must use THIS one: the
           -- marker means the session DIED, and a cold reset kills its predecessor, so it
           -- always postdates the final loop:checkpoint and reads as phantom post-note work.
           --
           -- EI-19316779460752535: the journal ALONE is not a usable "a turn happened" source —
           -- it is not a per-turn journal at all. The journal:record-turn tool (agent-tools/
           -- journal/record-turn.ts) writes a row ONLY when extractJournalFromAssistantText()
           -- finds an extractable note in the turn text; every other turn returns no_note and
           -- writes NOTHING. Measured 2026-08-02 over 24h: 17 journal rows against 750 ingested
           -- assistant turns for one owner (2.3%), and 746 rows / 61 owners fleet-wide, of which
           -- 746 (100%) are flagged=true. So a journal-only read is silent for ~98% of turns and
           -- its consumer (the cold-wake staleness hint, wake-executor.ts) degrades from WI-6951's
           -- false POSITIVE to a systematic false NEGATIVE. UNION in session_turns' assistant
           -- turns — the COMPLETE transcript-ingest source — which restores coverage WITHOUT
           -- reintroducing the WI-6951 bug: session_turns carries real assistant turns only and
           -- never the '■ session ended' lifecycle marker (that lives in agent_activity, which is
           -- exactly what stays excluded here). The ingest lags (p50 65s / p90 115s over 6h), and
           -- that lag can only make this read OLDER — i.e. it can only withhold the hint, never
           -- manufacture a phantom turn — so the failure direction stays the safe one.
           -- Index-backed both sides: session_turn_journal_owner_ts_idx (owner_id, created_at
           -- DESC) and session_turns_owner_ts_idx (owner, ts).
           (SELECT max(ts) FROM (
              SELECT j.created_at AS ts FROM harness_shared.session_turn_journal j
               WHERE j.owner_id = r.target_owner_id
              UNION ALL
              SELECT st3.ts AS ts FROM harness_shared.session_turns st3
               WHERE st3.owner = r.target_owner_id
                 AND st3.speaker = 'assistant'
            ) real_turn_sources)                                          AS last_real_turn_at,
           -- EI-21303383797798186: a manual owner prompt can produce arbitrarily many
           -- assistant rows while an armed loop delivers zero autonomous turns. Pair
           -- each authored loop-fire USER envelope with assistant output before the
           -- next user prompt; only that proves the loop wake became a real turn.
           -- The owner predicate uses session_turns_owner_ts_idx, while each bounded
           -- same-session range uses the table's (session/source/turn_idx/workspace)
           -- primary key. Restrict to the current arm to keep the correlated read lean.
           (SELECT max((
              SELECT max(a2.ts)
                FROM harness_shared.session_turns a2
               WHERE a2.workspace_id = u.workspace_id
                 AND a2.source_kind = u.source_kind
                 AND a2.session_id = u.session_id
                 AND a2.speaker = 'assistant'
                 AND a2.turn_idx > u.turn_idx
                 AND a2.turn_idx < COALESCE((
                       SELECT min(u2.turn_idx)
                         FROM harness_shared.session_turns u2
                        WHERE u2.workspace_id = u.workspace_id
                          AND u2.source_kind = u.source_kind
                          AND u2.session_id = u.session_id
                          AND u2.speaker = 'user'
                          AND u2.turn_idx > u.turn_idx
                     ), 2147483647)
            ))
              FROM harness_shared.session_turns u
             WHERE u.owner = r.target_owner_id
               AND u.speaker = 'user'
               AND u.turn_origin = 'loop-fire'
               AND u.ts >= COALESCE(
                     (r.metadata->>'armed_at')::timestamptz,
                     '-infinity'::timestamptz
                   ))                                                    AS last_loop_turn_at,
           -- EI-20217869515819188: compute the largest observed gap in this arm's
           -- wake-delivery history without fetching the whole event ledger into JS.
           -- COALESCE(delivered_at, created_at) matches lastWakeAt's existing
           -- semantics: a created-but-not-yet-delivered wake is still an observed
           -- delivery attempt, while a missing row remains distinguishable from a
           -- queued row. No LIMIT is used here; a capped history would make a
           -- round-number cap look like the true longest gap.
           (SELECT max(gap_sec) FROM (
              SELECT EXTRACT(EPOCH FROM (
                       observed_at - LAG(observed_at) OVER (ORDER BY observed_at)
                     )) AS gap_sec
                FROM (
                  SELECT COALESCE(w2.delivered_at, w2.created_at) AS observed_at
                    FROM harness_shared.event_wake_deliveries w2
                   WHERE w2.subscriber_id = r.target_owner_id
                     AND w2.source = 'loop:' || r.id
                     AND COALESCE(w2.delivered_at, w2.created_at) >=
                         COALESCE((r.metadata->>'armed_at')::timestamptz, '-infinity'::timestamptz)
                ) observed_wakes
           ) wake_gaps)                                                     AS longest_observed_gap_sec,
           (SELECT max(p.last_active_at) FROM harness_shared.coord_presence p
             WHERE p.owner_id = r.target_owner_id) AS presence_last_active_at,
           lw.channel                                                    AS last_wake_channel,
           lw.status                                                     AS last_wake_status,
           COALESCE(lw.delivered_at, lw.created_at)                      AS last_wake_at,
           lw.last_error                                                 AS last_wake_error
      FROM harness_shared.routines r
      LEFT JOIN harness_shared.autoloop_state a
        ON a.workspace_id = r.workspace_id AND a.harness_slug = r.install_slug AND a.role = r.name
      LEFT JOIN LATERAL (
        -- EI-16210: the most recent wake-delivery row for THIS routine's own wake channel.
        -- Filters on subscriber_id FIRST (idx_event_wake_deliveries_subscriber) so this stays
        -- an indexed lookup per owner even though 'source' itself carries no index.
        SELECT w.channel, w.status, w.last_error, w.created_at, w.delivered_at
          FROM harness_shared.event_wake_deliveries w
         WHERE w.subscriber_id = r.target_owner_id
           AND w.source = 'loop:' || r.id
         ORDER BY w.created_at DESC
         LIMIT 1
      ) lw ON true
     WHERE r.target_owner_id = ANY(${owners}::text[])
       AND r.reschedule_interval_sec IS NOT NULL
     ORDER BY r.target_owner_id, r.active DESC, r.updated_at DESC
    `;
  // requestSessionIdentityActivation opens the atomic outer transaction and
  // then reads the current loop while building the control anchor. Postgres.js
  // TransactionSql intentionally exposes savepoint, not begin; asking the
  // bounded read wrapper to open another transaction throws before this query.
  // Reuse an injected transaction directly. A top-level client still takes the
  // bounded READ ONLY path with its acquisition and statement deadlines.
  const rows = typeof (sql as Sql).begin === 'function'
    ? await boundedPgReadTxn<any[]>((tx) => read(tx), { client: sql as Sql })
    : await read(sql);
  for (const r of rows) {
    const ownerId = String(r.target_owner_id);
    out.set(ownerId, loopStatusFromRow(r, ownerId));
  }
  return out;
}

export async function getLoopStatus(
  ownerId: string,
  opts: { sql?: Sql | TransactionSql } = {},
): Promise<LoopStatus | null> {
  return (await getLoopStatuses([ownerId], opts)).get(ownerId) ?? null;
}

/**
 * EI-19984789589075138: whether the owner made any AGENT-authored tool call — i.e.
 * excluding the automatic hook/status set (AUTOMATIC_TOOL_NAMES, shared with
 * sessions:timeline's audit) — in (sinceMs, untilMs]. The cold-wake un-checkpointed-work
 * banner (su-cold-loop.ts's renderColdWakeInjection) sources its "a turn completed after
 * the note" signal from `lastRealTurnAt`, which unions in session_turns' assistant turns —
 * and a turn is a well-formed row there even when it is a usage-wall / withheld-fire bounce
 * that did zero work (the model emits refusal text, the turn ends). This is the STRICT
 * evidence check a caller runs before showing the alarm: a confirmed 0 downgrades it to a
 * bounced-fire notice instead of sending the successor on a reconciliation hunt for work
 * that never happened.
 *
 * EI-20543456503122446: the carry-note bookkeeping calls (CARRY_NOTE_BOOKKEEPING_TOOL_NAMES)
 * are excluded. The window OPENS at the note's `updated_at`, but a tool_invocations row is
 * stamped at INSERT — after the handler's write commits — so the loop:checkpoint that WROTE
 * the note lands strictly inside the window and counted itself. Any session that checkpointed
 * and then died scored >= 1 by construction, and one that never checkpointed has no note to be
 * stale against, so the `0` downgrade was unreachable in exactly the case it exists for.
 *
 * Returns `null` on any query failure — callers MUST treat null as "evidence unavailable"
 * and never read it as zero, or a transient query error would silently suppress a real
 * warning (the existing, safe default). Best-effort only: never let this delay or drop a
 * cold-wake delivery.
 *
 * WI-2143038 — the two callers ask DIFFERENT questions, and the difference is load-bearing:
 *
 *  'post-note-work' (default, the original caller): "did any work happen AFTER the carry
 *    note was written?" Its window opens at the note's `updated_at`, so the loop:checkpoint
 *    that wrote the note lands inside it and would count ITSELF — hence the bookkeeping
 *    exclusion documented above. MCP-ledger evidence is the right (and only) instrument,
 *    because the question is about a specific write ordering.
 *
 *  'fire-productivity' (WI-41228's R4 zero-tool escalation): "did this fire's turn do
 *    ANYTHING?" Its window opens at the FIRE, not the note, so the checkpoint cannot count
 *    itself and excluding it is simply wrong — writing a carry-note IS agent work, and for a
 *    disciplined watcher it is often the only MCP call of the wake. This scope therefore
 *    keeps the bookkeeping calls AND unions in the native-tool ledger.
 *
 * Reusing 'post-note-work' for the R4 question is what disarmed a healthy hourly wall-watcher
 * on 2026-09-02 (owner su-54215254): its wakes were a native Bash probe plus a loop:checkpoint
 * — invisible and excluded respectively — so it scored a structural 0 three times running and
 * was paused with pausedNextFireAt=infinity while doing exactly its job.
 */
export type AgentToolEvidenceScope = 'post-note-work' | 'fire-productivity';

export async function countAgentToolCallsInWindow(
  ownerId: string,
  sinceMs: number,
  untilMs: number,
  opts: { sql?: Sql; evidenceScope?: AgentToolEvidenceScope } = {},
): Promise<number | null> {
  const evidenceScope = opts.evidenceScope ?? 'post-note-work';
  const fireProductivity = evidenceScope === 'fire-productivity';
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    const agentToolPredicate = agentToolInvocationPredicate(sql);
    const [row] = await boundedPgReadTxn<Array<{ n: number }>>(
      async (tx) =>
        await tx<Array<{ n: number }>>`
          SELECT count(*)::int AS n
            FROM harness_shared.tool_invocations
           WHERE coord_owner_id = ${ownerId}
             AND invoked_at > ${new Date(sinceMs).toISOString()}::timestamptz
             AND invoked_at <= ${new Date(untilMs).toISOString()}::timestamptz
             AND (${fireProductivity}
                  OR tool_name <> ALL(${sql.array([...CARRY_NOTE_BOOKKEEPING_TOOL_NAMES])}::text[]))
             AND ${agentToolPredicate}
        `,
      { client: opts.sql },
    );
    const ledgerCount = row ? Number(row.n) : 0;

    // WI-2143038 second leg. harness_shared.tool_invocations records MCP calls ONLY — a
    // native Claude Code Bash/Read/Grep/Edit produces no row there at all (measured over 24h:
    // 54,009 native calls vs 35,479 MCP). A loop whose whole job is a shell probe therefore
    // scores 0 on the ledger while working perfectly. harness_shared.agent_activity is the
    // per-CLI hook ledger that DOES record native calls, and (measured on the su-54215254
    // disarm window) carries none of the hook-driven activity:report / coord:glance traffic
    // that floods tool_invocations — so it reads agent-authored work directly. Count `pre`
    // rows only: each call writes a pre/post pair.
    //
    // WI-10002086: this leg runs for BOTH scopes. It used to sit behind an
    // `if (!fireProductivity) return ledgerCount;` early return, which left the cold-wake
    // un-checkpointed-work detector — which uses the DEFAULT 'post-note-work' scope —
    // counting MCP calls only. An agent whose post-note work was entirely native
    // Bash/Read/Edit therefore scored a structural 0, and su-cold-loop.ts's
    // `confirmedNoWork` downgraded the loud warning to "the note above is CURRENT, no
    // recovery hunt needed" while that work was silently re-derived or lost. A FALSE
    // NEGATIVE in a safety signal is strictly worse than the false-positive direction,
    // which merely costs a verification. The `null`-on-failure contract is unchanged:
    // a failed query stays evidence-unavailable and must never be read as zero.
    const automaticCanonical = [
      ...AUTOMATIC_TOOL_NAMES,
      // Scope-dependent, mirroring leg 1's own `CARRY_NOTE_BOOKKEEPING_TOOL_NAMES`
      // exclusion above. 'post-note-work' asks whether work happened AFTER the note, so
      // the call that WROTE the note must not answer yes on its own behalf: its row is
      // stamped at INSERT, after the handler's write commits, so it lands just INSIDE the
      // window that opens at the note's updated_at (measured on this path: note
      // 18:20:06.840Z, its own loop:checkpoint row 18:20:07.136Z). Without this, widening
      // leg 2 would trade the false negative above for a false POSITIVE. 'fire-productivity'
      // deliberately keeps them — for a disciplined watcher the checkpoint is often the
      // only MCP call of the wake, and excluding it is what disarmed su-54215254.
      ...(fireProductivity ? [] : CARRY_NOTE_BOOKKEEPING_TOOL_NAMES),
    ];
    // Forward-map the canonical names to the CLI's `mcp__<server>__<verb>` tail form
    // (`coord:glance` → `coord_glance`). Forward is unambiguous; reversing is not, because
    // a canonical name like `work_items:checkpoint` already contains an underscore.
    const automaticCliTails = automaticCanonical.map((n) => n.replace(':', '_'));
    const [nativeRow] = await boundedPgReadTxn<Array<{ n: number }>>(
      async (tx) =>
        await tx<Array<{ n: number }>>`
          SELECT count(*)::int AS n
            FROM harness_shared.agent_activity
           WHERE kind = 'tool'
             AND phase = 'pre'
             AND owner_id = ${ownerId}
             AND workspace_id IN (${activeWorkspaceId()}, '*')
             AND created_at > ${new Date(sinceMs).toISOString()}::timestamptz
             AND created_at <= ${new Date(untilMs).toISOString()}::timestamptz
             AND tool_name <> ALL(${sql.array(automaticCanonical)}::text[])
             AND split_part(tool_name, '__', 3) <> ALL(${sql.array(automaticCliTails)}::text[])
        `,
      { client: opts.sql },
    );
    return Math.max(ledgerCount, nativeRow ? Number(nativeRow.n) : 0);
  } catch (e) {
    console.warn('[loop] countAgentToolCallsInWindow failed (evidence unavailable):', e as Error);
    return null;
  }
}

/**
 * The lean facts the arm-time overwrite guard (EI-18221784742583615) needs about the
 * loop a `loop:arm` upsert is ABOUT to replace: whether it is active, its interval, the
 * full kickoff (so the arming verb can compare the incoming goal against the loop's
 * current goal), its fireCount, carry/continuation/mode, and armedAt. Kept SEPARATE from
 * getLoopStatus so the roster/watchdog batch reads (getLoopStatuses) never have to carry
 * the potentially-multi-KB kickoff text. Returns null when the owner has no loop routine
 * at all. Reads the latest routine per owner (active first), mirroring materializeLoop's
 * own overwrite target.
 */
export interface PriorLoopFacts {
  active: boolean;
  intervalSec: number | null;
  /** The concrete harness namespace the existing routine is installed under. */
  harnessSlug: string | null;
  /** The stable work-item anchor previously bound to this loop, when present. */
  workItem?: string | null;
  /** The structurally persisted mission, when present on newer loop rows. */
  goal?: string | null;
  /** The current payload_template.kickoff — the arm-time goal comparison substrate. */
  kickoff: string;
  /** True only when a newer loop:arm persisted an explicit custom wakePrompt. */
  customWakePrompt?: boolean;
  fireCount: number;
  carry: 'warm' | 'cold';
  continuation: 'settle' | 'gated';
  mode: 'work' | 'monitor';
  /** Typed monitor policy on P-003+ rows; absent on legacy/work loops. */
  monitor?: PersistedMonitorConfig | null;
  /**
   * EI-21526226279199560: the blocker persisted on the row this arm is about to replace.
   * Read so a RE-ARM can carry its `since` forward — see `resolveBlockedSince`.
   */
  blockedOn?: LoopBlockedOnRecord | null;
  armedAt: string | null;
}

export async function readActiveLoopFacts(ownerId: string, opts: { sql?: Sql } = {}): Promise<PriorLoopFacts | null> {
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await boundedPgReadTxn<
    Array<{
      active: boolean;
      reschedule_interval_sec: number | null;
      install_slug: string | null;
      payload_template: Record<string, unknown> | null;
      fire_count: number | null;
      armed_at: string | null;
    }>
  >(
    (tx) => tx`
      SELECT r.active,
             r.reschedule_interval_sec,
             r.install_slug,
             r.payload_template,
             COALESCE((r.metadata->>'fire_count')::int, 0) AS fire_count,
             r.metadata->>'armed_at'                       AS armed_at
        FROM harness_shared.routines r
       WHERE r.target_owner_id = ${ownerId}
         AND r.reschedule_interval_sec IS NOT NULL
       ORDER BY r.active DESC, r.updated_at DESC
       LIMIT 1
    `,
    { client: opts.sql },
  );
  const r = rows[0];
  if (!r) return null;
  const pt = (r.payload_template ?? {}) as Record<string, unknown>;
  return {
    active: Boolean(r.active),
    intervalSec: r.reschedule_interval_sec == null ? null : Number(r.reschedule_interval_sec),
    harnessSlug: typeof r.install_slug === 'string' ? r.install_slug : null,
    workItem:
      typeof pt.workItem === 'string' && pt.workItem.trim() ? pt.workItem.trim().toUpperCase() : null,
    goal: typeof pt.goal === 'string' && pt.goal.trim() ? pt.goal.trim() : null,
    kickoff: typeof pt.kickoff === 'string' ? pt.kickoff : '',
    customWakePrompt: pt.customWakePrompt === true,
    fireCount: r.fire_count == null ? 0 : Number(r.fire_count),
    carry: pt.carry === 'cold' ? 'cold' : 'warm',
    blockedOn:
      pt.blockedOn && typeof pt.blockedOn === 'object'
        ? (pt.blockedOn as LoopBlockedOnRecord)
        : null,
    continuation: pt.continuation === 'gated' ? 'gated' : 'settle',
    mode: pt.mode === 'monitor' ? 'monitor' : 'work',
    monitor:
      pt.mode === 'monitor' && pt.monitor && typeof pt.monitor === 'object' && !Array.isArray(pt.monitor)
        ? (pt.monitor as PersistedMonitorConfig)
        : null,
    armedAt: r.armed_at ? new Date(r.armed_at).toISOString() : null,
  };
}

/**
 * kickoff-prompt-absorption-2026-07-17 P-001 — arm a fleet MEMBER's engine loop
 * SERVER-SIDE at boot, the moment its fleet membership registers, instead of
 * relying on the kickoff prompt's "you must self-arm" instruction (AUTO_MODE_
 * DIRECTIVE in bootstrap-su.ts) — a compliance domain text alone can't
 * guarantee. Persistence leaves the compliance domain and becomes a structural
 * boot-time effect.
 *
 * Scope, deliberately narrow:
 *   - MEMBER only, never the leader — a leader's arming is part of a more
 *     involved, explicitly-sequenced bring-up (e.g. DRAIN's canary-first
 *     leadership-then-arm order); auto-arming ahead of that could race it.
 *   - MISSION-bound — a plan supplies the historical plan goal; a planless
 *     member must resolve a real per-member/inherited fleet claim spec, and the
 *     goal names that scheduler lane. A fleet member whose sentinel is absent or
 *     invalid stays fail-closed instead of being armed onto the default backlog.
 *   - IDEMPOTENT — never clobbers an existing loop for this owner (self-armed,
 *     armed on a prior boot, or already retuned): a live active loop is left
 *     completely untouched, and an inactive predecessor's cadence/lifecycle/
 *     mission are carried into the recovery arm. An explicit `loop:arm` remains
 *     the path for a member that intentionally wants to retune.
 *   - Respects the same `papercusp-loops` feature gate `loop:arm` itself checks.
 *
 * Best-effort: any failure here must never fail the launch — the kickoff's
 * self-arm instruction is the fallback path exactly like today.
 */
export async function autoArmFleetMemberLoop(opts: {
  workspaceId: string;
  ownerId: string;
  harnessSlug: string;
  planSlug: string | null;
  fleetSlug: string;
  fleetRole: string | null;
  /** Explicit per-member carry from the launch command. When present it wins
   * over an inactive predecessor's stored carry; omitted launches preserve the
   * predecessor facts for recovery. */
  carry?: 'warm' | 'cold' | null;
  /** Test seam: an injected PG connection (createOrgTestDb().adminSql). When
   *  supplied, the live-singleton-only `armInboxWake` best-effort leg is SKIPPED
   *  (it has no `sql` override of its own and always targets the real org pool —
   *  calling it against a test DB would exercise/pollute live infra, not the
   *  isolated one under test). Omitted in production ⇒ today's live behaviour. */
  sql?: Sql;
}): Promise<{ armed: boolean; reason: string; loopName?: string }> {
  if (opts.fleetRole !== 'member') return { armed: false, reason: 'not-a-member' };
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([import('@papercusp/flags/server'), import('@papercusp/flags')]);
    if (!(await getFlag(FLAGS.LOOPS, 'system'))) {
      return { armed: false, reason: 'loops-disabled' };
    }
  } catch (e) {
    return { armed: false, reason: `flag-check-failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const existing = await getLoopStatus(opts.ownerId, { sql: opts.sql });
    if (existing?.active) return { armed: false, reason: 'already-armed', loopName: existing.name };

    let derivedGoal: string;
    if (opts.planSlug) {
      derivedGoal =
        `Drive plan \`${opts.planSlug}\` per your member role in fleet ` +
        `\`${opts.fleetSlug}\` (coord:orient to pull your lane).`;
    } else {
      // EI-21275400284931421: planless fleets are not missionless. Their durable
      // mission is the effective scheduler claim spec. Resolve it only after the
      // membership stamp has landed (bootstrap-su calls this at that boundary),
      // and reject the default/missing-sentinel path exactly as scheduler:get_next
      // does. This is what prevents a planless fleet from becoming loopless while
      // also preventing an auto-arm from widening it onto the generic backlog.
      const { getClaimSpecRecord } = await import('../../scheduler/claim-spec-store');
      const record = await getClaimSpecRecord(
        { cupId: opts.ownerId, workspaceId: opts.workspaceId },
        opts.sql as never,
      );
      if (record.source === 'default') {
        return {
          armed: false,
          reason: record.fleetSlug ? 'fleet-claim-spec-unresolved' : 'no-claim-spec-bound',
        };
      }
      const specId = record.spec.specId?.trim();
      if (!specId) return { armed: false, reason: 'claim-spec-missing-id' };
      derivedGoal =
        `Drive claim-spec lane \`${specId}\` in fleet \`${opts.fleetSlug}\` ` +
        `(scheduler:get_next in harness \`${opts.harnessSlug}\` pulls your lane).`;
    }

    // A boot/recovery path can see the owner's prior loop after loop:end or a
    // session teardown. Replacing that inactive row with the fleet default is a
    // silent retune: it discards an explicit fallback cadence (for example 1200s),
    // cold/gated lifecycle, monitor mode, and any blocker-aware kickoff. Read the
    // full payload only for this inactive recovery case; active loops returned
    // above remain completely untouched.
    let priorLoopFacts: PriorLoopFacts | null = null;
    if (existing && !existing.active) {
      try {
        priorLoopFacts = await readActiveLoopFacts(opts.ownerId, { sql: opts.sql });
      } catch (e) {
        // Best-effort recovery must still be able to arm with safe defaults when
        // the optional payload read is unavailable.
        console.warn(
          `[autoArmFleetMemberLoop] prior inactive loop read failed; using defaults: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    const intervalSec = existing?.intervalSec ?? priorLoopFacts?.intervalSec ?? LOOP_INTERVAL_FLOOR_SEC;
    const goal =
      priorLoopFacts?.goal ??
      existing?.goal ??
      derivedGoal;
    const carry = opts.carry ?? existing?.carry ?? priorLoopFacts?.carry ?? 'warm';
    const continuation = existing?.continuation ?? priorLoopFacts?.continuation ?? 'settle';
    const mode = existing?.mode ?? priorLoopFacts?.mode ?? 'work';
    const kickoff = buildLoopWakePrompt({
      ownerId: opts.ownerId,
      intervalSec,
      harness: opts.harnessSlug,
      goal,
      carry,
      continuation,
      mode,
    });
    const preservedKickoff = priorLoopFacts?.kickoff?.trim() || kickoff;
    const loop = await materializeLoop({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      ownerId: opts.ownerId,
      intervalSec,
      kickoff: preservedKickoff,
      // EI-20194544581627100: auto-arm derives the member mission above; persist
      // it structurally so loop:status and cold resets can recover the goal.
      goal,
      carry,
      continuation,
      mode,
      // The rescue reconciler can race an explicit member loop:arm. The explicit
      // arm wins; a stale system repair must never overwrite its newer mission or
      // cadence after the initial status read above.
      onlyIfInactive: true,
      ...(priorLoopFacts?.customWakePrompt === true ? { customWakePrompt: true } : {}),
      sql: opts.sql,
    });
    // Wake-reachability is INTRINSIC to arming a loop (mirrors loop:arm's own
    // tool-level step) — without this the routine exists but can't reach the
    // member as a fresh turn until its FIRST natural wake re-arms it. Best-effort:
    // the loop is already armed; a watch-arm hiccup must not fail the boot.
    // Skipped under an injected test `sql` — see the `sql` param doc above.
    if (!opts.sql) {
      try {
        const { armInboxWake } = await import('../../events/await/inbox-wake-arm');
        await armInboxWake({
          ownerId: opts.ownerId,
          workspaceId: opts.workspaceId,
          note: `auto-armed inbox-wake (${loop.name})`,
        });
      } catch (e) {
        console.warn(
          `[autoArmFleetMemberLoop] inbox-wake arm failed (loop still armed): ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return { armed: true, reason: 'armed', loopName: loop.name };
  } catch (e) {
    return { armed: false, reason: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
