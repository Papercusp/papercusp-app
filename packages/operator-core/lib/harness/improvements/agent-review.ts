/**
 * Agent-review lifecycle over the existing work-item queue + Blender ledger.
 *
 * `scout_routed_ideas` remains the sole grade authority. The work-item payload stores
 * routing state only; comments preserve round history.
 *
 * WHAT IS AND IS NOT RETRYABLE (WI-41691). `reconcileAgentReviewGrade` below is itself
 * convergent: it re-reads the standing ledger grade, recomputes the target status, and
 * dedupes its own side effects (`changed`, `ensureComment`), so re-invoking it after an
 * applied transition is a no-op and after a PARTIAL one completes the residue. That
 * property is NOT reachable through the supported surface. `blender:grade-idea` runs
 * `preflightAgentReviewGrade` first and returns `applied:false` with
 * `reason:'agent-review-not-pending'` — before the ledger write and before reconcile —
 * as soon as the payload has left 'pending', which a partial write is exactly what makes
 * it do. So a retry THROUGH THE TOOL cannot converge a partially-applied transition;
 * only a direct call to `reconcileAgentReviewGrade` can. That refusal is deliberate
 * (grade-idea.ts D-003/P-004: a non-pending regrade must not re-decide a settled round),
 * not an oversight — the claim that stood here until WI-41691 described the function and
 * silently promised the same of the tool.
 *
 * The gap is narrower than it was, on two counts. WI-41687 removed the dominant
 * partial-write path (the revision transfer no longer throws when the submitter's session
 * has been reaped). WI-41689 then answered the product question this paragraph used to
 * park: a settled row MAY be re-driven, but only FORWARD through `resubmitAgentReview`,
 * which returns it to 'pending' and re-enters review — never by re-deciding a settled
 * round in place through `blender:grade-idea`. Resubmit no longer requires the original
 * submitter to still exist: when the shared liveness oracle reports that session PROVABLY
 * gone, another agent may adopt the row (the orphan-rebind branch below).
 *
 * `ensureComment` or `deliverRevision` throwing after `mergeWorkItemPayload` has committed
 * still leaves partial-write residue, and only a direct `reconcileAgentReviewGrade` call
 * converges that.
 *
 * Pinned by lib/doc-claims/agent-review-retry-convergence.test.ts — if the pending guard
 * is ever relaxed to admit a converging regrade, that test fails and forces this
 * paragraph to be corrected in the same change.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  claimWorkItem,
  commentWorkItem,
  depsBlockedExclusionSql,
  getWorkItem,
  getWorkItemDetail,
  mergeWorkItemPayload,
  releaseWorkItem,
  type WorkItem,
} from '../../work-items';
import { activeWorkspaceId } from '../../workspace-registry';
import { recordRoutedIdea } from '../../scout/routed-ledger';
import { boundedOrgTxn } from '../../pg-bounded-txn';
import {
  agentReviewEligibility,
  agentReviewPendingSelectorSql,
  createImplementationReadiness,
  LEGACY_AGENT_REVIEW_SUBMITTER,
  mintAgentReviewClaimAdmission,
  readAgentReviewState,
  readImplementationReadiness,
  type AgentReviewState,
  type ImplementationReadinessState,
} from './agent-review-policy';
// The canonical "this session can still act" set, IMPORTED rather than re-derived.
// Deliberately not a delegation to `rebindIdentity` itself: that migrates ~16 ownerId-keyed
// surfaces (loop, presence, fleet membership, claims, facts, watermarks) from one sid to
// another, whereas the orphan rebind below re-points ONE payload field on ONE work item —
// delegating would move a dead submitter's entire coordination identity onto whoever
// resubmits. The two also sit on OPPOSITE sides of the unknown-verdict question, which is
// why only the constant is shared: `rebindIdentity` fails OPEN on an unmeasured verdict
// (an explicit caller has asserted the death and its surfaces are idempotent), while this
// guard must fail CLOSED (nobody asserted anything — the code is inferring the death).
import { REBIND_BLOCKING_SESSION_STATES } from '../../agent-tools/coordination/rebind-identity';
import type { SessionState } from '../../agent-tools/coordination/presence-wakeability';

export const AGENT_REVIEW_MAX_REVISION_GRADE = 3;

export interface AgentReviewLedgerGrade {
  ideaId: string;
  workItemId: string;
  grade: number | null;
  feedback: string | null;
  gradedBy: string | null;
}

/**
 * The liveness facts the orphan-rebind guard acts on — a projection of the shared oracle's
 * verdict, deliberately narrowed to the one field the guard is allowed to reason about.
 */
export interface SubmitterLivenessVerdict {
  sessionState: SessionState;
}

