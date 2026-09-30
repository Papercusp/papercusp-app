/**
 * Loop completion-rebase — re-arm an interval-loop routine N seconds AFTER the
 * woken turn it fired COMPLETES (loop-routines-interval-recurrence-2026-06-20 P-002 /
 * brief B-LOOP-2).
 *
 * A "loop" (B-LOOP-1, migration 323, owned by su-d5a84) is the third routine recurrence
 * kind: a routine carrying `reschedule_interval_sec` (+ `target_owner_id`, the warm coord
 * session it wakes) and NEITHER cron nor rrule. On each fire `claimDueRoutine` keeps a
 * PURE loop active and PARKS it at `next_fire_at = 'infinity'` (the in-flight sentinel —
 * the claim guard `next_fire_at <= now()` never matches infinity, so it is never
 * re-claimed while its turn runs). NOTHING re-arms it; this reconcile does: once the
 * woken turn SETTLES it sets `next_fire_at = completed_at + interval`, so the loop's true
 * period is (turn duration + interval) — the after-completion cadence that replaces
 * Claude /loop. A cron+loop (BOTH a cron and an interval) is recurrence, so claim
 * advances it to cron-next (never infinity); here we FOLD the loop re-arm in by taking
 * the sooner (d5a84's LEAST idiom — see the UPDATE below).
 *
 * ## The completion signal (the resolved spike — B-LOOP-2's open question)
 * A loop fire is a WARM `coord` wake (D-005) — it mints NO plan_run, so the signal is
 * NOT `plan_runs.finished_at`. It is re-sourced from the SESSION turn lifecycle.
 *
 * ⚠ EI-18712914572668391 / WI-6069 (2026-07-26): the paragraph below describing
 * `lifecycle-report.sh` as "wired to `Stop` (and `SessionEnd`)" was FALSE — verified live
 * against `~/.claude/settings.json`: `lifecycle-report.sh` is wired ONLY to `SessionStart`
 * + `SessionEnd`; the `Stop` hook slot runs `workitem-verify-nudge.sh` / `stop-turn-journal.sh`
 * / `ask-gate-mirror.sh` — none of which write the `kind='lifecycle'` marker. So the
 * `lifecycle_completed_at` signal below has in practice only ever fired at a genuine
 * SESSION RESTART, never at an ordinary turn boundary — exactly matching the live evidence
 * that drove this fix (8 start/end marker PAIRS in a day, not one per turn). A warm session
 * driven entirely by push wakes (events:await / a loop re-wake) never restarts, so for such
 * a session this ladder never got past layer 1 and (per the two caveats below) rarely got
 * past layer 2 either — its EFFECTIVE loop period silently became the layer-3 backstop
 * (≥30min) regardless of the configured interval, and the better-behaved (push-wake-only)
 * the agent, the worse this got. The fix: layer 1.5 below, `turn-journal`, consults
 * `session_turn_journal` instead/in addition — the Stop hook DOES fire `journal:record-turn`
 * on every turn (deterministic-context-carry-2026-07-14 P-012's `stop-turn-journal.sh`,
 * client-neutral across Claude/Codex/OMP), so that table's per-owner `created_at` actually is
 * the per-turn signal the paragraph below always claimed to have. The lifecycle marker is
 * left in place (still correct, still fires at a real session restart / for any client that
 * DOES wire Stop→lifecycle-report.sh) — this only adds the layer that makes the ladder work
 * for the common case where it doesn't restart.
 *
 * (Original paragraph, now describing the OTHER available signal rather than "the" signal:)
 * Claude Code's `SessionEnd` hook is wired to `lifecycle-report.sh`, which fires
 * `activity:report {kind:'lifecycle', summary:'■ session ended'}` into
 * `harness_shared.agent_activity`, keyed by `owner_id = PAPERCUSP_SID =` the loop's
 * `target_owner_id`, at a genuine session restart boundary. The most-recent such marker
 * AFTER `last_fired_at` is treated as a completion when present. This is immune to the
 * mid-turn quiet-gap a `coord_presence.last_active_at` quiescence read suffers from (a long
 * SILENT Bash leaves last_active_at stale mid-turn → a false "settled"). (EI-12979: this
 * used to match `summary ILIKE '%end%'` on the reasoning that kind='lifecycle' rows only
 * ever carry "▶ session started" / "■ session ended" — true today, but an unanchored
 * substring match on someone ELSE's assumption about what else might get written under
 * kind='lifecycle' is exactly the latent trap that bug describes. Now compares against
 * the shared SESSION_END_MARKER / SESSION_START_MARKER constants exactly, the same
 * ones report.ts's `lifecyclePhase` and presence-wakeability.ts's `fetchWakeability`
 * key off — one canonical marker, never re-derived per reader.)
 *
 * ## Robustness (now 4 layers, each cheap)
 *  1. PRIMARY-A — the lifecycle 'ended' marker (above) — fires at a genuine session
 *     restart. COLD loops (payload_template carry:'cold') use a DIFFERENT ladder entirely —
 *     see completionSignal: the settle is the turn's 'ended' AFTER the boundary 'started',
 *     OR the carry-note refresh (the protocol's own completion receipt); bare
 *     presence-quiescence is NOT a cold settle (a recycle's booted-but-idle session is quiet
 *     without having run its iteration — the 2026-07-03 stale-note-treadmill live finding,
 *     wakes #5033→#5036).
 *  1.5. PRIMARY-B ('turn-journal', WI-6069) — WARM loops only: the per-turn Stop-hook
 *     journal write (`session_turn_journal`, P-012) fires at the end of EVERY ordinary turn,
 *     restart or not, across every CLI — the actual "a turn just finished" signal 1's
 *     original doc claimed to have. Checked whenever 1 does not fire. Not applied to cold
 *     loops (they have their own two-signal ladder with a reset-boundary guard that this
 *     signal cannot participate in — it carries no 'started' counterpart to disambiguate).
 *  2. FALLBACK — 1/1.5 can both miss (the lifecycle report is a DETACHED, fail-open POST;
 *     the journal write can 'no_note'/miss its transcript on a bad turn). If neither marker
 *     exists after the fire but `coord_presence.last_active_at` advanced past last_fired_at
 *     AND has since gone quiet (≥ FALLBACK_QUIET_MS), the session did work then idled →
 *     rebase off last_active_at (recovers a dropped report).
 *  3. STUCK-PARK BACKSTOP — a loop parked far past the fire with NO post-fire signal at
 *     all (the wake was never delivered / the session died silently) is re-armed off
 *     `last_fired_at + interval` so the next fire RETRIES (and then flows through the
 *     fire-gate / cost-cap on the fire side, which can auto-pause a dead loop) — never
 *     wedge at infinity forever. WI-2714 adds a BOUNDED, EARLIER quick-retry leg ahead of
 *     this layer's own generous dwell (see quickRetryParkMs/quickRetryEligible below) —
 *     recover-then-escalate instead of dwell-then-recover-then-escalate — while leaving the
 *     dead-owner TERMINATION decision (checkUnreachableTerminalGuard) and its dwell/
 *     reachability veto completely untouched: quick-retry only ever attempts another wake,
 *     never a pause.
 *  4. ARMED-LOOP REACHABILITY SWEEP (EI-11407) — the guard above only ever ran on a PARKED
 *     row (or a cron+loop, scanned regardless of parked state). A PURE loop that settles
 *     once and re-arms to a real future `next_fire_at` leaves the scan entirely (the original
 *     WHERE matched only `next_fire_at = infinity` or a cron trigger) — so if its owner then
 *     disappears PERMANENTLY, nothing re-checks reachability until the loop actually fires
 *     again, goes back to parked-with-no-signal, and dwells through the classic stuck-park +
 *     circuit-open ladder — a ~12h+ round trip for a 1h-interval loop (live repro: EI-11407,
 *     an owner-abandoned loop still armed+scheduled at handoff required manual `loop:end`).
 *     The fix: scan EVERY active pure loop that has fired at least once (armed or parked),
 *     and for an ARMED row, measure dwell from the latest known-alive evidence (the fire
 *     itself, or any genuine presence activity after it) rather than from "currently parked".
 *     Once that dwell exceeds the same generous terminal window, consult the SAME
 *     `checkUnreachableTerminalGuard` — its own reachability veto (a live owner is NEVER
 *     terminated, regardless of dwell) is what actually protects a healthy long-interval
 *     loop; the window just avoids probing a freshly-armed one for no reason.
 *  5. LIFECYCLE-DEATH RECLASSIFICATION (EI-13818) — the 'lifecycle' completion signal (the
 *     Stop-hook 'ended' marker) means the woken turn RAN AND EXITED CLEANLY — it does NOT mean
 *     the turn succeeded. A provider rate-limit/session-limit/auth/context-overflow kill lands
 *     as an ORDINARY assistant turn ("You've hit your session limit · resets 5:40am") that the
 *     CLI completes normally: the Stop hook fires, `completionSignal` reads it as a healthy
 *     settle, and the circuit below was recording 'ok' for what was actually a dead wake — so a
 *     rate-limited loop kept re-firing at its bare interval into the SAME wall, forever, with
 *     the failure-streak fire-gate never tripping and nothing alerting (the observed incident:
 *     4 wakes in 10min, each 2-turn/0-tool-call, each dying on the identical session-limit
 *     text). The existing P0a/P0b/P1a machinery (classify → recordFire('error') → rate-limit-
 *     aware re-arm) already solves exactly this for the `resume-headless` detached-subprocess
 *     channel (resume-turn-outcome.ts); it never covered the live-inject / cold-spawn channel
 *     because there is no subprocess exit to observe there. This layer closes that gap for the
 *     lifecycle-signal path specifically: re-classify the completed turn's OWN text (reusing
 *     `classifySessionEnd`, the same text-pattern classifier session digests trust) and, on a
 *     kill signature, override the verdict to 'error' + a rate-limit-aware re-arm delay (reusing
 *     `parseUsageReset`) instead of the blind interval, and raise one loud advisory escalation
 *     so a human sees a loop is dying on a provider wall instead of discovering it via
 *     session-archaeology hours later. An armed loop
 *     has no discrete "failed fire attempt" streak to gate on (it isn't failing to fire — it
 *     just hasn't been checked), so the dwell window itself is this leg's blip protection and
 *     `stuckFireCount` is passed pre-satisfied.
 *  6. LIFECYCLE-DEATH RECLASSIFICATION ALSO COVERS presence-quiescence (EI-15722) — layer 5
 *     above was scoped ONLY to the 'lifecycle' via ("every other via has no turn text to
 *     check"), but that premise was false: `last_assistant_text_after_fire` is queried
 *     unconditionally, independent of via. A kill that loses its OWN Stop-hook 'ended' report
 *     (the layer-2 fallback's whole reason to exist — the report "CAN be lost") still bumps
 *     `presence.last_active_at` once via the dispatch that preceded the kill, so it settles via
 *     the presence-quiescence FALLBACK instead — which, unlike the lifecycle path, was recording
 *     an unconditional 'ok' with zero text inspection. Because the kill wall commonly outlives
 *     one bare-interval re-arm, this repeated every fire: 'ok' resets the failure-streak circuit
 *     each time, so it never opens and nothing ever escalates — a loop can sit firing on
 *     schedule for many hours (observed: 22h+) producing zero real agent turns while reporting
 *     healthy. Fix: run the SAME reclassification for via 'presence-quiescence' too.
 *
 * ## Invariants
 *  - IDEMPOTENT + NEVER-BACKWARDS (pure loop) — `created_at > last_fired_at` excludes an
 *    older late-settling turn (rebase only off the MOST-RECENT settled turn), and the
 *    UPDATE re-arms only a row still at 'infinity' (or strictly lowers a cron+loop), so a
 *    second pass within one fire cycle is a no-op and next_fire_at never regresses.
 *  - cron+loop COMPOSITION — `LEAST(next_fire_at, completed+interval)` is the SOONER of
 *    the standing cron-next and the loop re-arm (d5a84's tip). The WHERE clause guards it
 *    to only re-arm a parked pure loop OR strictly-lower a cron+loop, so it never raises a
 *    cron fire and is idempotent.
 *
 * Caveat (by design): settle is observed on the 30s tick, so the true period is
 * interval + up-to-30s — fine for the 60s /loop floor, not sub-minute.
 *
 * Wired as its OWN `loop-rebase-sweep` step in routinesTickImpl (routines-workflow.ts),
 * FIRST after the fire loop — NOT at the tail of reconcileAndGovern where it used to
 * ride (Task-#8, 2026-07-03: the 9 serial sweeps ahead of it starved under pool
 * pressure and armed loops sat parked ~17 min between 60s wakes).
 *
 * NB on parked-Date parsing: postgres-js parses `'infinity'::timestamptz` to an INVALID
 * JS Date (d5a84's frozen-seam note). This module never relies on the JS-parsed
 * `next_fire_at` for a parked row — "parked" is computed as a SQL boolean and every
 * infinity comparison is done in SQL — so the invalid-Date trap cannot bite here.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  recordFire as defaultRecordFire,
  readFireState as defaultReadFireState,
  circuitThreshold as defaultCircuitThreshold,
  evaluateFireGate as defaultEvaluateFireGate,
  LOOP_TERMINAL_AUTO_PAUSE_STATUS,
} from '../../autoloop';
import { runWithWorkspace } from '../../workspace-als';
import {
  checkUnreachableTerminalGuard as defaultCheckUnreachableTerminalGuard,
  terminalUnreachableMs,
  minStuckFiresForTermination,
  stuckBackstopCadenceMs,
} from './loop-unreachable-guard';
import { cancelInboxWake as defaultCancelInboxWake } from '../../events/await/inbox-wake-arm';
import {
  openEscalation,
  listEscalationsPaginated,
  resolveEscalation,
  type EscalationRecord,
} from '../../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { SESSION_END_MARKER, SESSION_START_MARKER } from '../../agent-tools/activity/lifecycle-markers';
import { classifySessionEnd, isMachineModelErrorText, type SessionEndReason } from '../../search/session-end-reason';
import {
  parseUsageReset,
  clampUsageRearmDelayMs,
  MODEL_CAPACITY_RE,
  MODEL_CAPACITY_RETRY_AFTER_MS,
} from '@papercusp/papercusp-shared/agent';
import { recordLoopTransition } from './loop-transition-log';
import { countAgentToolCallsInWindow as defaultCountAgentToolCallsInWindow } from './loop';
import { autoPauseLoopRoutine as defaultAutoPauseLoopRoutine } from './loop-cost-cap';
import {
  recordZeroToolFireObservation as defaultRecordZeroToolFireObservation,
  zeroToolEscalationThreshold,
} from './loop-zero-tool-escalation';
import {
  decideMonitorSettlement,
  monitorDeltaObservedForFire,
  persistMonitorNoDeltaBudget,
  readPersistedMonitorConfig,
  recheckMonitorAuthority as defaultRecheckMonitorAuthority,
  standDownMonitorLoop,
} from './monitor-standdown';

/**
 * Coerce a `timestamptz` column to epoch ms, tolerating BOTH shapes it can arrive in:
 * a `Date` (a type-parsing connection — what the testcontainer integration tests use) OR a
 * STRING. The operator's pooled `getOrgPg()` connection runs `prepare: false`, which skips
 * postgres-js's per-column type-OID resolution, so a `timestamptz` comes back as the raw PG
 * string (`"2026-06-21 16:30:03.587133-04"`) — NOT a Date. Calling `.getTime()` on that threw
 * `getTime is not a function` on the FIRST row of every pass, which propagated out and
 * SILENTLY ABORTED the whole reconcile (caught by reconcileAndGovern's best-effort try) — so
 * every loop fleet-wide parked at infinity and was never re-armed after one fire (EI-2549).
 * The integration tests used a direct, type-parsing connection, so they never hit this — a
 * real test gap, now closed by `…string-typed timestamptz columns…`. `new Date(pgString)`
 * round-trips the PG format correctly. Returns null for null/undefined or an unparseable value.
 */
