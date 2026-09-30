/**
 * acceptance-seat-succession — who may record a plan's acceptance verdict when
 * the recorded rubric author is DEAD (WI-2141007).
 *
 * THE DEADLOCK THIS EXISTS TO BREAK. Plan completion step 6 requires the
 * acceptance-rubric AUTHOR to emit the card carrying `acceptance:{verdict}`.
 * Two rails then close on each other once that author's session ends:
 *   - only the rubric author may record the acceptance verdict; and
 *   - any session in the author's spawn/rebind lineage is refused as a grader.
 * A session OUTSIDE the lineage is not the author. A session INSIDE it is
 * refused for being inside it. With a dead author the intersection is EMPTY and
 * the plan is permanently unshippable. `plans:set-plan-status force:{reason}`
 * does not help: it waives only the code-truth family and explicitly never
 * waives the implementer verdict. On a fleet where members are routinely reaped
 * this is not an edge case — the rubric author is normally the implementer, and
 * implementers are exactly the sessions that get reaped.
 *
 * WHY NOT `coord:rebind-identity` (which the old refusal advertised). That is
 * identity CONTINUITY — ONE agent reclaiming its own surfaces after a
 * relaunch changed its sid — and it migrates the dead author's ENTIRE
 * owner-keyed surface set: armed loops, plan/work-item claims, scheduler claim
 * spec, standing awaits, fleet membership, held file locks, owner-scoped facts.
 * Invoking it so an unrelated live peer can pass an independence control both
 * defeats the control and moves state nobody asked to move
 * (EI-22135313244682666). This module transfers the SEAT ALONE and records that
 * it did, on the card.
 *
 * THE SAFETY PROPERTY THE REPAIR MUST NOT BREAK. Independence stays measured
 * against the ORIGINAL author's lineage, exactly as before — a successor does
 * not launder a related grader into an independent one. And because the
 * successor now holds author authority, the caller ALSO may not accept a
 * grading from their OWN lineage; otherwise the three-party chain
 * (author -> critic -> grader) collapses into a session grading its own work
 * and then accepting it. Both halves are enforced by the caller in
 * `scorecards:emit`; this module answers only the identity question.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import type { AcceptanceSeatSuccession } from './harness/improvements/observation-types';
import { acceptanceDrainPlanRef } from './agent-tools/plans/acceptance-drain-filing';

/** A session-state verdict, structurally matching the liveness oracle's. */
type SessionStateLike = string;

export interface AcceptanceSeatBasis {
  /** The work-item that makes the caller accountable for the subject plan. */
  workItemId: string;
  /** The plan slug that work-item belongs to. */
  planSlug: string;
}

export type AcceptanceSeatIneligibleReason =
  | 'no_author_of_record'
  | 'no_subject_plan'
  | 'author_still_reachable'
  | 'author_state_unknown'
  | 'caller_not_accountable_for_plan';

export type AcceptanceSeatResolution =
  | { eligible: true; succession: AcceptanceSeatSuccession }
  | { eligible: false; reason: AcceptanceSeatIneligibleReason; authorSessionState?: SessionStateLike };

/**
 * Whether `callerId` currently holds either:
 *
 *   1. a work-item belonging to `subjectPlan`; or
 *   2. the canonical acceptance-drain work-item filed for that plan.
 *
 * The second leg is deliberately keyed by `payload.acceptanceDrainPlan`, not
 * the plan's own `source_plan_slug`. Acceptance-drain work is an independent
 * ceremony item: the plan's implementation rows are terminal by the time this
 * seat is needed, and therefore cannot provide a live accountability lease.
 *
 * `taken_by` is the accountability signal on purpose: it is CLEARED when a
 * session dies or releases (session-death-claim-release-2026-07-11), so a match
 * means "this agent is accountable for this plan's work right now", not "some
 * agent touched this plan once". That self-limiting property is what makes it
 * safe to key a seat transfer on.
 *
 * ⚠ Reads the canonical `harness_shared.work_items` BASE TABLE, never the
 * `engineer_issues` view. That view is issue-family (bug/change/task) and omits
 * feature-family `WI-`/`F-` rows — and a plan's acceptance-ceremony item is
 * normally feature-family, so keying this off the view would make succession
 * silently ineligible in precisely its main case.
 */
