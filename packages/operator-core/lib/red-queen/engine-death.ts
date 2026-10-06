/**
 * engine-death.ts — the routine-engine-death drill class + the OUT-OF-BAND
 * live sentinel (self-learning-frontier-2026-06-12 P-031 / FB-20).
 *
 * Modeled on the 2026-06-12 DBOS incident (insight:
 * esm-dirname-tsx-file-mode-dbos-stall): a swallowed boot error left the
 * routines engine dead while `:3070` answered /api/health — git-sync, the
 * monitors, AND the deploy train all silently stopped. The incident signature
 * (per the insight's diagnosis runbook): EVERY active routine's next_fire_at
 * sits in the past at once. One stale row = that routine's problem; all of
 * them = the engine is dead.
 *
 * The watchdog cannot see this class — its tick rides the same engine
 * (system:improvement-watchdog is a routine; service-health is a DBOS periodic
 * workflow). So detection here is OUT-OF-BAND twice over:
 *
 *   - the DRILL leg feeds the pure detector a synthetic routines snapshot
 *     (planted as drill payload, never as live `harness_shared.routines` rows —
 *     the engine's listDueCronRoutines() spans every workspace, so a planted
 *     active row would be FIRED by the live engine, not ignored);
 *   - the LIVE sentinel is a plain setInterval armed in host-bootstrap right
 *     after the swallowed `[dbos] boot failed` catch — it deliberately does NOT
 *     ride DBOS, the routines engine, or background-worker workflows, so it
 *     survives exactly the failure it watches for. Flag-gated per D-001
 *     (checked every pass, so a P-001 flag flip arms it without a restart).
 *
 * The LIVE sentinel's read is scoped to `activeWorkspaceId()` (EI-14375,
 * 2026-07-19) — unlike the engine's own dispatch, which correctly spans every
 * tenant, THIS detector exists to answer "is THIS host's engine alive", so it
 * must only look at THIS host's own workspace. An earlier unscoped version
 * read active routines across every tenant sharing the Postgres instance and
 * declared papercusp's production engine dead whenever an unrelated
 * tenant's routines were idle — a real, evidenced false alarm (see EI-14375:
 * bg-host-watchdog logged continuous healthy ticks the whole time the
 * unscoped sentinel reported "7/7 active routines overdue").
 */

import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import type { WatchdogCollector, WatchdogSignal } from '../harness/improvements/watchdog';
import { captureImprovement } from '../harness/improvements/capture-core';
import { activeWorkspaceId } from '../workspace-registry';
import { readRoutineEngineLiveness as readTickLiveness, type RoutineEngineLiveness } from '../release/routine-engine-liveness';
import { SANDBOX_SCOPE, SANDBOX_WORKSPACE_ID } from './types';

/** The slice of a routines row the detector needs. */
export interface RoutineLivenessRow {
  name: string;
  active: boolean;
  nextFireAt: string | Date | null;
}

export interface EngineDeathOptions {
  /** How far past next_fire_at a routine must be before it counts overdue (min). */
  graceMinutes?: number;
  /** Active routines required before "all overdue" means engine death (not a quiet box). */
  minActiveRoutines?: number;
}

export const ENGINE_DEATH_DEFAULTS = { graceMinutes: 10, minActiveRoutines: 3 } as const;

