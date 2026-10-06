/**
 * Persisted plan-closure observations — the goal portfolio's closure read never
 * runs the acceptance gate inline (plan goal-brief-to-claimed-plan-work-2026-09-23,
 * D-032; WI-10003890).
 *
 * WHY. `resolveWorklistClosures` used to call `evaluatePlanAcceptanceGate` for every
 * worklist plan that claims to be finished, inside the goal turn-end obligation read's
 * 900ms budget. One awaiting-acceptance plan cost 1.4–2.3s of a ~1.8s read, so every
 * 60d3a8 turn-end row recorded `unknown` ('goal portfolio timeout after 900ms').
 *
 * THE CONTRACT.
 *  1. ONE writer: `evaluatePlanAcceptanceGate` records its own verdict on every
 *     canonical call (see {@link isCanonicalClosureGateCall}). There is no per-caller
 *     hook list, so a new gate caller cannot become a silently stale writer.
 *  2. The verdict is stored with the input FINGERPRINT read when evaluation began.
 *     The fingerprint covers the inputs that change on the way to closure: the plan's
 *     version and acceptance-bar epoch, its item, audit and spec-evidence-binding
 *     watermarks, its acceptance rubrics' versions, and the scorecards graded or vetted
 *     against those rubrics.
 *  3. The portfolio read loads observations and current fingerprints in ONE query and
 *     serves an observation only while its fingerprint matches AND it is younger than
 *     {@link PLAN_CLOSURE_OBSERVATION_MAX_AGE_MS}. The age bound covers every gate
 *     input the fingerprint does not name (spec evidence freshness, design evidence,
 *     lineage, flags). Anything else reads `stale`/`absent`, which the caller renders
 *     as an unreadable closure, and fires a single-flight background re-evaluation.
 *  4. Orientation only. `plans:set-plan-status` evaluates the gate itself.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';
import type { PlanAcceptanceGateOpts, PlanAcceptanceGateVerdict } from '../plan-acceptance-gate';
import { META_ACCEPTANCE_RUBRIC_ID } from '../rubrics';
import { activeWorkspaceId } from '../workspace-registry';

/** Older observations are re-evaluated even when the fingerprint still matches. */
export const PLAN_CLOSURE_OBSERVATION_MAX_AGE_MS = 10 * 60_000;

/**
 * The persisted gate fields: the four `resolvePlanClosure` consumes, plus the rubric and
 * grader the independent-verification obligation names (D-039 — the turn-start
 * obligation reader serves this observation instead of running the gate inline).
 */
export type PlanClosureGateFields = Pick<
  PlanAcceptanceGateVerdict,
  'satisfied' | 'code' | 'skipped' | 'message' | 'rubricId' | 'gradedBy'
>;

/** Gate inputs captured when an evaluation begins. Watermarks are epoch microseconds as text. */
export interface PlanClosureFingerprint {
  planVersion: string | null;
  acceptanceBarEpoch: number | null;
  itemsWatermark: string | null;
  auditSeq: string | null;
  /** `<max binding id>:<retracted count>` — a new or retracted spec-evidence binding. */
  specBindings: string | null;
  rubrics: string[];
  scorecardWatermark: string | null;
  metaScorecardWatermark: string | null;
}

export type PlanClosureObservationRead =
  | { planSlug: string; status: 'fresh'; gate: PlanClosureGateFields; observedAt: string }
  | { planSlug: string; status: 'stale' | 'absent' | 'ambiguous'; detail: string };

/**
 * Whether a gate call answers the same question the closure read asks
 * (`evaluatePlanAcceptanceGate(planSlug)`). `force`, `gradingRecruitment` and caller
 * fingerprints change the verdict, so those calls are never recorded.
 * `probeCitationDeployment` and `readGradingAuditDispatchSuppression` only add report
 * fields or message text, and `harnessSlug` only disambiguates the subject.
 */
export function isCanonicalClosureGateCall(opts: PlanAcceptanceGateOpts): boolean {
  return !opts.force && !opts.gradingRecruitment && !(opts.current && opts.current.length > 0);
}

