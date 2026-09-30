/**
 * dbos-hang-watchdog — the sibling of dead-workflow-monitor for the OTHER silent
 * DBOS failure: a workflow that is NEVER terminal because DBOS keeps loyally
 * recovering a hang, forever (EI-18754773151573358, filed off EI-18752434722211671).
 *
 * THE GAP: dead-workflow-monitor watches `ERROR` / `MAX_RECOVERY_ATTEMPTS_EXCEEDED` —
 * both TERMINAL states. A workflow with an unbounded `await` inside a step (the
 * EI-18752434722211671 root cause) never reaches either: DBOS checkpoints each step
 * that DOES complete, and on executor restart / periodic recovery it faithfully
 * re-claims the workflow and re-runs from the last checkpoint — which hangs again at
 * the exact same step, forever. From the outside this is INDISTINGUISHABLE from
 * healthy activity: `status` stays `PENDING`, a live executor owns the row,
 * `updated_at` is recent, and `recovery_attempts` climbing looks like the retry is
 * making progress rather than looping in place. Verified live on the P-302 rig
 * 2026-07-26: a `routine:rt_papercusp_git_sync` workflow sat PENDING with
 * `recovery_attempts=3` and its `operation_outputs` step ledger frozen at
 * `function_id=7` across all three recoveries — no detector anywhere read that.
 *
 * THE SIGNAL (from the filed sketch): a workflow whose `recovery_attempts` counter
 * ADVANCES between two observations, while its max `operation_outputs.function_id`
 * does NOT, has definitionally been recovered without making a single step of
 * progress — a hang being re-run, not slow work. This generalizes to every DBOS
 * workflow, not just git-sync (which already has its own commit-staleness watchdog;
 * see git-sync-stall-watchdog.ts — this fills the gap for every OTHER workflow).
 *
 * SCOPE: deliberately READ-ONLY, exactly like dead-workflow-monitor — it only SELECTs
 * `dbos.workflow_status` / `dbos.operation_outputs` and never throws, so it cannot
 * affect the workflows it watches. It does NOT touch the reaper or recovery logic:
 * the filed finding explicitly warns against "fixing" this by shortening the reaper
 * window (that converts a silent stall into a faster reap→requeue→hang loop) and
 * that three earlier fix directions on the parent issue would have made things worse.
 * This is visibility only — same reason dead-workflow-monitor stops at a WARN log
 * instead of a per-instance human escalation (round-1 D-005: don't flood the human
 * channel with per-workflow operational noise; the fleet's curator/log-reading
 * surfaces are where this kind of aggregate signal belongs).
 *
 * State is process-in-memory only (a Map, cleared on restart) — there is nothing to
 * corrupt by losing it: the next sweep simply re-observes one baseline before it can
 * alarm again, same cold-start behavior as a fresh process. Multiple hosts running
 * this concurrently (bg-host / staging / release) may each independently detect the
 * same hang and log it — harmless, unlike an escalation ledger, which would need
 * cross-process dedup (deliberately not needed here since this never opens one).
 *
 * Kill-switch: PAPERCUSP_DBOS_HANG_WATCHDOG='0'.
 */
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';

/** A workflow must have recovered at least this many times before it is even a
 *  candidate — below this, "recovery_attempts" is noise (a single restart is
 *  ordinary). Matches the concrete incident (`recovery_attempts=3`). */
export const DEFAULT_MIN_RECOVERY_ATTEMPTS = 2;
/** How often to sweep. DBOS recoveries happen on executor restart / a periodic
 *  recovery pass, not continuously — 10 min keeps this well ahead of the 30min+ the
 *  incident sat silent, without hammering `operation_outputs`. */
export const DEFAULT_HANG_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** Cap on candidates read per sweep — a runaway PENDING count is itself a different,
 *  already-covered problem (the executor reaper); this just bounds the query. */
const CANDIDATE_LIMIT = 500;

