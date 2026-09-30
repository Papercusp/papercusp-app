/**
 * silent-halt-reconcile — a STANDING reconciler for the autonomous session that went
 * inert for a reason no code path was executing to notice (WI-35718).
 *
 * THE GAP THIS CLOSES. Two point-fixes already page the owner at the moment they silence a
 * session: `loop-dead-man.ts` on a maxFires/maxDurationSec breach, and `stalled-loops-guard.ts`
 * on a disarm of a still-reachable session. Both fire only on the specific code path that does
 * the silencing. A session that goes inert for any OTHER reason — a crashed CLI child, a died
 * carry-respawn, a wedged host, a dropped socket ack booked as `delivered`, a zero-tool
 * escalation whose real cause was a provider usage wall — is caught by nothing, because at that
 * moment there is no executing code to notice. Only a sweep run from OUTSIDE the halted session
 * can see it.
 *
 * WHY THE OWNER, NEVER THE AGENT'S OWN INBOX. Delivery-to-inbox does not wake a session.
 * `claim-discipline-watch` fired at su-1f7ee244 roughly hourly for the FULL four days it was
 * inert; every one landed in an inbox nobody would ever read. The system already HELD the signal
 * and spent it on a dead channel. A watchdog that repeats the same finding at the same agent for
 * four days without escalating CHANNEL is not a detector, it is a metronome.
 *
 * ── WHY THIS PAGES ONLY ABOUT A SESSION THAT HOLDS WORK ───────────────────────────────────────
 *
 * WI-35718 states its conjunction and calls it "an unambiguous silently-halted autonomous
 * agent". Measured against live PG before this file was written, it is not unambiguous — as
 * written it selects ~4,037 rows, because ~4,091 candidates have no coord_presence row at all.
 * Presence is reaped, so a mode row beside an inactive loop is the normal terminal RESIDUE every
 * cleanly-ended session leaves behind forever. Adding a presence join drops that ~60x, and the
 * item's own `no pending await` term drops it again (an await IS a wake source).
 *
 * That gets the population small. It does NOT establish that the survivors are halted, and the
 * distinction matters because `unguarded-halt-rescue-action.ts` (2026-07-26, which PRE-dates
 * this item and which the item does not mention) already targets this failure class — and its
 * own measurement contradicts the obvious gate head-on:
 *
 *     "The obvious gate — heartbeat fresh ⇒ the process is alive, so wake it — is WRONG here,
 *      and measurably so. 30+ agents had made no tool call for 6-9 DAYS while still heartbeating
 *      every ~50s."
 *
 * So heartbeat-fresh proves a PROCESS EXISTS; it does not separate halted-and-recoverable from
 * abandoned, and no available signal does (that module reports sessionState and wakeable failing
 * the same way). It therefore targets by REASON TO WAKE — fleet still active, load 0, and work
 * actually claimable — and WAKES the agent, which is strictly better than bothering a human.
 *
 * This module must not re-litigate that. It takes the one case that design provably EXCLUDES:
 * its conjunct (2) requires load 0 ("nothing to resume"), so a halted session that HOLDS a
 * claimed work-item is rescued by nothing. That case is worth a human, and it is the only one
 * here that survives the abandoned-vs-halted ambiguity — because it does not depend on resolving
 * it. Either way the held item is STRANDED: the owner is heartbeat-fresh, so the dead-owner claim
 * reaper does not reclaim it, and the session takes no turns, so nothing advances it. The work
 * sits claimed and unworkable until a human looks. Whether the agent behind it is recoverable or
 * abandoned changes the remedy, not the fact that one is needed.
 *
 * Hence: liveness NARROWS the population, held work JUSTIFIES the page. Neither alone is enough,
 * and paging on liveness alone is the mistake the counter-design already measured.
 *
 * WHY REUSE getLoopStatuses. `lastRealTurnAt` is a union over the journal and session_turns'
 * assistant turns (loop.ts ~line 2000) and has under-reported twice already (WI-6069 and its
 * follow-up), both times in the direction of a healthy agent reading as dead. This module reads
 * it through the SAME accessor `loop:status` and `stalled-loops-guard` use rather than
 * re-deriving it, so a future correction lands here for free and cannot drift into a second,
 * subtly-different definition of "produced a turn".
 *
 * RECURRENCE GUARD. One owner-visible escalation per (owner, disarm epoch), via
 * `notifyAttention`'s `dedupeKey`. A session that stays halted does not re-page; one that is
 * re-armed and later halts AGAIN has a new epoch and does page, because that is a new fault.
 * This is the direct answer to the metronome above.
 *
 * SAFETY / FAILURE DIRECTION. Every ambiguity resolves toward SILENCE except one. No presence
 * row, a stale heartbeat, any pending await, an armed loop, or no autonomy posture all mean "not
 * my case". The single deliberate exception is inherited from `hasAutonomyPosture`: an UNKNOWN
 * mode id counts as autonomous, because a spurious page costs one notification while a missed
 * one costs days.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { AttentionNotifyInput } from '../../attention-notify';
import { hasAutonomyPosture } from './loop-dead-man';
import { getLoopStatuses } from './loop';
import { readEngineLoopRowsByOwner } from './engine-loop-standdown';
import { classifyEndedHolder, type SessionEndClassification } from '../../session-end-classifier';
import {
  resolveFleetParkResumePath,
  describeParkResumePath,
  type FleetParkResumePath,
} from '../../fleet-park-resume-path';

/**
 * A heartbeat older than this means the PROCESS is gone, not halted — the fifth term measured
 * above. Deliberately generous relative to the ~30s presence beat: a missed beat or two under
 * load must not be read as death, because reading a live agent as gone is how this module would
 * stop reporting the very thing it exists to find.
 */