interface FingerprintRow {
  plan_slug: string;
  harness_slug: string;
  matches: number;
  fingerprint: PlanClosureFingerprint;
  fingerprint_matches: boolean | null;
  satisfied: boolean | null;
  code: string | null;
  skipped: string | null;
  message: string | null;
  rubric_id: string | null;
  graded_by: string | null;
  observed_fingerprint: PlanClosureFingerprint | null;
  observed_at: Date | string | null;
}

/**
 * Current fingerprints for `planSlugs`, LEFT JOINed to their stored observations.
 * The writer and the reader share this one query, so the two sides cannot compute
 * the fingerprint differently.
 */
async function readFingerprintRows(sql: Sql, workspaceId: string, planSlugs: readonly string[]): Promise<FingerprintRow[]> {
  const slugs = [...new Set(planSlugs)];
  if (slugs.length === 0) return [];
  return sql<FingerprintRow[]>`
    WITH subject AS (
      SELECT p.plan_slug, p.harness_slug, p.version, p.acceptance_bar_epoch,
             count(*) OVER (PARTITION BY p.plan_slug)::int AS matches
        FROM harness_shared.harness_plans AS p
       WHERE p.workspace_id = ${workspaceId}
         AND p.plan_slug = ANY(${slugs}::text[])
    ), rubric AS (
      SELECT r.template_data ->> 'subjectPlan' AS subject_plan, r.plan_slug AS rubric_id, r.version
        FROM harness_shared.harness_plans AS r
       WHERE r.workspace_id = ${workspaceId}
         AND r.template = 'rubric'
         AND r.template_data ->> 'kind' = 'acceptance'
         AND r.template_data ->> 'subjectPlan' = ANY(${slugs}::text[])
    ), current_fp AS (
      SELECT s.plan_slug, s.harness_slug, s.matches,
             jsonb_build_object(
               'planVersion', s.version::text,
               'acceptanceBarEpoch', s.acceptance_bar_epoch,
               'itemsWatermark', (
                 SELECT floor(extract(epoch FROM max(i.updated_at)) * 1000000)::bigint::text
                   FROM harness_shared.plan_items AS i
                  WHERE i.workspace_id = ${workspaceId}
                    AND i.harness_slug = s.harness_slug
                    AND i.plan_slug = s.plan_slug),
               'auditSeq', (
                 SELECT max(a.audit_seq)::text
                   FROM harness_shared.plan_audits AS a
                  WHERE a.workspace_id = ${workspaceId}
                    AND a.plan_slug = s.plan_slug),
               'specBindings', (
                 SELECT max(b.id)::text || ':' || (count(*) FILTER (WHERE b.retracted_at IS NOT NULL))::text
                   FROM harness_shared.spec_evidence_bindings AS b
                  WHERE b.workspace_id = ${workspaceId}
                    AND b.harness_slug = s.harness_slug
                    AND b.plan_slug = s.plan_slug),
               'rubrics', COALESCE((
                 SELECT jsonb_agg(r.rubric_id || '@' || r.version::text ORDER BY r.rubric_id)
                   FROM rubric AS r
                  WHERE r.subject_plan = s.plan_slug), '[]'::jsonb),
               'scorecardWatermark', (
                 SELECT floor(extract(epoch FROM max(GREATEST(sc.created_at, sc.updated_at))) * 1000000)::bigint::text
                   FROM harness_shared.engineer_issues AS sc
                  WHERE sc.workspace_id = ${workspaceId}
                    AND sc.payload -> 'observation' ->> 'rubricRef' IN (
                      SELECT r.rubric_id FROM rubric AS r WHERE r.subject_plan = s.plan_slug)),
               'metaScorecardWatermark', (
                 SELECT floor(extract(epoch FROM max(GREATEST(sc.created_at, sc.updated_at))) * 1000000)::bigint::text
                   FROM harness_shared.engineer_issues AS sc
                  WHERE sc.workspace_id = ${workspaceId}
                    AND sc.payload -> 'observation' ->> 'rubricRef' = ${META_ACCEPTANCE_RUBRIC_ID}
                    AND sc.payload -> 'observation' -> 'subject' ->> 'ref' IN (
                      SELECT r.rubric_id FROM rubric AS r WHERE r.subject_plan = s.plan_slug))
             ) AS fingerprint
        FROM subject AS s
    )
    SELECT fp.plan_slug, fp.harness_slug, fp.matches, fp.fingerprint,
           (o.fingerprint = fp.fingerprint) AS fingerprint_matches,
           o.satisfied, o.code, o.skipped, o.message, o.rubric_id, o.graded_by,
           o.fingerprint AS observed_fingerprint, o.observed_at
      FROM current_fp AS fp
      LEFT JOIN harness_shared.plan_closure_observations AS o
        ON o.workspace_id = ${workspaceId}
       AND o.harness_slug = fp.harness_slug
       AND o.plan_slug = fp.plan_slug`;
}

