/**
 * E3 pilot contract on the canonical work-item payload. No separate job ledger.
 * These transitions are pure: the storage adapter must compare-and-write the
 * returned version, authenticate the human, and resolve scorecard receipts.
 * A fixture exercising this contract is never evidence of a live human pilot.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { WorkItem } from './work-items';

const text = z.string().trim().min(1);
const humanId = z.string().uuid();
const claimSchema = z.object({ userId: humanId, claimedAt: text }).strict();
const submissionSchema = z.object({
  result: text.max(32000), sha256: z.string().regex(/^[a-f0-9]{64}$/), submittedAt: text,
}).strict();
const gradeSchema = z.object({
  scorecardRef: text, rubricRef: text, graderId: text,
  submissionSha256: z.string().regex(/^[a-f0-9]{64}$/), passed: z.boolean(),
}).strict();
const paymentSchema = z.object({
  receiptRef: text, paidBy: text, paidAt: text,
  amountCents: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

export const humanMarketJobSchema = z.object({
  route: z.literal('market'), version: z.number().int().nonnegative(),
  brief: text.max(8000), rubricRef: text, ownerUserId: humanId,
  rubricRevision: z.number().int().positive().optional(),
  rubricCriteriaHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  amountCents: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/),
  claim: claimSchema.optional(), submission: submissionSchema.optional(),
  grade: gradeSchema.optional(), payment: paymentSchema.optional(),
}).strict().superRefine((job, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if ((job.rubricRevision == null) !== (job.rubricCriteriaHash == null)) invalid('rubric identity must include revision and criteria hash');
  if (job.claim?.userId === job.ownerUserId) invalid('owner cannot be the external participant');
  if (job.submission && !job.claim) invalid('submission requires a human claim');
  if (job.submission && digest(job.submission.result) !== job.submission.sha256) invalid('submission hash mismatch');
  if (job.grade && (!job.claim || !job.submission || job.grade.submissionSha256 !== job.submission.sha256 ||
    job.grade.rubricRef !== job.rubricRef || job.grade.graderId === humanAssignee(job.claim!.userId) ||
    job.grade.graderId === job.claim!.userId)) invalid('grade must independently cover the exact submission and rubric');
  if (job.payment && (!job.claim || !job.grade?.passed || job.payment.amountCents !== job.amountCents ||
    job.payment.currency !== job.currency || job.payment.paidBy === job.claim.userId ||
    job.payment.paidBy === humanAssignee(job.claim.userId))) {
    invalid('payment requires an independent payer, passing grade and the agreed terms');
  }
});

export type HumanMarketJob = z.infer<typeof humanMarketJobSchema>;
type MarketItem = Pick<WorkItem, 'id' | 'state' | 'payload' | 'assignee'>;
export const humanAssignee = (userId: string): string => `human:${humanId.parse(userId)}`;
const digest = (result: string): string => createHash('sha256').update(result).digest('hex');
const needsHuman = (state: string): boolean => state === 'needs-human' || state === 'needs_human';

/** Malformed/internal owner asks never become market offers by inference. */
export function readHumanMarketJob(item: MarketItem): HumanMarketJob | null {
  const payload = item.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const parsed = humanMarketJobSchema.safeParse((payload as Record<string, unknown>).humanWork);
  return parsed.success ? parsed.data : null;
}

/** Explicit allowlist; never copy an internal title, payload, owner id or logs. */
export function publicHumanMarketOffer(item: MarketItem) {
  const job = readHumanMarketJob(item);
  if (!job || (!needsHuman(item.state) && !(item.state === 'wip' && job.claim)) ||
    (item.assignee && item.assignee !== (job.claim && humanAssignee(job.claim.userId)))) return null;
  return {
    id: item.id, brief: job.brief, rubricRef: job.rubricRef,
    amountCents: job.amountCents, currency: job.currency,
    status: job.payment ? 'paid' : job.grade ? (job.grade.passed ? 'accepted' : 'rejected') :
      job.submission ? 'submitted' : job.claim ? 'claimed' : 'available',
  };
}

function requireJob(item: MarketItem): HumanMarketJob {
  const job = readHumanMarketJob(item);
  if (!job) throw new Error('market_offer_required');
  return job;
}

function requireClaimant(item: MarketItem, userId: string): HumanMarketJob {
  const job = requireJob(item);
  if (!job.claim || job.claim.userId !== humanId.parse(userId) || item.assignee !== humanAssignee(userId)) {
    throw new Error('human_claim_required');
  }
  if (!needsHuman(item.state) && item.state !== 'wip') throw new Error('market_job_not_active');
  return job;
}

export function claimHumanMarketJob(item: MarketItem, userId: string, at: string): HumanMarketJob {
  const id = humanId.parse(userId);
  const job = requireJob(item);
  if (id === job.ownerUserId) throw new Error('external_human_required');
  if (job.claim) return requireClaimant(item, id);
  if (!needsHuman(item.state)) throw new Error('needs_human_required');
  if (item.assignee) throw new Error('claim_conflict');
  return humanMarketJobSchema.parse({ ...job, version: job.version + 1, claim: { userId: id, claimedAt: at } });
}

export function submitHumanMarketJob(item: MarketItem, userId: string, result: string, at: string): HumanMarketJob {
  const job = requireClaimant(item, userId);
  const submission = submissionSchema.parse({ result, sha256: digest(result.trim()), submittedAt: at });
  if (job.submission) {
    if (job.submission.sha256 === submission.sha256) return job;
    throw new Error('submission_already_recorded');
  }
  return humanMarketJobSchema.parse({ ...job, version: job.version + 1, submission });
}

/** The adapter resolves this receipt from scorecards; human HTTP input cannot supply a grade. */
export function gradeHumanMarketJob(item: MarketItem, receipt: z.infer<typeof gradeSchema>): HumanMarketJob {
  const job = requireJob(item);
  if (!job.claim) throw new Error('human_claim_required');
  requireClaimant(item, job.claim.userId);
  if (!job.submission) throw new Error('submission_required');
  if (job.grade) throw new Error('grade_already_recorded');
  return humanMarketJobSchema.parse({ ...job, version: job.version + 1, grade: receipt });
}

/** Manual payment attestation only; this function never transfers money. */
export function recordHumanMarketPayment(item: MarketItem, receipt: z.infer<typeof paymentSchema>): HumanMarketJob {
  const job = requireJob(item);
  if (!job.grade?.passed) throw new Error('passing_grade_required');
  requireClaimant(item, job.claim!.userId);
  if (job.payment) throw new Error('payment_already_recorded');
  return humanMarketJobSchema.parse({ ...job, version: job.version + 1, payment: receipt });
}
