/**
 * Legacy acceptance adoption + the named current-build canary
 * (observation-candidate-acceptance-promotion-2026-09-30 P-011; D-004, D-009, D-018).
 *
 * D-004: "Baseline and propose the cohort/cutover policy before applying it. Protect
 * in-flight claims and intentional holds, preserve uncertain evidence and show remaining
 * legacy exemptions explicitly until the adoption completes. No age-only rejection or
 * mass deletion is permitted."
 *
 * The adoption therefore never decides acceptance. It ENROLS a bounded cohort of
 * pre-cutover rows that carry no readiness record at all (`legacy-missing`) into the
 * acceptance pipeline: each row gets the same `unknown` / `creation-enrollment`
 * readiness every new row gets at creation, plus a `legacyAcceptanceAdoption` marker
 * naming the run. Claimability does not change (both shapes are the legacy-equivalent
 * exception of floor #16 until the cutover), so nothing is frozen; the row's intake
 * stage moves from `unknown` to `candidate`, which is what the P-008 intake drain
 * reviews. Acceptance is then sealed only by that review (R-35: NULL state never
 * manufactures acceptance).
 *
 * Every step is report-first and recoverable:
 *   report  → read-only, bounded, records the exact rows + their updated_ts;
 *   apply   → only the reported rows, only if unchanged and still unprotected;
 *   revert  → restores the absent readiness on every row nobody reviewed since.
 *
 * The canary (R-11/R-35/R-36/R-37) runs four checks on the named runtime and records
 * a receipt; `authorizeEnforcementCutoverAdvance` refuses to move the enforcement
 * cutover without a passed receipt for that runtime.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { OrgSql } from '../../work-items';
import { ALL_TERMINAL_STATUSES } from '../../work-item-blocking';
import { activeExternalBlockers } from '../../external-blockers';
import {
  IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER,
  IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS,
  IMPLEMENTATION_READINESS_SCHEMA_VERSION,
  createImplementationReadiness,
  deriveWorkItemIntakeStage,
  hasStrictOwnerAction,
  implementationReadinessAdmitsClaim,
  readAgentReviewState,
  readImplementationReadiness,
  sealImplementationAcceptance,
} from './agent-review-policy';

export const LEGACY_ADOPTION_SCHEMA_VERSION = 'legacy-acceptance-adoption-v1' as const;
/** Upper bound on the rows ONE cohort examines (D-004 "bounded cohorts"). */
export const LEGACY_ADOPTION_MAX_COHORT = 200;
/** A report older than this cannot be applied; re-run the report first. */
export const LEGACY_ADOPTION_REPORT_TTL_MS = 60 * 60_000;
export const LEGACY_ADOPTION_KINDS = ['bug', 'change', 'task'] as const;
export type LegacyAdoptionKind = (typeof LEGACY_ADOPTION_KINDS)[number];
export const LEGACY_ADOPTION_PAYLOAD_KEY = 'legacyAcceptanceAdoption' as const;
export const LEGACY_ADOPTION_WRITER = 'legacy-acceptance-adoption' as const;

/** The sentinel D-018 parked the cutover at: enforcement of the post-cutover arm is OFF. */
export const ENFORCEMENT_CUTOVER_SENTINEL = '2100-01-01T00:00:00.000Z' as const;
/** The runtime the canary must pass on before enforcement moves (dev:pipeline_position testClass). */
export const ACCEPTANCE_CANARY_RUNTIME = 'operator-api' as const;
export const ACCEPTANCE_CANARY_STEPS = ['new-intake-stage', 'legacy-cohort-report', 'fail-closed', 'fast-path'] as const;
export type AcceptanceCanaryStep = (typeof ACCEPTANCE_CANARY_STEPS)[number];
/** A canary receipt older than this no longer authorizes a cutover move. */
export const ACCEPTANCE_CANARY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * The receipt that authorized the CURRENT `IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER`.
 * While the cutover is the D-018 sentinel this stays null. Lowering the cutover is a
 * code change that MUST set this to the passed canary receipt the
 * `work_items:acceptance-adoption { op:'cutover-check' }` read returned; the R-37 guard
 * test fails a cutover move that carries no attestation.
 */
export const ENFORCEMENT_CUTOVER_CANARY_ATTESTATION: {
  receiptRunId: string;
  runtime: typeof ACCEPTANCE_CANARY_RUNTIME;
  buildSha: string;
  recordedAt: string;
} | null = null;

