/**
 * dispatch-ledger.ts — the DURABLE dispatch ledger for the auto-implement lane
 * (self-improvement-consume-edges-2026-06-12 P-010 / B-04, core of EI-365).
 *
 * One `harness_shared.improvement_dispatches` row per dispatch (migration 238),
 * written by the `improvement-implement` routine AT FIRE TIME and driven to a
 * terminal state by exactly one of:
 *
 *   - the fire itself failing            → outcome 'fire-failed' (immediate)
 *   - the worker's `improvements:resolve` back-edge
 *                                        → 'fixed' | 'could-not-fix' | 'needs-human'
 *   - the orphaned-dispatch collector (P-011, worker death)
 *                                        → 'orphaned'
 *
 * Before this ledger the three failure shapes were indistinguishable from a
 * worker still running — the lane ran armed for two days with zero resolves
 * while looking permanently "in progress" (EI-365). The state model lives in
 * this module (the columns are plain text; this seam owns the vocabulary):
 *
 *   fire_result 'pending' → row inserted, fire not yet returned. A row STUCK
 *   here means the dispatcher itself died mid-fire.
 *   fire_result 'ok' + outcome NULL → in progress (presumed dead once older
 *   than the overdue threshold).
 *   outcome non-NULL → terminal.
 *
 * Write-side fns used by the dispatch loop (`recordDispatchFired`,
 * `recordFireResult`) swallow + warn on PG failure — accounting must never
 * block the dispatch itself (the issue claim already prevents double-dispatch).
 * Everything else throws naturally; callers on best-effort paths wrap.
 * `computeDispatchStats` is PURE over injected rows (unit-testable without PG),
 * mirroring flow-metrics.ts.
 */

import { getOrgPg } from '@papercusp/db-org';

/** Terminal outcomes a dispatch row can reach (NULL in PG = still open). */
export type DispatchOutcome = 'fixed' | 'could-not-fix' | 'needs-human' | 'fire-failed' | 'orphaned';

/** The resolve back-edge's subset of outcomes (what improvements:resolve reports). */
export type DispatchResolveOutcome = Extract<DispatchOutcome, 'fixed' | 'could-not-fix' | 'needs-human'>;

export interface ImprovementDispatchRow {
  id: string;
  workspaceId: string;
  itemId: string;
  attempt: number;
  runnerHarness: string | null;
  /** ISO timestamp. */
  firedAt: string;
  fireResult: 'pending' | 'ok' | 'error';
  fireError: string | null;
  spawnedRunId: string | null;
  outcome: DispatchOutcome | null;
  /** ISO timestamp, set with the terminal outcome. */
  resolvedAt: string | null;
  resolvedBy: string | null;
}

/**
 * How long an open dispatch may run before the read side reports it `overdue`
 * (worker presumed dead). Default 2h — aligned with plan-implement's stale-claim
 * window and P-011's orphan threshold, and comfortably above the 45-min worker
 * timeout (`PAPERCUSP_IMPROVEMENT_IMPLEMENT_TIMEOUT_MS`).
 */
export function dispatchOverdueAfterMs(): number {
  // Private mirror of improvement-actions' intFromEnv (importing it would make
  // an improvement-actions ↔ dispatch-ledger cycle): honor an explicit valid
  // integer, fall back on unset/blank/garbage.
  const raw = process.env.PAPERCUSP_IMPROVEMENT_DISPATCH_OVERDUE_MS;
  if (raw == null || raw.trim() === '') return 7_200_000;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || String(n) !== raw.trim() || n < 60_000) {
    console.warn(`[dispatch-ledger] PAPERCUSP_IMPROVEMENT_DISPATCH_OVERDUE_MS="${raw}" invalid — using 7200000`);
    return 7_200_000;
  }
  return n;
}

export interface RecordDispatchInput {
  workspaceId: string;
  itemId: string;
  /** payload.implementAttempts as stamped for THIS dispatch (1-based). */
  attempt: number;
  runnerHarness: string | null;
  /**
   * (per-hive-learning-loops P-012) The Hive that OWNS the dispatched improvement,
   * resolved from the item's `scope:'harness:<X>'` tag (P-032) to its home Hive, so
   * per-hive dispatch diagnostics align with the per-hive improvement lens (P-040).
   * NULL for an operator-scoped (workspace-global) item.
   */
  potSlug?: string | null;
}

/**
 * Insert the ledger row for one dispatch, BEFORE the fire (fire_result
 * 'pending'). Returns the row id for `recordFireResult`, or null when the
 * write failed (logged loudly; the dispatch proceeds — see module doc).
 */
