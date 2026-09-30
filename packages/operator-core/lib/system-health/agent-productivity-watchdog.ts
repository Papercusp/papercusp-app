/**
 * agent-productivity-watchdog — the present-but-unproductive sweep, for EVERY
 * agent rather than only a goal's holder.
 *
 * SIBLING of goal-liveness-watchdog's wedge leg (EI-21578742955425881), and the
 * generalisation of it. That leg asks the question of goal HOLDERS only, which
 * is where the condition was first noticed but not where it lives: a wedge is a
 * property of an agent SESSION. Both legs now decide through the one rule in
 * `agent-wedge.ts`, so they cannot drift apart.
 *
 * ── WHAT IT SEES THAT NOTHING ELSE DOES ─────────────────────────────────────
 *
 * Measured workspace-wide 2026-08-27T06:08Z: of 166 sessions past the grace
 * window, 22 had made ZERO agent-origin tool calls since `started_at` — 11 of
 * them fleet members. Every one was reported `wakeable: true` by
 * `coord:presence`, which is exactly the field a dispatcher reads to decide who
 * can take work; one had been wakeable for eighteen hours having never made a
 * single call of any origin. No surface was wrong and nothing alarmed:
 * heartbeats fresh, `sessionState` a legitimate `parked`, claims empty. The
 * counts are all healthy because none of them counts THIS.
 *
 * The cost is paid by whoever dispatches to them. Waking a wedged session
 * succeeds — the wake lands, `woken: 1` comes back — and nothing happens.
 *
 * ── THREE LEGS, ONE SWEEP ───────────────────────────────────────────────────
 *
 * The module runs two more predicates over the SAME population, deliberately
 * not separate watchdogs (WI-42436 / WI-7129):
 *
 *   wedge leg       "is this agent producing ANY work?"
 *   cadence leg     "is this agent producing the work its MODE obliges?"
 *   degenerate leg  "did this agent's wakes collapse into telemetry?"
 *
 * Same candidate read, same oracle call, same wave-shaped escalation — because
 * parallel sweeps over one table with related thresholds are exactly the drift
 * that extracting `agent-wedge.ts` removed. The cadence leg's
 * subject is the agent that is unmistakably BUSY and still never does the one
 * thing its mode exists for: measured 2026-08-27, a goal holder made 251
 * agent-origin calls across 52 tools in 80 minutes with zero ideation, and
 * every count-based surface read healthy because none of them asks whether the
 * mode's own obligation ever fired. The degenerate leg reads a trailing
 * 30-minute invocation mix so a heartbeat-fresh telemetry loop no longer reads
 * as healthy merely because it keeps making calls.
 *
 * ── WHY ONE CORRELATED WAVE, NOT N ALARMS ───────────────────────────────────
 *
 * The single most important design choice here. Wedge causes are CORRELATED:
 * one throttled account pool, one unlaunchable model id, one bad launcher
 * generation wedges every session it touched, all at once. A detector that
 * escalates per victim turns one cause into twenty-two identical reports, and
 * twenty-two copies of the same sentence is not twenty-two times the signal —
 * it is noise that buries the one fact that matters (they share a cause).
 *
 * So victims are grouped into WAVES by (workspace, phase), with the fleet
 * breakdown carried inside the body. `phase` is the grouping dimension because
 * it IS the cause dimension:
 *
 *   `never-booted`        the session never ran its start hooks — nothing
 *                         executed in that process at all, yet presence exists
 *                         and its heartbeat is fresh. The fault is in the
 *                         LAUNCHER or the presence writer.
 *   `booted-never-worked` the process came up, ran its hooks, and never took a
 *                         turn — a first-turn 429, an unlaunchable model, a
 *                         wedged CLI. The fault is in the SESSION.
 *
 * Two phases, two unrelated repairs, and each repair is actively wrong for the
 * other population: respawning a `never-booted` row re-runs a launcher that has
 * already failed, and nothing about relaunching the presence layer helps a
 * session that is genuinely up.
 *
 * ── REPORT-ONLY, AND THAT IS A DECISION ─────────────────────────────────────
 *
 * It never respawns anything. The same correlation that makes one wave the
 * right report makes auto-recovery the wrong action: N respawns fired into the
 * wall that caused the wedge spend the little capacity left on relaunches that
 * will wedge again. Recovery belongs to a caller that can also see whether
 * capacity exists — which is why goal-holder respawn sits behind its own
 * default-OFF owner-authority flag rather than being wired to this signal.
 *
 * Design notes:
 *  - `managedSetInterval`, category 'watchdog' — visible in schedule:inventory.
 *  - Runtime gate: FLAGS.AGENT_PRODUCTIVITY_WATCHDOG (default ON; kill-switch
 *    at /admin/features), independent of the goal legs' flags.
 *  - Dedup is delegated to openEscalation's (dedupKind, subjectSignature) PG
 *    dedup — no new state surface.
 *  - UNKNOWN SUPPRESSES, throughout. `resolveSessionStates` omits an entry when
 *    its wakeability fetch degrades, and a subject missing from the productivity
 *    census is unmeasured, not idle. Both are skipped rather than reported, so a
 *    transient DB hiccup costs silence instead of a false wave across every
 *    agent at once.
 */
import type { Sql } from 'postgres';

import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import {
  resolveSessionStates,
  type LivenessVerdict,
} from '../agent-tools/coordination/liveness-oracle';
// The alive predicate is generic in substance despite its goal-shaped NAME
// (ended ⇒ false; parked with no self-wake ⇒ false; otherwise present). Importing
// it keeps ONE definition of "will this session take a turn"; re-deriving it here
// would be the exact duplication this module exists to avoid.
import { holderCountsAsAlive } from '../goals/holder';
import {
  AGENT_PRODUCTIVITY_GRACE_MS,
  resolveAgentWedge,
  type AgentWedgePhase,
} from '../agent-wedge';

export const AGENT_PRODUCTIVITY_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * Degenerate-wake detector calibration (WI-7129).  A session must have a
 * meaningful sample before a ratio can say anything: the measured incident
 * used a 30-minute trailing window and a 40-call floor.  The detector is
 * intentionally conservative — it reports only a very telemetry-heavy window
 * with almost no work calls, never a merely idle or low-volume session.
 */
