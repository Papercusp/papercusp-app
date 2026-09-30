/** Rollout admission reuses immutable approval artifacts and the scorecard ledger.
 * This admits NEW obligations; it never waives an existing completion failure. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { artifactBytes, designAcceptanceRoot, readBrowserFileRun } from './acceptance';
import type { DesignApprovalScope } from './ratification';
import type { ScorecardEvidenceReadResult } from '../scorecards';

export const DESKTOP_CANARY = {
  harnessSlug: 'papercusp', featureId: 'desktop-design-fidelity-repair-2026-09-08',
  referenceId: 'desktop-option-b', targetRoute: '/?app=desktops',
  contentSha256: '606532c975779beb47eb0b1edda8f4ef61dc95d72071fec343774443a0b2d663',
} as const;
export const DESIGN_ROLLOUT_REVIEW_RUBRIC = 'acceptance-design-acceptance-journey-enforcement-2026-09-08';
export const DESIGN_ROLLOUT_CONTROLS = [
  'empty-host-entry', 'wrong-route', 'missing-reference', 'failed-item-aggregation',
  'stale-build', 'missing-responsive-state', 'placeholder-as-working',
] as const;
const text = z.string().trim().min(1);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const artifact = z.object({ path: text, sha256: sha }).strict();
const cohort = z.object({
  harnessSlug: text, featureId: text, planSlug: text,
  planItemIds: z.array(z.string().regex(/^P-\d{3,}$/)).min(1).max(40),
  targetRoute: z.string().regex(/^\/(?!\/)/),
}).strict().refine(row => row.featureId === row.planSlug && new Set(row.planItemIds).size === row.planItemIds.length, 'exact unique implementing scope required');
export const designRolloutPolicySchema = z.object({
  schemaVersion: z.literal(1), version: text, author: text,
  scopeMode: z.literal('explicit-approval'),
  historical: z.object({
    unadopted: z.literal('preserve-existing-policy'),
    adopted: z.literal('preserve-obligation'),
    migration: z.literal('new-approved-revision'),
  }).strict(),
  canary: z.object({
    featureId: z.literal(DESKTOP_CANARY.featureId),
    referenceSha256: z.literal(DESKTOP_CANARY.contentSha256),
    original: z.object({ buildId: text, testRunRef: z.string().regex(/^test-run:\d+$/), outcome: z.literal('fail') }).strict(),
    repaired: z.object({ buildId: text, testRunRef: z.string().regex(/^test-run:\d+$/), outcome: z.literal('pass') }).strict(),
    evidence: artifact,
    connectivity: z.literal('not-established'),
  }).strict().refine(row => row.original.buildId !== row.repaired.buildId && row.original.testRunRef !== row.repaired.testRunRef, 'distinct measured canary pair required'),
  controls: z.array(z.object({
    id: z.enum(DESIGN_ROLLOUT_CONTROLS), evidence: artifact,
    negative: z.literal('fail'), repaired: z.literal('pass'),
  }).strict()).length(DESIGN_ROLLOUT_CONTROLS.length)
    .refine(rows => new Set(rows.map(row => row.id)).size === DESIGN_ROLLOUT_CONTROLS.length, 'complete unique negative-control census required'),
  authorGuidance: artifact,
  cohorts: z.array(cohort).max(10),
  exceptions: z.array(z.object({
    id: text, version: z.number().int().positive(), scope: cohort,
    disposition: z.literal('defer-new-adoption'), owner: text, reason: text, approvalRef: text,
    startsAt: z.string().datetime(), expiresAt: z.string().datetime(),
  }).strict().refine(row => {
    const duration = Date.parse(row.expiresAt) - Date.parse(row.startsAt);
    return duration > 0 && duration <= 7 * 24 * 60 * 60 * 1000;
  }, 'exceptions must expire within seven days')).max(16),
}).strict();
export type DesignRolloutPolicy = z.infer<typeof designRolloutPolicySchema>;
export type RolloutAdmission = { satisfied: boolean; reason: string };
export type RolloutScope = {
  harnessSlug: string; featureId: string; referenceId: string; contentSha256: string;
  approval: DesignApprovalScope; actorId: string;
};
const matches = (row: z.infer<typeof cohort>, scope: RolloutScope) =>
  row.harnessSlug === scope.harnessSlug && row.featureId === scope.featureId &&
  row.planSlug === scope.approval.planSlug && row.targetRoute === scope.approval.targetRoute &&
  scope.approval.planItemIds.every(id => row.planItemIds.includes(id));

/** Pure policy judgment. Review identity/content come from the existing ledger,
 * never from fields an approval caller supplies as their own review. */
