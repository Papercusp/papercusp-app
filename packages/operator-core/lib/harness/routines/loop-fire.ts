/**
 * Loop fire — a loop routine's fire ACTION (loop-routines-interval-recurrence-2026-06-20
 * P-004 / D-005 / D-006, B-LOOP-3). Carved out of `dbos/routines-workflow.ts` so the fire
 * semantics are testable without importing the DBOS workflow module.
 *
 * A "loop" (su-d5a84's B-LOOP-1 third recurrence kind: `reschedule_interval_sec` set, no
 * cron/rrule, bound to a `target_owner_id`) does NOT spawn a role or run a system action when
 * it fires. It delivers a WARM `coord` wake to its pinned su session — the same session/
 * context continues across iterations (behave like Claude /loop, but engine-tracked). The
 * wake rides the SHIPPED wake-executor liveness ladder (await-event-primitive-2026-06-05
 * P-004): alive+injectable → inject the wake turn; exited → `claude --resume <sid>`; alive-
 * but-uninjectable → park → resume when the pid dies. The loop owns NO resume code (D-005) —
 * `wakeRecipients` fires the recipient's own `coord:inbox-wake:<ownerId>` key and the executor
 * picks the channel. Transcript growth across iterations is the agent harness's job (native
 * compaction), not the loop's.
 *
 * Two guardrails gate the fire (D-006): the EXISTING failure-streak fire-gate (`checkFireGate`,
 * keyed per-loop by the routine name) and the new COST cap (`checkLoopCostCap`). Tracking
 * otherwise piggybacks on the existing layers — routine fire-history (`recordFire`) + the
 * work-queue (the kickoff tells the agent to create + self-assign its work_items) + plan
 * progress — so no per-fire plan_run is minted (D-006).
 *
 * The completion-rebase that re-arms the parked loop after its turn settles is su-15ea2's
 * B-LOOP-2 (`reconcile-loop-routines.ts`), wired as its own early `loop-rebase-sweep` step
 * in routinesTickImpl (Task-#8, 2026-07-03); this module only delivers the fire.
 */
import type { Sql } from 'postgres';
import {
  checkFireGate as defaultCheckFireGate,
  recordFire as defaultRecordFire,
  recordWithheld as defaultRecordWithheld,
} from '../../autoloop';
import { wakeRecipients as defaultWakeRecipients } from '../../agent-tools/coordination/inbox-wake';
import { listParkedAwaitsForSubscribers } from '../../events/await/store';
import {
  getLoopCarryNote as defaultGetLoopCarryNote,
  getLoopCarryNoteWithMeta as defaultGetLoopCarryNoteWithMeta,
  renderCheckLine,
  splitCarryNoteChecks,
  splitCarryNoteWalls,
  type CheckEntry,
  type WallEntry,
} from '../../carry-note';
import { getOrgPg } from '@papercusp/db-org';
import { assessGoalStaleness, extractGoalWorkItemIds } from './loop-goal-staleness';
import { assessGoalFactDivergence, type CorrectedFact } from './loop-goal-fact-divergence';
import {
  assessBlockerLiveness,
  type BlockerLiveness,
  type LoopBlockedOnRecord,
} from './loop-blocker-liveness';
import { resolveSessionStates } from '../../agent-tools/coordination/liveness-oracle';
import { checkLoopCostCap as defaultCheckLoopCostCap } from './loop-cost-cap';
import {
  renderWallNagLine,
  takeLoopWallNag as defaultTakeLoopWallNag,
} from './loop-wall-nag';
import {
  extractWakeRecipeQuery,
  findTopRecipeForWake as defaultFindTopRecipeForWake,
  renderWakeRecipeLine,
} from './loop-wake-recipe';
import {
  checkLoopDeadMan as defaultCheckLoopDeadMan,
  incrementLoopFireCount as defaultIncrementLoopFireCount,
  readLoopFireCount as defaultReadLoopFireCount,
  readLoopLastDeliveredAtMs as defaultReadLoopLastDeliveredAtMs,
} from './loop-dead-man';
import { recordLoopTransition } from './loop-transition-log';
import {
  armInboxWake as defaultArmInboxWake,
  ensureInboxWakeArmedForActiveSession as defaultEnsureWakeArmed,
} from '../../events/await/inbox-wake-arm';

/** The wake-turn text delivered when the loop's row carries no explicit kickoff. Mirrors the
 *  D-006 / B-LOOP-5 convention: each wake, create + SELF-ASSIGN this iteration's work_items
 *  (so the loop's work rides the work-queue / fleet:assignments), work them, then end the turn
 *  (the loop re-arms `interval` sec after the turn settles). */
export function defaultLoopKickoff(routineId: string): string {
  return (
    `Loop '${routineId}' fired. Continue working your plan for this iteration: create + ` +
    `self-assign your work_items (work_items:create { assign_to: <your ownerId> }), work them ` +
    `and set_state as you go, update plan progress, then end your turn — the loop re-arms after ` +
    `it settles.`
  );
}

export interface LoopFireInput {
  routineId: string;
  /** The fire-gate role key — the routine NAME gives per-loop failure-streak tracking + a
   *  readable autoloop:status row. */
  routineName: string;
  workspaceId: string;
  installSlug: string;
  /** The pinned session's coord ownerId the warm wake targets (su-d5a84's target_owner_id). */
  targetOwnerId: string;
  /** The routine's payload_template — carries the loop's `kickoff` (wake-turn text) +
   *  optional `costCapCents` (the cost-cap). */
  payloadTemplate: Record<string, unknown> | null;
  /** The loop's interval (routines.reschedule_interval_sec) — the P-002 checkpoint
   *  staleness ceiling scales with it. Optional/back-compat: absent ⇒ the 30min floor. */
  intervalSec?: number | null;
  /** Seam for the cost-cap's DB reads/writes (defaults to the admin pool). */
  sql?: Sql;
}

export interface LoopFireDeps {
  checkFireGate?: typeof defaultCheckFireGate;
  recordFire?: typeof defaultRecordFire;
  /** EI-14483: record a fire-gate withhold to a durable, queryable trail (separate from
   *  recordFire's backoff-clock columns) so "attempted-and-denied" is distinguishable from
   *  "never attempted" after the fact. */
  recordWithheld?: typeof defaultRecordWithheld;
  wake?: typeof defaultWakeRecipients;
  costCap?: typeof defaultCheckLoopCostCap;
  deadMan?: typeof defaultCheckLoopDeadMan;
  incrementFireCount?: typeof defaultIncrementLoopFireCount;
  /** su-cold-auto P-003: read the prior fire count for the cold wakeCount cadence. */
  readFireCount?: typeof defaultReadLoopFireCount;
  /** P-024: read when the loop last REACHED its owner (the blocking-await heartbeat anchor).
   *  Only consulted when a blocking await exists; a failed read ⇒ null (pre-heartbeat ceiling). */
  readLastDeliveredAt?: typeof defaultReadLoopLastDeliveredAtMs;
  /** EI-7809: read the CURRENT loop:checkpoint at fire time so wake text does not stale at arm time. */
  getLoopCarryNote?: typeof defaultGetLoopCarryNote;
  /** P-002: the meta-carrying read (note + write instant) the staleness stamp needs. */
  getLoopCarryNoteWithMeta?: typeof defaultGetLoopCarryNoteWithMeta;
  /** P-005c: the top-recipe lookup the SHORT wake form splices (fail-soft, time-bounded). */
  findWakeRecipe?: typeof defaultFindTopRecipeForWake;
  /** P-006: read-and-clear the pending turn-settle wall nag (fail-soft). */
  takeWallNag?: typeof defaultTakeLoopWallNag;
  /** EI-19501119110607678: resolve the CURRENT state of the work-items the frozen goal
   *  names, so the wake can say the goal is stale instead of merely warning that it
   *  might be. Fail-soft: a failed read must yield an EMPTY map (⇒ every id unresolved
   *  ⇒ no staleness claim at all), never a partial one that could read as "finished". */
  readGoalItemStates?: typeof defaultReadGoalItemStates;
  /** EI-21459285533379701: read this loop's arm time plus the owner's standing facts
   *  whose CURRENT version superseded an earlier one, so the wake can say the goal
   *  echoes a claim its author has since withdrawn. Fail-soft the same way
   *  `readGoalItemStates` is: a failed read yields a null arm time and an EMPTY list
   *  (⇒ no claim at all), never a partial one that could read as an all-clear. */
  readGoalFactCorrections?: typeof defaultReadGoalFactCorrections;
  /** EI-21526226279199560: injected in tests so the blocker-liveness stamp needs no PG. */
  readBlockerLiveness?: typeof defaultReadBlockerLiveness;
  /** EI-11484: fetch + render the OPEN OWNER DIRECTIVES block for the wake's
   *  workspace (defaults to renderOpenOwnerDirectivesBlock). Best-effort. */
  renderOwnerDirectives?: (
    workspaceId: string | null | undefined,
    opts?: { sql?: Sql; viewerOwnerId?: string | null },
  ) => Promise<string | null>;
  /** EI-10901: read the owner's currently-active BLOCKING awaits (defaults to
   *  listParkedAwaitsForSubscribers, scoped to one owner). */
  listBlockingAwaits?: (targetOwnerId: string) => Promise<BlockingAwaitLike[]>;
  /** EI-21350609923930437: re-arm a parked pure loop at the suppression threshold before
   *  withholding its wake. Injected for tests; a failed write fails open and delivers the
   *  wake rather than leaving the claimed row parked forever. */
  rescheduleSuppressedWake?: (input: SuppressedLoopRearmInput) => Promise<boolean>;
  /** EI-18673998482704275-followup (WI-5862): self-heal seam for a `!reached` miss —
   *  defaults to ensureInboxWakeArmedForActiveSession (a live adv_sessions row but no
   *  active standing inbox-wake await ⇒ re-arm it and report true). Injected for tests. */
  ensureWakeArmed?: typeof defaultEnsureWakeArmed;
  /** EI-21417550055038906 (cold-carry delivery): arm the standing inbox-wake
   *  DIRECTLY (no live-session gate) so the wake-executor's resume channel can
   *  cold-respawn a between-fires owner. Injectable for tests. */
  armWakeForColdRespawn?: typeof defaultArmInboxWake;
}