export type LegacyAdoptionProtection =
  | 'in-flight-claim'
  | 'claim-hold'
  | 'agent-review-in-progress'
  | 'owner-action'
  | 'external-blocker';

export type LegacyAdoptionSkip = LegacyAdoptionProtection | 'changed-since-report' | 'no-longer-legacy';

const IN_FLIGHT_STATUSES = new Set(['wip', 'in_progress', 'in-progress', 'active', 'running']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Why a legacy row must NOT be touched by an adoption cohort, or null. In-flight claims
 * and intentional parks are preserved exactly as they are (D-004).
 */
export function legacyAdoptionProtection(row: {
  status: string;
  takenBy?: string | null;
  payload?: unknown;
}): LegacyAdoptionProtection | null {
  if ((row.takenBy ?? '').trim() || IN_FLIGHT_STATUSES.has(row.status)) return 'in-flight-claim';
  const payload = record(row.payload);
  if (payload._claimHold === true) return 'claim-hold';
  const review = readAgentReviewState(payload);
  if (review && (review.status === 'pending' || review.status === 'revision-requested')) {
    return 'agent-review-in-progress';
  }
  if (hasStrictOwnerAction(payload)) return 'owner-action';
  if (activeExternalBlockers(payload).length > 0) return 'external-blocker';
  return null;
}

export interface LegacyCohortSelector {
  kind: LegacyAdoptionKind;
  /** Inclusive lower bound on created_ts (epoch ms). */
  createdFromMs?: number | null;
  /** Exclusive upper bound on created_ts; never later than the enforcement cutover. */
  createdBeforeMs?: number | null;
}

export function legacyCohortKey(selector: LegacyCohortSelector): string {
  const before = Math.min(selector.createdBeforeMs ?? IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS,
    IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS);
  return `${selector.kind}:${selector.createdFromMs ?? 0}..${before}`;
}

interface LegacyRow {
  feature_id: string;
  item_kind: string;
  status: string;
  taken_by: string | null;
  payload: unknown;
  updated_ts: string | number | null;
  created_ts: string | number | null;
}

function rowVersion(row: Pick<LegacyRow, 'updated_ts'>): string {
  return String(row.updated_ts ?? '');
}

function fingerprint(entries: ReadonlyArray<readonly [string, string]>): string {
  const material = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([id, v]) => `${id}@${v}`).join('\n');
  return `lac-v1:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

/** The legacy population predicate: pre-cutover, issue-family, non-observation, non-terminal, never enrolled. */
function legacyPopulationSql(sql: OrgSql, scope: { workspaceId: string; harnessSlug: string }, selector: LegacyCohortSelector) {
  const from = selector.createdFromMs ?? 0;
  const before = Math.min(selector.createdBeforeMs ?? IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS,
    IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS);
  const terminal = [...ALL_TERMINAL_STATUSES];
  return sql`
        wi.workspace_id = ${scope.workspaceId}
    AND wi.harness_slug = ${scope.harnessSlug}
    AND wi.item_kind = ${selector.kind}
    AND wi.lane IS DISTINCT FROM 'observation'
    AND COALESCE(wi.payload ->> 'lane', '') <> 'observation'
    AND wi.status <> ALL(${terminal}::text[])
    AND COALESCE(wi.created_ts, 0) >= ${from}::bigint
    AND COALESCE(wi.created_ts, 0) < ${before}::bigint
    AND NOT (COALESCE(wi.payload, '{}'::jsonb) ? 'implementationReadiness')
    AND NOT (COALESCE(wi.payload, '{}'::jsonb) ? ${LEGACY_ADOPTION_PAYLOAD_KEY})`;
}

export interface LegacyCohortReport {
  ok: true;
  dryRun: true;
  runId: string;
  cohortKey: string;
  scope: { workspaceId: string; harnessSlug: string; kind: LegacyAdoptionKind };
  window: { createdFromMs: number; createdBeforeMs: number; enforcementCutover: string };
  unit: 'work-item rows';
  writer: 'reportLegacyAdoptionCohort';
  limit: number;
  examined: number;
  eligible: string[];
  protected: Array<{ id: string; reason: LegacyAdoptionProtection }>;
  /** Legacy rows matching the selector that this cohort did NOT examine (still exempt, still visible). */
  remainingLegacyOutsideCohort: number;
  fingerprint: string;
}

/** Report-first dry run of ONE bounded cohort. Mutates nothing except its own receipt row. */
export async function reportLegacyAdoptionCohort(
  sql: OrgSql,
  input: {
    workspaceId: string;
    harnessSlug: string;
    selector: LegacyCohortSelector;
    limit?: number;
    actor: string;
  },
): Promise<LegacyCohortReport> {
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? LEGACY_ADOPTION_MAX_COHORT), LEGACY_ADOPTION_MAX_COHORT));
  const scope = { workspaceId: input.workspaceId, harnessSlug: input.harnessSlug };
  const predicate = legacyPopulationSql(sql, scope, input.selector);
  const rows = await sql<LegacyRow[]>`
    SELECT wi.feature_id, wi.item_kind, wi.status, wi.taken_by, wi.payload, wi.updated_ts, wi.created_ts
      FROM harness_shared.work_items wi
     WHERE ${predicate}
     ORDER BY wi.created_ts NULLS FIRST, wi.feature_id
     LIMIT ${limit}`;
  const [{ total }] = await sql<{ total: number }[]>`
    SELECT count(*)::int AS total FROM harness_shared.work_items wi WHERE ${predicate}`;
  const eligible: string[] = [];
  const versions: Record<string, string> = {};
  const protectedRows: Array<{ id: string; reason: LegacyAdoptionProtection }> = [];
  for (const row of rows) {
    const reason = legacyAdoptionProtection({ status: row.status, takenBy: row.taken_by, payload: row.payload });
    if (reason) protectedRows.push({ id: row.feature_id, reason });
    else {
      eligible.push(row.feature_id);
      versions[row.feature_id] = rowVersion(row);
    }
  }
  const runId = `lac-report-${randomUUID()}`;
  const cohortKey = legacyCohortKey(input.selector);
  const fp = fingerprint(Object.entries(versions));
  const window = {
    createdFromMs: input.selector.createdFromMs ?? 0,
    createdBeforeMs: Math.min(input.selector.createdBeforeMs ?? IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS,
      IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS),
    enforcementCutover: IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER,
  };
  const report: LegacyCohortReport = {
    ok: true,
    dryRun: true,
    runId,
    cohortKey,
    scope: { ...scope, kind: input.selector.kind },
    window,
    unit: 'work-item rows',
    writer: 'reportLegacyAdoptionCohort',
    limit,
    examined: rows.length,
    eligible,
    protected: protectedRows,
    remainingLegacyOutsideCohort: Math.max(0, Number(total) - rows.length),
    fingerprint: fp,
  };
  await sql`
    INSERT INTO harness_shared.acceptance_adoption_runs
      (run_id, workspace_id, harness_slug, kind, cohort_key, status, actor, fingerprint, row_ids, detail)
    VALUES (${runId}, ${scope.workspaceId}, ${scope.harnessSlug}, 'cohort-report', ${cohortKey}, 'recorded',
            ${input.actor}, ${fp}, ${eligible}::text[],
            ${sql.json({ schemaVersion: LEGACY_ADOPTION_SCHEMA_VERSION, selector: input.selector, versions,
              protected: protectedRows, window, limit, examined: rows.length,
              remainingLegacyOutsideCohort: report.remainingLegacyOutsideCohort } as never)})`;
  return report;
}

export type LegacyCohortApplyResult =
  | {
      ok: true;
      runId: string;
      reportRunId: string;
      cohortKey: string;
      adopted: string[];
      skipped: Array<{ id: string; reason: LegacyAdoptionSkip }>;
      unit: 'work-item rows';
      writer: 'applyLegacyAdoptionCohort';
    }
  | { ok: false; refusal: 'report-not-found' | 'report-expired' | 'already-applied' | 'scope-mismatch'; reportRunId: string };

interface RunRow {
  run_id: string;
  workspace_id: string;
  harness_slug: string;
  kind: string;
  cohort_key: string | null;
  report_run_id: string | null;
  status: string;
  row_ids: string[];
  detail: Record<string, unknown>;
  created_at: Date | string;
}

/**
 * Enrol exactly the reported rows that are still legacy, unchanged since the report and
 * unprotected. One apply per report (unique index). Rows claimed or parked after the
 * report are skipped and left untouched.
 */
export async function applyLegacyAdoptionCohort(
  sql: OrgSql,
  input: { workspaceId: string; harnessSlug: string; reportRunId: string; actor: string; now?: () => number },
): Promise<LegacyCohortApplyResult> {
  const nowMs = (input.now ?? Date.now)();
  const [report] = await sql<RunRow[]>`
    SELECT * FROM harness_shared.acceptance_adoption_runs
     WHERE run_id = ${input.reportRunId} AND kind = 'cohort-report'`;
  if (!report) return { ok: false, refusal: 'report-not-found', reportRunId: input.reportRunId };
  if (report.workspace_id !== input.workspaceId || report.harness_slug !== input.harnessSlug) {
    return { ok: false, refusal: 'scope-mismatch', reportRunId: input.reportRunId };
  }
  if (nowMs - new Date(report.created_at).getTime() > LEGACY_ADOPTION_REPORT_TTL_MS) {
    return { ok: false, refusal: 'report-expired', reportRunId: input.reportRunId };
  }
  const versions = record(record(report.detail).versions) as Record<string, string>;
  const runId = `lac-apply-${randomUUID()}`;
  const adoptedAt = new Date(nowMs).toISOString();
  const readiness = createImplementationReadiness({
    status: 'unknown',
    source: 'creation-enrollment',
    reason: `legacy-acceptance-adoption cohort ${report.cohort_key} run ${runId}`,
    updatedAt: adoptedAt,
  });
  const marker = {
    schemaVersion: LEGACY_ADOPTION_SCHEMA_VERSION,
    runId,
    reportRunId: input.reportRunId,
    cohortKey: report.cohort_key,
    adoptedAt,
    actor: input.actor,
    priorReadiness: 'absent' as const,
  };
  try {
    return await sql.begin(async (tx) => {
      const t = tx as unknown as OrgSql;
      // Claim the report first: the partial unique index makes a second apply fail here.
      await t`
        INSERT INTO harness_shared.acceptance_adoption_runs
          (run_id, workspace_id, harness_slug, kind, cohort_key, report_run_id, status, actor, fingerprint, row_ids, detail)
        VALUES (${runId}, ${input.workspaceId}, ${input.harnessSlug}, 'cohort-apply', ${report.cohort_key},
                ${input.reportRunId}, 'applied', ${input.actor}, ${null}, '{}'::text[], '{}'::jsonb)`;
      const rows = await t<LegacyRow[]>`
        SELECT feature_id, item_kind, status, taken_by, payload, updated_ts, created_ts
          FROM harness_shared.work_items
         WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
           AND feature_id = ANY(${report.row_ids}::text[])
         ORDER BY feature_id
           FOR UPDATE`;
      const adopted: string[] = [];
      const skipped: Array<{ id: string; reason: LegacyAdoptionSkip }> = [];
      const seen = new Set<string>();
      for (const row of rows) {
        seen.add(row.feature_id);
        const payload = record(row.payload);
        if (Object.prototype.hasOwnProperty.call(payload, 'implementationReadiness')
          || Object.prototype.hasOwnProperty.call(payload, LEGACY_ADOPTION_PAYLOAD_KEY)
          || ALL_TERMINAL_STATUSES.has(row.status)) {
          skipped.push({ id: row.feature_id, reason: 'no-longer-legacy' });
          continue;
        }
        if (versions[row.feature_id] !== rowVersion(row)) {
          skipped.push({ id: row.feature_id, reason: 'changed-since-report' });
          continue;
        }
        const protection = legacyAdoptionProtection({ status: row.status, takenBy: row.taken_by, payload });
        if (protection) {
          skipped.push({ id: row.feature_id, reason: protection });
          continue;
        }
        await t`
          UPDATE harness_shared.work_items
             SET payload = COALESCE(payload, '{}'::jsonb)
                   || jsonb_build_object('implementationReadiness', ${t.json(readiness as never)}::jsonb,
                                         ${LEGACY_ADOPTION_PAYLOAD_KEY}::text, ${t.json(marker as never)}::jsonb),
                 updated_ts = ${nowMs}
           WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
             AND feature_id = ${row.feature_id}`;
        adopted.push(row.feature_id);
      }
      for (const id of report.row_ids) if (!seen.has(id)) skipped.push({ id, reason: 'no-longer-legacy' });
      await t`
        UPDATE harness_shared.acceptance_adoption_runs
           SET row_ids = ${adopted}::text[],
               detail = ${t.json({ schemaVersion: LEGACY_ADOPTION_SCHEMA_VERSION, skipped, readinessUpdatedAt: adoptedAt } as never)}
         WHERE run_id = ${runId}`;
      return {
        ok: true as const,
        runId,
        reportRunId: input.reportRunId,
        cohortKey: report.cohort_key ?? '',
        adopted,
        skipped,
        unit: 'work-item rows' as const,
        writer: 'applyLegacyAdoptionCohort' as const,
      };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return { ok: false, refusal: 'already-applied', reportRunId: input.reportRunId };
    }
    throw error;
  }
}

export type LegacyCohortRevertResult =
  | { ok: true; runId: string; applyRunId: string; restored: string[]; kept: Array<{ id: string; reason: 'reviewed-since-adoption' | 'missing' }> }
  | { ok: false; refusal: 'apply-not-found' | 'already-reverted' | 'scope-mismatch'; applyRunId: string };

/**
 * Recovery: restore the prior (absent) readiness on every row this apply enrolled,
 * unless a reviewer has written a verdict since — that verdict is preserved.
 */
export async function revertLegacyAdoptionCohort(
  sql: OrgSql,
  input: { workspaceId: string; harnessSlug: string; applyRunId: string; actor: string; now?: () => number },
): Promise<LegacyCohortRevertResult> {
  const nowMs = (input.now ?? Date.now)();
  const [apply] = await sql<RunRow[]>`
    SELECT * FROM harness_shared.acceptance_adoption_runs
     WHERE run_id = ${input.applyRunId} AND kind = 'cohort-apply'`;
  if (!apply) return { ok: false, refusal: 'apply-not-found', applyRunId: input.applyRunId };
  if (apply.workspace_id !== input.workspaceId || apply.harness_slug !== input.harnessSlug) {
    return { ok: false, refusal: 'scope-mismatch', applyRunId: input.applyRunId };
  }
  if (apply.status === 'reverted') return { ok: false, refusal: 'already-reverted', applyRunId: input.applyRunId };
  const readinessUpdatedAt = String(record(apply.detail).readinessUpdatedAt ?? '');
  const runId = `lac-revert-${randomUUID()}`;
  try {
    return await sql.begin(async (tx) => {
      const t = tx as unknown as OrgSql;
      await t`
        INSERT INTO harness_shared.acceptance_adoption_runs
          (run_id, workspace_id, harness_slug, kind, cohort_key, report_run_id, status, actor, row_ids, detail)
        VALUES (${runId}, ${input.workspaceId}, ${input.harnessSlug}, 'cohort-revert', ${apply.cohort_key},
                ${input.applyRunId}, 'reverted', ${input.actor}, '{}'::text[], '{}'::jsonb)`;
      const rows = await t<LegacyRow[]>`
        SELECT feature_id, item_kind, status, taken_by, payload, updated_ts, created_ts
          FROM harness_shared.work_items
         WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
           AND feature_id = ANY(${apply.row_ids}::text[])
         ORDER BY feature_id
           FOR UPDATE`;
      const restored: string[] = [];
      const kept: Array<{ id: string; reason: 'reviewed-since-adoption' | 'missing' }> = [];
      const seen = new Set<string>();
      for (const row of rows) {
        seen.add(row.feature_id);
        const payload = record(row.payload);
        const marker = record(payload[LEGACY_ADOPTION_PAYLOAD_KEY]);
        const readiness = readImplementationReadiness(payload);
        const untouched = marker.runId === input.applyRunId
          && readiness?.source === 'creation-enrollment'
          && readiness.status === 'unknown'
          && readiness.updatedAt === readinessUpdatedAt
          && !readiness.evidence;
        if (!untouched) {
          kept.push({ id: row.feature_id, reason: 'reviewed-since-adoption' });
          continue;
        }
        await t`
          UPDATE harness_shared.work_items
             SET payload = (payload - 'implementationReadiness') - ${LEGACY_ADOPTION_PAYLOAD_KEY}::text,
                 updated_ts = ${nowMs}
           WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
             AND feature_id = ${row.feature_id}`;
        restored.push(row.feature_id);
      }
      for (const id of apply.row_ids) if (!seen.has(id)) kept.push({ id, reason: 'missing' });
      await t`
        UPDATE harness_shared.acceptance_adoption_runs
           SET row_ids = ${restored}::text[], detail = ${t.json({ schemaVersion: LEGACY_ADOPTION_SCHEMA_VERSION, kept } as never)}
         WHERE run_id = ${runId}`;
      await t`UPDATE harness_shared.acceptance_adoption_runs SET status = 'reverted' WHERE run_id = ${input.applyRunId}`;
      return { ok: true as const, runId, applyRunId: input.applyRunId, restored, kept };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return { ok: false, refusal: 'already-reverted', applyRunId: input.applyRunId };
    }
    throw error;
  }
}

// ── Canary ─────────────────────────────────────────────────────────────────────

export interface AcceptanceCanaryStepResult {
  step: AcceptanceCanaryStep;
  ok: boolean;
  evidence: Record<string, unknown>;
}

export interface AcceptanceCanaryReceipt {
  runId: string;
  runtime: string;
  buildSha: string | null;
  status: 'passed' | 'failed';
  steps: AcceptanceCanaryStepResult[];
  recordedAt: string;
}

/** Synthetic post-cutover rows the deployed SQL floor and its TS twin must refuse (R-35) or admit (R-36). */
export function acceptanceCanaryProbes(): Array<{
  probe: string;
  step: 'fail-closed' | 'fast-path';
  payload: Record<string, unknown> | null;
  expectAdmit: boolean;
}> {
  const title = 'acceptance canary probe';
  const summary = 'synthetic row; never written';
  const updatedAt = '2026-10-01T00:00:00.000Z';
  const proposal = {
    problem: 'Synthetic canary defect.',
    evidence: ['acceptance canary fixture'],
    outcome: 'The canary admits only a scoped receipt.',
    scope: 'Canary only.',
    completionCheck: 'The canary step passes.',
  };
  const policy = sealImplementationAcceptance({
    proposal,
    authority: { kind: 'policy', policy: 'trusted-tool-failure-promotion', actor: 'system:acceptance-canary' },
    reason: 'trusted tool-failure promotion receipt',
    source: { kind: 'bug', title, summary },
    acceptedAt: updatedAt,
    // P-006 (D-019): a bug's acceptance carries its reproduction receipt, so the
    // fast-path probe must too or the floor reads it as incomplete.
    reproduction: { kind: 'current-build-observation', ref: 'acceptance canary fixture (synthetic, never written)', buildSha: '0000000' },
  });
  if (!policy.ok) throw new Error('canary policy receipt must seal');
  const bareReady = createImplementationReadiness({ status: 'ready', source: 'capture-policy', reason: 'immediate capture', updatedAt });
  const probes: Array<{ probe: string; step: 'fail-closed' | 'fast-path'; payload: unknown; expectAdmit: boolean }> = [
    { probe: 'null-payload', step: 'fail-closed', payload: null, expectAdmit: false },
    { probe: 'missing-readiness', step: 'fail-closed', payload: {}, expectAdmit: false },
    {
      probe: 'creation-enrollment-unknown',
      step: 'fail-closed',
      payload: { implementationReadiness: createImplementationReadiness({ status: 'unknown', source: 'creation-enrollment', reason: 'no-acceptance-evidence-at-creation', updatedAt }) },
      expectAdmit: false,
    },
    { probe: 'admission-unreviewed-fail-open', step: 'fail-closed', payload: { admission: 'unreviewed', implementationReadiness: bareReady }, expectAdmit: false },
    { probe: 'critical-severity', step: 'fast-path', payload: { _ei: { severity: 'critical' }, implementationReadiness: bareReady }, expectAdmit: false },
    { probe: 'security-tag', step: 'fast-path', payload: { tags: ['security'], implementationReadiness: bareReady }, expectAdmit: false },
    { probe: 'explicit-assignment', step: 'fast-path', payload: { assignee: 'su-assigned', implementationReadiness: bareReady }, expectAdmit: false },
    {
      probe: 'policy-receipt',
      step: 'fast-path',
      payload: {
        implementationReadiness: createImplementationReadiness({
          status: 'ready', source: 'capture-policy', reason: 'trusted tool-failure promotion', updatedAt,
          evidence: { acceptance: policy.contract },
        }),
      },
      expectAdmit: true,
    },
  ];
  return probes.map((p) => ({ ...p, payload: p.payload as Record<string, unknown> | null }));
}

/**
 * Run the four canary checks on THIS runtime and record a receipt.
 * `probe.create` must go through the real create path (R-11); `probe.drop` closes the
 * probe so it never enters the queue. The probe is created already assigned to the
 * canary actor, so no other agent can claim it in between.
 */
export async function runAcceptanceCanary(
  sql: OrgSql,
  input: {
    workspaceId: string;
    harnessSlug: string;
    actor: string;
    runtime: string;
    buildSha: string | null;
    probe: {
      create: () => Promise<{ id: string }>;
      drop: (id: string, runId: string) => Promise<void>;
    };
    cohort?: LegacyCohortSelector;
    now?: () => number;
  },
): Promise<AcceptanceCanaryReceipt> {
  const runId = `lac-canary-${randomUUID()}`;
  const steps: AcceptanceCanaryStepResult[] = [];
  const post = IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS + 60_000;

  // 1. new-intake-stage: a row created through the real create path carries an attributable stage.
  try {
    const { id } = await input.probe.create();
    try {
      const [row] = await sql<{ item_kind: string; status: string; payload: unknown; title: string; summary: string | null }[]>`
        SELECT item_kind, status, payload, title, summary FROM harness_shared.work_items
         WHERE workspace_id = ${input.workspaceId} AND feature_id = ${id}`;
      const readiness = row ? readImplementationReadiness(row.payload) : null;
      const stage = row
        ? deriveWorkItemIntakeStage({ kind: row.item_kind, status: row.status, payload: row.payload, title: row.title, summary: row.summary })
        : null;
      steps.push({
        step: 'new-intake-stage',
        ok: Boolean(readiness && readiness.source === 'creation-enrollment' && readiness.status === 'unknown'
          && stage && stage.primaryStage === 'candidate' && stage.readiness === 'unknown'),
        evidence: { probeId: id, readinessSource: readiness?.source ?? null, readinessStatus: readiness?.status ?? null,
          primaryStage: stage?.primaryStage ?? null, reason: stage?.reason ?? null },
      });
    } finally {
      await input.probe.drop(id, runId);
    }
  } catch (error) {
    steps.push({ step: 'new-intake-stage', ok: false, evidence: { error: String((error as Error)?.message ?? error) } });
  }

  // 2. legacy-cohort-report: the report-first dry run answers with scope/window/unit/writer.
  try {
    const report = await reportLegacyAdoptionCohort(sql, {
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      selector: input.cohort ?? { kind: 'bug' },
      limit: 25,
      actor: input.actor,
    });
    steps.push({
      step: 'legacy-cohort-report',
      ok: report.dryRun && report.examined === report.eligible.length + report.protected.length
        && report.examined <= LEGACY_ADOPTION_MAX_COHORT,
      evidence: { reportRunId: report.runId, cohortKey: report.cohortKey, examined: report.examined,
        eligible: report.eligible.length, protected: report.protected.length,
        remainingLegacyOutsideCohort: report.remainingLegacyOutsideCohort },
    });
  } catch (error) {
    steps.push({ step: 'legacy-cohort-report', ok: false, evidence: { error: String((error as Error)?.message ?? error) } });
  }

  // 3/4. fail-closed + fast-path: the DEPLOYED SQL floor and its TS twin judge synthetic post-cutover rows.
  const probes = acceptanceCanaryProbes();
  for (const step of ['fail-closed', 'fast-path'] as const) {
    try {
      const verdicts: Array<{ probe: string; sql: boolean; ts: boolean; expect: boolean }> = [];
      for (const p of probes.filter((x) => x.step === step)) {
        const [r] = await sql<{ admits: boolean }[]>`
          SELECT harness_shared.work_item_implementation_readiness_admits(
                   ${p.payload ? sql.json(p.payload as never) : null}::jsonb,
                   'bug', 'acceptance canary probe', 'synthetic row; never written', ${post}::bigint) AS admits`;
        const ts = implementationReadinessAdmitsClaim({
          payload: p.payload ?? {}, kind: 'bug', title: 'acceptance canary probe',
          summary: 'synthetic row; never written', createdAtMs: post,
        });
        verdicts.push({ probe: p.probe, sql: Boolean(r?.admits), ts, expect: p.expectAdmit });
      }
      steps.push({ step, ok: verdicts.length > 0 && verdicts.every((v) => v.sql === v.expect && v.ts === v.expect), evidence: { verdicts } });
    } catch (error) {
      steps.push({ step, ok: false, evidence: { error: String((error as Error)?.message ?? error) } });
    }
  }

  const status = ACCEPTANCE_CANARY_STEPS.every((s) => steps.find((x) => x.step === s)?.ok) ? 'passed' : 'failed';
  const recordedAt = new Date((input.now ?? Date.now)()).toISOString();
  await sql`
    INSERT INTO harness_shared.acceptance_adoption_runs
      (run_id, workspace_id, harness_slug, kind, runtime, build_sha, status, actor, detail, created_at)
    VALUES (${runId}, ${input.workspaceId}, ${input.harnessSlug}, 'canary', ${input.runtime}, ${input.buildSha},
            ${status}, ${input.actor},
            ${sql.json({ schemaVersion: LEGACY_ADOPTION_SCHEMA_VERSION, steps, readinessSchema: IMPLEMENTATION_READINESS_SCHEMA_VERSION } as never)},
            ${recordedAt}::timestamptz)`;
  return { runId, runtime: input.runtime, buildSha: input.buildSha, status, steps, recordedAt };
}

export type EnforcementCutoverAuthorization =
  | { ok: true; receiptRunId: string; runtime: string; buildSha: string | null; recordedAt: string }
  | { ok: false; refusal: 'no-successful-canary-receipt' | 'cutover-precedes-canary'; runtime: string; detail?: string };

/**
 * R-37: the enforcement cutover may move only after a passed canary receipt exists for
 * the named runtime, with all four steps passing, recorded within the freshness window,
 * and no later than the proposed cutover (enforcement never predates its canary).
 */
export async function authorizeEnforcementCutoverAdvance(
  sql: OrgSql,
  input: {
    workspaceId: string;
    harnessSlug: string;
    proposedCutoverMs: number;
    runtime?: string;
    now?: () => number;
    maxReceiptAgeMs?: number;
  },
): Promise<EnforcementCutoverAuthorization> {
  const runtime = input.runtime ?? ACCEPTANCE_CANARY_RUNTIME;
  const nowMs = (input.now ?? Date.now)();
  const maxAge = input.maxReceiptAgeMs ?? ACCEPTANCE_CANARY_MAX_AGE_MS;
  const rows = await sql<{ run_id: string; build_sha: string | null; detail: Record<string, unknown>; created_at: Date | string }[]>`
    SELECT run_id, build_sha, detail, created_at FROM harness_shared.acceptance_adoption_runs
     WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
       AND kind = 'canary' AND status = 'passed' AND runtime = ${runtime}
       AND created_at <= ${new Date(nowMs).toISOString()}::timestamptz
       AND created_at >= ${new Date(nowMs - maxAge).toISOString()}::timestamptz
     ORDER BY created_at DESC
     LIMIT 20`;
  const passed = rows.find((row) => {
    const steps = Array.isArray(record(row.detail).steps) ? (record(row.detail).steps as AcceptanceCanaryStepResult[]) : [];
    return ACCEPTANCE_CANARY_STEPS.every((s) => steps.some((x) => x.step === s && x.ok === true));
  });
  if (!passed) return { ok: false, refusal: 'no-successful-canary-receipt', runtime };
  const recordedAtMs = new Date(passed.created_at).getTime();
  if (input.proposedCutoverMs < recordedAtMs) {
    return { ok: false, refusal: 'cutover-precedes-canary', runtime, detail: `receipt ${passed.run_id} recorded after the proposed cutover` };
  }
  return { ok: true, receiptRunId: passed.run_id, runtime, buildSha: passed.build_sha, recordedAt: new Date(recordedAtMs).toISOString() };
}

/**
 * Static half of R-37: the compiled cutover may differ from the D-018 sentinel only when
 * the code also carries the canary receipt that authorized it.
 */
export function enforcementCutoverAttested(
  cutover: string = IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER,
  attestation: typeof ENFORCEMENT_CUTOVER_CANARY_ATTESTATION = ENFORCEMENT_CUTOVER_CANARY_ATTESTATION,
): { ok: true; enforcing: boolean } | { ok: false; refusal: 'cutover-moved-without-canary-attestation' } {
  if (cutover === ENFORCEMENT_CUTOVER_SENTINEL) return { ok: true, enforcing: false };
  if (!attestation || attestation.runtime !== ACCEPTANCE_CANARY_RUNTIME || !attestation.receiptRunId.trim()) {
    return { ok: false, refusal: 'cutover-moved-without-canary-attestation' };
  }
  if (Date.parse(attestation.recordedAt) > Date.parse(cutover)) {
    return { ok: false, refusal: 'cutover-moved-without-canary-attestation' };
  }
  return { ok: true, enforcing: true };
}