export function evaluateDesignRollout(input: {
  policy: unknown; policySha256: string; review: ScorecardEvidenceReadResult;
  scope: RolloutScope; now: number;
}): RolloutAdmission {
  const fail = (reason: string) => ({ satisfied: false, reason });
  const parsed = designRolloutPolicySchema.safeParse(input.policy);
  if (!parsed.success) return fail('invalid-rollout-policy');
  const policy = parsed.data;
  if (input.review.kind !== 'found') return fail('independent-review-missing');
  const review = input.review.scorecard;
  if (review.rubricRef !== DESIGN_ROLLOUT_REVIEW_RUBRIC || !review.rubricResolved ||
      review.subject?.kind !== 'plan' || review.subject.ref !== 'design-acceptance-journey-enforcement-2026-09-08' ||
      !review.createdBy || review.createdBy === policy.author || review.createdBy === input.scope.actorId ||
      review.synthesized || review.provisional || review.retracted ||
      (review.gradingAudit && review.gradingAudit.state !== 'passed') ||
      review.missingKeys.length || review.extraKeys.length) return fail('independent-review-invalid');
  const requiredCriteria = ['r-1', 'r-2', 'r-3', 'r-4', 'r-5'];
  if (review.criteria.length !== requiredCriteria.length || requiredCriteria.some(key =>
      review.criteria.filter(row => row.key === key && row.rating === 'healthy').length !== 1)) return fail('independent-review-incomplete');
  const grade = review.criteria.find(row => row.key === 'r-5');
  // A JSON attestation inside the criterion's existing evidence field binds the
  // complete reviewed policy bytes. Ordinary prose is deliberately insufficient.
  try {
    const attestation = JSON.parse(grade?.evidence ?? '');
    if (attestation.designRolloutPolicySha256 !== input.policySha256 ||
        attestation.verdict !== 'accepted' || attestation.canaryGrade !== 'pass') return fail('policy-review-mismatch');
  } catch { return fail('policy-review-mismatch'); }
  if (!Number.isFinite(input.now)) return fail('rollout-clock-unavailable');
  if (policy.exceptions.some(row => Date.parse(row.expiresAt) <= input.now)) return fail('expired-rollout-exception');
  if (policy.exceptions.some(row => matches(row.scope, input.scope) && Date.parse(row.startsAt) <= input.now)) return fail('adoption-explicitly-deferred');
  if (!policy.cohorts.some(row => matches(row, input.scope))) return fail('outside-reviewed-cohort');
  return { satisfied: true, reason: 'independently-reviewed-cohort' };
}

/** Called before ratification writes. Historical references stay historical;
 * existing adopted references are never weakened by a later policy change. */
export async function readDesignRolloutAdmission(scope: RolloutScope, deps: {
  now: number; root?: string; readReview?: (id: string) => Promise<ScorecardEvidenceReadResult>;
  readRun?: typeof readBrowserFileRun;
}): Promise<RolloutAdmission> {
  if (scope.harnessSlug === DESKTOP_CANARY.harnessSlug && scope.featureId === DESKTOP_CANARY.featureId &&
      scope.referenceId === DESKTOP_CANARY.referenceId && scope.contentSha256 === DESKTOP_CANARY.contentSha256 &&
      scope.approval.planSlug === DESKTOP_CANARY.featureId && scope.approval.targetRoute === DESKTOP_CANARY.targetRoute) {
    return { satisfied: true, reason: 'desktop-canary' };
  }
  const descriptor = scope.approval.rollout;
  if (!descriptor) return { satisfied: false, reason: 'rollout-registration-required' };
  try {
    const root = deps.root ?? await designAcceptanceRoot(scope.harnessSlug);
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const bytes = await artifactBytes(root, descriptor.policyPath);
    if (digest(bytes) !== descriptor.policySha256) return { satisfied: false, reason: 'stale-rollout-policy' };
    const parsed = designRolloutPolicySchema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!parsed.success) return { satisfied: false, reason: 'invalid-rollout-policy' };
    for (const ref of [parsed.data.canary.evidence, parsed.data.authorGuidance, ...parsed.data.controls.map(row => row.evidence)]) {
      if (digest(await artifactBytes(root, ref.path)) !== ref.sha256) return { satisfied: false, reason: 'stale-rollout-evidence' };
    }
    const saved = JSON.parse((await artifactBytes(root, parsed.data.canary.evidence.path)).toString('utf8'));
    const canary = parsed.data.canary;
    const entries = ['clean', 'canonical', 'legacy', 'persisted', 'reload', 'history'];
    if (saved.original?.build?.buildId !== canary.original.buildId ||
        saved.positive?.build?.buildId !== canary.repaired.buildId || saved.positive?.status !== 'pass' ||
        `test-run:${saved.original?.testRunId}` !== canary.original.testRunRef ||
        `test-run:${saved.positive?.testRunId}` !== canary.repaired.testRunRef ||
        entries.some(scenario => {
          const id = `desktop.entry.${scenario}`;
          const cases = saved.original?.cases?.filter((row: { scenarioId: string }) => row.scenarioId === id);
          return cases?.length !== 1 || !cases[0].shellReady || cases[0].desktopWorkspacePresent !== false ||
            !saved.positive?.scenarioIds?.includes(id);
        })) return { satisfied: false, reason: 'canary-pair-unproven' };
    for (const pair of [canary.original, canary.repaired]) {
      const run = await (deps.readRun ?? readBrowserFileRun)(Number(pair.testRunRef.slice('test-run:'.length)));
      if (!run || run.framework !== 'playwright' || run.status !== pair.outcome || run.filePath !== saved.sourceTest) {
        return { satisfied: false, reason: 'canary-browser-run-unproven' };
      }
    }
    const readReview = deps.readReview ?? (await import('../scorecards')).readScorecardEvidence;
    const review = await readReview(descriptor.reviewCardRef);
    return evaluateDesignRollout({ policy: parsed.data, policySha256: descriptor.policySha256, review, scope, now: deps.now });
  } catch { return { satisfied: false, reason: 'rollout-evidence-unavailable' }; }
}
