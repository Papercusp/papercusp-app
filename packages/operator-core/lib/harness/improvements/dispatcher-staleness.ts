/**
 * dispatcher-staleness.ts — the auto-implement DISPATCHER-STALL watchdog collector
 * (EI-2150).
 *
 * The sibling `orphaned-dispatch` collector watches for DEAD WORKERS — open ledger
 * rows whose worker silently died. It reads `signalCount:0` when the lane has no
 * *pending* orphans, which is exactly the blind spot EI-2150 found: on 2026-06-19 a
 * host-restart storm orphaned 154/196 dispatches, the orphan collector correctly
 * drove them terminal (so it saw 0 pending), and then the `improvement-implement`
 * routine went QUIET and never resumed — `lastDispatchAt` frozen for 34h+ while ~21
 * auto-eligible, never-dispatched bugs sat waiting. `routine-failure` read 0 too (the
 * dispatcher did not ERROR, it just stopped scheduling). So the entire auto-implement
 * self-healing lane went dark and NOTHING noticed.
 *
 * This collector closes that edge: it asks "is the dispatcher SUPPOSED to be firing
 * right now, yet hasn't in N hours?" and signals if so. It fires ONLY when the lane
 * is genuinely shirking — every "legitimately quiet" reason is gated out first, so it
 * does not false-alarm on a disarmed lane, a deploy/credential pause, an empty queue,
 * or a slow-but-working dispatcher draining a backlog:
 *
 *   - ARMED — `IMPROVEMENT_AUTO_IMPLEMENT` on AND a runner harness configured AND
 *     the per-run cap > 0. A disarmed lane never fires, so a quiet dispatcher is
 *     correct (this is the "shipping is healthy" gate the issue asks for: a frozen
 *     deploy is captured separately as `service-down`/`ship-link`, and an owner who
 *     pauses the lane flips the flag — both leave `armed=false`). The armed inputs
 *     are resolved EXACTLY as `improvement-implement` resolves them — the runner
 *     falls back to the routine's install slug when the env override is unset
 *     (WI-290's post-incident default), and the flag distinct-id keys on the install
 *     slug. Reading the runner env-ONLY would make THIS collector skip as "disarmed"
 *     in the very env-unset config that caused EI-2150 — a detector blind to its own
 *     scenario.
 *   - NOT env-paused — `laneInEnvOutage` over the dispatch ledger: a fleet
 *     credential/rate-limit outage legitimately PAUSES the lane (plan-implement's
 *     'paused' action) and is already surfaced separately, so suppress here.
 *   - the eligible queue is NON-EMPTY — at least one OPEN, auto-tier, attempts:0
 *     bug (never dispatched ⇒ neither in-flight nor attempts-exhausted), i.e. work
 *     the dispatcher should have picked up.
 *   - the OLDEST eligible bug has WAITED past the threshold — so a fresh item
 *     arriving right after a long idle does not false-positive; the dispatcher is
 *     given a cadence tick or two to pick it up.
 *   - `lastDispatchAt` is itself older than the threshold (and non-null) — a
 *     slow-but-working dispatcher draining a backlog one-per-tick keeps a FRESH
 *     `lastDispatchAt`, so it is correctly NOT flagged; only a genuinely silent lane
 *     is. A null `lastDispatchAt` (never dispatched at all) is a louder
 *     never-configured condition, out of scope here — not flagged.
 *
 * Pure core (`buildDispatcherStalenessSignal`) + thin glue
 * (`collectDispatcherStalenessSignals`), mirroring orphaned-dispatch.ts /
 * insight-staleness.ts. The glue skips with a NOTE (never an error) when the lane is
 * disarmed, env-paused, or the dispatch ledger is absent (migration 238 not applied),
 * so a config/deploy-ordering state is observable in the tick record without
 * self-escalating the watchdog.
 */

import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { CollectorResult, WatchdogSignal } from './watchdog';
import { readImprovementItems } from './read-items';
import { buildDigest } from './digest';
import { readOwnerFullAutonomyGrant } from './full-autonomy-grant';
import { computeDispatchStats, readRecentDispatches, type ImprovementDispatchRow } from './dispatch-ledger';
import { isMissingLedgerTable, laneInEnvOutage } from './orphaned-dispatch';