export interface LoopFireResult {
  fired: boolean;
  /** Why a fire was withheld (when fired=false). */
  reason?: 'no-target' | 'fire-gate' | 'cost-cap' | 'dead-man' | 'no-session-now' | 'await-blocking';
  woken?: number;
  staged?: number;
  detail?: string;
}

// ── Blocking-await suppression (EI-10901) ────────────────────────────────
//
// "checkpoint:await says 'END YOUR TURN, do not poll' and then the 60s loop polls you
// anyway": an agent that deliberately parked on `events:await`/`watch:create` (a real,
// non-standing wait — NOT the always-armed inbox-wake self-await, NOT a standing
// `announce` row) should not also be interrupted by its own loop's routine wake — that
// re-injects the full loop contract + carry-note just to report "still waiting," the
// exact empty-wake cost the "do not poll" contract tells the agent to avoid.
//
// Reuses `listParkedAwaitsForSubscribers` — the SAME "is this owner deliberately parked
// on a real event" read `fleet:assignments` / `bench` / `presence` / claim-discipline
// already derive bench state from (EI-9014) — rather than inventing new await-kind
// semantics: it already excludes the `coord:inbox-wake:%` liveness self-await and
// `policy = 'announce'` rows.

/** A blocking-await row's minimal shape the suppression decision needs. */
export interface BlockingAwaitLike {
  eventKey: string;
  /** ISO deadline, or null = no deadline set on the await itself. */
  expiresTs: string | null;
  /** ISO creation time — the suppression-quiet clock's origin (no new state needed). */
  createdAt: string;
  /** Platform-authored lifecycle binding; manual events:await leaves it null. */
  boundTo?: { kind: string; ref: string } | null;
}

/** Inputs for the parked-loop re-arm that accompanies await suppression. */
export interface SuppressedLoopRearmInput {
  routineId: string;
  workspaceId: string;
  installSlug: string;
  routineName: string;
  targetOwnerId?: string | null;
  intervalSec?: number | null;
  /** The earliest threshold at which the suppression decision must be revisited. */
  resumeAtMs: number;
  /** The await that caused this re-arm, for forensic transition detail. */
  drivingEventKey?: string;
  /** Injectable for tests; production falls back to the operator's org connection. */
  sql?: Sql;
}

/** Ceiling on how long a blocking await may silence loop wakes, measured from the
 *  await's OWN creation — independent of its `expiresTs` (which may be null / far
 *  future). Bounds a stuck-forever await (emitter bug, cancelled-without-cleanup, …)
 *  from permanently silencing the loop: past this bound the routine wake resumes on
 *  its normal cadence regardless of the await still being active (mirrors the
 *  `loopCheckpointStaleMs` 30-minute floor used elsewhere in this file). */
export const LOOP_AWAIT_SUPPRESSION_MAX_QUIET_MS = 30 * 60_000;

/** P-024 (review-system-rework-reduction-2026-09-23): once the max-quiet window has
 *  elapsed and a heartbeat fire has been DELIVERED during the await, the next fire is held
 *  until `lastDeliveredAt + LOOP_AWAIT_HEARTBEAT_MS` (still capped by the await's own
 *  deadline). Before this, the max-quiet window lifted suppression outright: su-77b3a99d
 *  (2026-09-23) was quiet 01:46→02:16Z, then took 8 full loop turns by 04:22Z while its
 *  owner-answer await stayed open until 09:12Z. The heartbeat keeps the stuck-await
 *  safety the max-quiet bound exists for — the agent still wakes, just once per period. */
export const LOOP_AWAIT_HEARTBEAT_MS = 60 * 60_000;

export interface LoopAwaitSuppressionDecision {
  suppress: boolean;
  /** Earliest moment (ms epoch) suppression is expected to lift — null when not suppressed. */
  resumeAtMs: number | null;
  /** The blocking await that drove the decision (earliest-resuming, when suppressed). */
  drivingEventKey?: string;
}

/** Pure decision: given the owner's currently-active blocking awaits, should THIS
 *  routine wake be withheld? `resumeAtMs` per await = min(its own deadline, its
 *  creation + maxQuietMs) — "an await near deadline must not silence the routine
 *  past its fallback" (the recommended plan this item's checkpoint left). Suppressed
 *  while ANY await's resumeAtMs is still in the future; the reported `resumeAtMs` is
 *  the EARLIEST such threshold (a self-correcting re-check — if another await is
 *  still fresh, the next tick simply re-suppresses). No awaits ⇒ never suppress
 *  (today's behavior, byte-identical).
 *
 *  P-024 heartbeat: when `lastDeliveredAtMs` shows a loop fire already REACHED the owner
 *  during this await (at/after its creation), the quiet ceiling stretches to
 *  `max(createdAt + maxQuiet, lastDelivered + heartbeat)` — one liveness fire per
 *  heartbeat period for as long as the await stays open. A delivery before the await was
 *  created, or an unknown (`null`/absent) delivery time, keeps the pre-heartbeat ceiling. */
export function decideLoopAwaitSuppression(input: {
  awaits: ReadonlyArray<BlockingAwaitLike>;
  nowMs: number;
  maxQuietMs?: number;
  /** Epoch ms the loop last reached its owner; null/absent = unknown. */
  lastDeliveredAtMs?: number | null;
  heartbeatMs?: number;
}): LoopAwaitSuppressionDecision {
  const maxQuietMs =
    typeof input.maxQuietMs === 'number' && Number.isFinite(input.maxQuietMs) && input.maxQuietMs > 0
      ? input.maxQuietMs
      : LOOP_AWAIT_SUPPRESSION_MAX_QUIET_MS;
  const heartbeatMs =
    typeof input.heartbeatMs === 'number' && Number.isFinite(input.heartbeatMs) && input.heartbeatMs > 0
      ? input.heartbeatMs
      : LOOP_AWAIT_HEARTBEAT_MS;
  const lastDeliveredAtMs =
    typeof input.lastDeliveredAtMs === 'number' && Number.isFinite(input.lastDeliveredAtMs)
      ? input.lastDeliveredAtMs
      : null;
  let earliestResumeAtMs = Infinity;
  let drivingEventKey: string | undefined;
  for (const a of input.awaits) {
    // EI-22433430601034541: holding a blocked aggregate auto-arms these watches
    // even while another owned item is actionable. Only a caller-owned park
    // may pause the work loop. Keep the watch itself for its eventual wake.
    if (a.boundTo?.kind === 'work-item-blocked') continue;
    const createdAtMs = Date.parse(a.createdAt);
    if (!Number.isFinite(createdAtMs)) continue; // malformed row — never suppress on it
    const heartbeatCeilingMs =
      lastDeliveredAtMs != null && lastDeliveredAtMs >= createdAtMs ? lastDeliveredAtMs + heartbeatMs : -Infinity;
    const quietCeilingMs = Math.max(createdAtMs + maxQuietMs, heartbeatCeilingMs);
    const deadlineMs = a.expiresTs ? Date.parse(a.expiresTs) : NaN;
    const resumeAtMs = Number.isFinite(deadlineMs) ? Math.min(deadlineMs, quietCeilingMs) : quietCeilingMs;
    if (input.nowMs < resumeAtMs && resumeAtMs < earliestResumeAtMs) {
      earliestResumeAtMs = resumeAtMs;
      drivingEventKey = a.eventKey;
    }
  }
  if (!Number.isFinite(earliestResumeAtMs)) return { suppress: false, resumeAtMs: null };
  return { suppress: true, resumeAtMs: earliestResumeAtMs, drivingEventKey };
}

/** Default resolver: the owner's active BLOCKING awaits (excludes the standing
 *  inbox-wake self-await + `announce` rows — see `listParkedAwaitsForSubscribers`). */
async function defaultListBlockingAwaits(targetOwnerId: string): Promise<BlockingAwaitLike[]> {
  const rows = await listParkedAwaitsForSubscribers([targetOwnerId]);
  return rows.map((r) => ({ eventKey: r.eventKey, expiresTs: r.expiresTs, createdAt: r.createdAt, boundTo: r.boundTo }));
}

/**
 * Move a claimed pure loop off the in-flight `infinity` sentinel when its wake is withheld
 * because the owner is parked on a blocking await. `claimDueRoutine` parks pure loops at
 * infinity before calling `fireLoopWake`; without this write, returning from the suppression
 * guard permanently removes the row from the due scan and the computed `resumeAtMs` is dead
 * data. The infinity predicate also makes this CAS safe against a concurrent loop:arm or
 * completion re-arm that already installed a finite schedule.
 */