export interface AgentReviewDeps {
  getWorkItem: typeof getWorkItem;
  getWorkItemDetail: typeof getWorkItemDetail;
  mergeWorkItemPayload: typeof mergeWorkItemPayload;
  releaseWorkItem: typeof releaseWorkItem;
  claimWorkItem: typeof claimWorkItem;
  commentWorkItem: typeof commentWorkItem;
  recordRoutedIdea: typeof recordRoutedIdea;
  resolveLedgerIdeaId: (workItemId: string) => Promise<string>;
  readLedgerGrade: (ideaId: string) => Promise<AgentReviewLedgerGrade | null>;
  deliverRevision: (input: {
    to: string;
    workItemId: string;
    round: number;
    grade: number;
    feedback: string;
    gradedBy: string;
  }) => Promise<{ woken: number }>;
  /**
   * Can this agent-review submitter still act? Resolved through THE shared liveness oracle
   * so the answer cannot drift from what coord:presence / fleet:status report for the same
   * agent (presence-derivation-unification-2026-07-17 D-001: one derivation, many lenses).
   *
   * `null` is the oracle's IN-BAND unknown folded into "no reading" — NOT a state. The
   * caller MUST fail closed on it; see the orphan-rebind branch.
   */
  resolveSubmitterLiveness: (
    ownerId: string,
    hints: { claimsHeld: boolean },
  ) => Promise<SubmitterLivenessVerdict | null>;
}

async function readLedgerGrade(ideaId: string): Promise<AgentReviewLedgerGrade | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{
    idea_id: string;
    routed_ref: string;
    human_grade: number | null;
    human_feedback: string | null;
    graded_by: string | null;
  }[]>`
    SELECT idea_id, routed_ref, human_grade, human_feedback, graded_by
      FROM harness_shared.scout_routed_ideas
     WHERE idea_id = ${ideaId}`;
  const row = rows[0];
  if (!row?.routed_ref.startsWith('wi:')) return null;
  return {
    ideaId: row.idea_id,
    workItemId: row.routed_ref.slice(3),
    grade: row.human_grade == null ? null : Number(row.human_grade),
    feedback: row.human_feedback,
    gradedBy: row.graded_by,
  };
}

/**
 * Preserve a pre-existing same-id Blender row when it belongs to another
 * artifact. D-004 reserves exactly one deterministic fallback so migration
 * retries converge and payload.agentReview can point at the real grade authority.
 */
export async function resolveLedgerIdeaId(workItemId: string): Promise<string> {
  const { sql } = getOrgPg();
  const fallback = `agent-review:${workItemId}`;
  const rows = await sql<{ idea_id: string; routed_ref: string }[]>`
    SELECT idea_id, routed_ref
      FROM harness_shared.scout_routed_ideas
     WHERE idea_id IN (${workItemId}, ${fallback})`;
  const byId = new Map(rows.map((row) => [row.idea_id, row.routed_ref]));
  const routedRef = `wi:${workItemId}`;
  const primary = byId.get(workItemId);
  if (primary == null || primary === routedRef) return workItemId;
  const fallbackRoute = byId.get(fallback);
  if (fallbackRoute == null || fallbackRoute === routedRef) return fallback;
  throw new Error(
    `agent review ledger collision: '${workItemId}' and '${fallback}' both route to other artifacts`,
  );
}

export interface PreserveAgentReviewAuthorityResult {
  preserved: boolean;
  ledgerIdeaId?: string;
  reason?: 'not-found' | 'not-agent-review' | 'already-independent';
}

/**
 * Preserve agent-review's grade authority before blender:route-idea reuses the
 * work-item id as the plan-learning row's primary key.
 *
 * Enrollment already chooses `agent-review:<WI>` when the bare id is occupied at
 * enrollment time. The inverse ordering was still unsafe: a feature could enter
 * review first (so its payload + `wi:<WI>` ledger row both used the bare id), then
 * a later plan route would upsert that same row to `plan:<slug>`. The payload kept
 * pointing at the overwritten row, so review pickup remained pending forever while
 * every grade was treated as an ordinary plan-learning grade.
 *
 * Lock the work item and both possible ledger rows, materialize the deterministic
 * fallback, and repoint payload.agentReview in ONE transaction. A normal first
 * route clones the review row (including any standing grade); a retry against the
 * already-overwritten incident shape creates a clean review row instead of copying
 * the unrelated plan grade. The caller may then safely upsert the bare id onto the
 * plan rail. Retries converge once the payload points at the fallback.
 */
