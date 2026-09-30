/**
 * acceptance-bar-amendment-review.ts — the routed outside-lineage review of a
 * started acceptance-BAR amendment (P-005,
 * review-routing-through-relevance-router-2026-09-26).
 *
 * D-001 [owner 2026-09-26]: every review is recruited by the relevance
 * router and answered by a fork/convert of the routed expert's transcript, never
 * by hand-picking a reviewer and messaging them. This is that route for the
 * amendment approval:
 *
 *  - the menu is bounded by ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY;
 *  - every candidate is screened with the SAME screen rubrics:check-approver
 *    exposes (`resolveAcceptanceBarApproverScreen`), applied to the routed
 *    EXPERT. The answering session forks that expert's transcript, and
 *    acceptance-author-identity gives a routed fork its source's lineage, so
 *    screening the source is screening the reviewer the apply guard will judge;
 *  - the screen runs BEFORE selection (as `filterRoute`), so minimum-fill and
 *    every later cascade rank inherit the same fence, and a screen fault throws
 *    (fail closed) instead of letting an unscreened candidate through.
 *
 * P-006 connects rubrics:amend to it: `openAcceptanceBarAmendmentReview` checks
 * the requester's preview post with the apply guard's own resolver, then routes
 * a brief that carries everything the reviewer signs (no tool reads a thread
 * post by id, so the brief cannot just point at it).
 *
 * WI-10003299: when the router has nobody eligible (every live candidate is in
 * the implementers' lineage, which is the normal state on a plan whose whole
 * fleet built it), the review no longer dead-ends. It launches ONE fresh reviewer
 * the way grading does (acceptance-grader.ts / grading-integrity.ts): under a
 * dedicated system principal, so the launch edge makes the reviewer a
 * descendant of that principal and not of the requester. That principal is
 * screened with the same check-approver screen first, the launch is idempotent
 * per preview, and the reviewer answers with a work_items:comment on the
 * preview's own work-item, whose author the apply guard judges as usual.
 */
import { createHash } from 'node:crypto';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { AcceptanceBarAmendmentPreview, AcceptanceBarApproverEligibilityCheck } from '../rubrics';
import type { RouteResult } from './relevance-router';
import type { ConsultReviewerModel } from './get-feedback-core';
import { resolveExpertModelAllowlist } from './expert-model-allowlist';
import { ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY } from './selection-policies';

/** One candidate's verdict from the check-approver screen. */
export type AmendmentReviewerScreen = (
  ownerId: string,
) => Promise<Pick<AcceptanceBarApproverEligibilityCheck, 'eligible' | 'reason'>>;

export interface AmendmentReviewScreenedOut {
  ownerId: string;
  reason: AcceptanceBarApproverEligibilityCheck['reason'];
}

/**
 * Keep only candidates the screen calls eligible, in both the qualified list and
 * the snapshot the minimum-fill draws from. Each distinct owner is screened
 * once; a screen error propagates.
 */
export async function filterAmendmentReviewRoute(
  route: RouteResult,
  screen: AmendmentReviewerScreen,
  onScreenedOut?: (entry: AmendmentReviewScreenedOut) => void,
): Promise<RouteResult> {
  const ownerIds = [...new Set([...route.qualified, ...route.snapshot.candidates].map((c) => c.ownerId))];
  const eligible = new Set<string>();
  for (const ownerId of ownerIds) {
    const verdict = await screen(ownerId);
    if (verdict.eligible === true) eligible.add(ownerId);
    else onScreenedOut?.({ ownerId, reason: verdict.reason });
  }
  const allowed = (candidate: { ownerId: string }) => eligible.has(candidate.ownerId);
  return {
    ...route,
    qualified: route.qualified.filter(allowed),
    snapshot: { ...route.snapshot, candidates: route.snapshot.candidates.filter(allowed) },
  };
}

export interface AmendmentReviewRouteInput {
  /** The started acceptance rubric being amended. */
  rubricRef: string;
  /** What the reviewer must inspect: the exact candidate criteria and dry-run diff. */
  brief: string;
  /** The identity that will APPLY the amendment (the requester). */
  identity: AgentIdentity;
  workspaceId: string;
  harness?: string;
  reviewerModel?: ConsultReviewerModel;
}

/** A constrained review may only use a model admitted by the workspace's
 * existing expert allowlist. Never silently use a different ranked model. */
