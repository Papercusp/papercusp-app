/**
 * The ONE definition of "this plan is awaiting acceptance".
 *
 * Extracted verbatim from `harness/routines/acceptance-grading-sweep-action.ts`'s
 * `listCandidates` closure (plan generic-acceptance-routing-and-live-plan-agent-brief
 * -2026-09-20, P-005 / R-5). The predicate previously existed ONLY as a private
 * closure inside that routine, so the delegation-count provider had exactly two
 * options: import it, or re-spell it. Re-spelling would have created a second
 * hand-maintained copy of a population definition — the derived-truth-ladder
 * failure this repo documents — and the two copies would then disagree about
 * which plans are awaiting acceptance while both looked authoritative.
 *
 * ⚠ THE `isHarnessInScope` FILTER IS PART OF THE DEFINITION, NOT A DETAIL.
 * It runs in JS after the SELECT (workspace-work-scope-policy-2026-09-04 P-007):
 * a plan in an out-of-scope harness gets no grader dispatched, so it is NOT
 * awaiting acceptance in any sense a caller can act on. A count that skipped this
 * filter would over-report against the sweep's own candidate list — the precise
 * disagreement this extraction exists to make impossible.
 *
 * ⚠ DELIBERATELY NOT WORKSPACE-SCOPED BY DEFAULT. The sweep serves every
 * workspace's plans from one ALS-free pass, so `workspaceId` is OPTIONAL and the
 * workspace travels on each row. Pass it only when the caller is genuinely
 * per-workspace (the delegation-count provider is; the sweep is not).
 */

type Sql = import('postgres').Sql;

export interface AwaitingAcceptancePlanRow {
  planSlug: string;
  harnessSlug: string | null;
  rubricRef: string | null;
  gradeableSinceMs: number | null;
  /** Carried for the per-row identity every downstream call is built from. */
  workspaceId: string;
}

/**
 * A plan is awaiting acceptance only once it is gradeable AT ALL: not terminal,
 * not archived, not itself a rubric, and carrying BOTH an acceptance rubric and a
 * completion audit. `gradeable_since` is the later of those two timestamps,
 * because a grader has nothing to grade until both exist — and it is read from
 * rows that already have to exist rather than from any new column, so this needs
 * no migration.
 *
 * `limit: null` (the default) means NO limit — Postgres treats `LIMIT NULL`
 * exactly as an omitted LIMIT clause, which is what lets a COUNT caller and a
 * bounded-queue caller share one statement instead of one each.
 */
export async function listPlansAwaitingAcceptance(input: {
  sql: Sql;
  rubricTemplateName: string;
  limit?: number | null;
  workspaceId?: string | null;
}): Promise<AwaitingAcceptancePlanRow[]> {
  const { sql, rubricTemplateName } = input;
  const limit = input.limit ?? null;
  const workspaceId = input.workspaceId ?? null;

  const rows = await sql<
    Array<{
      workspace_id: string;
      plan_slug: string;
      harness_slug: string | null;
      rubric_slug: string | null;
      gradeable_since: Date | null;
    }>
  >`
    WITH acceptance_rubric AS (
      SELECT workspace_id,
             template_data->>'subjectPlan' AS subject_plan,
             MIN(plan_slug)  AS rubric_slug,
             MIN(created_at) AS rubric_since
        FROM harness_shared.harness_plans
       WHERE template = ${rubricTemplateName}
         AND template_slug IS NULL
         AND template_data->>'kind' = 'acceptance'
         AND template_data->>'subjectPlan' IS NOT NULL
         AND archived = FALSE
       GROUP BY workspace_id, template_data->>'subjectPlan'
    ),
    completion_audit AS (
      SELECT workspace_id, plan_slug, MAX(created_at) AS audited_since
        FROM harness_shared.plan_audits
       WHERE audit_kind = 'completion'
       GROUP BY workspace_id, plan_slug
    )
    SELECT p.workspace_id,
           p.plan_slug,
           p.harness_slug,
           r.rubric_slug,
           GREATEST(r.rubric_since, a.audited_since) AS gradeable_since
      FROM harness_shared.harness_plans p
      JOIN acceptance_rubric r
        ON r.workspace_id = p.workspace_id AND r.subject_plan = p.plan_slug
      JOIN completion_audit a
        ON a.workspace_id = p.workspace_id AND a.plan_slug = p.plan_slug
     WHERE p.archived = FALSE
       AND p.status NOT IN ('shipped', 'superseded')
       AND p.template IS DISTINCT FROM ${rubricTemplateName}
       AND (${workspaceId}::text IS NULL OR p.workspace_id = ${workspaceId}::text)
     ORDER BY GREATEST(r.rubric_since, a.audited_since) ASC
     LIMIT ${limit}`;

  // ⚠ The scope policy must be LOADED before it can filter. `workScopePolicy()` is a
  // synchronous read of a cache that is EMPTY until an async refresh completes, and an
  // empty policy is "not enforced", which `isHarnessInScope` treats as everything being
  // in scope. So on a cold process this filter FAILS OPEN and admits the out-of-scope
  // harnesses the comment above says it exists to exclude.
  //
  // MEASURED (2026-09-22, P-006 live probe): the first call in a fresh process returned
  // 52 plans awaiting acceptance and every later call in that same process returned 51 —
  // reproducibly, three runs, identical delta. The extra row was an out-of-scope harness
  // admitted by the unloaded policy. That is not a cosmetic off-by-one: this count is the
  // HIGHEST-priority input to the plan-agent brief's delegation decision, and the brief
  // renders in a freshly-started process, so it was reading precisely the cold value. An
  // over-reported acceptance count makes the brief withhold a legitimate delegation.
  //
  // Awaiting the refresh when the cache is cold makes the predicate depend on the policy
  // rather than on how old the calling process happens to be. It is paid once per process:
  // `refreshPotControlPolicy` populates the same cache `workScopePolicy()` reads.
  const { isHarnessInScope, workScopePolicy } = await import('./work-scope-policy');
  if (workScopePolicy() === null) {
    const { refreshPotControlPolicy } = await import('./pot-control-policy');
    await refreshPotControlPolicy();
  }
  return rows.filter((r) => isHarnessInScope(r.harness_slug)).map((r) => ({
    planSlug: r.plan_slug,
    harnessSlug: r.harness_slug,
    rubricRef: r.rubric_slug,
    gradeableSinceMs: r.gradeable_since ? new Date(r.gradeable_since).getTime() : null,
    workspaceId: r.workspace_id,
  }));
}

/**
 * The count of plans awaiting acceptance, by construction identical to
 * `listPlansAwaitingAcceptance(...).length`.
 *
 * ⚠ It really does materialise the rows rather than issuing `count(*)`. That is
 * deliberate: `isHarnessInScope` is a JS predicate, so a SQL-side COUNT would
 * silently include out-of-scope harnesses and over-report against the sweep's
 * own candidate list. An aggregate that disagrees with the list it claims to
 * summarise is worse than a marginally more expensive one that cannot.
 */
export async function countPlansAwaitingAcceptance(input: {
  sql: Sql;
  rubricTemplateName: string;
  workspaceId?: string | null;
}): Promise<number> {
  const rows = await listPlansAwaitingAcceptance({ ...input, limit: null });
  return rows.length;
}
