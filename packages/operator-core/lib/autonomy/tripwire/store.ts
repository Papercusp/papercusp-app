/**
 * tripwire/store.ts — PG glue for the auto-revert tripwire ledger
 * (queen-autonomy-policy-2026-06-13 B-16 / P-080, P-081). Backs
 * `harness_shared.autonomy_tripwires` (migration 266).
 *
 * The pure decisions live in {@link ./core}; this module only persists arming
 * rows, loads armed rows for the sweep, flips status (cleared / tripped /
 * reverted), and reads the rows back as graduation evidence. Every function
 * takes the `postgres` client explicitly (admin handle in prod, a test client
 * under integration) so the store is decoupled from connection management.
 *
 * Fail-safe (D-007): a read against the not-yet-applied table (42P01) returns
 * empty — so a pre-boot-apply state is dormant, never an error. Writes against a
 * missing table no-op with a warning (the subsystem is dark until the owner arms
 * autonomy, so a lost arming pre-migration is immaterial).
 */
import type { Sql } from 'postgres';
import { type AutonomyCategory, isAutonomyCategory } from '../categories';
import type { AutonomyDecision } from '../decider';
import type {
  ArmedTripwire,
  RevertHandle,
  TripwireArming,
  TripwireSignalKind,
  TripwireStatus,
} from './core';
import { trackDetached } from '../../detached-imports';

/** PG error code for "relation does not exist" — table not applied yet. */
const UNDEFINED_TABLE = '42P01';

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string })?.code === UNDEFINED_TABLE;
}