export const DEGENERATE_WAKE_WINDOW_MS = 30 * 60_000;
export const DEGENERATE_WAKE_MIN_CALLS = 40;
export const DEGENERATE_WAKE_TELEMETRY_RATIO = 0.75;
export const DEGENERATE_WAKE_MAX_WORK_CALLS = 5;
/**
 * False-positive guard from the live calibration: hook telemetry can dominate
 * a healthy session's RAW rows.  Real agent-origin, non-telemetry calls are the
 * progress counter that distinguishes that healthy case from degeneration.
 */
export const DEGENERATE_WAKE_MAX_PROGRESS_CALLS = 5;

const TELEMETRY_TOOL_NAMES = [
  'coord:glance',
  'activity:report',
  'flags:get',
  'journal:record-turn',
] as const;

/**
 * How stale a heartbeat may be for a row to remain a CANDIDATE.
 *
 * Deliberately generous, and not a liveness judgement — the oracle makes that.
 * This bound exists only to keep the candidate set (and therefore the census
 * query) bounded; erring wide costs a few extra oracle lookups, while erring
 * narrow would silently drop real victims before they are ever measured.
 */
const CANDIDATE_HEARTBEAT_WINDOW_MS = 10 * 60_000;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'agent-productivity-watchdog',
  ownerLabel: 'system · agent productivity',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** One presence row, reduced to what this sweep needs. */
export interface AgentPresenceCandidate {
  ownerId: string;
  ownerLabel: string;
  workspaceId: string;
  agentRole: string | null;
  fleetSlug: string | null;
  source: string | null;
  host: string | null;
  pid: number | null;
  heartbeatAt: string;
  /** ms epoch the session's presence row was created. */
  startedAtMs: number;
}

/** The invocation census for one candidate. */
export interface AgentCallCensus {
  /** Hook-origin EXCLUDED — see makeReadAgentProductivity's warning. */
  agentOriginCalls: number;
  /** Every origin, hook included — the phase discriminator. */
  anyOriginCalls: number;
  /** Calls of every origin in the trailing degenerate-wake window. */
  recentCalls?: number;
  /** Telemetry calls in that trailing window. */
  recentTelemetryCalls?: number;
  /** Work calls in that trailing window. */
  recentWorkCalls?: number;
  /** Agent-origin, non-telemetry calls in that trailing window. */
  recentProgressCalls?: number;
}

/** One wedged agent, as reported inside a wave. */
export interface AgentWedgeVictim {
  ownerId: string;
  ownerLabel: string;
  fleetSlug: string | null;
  agentRole: string | null;
  sessionState: string | null;
  presentForMs: number;
  agentOriginCalls: number;
  anyOriginCalls: number;
}

/** A correlated group of victims sharing a workspace and a phase. */
export interface AgentWedgeWave {
  workspaceId: string;
  phase: AgentWedgePhase;
  victims: AgentWedgeVictim[];
}

/**
 * How long an `overlay:ideate` registration may stand before a session that has
 * never recorded a pass is worth reporting.
 *
 * Deliberately generous, and much wider than the wedge grace: IDEATE obliges a
 * pass at task boundaries and lulls, not on a clock, so a busy agent mid-unit is
 * not yet delinquent. This bound is calibrated to catch NEVER, not LATE.
 */
export const IDEATE_PASS_GRACE_MS = 2 * 60 * 60_000;

/** One `overlay:ideate` registration, reduced to what the cadence leg needs. */
export interface AgentIdeateRegistration {
  /** ms epoch the mode was registered. */
  setAtMs: number;
  /** WHO registered it — the correlation key: a launcher, or the agent itself. */
  setBy: string;
  ownerDirected: boolean;
}

/** An ideate-registered session that has recorded no pass since registration. */
export interface AgentIdeateSilentVictim {
  ownerId: string;
  ownerLabel: string;
  fleetSlug: string | null;
  agentRole: string | null;
  setBy: string;
  ownerDirected: boolean;
  registeredForMs: number;
  /** Agent-origin calls since start — how BUSY this silent agent is. */
  agentOriginCalls: number;
  /** ms epoch of the last recorded pass, or null when there has never been one. */
  lastPassAtMs: number | null;
}

/**
 * Ideate silence in one workspace.
 *
 * `suppressedAsWedged` is load-bearing, not a statistic: a session with zero
 * agent-origin calls is silent because it is WEDGED, and the wedge wave already
 * reports it — escalating it twice is the noise one-correlated-wave exists to
 * prevent. But a suppressed population must never read as a real zero, so the
 * count travels with the wave (and is reported even when `victims` is empty).
 * Measured 2026-08-27: 13 of 13 ideate-silent sessions were wedge-explained, so
 * a leg that silently dropped them would have escalated nothing and looked healthy.
 */
export interface AgentIdeateSilenceWave {
  workspaceId: string;
  victims: AgentIdeateSilentVictim[];
  suppressedAsWedged: number;
}

/** One agent caught in a telemetry-only wake loop. */
export interface DegenerateWakeVictim {
  ownerId: string;
  ownerLabel: string;
  fleetSlug: string | null;
  agentRole: string | null;
  totalCalls: number;
  telemetryCalls: number;
  workCalls: number;
  progressCalls: number;
  telemetryRatio: number;
  /** null means the claim read degraded; never render that as "no claim". */
  heldClaims: string[] | null;
}

/** Correlated degenerate-wake victims in one workspace. */
export interface DegenerateWakeWave {
  workspaceId: string;
  victims: DegenerateWakeVictim[];
}

export type DegenerateWakeReason =
  | 'degenerate'
  | 'not-measured'
  | 'wedge-owned'
  | 'below-call-floor'
  | 'work-present'
  | 'telemetry-below-threshold';

export interface DegenerateWakeVerdict {
  degenerate: boolean;
  reason: DegenerateWakeReason;
  telemetryRatio: number | null;
}

/**
 * PURE: decide whether one trailing call window is a degenerate telemetry loop.
 *
 * The wedge leg owns a session with zero agent-origin calls.  This leg starts
 * only after the agent has done real work, then asks whether its CURRENT wakes
 * have collapsed into telemetry.  Missing trailing fields are NOT MEASURED,
 * never a clean verdict — older callers/tests may supply only lifetime counts.
 */