/** Fingerprint keys whose values differ, for a `stale` detail that names its cause. */
export function changedFingerprintKeys(
  observed: Partial<PlanClosureFingerprint> | null | undefined,
  current: Partial<PlanClosureFingerprint>,
): string[] {
  const keys = new Set([...Object.keys(observed ?? {}), ...Object.keys(current)]);
  return [...keys]
    .filter((key) => JSON.stringify((observed as Record<string, unknown> | null)?.[key] ?? null)
      !== JSON.stringify((current as Record<string, unknown>)[key] ?? null))
    .sort();
}

/**
 * Judge one plan's stored observation against its current fingerprint. Pure, so the
 * freshness rule is testable without a database.
 */
export function judgePlanClosureObservation(
  planSlug: string,
  rows: readonly (Pick<FingerprintRow,
    'matches' | 'fingerprint' | 'fingerprint_matches' | 'satisfied' | 'code' | 'skipped' | 'message' |
    'observed_fingerprint' | 'observed_at'> & Partial<Pick<FingerprintRow, 'rubric_id' | 'graded_by'>>)[],
  now: Date,
  maxAgeMs = PLAN_CLOSURE_OBSERVATION_MAX_AGE_MS,
): PlanClosureObservationRead {
  if (rows.length === 0) {
    return { planSlug, status: 'absent', detail: `plan '${planSlug}' does not resolve, so no closure observation applies` };
  }
  if (rows.length > 1 || rows[0].matches > 1) {
    return { planSlug, status: 'ambiguous', detail: `plan slug '${planSlug}' resolves in ${Math.max(rows.length, rows[0].matches)} harnesses` };
  }
  const row = rows[0];
  if (row.observed_at == null || row.satisfied == null) {
    return { planSlug, status: 'absent', detail: `no acceptance-gate verdict has been recorded for '${planSlug}' yet` };
  }
  const observedAt = new Date(row.observed_at);
  if (row.fingerprint_matches !== true) {
    const changed = changedFingerprintKeys(row.observed_fingerprint, row.fingerprint);
    return {
      planSlug,
      status: 'stale',
      detail: `the recorded acceptance-gate verdict for '${planSlug}' (${observedAt.toISOString()}) predates a change to ${changed.join(', ') || 'its inputs'}`,
    };
  }
  const ageMs = now.getTime() - observedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
    return {
      planSlug,
      status: 'stale',
      detail: `the recorded acceptance-gate verdict for '${planSlug}' is ${Math.round(ageMs / 1000)}s old (max ${Math.round(maxAgeMs / 1000)}s)`,
    };
  }
  return {
    planSlug,
    status: 'fresh',
    gate: {
      satisfied: row.satisfied,
      code: row.code as PlanClosureGateFields['code'],
      ...(row.skipped ? { skipped: row.skipped as PlanClosureGateFields['skipped'] } : {}),
      ...(row.message != null ? { message: row.message } : {}),
      ...(row.rubric_id ? { rubricId: row.rubric_id } : {}),
      ...(row.graded_by ? { gradedBy: row.graded_by } : {}),
    } as PlanClosureGateFields,
    observedAt: observedAt.toISOString(),
  };
}

