/**
 * goal-context — the ONE answer to "which goal does this agent's work serve?"
 * (goal-mode-hardening-2026-08-10 P-002, D-008).
 *
 * WHY THIS IS NOT `getModeSubject(ws, owner, 'goal')`. It used to be. Goal
 * provenance (`work_items.goal_id`) was stamped by reading the creator's own
 * GOAL-mode subject, which is correct for exactly one agent — the one RUNNING
 * the goal — and silently wrong for everyone it spawns. A fleet member launched
 * by a goal agent has no goal-mode row, so every work-item it created stamped
 * NULL and fell out of the goal's spend meter and its "what belongs to this
 * goal?" view. The goal agent's own handful of items were counted; the fleet
 * doing the actual work was invisible.
 *
 * The fix is NOT to give the child a goal-mode row. That would make it a
 * portfolio manager (`isGoalSessionModes()` true), hide it from the ordinary
 * sessions board, and hand it GOAL's never-implement contract — the thing P-002
 * names explicitly: "a fleet member must not become a portfolio manager". The
 * two facts were only ever conflated because, before fleets, the only session
 * that created work under a goal WAS the goal's agent:
 *
 *   agent_modes.subject (mode='goal')  -> this session RUNS the goal
 *   session_briefs.goal_id             -> this session's WORK BELONGS TO the goal
 *
 * TRANSITIVITY IS A PROPERTY OF THE RESOLVER, not of the launch code. A launch
 * injects the LAUNCHER's *resolved* context (this function), not its mode
 * subject — so a child that inherited resolves the same goal, and ITS children
 * inherit it in turn. Nothing special-cases depth; "descendants" falls out.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  readGoalHolderAuthority,
  type GoalHolderAuthority,
} from '../goals/holder-authority';

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/** A typed refusal so launch/write boundaries can fail closed rather than degrade. */
export class GoalHolderAuthorityError extends Error {
  readonly code: 'goal_holder_superseded' | 'goal_holder_authority_unreadable';

  constructor(
    readonly authority: GoalHolderAuthority | null,
    readonly ownerId: string,
    cause?: unknown,
  ) {
    super(
      authority
        ? `GOAL holder ${ownerId} is superseded for '${authority.goalId ?? 'unknown'}'; ` +
          `elected holder is ${authority.electedOwnerId ?? 'unknown'} at epoch ` +
          `${authority.electedEpoch ?? 'legacy'}`
        : `GOAL holder authority is unreadable for ${ownerId}; refusing goal-scoped context and mutation`,
    );
    this.code = authority ? 'goal_holder_superseded' : 'goal_holder_authority_unreadable';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
    this.name = 'GoalHolderAuthorityError';
  }
}

export function isGoalHolderAuthorityError(error: unknown): error is GoalHolderAuthorityError {
  return error instanceof GoalHolderAuthorityError;
}

/**
 * The shared pre-write fence for every goal-scoped mutation/provenance door.
 *
 * `none`, `elected`, and a still-live named `handoff` are all valid callers.
 * An expired predecessor is refused with the elected-holder diagnosis. A read
 * failure is ALSO a refusal: falling through to inherited context when the
 * authority store is unreadable would turn absence of evidence into authority.
 */
export async function assertGoalHolderMutationAuthority(
  workspaceId: string,
  ownerId: string,
  sql?: Sql,
): Promise<GoalHolderAuthority> {
  let authority: GoalHolderAuthority;
  try {
    authority = await readGoalHolderAuthority(pg(sql), workspaceId, ownerId);
  } catch (error) {
    throw new GoalHolderAuthorityError(null, ownerId, error);
  }
  if (authority.status === 'superseded') {
    throw new GoalHolderAuthorityError(authority, ownerId);
  }
  return authority;
}

/**
 * The goal id INHERITED by this agent from its launcher, or null.
 *
 * Deliberately separate from {@link resolveGoalContext} so a caller that needs
 * to know *how* an agent is attached to a goal (ran it vs inherited it) can ask
 * without re-deriving the precedence, and so the fallback leg is testable on its
 * own.
 *
 * Fail-soft to null on ANY error, including the "column does not exist" a node
 * that has not yet applied migration 785 will raise: every caller is a stamping
 * or launch path where the correct behaviour when provenance cannot be resolved
 * is to record none, never to fail the operation it was decorating.
 */
export async function getInheritedGoalContext(
  workspaceId: string,
  ownerId: string,
  sql?: Sql,
): Promise<string | null> {
  if (!workspaceId || workspaceId === '*' || !ownerId) return null;
  try {
    const rows = await pg(sql)`
      SELECT goal_id FROM harness_shared.session_briefs
      WHERE owner_id = ${ownerId} AND workspace_id = ${workspaceId}
      LIMIT 1`;
    const raw = rows.length ? (rows[0] as { goal_id?: unknown }).goal_id : null;
    return raw == null || raw === '' ? null : String(raw);
  } catch {
    return null;
  }
}

