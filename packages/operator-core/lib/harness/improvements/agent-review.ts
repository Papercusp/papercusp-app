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
import { isDeepStrictEqual } from 'node:util';

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
import { selfHealOwnNodeOriginIfStranded } from '../../work-items-admission';
import { recordRoutedIdea } from '../../scout/routed-ledger';
import { boundedOrgTxn } from '../../pg-bounded-txn';
import {
  agentReviewEligibility,
  agentReviewPendingSelectorSql,
  createImplementationReadiness,
  evaluateImplementationAcceptance,
  type ImplementationAcceptanceContract,
  readImplementationAcceptanceProposal,
  sealImplementationAcceptance,
  LEGACY_AGENT_REVIEW_SUBMITTER,
  mintAgentReviewClaimAdmission,
  readAgentReviewState,
  readImplementationReadiness,
  type AgentReviewState,
  type ImplementationReadinessState,
  verificationConflict,
  verificationConflictSql,
  verificationParties,
  verificationTaskConflictSql,
  type VerificationConflictRole,
} from './agent-review-policy';
import { readBornVerifiedReproduction } from '../../attention/bug-reproduction';
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
  /**
   * WI-10006314: flip an own-node row's stranded `origin='remote'` to 'local'. The heal's WHERE
   * clause IS the identity check (WI-10003565), so a foreign remote row is never touched.
   */
  healOwnNodeOrigin: typeof selfHealOwnNodeOriginIfStranded;
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
  healOwnNodeOrigin: selfHealOwnNodeOriginIfStranded,
};

/**
 * WI-10006314 — heal an own-node row stranded at `origin='remote'` BEFORE the eligibility check.
 *
 * `agentReviewEligibility` is pure and reads the raw `origin` column, but `origin` records how a
 * row ARRIVED, not who wrote it (WI-10003565): the claim gate (`issueOwnAuthorWhereSql`) and the
 * write path (`setWorkItemState`) already treat an own-author row as ours. Without this the review
 * doors were the one place that disagreed — they refused such a row as 'remote-owned', and only the
 * failure stamp's write healed it as a side effect, so it entered review on a LATER attempt
 * (measured 2026-10-06: 3 of 601 rows in the P-003 stranded sweep). Healing first also matters for
 * what follows the check: the `engineer_issues` view trigger no-ops writes while origin='remote'.
 *
 * A foreign row is untouched (the heal's WHERE is the identity check) and stays refused. Any heal
 * failure FAILS CLOSED: the row is returned unchanged, so the refusal stands as before.
 */
async function healOwnNodeRemoteOrigin(
  workItem: WorkItem,
  deps: AgentReviewDeps,
  scope: { harnessSlug?: string; workspaceId?: string },
): Promise<WorkItem> {
  if (workItem.origin !== 'remote') return workItem;
  try {
    const healed = await deps.healOwnNodeOrigin(
      scope.workspaceId ?? activeWorkspaceId(),
      workItem.id,
      scope.harnessSlug ?? workItem.harness ?? null,
    );
    if (!healed) return workItem;
    return (await deps.getWorkItem(workItem.id, scope.harnessSlug)) ?? { ...workItem, origin: 'local' };
  } catch {
    return workItem;
  }
}

function reviewImplementationReadiness(
  payload: unknown,
  input: {
    status: ImplementationReadinessState['status'];
    reason: string;
    submittedBy: string;
    round: number;
    reviewer?: string;
    grade?: number;
    /** Sealed contract written by an approval; other transitions carry the unsealed proposal. */
    acceptance?: Partial<ImplementationAcceptanceContract>;
  },
): ImplementationReadinessState {
  const existing = readImplementationReadiness(payload);
  const review = existing?.evidence?.review;
  // P-005: never drop a producer's acceptance proposal across review transitions.
  // A previously sealed contract is carried as its proposal fields only, so a
  // re-review judges it afresh rather than inheriting the old authority.
  const proposal = readImplementationAcceptanceProposal(payload);
  const acceptance = input.acceptance ?? (Object.keys(proposal).length > 0 ? proposal : undefined);
  if (
    existing?.source === 'agent-review' &&
    existing.status === input.status &&
    existing.reason === input.reason &&
    review?.submittedBy === input.submittedBy &&
    review.round === input.round &&
    review.reviewer === input.reviewer &&
    review.grade === input.grade &&
    // Order-insensitive: the stored side came back through jsonb, which reorders keys.
    isDeepStrictEqual(existing.evidence?.acceptance ?? null, acceptance ?? null)
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
      ...(acceptance ? { acceptance } : {}),
    },
  });
}

/**
 * Approval is the independent-review authority (R-20). It seals the producer's
 * proposal into a qualifying contract bound to the revision the reviewer judged;
 * an incomplete proposal is NOT defaulted — the approval stays a bare `ready`
 * that the intake-stage derivation keeps in intake (R-4).
 */