export async function rescheduleLoopAfterAwaitSuppression(input: SuppressedLoopRearmInput): Promise<boolean> {
  if (!Number.isFinite(input.resumeAtMs)) return false;
  const db = input.sql ?? getOrgPg().sql;
  const resumeAtIso = new Date(input.resumeAtMs).toISOString();
  const rows = await db<{ id: string }[]>`
    UPDATE harness_shared.routines
       SET next_fire_at = GREATEST(now(), ${resumeAtIso}::timestamptz),
           updated_at = now()
     WHERE id = ${input.routineId}
       AND active = TRUE
       AND reschedule_interval_sec IS NOT NULL
       AND next_fire_at = 'infinity'::timestamptz
       AND NOT jsonb_exists(trigger_config, 'cron')
       AND NOT jsonb_exists(trigger_config, 'rrule')
     RETURNING id
  `;
  if (rows.length > 0) {
    // EI-21388574737613226: this re-arm closes the `parked` transition written by
    // claimDueRoutine. Without the matching row, the forensic ledger falsely reports a
    // parked loop with no successor even though await suppression successfully restored its
    // schedule. Keep this fire-and-forget just like the other transition call sites: the
    // instrument must never turn a successful scheduling CAS into a failed wake.
    void recordLoopTransition(db, {
      workspaceId: input.workspaceId,
      installSlug: input.installSlug,
      routineId: input.routineId,
      routineName: input.routineName,
      targetOwnerId: input.targetOwnerId,
      event: 'rearmed',
      actor: 'await-suppression',
      newNextFireAt: resumeAtIso,
      intervalSec: input.intervalSec,
      detail: {
        via: 'await-suppression',
        ...(input.drivingEventKey ? { drivingEventKey: input.drivingEventKey } : {}),
      },
    });
  }
  return rows.length > 0;
}

/** Read the loop kickoff (wake-turn text) from the routine's payload_template, if any. */
export function readLoopKickoff(payloadTemplate: Record<string, unknown> | null): string | undefined {
  const k = payloadTemplate?.kickoff;
  return typeof k === 'string' && k.trim() ? k : undefined;
}

/** Read the loop cost-cap (cents) from the routine's payload_template, if a positive number. */
export function readLoopCostCapCents(payloadTemplate: Record<string, unknown> | null): number | null {
  const c = payloadTemplate?.costCapCents;
  return typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : null;
}

export const LOOP_WAKE_CHECKPOINT_MAX_CHARS = 3_000;

/** Settled checks are durable history, not a per-wake action queue. Keep only the
 * newest row expanded; older verified rows remain addressable by stable id in one
 * summary line. Predicted/contested rows are never compacted. */
export const LOOP_WAKE_EXPANDED_VERIFIED_CHECKS = 1;

/** EI-18187907490692276: clip an over-long carry-note for a wake prompt WITHOUT dropping
 *  the load-bearing tail. A loop:checkpoint carry-note is authored Did → Left → Insight →
 *  Next action, so the single most load-bearing section — `## Next action`, i.e. what to
 *  actually DO this wake — sits at the END. A plain head-keep `note.slice(0, max)` therefore
 *  truncates exactly that (observed live 2026-07-20: a warm loop-fire cut the Next action
 *  mid-word at "acknowled…", stranding the concrete next command). Instead keep a HEAD + the
 *  load-bearing TAIL and elide the MIDDLE, so `## Next action` always survives — for BOTH warm
 *  wakes (a bare pointer would arguably suffice since they re-orient, but this is cheap and
 *  universal) and COLD wakes (whose ONLY continuity IS this note — a pointer would strand
 *  them). The kept tail is anchored at the LAST `## ` section header when the whole final
 *  section fits in the reserved tail budget (so `## Next action` is delivered intact, starting
 *  at its header, not mid-sentence); otherwise it falls back to the last `tailBudget` chars,
 *  still preferring a section boundary. Total length stays ≤ `max` (the marker is budgeted
 *  inside `max`), so every existing scaffold byte-budget bound holds unchanged. */
export function clipLoopCheckpointForWake(
  checkpoint: string | null | undefined,
  max: number = LOOP_WAKE_CHECKPOINT_MAX_CHARS,
): string {
  const note = (checkpoint ?? '').trim();
  if (note.length <= max) return note;
  const marker =
    '\n…[loop:checkpoint MIDDLE elided for the wake prompt — HEAD + load-bearing TAIL kept so `## Next action` survives; the full note is in loop:checkpoint]…\n';
  // Reserve up to half the budget for the tail (a normal Next-action section is well under
  // this). Anchor at the last `## ` header when the whole final section fits; else start the
  // tail at a section boundary inside the budget, else at the raw budget offset.
  const tailBudget = Math.max(0, Math.min(Math.floor(max / 2), Math.max(0, max - marker.length)));
  let tailStart = note.length - tailBudget;
  const lastHeader = note.lastIndexOf('\n## ');
  if (lastHeader !== -1 && lastHeader + 1 >= tailStart) {
    tailStart = lastHeader + 1; // keep the whole final section (## Next action) intact
  } else {
    const boundary = note.indexOf('\n## ', tailStart);
    if (boundary !== -1) tailStart = boundary + 1;
  }
  const tail = note.slice(tailStart);
  const headBudget = Math.max(0, max - tail.length - marker.length);
  const head = note.slice(0, headBudget).trimEnd();
  return `${head}${marker}${tail}`;
}

export function spliceCurrentLoopCheckpoint(kickoff: string, checkpoint: string | null | undefined): string {
  const note = (checkpoint ?? '').trim();
  if (!note) return kickoff;
  const clipped = clipLoopCheckpointForWake(note);
  return [
    kickoff,
    '',
    'Current loop:checkpoint (fresh at fire time; prefer this over any stale arm-time goal text if they conflict):',
    clipped,
  ].join('\n');
}

// ── Wake-text rendering (compaction-continuity-hardening-2026-07-07 P-001/P-002/P-005c) ──
//
// Measured on a live warm AUTO session (2026-07-07): the ~3KB arm-time kickoff was
// re-delivered VERBATIM on all 263 wakes of one session ≈ ~200k tokens of repeated
// boilerplate — the single biggest recurring context injection, directly accelerating
// compaction frequency. And the spliced checkpoint was labeled "fresh at fire time"
// when only its READ is fresh — a checkpoint WRITTEN before turns the agent can no
// longer see kept instructing an already-done "next action" (the re-report trap).

/** Re-deliver the FULL arm-time kickoff every Nth wake (1, 11, 21, …) as a contract
 *  refresher; all other wakes get the short form. */
export const LOOP_WAKE_FULL_TEMPLATE_EVERY = 10;

/** P-008 context-burn ratchet: byte budgets for the wake template's OWN scaffolding —
 *  everything renderLoopWakeText/renderLoopWallsBlock add BEYOND caller content
 *  (kickoff, checkpoint note, wall claims, recipe line). The companion budget test
 *  (loop-fire.test.ts "P-008" block) renders minimal fixtures and reds when a template
 *  edit pushes the scaffold past these — the same catch-it-in-unit pattern as the P-011
 *  tool prompt-weight budget. Every scaffold byte is re-injected on EVERY wake of every
 *  loop (measured pre-diet: ~200k tokens/session of repeated boilerplate), so raise a
 *  budget only for a deliberate trade-off, never to green a red test.
 *  Measured 2026-07-07: shortForm 549 (stale-header case; fresh 341), fullForm 125,
 *  wallsHeader 174, wallsPerRow 39.
 *  Raised 2026-07-19 (EI-13592, deliberate trade-off): renderLoopCheckpointBlock now
 *  stamps an absolute compact write-time (~16 bytes, e.g. "[07-17T04:52:00Z]") on
 *  every checkpoint header so a reader can detect a fire→delivery delivery-gap the
 *  relative "X ago" age (computed at fire time, silently wrong once delivery is
 *  delayed) cannot reveal on its own — see the function's doc for the mechanism.
 *  Raised again 2026-07-19 (EI-14876, deliberate trade-off): the STALE header now
 *  explicitly names `work_items:checkpoint` as NOT the store this wake reads —
 *  a live session was observed calling ONLY work_items:checkpoint every wake for
 *  10+ consecutive fires (~45min) while its loop:checkpoint carry-note sat frozen,
 *  and misread the resulting STALE warning as a "lag artifact" instead of "you're
 *  writing the wrong checkpoint" — the two tools are similarly named and easy to
 *  conflate under a WARM loop, where loop:checkpoint feels optional. Re-measured:
 *  shortForm 747 (stale-header case), fullForm 199.
 *  Raised again 2026-07-19 (EI-17327, deliberate trade-off): the SHORT form's
 *  first line (the arm-time GOAL text) now carries its own staleness caveat —
 *  a wake was observed presenting an hours-stale goal line naming a torn-down
 *  PID/run-id as if current, while the (correct) checkpoint block's "prefer
 *  this" framing never referenced the goal line specifically enough to catch
 *  it. Re-measured: shortForm 932 (stale-header case).
 *  LOWERED 2026-08-09 (P-017, fleet-lead-instrumentation-audit-2026-08-09) — the first
 *  time this budget has moved DOWN. The three raises above (549 → 747 → 932) were each a
 *  caveat appended to the SHORT form's first line, and each was locally justified by a
 *  real observed misread. They shared one unfixed root cause: that line LED with the
 *  frozen arm-time goal, so the least trustworthy text in the wake held the most
 *  prominent position on every fire, and every new failure mode was answered by making
 *  the warning longer. Fixing the ORDER instead of appending a fourth caveat — lead with
 *  the wake counter/form, demote the goal BELOW the checkpoint that supersedes it — let
 *  the ~200-byte disclaimer collapse into one short tag at the goal's point of use.
 *  Re-measured on the same fixtures: shortForm 810 stale / 490 fresh, fullForm 199.
 *  GENERAL: when a budget has been raised repeatedly for the same reason, the raises are
 *  the symptom — the next edit should attack what keeps making them necessary. */
export const LOOP_WAKE_SCAFFOLD_BYTE_BUDGETS = {
  shortForm: 830,
  fullForm: 210,
  wallsHeader: 220,
  wallsPerRow: 56,
} as const;

