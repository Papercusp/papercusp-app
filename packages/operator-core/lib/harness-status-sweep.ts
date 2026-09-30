/**
 * PID-liveness sweeper for harness_shared.harness_lanes + per-harness
 * agent_runs.running. Counterpart to harness-fs-watcher: where the watcher
 * mirrors disk to PG, the sweeper detects PG state that's gone stale
 * because run.sh was SIGKILL'd or otherwise didn't run its trap EXIT.
 *
 * Two responsibilities, each runs every SWEEP_INTERVAL_MS:
 *
 *   1. agent_runs orphans — for every per-harness `agent_runs` row with
 *      running=true, check if its recorded PID still exists in /proc/<pid>.
 *      If not, set running=false.
 *
 *   2. harness_lanes orphans — drop rows whose recorded PID is gone, or
 *      (fallback) whose started_at is older than LANE_STALE_MS when the
 *      row has no PID. Catches workers that SIGKILL'd without running
 *      pg_clear_lanes.
 *
 * NOT here (moved to expirable-registry):
 *   - harness_status stalled detection (TTL via expires_at column,
 *     registered with onExpire: mark-status running → stalled).
 *   - operator_scan_locks, operator_claims, papercusp_auth.magic_link_requests,
 *     papercusp_auth.sessions — all pure TTL.
 *
 * The split is by signal kind: PID-liveness lives here because long-running
 * invokes can't be modeled cleanly with TTL (would require bash-side
 * heartbeat plumbing in run.sh). Pure-TTL state lives in expirable-registry.
 *
 * Pinned to globalThis (anti-pattern A18 compliance with Next.js dev
 * module re-eval). Started lazily from the API entrypoint; SIGTERM/SIGINT
 * release the timer.
 */
import { existsSync } from 'node:fs';
import { getResourceProfile } from './resource-profile';
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq } from 'drizzle-orm';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';

const hl = generated.harnessLanesInHarnessShared;
import { loadHarnessRegistry } from './harness-registry';
import { backgroundWorkersEnabled } from './background-workers';
// F-E5 (app-wide-load-traps § E): widen the background cadence on a quiet/
// battery host so periodic work runs proportionally less often (multiplier 1 on AC).
const SWEEP_INTERVAL_MS = 30_000 * getResourceProfile().backgroundCadenceMultiplier;
// Lane rows are PID-tagged by run.sh's pg_write_lane. As long as the PID is
// alive, the lane is legitimately running — agent invocations can take an
// hour+ on hard features. Only fall back to age-based sweeping when the PID
// is missing (legacy rows / failed PID capture). 24h is generous enough that
// we never sweep an actually-live invocation.
const LANE_STALE_MS = 24 * 60 * 60_000;

interface SweepState {
  timer: ManagedHandle;
  stopped: boolean;
}

type _G = { __harnessStatusSweep?: SweepState };
const _g = globalThis as unknown as _G;

function pidIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    return existsSync(`/proc/${pid}`);
  } catch {
    return false;
  }
}

/**
 * For each per-harness schema with an agent_runs table, clear `running` on
 * any row whose recorded PID is gone. agent_runs is per-schema (not in
 * harness_shared), so we have to iterate registered projects.
 *
 * agent_runs is populated via FS scans of .papercusp/logs/*.jsonl; PIDs
 * aren't recorded anywhere in that pipeline (the JSONL doesn't carry them,
 * and the row gets created by directory enumeration, not by spawn-time
 * writes). So PID-based liveness for agent_runs is structurally not
 * available — the mtime cutoff IS the right signal.
 *
 * For the PID-knowing case we use harness_lanes, which is orchestrator-
 * written and carries the spawning shell's PID (sweepHarnessLanes below
 * is the PID-aware path).
 *
 * mtime cutoff: clear running=true on rows whose updated_ts is older
 * than LANE_STALE_MS (run.sh would have either updated them or marked
 * them done by now).
 */
/**
 * Ident hygiene (audit P-029): the slug comes from the registry, but it
 * still feeds a SQL identifier in sql.unsafe — sanitize to one plain
 * segment like resources/harness/issues.ts does.
 */
function schemaIdentForSlug(slug: string): string {
  return `harness_${slug.replace(/[^a-z0-9_]/gi, '_')}`;
}