export const SILENT_HALT_HEARTBEAT_FRESH_MS = 10 * 60 * 1000;

/**
 * Floor under the staleness test, whatever the loop's interval. A 60s loop must not page 5
 * minutes after a disarm that an agent is about to correct itself — most disarms are transient
 * and self-heal, and the cost of waiting is bounded while the cost of a false page is trust.
 */
export const SILENT_HALT_MIN_STALE_MS = 30 * 60 * 1000;

/** Multiple of the loop's own interval that must elapse with no real turn. */
export const SILENT_HALT_STALE_INTERVALS = 5;

/** Never page about more owners than this in one pass — a mass-halt is ONE incident. */
export const SILENT_HALT_MAX_PAGES_PER_SWEEP = 5;

/** Bound the per-sweep WAKE fan the same way (P-003 R2): a mass halt recovers steadily. */
export const SILENT_HALT_MAX_WAKES_PER_SWEEP = 5;

/** Outbox identity for the wake-first rung — its own sent rows ARE the markers that
 *  make the one-wake-per-(owner, disarm-epoch) bound restart-safe with NO new table
 *  (R2), the same derived-from-PG pattern as `unguarded-halt-rescue-action.ts`. */
export const SILENT_HALT_WAKE_OWNER = 'silent-halt-reconcile';

/** Marks this rung's own outbox rows so the epoch dedupe can find them. */
export const SILENT_HALT_WAKE_PREFIX = 'silent-halt wake:';

/**
 * The disarm-epoch token BOTH actuations key on: the disarm INSTANT in epoch-minutes
 * (stable across sweeps — `now - inactiveFor` reproduces `active_changed_at`), or
 * 'unknown' when no disarm timestamp exists. The page dedupeKey and the wake marker
 * MUST share this derivation, or the two rungs would disagree about what "once per
 * epoch" means.
 */
export function disarmEpochToken(nowMs: number, inactiveForMs: number | null): string {
  return inactiveForMs != null ? String(Math.round((nowMs - inactiveForMs) / 60000)) : 'unknown';
}

/** The exact outbox summary a wake attempt writes — doubling as its dedupe marker. */
export function wakeMarkerSummary(ownerId: string, epochToken: string): string {
  return `${SILENT_HALT_WAKE_PREFIX} ${ownerId}:${epochToken}`;
}

/**
 * The member-facing wake text (P-003). Unlike the rescue's body this addresses a
 * session that HOLDS work: the ask is resume-or-release, then restore a wake source.
 * A parked fleet's member also gets its park's way back VERBATIM
 * (`describeParkResumePath`), so the key it should await is copied, never re-typed.
 */
export function silentHaltWakeBody(
  candidate: SilentHaltCandidate,
  verdict: SilentHaltVerdict,
  parkPath: FleetParkResumePath | null,
): string {
  const park = parkPath?.parked
    ? [
        ``,
        `Your fleet${candidate.fleetSlug ? ` "${candidate.fleetSlug}"` : ''} has a park directive in force:`,
        describeParkResumePath(parkPath),
      ]
    : [];
  return [
    `You are an autonomous session that stopped taking turns while still HOLDING ` +
      `${candidate.heldWorkItems} work-item(s): ${verdict.reason ?? 'no armed loop, no pending await — no wake source'}.`,
    ``,
    `This wake came from the system-side silent-halt sweep (${SILENT_HALT_WAKE_OWNER}), not from a`,
    `peer — there is no one to reply to. It is the ONE wake this disarm epoch gets: if you take no`,
    `real turn, the next sweep tick pages the human owner about the stranded work.`,
    ``,
    `NEXT, in this turn:`,
    `  1. Re-read each held item's checkpoint (work_items:get) and either RESUME the work or`,
    `     work_items:checkpoint + work_items:release what you cannot continue.`,
    `  2. Restore a real wake source before ending the turn: loop:arm { intervalSec, goal }`,
    `     (verify loop:status.active) or events:await { event } when blocked on a completion.`,
    `  3. If you deliberately stopped (loop:end), note that a clean wind-down releases held claims`,
    `     first — holding work with no wake source is exactly the strand this sweep exists to catch.`,
    ...park,
  ].join('\n');
}

