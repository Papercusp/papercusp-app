/**
 * dbos/routine-fire-cancellation-alarm — makes a CANCELLED `routineFire` visible
 * (WI-35534, "make it visible" half of the proposed fix; part 2 — auto-reenqueue
 * a max-recovery-cancelled low-frequency fire — is deliberately out of scope here).
 *
 * `routinesTick` claims a routine, bumps `last_fired_at`, and enqueues a
 * `routineFire` DBOS workflow. If bg-host restarts before that fire is serviced,
 * DBOS's own recovery mechanism recovers the still-ENQUEUED workflow; after
 * `recovery_attempts` reaches its cap it CANCELS the workflow — with an EMPTY
 * error string, `catchup:'skip-old'` semantics, and no retry. Nothing reports
 * this: `last_fired_at` already advanced (the tick that enqueued it succeeded),
 * so the routines table reads healthy while the fire that was supposed to DO
 * the work silently never ran.
 *
 * This is invisible-by-construction for a HIGH-frequency routine (it self-heals
 * on the next tick, a few minutes later) but catastrophic for a LOW-frequency
 * one (daily/weekly): a routine whose recent fires are PREDOMINANTLY cancelled
 * has effectively stopped running, indistinguishable from healthy on every
 * existing surface (`harness_shared.routines`, `schedule:inventory`) because
 * none of them read `dbos.workflow_status` at all.
 *
 * Deliberately separate from `dbos-executor-reaper.ts`: the reaper detects and
 * requeues a routineFire that STARTED but produced no operation output (a
 * different DBOS state — PENDING with no first step, not ENQUEUED-then-
 * recovery-cancelled) and already has its own requeue side effect. This alarm
 * is READ-ONLY — it raises visibility, it does not touch the workflow or the
 * routine. Mirrors escalation-aging-alarm.ts's architecture: a deterministic,
 * never-LLM-dependent periodic actor reconciling ONE durably-tracked advisory
 * escalation PER flagged routine, keyed so re-firing coalesces instead of
 * forking a duplicate row, and auto-resolving the moment the routine's recent
 * cancellation rate drops back under threshold.
 *
 * Best-effort + fail-soft: never throws, never blocks the request worker it
 * runs on.
 */
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { getOrgPg } from '@papercusp/db-org';
import {
  openEscalation,
  listEscalationsPaginated,
  resolveEscalation,
  type EscalationRecord,
} from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { SELF_RECONCILING_META_KEY } from '../attention/reconcile-escalations';

