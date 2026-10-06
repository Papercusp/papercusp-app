/** E3 uses the existing work_items row and its CDC; no separate jobs table. */
import type { getOrgPg } from '@papercusp/db-org';
import { boundedOrgTxn } from './pg-bounded-txn';
import { admittedWhereSql } from './work-items-admission';
import { CLAIM_SUBJECT_BASELINE_KEY } from './claim-subject-baseline';
import {
  claimHumanMarketJob, gradeHumanMarketJob, humanAssignee, readHumanMarketJob,
  recordHumanMarketPayment, submitHumanMarketJob, type HumanMarketJob,
} from './work-items-human-market';
import { issuesScopeWorkspace } from './issues-engineer';
import { getRubric } from './rubrics';
import { ratingVerdict, readScorecardEvidence } from './scorecards';
import { resolveAcceptanceGraderEligibility } from './agent-tools/scorecards/grader-eligibility';

type Sql = ReturnType<typeof getOrgPg>['sql'];
export interface HumanMarketItem {
  id: string;
  state: string;
  assignee: string | null;
  payload: Record<string, unknown>;
}
interface Row {
  feature_id: string;
  status: string;
  taken_by: string | null;
  payload: Record<string, unknown>;
}
const itemFromRow = (row: Row): HumanMarketItem => ({
  id: row.feature_id, state: row.status, assignee: row.taken_by, payload: row.payload,
});
interface Scope { workspaceId: string; harness: string; id: string }

function requireScope(scope: Scope): void {
  if (!scope.workspaceId.trim() || scope.workspaceId === '*' || !scope.harness.trim() || scope.harness === '*') {
    throw new Error('market_scope_required');
  }
}

async function readItem(sql: Sql, scope: Scope): Promise<HumanMarketItem | null> {
  requireScope(scope);
  const rows = await sql<Row[]>`
    SELECT feature_id, status, taken_by, payload
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harness}
       AND feature_id = ${scope.id}
       AND COALESCE(origin, 'local') = 'local'
       AND ${admittedWhereSql(sql)}
       AND payload->>'humanWork' IS NOT NULL
       AND claim_hold IS NOT TRUE`;
  return rows[0] ? itemFromRow(rows[0]) : null;
}

export async function getHumanMarketItem(scope: Scope): Promise<HumanMarketItem | null> {
  return boundedOrgTxn((sql) => readItem(sql, scope));
}

/**
 * Only an authenticated HTTP session supplies userId. The offer version comes
 * from the terms the person saw. CAS also compares the entire stored offer,
 * lifecycle and holder, so editing terms without bumping version cannot race
 * this write. Unrelated payload keys are merged in PostgreSQL, never replaced.
 */
export async function actOnHumanMarketItem(input: Scope & {
  userId: string;
  version: number;
  action: 'claim' | 'submit';
  result?: string;
}): Promise<HumanMarketItem> {
  return boundedOrgTxn(async (sql) => {
    const before = await readItem(sql, input);
    if (!before) throw new Error('market_offer_required');
    const job = readHumanMarketJob(before);
    if (!job) throw new Error('market_offer_required');
    if (job.version !== input.version) throw new Error('market_offer_changed');
    const at = new Date().toISOString();
    const next = input.action === 'claim'
      ? claimHumanMarketJob(before, input.userId, at)
      : submitHumanMarketJob(before, input.userId, input.result ?? '', at);
    if (next.version === job.version) return before;
    const claiming = input.action === 'claim';
    return writeJob(sql, input, before, next, claiming);
  });
}

async function writeJob(sql: Sql, scope: Scope, before: HumanMarketItem, next: HumanMarketJob, claiming = false) {
    const rows = await sql<Row[]>`
      UPDATE harness_shared.work_items
         SET payload = COALESCE(payload, '{}'::jsonb)
               || jsonb_build_object('humanWork', ${JSON.stringify(next)}::text::jsonb)
               || CASE WHEN ${claiming} THEN jsonb_build_object(
                    ${CLAIM_SUBJECT_BASELINE_KEY}::text, jsonb_build_object(
                      'kind', item_kind, 'title', COALESCE(title, ''),
                      'summary', COALESCE(summary, ''), 'body', COALESCE(summary, ''),
                      'watchdogKey', CASE WHEN jsonb_typeof(payload->'watchdogKey') = 'string'
                        THEN payload->>'watchdogKey' ELSE NULL END),
                    'claim_history_post_id', COALESCE((
                      SELECT max(id) FROM harness_shared.coord_thread_posts
                       WHERE workspace_id = ${scope.workspaceId}), 0))
                  ELSE '{}'::jsonb END,
             status = 'wip', taken_by = ${humanAssignee(next.claim!.userId)},
             taken_at = CASE WHEN ${claiming} THEN now() ELSE taken_at END,
             last_progress_at = now(), updated_ts = ${Date.now()}
       WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harness}
         AND feature_id = ${scope.id}
         AND status = ${before.state}
         AND taken_by IS NOT DISTINCT FROM ${before.assignee}
         AND payload->'humanWork' = ${JSON.stringify(before.payload.humanWork)}::text::jsonb
         AND COALESCE(origin, 'local') = 'local'
         AND ${admittedWhereSql(sql)}
         AND claim_hold IS NOT TRUE
      RETURNING feature_id, status, taken_by, payload`;
    if (!rows[0]) throw new Error('market_offer_changed');
    // The canonical base-table trigger captures this write under the existing
    // family-specific wire name and invalidates the work-item sync queries.
    return itemFromRow(rows[0]);
}

