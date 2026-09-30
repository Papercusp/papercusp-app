/**
 * rubrics:amend — patch ONE criterion field and/or the rubric-level methodRef
 * without the whole-document rubrics:propose replace (rubric-system-improvements-
 * 2026-07-12 P-003). The replace ceremony (refetch → resubmit every criterion →
 * ack loss-guards) deterred a same-day one-paragraph amendment; small rubric
 * improvements were being skipped. Amending preserves the stored lifecycle
 * status — an active rubric stays active.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  amendRubric,
  getRubric,
  mintAmendmentIdempotencyKey,
  previewAcceptanceBarAmendment,
  rubricCompleteness,
  AMENDABLE_CRITERION_FIELDS,
  type AmendRubricInput,
} from '../../rubrics';
import { trackAmendRun } from './amend-receipts';
import { refineEvenWithShapeIssues } from '../_refine-with-shape-issues';
import { validateRubricReplicationSql } from '../../rubrics-replication-sql';
import { trackDetached } from '../../detached-imports';
import { requirementCriterionInputSchema, requirementAmendmentSchema } from '../plans/rubric-template';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { lintAcceptanceCriterionMethods } from '../../rubrics-method-lint';
import { runtimeVettingFindings } from '../../acceptance-runtime-citation';
import { openAcceptanceBarAmendmentReview } from '../../consult/acceptance-bar-amendment-review';

/** P-006: the requirement this dry run still owes when nobody has opened its review. */
const REVIEW_NOT_REQUESTED_NEXT =
  "Post preview.approval once as a work_items:comment, then repeat this dry run with reviewPreviewPost:'thread-post:<that post id>'. The relevance router picks and screens the outside-lineage reviewer; do not pick or message one yourself.";

/** The amendment fields exactly as requested, so a routed reviewer can reproduce the preview. */
function amendmentPatch(args: z.infer<typeof rubricsAmendArgs>): Record<string, unknown> {
  const fields = ['requirement', 'criteria', 'criterion', 'criterionClass', 'criterionEvidencePlane', 'methodRef', 'classRef', 'composes'] as const;
  return Object.fromEntries(fields.filter((field) => args[field] !== undefined).map((field) => [field, args[field]]));
}

const amendmentCriterionSchema = requirementCriterionInputSchema;