/**
 * The parked-loop sentinel, in ms — `NEXT_FIRE_PARKED` (db-org routines-runtime).
 * A LOOP routine parks at `next_fire_at = 'infinity'::timestamptz` while its turn is
 * in flight; it is armed, but deliberately not scheduled, so it can prove the engine
 * neither alive nor dead — the same bucket as a null/unparseable next_fire_at.
 *
 * ⚠ This guard exists because the detector's correctness USED TO depend, invisibly, on
 * `readRoutineLivenessRows` issuing a RAW query: postgres-js parses 'infinity' to an
 * INVALID Date, which the `Number.isFinite` skip below already excludes. Route the same
 * rows through `rowToRoutine` instead — the obvious cleanup, since that mapper exists
 * precisely to make 'infinity' safe for JS readers — and every parked loop becomes a
 * VALID max-Date that reads as "inside its fire window", so the FIRST one short-circuits
 * the scan and reports a genuinely dead engine as alive. Measured 2026-08-08 against a
 * dead-engine snapshot: `dead:false, reason:'routine "loop-su-a" is inside its fire
 * window — engine alive'`, and with the parked row ordered first `overdueCount` collapsed
 * from 3 to 0. papercusp-workspace carries 11 parked loops, so that cleanup would have
 * blinded the sentinel on exactly the outage it exists to catch.
 *
 * Duplicated as a literal rather than imported so the pure detector keeps a dependency-free
 * import graph; `engine-death.test.ts` pins it against the exported NEXT_FIRE_PARKED so the
 * two cannot drift.
 */
export const PARKED_NEXT_FIRE_MS = 8_640_000_000_000_000;

export interface EngineDeathVerdict {
  dead: boolean;
  activeCount: number;
  overdueCount: number;
  /** Minutes the most-overdue routine has been waiting (0 when none). */
  oldestOverdueMinutes: number;
  reason: string;
}

/**
 * Pure: the 06-12 incident signature. Dead ⟺ there are ≥ minActiveRoutines
 * active routines AND every one of them is overdue past the grace window.
 * A single overdue routine (others healthy) is that routine's own problem —
 * the in-band routine-failure collector's territory, not engine death.
 */
export function detectRoutineEngineDeath(
  rows: RoutineLivenessRow[],
  nowMs: number,
  opts: EngineDeathOptions = {},
): EngineDeathVerdict {
  const grace = (opts.graceMinutes ?? ENGINE_DEATH_DEFAULTS.graceMinutes) * 60_000;
  const minActive = opts.minActiveRoutines ?? ENGINE_DEATH_DEFAULTS.minActiveRoutines;
  const active = rows.filter((r) => r.active);
  let overdue = 0;
  let oldestMs = 0;
  for (const r of active) {
    const at = r.nextFireAt instanceof Date ? r.nextFireAt.getTime() : r.nextFireAt ? Date.parse(String(r.nextFireAt)) : NaN;
    // An active routine with no/unparseable next_fire_at can't prove liveness
    // either way — count it neither overdue nor healthy.
    if (!Number.isFinite(at)) continue;
    // Same bucket, and it must be checked BEFORE the in-window test below: a parked
    // loop is armed but deliberately unscheduled, so treating it as "inside its fire
    // window" would let one parked row vouch for a dead engine (see PARKED_NEXT_FIRE_MS).
    if (at >= PARKED_NEXT_FIRE_MS) continue;
    const lateBy = nowMs - at;
    if (lateBy > grace) {
      overdue += 1;
      if (lateBy > oldestMs) oldestMs = lateBy;
    } else {
      // One routine inside its window = the engine fired (or will) — alive.
      return {
        dead: false,
        activeCount: active.length,
        overdueCount: overdue,
        oldestOverdueMinutes: Math.round(oldestMs / 60_000),
        reason: `routine "${r.name}" is inside its fire window — engine alive`,
      };
    }
  }
  if (active.length < minActive || overdue < minActive) {
    return {
      dead: false,
      activeCount: active.length,
      overdueCount: overdue,
      oldestOverdueMinutes: Math.round(oldestMs / 60_000),
      reason: `${active.length} active routine(s) (< ${minActive}) — too few to distinguish engine death from a quiet box`,
    };
  }
  return {
    dead: true,
    activeCount: active.length,
    overdueCount: overdue,
    oldestOverdueMinutes: Math.round(oldestMs / 60_000),
    reason: `ALL ${overdue} active routines overdue past ${opts.graceMinutes ?? ENGINE_DEATH_DEFAULTS.graceMinutes}min — the 06-12 incident signature`,
  };
}