/**
 * How long the dispatcher may go without firing — while armed work waits — before the
 * lane is declared stalled. Default 6h: comfortably above the ~30-min routine cadence
 * and the 45-min worker timeout (so a single in-flight worker or a brief empty-queue
 * lull never trips it), yet far below the 34h dark window EI-2150 observed. Tunable
 * via the routine payload (`dispatcherStalenessThresholdHours`).
 */
export const DEFAULT_DISPATCHER_STALENESS_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/** How many ledger rows the glue reads to compute `lastDispatchAt` + env-outage. */
export const DISPATCHER_STALENESS_SCAN_READ_LIMIT = 200;

/** The scheduled routine whose active state gates the dispatcher-staleness alarm. */
export const IMPROVEMENT_IMPLEMENT_ROUTINE_NAME = 'improvement-implement';

/** One never-dispatched, auto-eligible improvement awaiting the dispatcher. */
export interface EligibleDispatchItem {
  id: string;
  /** How long it has been waiting (ms): now − createdAt. */
  ageMs: number;
  /** Whether the scheduled triage routed it `place` (issue's "triaged-place" lens). */
  triagedPlace: boolean;
}

export interface DispatcherStalenessInput {
  /**
   * The lane is in a state where the dispatcher WOULD dispatch if it ran now:
   * `IMPROVEMENT_AUTO_IMPLEMENT` on AND a runner harness configured AND cap > 0 AND
   * not in a credential/env outage. When false the dispatcher is legitimately quiet
   * and nothing is flagged.
   */
  armed: boolean;
  /** Most recent dispatch fire (computeDispatchStats.lastDispatchAt), or null if none ever. */
  lastDispatchAt: string | null;
  /** Open, auto-tier, attempts:0 bugs awaiting dispatch (never dispatched ⇒ not in-flight/exhausted). */
  eligible: EligibleDispatchItem[];
  /** Now (ms). */
  nowMs: number;
  /** Staleness threshold (ms). Default DEFAULT_DISPATCHER_STALENESS_THRESHOLD_MS. */
  thresholdMs?: number;
}

/**
 * Pure: at most ONE signal. Fires only when every "legitimately quiet" reason is
 * ruled out (see the module doc) — armed, a non-empty eligible queue whose oldest
 * item has waited past the threshold, AND a `lastDispatchAt` itself older than the
 * threshold. A null/unparseable `lastDispatchAt` is the never-dispatched case and is
 * NOT flagged (a different, louder never-configured condition). Live-state signal:
 * the stall exists NOW, so no `latestAt` (a re-file after a resolve is always a real
 * regression — the lane stalled again).
 */
