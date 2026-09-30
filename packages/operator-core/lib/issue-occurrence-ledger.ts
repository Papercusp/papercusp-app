/**
 * Shared canonical-issue occurrence seam (P-004).
 *
 * Both issue creation doors use this module after their existing candidate
 * generators run.  The canonical object is still a work-item; this module only
 * chooses the canonical candidate and appends the incoming report/evidence.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { AdmissionIdentity } from './harness/improvements/digest';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

export type IssueOccurrenceKind =
  | 'canonical-created'
  | 'duplicate'
  | 'coalesced'
  | 'promoted'
  | 'regression';

export interface CanonicalCandidate {
  id: string;
  title: string;
  canonicalHarness?: string | null;
  /** False for an advisory-only candidate (for example a soft semantic hit). */
  eligible: boolean;
  similarity?: number;
}

/**
 * One deterministic selector shared by every admission door.  Exact stable
 * identity outranks fuzzy score; fuzzy ties are stable by id.
 */
export function selectCanonicalIssue(
  identity: AdmissionIdentity,
  candidates: readonly CanonicalCandidate[],
): CanonicalCandidate | null {
  const eligible = candidates.filter((candidate) => candidate.eligible);
  const exact = eligible
    .filter((candidate) => {
      const normalized = candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return identity.titleKey === `title:${normalized}`;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (exact.length > 0) return exact[0] ?? null;
  return eligible
    .slice()
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || a.id.localeCompare(b.id))[0] ?? null;
}

/**
 * P-005 queue-admission circuit defaults. A short fixed window makes a burst a
 * rate observation rather than a statement about the lifetime backlog. Both
 * canonical-cluster AND emitter diversity must collapse before admission is
 * tightened, which preserves genuinely independent corroboration.
 */
export const ISSUE_ADMISSION_WINDOW_SECONDS = 5 * 60;
export const ISSUE_ADMISSION_MIN_OCCURRENCES = 12;
export const ISSUE_ADMISSION_MAX_NORMALIZED_ENTROPY = 0.45;
export const ISSUE_ADMISSION_MIN_DOMINANT_SHARE = 0.60;

export interface IssueAdmissionDistribution {
  rawOccurrences: number;
  duplicateOccurrences: number;
  canonicalStock: number;
  canonicalClusterCounts: readonly number[];
  emitterCounts: readonly number[];
}

export interface IssueAdmissionPressure {
  active: boolean;
  mode: 'pass' | 'coalesce';
  windowSeconds: number;
  rawOccurrences: number;
  duplicateOccurrences: number;
  canonicalClusters: number;
  canonicalStock: number;
  emitters: number;
  canonicalNormalizedEntropy: number;
  emitterNormalizedEntropy: number;
  canonicalDominantShare: number;
  emitterDominantShare: number;
  thresholds: {
    minOccurrences: number;
    maxNormalizedEntropy: number;
    minDominantShare: number;
  };
  units: {
    rawOccurrences: 'append-only report rows in the rolling window';
    duplicateOccurrences: 'rolling-window report rows not creating a canonical item';
    canonicalClusters: 'distinct canonical clusters seen in the rolling window';
    canonicalStock: 'current non-terminal issue-family work-item rows';
    emitters: 'distinct source-tool plus reporter identities in the rolling window';
    entropy: 'normalized Shannon entropy from 0 (one bucket) to 1 (uniform buckets)';
  };
  writers: {
    flow: 'harness_shared.work_item_occurrences';
    stock: 'harness_shared.work_items';
  };
  cap: 'none — exact SQL aggregates';
}

function finiteCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Normalized Shannon entropy over already-aggregated bucket counts. */
export function normalizedAdmissionEntropy(counts: readonly number[]): number {
  const clean = counts.map(finiteCount).filter((count) => count > 0);
  const total = clean.reduce((sum, count) => sum + count, 0);
  if (clean.length <= 1 || total <= 0) return 0;
  const entropy = clean.reduce((sum, count) => {
    const p = count / total;
    return sum - p * Math.log(p);
  }, 0);
  return entropy / Math.log(clean.length);
}

function dominantShare(counts: readonly number[]): number {
  const clean = counts.map(finiteCount).filter((count) => count > 0);
  const total = clean.reduce((sum, count) => sum + count, 0);
  return total > 0 ? Math.max(...clean) / total : 0;
}

/**
 * Pure pressure classifier used by the live SQL reader and replay tests. The
 * raw-occurrence writer remains authoritative; distributions only determine
 * whether those rows are concentrated enough to tighten admission.
 */
export function assessIssueAdmissionPressure(
  distribution: IssueAdmissionDistribution,
): IssueAdmissionPressure {
  const canonicalNormalizedEntropy = normalizedAdmissionEntropy(distribution.canonicalClusterCounts);
  const emitterNormalizedEntropy = normalizedAdmissionEntropy(distribution.emitterCounts);
  const canonicalDominantShare = dominantShare(distribution.canonicalClusterCounts);
  const emitterDominantShare = dominantShare(distribution.emitterCounts);
  const rawOccurrences = Math.max(0, Math.trunc(distribution.rawOccurrences));
  const active =
    rawOccurrences >= ISSUE_ADMISSION_MIN_OCCURRENCES &&
    canonicalNormalizedEntropy <= ISSUE_ADMISSION_MAX_NORMALIZED_ENTROPY &&
    emitterNormalizedEntropy <= ISSUE_ADMISSION_MAX_NORMALIZED_ENTROPY &&
    canonicalDominantShare >= ISSUE_ADMISSION_MIN_DOMINANT_SHARE &&
    emitterDominantShare >= ISSUE_ADMISSION_MIN_DOMINANT_SHARE;
  return {
    active,
    mode: active ? 'coalesce' : 'pass',
    windowSeconds: ISSUE_ADMISSION_WINDOW_SECONDS,
    rawOccurrences,
    duplicateOccurrences: Math.max(0, Math.trunc(distribution.duplicateOccurrences)),
    canonicalClusters: distribution.canonicalClusterCounts.filter((count) => finiteCount(count) > 0).length,
    canonicalStock: Math.max(0, Math.trunc(distribution.canonicalStock)),
    emitters: distribution.emitterCounts.filter((count) => finiteCount(count) > 0).length,
    canonicalNormalizedEntropy,
    emitterNormalizedEntropy,
    canonicalDominantShare,
    emitterDominantShare,
    thresholds: {
      minOccurrences: ISSUE_ADMISSION_MIN_OCCURRENCES,
      maxNormalizedEntropy: ISSUE_ADMISSION_MAX_NORMALIZED_ENTROPY,
      minDominantShare: ISSUE_ADMISSION_MIN_DOMINANT_SHARE,
    },
    units: {
      rawOccurrences: 'append-only report rows in the rolling window',
      duplicateOccurrences: 'rolling-window report rows not creating a canonical item',
      canonicalClusters: 'distinct canonical clusters seen in the rolling window',
      canonicalStock: 'current non-terminal issue-family work-item rows',
      emitters: 'distinct source-tool plus reporter identities in the rolling window',
      entropy: 'normalized Shannon entropy from 0 (one bucket) to 1 (uniform buckets)',
    },
    writers: {
      flow: 'harness_shared.work_item_occurrences',
      stock: 'harness_shared.work_items',
    },
    cap: 'none — exact SQL aggregates',
  };
}

export interface IssueAdmissionCircuitDecision {
  action: 'pass' | 'coalesce';
  reason: 'normal' | 'forced' | 'critical-novelty' | 'no-canonical-candidate' | 'low-diversity-burst';
  canonical: CanonicalCandidate | null;
  pressure: IssueAdmissionPressure | null;
}

/**
 * Tighten only when the pressure writer says the burst is concentrated AND an
 * existing advisory candidate gives the report a lossless home. No candidate
 * is novel by construction; critical novelty and explicit force always pass.
 */
export function decideIssueAdmissionCircuit(args: {
  identity: AdmissionIdentity;
  candidates: readonly CanonicalCandidate[];
  pressure: IssueAdmissionPressure | null;
  severity?: string | null;
  force?: boolean;
}): IssueAdmissionCircuitDecision {
  if (args.force) return { action: 'pass', reason: 'forced', canonical: null, pressure: args.pressure };
  if (args.severity === 'critical') {
    return { action: 'pass', reason: 'critical-novelty', canonical: null, pressure: args.pressure };
  }
  if (!args.pressure?.active) {
    return { action: 'pass', reason: 'normal', canonical: null, pressure: args.pressure };
  }
  const canonical = selectCanonicalIssue(args.identity, args.candidates);
  return canonical
    ? { action: 'coalesce', reason: 'low-diversity-burst', canonical, pressure: args.pressure }
    : { action: 'pass', reason: 'no-canonical-candidate', canonical: null, pressure: args.pressure };
}

/**
 * Read one exact, uncapped aggregate for the candidate's workspace/harness.
 * The candidate itself resolves scope, avoiding ambient-workspace guesses in a
 * deep admission call chain. Returns null when the canonical row or ledger is
 * unavailable; admission then fails open.
 */
export async function readIssueAdmissionPressure(
  args: { canonicalId: string; canonicalHarness?: string | null; now?: Date },
  sqlOverride?: OrgSql,
): Promise<IssueAdmissionPressure | null> {
  if (process.env.VITEST && !sqlOverride) return null;
  const sql = sqlOverride ?? getOrgPg().sql;
  const since = new Date((args.now ?? new Date()).getTime() - ISSUE_ADMISSION_WINDOW_SECONDS * 1_000).toISOString();
  try {
    const rows = await sql<Array<{
      raw_occurrences: string | number;
      duplicate_occurrences: string | number;
      canonical_stock: string | number;
      canonical_cluster_counts: Array<string | number> | null;
      emitter_counts: Array<string | number> | null;
    }>>`
      WITH scope AS (
        SELECT workspace_id, harness_slug
          FROM harness_shared.work_items
         WHERE feature_id = ${args.canonicalId}
           ${args.canonicalHarness ? sql`AND harness_slug = ${args.canonicalHarness}` : sql``}
         ORDER BY created_ts DESC
         LIMIT 1
      ), recent AS (
        SELECT o.canonical_work_item_id,
               concat(o.source_tool, ':', coalesce(o.reporter, 'anonymous')) AS emitter,
               o.report_kind
          FROM harness_shared.work_item_occurrences o
          JOIN scope s
            ON s.workspace_id = o.workspace_id
           AND s.harness_slug = o.canonical_harness_slug
         WHERE o.occurred_at > ${since}::timestamptz
      ), cluster_counts AS (
        SELECT count(*)::bigint AS count
          FROM recent
         GROUP BY canonical_work_item_id
      ), emitter_counts AS (
        SELECT count(*)::bigint AS count
          FROM recent
         GROUP BY emitter
      )
      SELECT (SELECT count(*) FROM recent) AS raw_occurrences,
             (SELECT count(*) FROM recent WHERE report_kind <> 'canonical-created') AS duplicate_occurrences,
             (SELECT count(*)
                FROM harness_shared.work_items wi
                JOIN scope s ON s.workspace_id = wi.workspace_id AND s.harness_slug = wi.harness_slug
               WHERE wi.item_kind IN ('bug', 'change', 'task')
                 AND NOT harness_shared.work_item_status_is_terminal(wi.status)) AS canonical_stock,
             coalesce((SELECT array_agg(count ORDER BY count DESC) FROM cluster_counts), ARRAY[]::bigint[])
               AS canonical_cluster_counts,
             coalesce((SELECT array_agg(count ORDER BY count DESC) FROM emitter_counts), ARRAY[]::bigint[])
               AS emitter_counts
        FROM scope
    `;
    const row = rows[0];
    if (!row) return null;
    return assessIssueAdmissionPressure({
      rawOccurrences: Number(row.raw_occurrences ?? 0),
      duplicateOccurrences: Number(row.duplicate_occurrences ?? 0),
      canonicalStock: Number(row.canonical_stock ?? 0),
      canonicalClusterCounts: (row.canonical_cluster_counts ?? []).map(Number),
      emitterCounts: (row.emitter_counts ?? []).map(Number),
    });
  } catch {
    return null;
  }
}

export interface RecordIssueOccurrenceInput {
  canonicalId: string;
  canonicalHarness?: string | null;
  reporter?: string | null;
  sourceTool: 'work_items:create' | 'improvements:capture' | 'system';
  reportKind: IssueOccurrenceKind;
  reportedTitle: string;
  evidence?: Record<string, unknown>;
  admissionIdentity?: AdmissionIdentity | null;
}

export interface RecordedIssueOccurrence {
  occurrenceId: number;
  workspaceId: string;
  canonicalHarness: string;
  canonicalId: string;
  reportKind: IssueOccurrenceKind;
  occurredAt: string;
}

/** Append one report. Failure is intentionally non-fatal to issue admission. */
export async function recordIssueOccurrence(
  input: RecordIssueOccurrenceInput,
  sqlOverride?: OrgSql,
): Promise<RecordedIssueOccurrence | null> {
  // Unit suites use injected recorders. Never let an unrelated pure test open PG.
  if (process.env.VITEST && !sqlOverride) return null;
  const sql = sqlOverride ?? getOrgPg().sql;
  try {
    const canonical = (await sql<Array<{
      workspace_id: string;
      harness_slug: string;
      feature_id: string;
    }>>`
      SELECT workspace_id, harness_slug, feature_id
        FROM harness_shared.work_items
       WHERE feature_id = ${input.canonicalId}
         ${input.canonicalHarness ? sql`AND harness_slug = ${input.canonicalHarness}` : sql``}
       ORDER BY created_ts DESC
       LIMIT 1
    `)[0];
    if (!canonical) return null;
    const evidence = JSON.stringify(input.evidence ?? {});
    const identity = input.admissionIdentity ? JSON.stringify(input.admissionIdentity) : null;
    const rows = await sql<Array<{ occurrence_id: string | number; occurred_at: Date | string }>>`
      INSERT INTO harness_shared.work_item_occurrences
        (workspace_id, canonical_harness_slug, canonical_work_item_id, reporter,
         source_tool, report_kind, reported_title, evidence, admission_identity)
      VALUES
        (${canonical.workspace_id}, ${canonical.harness_slug}, ${canonical.feature_id},
         ${input.reporter ?? null}, ${input.sourceTool}, ${input.reportKind}, ${input.reportedTitle},
         ${evidence}::text::jsonb, ${identity}::text::jsonb)
      RETURNING occurrence_id, occurred_at
    `;
    const row = rows[0];
    return row
      ? {
          occurrenceId: Number(row.occurrence_id),
          workspaceId: canonical.workspace_id,
          canonicalHarness: canonical.harness_slug,
          canonicalId: canonical.feature_id,
          reportKind: input.reportKind,
          occurredAt: new Date(row.occurred_at).toISOString(),
        }
      : null;
  } catch {
    return null;
  }
}

export interface IssueOccurrenceCounts {
  canonicalClusters: number;
  rawOccurrences: number;
  duplicateOccurrences: number;
  units: {
    canonicalClusters: 'distinct canonical work-item ids with occurrences';
    rawOccurrences: 'append-only report rows';
    duplicateOccurrences: 'report rows not creating a canonical item';
  };
  writer: 'harness_shared.work_item_occurrences';
}

/** Exact, uncapped census for queue/leader reads. */
export async function readIssueOccurrenceCounts(
  args: { workspaceId: string; harnessSlug?: string | null; since?: string | null },
  sqlOverride?: OrgSql,
): Promise<IssueOccurrenceCounts> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = await sql<Array<{
    canonical_clusters: string | number;
    raw_occurrences: string | number;
    duplicate_occurrences: string | number;
  }>>`
    SELECT count(DISTINCT (canonical_harness_slug, canonical_work_item_id)) AS canonical_clusters,
           count(*)                                                        AS raw_occurrences,
           count(*) FILTER (WHERE report_kind <> 'canonical-created')      AS duplicate_occurrences
      FROM harness_shared.work_item_occurrences
     WHERE workspace_id = ${args.workspaceId}
       ${args.harnessSlug ? sql`AND canonical_harness_slug = ${args.harnessSlug}` : sql``}
       ${args.since ? sql`AND occurred_at > ${args.since}::timestamptz` : sql``}
  `;
  const row = rows[0];
  return {
    canonicalClusters: Number(row?.canonical_clusters ?? 0),
    rawOccurrences: Number(row?.raw_occurrences ?? 0),
    duplicateOccurrences: Number(row?.duplicate_occurrences ?? 0),
    units: {
      canonicalClusters: 'distinct canonical work-item ids with occurrences',
      rawOccurrences: 'append-only report rows',
      duplicateOccurrences: 'report rows not creating a canonical item',
    },
    writer: 'harness_shared.work_item_occurrences',
  };
}