/** Checkpoint staleness ceiling: older than max(3 intervals, 30min) ⇒ the note likely
 *  predates turns the agent cannot see — demote its authority instead of asserting it. */
export function loopCheckpointStaleMs(intervalSec: number | null | undefined): number {
  const iv = typeof intervalSec === 'number' && Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 60;
  return Math.max(3 * iv * 1000, 30 * 60_000);
}

function humanAge(ms: number): string {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 36 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** Compact absolute stamp (no year/millis — a loop's checkpoint is never meaningfully
 *  ambiguous across a year boundary, and sub-second precision adds nothing here) so a
 *  reader can compute the TRUE elapsed time against their OWN current wall-clock,
 *  independent of how long this rendered text sat in the wake queue before delivery
 *  (EI-13592 below). ~16 bytes: "07-17T04:52:00Z". */
function isoStamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(5, 19)}Z`;
}

/** Render the fire-time checkpoint block with an explicit WRITE-AGE stamp. A fresh
 *  note is the single authority for the turn; a stale one is demoted to a lead the
 *  agent must reconcile — never re-execute — because turns it cannot see may have
 *  happened since (P-002; the exact post-compaction trap this session hit).
 *
 *  EI-13592: the age/staleness verdict here is computed ONCE, at FIRE (staging) time —
 *  the moment this text is baked into the wake payload. Delivery can lag fire by an
 *  arbitrary amount (the target session was mid-turn and only reads the queued wake
 *  once it settles), and any loop:checkpoint REWRITE landing in that fire→delivery
 *  gap is invisible to this render — a note that was genuinely fresh at fire time can
 *  be stale well before the agent actually reads it, with nothing here to say so. A
 *  fully lazy re-render at delivery time would close this completely, but that
 *  requires the wake-delivery pipeline itself to defer rendering (out of scope for a
 *  pure render function and too broad a change to land opportunistically here). The
 *  tractable partial fix: stamp the ABSOLUTE write time (not just a relative "X ago"
 *  computed at fire time, which silently understates the true gap the longer delivery
 *  is delayed) so a reader who suspects a large fire→delivery gap can compare it
 *  against their own current wall-clock instead of trusting a relative age that may be
 *  stale itself. */
export function renderLoopCheckpointBlock(
  checkpoint: string | null | undefined,
  opts: { updatedAtMs?: number | null; nowMs?: number; intervalSec?: number | null } = {},
): string | null {
  const note = (checkpoint ?? '').trim();
  if (!note) return null;
  const clipped = clipLoopCheckpointForWake(note);
  const now = opts.nowMs ?? Date.now();
  const ageMs = opts.updatedAtMs != null && Number.isFinite(opts.updatedAtMs) ? Math.max(0, now - opts.updatedAtMs) : null;
  const stale = ageMs != null && ageMs > loopCheckpointStaleMs(opts.intervalSec);
  const stamp = ageMs != null ? ` [${isoStamp(opts.updatedAtMs!)}]` : '';
  const header = stale
    ? `⚠ Your loop:checkpoint is STALE (written${stamp} ${humanAge(ageMs!)} ago as of fire time — if delivery was ` +
      'delayed past fire time, the true gap is larger than this — turns you cannot see may have happened since). ' +
      'Treat it as a LEAD, not the truth: RECONCILE against live state first, and do NOT re-execute its "next action" ' +
      'verbatim (it may already be done). Refresh it with loop:checkpoint { did, left, insight, next } — NOT ' +
      'work_items:checkpoint, a different store this wake never reads — before this turn ends:'
    : `Current loop:checkpoint (you wrote it${stamp} ${ageMs != null ? humanAge(ageMs) + ' ago as of fire time' : 'earlier'}; if this wake's delivery was delayed, that gap may be larger now) — this is the authority for what to do this wake:`;
  return `${header}\n${clipped}`;
}

/** Whether fire #`fireNumber` gets the FULL arm-time kickoff: fire 1, every
 *  LOOP_WAKE_FULL_TEMPLATE_EVERY-th wake after (11, 21, …), or no checkpoint
 *  (the kickoff is then the only brief the agent has). Exported so the fire
 *  path can skip short-form-only work (the recipe lookup) without duplicating
 *  the cadence condition. */
export function isLoopWakeFullForm(fireNumber: number, hasCheckpoint: boolean): boolean {
  return fireNumber <= 1 || fireNumber % LOOP_WAKE_FULL_TEMPLATE_EVERY === 1 || !hasCheckpoint;
}

/** Render the OPEN-WALLS block (P-006): the carried owner-gated commitments, as
 *  rows, in EVERY wake form until cleared — rendered OUTSIDE the truncatable
 *  checkpoint body so a capped note can never clip a commitment off the end. */
export function renderLoopWallsBlock(walls: ReadonlyArray<WallEntry>, nowMs: number = Date.now()): string | null {
  if (!walls.length) return null;
  const lines = walls.map((w) => {
    const recheck = w.recheck ? ` — re-check: ${w.recheck}` : '';
    const age =
      w.sinceMs != null && Number.isFinite(w.sinceMs)
        ? ` (standing ${humanAge(Math.max(0, nowMs - w.sinceMs))})`
        : '';
    return `  • ${w.claim}${recheck}${age}`;
  });
  return (
    '⛔ OPEN WALLS — owner-gated / pending decisions you are carrying (re-check, do not re-litigate or ' +
    're-declare resolved; clear a resolved one via loop:checkpoint { walls }):\n' +
    lines.join('\n')
  );
}

/** Render the CARRIED-CHECKS block (cold-carry-system-hardening P-001, delivery
 *  parity with walls): claims + probes, OUTSIDE the truncatable checkpoint body —
 *  a probe clipped off a capped note is a dissolved check (the phantom-re-anchor
 *  shape), exactly what walls-splitting exists to prevent. */
export function renderLoopChecksBlock(checks: ReadonlyArray<CheckEntry>): string | null {
  if (!checks.length) return null;
  const unsettled = checks.filter((check) => !check.verified || Boolean(check.contested));
  const verified = checks.filter((check) => Boolean(check.verified) && !check.contested && Boolean(check.id));
  const unaddressableVerified = checks.filter(
    (check) => Boolean(check.verified) && !check.contested && !check.id,
  );
  const expandedVerified = verified.slice(-LOOP_WAKE_EXPANDED_VERIFIED_CHECKS);
  const compactedVerified = verified.slice(0, -LOOP_WAKE_EXPANDED_VERIFIED_CHECKS);
  const compactedLine = compactedVerified.length
    ? `  • ✓ ${compactedVerified.length} older verified check(s) retained in loop:checkpoint: ${compactedVerified
        .map((check) => `#${check.id}`)
        .join(', ')}`
    : null;
  const rendered = [...unsettled, ...unaddressableVerified, ...expandedVerified].map(
    (c) => `  ${renderCheckLine(c).replace(/^-\s*/, '• ')}`,
  );
  return (
    '🧪 CARRIED CHECKS — claims + probes (✓ verified w/ evidence · ⚠ CONTESTED: evidence contradicts verification; ' +
    '? PREDICTED: run the re-check before ' +
    'relying on it; update/clear via loop:checkpoint { checks }):\n' +
    [...(compactedLine ? [compactedLine] : []), ...rendered].join('\n')
  );
}

/**
 * Render the wake-turn text for fire #`fireNumber` (P-001b wake diet):
 *   - FULL form (the whole arm-time kickoff) per isLoopWakeFullForm;
 *   - SHORT form otherwise: the kickoff's first line (which carries the 🔁 marker +
 *     goal) + the checkpoint block + an optional on-point recipe line (P-005c) + a
 *     one-line footer. The checkpoint IS the brief — re-sending the full contract
 *     every wake is what burned ~200k tokens/session.
 * The wall-nag line and the walls block (P-006) render in BOTH forms — commitments
 * ride every wake until cleared.
 */
export function renderLoopWakeText(opts: {
  kickoff: string;
  fireNumber: number;
  checkpoint: string | null | undefined;
  checkpointUpdatedAtMs?: number | null;
  intervalSec?: number | null;
  nowMs?: number;
  /** P-005c: the pre-rendered top-recipe one-liner (renderWakeRecipeLine), spliced
   *  into the SHORT form only — the moment-of-need reuse pointer. */
  recipeLine?: string | null;
  /** P-006: open walls parsed OUT of the note (splitCarryNoteWalls) — rendered as
   *  their own un-truncatable block in every form. */
  walls?: ReadonlyArray<WallEntry>;
  /** P-001 (cold-carry-system-hardening): carried checks parsed OUT of the note
   *  (splitCarryNoteChecks) — same un-truncatable delivery as walls. */
  checks?: ReadonlyArray<CheckEntry>;
  /** P-006: the pre-rendered turn-settle nag line (renderWallNagLine), when the
   *  previous turn ended on a row-less owner-ask. */
  wallNagLine?: string | null;
  /** EI-11484: the pre-rendered OPEN OWNER DIRECTIVES block
   *  (renderOwnerDirectivesBlock) — rendered FIRST in the priority stack,
   *  ABOVE the wall nag, the walls, and the loop contract, in EVERY form:
   *  an owner order outranks the loop's re-injected standing agenda. */
  ownerDirectivesBlock?: string | null;
  /** WI-5092: true when the carry-note READ FAILED (store error) — suppresses the
   *  first-carry-note mandate, which must only assert emptiness on a CONFIRMED-empty
   *  read (a failed read may hide a real note the mandate would nudge an overwrite of). */
  noteReadFailed?: boolean;
  /**
   * EI-19501119110607678: the MEASURED staleness of the arm-time goal
   * (`assessGoalStaleness`), or null when there is nothing honest to say.
   *
   * ⚠ RENDERED IN BOTH FORMS, and adjacent to the goal it judges. P-017 demoted the
   * frozen goal below the checkpoint and tagged it "frozen at arm time" — but that is
   * a generic caution, and a generic caution loses to specific text: the goal still
   * names real ids in the shape of live state. This line is the difference between
   * "this might be stale" and "these four items are done"; separating it from the goal
   * would recreate the ordering defect P-017 fixed, one level up.
   */
  goalStalenessNote?: string | null;
  /**
   * EI-21459285533379701: the MEASURED divergence between the arm-time goal and a
   * standing fact CORRECTED since arming (`assessGoalFactDivergence`), or null.
   *
   * ⚠ Rendered in the same slots as `goalStalenessNote`, for the same reason — it is a
   * verdict on that exact line. The two are complementary, not redundant: staleness
   * judges the WORK-ITEM IDS the goal names, this judges a CLAIM the goal makes that
   * its own author has since withdrawn. A retracted claim names no id, so the
   * staleness check is structurally blind to it.
   */
  goalFactDivergenceNote?: string | null;
  /**
   * EI-21526226279199560: the MEASURED liveness of the blocker this loop declared
   * (`assessBlockerLiveness`), or null when there is nothing honest to say.
   *
   * ⚠ Rendered in the same slots as the two notes above, and for the same reason — but
   * note what it judges is DIFFERENT in kind. Those two judge the GOAL. This judges the
   * WAIT, which has no other representation in the wake at all: a blocked loop's frozen
   * premise asserts "I am waiting on X" every single wake with nothing ever re-checking
   * whether waiting on X is still a sane thing to do. Silent unless the blocker is dead,
   * suspect, or the wait has outrun its clock, because a reassurance on every healthy
   * wake becomes scenery — which is exactly how the generic prose caution failed.
   */
  blockerLivenessNote?: string | null;
}): string {
  const block = renderLoopCheckpointBlock(opts.checkpoint, {
    updatedAtMs: opts.checkpointUpdatedAtMs,
    nowMs: opts.nowMs,
    intervalSec: opts.intervalSec,
  });
  const wallsBlock = renderLoopWallsBlock(opts.walls ?? [], opts.nowMs);
  const checksBlock = renderLoopChecksBlock(opts.checks ?? []);
  const priority = [opts.ownerDirectivesBlock || null, opts.wallNagLine || null, wallsBlock, checksBlock].filter(
    (s): s is string => Boolean(s),
  );
  // WI-5092 (su-behavior audit): an armed loop whose carry-note is NEVER written is the
  // audited continuity gap — monitor loops especially armed fine, then settled wake after
  // wake with loop:checkpoint absent from every call, leaving a cold wake / successor /
  // post-compaction resume only the arm-time goal text. When no note exists, say so
  // CONCRETELY (same design as renderDrivenWorkItemLine: a conditional made true is
  // named, not left hypothetical). block == null always renders the FULL form
  // (isLoopWakeFullForm), so the mandate only needs to ride that branch.
  const noNoteMandate =
    block == null && !opts.noteReadFailed
      ? '⚠ NO loop:checkpoint carry-note exists for this loop yet. Write the FIRST one before this turn ends — loop:checkpoint { did, left, insight, next } — even on a quiet wake: with no carry-note, a cold wake, a successor, or a post-compaction resume reconstructs this loop from its arm-time goal text alone.'
      : null;
  if (isLoopWakeFullForm(opts.fireNumber, block != null)) {
    // The staleness verdict sits IMMEDIATELY after the kickoff here, because in the
    // FULL form the kickoff (goal and all) leads — so the correction has to be the
    // very next thing read, not filed below the checkpoint.
    return [
      opts.kickoff,
      ...(opts.goalStalenessNote ? [opts.goalStalenessNote] : []),
      ...(opts.goalFactDivergenceNote ? [opts.goalFactDivergenceNote] : []),
      ...(opts.blockerLivenessNote ? [opts.blockerLivenessNote] : []),
      ...priority,
      ...(block ? [block] : []),
      ...(noNoteMandate ? [noNoteMandate] : []),
    ].join('\n\n');
  }
  const firstLine = opts.kickoff.split('\n').find((l) => l.trim().length > 0) ?? opts.kickoff;
  return [
    // P-006 (fleet-member-dx, EI-9018): label this as the LOOP's own counter so it
    // can't be confused with the event-wake delivery-log id in the same injection.
    // P-017 (fleet-lead-instrumentation-audit-2026-08-09): this line used to LEAD with
    // `firstLine` — the arm-time GOAL text, frozen whenever the loop was last (re-)armed
    // — and then spend ~200 bytes telling the reader to distrust what they had just read
    // (EI-17327). The ORDERING was the defect, not the wording: the least trustworthy
    // text held first position on every wake, so each newly-observed misread was answered
    // by appending another caveat to it, and the shortForm budget was raised 549 → 747 →
    // 932 doing exactly that. Three locally-reasonable raises, one unfixed root cause.
    // The fix is positional: lead with what is ALWAYS true (the wake counter + form),
    // let the checkpoint block carry the fresh state, and demote the frozen goal to a
    // labelled line BELOW it. Once the stale text no longer leads, one short tag does
    // the work the disclaimer was doing — so the scaffold SHRANK (measured: 932 → 826).
    `Loop wake #${opts.fireNumber} — short form (the full loop contract ships on wake 1, then every ${LOOP_WAKE_FULL_TEMPLATE_EVERY} wakes).`,
    '',
    ...priority.flatMap((s) => [s, '']),
    block,
    '',
    ...(opts.recipeLine ? [opts.recipeLine, ''] : []),
    // The goal sits AFTER the checkpoint deliberately: it is orientation, not state, and
    // the checkpoint's `next` is the authoritative action. Tagged at its point of use so
    // a reader meeting a stale PID/run-id/leader here knows what it is without a preamble.
    `Arm-time goal (frozen at arm time — the checkpoint above is the fresher source): ${firstLine}`,
    // Directly beneath the goal, never elsewhere: this is the measured verdict ON that
    // exact line, and a reader must not be able to accept the goal before meeting it.
    ...(opts.goalStalenessNote ? [opts.goalStalenessNote] : []),
    ...(opts.goalFactDivergenceNote ? [opts.goalFactDivergenceNote] : []),
    ...(opts.blockerLivenessNote ? [opts.blockerLivenessNote] : []),
    '',
    'On settle: refresh loop:checkpoint { did, left, insight, next }; END YOUR TURN. `loop:end` stops; `loop:status` inspects.',
  ].join('\n');
}