async function assertReviewerModelAllowed(workspaceId: string, choice: ConsultReviewerModel): Promise<void> {
  const { readConsultExpertRoutingSettings, bindConsultExpertRoutingSettings } = await import('./expert-routing-settings');
  const settings = bindConsultExpertRoutingSettings(await readConsultExpertRoutingSettings(workspaceId));
  const ranks = await resolveExpertModelAllowlist(workspaceId, { loadRanks: settings.loadRanks });
  if (!ranks.some((rank) => rank.agent === choice.agent && rank.model === choice.model)) {
    throw new Error(`reviewer_model_not_allowed: ${choice.agent}/${choice.model} is absent from the workspace expert allowlist`);
  }
}

export type AmendmentReviewRouteResult =
  | { state: 'routed'; conversationId: string; responderId: string | null; screenedOut: AmendmentReviewScreenedOut[] }
  | { state: 'no-eligible-reviewer'; conversationId: string | null; reason: string; screenedOut: AmendmentReviewScreenedOut[] };

export async function routeAcceptanceBarAmendmentReview(
  input: AmendmentReviewRouteInput,
  deps: {
    resolveScreen?: (args: { rubricId: string; applierId: string }) => Promise<{ check: AmendmentReviewerScreen }>;
    feedback?: typeof import('./get-feedback-prod').getFeedbackProd;
    assertAllowed?: typeof assertReviewerModelAllowed;
  } = {},
): Promise<AmendmentReviewRouteResult> {
  const rubricId = input.rubricRef.trim().replace(/^plan:/i, '').trim();
  if (input.reviewerModel) await (deps.assertAllowed ?? assertReviewerModelAllowed)(input.workspaceId, input.reviewerModel);
  const applierId = input.identity.ownerId;
  const resolveScreen =
    deps.resolveScreen ?? (async (args) => (await import('../rubrics')).resolveAcceptanceBarApproverScreen(args));
  // Resolve the population before routing: an unreadable rubric or implementer
  // history refuses the review rather than routing it unscreened.
  const screen = await resolveScreen({ rubricId, applierId });
  const feedback = deps.feedback ?? (await import('./get-feedback-prod')).getFeedbackProd;
  const screenedOut: AmendmentReviewScreenedOut[] = [];
  const result = await feedback(
    {
      workspaceId: input.workspaceId,
      requesterId: applierId,
      question: input.brief,
      originTaskRef: rubricId,
      // The applier is also screened; excluding it up front keeps it out of
      // the router's own candidate accounting.
      excludeOwners: [applierId],
      // An archived answer is not an approval of THIS diff: always route fresh.
      archiveFloor: 2,
      policy: ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY,
      ...(input.reviewerModel ? { reviewerModel: input.reviewerModel } : {}),
      latencyContract: 'hard-blocked',
      ...(input.harness ? { harnessSlug: input.harness } : {}),
    },
    input.identity,
    { filterRoute: (route) => filterAmendmentReviewRoute(route, screen.check, (entry) => screenedOut.push(entry)) },
  );
  if ('error' in result) throw new Error(`acceptance_bar_amendment_review_refused: ${result.error}`);
  if (result.verdict === 'routed') {
    return {
      state: 'routed',
      conversationId: result.conversation_id,
      responderId: result.responder?.ownerId ?? null,
      screenedOut,
    };
  }
  return {
    state: 'no-eligible-reviewer',
    conversationId: result.conversation_id ?? null,
    reason: `${result.verdict}${result.reason ? ` (${result.reason})` : ''}`,
    screenedOut,
  };
}