export async function resolveAcceptanceSeatBasis(
  callerId: string,
  subjectPlan: string | null | undefined,
  opts: { sql?: Sql; workspaceId?: string; harness?: string | null } = {},
): Promise<AcceptanceSeatBasis | null> {
  const planSlug = typeof subjectPlan === 'string' ? subjectPlan.trim() : '';
  if (!planSlug || !callerId) return null;
  const sql = opts.sql ?? getOrgPg().sql;
  const workspaceId = opts.workspaceId || activeWorkspaceId();
  const harness = typeof opts.harness === 'string' && opts.harness.trim() ? opts.harness.trim() : null;
  // Keep this marker in lockstep with acceptanceDrainPlanRef(), the canonical
  // filer-side identity. Without the harness context there is no safe way to
  // choose one tenant's acceptance-drain item when plan slugs collide.
  const acceptanceDrainRef = harness
    ? acceptanceDrainPlanRef({ workspaceId, harnessSlug: harness, planSlug })
    : null;
  const planWorkItemMatch = sql`
    (
      (
        source_plan_slug = ${planSlug}
        OR payload -> 'plan_item' ->> 'plan_slug' = ${planSlug}
      )
      ${harness ? sql`AND harness_slug = ${harness}` : sql``}
    )
  `;
  const acceptanceDrainWorkItemMatch = acceptanceDrainRef
    ? sql`payload ->> 'acceptanceDrainPlan' = ${acceptanceDrainRef}`
    : sql`FALSE`;
  const rows = (await sql`
    SELECT feature_id
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND taken_by = ${callerId}
       AND (${planWorkItemMatch} OR ${acceptanceDrainWorkItemMatch})
     ORDER BY feature_id
     LIMIT 1
  `) as Array<{ feature_id: string | null }>;
  const workItemId = rows[0]?.feature_id ?? null;
  return workItemId ? { workItemId, planSlug } : null;
}

/**
 * Resolve whether `callerId` may inherit the acceptance seat of `authorId`.
 *
 * Eligibility requires ALL of:
 *  1. an author of record exists, and is NOT the caller (that is the ordinary
 *     path, not a succession);
 *  2. the author's session is confirmed non-live — the same
 *     `REBIND_BLOCKING_SESSION_STATES` exclusion the author-refusal hint uses,
 *     so a live/parked/draining author's seat can never be taken out from under
 *     them. An UNKNOWN verdict (probe fault) is refused, not assumed dead:
 *     silence must never widen authority.
 *  3. the caller currently holds a work-item for the rubric's subject plan,
 *     including the independent acceptance-drain work-item filed for it.
 *
 * Never throws — a probe or query fault degrades to ineligible, so a fault can
 * only ever DENY the transfer.
 */
