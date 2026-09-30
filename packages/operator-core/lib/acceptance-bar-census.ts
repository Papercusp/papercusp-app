/**
 * P-009 — versioned, rerunnable acceptance BAR coverage census.
 *
 * The census is a read projection over the canonical plan/rubric/spec rows. It
 * deliberately keeps Requirements-heading adoption separate from BAR-contract
 * coverage: the former preserves the 158/1,636 baseline, while the latter is
 * the post-epoch executable non-investigation denominator whose target is 100%.
 */
import { rubricTemplateDataAuthoringSchema } from './agent-tools/plans/rubric-template';

export const ACCEPTANCE_BAR_CENSUS_SCHEMA_VERSION = 2;
export const ACCEPTANCE_BAR_CENSUS_LIVE_STATUSES = ['ready', 'active', 'awaiting-acceptance'] as const;

export interface AcceptanceBarCensusOptions {
  workspaceId: string;
  harnessSlug: string;
  measuredAt?: Date;
  residualLimit?: number;
}

export interface AcceptanceBarCensusSql {
  unsafe<T = unknown>(query: string, values?: readonly unknown[]): Promise<T>;
}

export interface AcceptanceBarCensusRow {
  plan_slug: string;
  title: string | null;
  status: string | null;
  archived: boolean;
  is_legacy: boolean;
  template: string | null;
  template_slug: string | null;
  content: string;
  acceptance_bar_epoch: number | string | null;
  acceptance_bar_cohort: 'post-epoch' | 'legacy-backfilled' | null;
  acceptance_bar_set_hash: string | null;
  acceptance_bar_rubric_slug: string | null;
  acceptance_bar_rubric_revision: number | string | null;
  rubric_template_data: unknown;
  mapped_bar_keys: string[] | null;
}

export interface AcceptanceBarCensusResidual {
  planSlug: string;
  status: string | null;
  reasons: string[];
}

export interface AcceptanceBarCensusReport {
  schemaVersion: number;
  measuredAt: string;
  parameters: {
    workspaceId: string;
    harnessSlug: string;
    liveStatuses: readonly string[];
    residualLimit: number;
    barCoveragePopulation: 'post-epoch-executable';
    migrationCoveragePopulation: 'all-executable';
  };
  exclusions: {
    archived: number;
    legacy: number;
    rubricOrInstance: number;
    investigation: number;
    preEpochExecutable: number;
  };
  cohorts: Record<string, number>;
  requirementsAdoption: {
    numerator: number;
    denominator: number;
    percent: number;
  };
  barCoverage: {
    numerator: number;
    denominator: number;
    percent: number;
  };
  /** The v1 all-executable metric, retained separately from the adoption target. */
  migrationCoverage: { numerator: number; denominator: number; percent: number };
  residuals: AcceptanceBarCensusResidual[];
  residualsTruncated: boolean;
  migrationResiduals: AcceptanceBarCensusResidual[];
  migrationResidualsTruncated: boolean;
  query: string;
}

/** The exact SQL sent by the runner, retained in every report for reruns. */
export const ACCEPTANCE_BAR_CENSUS_QUERY = `
SELECT p.plan_slug, p.title, p.status, p.archived, p.is_legacy,
       p.template, p.template_slug, p.content,
       p.acceptance_bar_epoch, p.acceptance_bar_cohort,
       p.acceptance_bar_set_hash, p.acceptance_bar_rubric_slug,
       p.acceptance_bar_rubric_revision,
       rubric.template_data AS rubric_template_data,
       mapped.mapped_bar_keys
  FROM harness_shared.harness_plans p
  LEFT JOIN LATERAL (
    SELECT r.template_data
      FROM harness_shared.harness_plans r
     WHERE r.workspace_id = p.workspace_id
       AND r.harness_slug = p.harness_slug
       AND r.template = 'rubric'
       AND r.template_slug IS NULL
       AND r.archived = false
       AND r.status IN ('active', 'ready')
       AND r.template_data->>'kind' = 'acceptance'
       AND r.template_data->>'subjectPlan' = p.plan_slug
     ORDER BY r.updated_at DESC NULLS LAST, r.plan_slug ASC
     LIMIT 1
  ) rubric ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT revision.source_bar_key ORDER BY revision.source_bar_key)
             FILTER (WHERE revision.source_bar_key IS NOT NULL) AS mapped_bar_keys
      FROM harness_shared.plan_spec_clauses clause
      JOIN harness_shared.plan_spec_clause_revisions revision
        ON revision.workspace_id = clause.workspace_id
       AND revision.harness_slug = clause.harness_slug
       AND revision.plan_slug = clause.plan_slug
       AND revision.spec_id = clause.spec_id
       AND revision.revision = clause.current_revision
     WHERE clause.workspace_id = p.workspace_id
       AND clause.harness_slug = p.harness_slug
       AND clause.plan_slug = p.plan_slug
       AND revision.lifecycle_status NOT IN ('retired', 'exempt')
  ) mapped ON true
 WHERE p.workspace_id = $1
   AND p.harness_slug = $2
 ORDER BY p.plan_slug ASC`;

function hasRequirementsHeading(content: string): boolean {
  return /(?:^|\n)##\s+Requirements(?:\s|$)/i.test(content);
}

function isInvestigation(row: AcceptanceBarCensusRow): boolean {
  return /(?:^|\n)##\s+Investigation(?:\s|$)/i.test(row.content);
}

function isPostEpoch(row: AcceptanceBarCensusRow): boolean {
  // Either durable marker admits a row. Missing one marker is a coverage
  // failure, never a way to disappear from the adoption denominator.
  return row.acceptance_bar_cohort === 'post-epoch' ||
    (row.acceptance_bar_epoch != null && row.acceptance_bar_cohort !== 'legacy-backfilled');
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(2));
}