function genId(): string {
  return `tw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Push-on-write for the Health tab's autonomy panel
 * (stop-discarded-dedup-and-audit-server-polling-2026-07-26 P-013 / D-007):
 * every tripwire status flip changes the armed/tripped/reverted counts that
 * panel shows. Lazy import so this store stays decoupled from the sync/health
 * layers (same fire-and-forget discipline as improvements/capture-core.ts) — a
 * cold health cache makes this a safe no-op.
 */
function refreshAutonomyHealthPanel(workspaceId: string): void {
  void trackDetached(import('../../system-health/compute'))
    .then((m) => m.refreshHealthPanel('autonomy', workspaceId))
    .catch(() => {});
}

function toMs(v: Date | string | null): number {
  if (v == null) return 0;
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/** A full tripwire row, with timestamps as ms (the pure core's unit). */
export interface TripwireRow extends ArmedTripwire {
  workspaceId: string;
  action: string | null;
  riskTier: string;
  reversibility: string;
  revertHandle: RevertHandle;
  decision: AutonomyDecision | null;
  /** Link to the decision-ledger disposition row (B-13), or null if uncorrelated. */
  decisionId: string | null;
  tripReason: TripwireSignalKind | null;
  resolvedAtMs: number | null;
  revertedAtMs: number | null;
  resolvedBy: string | null;
}

interface RawRow {
  id: string;
  workspace_id: string;
  category: string;
  finding_class: string;
  action: string | null;
  risk_tier: string;
  reversibility: string;
  revert_handle: RevertHandle | null;
  decision: AutonomyDecision | null;
  decision_id: string | null;
  status: string;
  trip_reason: string | null;
  armed_at: Date | string;
  window_until: Date | string;
  resolved_at: Date | string | null;
  reverted_at: Date | string | null;
  resolved_by: string | null;
}

function rowFrom(r: RawRow): TripwireRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    category: r.category as AutonomyCategory,
    findingClass: r.finding_class,
    action: r.action,
    riskTier: r.risk_tier,
    reversibility: r.reversibility,
    revertHandle: (r.revert_handle ?? { kind: 'unknown' }) as RevertHandle,
    decision: r.decision,
    decisionId: r.decision_id ?? null,
    status: r.status as TripwireStatus,
    tripReason: (r.trip_reason ?? null) as TripwireSignalKind | null,
    armedAtMs: toMs(r.armed_at),
    windowUntilMs: toMs(r.window_until),
    resolvedAtMs: r.resolved_at == null ? null : toMs(r.resolved_at),
    revertedAtMs: r.reverted_at == null ? null : toMs(r.reverted_at),
    resolvedBy: r.resolved_by,
  };
}

const SELECT_COLS = `id, workspace_id, category, finding_class, action, risk_tier, reversibility,
  revert_handle, decision, decision_id, status, trip_reason, armed_at, window_until, resolved_at, reverted_at, resolved_by`;

/**
 * Persist one armed tripwire. Returns its id, or null if the table isn't applied
 * yet (the subsystem is dark — a lost arming pre-migration is immaterial).
 * jsonb columns bound `${JSON.stringify(v)}::text::jsonb` (the client-agnostic
 * idiom — see policy-store / agent-insights/postgres-js-jsonb-binding).
 */
export async function insertTripwire(
  sql: Sql,
  workspaceId: string,
  arming: TripwireArming,
): Promise<string | null> {
  const id = genId();
  try {
    await sql`
      INSERT INTO harness_shared.autonomy_tripwires
        (id, workspace_id, category, finding_class, action, risk_tier, reversibility,
         revert_handle, decision, decision_id, status, armed_at, window_until)
      VALUES (${id}, ${workspaceId}, ${arming.category}, ${arming.findingClass},
              ${arming.action ?? null}, ${arming.riskTier}, 'reversible',
              ${JSON.stringify(arming.revertHandle)}::text::jsonb,
              ${JSON.stringify(arming.decision)}::text::jsonb,
              ${arming.decisionId ?? null},
              'armed', ${new Date(arming.armedAtMs)}, ${new Date(arming.windowUntilMs)})`;
    refreshAutonomyHealthPanel(workspaceId);
    return id;
  } catch (err) {
    if (isMissingTable(err)) {
      console.warn('[autonomy-tripwire] table not applied yet — arming dropped (subsystem dark)');
      return null;
    }
    throw err;
  }
}

/** Load every still-armed tripwire for the sweep (empty if the table is missing). */
export async function listArmedTripwires(sql: Sql, workspaceId: string): Promise<TripwireRow[]> {
  try {
    const rows = (await sql`
      SELECT ${sql.unsafe(SELECT_COLS)}
        FROM harness_shared.autonomy_tripwires
       WHERE workspace_id = ${workspaceId} AND status = 'armed'
       ORDER BY armed_at ASC`) as unknown as RawRow[];
    return rows.filter((r) => isAutonomyCategory(r.category)).map(rowFrom);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/** One tripwire by id (for the owner one-click revert). */
export async function getTripwire(
  sql: Sql,
  workspaceId: string,
  id: string,
): Promise<TripwireRow | null> {
  try {
    const rows = (await sql`
      SELECT ${sql.unsafe(SELECT_COLS)}
        FROM harness_shared.autonomy_tripwires
       WHERE workspace_id = ${workspaceId} AND id = ${id}
       LIMIT 1`) as unknown as RawRow[];
    return rows[0] ? rowFrom(rows[0]) : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/** Flip an armed row to cleared (a clean pass). CAS on status='armed'. */
export async function markTripwireCleared(
  sql: Sql,
  workspaceId: string,
  id: string,
  nowMs: number,
  resolvedBy = 'sweep',
): Promise<void> {
  await sql`
    UPDATE harness_shared.autonomy_tripwires
       SET status = 'cleared', resolved_at = ${new Date(nowMs)}, resolved_by = ${resolvedBy}
     WHERE workspace_id = ${workspaceId} AND id = ${id} AND status = 'armed'`;
  refreshAutonomyHealthPanel(workspaceId);
}

/** Flip an armed row to tripped (records which signal). CAS on status='armed'. */
export async function markTripwireTripped(
  sql: Sql,
  workspaceId: string,
  id: string,
  reason: TripwireSignalKind,
  nowMs: number,
  resolvedBy = 'sweep',
): Promise<void> {
  await sql`
    UPDATE harness_shared.autonomy_tripwires
       SET status = 'tripped', trip_reason = ${reason},
           resolved_at = ${new Date(nowMs)}, resolved_by = ${resolvedBy}
     WHERE workspace_id = ${workspaceId} AND id = ${id} AND status = 'armed'`;
  refreshAutonomyHealthPanel(workspaceId);
}

/** Flip a tripped row to reverted (the auto-revert executed). CAS on status='tripped'. */
export async function markTripwireReverted(
  sql: Sql,
  workspaceId: string,
  id: string,
  nowMs: number,
): Promise<void> {
  await sql`
    UPDATE harness_shared.autonomy_tripwires
       SET status = 'reverted', reverted_at = ${new Date(nowMs)}
     WHERE workspace_id = ${workspaceId} AND id = ${id} AND status = 'tripped'`;
  refreshAutonomyHealthPanel(workspaceId);
}

/**
 * Read tripwire rows resolved (or armed) within the lookback for graduation
 * evidence: a `cleared` row is one clean auto-pass, a `tripped`/`reverted` row
 * resets the streak, an `armed` (window-open) row is pending. Empty if missing.
 */
export async function readTripwireEvidence(
  sql: Sql,
  workspaceId: string,
  opts: { lookbackDays: number; nowMs: number },
): Promise<TripwireRow[]> {
  const sinceMs = opts.nowMs - opts.lookbackDays * 86_400_000;
  try {
    // Bind `sinceMs` as a NUMBER + convert in SQL, NOT `${new Date(sinceMs)}`: a Date
    // parameter combined with the `sql.unsafe(SELECT_COLS)` fragment in the same query
    // mis-binds under postgres-js (it routes the Date through the string serializer →
    // `Buffer.byteLength(Date)` throws ERR_INVALID_ARG_TYPE). This threw on EVERY call,
    // breaking both autonomy:graduation_status and the live autonomy-trust-scan routine's
    // graduation leg. A numeric param binds cleanly past the unsafe fragment.
    const rows = (await sql`
      SELECT ${sql.unsafe(SELECT_COLS)}
        FROM harness_shared.autonomy_tripwires
       WHERE workspace_id = ${workspaceId} AND armed_at >= to_timestamp(${sinceMs} / 1000.0)
       ORDER BY armed_at ASC`) as unknown as RawRow[];
    return rows.filter((r) => isAutonomyCategory(r.category)).map(rowFrom);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/**
 * Read successful auto-reverts in a wall-clock window. This is deliberately
 * keyed off `reverted_at`, not `armed_at`: the revert-loop damper cares when the
 * undo actually succeeded, and a long watch may have been armed before the
 * requested window began.
 */
export async function listRecentlyRevertedTripwires(
  sql: Sql,
  workspaceId: string,
  sinceMs: number,
): Promise<TripwireRow[]> {
  try {
    const rows = (await sql`
      SELECT ${sql.unsafe(SELECT_COLS)}
        FROM harness_shared.autonomy_tripwires
       WHERE workspace_id = ${workspaceId}
         AND status = 'reverted'
         AND reverted_at >= to_timestamp(${sinceMs} / 1000.0)
       ORDER BY reverted_at ASC, armed_at ASC`) as unknown as RawRow[];
    return rows.filter((r) => isAutonomyCategory(r.category)).map(rowFrom);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

export interface ListTripwiresOptions {
  /** Filter by status (omit for all). */
  status?: TripwireStatus;
  /** Filter by category (omit for all). */
  category?: AutonomyCategory;
  limit?: number;
}

/** Recent tripwires for the owner feed (P-031), newest first. Empty if missing. */
export async function listRecentTripwires(
  sql: Sql,
  workspaceId: string,
  opts: ListTripwiresOptions = {},
): Promise<TripwireRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  try {
    const rows = (await sql`
      SELECT ${sql.unsafe(SELECT_COLS)}
        FROM harness_shared.autonomy_tripwires
       WHERE workspace_id = ${workspaceId}
         ${opts.status ? sql`AND status = ${opts.status}` : sql``}
         ${opts.category ? sql`AND category = ${opts.category}` : sql``}
       ORDER BY armed_at DESC
       LIMIT ${limit}`) as unknown as RawRow[];
    return rows.filter((r) => isAutonomyCategory(r.category)).map(rowFrom);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}