export function resolveDegenerateWake(
  census: AgentCallCensus | null | undefined,
): DegenerateWakeVerdict {
  if (
    !census ||
    census.recentCalls == null ||
    census.recentTelemetryCalls == null ||
    census.recentWorkCalls == null ||
    census.recentProgressCalls == null
  ) {
    return { degenerate: false, reason: 'not-measured', telemetryRatio: null };
  }
  if (census.agentOriginCalls === 0) {
    return { degenerate: false, reason: 'wedge-owned', telemetryRatio: null };
  }

  const total = census.recentCalls;
  const ratio = total > 0 ? census.recentTelemetryCalls / total : 0;
  if (total < DEGENERATE_WAKE_MIN_CALLS) {
    return { degenerate: false, reason: 'below-call-floor', telemetryRatio: ratio };
  }
  if (census.recentWorkCalls > DEGENERATE_WAKE_MAX_WORK_CALLS) {
    return { degenerate: false, reason: 'work-present', telemetryRatio: ratio };
  }
  if (census.recentProgressCalls > DEGENERATE_WAKE_MAX_PROGRESS_CALLS) {
    return { degenerate: false, reason: 'work-present', telemetryRatio: ratio };
  }
  if (ratio <= DEGENERATE_WAKE_TELEMETRY_RATIO) {
    return { degenerate: false, reason: 'telemetry-below-threshold', telemetryRatio: ratio };
  }
  return { degenerate: true, reason: 'degenerate', telemetryRatio: ratio };
}

export interface AgentProductivitySweepDeps {
  /** Presence rows old enough to judge, with a heartbeat recent enough to bother. */
  readCandidates: (graceMs: number) => Promise<AgentPresenceCandidate[]>;
  /**
   * The liveness oracle over those rows. A subject ABSENT from the returned map
   * is UNKNOWN and is suppressed — never read as dead.
   */
  resolveLiveness: (
    candidates: readonly AgentPresenceCandidate[],
  ) => Promise<Map<string, LivenessVerdict>>;
  /**
   * The invocation census, keyed by ownerId. A candidate ABSENT from the map is
   * `not-measured` and is suppressed, so a degraded read costs silence rather
   * than a wave of false alarms.
   */
  readProductivity: (
    candidates: readonly AgentPresenceCandidate[],
  ) => Promise<Map<string, AgentCallCensus>>;
  /** Current non-terminal work-item claims, keyed by ownerId. */
  readHeldClaims: (
    candidates: readonly AgentPresenceCandidate[],
  ) => Promise<Map<string, string[]>>;
  escalateWave: (wave: AgentWedgeWave) => Promise<void>;
  /**
   * `overlay:ideate` registrations for those candidates, keyed by ownerId. A
   * candidate ABSENT from the map simply never had the mode — the overwhelming
   * majority — and is not a subject of the cadence leg at all.
   */
  readIdeateRegistrations: (
    candidates: readonly AgentPresenceCandidate[],
  ) => Promise<Map<string, AgentIdeateRegistration>>;
  /**
   * Last recorded ideate pass per ownerId (ms epoch). A subject ABSENT from the
   * map has never recorded one — which is the predicate, so absence here is
   * MEANINGFUL rather than degraded, unlike the census map above.
   */
  readIdeatePasses: (
    candidates: readonly AgentPresenceCandidate[],
  ) => Promise<Map<string, number>>;
  /** Active GRADE-mode sessions per workspace. They receive the same missing-pass
   *  signal as the subject so a detected grading obligation becomes corrective
   *  action instead of an escalation somebody may notice much later. */
  resolveGraders: (workspaceIds: string[]) => Promise<Map<string, string[]>>;
  escalateIdeateWave: (wave: AgentIdeateSilenceWave) => Promise<void>;
  /** One correlated wake fan-out per workspace wave: every violating subject plus
   *  the workspace's active graders. Failures are contained independently from
   *  the durable escalation. */
  notifyIdeateWave: (wave: AgentIdeateSilenceWave, graders: string[]) => Promise<void>;
  escalateDegenerateWakeWave: (wave: DegenerateWakeWave) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
  graceMs: number;
  ideateGraceMs: number;
}

/**
 * The candidate read. Bounded two ways on purpose: old enough that the grace
 * cannot have elapsed mid-flight, and heartbeating recently enough that the row
 * is worth an oracle lookup.
 */
export function makeReadCandidates(sql: Sql): AgentProductivitySweepDeps['readCandidates'] {
  return async (graceMs) => {
    const rows = await sql<
      {
        owner_id: string;
        owner_label: string;
        workspace_id: string;
        agent_role: string | null;
        fleet_slug: string | null;
        source: string | null;
        host: string | null;
        pid: number | null;
        heartbeat_at: Date | string;
        started_at: Date | string;
      }[]
    >`
      SELECT owner_id, owner_label, workspace_id, agent_role, fleet_slug,
             source, host, pid, heartbeat_at, started_at
        FROM harness_shared.coord_presence
       WHERE heartbeat_at > now() - make_interval(secs => ${CANDIDATE_HEARTBEAT_WINDOW_MS / 1000})
         AND started_at   < now() - make_interval(secs => ${graceMs / 1000})`;

    return rows.map((r) => ({
      ownerId: r.owner_id,
      ownerLabel: r.owner_label,
      workspaceId: r.workspace_id,
      agentRole: r.agent_role,
      fleetSlug: r.fleet_slug,
      source: r.source,
      host: r.host,
      pid: r.pid,
      heartbeatAt:
        r.heartbeat_at instanceof Date
          ? r.heartbeat_at.toISOString()
          : new Date(r.heartbeat_at).toISOString(),
      startedAtMs:
        r.started_at instanceof Date ? r.started_at.getTime() : new Date(r.started_at).getTime(),
    }));
  };
}

/**
 * The measurement, from the invocation ledger.
 *
 * ⚠ `call_origin IS DISTINCT FROM 'hook'`, NOT `<> 'hook'`. Excluding
 * hook-origin calls IS the signal — a session that boots and immediately fails
 * still emits hook-fired calls (`coord:glance`, `activity:report` on the
 * session-start hook), so a raw count is non-zero for an agent that never ran an
 * instruction of its own (measured: raw 2–5, agent-origin 0). But `<> 'hook'` is
 * FALSE for a NULL origin, which would silently drop those rows and undercount
 * toward a FALSE WEDGE — the one direction this must never err in.
 * `IS DISTINCT FROM` counts a NULL (and the `unknown`/`ui` origins the column
 * actually carries) as work, erring toward silence.
 *
 * `since` travels PER ROW: an owner is answerable only for calls made after ITS
 * session started, so a floor shared across candidates would credit one session
 * with a predecessor's work.
 */
