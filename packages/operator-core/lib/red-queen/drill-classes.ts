/**
 * drill-classes.ts — the Red Queen drill registry
 * (self-learning-frontier-2026-06-12 P-031 / FB-20).
 *
 * One drill class per covered watchdog collector family. Every class follows
 * the same safety shape:
 *
 *   - plant() writes ONLY sandbox-workspace rows (SANDBOX_WORKSPACE_ID) into
 *     the real substrate table the family's collector reads. All v1 families
 *     are workspace-scoped collectors, so the live watchdog is structurally
 *     blind to the planted rows (zero-leak by partition).
 *   - collectors() wraps the REAL collector function — same SQL, same pure
 *     signal builders — pointed at the sandbox workspace, then stamps
 *     origin='drill' + the valid operator storage scope on every signal (the
 *     WatchdogSignal fields FB-03 threaded for exactly this). The origin is the
 *     read partition; a synthetic harness slug is not a registered Pot.
 *   - heal() applies the known remedy; cleanup() removes every planted row
 *     (exact-identity deletes, idempotent — runs even after a failed cycle).
 *
 * NOT YET COVERED (need a leak-safe planting strategy first — their collectors
 * are NOT workspace-scoped, so a planted row would be visible to the live
 * watchdog or fired by the live engine): red-test, repeated-tool-error,
 * service-down, migration-drift, routine-failure (in-band), failed-spawn,
 * expired-lease, insight-staleness, orphaned-dispatch, ship-link, and the
 * hive-loop monitors. Add classes here as strategies land; the registry is the
 * extension seam. The routine-engine-death class (out-of-band, snapshot-fed)
 * lives in engine-death.ts and is registered below.
 */

import type { Sql } from 'postgres';
import {
  collectCircuitOpenSignals,
  collectEscalationSignals,
  collectSmokeFailSignals,
  collectStuckPlanSignals,
  type WatchdogCollector,
  type WatchdogSignal,
} from '../harness/improvements/watchdog';
import {
  engineDeathDrillCollector,
  type RoutineLivenessRow,
} from './engine-death';
import { SANDBOX_HARNESS_SLUG, SANDBOX_SCOPE, SANDBOX_WORKSPACE_ID, type DrillClass, type PlantedDrill } from './types';

/** Stamp the drill provenance + sandbox scope on every signal a wrapper yields. */
export function stampDrillSignals(signals: WatchdogSignal[]): WatchdogSignal[] {
  return signals.map((s) => ({ ...s, origin: 'drill' as const, scope: SANDBOX_SCOPE }));
}

/**
 * Wrap a real collector for the given workspace. Sandbox sweeps stamp
 * origin='drill' + the operator storage scope; a live-workspace sweep (the zero-leak
 * check) passes signals through untouched — it only ever ASSERTS emptiness,
 * never captures.
 */
function wrap(name: string, workspaceId: string, collect: () => Promise<WatchdogSignal[]>): WatchdogCollector {
  return {
    name,
    collect: async () => {
      const signals = await collect();
      return workspaceId === SANDBOX_WORKSPACE_ID ? stampDrillSignals(signals) : signals;
    },
  };
}

/** smoke-fail: a RED smoke test for the sandbox harness. */
const smokeFailDrill: DrillClass = {
  id: 'smoke-fail',
  collectorFamily: 'smoke-fail',
  description: 'plants a failing harness smoke test in the sandbox workspace',
  plant: async (sql) => {
    await sql`
      INSERT INTO harness_shared.harness_smoke_test
        (harness_slug, status, failure_content, mtime_ms, workspace_id)
      VALUES (${SANDBOX_HARNESS_SLUG}, 'fail',
              'red-queen drill: synthetic smoke failure (planted, origin=drill)',
              ${Date.now()}, ${SANDBOX_WORKSPACE_ID})
      ON CONFLICT (harness_slug) DO UPDATE SET
        status = 'fail',
        failure_content = EXCLUDED.failure_content,
        mtime_ms = EXCLUDED.mtime_ms,
        workspace_id = EXCLUDED.workspace_id`;
    return {
      expectedWatchdogKey: `smoke-fail:${SANDBOX_HARNESS_SLUG}`,
      expectedKind: 'bug',
      expectedSeverity: 'major',
      expectedDecision: 'place',
      artifacts: { table: 'harness_smoke_test', harness_slug: SANDBOX_HARNESS_SLUG },
    };
  },
  collectors: (sql, _planted, workspaceId) => [
    wrap('red-queen-smoke-fail', workspaceId, () => collectSmokeFailSignals(sql, workspaceId)),
  ],
  heal: async (sql) => {
    await sql`
      UPDATE harness_shared.harness_smoke_test
         SET status = 'pass', pass_content = 'red-queen drill healed', mtime_ms = ${Date.now()}
       WHERE harness_slug = ${SANDBOX_HARNESS_SLUG} AND workspace_id = ${SANDBOX_WORKSPACE_ID}`;
  },
  cleanup: async (sql) => {
    await sql`
      DELETE FROM harness_shared.harness_smoke_test
       WHERE harness_slug = ${SANDBOX_HARNESS_SLUG} AND workspace_id = ${SANDBOX_WORKSPACE_ID}`;
  },
};

