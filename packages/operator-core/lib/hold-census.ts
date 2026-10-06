/**
 * HOLD CENSUS — which non-terminal rows are held, by what, and which holds nobody clears.
 *
 * Plan unified-bug-pipeline-and-honest-queue-2026-10-05, P-001 / D-026 point (5).
 *
 * Runs `classifyHolds` (hold-registry.ts) over EVERY open, wip, blocked and needs-human row of a
 * workspace (optionally one harness), observation lane excluded. A hold whose registry entry is
 * `null` has no clearer: no lane, routine or owner is responsible for ending it. That is the
 * number AUTO-BAR-R-4-P-001 ("zero open items held with no clearer") is measured with, and the
 * breakdown P-002/P-004 read.
 *
 * WHOLE POPULATION, NOT A SAMPLE. The rows are read in keyset pages until the population is
 * exhausted, so every count (`scanned`, `held`, `byDomain`, `byKey`, `byClearerKind`,
 * `unmappedCount`, `unmappedByKey`) is a total. Only the `unmapped` row LIST is capped
 * (`sampleLimit`); `unmappedSampleTruncated` says when it was, so the list is never read as the
 * total.
 *
 * PAYLOADS ARE PROJECTED to `HOLD_PAYLOAD_KEYS` in SQL — a full payload per non-terminal row
 * would ship megabytes for five keys. hold-registry.test.ts pins that the projection classifies
 * identically to the whole payload.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  classifyHolds,
  HOLD_PAYLOAD_KEYS,
  type HoldClearerKind,
  type HoldDomain,
} from './hold-registry';

type Sql = ReturnType<typeof getOrgPg>['sql'];

export const HOLD_CENSUS_PAGE = 1000;
export const HOLD_CENSUS_SAMPLE_LIMIT = 50;

export interface HoldCensusUnmappedRow {
  id: string;
  harness: string;
  status: string;
  domain: HoldDomain;
  key: string;
}

export interface HoldCensus {
  workspaceId: string;
  harness: string | null;
  /** Non-terminal, non-observation rows examined — the whole population. */
  scanned: number;
  /** Rows with at least one hold. */
  held: number;
  /** Holds per domain (a row with two holds counts in both). */
  byDomain: Partial<Record<HoldDomain, number>>;
  /** Holds per `<domain>:<key>`. */
  byKey: Record<string, number>;
  /** Holds per clearer kind; `none` is a hold with no registry entry. */
  byClearerKind: Partial<Record<HoldClearerKind | 'none', number>>;
  /** Holds with no clearer — the AUTO-BAR-R-4-P-001 measurement. A total. */
  unmappedCount: number;
  /** Unmapped holds per `<domain>:<key>`. A total. */
  unmappedByKey: Record<string, number>;
  /** Up to `sampleLimit` of the unmapped holds. */
  unmapped: HoldCensusUnmappedRow[];
  unmappedSampleTruncated: boolean;
}

export interface HoldCensusOptions {
  harness?: string | null;
  sql?: Sql;
  pageSize?: number;
  sampleLimit?: number;
}

interface CensusRow {
  harness_slug: string;
  feature_id: string;
  status: string;
  lane: string | null;
  payload: Record<string, unknown> | null;
}

const CENSUS_SQL = `
    SELECT harness_slug, feature_id, status, lane,
           (SELECT jsonb_object_agg(e.key, e.value)
              FROM jsonb_each(CASE WHEN jsonb_typeof(payload) = 'object' THEN payload ELSE '{}'::jsonb END) e
             WHERE e.key = ANY ($3::text[])) AS payload
      FROM harness_shared.work_items
     WHERE workspace_id = $1
       AND ($2::text IS NULL OR harness_slug = $2)
       AND status IN ('open', 'wip', 'blocked', 'needs-human')
       AND lane IS DISTINCT FROM 'observation'
       AND payload->>'lane' IS DISTINCT FROM 'observation'
       AND (harness_slug, feature_id) > ($4::text, $5::text)
     ORDER BY harness_slug, feature_id
     LIMIT $6`;

function bump<K extends string>(counts: Partial<Record<K, number>>, key: K): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export async function holdCensus(workspaceId: string, opts: HoldCensusOptions = {}): Promise<HoldCensus> {
  const sql = opts.sql ?? getOrgPg().sql;
  const harness = opts.harness ?? null;
  const pageSize = Math.max(1, opts.pageSize ?? HOLD_CENSUS_PAGE);
  const sampleLimit = Math.max(0, opts.sampleLimit ?? HOLD_CENSUS_SAMPLE_LIMIT);
  const census: HoldCensus = {
    workspaceId,
    harness,
    scanned: 0,
    held: 0,
    byDomain: {},
    byKey: {},
    byClearerKind: {},
    unmappedCount: 0,
    unmappedByKey: {},
    unmapped: [],
    unmappedSampleTruncated: false,
  };

  let after: [string, string] = ['', ''];
  for (;;) {
    const rows = await sql.unsafe<CensusRow[]>(CENSUS_SQL, [
      workspaceId,
      harness,
      [...HOLD_PAYLOAD_KEYS],
      after[0],
      after[1],
      pageSize,
    ]);
    for (const row of rows) {
      census.scanned += 1;
      const holds = classifyHolds({ status: row.status, lane: row.lane, payload: row.payload ?? {} });
      if (holds.length > 0) census.held += 1;
      for (const hold of holds) {
        const label = `${hold.domain}:${hold.key}`;
        bump(census.byDomain, hold.domain);
        bump(census.byKey, label);
        bump(census.byClearerKind, hold.entry ? hold.entry.clearer.kind : 'none');
        if (hold.entry) continue;
        census.unmappedCount += 1;
        bump(census.unmappedByKey, label);
        if (census.unmapped.length < sampleLimit) {
          census.unmapped.push({
            id: row.feature_id,
            harness: row.harness_slug,
            status: row.status,
            domain: hold.domain,
            key: hold.key,
          });
        } else {
          census.unmappedSampleTruncated = true;
        }
      }
    }
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    after = [last.harness_slug, last.feature_id];
  }
  return census;
}

/** One line per finding, for a routine note or a tool summary. */
export function renderHoldCensus(census: HoldCensus): string {
  const top = Object.entries(census.unmappedByKey)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, n]) => `${key}=${n}`)
    .join(', ');
  return (
    `hold census ${census.harness ?? census.workspaceId}: scanned=${census.scanned} held=${census.held} ` +
    `no-clearer=${census.unmappedCount}${top ? ` (${top})` : ''}`
  );
}