export async function preserveAgentReviewAuthorityBeforePlanRoute(input: {
  workItemId: string;
  workspaceId?: string;
}): Promise<PreserveAgentReviewAuthorityResult> {
  const workspaceId = input.workspaceId ?? activeWorkspaceId();
  const fallback = `agent-review:${input.workItemId}`;
  const reviewRef = `wi:${input.workItemId}`;
  const now = Date.now();

  return boundedOrgTxn(async (tx) => {
    const workItems = await tx<{ payload: unknown; harness_slug: string; title: string }[]>`
      SELECT payload, harness_slug, title
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${input.workItemId}
         AND item_kind = ANY (ARRAY['bug', 'change', 'task', 'feature'])
       FOR UPDATE`;
    const workItem = workItems[0];
    if (!workItem) return { preserved: false, reason: 'not-found' };

    const review = readAgentReviewState(workItem.payload);
    if (!review) return { preserved: false, reason: 'not-agent-review' };
    if (review.ledgerIdeaId !== input.workItemId) {
      return { preserved: false, ledgerIdeaId: review.ledgerIdeaId, reason: 'already-independent' };
    }

    const ledgerRows = await tx<{ idea_id: string; routed_ref: string }[]>`
      SELECT idea_id, routed_ref
        FROM harness_shared.scout_routed_ideas
       WHERE idea_id IN (${input.workItemId}, ${fallback})
       FOR UPDATE`;
    const byId = new Map(ledgerRows.map((row) => [row.idea_id, row.routed_ref]));
    const fallbackRef = byId.get(fallback);
    if (fallbackRef != null && fallbackRef !== reviewRef) {
      throw new Error(
        `agent review ledger collision: fallback '${fallback}' routes to '${fallbackRef}', not '${reviewRef}'`,
      );
    }

    if (fallbackRef == null) {
      const primaryIsReviewAuthority = byId.get(input.workItemId) === reviewRef;
      if (primaryIsReviewAuthority) {
        await tx`
          INSERT INTO harness_shared.scout_routed_ideas
            (idea_id, workspace_id, harness_slug, source_hive, target_hive, cycle_id,
             lens, rail, routed_ref, title, addresses_pattern_refs, routed_at,
             outcome, outcome_checked_at, human_grade, human_feedback, graded_by,
             graded_at, origin, created_by, model_spec, model_config)
          SELECT ${fallback}, workspace_id, harness_slug, source_hive, target_hive, cycle_id,
                 lens, rail, routed_ref, title, addresses_pattern_refs, routed_at,
                 outcome, outcome_checked_at, human_grade, human_feedback, graded_by,
                 graded_at, origin, created_by, model_spec, model_config
            FROM harness_shared.scout_routed_ideas
           WHERE idea_id = ${input.workItemId}
          ON CONFLICT (idea_id) DO NOTHING`;
      } else {
        // Retry/repair after the bare row has already become plan provenance: do
        // not copy that row's plan grade into a review round that never received it.
        await tx`
          INSERT INTO harness_shared.scout_routed_ideas
            (idea_id, workspace_id, harness_slug, source_hive, target_hive, cycle_id,
             lens, rail, routed_ref, title, addresses_pattern_refs, routed_at,
             outcome, outcome_checked_at, human_grade, human_feedback, graded_by,
             graded_at, origin, created_by, model_spec, model_config)
          VALUES
            (${fallback}, ${workspaceId}, ${workItem.harness_slug}, ${workItem.harness_slug},
             NULL, NULL, 'agent-review', 'improvement', ${reviewRef}, ${workItem.title},
             NULL, ${now}, NULL, NULL, NULL, NULL, NULL, NULL, 'agent-review',
             ${review.submittedBy}, NULL, NULL)
          ON CONFLICT (idea_id) DO NOTHING`;
      }
    }

    const fallbackRows = await tx<{ routed_ref: string }[]>`
      SELECT routed_ref
        FROM harness_shared.scout_routed_ideas
       WHERE idea_id = ${fallback}`;
    if (fallbackRows[0]?.routed_ref !== reviewRef) {
      throw new Error(`agent review authority migration could not establish '${fallback}' -> '${reviewRef}'`);
    }

    const updated = await tx<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
               COALESCE(payload, '{}'::jsonb),
               '{agentReview,ledgerIdeaId}',
               to_jsonb(${fallback}::text),
               true
             ),
             updated_ts = ${now}
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${input.workItemId}
         AND payload #>> '{agentReview,ledgerIdeaId}' = ${input.workItemId}
      RETURNING feature_id`;
    if (!updated[0]) {
      throw new Error(`agent review authority migration lost work-item '${input.workItemId}'`);
    }
    return { preserved: true, ledgerIdeaId: fallback };
  });
}

async function deliverRevision(input: {
  to: string;
  workItemId: string;
  round: number;
  grade: number;
  feedback: string;
  gradedBy: string;
}): Promise<{ woken: number }> {
  const [{ sendMessage }, { wakeRecipients }] = await Promise.all([
    import('../../agent-tools/coordination/messages'),
    import('../../agent-tools/coordination/inbox-wake'),
  ]);
  const summary = `Agent review round ${input.round} requests revision on ${input.workItemId}`;
  const body =
    `${input.gradedBy} graded ${input.workItemId} ${input.grade}/5.\n\n${input.feedback}\n\n` +
    `Revise the same work item, then call improvements:agent-review { mode:'resubmit', id:'${input.workItemId}' }.`;
  await sendMessage(
    {
      ownerId: 'agent-review-revision',
      ownerLabel: 'agent review',
      source: 'static-client' as const,
      workspaceId: null,
      userId: null,
    },
    { to: [input.to], summary, body },
  );
  try {
    return await wakeRecipients([input.to], { summary, source: 'agent-review-revision' });
  } catch {
    return { woken: 0 };
  }
}

/**
 * Default submitter-liveness resolution. The oracle is reached by DYNAMIC import on
 * purpose: it statically pulls presence.ts, adv-sessions and psu-pty-discovery, and this
 * module is imported by hermetic unit tests. Same keep-it-off-the-static-graph discipline
 * `rebindIdentity.defaultResolveLiveness` uses for the same dependency.
 *
 * `hydratePerId` fills heartbeat/stale/host/pid/source from the subject's own presence
 * row, which is what enables the oracle's pid probe — without it a reaped session can
 * resolve to a weaker verdict than the evidence supports.
 */
async function resolveSubmitterLiveness(
  ownerId: string,
  hints: { claimsHeld: boolean },
): Promise<SubmitterLivenessVerdict | null> {
  const { resolveSessionStates } = await import('../../agent-tools/coordination/liveness-oracle');
  const verdicts = await resolveSessionStates([{ ownerId, claimsHeld: hints.claimsHeld }], {
    hydratePerId: true,
  });
  const v = verdicts.get(ownerId);
  // `sessionState: null` is the oracle's in-band unknown. Fold it into "no reading" here
  // so the single `null` the caller sees always means NOT MEASURED, and it cannot be
  // mistaken for a measured absence.
  return v && v.sessionState != null ? { sessionState: v.sessionState } : null;
}

const defaultDeps: AgentReviewDeps = {
  getWorkItem,
  getWorkItemDetail,
  mergeWorkItemPayload,
  releaseWorkItem,
  claimWorkItem,
  commentWorkItem,
  recordRoutedIdea,
  resolveLedgerIdeaId,
  readLedgerGrade,
  deliverRevision,
  resolveSubmitterLiveness,
};

function reviewImplementationReadiness(
  payload: unknown,
  input: {
    status: ImplementationReadinessState['status'];
    reason: string;
    submittedBy: string;
    round: number;
    reviewer?: string;
    grade?: number;
  },
): ImplementationReadinessState {
  const existing = readImplementationReadiness(payload);
  const review = existing?.evidence?.review;
  if (
    existing?.source === 'agent-review' &&
    existing.status === input.status &&
    existing.reason === input.reason &&
    review?.submittedBy === input.submittedBy &&
    review.round === input.round &&
    review.reviewer === input.reviewer &&
    review.grade === input.grade
  ) {
    return existing;
  }
  return createImplementationReadiness({
    status: input.status,
    source: 'agent-review',
    reason: input.reason,
    evidence: {
      review: {
        submittedBy: input.submittedBy,
        round: input.round,
        ...(input.reviewer ? { reviewer: input.reviewer } : {}),
        ...(input.grade == null ? {} : { grade: input.grade }),
      },
    },
  });
}

export interface EnterAgentReviewInput {
  id: string;
  submittedBy: string;
  harnessSlug?: string;
  workspaceId?: string;
}

export async function enterAgentReview(
  input: EnterAgentReviewInput,
  deps: AgentReviewDeps = defaultDeps,
): Promise<{ entered: boolean; state?: AgentReviewState; reason?: string }> {
  const workItem = await deps.getWorkItem(input.id, input.harnessSlug);
  if (!workItem) return { entered: false, reason: 'not-found' };
  const eligibility = agentReviewEligibility(workItem);
  if (!eligibility.eligible) return { entered: false, reason: eligibility.reason };

  const existing = readAgentReviewState(workItem.payload);
  if (existing?.status === 'approved') return { entered: false, state: existing, reason: 'already-approved' };
  const ledgerIdeaId = existing?.ledgerIdeaId ?? await deps.resolveLedgerIdeaId(workItem.id);
  const next: AgentReviewState = existing?.status === 'pending'
    ? existing
    : {
        status: 'pending',
        submittedBy: existing?.submittedBy ?? input.submittedBy,
        ledgerIdeaId,
        round: existing ? existing.round + 1 : 1,
      };

  const harnessSlug = input.harnessSlug ?? workItem.harness;
  if (!harnessSlug) throw new Error(`enterAgentReview: work item '${workItem.id}' has no harness`);
  await deps.recordRoutedIdea({
    ideaId: next.ledgerIdeaId,
    lens: 'agent-review',
    rail: 'improvement',
    routedRef: `wi:${workItem.id}`,
    harnessSlug,
    title: workItem.title,
    origin: 'agent-review',
    createdBy: next.submittedBy,
    preserveExisting: true,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
  const merged = await deps.mergeWorkItemPayload(
    workItem.id,
    {
      agentReview: next,
      implementationReadiness: reviewImplementationReadiness(workItem.payload, {
        status: 'unknown',
        reason: 'awaiting-agent-review',
        submittedBy: next.submittedBy,
        round: next.round,
      }),
    },
    {
      harness: harnessSlug,
      unset: ['needsHuman', 'needsOwnerAction'],
    },
  );
  if (!merged) throw new Error(`enterAgentReview: work item '${workItem.id}' disappeared during enrollment`);
  if (workItem.assignee) {
    const released = await deps.releaseWorkItem(workItem.id, {
      harness: harnessSlug,
      expectedAssignee: workItem.assignee,
    });
    if (!released) throw new Error(`enterAgentReview: could not release submitter claim on '${workItem.id}'`);
  }
  return { entered: !existing || existing.status !== 'pending', state: next };
}

export async function resubmitAgentReview(
  input: { id: string; submittedBy: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<{ resubmitted: boolean; state?: AgentReviewState; reason?: string }> {
  const workItem = await deps.getWorkItem(input.id);
  if (!workItem) return { resubmitted: false, reason: 'not-found' };
  const current = readAgentReviewState(workItem.payload);
  if (!current) return { resubmitted: false, reason: 'not-agent-review' };
  const isLegacyRebind = current.submittedBy === LEGACY_AGENT_REVIEW_SUBMITTER;
  if (isLegacyRebind && workItem.assignee !== input.submittedBy) {
    return { resubmitted: false, state: current, reason: 'legacy-revision-not-claimant' };
  }
  // ORPHAN REBIND (WI-41689). A 'revision-requested' row can only leave that state through
  // this function, and until now only its ORIGINAL submitter could call it. That submitter
  // is routinely gone by review time — a session that filed a report hours earlier is
  // reaped — which left the row excluded from the claim floor by
  // `agentReviewPendingSelectorSql` with nobody alive able to release it. Permanently
  // unclaimable, and invisible as a blocker.
  //
  // So: when the original submitter is PROVABLY gone, another agent may adopt the row.
  // "Provably" is doing real work in that sentence — see the two guards below.
  let isOrphanRebind = false;
  if (!isLegacyRebind && current.submittedBy !== input.submittedBy) {
    // A row that is not resubmittable anyway refuses on identity exactly as before,
    // rather than spending an oracle read to reach the same answer by a new name.
    if (current.status !== 'revision-requested') {
      return { resubmitted: false, state: current, reason: 'not-submitter' };
    }
    const verdict = await deps.resolveSubmitterLiveness(current.submittedBy, {
      claimsHeld: workItem.assignee === current.submittedBy,
    });
    // FAIL CLOSED on an unmeasured verdict. `null` means the oracle had no signal, not
    // that the submitter is absent, and collapsing the two would quietly turn this into
    // "resubmit whenever we cannot see the submitter" — a different, much weaker rule
    // wearing this one's clothes. A DISTINCT reason keeps that diagnosable instead of
    // indistinguishable from a live-submitter refusal.
    if (!verdict) {
      return { resubmitted: false, state: current, reason: 'not-submitter:liveness-unknown' };
    }
    if ((REBIND_BLOCKING_SESSION_STATES as readonly SessionState[]).includes(verdict.sessionState)) {
      return { resubmitted: false, state: current, reason: 'not-submitter' };
    }
    // The submitter is gone, but the ROW may still be someone else's: adopting it out from
    // under a third agent would trade this bug for a claim-steal. Unheld, held by the gone
    // submitter, or held by the caller are all adoptable; anything else is not ours to take.
    if (
      workItem.assignee != null &&
      workItem.assignee !== current.submittedBy &&
      workItem.assignee !== input.submittedBy
    ) {
      return { resubmitted: false, state: current, reason: 'orphan-revision-held-by-other' };
    }
    isOrphanRebind = true;
  }
  if (current.status !== 'revision-requested') {
    return { resubmitted: false, state: current, reason: `not-revision-requested:${current.status}` };
  }
  const next: AgentReviewState = {
    ...current,
    status: 'pending',
    submittedBy: isLegacyRebind || isOrphanRebind ? input.submittedBy : current.submittedBy,
    round: current.round + 1,
  };
  const merged = await deps.mergeWorkItemPayload(
    workItem.id,
    {
      agentReview: next,
      implementationReadiness: reviewImplementationReadiness(workItem.payload, {
        status: 'unknown',
        reason: 'agent-review-resubmitted',
        submittedBy: next.submittedBy,
        round: next.round,
      }),
    },
    {
      ...(workItem.harness ? { harness: workItem.harness } : {}),
      unset: ['needsHuman', 'needsOwnerAction'],
    },
  );
  if (!merged) throw new Error(`resubmitAgentReview: work item '${workItem.id}' disappeared`);
  if (workItem.assignee) {
    // `expectedAssignee` is a CAS (work-items.ts: `taken_by IS NULL OR taken_by =
    // expectedAssignee`), so it must name the CURRENT holder, not the caller. On an orphan
    // rebind the holder is the gone submitter — passing the caller here would match zero
    // rows and throw "held by another agent" about a row whose only holder is a dead
    // session, re-stranding exactly the case this branch exists to rescue. The guard above
    // has already established the holder is adoptable.
    const released = await deps.releaseWorkItem(workItem.id, {
      ...(workItem.harness ? { harness: workItem.harness } : {}),
      expectedAssignee: isOrphanRebind ? workItem.assignee : input.submittedBy,
    });
    if (!released) throw new Error(`resubmitAgentReview: '${workItem.id}' is held by another agent`);
  }
  return { resubmitted: true, state: next };
}