export function makeReadAgentProductivity(
  sql: Sql,
): AgentProductivitySweepDeps['readProductivity'] {
  return async (candidates) => {
    const out = new Map<string, AgentCallCensus>();
    if (candidates.length === 0) return out;

    const ownerIds = candidates.map((c) => c.ownerId);
    const workspaceIds = candidates.map((c) => c.workspaceId);
    const sinceIso = candidates.map((c) => new Date(c.startedAtMs).toISOString());

    const rows = await sql<{
      owner_id: string;
      agent_calls: string;
      any_calls: string;
      recent_calls: string;
      recent_telemetry_calls: string;
      recent_work_calls: string;
      recent_progress_calls: string;
    }[]>`
      WITH subjects AS (
        SELECT * FROM unnest(
          ${ownerIds}::text[],
          ${workspaceIds}::text[],
          ${sinceIso}::timestamptz[]
        ) AS t(owner_id, workspace_id, since)
      )
      SELECT s.owner_id,
             count(ti.id) FILTER (
               WHERE ti.call_origin IS DISTINCT FROM 'hook'
             ) AS agent_calls,
             count(ti.id) AS any_calls,
            count(ti.id) FILTER (
               WHERE ti.invoked_at >= GREATEST(s.since, now() - make_interval(secs => ${DEGENERATE_WAKE_WINDOW_MS / 1000}))
             ) AS recent_calls,
            count(ti.id) FILTER (
               WHERE ti.invoked_at >= GREATEST(s.since, now() - make_interval(secs => ${DEGENERATE_WAKE_WINDOW_MS / 1000}))
                 AND lower(ti.tool_name) = ANY(${[...TELEMETRY_TOOL_NAMES]}::text[])
             ) AS recent_telemetry_calls,
            count(ti.id) FILTER (
               WHERE ti.invoked_at >= GREATEST(s.since, now() - make_interval(secs => ${DEGENERATE_WAKE_WINDOW_MS / 1000}))
                 AND (lower(ti.tool_name) LIKE 'work_items:%' OR lower(ti.tool_name) LIKE 'scheduler:%')
             ) AS recent_work_calls,
             count(ti.id) FILTER (
               WHERE ti.call_origin IS DISTINCT FROM 'hook'
                 AND ti.invoked_at >= GREATEST(s.since, now() - make_interval(secs => ${DEGENERATE_WAKE_WINDOW_MS / 1000}))
                 AND lower(ti.tool_name) <> ALL(${[...TELEMETRY_TOOL_NAMES]}::text[])
             ) AS recent_progress_calls
        FROM subjects s
        LEFT JOIN harness_shared.tool_invocations ti
               ON ti.coord_owner_id = s.owner_id
              AND ti.workspace_id   = s.workspace_id
              AND ti.invoked_at    >= s.since
       GROUP BY 1`;

    for (const r of rows) {
      out.set(r.owner_id, {
        agentOriginCalls: Number(r.agent_calls),
        anyOriginCalls: Number(r.any_calls),
        recentCalls: Number(r.recent_calls),
        recentTelemetryCalls: Number(r.recent_telemetry_calls),
        recentWorkCalls: Number(r.recent_work_calls),
        recentProgressCalls: Number(r.recent_progress_calls),
      });
    }
    return out;
  };
}

/** Read current non-terminal claims for the candidates in one bounded query. */
export function makeReadHeldClaims(
  sql: Sql,
): AgentProductivitySweepDeps['readHeldClaims'] {
  return async (candidates) => {
    const out = new Map<string, string[]>();
    if (candidates.length === 0) return out;
    const ownerIds = candidates.map((c) => c.ownerId);
    const workspaceIds = candidates.map((c) => c.workspaceId);
    const rows = await sql<{ owner_id: string; feature_id: string }[]>`
      WITH subjects AS (
        SELECT * FROM unnest(
          ${ownerIds}::text[],
          ${workspaceIds}::text[]
        ) AS t(owner_id, workspace_id)
      )
      SELECT w.taken_by AS owner_id, w.feature_id
        FROM harness_shared.work_items w
        JOIN subjects s
          ON s.owner_id = w.taken_by
         AND s.workspace_id = w.workspace_id
       WHERE w.taken_by IS NOT NULL
         AND w.taken_by <> ''
         AND w.payload->>'lane' IS DISTINCT FROM 'observation'
         AND (
           w.status IS NULL
           OR w.status NOT IN ('done', 'closed', 'deprecated', 'dropped', 'passed', 'resolved')
         )
       ORDER BY w.taken_by, w.feature_id`;
    for (const row of rows) {
      const claims = out.get(row.owner_id);
      if (claims) claims.push(row.feature_id);
      else out.set(row.owner_id, [row.feature_id]);
    }
    return out;
  };
}

function defaultResolveLiveness(): AgentProductivitySweepDeps['resolveLiveness'] {
  return async (candidates) =>
    // `selfWake: true` is REQUIRED, not an optimisation: without it every parked
    // session looks equally wakeable, and `holderCountsAsAlive` cannot tell a
    // session that will wake itself from one waiting for a wake that never comes.
    await resolveSessionStates(
      candidates.map((c) => ({
        ownerId: c.ownerId,
        heartbeatAt: c.heartbeatAt,
        host: c.host,
        pid: c.pid,
        source: c.source,
        agentRole: c.agentRole,
      })),
      { selfWake: true },
    );
}

const PHASE_PROSE: Record<AgentWedgePhase, string> = {
  'never-booted':
    'These sessions made NO tool calls at all — not even the hook-origin calls every ' +
    'session emits on start-up. Nothing ran in those processes, yet a presence row exists ' +
    'for each with a fresh heartbeat. The fault is in the LAUNCHER or the presence writer, ' +
    'not in the sessions: there is nothing there to restart.',
  'booted-never-worked':
    'These sessions came up and ran their start-up hooks, then never took a turn — the ' +
    'classic wedge (a first-turn 429, a model id that resolves to no CLI backend, a wedged ' +
    'CLI). The processes are genuinely there, so this is the phase where a respawn is even ' +
    'a candidate — but only once the shared cause below is understood.',
};

/**
 * Report-only. NEVER respawns, and that is a decision rather than an omission —
 * see the module header on correlation.
 */
