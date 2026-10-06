/** Common receipts live on the existing producer rows, atomically with their writes. */
import type { Sql } from 'postgres';
import type { LearningContract } from './types';
import {
  adaptScoutOutput, adaptGymOutput, adaptCalibrationOutput, adaptTransferOutput,
  adaptRegretOutput, adaptRedQueenOutput, type LearningProducer, type ProducerLifecycleObservation,
} from './lifecycle-adapter';

const stores = {
  scout: { table: 'scout_routed_ideas', key: 'idea_id', keyType: 'text', adapt: adaptScoutOutput },
  gym: { table: 'gym_proposals', key: 'id', keyType: 'text', adapt: adaptGymOutput },
  calibration: { table: 'calibration_predictions', key: 'id', keyType: 'bigint', adapt: adaptCalibrationOutput },
  transfer: { table: 'transfer_lessons', key: 'id', keyType: 'uuid', adapt: adaptTransferOutput },
  regret: { table: 'regret_findings', key: 'run_id', keyType: 'text', adapt: adaptRegretOutput },
  'red-queen': { table: 'red_queen_drills', key: 'id', keyType: 'uuid', adapt: adaptRedQueenOutput },
} as const;

export interface ProducerWriteScope {
  producer: LearningProducer;
  workspaceId: string;
  /** Null when an insert no-ops and returned no id. */
  sourceId?: string | null;
  /** Reconciliation/expiry stays batched instead of adding serial per-row queries. */
  sourceIds?: readonly string[];
  /** Single-output evaluation captured by the producer that executed it. */
  evaluation?: unknown;
  contract?: LearningContract;
}

/**
 * Snapshot only committed producer data. The WHERE keys and adapter are a fixed
 * allowlist, and the row lock serializes concurrent updates of the same output.
 * Domain acceptance remains in source; it is never relabelled contract acceptance.
 */
export async function recordProducerObservation(sql: Sql, scope: ProducerWriteScope): Promise<void> {
  // Capture before SELECT yields: producer-owned evidence may be reused or
  // changed while the database read is in flight.
  scope = structuredClone(scope);
  const ids = [...new Set(scope.sourceIds ?? (scope.sourceId == null ? [] : [scope.sourceId]))];
  if (!ids.length) return;
  if (scope.evaluation !== undefined && ids.length !== 1) throw new Error('producer evaluation requires one source identity');
  if (scope.contract !== undefined && ids.length !== 1) throw new Error('producer decision requires one source identity');
  const store = stores[scope.producer];
  const rows = await sql.unsafe(
    `SELECT * FROM harness_shared.${store.table}
      WHERE workspace_id = $1 AND ${store.key} = ANY($2::${store.keyType}[]) ORDER BY ${store.key} FOR UPDATE`,
    [scope.workspaceId, ids],
  );
  if (rows.length !== ids.length) throw new Error(`producer lifecycle source missing: ${scope.producer}`);
  // Agent-review enrollment and REM/SU routes share Scout's store, but are not Scout output.
  const sources = rows.filter((row) => scope.producer !== 'scout' || row.origin === 'scout');
  if (!sources.length) return;
  const recordedAt = new Date().toISOString();
  const receipts = sources.map((source) => store.adapt({
    stage: 'observation', workspaceId: scope.workspaceId,
    sourceRef: `${scope.producer}:${String(source[store.key])}`, source, recordedAt,
    ...(scope.evaluation === undefined ? {} : { evaluation: scope.evaluation }),
    ...(scope.contract === undefined ? {} : { contract: scope.contract }),
  }));
  await sql.unsafe(
    `UPDATE harness_shared.${store.table} AS source SET learning_lifecycle = receipt.payload::jsonb
      FROM unnest($2::${store.keyType}[], $3::text[]) AS receipt(id, payload)
      WHERE source.workspace_id = $1 AND source.${store.key} = receipt.id`,
    [scope.workspaceId, sources.map((source) => String(source[store.key])), receipts.map((receipt) => JSON.stringify(receipt))],
  );
}

/** Root clients open a transaction; route/outer-transaction clients reuse theirs. */
export async function withProducerLifecycleWrite<T>(sql: Sql, write: (tx: Sql) => Promise<T>): Promise<T> {
  return typeof sql.begin === 'function'
    ? sql.begin((tx) => write(tx as unknown as Sql)) as Promise<T>
    : write(sql);
}

/** Bounded workspace-local read of the same persisted common envelope. */
export async function readProducerObservations(
  sql: Sql,
  query: { producer: LearningProducer; workspaceId: string; limit?: number },
): Promise<ProducerLifecycleObservation[]> {
  const store = stores[query.producer];
  const rows = await sql.unsafe(
    `SELECT * FROM harness_shared.${store.table}
      WHERE workspace_id = $1 AND learning_lifecycle IS NOT NULL
      ORDER BY learning_lifecycle->>'recordedAt' DESC, ${store.key} LIMIT $2`,
    [query.workspaceId, Math.min(Math.max(query.limit ?? 20, 1), 200)],
  );
  return rows.map((row) => {
    const receipt = (typeof row.learning_lifecycle === 'string'
      ? JSON.parse(row.learning_lifecycle) : row.learning_lifecycle) as ProducerLifecycleObservation;
    const current = store.adapt({
      stage: 'observation', workspaceId: query.workspaceId, sourceRef: receipt.sourceRef,
      recordedAt: receipt.recordedAt, source: row,
    });
    const sourceCurrent = current.sourceHash === receipt.sourceHash;
    return { ...receipt, sourceCurrent, promotionAllowed: receipt.promotionAllowed && sourceCurrent,
      ...(receipt.evaluation === undefined ? {} : { evaluationCurrent: receipt.evaluationSourceHash === current.sourceHash }) };
  });
}