/** Pure: a dead-engine verdict → the watchdog signal (shared by drill + sentinel). */
export function engineDeathSignal(
  verdict: EngineDeathVerdict,
  scope: { key: string; origin?: 'drill'; captureScope?: string },
): WatchdogSignal {
  return {
    source: 'routine-engine-death',
    key: scope.key,
    title: 'The routines engine is dead — every active routine is overdue',
    body:
      `Watchdog signal (routine-engine-death, detected OUT-OF-BAND): ${verdict.overdueCount}/${verdict.activeCount} ` +
      `active routines are overdue (oldest ~${verdict.oldestOverdueMinutes}min) — ${verdict.reason}.\n\n` +
      `This is the 2026-06-12 DBOS incident class: a dead engine means no git-sync sweeps, no monitors, and no ` +
      `auto-deploys (the deploy train cannot carry its own fix). Runbook: ` +
      `agent-insights/esm-dirname-tsx-file-mode-dbos-stall — check the journal for '[dbos] boot failed', ` +
      `then the manual recovery chain.`,
    severity: 'critical',
    kind: 'bug',
    paths: ['packages/operator-core/lib/dbos/routines-workflow.ts', 'apps/operator/bin/host-bootstrap.ts'],
    ...(scope.origin ? { origin: scope.origin } : {}),
    ...(scope.captureScope ? { scope: scope.captureScope } : {}),
  };
}

/**
 * The drill leg's sandbox collector: runs the REAL detector over the planted
 * synthetic snapshot (drill payload), emitting an origin='drill' signal captured
 * under the workspace platform Pot. The snapshot — not live rows — is deliberate: planting
 * active rows in harness_shared.routines would be FIRED by the live engine.
 */
export function engineDeathDrillCollector(snapshot: RoutineLivenessRow[], nowMs?: number): WatchdogCollector {
  return {
    name: 'red-queen-routine-engine-death',
    collect: async () => {
      const verdict = detectRoutineEngineDeath(snapshot, nowMs ?? Date.now());
      if (!verdict.dead) return { signals: [], note: verdict.reason };
      return [
        engineDeathSignal(verdict, {
          key: `engine:${SANDBOX_WORKSPACE_ID}`,
          origin: 'drill',
          captureScope: SANDBOX_SCOPE,
        }),
      ];
    },
  };
}

/**
 * Read the live routine-liveness slice (read-only; safe out-of-band).
 *
 * SCOPED to `workspaceId` (EI-14375, 2026-07-19): `harness_shared.routines` is
 * multi-tenant — this dev box alone has 'papercusp-workspace', 'default'
 * (cross-hive/global routines), and ad-hoc test workspaces sharing one
 * Postgres. The unscoped version of this query read active rows across EVERY
 * tenant and declared "the routines engine is dead" (with THIS host's
 * papercusp-specific runbook + remediation paths) whenever any OTHER
 * tenant's routine set happened to be idle/overdue — even while this host's
 * own engine was provably healthy (bg-host-watchdog logged continuous
 * healthy ticks for the entire window EI-14375 was open). Scoping to the
 * sentinel's own workspace makes the signal mean what its message claims:
 * THIS host's engine, not some unrelated tenant's.
 *
 * The raw row shape here (rather than db-org's `rowToRoutine`) is now a free choice,
 * NOT a load-bearing one: `detectRoutineEngineDeath` skips the parked-loop sentinel in
 * BOTH wire forms (raw 'infinity' → Invalid Date, and the mapped max-Date), so routing
 * these rows through the mapper can no longer blind the detector. It could before —
 * see PARKED_NEXT_FIRE_MS.
 */