export interface AgentReviewGradePreflight {
  applicable: boolean;
  workItemId?: string;
  state?: AgentReviewState;
  refusal?: 'agent-review-feedback-required' | 'agent-review-not-pending';
}

export async function preflightAgentReviewGrade(
  input: { ideaId: string; grade: number; feedback?: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<AgentReviewGradePreflight> {
  const ledger = await deps.readLedgerGrade(input.ideaId);
  if (!ledger) return { applicable: false };
  const workItem = await deps.getWorkItem(ledger.workItemId);
  const state = workItem ? readAgentReviewState(workItem.payload) : null;
  if (!state || state.ledgerIdeaId !== input.ideaId) return { applicable: false };
  if (state.status !== 'pending') {
    return { applicable: true, workItemId: workItem!.id, state, refusal: 'agent-review-not-pending' };
  }
  if (input.grade <= AGENT_REVIEW_MAX_REVISION_GRADE && !input.feedback?.trim()) {
    return { applicable: true, workItemId: workItem!.id, state, refusal: 'agent-review-feedback-required' };
  }
  return { applicable: true, workItemId: workItem!.id, state };
}

function revisionComment(round: number, grade: number, feedback: string, gradedBy: string): string {
  return `Agent review round ${round}: revision requested by ${gradedBy} (grade ${grade}/5).\n\n${feedback}`;
}

function approvalComment(round: number, grade: number, gradedBy: string): string {
  return `Agent review round ${round}: approved by ${gradedBy} (grade ${grade}/5). Implementation is re-admitted; this approval does not close the work item.`;
}

async function ensureComment(
  workItem: WorkItem,
  body: string,
  author: string,
  deps: AgentReviewDeps,
): Promise<boolean> {
  const detail = await deps.getWorkItemDetail(workItem.id, workItem.harness ?? undefined);
  if (detail?.posts.some((post) => post.body === body)) return false;
  const written = await deps.commentWorkItem(
    workItem.id,
    body,
    author,
    workItem.harness ? { harness: workItem.harness } : {},
  );
  if (!written) throw new Error(`agent review could not persist round history on '${workItem.id}'`);
  return true;
}

export interface AgentReviewReconcileOutcome {
  workItemId: string;
  status: 'revision-requested' | 'approved';
  round: number;
  changed: boolean;
  woken?: number;
  /**
   * WI-41687: whether the row ended up held by its original submitter. False means the
   * transfer could not be made (typically a reaped submitter session) and the reviewer's
   * claim was dropped instead, leaving the row unassigned in 'revision-requested'. The
   * revision itself is still fully recorded — grade, payload and round comment — so this
   * reports a weaker DISPOSITION, never a failed review.
   */
  returnedToSubmitter?: boolean;
}

export async function reconcileAgentReviewGrade(
  input: { ideaId: string; gradedBy: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<AgentReviewReconcileOutcome | null> {
  const ledger = await deps.readLedgerGrade(input.ideaId);
  if (!ledger) return null;
  const workItem = await deps.getWorkItem(ledger.workItemId);
  if (!workItem) return null;
  const current = readAgentReviewState(workItem.payload);
  if (!current || current.ledgerIdeaId !== input.ideaId) return null;
  if (ledger.grade == null) throw new Error(`agent review ledger '${input.ideaId}' has no standing grade`);

  const grade = ledger.grade;
  const gradedBy = ledger.gradedBy ?? input.gradedBy;
  if (grade <= AGENT_REVIEW_MAX_REVISION_GRADE) {
    const feedback = ledger.feedback?.trim();
    if (!feedback) throw new Error('agent-review-feedback-required');
    const next: AgentReviewState = { ...current, status: 'revision-requested' };
    const changed = current.status !== next.status;
    const merged = await deps.mergeWorkItemPayload(
      workItem.id,
      {
        agentReview: next,
        implementationReadiness: reviewImplementationReadiness(workItem.payload, {
          status: 'not-ready',
          reason: 'agent-review-revision-requested',
          submittedBy: current.submittedBy,
          reviewer: gradedBy,
          round: current.round,
          grade,
        }),
      },
      {
        ...(workItem.harness ? { harness: workItem.harness } : {}),
        unset: ['needsHuman', 'needsOwnerAction'],
      },
    );
    if (!merged) throw new Error(`agent review could not persist revision state on '${workItem.id}'`);
    const commentAdded = await ensureComment(
      workItem,
      revisionComment(current.round, grade, feedback, gradedBy),
      gradedBy,
      deps,
    );
    if (current.submittedBy === LEGACY_AGENT_REVIEW_SUBMITTER) {
      if (changed && workItem.assignee) {
        const released = await deps.releaseWorkItem(workItem.id, {
          ...(workItem.harness ? { harness: workItem.harness } : {}),
          expectedAssignee: gradedBy,
        });
        if (!released) throw new Error(`agent review could not release reviewer claim on '${workItem.id}'`);
      }
      return { workItemId: workItem.id, status: 'revision-requested', round: current.round, changed };
    }
    let returnedToSubmitter = true;
    if (changed) {
      const transferred = await deps.claimWorkItem(workItem.id, current.submittedBy, {
        ...(workItem.harness ? { harness: workItem.harness } : {}),
        ...(workItem.assignee ? { fromHolder: gradedBy } : {}),
      });
      if (!transferred) {
        // WI-41687: the submitter frequently no longer EXISTS by review time — a session
        // that filed a report hours earlier is routinely reaped, and a reaped owner cannot
        // take a claim. This is the common case, not an edge case.
        //
        // Throwing here stranded the row twice over. By this point the ledger grade, the
        // payload flip to 'revision-requested' and the round comment have ALL committed,
        // so the caller saw a hard error for a transition that was three-quarters applied;
        // the row kept the REVIEWER's claim (an agent who is not implementing it); and the
        // regrade path then refused to re-drive the transfer at all, because the payload had
        // already left 'pending' ('agent-review-not-pending'). Nothing could recover it
        // through the supported surface.
        //
        // Fall back to the disposition the LEGACY_AGENT_REVIEW_SUBMITTER branch above already
        // uses for "no real submitter to hand this to", and that the approval path below uses
        // unconditionally: drop the reviewer's claim and leave the row unassigned in
        // 'revision-requested'. Release is best-effort — if it also fails the row is no worse
        // off than before, and `returnedToSubmitter:false` reports the weaker disposition
        // rather than hiding it behind a thrown error.
        returnedToSubmitter = false;
        if (workItem.assignee) {
          await deps.releaseWorkItem(workItem.id, {
            ...(workItem.harness ? { harness: workItem.harness } : {}),
            expectedAssignee: gradedBy,
          });
        }
      }
    }
    let woken: number | undefined;
    if (changed || commentAdded) {
      woken = (await deps.deliverRevision({
        to: current.submittedBy,
        workItemId: workItem.id,
        round: current.round,
        grade,
        feedback,
        gradedBy,
      })).woken;
    }
    return { workItemId: workItem.id, status: 'revision-requested', round: current.round, changed, returnedToSubmitter, ...(woken === undefined ? {} : { woken }) };
  }

  const next: AgentReviewState = { ...current, status: 'approved' };
  const changed = current.status !== next.status;
  const merged = await deps.mergeWorkItemPayload(
    workItem.id,
    {
      agentReview: next,
      implementationReadiness: reviewImplementationReadiness(workItem.payload, {
        status: 'ready',
        reason: 'agent-review-approved',
        submittedBy: current.submittedBy,
        reviewer: gradedBy,
        round: current.round,
        grade,
      }),
    },
    {
      ...(workItem.harness ? { harness: workItem.harness } : {}),
      unset: ['needsHuman', 'needsOwnerAction'],
    },
  );
  if (!merged) throw new Error(`agent review could not persist approval state on '${workItem.id}'`);
  await ensureComment(workItem, approvalComment(current.round, grade, gradedBy), gradedBy, deps);
  if (workItem.assignee) {
    const released = await deps.releaseWorkItem(workItem.id, {
      ...(workItem.harness ? { harness: workItem.harness } : {}),
      expectedAssignee: gradedBy,
    });
    if (!released) throw new Error(`agent review could not release reviewer claim on '${workItem.id}'`);
  }
  return { workItemId: workItem.id, status: 'approved', round: current.round, changed };
}

export type ClaimAgentReviewReason =
  | 'not-found'
  | 'not-open'
  | 'not-review-kind'
  | 'remote-owned'
  | 'observation'
  | 'owner-capability'
  | 'agent-review-not-pending'
  | 'own-submission'
  | 'claim-conflict'
  | 'claim-not-claimable';

export interface ClaimAgentReviewResult {
  claimed: boolean;
  workItem: WorkItem | null;
  reason?: ClaimAgentReviewReason;
  claimConflict?: {
    workItemId: string;
    holder: string;
    source: 'work_items.assignee';
    assignedBy: string | null;
  };
}

/**
 * Directed reviewer pickup for one known work item.
 *
 * This is deliberately separate from claimNextAgentReview: a review request naming
 * WI-B must never consume older WI-A merely because WI-A sorts first in the shared
 * review queue. Identity remains caller-derived at the public door. The pre-claim
 * checks provide useful refusal reasons; the returned row is checked again after
 * claimWorkItem's CAS so a concurrent lifecycle transition cannot leave the reviewer
 * holding work that is no longer pending or is their own submission.
 */
export async function claimAgentReview(
  input: { id: string; reviewer: string; harnessSlug: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<ClaimAgentReviewResult> {
  const workItem = await deps.getWorkItem(input.id, input.harnessSlug);
  if (!workItem || workItem.harness !== input.harnessSlug) {
    return { claimed: false, workItem: null, reason: 'not-found' };
  }
  if (workItem.state !== 'open') {
    return { claimed: false, workItem: null, reason: 'not-open' };
  }
  const eligibility = agentReviewEligibility(workItem);
  if (!eligibility.eligible) {
    return { claimed: false, workItem: null, reason: eligibility.reason };
  }
  const current = readAgentReviewState(workItem.payload);
  if (current?.status !== 'pending') {
    return { claimed: false, workItem: null, reason: 'agent-review-not-pending' };
  }
  if (current.submittedBy === input.reviewer) {
    return { claimed: false, workItem: null, reason: 'own-submission' };
  }

  const agentReviewAdmission = mintAgentReviewClaimAdmission({
    itemId: workItem.id,
    reviewer: input.reviewer,
    harnessSlug: input.harnessSlug,
    review: current,
  });
  if (!agentReviewAdmission) {
    return { claimed: false, workItem: null, reason: 'claim-not-claimable' };
  }

  const claimed = await deps.claimWorkItem(workItem.id, input.reviewer, {
    ...(workItem.harness ? { harness: workItem.harness } : {}),
    agentReviewAdmission,
  });
  if (!claimed) {
    const latest = await deps.getWorkItem(input.id, input.harnessSlug);
    if (!latest || latest.harness !== input.harnessSlug) {
      return { claimed: false, workItem: null, reason: 'not-found' };
    }
    if (latest.state !== 'open') {
      return { claimed: false, workItem: null, reason: 'not-open' };
    }
    const latestEligibility = agentReviewEligibility(latest);
    if (!latestEligibility.eligible) {
      return { claimed: false, workItem: null, reason: latestEligibility.reason };
    }
    const latestReview = readAgentReviewState(latest.payload);
    if (latestReview?.status !== 'pending') {
      return { claimed: false, workItem: null, reason: 'agent-review-not-pending' };
    }
    if (latestReview.submittedBy === input.reviewer) {
      return { claimed: false, workItem: null, reason: 'own-submission' };
    }
    const holder = latest.assignee?.trim();
    if (holder && holder !== input.reviewer) {
      return {
        claimed: false,
        workItem: null,
        reason: 'claim-conflict',
        claimConflict: {
          workItemId: latest.id,
          holder,
          source: 'work_items.assignee',
          assignedBy: latest.assignedBy ?? null,
        },
      };
    }
    return { claimed: false, workItem: null, reason: 'claim-not-claimable' };
  }

  const claimedState = readAgentReviewState(claimed.payload);
  const postClaimReason: ClaimAgentReviewReason | null =
    claimedState?.status !== 'pending'
      ? 'agent-review-not-pending'
      : claimedState.submittedBy === input.reviewer
        ? 'own-submission'
        : null;
  if (postClaimReason) {
    const released = await deps.releaseWorkItem(claimed.id, {
      ...(claimed.harness ? { harness: claimed.harness } : {}),
      expectedAssignee: input.reviewer,
    });
    if (!released) {
      throw new Error(`claimAgentReview: could not release invalidated claim on '${claimed.id}'`);
    }
    return { claimed: false, workItem: null, reason: postClaimReason };
  }
  return { claimed: true, workItem: claimed };
}

/** Reviewer pickup over the unified queue; direct claims still use claimWorkItem's CAS. */
export async function claimNextAgentReview(
  input: { reviewer: string; harnessSlug?: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<WorkItem | null> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items wi
     WHERE workspace_id = ${ws}
       AND status = 'open'
       AND item_kind IN ('bug', 'change', 'task', 'feature')
       AND (taken_by IS NULL OR btrim(taken_by) = '')
       AND ${depsBlockedExclusionSql(sql)}
       AND ${agentReviewPendingSelectorSql(sql)}
       AND COALESCE(payload, '{}'::jsonb) -> 'agentReview' ->> 'submittedBy' IS DISTINCT FROM ${input.reviewer}
       AND ${input.harnessSlug ? sql`harness_slug = ${input.harnessSlug}` : sql`TRUE`}
     ORDER BY feature_order ASC NULLS LAST, created_ts ASC
     LIMIT 25`;
  for (const row of rows) {
    const workItem = await deps.getWorkItem(row.feature_id, input.harnessSlug);
    if (!workItem || !agentReviewEligibility(workItem).eligible) continue;
    const review = readAgentReviewState(workItem.payload);
    if (review?.status !== 'pending' || review.submittedBy === input.reviewer) continue;
    const agentReviewAdmission = workItem.harness
      ? mintAgentReviewClaimAdmission({
          itemId: workItem.id,
          reviewer: input.reviewer,
          harnessSlug: workItem.harness,
          review,
        })
      : null;
    const claimed = await deps.claimWorkItem(workItem.id, input.reviewer, {
      ...(workItem.harness ? { harness: workItem.harness } : {}),
      ...(agentReviewAdmission ? { agentReviewAdmission } : {}),
    });
    if (claimed) return claimed;
  }
  return null;
}