/**
 * Record that `ownerId` works under `goalId`, inherited from its launcher.
 *
 * A NARROW writer rather than `writeSessionBrief({ goalId })` on purpose. That
 * function assigns `owner_label`, `source` and `intent` unconditionally in its
 * ON CONFLICT clause — correct for a presence write, destructive here: a
 * carry-respawn reuses the SAME ownerId, so the brief row already exists and
 * carries the predecessor's declared intent, which is exactly the field a
 * successor reads first. This touches `goal_id` and nothing else.
 *
 * The INHERITED value wins over an existing one. Launch is an explicit act, and
 * an agent relaunched by a different goal's agent has genuinely been re-parented
 * — the alternative (populate-once-then-keep, as the other lanes use) would pin
 * a recycled owner id to a goal that no longer owns it.
 *
 * Fail-soft: a launch must never fail because provenance could not be recorded.
 * Returns whether the write landed, so a caller can log the miss instead of
 * assuming success.
 */
export async function setInheritedGoalContext(
  workspaceId: string,
  ownerId: string,
  goalId: string,
  sql?: Sql,
): Promise<boolean> {
  if (!workspaceId || workspaceId === '*' || !ownerId || !goalId) return false;
  try {
    await pg(sql)`
      INSERT INTO harness_shared.session_briefs
        (owner_id, workspace_id, goal_id, first_seen_at, updated_at)
      VALUES (${ownerId}, ${workspaceId}, ${goalId}, now(), now())
      ON CONFLICT (owner_id) DO UPDATE SET
        goal_id    = EXCLUDED.goal_id,
        updated_at = now()`;
    return true;
  } catch {
    return false;
  }
}

/**
 * The goal this agent's work serves — the single resolution every provenance
 * stamp and every launch-time inheritance goes through.
 *
 * Precedence is load-bearing and is the reason this is one function rather than
 * two call sites doing `?? `: an agent that is BOTH running a goal and was
 * launched under another one must attribute its work to the goal it runs. That
 * is reachable today — a goal agent spawned by a higher-level goal agent — and
 * the opposite order would silently re-parent a whole sub-portfolio's work to
 * its grandparent.
 */
export async function resolveGoalContext(
  workspaceId: string,
  ownerId: string,
  sql?: Sql,
): Promise<string | null> {
  if (!workspaceId || workspaceId === '*' || !ownerId) return null;
  const authority = await assertGoalHolderMutationAuthority(workspaceId, ownerId, sql);
  if (authority.status === 'elected' || authority.status === 'handoff') {
    return authority.goalId;
  }
  return getInheritedGoalContext(workspaceId, ownerId, sql);
}

/**
 * Stamp a NEWLY CREATED plan with the goal its creator is working (migration 791).
 *
 * WHY THIS EXISTS — owner-reported 2026-08-10: the goal popup showed the goal's work
 * item but not the plan its agent had just created. That was not a rendering fault. A
 * plan reached a goal by exactly one derivation: a goal-stamped work item whose
 * `source_plan_slug` names it. That derivation is honest but structurally blind to the
 * case that matters most on a young goal — the plan the goal's OWN agent authored,
 * before any work item from it exists. Measured on the goal that reported it: one
 * stamped work item, `source_plan_slug` NULL, and the just-started plan invisible.
 * EVERY new goal begins in that state, so the rail was emptiest exactly while the owner
 * was watching to see whether the agent had done anything.
 *
 * It is deliberately the SAME rule as `stampGoalProvenance` for work items, not a new
 * one: written from the creator's RESOLVED goal context, never from an argument, so a
 * plan cannot self-report its way onto a goal; and never over an existing stamp, so the
 * first attribution wins and a later editor cannot re-parent someone else's plan.
 *
 * Best-effort BY DESIGN — provenance is metadata, and a plan that was successfully
 * created must not be failed retroactively because its stamp could not be written. The
 * caller therefore does not await a verdict it would have no way to act on.
 */