export function approvalAcceptance(
  workItem: Pick<WorkItem, 'kind' | 'title' | 'summary' | 'payload'>,
  input: { reviewer: string; submittedBy: string; round: number; grade: number },
): ImplementationAcceptanceContract | undefined {
  const authority = {
    kind: 'agent-review',
    reviewer: input.reviewer,
    submittedBy: input.submittedBy,
    round: input.round,
  } as const;
  const reason = `agent-review-approved (grade ${input.grade}/5)`;
  const source = { kind: workItem.kind, title: workItem.title, summary: workItem.summary ?? null };
  // Convergence: a retried approval of the same round must not re-seal (a fresh
  // acceptedAt would rewrite readiness on every retry). Reuse the standing contract
  // when it is still qualifying for this exact authority, grade and revision.
  const standing = evaluateImplementationAcceptance(workItem.payload, source);
  if (
    standing.state === 'qualifying' &&
    standing.contract?.reason === reason &&
    isDeepStrictEqual(standing.contract.authority, authority)
  ) {
    return standing.contract;
  }
  const sealed = sealImplementationAcceptance({
    proposal: readImplementationAcceptanceProposal(workItem.payload),
    authority,
    reason,
    source,
    // P-006 (D-019): the seal is the one verification stage. A bug is accepted only
    // with its reproduction receipt — the born-verified filing receipt (D-024) or the
    // one recorded at intake (D-023); without one the approval stays a bare `ready`.
    reproduction: workItem.kind === 'bug' ? approvalReproduction(workItem.payload) : undefined,
  });
  return sealed.ok ? sealed.contract : undefined;
}