async function defaultEscalateWave(wave: AgentWedgeWave): Promise<void> {
  const n = wave.victims.length;
  const byFleet = new Map<string, AgentWedgeVictim[]>();
  for (const v of wave.victims) {
    const key = v.fleetSlug ?? '(no fleet)';
    const list = byFleet.get(key);
    if (list) list.push(v);
    else byFleet.set(key, [v]);
  }

  const fleetLines = [...byFleet.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([fleet, vs]) => {
      const oldest = Math.max(...vs.map((v) => v.presentForMs));
      return `  • ${fleet} — ${vs.length} session(s), oldest present ${formatDuration(oldest)}: ${vs
        .slice(0, 6)
        .map((v) => v.ownerLabel)
        .join(', ')}${vs.length > 6 ? `, +${vs.length - 6} more` : ''}`;
    });

  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `${n} agent session(s) are present and have NEVER produced work (${wave.phase}) ` +
      `in workspace ${wave.workspaceId}`,
    body:
      `${n} session(s) resolve as present — the liveness oracle reports them wakeable, so ` +
      `every dispatcher counts them as able to take work — and have made ZERO agent-origin ` +
      `tool calls since they started.\n\n` +
      `${PHASE_PROSE[wave.phase]}\n\n` +
      `Grouped by fleet:\n${fleetLines.join('\n')}\n\n` +
      `ONE report, not ${n}: wedge causes are CORRELATED — a throttled account pool, an ` +
      `unlaunchable model id, a bad launcher generation takes out everything it touched at ` +
      `once — so the fact worth acting on is that these share a cause, which ${n} separate ` +
      `alarms would bury. Look for what they have in common (launch window, account, model, ` +
      `fleet) before looking at any one of them.\n\n` +
      `Reported, never auto-recovered: respawning N wedged sessions fires them straight back ` +
      `into the wall that wedged them, spending the capacity that is already short. Recovery ` +
      `belongs to a caller that can also see whether capacity exists.\n\n` +
      `Hook-origin calls are excluded from the count deliberately — a session that boots and ` +
      `fails its first turn still emits those, which is why a raw invocation count reads ` +
      `healthy for an agent that never ran an instruction of its own.`,
    meta: {
      dedupKind: 'agent-productivity-wedge',
      subjectSignature: `${wave.workspaceId}:${wave.phase}`,
      workspaceId: wave.workspaceId,
      phase: wave.phase,
      victimCount: n,
      victims: wave.victims.slice(0, 40),
    },
  });
}

function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 90) return `${min}m`;
  return `${Math.round(min / 6) / 10}h`;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.AGENT_PRODUCTIVITY_WATCHDOG, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

/**
 * The `overlay:ideate` registrations among these candidates.
 *
 * axis_key/mode are the MEASURED encoding (`overlay:ideate` / `ideate`), not the
 * prose spelling: the axis carries the `overlay:` prefix and the mode does not.
 */
export function makeReadIdeateRegistrations(
  sql: Sql,
): AgentProductivitySweepDeps['readIdeateRegistrations'] {
  return async (candidates) => {
    const out = new Map<string, AgentIdeateRegistration>();
    if (candidates.length === 0) return out;
    const owners = candidates.map((c) => c.ownerId);
    const workspaces = [...new Set(candidates.map((c) => c.workspaceId))];
    const rows = await sql<
      { owner_id: string; set_at: Date; set_by: string; owner_directed: boolean }[]
    >`
      SELECT owner_id, set_at, set_by, owner_directed
        FROM harness_shared.agent_modes
       WHERE workspace_id = ANY(${workspaces})
         AND owner_id = ANY(${owners})
         AND axis_key = 'overlay:ideate'
         AND mode = 'ideate'
    `;
    for (const r of rows) {
      out.set(r.owner_id, {
        setAtMs: r.set_at.getTime(),
        setBy: r.set_by,
        ownerDirected: r.owner_directed,
      });
    }
    return out;
  };
}

/**
 * The last recorded ideate pass per candidate.
 *
 * Two things here are deliberate and easy to get wrong:
 *
 *  - `origin = 'su-ideate'` is REQUIRED, and it is not a mere filter. Migration
 *    571 added that column precisely so su passes ride the Scout tick ledger
 *    WITHOUT entering Scout's cadence and health reads (a foreign 'ran' tick
 *    would gate the next Scout cycle as 'min-interval' and mask a dead Scout).
 *    That exclusion is correct; this read is the su-ideate partition's OWN
 *    reader, never a widening of Scout's.
 *  - Attribution is `detail->>'owner'`, because scout_ticks has no owner column
 *    at all — the writer (`blender:ideate-pass-record`) stamps the owner into
 *    the detail jsonb. Filtering workspace + origin first keeps this on
 *    `scout_ticks_ws_origin_idx` and confines the jsonb work to the small
 *    su-ideate partition.
 */
export function makeReadIdeatePasses(sql: Sql): AgentProductivitySweepDeps['readIdeatePasses'] {
  return async (candidates) => {
    const out = new Map<string, number>();
    if (candidates.length === 0) return out;
    const owners = candidates.map((c) => c.ownerId);
    const workspaces = [...new Set(candidates.map((c) => c.workspaceId))];
    const rows = await sql<{ owner_id: string; last_pass: Date }[]>`
      SELECT detail->>'owner' AS owner_id, max(tick_at) AS last_pass
        FROM harness_shared.scout_ticks
       WHERE workspace_id = ANY(${workspaces})
         AND origin = 'su-ideate'
         AND detail->>'owner' = ANY(${owners})
       GROUP BY 1
    `;
    for (const r of rows) {
      if (r.owner_id) out.set(r.owner_id, r.last_pass.getTime());
    }
    return out;
  };
}

/** Resolve the GRADE-mode sessions that must re-evaluate a detected IDEATE-pass
 *  omission. Kept workspace-batched so one wave costs one indexed mode read, not
 *  one query per victim. */
export function makeResolveGraders(sql: Sql): AgentProductivitySweepDeps['resolveGraders'] {
  return async (workspaceIds) => {
    const out = new Map<string, string[]>();
    if (workspaceIds.length === 0) return out;
    const rows = await sql<{ workspace_id: string; owner_id: string }[]>`
      SELECT DISTINCT workspace_id, owner_id
        FROM harness_shared.agent_modes
       WHERE mode = 'grade' AND workspace_id IN ${sql(workspaceIds)}`;
    for (const row of rows) {
      const owners = out.get(row.workspace_id) ?? [];
      owners.push(row.owner_id);
      out.set(row.workspace_id, owners);
    }
    return out;
  };
}

/**
 * Report-only, and one wave per workspace — for the same reason as the wedge
 * leg, with the cause already measured: the registrations come from LAUNCHERS
 * (`pc-admin-coord-ui`, `goal-liveness-watchdog:auto-start`), so the agents did
 * not choose the mode and N nags would be N copies of one launcher's decision.
 */