function tsMs(v: Date | string | null | undefined): number | null {
  if (v == null) return null;
  const ms = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Keep every completion-rebase on a future schedule. A delayed reconcile pass can observe a
 * valid completion marker whose `completed_at + interval` is already past; persisting that
 * candidate leaves an active loop due immediately and can make cadence status report a stale
 * next fire while the next routine tick is absent or delayed. Preserve the completion-relative
 * cadence when it is still future, otherwise give the loop a full interval from this pass's
 * clock instead of writing another expired timestamp.
 */
function futureRearmAtMs(completedAtMs: number, rearmMs: number, nowMs: number, intervalMs: number): number {
  const requestedAtMs = completedAtMs + rearmMs;
  return Number.isFinite(requestedAtMs) && requestedAtMs > nowMs ? requestedAtMs : nowMs + intervalMs;
}

/** A dropped lifecycle report is inferred only once the session's last GENUINE activity
 *  (coord_presence.last_active_at — NOT the keepalive heartbeat_at) has been quiet for at
 *  least this long, so we never mistake a mid-turn pause for a settle. */
const FALLBACK_QUIET_MS = 60_000;

/** Floor for the stuck-park backstop: a loop parked at least this long past its fire with
 *  NO post-fire activity is treated as a never-delivered/dead fire and re-armed to retry.
 *  Generous so a legitimately long turn (which keeps producing activity) is never
 *  force-rearmed. Per-loop the effective bound is max(30min, 4×interval).
 *
 *  WI-6660: the definition now LIVES in loop-unreachable-guard.ts and is delegated to here, so
 *  the comatose window's arithmetic (which converts a wall-clock budget into a fire count) reads
 *  the SAME cadence that actually feeds the streak. Two copies of `max(30min, interval*4)` is
 *  exactly the drift that let one fixed count of 24 mean "12h" in one place and "88h" in another. */
const stuckParkMs = stuckBackstopCadenceMs;

/**
 * QUICK-RETRY leg (WI-2714 — "recover-then-escalate, not escalate-only"). The classic
 * stuck-park backstop above only attempts its first re-fire after a generous ~30min dwell
 * (right, for the TERMINATION decision — a legitimately long turn must never be mistaken for
 * a dead owner) but that same generous dwell was also gating the RETRY itself, so a member
 * whose turn wedged on something recoverable (e.g. a stale `events:await` the wake-executor's
 * inject channel can actually unstick) sat fully idle for the whole window, and 3 separate
 * live incidents needed a leader to manually `coord:wake` it faster than the backstop would
 * have on its own (throughput loss + leader toil + noisy human escalation).
 *
 * The fix decouples "safe to ATTEMPT another wake" from "safe to conclude the owner is dead":
 * termination (checkUnreachableTerminalGuard) keeps its full dwell + reachability veto
 * UNCHANGED below — this only adds an EARLIER, BOUNDED opportunity to retry the exact same
 * re-arm-and-refire the classic path already performs, for the SAME quiet-parked candidates
 * (`looksDeadOrStuck`, i.e. zero presence activity since the fire — a genuinely busy turn is
 * never touched by either leg). Bounded by `quickRetryMaxAttempts()` consecutive errors so a
 * truly-dead owner falls through to the classic (slower, dwell-gated) path — and from there,
 * unchanged, to the reachability-vetoed terminal guard — rather than quick-retrying forever.
 */
const DEFAULT_QUICK_RETRY_PARK_MS = 10 * 60_000; // 10min — comfortably past a normal build/test/install tool call
const DEFAULT_QUICK_RETRY_MAX_ATTEMPTS = 3;

/** EI-21549554609576994: claimDueRoutine parks a pure loop and stamps
 * routines.last_fired_at BEFORE the loop action begins. If neither fireLoopWake's
 * fire-state writer nor the routine-scoped wake ledger advances, the claim died in
 * that handoff and there is no legitimate turn to wait for. Give the dispatch path
 * two configured intervals to start, bounded to 1–5 minutes so a short loop is not
 * dead for the generic 10–30 minute turn-health ladders and a long loop does not
 * inherit an hours-long dispatch grace. */
const CLAIM_DISPATCH_GRACE_MIN_MS = 60_000;
const CLAIM_DISPATCH_GRACE_MAX_MS = 5 * 60_000;

function claimDispatchGraceMs(intervalMs: number): number {
  return Math.min(Math.max(intervalMs * 2, CLAIM_DISPATCH_GRACE_MIN_MS), CLAIM_DISPATCH_GRACE_MAX_MS);
}

/** Floor for the quick-retry leg: env-overridable, floored at 3× the loop's own interval (same
 *  "give a short-interval loop several real cycles first" idiom as `stuckParkMs`'s 4×, one less
 *  since this is the SHORTER, earlier-firing leg). */
function quickRetryParkMs(intervalMs: number): number {
  const env = Number(process.env.PAPERCUSP_LOOP_QUICK_RETRY_MS);
  const base = Number.isFinite(env) && env > 0 ? env : DEFAULT_QUICK_RETRY_PARK_MS;
  return Math.max(base, intervalMs * 3);
}

/** How many consecutive quick-retry attempts before falling back to the classic (dwell-gated)
 *  stuck-park path. Env-overridable; <=0 disables the quick-retry leg entirely (fail-soft to
 *  today's behavior — the classic path is untouched either way). */
function quickRetryMaxAttempts(): number {
  const env = Number(process.env.PAPERCUSP_LOOP_QUICK_RETRY_MAX_ATTEMPTS);
  return Number.isFinite(env) ? env : DEFAULT_QUICK_RETRY_MAX_ATTEMPTS;
}

/** WI-2339 (fix E) — the synthetic system principal the loud dead-loop escalation is attributed
 *  to, mirroring INFRA_LIVENESS_IDENTITY. Attributable + dedupable in the human inbox. */
export const LOOP_DEATH_WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'system:loop-death-watchdog',
  ownerLabel: 'system · loop-death-watchdog',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** EI-19408412473830336: the `meta.subjectSignature` PREFIX for a loop-death escalation —
 *  shared between the opener (`defaultEscalateDeadLoop`) and the auto-resolve reader
 *  (`reconcileDeadLoopEscalations`/`parseLoopWatchdogSignature`) so they can never drift. */
export const LOOP_DEATH_SIGNATURE_PREFIX = 'loop-death';

/** Diagnostics passed to the dead-loop escalation seam. */
export interface DeadLoopInfo {
  routineId: string;
  targetOwnerId: string;
  installSlug: string;
  name: string;
  reason: string;
}

/**
 * Default loud human escalation for a durably-dead loop (WI-2339 fix E = pause+escalate, NOT
 * auto-respawn — owner policy). Advisory severity: the watchdog has ALREADY paused the loop, so
 * the human just needs to know it happened + decide whether to relaunch. `harness_slug` federates
 * the escalation to the owning harness's human inbox (WI-1375). May throw if the coord context is
 * unavailable in this worker — the CALLER swallows it (worst case: no escalation, never a crashed
 * tick), so this stays a plain await.
 */
async function defaultEscalateDeadLoop(info: DeadLoopInfo): Promise<void> {
  await openEscalation(LOOP_DEATH_WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: `Loop '${info.name}' auto-paused — owner session ${info.targetOwnerId} is durably dead (wakes stopped landing).`,
    body:
      `The loop death/respawn watchdog (WI-2339) confirmed loop '${info.name}' ` +
      `(routine ${info.routineId}, harness ${info.installSlug}, owner ${info.targetOwnerId}) can no longer be ` +
      `reached as a fresh turn, and AUTO-PAUSED it (active=false) instead of re-firing into a dead session forever.\n\n` +
      `Reason: ${info.reason}\n\n` +
      `This is inform-only: the watchdog does NOT auto-respawn (owner policy). To resume the work, ` +
      `relaunch the owner session and re-arm the loop (loop:arm), or reclaim its work-items.`,
    harness_slug: info.installSlug,
    // EI-19408412473830336: stamp a stable, PARSEABLE conditionKey (mirrors
    // defaultEscalateLifecycleDeath's own `meta.subjectSignature` below) so
    // `reconcileDeadLoopEscalations` can recover `routineId` from the escalation
    // record without depending on prose. Also strengthens dedup: without this the
    // fallback key is derived from `summary`, which is stable here too (no volatile
    // duration embedded) but an explicit key is strictly more robust than relying on
    // that.
    meta: { subjectSignature: `${LOOP_DEATH_SIGNATURE_PREFIX}:${info.installSlug}:${info.routineId}` },
  });
}

/* The re-arm ceiling used to live here as a private 6h constant, duplicated in
 * loop-turn-outcome.ts with a comment asking the two to be kept in step. EI-20544023385610622
 * made the policy TWO-TIER (a NAMED reset instant earns a longer hold than an INFERRED one), and
 * a two-tier policy duplicated twice is drift waiting to happen — so both now import the single
 * `clampUsageRearmDelayMs` from the shared agent lib, beside the precision it consults. */

/** Reasons a `classifySessionEnd` verdict on a LIFECYCLE-COMPLETED loop turn's own text means
 *  the 'ended' marker was a KILL, not a success (EI-13818 — see module header point 5). */
const LOOP_LIFECYCLE_DEATH_REASONS: ReadonlySet<SessionEndReason> = new Set<SessionEndReason>([
  'auth_wall',
  'usage_limit',
  'model_error',
  'context_limit',
]);

export interface LoopLifecycleDeathVerdict {
  reason: SessionEndReason;
  evidence: string | null;
  /** ms from `now` to re-arm at, instead of the blind interval — reset-aware for usage_limit
   *  (parsed from the turn's own "resets 5:40am" text), else the plain interval (the fire-gate's
   *  own exponential backoff, now correctly fed by the 'error' this verdict causes, owns further
   *  escalation for a repeat). */
  rearmDelayMs: number;
}

/**
 * Re-classify a completed loop turn's OWN text for a provider-kill signature a clean 'ended'
 * lifecycle marker cannot distinguish from a real success (EI-13818). Pure + reuses the
 * existing text-pattern classifier (`classifySessionEnd`) and reset-time parser
 * (`parseUsageReset`) rather than inventing a second taxonomy. Returns null when the text is
 * a genuine settle (or absent — a read miss must never manufacture a false death).
 */
export function classifyLoopLifecycleTurn(
  text: string | null | undefined,
  intervalMs: number,
  nowMs: number,
): LoopLifecycleDeathVerdict | null {
  if (!text || !text.trim()) return null;
  const cls = classifySessionEnd({ lastAssistantText: text, lastTsMs: nowMs, nowMs, activeWithinMs: 0 });
  if (!LOOP_LIFECYCLE_DEATH_REASONS.has(cls.reason)) return null;
  // EI-22102700164999066: this scan is BLIND. `last_assistant_text_after_fire` is the turn's own
  // prose, NOT a known-dead session's tail, so it carries the same precision requirement that
  // makes `classifyWedgeText` drop `model_error` outright. Its loose half (`rate.?limit` / `429`)
  // collides with ordinary dev conversation, so a loop turn that merely ENDED BY DISCUSSING a
  // 429 was recorded as a dead wake — recordFire('error'), fire-gate backoff and a spurious
  // death escalation against a perfectly healthy loop. Dropping the reason entirely would
  // re-open the bug this leg exists for, so require only the MACHINE-emitted half: a real
  // `API Error: Request rejected (429) …` death still matches it.
  if (cls.reason === 'model_error' && !isMachineModelErrorText(text)) return null;
  let rearmDelayMs = intervalMs;
  if (cls.reason === 'usage_limit') {
    const reset = parseUsageReset(text, nowMs);
    if (reset != null && reset.atMs > nowMs) {
      // The ceiling follows the parse's PRECISION: a date-qualified weekly wall ("resets Aug 20,
      // 7am") is held in full, while a bare-clock guess keeps the tight 6h rail.
      rearmDelayMs = clampUsageRearmDelayMs(reset.atMs - nowMs, intervalMs, reset.precision);
    }
  }
  // A model-CAPACITY wall is the one `model_error` shape with a known, short clearing time: the
  // provider is shedding load on this model and the shared taxonomy already fixes that window at
  // MODEL_CAPACITY_RETRY_AFTER_MS. Re-arming on the blind interval would let a loop tighter than
  // that window spend its next wake walking straight back into the same wall — so FLOOR the delay
  // at the provider's retry window. `Math.max` on purpose: a loop that already waits longer keeps
  // its own slower cadence, because this is a minimum-wait rail, not a new schedule.
  if (cls.reason === 'model_error' && MODEL_CAPACITY_RE.test(text)) {
    rearmDelayMs = Math.max(rearmDelayMs, MODEL_CAPACITY_RETRY_AFTER_MS);
  }
  return { reason: cls.reason, evidence: cls.evidence, rearmDelayMs };
}

/** WI-2339-style advisory identity for the lifecycle-death alert — distinct from
 *  LOOP_DEATH_WATCHDOG_IDENTITY (that one means "owner is unreachable, loop paused"; this one
 *  means "owner is alive and reachable, but its wakes are dying on a provider wall"). */
export const LOOP_LIFECYCLE_DEATH_WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'system:loop-lifecycle-death-watchdog',
  ownerLabel: 'system · loop-lifecycle-death-watchdog',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** EI-19408412473830336: shares the `LOOP_DEATH_SIGNATURE_PREFIX` naming convention — see
 *  that constant's doc comment. Kept as its own constant (rather than reusing the string
 *  literal already embedded below in `defaultEscalateLifecycleDeath`, EI-18668025239634541)
 *  so the opener and the auto-resolve reader can never drift on the prefix. */
export const LOOP_LIFECYCLE_DEATH_SIGNATURE_PREFIX = 'loop-lifecycle-death';

/** Diagnostics passed to the lifecycle-death escalation seam. */
export interface LifecycleDeathInfo {
  routineId: string;
  targetOwnerId: string;
  installSlug: string;
  name: string;
  verdict: LoopLifecycleDeathVerdict;
}

/**
 * Loud (but non-terminating) human escalation for a loop whose completed turn was actually a
 * provider kill (EI-13818, ask (c)): the loop is NOT paused (it re-arms at `verdict.rearmDelayMs`
 * and will retry on its own), but a human should see it rather than discover it via
 * session-archaeology. Advisory severity; may throw if the coord context is unavailable — the
 * caller swallows it (a lost escalation must never abort the reconcile pass).
 *
 * Exported (not just used as the `opts.escalateLifecycleDeath` default) so
 * EI-18668025239634541's recurrence guard can call it directly and assert on
 * the `conditionKey` (meta.subjectSignature) it passes to `openEscalation` —
 * the exact thing that was missing and caused the leak.
 */
export async function defaultEscalateLifecycleDeath(info: LifecycleDeathInfo): Promise<void> {
  const mins = Math.round(info.verdict.rearmDelayMs / 60_000);
  await openEscalation(LOOP_LIFECYCLE_DEATH_WATCHDOG_IDENTITY, {
    severity: 'advisory',
    // EI-18668025239634541: this call used to omit a conditionKey entirely, so
    // dedup fell back to the prose SUMMARY — which embedded `~${mins}m`, a value
    // that backs off between occurrences and therefore never repeats even for
    // the SAME loop. Every reconcile pass over a loop stuck on a provider wall
    // then leaked a fresh permanently-open escalation row (10 rows / 2.5h
    // measured, 1.0x coalescing) instead of bumping repeatCount on one row.
    // `meta.subjectSignature` is the stable conditionKey convention every other
    // recurring watchdog in this codebase uses (see coordination/escalations.ts
    // escalationDedupIdentity + coordination/tools/escalate.ts) — key it on the
    // loop identity alone (installSlug + routineId), which does NOT vary across
    // occurrences of the same underlying condition.
    meta: { subjectSignature: `${LOOP_LIFECYCLE_DEATH_SIGNATURE_PREFIX}:${info.installSlug}:${info.routineId}` },
    // Defense in depth (belt-and-suspenders with the conditionKey above): the
    // volatile `~${mins}m` duration used to live here and nowhere else — if a
    // future refactor ever drops the conditionKey again, the summary-derived
    // dedup fallback should still coalesce instead of repeating this exact leak.
    // The duration detail is preserved in `body` below, which isn't part of the
    // dedup signature.
    summary: `Loop '${info.name}' wake died on a provider '${info.verdict.reason}' — re-arming instead of the bare interval.`,
    body:
      `The loop-lifecycle-death watchdog (EI-13818) found that loop '${info.name}' (routine ${info.routineId}, ` +
      `harness ${info.installSlug}, owner ${info.targetOwnerId})'s most recently woken turn completed CLEANLY ` +
      `(the Stop hook fired normally) but its own text was a provider kill signature, not real work:\n\n` +
      `${info.verdict.evidence ?? '(no evidence captured)'}\n\n` +
      `Without this check the loop would have recorded a false 'ok' and kept re-firing at its bare interval into ` +
      `the same wall. Instead this fire was recorded as an 'error' (feeding the existing failure-streak circuit) ` +
      `and the loop is re-armed ~${mins}m out instead of immediately. This is inform-only — no action needed unless ` +
      `the reason recurs after the re-arm.`,
    harness_slug: info.installSlug,
  });
}