/**
 * Resolve the current state of the work-items a frozen goal names.
 *
 * ⚠ ONE QUERY, BOUNDED BY THE ID LIST, and it must FAIL SOFT TO EMPTY. Returning a
 * partially-populated map on error would let a read failure masquerade as "these
 * items are gone", which `assessGoalStaleness` would then read as a resolved id —
 * exactly the fabricated-measurement failure that module is built to refuse.
 *
 * `work_items` is the right (single) table for all three id shapes: issue-family rows
 * (EI-/bug/change/task) are MIRRORED into it, so a WI-/EI-/F- id resolves here
 * uniformly rather than needing a second read against `engineer_issues`.
 */
export async function defaultReadGoalItemStates(
  ids: readonly string[],
  opts: { sql?: Sql; workspaceId?: string | null } = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    const rows = await sql<{ feature_id: string; status: string | null }[]>`
      SELECT feature_id, status
        FROM harness_shared.work_items
       WHERE feature_id = ANY(${ids as string[]})`;
    for (const r of rows) {
      if (r.feature_id && r.status) out.set(r.feature_id.toUpperCase(), r.status);
    }
  } catch {
    // Fail-soft to EMPTY — see the note above. A wake must never be delayed or
    // decorated with a claim this read could not support.
    return new Map();
  }
  return out;
}

/**
 * EI-21526226279199560: the liveness of the AGENT this loop declared itself blocked on.
 *
 * Only kind:'agent' has a subject to resolve. A work-item or event blocker already has a
 * clearance mechanism (`blocked-on-status.ts`); a process, owner or 'other' blocker has
 * no oracle at all, and inventing one is the fabrication D-003 banned. Those kinds still
 * reach the elapsed-clock branch, which needs no oracle — which is why this read is
 * skipped rather than faked for them.
 *
 * Routed through `resolveSessionStates` — THE shared oracle behind coord:presence,
 * fleet:status and the send-miss report — and NOT through the heartbeat columns beside
 * it, because raw keepalive freshness is not liveness: a warm-dead session reads
 * heartbeatFresh:true with sessionState:'ended'. That corpse is precisely what this
 * detector exists to catch, so reading the cheaper column would blind it to its own case.
 *
 * Fail-soft to an unmeasured verdict — a wake must never be delayed, nor decorated with
 * a claim this read could not support. `sessionState: null` yields NO line at all.
 */
export async function defaultReadBlockerLiveness(
  ref: string,
  opts: { sql?: Sql; workspaceId?: string | null } = {},
): Promise<BlockerLiveness> {
  const unmeasured: BlockerLiveness = { sessionState: null, lastActiveMsAgo: null };
  if (!ref) return unmeasured;
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    const verdicts = await resolveSessionStates([{ ownerId: ref }], {
      hydratePerId: true,
      psuHostAuthority: true,
    });
    const rows = await sql<{ last_active_at: string | null }[]>`
      SELECT last_active_at
        FROM harness_shared.coord_presence
       WHERE owner_id = ${ref}
       LIMIT 1`;
    const lastActiveRaw = rows[0]?.last_active_at ?? null;
    const lastActiveMs = lastActiveRaw ? Date.parse(lastActiveRaw) : Number.NaN;
    return {
      sessionState: verdicts.get(ref)?.sessionState ?? null,
      lastActiveMsAgo: Number.isFinite(lastActiveMs) ? Date.now() - lastActiveMs : null,
    };
  } catch {
    return unmeasured;
  }
}