export async function stampPlanGoalProvenance(args: {
  workspaceId: string | undefined;
  harnessSlug: string | undefined;
  planSlug: string;
  ownerId: string | undefined;
  sql?: Sql;
  /** Test seam for the worklist enrollment that follows a first stamp. */
  enroll?: typeof enrollGoalAuthoredPlanOnWorklist;
}): Promise<string | null> {
  const { workspaceId, harnessSlug, planSlug, ownerId } = args;
  if (!workspaceId || workspaceId === '*' || !harnessSlug || !planSlug || !ownerId) return null;
  try {
    const goalId = await resolveGoalContext(workspaceId, ownerId, args.sql);
    if (!goalId) return null;
    const sql = args.sql ?? getOrgPg().sql;
    const stamped = await sql<Array<{ plan_slug: string }>>`
      UPDATE harness_shared.harness_plans
         SET goal_id = ${goalId}
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${harnessSlug}
         AND plan_slug    = ${planSlug}
         AND goal_id IS NULL
      RETURNING plan_slug
    `;
    // Only the FIRST attribution enrolls the plan (WI-10003913). A plan that
    // already belonged to a goal is not re-listed, and an owner who later
    // removes it from the worklist keeps that removal.
    if (Array.isArray(stamped) && stamped.length > 0) {
      const enroll = args.enroll ?? enrollGoalAuthoredPlanOnWorklist;
      const enrolled = await enroll({ workspaceId, goalId, harnessSlug, planSlug, actorId: ownerId, sql: args.sql })
        .catch((error: unknown): GoalWorklistEnrollment => ({
          outcome: 'refused', ref: goalWorklistRef(harnessSlug, planSlug),
          code: error instanceof Error ? error.message : String(error),
        }));
      if (enrolled.outcome === 'refused') {
        // Loud, not fatal: the plan exists and is stamped, but the goal's
        // placement policy will not see it until the worklist lists it.
        console.warn(`[goal-context] plan ${enrolled.ref} stamped to goal ${goalId} but NOT enrolled on its worklist: ${enrolled.code}`);
      }
    }
    return goalId;
  } catch (error) {
    if (isGoalHolderAuthorityError(error)) throw error;
    return null;
  }
}

/** The canonical worklist ref shape (`plan:<harness>/<slug>`) the portfolio reader resolves. */
export function goalWorklistRef(harnessSlug: string, planSlug: string): string {
  return `plan:${harnessSlug}/${planSlug}`;
}

export type GoalWorklistEnrollment =
  | { outcome: 'enrolled'; ref: string; version: number }
  | { outcome: 'already-listed'; ref: string }
  | { outcome: 'refused'; ref: string; code: string };

/**
 * Put a plan the goal's OWN agent just authored onto that goal's canonical
 * `worklist` property (WI-10003913).
 *
 * WHY: two rails named a goal's plans and they disagreed. `plans:new` stamps
 * `harness_plans.goal_id` (above), but the placement policy, the goal brief
 * and the turn-end placement receipts read ONLY `properties.worklist`. A goal
 * whose holder never hand-edited the worklist therefore looked plan-less: its
 * plan-placement obligation read `not-applicable` with no plan on every turn,
 * even while its own fleet was claiming that plan's items (measured on both
 * P-007 trial goals, 2026-09-27). Enrolling at creation makes the worklist
 * carry what the stamp already knows, through the same CAS writer
 * `goals:set-property` uses (agent-edit provenance; the canonical declaration
 * is `editable_by: 'both'`).
 *
 * Runs in its own transaction: the goal row is locked, the current version is
 * read under that lock, and the write is CAS-guarded against it.
 */
export async function enrollGoalAuthoredPlanOnWorklist(args: {
  workspaceId: string;
  goalId: string;
  harnessSlug: string;
  planSlug: string;
  actorId: string;
  sql?: Sql;
  write?: typeof import('../typed-properties-db').applyGoalPropertyWrite;
}): Promise<GoalWorklistEnrollment> {
  const ref = goalWorklistRef(args.harnessSlug, args.planSlug);
  const write = args.write ?? (await import('../typed-properties-db')).applyGoalPropertyWrite;
  const { CANONICAL_WORKLIST_PROPERTY } = await import('../goals/package-property-datatypes');
  const run = async (tx: Sql): Promise<GoalWorklistEnrollment> => {
    const rows = await tx<Array<{ worklist: unknown }>>`
      SELECT properties -> ${CANONICAL_WORKLIST_PROPERTY}::text AS worklist
        FROM harness_shared.goals
       WHERE id = ${args.goalId} AND workspace_id = ${args.workspaceId}
       FOR UPDATE`;
    if (!rows[0]) return { outcome: 'refused', ref, code: 'not_found' };
    const current = (rows[0].worklist ?? null) as { value?: unknown; version?: unknown } | null;
    const listed: unknown[] = Array.isArray(current?.value) ? [...current.value] : [];
    if (listed.includes(ref) || listed.includes(`plan:${args.planSlug}`)) return { outcome: 'already-listed', ref };
    const expectedVersion = typeof current?.version === 'number' ? current.version : 0;
    const result = await write(tx, {
      workspaceId: args.workspaceId,
      goalId: args.goalId,
      property: CANONICAL_WORKLIST_PROPERTY,
      value: [...listed, ref],
      expectedVersion,
      provenance: 'agent-edit',
      actorId: args.actorId,
    });
    if (!result.ok) return { outcome: 'refused', ref, code: result.code };
    return { outcome: 'enrolled', ref, version: expectedVersion + 1 };
  };
  const sql = pg(args.sql);
  const begin = (sql as unknown as { begin?: unknown }).begin;
  if (typeof begin !== 'function') return run(sql);
  return (await sql.begin((tx) => run(tx as unknown as Sql))) as GoalWorklistEnrollment;
}
