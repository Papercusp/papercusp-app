/**
 * fleet/saga — sagas + tombstones for compensable destructive ops (papercusp binding).
 *
 * The mechanism (forward execute → reverse compensate, soft-delete tombstones + deferred
 * GC) lives in @papercusp/structured-concurrency. This module binds it to the PG journal
 * (harness_shared.fleet_sagas) + tombstone store (harness_shared.fleet_tombstones) and
 * keeps the historical `<fn>(sql, …)` entry points.
 */
import { createTombstones, runSaga as runSagaCore } from '@papercusp/structured-concurrency';
import type { SagaResult, SagaStep, TombstoneRef } from '@papercusp/structured-concurrency';
import { pgSagaJournal, pgTombstoneStore, type Db } from './pg-stores';

export type { SagaStep, SagaStepLog, SagaResult, TombstoneRef } from '@papercusp/structured-concurrency';

export async function runSaga(sql: Db, opts: { workspaceId: string; name: string; steps: SagaStep[] }): Promise<SagaResult> {
  return runSagaCore(pgSagaJournal(sql), opts);
}

export async function softDelete(
  sql: Db,
  opts: TombstoneRef & { reason?: string; deletedBy?: string; graceSec?: number; now?: number },
): Promise<void> {
  return createTombstones(pgTombstoneStore(sql)).softDelete(opts);
}

export async function restoreTombstone(sql: Db, ref: TombstoneRef): Promise<boolean> {
  return createTombstones(pgTombstoneStore(sql)).restoreTombstone(ref);
}

export async function isTombstoned(sql: Db, ref: TombstoneRef): Promise<boolean> {
  return createTombstones(pgTombstoneStore(sql)).isTombstoned(ref);
}

export async function physicalGc(sql: Db, opts: { workspaceId: string; refKind?: string; now?: number }): Promise<string[]> {
  return createTombstones(pgTombstoneStore(sql)).physicalGc(opts);
}