/**
 * EI-21459285533379701: this loop's arm time + the owner's CORRECTED standing facts.
 *
 * ONE round-trip, and the corrected-fact population is the ~6.5% tail of live facts
 * (260 of 4004 measured), reached through `agent_facts_fold` with the supersede EXISTS
 * probe served by `agent_facts_version_chain` — measured 0.06ms / 3 buffer hits for an
 * owner with no corrections, where the EXISTS leg is never executed at all. The time
 * comparison is deliberately NOT pushed into SQL: it is the gate that makes this
 * detector selective (1 of 39 live loops vs 69% ungated), so it lives in
 * `assessGoalFactDivergence` where it is exhaustively tested, not in a query string.
 *
 * Fail-soft to `{ armedAtMs: null, corrected: [] }` — a wake must never be delayed, nor
 * decorated with a claim this read could not support.
 */
export async function defaultReadGoalFactCorrections(
  routineId: string,
  ownerId: string,
  opts: { sql?: Sql; workspaceId?: string | null } = {},
): Promise<{ armedAtMs: number | null; corrected: CorrectedFact[] }> {
  const empty = { armedAtMs: null, corrected: [] as CorrectedFact[] };
  if (!routineId || !ownerId) return empty;
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    const rows = await sql<
      { armed_at: string | null; key: string | null; body: string | null; updated_at: string | null }[]
    >`
      SELECT r.metadata->>'armed_at' AS armed_at, f.key, f.body, f.updated_at
        FROM harness_shared.routines r
        LEFT JOIN harness_shared.agent_facts f
          ON f.workspace_id = r.workspace_id
         AND f.scope = 'owner'
         AND f.scope_ref = ${ownerId}
         AND f.retracted_at IS NULL
         AND f.superseded_at IS NULL
         AND f.expires_at > now()
         AND EXISTS (
               SELECT 1
                 FROM harness_shared.agent_facts p
                WHERE p.workspace_id = f.workspace_id
                  AND p.scope = f.scope
                  AND COALESCE(p.scope_ref, '') = COALESCE(f.scope_ref, '')
                  AND p.key = f.key
                  AND p.superseded_at IS NOT NULL
             )
       WHERE r.id = ${routineId}`;
    if (!rows.length) return empty;
    const armedRaw = rows[0].armed_at;
    const armedMs = armedRaw ? Date.parse(armedRaw) : Number.NaN;
    const corrected: CorrectedFact[] = [];
    for (const r of rows) {
      if (!r.key || !r.body || !r.updated_at) continue; // LEFT JOIN miss ⇒ no corrections
      const correctedAtMs = Date.parse(r.updated_at);
      if (!Number.isFinite(correctedAtMs)) continue;
      corrected.push({ key: r.key, body: r.body, correctedAtMs });
    }
    return { armedAtMs: Number.isFinite(armedMs) ? armedMs : null, corrected };
  } catch {
    return empty;
  }
}

/** Read the loop's carry MODE from payload_template (su-cold-auto-mode-2026-07-03 P-003).
 *  'cold' = the opt-in fresh-context cold-auto lifecycle — a cold fire stamps a
 *  {carry:'cold', wakeCount, harness} marker the wake-executor forks on (RESET-CONTEXT /
 *  RECYCLE). Anything else, INCLUDING absent, is today's WARM loop (no payload marker,
 *  byte-identical). The whole cold path is still dormant downstream until the P-007 master
 *  gate (coldAutoEnabled) is wired on in Phase 3 — this only stamps the marker. */
export function readLoopCarry(payloadTemplate: Record<string, unknown> | null): 'warm' | 'cold' {
  return payloadTemplate?.carry === 'cold' ? 'cold' : 'warm';
}