export async function readRoutineLivenessRows(sql: Sql, workspaceId: string): Promise<RoutineLivenessRow[]> {
  const rows = await sql<{ name: string; active: boolean; next_fire_at: string | Date | null }[]>`
    SELECT name, active, next_fire_at
      FROM harness_shared.routines
     WHERE active = true
       AND workspace_id = ${workspaceId}
     LIMIT 500`;
  return rows.map((r) => ({ name: r.name, active: r.active, nextFireAt: r.next_fire_at }));
}

/**
 * Diagnostic only: an unscoped `last_fired_at` timestamp shows a routine was
 * claimed for dispatch, not that its DBOS workflow executed or completed.
 * claimDueRoutine writes it before enqueue, so it must never suppress an
 * engine-death capture.
 */
export async function hasRecentGlobalRoutineClaim(sql: Sql, windowMs: number): Promise<boolean> {
  const rows = await sql<{ fresh: boolean }[]>`
    SELECT COALESCE(
      MAX(last_fired_at) >= now() - (${windowMs}::bigint * interval '1 millisecond'),
      false
    ) AS fresh
      FROM harness_shared.routines
     WHERE active = true
       AND last_fired_at IS NOT NULL`;
  return rows[0]?.fresh === true;
}

/** Injectable seam for the sentinel (tests run without PG/flags). */
export interface EngineDeathSentinelDeps {
  isArmed: () => Promise<boolean>;
  readRows: () => Promise<RoutineLivenessRow[]>;
  /** A recent pre-enqueue claim timestamp is diagnostic, never liveness proof. */
  hasRecentGlobalRoutineClaim?: (windowMs: number) => Promise<boolean>;
  readRoutineEngineLiveness?: () => Promise<RoutineEngineLiveness>;
  capture: typeof captureImprovement;
  log: (msg: string) => void;
  /**
   * WI-5456 ask (2): query whether a durable critical pool-shed event
   * (dbos/pool-pressure.ts's recordPoolShedEvent, migration 627) explains the
   * overdue window — a critical PG-pool-starvation shed can legitimately
   * delay/skip a routines tick without the engine actually being dead. This
   * is exactly the "paused by a guardrail, not dead" class
   * hasPoolShedInWindow's own doc comment calls out; wiring it here is the
   * specific consumer that comment was written for. Optional + defaults to
   * "no shed known" (never consulted) when omitted, so existing callers/tests
   * that don't pass it keep today's behavior unchanged.
   */
  hasPoolShedInWindow?: (workspaceId: string, windowMs: number) => Promise<boolean>;
  /** workspaceId for the hasPoolShedInWindow correlation query above (must
   *  match the scope readRows() used, so the shed check looks at the same
   *  tenant as the overdue routines). Only consulted when
   *  hasPoolShedInWindow is provided. Defaults to activeWorkspaceId(). */
  workspaceId?: () => string;
}

/**
 * One sentinel pass: read live routine liveness, detect, and — only on a dead
 * verdict — file ONE organic capture (this is a REAL outage signal, not a
 * drill; dedupScope 'open' keeps it to one open item per outage). Never
 * throws; flag-dark passes do zero PG reads.
 *
 * Before filing, a dead verdict is cross-checked against
 * `deps.hasPoolShedInWindow` (WI-5456 ask 2): if a critical pool-shed
 * guardrail event (pool-pressure.ts) landed within the overdue window, the
 * "all routines overdue" signature is explained by a known, already-logged
 * cause rather than a genuinely dead engine, and the pass returns
 * `shedExplained: true` instead of filing — the exact "dead instrument hid
 * because nothing distinguished shed-by-guardrail from actually-dead" failure
 * class this wiring exists to close.
 */