const PREVIEW_POST_REF = /^thread-post:[1-9][0-9]*$/;
const BRIEF_REASON_MAX = 800;
const BRIEF_PATCH_MAX = 2500;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} chars clipped]`;
}

function reviewPatch(input: AmendmentReviewBriefInput): { patch: string; omittedCriteria: number } {
  const full = JSON.stringify(input.patch);
  if (full.length <= BRIEF_PATCH_MAX || !Array.isArray(input.patch.criteria)) {
    return { patch: full, omittedCriteria: 0 };
  }

  const changedKeys = new Set(input.preview.changes.map((change) => change.barKey));
  const criteria = input.patch.criteria;
  const changedCriteria = criteria.filter((criterion) => {
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) return false;
    const candidate = criterion as Record<string, unknown>;
    const barKey = candidate.barKey ?? candidate.key;
    return typeof barKey === 'string' && changedKeys.has(barKey.trim());
  });
  // A malformed or unmappable replacement must stay complete: omitting entries
  // would make a change invisible to the reviewer.
  if (criteria.some((criterion) => !criterion || typeof criterion !== 'object' || Array.isArray(criterion)
    || typeof ((criterion as Record<string, unknown>).barKey ?? (criterion as Record<string, unknown>).key) !== 'string')
    || input.preview.changes.some((change) => !changedCriteria.some((criterion) => {
      const candidate = criterion as Record<string, unknown>;
      return ((candidate.barKey ?? candidate.key) as string).trim() === change.barKey;
    }))) {
    return { patch: full, omittedCriteria: 0 };
  }
  return {
    patch: JSON.stringify({ ...input.patch, criteria: changedCriteria }),
    omittedCriteria: criteria.length - changedCriteria.length,
  };
}

export interface AmendmentReviewBriefInput {
  rubricRef: string;
  /** `thread-post:<id>` — the requester's post carrying the exact preview approval JSON. */
  previewPostRef: string;
  preview: Pick<AcceptanceBarAmendmentPreview, 'approval' | 'changes'>;
  reason?: string;
  /** The amendment fields as requested, so the reviewer can reproduce the preview. */
  patch: Record<string, unknown>;
}

/** Where a fresh reviewer (who has no consult to answer) posts its verdict: the
 * work-item whose thread holds the preview post. */
export interface FreshReviewerAnswerTarget {
  workItemId: string;
  harness: string | null;
}

/**
 * What the routed reviewer reads. It carries the approval JSON and the patch
 * itself because no tool reads a thread post by id, and it names the one-line
 * answer the apply guard accepts (`approve thread-post:<id>`).
 *
 * With `answerOn` it is the FRESH reviewer's brief (WI-10003299): same content,
 * but the reviewer was launched rather than routed, runs as a judge (no
 * rubrics:amend), and answers with one work_items:comment on that work-item.
 */
export function buildAmendmentReviewBrief(
  input: AmendmentReviewBriefInput,
  answerOn?: FreshReviewerAnswerTarget,
): string {
  const shownPatch = reviewPatch(input);
  const bars = input.preview.changes
    .map((change) => `${change.barKey} (${[...change.kinds].join('+')}${change.fields?.length ? `: ${change.fields.join(', ')}` : ''})`)
    .join('; ');
  const commentCall = answerOn
    ? `work_items:comment { id:'${answerOn.workItemId}'${answerOn.harness ? `, harness:'${answerOn.harness}'` : ''} }`
    : '';
  return [
    answerOn
      ? `Outside-lineage review of a started acceptance-BAR amendment to ${input.rubricRef}. The relevance router found no eligible reviewer, so ${ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR} launched you fresh: you are outside the implementer's lineage, and the apply guard re-checks that from your post.`
      : `Outside-lineage review of a started acceptance-BAR amendment to ${input.rubricRef}. The relevance router picked you and screened you with rubrics:check-approver: you are outside the implementer's lineage.`,
    `Changed BARs: ${bars || '(none listed)'}.`,
    input.reason?.trim() ? `Reason given: ${clip(input.reason.trim(), BRIEF_REASON_MAX)}` : 'No reason was given.',
    shownPatch.omittedCriteria > 0
      ? `Requested patch excerpt: all changed criteria and other patch fields are complete; ${shownPatch.omittedCriteria} unchanged criteria omitted. Read the full current criteria with rubrics:get and compare the changed BARs before judging. This excerpt is not a complete replacement patch and must not be submitted to rubrics:amend.`
      : answerOn
        ? 'Requested patch. Read the current criteria with rubrics:get and judge what the patch changes; the apply guard itself checks the approval JSON below against the live delta:'
        : 'Requested patch. Reproduce the preview with rubrics:amend { rubricRef, dryRun:true, ...patch } and read the criteria with rubrics:get before judging:',
    '```json',
    shownPatch.patch,
    '```',
    `Approval JSON the requester posted as ${input.previewPostRef}:`,
    '```json',
    JSON.stringify(input.preview.approval),
    '```',
    answerOn
      ? `To approve, post exactly one line with ${commentCall}, body: approve ${input.previewPostRef}`
      : `To approve, answer this consult with exactly one line: approve ${input.previewPostRef}`,
    answerOn
      ? `That line is the signature: the apply guard takes its author and time from your post. If the change weakens a requirement or you cannot verify it, post the objection with that same ${commentCall} instead; any other text is not an approval. Post once, do not edit files or recruit anyone, then end your session.`
      : 'That line is the signature: the apply guard takes its author and time from your post. If the change weakens a requirement or you cannot verify it, decline or answer with the objection; any other answer is not an approval.',
  ].join('\n');
}