async function defaultEscalateIdeateWave(wave: AgentIdeateSilenceWave): Promise<void> {
  const n = wave.victims.length;
  const bySetter = new Map<string, AgentIdeateSilentVictim[]>();
  for (const v of wave.victims) {
    const list = bySetter.get(v.setBy);
    if (list) list.push(v);
    else bySetter.set(v.setBy, [v]);
  }
  const setterLines = [...bySetter.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([setBy, vs]) => {
      const oldest = Math.max(...vs.map((v) => v.registeredForMs));
      const busiest = Math.max(...vs.map((v) => v.agentOriginCalls));
      const selfSet = vs.every((v) => v.ownerDirected);
      return (
        `  • set by ${setBy}${selfSet ? '' : ' (not owner-directed)'} — ${vs.length} session(s), ` +
        `oldest registered ${formatDuration(oldest)} ago, busiest has made ${busiest} ` +
        `agent-origin call(s): ${vs
          .slice(0, 6)
          .map((v) => v.ownerLabel)
          .join(', ')}${vs.length > 6 ? `, +${vs.length - 6} more` : ''}`
      );
    });

  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `${n} agent session(s) carry IDEATE mode and have NEVER recorded a pass ` +
      `in workspace ${wave.workspaceId}`,
    body:
      `${n} session(s) have had \`overlay:ideate\` registered past the grace and have ` +
      `recorded no \`blender:ideate-pass-record\` tick since registration — while making ` +
      `real agent-origin tool calls. They are working; they are just not doing the thing ` +
      `the MODE obliges.\n\n` +
      `This is the wedge question one level up. The wedge leg asks "is this agent ` +
      `producing ANY work?"; this asks "is this agent producing the work its MODE ` +
      `obliges?" — same instrument, same population, different predicate. Every ` +
      `count-based surface reads healthy for these agents, because none of them asks ` +
      `whether the mode's own obligation ever fired.\n\n` +
      `Grouped by who registered the mode:\n${setterLines.join('\n')}\n\n` +
      `Grouped that way on purpose: when a LAUNCHER registers the mode, the agent never ` +
      `chose it, and the fix belongs to the launch path — one decision reproduced N times, ` +
      `not N agents each forgetting.\n\n` +
      (wave.suppressedAsWedged > 0
        ? `Additionally ${wave.suppressedAsWedged} ideate-registered session(s) have recorded ` +
          `no pass AND made zero agent-origin calls. They are NOT counted above: their ` +
          `silence is explained by the wedge, and the wedge wave already reports them. ` +
          `Reported here only so a suppressed population never reads as a clean zero.\n\n`
        : '') +
      `Reported, never enforced: an agent cannot be made to have an idea on a timer, and ` +
      `the honest reading of a silent pass ledger is that the mode was registered where no ` +
      `pass was ever going to happen.`,
    meta: {
      dedupKind: 'agent-productivity-ideate-silence',
      subjectSignature: `${wave.workspaceId}:ideate-silence`,
      workspaceId: wave.workspaceId,
      victimCount: n,
      suppressedAsWedged: wave.suppressedAsWedged,
      victims: wave.victims.slice(0, 40),
    },
  });
}

/** Push the cadence violation to the actors who can correct it now. The durable
 * escalation remains one correlated workspace wave; this is its active delivery
 * complement, reusing the coordination wake primitive rather than adding a second
 * alert or state surface. */
async function defaultNotifyIdeateWave(
  wave: AgentIdeateSilenceWave,
  graders: string[],
): Promise<void> {
  const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
  const recipients = [...new Set([...wave.victims.map((victim) => victim.ownerId), ...graders])];
  if (recipients.length === 0) return;
  await wakeRecipients(recipients, {
    summary:
      `${wave.victims.length} IDEATE-mode session(s) in workspace ${wave.workspaceId} have no ` +
      '`blender:ideate-pass-record` after the grace window. Subjects: run a grounded pass and record it now. ' +
      'Graders: re-evaluate the Blender feedback/disposition criterion.',
    payload: {
      workspaceId: wave.workspaceId,
      reason: 'ideate-pass-missing',
      victimCount: wave.victims.length,
      victims: wave.victims.slice(0, 40),
    },
    source: 'agent-productivity-watchdog',
    workspaceId: wave.workspaceId,
  });
}

/** Report one correlated workspace wave, with the per-agent evidence needed to act. */
async function defaultEscalateDegenerateWakeWave(wave: DegenerateWakeWave): Promise<void> {
  const n = wave.victims.length;
  const victimLines = [...wave.victims]
    .sort((a, b) => b.telemetryRatio - a.telemetryRatio)
    .map((v) => {
      const claims =
        v.heldClaims === null
          ? 'CLAIM STATE UNKNOWN'
          : v.heldClaims.length > 0
            ? v.heldClaims.join(', ')
            : 'NO CLAIM';
      return (
        `  • ${v.ownerLabel} (${v.ownerId}) — ${(v.telemetryRatio * 100).toFixed(1)}% telemetry ` +
        `(${v.telemetryCalls}/${v.totalCalls}), ${v.workCalls} work call(s), ` +
        `${v.progressCalls} agent-origin progress call(s), ` +
        `fleet ${v.fleetSlug ?? '(none)'}, held ${claims}`
      );
    });

  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `${n} agent session(s) have degenerated into telemetry-only wake loops ` +
      `in workspace ${wave.workspaceId}`,
    body:
      `${n} present session(s) crossed the calibrated degenerate-wake threshold: ` +
      `more than ${(DEGENERATE_WAKE_TELEMETRY_RATIO * 100).toFixed(0)}% telemetry over ` +
      `at least ${DEGENERATE_WAKE_MIN_CALLS} calls in the trailing ` +
      `${DEGENERATE_WAKE_WINDOW_MS / 60_000} minutes, while producing no more than ` +
      `${DEGENERATE_WAKE_MAX_WORK_CALLS} work calls and no more than ` +
      `${DEGENERATE_WAKE_MAX_PROGRESS_CALLS} ` +
      `agent-origin non-telemetry progress calls — the guard that prevents hook-generated ` +
      `telemetry from classifying a healthy working agent as degenerate. They remain ` +
      `heartbeat-fresh and look live on count-based surfaces while spending wakes ` +
      `without advancing work.\n\n` +
      `${victimLines.join('\n')}\n\n` +
      `A victim holding NO CLAIM is the sharpest case: it is burning wakes with no ` +
      `registered unit to advance. A victim holding a claim may be silently blocking a ` +
      `lane and should be checked first.\n\n` +
      `ONE workspace report, not ${n}: degenerate wakes commonly share a launcher, ` +
      `prompt, or coordination-loop cause. This detector reports the correlated wave ` +
      `and does not auto-respawn; first identify the shared cause, then recover the victims.\n\n` +
      `The signal deliberately does not use ended_at or session-end clustering. ` +
      `ended_at is written by the reaper and clusters by construction; this signal is ` +
      `derived from the actual trailing invocation mix instead.`,
    meta: {
      dedupKind: 'agent-productivity-degenerate-wake',
      subjectSignature: `${wave.workspaceId}:degenerate-wake`,
      workspaceId: wave.workspaceId,
      victimCount: n,
      windowMs: DEGENERATE_WAKE_WINDOW_MS,
      minCalls: DEGENERATE_WAKE_MIN_CALLS,
      telemetryRatioThreshold: DEGENERATE_WAKE_TELEMETRY_RATIO,
      maxWorkCalls: DEGENERATE_WAKE_MAX_WORK_CALLS,
      maxProgressCalls: DEGENERATE_WAKE_MAX_PROGRESS_CALLS,
      victims: wave.victims.slice(0, 40),
    },
  });
}

