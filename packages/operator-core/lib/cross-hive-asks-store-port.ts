/**
 * cross-hive-asks-store-port — the narrow C-1 ledger STORE port the front-door
 * tools depend on (hive-network-surface-2026-06-11 P-003, brief B-04), plus the
 * production adapter over brief B-02's `PgCrossHiveAsks`.
 *
 * The send composition + `pot:asks` take the store as an injected port so they
 * unit-test without PG (a fake store) and bind to the live PG store
 * (`pgCrossHiveAsksStore`) in production. The port re-uses B-02's row / input /
 * filter types verbatim — no parallel shapes to drift.
 */
import type { Sql } from 'postgres';
import {
  PgCrossHiveAsks,
  type CrossHiveAsk,
  type InsertCrossHiveAskInput,
  type ListCrossHiveAsksFilter,
} from './cross-hive-asks-pg';

export type { CrossHiveAsk, InsertCrossHiveAskInput, ListCrossHiveAsksFilter } from './cross-hive-asks-pg';

/** The subset of the C-1 ledger the front-door tools use. */
export interface CrossHiveAsksStore {
  /** Record a fresh request in state `queued` (idempotent on correlation_id). */
  insertQueued(
    workspaceId: string,
    potSlug: string,
    input: InsertCrossHiveAskInput,
    sql?: Sql,
  ): Promise<CrossHiveAsk>;
  /** queued → sent once the wire send delivered (keyed by correlation_id; idempotent). */
  markSentByCorrelationId(
    workspaceId: string,
    potSlug: string,
    correlationId: string,
    sql?: Sql,
  ): Promise<void>;
  /** List rows (most-recent-first) for `pot:asks`. */
  list(
    workspaceId: string,
    potSlug: string,
    filter: ListCrossHiveAsksFilter,
    sql?: Sql,
  ): Promise<CrossHiveAsk[]>;
}

/** The live PG store (B-02's `PgCrossHiveAsks`), per-(workspace, hive) per call. */
export const pgCrossHiveAsksStore: CrossHiveAsksStore = {
  insertQueued: (ws, slug, input, sql) => new PgCrossHiveAsks(ws, slug, sql).insert(input),
  async markSentByCorrelationId(ws, slug, correlationId, sql) {
    await new PgCrossHiveAsks(ws, slug, sql).markSentByCorrelationId(correlationId);
  },
  list: (ws, slug, filter, sql) => new PgCrossHiveAsks(ws, slug, sql).list(filter),
};
