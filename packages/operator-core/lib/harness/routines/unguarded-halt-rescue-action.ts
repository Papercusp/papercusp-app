/**
 * `system:unguarded-halt-rescue` — the SYSTEM-side leg of the unguarded-halt
 * guard (turn-end-tracking P-016, the enforcement half P-015 deferred).
 *
 * THE DEFECT THIS CLOSES (WI-6054, observed 2026-07-26 on fleet
 * nonp2p-bug-drain-0725): an autonomous agent that ends a turn with no armed
 * loop and no registered event-await has NO wake source left except the
 * always-armed `coord:inbox-wake:` keepalive — which only fires when a HUMAN or
 * a peer messages it. Nothing re-arms it, so it silently halts forever. Four of
 * ten members halted this way for 3.3-4.1h (~14 agent-hours) while 13 items
 * were claimable under their own claim spec.
 *
 * The detector for exactly this already existed and was correct
 * (`turn-end-tracking.detectUnguardedHalt`, assembled from live stores by
 * `turn-end-tracking-io.sweepUnguardedHalt`). Its ONLY production call site,
 * however, was `agent-tools/journal/record-turn.ts` — an AGENT-INVOKED MCP tool.
 * So the guard fired only when the agent voluntarily called `journal:record-turn`
 * at turn end, and an agent that simply STOPS never calls it: the guard was
 * structurally incapable of catching the failure it was built for. This routine
 * moves that SAME sweep onto a system path and re-implements no predicate, so
 * the rescue and the agent-side warning can never disagree about "unguarded".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY TARGETING IS BY *REASON TO WAKE*, NEVER BY LIVENESS
 *
 * The obvious gate — "heartbeat fresh ⇒ the process is alive, so wake it" — is
 * WRONG here, and measurably so. Run against live data on this box, 30+ agents
 * had made no tool call for 6-9 DAYS while still heartbeating every ~50s; a
 * liveness-gated sweep fires a wake storm at long-dead sessions, each wake a
 * real billable turn.
 *
 * The derived `sessionState` oracle does not rescue the design either: those
 * 9-day-abandoned sessions read `state='parked', wakeable=true` — identical to
 * how the four genuine orphans read before they were woken (27 of 41 presence
 * rows were 'parked'). Heartbeat, sessionState and wakeable ALL fail to
 * separate "abandoned" from "recoverable".
 *
 * So this routine does not ask "is it alive?" — no available signal answers
 * that usefully. It asks "is there a REASON to wake it?", which is decidable:
 *   (1) it belongs to a fleet that is still `active`   — an abandoned session's
 *       fleet has wound down, so this alone drops the 6-9-day population;
 *   (2) it holds no work (load 0)                       — nothing to resume;
 *   (3) it is idle INSIDE a window — longer than one turn could plausibly take,
 *       but not so long that it is abandoned rather than halted;
 *   (4) the existing halt predicate trips (no loop, no real await);
 *   (5) AND there is claimable work under that fleet's OWN claim spec.
 * (5) is the decisive one: never wake an agent unless work actually exists for
 * it. Together these encode the real invariant — "an idle agent with a nonempty
 * queue is a bug" — instead of guessing at liveness.
 *
 * STOOD-DOWN SUPPRESSION (EI-21275606411048371, recurring class of dropped
 * EI-18734910825871393): conjunct (4) already requires NO armed loop, so
 * everyone this sweep could wake EITHER never armed one — the silent stall
 * WI-6054 targets — OR ended one. An owner whose engine-loop routine row(s)
 * are now ALL inactive wound down deliberately (`loop:end` is the
 * persona-mandated wind-down act), and re-waking them every throttle hour to
 * re-discover "nothing scoped to do" is itself the defect: each wake a full
 * billable turn, repeated indefinitely because every verification turn
 * refreshes `last_tool_call_at` back INTO the idle window. Those owners are
 * suppressed (see `engine-loop-standdown.ts`); never-armed owners stay fully
 * rescuable, and any reader failure fails OPEN to the unsuppressed sweep.
 *
 * WAKE, not inject: an injected coord message lands on the recipient's NEXT
 * turn, and the defining property of a halted agent is that there will never be
 * a next turn. `claim-discipline-watch` is inject-only for the opposite reason
 * (its targets are live and taking turns; a nudge is not worth a wake).
 *
 * Self-throttled via its OWN outbox (no new state table), the same
 * derived-from-PG, restart-safe pattern as `claim-discipline-action.ts`.
 */
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { groupByAgent, lastToolCallAtByOwner, listFleetAssignments } from '../../fleet/assignments';
import { sendMessage, readOutbox } from '../../agent-tools/coordination/messages';
import { wakeRecipients } from '../../agent-tools/coordination/inbox-wake';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { getClaimSpecRecord } from '../../scheduler/claim-spec-store';
import { claimSpecReferencesField } from '../../scheduler/claim-spec';
import { readIssueClaimability } from '../../scheduler/get-next';
import { boundedUnguardedHaltSweep } from '../../turn-end-tracking-io';
import {
  isStoodDownOwner,
  readEngineLoopRowsByOwner,
  type EngineLoopRowsByOwner,
} from './engine-loop-standdown';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const HALT_RESCUE_OWNER = 'unguarded-halt-rescue';