/**
 * WI-10003299: the system principal that launches a fresh reviewer when the
 * router has nobody eligible. A reviewer launched by the REQUESTER would be the
 * requester's descendant and the apply guard would refuse it, so, like
 * ACCEPTANCE_GRADING_SWEEP_ACTOR, the launch is attributed to this principal.
 * It is dedicated (never used to launch implementers), so it has no lineage of
 * its own to the plans it reviews; the screen below still checks that.
 */
export const ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR = 'system:acceptance-bar-amendment-review';

export type FreshAmendmentReviewerResult =
  | {
      state: 'launched';
      launcherId: string;
      taskId: string | null;
      label: string;
      idempotencyKey: string;
      /** True when this preview already had a fresh reviewer: nothing new was launched. */
      deduped: boolean;
      answerOn: FreshReviewerAnswerTarget;
    }
  | { state: 'not-launched'; reason: string };

export interface FreshAmendmentReviewerInput extends AmendmentReviewBriefInput {
  applierId: string;
  workspaceId: string;
  /** The requesting tool call's context; overridden with the system principal. */
  launchCtx?: unknown;
  reviewerModel?: ConsultReviewerModel;
}

/** The work-item whose thread carries the preview post, with its harness. */
async function resolvePreviewPostWorkItem(args: {
  workspaceId: string;
  previewPostRef: string;
}): Promise<FreshReviewerAnswerTarget | null> {
  const postId = PREVIEW_POST_REF.test(args.previewPostRef) ? args.previewPostRef.slice('thread-post:'.length) : null;
  if (!postId) return null;
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql;
  const [row] = await sql<Array<{ parent_ref: string | null; harness_slug: string | null }>>`
    SELECT w.feature_id AS parent_ref, w.harness_slug
      FROM harness_shared.coord_thread_posts p
      JOIN harness_shared.coord_threads t
        ON t.workspace_id = p.workspace_id AND t.thread_id = p.thread_id
      JOIN harness_shared.work_items w
        ON w.workspace_id = p.workspace_id
       AND (
         (t.parent_kind = 'feature' AND w.item_kind IN ('feature', 'chunk')
           AND t.parent_ref = w.harness_slug || '#' || w.feature_id)
         OR (t.parent_kind = 'issue' AND w.item_kind IN ('bug', 'change', 'task')
           AND t.parent_ref = w.feature_id)
       )
     WHERE p.workspace_id = ${args.workspaceId}
       AND p.id = ${postId}::bigint
       AND p.origin = 'local'
     LIMIT 1`;
  return row?.parent_ref ? { workItemId: row.parent_ref, harness: row.harness_slug?.trim() || null } : null;
}

function freshReviewerLaunchCtx(launchCtx: unknown, workspaceId: string, harness: string | null): unknown {
  return {
    ...(launchCtx && typeof launchCtx === 'object' ? (launchCtx as Record<string, unknown>) : {}),
    workspaceId,
    ...(harness ? { harnessSlug: harness } : {}),
    uiClientId: null,
    isSuperuser: false,
    isPowerUser: false,
    principal: { kind: 'system', slug: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR, workspaceId },
    ownerId: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
    ownerLabel: 'acceptance-BAR amendment review',
    userId: null,
  };
}

type LaunchHandler = (args: never, ctx: never) => Promise<unknown>;

/**
 * Launch one fresh outside-lineage reviewer for a preview the router could not
 * staff. Refuses (never launches) when the preview is not on a work-item thread
 * or the launcher principal fails the check-approver screen. Idempotent per
 * (workspace, rubric, preview post, approval): a repeat returns the same launch.
 */
