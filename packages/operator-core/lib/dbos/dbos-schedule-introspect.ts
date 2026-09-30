/**
 * dbos-schedule-introspect — enumerate the REGISTERED DBOS scheduled workflows
 * (the schedule *registry*, not execution rows) for the central schedule
 * inventory (plan schedule-inventory-and-ephemeral-tier-2026-06-26, P-001).
 *
 * `/admin/dbos` already shows `dbos.workflow_status` EXECUTION rows; this is the
 * complementary read — the cron *definitions* themselves (name @ crontab; mode;
 * queue). DBOS keeps those only in an in-process registry populated when the
 * workflow modules are imported (`registerScheduled` runs at import time), so we
 * read it via the SDK's own introspection seam, `DBOS.getAssociatedInfo('dbos.scheduler')`
 * — the exact call `ScheduledReceiver.initialize()` / `logRegisteredEndpoints()`
 * use (node_modules/@dbos-inc/dbos-sdk scheduler_decorator).
 *
 * Last-fire comes from the SDK's own `dbos.event_dispatch_kv` (service_name
 * 'dbos.scheduler', workflow_fn_name `${className}.${name}`, key 'lastState',
 * value = epoch ms) — the row the scheduler loop upserts each fire. Both reads
 * degrade to empty when DBOS isn't loaded in THIS process (flag off, or a :3070
 * request worker that never imported the workflow modules), so the accessor never
 * throws and never 500s the inventory. EI-1622 context: this is read-only and
 * adds ZERO workflow_status rows.
 */
import { getOrgPg } from '@papercusp/db-org';

const SCHEDULER_SERVICE = 'dbos.scheduler';
/** Mirrors SchedulerMode.ExactlyOncePerIntervalWhenActive (the SDK default when a schedule omits `mode`). */
const DEFAULT_MODE = 'ExactlyOncePerIntervalWhenActive';

export interface DbosScheduledEntry {
  /** `${className}.${functionName}` — the schedule's registry key (also the event_dispatch_kv workflow_fn_name). */
  name: string;
  crontab: string;
  mode: string;
  queueName: string | null;
  /** epoch ms of the last fire (event_dispatch_kv lastState), or null if never fired / not tracked. */
  lastFireMs: number | null;
  /** most-recent execution status for this schedule (best-effort match on workflow_status.name), or null. */
  lastStatus: string | null;
}

/** A registered schedule as read from the SDK registry (pre-PG-enrichment). */
export interface RegisteredSchedule {
  name: string;
  crontab: string;
  mode: string;
  queueName: string | null;
}

/** Per-schedule fire state, keyed by schedule name. */
export type FireState = Map<string, { lastFireMs: number | null; lastStatus: string | null }>;

export interface DbosScheduleIntrospectDeps {
  /** Enumerate the in-process schedule registry. Default: DBOS.getAssociatedInfo('dbos.scheduler'); [] when the SDK isn't loaded. */
  getRegisteredSchedules: () => Promise<RegisteredSchedule[]> | RegisteredSchedule[];
  /** Per-schedule last-fire + last-status. Default: query dbos.event_dispatch_kv + dbos.workflow_status; empty when the dbos schema is absent. */
  getFireState: (names: string[]) => Promise<FireState>;
}

/** Production default: read the SDK's in-process scheduler registry. Never throws. */
export async function defaultGetRegisteredSchedules(): Promise<RegisteredSchedule[]> {
  try {
    const mod = (await import('@dbos-inc/dbos-sdk')) as {
      DBOS?: { getAssociatedInfo?: (s: string) => readonly unknown[] };
    };
    const getInfo = mod.DBOS?.getAssociatedInfo;
    if (typeof getInfo !== 'function') return [];
    const regs = getInfo.call(mod.DBOS, SCHEDULER_SERVICE) as ReadonlyArray<{
      methodReg?: { className?: string; name?: string };
      methodConfig?: { crontab?: string; mode?: string; queueName?: string };
    }>;
    const out: RegisteredSchedule[] = [];
    for (const r of regs) {
      const cfg = r.methodConfig ?? {};
      if (!cfg.crontab) continue; // missing crontab → not an active schedule (the SDK skips it too)
      const className = r.methodReg?.className ?? '';
      const fn = r.methodReg?.name ?? '';
      out.push({
        // Keep the SDK's exact scheduler key. Its scheduler loop builds this
        // as `${className}.${name}`, including the leading dot for an empty
        // class name; that is the key written to event_dispatch_kv.
        name: `${className}.${fn}`,
        crontab: cfg.crontab,
        mode: cfg.mode ?? DEFAULT_MODE,
        queueName: cfg.queueName ?? null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Production default: enrich from `dbos.event_dispatch_kv` (last fire) +
 * `dbos.workflow_status` (last status, best-effort). Never throws; returns an
 * empty map when the `dbos` schema is absent (DBOS never launched).
 */
export async function defaultGetFireState(names: string[]): Promise<FireState> {
  const map: FireState = new Map();
  if (names.length === 0) return map;
  try {
    const { sql } = getOrgPg();
    const present = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'dbos'
      ) AS exists`;
    if (!present[0]?.exists) return map;

    const fires = await sql<{ workflow_fn_name: string; value: string | null }[]>`
      SELECT workflow_fn_name, value
        FROM dbos.event_dispatch_kv
       WHERE service_name = ${SCHEDULER_SERVICE}
         AND key = 'lastState'
         AND workflow_fn_name = ANY(${names})`;
    for (const row of fires) {
      const ms = row.value != null ? Number.parseFloat(row.value) : Number.NaN;
      map.set(row.workflow_fn_name, {
        lastFireMs: Number.isFinite(ms) ? ms : null,
        lastStatus: null,
      });
    }

    // Best-effort last status: tolerant of the className.name vs function-name
    // mismatch — a miss simply leaves lastStatus null.
    const statuses = await sql<{ name: string; status: string }[]>`
      SELECT DISTINCT ON (name) name, status
        FROM dbos.workflow_status
       WHERE name = ANY(${names})
       ORDER BY name, created_at DESC`;
    for (const row of statuses) {
      const prev = map.get(row.name) ?? { lastFireMs: null, lastStatus: null };
      prev.lastStatus = row.status;
      map.set(row.name, prev);
    }
    return map;
  } catch {
    return map;
  }
}

/**
 * List the registered DBOS scheduled workflows, enriched with last-fire/last-status.
 * Returns [] when DBOS isn't loaded in this process. Never throws — a PG hiccup in
 * the enrichment leg degrades to schedules with null fire-state, never an error.
 */
export async function listDbosScheduledWorkflows(
  deps: Partial<DbosScheduleIntrospectDeps> = {},
): Promise<DbosScheduledEntry[]> {
  const getRegistered = deps.getRegisteredSchedules ?? defaultGetRegisteredSchedules;
  const getFireState = deps.getFireState ?? defaultGetFireState;

  const registered = await getRegistered();
  if (registered.length === 0) return [];

  const names = registered.map((r) => r.name);
  let fireState: FireState;
  try {
    fireState = await getFireState(names);
  } catch {
    fireState = new Map();
  }

  return registered
    .map((r): DbosScheduledEntry => {
      const fs = fireState.get(r.name);
      return {
        name: r.name,
        crontab: r.crontab,
        mode: r.mode,
        queueName: r.queueName,
        lastFireMs: fs?.lastFireMs ?? null,
        lastStatus: fs?.lastStatus ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