const RESCUE_IDENTITY: AgentIdentity = {
  ownerId: HALT_RESCUE_OWNER,
  ownerLabel: HALT_RESCUE_OWNER,
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** Marks this routine's own outbox rows so the throttle can find them. */
export const RESCUE_PREFIX = 'unguarded-halt rescue:';

/** One rescue wake per agent per hour. An agent that is woken and halts again is
 *  a real (and interesting) repeat — but it must not become a wake loop billing
 *  a turn every tick. */
export const DEFAULT_RESCUE_THROTTLE_MS = 60 * 60 * 1000;

/**
 * LOWER bound: a halted agent must have taken no turn for at least this long.
 * DELIBERATELY well beyond the 5-min "speaking" window, because an agent that is
 * genuinely working can make NO tool calls for several minutes while one long
 * call runs — a build, a full test suite, a typecheck. Waking it mid-turn is a
 * spurious billable interruption that teaches exactly the wrong lesson.
 */
export const DEFAULT_HALT_IDLE_MS = 15 * 60_000;

/**
 * UPPER bound: past this, the session is ABANDONED, not halted mid-work — the
 * idle reaper's business, not a wake target. Without this bound the sweep reaches
 * the 6-9-day heartbeating population described above. Generous enough to cover
 * a real halt (the observed orphans were 3.3-4.1h idle) and far short of days.
 */
export const DEFAULT_HALT_MAX_IDLE_MS = 6 * 60 * 60_000;

/** Bound the per-tick wake fan. A mass halt (e.g. a host restart) recovers
 *  steadily rather than detonating hundreds of billable turns in one tick. */
export const MAX_RESCUES_PER_TICK = 10;

/** Any agent this routine may consider — fleet member or solo. */
export interface HaltCandidate {
  agentId: string;
  /** The fleet it belongs to, or null for a solo/interactive agent. Carried for
   *  message + auto-arm context ONLY; it is never an exclusion. A halt is a halt
   *  whether or not the agent is in a fleet. */
  fleetSlug: string | null;
  /** Carried for auto-arm context only; never an exclusion. */
  fleetRole?: string | null;
  /** Work-items currently held. load>0 is a REASON TO WAKE, never an exclusion:
   *  a halted HOLDER is the worst case, because the item is claimed (so no peer
   *  will take it) and the holder is silent — a deadlock with no discovery path. */
  load: number;
  /** Epoch ms of the agent's last tool call — its last real TURN activity. */
  lastToolCallMs: number | null;
}

export interface SelectOpts {
  idleMs?: number;
  maxIdleMs?: number;
}

/**
 * PURE: which agents are eligible to be SWEPT this tick.
 *
 * UNIVERSAL BY OWNER DIRECTIVE [owner 2026-09-11, interactive, verbatim:
 * "fix the code so it structurally sees all agents, it shouldn't filter any out
 * for this behavior, we want this behavior universally for all agents"].
 *
 * Two conjuncts were DELIBERATELY REMOVED here (WI-10001032). Do not restore
 * them; each made the sweep structurally blind to a real halt:
 *
 *   (1) FLEET MEMBERSHIP (`!c.fleetSlug || !activeFleets.has(...)`) — dropped
 *       every solo/interactive su session. Its real job was excluding the 6-9-day
 *       ABANDONED population, and `maxIdleMs` below does that directly and
 *       without collateral: abandonment is a time question, not a topology one.
 *   (2) EMPTY-HANDEDNESS (`c.load > 0`) — dropped every halted claim-HOLDER,
 *       which inverts the priority. The old rule encoded "an idle agent with a
 *       nonempty queue is a bug"; a halted holder is strictly worse, since its
 *       claim actively prevents anyone else from picking the work up.
 *
 * What remains is the honest definition of "halted", none of it agent-selective:
 * a throttle (not a filter — a rate limit), and an idle WINDOW whose lower bound
 * avoids interrupting a long legitimate turn and whose upper bound stops at
 * abandonment. See the module doc for why no liveness signal appears here.
 *
 * Ordering is stable by agentId so a capped tick is deterministic and the same
 * agent is not starved.
 */
export function selectSweepCandidates(
  candidates: readonly HaltCandidate[],
  recentlyRescued: ReadonlySet<string>,
  nowMs: number,
  opts: SelectOpts = {},
): HaltCandidate[] {
  const idleMs = opts.idleMs ?? DEFAULT_HALT_IDLE_MS;
  const maxIdleMs = opts.maxIdleMs ?? DEFAULT_HALT_MAX_IDLE_MS;
  return candidates
    .filter((c) => {
      if (!c.agentId) return false;
      if (recentlyRescued.has(c.agentId)) return false;
      // idle INSIDE the window: past a plausible long turn, short of abandoned.
      if (c.lastToolCallMs == null) return false;
      const idle = nowMs - c.lastToolCallMs;
      return idle >= idleMs && idle <= maxIdleMs;
    })
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/**
 * Why this agent is worth a billable wake. `holding` is the deadlock case added
 * by WI-10001032; `claimable` is the original "idle worker, nonempty queue".
 * A candidate with NEITHER is never woken — the sweep stays reason-gated, which
 * is what keeps universal DETECTION from becoming a universal wake storm.
 */
export type WakeReason =
  | { kind: 'holding'; load: number }
  | { kind: 'claimable'; claimable: number; fleetSlug: string | null };

export function wakeReasonFor(
  candidate: Pick<HaltCandidate, 'load' | 'fleetSlug'>,
  claimable: number,
): WakeReason | null {
  if (candidate.load > 0) return { kind: 'holding', load: candidate.load };
  if (claimable > 0) {
    return { kind: 'claimable', claimable, fleetSlug: candidate.fleetSlug ?? null };
  }
  return null;
}

/**
 * PURE: split sweep candidates into rescuable vs STOOD DOWN (the owner has ≥1
 * engine-loop routine row and every such row is inactive ⇒ deliberate
 * wind-down). `loopRows == null` — a failed reader — passes EVERYTHING through,
 * fail-open to the pre-fix behavior: a missed suppression costs one throttled
 * wake, a wrong permanent suppression strands a recoverable halt. Signal
 * semantics + lift conditions live in `engine-loop-standdown.ts`.
 *
 * WI-10001032 — THE HOLDER EXCEPTION. Stand-down excuses an EMPTY-HANDED halt,
 * which is all it was ever built for: an agent that finished, ended its loop and
 * went quiet owes nobody anything. It does NOT excuse halting while still
 * HOLDING a claim. That item is claimed, so no peer can pick it up, and the
 * holder is silent — suppressing it is how a claimed item ends up parked behind
 * a dead holder forever, which is precisely the deadlock this routine exists to
 * break. A holder is therefore never stood down, however deliberate its
 * wind-down looked.
 *
 * The rule lives HERE, beside the suppression it qualifies, so the two cannot
 * drift apart in a caller.
 */
export function partitionStoodDown(
  candidates: readonly HaltCandidate[],
  loopRows: EngineLoopRowsByOwner | null | undefined,
): { rescuable: HaltCandidate[]; stoodDown: HaltCandidate[] } {
  if (loopRows == null) return { rescuable: [...candidates], stoodDown: [] };
  const rescuable: HaltCandidate[] = [];
  const stoodDown: HaltCandidate[] = [];
  for (const c of candidates) {
    const suppressed = isStoodDownOwner(loopRows, c.agentId) && c.load === 0;
    (suppressed ? stoodDown : rescuable).push(c);
  }
  return { rescuable, stoodDown };
}

export function rescueSummary(): string {
  return `${RESCUE_PREFIX} no wake source, and work is waiting`;
}

export function rescueBody(
  fleetSlug: string | null,
  claimable: number,
  loopRepair?: { armed: boolean; reason: string; loopName?: string },
  reason?: WakeReason,
): string {
  const repair = loopRepair?.armed || loopRepair?.reason === 'already-armed'
    ? [
        `SYSTEM REPAIR: your recurring loop is now armed (${loopRepair.loopName ?? 'engine loop'}).`,
        `Verify with loop:status; do not replace it with a second recurrence mechanism.`,
        ``,
      ]
    : [
        `SYSTEM REPAIR COULD NOT ARM YOUR LOOP (${loopRepair?.reason ?? 'not attempted'}).`,
        `After pulling work, restore recurrence with loop:arm before ending this turn.`,
        ``,
      ];
  return [
    `You ended a turn under an autonomous mode with NO guaranteed re-wake: no armed`,
    `engine loop, no registered event-await (the always-armed coord:inbox-wake keepalive`,
    `does not count — it only fires when a human or a peer messages you), and no owner`,
    `present to speak next. Nothing was going to re-invoke you. This wake came from the`,
    `system-side unguarded-halt sweep, not from a peer — there is no one to reply to.`,
    ``,
    ...repair,
    ...(reason?.kind === 'holding'
      ? [
          `You were woken because YOU ARE STILL HOLDING ${reason.load} work-item(s) and had no`,
          `wake source. That is a DEADLOCK, not an idle: the item is CLAIMED, so no peer will`,
          `pick it up, and you were never going to speak again. Nothing would have noticed.`,
          ``,
          `NEXT: re-read what you hold (work_items:get). Then resume it, checkpoint it`,
          `(work_items:checkpoint), or release it (work_items:release) so someone else can.`,
        ]
      : [
          `You were woken because WORK IS ACTUALLY WAITING: ${claimable} item(s) are claimable`,
          `right now under your effective claim spec${fleetSlug ? ` inside fleet "${fleetSlug}"` : ''}. If you`,
          `stopped because your lane looked drained, that verdict had a TIMESTAMP and is stale`,
          `— "drained" is a measurement, not a state.`,
          ``,
          `NEXT: pull work with scheduler:get_next { harness } (it inherits your claim spec).`,
        ]),
    ``,
    `THEN, before you end your next turn, make sure a re-wake actually exists:`,
    `  - loop:arm { intervalSec, goal }   — for ongoing work (verify loop:status.active)`,
    `  - events:await { event }           — when blocked on a specific completion`,
    `  - session:request-compaction { autoContinue: true } — to continue on fresh context`,
    `Ending a turn with none of these is the halt that stranded you.`,
  ].join('\n');
}

/**
 * Read candidate agents + their turn-recency into rows.
 *
 * NOT fleet-scoped, despite the view's name (WI-10001032): `listFleetAssignments({})`
 * passes no `fleet` option, and `harness_shared.fleet_assignment` UNIONs a
 * workspace-scoped PRESENCE branch, so solo/interactive agents appear with
 * fleet_slug=NULL. Verified 2026-09-11: 46 presence + 54 work_item_claim +
 * 16 plan_item_claim rows carried fleet_slug IS NULL, including the halted
 * claim-holder that reported this bug.
 *
 * This is load-bearing. Removing the eligibility filters downstream only matters
 * because the SOURCE already sees these agents; re-scoping this read to fleets
 * would silently restore the original blind spot with every unit test still green,
 * since those inject candidates directly.
 */
export async function readHaltCandidates(): Promise<HaltCandidate[]> {
  const rows = await listFleetAssignments({});
  const agents = groupByAgent(rows);
  const lastCalls = await lastToolCallAtByOwner(agents.map((a) => a.agentId)).catch(
    () => new Map<string, string>(),
  );
  return agents.map((a) => {
    const iso = lastCalls.get(a.agentId);
    const ms = iso ? Date.parse(iso) : NaN;
    return {
      agentId: a.agentId,
      fleetSlug: a.fleetSlug ?? null,
      fleetRole: a.fleetRole ?? null,
      load: a.load ?? 0,
      lastToolCallMs: Number.isFinite(ms) ? ms : null,
    };
  });
}

/**
 * Claimable count under one candidate's EFFECTIVE claim spec — the "is there a
 * reason to wake this member" question. The scheduler resolves specs in the
 * order bee override → fleet inheritance → default, and every caller-relative
 * floor must receive the same member/fleet context as `scheduler:get_next`.
 * Fail-soft to 0, i.e. "rescue nobody", the safe direction for a billable wake.
 */
export interface ClaimabilityForCandidate {
  claimable: number;
  harnessSlug: string;
}

export async function claimabilityForCandidate(
  candidate: Pick<HaltCandidate, 'agentId' | 'fleetSlug'>,
  workspaceId: string,
): Promise<ClaimabilityForCandidate | null> {
  // WI-10001032: a SOLO agent (fleetSlug null) resolves its own effective claim
  // spec by cupId exactly as a fleet member does, so fleetlessness must not
  // short-circuit the claimability read — that was half of what made this sweep
  // blind to non-fleet sessions. The `source === 'default'` fail-closed below is
  // the guard that still matters: it is what stops an unresolved sentinel
  // becoming a broad default-backlog wake, and it applies to solo agents too.
  if (!candidate.agentId) return null;
  try {
    const resolved = await getClaimSpecRecord({ cupId: candidate.agentId, workspaceId });
    // A fleet member whose sentinel is missing/invalid is in the same
    // fail-closed transition state as scheduler:get_next. Never turn that
    // uncertainty into a broad default-backlog rescue wake.
    if (resolved.source === 'default') return null;
    const spec = resolved.spec;
    const harness = resolved.harnessSlug;
    if (!spec || !harness) return null;
    const { breakdown } = await readIssueClaimability(
      spec.view?.filter,
      {
        harness,
        states: spec.states,
        spec,
        workspaceId,
        assignee: candidate.agentId,
        ...(resolved.fleetSlug ? { claimantFleetSlug: resolved.fleetSlug } : {}),
        claimSpecReferencesFleet: claimSpecReferencesField(spec, 'fleet'),
        // EI-21398324268952860: mirror the claim's goal leg, so a halted goal-scoped drain is
        // not judged unrescuable because its own plan lane reads as reserved.
        claimSpecReferencesGoal: claimSpecReferencesField(spec, 'goal'),
      },
      { limit: 1, breakdownOnly: true },
    );
    return { claimable: breakdown.claimable, harnessSlug: harness };
  } catch {
    return null;
  }
}

/** Compatibility/count-only projection retained for the focused scope tests. */
export async function claimableForCandidate(
  candidate: Pick<HaltCandidate, 'agentId' | 'fleetSlug'>,
  workspaceId: string,
): Promise<number> {
  return (await claimabilityForCandidate(candidate, workspaceId))?.claimable ?? 0;
}

registerSystemAction('unguarded-halt-rescue', async (ctx: SystemActionCtx) => {
  // Fail-CLOSED on a flag-IO error, matching fleet-headcount-action: a wake costs
  // a real billable turn, and a missed rescue is recovered by the next tick.
  if (!(await getFlag(FLAGS.UNGUARDED_HALT_RESCUE, 'system').catch(() => false))) return;

  const cfg = ctx.triggerConfig ?? {};
  const num = (v: unknown, fallback: number, scale = 1): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n * scale : fallback;
  };
  const throttleMs = num(cfg.throttle_min, DEFAULT_RESCUE_THROTTLE_MS, 60_000);
  const idleMs = num(cfg.idle_min, DEFAULT_HALT_IDLE_MS, 60_000);
  const maxIdleMs = num(cfg.max_idle_min, DEFAULT_HALT_MAX_IDLE_MS, 60_000);
  const cap = Math.floor(num(cfg.max_per_tick, MAX_RESCUES_PER_TICK));

  const nowMs = Date.now();
  const recent = await readOutbox(HALT_RESCUE_OWNER, {
    since_ts: new Date(nowMs - throttleMs).toISOString(),
  }).catch(() => []);
  const recentlyRescued = new Set(
    recent
      .filter((e) => typeof e.summary === 'string' && e.summary.startsWith(RESCUE_PREFIX))
      .flatMap((e) => e.to),
  );

  const all = await readHaltCandidates();

  // WI-10001032: fleet controlState is deliberately NOT read here any more. It
  // used to gate the entire sweep, which made every solo/interactive session
  // invisible to the one routine built to rescue halts. Abandonment — the thing
  // that gate was really buying — is bounded directly by maxIdleMs.
  const candidates = selectSweepCandidates(all, recentlyRescued, nowMs, {
    idleMs,
    maxIdleMs,
  });
  if (candidates.length === 0) {
    // A quiet sweep must still be OBSERVABLE. Returning silently makes "ran and
    // correctly found nothing" byte-identical to "never ran at all" — and the
    // routines row cannot break the tie, because last_fired_at advances either
    // way (it advanced on every tick while this handler was undeployed and the
    // engine skipped it with a warn). One line per tick is the only cheap proof
    // that the DEPLOYED handler is actually executing, which is exactly what
    // verifying this routine after a deploy requires.
    console.log(
      `[unguarded-halt-rescue] ${all.length} agent(s) → 0 idle inside the halt window → nothing to rescue` +
        (recentlyRescued.size > 0 ? ` (${recentlyRescued.size} within throttle)` : ''),
    );
    return;
  }

  // ── Stood-down suppression (EI-21275606411048371) ──────────────────────────
  // Read BEFORE the per-agent claim-spec fan-out: suppressing here also saves
  // the claimability reads for members we must not wake anyway.
  const loopRows = await readEngineLoopRowsByOwner(
    candidates.map((c) => c.agentId),
    { workspaceId: ctx.workspaceId },
  ).catch(() => null);
  // The holder exception (WI-10001032) lives inside partitionStoodDown, beside
  // the suppression it qualifies, so a caller cannot drift from it.
  const { rescuable, stoodDown } = partitionStoodDown(candidates, loopRows);
  if (rescuable.length === 0) {
    console.log(
      `[unguarded-halt-rescue] ${all.length} agent(s) → ${candidates.length} idle inside the halt window → ` +
        `${stoodDown.length} stood down (engine loop ended, holding nothing) → nothing to rescue`,
    );
    return;
  }

  // Is there work for each candidate? The effective spec, assignee-relative
  // cooldown, and fleet authorization can differ even within one fleet.
  const claimabilityByCandidate = new Map<string, ClaimabilityForCandidate>();
  await Promise.all(
    rescuable.map(async (candidate) => {
      const result = await claimabilityForCandidate(candidate, ctx.workspaceId);
      if (result) claimabilityByCandidate.set(candidate.agentId, result);
    }),
  );
  // WI-10001032: reason-gated, but with TWO reasons now. A holder is woken on
  // the strength of what it is sitting on; an empty-handed agent still needs a
  // nonempty queue. Neither ⇒ never woken, which is what keeps universal
  // DETECTION from becoming a universal wake storm.
  const reasonByCandidate = new Map<string, WakeReason>();
  for (const c of rescuable) {
    const reason = wakeReasonFor(c, claimabilityByCandidate.get(c.agentId)?.claimable ?? 0);
    if (reason) reasonByCandidate.set(c.agentId, reason);
  }
  const withWork = rescuable.filter((c) => reasonByCandidate.has(c.agentId));

  // Only now — for agents that are idle in an active fleet WITH work waiting — is
  // the (more expensive, per-agent) halt predicate worth evaluating.
  const verdicts = await Promise.all(
    withWork.map(async (c) => ({
      c,
      tripwire: await boundedUnguardedHaltSweep({
        ownerId: c.agentId,
        workspaceId: ctx.workspaceId,
      }).catch(() => null),
    })),
  );
  const halted = verdicts.filter((v) => v.tripwire != null);
  const rescuing = halted.slice(0, cap);

  const { autoArmFleetMemberLoop } = await import('./loop');
  for (const { c } of rescuing) {
    const slug = c.fleetSlug;
    const reason = reasonByCandidate.get(c.agentId)!;
    // WI-10001032: both may legitimately be absent now — a solo halted HOLDER is
    // woken on its held work alone and may have no resolved claim spec at all.
    const claimability = claimabilityByCandidate.get(c.agentId) ?? null;
    // EI-21275400284931421: wake is the immediate recovery; arming the existing
    // engine loop is the recurrence fix. Planless members are admitted only
    // because claimabilityForCandidate already resolved their effective authored
    // claim spec and harness. autoArm repeats that fail-closed check at the write
    // boundary so a concurrent sentinel removal cannot widen the member.
    // WI-10001032: auto-arm still requires a fleet member WITH a resolved harness
    // (autoArmFleetMemberLoop hard-returns 'not-a-member' otherwise). A solo agent
    // therefore gets the WAKE — the immediate recovery, and the whole point of the
    // widening — plus the message's explicit "could not arm" branch telling it to
    // run loop:arm itself. Widening auto-arm to fleetless agents is a separate
    // change against a riskier seam; it is NOT a precondition for the rescue.
    const loopRepair =
      slug && claimability
        ? await autoArmFleetMemberLoop({
            workspaceId: ctx.workspaceId,
            ownerId: c.agentId,
            harnessSlug: claimability.harnessSlug,
            planSlug: null,
            fleetSlug: slug,
            fleetRole: 'member',
          })
        : { armed: false, reason: 'no-fleet-loop-template-for-solo-agent' };
    const claimable = claimability?.claimable ?? 0;
    // Durable inbox row first (the record survives even if the wake fan fails),
    // then the wake — the same ordering coord:send uses.
    await sendMessage(RESCUE_IDENTITY, {
      to: [c.agentId],
      summary: rescueSummary(),
      body: rescueBody(slug, claimable, loopRepair, reason),
    }).catch((e) =>
      console.warn(`[unguarded-halt-rescue] inbox write for ${c.agentId} failed:`, (e as Error)?.message ?? e),
    );
    await wakeRecipients([c.agentId], {
      summary: rescueSummary(),
      source: HALT_RESCUE_OWNER,
      workspaceId: ctx.workspaceId,
    }).catch((e) =>
      console.warn(`[unguarded-halt-rescue] wake for ${c.agentId} failed:`, (e as Error)?.message ?? e),
    );
  }

  console.log(
    `[unguarded-halt-rescue] ${all.length} member(s) → ${candidates.length} idle in an active fleet → ` +
      `${stoodDown.length} stood down → ${rescuable.length} rescuable → ` +
      `${withWork.length} with claimable work → ${halted.length} halted → ${rescuing.length} woken` +
      (halted.length > rescuing.length ? ` (${halted.length - rescuing.length} deferred)` : '') +
      (recentlyRescued.size > 0 ? `, ${recentlyRescued.size} within throttle` : ''),
  );
});