// RSR-P-008-A: refineEvenWithShapeIssues so a request with a shape defect AND an
// invalid field combination is refused naming both, not one per round-trip.
export const rubricsAmendArgs = refineEvenWithShapeIssues(
  z.object({
    rubricRef: z.string().min(1).max(120).describe('the rubric ref/slug to amend'),
    requirement: requirementAmendmentSchema
      .optional()
      .describe(
        'patch one requirement Intent, Acceptance or Verification; promise changes use the BAR amendment transaction',
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        'Preview a BAR meaning amendment without writing; returns exact approval JSON. If approvalRequired, post preview.approval once as a work_items:comment and repeat the dry run with reviewPreviewPost to open the routed review (guidance.chaining).',
      ),
    reviewPreviewPost: z
      .string()
      .trim()
      .regex(/^thread-post:[1-9][0-9]*$/)
      .optional()
      .describe(
        "dryRun only: thread-post:<id> of your post carrying this preview's approval JSON. When approval is required, the relevance router opens a lineage-screened review for it; returns review { state, conversationId, screenedOut, next }.",
      ),
    reviewerModel: z.object({
      agent: z.enum(['claude', 'codex', 'omp']),
      model: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    }).strict().optional().describe(
      'dryRun reviewPreviewPost only: require this allowed backend/model and optional reasoning effort for routed and fresh reviewers; an unavailable model refuses instead of changing the requested choice.',
    ),
    criteria: z
      .array(amendmentCriterionSchema)
      .min(1)
      .max(200)
      .optional()
      .describe(
        'acceptance-kind only: replace the COMPLETE criterion set through the atomic BAR amendment transaction. Use this when adding a BAR or binding structured checks across the set; read rubrics:get first and resubmit every stored criterion. Alias contract: prefer structured intent/acceptance/verification sections and omit legacy top-level aliases; when both forms are supplied, corresponding values (`bar`/`model`↔`acceptance.condition`, `driftMarkers`↔`acceptance.falsifier`, and verification fields) must match after canonical normalization or validation fails with `requirement_alias_conflict`',
      ),
    criterionEvidencePlane: z
      .object({ key: z.string().min(1), evidencePlane: z.enum(['tree', 'deployed', 'live']) })
      .optional()
      .describe(
        'change one acceptance criterion structural evidence plane through the canonical BAR amendment transaction',
      ),
    criterion: z
      .object({
        key: z.string().min(1).describe('the criterion key (must exist — keys are identity, not amendable)'),
        field: z.enum(AMENDABLE_CRITERION_FIELDS).describe('which prose field to patch'),
        mode: z
          .enum(['append', 'replace'])
          .describe(
            "'append' adds text as a new paragraph (never guarded); 'replace' swaps the whole field (shrink-guarded)",
          ),
        text: z.string().min(1).max(20000).describe('the text to append / the full replacement text'),
      })
      .optional()
      .describe('patch one criterion field'),
    criterionClass: z
      .object({
        key: z.string().min(1).describe('the criterion key (must exist)'),
        class: z.enum(['settle-once', 'violatable']),
      })
      .optional()
      .describe(
        "set one criterion's grading class (P-008). UPGRADE-ONLY here: tagging 'violatable' tightens grading, so it keeps status + ratifier; downgrading a stored 'violatable' is refused — use rubrics:propose with classDowngradeReason",
      ),
    methodRef: z
      .string()
      .max(200)
      .optional()
      .describe('set/replace the agent-insights runbook slug for the rubric-level method'),
    classRef: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'acceptance-kind only: bind a missing class to an existing standard rubric while preserving every BAR and criterion; an existing class may be repeated but not replaced',
      ),
    composes: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(16)
      .optional()
      .describe(
        'replace the unpinned composition refs with existing standard-kind rubric ids; omit to preserve the current list (revision pins are intentionally not supported)',
      ),
    allowMethodShrink: z
      .boolean()
      .optional()
      .describe(
        "loss-guard ack for mode:'replace' that shrinks a procedure >40% or drops its REPLICATION DRILL marker; requires shrinkReason",
      ),
    shrinkReason: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('why the shrink is intentional (required with allowMethodShrink)'),
    reason: z
      .string()
      .min(1)
      .max(4000)
      .optional()
      .describe('reason for a started-BAR meaning amendment; recorded on the subject-plan Decision'),
    expectedRubricRevision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('optimistic CAS for the acceptance-rubric plan revision'),
    expectedSubjectPlanRevision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('optimistic CAS for the subject-plan revision'),
    idempotencyKey: z.string().min(1).max(200).optional().describe('stable replay token for a started-BAR amendment'),
    approvalRef: z
      .string()
      .min(1)
      .max(240)
      .optional()
      .describe(
        'thread-post:<id> containing the preview approval JSON, authored by an authenticated outside-lineage reviewer. This authorizes a patch but is not itself a patch; include at least one amendment field.',
      ),
    approvedBy: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'optional assertion of the reviewer identity; must match the approval post author. On dryRun:true it also returns approverEligibility for that identity, a diagnostic: the routed review screens every candidate itself. approvedBy equal to the caller yields { selfScreen:true, eligible:null }, which is no verdict. relatedVia:"caller" is curable with an unrelated applier (WI-10002357).',
      ),
    approvedAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('legacy hint; authoritative approval time is always read from the post'),
    faultInjection: z
      .enum(['after-decision', 'after-rubric', 'after-projection', 'after-rebind'])
      .optional()
      .describe('test-only rollback probe'),
  }),
  (args, ctx) => {
    if (args.requirement && (args.criteria || args.criterion || args.criterionClass || args.criterionEvidencePlane)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requirement'],
        message: 'requirement amendment cannot be combined with other criterion patches',
      });
    }
    if (args.criteria && (args.criterion || args.criterionClass || args.criterionEvidencePlane)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria'],
        message:
          'criteria is the complete replacement set and cannot be combined with criterion, criterionClass, or criterionEvidencePlane patches',
      });
    }
    const hasPatch =
      args.requirement !== undefined ||
      args.criteria !== undefined ||
      args.criterionEvidencePlane !== undefined ||
      args.criterion !== undefined ||
      args.criterionClass !== undefined ||
      args.methodRef !== undefined ||
      args.classRef !== undefined ||
      args.composes !== undefined;
    if (!hasPatch) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message:
          'nothing to amend — include at least one amendment field; approvalRef authorizes a patch but does not supply one',
      });
    }
    if (args.reviewPreviewPost !== undefined && args.dryRun !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewPreviewPost'],
        message: 'reviewPreviewPost opens the review for a preview, so it requires dryRun:true',
      });
    }
    if (args.reviewerModel && !args.reviewPreviewPost) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reviewerModel'],
        message: 'reviewerModel requires dryRun:true and reviewPreviewPost' });
    }
  },
);