// ── EI-19408412473830336: auto-resolve leg for the two loop watchdogs ──────────────
//
// Both `defaultEscalateDeadLoop` and `defaultEscalateLifecycleDeath` above open an
// escalation and then NEVER resolve one — the module imported only `openEscalation`,
// no `listEscalationsPaginated`/`resolveEscalation`, so their escalations are
// structurally immortal (measured 2026-08-03: 48 open rows between the two, the 2nd
// and 3rd largest holders in the whole open-escalation set). Mirrors the pattern the
// sibling infra-liveness alarm already uses (liveness-alarm.ts EI-2146, now
// author-scoped per EI-19403159016550818): each tick, read THIS watchdog's OWN open
// escalations via `listEscalationsPaginated({ status:'open', from: <identity>.ownerId })`
// — the `from` scoping is what makes the read COMPLETE regardless of workspace-wide
// escalation-backlog size, the exact trap EI-19403159016550818 fixed for the sibling
// alarm — and auto-resolve any whose underlying condition no longer holds.
//
// The two identities mean different things (per the comment on
// LOOP_LIFECYCLE_DEATH_WATCHDOG_IDENTITY below) so they get two different recovery
// predicates, not one shared one:
//   - LOOP_DEATH means "owner unreachable, loop auto-paused (active=false)". Recovered
//     when the routine is ACTIVE again (a human relaunched the owner + re-armed the
//     loop) or the routine row no longer exists (deleted) — in either case "durably
//     dead, auto-paused" no longer describes the current state. A routine still paused
//     exactly as the watchdog left it stays open — that IS the correct informational
//     state, waiting on a human.
//   - LOOP_LIFECYCLE_DEATH means "owner reachable, but its wakes keep dying on a
//     provider wall" — advisory, the loop is NOT paused and keeps retrying on its own.
//     Recovered when a LATER fire recorded 'ok' (autoloop_state.consecutive_errors is
//     back to 0 — recordFire('ok') is the only thing that resets it, see autoloop.ts),
//     when the routine was SUBSEQUENTLY auto-paused by the loop-death watchdog (its
//     stronger blocker-equivalent escalation supersedes this advisory), or when the
//     routine row no longer exists.

/** Both watchdogs stamp `meta.subjectSignature` on the escalations they open, in the
 *  form `<prefix>:<installSlug>:<routineId>` — read back from the persisted TOP-LEVEL
 *  `subjectSignature` field `openEscalation` writes (coordination/escalations.ts). */
