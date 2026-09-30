/**
 * foreign-frontier.ts — occupied/empty niche frontier helpers for federated Scout/gym.
 *
 * Reads the LOCAL archive plus FOREIGN elite partitions, computes the EMPTY niche
 * frontier over the shared gym-QD niche vocabulary, and partitions that frontier by
 * rendezvous hashing so hives can explore disjoint empty regions instead of piling
 * into the same niche.
 */

import type { Sql } from 'postgres';
import {
  DOMAIN_VOCAB,
  RISK_BANDS,
  SCOPE_BANDS,
  nicheKey,
  type RiskBand,
  type ScopeBand,
  type ArchiveSource,
  type BehaviorDescriptor,
} from '../gym/qd/niche';
import { rendezvousWeight } from '../authority/rendezvous-authority';

export interface FrontierScope {
  workspaceId: string;
  harnessSlug: string;
}

export interface FrontierEliteView {
  nicheKey: string;
  coords: { scope: ScopeBand; domain: string; risk: RiskBand };
  candidateId: string;
  fitness: number;
  descriptor: BehaviorDescriptor;
  rationale: string | null;
  source: ArchiveSource;
  sourceHive: string | null;
}

type FrontierRow = {
  niche_key: string;
  scope: string;
  domain: string;
  risk: string;
  candidate_id: string;
  fitness: number;
  descriptor: BehaviorDescriptor | string;
  rationale: string | null;
  source: string;
  source_hive: string | null;
};

function parseDescriptor(value: BehaviorDescriptor | string): BehaviorDescriptor {
  return typeof value === 'string' ? (JSON.parse(value) as BehaviorDescriptor) : value;
}

function byFitnessThenIdentity(a: FrontierEliteView, b: FrontierEliteView): number {
  return (
    b.fitness - a.fitness ||
    a.nicheKey.localeCompare(b.nicheKey) ||
    (a.sourceHive ?? '').localeCompare(b.sourceHive ?? '') ||
    a.candidateId.localeCompare(b.candidateId)
  );
}

export async function listFrontierElites(sql: Sql, scope: FrontierScope): Promise<FrontierEliteView[]> {
  const rows = (await sql<FrontierRow[]>`
    SELECT
      niche_key,
      scope,
      domain,
      risk,
      candidate_id,
      fitness,
      descriptor,
      rationale,
      source,
      NULL::text AS source_hive
    FROM harness_shared.gym_qd_archive
    WHERE workspace_id = ${scope.workspaceId}
      AND harness_slug = ${scope.harnessSlug}

    UNION ALL

    SELECT
      niche_key,
      scope,
      domain,
      risk,
      candidate_id,
      fitness,
      descriptor,
      rationale,
      'gym'::text AS source,
      source_hive
    FROM harness_shared.gym_qd_foreign_elites
    WHERE workspace_id = ${scope.workspaceId}
      AND harness_slug = ${scope.harnessSlug}
  `) as FrontierRow[];

  return rows
    .map((row) => ({
      nicheKey: row.niche_key,
      coords: {
        scope: row.scope as ScopeBand,
        domain: row.domain,
        risk: row.risk as RiskBand,
      },
      candidateId: row.candidate_id,
      fitness: Number(row.fitness),
      descriptor: parseDescriptor(row.descriptor),
      rationale: row.rationale,
      source: row.source as ArchiveSource,
      sourceHive: row.source_hive,
    }))
    .sort(byFitnessThenIdentity);
}

export function allGymNicheKeys(domains: readonly string[] = DOMAIN_VOCAB): string[] {
  const out: string[] = [];
  for (const scope of SCOPE_BANDS) {
    for (const domain of domains) {
      for (const risk of RISK_BANDS) out.push(nicheKey({ scope, domain, risk }));
    }
  }
  return out;
}

export function computeEmptyNicheKeys(
  occupiedNicheKeys: readonly string[],
  domains: readonly string[] = DOMAIN_VOCAB,
): string[] {
  const occupied = new Set(occupiedNicheKeys);
  return allGymNicheKeys(domains).filter((key) => !occupied.has(key));
}

export function partitionNicheKeyByHive(niche: string, hiveIds: readonly string[]): string | null {
  if (hiveIds.length === 0) return null;
  const uniq = [...new Set(hiveIds)].sort();
  let winner = uniq[0]!;
  let best = rendezvousWeight(niche, winner);
  for (let i = 1; i < uniq.length; i++) {
    const candidate = uniq[i]!;
    const weight = rendezvousWeight(niche, candidate);
    if (weight > best || (weight === best && candidate < winner)) {
      winner = candidate;
      best = weight;
    }
  }
  return winner;
}

export function partitionEmptyNichesForHive(
  emptyNicheKeys: readonly string[],
  hiveIds: readonly string[],
  potId: string,
): string[] {
  return [...emptyNicheKeys]
    .filter((niche) => partitionNicheKeyByHive(niche, hiveIds) === potId)
    .sort();
}

/**
 * Pure core of the empty-frontier pipeline: from the merged frontier elites
 * (local ∪ foreign), subtract occupied niches from the vocabulary, then return
 * THIS hive's HRW-assigned DISJOINT slice of the empty frontier. Every hive in
 * `hiveIds` running this over the SAME frontier gets a non-overlapping partition
 * whose union is the whole empty set — so peers explore disjoint empty regions
 * instead of piling into the same niche. Include `potId` in `hiveIds`.
 */
export function hiveEmptyFrontierFromElites(
  frontierElites: readonly { nicheKey: string }[],
  hiveIds: readonly string[],
  potId: string,
  domains: readonly string[] = DOMAIN_VOCAB,
): string[] {
  const empty = computeEmptyNicheKeys(
    frontierElites.map((e) => e.nicheKey),
    domains,
  );
  return partitionEmptyNichesForHive(empty, hiveIds, potId);
}

/**
 * The full empty-frontier pipeline for ONE hive (the seam P-006's map lane calls):
 * read the merged frontier (gym_qd_archive ∪ gym_qd_foreign_elites), then return
 * this hive's disjoint HRW slice of the empty niches. Reads the DB; a read error
 * propagates (the caller decides fail-soft).
 */
export async function computeHiveEmptyFrontier(
  sql: Sql,
  scope: FrontierScope,
  hiveIds: readonly string[],
  potId: string,
  domains: readonly string[] = DOMAIN_VOCAB,
): Promise<string[]> {
  const frontier = await listFrontierElites(sql, scope);
  return hiveEmptyFrontierFromElites(frontier, hiveIds, potId, domains);
}