/** A canonical card must cite the immutable human result in every criterion. */
async function resolveGrade(scope: Scope, job: HumanMarketJob, scorecardRef: string) {
  if (!job.submission || !job.claim) throw new Error('submission_required');
  if (!job.rubricRevision || !job.rubricCriteriaHash) throw new Error('market_rubric_identity_required');
  // The existing scorecard/rubric stores use the issues workspace. Refuse an
  // ambient mismatch instead of reading a same-id receipt from another tenant.
  if (issuesScopeWorkspace() !== scope.workspaceId) throw new Error('market_scope_required');
  const [evidence, rubric] = await Promise.all([readScorecardEvidence(scorecardRef), getRubric(job.rubricRef)]);
  if (evidence.kind !== 'found' || !rubric || rubric.workspaceId !== scope.workspaceId ||
      rubric.status !== 'active') throw new Error('market_scorecard_required');
  const card = evidence.scorecard;
  if (!card.createdBy || [job.ownerUserId, job.claim.userId, humanAssignee(job.claim.userId)].includes(card.createdBy) ||
      card.rubricRef !== job.rubricRef || card.subject?.kind !== 'work-item' || card.subject.ref !== scope.id ||
      !card.auditTarget.current || card.synthesized || card.provisional ||
      (card.gradingAudit && card.gradingAudit.state !== 'passed') ||
      !card.rubricResolved || card.missingKeys.length || card.extraKeys.length || !card.criteria.length ||
      rubric.revision !== job.rubricRevision || rubric.criteriaHash !== job.rubricCriteriaHash ||
      card.rubricRevision !== job.rubricRevision || card.criteriaHash !== job.rubricCriteriaHash ||
      !(Date.parse(card.createdAt) >= Date.parse(job.submission.submittedAt)) ||
      !card.criteria.every(criterion => criterion.evidence.includes(`submission-sha256:${job.submission!.sha256}`))) {
    throw new Error('market_scorecard_mismatch');
  }
  if (rubric.kind === 'acceptance') {
    const eligibility = await resolveAcceptanceGraderEligibility({ rubric,
      callerId: card.createdBy, workspaceId: scope.workspaceId });
    if (eligibility.refusal || eligibility.callerIsImplementer) throw new Error('market_grader_not_independent');
  }
  const verdicts = card.criteria.map(criterion => ratingVerdict(criterion.rating));
  if (verdicts.some(verdict => verdict !== 'pass' && verdict !== 'fail')) throw new Error('market_grade_unsettled');
  return { scorecardRef: card.issueId, rubricRef: card.rubricRef, graderId: card.createdBy,
    submissionSha256: job.submission.sha256, passed: verdicts.every(verdict => verdict === 'pass') };
}

/** Owner cookie attests payment; this adapter never initiates a money transfer. */
export async function reviewHumanMarketItem(input: Scope & {
  userId: string; version: number;
} & ({ action: 'grade'; scorecardRef: string } | { action: 'payment'; receiptRef: string })): Promise<HumanMarketItem> {
  return boundedOrgTxn(async sql => {
    const before = await readItem(sql, input);
    const job = before && readHumanMarketJob(before);
    if (!before || !job) throw new Error('market_offer_required');
    if (job.ownerUserId !== input.userId) throw new Error('market_owner_required');
    if (job.version !== input.version) throw new Error('market_offer_changed');
    let next: HumanMarketJob;
    if (input.action === 'grade') {
      next = gradeHumanMarketJob(before, await resolveGrade(input, job, input.scorecardRef));
    } else {
      if (!job.grade?.passed) throw new Error('passing_grade_required');
      // Retraction, rubric edits, supersession or failed audit after grading
      // prevent payment from treating an obsolete grade as current evidence.
      const current = await resolveGrade(input, job, job.grade.scorecardRef);
      if (!current.passed || current.graderId !== job.grade.graderId) throw new Error('market_grade_unsettled');
      next = recordHumanMarketPayment(before, { receiptRef: input.receiptRef.trim(),
        paidBy: input.userId, paidAt: new Date().toISOString(), amountCents: job.amountCents, currency: job.currency });
    }
    return writeJob(sql, input, before, next);
  });
}