/** One PENDING workflow already past the recovery-attempts floor. */
export interface HangCandidate {
  workflowUuid: string;
  name: string | null;
  recoveryAttempts: number;
  /** max(operation_outputs.function_id) for this workflow, or null when it has
   *  never checkpointed a single step (also a hang signal — arguably a worse one). */
  maxFunctionId: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** What the watchdog remembers about one workflow between sweeps. */
export interface HangTrackedState {
  recoveryAttempts: number;
  maxFunctionId: number | null;
  /** true once this workflow has already been logged as stuck — suppresses
   *  re-logging every sweep for the same still-open hang (log once per episode). */
  alreadyLogged: boolean;
}

/** A confirmed "recovered without progress" hang, ready to log. */
export interface HangAlert {
  workflowUuid: string;
  name: string | null;
  recoveryAttempts: number;
  priorRecoveryAttempts: number;
  maxFunctionId: number | null;
  ageMs: number;
}

export interface HangSweepEvaluation {
  alerts: HangAlert[];
  nextState: Map<string, HangTrackedState>;
  /** workflows recovered this sweep after previously being logged stuck (progress
   *  resumed, or the row went terminal/disappeared) — for an optional recovery log. */
  recovered: string[];
}

/**
 * PURE — merge this sweep's candidates against the previous sweep's tracked state
 * and decide which ones are a confirmed hang. Exported for unit testing; the DB
 * wiring (the two SELECTs) is integration-covered via runDbosHangSweepOnce.
 *
 * A workflow with NO prior state is a fresh baseline: it already cleared the
 * recovery-attempts floor (so it may already be hung), but this sweep cannot tell
 * whether it is looping in place without a second data point — so it never alarms
 * on first sight, only records the baseline (mirrors the git-sync-stall-watchdog
 * head-tracking clock: first observation never alarms).
 */
export function evaluateHangSweep(
  candidates: readonly HangCandidate[],
  prevState: ReadonlyMap<string, HangTrackedState>,
  now: number,
): HangSweepEvaluation {
  const alerts: HangAlert[] = [];
  const recovered: string[] = [];
  const nextState = new Map<string, HangTrackedState>();
  const seen = new Set<string>();

  for (const c of candidates) {
    seen.add(c.workflowUuid);
    const prev = prevState.get(c.workflowUuid);
    if (!prev) {
      nextState.set(c.workflowUuid, {
        recoveryAttempts: c.recoveryAttempts,
        maxFunctionId: c.maxFunctionId,
        alreadyLogged: false,
      });
      continue;
    }

    const recoveryAdvanced = c.recoveryAttempts > prev.recoveryAttempts;
    const functionIdAdvanced =
      c.maxFunctionId != null && prev.maxFunctionId != null && c.maxFunctionId > prev.maxFunctionId;
    // Both still null (never checkpointed a step, ever, across a recovery) is NOT
    // progress either — treat it the same as "did not advance".
    const madeProgress = functionIdAdvanced || (c.maxFunctionId == null && prev.maxFunctionId == null && !recoveryAdvanced);

    if (recoveryAdvanced && !functionIdAdvanced) {
      // The smoking gun: DBOS recovered this workflow again and the checkpoint
      // pointer is exactly where it was before the recovery.
      if (!prev.alreadyLogged) {
        alerts.push({
          workflowUuid: c.workflowUuid,
          name: c.name,
          recoveryAttempts: c.recoveryAttempts,
          priorRecoveryAttempts: prev.recoveryAttempts,
          maxFunctionId: c.maxFunctionId,
          ageMs: Math.max(0, now - c.createdAtMs),
        });
      }
      nextState.set(c.workflowUuid, {
        recoveryAttempts: c.recoveryAttempts,
        maxFunctionId: c.maxFunctionId,
        alreadyLogged: true,
      });
      continue;
    }

    if (functionIdAdvanced && prev.alreadyLogged) {
      // Real progress resumed after we'd flagged it stuck — worth a recovery note.
      recovered.push(c.workflowUuid);
    }
    void madeProgress; // documents the both-null case; no separate branch needed
    nextState.set(c.workflowUuid, {
      recoveryAttempts: c.recoveryAttempts,
      maxFunctionId: c.maxFunctionId,
      // Keep the flag only if nothing changed (recoveryAttempts steady) — once real
      // progress is observed, the episode is over.
      alreadyLogged: prev.alreadyLogged && !functionIdAdvanced,
    });
  }

  // A previously-tracked workflow that's no longer a candidate (completed, GC'd, or
  // dropped below the floor — e.g. workflow_uuid reuse is not a thing here) is gone,
  // one way or another; if we had it flagged, that's a recovery worth a note.
  for (const [uuid, prev] of prevState) {
    if (!seen.has(uuid) && prev.alreadyLogged) recovered.push(uuid);
  }

  return { alerts, nextState, recovered };
}

interface HangSweepRow {
  workflow_uuid: string;
  name: string | null;
  recovery_attempts: string | number;
  created_at: string | number;
  updated_at: string | number;
}

interface FunctionMaxRow {
  workflow_uuid: string;
  max_fid: number | string | null;
}

/** Module-level, in-process only (see file header — losing this on restart is fine). */
let trackedState = new Map<string, HangTrackedState>();

export interface DbosHangSweepResult {
  alerted: HangAlert[];
  recovered: string[];
}

/**
 * One watchdog pass: read every PENDING workflow past the recovery-attempts floor,
 * batch-read their max operation_outputs.function_id, and log any confirmed hang.
 * Never throws. Read-only — no writes anywhere.
 */
export async function runDbosHangSweepOnce(
  sql: Sql,
  opts: { minRecoveryAttempts?: number; nowMs?: number } = {},
): Promise<DbosHangSweepResult> {
  const minRecoveryAttempts = opts.minRecoveryAttempts ?? DEFAULT_MIN_RECOVERY_ATTEMPTS;
  const now = opts.nowMs ?? Date.now();
  try {
    const present = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'dbos'
      ) AS exists`;
    if (!present[0]?.exists) return { alerted: [], recovered: [] };

    const rows = await sql<HangSweepRow[]>`
      SELECT workflow_uuid, name, recovery_attempts, created_at, updated_at
        FROM dbos.workflow_status
       WHERE status = 'PENDING'
         AND recovery_attempts >= ${minRecoveryAttempts}
       ORDER BY recovery_attempts DESC
       LIMIT ${CANDIDATE_LIMIT}`;

    const ids = rows.map((r) => r.workflow_uuid);
    const maxByWorkflow = new Map<string, number>();
    if (ids.length > 0) {
      const maxRows = await sql<FunctionMaxRow[]>`
        SELECT workflow_uuid, max(function_id) AS max_fid
          FROM dbos.operation_outputs
         WHERE workflow_uuid = ANY(${ids})
         GROUP BY workflow_uuid`;
      for (const r of maxRows) {
        if (r.max_fid != null) maxByWorkflow.set(r.workflow_uuid, Number(r.max_fid));
      }
    }

    const candidates: HangCandidate[] = rows.map((r) => ({
      workflowUuid: r.workflow_uuid,
      name: r.name,
      recoveryAttempts: Number(r.recovery_attempts),
      maxFunctionId: maxByWorkflow.get(r.workflow_uuid) ?? null,
      createdAtMs: Number(r.created_at),
      updatedAtMs: Number(r.updated_at),
    }));

    const { alerts, nextState, recovered } = evaluateHangSweep(candidates, trackedState, now);
    trackedState = nextState;

    for (const a of alerts) {
      console.warn(
        `[dbos-hang-watchdog] STUCK: workflow ${a.workflowUuid} (${a.name ?? 'unknown'}) was recovered again ` +
          `(recovery_attempts ${a.priorRecoveryAttempts} -> ${a.recoveryAttempts}) with NO step progress ` +
          `(max operation_outputs.function_id stuck at ${a.maxFunctionId ?? 'none — never checkpointed a step'}, ` +
          `age ~${Math.round(a.ageMs / 60_000)}min). DBOS is loyally re-running a hang, not making progress. ` +
          `See dbos.workflow_status / dbos.operation_outputs for this workflow_uuid. Background: EI-18754773151573358.`,
      );
    }
    if (recovered.length > 0) {
      console.warn(
        `[dbos-hang-watchdog] RECOVERED: ${recovered.length} previously-stuck workflow(s) now progressing or gone: ${recovered.join(', ')}`,
      );
    }
    return { alerted: alerts, recovered };
  } catch (e) {
    console.warn(`[dbos-hang-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return { alerted: [], recovered: [] };
  }
}

/** Test-only: reset the in-process tracked state between test cases. */
export function resetDbosHangWatchdogStateForTests(): void {
  trackedState = new Map();
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the watchdog: an immediate boot check + a recurring process-level sweep.
 * Idempotent. Kill-switch: PAPERCUSP_DBOS_HANG_WATCHDOG='0'.
 */
export function startDbosHangWatchdog(
  sql: Sql,
  opts: { intervalMs?: number; minRecoveryAttempts?: number } = {},
): void {
  if (process.env.PAPERCUSP_DBOS_HANG_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_HANG_SWEEP_INTERVAL_MS;

  let sweeping = false;
  const run = (): void => {
    if (sweeping) return; // never overlap a slow tick
    sweeping = true;
    void runDbosHangSweepOnce(sql, opts).finally(() => {
      sweeping = false;
    });
  };

  run(); // boot check
  if (watchdogTimer) watchdogTimer.stop();
  // D-004 (stop-discarded-dedup-and-audit-server-polling-2026-07-26, P-011): this sweep
  // detects a workflow re-recovered without progress by comparing recovery_attempts /
  // operation_outputs across successive periodic samples — the same "has enough time
  // passed without an expected transition" shape as this file's siblings
  // spawn-reclaim-sweep / stale-claim-sweep (in-process-periodic.ts), both classified
  // 'timeout-reaper'.
  watchdogTimer = managedSetInterval('dbos-hang-watchdog', intervalMs, run, {
    category: 'watchdog',
    classification: 'timeout-reaper',
  });
}