export interface SilentHaltInput {
  /** Loop routine `active`. An ARMED loop is stalled-loops-guard's domain, never this one. */
  loopActive: boolean;
  /** Result of `hasAutonomyPosture` over the owner's registered modes. */
  hasPosture: boolean;
  /** Un-fired, un-cancelled, un-expired awaits. Any at all is a live wake source. */
  pendingAwaits: number;
  /** Age of the presence heartbeat. `null` = no presence row = gone, not halted. */
  heartbeatAgeMs: number | null;
  /** Age of the last REAL turn (`lastRealTurnAt`); `null` when none was ever produced. */
  lastRealTurnAgeMs: number | null;
  /** How long the loop has been inactive (`active_changed_at`); `null` when unknown. */
  inactiveForMs: number | null;
  /** The loop's own cadence, for the interval-relative staleness floor. */
  intervalSec: number | null;
  /**
   * Non-terminal work-items this session still holds. ZERO means `unguarded-halt-rescue` owns
   * the case (it wakes exactly the load-0 population) and this module must stay silent; only a
   * HELD item makes the strand concrete enough to justify a human. See the header.
   */
  heldWorkItems: number;
}

export interface SilentHaltVerdict {
  halted: boolean;
  /** Why it IS a halt — populated only when `halted`. */
  reason: string | null;
  /** Why it is NOT — populated only when not `halted`. Every exemption is named, never silent. */
  exemption: string | null;
  /** The floor actually applied, so a verdict can be explained without re-deriving it. */
  staleFloorMs: number;
}

/**
 * The pure verdict. Split out from the sweep so the conjunction is testable without PG, and so
 * the exemption that fired is always nameable — an unexplained silence is indistinguishable
 * from a broken detector, which is the failure mode this whole module is about.
 */
export function evaluateSilentHalt(input: SilentHaltInput): SilentHaltVerdict {
  const intervalMs =
    input.intervalSec != null && Number.isFinite(input.intervalSec) && input.intervalSec > 0
      ? input.intervalSec * 1000
      : 0;
  const staleFloorMs = Math.max(SILENT_HALT_MIN_STALE_MS, intervalMs * SILENT_HALT_STALE_INTERVALS);
  const no = (exemption: string): SilentHaltVerdict => ({ halted: false, reason: null, exemption, staleFloorMs });

  // An ARMED loop that stopped producing turns is a different fault with a different remedy,
  // owned by stalled-loops-guard. Two modules acting on one signal is how a fleet gets disarmed
  // twice for one cause.
  if (input.loopActive) return no('loop-armed (stalled-loops-guard owns this case)');

  // A session with no autonomy posture has a human in front of it who will see the next turn.
  if (!input.hasPosture) return no('no-autonomy-posture (interactive session)');

  // An await IS a wake source. 63 of 67 live candidates were exempt here — this term, not
  // liveness, is what separates a waiting agent from a halted one.
  if (input.pendingAwaits > 0) return no(`pending-await x${input.pendingAwaits} (a live wake source)`);

  // No presence row = reaped = long gone. This is the ~60x collapse, and omitting it is what
  // turns this detector into a metronome. It NARROWS the population; it does not establish that
  // a survivor is halted rather than abandoned — see the header, and the held-work term below.
  if (input.heartbeatAgeMs == null) return no('no-presence-row (session is gone, not halted)');
  if (input.heartbeatAgeMs > SILENT_HALT_HEARTBEAT_FRESH_MS) {
    return no(`heartbeat-stale ${Math.round(input.heartbeatAgeMs / 60000)}m (process gone, not halted)`);
  }

  // THE TERM THAT JUSTIFIES A PAGE. A load-0 halt is `unguarded-halt-rescue`'s case and it WAKES
  // that agent — strictly better than bothering a human, so this module must not double-report
  // it. Only a HELD item makes the strand concrete: heartbeat-fresh means the dead-owner reaper
  // will not reclaim it, and a session taking no turns will not advance it, so it is stuck
  // whether the agent is recoverable OR abandoned. That is what makes this the one case here
  // that does not depend on a distinction no available signal can make.
  if (input.heldWorkItems <= 0) {
    return no('holds-no-work (unguarded-halt-rescue wakes this case; nothing is stranded)');
  }

  // Both clocks must clear the floor. A loop disarmed seconds ago is not yet a halt however old
  // the last turn is, and a turn produced seconds ago is not a halt however long the loop has
  // been off — either one alone would page an agent that is actively recovering.
  const turnAge = input.lastRealTurnAgeMs;
  const inactiveFor = input.inactiveForMs;
  if (inactiveFor != null && inactiveFor <= staleFloorMs) {
    return no(`recently-disarmed ${Math.round(inactiveFor / 60000)}m (below floor)`);
  }
  if (turnAge != null && turnAge <= staleFloorMs) {
    return no(`recent-turn ${Math.round(turnAge / 60000)}m (below floor)`);
  }
  // Never produced a turn AND never recorded a disarm time: nothing establishes duration, so
  // there is no evidence of a HALT as opposed to a session that has not started. Fail quiet.
  if (turnAge == null && inactiveFor == null) {
    return no('no-duration-evidence (neither a real turn nor a disarm timestamp)');
  }

  const silentForMs = Math.max(turnAge ?? 0, inactiveFor ?? 0);
  return {
    halted: true,
    reason:
      `autonomy posture registered, loop INACTIVE for ` +
      `${inactiveFor != null ? `${Math.round(inactiveFor / 60000)}m` : 'unknown'}, ` +
      `no pending await, heartbeat fresh (${Math.round(input.heartbeatAgeMs / 1000)}s) but ` +
      `${turnAge != null ? `no real turn in ${Math.round(turnAge / 60000)}m` : 'no real turn ever recorded'}`,
    exemption: null,
    staleFloorMs: silentForMs > 0 ? staleFloorMs : staleFloorMs,
  };
}