export const ROUTINE_FIRE_CANCELLATION_ALARM_IDENTITY: AgentIdentity = {
  ownerId: 'system:routine-fire-cancellation-alarm',
  ownerLabel: 'system · routine-fire-cancellation-alarm',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** The durable per-routine dedup key this alarm's escalations are filed under. */
export function routineFireCancellationConditionKey(routineId: string): string {
  return `routine-fire-cancellation:${routineId}`;
}

/** One routine's fire outcomes over the lookback window. */
export interface RoutineFireCounts {
  routineId: string;
  ok: number;
  cancelled: number;
}

/** A routine whose recent fires are predominantly cancelled. */
export interface RoutineCancellationSignal {
  routineId: string;
  ok: number;
  cancelled: number;
  total: number;
  rate: number;
}

const DEFAULT_RATE_THRESHOLD = 0.5;
const OPEN_SCAN_WINDOW = 200;
const DEFAULT_INTERVAL_MS = 15 * 60_000; // 15min: cheap read-only aggregate query,
// no reason to run it as often as the 5min alarms above — the harm this catches
// only accrues over hours/days for a low-frequency routine.
const DEFAULT_LOOKBACK_DAYS = 7;

/**
 * PURE: which routines' recent fires are predominantly CANCELLED — the general
 * form of the item's own probe (cancelled / (ok + cancelled) > threshold). A
 * routine with zero fires in the window is not flagged (nothing to measure);
 * a routine with fires but zero cancellations is not flagged (healthy).
 */
export function computeCancelledRoutineFireSignals(
  rows: readonly RoutineFireCounts[],
  opts: { rateThreshold?: number } = {},
): RoutineCancellationSignal[] {
  const threshold = opts.rateThreshold ?? DEFAULT_RATE_THRESHOLD;
  const signals: RoutineCancellationSignal[] = [];
  for (const row of rows) {
    const total = row.ok + row.cancelled;
    if (total === 0 || row.cancelled === 0) continue;
    const rate = row.cancelled / total;
    if (rate > threshold) {
      signals.push({ routineId: row.routineId, ok: row.ok, cancelled: row.cancelled, total, rate });
    }
  }
  // Worst rate first, then by absolute cancelled count — the routine losing the
  // largest SHARE of its work is the one most likely to be silently dead.
  return signals.sort((a, b) => b.rate - a.rate || b.cancelled - a.cancelled);
}

/**
 * Default read: aggregate `dbos.workflow_status` `routineFire` rows over the
 * lookback window, per routine id (extracted from the workflow's JSON `inputs`
 * — the routine id is the workflow's first positional argument, same
 * extraction the item's own probe used). `dbos.*` is a single shared schema
 * across every process on this box (no per-workspace partitioning), so no
 * workspace scoping applies here.
 */
async function defaultReadRoutineFireCounts(lookbackDays: number): Promise<RoutineFireCounts[]> {
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT
      split_part(split_part(inputs, '"', 4), '"', 1) AS routine_id,
      count(*) FILTER (WHERE status = 'SUCCESS')   AS ok,
      count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled
    FROM dbos.workflow_status
    WHERE name = 'routineFire'
      AND inputs IS NOT NULL
      AND created_at > (extract(epoch FROM now() - (${lookbackDays} || ' days')::interval) * 1000)
    GROUP BY 1
    HAVING count(*) FILTER (WHERE status = 'CANCELLED') > 0
  `) as unknown as { routine_id: string; ok: number; cancelled: number }[];
  return rows
    .filter((r) => r.routine_id)
    .map((r) => ({ routineId: r.routine_id, ok: Number(r.ok) || 0, cancelled: Number(r.cancelled) || 0 }));
}

export interface RoutineFireCancellationAlarmDeps {
  /** Read recent per-routine fire counts. Default: a fresh `dbos.workflow_status` aggregate. */
  readCounts?: () => Promise<RoutineFireCounts[]>;
  escalate?: (input: {
    severity: 'advisory';
    summary: string;
    body?: string;
    meta?: Record<string, unknown>;
  }) => Promise<unknown>;
  listOpen?: () => Promise<EscalationRecord[]>;
  resolve?: (msg_id: string, choice: string, note: string) => Promise<unknown>;
  rateThreshold?: number;
  lookbackDays?: number;
}

/**
 * One tick: read recent routineFire outcomes, flag routines whose fires are
 * predominantly cancelled, and reconcile ONE durably-tracked advisory
 * escalation per flagged routine (never re-forked while already open; resolved
 * automatically the moment that routine's rate drops back at/under threshold).
 */
export async function runRoutineFireCancellationAlarmTick(
  deps: RoutineFireCancellationAlarmDeps = {},
): Promise<{ signals: RoutineCancellationSignal[]; fired: string[]; resolved: string[] }> {
  const readCounts = deps.readCounts ?? (() => defaultReadRoutineFireCounts(deps.lookbackDays ?? DEFAULT_LOOKBACK_DAYS));
  const escalate =
    deps.escalate ?? ((input) => openEscalation(ROUTINE_FIRE_CANCELLATION_ALARM_IDENTITY, input));
  const listOpen =
    deps.listOpen ??
    (async () => {
      const { escalations } = await listEscalationsPaginated({
        status: 'open',
        maxRecords: OPEN_SCAN_WINDOW,
        from: ROUTINE_FIRE_CANCELLATION_ALARM_IDENTITY.ownerId,
      });
      return escalations;
    });
  const resolve =
    deps.resolve ??
    ((msg_id, choice, note) =>
      resolveEscalation({
        msg_id,
        choice,
        note,
        resolver: ROUTINE_FIRE_CANCELLATION_ALARM_IDENTITY.ownerId,
      }));

  let counts: RoutineFireCounts[] = [];
  try {
    counts = await readCounts();
  } catch {
    // A read failure must never crash the request worker nor look like "all clear".
    return { signals: [], fired: [], resolved: [] };
  }

  const signals = computeCancelledRoutineFireSignals(counts, { rateThreshold: deps.rateThreshold });
  const flaggedIds = new Set(signals.map((s) => s.routineId));

  let openRows: EscalationRecord[] = [];
  try {
    openRows = await listOpen();
  } catch {
    openRows = [];
  }
  const openByRoutine = new Map<string, EscalationRecord>();
  for (const rec of openRows) {
    // meta fields are flattened onto the record itself at open time
    // (Object.assign(env, input.meta) — escalations.ts), never nested under `.meta`.
    const sig = (rec as unknown as Record<string, unknown>).subjectSignature;
    if (typeof sig === 'string' && sig.startsWith('routine-fire-cancellation:')) {
      openByRoutine.set(sig.slice('routine-fire-cancellation:'.length), rec);
    }
  }

  const resolved: string[] = [];
  for (const [routineId, rec] of openByRoutine) {
    if (flaggedIds.has(routineId)) continue; // still cancelling — leave it open
    try {
      await resolve(
        rec.msg_id,
        'auto-resolved',
        `routine-fire-cancellation cleared for ${routineId} — recent fires are no longer predominantly cancelled`,
      );
      resolved.push(rec.msg_id);
    } catch {
      /* a resolve failure must never crash the request worker */
    }
  }

  const fired: string[] = [];
  for (const sig of signals) {
    if (openByRoutine.has(sig.routineId)) continue; // already reporting this routine
    const conditionKey = routineFireCancellationConditionKey(sig.routineId);
    try {
      await escalate({
        severity: 'advisory',
        summary: `Routine '${sig.routineId}' has ${sig.cancelled}/${sig.total} recent fires CANCELLED (${Math.round(sig.rate * 100)}%) — likely silently not running`,
        body:
          `Detected by the deterministic routine-fire-cancellation actor (WI-35534): DBOS's own ` +
          `max-recovery-attempts cancellation (catchup:'skip-old') can cancel a still-ENQUEUED ` +
          `routineFire with an empty error, and nothing retries it. \`last_fired_at\` on ` +
          `harness_shared.routines still advances (the ENQUEUEING tick succeeded), so this routine ` +
          `reads healthy everywhere except \`dbos.workflow_status\` itself. Check: SELECT * FROM ` +
          `dbos.workflow_status WHERE name='routineFire' AND inputs LIKE '%${sig.routineId}%' ` +
          `ORDER BY created_at DESC LIMIT 20. This is purely a VISIBILITY signal — nothing here ` +
          `retries the fire; a human/agent should re-arm or investigate the routine directly.`,
        meta: {
          subjectSignature: conditionKey,
          routineId: sig.routineId,
          [SELF_RECONCILING_META_KEY]: true,
        },
      });
      fired.push(sig.routineId);
    } catch {
      /* an alarm-send failure must never crash the request worker */
    }
  }

  return { signals, fired, resolved };
}