const DRILL_PLAN_SLUG = 'red-queen-drill-plan';

/** stuck-plan: a sandbox plan 'started' with a backdated heartbeat. */
const stuckPlanDrill: DrillClass = {
  id: 'stuck-plan',
  collectorFamily: 'stuck-plan',
  description: 'plants a sandbox plan stuck in started past the stale bar',
  plant: async (sql) => {
    await sql`
      INSERT INTO harness_shared.harness_plan_status
        (workspace_id, harness_slug, plan_slug, status, started_at, updated_at)
      VALUES (${SANDBOX_WORKSPACE_ID}, ${SANDBOX_HARNESS_SLUG}, ${DRILL_PLAN_SLUG}, 'started',
              now() - interval '26 hours', now() - interval '25 hours')
      ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET
        status = 'started',
        started_at = EXCLUDED.started_at,
        updated_at = EXCLUDED.updated_at`;
    return {
      expectedWatchdogKey: `stuck-plan:stuck-plan:${SANDBOX_HARNESS_SLUG}:${DRILL_PLAN_SLUG}`,
      expectedKind: 'bug',
      expectedSeverity: 'major',
      expectedDecision: 'place',
      artifacts: { table: 'harness_plan_status', harness_slug: SANDBOX_HARNESS_SLUG, plan_slug: DRILL_PLAN_SLUG },
    };
  },
  collectors: (sql, _planted, workspaceId) => [
    wrap('red-queen-stuck-plan', workspaceId, () => collectStuckPlanSignals(sql, workspaceId)),
  ],
  heal: async (sql) => {
    await sql`
      UPDATE harness_shared.harness_plan_status
         SET status = 'done', updated_at = now()
       WHERE workspace_id = ${SANDBOX_WORKSPACE_ID} AND harness_slug = ${SANDBOX_HARNESS_SLUG}
         AND plan_slug = ${DRILL_PLAN_SLUG}`;
  },
  cleanup: async (sql) => {
    await sql`
      DELETE FROM harness_shared.harness_plan_status
       WHERE workspace_id = ${SANDBOX_WORKSPACE_ID} AND harness_slug = ${SANDBOX_HARNESS_SLUG}
         AND plan_slug = ${DRILL_PLAN_SLUG}`;
  },
};

/** unresolved-escalation: a sandbox escalation with no supervisor notes. */
const escalationDrill: DrillClass = {
  id: 'unresolved-escalation',
  collectorFamily: 'unresolved-escalation',
  description: 'plants an unaddressed escalation on the sandbox harness',
  plant: async (sql) => {
    await sql`
      INSERT INTO harness_shared.harness_escalations
        (harness_slug, phase, escalation, supervisor_notes, mtime_ms, workspace_id)
      VALUES (${SANDBOX_HARNESS_SLUG}, 'staging',
              'red-queen drill: synthetic escalation needing supervisor attention (planted, origin=drill)',
              '', ${Date.now()}, ${SANDBOX_WORKSPACE_ID})
      ON CONFLICT (harness_slug, phase) DO UPDATE SET
        escalation = EXCLUDED.escalation,
        supervisor_notes = '',
        mtime_ms = EXCLUDED.mtime_ms,
        workspace_id = EXCLUDED.workspace_id`;
    return {
      expectedWatchdogKey: `unresolved-escalation:escalation:${SANDBOX_HARNESS_SLUG}:staging`,
      expectedKind: 'bug',
      expectedSeverity: 'major',
      expectedDecision: 'place',
      artifacts: { table: 'harness_escalations', harness_slug: SANDBOX_HARNESS_SLUG, phase: 'staging' },
    };
  },
  collectors: (sql, _planted, workspaceId) => [
    wrap('red-queen-unresolved-escalation', workspaceId, () => collectEscalationSignals(sql, workspaceId)),
  ],
  heal: async (sql) => {
    await sql`
      UPDATE harness_shared.harness_escalations
         SET supervisor_notes = 'red-queen drill healed: resolved by the drill remedy', mtime_ms = ${Date.now()}
       WHERE harness_slug = ${SANDBOX_HARNESS_SLUG} AND phase = 'staging'
         AND workspace_id = ${SANDBOX_WORKSPACE_ID}`;
  },
  cleanup: async (sql) => {
    await sql`
      DELETE FROM harness_shared.harness_escalations
       WHERE harness_slug = ${SANDBOX_HARNESS_SLUG} AND phase = 'staging'
         AND workspace_id = ${SANDBOX_WORKSPACE_ID}`;
  },
};

const DRILL_ROLE = 'red-queen-drill-worker';