/** One candidate as read from PG, before the verdict is applied. */
export interface SilentHaltCandidate {
  ownerId: string;
  workspaceId: string;
  routineId: string;
  intervalSec: number | null;
  heartbeatAgeMs: number | null;
  inactiveForMs: number | null;
  pendingAwaits: number;
  /** Non-terminal, non-observation work-items this session still holds (`taken_by`). */
  heldWorkItems: number;
  modes: Array<{ mode: string }>;
  /** Fleet the session belongs to (presence row), for the park-contract framing. */
  fleetSlug?: string | null;
}

/** One wake marker row as the rung reads it back from its own outbox. */
export interface SilentHaltWakeMarker {
  to: readonly string[];
  summary?: string | null;
  /** ISO-8601 — when the wake was attempted. */
  ts?: string | null;
}

export interface SilentHaltSweepDeps {
  /** Injectable for tests; defaults to the real candidate read. */
  readCandidates?: (workspaceId: string, sql: Sql) => Promise<SilentHaltCandidate[]>;
  /** Injectable for tests; defaults to the shared `getLoopStatuses` accessor. */
  readLoopStatuses?: typeof getLoopStatuses;
  /** Injectable for tests; defaults to a dynamically-imported `notifyAttention`. */
  notify?: (payload: AttentionNotifyInput & { dedupeKey?: string }) => Promise<void>;
  nowMs?: number;
  /** P-003 wake-first rung on/off. Defaults to the SILENT_HALT_WAKE_FIRST flag (fail-closed). */
  wakeFirstEnabled?: boolean;
  /** Reads this rung's own outbox markers; defaults to `readOutbox(SILENT_HALT_WAKE_OWNER)`. */
  readWakeMarkers?: (sinceIso: string) => Promise<readonly SilentHaltWakeMarker[]>;
  /** Writes the durable marker/inbox row (BEFORE the wake fires); defaults to `sendMessage`. */
  sendWakeMessage?: (ownerId: string, summary: string, body: string) => Promise<void>;
  /** Fires the actual wake; defaults to `wakeRecipients`. */
  fireWake?: (ownerId: string, summary: string, workspaceId: string) => Promise<void>;
  /** Engine-loop rows for the end classification; defaults to `readEngineLoopRowsByOwner`. */
  readEngineLoopRows?: typeof readEngineLoopRowsByOwner;
  /** Fleet park path for the park-contract framing; defaults to `getFleet` + resolver. */
  readFleetParkPath?: (workspaceId: string, fleetSlug: string) => Promise<FleetParkResumePath | null>;
}

export interface SilentHaltSweepResult {
  checked: number;
  halted: string[];
  paged: string[];
  /** Owners the wake-first rung WOKE this tick (P-003) — deliberately NOT paged this tick. */
  woken: string[];
  /** ownerId → the named exemption, so a zero-page sweep is explicable rather than mute. */
  exempt: Record<string, string>;
  dryRun: boolean;
  /** True when more wake-spent halts were found than `SILENT_HALT_MAX_PAGES_PER_SWEEP`. */
  pageCapReached: boolean;
  /** True when more unwoken halts were found than `SILENT_HALT_MAX_WAKES_PER_SWEEP`. */
  wakeCapReached: boolean;
}