function approvalReproduction(payload: unknown): unknown {
  const bornVerified = readBornVerifiedReproduction(payload);
  if (bornVerified) return bornVerified;
  if (!payload || typeof payload !== 'object') return undefined;
  const intake = (payload as Record<string, unknown>).intakeReproduction;
  return intake && typeof intake === 'object' ? (intake as Record<string, unknown>).receipt : undefined;
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
  const found = await deps.getWorkItem(input.id, input.harnessSlug);
  if (!found) return { entered: false, reason: 'not-found' };
  const workItem = await healOwnNodeRemoteOrigin(found, deps, input);
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
  // `gradedBy` is ATTRIBUTION only (comments, the revision notice). The ledger's standing
  // grade may be authored by someone who never held the work item — an owner-sovereign grade
  // on a pre-existing su-ideate row that agent review enrolled with `preserveExisting`
  // (EI-24720168531118378, EI-21887295701926471). Every CAS release/transfer below therefore
  // targets the CURRENT claim holder (`workItem.assignee`), never `ledger.gradedBy`: releasing
  // with `expectedAssignee:'owner'` against a row held by the reviewer session always lost the
  // CAS, threw 'could not release reviewer claim' AFTER the approval payload had committed,
  // and the row stayed held until a manual `work_items:release`.
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
          expectedAssignee: workItem.assignee,
        });
        if (!released) throw new Error(`agent review could not release reviewer claim on '${workItem.id}'`);
      }
      return { workItemId: workItem.id, status: 'revision-requested', round: current.round, changed };
    }
    let returnedToSubmitter = true;
    if (changed) {
      const transferred = await deps.claimWorkItem(workItem.id, current.submittedBy, {
        ...(workItem.harness ? { harness: workItem.harness } : {}),
        ...(workItem.assignee ? { fromHolder: workItem.assignee } : {}),
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
            expectedAssignee: workItem.assignee,
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
        acceptance: approvalAcceptance(workItem, {
          reviewer: gradedBy,
          submittedBy: current.submittedBy,
          round: current.round,
          grade,
        }),
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
      expectedAssignee: workItem.assignee,
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
  /** P-007: the reviewer filed or reported the subject. */
  | 'reporter-conflict'
  /** P-007: the reviewer implemented the subject (terminal owner or a recorded implementer). */
  | 'implementer-conflict'
  | 'claim-conflict'
  | 'claim-not-claimable';

function conflictReason(role: VerificationConflictRole | null): ClaimAgentReviewReason | null {
  if (role === 'reporter') return 'reporter-conflict';
  if (role === 'implementer') return 'implementer-conflict';
  return null;
}

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
  let workItem = await deps.getWorkItem(input.id, input.harnessSlug);
  if (!workItem || workItem.harness !== input.harnessSlug) {
    return { claimed: false, workItem: null, reason: 'not-found' };
  }
  if (workItem.state !== 'open') {
    return { claimed: false, workItem: null, reason: 'not-open' };
  }
  workItem = await healOwnNodeRemoteOrigin(workItem, deps, { harnessSlug: input.harnessSlug });
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
  const parties = verificationParties(workItem);
  const conflict = conflictReason(verificationConflict(parties, input.reviewer));
  if (conflict) return { claimed: false, workItem: null, reason: conflict };

  const agentReviewAdmission = mintAgentReviewClaimAdmission({
    itemId: workItem.id,
    reviewer: input.reviewer,
    harnessSlug: input.harnessSlug,
    review: current,
    parties,
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
    const latestConflict = conflictReason(verificationConflict(verificationParties(latest), input.reviewer));
    if (latestConflict) return { claimed: false, workItem: null, reason: latestConflict };
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
        : conflictReason(verificationConflict(verificationParties(claimed), input.reviewer));
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
       AND NOT ${verificationConflictSql(sql, input.reviewer, { payload: 'wi.payload', terminalOwner: 'wi.terminal_owner' })}
       AND ${input.harnessSlug ? sql`harness_slug = ${input.harnessSlug}` : sql`TRUE`}
     ORDER BY feature_order ASC NULLS LAST, created_ts ASC
     LIMIT 25`;
  for (const row of rows) {
    const found = await deps.getWorkItem(row.feature_id, input.harnessSlug);
    if (!found) continue;
    const workItem = await healOwnNodeRemoteOrigin(found, deps, { harnessSlug: input.harnessSlug, workspaceId: ws });
    if (!agentReviewEligibility(workItem).eligible) continue;
    const review = readAgentReviewState(workItem.payload);
    if (review?.status !== 'pending' || review.submittedBy === input.reviewer) continue;
    const parties = verificationParties(workItem);
    if (verificationConflict(parties, input.reviewer)) continue;
    // A 'pending' round whose ledger row ALREADY carries a standing grade is not reviewable:
    // `enterAgentReview` enrolls with `preserveExisting`, so a pre-existing su-ideate row that
    // the owner had already graded keeps that sovereign grade while the payload starts at
    // 'pending' — and nothing reconciles the two until someone grades. Handing it out made the
    // reviewer burn a review on a foregone conclusion (their grade cannot displace the owner's
    // and is refused or ignored). Converge it here from the standing grade instead, then move
    // on. Best-effort: a row that cannot converge (e.g. a low grade with no feedback) is
    // skipped, never handed out. (EI-24720168531118378)
    //
    // ROUND 1 ONLY. A standing grade is sovereign only when it pre-dates enrollment, which is
    // round 1. Resubmit and re-entry advance the round without clearing the ledger row, so in
    // round >= 2 the standing grade is the one that ALREADY decided an earlier round.
    // Converging from it replays the old grade and feedback as the new round, bounces the
    // item back to its submitter, and no reviewer ever sees the revision (WI-10005365).
    // A fresh grade in round >= 2 arrives through blender:grade-idea, which reconciles it itself.
    const standing = review.round === 1 ? await deps.readLedgerGrade(review.ledgerIdeaId) : null;
    if (standing && standing.grade != null && standing.workItemId === workItem.id) {
      try {
        await reconcileAgentReviewGrade(
          { ideaId: review.ledgerIdeaId, gradedBy: standing.gradedBy ?? input.reviewer },
          deps,
        );
      } catch {
        // leave it for a direct regrade / the next pickup; never hand out a settled row
      }
      continue;
    }
    const agentReviewAdmission = workItem.harness
      ? mintAgentReviewClaimAdmission({
          itemId: workItem.id,
          reviewer: input.reviewer,
          harnessSlug: workItem.harness,
          review,
          parties,
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

/**
 * P-007 Phase B (D-027): the verification-task leg of the verifier lane. A verification
 * task (payload.verification, stamped by `investigate`) is an ordinary ready row, so it is
 * claimed through claimWorkItem, the by-id writer that enforces the D-021 conflict rule,
 * the floors and admission. The SQL only orders candidates and applies the self-select
 * dependency floor; it admits nothing the writer would refuse.
 */
export async function claimNextVerificationTask(
  input: { verifier: string; harnessSlug?: string },
  deps: Pick<AgentReviewDeps, 'claimWorkItem'> = defaultDeps,
): Promise<WorkItem | null> {
  const verifier = input.verifier.trim();
  if (!verifier) return null;
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql<{ feature_id: string; harness_slug: string | null }[]>`
    SELECT feature_id, harness_slug
      FROM harness_shared.work_items wi
     WHERE workspace_id = ${ws}
       AND status = 'open'
       AND (taken_by IS NULL OR btrim(taken_by) = '')
       AND jsonb_typeof(COALESCE(payload, '{}'::jsonb) -> 'verification') = 'object'
       ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
       AND ${depsBlockedExclusionSql(sql)}
       AND NOT ${verificationTaskConflictSql(sql, verifier, 'wi.payload')}
     ORDER BY created_ts ASC, feature_id ASC
     LIMIT 20`;
  for (const row of rows) {
    const claimed = await deps.claimWorkItem(row.feature_id, verifier, row.harness_slug ? { harness: row.harness_slug } : {});
    if (claimed) return claimed;
  }
  return null;
}

export type VerificationWorkKind = 'agent-review' | 'verification-task';

/** P-007 Phase B (D-027): one verifier-lane pull. Pending reviews first, then verification tasks. */
export async function claimNextVerificationWork(
  input: { verifier: string; harnessSlug?: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<{ workItem: WorkItem; kind: VerificationWorkKind } | null> {
  const review = await claimNextAgentReview({ reviewer: input.verifier, harnessSlug: input.harnessSlug }, deps);
  if (review) return { workItem: review, kind: 'agent-review' };
  const task = await claimNextVerificationTask(input, deps);
  return task ? { workItem: task, kind: 'verification-task' } : null;
}