export async function launchFreshAmendmentReviewer(
  input: FreshAmendmentReviewerInput,
  deps: {
    resolveAnswerTarget?: typeof resolvePreviewPostWorkItem;
    resolveScreen?: (args: { rubricId: string; applierId: string }) => Promise<{ check: AmendmentReviewerScreen }>;
    launch?: LaunchHandler;
    assertAllowed?: typeof assertReviewerModelAllowed;
  } = {},
): Promise<FreshAmendmentReviewerResult> {
  const previewPostRef = input.previewPostRef.trim();
  const answerOn = await (deps.resolveAnswerTarget ?? resolvePreviewPostWorkItem)({
    workspaceId: input.workspaceId,
    previewPostRef,
  });
  if (!answerOn) {
    return {
      state: 'not-launched',
      reason: `${previewPostRef} is not a post on a work-item thread, so a fresh reviewer would have nowhere to answer. Post the preview with work_items:comment.`,
    };
  }
  const rubricId = input.rubricRef.trim().replace(/^plan:/i, '').trim();
  if (input.reviewerModel) await (deps.assertAllowed ?? assertReviewerModelAllowed)(input.workspaceId, input.reviewerModel);
  const resolveScreen =
    deps.resolveScreen ?? (async (args) => (await import('../rubrics')).resolveAcceptanceBarApproverScreen(args));
  const screen = await resolveScreen({ rubricId, applierId: input.applierId });
  const launcherVerdict = await screen.check(ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR);
  if (launcherVerdict.eligible !== true) {
    return {
      state: 'not-launched',
      reason: `the fresh-reviewer launcher ${ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR} is ${launcherVerdict.reason}, so a reviewer it launched would be refused`,
    };
  }
  const identity = createHash('sha256')
    .update([input.workspaceId, rubricId, previewPostRef, JSON.stringify(input.preview.approval),
      ...(input.reviewerModel ? [JSON.stringify(input.reviewerModel)] : [])].join('\0'))
    .digest('hex');
  const idempotencyKey = `acceptance-bar-amendment-review:${identity.slice(0, 32)}`;
  const label = `bar-amendment-review:${identity.slice(0, 12)}`;
  const launch: LaunchHandler =
    deps.launch ?? ((await import('../agent-tools/capability/launch-agent')).default.handler as unknown as LaunchHandler);
  const result = (await launch(
    {
      brief: buildAmendmentReviewBrief({ ...input, previewPostRef }, answerOn),
      ...(answerOn.harness ? { harness: answerOn.harness } : {}),
      headless: true,
      // Never the requester's fleet, and routed through the inference gateway
      // so one walled credential cannot strand an unattended reviewer
      // (the same two fences the acceptance grader's fresh judge carries).
      independent: true,
      account: 'auto',
      count: 1,
      // role:'judge' is harness-scoped; launch-agent refuses it without one
      // (EI-23414612968722239), so it rides only with a resolved harness.
      ...(answerOn.harness || input.reviewerModel ? { members: [{
        ...(answerOn.harness ? { role: 'judge' } : {}),
        ...(input.reviewerModel ?? {}),
      }] } : {}),
      label,
      idempotencyKey,
    } as never,
    freshReviewerLaunchCtx(input.launchCtx, input.workspaceId, answerOn.harness) as never,
  )) as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
    data?: { deduped?: boolean; launch?: { tasks?: Array<{ taskId?: unknown }> } };
  };
  if (result?.isError) {
    const text = (result.content ?? []).map((c) => c.text ?? '').join(' ').trim();
    return { state: 'not-launched', reason: `launch refused: ${clip(text || 'no detail', 400)}` };
  }
  const taskId = result?.data?.launch?.tasks?.[0]?.taskId;
  return {
    state: 'launched',
    launcherId: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
    taskId: typeof taskId === 'string' ? taskId : null,
    label,
    idempotencyKey,
    deduped: result?.data?.deduped === true,
    answerOn,
  };
}

/**
 * The preview post must carry the approval the CURRENT delta produces. This is
 * the apply guard's own resolver, so a post it would later refuse (unparseable,
 * other rubric, uncovered or stale BAR hashes) refuses the review up front
 * instead of spending a routed reviewer on it.
 */
async function verifyPreviewPostWithApplyResolver(args: {
  workspaceId: string;
  previewPostRef: string;
  approval: AcceptanceBarAmendmentPreview['approval'];
}): Promise<void> {
  const [{ getOrgPg }, { resolveAcceptanceBarApproval }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../acceptance-bar-amendment'),
  ]);
  await resolveAcceptanceBarApproval(getOrgPg().sql as never, {
    workspaceId: args.workspaceId,
    approvalRef: args.previewPostRef,
    expected: args.approval,
  });
}

export interface OpenAmendmentReviewInput extends AmendmentReviewBriefInput {
  preview: Pick<AcceptanceBarAmendmentPreview, 'approval' | 'changes' | 'approvalRequired'>;
  identity: AgentIdentity;
  workspaceId: string;
  harness?: string;
  /** The requesting tool call's context, reused (as the system principal) for a fresh-reviewer launch. */
  launchCtx?: unknown;
  reviewerModel?: ConsultReviewerModel;
}