async function sweepAgentRunsRunning(): Promise<void> {
  const reg = await loadHarnessRegistry();
  const projects = reg.projects ?? [];
  const cutoff = Date.now() - LANE_STALE_MS;
  for (const proj of projects) {
    try {
      // Per-harness schema reach via search_path. Use postgres-js raw exec
      // on the org pool with set_config for the search path.
      const { sql } = getOrgPg();
      const schema = schemaIdentForSlug(proj.slug);
      // Skip if the schema doesn't exist yet (uninstalled harness).
      const exists = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}
        ) AS exists
      `;
      if (!exists[0]?.exists) continue;
      // Identifier is sanitized above; the cutoff travels as a bound
      // parameter, not string interpolation (audit P-029).
      await sql.unsafe(
        `UPDATE ${schema}.agent_runs SET running = false
          WHERE running = true AND updated_ts < $1`,
        [cutoff],
      );
    } catch (e) {
      console.warn(`[harness-status-sweep] agent_runs sweep failed for ${proj.slug}:`, (e as Error)?.message ?? e);
    }
  }
}

async function sweepHarnessLanes(): Promise<void> {
  const { sql } = getOrgPg();
  const cutoff = Date.now() - LANE_STALE_MS;
  // Drop lanes where:
  //   - the recorded PID is gone (definitive — caller died)
  //   - OR started_at is older than LANE_STALE_MS (no PID recorded; conservative)
  //
  // Two-step: read lanes, decide which to drop, then DELETE the survivors.
  // Doing the PID check inline in SQL is impossible; we have to read.
  try {
    const { db } = getOrgPg();
    const rows = await db
      .select({
        harness_slug: hl.harnessSlug,
        phase: hl.phase,
        role: hl.role,
        pid: hl.pid,
        started_at: hl.startedAt,
      })
      .from(hl);
    for (const r of rows) {
      const startedAt = Number(r.started_at);
      const pidPresent = r.pid != null;
      const pidGone = pidPresent && !pidIsAlive(Number(r.pid));
      // PID-based liveness wins when we have it. Age-based sweep only
      // applies as a fallback when the row has no PID (legacy schema or
      // pg_write_lane fired before the worker pid was captured).
      const ageStale = !pidPresent
        && (!Number.isFinite(startedAt) || startedAt < cutoff);
      if (!pidGone && !ageStale) continue;
      await db
        .delete(hl)
        .where(and(eq(hl.harnessSlug, r.harness_slug), eq(hl.phase, r.phase), eq(hl.role, r.role)));
    }
  } catch (e) {
    console.warn('[harness-status-sweep] lane sweep failed:', (e as Error)?.message ?? e);
  }
}

/**
 * One sweep pass — the in-process periodic scheduler and the legacy fallback
 * timer both call this. Iteration column is orchestrator-owned; the sweeper never
 * writes it. harness_status stalled detection moved to expirable-registry once
 * the schema grew an explicit expires_at column. This sweeper only handles
 * PID-liveness work that TTL can't model cleanly.
 */
export async function runHarnessStatusSweepOnce(): Promise<void> {
  await sweepAgentRunsRunning();
  await sweepHarnessLanes();
}

async function tick(): Promise<void> {
  await runHarnessStatusSweepOnce();
}

/**
 * Idempotent. Starts the sweeper on first call; subsequent calls return
 * the existing state. Call from the same Hono entrypoint that starts
 * harness-fs-watcher.
 */
export function ensureHarnessStatusSweep(): SweepState {
  if (_g.__harnessStatusSweep) return _g.__harnessStatusSweep;

  // EI-1622: the in-process-periodic scheduler (dbos/in-process-periodic.ts, armed
  // from host-bootstrap under `backgroundWorkers`) now owns this sweep wherever
  // background workers run. This legacy in-process timer stands down on the SAME
  // predicate so the two never both fire in ONE process — and it now uses
  // backgroundWorkersEnabled() (NOT dbosTimersActive): the new scheduler runs
  // independent of DBOS, so the desktop app (backgroundWorkers ON, DBOS OFF) must
  // NOT also run this legacy timer. The legacy path is left as the fallback for
  // hosts where the new scheduler does NOT run (e.g. the :3170 request-only operator).
  //
  // ⚠ CORRECTED 2026-08-02 (EI-19305266463631270). An earlier revision of this comment
  // asserted that on the 16-worker :3070 cluster backgroundWorkersEnabled() is TRUE in
  // every worker, so all 17 stood this timer down and armed the scheduler's copy instead.
  // That is backwards, and it inverted the whole case table below. Measured reality: all 17
  // :3070 processes carry PAPERCUSP_BACKGROUND_WORKERS=0 (the dev-api drop-in sets it
  // service-wide), so backgroundWorkersEnabled() is FALSE in each — none of them stood
  // down, all 17 armed THIS legacy timer, and the scheduler's copy never armed there at
  // all. The fix is on the caller side: host-bootstrap now guards the
  // ensureHarnessStatusSweep() call with `cluster.isPrimary`, matching the fs-watcher and
  // credential-sync singletons it sits between.
  //
  // The stand-down below is therefore NOT a host-singleton mechanism and must not be
  // relied on as one — it only answers "has the in-process-periodic scheduler taken
  // ownership of this sweep on this host". `cluster.isPrimary` at the call site is what
  // makes it once-per-host. Walking the cases with both gates in place:
  //   cluster WORKER  — never reached: the caller's cluster.isPrimary guard skips it.
  //   cluster PRIMARY — bgWorkers FALSE on :3070, so this legacy timer arms; the
  //                     scheduler suite is not armed on that host ⇒ exactly one, host-wide.
  //   bg-host/desktop — bgWorkers TRUE, so this stands down and the scheduler owns the
  //                     sweep (both are unclustered, so the caller's guard is a no-op).
  //   :3170 / no bg   — legacy arms as the fallback; scheduler never armed ⇒ exactly one.
  if (backgroundWorkersEnabled()) {
    _g.__harnessStatusSweep = {
      timer: undefined as unknown as ManagedHandle,
      stopped: true,
    };
    return _g.__harnessStatusSweep;
  }

  const state: SweepState = {
    timer: managedSetInterval('harness-status-sweep', SWEEP_INTERVAL_MS, () => {
      tick().catch((e) =>
        console.warn('[harness-status-sweep] tick failed:', e?.message ?? e),
      );
    }, { category: 'global-sweep' }),
    stopped: false,
  };

  // First tick fires immediately so cold-boot picks up anything stale
  // without waiting 30s.
  void tick().catch(() => {});

  const shutdown = () => stopHarnessStatusSweep();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  _g.__harnessStatusSweep = state;
  return state;
}

export function stopHarnessStatusSweep(): void {
  const state = _g.__harnessStatusSweep;
  if (!state || state.stopped) return;
  state.stopped = true;
  state.timer.stop();
  _g.__harnessStatusSweep = undefined;
}

/** Test-only hook so a unit test can trigger one tick deterministically. */
export const _internals = {
  pidIsAlive,
  schemaIdentForSlug,
  sweepAgentRunsRunning,
  sweepHarnessLanes,
  tick,
};