export function agentProductivitySweepDeps(
  sql: Sql,
  overrides: Partial<AgentProductivitySweepDeps> = {},
): AgentProductivitySweepDeps {
  return {
    readCandidates: makeReadCandidates(sql),
    resolveLiveness: defaultResolveLiveness(),
    readProductivity: makeReadAgentProductivity(sql),
    readHeldClaims: makeReadHeldClaims(sql),
    escalateWave: defaultEscalateWave,
    readIdeateRegistrations: makeReadIdeateRegistrations(sql),
    readIdeatePasses: makeReadIdeatePasses(sql),
    resolveGraders: makeResolveGraders(sql),
    escalateIdeateWave: defaultEscalateIdeateWave,
    notifyIdeateWave: defaultNotifyIdeateWave,
    escalateDegenerateWakeWave: defaultEscalateDegenerateWakeWave,
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    graceMs: AGENT_PRODUCTIVITY_GRACE_MS,
    ideateGraceMs: IDEATE_PASS_GRACE_MS,
    ...overrides,
  };
}

/**
 * What one sweep measured.
 *
 * The ideate counters are reported separately from `wedged` on purpose: they
 * answer a different question over the same population, and `ideateSilent`
 * INCLUDES the sessions suppressed as wedge-explained, so
 * `ideateSilent - ideateSuppressedAsWedged` is the escalated set.
 */
export interface AgentProductivitySweepResult {
  scanned: number;
  present: number;
  wedged: number;
  unmeasured: number;
  wavesEscalated: number;
  /** Ideate-registered, past grace, no pass since registration — total. */
  ideateSilent: number;
  /** Of those, the ones whose silence the wedge already explains. */
  ideateSuppressedAsWedged: number;
  ideateWavesEscalated: number;
  /** Workspace waves whose violating subjects + active graders were directly woken. */
  ideateWavesNotified: number;
  /** Present sessions whose trailing call mix is degenerate. */
  degenerateWake: number;
  /** Correlated workspace waves emitted for the degenerate-wake leg. */
  degenerateWakeWavesEscalated: number;
}

function emptySweepResult(): AgentProductivitySweepResult {
  return {
    scanned: 0,
    present: 0,
    wedged: 0,
    unmeasured: 0,
    wavesEscalated: 0,
    ideateSilent: 0,
    ideateSuppressedAsWedged: 0,
    ideateWavesEscalated: 0,
    ideateWavesNotified: 0,
    degenerateWake: 0,
    degenerateWakeWavesEscalated: 0,
  };
}

/**
 * One sweep: read candidates, resolve presence, measure productivity, group the
 * wedged into correlated waves, escalate one report per wave.
 *
 * A failed escalate is swallowed per wave so one bad group cannot cost the rest
 * of the batch; the escalation-side dedup makes the next tick's retry idempotent.
 * Exported for tests.
 */