export async function runEngineDeathSentinelPass(
  deps: EngineDeathSentinelDeps,
  opts: EngineDeathOptions = {},
  nowMs?: number,
): Promise<{
  checked: boolean;
  verdict?: EngineDeathVerdict;
  captured?: boolean;
  shedExplained?: boolean;
  schedulerLivenessProven?: boolean;
}> {
  let observedSchedulerLiveness: RoutineEngineLiveness | undefined;
  try {
    if (!(await deps.isArmed())) return { checked: false };
    const rows = await deps.readRows();
    const verdict = detectRoutineEngineDeath(rows, nowMs ?? Date.now(), opts);
    if (!verdict.dead) return { checked: true, verdict };
    if (deps.hasRecentGlobalRoutineClaim) {
      const graceMinutes = opts.graceMinutes ?? ENGINE_DEATH_DEFAULTS.graceMinutes;
      const windowMs = graceMinutes * 60_000;
      try {
        if (await deps.hasRecentGlobalRoutineClaim(windowMs)) {
          deps.log(
            `workspace-scoped engine-death signature detected (${verdict.reason}) with a recent ` +
              `host-global routine claim timestamp; claim time is not completion evidence, so checking routinesTick liveness.`,
          );
        }
      } catch (e) {
        // UNKNOWN never suppresses a critical detector. Keep evaluating the
        // completion-backed liveness, pool-shed explanation, and capture path.
        deps.log(
          `host-global routine-claim diagnostic failed (UNKNOWN does not suppress): ` +
            `${e instanceof Error ? e.message : e}`,
        );
      }
    }
    if (deps.readRoutineEngineLiveness) {
      try {
        const liveness = await deps.readRoutineEngineLiveness();
        observedSchedulerLiveness = liveness;
        if (liveness.unknown) {
          deps.log('DBOS routinesTick liveness is UNKNOWN (UNKNOWN does not suppress the engine-death capture).');
        } else if (!liveness.stale) {
          deps.log(
            `workspace overdue signature detected (${verdict.reason}), but DBOS routinesTick completed ` +
              `within the last ${Math.round((liveness.staleMs ?? 0) / 1000)}s — scheduler alive; not filing.`,
          );
          return { checked: true, verdict, schedulerLivenessProven: true };
        }
      } catch (e) {
        deps.log(
          `DBOS routinesTick liveness check failed (UNKNOWN does not suppress): ` +
            `${e instanceof Error ? e.message : e}`,
        );
      }
    }
    if (deps.hasPoolShedInWindow) {
      const grace = opts.graceMinutes ?? ENGINE_DEATH_DEFAULTS.graceMinutes;
      const windowMs = (verdict.oldestOverdueMinutes + grace) * 60_000;
      const workspaceId = deps.workspaceId ? deps.workspaceId() : activeWorkspaceId();
      const shedExplained = await deps.hasPoolShedInWindow(workspaceId, windowMs);
      if (shedExplained) {
        deps.log(
          `engine-death signature detected (${verdict.reason}) but explained by a critical ` +
            `pool-shed guardrail event within the last ${Math.round(windowMs / 60_000)}min — ` +
            `treating as paused-by-guardrail, not dead; not filing.`,
        );
        return { checked: true, verdict, shedExplained: true };
      }
    }
    const signal = engineDeathSignal(verdict, { key: 'engine:live' });
    const livenessState = observedSchedulerLiveness
      ? observedSchedulerLiveness.unknown
        ? 'UNKNOWN'
        : observedSchedulerLiveness.stale
          ? 'STALE'
          : 'FRESH'
      : deps.readRoutineEngineLiveness
        ? 'ERROR'
        : 'NOT_CHECKED';
    const captureEvidence =
      `Capture provenance: sentinelPid=${process.pid}; uptimeSec=${Math.floor(process.uptime())}; ` +
      `dbPool=getOrgPg; routinesTick=${livenessState}; ` +
      `lastTickMs=${observedSchedulerLiveness?.lastTickMs ?? 'null'}; ` +
      `staleMs=${observedSchedulerLiveness?.staleMs ?? 'null'}.`;
    const res = await deps.capture({
      title: signal.title,
      kind: 'bug',
      body: `${signal.body}\n\n${captureEvidence}`,
      severity: signal.severity,
      paths: signal.paths,
      scope: 'operator',
      foundDuring: 'red-queen-engine-death-sentinel',
      createdBy: 'system:red-queen-sentinel',
      sourceRole: 'system',
      source: 'su',
      dedupScope: 'open',
      watchdogKey: `routine-engine-death:${signal.key}`,
      // The live sentinel is an availability monitor — a dead engine is an
      // ORGANIC signal (no origin override), unlike the sandbox drill leg.
    });
    deps.log(
      `ENGINE DEATH detected (${verdict.reason}) — capture ${res.created ? `filed ${res.issue?.id}` : `declined (${res.reason})`}; ${captureEvidence}`,
    );
    return { checked: true, verdict, captured: res.created };
  } catch (e) {
    deps.log(`sentinel pass failed (next interval retries): ${e instanceof Error ? e.message : e}`);
    return { checked: false };
  }
}