export default defineTool({
  name: 'rubrics:amend',
  profile: 'engineer',
  description:
    'Patch one rubric criterion/requirement, complete acceptance criteria, evidence plane, or rubric refs. An approvalRef authorizes a patch but never substitutes for one; include at least one amendment field. Use rubrics:propose for standard rubric criteria, key, or rating changes. A started BAR meaning change needs outside-lineage approval first (guidance.chaining has the steps). Subject Decision, BAR/spec revisions, and rebind commit atomically; old proof/grades remain history and the existing shrink guard applies.',
  guidance: {
    returns:
      "{ ok, rubric, completeness, replicationSqlCheck, methodLint, idempotencyKey }. methodLint is a non-blocking advisory for acceptance methods that prescribe native shell commands (judges cannot run shell; MCP tools such as testing:run stay valid). An amend or dry-run preview still running after ~40s returns { ok:true, pending:true, receipt } instead of timing out: the work continues server-side; poll rubrics:amend-status { rubricRef, idempotencyKey } and do not re-issue while it reads running. A dry run with reviewPreviewPost adds review { state, conversationId, previewPostRef, screenedOut, next }. The resolver loads the immutable preview in the same workspace and checks every changed BAR hash against the current delta; authorship/time come from the reviewer post.",
    when: 'A targeted acceptance-BAR change, evidence-plane binding, or rubric-ref update.',
    notWhen:
      'For standard rubric criteria, key, or rating changes use rubrics:propose. Complete `criteria` is acceptance-only and must preserve stored keys unless removal is explicitly allowed.',
    chaining:
      "rubrics:get → rubrics:amend. Started BAR: amend { dryRun:true } → if approvalRequired, post preview.approval once as a work_items:comment → re-run dryRun with reviewPreviewPost:'thread-post:<that post id>'; the relevance router picks an outside-lineage reviewer → follow review.next → reviewer answers `approve thread-post:<preview-post-id>` → apply with amend { approvalRef:'thread-post:<answer post id>' }. Posts are immutable and resolved by workspace/id, which avoids hash transcription; server checks preview vs applied delta. A payload needs payloadTier (unreadable in some views); a post is visible on every surface. Never pick or message a reviewer yourself. Do not create a counter-sign work-item for approval.",
    seeAlso: [
      'rubrics:propose (whole-document revision)',
      'rubrics:get (read before amending)',
      'work_items:comment (post the exact approval JSON as a Threadable body)',
      'conversations:get (find the routed reviewer answer post id)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: rubricsAmendArgs,
  // Structural shape behind `guidance.returns` (guidance-output-schema-live-guard).
  // OPEN on purpose: the dry-run, applied and receipt arms carry different fields.
  result: z
    .object({
      ok: z.boolean(),
      error: z.string().optional(),
      rubric: z.record(z.string(), z.unknown()).optional(),
      completeness: z.record(z.string(), z.unknown()).optional(),
      replicationSqlCheck: z.unknown().optional(),
      methodLint: z.array(z.record(z.string(), z.unknown())).optional(),
      idempotencyKey: z.string().optional(),
      pending: z.boolean().optional(),
      receipt: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    // ⚠ DO NOT pass `by: id.ownerId` here. AMENDING IS NOT AUTHORING (EI-10746 follow-on,
    // 2026-07-12). A rubric persists as a PLAN, and a plan has ONE `owner` — so
    // planRowToRubric projects createdBy AND proposedBy AND ratifiedBy from that single
    // field (rubrics.ts:213-215). Forcing `by` to the caller therefore silently TRANSFERS
    // AUTHORSHIP of the rubric to whoever amends it.
    //
    // That is not cosmetic: D-012 requires a NON-AUTHOR to ratify. So a reviewer who
    // improves a rubric before ratifying it — exactly the diligent path — becomes its
    // recorded author, and their ratification is silently converted into the
    // SELF-RATIFICATION the rule exists to forbid. The act of reviewing well disqualified
    // the reviewer. Observed live: a non-author ratifier amended blender-release-readiness
    // and instantly became its createdBy/proposedBy, erasing su-eb9b7ae3.
    //
    // amendRubric already does the right thing on its own (`input.by ?? stored.createdBy`,
    // rubrics.ts:801) — that fallback preserves the original author. It was simply DEAD,
    // because this wrapper always supplied `by`. Omitting it lets the guard actually run.
    //
    // Who amended is not lost: per D-002 the plan's revision spine carries the edit history.
    // (The deeper defect — that proposedBy/ratifiedBy are unrepresentable because all three
    // identities collapse onto plan.owner, making D-012 unauditable — is tracked separately.)
    const identity = resolveAgentIdentity(ctx); // authz/identity side-effects + a clear failure if unidentified
    const input: AmendRubricInput = {
      rubricId: args.rubricRef,
      ...(args.requirement ? { requirement: args.requirement } : {}),
      ...(args.criteria ? { criteria: args.criteria } : {}),
      ...(args.criterion ? { criterion: args.criterion } : {}),
      ...(args.criterionClass ? { criterionClass: args.criterionClass } : {}),
      ...(args.criterionEvidencePlane ? { criterionEvidencePlane: args.criterionEvidencePlane } : {}),
      ...(args.methodRef !== undefined ? { methodRef: args.methodRef } : {}),
      ...(args.classRef !== undefined ? { classRef: args.classRef } : {}),
      ...(args.composes !== undefined ? { composes: args.composes } : {}),
      ...(args.allowMethodShrink !== undefined ? { allowMethodShrink: args.allowMethodShrink } : {}),
      ...(args.shrinkReason !== undefined ? { shrinkReason: args.shrinkReason } : {}),
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      ...(args.expectedRubricRevision !== undefined ? { expectedRubricRevision: args.expectedRubricRevision } : {}),
      ...(args.expectedSubjectPlanRevision !== undefined
        ? { expectedSubjectPlanRevision: args.expectedSubjectPlanRevision }
        : {}),
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      ...(args.approvalRef !== undefined ? { approvalRef: args.approvalRef } : {}),
      ...(args.approvedBy !== undefined ? { approvedBy: args.approvedBy } : {}),
      ...(args.approvedAt !== undefined ? { approvedAt: args.approvedAt } : {}),
      ...(args.faultInjection !== undefined ? { faultInjection: args.faultInjection } : {}),
      checkPathRoot: resolveAgentWorkspaceRoot(ctx),
      actorId: identity.ownerId,
    };
    if (args.dryRun) {
      const receiptKey = 'preview-' + randomUUID();
      const run = trackAmendRun(receiptKey, args.rubricRef, async (): Promise<Record<string, unknown>> => {
        const preview = await previewAcceptanceBarAmendment(input);
        if (preview === null) {
          return {
            ok: false,
            dryRun: true,
            code: 'rubric_not_found',
            error: `no rubric '${args.rubricRef}' — rubrics:list to see refs`,
            rubricRef: args.rubricRef,
          };
        }
        if (!args.reviewPreviewPost) {
          return {
            ok: true,
            dryRun: true,
            preview,
            ...(preview.approvalRequired ? { review: { state: 'not-requested', next: REVIEW_NOT_REQUESTED_NEXT } } : {}),
          };
        }
        if (!identity.workspaceId) {
          throw new Error('acceptance_bar_amendment_review_unscoped: a routed review needs a concrete workspace identity');
        }
        const review = await openAcceptanceBarAmendmentReview({
          rubricRef: args.rubricRef,
          previewPostRef: args.reviewPreviewPost,
          preview,
          ...(args.reason ? { reason: args.reason } : {}),
          patch: amendmentPatch(args),
          identity,
          workspaceId: identity.workspaceId,
          // WI-10003299: a fresh-reviewer launch reuses this call's context,
          // re-attributed to the review's system principal.
          launchCtx: ctx,
          ...(args.reviewerModel ? { reviewerModel: args.reviewerModel } : {}),
        });
        return { ok: true, dryRun: true, preview, review };
      });
      const settled = await settleWithin(run, amendForegroundBudgetMs());
      if (settled.kind === 'rejected') throw settled.error;
      const payload = settled.kind === 'resolved'
        ? settled.value
        : {
            ok: true,
            dryRun: true,
            pending: true,
            idempotencyKey: receiptKey,
            receipt: {
              idempotencyKey: receiptKey,
              rubricRef: args.rubricRef,
              poll: { tool: 'rubrics:amend-status', args: { rubricRef: args.rubricRef, idempotencyKey: receiptKey } },
            },
            note:
              'The dry-run preview is still running after ' + Math.round(amendForegroundBudgetMs() / 1000) +
              's and continues server-side. Poll rubrics:amend-status with this receipt; dryRun applies no writes.',
          };
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
    }
    // RSR-P-008-C: hold a receipt BEFORE the work starts. An amend that outlives
    // the foreground budget returns that receipt instead of letting the transport
    // time out with an unknown commit state; the work keeps running and its outcome
    // is readable through rubrics:amend-status. A caller-supplied key is kept as-is;
    // a minted one is deterministic, so a re-issued identical request still replays.
    const idempotencyKey =
      input.idempotencyKey ?? mintAmendmentIdempotencyKey(input, (await getRubric(args.rubricRef))?.revision);
    const run = trackAmendRun(
      idempotencyKey,
      args.rubricRef,
      () => executeAmend({ ...input, idempotencyKey }, args.rubricRef),
    );
    const settled = await settleWithin(run, amendForegroundBudgetMs());
    if (settled.kind === 'rejected') throw settled.error;
    const payload =
      settled.kind === 'resolved'
        ? { ...settled.value, idempotencyKey }
        : {
            ok: true,
            pending: true,
            idempotencyKey,
            receipt: {
              idempotencyKey,
              rubricRef: args.rubricRef,
              poll: { tool: 'rubrics:amend-status', args: { rubricRef: args.rubricRef, idempotencyKey } },
            },
            note:
              `The amendment is still running after ${Math.round(amendForegroundBudgetMs() / 1000)}s and continues ` +
              'server-side. Poll rubrics:amend-status with this receipt; do not re-issue the amend while it reads running.',
          };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});

/** RSR-P-008-C: how long the handler waits before answering with a receipt.
 *  Well under the 55s MCP transport deadline so the receipt always wins the
 *  race. Overridable for tests through the env var. */
export const AMEND_FOREGROUND_BUDGET_MS = 40_000;

function amendForegroundBudgetMs(): number {
  const override = Number(process.env.PAPERCUSP_RUBRICS_AMEND_FOREGROUND_MS);
  return override > 0 ? override : AMEND_FOREGROUND_BUDGET_MS;
}

type Settled<T> = { kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown } | { kind: 'pending' };

/** Wait up to `budgetMs` for `run`. On `pending`, `run` keeps going; its
 *  rejection is already observed by trackAmendRun's receipt, so it is swallowed
 *  here rather than surfacing as an unhandled rejection. */
async function settleWithin<T>(run: Promise<T>, budgetMs: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'pending' }), budgetMs);
  });
  const outcome = run.then(
    (value): Settled<T> => ({ kind: 'resolved', value }),
    (error: unknown): Settled<T> => ({ kind: 'rejected', error }),
  );
  try {
    return await Promise.race([outcome, pending]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The synchronous amend: apply, then build the response payload. */
async function executeAmend(input: AmendRubricInput, rubricRef: string): Promise<Record<string, unknown>> {
  const rubric = await amendRubric(input);
  if (!rubric) return { ok: false, error: `no rubric '${rubricRef}' — rubrics:list to see refs` };
  const completeness = rubricCompleteness(rubric);
  // EI-10514: schema-validate embedded replication-drill SQL against live PG (non-blocking).
  const replicationSqlCheck = await validateRubricReplicationSql(rubric.criteria);
  const methodLint = rubric.kind === 'acceptance' ? lintAcceptanceCriterionMethods(rubric.criteria) : [];
  // acceptance-runtime-plane P-004: same non-blocking vetting finding as rubrics:propose.
  const runtimeFindings = rubric.kind === 'acceptance' ? runtimeVettingFindings(rubric.criteria) : [];
  // Push-on-write (push-audit 2026-07-26): the Rubrics pane + trend read these.
  void trackDetached(import('../../sync-sse'))
    .then((m) => {
      m.notifySyncInvalidate('rubrics.list');
      m.notifySyncInvalidate('rubrics.trend');
    })
    .catch(() => {});
  return {
    ok: true,
    rubric,
    completeness,
    replicationSqlCheck,
    methodLint,
    ...(runtimeFindings.length ? { runtimeFindings } : {}),
  };
}