export async function runAgentProductivitySweepOnce(
  sql: Sql,
  overrides: Partial<AgentProductivitySweepDeps> = {},
): Promise<AgentProductivitySweepResult> {
  const deps = agentProductivitySweepDeps(sql, overrides);
  if (!(await deps.flagEnabled())) {
    return emptySweepResult();
  }

  const candidates = await deps.readCandidates(deps.graceMs);
  if (candidates.length === 0) {
    return emptySweepResult();
  }

  const [verdicts, census, heldClaims, ideateRegs, ideatePasses] = await Promise.all([
    deps.resolveLiveness(candidates),
    deps.readProductivity(candidates),
    deps.readHeldClaims(candidates).catch((e) => {
      console.warn(
        `[agent-productivity-watchdog] held-claim read failed (non-fatal enrichment): ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }),
    deps.readIdeateRegistrations(candidates),
    deps.readIdeatePasses(candidates),
  ]);

  const now = deps.now();
  const waves = new Map<string, AgentWedgeWave>();
  const ideateWaves = new Map<string, AgentIdeateSilenceWave>();
  const degenerateWaves = new Map<string, DegenerateWakeWave>();
  let present = 0;
  let wedged = 0;
  let unmeasured = 0;
  let ideateSilent = 0;
  let ideateSuppressedAsWedged = 0;
  let degenerateWake = 0;

  for (const c of candidates) {
    const verdict = verdicts.get(c.ownerId);
    // Absent from the oracle ⇒ UNKNOWN, never dead and never present.
    if (!verdict) continue;
    if (!holderCountsAsAlive(verdict)) continue;
    present += 1;

    const measured = census.get(c.ownerId);
    const v = resolveAgentWedge({
      presence: 'present',
      productivity: measured
        ? {
            agentOriginCalls: measured.agentOriginCalls,
            anyOriginCalls: measured.anyOriginCalls,
            presentForMs: now - c.startedAtMs,
          }
        : null,
      graceMs: deps.graceMs,
    });

    if (v.reason === 'not-measured') unmeasured += 1;

    // ── Degenerate-wake leg ──────────────────────────────────────────────
    // This is deliberately separate from the zero-work wedge: these sessions
    // have made real calls, but their current wake mix has collapsed into
    // telemetry.  Missing trailing measurements are unknown, never healthy.
    const d = resolveDegenerateWake(measured);
    if (d.degenerate && measured && d.telemetryRatio !== null) {
      degenerateWake += 1;
      const wave =
        degenerateWaves.get(c.workspaceId) ??
        ({ workspaceId: c.workspaceId, victims: [] } as DegenerateWakeWave);
      wave.victims.push({
        ownerId: c.ownerId,
        ownerLabel: c.ownerLabel,
        fleetSlug: c.fleetSlug,
        agentRole: c.agentRole,
        totalCalls: measured.recentCalls!,
        telemetryCalls: measured.recentTelemetryCalls!,
        workCalls: measured.recentWorkCalls!,
        progressCalls: measured.recentProgressCalls!,
        telemetryRatio: d.telemetryRatio,
        heldClaims: heldClaims === null ? null : (heldClaims.get(c.ownerId) ?? []),
      });
      degenerateWaves.set(c.workspaceId, wave);
    }

    // ── The cadence leg ───────────────────────────────────────────────────
    // Runs for every PRESENT candidate, wedged or not — which is why it sits
    // ahead of the wedge `continue` below. Its subject is the agent that is
    // working normally and simply never does what the mode obliges; skipping
    // the non-wedged would remove exactly that population.
    const reg = ideateRegs.get(c.ownerId);
    if (reg && measured && now - reg.setAtMs >= deps.ideateGraceMs) {
      const lastPassAtMs = ideatePasses.get(c.ownerId) ?? null;
      // A pass recorded BEFORE the mode was registered does not discharge the
      // current registration — the obligation starts when the mode is set.
      if (lastPassAtMs === null || lastPassAtMs < reg.setAtMs) {
        ideateSilent += 1;
        const wave =
          ideateWaves.get(c.workspaceId) ??
          ({ workspaceId: c.workspaceId, victims: [], suppressedAsWedged: 0 } as AgentIdeateSilenceWave);
        if (v.wedged) {
          // Silence fully explained by the wedge — the wedge wave owns this
          // session. Counted, never escalated twice.
          ideateSuppressedAsWedged += 1;
          wave.suppressedAsWedged += 1;
        } else {
          wave.victims.push({
            ownerId: c.ownerId,
            ownerLabel: c.ownerLabel,
            fleetSlug: c.fleetSlug,
            agentRole: c.agentRole,
            setBy: reg.setBy,
            ownerDirected: reg.ownerDirected,
            registeredForMs: now - reg.setAtMs,
            agentOriginCalls: measured.agentOriginCalls,
            lastPassAtMs,
          });
        }
        ideateWaves.set(c.workspaceId, wave);
      }
    }

    // `phase` is null only when the census did not supply anyOriginCalls, which
    // cannot happen on this path — but a wave keyed on a null phase would be a
    // group with no repair, so it is skipped rather than invented.
    if (!v.wedged || v.phase === null || !measured) continue;
    wedged += 1;

    const key = `${c.workspaceId}:${v.phase}`;
    const wave =
      waves.get(key) ??
      ({ workspaceId: c.workspaceId, phase: v.phase, victims: [] } as AgentWedgeWave);
    wave.victims.push({
      ownerId: c.ownerId,
      ownerLabel: c.ownerLabel,
      fleetSlug: c.fleetSlug,
      agentRole: c.agentRole,
      sessionState: verdict.sessionState,
      presentForMs: now - c.startedAtMs,
      agentOriginCalls: measured.agentOriginCalls,
      anyOriginCalls: measured.anyOriginCalls,
    });
    waves.set(key, wave);
  }

  let wavesEscalated = 0;
  for (const wave of waves.values()) {
    try {
      await deps.escalateWave(wave);
      wavesEscalated += 1;
    } catch (e) {
      console.warn(
        `[agent-productivity-watchdog] escalate failed for ${wave.workspaceId}:${wave.phase} ` +
          `(non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  let ideateWavesEscalated = 0;
  let ideateWavesNotified = 0;
  const graderMap =
    ideateWaves.size > 0
      ? await deps.resolveGraders([...ideateWaves.keys()]).catch((e) => {
          console.warn(
            `[agent-productivity-watchdog] grader resolution failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
          return new Map<string, string[]>();
        })
      : new Map<string, string[]>();
  for (const wave of ideateWaves.values()) {
    // A wave with nothing but suppressed victims raises no alarm: every one of
    // them is already reported by the wedge wave. The population still travels
    // out in the counts below, so "nothing escalated" is never mistaken for
    // "nobody was silent".
    if (wave.victims.length === 0) continue;
    try {
      await deps.escalateIdeateWave(wave);
      ideateWavesEscalated += 1;
    } catch (e) {
      console.warn(
        `[agent-productivity-watchdog] ideate escalate failed for ${wave.workspaceId} ` +
          `(non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      await deps.notifyIdeateWave(wave, graderMap.get(wave.workspaceId) ?? []);
      ideateWavesNotified += 1;
    } catch (e) {
      console.warn(
        `[agent-productivity-watchdog] ideate notify failed for ${wave.workspaceId} ` +
          `(non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  let degenerateWakeWavesEscalated = 0;
  for (const wave of degenerateWaves.values()) {
    try {
      await deps.escalateDegenerateWakeWave(wave);
      degenerateWakeWavesEscalated += 1;
    } catch (e) {
      console.warn(
        `[agent-productivity-watchdog] degenerate-wake escalate failed for ${wave.workspaceId} ` +
          `(non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    scanned: candidates.length,
    present,
    wedged,
    unmeasured,
    wavesEscalated,
    ideateSilent,
    ideateSuppressedAsWedged,
    ideateWavesEscalated,
    ideateWavesNotified,
    degenerateWake,
    degenerateWakeWavesEscalated,
  };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Idempotent. Runtime gate: FLAGS.AGENT_PRODUCTIVITY_WATCHDOG (checked per tick,
 * so the kill-switch takes effect without a restart).
 */
export function startAgentProductivityWatchdog(
  sql: Sql,
  opts: { intervalMs?: number } = {},
): void {
  const intervalMs = opts.intervalMs ?? AGENT_PRODUCTIVITY_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'agent-productivity-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runAgentProductivitySweepOnce(sql)
        .catch((e) => {
          console.warn(
            `[agent-productivity-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // The alarm condition is an agent present for a WINDOW without having
    // worked. Nothing emits an event for work that never happened, so the
    // passage of time in that state is the only trigger available.
    { category: 'watchdog', classification: 'timeout-reaper' },
  );
}