/**
 * Read the candidate set. Deliberately CHEAP and broad: it applies only the terms expressible as
 * a cheap index-friendly predicate and leaves every judgement to `evaluateSilentHalt`, so the
 * verdict has exactly one home.
 *
 * NOTE the `event_awaits` scoping. That table stores every row under the literal
 * workspace_id='default' (the corpus namespace, hardcoded in search/session-ingest.ts), so it
 * MUST be joined on `subscriber_id` alone. Filtering it by a real workspace matches zero rows
 * and silently disables the no-pending-await term while returning a clean, confident result —
 * measured live while writing this file, and the reason the term is joined this way.
 */
async function defaultReadCandidates(workspaceId: string, sql: Sql): Promise<SilentHaltCandidate[]> {
  const rows = await sql<
    Array<{
      owner_id: string;
      workspace_id: string;
      routine_id: string;
      interval_sec: number | null;
      fleet_slug: string | null;
      heartbeat_age_ms: string | number | null;
      inactive_for_ms: string | number | null;
      pending_awaits: string | number | null;
      held_work_items: string | number | null;
      modes: string[] | null;
    }>
  >`
    WITH loops AS (
      SELECT r.id AS routine_id, r.target_owner_id AS owner_id, r.workspace_id,
             r.reschedule_interval_sec AS interval_sec, r.active_changed_at
        FROM harness_shared.routines r
       WHERE r.name LIKE 'loop-%'
         AND r.target_owner_id IS NOT NULL
         AND r.workspace_id = ${workspaceId}
         AND r.active = false
    ), awaits AS (
      SELECT subscriber_id, count(*)::int AS n
        FROM harness_shared.event_awaits
       WHERE fired_at IS NULL AND cancelled_at IS NULL
         AND (expires_ts IS NULL OR expires_ts > now())
       GROUP BY 1
    )
    SELECT l.routine_id, l.owner_id, l.workspace_id, l.interval_sec,
           p.fleet_slug,
           round(extract(epoch from (now() - p.heartbeat_at)) * 1000)     AS heartbeat_age_ms,
           round(extract(epoch from (now() - l.active_changed_at)) * 1000) AS inactive_for_ms,
           COALESCE(a.n, 0)                                                AS pending_awaits,
           -- lane <> 'observation' is load-bearing: work_items also holds agents' own turn-end
           -- notes, which are never claimed work and would make every session look loaded.
           (SELECT count(*)::int FROM harness_shared.work_items w
             WHERE w.taken_by = l.owner_id
               AND w.lane IS DISTINCT FROM 'observation'
               AND w.status NOT IN ('done','dropped','passed','deprecated','resolved','closed'))
                                                                           AS held_work_items,
           array_agg(DISTINCT m.mode)                                      AS modes
      FROM loops l
      JOIN harness_shared.agent_modes m
        ON m.owner_id = l.owner_id AND m.workspace_id = l.workspace_id
      JOIN harness_shared.coord_presence p
        ON p.owner_id = l.owner_id AND p.workspace_id = l.workspace_id
      LEFT JOIN awaits a ON a.subscriber_id = l.owner_id
     WHERE p.heartbeat_at > now() - make_interval(secs => ${SILENT_HALT_HEARTBEAT_FRESH_MS / 1000})
     GROUP BY l.routine_id, l.owner_id, l.workspace_id, l.interval_sec,
              p.fleet_slug, p.heartbeat_at, l.active_changed_at, a.n`;

  return rows.map((r) => ({
    ownerId: r.owner_id,
    workspaceId: r.workspace_id,
    routineId: r.routine_id,
    intervalSec: r.interval_sec == null ? null : Number(r.interval_sec),
    heartbeatAgeMs: r.heartbeat_age_ms == null ? null : Number(r.heartbeat_age_ms),
    inactiveForMs: r.inactive_for_ms == null ? null : Number(r.inactive_for_ms),
    pendingAwaits: Number(r.pending_awaits ?? 0),
    heldWorkItems: Number(r.held_work_items ?? 0),
    modes: (r.modes ?? []).filter(Boolean).map((mode) => ({ mode })),
    fleetSlug: r.fleet_slug ?? null,
  }));
}

/**
 * Sweep for silently-halted autonomous sessions and page the OWNER once per halt epoch.
 *
 * Writes nothing to the loop. Unlike its siblings this module does NOT disarm, re-arm, or
 * otherwise touch the session: by construction its subjects are already stopped, and the one
 * thing a halted agent provably cannot do is act on a message. The remedy is a human.
 */