export function buildDispatcherStalenessSignal(input: DispatcherStalenessInput): WatchdogSignal[] {
  const thresholdMs = input.thresholdMs ?? DEFAULT_DISPATCHER_STALENESS_THRESHOLD_MS;
  if (!input.armed) return []; // disarmed / env-paused — the dispatcher is correctly idle
  if (input.eligible.length === 0) return []; // nothing to dispatch — correctly idle
  // The oldest eligible bug must have WAITED past the threshold (else a fresh item
  // after a long idle would false-positive before the dispatcher's next tick).
  const oldestWaitMs = Math.max(...input.eligible.map((e) => e.ageMs));
  if (!(oldestWaitMs > thresholdMs)) return [];
  // AND the dispatcher must itself be silent past the threshold. A slow-but-working
  // dispatcher draining a backlog keeps a fresh lastDispatchAt → not flagged. A
  // null/unparseable lastDispatchAt (never dispatched) is out of scope → not flagged.
  const lastMs = input.lastDispatchAt ? Date.parse(input.lastDispatchAt) : NaN;
  if (!Number.isFinite(lastMs)) return [];
  const sinceLastMs = input.nowMs - lastMs;
  if (!(sinceLastMs > thresholdMs)) return [];

  const eligibleCount = input.eligible.length;
  const triagedPlaceCount = input.eligible.filter((e) => e.triagedPlace).length;
  const oldestWaitHours = Math.round(oldestWaitMs / 3_600_000);
  const sinceLastHours = Math.round(sinceLastMs / 3_600_000);
  const thresholdHours = Math.round(thresholdMs / 3_600_000);
  return [
    {
      source: 'dispatcher-staleness',
      key: 'auto-implement-dispatcher',
      // STABLE title (no counts) — the cross-tick search-first dedup matches on it.
      title: 'Auto-implement dispatcher has stalled — eligible bugs queued but no dispatch firing',
      body:
        `Watchdog signal (dispatcher-staleness): the auto-implement dispatcher ` +
        `(\`system:improvement-implement\`) has not fired a dispatch in ~${sinceLastHours}h ` +
        `(last dispatch ${input.lastDispatchAt}; staleness threshold ${thresholdHours}h), yet ` +
        `${eligibleCount} auto-eligible, never-dispatched bug(s) are waiting` +
        (triagedPlaceCount ? ` (${triagedPlaceCount} triaged 'place')` : '') +
        ` — the oldest has waited ~${oldestWaitHours}h.\n\n` +
        `The lane is ARMED (the \`papercusp-improvement-auto-implement\` flag is on, a runner harness is ` +
        `configured, cap > 0) and is NOT in a credential/env outage, so it SHOULD be dispatching — but it is ` +
        `silent. The entire auto-implement self-healing lane is effectively dark.\n\n` +
        `Investigate the \`improvement-implement\` routine: is it still ACTIVE and scheduling on the routines ` +
        `engine, or did it stop firing after a host-restart storm (the EI-2150 incident)? Check ` +
        `\`harness_shared.routines\` for the row + its next/last fire, and \`improvements:watchdog-status\` for ` +
        `the dispatch ledger. Restarting/re-arming the routine resumes the lane.`,
      severity: 'major' as const,
      // kind=change — routes to the HUMAN queue (not the auto-implement lane, which is
      // itself the thing that is dark): a stopped routine is an operational fix, and
      // auto-dispatching a fix through the dead dispatcher would be self-defeating.
      kind: 'change' as const,
      paths: [
        'packages/operator-core/lib/harness/routines/improvement-actions.ts',
        'packages/operator-core/lib/harness/improvements/dispatcher-staleness.ts',
      ],
      findingClass: 'dispatcher-staleness:auto-implement',
      // Live-state signal (no latestAt): the stall exists NOW, so a re-file after a
      // resolution is always a genuine regression (the lane stalled again).
    },
  ];
}

export interface CollectDispatcherStalenessOpts {
  /** Staleness threshold in HOURS (routine-tunable). Default 6. */
  dispatcherStalenessThresholdHours?: number;
  /** Now (ms) — injectable for tests. */
  nowMs?: number;
  /**
   * The routine's install slug (the watchdog tick passes `ctx.installSlug`). Used to
   * mirror the dispatcher's armed inputs (EI-2150): the runner falls back to it when the
   * env override is unset, and the flag distinct-id keys on it (`routine:<installSlug>`).
   * Absent ⇒ the runner is env-only and the distinct-id falls back to `routine:<workspaceId>`.
   */
  installSlug?: string | null;
  /** Distinct-id for the auto-implement flag read. Default `routine:<installSlug ?? workspaceId>`. */
  flagDistinctId?: string;
  /** Pre-resolved deps — injectable so the glue is unit-testable without PG/flags. */
  deps?: Partial<DispatcherStalenessDeps>;
}

/** Injectable IO seam (tests pin every leg; the default wires the real readers). */
export interface DispatcherStalenessDeps {
  flagEnabled: (workspaceId: string, distinctId: string) => Promise<boolean>;
  /** Resolve the runner harness GIVEN the install slug — mirrors the dispatcher's
   *  `env || installSlug || null` (WI-290), so an unset env override is NOT read as
   *  "disarmed" (EI-2150). */
  runnerHarness: (installSlug: string | null) => string | null;
  maxPerRun: () => number;
  /** Read the dispatcher routine's live active/pause state. Unknown rows fail open. */
  routineState: (workspaceId: string, installSlug: string) => Promise<DispatcherRoutineState | null>;
  readDispatches: (workspaceId: string) => Promise<ImprovementDispatchRow[]>;
  readItems: typeof readImprovementItems;
  ownerFullAutonomy: (workspaceId: string) => Promise<boolean>;
}

