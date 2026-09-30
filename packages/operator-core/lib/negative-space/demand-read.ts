/**
 * demand-read.ts — the read behind the Learning tab's demand panel
 * (self-learning-frontier-2026-06-12 P-010 / FB-04; `learning.demand` resolver).
 *
 * Snapshot of harness_shared.negative_space_demand for one workspace:
 * hottest entries first plus the rollups the panel's header needs. Pure
 * projection over fetched rows (snapshot shape unit-tested without PG);
 * readDemandSnapshot is the thin SQL leg the resolver wires.
 */

import type { Sql } from 'postgres';
import type { DemandSurface } from './miner-core';

export interface DemandPanelEntry {
  surface: DemandSurface;
  queryNorm: string;
  exampleQuery: string;
  missCount: number;
  distinctAgents: number;
  lastMissedAt: string;
  /** Set once the miner filed a kind=change candidate for this entry. */
  candidateImprovementId: string | null;
}

export interface DemandSnapshot {
  entries: DemandPanelEntry[];
  /** Distinct missing-knowledge queries on the map (not just the page returned). */
  totalEntries: number;
  /** Sum of zero-hit invocations across the map. */
  totalMisses: number;
  /** Entries with a filed candidate. */
  filedCount: number;
  /** Newest map write — when the miner last ran (null = never mined). */
  minedAt: string | null;
}

export interface DemandRow {
  surface: string;
  query_norm: string;
  example_query: string;
  miss_count: number;
  distinct_agents: number;
  last_missed_at: string | Date;
  candidate_improvement_id: string | null;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v));

/** Pure: full row set → panel snapshot (top `limit` hottest entries). */
export function demandSnapshotFromRows(rows: DemandRow[], limit = 50): DemandSnapshot {
  const sorted = [...rows].sort(
    (a, b) => b.miss_count - a.miss_count || b.distinct_agents - a.distinct_agents,
  );
  let minedAt: string | null = null;
  for (const r of rows) {
    const u = iso(r.updated_at);
    if (minedAt === null || u > minedAt) minedAt = u;
  }
  return {
    entries: sorted.slice(0, limit).map((r) => ({
      surface: r.surface as DemandSurface,
      queryNorm: r.query_norm,
      exampleQuery: r.example_query,
      missCount: r.miss_count,
      distinctAgents: r.distinct_agents,
      lastMissedAt: iso(r.last_missed_at),
      candidateImprovementId: r.candidate_improvement_id,
    })),
    totalEntries: rows.length,
    totalMisses: rows.reduce((n, r) => n + r.miss_count, 0),
    filedCount: rows.filter((r) => r.candidate_improvement_id != null).length,
    minedAt,
  };
}

export async function readDemandSnapshot(sql: Sql, workspaceId: string, limit = 50): Promise<DemandSnapshot> {
  const rows = await sql<DemandRow[]>`
    SELECT surface, query_norm, example_query, miss_count, distinct_agents,
           last_missed_at, candidate_improvement_id, updated_at
      FROM harness_shared.negative_space_demand
     WHERE workspace_id = ${workspaceId}`;
  return demandSnapshotFromRows(rows, limit);
}

export const EMPTY_DEMAND_SNAPSHOT: DemandSnapshot = {
  entries: [],
  totalEntries: 0,
  totalMisses: 0,
  filedCount: 0,
  minedAt: null,
};