export async function recordDispatchFired(input: RecordDispatchInput): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.improvement_dispatches
        (workspace_id, item_id, attempt, runner_harness, pot_slug)
      VALUES (${input.workspaceId}, ${input.itemId}, ${input.attempt}, ${input.runnerHarness}, ${input.potSlug ?? null})
      RETURNING id`;
    return rows[0]?.id ?? null;
  } catch (e) {
    console.warn(
      `[dispatch-ledger] FAILED to record dispatch of ${input.itemId} — the lane is flying blind for this row:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

export type FireResultUpdate =
  | { ok: true; spawnedRunId?: string | null }
  | { ok: false; error: string };

/**
 * Record the fire's result on the row `recordDispatchFired` created. A failed
 * fire is TERMINAL ('fire-failed') — distinguishable from a worker in progress.
 * Swallow + warn on PG failure (the dispatch loop must keep going).
 */
export async function recordFireResult(dispatchId: string, result: FireResultUpdate): Promise<void> {
  try {
    const { sql } = getOrgPg();
    if (result.ok) {
      await sql`
        UPDATE harness_shared.improvement_dispatches
           SET fire_result = 'ok', spawned_run_id = ${result.spawnedRunId ?? null}
         WHERE id = ${dispatchId}`;
    } else {
      await sql`
        UPDATE harness_shared.improvement_dispatches
           SET fire_result = 'error', fire_error = ${result.error},
               outcome = 'fire-failed', resolved_at = now(), resolved_by = 'system'
         WHERE id = ${dispatchId}`;
    }
  } catch (e) {
    console.warn(`[dispatch-ledger] FAILED to record fire result on ${dispatchId}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Drive every OPEN row for one item terminal — the `improvements:resolve`
 * back-edge (resolve-core wires this in as an injectable dep). Closes all open
 * rows, not just the newest: a re-dispatched item must never strand an older
 * open row for the orphan collector to false-positive on. Returns the count
 * closed. Throws on PG failure (resolve-core wraps it best-effort).
 */
export async function closeDispatchesForItem(
  itemId: string,
  opts: { outcome: DispatchResolveOutcome; by?: string },
): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.improvement_dispatches
       SET outcome = ${opts.outcome}, resolved_at = now(), resolved_by = ${opts.by ?? 'improvement-runner'}
     WHERE item_id = ${itemId} AND outcome IS NULL
     RETURNING id`;
  return rows.length;
}

/**
 * Mark one open dispatch 'orphaned' (worker death). The two writers:
 *   - the P-011 orphan collector (the 2h catch-all, `by` defaults here), and
 *   - the worker-exit back-edge (EI-404 — `recordImplementWorkerExit`, by
 *     'worker-exit-backedge'), which fires in SECONDS when the worker exits
 *     without resolving, instead of waiting for the 2h threshold.
 * No-op (false) when the row is already terminal, so the collector, the
 * back-edge, and a late resolve can all race safely. `detail` (exit code +
 * bounded output tail) is stored on `fire_error` for diagnosis — a dead
 * worker's last words; COALESCE keeps any prior detail when none is supplied.
 */
export async function markDispatchOrphaned(
  dispatchId: string,
  by = 'orphaned-dispatch-collector',
  detail?: string,
): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.improvement_dispatches
       SET outcome = 'orphaned', resolved_at = now(), resolved_by = ${by},
           fire_error = COALESCE(${detail ?? null}, fire_error)
     WHERE id = ${dispatchId} AND outcome IS NULL
     RETURNING id`;
  return rows.length > 0;
}

/** The most recent dispatches for a workspace, newest first. */
export async function readRecentDispatches(
  workspaceId: string,
  opts: { limit?: number } = {},
): Promise<ImprovementDispatchRow[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
  const rows = await sql<
    {
      id: string;
      workspace_id: string;
      item_id: string;
      attempt: number;
      runner_harness: string | null;
      fired_at: Date | string;
      fire_result: string;
      fire_error: string | null;
      spawned_run_id: string | null;
      outcome: string | null;
      resolved_at: Date | string | null;
      resolved_by: string | null;
    }[]
  >`
    SELECT id, workspace_id, item_id, attempt, runner_harness, fired_at,
           fire_result, fire_error, spawned_run_id, outcome, resolved_at, resolved_by
      FROM harness_shared.improvement_dispatches
     WHERE workspace_id = ${workspaceId}
     ORDER BY fired_at DESC
     LIMIT ${limit}`;
  const iso = (v: Date | string | null): string | null =>
    v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    itemId: r.item_id,
    attempt: Number(r.attempt) || 1,
    runnerHarness: r.runner_harness,
    firedAt: iso(r.fired_at) as string,
    fireResult: (r.fire_result === 'ok' || r.fire_result === 'error' ? r.fire_result : 'pending') as
      | 'pending'
      | 'ok'
      | 'error',
    fireError: r.fire_error,
    spawnedRunId: r.spawned_run_id,
    outcome: (r.outcome ?? null) as DispatchOutcome | null,
    resolvedAt: iso(r.resolved_at),
    resolvedBy: r.resolved_by,
  }));
}

/**
 * The rollup the watchdog-status tool and the Learning tab flow strip render.
 * Buckets are DISJOINT — every row lands in exactly one of
 * firing / inProgress / overdue / fireFailed / orphaned / resolved.*.
 */
export interface DispatchStats {
  /** Rows considered (the caller-bounded read window). */
  total: number;
  /** Dispatches fired in the trailing 7 days (flow, not stock). */
  fired7d: number;
  /** fire_result 'pending', open — the fire is in flight (or the dispatcher died mid-fire). */
  firing: number;
  /** Fire ok, no outcome, younger than the overdue threshold — a worker is (presumably) on it. */
  inProgress: number;
  /** Open past the overdue threshold — worker presumed dead; P-011's collector target. */
  overdue: number;
  fireFailed: number;
  orphaned: number;
  resolved: { fixed: number; couldNotFix: number; needsHuman: number };
  /** 'fixed' outcomes in the trailing 7 days — the lane's actual throughput. */
  fixed7d: number;
  lastDispatchAt: string | null;
  /** The most recent terminal transition (any outcome). */
  lastOutcomeAt: string | null;
}

export interface ComputeDispatchStatsOptions {
  /** Now, in ms — injectable for deterministic tests; callers pass Date.now(). */
  nowMs?: number;
  /** Open-row age past which a dispatch is `overdue` (default dispatchOverdueAfterMs()). */
  overdueAfterMs?: number;
}

/** Pure rollup over ledger rows. Deterministic given nowMs; no PG, no clock reads. */
export function computeDispatchStats(
  rows: ImprovementDispatchRow[],
  opts: ComputeDispatchStatsOptions = {},
): DispatchStats {
  const nowMs = opts.nowMs ?? Date.now();
  const overdueAfterMs = opts.overdueAfterMs ?? dispatchOverdueAfterMs();
  const weekStart = nowMs - 7 * 24 * 60 * 60 * 1000;

  const stats: DispatchStats = {
    total: rows.length,
    fired7d: 0,
    firing: 0,
    inProgress: 0,
    overdue: 0,
    fireFailed: 0,
    orphaned: 0,
    resolved: { fixed: 0, couldNotFix: 0, needsHuman: 0 },
    fixed7d: 0,
    lastDispatchAt: null,
    lastOutcomeAt: null,
  };

  for (const r of rows) {
    const firedMs = Date.parse(r.firedAt);
    if (!Number.isNaN(firedMs) && firedMs >= weekStart && firedMs <= nowMs) stats.fired7d += 1;
    if (stats.lastDispatchAt === null || r.firedAt > stats.lastDispatchAt) stats.lastDispatchAt = r.firedAt;
    if (r.resolvedAt && (stats.lastOutcomeAt === null || r.resolvedAt > stats.lastOutcomeAt)) {
      stats.lastOutcomeAt = r.resolvedAt;
    }

    if (r.outcome === 'fixed') {
      stats.resolved.fixed += 1;
      const resolvedMs = r.resolvedAt ? Date.parse(r.resolvedAt) : NaN;
      if (!Number.isNaN(resolvedMs) && resolvedMs >= weekStart && resolvedMs <= nowMs) stats.fixed7d += 1;
    } else if (r.outcome === 'could-not-fix') stats.resolved.couldNotFix += 1;
    else if (r.outcome === 'needs-human') stats.resolved.needsHuman += 1;
    else if (r.outcome === 'fire-failed') stats.fireFailed += 1;
    else if (r.outcome === 'orphaned') stats.orphaned += 1;
    else {
      // Open. Age decides whether someone is plausibly still working it.
      const age = Number.isNaN(firedMs) ? Number.POSITIVE_INFINITY : nowMs - firedMs;
      if (age > overdueAfterMs) stats.overdue += 1;
      else if (r.fireResult === 'pending') stats.firing += 1;
      else stats.inProgress += 1;
    }
  }
  return stats;
}
