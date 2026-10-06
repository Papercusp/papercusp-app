/**
 * corpus-sweep-io — the live wiring for {@link sweepCorpus}.
 *
 * All PG/LLM contact lives here so `corpus-sweep.ts` stays pure and its tests
 * need neither (the split `corpus-recall` / `corpus-recall-io` already uses in
 * this directory).
 *
 * THE ONE PREDICATE THAT MATTERS: every read here carries
 * `NOT (payload ? 'entityType')`. `harness_shared.memory_canonical` holds TWO
 * populations — ~4,100 real memories and ~29,400 mem0 GRAPH ENTITY NODES —
 * and the entity nodes look exactly like short memory fragments (plan D-013).
 * A sweep that omits this predicate does not merely over-report by ~8x: in
 * apply mode it would close the validity window of the entity index recall
 * links through. The predicate is repeated on every statement rather than
 * factored into a comment, because the failure is silent.
 */
import { sweepPoolConflicts } from '../knowledge-packs/manage';
import { getMemoryBackend } from './backend';
import type { CorpusConflictPair, CorpusRow, CorpusSweepDeps } from './corpus-sweep';

/** Rows a sweep may see: a real memory, not archived, not an entity node. */
const REAL_MEMORY_PREDICATE = `NOT (payload ? 'entityType') AND state <> 'archived'`;

interface PgLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
}

async function connect(): Promise<PgLike | null> {
  const { pgClientFields } = await import('./mem0-connection');
  const fields = await pgClientFields();
  if (!fields) return null;
  const { Client } = await import('pg');
  const client = new Client(fields);
  await client.connect();
  return client as unknown as PgLike;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) return value;
  return null;
}

function toCorpusRow(r: Record<string, unknown>): CorpusRow {
  return {
    id: String(r.id),
    pool: String(r.pool ?? ''),
    text: typeof r.text === 'string' ? r.text : '',
    createdAt: isoOrNull(r.created_at) ?? new Date(0).toISOString(),
    lastSurfacedAt: isoOrNull(r.last_surfaced_at),
    origin: typeof r.origin === 'string' ? r.origin : 'local',
    shareable: typeof r.shareable === 'boolean' ? r.shareable : null,
    sourceHive: typeof r.source_hive === 'string' && r.source_hive ? r.source_hive : null,
    invalidAt: isoOrNull(r.invalid_at),
  };
}

/**
 * Build the live deps. Returns null when the store is unreachable — the caller
 * reports that rather than pretending an empty corpus is a clean one.
 */
export async function liveCorpusSweepDeps(
  fileConflict?: CorpusSweepDeps['fileConflict'],
): Promise<{ deps: CorpusSweepDeps; close: () => Promise<void> } | null> {
  const client = await connect();
  if (!client) return null;

  // Probed ONCE here (the factory is already async, so the sweep's own
  // predicate can stay synchronous). Fails OPEN: a probe that cannot answer
  // must never be the reason the contradiction layer is silently skipped.
  let judgeWired = true;
  try {
    const { conflictJudgeAvailable } = await import('./anthropic-judge');
    judgeWired = conflictJudgeAvailable();
  } catch {
    judgeWired = true;
  }

  // Content-free layer (P-011): the substance judge is Jev, so it is wired only
  // when a Jev key resolves. Unwired ⇒ the sweep reports the layer NOT MEASURED.
  let judgeSubstance: CorpusSweepDeps['judgeSubstance'];
  try {
    const { ensureJevDecisionClient, readJevApiKey } = await import('./jev-settings');
    if (await readJevApiKey()) {
      const { judgeSubstanceWithJev } = await import('./jev-conflict-judge');
      judgeSubstance = (text: string) => judgeSubstanceWithJev(text, { client: ensureJevDecisionClient });
    }
  } catch {
    judgeSubstance = undefined;
  }

  const deps: CorpusSweepDeps = {
    listPools: async () => {
      const { rows } = await client.query(
        `SELECT DISTINCT payload->>'user_id' AS pool
           FROM harness_shared.memory_canonical
          WHERE ${REAL_MEMORY_PREDICATE}
            AND payload->>'user_id' IS NOT NULL
          ORDER BY 1`,
      );
      return rows.map((r) => String(r.pool)).filter(Boolean);
    },

    listRows: async (pool: string) => {
      const { rows } = await client.query(
        `SELECT id,
                payload->>'user_id' AS pool,
                payload->>'data'    AS text,
                created_at, last_surfaced_at, origin, shareable, source_hive, invalid_at
           FROM harness_shared.memory_canonical
          WHERE ${REAL_MEMORY_PREDICATE}
            AND payload->>'user_id' = $1`,
        [pool],
      );
      return rows.map(toCorpusRow);
    },

    // Soft: close the validity window via the SAME backend primitive
    // `memory:forget { soft:true }` uses. Never a hard delete — a hygiene
    // sweep must stay reversible (`include_superseded` / `as_of` still find
    // the row), and the sweep's own safety rules already spare anything
    // federated, so this UPDATE cannot emit an outbox op.
    softForget: async (id: string) => {
      const backend = getMemoryBackend();
      const invalidate = backend.invalidateEntry?.bind(backend);
      if (!invalidate) return false;
      return (await invalidate(id)) === true;
    },

    sweepConflicts: async (pool: string): Promise<CorpusConflictPair[]> => {
      const result = await sweepPoolConflicts({ scope: pool });
      return result.pairs;
    },

    // Measured 2026-08-03: run from a CLI, no ANTHROPIC key resolves, so the
    // judge classified 1,583 rows "clean" in a process that never called it —
    // reported as `conflictPairs: 0`, indistinguishable from a real result.
    // The sweep skips the layer outright when this is false.
    judgeAvailable: () => judgeWired,

    ...(judgeSubstance ? { judgeSubstance } : {}),
    substanceAvailable: () => judgeSubstance !== undefined,

    ...(fileConflict ? { fileConflict } : {}),
  };

  return { deps, close: () => client.end() };
}