/** Default sentinel cadence — frequent enough to beat the 30s tick's users noticing. */
export const ENGINE_DEATH_SENTINEL_INTERVAL_MS = 5 * 60_000;

let sentinelTimer: ManagedHandle | null = null;

/**
 * Arm the out-of-band sentinel: a managedSetInterval (out-of-band — never DBOS,
 * never the routines engine; it must survive exactly the failure it watches for,
 * so it registers for VISIBILITY but stays bespoke per D-005).
 * Call once from host-bootstrap AFTER the dbos start block. The
 * `papercusp-red-queen` flag is checked inside every pass, so the sentinel is
 * inert while dark and a P-001 flag flip arms it without a restart.
 */
export function armEngineDeathSentinel(intervalMs: number = ENGINE_DEATH_SENTINEL_INTERVAL_MS): void {
  if (sentinelTimer) return;
  const deps: EngineDeathSentinelDeps = {
    isArmed: async () => {
      const [{ FLAGS }, { getFlag }] = await Promise.all([import('@papercusp/flags'), import('@papercusp/flags/server')]);
      return getFlag(FLAGS.RED_QUEEN, 'red-queen-sentinel');
    },
    readRows: async () => readRoutineLivenessRows((await import('@papercusp/db-org')).getOrgPg().sql, activeWorkspaceId()),
    hasRecentGlobalRoutineClaim: async (windowMs) =>
      hasRecentGlobalRoutineClaim((await import('@papercusp/db-org')).getOrgPg().sql, windowMs),
    readRoutineEngineLiveness: async () =>
      readTickLiveness((await import('@papercusp/db-org')).getOrgPg().sql),
    capture: captureImprovement,
    log: (m) => console.log(`[red-queen-sentinel] ${m}`),
    hasPoolShedInWindow: async (workspaceId, windowMs) => {
      const { hasPoolShedInWindow } = await import('../dbos/pool-pressure');
      return hasPoolShedInWindow(workspaceId, windowMs);
    },
    workspaceId: () => activeWorkspaceId(),
  };
  sentinelTimer = managedSetInterval(
    'red-queen-engine-death',
    intervalMs,
    // managedSetInterval's callback is `() => void | Promise<void>` — runEngineDeathSentinelPass()
    // resolves a richer { checked, verdict?, captured? } shape. `.then(() => {})` (no rejection
    // handler) collapses the RESOLVED type to void while still PROPAGATING a rejection, so
    // managedSetInterval's own tick tracking (rec.entry.lastError) keeps seeing sentinel
    // failures — swallowing the rejection here (a bare `.catch`) would silently blind that
    // tracking, which is exactly the failure class this sentinel exists to catch.
    () => runEngineDeathSentinelPass(deps).then(() => {}),
    { category: 'watchdog' },
  );
}

/** Disarm (tests). */
export function disarmEngineDeathSentinel(): void {
  if (sentinelTimer) sentinelTimer.stop();
  sentinelTimer = null;
}