export async function resolveAcceptanceSeatSuccession(params: {
  authorId: string | null;
  callerId: string;
  subjectPlan: string | null | undefined;
  workspaceId: string;
  harness?: string | null;
  resolveAuthorSessionState: (
    ownerId: string,
    opts: { workspaceId?: string },
  ) => Promise<SessionStateLike | null>;
  sql?: Sql;
  now?: () => Date;
}): Promise<AcceptanceSeatResolution> {
  const { authorId, callerId, subjectPlan, workspaceId } = params;
  if (!authorId || authorId === callerId) return { eligible: false, reason: 'no_author_of_record' };
  const planSlug = typeof subjectPlan === 'string' ? subjectPlan.trim() : '';
  if (!planSlug) return { eligible: false, reason: 'no_subject_plan' };

  let state: SessionStateLike | null;
  try {
    state = await params.resolveAuthorSessionState(authorId, { workspaceId });
  } catch {
    return { eligible: false, reason: 'author_state_unknown' };
  }
  // An unreadable verdict is NOT a dead author. Refuse rather than infer.
  if (state == null) return { eligible: false, reason: 'author_state_unknown' };
  try {
    const { REBIND_BLOCKING_SESSION_STATES } = await import('./agent-tools/coordination/rebind-identity');
    if ((REBIND_BLOCKING_SESSION_STATES as readonly string[]).includes(state)) {
      return { eligible: false, reason: 'author_still_reachable', authorSessionState: state };
    }
  } catch {
    return { eligible: false, reason: 'author_state_unknown' };
  }

  let basis: AcceptanceSeatBasis | null;
  try {
    basis = await resolveAcceptanceSeatBasis(callerId, planSlug, {
      sql: params.sql,
      workspaceId,
      harness: params.harness,
    });
  } catch {
    return { eligible: false, reason: 'caller_not_accountable_for_plan', authorSessionState: state };
  }
  if (!basis) {
    return { eligible: false, reason: 'caller_not_accountable_for_plan', authorSessionState: state };
  }

  const now = params.now ?? (() => new Date());
  return {
    eligible: true,
    succession: {
      succeededFrom: authorId,
      authorSessionState: state,
      basisWorkItemId: basis.workItemId,
      basisPlanSlug: basis.planSlug,
      succeededAt: now().toISOString(),
    },
  };
}

/**
 * The refusal text shown when a caller offers an author verdict, is not the
 * author, and could not inherit the seat. It names the ONE thing that would
 * make them eligible, per reason — an agent reading "you are not the author"
 * with no route is exactly how this became a reported permanent dead-end.
 */
export function acceptanceSeatRefusalHint(
  resolution: Extract<AcceptanceSeatResolution, { eligible: false }>,
  authorId: string | null,
  subjectPlan: string | null | undefined,
  scope: { workspaceId?: string | null; harness?: string | null } = {},
): string {
  switch (resolution.reason) {
    case 'author_still_reachable':
      return (
        ` — the recorded author's session is still reachable (sessionState: ` +
        `'${resolution.authorSessionState}'), so the seat cannot be inherited; ask them to record the verdict`
      );
    case 'caller_not_accountable_for_plan': {
      const workspaceId = scope.workspaceId?.trim() ?? '';
      const harnessSlug = scope.harness?.trim() ?? '';
      const planSlug = subjectPlan?.trim() ?? '';
      const acceptanceDrainRef = workspaceId && harnessSlug && planSlug
        ? acceptanceDrainPlanRef({ workspaceId, harnessSlug, planSlug })
        : null;
      const acceptanceDrainInstruction = acceptanceDrainRef
        ? `payload.acceptanceDrainPlan = '${acceptanceDrainRef}'`
        : `payload.acceptanceDrainPlan using the canonical <workspace>/<harness>/<plan> ref for ` +
          `'${planSlug || 'this rubric’s subject plan'}'`;
      return (
        ` — the recorded author's session has ended (sessionState: '${resolution.authorSessionState}'), so the ` +
        `seat MAY be inherited, but only by a session accountable for the plan: claim the plan's work-item ` +
        `or its independent acceptance-drain work-item (work_items:claim; the latter is filed with ` +
        `${acceptanceDrainInstruction}) and re-emit. ` +
        `If you ARE that author under a new sid (a relaunch/carry-respawn changed your ` +
        `PAPERCUSP_SID), coord:rebind-identity { from: '${authorId ?? 'the author'}' } remains the correct ` +
        `recovery and this guard walks its audited trail. Do NOT reach for it as an unrelated PEER just to pass ` +
        `this check: it migrates the dead author's whole owner-keyed surface set (armed loops, claims, file ` +
        `locks, facts, fleet membership), which is not what recording one verdict should do`
      );
    }
    case 'author_state_unknown':
      return (
        ` — the recorded author's session state could not be read, so seat succession cannot be authorized ` +
        `(an unreadable verdict is deliberately NOT treated as a dead author); retry once the liveness probe recovers`
      );
    default:
      return '';
  }
}