/** fire-circuit-open: a sandbox role fire-path stuck in error-backoff. */
const circuitOpenDrill: DrillClass = {
  id: 'fire-circuit-open',
  collectorFamily: 'fire-circuit-open',
  description: 'plants a sandbox autoloop fire-path with a tripped error circuit',
  plant: async (sql) => {
    await sql`
      INSERT INTO harness_shared.autoloop_state
        (harness_slug, role, last_fired_at, last_status, consecutive_errors, workspace_id)
      VALUES (${SANDBOX_HARNESS_SLUG}, ${DRILL_ROLE}, now(),
              'red-queen drill: synthetic consecutive fire errors (planted, origin=drill)',
              7, ${SANDBOX_WORKSPACE_ID})
      ON CONFLICT (workspace_id, harness_slug, role) DO UPDATE SET
        last_fired_at = now(),
        last_status = EXCLUDED.last_status,
        consecutive_errors = 7`;
    return {
      expectedWatchdogKey: `fire-circuit-open:circuit:${SANDBOX_HARNESS_SLUG}:${DRILL_ROLE}`,
      expectedKind: 'bug',
      expectedSeverity: 'major',
      expectedDecision: 'place',
      artifacts: { table: 'autoloop_state', harness_slug: SANDBOX_HARNESS_SLUG, role: DRILL_ROLE },
    };
  },
  collectors: (sql, _planted, workspaceId) => [
    wrap('red-queen-fire-circuit-open', workspaceId, () => collectCircuitOpenSignals(sql, workspaceId)),
  ],
  heal: async (sql) => {
    await sql`
      UPDATE harness_shared.autoloop_state
         SET consecutive_errors = 0, last_status = 'red-queen drill healed: circuit reset'
       WHERE workspace_id = ${SANDBOX_WORKSPACE_ID} AND harness_slug = ${SANDBOX_HARNESS_SLUG}
         AND role = ${DRILL_ROLE}`;
  },
  cleanup: async (sql) => {
    await sql`
      DELETE FROM harness_shared.autoloop_state
       WHERE workspace_id = ${SANDBOX_WORKSPACE_ID} AND harness_slug = ${SANDBOX_HARNESS_SLUG}
         AND role = ${DRILL_ROLE}`;
  },
};

/** The synthetic engine-death snapshot the drill plants (as payload, never live rows). */
export function engineDeathSnapshot(nowMs: number): RoutineLivenessRow[] {
  // Four active routines, all overdue 30–90 min — the all-overdue-at-once
  // signature, clear of the 10-min grace and the 3-routine floor.
  return ['git-sync', 'improvement-watchdog', 'green-checkpoint', 'release-trigger'].map((name, i) => ({
    name: `drill:${name}`,
    active: true,
    nextFireAt: new Date(nowMs - (30 + i * 20) * 60_000).toISOString(),
  }));
}

/**
 * routine-engine-death: OUT-OF-BAND (the 06-12 DBOS incident class). The
 * snapshot is planted as drill PAYLOAD, not as live routines rows — the live
 * engine spans every workspace and would fire a planted active row. heal()
 * mutates the snapshot to "engine recovered" (next fires in the future);
 * there are no substrate artifacts to clean.
 */
const engineDeathDrill: DrillClass = {
  id: 'routine-engine-death',
  collectorFamily: 'out-of-band',
  description: 'plants an all-routines-overdue snapshot and runs the out-of-band detector over it',
  plant: async (_sql, _planted) => ({
    expectedWatchdogKey: `routine-engine-death:engine:${SANDBOX_WORKSPACE_ID}`,
    expectedKind: 'bug',
    expectedSeverity: 'critical',
    expectedDecision: 'place',
    artifacts: {},
    payload: { snapshot: engineDeathSnapshot(Date.now()) },
  }),
  collectors: (_sql, planted, workspaceId) => {
    // Nothing is planted outside the drill payload, so a live-workspace sweep
    // has nothing to find — the leak check passes vacuously by construction.
    if (workspaceId !== SANDBOX_WORKSPACE_ID) return [];
    const snapshot = (planted.payload?.snapshot ?? []) as RoutineLivenessRow[];
    return [engineDeathDrillCollector(snapshot)];
  },
  heal: async (_sql, planted) => {
    // The remedy for a dead engine is a restart that brings every routine back
    // inside its window. There are no substrate rows to mutate — the snapshot
    // lives only in the drill payload — so "engine recovered" means pushing
    // every routine's next_fire_at into the future, in place, so the post-heal
    // re-sweep reads a healthy snapshot and the detector returns alive.
    const snapshot = (planted.payload?.snapshot ?? []) as RoutineLivenessRow[];
    const healedAt = Date.now();
    for (const row of snapshot) {
      row.active = true;
      row.nextFireAt = new Date(healedAt + 5 * 60_000).toISOString();
    }
  },
  cleanup: async () => {},
};

/** The v1 registry, in rotation order. */
export const DRILL_CLASSES: readonly DrillClass[] = [
  smokeFailDrill,
  stuckPlanDrill,
  escalationDrill,
  circuitOpenDrill,
  engineDeathDrill,
];

export function drillClassById(id: string): DrillClass | undefined {
  return DRILL_CLASSES.find((c) => c.id === id);
}

/** Exact-identity sweep of every class's artifacts (the belt-and-suspenders janitor). */
export async function cleanupAllDrillArtifacts(sql: Sql): Promise<void> {
  for (const c of DRILL_CLASSES) {
    await c.cleanup(sql, { artifacts: {} } as PlantedDrill).catch(() => {});
  }
}