/** Read a positive-number dead-man bound (`maxFires` / `maxDurationSec`) from payload_template. */
export function readLoopPositiveBound(
  payloadTemplate: Record<string, unknown> | null,
  key: 'maxFires' | 'maxDurationSec',
): number | null {
  const v = payloadTemplate?.[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Fire one loop iteration: gate (failure-streak → cost-cap) then deliver the warm coord wake.
 * Never throws — every failure is a result (the routine engine's fire path is fail-soft; a
 * lost fire is re-armed by the completion-rebase / the next interval).
 */
export async function fireLoopWake(input: LoopFireInput, deps: LoopFireDeps = {}): Promise<LoopFireResult> {
  const checkFireGate = deps.checkFireGate ?? defaultCheckFireGate;
  const recordFire = deps.recordFire ?? defaultRecordFire;
  const wake = deps.wake ?? defaultWakeRecipients;
  const costCap = deps.costCap ?? defaultCheckLoopCostCap;
  const deadMan = deps.deadMan ?? defaultCheckLoopDeadMan;
  const incrementFireCount = deps.incrementFireCount ?? defaultIncrementLoopFireCount;
  const readFireCount = deps.readFireCount ?? defaultReadLoopFireCount;
  const getNoteMeta =
    deps.getLoopCarryNoteWithMeta ??
    (deps.getLoopCarryNote
      ? async (ref: Parameters<typeof defaultGetLoopCarryNoteWithMeta>[0]) => ({
          note: await deps.getLoopCarryNote!(ref),
          updatedAtMs: null,
          readFailed: false,
        })
      : defaultGetLoopCarryNoteWithMeta);
  const recordWithheld = deps.recordWithheld ?? defaultRecordWithheld;
  const rescheduleSuppressedWake = deps.rescheduleSuppressedWake ?? rescheduleLoopAfterAwaitSuppression;

  if (!input.targetOwnerId) {
    return { fired: false, reason: 'no-target', detail: 'loop routine has no target_owner_id to wake' };
  }

  // Guard 1 — failure-streak fire-gate (the existing autoloop backoff/circuit, per-loop).
  const gate = await checkFireGate(input.installSlug, input.routineName);
  if (!gate.allow) {
    const detail = `${gate.reason} (consecutive_errors=${gate.consecutiveErrors}, retry in ~${gate.retryAfterSec}s)`;
    // EI-14483: a fire-gate deny previously left NO durable trace (recordFire is
    // deliberately skipped here — see recordWithheld's doc — so last_fired_at doesn't
    // reset the backoff clock). That made "silently denied every tick for hours" and
    // "never scheduled" indistinguishable from autoloop_state after the fact. Record to
    // the SEPARATE last_withheld_* columns instead — never last_fired_at/consecutive_errors.
    await recordWithheld(input.installSlug, input.routineName, 'fire-gate', detail).catch(() => {});
    return { fired: false, reason: 'fire-gate', detail };
  }

  // Guard 2 — cost-cap (D-006's one net-new loop guardrail): auto-pause on cumulative breach.
  const capCents = readLoopCostCapCents(input.payloadTemplate);
  if (capCents != null) {
    const c = await costCap({
      sql: input.sql,
      routineId: input.routineId,
      targetOwnerId: input.targetOwnerId,
      capCents,
    });
    if (c.breach) {
      // The breach already auto-paused the routine; record it as a fire-path error so it is
      // visible in autoloop:status / fire history, and withhold the wake.
      await recordFire(input.installSlug, input.routineName, `cost-cap ${c.spendCents}¢>${c.capCents}¢`, 'error').catch(
        () => {},
      );
      return {
        fired: false,
        reason: 'cost-cap',
        detail: `cumulative spend ${c.spendCents}¢ exceeded cap ${c.capCents}¢ — loop auto-paused`,
      };
    }
  }

  // Guard 3 — the dead-man bound (loop-wake-rate-limit-robustness P2a): a runaway / forgotten /
  // permanently-dead loop auto-pauses when its total fires or wall-clock-since-arm crosses an
  // optional bound. Config rides payload_template (maxFires / maxDurationSec); no bound ⇒ no read.
  const maxFires = readLoopPositiveBound(input.payloadTemplate, 'maxFires');
  const maxDurationSec = readLoopPositiveBound(input.payloadTemplate, 'maxDurationSec');
  if (maxFires != null || maxDurationSec != null) {
    const dm = await deadMan({ sql: input.sql, routineId: input.routineId, maxFires, maxDurationSec });
    if (dm.breach) {
      // The breach auto-paused the routine; record it as a fire-path error so it is visible in
      // autoloop:status / fire history, and withhold the wake.
      await recordFire(input.installSlug, input.routineName, `dead-man ${dm.reason}`, 'error').catch(() => {});
      return { fired: false, reason: 'dead-man', detail: `dead-man guard tripped: ${dm.reason} — loop auto-paused` };
    }
  }

  // Guard 4 — an active BLOCKING event-await (EI-10901): the owner deliberately parked via
  // events:await/watch:create and was told "end your turn, do not poll" — this routine's own
  // wake should not undo that by re-injecting the full loop contract just to report "still
  // waiting." Withheld SILENTLY (no recordFire call, matching Guard 1's fire-gate pattern):
  // this is expected, benign, self-correcting behavior, not a fire-history-worthy anomaly —
  // the routine simply re-checks on its normal cadence next tick.
  //
  // Monitor loops are the exception: their cadence is the heartbeat/backstop for the state
  // they are watching, so a deliberate gate wait must not silence that monitor. A monitor
  // loop's persisted mode is the structural signal; do not infer it from goal prose.
  const listBlockingAwaits = deps.listBlockingAwaits ?? defaultListBlockingAwaits;
  const blockingAwaits = await listBlockingAwaits(input.targetOwnerId).catch(() => []);
  const isMonitorLoop = input.payloadTemplate?.mode === 'monitor';
  if (!isMonitorLoop && blockingAwaits.length > 0) {
    const readLastDeliveredAt = deps.readLastDeliveredAt ?? defaultReadLoopLastDeliveredAtMs;
    const lastDeliveredAtMs = await readLastDeliveredAt(input.sql ?? undefined, input.routineId).catch(() => null);
    const decision = decideLoopAwaitSuppression({ awaits: blockingAwaits, nowMs: Date.now(), lastDeliveredAtMs });
    if (decision.suppress) {
      let rearmFailed = false;
      if (decision.resumeAtMs != null) {
        try {
          const rearmed = await rescheduleSuppressedWake({
            routineId: input.routineId,
            workspaceId: input.workspaceId,
            installSlug: input.installSlug,
            routineName: input.routineName,
            targetOwnerId: input.targetOwnerId,
            intervalSec: input.intervalSec,
            resumeAtMs: decision.resumeAtMs,
            drivingEventKey: decision.drivingEventKey,
            sql: input.sql,
          });
          if (!rearmed) {
            // A false result means the parked row did not satisfy the repair CAS. The
            // caller cannot prove that another writer installed a finite schedule, so
            // treating this as a successful suppression can strand next_fire_at at
            // infinity just as surely as a thrown write. Fail open and let the normal
            // wake completion path establish the next finite schedule.
            rearmFailed = true;
            console.warn(
              `[loop-fire] await suppression re-arm failed for '${input.routineId}' — delivering wake: ` +
                'compare-and-set matched no parked pure-loop row',
            );
          }
        } catch (error) {
          // The row is already parked by claimDueRoutine. If this repair write fails, do not
          // return the old silent-withhold result: fail open and deliver this wake so the
          // completion-rebase can restore a finite schedule instead of creating a new wedge.
          rearmFailed = true;
          console.warn(
            `[loop-fire] await suppression re-arm failed for '${input.routineId}' — delivering wake: ${
              error instanceof Error ? error.message : error
            }`,
          );
        }
      }
      if (!rearmFailed) {
        return {
          fired: false,
          reason: 'await-blocking',
          detail:
            `owner is parked on a blocking await (${decision.drivingEventKey ?? blockingAwaits[0]?.eventKey}) — ` +
            `wake withheld until ${decision.resumeAtMs != null ? new Date(decision.resumeAtMs).toISOString() : 'it fires'}`,
        };
      }
    }
  }

  // Fire — the WARM coord wake. `wakeRecipients` fires `coord:inbox-wake:<targetOwnerId>` and
  // rides the wake-executor liveness ladder (inject-if-live / `--resume`-if-exited); the loop
  // adds NO resume code (D-005). Pre-record the attempt (preserves the streak counter), then
  // record the outcome.
  await recordFire(input.installSlug, input.routineName, 'firing', 'attempt').catch(() => {});
  const armTimeKickoff = readLoopKickoff(input.payloadTemplate) ?? defaultLoopKickoff(input.routineId);
  // Fire number = priorFires + 1, read UNCONDITIONALLY (P-001b): the full/short wake cadence
  // needs it on every loop, warm or cold. Fail-soft: a read miss ⇒ fire 1 (full form).
  const priorFires = await readFireCount(input.sql, input.routineId).catch(() => 0);
  const fireNumber = priorFires + 1;
  // WI-5092: a READ FAILURE must stay distinguishable from a CONFIRMED-EMPTY note — the
  // first-carry-note mandate below asserts "no note exists", which is false (and nudges an
  // overwrite of a real note) when the carry store merely errored. A failed read keeps the
  // wake prompt byte-equivalent, exactly as before.
  const checkpointMeta = await getNoteMeta({
    harness: input.installSlug,
    ownerId: input.targetOwnerId,
    workspaceId: input.workspaceId,
  }).then(
    // Preserve the canonical reader's explicit failure sentinel. Older injected
    // readers omit it, which remains the successful/confirmed-empty default.
    (m) => ({ ...m, readFailed: m.readFailed === true }),
    () => ({ note: null, updatedAtMs: null, readFailed: true }),
  );
  // P-006: walls render OUTSIDE the truncatable checkpoint body (a commitment
  // clipped off a capped note is a dissolved commitment) — split them out and
  // render the block in every form. The pending turn-settle nag is taken
  // (read-and-cleared) here, fail-soft.
  const wallSplit = splitCarryNoteWalls(checkpointMeta.note);
  const walls = wallSplit.walls;
  const { body: checkpointBody, checks } = splitCarryNoteChecks(wallSplit.body);
  const takeWallNag = deps.takeWallNag ?? defaultTakeLoopWallNag;
  const nag = await takeWallNag({ harness: input.installSlug, ownerId: input.targetOwnerId }).catch(() => null);
  // P-005c: on a SHORT-form wake only, splice the one on-point recipe (the
  // moment-of-need reuse pointer). Fail-soft + time-bounded — a missing
  // embedder / slow lookup degrades to no line, never delays the fire.
  const hasCheckpoint = Boolean(checkpointBody.trim());
  let recipeLine: string | null = null;
  if (!isLoopWakeFullForm(fireNumber, hasCheckpoint)) {
    const findWakeRecipe = deps.findWakeRecipe ?? defaultFindTopRecipeForWake;
    const hit = await findWakeRecipe(extractWakeRecipeQuery(checkpointBody, armTimeKickoff), {
      sql: input.sql,
    }).catch(() => null);
    if (hit) recipeLine = renderWakeRecipeLine(hit);
  }
  // EI-11484: open owner directives render ABOVE the loop contract in EVERY
  // wake until dispositioned — the re-injection surface the loop agenda always
  // had and fresh owner orders lacked. Fail-soft: a read miss renders nothing,
  // never delays the fire.
  const renderDirectives =
    deps.renderOwnerDirectives ??
    (async (ws: string | null | undefined, o?: { sql?: Sql; viewerOwnerId?: string | null }) => {
      const { renderOpenOwnerDirectivesBlock } = await import('../../owner-directives');
      return renderOpenOwnerDirectivesBlock(ws, o);
    });
  // The wake renders FOR this loop's owner, so its own cleared rows drop out
  // (P-008 / D-008); the directive stays open for everyone else.
  const ownerDirectivesBlock = await renderDirectives(input.workspaceId, {
    sql: input.sql,
    viewerOwnerId: input.targetOwnerId,
  }).catch(() => null);
  // EI-19501119110607678 — MEASURE the frozen goal instead of only cautioning about it.
  // Judge the persisted `goal` when the loop has one; otherwise the kickoff's first
  // line, which is the text the wake actually renders as "Arm-time goal" — the check
  // must judge WHAT THE READER SEES, or it can exonerate a line it never looked at.
  const goalTextForCheck =
    typeof input.payloadTemplate?.goal === 'string' && input.payloadTemplate.goal.trim()
      ? input.payloadTemplate.goal
      : (armTimeKickoff.split('\n').find((l) => l.trim().length > 0) ?? '');
  const readGoalItemStates = deps.readGoalItemStates ?? defaultReadGoalItemStates;
  const goalIds = extractGoalWorkItemIds(goalTextForCheck);
  // Skipped entirely for a prose goal: no ids ⇒ nothing to resolve ⇒ no query on the
  // hot fire path, which is the common case for a mission-shaped goal.
  const goalItemStates = goalIds.length
    ? await readGoalItemStates(goalIds, { sql: input.sql, workspaceId: input.workspaceId }).catch(
        () => new Map<string, string>(),
      )
    : new Map<string, string>();
  const goalStalenessNote = assessGoalStaleness(goalTextForCheck, goalItemStates).note;
  // EI-21459285533379701 — the OTHER way a frozen goal goes wrong: it keeps asserting a
  // CLAIM its own author has since corrected via facts:assert. A retracted claim names no
  // work-item id, so the staleness check above is structurally blind to it.
  // Skipped entirely for a goal with no text, exactly as the id check is for a prose goal.
  const readGoalFactCorrections = deps.readGoalFactCorrections ?? defaultReadGoalFactCorrections;
  const factCorrections = goalTextForCheck.trim()
    ? await readGoalFactCorrections(input.routineId, input.targetOwnerId, {
        sql: input.sql,
        workspaceId: input.workspaceId,
      }).catch(() => ({ armedAtMs: null, corrected: [] as CorrectedFact[] }))
    : { armedAtMs: null, corrected: [] as CorrectedFact[] };
  const goalFactDivergenceNote = assessGoalFactDivergence(
    goalTextForCheck,
    factCorrections.corrected,
    factCorrections.armedAtMs,
  ).note;
  // EI-21526226279199560 — the THIRD way a frozen premise goes wrong: the thing it names
  // DIED. `blockedOn` already reached this wake as prose prepended to the kickoff, so the
  // fire could re-DELIVER the premise but never re-EVALUATE it — and a premise that only
  // repeats is what let an agent wait 2.5h on a peer that had ended.
  const blockedOnRecord =
    input.payloadTemplate?.blockedOn && typeof input.payloadTemplate.blockedOn === 'object'
      ? (input.payloadTemplate.blockedOn as LoopBlockedOnRecord)
      : null;
  const readBlockerLiveness = deps.readBlockerLiveness ?? defaultReadBlockerLiveness;
  // Only kind:'agent' has a subject the oracle can resolve, so only it costs a read. Every
  // other kind falls through to the elapsed-clock branch, which needs none — and a loop
  // that declared no blocker at all (the overwhelming majority) touches neither.
  const blockerLiveness: BlockerLiveness | null =
    blockedOnRecord && blockedOnRecord.kind === 'agent' && blockedOnRecord.ref
      ? await readBlockerLiveness(blockedOnRecord.ref, {
          sql: input.sql,
          workspaceId: input.workspaceId,
        }).catch(() => null)
      : null;
  const blockerLivenessNote = assessBlockerLiveness(
    blockedOnRecord,
    blockerLiveness,
    Date.now(),
  ).note;
  const kickoff = renderLoopWakeText({
    kickoff: armTimeKickoff,
    goalStalenessNote,
    goalFactDivergenceNote,
    blockerLivenessNote,
    fireNumber,
    checkpoint: checkpointBody,
    checkpointUpdatedAtMs: checkpointMeta.updatedAtMs,
    intervalSec: input.intervalSec,
    recipeLine,
    walls,
    checks,
    wallNagLine: nag ? renderWallNagLine(nag) : null,
    ownerDirectivesBlock,
    noteReadFailed: checkpointMeta.readFailed,
  });

  // su-cold-auto P-003: a COLD loop stamps a {carry:'cold', wakeCount, harness} marker on the
  // wake DELIVERY so the wake-executor forks to a fresh-context RESET / periodic RECYCLE
  // instead of the warm in-place turn. wakeCount = this fire's 1-based number → the consumer
  // HYBRID cadence recycles every Nth wake; `harness` (the loop's install_slug) is the
  // carry-note scope key.
  //
  // deterministic-context-carry P-021: a WARM loop now stamps the SAME marker WITHOUT the
  // carry field ({wakeCount, harness}) — the wake-executor needs it to (a) recognize the
  // delivery as a LOOP wake at all (an ordinary coord wake must never be cold-by-default
  // eligible) and (b) scope the carry-note read, when the session's class is drill-proven
  // cold-by-default. Side effect: readColdLoopMarker(d.payload) is now non-null for warm
  // loop wakes, so their turn-provenance origin correctly classifies 'loop-fire' instead
  // of 'wake-pump' (both verified agent-origin — a labeling improvement, not a behavior
  // fork). decideColdWake still treats carry!=='cold' as warm unless the caller resolved
  // classDefaultCold, so a warm loop with the P-021 flag off is byte-identical downstream.
  //
  // WI-5510: `routineId` additionally rides the marker — the delivery-side stale-fire
  // guard (psu-pty-host.mjs's makeStaleFireGuard, wired through injectPsuHostWake) needs
  // a stable LOOP-INSTANCE identity, not just the raw fire number, so a loop that was
  // `loop:end`ed and re-armed (fire numbers restart at 1) is never mistaken for a stale
  // delivery of a prior loop's higher fire count. Purely additive on the wire.
  const carry = readLoopCarry(input.payloadTemplate);
  const loopMarkerPayload: { carry?: 'cold'; wakeCount: number; harness: string; routineId: string } =
    carry === 'cold'
      ? { carry: 'cold', wakeCount: fireNumber, harness: input.installSlug, routineId: input.routineId }
      : { wakeCount: fireNumber, harness: input.installSlug, routineId: input.routineId };

  const fan = await wake([input.targetOwnerId], {
    summary: kickoff,
    payload: loopMarkerPayload,
    source: `loop:${input.routineId}`,
    workspaceId: input.workspaceId,
  });

  // The enqueue is recorded as `attempt`, NOT `ok` (loop-wake-rate-limit-robustness P0b):
  // a queued wake is NOT yet a survived turn. The old `ok`-on-enqueue reset the failure
  // streak the instant a delivery was queued, so a wake whose detached resume turn later
  // 429'd-and-died kept consecutive_errors oscillating 0→1→0 and never opened the circuit.
  // The TURN OUTCOME now owns ok/error: reconcile-loop-routines records `ok` when it sees
  // the turn's completion marker, and the resume-turn-outcome handler / stuck-park backstop
  // record `error` on a death. The enqueue just refreshes last_status (counter PRESERVED).
  //
  // EI-16166: a `!reached` miss (woken:0, staged:0) does NOT immediately deactivate the loop
  // here anymore. It PREVIOUSLY did — unconditionally, on the very FIRST such miss, with no
  // retry and no owner escalation — which is exactly the WI-2339 "proposal A" anti-pattern
  // that reachability-probe-based termination was deliberately rejected for elsewhere in this
  // same file's design ("kill a healthy loop on a transient blip"): `!reached` is reachable
  // not only for a genuinely-gone owner but also for a session whose standing inbox-wake await
  // was cancelled by a SessionEnd hook that fires on an ABNORMAL exit (e.g. a fatal
  // rate-limit/auth_wall kill mid-turn), which is transient account-pool pressure, not a dead
  // loop (observed 2026-07-18: a 2/5-account-available pool preceded exactly this single-miss
  // deactivation with fireCount:66 and consecutiveErrors:1 — a loop healthy for 66 prior fires
  // silently killed on its 67th). The loop is left PARKED (its normal post-fire state either
  // way) and this miss is recorded as an `error`, feeding the SAME failure-streak circuit /
  // stuck-park+quick-retry ladder every other death signal in this system already goes
  // through (reconcile-loop-routines.ts) — which retries multiple times across a bounded dwell
  // window before ever concluding the owner is truly gone, and which — unlike this fast path —
  // LOUDLY escalates to the owner (`escalateDeadLoop`) at the moment it actually terminates.
  let reached = (fan.woken ?? 0) > 0 || (fan.staged ?? 0) > 0;
  let fan2 = fan;
  // WI-5862: a `!reached` miss does NOT necessarily mean the target owner is gone — it can
  // equally mean a LIVE, tracked session simply has no active standing inbox-wake await right
  // now (never armed / spuriously cancelled by an abnormal-exit SessionEnd hook — see the
  // `!reached` doc above re: rate-limit/auth_wall kills). Distinguishing those two cases is
  // exactly what `ensureInboxWakeArmedForActiveSession` already does (live adv_sessions row +
  // no active await ⇒ re-arm; anything else ⇒ false, no-op) — reused here as a ONE-TIME
  // self-heal + retry before concluding "no session" and feeding the failure-streak circuit.
  // A genuinely dead/gone owner still falls through to today's behavior unchanged (the ensure
  // call is a fast, targeted PG probe, not a new failure surface).
  if (!reached) {
    const ensureWakeArmed = deps.ensureWakeArmed ?? defaultEnsureWakeArmed;
    let healed = await ensureWakeArmed({ ownerId: input.targetOwnerId, workspaceId: input.workspaceId }).catch(
      () => false,
    );
    // EI-21417550055038906 (comment 77440, fix part 4): a COLD-carry loop's owner
    // is EXPECTED to have no live session between fires — each one-turn cold
    // session dies, its SessionEnd cancels the standing inbox-wake await, and the
    // live-session-gated self-heal above then refuses to re-arm (no live
    // adv_sessions row). Every subsequent fire therefore emitted a warm wake into
    // the void and black-holed as no-session-now (measured: 0/17 fires delivered,
    // consecutiveErrors climbing, member idle over a claimable lane) — the only
    // working lever was an external coord:send wake:'required'. For a cold loop,
    // arm the standing await DIRECTLY (armInboxWake has no live-session gate; it
    // captures the freshest resume handle, and the wake-executor's liveness
    // ladder already handles "exited → resume/respawn"), then retry the emit so
    // THIS fire takes the resume channel instead of counting an error. A cold
    // loop being armed IS the owner's standing consent to be re-woken; loop:end
    // is the opt-out, so bypassing the explicit-cancel check here is correct.
    if (!healed && carry === 'cold') {
      const armColdWake = deps.armWakeForColdRespawn ?? defaultArmInboxWake;
      healed = await armColdWake({
        ownerId: input.targetOwnerId,
        note: `cold-loop resume channel (loop:${input.routineId}) — re-armed by loop-fire after a no-watcher miss`,
      })
        .then(() => true)
        .catch(() => false);
    }
    if (healed) {
      fan2 = await wake([input.targetOwnerId], {
        summary: kickoff,
        payload: loopMarkerPayload,
        source: `loop:${input.routineId}`,
        workspaceId: input.workspaceId,
      });
      reached = (fan2.woken ?? 0) > 0 || (fan2.staged ?? 0) > 0;
    }
  }
  if (!reached) {
    await recordFire(input.installSlug, input.routineName, 'no-session-now', 'error').catch(() => {});
    return {
      fired: false,
      reason: 'no-session-now',
      woken: fan2.woken,
      staged: fan2.staged,
      detail:
        'pinned warm session did not pick up this wake (woken:0, staged:0) — left parked for the ' +
        'stuck-park/quick-retry ladder to retry; only the reachability-vetoed terminal guard ' +
        '(with owner escalation) may auto-pause it after a sustained, dwell-gated streak',
    };
  }
  await recordFire(input.installSlug, input.routineName, 'queued', 'attempt').catch(() => {});

  // Bump the live fire counter UNCONDITIONALLY after a reached fire (P-001b): the full/short
  // wake cadence, the dead-man `maxFires` bound, and the cold wakeCount cadence all read it.
  // (Previously gated on maxFires/cold, which left every plain warm loop's fireNumber stuck
  // at 0 — full boilerplate on every wake.) Only incremented after a REACHED fire, so a
  // non-delivered wake never consumes a slot. Best-effort; single-flight per loop.
  await incrementFireCount(input.sql ?? undefined, input.routineId).catch(() => {});

  return { fired: true, woken: fan2.woken, staged: fan2.staged };
}