/** Load the stored closure observations for `planSlugs` in one query. */
export async function readPlanClosureObservations(args: {
  workspaceId: string;
  planSlugs: readonly string[];
  sql?: Sql;
  now?: Date;
}): Promise<Map<string, PlanClosureObservationRead>> {
  const sql = args.sql ?? getOrgPg().sql;
  const rows = await readFingerprintRows(sql, args.workspaceId, args.planSlugs);
  const now = args.now ?? new Date();
  const out = new Map<string, PlanClosureObservationRead>();
  for (const planSlug of new Set(args.planSlugs)) {
    out.set(planSlug, judgePlanClosureObservation(planSlug, rows.filter((row) => row.plan_slug === planSlug), now));
  }
  return out;
}

/**
 * Start recording a canonical gate evaluation. Await it BEFORE the gate reads anything:
 * the fingerprint must describe inputs no newer than the ones the verdict was computed
 * from. Read concurrently, a queued fingerprint SELECT could land after an input
 * changed, pairing a post-change fingerprint with a pre-change verdict that would then
 * be served as fresh. Read first, a change during evaluation only leaves the row stale.
 * Neither this nor `record` throws: a failed read or write only means the next closure
 * read re-evaluates.
 */
export async function beginPlanClosureObservation(planSlug: string): Promise<{
  record(harnessSlug: string | undefined, verdict: PlanClosureGateFields & { buildProvenance?: { sha: string | null } }): Promise<void>;
}> {
  const observedAt = new Date();
  let target: { workspaceId: string; sql: Sql; rows: FingerprintRow[] } | null = null;
  try {
    const workspaceId = activeWorkspaceId();
    const { sql } = getOrgPg();
    target = { workspaceId, sql, rows: await readFingerprintRows(sql, workspaceId, [planSlug]) };
  } catch {
    target = null;
  }
  return {
    async record(harnessSlug, verdict) {
      if (!harnessSlug || !target) return;
      const { workspaceId, sql, rows } = target;
      try {
        const row = rows.find((r) => r.harness_slug === harnessSlug);
        if (!row) return;
        await sql`
          INSERT INTO harness_shared.plan_closure_observations
            (workspace_id, harness_slug, plan_slug, satisfied, code, skipped, message, rubric_id, graded_by,
             fingerprint, observed_at, build_sha)
          VALUES (${workspaceId}, ${harnessSlug}, ${planSlug}, ${verdict.satisfied}, ${verdict.code ?? null},
                  ${verdict.skipped ?? null}, ${verdict.message ?? null}, ${verdict.rubricId ?? null},
                  ${verdict.gradedBy ?? null}, ${sql.json(row.fingerprint as never)},
                  ${observedAt}, ${verdict.buildProvenance?.sha ?? null})
          ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET
            satisfied = EXCLUDED.satisfied,
            code = EXCLUDED.code,
            skipped = EXCLUDED.skipped,
            message = EXCLUDED.message,
            rubric_id = EXCLUDED.rubric_id,
            graded_by = EXCLUDED.graded_by,
            fingerprint = EXCLUDED.fingerprint,
            observed_at = EXCLUDED.observed_at,
            build_sha = EXCLUDED.build_sha
          WHERE harness_shared.plan_closure_observations.observed_at <= EXCLUDED.observed_at`;
      } catch {
        // Orientation only: the closure read treats a missing row as not evaluated.
      }
    },
  };
}

const refreshState = pinModuleState('@papercusp/operator-core.planClosureObservationRefresh', () => ({
  inFlight: new Set<string>(),
}));

/**
 * Fire-and-forget re-evaluation for plans whose observation is stale or absent. At
 * most one evaluation per plan runs per process; the gate's own write refreshes the row.
 */
export function refreshPlanClosureObservations(
  planSlugs: readonly string[],
  evaluate: (planSlug: string) => Promise<unknown> = async (planSlug) => {
    const { evaluatePlanAcceptanceGate } = await import('../plan-acceptance-gate');
    return evaluatePlanAcceptanceGate(planSlug);
  },
): string[] {
  const started: string[] = [];
  for (const planSlug of new Set(planSlugs)) {
    if (refreshState.inFlight.has(planSlug)) continue;
    refreshState.inFlight.add(planSlug);
    started.push(planSlug);
    void Promise.resolve()
      .then(() => evaluate(planSlug))
      .catch(() => undefined)
      .finally(() => refreshState.inFlight.delete(planSlug));
  }
  return started;
}