function escalationSubjectSignature(rec: EscalationRecord): string | null {
  const v = (rec as Record<string, unknown>).subjectSignature;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Parse a `<prefix>:<installSlug>:<routineId>` subjectSignature back into its parts.
 *  `routineId` is taken as the FINAL colon-delimited segment (routine ids are UUIDs and
 *  never contain a colon); everything between the prefix and it is `installSlug`. Returns
 *  null for a signature that doesn't carry this watchdog's prefix, or is malformed. */
export function parseLoopWatchdogSignature(
  sig: string,
  prefix: string,
): { installSlug: string; routineId: string } | null {
  if (!sig.startsWith(`${prefix}:`)) return null;
  const rest = sig.slice(prefix.length + 1);
  const idx = rest.lastIndexOf(':');
  if (idx <= 0 || idx >= rest.length - 1) return null;
  return { installSlug: rest.slice(0, idx), routineId: rest.slice(idx + 1) };
}

export interface WatchdogEscalationReconcileResult {
  /** Open escalations for this watchdog identity read this pass. */
  scanned: number;
  /** Resolved this pass because their condition no longer holds. */
  resolved: number;
  /** Left open — either still-live, or a resolve attempt didn't transition (raced /
   *  already resolved elsewhere / not found). */
  stillOpen: number;
  /** Carried no parseable `subjectSignature` (pre-fix legacy row, or a caller's meta
   *  malformed) — left untouched rather than guessed at. */
  unparseable: number;
}

/**
 * Auto-resolve leg for LOOP_DEATH_WATCHDOG_IDENTITY escalations. See the module-header
 * note above this function for the recovery predicate. Fail-soft throughout — a read or
 * resolve failure leaves the affected rows open (never silently drops one), and this must
 * never throw out of the caller's tick.
 */
export async function reconcileDeadLoopEscalations(
  opts: {
    sql?: Sql;
    /** Injected for tests; defaults to a `from`-scoped open-escalation read for this identity. */
    listOpen?: () => Promise<EscalationRecord[]>;
    /** Injected for tests; defaults to the real resolveEscalation. */
    resolve?: (msg_id: string, choice: string, note: string) => Promise<unknown>;
  } = {},
): Promise<WatchdogEscalationReconcileResult> {
  const db = opts.sql ?? getOrgPg().sql;
  const listOpen =
    opts.listOpen ??
    (async () => {
      const { escalations } = await listEscalationsPaginated({
        status: 'open',
        from: LOOP_DEATH_WATCHDOG_IDENTITY.ownerId,
        maxRecords: 500,
      });
      return escalations;
    });
  const resolve =
    opts.resolve ??
    ((msg_id: string, choice: string, note: string) =>
      resolveEscalation({ msg_id, choice, note, resolver: LOOP_DEATH_WATCHDOG_IDENTITY.ownerId }));

  const result: WatchdogEscalationReconcileResult = { scanned: 0, resolved: 0, stillOpen: 0, unparseable: 0 };
  let open: EscalationRecord[];
  try {
    open = await listOpen();
  } catch {
    return result; // a read failure must never resolve/crash — try again next tick
  }
  result.scanned = open.length;
  if (open.length === 0) return result;

  const parsed = open.map((rec) => {
    const sig = escalationSubjectSignature(rec);
    return { rec, parts: sig ? parseLoopWatchdogSignature(sig, LOOP_DEATH_SIGNATURE_PREFIX) : null };
  });
  result.unparseable = parsed.filter((p) => !p.parts).length;
  const routineIds = Array.from(new Set(parsed.map((p) => p.parts?.routineId).filter((id): id is string => !!id)));
  if (routineIds.length === 0) {
    result.stillOpen = parsed.length - result.unparseable; // (0 here since none parsed)
    return result;
  }

  let activeById = new Map<string, boolean>();
  try {
    const rows = await db<{ id: string; active: boolean }[]>`
      SELECT id, active FROM harness_shared.routines WHERE id = ANY(${routineIds})
    `;
    activeById = new Map(rows.map((r) => [r.id, r.active]));
  } catch {
    result.stillOpen += parsed.filter((p) => p.parts).length; // read failure — leave every parsed row open
    return result;
  }

  for (const { rec, parts } of parsed) {
    if (!parts) continue; // already counted in unparseable
    const active = activeById.get(parts.routineId);
    // Recovered when the routine is active again (re-armed) OR no longer exists
    // (deleted) — `undefined` from the map means "not found in the query result".
    if (active !== true && active !== undefined) {
      result.stillOpen += 1;
      continue;
    }
    const note =
      active === undefined
        ? `loop-death watchdog: routine ${parts.routineId} no longer exists — nothing left to auto-pause`
        : `loop-death watchdog: routine ${parts.routineId} is active again — a human re-armed it`;
    try {
      const outcome = await resolve(rec.msg_id, 'auto-resolved', note);
      if (outcome === 'not_found' || outcome === 'already_resolved' || outcome === 'requires_spawn_approve') {
        result.stillOpen += 1;
        continue;
      }
      result.resolved += 1;
    } catch {
      result.stillOpen += 1;
    }
  }
  return result;
}

/**
 * Auto-resolve leg for LOOP_LIFECYCLE_DEATH_WATCHDOG_IDENTITY escalations. See the
 * module-header note above `reconcileDeadLoopEscalations` for the recovery predicate.
 * Fail-soft throughout, same contract as its sibling above.
 */
export async function reconcileLoopLifecycleDeathEscalations(
  opts: {
    sql?: Sql;
    listOpen?: () => Promise<EscalationRecord[]>;
    resolve?: (msg_id: string, choice: string, note: string) => Promise<unknown>;
    readFireState?: typeof defaultReadFireState;
  } = {},
): Promise<WatchdogEscalationReconcileResult> {
  const db = opts.sql ?? getOrgPg().sql;
  const readFireState = opts.readFireState ?? defaultReadFireState;
  const listOpen =
    opts.listOpen ??
    (async () => {
      const { escalations } = await listEscalationsPaginated({
        status: 'open',
        from: LOOP_LIFECYCLE_DEATH_WATCHDOG_IDENTITY.ownerId,
        maxRecords: 500,
      });
      return escalations;
    });
  const resolve =
    opts.resolve ??
    ((msg_id: string, choice: string, note: string) =>
      resolveEscalation({ msg_id, choice, note, resolver: LOOP_LIFECYCLE_DEATH_WATCHDOG_IDENTITY.ownerId }));

  const result: WatchdogEscalationReconcileResult = { scanned: 0, resolved: 0, stillOpen: 0, unparseable: 0 };
  let open: EscalationRecord[];
  try {
    open = await listOpen();
  } catch {
    return result;
  }
  result.scanned = open.length;
  if (open.length === 0) return result;

  const parsed = open.map((rec) => {
    const sig = escalationSubjectSignature(rec);
    return { rec, parts: sig ? parseLoopWatchdogSignature(sig, LOOP_LIFECYCLE_DEATH_SIGNATURE_PREFIX) : null };
  });
  result.unparseable = parsed.filter((p) => !p.parts).length;
  const routineIds = Array.from(new Set(parsed.map((p) => p.parts?.routineId).filter((id): id is string => !!id)));
  if (routineIds.length === 0) return result;

  let routineById = new Map<string, { active: boolean; installSlug: string; name: string }>();
  try {
    const rows = await db<{ id: string; active: boolean; install_slug: string; name: string }[]>`
      SELECT id, active, install_slug, name FROM harness_shared.routines WHERE id = ANY(${routineIds})
    `;
    routineById = new Map(rows.map((r) => [r.id, { active: r.active, installSlug: r.install_slug, name: r.name }]));
  } catch {
    result.stillOpen += parsed.filter((p) => p.parts).length;
    return result;
  }

  for (const { rec, parts } of parsed) {
    if (!parts) continue;
    const routine = routineById.get(parts.routineId);
    let note: string | null = null;
    if (!routine) {
      note = `loop-lifecycle-death watchdog: routine ${parts.routineId} no longer exists`;
    } else if (!routine.active) {
      note =
        `loop-lifecycle-death watchdog: routine ${parts.routineId} was subsequently auto-paused ` +
        `(superseded by the loop-death watchdog's stronger escalation)`;
    } else {
      const fireState = await readFireState(routine.installSlug, routine.name).catch(() => null);
      if (!fireState || fireState.consecutiveErrors === 0) {
        note =
          `loop-lifecycle-death watchdog: routine ${parts.routineId} has since fired successfully ` +
          `(consecutive_errors reset to 0) — the provider wall cleared`;
      }
    }
    if (note === null) {
      result.stillOpen += 1;
      continue;
    }
    try {
      const outcome = await resolve(rec.msg_id, 'auto-resolved', note);
      if (outcome === 'not_found' || outcome === 'already_resolved' || outcome === 'requires_spawn_approve') {
        result.stillOpen += 1;
        continue;
      }
      result.resolved += 1;
    } catch {
      result.stillOpen += 1;
    }
  }
  return result;
}

export type RebaseVia =
  | 'lifecycle'
  | 'turn-journal'
  | 'note-refresh'
  /** EI-21743034835075378: a strict assistant turn paired to this fire's
   *  `turn_origin='loop-fire'` prompt. */
  | 'loop-turn'
  /** EI-21743034835075378: the wake ledger says this exact loop fire was delivered,
   *  but no assistant turn paired to a `turn_origin='loop-fire'` prompt arrived.
   *  Re-arm from the delivery clock after a bounded grace instead of allowing
   *  owner-wide presence/journal signals to strand the pure loop at infinity. */
  | 'delivered-wake-no-loop-turn'
  /** EI-20988940040434762: the first cold fire was parked at arm time and is
   *  released by the first carry-note written after that arm. No fire outcome
   *  is recorded because no wake has been delivered yet. */
  | 'initial-cold-note-refresh'
  | 'presence-quiescence'
  /** EI-21549554609576994: the routine claim parked and advanced last_fired_at,
   *  but the fire-state + wake-delivery writers both remained behind it. No turn
   *  was dispatched, so re-arm promptly instead of waiting for turn-health dwell. */
  | 'claim-dispatch-gap'
  | 'stuck-backstop'
  /** WI-36792: the loop is parked at 'infinity' and the FIRE-GATE is what is holding it —
   *  re-arm to the moment the gate's own backoff expires. This via records NO fire outcome
   *  (see the recordFire call site): it is a pure scheduling nudge that learns nothing new
   *  about the turn's health, so feeding 'ok' would ERASE the very streak the backoff is
   *  computed from, and feeding 'error' would double-count errors already recorded. */
  | 'gate-backoff';

export interface LoopRebaseResult {
  /** Loops re-armed this pass. */
  rearmed: number;
  /** Per re-armed loop (diagnostics / tests). */
  loops: Array<{
    id: string;
    targetOwnerId: string;
    /** The completion time the re-arm was computed from (epoch ms). */
    completedAt: number;
    /** The new next_fire_at floor we pushed (epoch ms) — for a cron+loop the persisted
     *  value is LEAST(cron-next, this), so it may be sooner. */
    nextFireAt: number;
    via: RebaseVia;
    /** WI-2714: true when this 'stuck-backstop' re-arm fired via the EARLY quick-retry leg
     *  (before the classic dwell window elapsed) rather than the classic dwell-gated path.
     *  Absent/false for every other via and for a classic stuck-backstop re-arm. */
    quickRetry?: boolean;
  }>;
  /** Loops auto-paused this pass because their owner is permanently unreachable (WI-1399) —
   *  NOT re-armed; `active=false` was set instead. Diagnostics / tests. */
  terminated: Array<{
    id: string;
    targetOwnerId: string;
    reason: string;
  }>;
}

interface LoopRow {
  id: string;
  target_owner_id: string;
  interval_sec: number;
  parked: boolean;
  /** EI-11407: true when the routine carries a `cron` trigger_config key (a cron+loop).
   *  Distinguishes an ARMED pure loop (newly in-scope for the reachability sweep below) from
   *  an armed cron+loop (unchanged pre-existing behavior — its cadence is cron-owned). */
  is_cron: boolean;
  // Fire-gate key (loop-wake-rate-limit-robustness P0b): the completion-rebase feeds the
  // EXISTING autoloop circuit — recordFire(install_slug, name, …, 'ok' on completion /
  // 'error' on the stuck-park backstop) — keyed exactly as fireLoopWake/checkFireGate.
  install_slug: string;
  name: string;
  routine_workspace_id: string;
  // timestamptz columns: a `Date` on a type-parsing connection, a STRING on the operator's
  // pooled `prepare:false` connection — always read through `tsMs()`, never `.getTime()` (EI-2549).
  last_fired_at: Date | string | null;
  /** Owner-loop fire-state clocks, read role-scoped (workspace + globally unique loop name).
   *  A claim newer than BOTH means the claim never entered fireLoopWake; a withheld clock
   *  newer than the claim is the deliberate fire-gate control and must never be retried here. */
  fire_state_last_fired_at: Date | string | null;
  fire_state_last_withheld_at: Date | string | null;
  /** Latest delivery-attempt clock for this exact routine source (`loop:<routineId>`). */
  last_wake_at: Date | string | null;
  /** Latest delivery state for this exact routine source (`loop:<routineId>`). */
  last_wake_status?: string | null;
  /** EI-22127560919383327: the delivery CHANNEL of that same latest row. 'suppressed-redundant'
   *  means the await engine settled the delivery WITHOUT spending a turn because one was already
   *  in flight — the psu-host stacks the queued prompt into the NEXT turn — so a missing
   *  loop-origin turn is EXPECTED until that in-flight turn ends, not evidence of a failed wake. */
  last_wake_channel?: string | null;
  /** Strict per-fire loop-turn completion clock. This is the latest assistant
   *  turn paired to a user prompt carrying `turn_origin='loop-fire'`, not an
   *  owner-wide assistant/journal signal. */
  last_loop_turn_at?: Date | string | null;
  /** max(agent_activity.created_at) for a kind='lifecycle' 'ended' marker after the fire. */
  lifecycle_completed_at: Date | string | null;
  /** WI-6069: max(session_turn_journal.created_at) for this owner after the fire — the
   *  Stop hook's per-turn journal write (P-012), which fires at the end of EVERY ordinary
   *  turn (not just a session restart). See the module header's layer-1.5 note. */
  turn_journal_completed_at: Date | string | null;
  /** max(agent_activity.created_at) for a kind='lifecycle' 'started' marker after the fire —
   *  the cold reset-boundary guard (see completionSignal). */
  lifecycle_started_at: Date | string | null;
  /** payload_template->>'carry' — 'cold' marks a cold loop (reset/recycle wakes), which
   *  changes what counts as a settle (see completionSignal). */
  carry: string | null;
  /** metadata->>'armed_at' — the latest arm instant. A cold loop with no prior
   *  fire uses it to distinguish its first post-arm checkpoint from a stale note. */
  armed_at: Date | string | null;
  /** max(carry_notes.updated_ts) for the loop's scope, any workspace (epoch ms — bigint,
   *  so a STRING over the wire). A refresh AFTER the fire is the cold protocol's own
   *  "iteration done" contract (loop:checkpoint is REQUIRED before a cold turn ends). */
  note_updated_ts: string | number | null;
  /** The session's most-recent genuine-activity timestamp (presence-v2, mig 277). */
  presence_last_active_at: Date | string | null;
  /** EI-13818: the most recent ASSISTANT turn text for this owner strictly after the fire —
   *  read regardless of which completion signal fires below, but only CONSULTED on a
   *  'lifecycle' via (see classifyLoopLifecycleTurn). null when no such turn is indexed yet
   *  (session_turns ingest lag) — never treated as a death, only ever as "nothing to check". */
  last_assistant_text_after_fire: string | null;
  /** WI-6852: newest session_turns ts indexed for this owner (any speaker) — the ingest
   *  WATERMARK. Disambiguates the field above: a null text with a watermark BEHIND the quiet
   *  instant is an ingest lag, not evidence the turn ended cleanly. null when the owner has no
   *  indexed turns at all. */
  turns_ingest_watermark: Date | string | null;
  /** P-004: the whole `payload_template`, so a monitor loop's persisted policy
   *  (`mode:'monitor'` + the typed `monitor` object) can be settled before re-arm.
   *  A work loop carries no `monitor` key and takes the unchanged re-arm path. */
  payload_template: unknown;
  /** P-004: `metadata->>'monitor_delta_at'` — the marker stamped by
   *  `loop:checkpoint { monitorDelta: true }`. Newer than `last_fired_at` ⇒ this fire
   *  reported a delta and the consecutive-quiet budget resets. */
  monitor_delta_at: Date | string | null;
}

/**
 * Detect the delivered-wake/no-loop-turn wedge for a warm pure loop.
 *
 * `event_wake_deliveries.status='delivered'` is stamped when the wake is accepted
 * by the pty/resume/inbox delivery channel, before the target necessarily gets a
 * model turn. The older completion ladder is intentionally owner-wide: a manual
 * turn, a journal write, or a presence beat can therefore look like completion
 * for this loop fire and leave the pure routine parked at infinity when the
 * delivered wake never became a turn.
 *
 * The strict `last_loop_turn_at` clock is the discriminator. While it is absent
 * (or older than this fire's delivery), hold the row through a bounded grace so
 * ingest can catch a genuinely active loop turn. Recent genuine presence also
 * keeps the row in flight; once that activity is quiet and the grace expires,
 * return the delivery clock as the retry base. Cold loops are excluded because
 * their reset-boundary/note-refresh ladder has different semantics, and
 * cron+loops have a standing finite schedule rather than the pure-loop infinity
 * sentinel.
 */
function deliveredWakeWithoutLoopTurn(
  row: LoopRow,
  lastFiredMs: number,
  nowMs: number,
):
  | { kind: 'awaiting-turn' }
  | { kind: 'retry'; completedAt: number; via: 'delivered-wake-no-loop-turn' }
  | null {
  if (row.carry === 'cold' || row.is_cron || !row.parked) return null;
  // Production SELECTs always include these discriminator fields. Legacy/unit
  // seams may omit them; absence is evidence-unavailable and must preserve the
  // established completion/retry ladder rather than manufacture a wedge.
  if (
    !Object.prototype.hasOwnProperty.call(row, 'last_wake_status') ||
    !Object.prototype.hasOwnProperty.call(row, 'last_loop_turn_at')
  ) {
    return null;
  }
  if (row.last_wake_status !== 'delivered') return null;

  const wakeAtMs = tsMs(row.last_wake_at);
  if (wakeAtMs == null || wakeAtMs <= lastFiredMs) return null;

  const loopTurnAtMs = tsMs(row.last_loop_turn_at);
  if (loopTurnAtMs != null && loopTurnAtMs >= wakeAtMs) return null;

  const intervalMs = row.interval_sec * 1000;
  // EI-22127560919383327: a 'suppressed-redundant' delivery was settled by the await engine
  // WITHOUT spending a turn because a turn was ALREADY IN FLIGHT; the psu-host stacks the queued
  // loop-fire prompt into the next turn once that one ends (measured 2026-09-02: fires 05:37:32Z
  // and 05:43:01Z both arrived as ONE loop-fire prompt at 05:44:33Z, behind an 8-min turn). So a
  // missing loop-origin turn is EXPECTED until the in-flight turn ends — and presence, which bumps
  // only on tool calls, cannot see a turn that is generating text for >60s. Scoring that as
  // 'retry' fed recordFire('error') into the fire-circuit for a wake that was never attempted
  // (transition #402464: streak 0→1 on a healthy loop; 8 such long turns open the circuit and
  // hand the loop to the WI-36792/WI-2141029 gate-backoff path). Wait for a lifecycle 'ended'
  // newer than the wake, then run the ordinary grace from THAT clock. Bounded by the stuck-park
  // dwell so a lost 'ended' report (the detached POST that "CAN be lost") can never strand a
  // loop here — past the dwell the pre-existing ladder judges it exactly as before.
  let graceFromMs = wakeAtMs;
  if (row.last_wake_channel === 'suppressed-redundant' && nowMs - wakeAtMs < stuckParkMs(intervalMs)) {
    const lifecycleEndMs = tsMs(row.lifecycle_completed_at);
    if (lifecycleEndMs == null || lifecycleEndMs < wakeAtMs) return { kind: 'awaiting-turn' };
    graceFromMs = lifecycleEndMs;
  }

  // A delivery is a handoff attempt, not proof that a model turn completed.
  // While the bounded grace is open, suppress the owner-wide completion
  // signals below so unrelated activity cannot settle this fire early.
  if (nowMs - graceFromMs < claimDispatchGraceMs(intervalMs)) {
    return { kind: 'awaiting-turn' };
  }

  // WI-2140827: this presence leg must carry the SAME stuck-park bound as the
  // 'suppressed-redundant' leg above, for the same reason stated there. Its premise is
  // "recent activity ⇒ the woken turn is still running", but `coord_presence.last_active_at`
  // is OWNER-WIDE: a session that keeps working on ANYTHING ELSE (peer coord wakes, event
  // awaits, owner turns) bumps it every few seconds forever. So for a continuously-busy
  // session the deferral never expires, and — because `hasDeliveredWakeWithoutLoopTurn`
  // simultaneously suppresses the whole owner-wide ladder and `looksDeadOrStuck` reads false
  // off that same recent activity — layers 1, 1.5, 2 AND the layer-3 stuck-park backstop are
  // all unreachable at once. The loop stays parked at 'infinity' for as long as its session
  // stays busy, while every health surface reads active:true / turnsStalled:false.
  //
  // Measured live 2026-09-02, workspace papercusp-workspace: 4 warm loops wedged this way,
  // each with a presence beat 1–68s old — including a 60s loop parked 2574s (43× its
  // interval) and a 900s loop parked 4955s. All four had ordinary turns landing throughout;
  // none had a `turn_origin='loop-fire'` turn after its fire (newest such turn was 30min–6.5h
  // stale while ingest was current to the second, so this is a missing loop-origin stamp, not
  // ingest lag). The property is inverted from the intent: the BUSIER the session, the more
  // certainly its loop is wedged — and a quiet one is rescued by the backstop within ~30min.
  //
  // Bounded exactly like the leg above: inside the dwell nothing changes (the psu-host stacks
  // a queued loop-fire prompt into the next turn well within it, so EI-22127560919383327's
  // in-flight case is still fully protected); past the dwell the pre-existing ladder judges
  // it exactly as before, which for a genuinely lost wake is the retry below.
  const lastActiveMs = tsMs(row.presence_last_active_at);
  if (
    lastActiveMs != null &&
    lastActiveMs >= wakeAtMs &&
    nowMs - lastActiveMs < FALLBACK_QUIET_MS &&
    nowMs - wakeAtMs < stuckParkMs(intervalMs)
  ) {
    return { kind: 'awaiting-turn' };
  }
  return { kind: 'retry', completedAt: wakeAtMs, via: 'delivered-wake-no-loop-turn' };
}

/** Return the strict loop-origin assistant completion for this fire, when the
 *  provenance clock proves it belongs to the latest delivered wake. */
function loopTurnCompletionAt(row: LoopRow, lastFiredMs: number): number | null {
  if (!Object.prototype.hasOwnProperty.call(row, 'last_loop_turn_at')) return null;
  const loopTurnAtMs = tsMs(row.last_loop_turn_at);
  if (loopTurnAtMs == null || loopTurnAtMs <= lastFiredMs) return null;

  const wakeAtMs = tsMs(row.last_wake_at);
  if (row.last_wake_status === 'delivered' && wakeAtMs != null && loopTurnAtMs < wakeAtMs) return null;
  return loopTurnAtMs;
}

/**
 * Resolve the woken turn's completion time for one loop (primary lifecycle marker, else
 * the dropped-report presence fallback). Returns null when the turn is still in flight /
 * no signal has landed yet. `lastFiredMs` bounds the window to THIS fire.
 */
function completionSignal(
  row: LoopRow,
  lastFiredMs: number,
  nowMs: number,
  options: { suppressOwnerWideSignals?: boolean } = {},
): { completedAt: number; via: Exclude<RebaseVia, 'stuck-backstop'> } | null {
  // ── COLD loop (carry:'cold') — settle requires evidence the ITERATION RAN ────────
  // A cold wake delivers a reset/recycle that restarts the session, so the signals mean
  // different things than warm (su-cold-auto live test, 2026-07-03, wakes 7-10):
  //  - A recycle KILLS the child (emitting '■ session ended') and the fresh child's
  //    carry inject is best-effort — when it defers, the booted-but-idle session sits
  //    QUIET, which the presence-quiescence fallback read as "turn settled" and re-fired
  //    91s after the recycle, into a still-booting host (wake #5036 after #5033). Bare
  //    quiescence CANNOT distinguish "booted idle, iteration never ran" from "iteration
  //    done" — so it is NOT a cold settle signal at all.
  //  - What IS: (1) the turn's own Stop-hook 'ended' NEWER than the boundary 'started'
  //    (the session booted AND its turn finished), (1.5) the per-turn journal write NEWER
  //    than that same boundary 'started' (see below), or (2) the carry-note REFRESH — the
  //    cold protocol's required loop:checkpoint before turn end, i.e. the iteration's
  //    own completion receipt. Take the LATEST of the three (checkpoint-then-more-work
  //    still re-arms off the latest evidence; the pty host's clean-boundary gate defers
  //    an early-landing cold apply to the turn boundary regardless).
  //  - A dead boot / dropped iteration produces NONE → the loop stays parked until
  //    the stuck-park backstop re-fires it, which re-delivers the SAME note — exactly
  //    the right retry.
  //
  // EI-20476474709976110 — COLD layer-1.5, the mirror of WI-6069's warm leg.
  // Leg (1) above CANNOT fire at an ordinary turn boundary: `lifecycle-report.sh` is wired
  // in ~/.claude/settings.json only to SessionStart/SessionEnd, never to Stop (re-verified
  // live 2026-09-02), so a cold-woken session that finishes its turn and STAYS ALIVE emits
  // no 'ended'. That left leg (2) — an agent remembering to call loop:checkpoint — as the
  // only reachable cold settle, and a dropped checkpoint silently degraded the loop to the
  // >=30min stuck-park backstop regardless of its configured interval (observed: configured
  // 300s vs effective 1632s, cadenceRatio 5.44, lastDeliveryOutcome='loop-stuck-backstop').
  // This is the SAME gap WI-6069 closed for warm, and it is closed here the same way.
  //
  // Why this does NOT reintroduce the 2026-07-03 bare-quiescence trap: that trap was a
  // booted-but-idle session being read as settled. Such a session runs no turn, so the Stop
  // hook never fires and NO `session_turn_journal` row exists — there is nothing to settle
  // on. Unlike bare quiescence, this signal is positive evidence that a turn actually ran.
  //
  // The gate is BOTH halves of the cold reset boundary, and both are load-bearing because
  // `turn_journal_completed_at` is an OWNER-WIDE clock, not a per-fire one:
  //   - `lsCold != null` — a post-fire 'started' must exist, i.e. the session demonstrably
  //     REBOOTED for this fire. Without it we cannot tell the woken iteration's turn from
  //     the pre-existing session's unrelated work, and settling on the latter re-arms a fire
  //     whose iteration never ran (the delivered-wake case EI-21743034835075378 guards).
  //   - `tjCold > lsCold` — the journal write must be NEWER than that boot marker; an older
  //     row belongs to the DYING child's last turn, not to the woken iteration.
  // In the real cold path both are satisfied: lifecycle-report.sh IS wired to SessionStart,
  // so the reboot marker is present; only the END-of-turn marker was missing, and the Stop
  // hook's journal write is exactly that. Together these make this leg STRICTLY STRONGER
  // than the note-refresh leg the cold ladder already accepts (gated only on `> lastFiredMs`).
  if (row.carry === 'cold') {
    const lcCold = tsMs(row.lifecycle_completed_at);
    const lsCold = tsMs(row.lifecycle_started_at);
    const turnEnded = lcCold != null && lsCold != null && lcCold > lsCold ? lcCold : null;
    const rawNoteTs = row.note_updated_ts == null ? null : Number(row.note_updated_ts);
    const noteRefreshed =
      rawNoteTs != null && Number.isFinite(rawNoteTs) && rawNoteTs > lastFiredMs ? rawNoteTs : null;
    const tjCold = tsMs(row.turn_journal_completed_at);
    const turnJournalled =
      tjCold != null && lsCold != null && tjCold > lsCold ? tjCold : null;
    const coldSignals: { completedAt: number; via: Exclude<RebaseVia, 'stuck-backstop'> }[] = [];
    if (turnEnded != null) coldSignals.push({ completedAt: turnEnded, via: 'lifecycle' });
    if (turnJournalled != null) {
      coldSignals.push({ completedAt: turnJournalled, via: 'turn-journal' });
    }
    if (noteRefreshed != null) coldSignals.push({ completedAt: noteRefreshed, via: 'note-refresh' });
    if (coldSignals.length === 0) return null;
    // Latest evidence wins; ties keep the earlier (stronger) leg, preserving the original
    // `turnEnded >= noteRefreshed` precedence.
    return coldSignals.reduce((best, next) =>
      next.completedAt > best.completedAt ? next : best,
    );
  }
  const strictLoopTurnAtMs = loopTurnCompletionAt(row, lastFiredMs);
  if (strictLoopTurnAtMs != null) {
    return { completedAt: strictLoopTurnAtMs, via: 'loop-turn' };
  }
  // A delivered wake without its matching loop-origin turn is handled by the
  // no-signal retry/terminal-guard path in reconcileLoopRoutines. Suppress the
  // owner-wide lifecycle/journal/presence ladder here so those unrelated signals
  // cannot settle the fire before that path gets a chance to run.
  if (options.suppressOwnerWideSignals) return null;
  // ── WARM loop — the original two-layer ladder ────────────────────────────────────
  // 1. PRIMARY: the Stop-hook lifecycle 'ended' marker (already filtered > last_fired by
  //    the SQL window). COLD-RESET-BOUNDARY GUARD (su-cold-auto 2026-07-03): a COLD
  //    reset/recycle wake restarts the session AT delivery — the dying process emits
  //    '■ session ended' and the fresh one '▶ session started' back-to-back (~250ms apart),
  //    so an 'ended' marker OLDER than the newest post-fire 'started' is the reset boundary,
  //    NOT the woken turn settling. Treating it as a settle re-armed the loop ~interval
  //    after DELIVERY and the next fire landed mid-turn (observed live: fire #4979
  //    overlapped the still-running turn of fire #4972). A settle requires the newest
  //    post-fire lifecycle marker to be the 'ended' one; while a fresh 'started' is newest,
  //    the session is RUNNING → not settled (the cold turn's own Stop hook emits the real
  //    'ended' when it finishes). Warm loops are unaffected: 'started' fires only at process
  //    boot, which precedes last_fired and falls outside the SQL window.
  const lc = tsMs(row.lifecycle_completed_at);
  const ls = tsMs(row.lifecycle_started_at);
  if (lc != null && (ls == null || ls < lc)) {
    return { completedAt: lc, via: 'lifecycle' };
  }
  // 1.5. PRIMARY-B (WI-6069): the per-turn Stop-hook journal write. See module header —
  //    unlike the lifecycle marker above (which in practice only fires at a genuine session
  //    restart), this fires at the end of EVERY ordinary turn, so it is what actually lets a
  //    warm, push-wake-only session (never restarts) settle promptly instead of degrading to
  //    the layer-3 stuck-park backstop every single fire.
  const tj = tsMs(row.turn_journal_completed_at);
  if (tj != null) {
    return { completedAt: tj, via: 'turn-journal' };
  }
  // 2. FALLBACK: a dropped lifecycle report / journal write — the session did genuine work
  //    after the fire then went quiet. last_active_at is the genuine-activity ts (NOT keepalive).
  const la = tsMs(row.presence_last_active_at);
  if (la != null && la > lastFiredMs && nowMs - la >= FALLBACK_QUIET_MS) {
    // WI-6852 — DEFER while the death evidence is merely UNINGESTED rather than absent.
    //
    // Reaching this fallback already means BOTH stronger signals missed (no lifecycle 'ended',
    // no turn-journal row), so the turn ended abnormally often enough that the caller
    // reclassifies it as a death from `last_assistant_text_after_fire`. But that text arrives
    // via the session_turns ingest, which lags MINUTES, while quiescence is declared after just
    // FALLBACK_QUIET_MS (60s). The settle therefore wins the race, the reclassification finds
    // nothing, and the loop re-arms at the BARE interval — firing straight back into whatever
    // killed it (a provider usage wall). The correct reset-aware re-arm then lands on the NEXT
    // cycle, after the damage. Live: last beat 02:42:47.965 -> re-arm +900s -> fire 02:58:02,
    // while the +3600s reclassification only landed 02:59:31.
    //
    // So a null text is only trustworthy once the ingest has actually REACHED the quiet instant.
    // While the watermark is behind `la`, return null: the loop stays parked and a later pass
    // settles it once the evidence is readable. This cannot wedge — the layer-3 stuck-park
    // backstop still re-arms off last_fired_at + interval at its >=30min floor, so the worst
    // case is settling ~30min late instead of firing blind into a live wall.
    //
    // NARROW BY DESIGN: a null WATERMARK (owner has no indexed turns at all — never ingested,
    // not merely behind) falls THROUGH to today's behavior. Deferring needs positive evidence
    // the ingest is lagging; without it we would silently downgrade an unmeasured population
    // from the 60s fallback to the 30min backstop.
    if (row.last_assistant_text_after_fire == null) {
      const ingestWatermark = tsMs(row.turns_ingest_watermark);
      if (ingestWatermark != null && ingestWatermark < la) {
        return null;
      }
    }
    return { completedAt: la, via: 'presence-quiescence' };
  }
  return null;
}

/**
 * Re-arm every interval-loop routine whose woken turn has settled. Pure loops (parked at
 * 'infinity') rebase to completed_at + interval; cron+loops fold the loop re-arm into
 * their cron-next by taking the sooner (LEAST). `nowMs` is injectable for deterministic
 * tests.
 */
export async function reconcileLoopRoutines(
  opts: {
    sql?: Sql;
    nowMs?: number;
    recordFire?: typeof defaultRecordFire;
    /** Injected for tests; defaults to the real autoloop_state read. */
    readFireState?: typeof defaultReadFireState;
    /** Injected for tests; defaults to the real unreachable-owner terminal guard (WI-1399). */
    checkUnreachableTerminalGuard?: typeof defaultCheckUnreachableTerminalGuard;
    /** Injected for tests; defaults to the real fire-circuit threshold read (EI-7006). */
    circuitThreshold?: typeof defaultCircuitThreshold;
    /** WI-36792: the pure fire-gate verdict, injected so a test can drive the gate-backoff
     *  re-arm leg without constructing autoloop_state rows. */
    evaluateFireGate?: typeof defaultEvaluateFireGate;
    /** WI-2339 (fix E): injected loud human-escalation for a confirmed durably-dead loop. Fires
     *  ONCE per dead loop (the breach auto-pauses it → never re-scanned). Default opens an advisory
     *  coord escalation. Fail-soft at the call site. */
    escalateDeadLoop?: (info: DeadLoopInfo) => Promise<void>;
    /** WI-2339 (fix D): injected inbox-wake cancel for a confirmed durably-dead owner. Default
     *  cancelInboxWake — stops the ghost standing await from matching-without-consuming and
     *  poisoning EVERY other wake source for the dead owner. Fail-soft at the call site. */
    cancelInboxWake?: (ownerId: string, workspaceId?: string) => Promise<number>;
    /** EI-13818: injected loud human-escalation for a loop turn reclassified from a false
     *  'ok' lifecycle settle to a provider-kill 'error'. Default opens an advisory coord
     *  escalation. Fail-soft at the call site — never blocks the re-arm it accompanies. */
    escalateLifecycleDeath?: (info: LifecycleDeathInfo) => Promise<void>;
    /** WI-41228: canonical agent-authored tool-call evidence for the dispatched fire window. */
    countAgentToolCallsInWindow?: typeof defaultCountAgentToolCallsInWindow;
    /** WI-41228: idempotent routine-metadata streak writer, injectable for focused tests. */
    recordZeroToolFireObservation?: typeof defaultRecordZeroToolFireObservation;
    /** WI-41228: shared disarm primitive used before the existing dead-loop termination path. */
    autoPauseLoopRoutine?: typeof defaultAutoPauseLoopRoutine;
    /** Test/config seam; production defaults to PAPERCUSP_LOOP_ZERO_TOOL_ESCALATION_THRESHOLD (3). */
    zeroToolThreshold?: number;
    /** P-004: the stored-authority re-validation run before a MONITOR loop is re-armed.
     *  Injectable because the real one reads work-items / presence / fleets through the LIVE
     *  connection, which a hermetic fakeSql test cannot intercept (the EI-7006 leak class). */
    recheckMonitorAuthority?: typeof defaultRecheckMonitorAuthority;
  } = {},
): Promise<LoopRebaseResult> {
  const db = opts.sql ?? getOrgPg().sql;
  const nowMs = opts.nowMs ?? Date.now();
  const recordFire = opts.recordFire ?? defaultRecordFire;
  const readFireState = opts.readFireState ?? defaultReadFireState;
  const checkUnreachableTerminalGuard = opts.checkUnreachableTerminalGuard ?? defaultCheckUnreachableTerminalGuard;
  const circuitThreshold = opts.circuitThreshold ?? defaultCircuitThreshold;
  const evaluateFireGate = opts.evaluateFireGate ?? defaultEvaluateFireGate;
  const escalateDeadLoop = opts.escalateDeadLoop ?? defaultEscalateDeadLoop;
  const cancelInboxWake = opts.cancelInboxWake ?? defaultCancelInboxWake;
  const escalateLifecycleDeath = opts.escalateLifecycleDeath ?? defaultEscalateLifecycleDeath;
  const countAgentToolCallsInWindow = opts.countAgentToolCallsInWindow ?? defaultCountAgentToolCallsInWindow;
  const recordZeroToolFireObservation = opts.recordZeroToolFireObservation ?? defaultRecordZeroToolFireObservation;
  const autoPauseLoopRoutine = opts.autoPauseLoopRoutine ?? defaultAutoPauseLoopRoutine;
  const zeroToolThreshold = opts.zeroToolThreshold ?? zeroToolEscalationThreshold();
  const recheckMonitorAuthority = opts.recheckMonitorAuthority ?? defaultRecheckMonitorAuthority;

  // Loop routines in scope: a PARKED pure loop (rebase off completion), an armed cron+loop
  // (fold the sooner — unchanged), OR (EI-11407) an ARMED pure loop that has fired at least
  // once — newly in scope so the reachability sweep can catch a permanently-dead owner
  // without waiting for the loop to actually fire again first. A cold loop's initial arm is
  // also parked at infinity with last_fired_at NULL; it is released below only after a
  // carry-note newer than metadata.armed_at exists (EI-20988940040434762). The partial index
  // routines_loop_interval_idx (on reschedule_interval_sec IS NOT NULL, every loop routine —
  // never conditioned on parked/cron) keeps this scan cheap either way.
  const rows = await db<LoopRow[]>`
    SELECT r.id,
           r.target_owner_id,
           r.reschedule_interval_sec AS interval_sec,
           (r.next_fire_at = 'infinity'::timestamptz) AS parked,
           jsonb_exists(r.trigger_config, 'cron') AS is_cron,
           r.install_slug,
           r.name,
           r.workspace_id AS routine_workspace_id,
           r.last_fired_at,
           fs.last_fired_at AS fire_state_last_fired_at,
           fs.last_withheld_at AS fire_state_last_withheld_at,
           lw.last_wake_at,
           lw.status AS last_wake_status,
           lw.channel AS last_wake_channel,
           -- EI-21743034835075378: pair each loop-fire USER prompt with the
           -- assistant output before the next user prompt. Unlike the
           -- owner-wide lifecycle/journal/presence clocks below, this proves
           -- that THIS routine's delivered wake became an actual loop turn.
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
               AND u.ts > r.last_fired_at) AS last_loop_turn_at,
           (SELECT max(a.created_at)
              FROM harness_shared.agent_activity a
             WHERE a.owner_id = r.target_owner_id
               AND a.kind = 'lifecycle'
               AND a.summary = ${SESSION_END_MARKER}
               AND a.created_at > r.last_fired_at) AS lifecycle_completed_at,
           -- WI-6069: the Stop hook's journal write (P-012) — see the layer-1.5 module-header
           -- note. Cheap: indexed on (owner_id, created_at DESC).
           --
           -- ⚠ EI-19316779460752535 — WI-6069's stated premise, that this write "fires at the
           -- end of EVERY ordinary turn, restart or not, across every CLI", is FALSE.
           -- The journal:record-turn tool writes a row ONLY when extractJournalFromAssistantText()
           -- finds an extractable note in the turn text; otherwise it returns no_note and
           -- writes nothing. Measured 2026-08-02 over 24h: 17 rows vs 750 ingested assistant
           -- turns for one owner (2.3%); 746 rows / 61 owners fleet-wide, 100% flagged=true.
           -- Consequence for THIS file: the layer-1.5 'turn-journal' completion signal — added
           -- precisely so a warm push-wake session settles promptly instead of degrading to the
           -- weaker layer-2 fallback — fires for a small minority of turns, so most loop settles
           -- still go through presence-quiescence (which is why WI-6852's ingest-watermark
           -- deferral had to be added THERE). Do not treat a missing journal row as evidence
           -- that no turn completed.
           (SELECT max(j.created_at)
              FROM harness_shared.session_turn_journal j
             WHERE j.owner_id = r.target_owner_id
               AND j.created_at > r.last_fired_at) AS turn_journal_completed_at,
           (SELECT max(a.created_at)
              FROM harness_shared.agent_activity a
             WHERE a.owner_id = r.target_owner_id
               AND a.kind = 'lifecycle'
               AND a.summary = ${SESSION_START_MARKER}
               AND a.created_at > r.last_fired_at) AS lifecycle_started_at,
           (r.payload_template->>'carry') AS carry,
           r.metadata->>'armed_at' AS armed_at,
           (SELECT max(cn.updated_ts)
              FROM harness_shared.carry_notes cn
             WHERE cn.scope = ('loop:' || r.install_slug || ':' || r.target_owner_id)
               AND cn.note IS NOT NULL) AS note_updated_ts,
           (SELECT max(p.last_active_at)
              FROM harness_shared.coord_presence p
             WHERE p.owner_id = r.target_owner_id) AS presence_last_active_at,
           -- EI-13818: the most recent assistant turn text after this fire — the lifecycle-death
           -- reclassification's only evidence source. Cheap: one correlated single-row lookup per
           -- in-scope loop, ordered by ts (falls back to turn_idx on a tie) so a multi-session
           -- (cold-spawn) owner still resolves to its TRUE most-recent turn, not an arbitrary one.
           (SELECT st.text
              FROM harness_shared.session_turns st
             WHERE st.owner = r.target_owner_id
               AND st.speaker = 'assistant'
               AND st.ts > r.last_fired_at
             ORDER BY st.ts DESC, st.turn_idx DESC
             LIMIT 1) AS last_assistant_text_after_fire,
           -- WI-6852: the session_turns INGEST WATERMARK for this owner — the newest turn ts
           -- indexed so far, any speaker. Answers the question the text lookup above cannot:
           -- is a NULL last_assistant_text_after_fire a REAL absence, or merely a turn that
           -- has not been ingested yet? Index-backed (session_turns_owner_ts_idx on (owner, ts)),
           -- same correlated single-row cost class as the lookup above. Deliberately NOT
           -- speaker-filtered: this is "how far has the ingest got", not "what did it say".
           (SELECT max(st2.ts)
              FROM harness_shared.session_turns st2
             WHERE st2.owner = r.target_owner_id) AS turns_ingest_watermark,
           -- P-004 (anti-babysitting): the monitor settlement inputs. Both come off the
           -- routine row already being scanned, so this adds no join and no extra pass.
           r.payload_template,
           r.metadata->>'monitor_delta_at'                                AS monitor_delta_at
      FROM harness_shared.routines r
      LEFT JOIN LATERAL (
        -- Owner-loop fire state is role-scoped inside one workspace (WI-41224): split legacy
        -- harness rows may still exist, so take each clock's max rather than trusting one row.
        SELECT max(s.last_fired_at) AS last_fired_at,
               max(s.last_withheld_at) AS last_withheld_at
          FROM harness_shared.autoloop_state s
         WHERE s.workspace_id = r.workspace_id
           AND s.role = r.name
      ) fs ON true
      LEFT JOIN LATERAL (
        SELECT w.status,
               w.channel,
               COALESCE(w.delivered_at, w.created_at) AS last_wake_at
          FROM harness_shared.event_wake_deliveries w
         WHERE w.subscriber_id = r.target_owner_id
           AND w.source = ('loop:' || r.id)
         ORDER BY w.created_at DESC
         LIMIT 1
       ) lw ON true
     WHERE r.active = TRUE
       AND r.reschedule_interval_sec IS NOT NULL
       AND r.target_owner_id IS NOT NULL
       AND (
             r.next_fire_at = 'infinity'::timestamptz
             OR jsonb_exists(r.trigger_config, 'cron')
             -- EI-11407: an ARMED pure loop that has fired at least once — previously excluded
             -- entirely, the gap this fix closes (see the class-4 header note above).
             OR (r.last_fired_at IS NOT NULL AND NOT jsonb_exists(r.trigger_config, 'cron'))
           )
  `;

  const result: LoopRebaseResult = { rearmed: 0, loops: [], terminated: [] };

  /** Shared termination side-effects (WI-1399 / WI-2339 fix D+E) — pushed to `result`, fed to
   *  the fire-circuit as 'error', the ghost inbox-wake cancelled, and a loud advisory
   *  escalation raised. Used by BOTH the classic stuck-park/circuit-open path below and the
   *  EI-11407 armed-loop sweep — kept as one function so the two paths can never drift. */
  async function terminateDeadLoop(row: LoopRow, reason: string): Promise<void> {
    result.terminated.push({ id: row.id, targetOwnerId: row.target_owner_id, reason });
    await runWithWorkspace(row.routine_workspace_id, () =>
      recordFire(row.install_slug, row.name, LOOP_TERMINAL_AUTO_PAUSE_STATUS, 'error'),
    ).catch((e) =>
      console.warn(
        `[loop-reconcile] recordFire('error') failed for terminated loop '${row.id}': ${e instanceof Error ? e.message : e}`,
      ),
    );
    // WI-2339 fix D — stop the ghost standing inbox-wake await from matching-without-
    // consuming and poisoning EVERY other wake source for this now-confirmed-dead owner
    // (the once=false await is otherwise cancelled only on a graceful SessionEnd, which an
    // unplanned death never runs). Fail-soft: a cancel failure never blocks termination.
    await runWithWorkspace(row.routine_workspace_id, () =>
      cancelInboxWake(row.target_owner_id, row.routine_workspace_id),
    ).catch((e) =>
      console.warn(
        `[loop-reconcile] cancelInboxWake failed for dead owner '${row.target_owner_id}': ${e instanceof Error ? e.message : e}`,
      ),
    );
    // WI-2339 fix E — pause+ESCALATE (owner policy: NOT auto-respawn). Loudly tell a human
    // the watchdog auto-paused a dead loop, rather than the silent no-op it was before.
    // Fires exactly once (the loop is now active=false → never re-scanned). Fail-soft: a
    // missing coord context degrades to no escalation, never a crashed tick.
    await runWithWorkspace(row.routine_workspace_id, () =>
      escalateDeadLoop({
        routineId: row.id,
        targetOwnerId: row.target_owner_id,
        installSlug: row.install_slug,
        name: row.name,
        reason,
      }),
    ).catch((e) =>
      console.warn(
        `[loop-reconcile] escalateDeadLoop failed for terminated loop '${row.id}': ${e instanceof Error ? e.message : e}`,
      ),
    );
    console.warn(
      `[loop-reconcile] loop '${row.id}' (owner ${row.target_owner_id}) TERMINATED (auto-paused, not re-armed): ${reason}`,
    );
  }

  for (const row of rows) {
    // PER-ROW ISOLATION (engine-loop re-arm hardening, EI-2549): one malformed row must NEVER
    // throw out of this loop and strand EVERY other loop's re-arm (a single bad row silently
    // wedging the whole fleet's loops is exactly the failure class this guards). Log + continue.
    try {
      // A fired loop always has last_fired_at (claim sets it on park/advance); defensively
      // skip a malformed/missing row rather than rebasing off an unbounded window. The one
      // intentional exception is a never-fired COLD loop: materializeLoop parks its initial
      // schedule at infinity, and the first post-arm carry-note is the only valid completion
      // signal for releasing that schedule (EI-20988940040434762). tsMs() tolerates the string
      // form the pooled connection returns (EI-2549).
      const lastFiredMs = tsMs(row.last_fired_at);
      const intervalMs = row.interval_sec * 1000;

      if (lastFiredMs == null) {
        if (row.carry === 'cold') {
          const armedAtMs = tsMs(row.armed_at);
          const noteAt = row.note_updated_ts == null ? null : Number(row.note_updated_ts);
          if (armedAtMs != null && noteAt != null && Number.isFinite(noteAt) && noteAt > armedAtMs) {
            const reArmIso = new Date(noteAt + intervalMs).toISOString();
            const armedAtIso = new Date(armedAtMs).toISOString();
            const updated = await db<{ id: string }[]>`
              UPDATE harness_shared.routines
                 SET next_fire_at = ${reArmIso}::timestamptz, updated_at = now()
               WHERE id = ${row.id}
                 AND active = TRUE
                 AND reschedule_interval_sec IS NOT NULL
                 AND last_fired_at IS NULL
                 AND next_fire_at = 'infinity'::timestamptz
                 AND payload_template->>'carry' = 'cold'
                 AND (metadata->>'armed_at')::timestamptz = ${armedAtIso}::timestamptz
               RETURNING id
            `;
            if (updated.length > 0) {
              const via: RebaseVia = 'initial-cold-note-refresh';
              result.rearmed++;
              result.loops.push({
                id: row.id,
                targetOwnerId: row.target_owner_id,
                completedAt: noteAt,
                nextFireAt: noteAt + intervalMs,
                via,
              });
              // No fire outcome is recorded here: the initial wake has not been delivered
              // yet. Keep the same transition ledger used by ordinary loop re-arms so the
              // pending-first-fire handoff is observable without fabricating a fire.
              void recordLoopTransition(db, {
                workspaceId: row.routine_workspace_id,
                installSlug: row.install_slug,
                routineId: row.id,
                routineName: row.name,
                targetOwnerId: row.target_owner_id,
                event: 'rearmed',
                actor: 'reconcile-loop-routines',
                newNextFireAt: reArmIso,
                intervalSec: row.interval_sec,
                detail: { via, wasParked: true, initialColdFire: true },
              });
            }
          }
        }
        continue;
      }

      // EI-11407 ARMED-LOOP REACHABILITY SWEEP — a pure loop (never cron: cron+loop keeps its
      // pre-existing fold-the-sooner handling below, untouched) that is NOT parked has already
      // settled its last fire (that's WHY it's armed with a real future next_fire_at) — there is
      // no in-flight turn to rebase. But nothing previously re-checked whether its owner is still
      // alive while it waits out the interval, so a permanently-dead owner sat armed+scheduled
      // until the loop fired again and dwelled through the full stuck-park/circuit ladder (see the
      // class-4 header note). Measure dwell from the LATEST known-alive evidence — the fire
      // itself, or any genuine presence activity after it, whichever is more recent — and consult
      // the SAME reachability guard once that dwell exceeds the generous terminal window. The
      // guard's own reachability veto (a live owner is NEVER terminated, any dwell) is what
      // actually protects a healthy long-interval armed loop; the window here just avoids probing
      // a freshly-armed one for no reason.
      if (!row.parked && !row.is_cron) {
        const lastActiveMs = tsMs(row.presence_last_active_at);
        const sinceAliveMs = nowMs - Math.max(lastFiredMs, lastActiveMs ?? lastFiredMs);
        if (sinceAliveMs >= terminalUnreachableMs(intervalMs)) {
          const guard = await checkUnreachableTerminalGuard({
            sql: db,
            routineId: row.id,
            targetOwnerId: row.target_owner_id,
            parkedForMs: sinceAliveMs,
            intervalMs,
            // An armed loop has no discrete "failed fire attempt" streak to gate on — it isn't
            // failing to fire, it just hasn't been checked since it settled. The dwell window
            // above is this leg's blip protection, so pre-satisfy the guard's fire-count floor.
            stuckFireCount: minStuckFiresForTermination(),
            circuitOpen: false,
          }).catch((e) => {
            console.warn(
              `[loop-reconcile] armed-loop unreachable-guard check failed for '${row.id}' — leaving it armed: ${e instanceof Error ? e.message : e}`,
            );
            return { breach: false } as { breach: boolean; reason?: string };
          });
          if (guard.breach) {
            await terminateDeadLoop(row, guard.reason ?? 'unreachable dead-owner loop (armed, EI-11407 sweep)');
            continue;
          }
        }
        // EI-21910891361619900: the armed branch used to continue after the reachability
        // check without recording a successful loop-origin turn. A pure loop is armed again
        // (finite next_fire_at) as soon as its previous turn settles, so that turn never
        // reaches the parked branch below; a stale `consecutive_errors` streak consequently
        // survived indefinitely and the fire gate's backoff ratcheted on an otherwise healthy
        // owner-loop.
        //
        // `last_loop_turn_at` is the strict per-fire completion proof. Only reset when the
        // fire-state watermark is older than that proof, so repeated reconcile ticks are
        // idempotent after the first successful write. Re-read the state before writing to
        // avoid clearing an error that raced in after this SELECT snapshot. Missing
        // discriminator fields are legacy/unit-test evidence-unavailable and fail open.
        const armedLoopTurnAt = loopTurnCompletionAt(row, lastFiredMs);
        if (
          armedLoopTurnAt != null &&
          Object.prototype.hasOwnProperty.call(row, 'fire_state_last_fired_at')
        ) {
          const snapshotFireStateAt = tsMs(row.fire_state_last_fired_at);
          if (snapshotFireStateAt == null || snapshotFireStateAt < armedLoopTurnAt) {
            const currentFireState = await runWithWorkspace(row.routine_workspace_id, () =>
              readFireState(row.install_slug, row.name),
            ).catch((e) => {
              console.warn(
                `[loop-reconcile] armed-loop fire-state read failed for '${row.id}' — leaving the streak untouched: ${e instanceof Error ? e.message : e}`,
              );
              return null;
            });
            const currentFireStateAt = tsMs(currentFireState?.lastFiredAt);
            if (
              (currentFireState?.consecutiveErrors ?? 0) > 0 &&
              (currentFireStateAt == null || currentFireStateAt < armedLoopTurnAt)
            ) {
              await runWithWorkspace(row.routine_workspace_id, () =>
                recordFire(row.install_slug, row.name, 'loop-armed-settle', 'ok'),
              ).catch((e) =>
                console.warn(
                  `[loop-reconcile] armed-loop recordFire('ok') failed for '${row.id}': ${e instanceof Error ? e.message : e}`,
                ),
              );
            }
          }
        }
        continue; // armed pure loop: nothing to rebase either way (see comment above)
      }

      // Resolve the re-arm time + provenance.
      let completedAt: number;
      let via: RebaseVia;
      let quickRetry = false;
      /** WI-36792: set only on the 'gate-backoff' via — the fire-gate's own remaining backoff,
       *  in ms. Overrides the interval/lifecycle delay so the re-arm lands exactly when the
       *  gate will next ALLOW, instead of hammering a gate that is still withholding. */
      let gateRetryMs: number | null = null;
      /** WI-36792: the withholding streak, captured for the 'gate-backoff' log line (the
       *  streak itself is block-scoped to the quiet-parked path below). */
      let gateBackoffErrors = 0;
      // EI-21743034835075378: delivery is only an accepted handoff, not proof
      // that this fire became a model turn. Keep the generic owner-wide signal
      // ladder out of the way until the strict loop-origin clock catches up.
      // The full delivered-wake classification runs in the no-signal branch so
      // post-grace retries still pass through terminal-guard handling.
      const loopTurnAtMs = loopTurnCompletionAt(row, lastFiredMs);
      const wakeAtMs = tsMs(row.last_wake_at);
      // EI-22177872501023528: a 'suppressed-redundant' delivery is settled WITHOUT spending a
      // turn because one was already in flight, and the psu-host stacks the queued prompt into
      // the NEXT turn. But that stacked prompt only carries `turn_origin='loop-fire'` when the
      // LOOP's wake is what opens that turn — when a watchdog / wake-pump / coord wake opens it
      // first, the prompt rides in under THAT origin and the strict loop-turn clock never
      // advances. Pair that with a WARM session, whose lifecycle 'ended' marker "in practice
      // only fires at a genuine session restart" (layer 1, module header), and NO signal this
      // suppression waits for can ever arrive — so the owner-wide ladder stays suppressed until
      // the layer-3 stuck-park backstop, a flat 30-min floor (max(30min, interval*4)) that is
      // 30x cadence for a 60s loop.
      //
      // Presence bumps on tool calls, so it is the in-flight evidence this leg actually wants:
      // once it has been quiet for FALLBACK_QUIET_MS the turn that swallowed the stacked prompt
      // is demonstrably over. Lift the suppression there and let the ordinary ladder settle the
      // fire as 'ok' via presence-quiescence, instead of riding the backstop. Deliberately
      // scoped to this ONE channel: a psu-socket-inject delivery genuinely should have produced
      // a loop-origin turn, so its pre-existing retry/circuit path is untouched.
      //
      // Measured 2026-09-02 (papercusp-workspace): warm + suppressed-redundant = 8 parked loops,
      // 8/8 with zero post-fire loop-fire turns, averaging 17.5x their own interval, against
      // 1.8-5.2x for every other parked group.
      const presenceLastActiveMs = tsMs(row.presence_last_active_at);
      const suppressedRedundantTurnEnded =
        row.last_wake_channel === 'suppressed-redundant' &&
        presenceLastActiveMs != null &&
        presenceLastActiveMs > lastFiredMs &&
        nowMs - presenceLastActiveMs >= FALLBACK_QUIET_MS;
      const hasDeliveredWakeWithoutLoopTurn =
        row.carry !== 'cold' &&
        !row.is_cron &&
        row.parked &&
        Object.prototype.hasOwnProperty.call(row, 'last_wake_status') &&
        Object.prototype.hasOwnProperty.call(row, 'last_loop_turn_at') &&
        row.last_wake_status === 'delivered' &&
        wakeAtMs != null &&
        wakeAtMs > lastFiredMs &&
        (loopTurnAtMs == null || loopTurnAtMs < wakeAtMs) &&
        // WI-2140827: the suppression is a GRACE, so it has to expire. Unbounded, it was the
        // other half of the wedge documented in deliveredWakeWithoutLoopTurn(): the strict
        // loop-origin clock is the discriminator only while it can still plausibly arrive, and
        // when the loop-origin stamp simply never lands, holding the ladder off forever leaves
        // a busy session's loop with NO reachable settle layer. Past the stuck-park dwell,
        // restore the pre-existing ladder — a real lifecycle/turn-journal settle then re-arms
        // the loop as 'ok' rather than letting it ride the retry leg's 'error' indefinitely.
        nowMs - wakeAtMs < stuckParkMs(intervalMs) &&
        // EI-22177872501023528 — see the note above this block.
        !suppressedRedundantTurnEnded;
      const signal = completionSignal(row, lastFiredMs, nowMs, {
        suppressOwnerWideSignals: hasDeliveredWakeWithoutLoopTurn,
      });
      // EI-13818: a 'lifecycle' signal means the Stop hook fired — the turn EXITED cleanly —
      // not that it SUCCEEDED. Re-classify its own text before trusting that as an 'ok'.
      //
      // EI-15722: the SAME false-'ok' failure mode hits the 'presence-quiescence' FALLBACK
      // path too, and is actually WORSE there because it can repeat indefinitely: that path
      // exists precisely because the lifecycle 'ended' report is a detached, fail-open POST
      // that "CAN be lost" (module header, layer 2) — and a turn that dies on a provider kill
      // (auth_wall / usage_limit / model_error / context_limit) commonly does lose that report
      // (the process is torn down mid/just-after generation, before the Stop hook's POST lands),
      // while still bumping `presence.last_active_at` once via the dispatch that preceded the
      // kill. completionSignal() then reads "activity after the fire, gone quiet" as a genuine
      // settle and hands back via:'presence-quiescence' — previously trusted as an unconditional
      // 'ok' with NO text check at all, unlike the 'lifecycle' path. Since the kill wall
      // (an expired credential, a still-open rate-limit window, …) typically persists across the
      // next several bare-interval re-arms, this silently repeats every fire: 'ok' resets the
      // failure-streak circuit each time, so it never opens, no rate-limit-aware backoff ever
      // applies, and no escalation ever fires — a loop can sit "firing on schedule" for many
      // hours (observed: 22h+) producing zero real agent turns while reporting perfectly healthy.
      // `row.last_assistant_text_after_fire` is queried unconditionally regardless of `via` (see
      // the SELECT above) — it is NOT lifecycle-report-gated — so this reclassification costs
      // nothing extra and needs no new evidence source; it was simply never wired to this via.
      // note-refresh is unchanged: it is the cold protocol's own explicit checkpoint write (a
      // much stronger real-work signal than bare presence), so there is nothing to reclassify.
      // stuck-backstop ALSO gets reclassified (EI-19295537569038753, see below) — it already
      // always records 'error' regardless, but "always error" only fixes the ok/error verdict,
      // not the REARM DELAY: a wedged turn that produces no lifecycle/turn-journal/presence
      // signal at all (e.g. a provider-wall reply with no tool call, so presence never bumps)
      // structurally can never reach the `if (signal)` branch above, so leaving stuck-backstop
      // unreclassified meant its own captured wedge text was fetched and then silently never
      // read — the loop kept re-firing at the bare interval into the same wall instead of the
      // reset-aware delay every other via already gets.
      let turnDeath: LoopLifecycleDeathVerdict | null = null;
      if (signal) {
        completedAt = signal.completedAt;
        via = signal.via;
        if (via === 'lifecycle' || via === 'turn-journal' || via === 'presence-quiescence') {
          turnDeath = classifyLoopLifecycleTurn(row.last_assistant_text_after_fire, intervalMs, nowMs);
        }
      } else {
        const deliveredWakeState = deliveredWakeWithoutLoopTurn(row, lastFiredMs, nowMs);
        if (deliveredWakeState?.kind === 'awaiting-turn') continue;
        const deliveredWakeRetryAt =
          deliveredWakeState?.kind === 'retry' ? deliveredWakeState.completedAt : null;
        // No healthy completion signal. A PARKED loop with NO post-fire activity is a
        // dead-or-stuck candidate — a legitimately long turn keeps producing activity, so its
        // last_active_at would be > last_fired and it is skipped here for free (no fire-state read).
        // Two ways such a loop needs the dead-owner terminal guard (WI-1399):
        //   • STUCK-PARK — parked past the dwell window (the original backstop trigger); OR
        //   • CIRCUIT-OPEN (EI-7006) — its fire-circuit already has ≥circuitThreshold consecutive
        //     failures. The circuit's ~hourly probe keeps refreshing last_fired, so `nowMs-last_fired`
        //     rarely reaches stuckParkMs and the stuck-park branch is STARVED; and even when reached,
        //     the 2h terminal-window floor exceeds the inter-probe gap so the guard never breaches.
        //     Routing a circuit-open loop to the guard directly (dwell window decoupled) is the fix
        //     for dead loops that otherwise climb to 55→∞ fire-circuit-open EIs and never terminate.
        // WI-6639: "has post-fire activity" must be qualified by "…and that activity is
        // RECENT". The original form compared two PAST instants (presence vs last_fired), so a
        // session that emitted one beat just after its final fire and then died looked
        // permanently "still in flight" and was `continue`d on every pass, forever. It strands
        // COLD loops specifically: the cold branch of completionSignal() has no
        // presence-quiescence fallback (a booted-but-idle session is indistinguishable from a
        // finished one), so a cold loop whose iteration never produced a lifecycle 'ended' or a
        // carry-note refresh reaches exactly this line with signal===null. Measured live:
        // 12 loops, ALL carry:'cold', parked at 'infinity' for 38h–160h, whose routine rows had
        // not been written since their fire (updated_at === last_fired_at to the second).
        // A legitimately long turn keeps beating, so it stays exempt via the recency term.
        const lastActiveMs = tsMs(row.presence_last_active_at) ?? 0;
        const fireStateLastFiredMs = tsMs(row.fire_state_last_fired_at);
        const fireStateLastWithheldMs = tsMs(row.fire_state_last_withheld_at);
        const lastWakeMs = tsMs(row.last_wake_at);
        // Production SELECT always returns all three keys (null means the ledger has no row).
        // Legacy/unit seams may omit them entirely; absence there is evidence-unavailable and
        // must fail open to the established quick/stuck ladders rather than manufacture a gap.
        const hasDispatchClockEvidence =
          Object.prototype.hasOwnProperty.call(row, 'fire_state_last_fired_at') &&
          Object.prototype.hasOwnProperty.call(row, 'fire_state_last_withheld_at') &&
          Object.prototype.hasOwnProperty.call(row, 'last_wake_at');
        const claimDispatchGap =
          hasDispatchClockEvidence &&
          row.parked &&
          nowMs - lastFiredMs >= claimDispatchGraceMs(intervalMs) &&
          lastActiveMs <= lastFiredMs &&
          (fireStateLastFiredMs == null || fireStateLastFiredMs < lastFiredMs) &&
          (fireStateLastWithheldMs == null || fireStateLastWithheldMs < lastFiredMs) &&
          (lastWakeMs == null || lastWakeMs < lastFiredMs);

        if (claimDispatchGap) {
          // claimDueRoutine already parked this pure loop at infinity, but every writer that
          // proves the action progressed is still older than the claim. This is not a long
          // turn: no turn was dispatched. Re-arm from the claim clock so the finite timestamp
          // is already due and the next routine tick retries immediately.
          completedAt = lastFiredMs;
          via = 'claim-dispatch-gap';
        } else {
          // EI-22171105225585428: disjunct 2 used to re-use `stuckParkMs` (30min-2h) as BOTH
          // the overall dwell AND the "how stale can the last beat be" staleness bar. Those are
          // different questions. `lastActiveMs` is OWNER-WIDE presence — activity from ANYTHING
          // the session does, not just this loop's woken turn — so a SINGLE stray beat (a
          // coord:glance on unrelated work) stays "fresh enough" by that same long bar for up to
          // the FULL dwell, silently short-circuiting the early continue below and starving the
          // quick-retry/stuck-park ladder from ever being consulted for as long as that one beat looks
          // recent. Measured live 2026-09-02: a stray beat ~30min into a park kept `nowMs -
          // lastActiveMs` under the 2h bar for the next ~100min, during which the loop's own
          // quick-retry/stuck-park logic below was never even reached.
          //
          // Fix: use the SAME staleness bar `completionSignal`'s presence-quiescence leg already
          // uses (FALLBACK_QUIET_MS, 60s) for "is this beat still fresh" — NOT the full dwell.
          // By construction, if control reaches here at all, presence-quiescence did NOT already
          // settle the fire (either the beat is still genuinely fresh, <60s old — the EI-7006
          // "healthy long turn" case, correctly still exempt below — or presence-quiescence's own
          // WI-6852 ingest-lag guard deferred a beat that IS already ≥60s stale by its own bar).
          // So bounding disjunct 2 at 60s never disagrees with presence-quiescence's verdict; it
          // just lets the pre-existing, already-tested quick-retry/stuck-park/dispatched-fire-in-
          // flight/gate-backoff ladder actually run once a beat is stale by that bar, instead of
          // an owner-wide-but-unrelated beat blocking it for up to the full dwell. The 30min-2h
          // dwell is still enforced further down via stuckParkElapsed exactly as before — this
          // only shortens how long a SINGLE stale beat can keep the row skipped "for free".
          const looksDeadOrStuck =
            row.parked && (lastActiveMs <= lastFiredMs || nowMs - lastActiveMs >= FALLBACK_QUIET_MS);
          if (deliveredWakeRetryAt == null && !looksDeadOrStuck) {
            continue; // still in flight (recent post-fire activity) / nothing to fold — leave it
          }
        // Read the fire-state ONCE (only on this quiet-parked path, so healthy loops pay nothing):
        // it drives BOTH the circuit-open decision and the stuck-fire count the guard consumes.
        // Fail-soft: a read failure is treated as zero prior errors (guard still consulted).
        const priorState = await runWithWorkspace(row.routine_workspace_id, () =>
          readFireState(row.install_slug, row.name),
        ).catch(() => null);
        const consecutiveErrors = priorState?.consecutiveErrors ?? 0;
        const circuitOpen = consecutiveErrors >= circuitThreshold();
        const stuckParkElapsed = nowMs - lastFiredMs >= stuckParkMs(intervalMs);
        // WI-2714 quick-retry leg: eligible ONLY before the classic dwell (stuckParkElapsed
        // already subsumes it), never once the circuit is open (that path is reserved for the
        // terminal guard's decoupled fast path below — quick-retrying a circuit-open loop would
        // just fight the circuit's own backoff), and only for a bounded few attempts.
        const quickRetryElapsed = nowMs - lastFiredMs >= quickRetryParkMs(intervalMs);
        const quickRetryEligible =
          quickRetryElapsed &&
          !stuckParkElapsed &&
          !circuitOpen &&
          quickRetryMaxAttempts() > 0 &&
          consecutiveErrors < quickRetryMaxAttempts();

        // Consult the dead-owner terminal guard when the loop is stuck-park OR circuit-open. Before
        // re-arming into the void yet again, check whether the owner is PERMANENTLY unreachable (no
        // injectable/resumable wake channel) — if so, auto-pause instead. Fail-soft: any probe/read
        // failure falls back to the normal stuck-backstop re-arm below (never blocks a retry on an
        // uncertain read).
        if (circuitOpen || stuckParkElapsed) {
          // stuckFireCount: on the circuit-open path the streak IS consecutiveErrors (already
          // ≥threshold); on the classic stuck-park path it is prior errors + this fire (+1),
          // preserving the original WI-1399 contract byte-for-byte when the circuit is closed.
          const stuckFireCount = circuitOpen ? consecutiveErrors : consecutiveErrors + 1;
          const guard = await checkUnreachableTerminalGuard({
            sql: db,
            routineId: row.id,
            targetOwnerId: row.target_owner_id,
            parkedForMs: nowMs - lastFiredMs,
            intervalMs,
            stuckFireCount,
            circuitOpen,
          }).catch((e) => {
            console.warn(
              `[loop-reconcile] unreachable-terminal-guard check failed for '${row.id}' — falling back to stuck-backstop retry: ${e instanceof Error ? e.message : e}`,
            );
            return { breach: false } as { breach: boolean; reason?: string };
          });
          if (guard.breach) {
            await terminateDeadLoop(row, guard.reason ?? 'unreachable dead-owner loop');
            continue; // auto-paused (active=false) inside the guard — do NOT re-arm below
          }
        }

        // Not terminated. Re-arm to retry when EITHER the classic stuck-park dwell has elapsed
        // (the original backstop behavior) OR the WI-2714 quick-retry leg is eligible (a bounded
        // early attempt, well before the classic dwell — see quickRetryEligible's doc above). A
        // circuit-open-but-not-breached loop that has reached neither is left untouched — the
        // fire-gate owns its cadence; re-arming it here would only fight the circuit's backoff.
        if (deliveredWakeRetryAt != null) {
          // The wake was accepted but never became a loop-origin turn. Re-arm
          // from the delivery clock after the bounded grace, while preserving
          // the terminal guard decision above.
          completedAt = deliveredWakeRetryAt;
          via = 'delivered-wake-no-loop-turn';
        } else if (!stuckParkElapsed && !quickRetryEligible) {
          // WI-36792: this `continue` was a SILENT HALT for a parked pure loop, and the comment
          // above states the false premise that made it look safe — "the fire-gate owns its
          // cadence". That is true for a cron/interval routine, which keeps being CLAIMED on
          // schedule so the gate is re-consulted until its backoff expires. It is false for a
          // pure loop: claimDueRoutine parks it at next_fire_at='infinity' at CLAIM time, and
          // the gate has no power to cause a claim. Nothing re-consults it, so the gate's own
          // `retry in ~Ns` is a promise nothing can keep and the loop is simply dead.
          //
          // Measured 2026-08-08 (my own loop, 2h44m halt): three stuck-backstop rescues each
          // fed 'error' into the SAME streak that gates them, so quickRetryEligible went false
          // at consecutiveErrors=3; the 4th claim at 21:54:31 was then DENIED by the gate
          // (consecutive_errors=4 ⇒ 60*2^3 = 480s backoff, recorded as `retry in ~454s`) and
          // this branch declined to re-arm. Zero transition rows for the next 71 minutes,
          // until the owner re-armed by hand.
          //
          // Fix: when the gate is the thing holding a PARKED loop, re-arm to the moment the
          // backoff expires — honoring it rather than fighting it. `evaluateFireGate` is pure
          // and `priorState` (a full FireState) is already read at the top of this path, so
          // this adds no query and no new failure surface. Guarded on `row.parked` so a
          // cron+loop with a live schedule is never pulled sooner by this leg.
          //
          // WI-2141029 (EI-22123519641932348): this leg rescues a claim the gate REFUSED. A fire
          // the gate ALLOWED reaches the very same shape for its first ~30s — no completion
          // signal yet, presence not bumped since the claim, circuit still open from the prior
          // streak — and re-arming it here UN-PARKS the row, so when the turn settles the next
          // tick takes the `!row.parked` armed-loop `continue` above and recordFire('ok') never
          // runs: consecutive_errors never decays, and every later fire repeats the hourly
          // re-arm. Measured 2026-09-02 on a 60s loop: fire 04:41:33Z → 'gate-backoff' re-arm
          // at 04:42:04Z (to 05:41Z) → turn settled 04:45:08Z → streak stayed 10, for ~4h across
          // four fires; an explicit loop:arm could not break it (its first fire was withheld too).
          // The two cases are told apart by the dispatch clock the SELECT already carries:
          // loop-fire's recordFire('attempt') advances autoloop_state.last_fired_at to ≥ the
          // claim's routines.last_fired_at, while a withhold writes only last_withheld_at and
          // leaves it older. Absent clock columns (legacy/unit seams) fail open to the WI-36792
          // behaviour. A dispatched turn that never settles is still caught by the
          // stuck-backstop once the dwell elapses — this only defers, never hides.
          const dispatchedFireInFlight =
            hasDispatchClockEvidence && fireStateLastFiredMs != null && fireStateLastFiredMs >= lastFiredMs;
          if (dispatchedFireInFlight) {
            continue; // a turn is running — stay parked so its settle records 'ok' and decays the streak
          }
          const gate = evaluateFireGate(priorState, new Date(nowMs));
          if (!row.parked || gate.allow || !gate.retryAfterSec || gate.retryAfterSec <= 0) {
            continue;
          }
          completedAt = nowMs;
          via = 'gate-backoff';
          gateRetryMs = gate.retryAfterSec * 1000;
          gateBackoffErrors = consecutiveErrors;
        } else {
          completedAt = lastFiredMs;
          via = 'stuck-backstop';
          if (quickRetryEligible && !stuckParkElapsed) quickRetry = true;
          // EI-19295537569038753: reclassify here too, not just on the `if (signal)` vias above —
          // see the comment block above this else/if for why this branch is exactly the one a
          // wedged (no-signal) provider-wall death reaches, and why it was previously unread.
          turnDeath = classifyLoopLifecycleTurn(row.last_assistant_text_after_fire, intervalMs, nowMs);
        }
        }
      }

      // EI-13818: a reclassified lifecycle-death re-arms after `turnDeath.rearmDelayMs` (reset-
      // aware for usage_limit, else the plain interval) instead of the blind interval — never
      // shorter than the interval either way.
      //
      // ⚠ This DELAY being longer never meant the stored next_fire_at moved later: the ordinary
      // statement below is never-later by construction, so a longer rearmMs was silently
      // DISCARDED whenever a nearer next_fire_at was already set (WI-6852 — the comment that
      // used to sit here claimed the opposite and is exactly what hid the bug). Only the
      // `deferPastWall` branch can actually push the next fire out.
      // WI-36792: a 'gate-backoff' re-arm targets the gate's own expiry, not the interval —
      // and never sooner than one interval, so it can never out-pace the loop's own cadence.
      const rearmMs = gateRetryMs != null ? Math.max(gateRetryMs, intervalMs) : (turnDeath?.rearmDelayMs ?? intervalMs);

      // WI-41228 (P-005) — ESCALATION RUNG R4. A fire can settle cleanly at the session layer
      // while the agent produces zero authored tool calls (expired bearer, split state, or a new
      // failure mode). Re-arming that shape forever is silent starvation. Count only after a
      // DISPATCHED fire has reached a settle/stuck decision: gate-backoff is deliberately excluded
      // because the gate refused the fire and no turn ran. The canonical counter excludes automatic
      // carry bookkeeping. A null read is evidence-unavailable, not zero, so it fails open.
      if (
        via !== 'gate-backoff' &&
        via !== 'claim-dispatch-gap' &&
        via !== 'delivered-wake-no-loop-turn'
      ) {
        // WI-2143038: the window runs to NOW, not to `completedAt`. `completedAt` is a
        // turn-SETTLED signal that can land before (or early in) the woken agent's actual
        // work — measured on the su-54215254 disarm: an agent-origin loop:status sat at
        // fire+81s and was still scored 0. Widening is fail-open by construction (a longer
        // window can only find MORE evidence), and any agent-authored call in the interval
        // refutes R4's premise directly: this session is not merely consuming wakes.
        const evidenceUntilMs = nowMs;
        const toolCalls = await runWithWorkspace(row.routine_workspace_id, () =>
          countAgentToolCallsInWindow(row.target_owner_id, lastFiredMs, evidenceUntilMs, {
            sql: db,
            evidenceScope: 'fire-productivity',
          }),
        ).catch((e) => {
          console.warn(
            `[loop-reconcile] zero-tool evidence read failed for '${row.id}' — leaving the existing re-arm path intact: ${e instanceof Error ? e.message : e}`,
          );
          return null;
        });

        if (toolCalls != null) {
          const fireToken = new Date(lastFiredMs).toISOString();
          const observation = await recordZeroToolFireObservation(db, {
            routineId: row.id,
            fireToken,
            toolCalls,
            threshold: zeroToolThreshold,
          }).catch((e) => {
            console.warn(
              `[loop-reconcile] zero-tool streak write failed for '${row.id}' — leaving the existing re-arm path intact: ${e instanceof Error ? e.message : e}`,
            );
            return null;
          });

          if (observation?.atThreshold) {
            const reason =
              `zero-tool escalation (WI-41228): ${observation.streak} consecutive dispatched turns ` +
              `recorded zero agent-authored tool calls (threshold=${observation.threshold}, ` +
              `last_fire=${observation.fireToken})`;
            // Pause FIRST so this fire cannot be re-armed below. Then reuse the existing terminal
            // path for attributed fire history, ghost-await cancellation, deduped human escalation,
            // and the loud terminal log. Cause-agnostic by design; no blind auto-respawn loop.
            await autoPauseLoopRoutine(db, row.id, reason, 'loop-zero-tool-escalation');
            await terminateDeadLoop(row, reason);
            continue;
          }
        }
      }

      // ── P-004 MONITOR STANDDOWN — decided BEFORE the re-arm, never after ────────────
      // A monitor loop is the one kind whose settlement can END it rather than re-arm it
      // (anti-babysitting-monitor-enforcement-2026-08-25, D-002 §3/§4). This is where the
      // persona rule "a non-owner's first no-delta wake is terminal" becomes mechanical:
      // the engine decrements the persisted budget on every quiet settled fire and
      // deactivates at zero, so an agent that forgets `loop:end` still stands down.
      //
      // Placed here — after every completion/termination guard, immediately before the
      // re-arm UPDATE — so a monitor cannot be re-armed and then retroactively ended.
      // A work loop parses to null and takes the unchanged path below.
      //
      // GATED ON A GENUINE SETTLE. `via` also carries the re-arms that happen when the
      // agent got NO TURN at all — `gate-backoff` (the fire was withheld), `stuck-backstop`
      // (the turn never settled), `claim-dispatch-gap` (the fire never reached dispatch) —
      // and `turnDeath` marks a turn the PROVIDER killed. Charging a quiet-wake unit for a
      // wake that was never delivered would stand a healthy monitor down for the scheduler's
      // failure, which is the opposite of what the budget measures. Written as an ALLOWLIST
      // so a via added later defaults to "not a settle" and fails toward keeping the loop.
      const settledTurnVia =
        turnDeath == null &&
        (via === 'lifecycle' || via === 'turn-journal' || via === 'presence-quiescence' || via === 'note-refresh');
      const monitorConfig = settledTurnVia ? readPersistedMonitorConfig(row.payload_template) : null;
      if (monitorConfig) {
        // The authority reads resolve work-items / presence / fleets, which are
        // workspace-scoped stores — run them under THIS routine's workspace, the same way
        // every other cross-store call in this loop does, so a multi-workspace tick cannot
        // judge one workspace's monitor against another's rows.
        const authority = await runWithWorkspace(row.routine_workspace_id, () =>
          recheckMonitorAuthority({
            ownerId: row.target_owner_id,
            workspaceId: row.routine_workspace_id,
            harness: row.install_slug,
            config: monitorConfig,
          }),
        ).catch((e) => ({
          // FAIL-OPEN, matching engine-loop-standdown.ts: an unreadable authority must
          // never manufacture a standdown. A missed standdown costs one throttled wake;
          // a wrong one silently kills a legitimate owner's watch.
          ok: 'unknown' as const,
          message: `monitor authority recheck threw: ${e instanceof Error ? e.message : String(e)}`,
        }));
        const settlement = decideMonitorSettlement({
          config: monitorConfig,
          deltaObserved: monitorDeltaObservedForFire({
            monitorDeltaAt: row.monitor_delta_at,
            lastFiredAt: row.last_fired_at,
          }),
          authority,
        });
        if (settlement.action === 'standdown') {
          const stoodDown = await standDownMonitorLoop(db, row.id, settlement).catch((e) => {
            console.warn(
              `[loop-reconcile] monitor standdown write failed for '${row.id}' — leaving the loop armed: ${e instanceof Error ? e.message : e}`,
            );
            return false;
          });
          if (stoodDown) {
            result.terminated.push({
              id: row.id,
              targetOwnerId: row.target_owner_id,
              reason: settlement.reason,
            });
            continue;
          }
          // The write found no active row (a concurrent loop:end / pause already won).
          // Nothing left to re-arm either — this settled fire is done.
          continue;
        }
        // Survived: persist the decremented (or delta-reset) budget, then fall through to
        // the ordinary re-arm. A failed budget write must NOT re-arm with a stale budget —
        // that would make the bound unenforceable — so treat it as "settle again next pass".
        // The fire token makes the decrement exactly-once even if two passes overlap.
        const budgetWritten = await persistMonitorNoDeltaBudget(
          db,
          row.id,
          settlement.remainingNoDeltaBudget,
          String(lastFiredMs),
        ).catch((e) => {
          console.warn(
            `[loop-reconcile] monitor budget write failed for '${row.id}' — skipping this re-arm: ${e instanceof Error ? e.message : e}`,
          );
          return false;
        });
        if (!budgetWritten) continue;
      }

      // Pass an ISO STRING + explicit ::timestamptz cast, NOT a Date object: the operator's
      // pooled `prepare: false` connection rejects a Date bind param ("the string argument must
      // be … Received an instance of Date") — the write-side mirror of the string-read quirk
      // (EI-2549). A string + cast binds cleanly on BOTH that connection and a direct one.
      // EI-22346847925961653: reconcile can run long after a completion signal landed. Never
      // leave an active AUTO loop with an already-expired finite next_fire_at; if the
      // completion-relative candidate is stale, start a fresh interval from this pass's clock.
      const rearmAtMs = futureRearmAtMs(completedAt, rearmMs, nowMs, intervalMs);
      const reArmIso = new Date(rearmAtMs).toISOString();

      // WI-6852: a USAGE-LIMIT death is the one case that must be allowed to push next_fire_at
      // LATER. The general statement below is never-later BY CONSTRUCTION (LEAST, plus a WHERE
      // that only matches 'infinity' or a next_fire_at already beyond X), which SILENTLY DROPPED
      // the reset-aware re-arm whenever a blind re-arm had already won the ingest race and set
      // next_fire_at = completedAt + interval: infinity? no; (now+300s) > (now+3h)? no; zero rows
      // updated. The loop then kept its bare-interval cadence and hammered the still-active wall
      // — measured 295 wasted fires across 58 owners in 10 days, each one a killed respawn, with
      // one owner re-firing 30x over 2h40m and stopping only when the wall itself lifted.
      // Gated on a reset-aware verdict (rearmMs > intervalMs proves an instant was actually
      // parsed from the turn's own text), so no other path can push a loop's cadence out.
      const deferPastWall = turnDeath?.reason === 'usage_limit' && rearmMs > intervalMs;

      // ONE statement for BOTH kinds (d5a84's LEAST tip):
      //   pure loop parked  → next_fire_at='infinity' matches → LEAST(infinity, X) = X (re-arm)
      //   cron+loop (armed) → guarded by next_fire_at > X → LEAST(cron-next, X) = X (fold sooner)
      // Idempotent + never-backwards: a re-armed loop sits at X (a finite past/future time);
      // the first disjunct (=infinity) no longer matches and the second (next_fire_at > X) is
      // false, so a re-pass is a no-op. A cron fire that is already sooner than X is left
      // untouched (the WHERE never matches), so a cron's cadence is never delayed.
      // The wall branch is the MIRROR of that statement (WI-6852): same shape, inverted
      // direction. GREATEST + (next_fire_at < X) only ever moves the next fire OUT to X, and a
      // parked loop still re-arms from 'infinity'. Idempotent for the same reason: after it runs
      // next_fire_at = X, so neither disjunct matches on a re-pass. A wall already scheduled
      // FURTHER out than X is left untouched, so the longest known wall always wins.
      const updated = deferPastWall
        ? await db<{ id: string }[]>`
            UPDATE harness_shared.routines
               SET next_fire_at = CASE
                     WHEN next_fire_at = 'infinity'::timestamptz THEN ${reArmIso}::timestamptz
                     ELSE GREATEST(next_fire_at, ${reArmIso}::timestamptz)
                   END,
                   updated_at = now()
             WHERE id = ${row.id}
               AND reschedule_interval_sec IS NOT NULL
               AND ( next_fire_at = 'infinity'::timestamptz
                     OR next_fire_at < ${reArmIso}::timestamptz )
            RETURNING id
          `
        : await db<{ id: string }[]>`
        UPDATE harness_shared.routines
           SET next_fire_at = LEAST(next_fire_at, ${reArmIso}::timestamptz), updated_at = now()
         WHERE id = ${row.id}
           AND reschedule_interval_sec IS NOT NULL
           AND ( next_fire_at = 'infinity'::timestamptz
                 OR next_fire_at > ${reArmIso}::timestamptz )
           -- EI-21122026530854360: the SELECT above is intentionally unlocked, so a pure
           -- loop may have been re-armed by loop:arm after this row said it was parked. Do
           -- not let that stale snapshot fold the fresh finite schedule backwards. A cron+loop
           -- remains eligible for the existing never-later LEAST fold; only a pure loop must
           -- still be parked when this completion re-arm wins.
           AND ( jsonb_exists(trigger_config, 'cron')
                 OR next_fire_at = 'infinity'::timestamptz )
        RETURNING id
      `;
      if (updated.length > 0) {
        result.rearmed++;
        result.loops.push({
          id: row.id,
          targetOwnerId: row.target_owner_id,
          completedAt,
          nextFireAt: rearmAtMs,
          via,
          ...(quickRetry ? { quickRetry: true } : {}),
        });
        // EI-19411045952024591: record the RE-ARM durably — the closing half of the park
        // recorded by claimDueRoutine. This is the row whose ABSENCE is the fault: a loop
        // that parks and never re-arms leaves a `parked` row with no `rearmed` successor,
        // which is precisely the evidence the 2026-08-03 45min fire outage lacked. Also
        // stamps the park DURATION this re-arm just closed (last_fired_at is set at park
        // time by claimDueRoutine), so a creeping re-arm latency is visible BEFORE it
        // becomes an outage rather than only after. Not awaited — instrument, not control.
        const parkedSinceMs = row.last_fired_at ? new Date(row.last_fired_at as any).getTime() : NaN;
        void recordLoopTransition(db, {
          workspaceId: row.routine_workspace_id,
          installSlug: row.install_slug,
          routineId: row.id,
          routineName: row.name,
          targetOwnerId: row.target_owner_id,
          event: 'rearmed',
          actor: 'reconcile-loop-routines',
          newNextFireAt: reArmIso,
          intervalSec: row.interval_sec,
          detail: {
            via,
            wasParked: !!row.parked,
            ...(deferPastWall ? { deferPastWall: true } : {}),
            ...(quickRetry ? { quickRetry: true } : {}),
            ...(Number.isFinite(parkedSinceMs) ? { parkedMs: Date.now() - parkedSinceMs } : {}),
          },
        });
        // Feed the autoloop circuit (loop-wake-rate-limit-robustness P0b). A completed turn
        // (lifecycle / presence-quiescence) is SUCCESS → recordFire('ok') resets the streak;
        // a stuck-park re-arm is a dead / never-delivered turn → recordFire('error') feeds
        // the existing backoff + circuit. CHANNEL-AGNOSTIC: this catches inject-path deaths
        // the resume-exit observer can't see, and is the durable fallback when that observer
        // is missed (operator restart between spawn and exit). Run under the loop's own
        // workspace so the (ws, install_slug, name) key matches the fire side exactly.
        // EI-13818: a reclassified lifecycle-death is ALSO an 'error' (a false 'ok' is exactly
        // the bug) — checked first since it overrides an otherwise-'ok' lifecycle via.
        // WI-36792: the 'gate-backoff' via records NO outcome at all, and this asymmetry is
        // load-bearing rather than an oversight. That re-arm observed nothing about the turn —
        // it only rescheduled a claim the gate had already refused. 'ok' would RESET
        // consecutive_errors and erase the very streak the backoff is computed from (the loop
        // would then re-fire immediately and read as healthy); 'error' would double-count a
        // failure already recorded by the fire path. Leaving the streak untouched keeps the
        // gate's own clock — autoloop_state.last_fired_at, which a withhold deliberately does
        // not advance — the single authority on when the retry is due.
        const outcome: 'ok' | 'error' | null =
          via === 'gate-backoff'
            ? null
            : turnDeath != null ||
                via === 'stuck-backstop' ||
                via === 'claim-dispatch-gap' ||
                via === 'delivered-wake-no-loop-turn'
              ? 'error'
              : 'ok';
        if (outcome != null) {
          const fireDetail = turnDeath ? `loop-lifecycle-death:${turnDeath.reason}` : `loop-${via}`;
          await runWithWorkspace(row.routine_workspace_id, () =>
            recordFire(row.install_slug, row.name, fireDetail, outcome),
          ).catch((e) =>
            console.warn(
              `[loop-reconcile] recordFire('${outcome}') failed for '${row.id}': ${e instanceof Error ? e.message : e}`,
            ),
          );
        }
        if (turnDeath) {
          console.warn(
            `[loop-reconcile] loop '${row.id}' (owner ${row.target_owner_id}) turn completed CLEANLY but its ` +
              `text was a provider kill ('${turnDeath.reason}') — recorded 'error' + re-armed ` +
              `+${Math.round(rearmMs / 1000)}s instead of the bare interval`,
          );
          await runWithWorkspace(row.routine_workspace_id, () =>
            escalateLifecycleDeath({
              routineId: row.id,
              targetOwnerId: row.target_owner_id,
              installSlug: row.install_slug,
              name: row.name,
              verdict: turnDeath!,
            }),
          ).catch((e) =>
            console.warn(
              `[loop-reconcile] escalateLifecycleDeath failed for '${row.id}': ${e instanceof Error ? e.message : e}`,
            ),
          );
        }
        if (via === 'stuck-backstop') {
          console.warn(
            `[loop-reconcile] loop '${row.id}' (owner ${row.target_owner_id}) parked ` +
              `${Math.round((nowMs - lastFiredMs) / 1000)}s with no completion signal — re-armed to retry ` +
              `(circuit fed 'error'${quickRetry ? ', WI-2714 quick-retry leg' : ''})`,
          );
        }
        if (via === 'delivered-wake-no-loop-turn') {
          console.warn(
            `[loop-reconcile] loop '${row.id}' (owner ${row.target_owner_id}) wake was marked ` +
              `delivered at ${new Date(completedAt).toISOString()} but no loop-origin assistant turn ` +
              `was observed after the bounded grace — re-armed to retry (circuit fed 'error')`,
          );
        }
        if (via === 'gate-backoff') {
          // WI-36792: without this line the rescue is invisible — the failure it fixes produced
          // NO log, no fire row and no transition row for 71 minutes, which is precisely why it
          // took three sessions to find. Name the streak so a loop stuck behind a genuinely
          // broken fire path is distinguishable from one riding a transient backoff.
          console.warn(
            `[loop-reconcile] loop '${row.id}' (owner ${row.target_owner_id}) was parked at 'infinity' ` +
              `with the fire-gate withholding (consecutive_errors=${gateBackoffErrors}) — re-armed ` +
              `+${Math.round(rearmMs / 1000)}s to the moment the backoff expires; circuit left UNTOUCHED`,
          );
        }
      }
    } catch (e) {
      console.warn(
        `[loop-reconcile] row '${row.id}' (owner ${row.target_owner_id}) failed to rebase — SKIPPED ` +
          `(other loops unaffected): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
    }
  }

  return result;
}