function classifyCoverage(row: AcceptanceBarCensusRow): string[] {
  const reasons: string[] = [];
  if (row.acceptance_bar_epoch == null) reasons.push('bar_epoch_missing');
  if (row.acceptance_bar_cohort == null) reasons.push('bar_cohort_missing');
  if (!row.acceptance_bar_set_hash) reasons.push('bar_set_hash_missing');
  if (!row.acceptance_bar_rubric_slug || row.acceptance_bar_rubric_revision == null) reasons.push('rubric_pin_missing');
  const rubric = rubricTemplateDataAuthoringSchema.safeParse(row.rubric_template_data);
  if (!rubric.success || rubric.data.kind !== 'acceptance') {
    reasons.push('rubric_missing_or_unreadable');
    return reasons;
  }
  const bars = rubric.data.criteria.filter((criterion) => criterion.barKey);
  const keys = bars.map((criterion) => criterion.barKey!);
  if (bars.length === 0) reasons.push('bar_set_empty');
  if (new Set(keys).size !== keys.length) reasons.push('bar_keys_duplicate');
  if (bars.some((criterion) => typeof criterion.model !== 'string' || !criterion.model.trim())) reasons.push('bar_text_empty');
  const mapped = new Set(row.mapped_bar_keys ?? []);
  if (keys.some((key) => !mapped.has(key))) reasons.push('bar_mapping_incomplete');
  return reasons;
}

/** Pure projection used by both the DB adapter and deterministic tests. */
export function buildAcceptanceBarCensusReport(
  rows: readonly AcceptanceBarCensusRow[],
  options: AcceptanceBarCensusOptions,
): AcceptanceBarCensusReport {
  const residualLimit = Math.max(1, Math.min(10_000, Math.floor(options.residualLimit ?? 10_000)));
  const requirementsCorpus = rows.filter(
    (row) => !row.archived && !row.is_legacy && row.template !== 'rubric' && row.template_slug == null,
  );
  const executable = requirementsCorpus.filter(
    (row) => ACCEPTANCE_BAR_CENSUS_LIVE_STATUSES.includes(row.status as (typeof ACCEPTANCE_BAR_CENSUS_LIVE_STATUSES)[number]) && !isInvestigation(row),
  ).sort((a, b) => a.plan_slug.localeCompare(b.plan_slug));
  const postEpoch = executable.filter(isPostEpoch);
  const exclusions = {
    archived: rows.filter((row) => row.archived).length,
    legacy: rows.filter((row) => row.is_legacy).length,
    rubricOrInstance: rows.filter((row) => row.template === 'rubric' || row.template_slug != null).length,
    investigation: requirementsCorpus.filter(isInvestigation).length,
    preEpochExecutable: executable.length - postEpoch.length,
  };
  const cohorts: Record<string, number> = {};
  for (const row of rows) {
    const cohort = row.acceptance_bar_cohort ?? 'unmarked';
    cohorts[cohort] = (cohorts[cohort] ?? 0) + 1;
  }
  const residuals: AcceptanceBarCensusResidual[] = [];
  const migrationResiduals: AcceptanceBarCensusResidual[] = [];
  let covered = 0;
  let migrationCovered = 0;
  for (const row of executable) {
    const reasons = classifyCoverage(row);
    if (reasons.length === 0) migrationCovered++;
    else if (migrationResiduals.length < residualLimit) migrationResiduals.push({ planSlug: row.plan_slug, status: row.status, reasons });
    if (!isPostEpoch(row)) continue;
    if (reasons.length === 0) covered++;
    else if (residuals.length < residualLimit) residuals.push({ planSlug: row.plan_slug, status: row.status, reasons });
  }
  const measuredAt = (options.measuredAt ?? new Date()).toISOString();
  const denominator = requirementsCorpus.length;
  const requirementsNumerator = requirementsCorpus.filter((row) => hasRequirementsHeading(row.content)).length;
  return {
    schemaVersion: ACCEPTANCE_BAR_CENSUS_SCHEMA_VERSION,
    measuredAt,
    parameters: {
      workspaceId: options.workspaceId,
      harnessSlug: options.harnessSlug,
      liveStatuses: [...ACCEPTANCE_BAR_CENSUS_LIVE_STATUSES],
      residualLimit,
      barCoveragePopulation: 'post-epoch-executable',
      migrationCoveragePopulation: 'all-executable',
    },
    exclusions,
    cohorts,
    requirementsAdoption: {
      numerator: requirementsNumerator,
      denominator,
      percent: percent(requirementsNumerator, denominator),
    },
    barCoverage: {
      numerator: covered,
      denominator: postEpoch.length,
      percent: percent(covered, postEpoch.length),
    },
    migrationCoverage: {
      numerator: migrationCovered,
      denominator: executable.length,
      percent: percent(migrationCovered, executable.length),
    },
    residuals,
    residualsTruncated: postEpoch.length - covered > residuals.length,
    migrationResiduals,
    migrationResidualsTruncated: executable.length - migrationCovered > migrationResiduals.length,
    query: ACCEPTANCE_BAR_CENSUS_QUERY,
  };
}

export async function runAcceptanceBarCensus(
  sql: AcceptanceBarCensusSql,
  options: AcceptanceBarCensusOptions,
): Promise<AcceptanceBarCensusReport> {
  const rows = await sql.unsafe<AcceptanceBarCensusRow[]>(ACCEPTANCE_BAR_CENSUS_QUERY, [options.workspaceId, options.harnessSlug]);
  return buildAcceptanceBarCensusReport(rows, options);
}