export interface DispatcherRoutineState {
  active: boolean;
  /** `metadata.pause.reason`, when the inactive row carries a deliberate hold. */
  pauseReason: string | null;
}

/** Parse PAPERCUSP_IMPROVEMENT_MAX_PER_RUN exactly as the dispatcher does (default 1, min 0). */
function maxPerRunFromEnv(): number {
  const raw = process.env.PAPERCUSP_IMPROVEMENT_MAX_PER_RUN;
  if (raw == null || raw.trim() === '') return 1;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || String(n) !== raw.trim() || n < 0) return 1;
  return n;
}

/**
 * Read the exact routine row that owns the auto-implement cadence. A missing row is
 * intentionally represented as `null`: the watchdog should still surface a stale
 * armed lane when the routine was never seeded, while an explicit `active:false`
 * is the authoritative pause/resume state and must suppress this alarm.
 */
async function readImprovementImplementRoutineState(
  workspaceId: string,
  installSlug: string,
): Promise<DispatcherRoutineState | null> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ active: boolean; metadata: Record<string, unknown> | null }>>`
    SELECT active, metadata
      FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId}
       AND install_slug = ${installSlug}
       AND name = ${IMPROVEMENT_IMPLEMENT_ROUTINE_NAME}
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  const pause = row.metadata?.pause;
  const pauseReason =
    pause && typeof pause === 'object' && typeof (pause as Record<string, unknown>).reason === 'string'
      ? ((pause as Record<string, unknown>).reason as string)
      : null;
  return { active: row.active === true, pauseReason };
}

const defaultDeps: DispatcherStalenessDeps = {
  flagEnabled: (_ws, distinctId) => getFlag(FLAGS.IMPROVEMENT_AUTO_IMPLEMENT, distinctId),
  // Mirror improvement-implement's runner resolution EXACTLY (WI-290): env override,
  // else the routine's own install slug, else null. Env-only here would re-open the
  // EI-2150 blind spot (env unset ⇒ dispatcher armed via the install-slug fallback,
  // yet this collector would skip as "disarmed" and never fire).
  runnerHarness: (installSlug) => process.env.PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS || installSlug || null,
  maxPerRun: maxPerRunFromEnv,
  routineState: readImprovementImplementRoutineState,
  readDispatches: (ws) => readRecentDispatches(ws, { limit: DISPATCHER_STALENESS_SCAN_READ_LIMIT }),
  readItems: readImprovementItems,
  ownerFullAutonomy: readOwnerFullAutonomyGrant,
};

/**
 * Thin glue: resolve the dispatcher's OWN runtime gates (flag + runner + cap +
 * env-outage), the dispatch ledger's `lastDispatchAt`, and the never-dispatched
 * auto-eligible queue, then call the pure core. Returns a NOTE (never throws/errors)
 * for each legitimately-quiet state so the tick record shows WHY it did not fire.
 */
export async function collectDispatcherStalenessSignals(
  workspaceId: string,
  opts: CollectDispatcherStalenessOpts = {},
): Promise<CollectorResult> {
  const deps = { ...defaultDeps, ...opts.deps };
  const nowMs = opts.nowMs ?? Date.now();
  const thresholdMs =
    opts.dispatcherStalenessThresholdHours != null && opts.dispatcherStalenessThresholdHours > 0
      ? opts.dispatcherStalenessThresholdHours * 3_600_000
      : DEFAULT_DISPATCHER_STALENESS_THRESHOLD_MS;

  // 1. Cheap config gates first — a disarmed lane skips all IO below. Resolve the
  //    dispatcher's OWN armed inputs EXACTLY as `improvement-implement` does, or the
  //    detector inherits a blind spot: the flag distinct-id keys on the install slug
  //    (`routine:<installSlug>`) and the runner falls back to the install slug when the
  //    env override is unset (WI-290). Reading the runner env-ONLY would skip as
  //    "disarmed" in the very env-unset config that caused EI-2150.
  const installSlug = opts.installSlug ?? null;
  const distinctId = opts.flagDistinctId ?? `routine:${installSlug ?? workspaceId}`;
  const flagEnabled = await deps.flagEnabled(workspaceId, distinctId).catch(() => false);
  const runnerHarness = deps.runnerHarness(installSlug);
  const maxPerRun = deps.maxPerRun();
  if (!flagEnabled || !runnerHarness || maxPerRun <= 0) {
    return {
      signals: [],
      note:
        `lane disarmed (flag ${flagEnabled ? 'on' : 'off'}, runner ${runnerHarness ? 'set' : 'unset'}, ` +
        `cap ${maxPerRun}) — dispatcher-staleness check skipped`,
    };
  }

  // The flag/runner/cap describe the dispatcher's CONFIGURATION, but the routine's
  // active bit is its live execution gate. An owner-directed pause leaves those
  // configuration inputs armed while correctly preventing fires; without this read,
  // an old lastDispatchAt plus queued work becomes a false stall alarm on every tick.
  // A missing slug/row or a read failure is unknown and fails open: that is a real
  // configuration/stall condition worth surfacing, unlike an explicit pause.
  if (installSlug) {
    let routineState: DispatcherRoutineState | null = null;
    try {
      routineState = await deps.routineState(workspaceId, installSlug);
    } catch {
      routineState = null;
    }
    if (routineState && !routineState.active) {
      return {
        signals: [],
        note:
          `improvement-implement routine inactive` +
          (routineState.pauseReason ? ` (paused: ${routineState.pauseReason})` : '') +
          ` — dispatcher-staleness check skipped`,
      };
    }
  }

  // 2. Dispatch ledger → lastDispatchAt + env-outage (one read; the table may be absent).
  let rows: ImprovementDispatchRow[];
  try {
    rows = await deps.readDispatches(workspaceId);
  } catch (e) {
    if (isMissingLedgerTable(e)) {
      return { signals: [], note: 'dispatch ledger absent (migration 238 not applied yet) — skipped' };
    }
    throw e;
  }
  // A credential/env outage legitimately PAUSES the lane (plan-implement 'paused') and
  // is surfaced separately (service-down / the orphan collector's outage note) — suppress.
  if (laneInEnvOutage(rows, { nowMs })) {
    return {
      signals: [],
      note: 'lane in a credential/env outage — dispatcher legitimately paused, staleness suppressed',
    };
  }
  const { lastDispatchAt } = computeDispatchStats(rows, { nowMs });

  // 3. The never-dispatched, auto-eligible queue (the dispatcher's own dispatchable
  //    set in a stall: attempts:0 ⟹ never claimed by the runner ⟹ neither in-flight
  //    nor attempts-exhausted). ownerFullAutonomy widens the auto tier exactly as the
  //    dispatcher does (fail-dark to false).
  const ownerFullAutonomy = await deps.ownerFullAutonomy(workspaceId).catch(() => false);
  const items = await deps.readItems({ state: 'open' });
  const createdAtById = new Map(items.map((c) => [c.id, c.createdAt]));
  const digest = buildDigest(items, { nowMs, ownerFullAutonomy });
  const eligible: EligibleDispatchItem[] = digest.autoEligible
    .filter((s) => (s.attempts ?? 0) === 0)
    .map((s) => {
      const createdAt = createdAtById.get(s.id);
      const createdMs = createdAt ? Date.parse(createdAt) : NaN;
      // Unknown/unparseable createdAt → age 0 (conservative: never let a parse glitch trip the alarm).
      const ageMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : 0;
      return { id: s.id, ageMs, triagedPlace: s.triageDecision === 'place' };
    });

  const signals = buildDispatcherStalenessSignal({
    armed: true,
    lastDispatchAt,
    eligible,
    nowMs,
    thresholdMs,
  });
  if (signals.length === 0) {
    return {
      signals,
      note:
        `armed, ${eligible.length} eligible (attempts:0) bug(s), ` +
        `lastDispatchAt=${lastDispatchAt ?? 'never'} — within the ${Math.round(thresholdMs / 3_600_000)}h staleness threshold`,
    };
  }
  return { signals };
}
