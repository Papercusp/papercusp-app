/**
 * provenance-stamp.ts — the ONE write of `work_items.goal_id` from session context
 * (goal-mode-2026-08-07 P-016; goal-mode-hardening-2026-08-10 P-002 / D-008).
 *
 * ── WHY THIS IS A MODULE AND NOT A PRIVATE HELPER ────────────────────────────
 *
 * Until WI-2140701 (b) this lived as a private function inside
 * `agent-tools/work_items/_create-core.ts`, so exactly ONE door stamped:
 * `work_items:create`. `improvements:capture` — the door a goal steward files
 * most of its findings through, and the one every watchdog and grader uses —
 * minted its rows through `captureImprovement` → `createIssue` and never touched
 * this, so those rows carried `goal_id = NULL`. Measured while grading card 4
 * (goal-mode-e2e rev36, subject su-b298b4b4): the holder's captures were invisible
 * to its goal's "what belongs to me" view and to the spend rollup, and the grader
 * read the goal as having produced less than it had. Two doors, one rule, one
 * function: every door that mints a work-item row stamps through here.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *
 * Stamp from SESSION CONTEXT — the resolved goal of the creating agent — never
 * from an argument. Self-report does not survive a compaction: an agent three
 * days into a goal, on its fifth session, has no memory of the goal id and simply
 * omits it. Before the mechanism existed `goal_id` was NULL on all 65,462 rows.
 *
 * `resolveGoalContext` is deliberately the only read. It answers for the agent
 * RUNNING the goal AND for every agent that goal spawned (the inherited leg,
 * D-008), so the fleet doing the work is attributed without being given GOAL mode.
 *
 * Never clobbers: `AND goal_id IS NULL`, so an item explicitly attributed
 * elsewhere (`work_items:update { goal }`, a plan-item conversion) outranks the
 * ambient session mode.
 *
 * A DECORATION, by contract: best-effort and non-fatal at every call site. Losing
 * provenance is bad; failing a creation because provenance could not be recorded
 * is worse. Call sites therefore catch, RECORD the error on the result
 * (`goalStampError`) and continue — an empty catch here once made a stamp that
 * THREW indistinguishable from one that correctly DECLINED (EI-20075667133396690),
 * and declining is the overwhelming majority case.
 *
 * Verified against REAL SQL by
 * `agent-tools/work_items/goal-provenance-stamp.integration.test.ts` — tsc cannot
 * see inside a SQL template, and the resolver's own suite runs over a mock seam.
 */
import { getOrgPg } from '@papercusp/db-org';

import { resolveGoalContext } from '../modes/goal-context';

/** The row to stamp — its id and, when known, the harness half of the table's identity. */
export interface GoalProvenanceSubject {
  id: string;
  /**
   * `work_items` is keyed on (harness_slug, feature_id). When the caller knows the
   * harness the stamp uses that identity verbatim; when it does not (an
   * operator-scope issue, where `harnessFromScope` yields null) it keys on
   * (workspace_id, feature_id) instead, which is unique because feature ids are
   * minted from one sequence. Passing null used to render `harness_slug = NULL`
   * and silently match nothing.
   */
  harness?: string | null;
}

/**
 * Stamp a freshly-created work-item with the goal its creator is running.
 *
 * Returns the goal id when a stamp was written, `null` in every not-applicable
 * case — no concrete workspace in scope, no owner, or the creator is attached to
 * no goal at all. NONE of those are errors: most work on this fleet is not goal
 * work, so a silent null is the common and correct outcome.
 */
export async function stampGoalProvenance(
  item: GoalProvenanceSubject,
  workspaceId: string | undefined,
  ownerId: string | undefined,
): Promise<string | null> {
  if (!workspaceId || workspaceId === '*' || !ownerId) return null;
  const goalId = await resolveGoalContext(workspaceId, ownerId);
  if (!goalId) return null;
  const { sql } = getOrgPg();
  const harness = item.harness ?? null;
  // ONE statement, no composed fragment: `_create-core.goal-stamp-silence.test.ts`
  // pins that a stamp is exactly one `sql` call, which is also what keeps the
  // "did the UPDATE run" question answerable from a call count.
  await sql`
    UPDATE harness_shared.work_items
       SET goal_id = ${goalId}
     WHERE feature_id = ${item.id}
       AND CASE
             WHEN ${harness}::text IS NULL THEN workspace_id = ${workspaceId}
             ELSE harness_slug = ${harness}::text
           END
       AND goal_id IS NULL
  `;
  return goalId;
}