/**
 * Start the alarm on a request-worker loop, mirroring
 * startEscalationAgingAlarm's/startConditionStalenessAlarm's shape (unref'd
 * timer, env-killable, interval overridable). Wire alongside those in
 * bin/hono-host.ts.
 */
export function startRoutineFireCancellationAlarm(opts: { intervalMs?: number } = {}): { stop(): void } {
  if (process.env.PAPERCUSP_ROUTINE_FIRE_CANCELLATION_ALARM === '0') return { stop() {} };
  const envMs = Number(process.env.PAPERCUSP_ROUTINE_FIRE_CANCELLATION_ALARM_MS);
  const intervalMs = opts.intervalMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  const timer = managedSetInterval(
    'routine-fire-cancellation-alarm',
    intervalMs,
    () => runRoutineFireCancellationAlarmTick().then(() => undefined, () => undefined),
    // D-004: must-sample. The condition this alarm reports — a routineFire that DBOS
    // recovery-cancelled after exhausting `recovery_attempts` — is a terminal state
    // written into `dbos.workflow_status` by DBOS itself. Nothing emits an event for
    // it (that silence IS the bug this alarm exists to surface: `last_fired_at` has
    // already advanced, so every existing surface reads healthy), so there is no push
    // signal to subscribe to and the state must be polled.
    { category: 'watchdog', classification: 'must-sample' },
  );
  return {
    stop() {
      timer.stop();
    },
  };
}