export type AmendmentReviewRequestResult =
  | { state: 'not-required'; next: string }
  | (AmendmentReviewRouteResult & {
      previewPostRef: string;
      next: string;
      /** WI-10003299: set when the router staffed nobody and a fresh reviewer was attempted. */
      freshReviewer?: FreshAmendmentReviewerResult;
    });

/**
 * rubrics:amend's review opener (P-006). A preview that needs no approval
 * routes nothing; otherwise the preview post is checked, then the routed,
 * lineage-screened review is opened for it.
 */
export async function openAcceptanceBarAmendmentReview(
  input: OpenAmendmentReviewInput,
  deps: {
    verifyPreviewPost?: typeof verifyPreviewPostWithApplyResolver;
    route?: typeof routeAcceptanceBarAmendmentReview;
    launchFresh?: typeof launchFreshAmendmentReviewer;
  } = {},
): Promise<AmendmentReviewRequestResult> {
  if (!input.preview.approvalRequired) {
    return { state: 'not-required', next: 'No BAR meaning changes: apply without approvalRef.' };
  }
  const previewPostRef = input.previewPostRef.trim();
  if (!PREVIEW_POST_REF.test(previewPostRef)) {
    throw new Error(`invalid_args: reviewPreviewPost must be thread-post:<id>, got '${input.previewPostRef}'`);
  }
  try {
    await (deps.verifyPreviewPost ?? verifyPreviewPostWithApplyResolver)({
      workspaceId: input.workspaceId,
      previewPostRef,
      approval: input.preview.approval,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `acceptance_bar_amendment_review_preview_invalid: ${previewPostRef} does not carry this preview's approval (${message}). ` +
        'Post the current preview.approval JSON once with work_items:comment and pass that post.',
    );
  }
  const routed = await (deps.route ?? routeAcceptanceBarAmendmentReview)({
    rubricRef: input.rubricRef,
    brief: buildAmendmentReviewBrief({ ...input, previewPostRef }),
    identity: input.identity,
    workspaceId: input.workspaceId,
    ...(input.harness ? { harness: input.harness } : {}),
    ...(input.reviewerModel ? { reviewerModel: input.reviewerModel } : {}),
  });
  if (routed.state === 'routed') {
    const next =
      `events:await { event:'consult:reply:${routed.conversationId}' }. When the routed reviewer answers \`approve ${previewPostRef}\`, ` +
      `apply with the same patch plus approvalRef:'thread-post:<that answer post id>' (conversations:get { id:'${routed.conversationId}' } lists post ids).`;
    return { ...routed, previewPostRef, next };
  }
  // WI-10003299: nobody eligible is not a reason to stop. Launch one fresh
  // outside-lineage reviewer instead of telling the requester to wait for one.
  let freshReviewer: FreshAmendmentReviewerResult;
  try {
    freshReviewer = await (deps.launchFresh ?? launchFreshAmendmentReviewer)({
      rubricRef: input.rubricRef,
      previewPostRef,
      preview: input.preview,
      ...(input.reason ? { reason: input.reason } : {}),
      patch: input.patch,
      applierId: input.identity.ownerId,
      workspaceId: input.workspaceId,
      ...(input.launchCtx !== undefined ? { launchCtx: input.launchCtx } : {}),
      ...(input.reviewerModel ? { reviewerModel: input.reviewerModel } : {}),
    });
  } catch (error) {
    freshReviewer = {
      state: 'not-launched',
      reason: `fresh reviewer launch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const next =
    freshReviewer.state === 'launched'
      ? `No eligible reviewer could be routed, so ${freshReviewer.launcherId} ${freshReviewer.deduped ? 'already launched' : 'launched'} a fresh outside-lineage reviewer ` +
        `(label ${freshReviewer.label}${freshReviewer.taskId ? `, task ${freshReviewer.taskId}` : ''}). It answers with one work_items:comment on ${freshReviewer.answerOn.workItemId}: ` +
        `\`approve ${previewPostRef}\` or an objection. Read it with work_items:get { id:'${freshReviewer.answerOn.workItemId}', threadLimit:5 }, then apply with the same patch plus approvalRef:'thread-post:<that post id>'. ` +
        'Re-running this dry run reuses the same reviewer; if it ended without posting, post the preview again and pass the new post to launch another.'
      : `No eligible outside-lineage reviewer could be routed, and no fresh reviewer was launched: ${freshReviewer.reason}. The reason and screenedOut say why routing failed.`;
  return { ...routed, previewPostRef, next, freshReviewer };
}