export async function sweepSilentHalts(opts: {
  workspaceId: string;
  dryRun?: boolean;
  sql?: Sql;
  deps?: SilentHaltSweepDeps;
}): Promise<SilentHaltSweepResult> {
  const deps = opts.deps ?? {};
  const sql = opts.sql ?? getOrgPg().sql;
  const dryRun = opts.dryRun === true;
  const nowMs = deps.nowMs ?? Date.now();

  const readCandidates = deps.readCandidates ?? defaultReadCandidates;
  const candidates = await readCandidates(opts.workspaceId, sql);

  const result: SilentHaltSweepResult = {
    checked: candidates.length,
    halted: [],
    paged: [],
    woken: [],
    exempt: {},
    dryRun,
    pageCapReached: false,
    wakeCapReached: false,
  };
  if (candidates.length === 0) return result;

  // One round-trip for every candidate's lastRealTurnAt, through the SAME accessor loop:status
  // uses — never a second local derivation of "produced a turn".
  const readStatuses = deps.readLoopStatuses ?? getLoopStatuses;
  let statuses: Awaited<ReturnType<typeof getLoopStatuses>>;
  try {
    statuses = await readStatuses(
      candidates.map((c) => c.ownerId),
      { sql },
    );
  } catch (e) {
    console.warn(
      `[silent-halt-reconcile] loop-status read failed; sweeping without turn evidence: ` +
        `${e instanceof Error ? e.message : e}`,
    );
    statuses = new Map();
  }

  const halted: Array<{
    candidate: SilentHaltCandidate;
    verdict: SilentHaltVerdict;
    lastRealTurnAtMs: number | null;
  }> = [];
  for (const c of candidates) {
    const status = statuses.get(c.ownerId);
    const lastRealTurnAt = status?.lastRealTurnAt ?? null;
    const lastRealTurnAgeMs = lastRealTurnAt ? nowMs - Date.parse(lastRealTurnAt) : null;

    const verdict = evaluateSilentHalt({
      // Re-read `active` from the status when available: the candidate query and this read are
      // separate round-trips, and an agent that re-armed in between must not be paged about.
      loopActive: status?.active === true,
      hasPosture: hasAutonomyPosture(c.modes),
      pendingAwaits: c.pendingAwaits,
      heartbeatAgeMs: c.heartbeatAgeMs,
      lastRealTurnAgeMs: Number.isFinite(lastRealTurnAgeMs as number) ? lastRealTurnAgeMs : null,
      inactiveForMs: c.inactiveForMs,
      intervalSec: c.intervalSec,
      heldWorkItems: c.heldWorkItems,
    });

    if (!verdict.halted) {
      result.exempt[c.ownerId] = verdict.exemption ?? 'unspecified';
      continue;
    }
    result.halted.push(c.ownerId);
    halted.push({
      candidate: c,
      verdict,
      lastRealTurnAtMs:
        lastRealTurnAt != null && Number.isFinite(Date.parse(lastRealTurnAt))
          ? Date.parse(lastRealTurnAt)
          : null,
    });
  }

  if (halted.length === 0 || dryRun) return result;

  // ── P-003 wake-first rung (R1/R2) ──────────────────────────────────────────────
  // ONE wake attempt per (owner, disarm epoch) BEFORE any owner page. The dedupe
  // marker is this rung's own outbox row — written before the wake fires, so a crash
  // between the two counts as attempted (never a re-wake storm), and the whole bound
  // is derived from PG with no new table (R2). The page becomes the NEXT tick's
  // fallback when the wake demonstrably produced no recovery (plan D-001/D-004).
  const wakeFirstEnabled =
    deps.wakeFirstEnabled ??
    (await (async () => {
      const [{ getFlag }, { FLAGS }] = await Promise.all([
        import('@papercusp/flags/server'),
        import('@papercusp/flags'),
      ]);
      return getFlag(FLAGS.SILENT_HALT_WAKE_FIRST, 'system');
    })().catch(() => false)); // fail-CLOSED: a wake is a billable turn; the page is the established fallback

  // Read the markers. A FAILED read must disable the rung for this tick (page-only,
  // the pre-P-003 behavior) rather than read as "no marker": that direction would
  // re-wake every candidate on every tick for as long as the read stays broken.
  let markers: readonly SilentHaltWakeMarker[] | null = null;
  if (wakeFirstEnabled) {
    const readMarkers =
      deps.readWakeMarkers ??
      (async (sinceIso: string): Promise<readonly SilentHaltWakeMarker[]> => {
        const { readOutbox } = await import('../../agent-tools/coordination/messages');
        return readOutbox(SILENT_HALT_WAKE_OWNER, { since_ts: sinceIso });
      });
    // Look back to the oldest disarm among the halted (plus slack), bounded at 14d.
    const oldestDisarmMs = halted.reduce(
      (min, h) =>
        h.candidate.inactiveForMs != null ? Math.min(min, nowMs - h.candidate.inactiveForMs) : min,
      nowMs,
    );
    const lookbackMs = Math.min(
      Math.max(nowMs - oldestDisarmMs + 60 * 60 * 1000, 60 * 60 * 1000),
      14 * 24 * 60 * 60 * 1000,
    );
    try {
      markers = await readMarkers(new Date(nowMs - lookbackMs).toISOString());
    } catch (e) {
      markers = null;
      console.warn(
        `[silent-halt-reconcile] wake-marker read failed; falling back to page-only this tick: ` +
          `${e instanceof Error ? e.message : e}`,
      );
    }
  }
  const rungLive = wakeFirstEnabled && markers != null;

  // End classification (plan D-003/D-005): consumed for FRAMING — the wake body tells
  // a parked member its way back, and the page tells the owner what kind of stop this
  // was. It deliberately does NOT gate the wake: every candidate here has an inactive
  // loop row by construction (the candidate query keys on them), so the standdown
  // conjunct is uniformly true over this population and gating on it would nullify R1.
  const readRows = deps.readEngineLoopRows ?? readEngineLoopRowsByOwner;
  const loopRows = await readRows(
    halted.map((h) => h.candidate.ownerId),
    { workspaceId: opts.workspaceId, sql },
  ).catch(() => null);
  const readParkPath =
    deps.readFleetParkPath ??
    (async (workspaceId: string, fleetSlug: string): Promise<FleetParkResumePath | null> => {
      const { getFleet } = await import('../../agent-fleets-store');
      const fleet = await getFleet(workspaceId, fleetSlug).catch(() => null);
      return fleet ? resolveFleetParkResumePath(fleet, nowMs) : null;
    });
  const parkBySlug = new Map<string, FleetParkResumePath | null>();
  const parkFor = async (c: SilentHaltCandidate): Promise<FleetParkResumePath | null> => {
    const slug = c.fleetSlug ?? null;
    if (!slug) return null;
    if (!parkBySlug.has(slug)) {
      parkBySlug.set(slug, await readParkPath(opts.workspaceId, slug).catch(() => null));
    }
    return parkBySlug.get(slug) ?? null;
  };

  type ActuationEntry = (typeof halted)[number] & {
    epochToken: string;
    marker: SilentHaltWakeMarker | null;
    classification: SessionEndClassification;
    parkPath: FleetParkResumePath | null;
  };
  const entries: ActuationEntry[] = [];
  for (const h of halted) {
    const epochToken = disarmEpochToken(nowMs, h.candidate.inactiveForMs);
    const summary = wakeMarkerSummary(h.candidate.ownerId, epochToken);
    const marker = rungLive ? ((markers ?? []).find((m) => m.summary === summary) ?? null) : null;
    const parkPath = await parkFor(h.candidate);
    entries.push({
      ...h,
      epochToken,
      marker,
      classification: classifyEndedHolder({
        engineLoopRows: loopRows,
        ownerId: h.candidate.ownerId,
        parkPath,
        heldWorkItems: h.candidate.heldWorkItems,
      }),
      parkPath,
    });
  }

  const toWake = rungLive ? entries.filter((e) => e.marker == null) : [];
  const toPage = rungLive ? entries.filter((e) => e.marker != null) : entries;

  // WAKE leg — bounded fan (R2). Overflow is DEFERRED whole: an unwoken candidate has
  // not had its R1 wake yet, so it must not fall through to the page either.
  result.wakeCapReached = toWake.length > SILENT_HALT_MAX_WAKES_PER_SWEEP;
  const waking = toWake.slice(0, SILENT_HALT_MAX_WAKES_PER_SWEEP);
  if (waking.length > 0) {
    const send =
      deps.sendWakeMessage ??
      (async (ownerId: string, summary: string, body: string) => {
        const { sendMessage } = await import('../../agent-tools/coordination/messages');
        await sendMessage(
          {
            ownerId: SILENT_HALT_WAKE_OWNER,
            ownerLabel: SILENT_HALT_WAKE_OWNER,
            source: 'static-client',
            workspaceId: null,
            userId: null,
          },
          { to: [ownerId], summary, body },
        );
      });
    const fire =
      deps.fireWake ??
      (async (ownerId: string, summary: string, workspaceId: string) => {
        const { wakeRecipients } = await import('../../agent-tools/coordination/inbox-wake');
        await wakeRecipients([ownerId], { summary, source: SILENT_HALT_WAKE_OWNER, workspaceId });
      });
    for (const e of waking) {
      const owner = e.candidate.ownerId;
      const summary = wakeMarkerSummary(owner, e.epochToken);
      try {
        // Marker FIRST: an unmarked wake would break the ≤1-per-epoch bound on the next
        // tick. If the marker cannot be written, skip the wake — the next tick retries.
        await send(owner, summary, silentHaltWakeBody(e.candidate, e.verdict, e.parkPath));
      } catch (err) {
        console.warn(
          `[silent-halt-reconcile] wake marker write for ${owner} failed (wake skipped): ` +
            `${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
      await fire(owner, summary, opts.workspaceId).catch((err) =>
        console.warn(
          `[silent-halt-reconcile] wake for ${owner} failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
      result.woken.push(owner);
    }
  }

  if (toPage.length === 0) return result;

  // PAGE leg — unchanged mechanics; with the rung live it now fires only for a
  // candidate whose disarm epoch already spent its wake attempt.
  // A mass halt is ONE incident (a wedged host, a deploy, an operator restart), not N — page a
  // bounded sample and name the total, the same reasoning stalled-loops-guard applies to its
  // fleet-wide broadcast.
  result.pageCapReached = toPage.length > SILENT_HALT_MAX_PAGES_PER_SWEEP;
  const paging = toPage.slice(0, SILENT_HALT_MAX_PAGES_PER_SWEEP);

  const notify =
    deps.notify ??
    (async (payload: AttentionNotifyInput & { dedupeKey?: string }) => {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention(payload);
    });

  for (const { candidate, verdict, epochToken, marker, classification, parkPath, lastRealTurnAtMs } of paging) {
    // One page per (owner, disarm epoch). A session that STAYS halted never re-pages; one that
    // is re-armed and halts again gets a new epoch, because that is a genuinely new fault.
    const dedupeKey = `silent-halt:${candidate.ownerId}:${epochToken}`;
    const inactiveMin = candidate.inactiveForMs != null ? Math.round(candidate.inactiveForMs / 60000) : null;
    const attemptedAt = marker?.ts ?? null;
    const attemptedAtMs = attemptedAt != null ? Date.parse(attemptedAt) : Number.NaN;
    const turnFollowedWake =
      Number.isFinite(attemptedAtMs) && lastRealTurnAtMs != null && lastRealTurnAtMs > attemptedAtMs;
    const wakeLine =
      marker != null
        ? `\n\nA system wake was already attempted${attemptedAt ? ` at ${attemptedAt}` : ''} in this disarm ` +
          `epoch and ${
            turnFollowedWake
              ? 'a turn followed, but the session halted again with the same held work'
              : 'produced no real turn'
          } — escalating to you (wake-before-page).`
        : '';
    const classificationLine =
      `\n\nEnd classification (derived): ${classification}.` +
      (parkPath?.parked ? ` Fleet park state: ${describeParkResumePath(parkPath)}` : '');

    try {
      await notify({
        kind: 'intervention',
        title:
          `Autonomous session ${candidate.ownerId} is alive but has taken no turns` +
          (inactiveMin != null ? ` for ${inactiveMin}m` : '') +
          ` — nothing will wake it`,
        body:
          `${verdict.reason}.\n\n` +
          `This session's process is still running (its presence heartbeat is current), it holds a ` +
          `registered autonomy posture (${candidate.modes.map((m) => m.mode).join(', ')}), and its ` +
          `engine loop is INACTIVE with no pending events:await. There is therefore no wake source ` +
          `of any kind pointed at it: a paused loop does not fire, no await will resolve, and the ` +
          `one warning designed to catch this (coord:orient's wakeSourceLostWarning) is only ever ` +
          `delivered ON a wake. It will take no further turns, and any plan or work-item it was ` +
          `advancing stops exactly where it is, until a human acts.\n\n` +
          `Its own inbox is the wrong channel and is deliberately not used: delivery-to-inbox does ` +
          `not wake a session, so a message there would be spent on a dead channel.\n\n` +
          `To bring it back: resume the session and re-arm its loop (loop:arm). If it was stopped ` +
          `by a bound it should not have had, re-arm without maxFires/maxDurationSec. If it was ` +
          `stopped by a zero-tool escalation, check for a provider usage wall first — a wall makes ` +
          `an agent look inert without anything being wrong with it.\n\n` +
          `Loop routine: ${candidate.routineId}` +
          wakeLine +
          classificationLine,
        importance: 'urgent',
        workspaceId: candidate.workspaceId,
        dedupeKey,
        data: {
          ownerId: candidate.ownerId,
          routineId: candidate.routineId,
          reason: verdict.reason ?? '',
          modes: candidate.modes.map((m) => m.mode).join(','),
          inactiveForMin: inactiveMin,
          totalHalted: halted.length,
          wakeAttemptedAt: attemptedAt,
          endClassification: classification,
        },
      });
      result.paged.push(candidate.ownerId);
    } catch (e) {
      // A downed push transport must never turn a successful detection into a thrown routine —
      // the remaining candidates still deserve their page.
      console.warn(
        `[silent-halt-reconcile] owner page failed for ${candidate.ownerId}: ` +
          `${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return result;
}
