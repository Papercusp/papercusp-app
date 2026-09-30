/**
 * Issue → F-FIX feature promotion — the shared, in-process logic behind BOTH
 *   1. the human-facing `POST /:slug/issues/:id/promote` route, and
 *   2. the DBOS orchestrator's automated CONVERT_ISSUES sweep
 *      (P-011 / D-004 / D-016: open critical|major issues with no linked feature
 *       are auto-promoted to F-FIX features so the substrate fixes them).
 *
 * Correctness notes (D-016 — the pre-existing inline route logic was wrong for
 * the DBOS path in three ways, all fixed here):
 *
 *   - **`metadata.source_plan`, NOT a `source_plan_slug` column.** The plan slug
 *     lives in `metadata->>'source_plan'` on per-schema `harness_features`;
 *     a dedicated `source_plan_slug` column exists ONLY on
 *     `harness_shared.harness_features_consolidated`. The orchestrator's
 *     plan-gate (`readFeaturesPg`) reads `metadata->>'source_plan'`, so the
 *     minted feature inherits the foundDuring parent's `metadata->>'source_plan'`
 *     into its own metadata — writing the old column threw "column does not
 *     exist" on every harness.
 *   - **`workspace_id` is set explicitly.** `readFeaturesPg` filters
 *     `WHERE workspace_id = $active`; a NULL workspace_id makes the minted
 *     feature invisible to dispatch.
 *   - **PG-canonical writes.** PG is the store-of-record (Phase 3 killed
 *     `issues.json`), so every issue mutation goes through `loadIssuesOrSeed`
 *     (async) + `saveIssues`.
 *
 * Idempotency (D-016.3): the sweep runs from BOTH the 30s orchestrator tick and
 * the on-settle refill within the SAME operator process, so a per-harness
 * in-process async mutex (`withHarnessSweepLock`) serializes them — combined
 * with the per-issue `linkedFeatureId` guard, no double-mint.
 */
import { harnessQuery } from '@papercusp/db-org';
import { auditFeatureChange } from './feature-audit';
import { loadIssuesOrSeed, saveIssues } from './harness-issues';
import { activeWorkspaceId } from './workspace-registry';
import type { Issue } from './harness/issue-types';
import type { ProjectEntry } from './harness-registry';

/** Severities the automated sweep auto-promotes. Minor/nit stay human-only (D-004). */
const AUTO_PROMOTE_SEVERITIES = new Set<Issue['severity']>(['critical', 'major']);

export interface PromotedFeature {
  id: string;
  title: string;
  claims: string[];
  // work-item-status-full-unify P-007: promoted features are born at the unified claimable
  // token 'open' (was 'todo') — a raw INSERT bypasses setWorkItemState's alias-fold, so 'todo'
  // here would strand the new feature OUTSIDE the ['open'] claim floor (P-004), unclaimable.
  status: 'open';
  attempts: 0;
  sourceIssueId: string;
  notes: string;
}

export interface PromoteOpts {
  /** Workspace the minted feature belongs to. Defaults to the active workspace. */
  workspaceId?: string;
  /** Audit actor for the feature-create event. */
  actor?: string;
}

/**
 * Pure (testable) candidate selection for the automated sweep: open
 * `critical`/`major` issues that are not yet linked to a feature. Minor/nit and
 * already-linked/closed issues are excluded — they stay human-promote-only.
 */
export function selectConvertCandidates(issues: readonly Issue[]): Issue[] {
  return issues.filter(
    (i) =>
      i.status === 'open' &&
      !i.linkedFeatureId &&
      AUTO_PROMOTE_SEVERITIES.has(i.severity),
  );
}

// ── In-process per-harness sweep mutex (D-016.3) ──────────────────────────────
// The 30s tick and the setImmediate on-settle refill BOTH call into the sweep
// for the same harness within one operator process. A second concurrent sweep
// for a key already in flight is SKIPPED (not queued) — the in-flight one will
// promote everything pending, so the skip loses no work.
const sweepInFlight = new Set<string>();

export interface SweepLockSkipped {
  skipped: true;
}

export async function withHarnessSweepLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T | SweepLockSkipped> {
  if (sweepInFlight.has(key)) return { skipped: true };
  sweepInFlight.add(key);
  try {
    return await fn();
  } finally {
    sweepInFlight.delete(key);
  }
}

/** Test-only: clear the in-flight set so suites don't leak state across cases. */
export function __resetSweepLocksForTest(): void {
  sweepInFlight.clear();
}

/**
 * Mint one `F-FIX-NNN` feature row in `harness_<slug>.harness_features` from an
 * issue. Does NOT touch the issue or `issues.json` — the caller links + saves.
 * Reads/writes via the per-harness legacy (postgres) client. Sequential calls
 * see each other's commits, so a batch mints F-FIX-001, F-FIX-002, … correctly.
 */
export async function mintFixFeatureRow(
  project: ProjectEntry,
  issue: Issue,
  opts: PromoteOpts = {},
): Promise<PromotedFeature> {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const actor = opts.actor ?? 'issue-promote';

  // All three statements below (the two lookups + the INSERT) share ONE
  // harnessQuery() call so they run against the same connection / per-tx
  // search_path under PgBouncer (see harnessQuery's docstring) — matching the
  // original single-`dbc`-client behavior.
  const { featureId, claims, featureNotes } = await harnessQuery(project.slug, async (sql) => {
    // Inherit source_plan from the feature the issue was found in so the
    // orchestrator's plan-gate (readFeaturesPg → metadata->>'source_plan')
    // dispatches this fix exactly when that plan is started (D-016.2).
    let sourcePlan: string | null = null;
    if (issue.foundDuring) {
      try {
        const parentRows = (await sql`
          SELECT metadata->>'source_plan' AS source_plan
            FROM harness_features
           WHERE harness_slug = ${project.slug} AND feature_id = ${issue.foundDuring} LIMIT 1
        `) as unknown as Array<{ source_plan: string | null }>;
        sourcePlan = parentRows[0]?.source_plan ?? null;
      } catch {
        /* non-fatal: a missing/odd parent just means no plan inheritance */
      }
    }

    const fixRows = (await sql`
      SELECT feature_id FROM harness_features
       WHERE harness_slug = ${project.slug} AND feature_id LIKE 'F-FIX-%'
    `) as unknown as Array<{ feature_id: string }>;
    const existingFixIds = fixRows
      .map((r) => Number(r.feature_id.slice(6)))
      .filter((n) => Number.isFinite(n));
    const nextFixId = (existingFixIds.length ? Math.max(...existingFixIds) : 0) + 1;
    const featureId = `F-FIX-${String(nextFixId).padStart(3, '0')}`;

    const claims = issue.codePointer ? [`VAL-FIX-${nextFixId} @ ${issue.codePointer}`] : [];
    const featureNotes = [
      issue.evidence ?? '',
      issue.suggestedFix ? `Suggested fix: ${issue.suggestedFix}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const metadata: Record<string, unknown> = { sourceIssueId: issue.id };
    if (sourcePlan) metadata.source_plan = sourcePlan;

    const ts = Date.now();
    await sql`
      INSERT INTO harness_features
         (harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata,
          kind, project_id, expected_cost_cents, tags, needs_human_review,
          workspace_id, ts, created_ts, updated_ts)
       VALUES (${project.slug}, ${featureId}, ${issue.title}, NULL, 'open', 0,
               ${claims.length ? JSON.stringify(claims) : null},
               ${featureNotes || null},
               ${JSON.stringify(metadata)},
               NULL, NULL, NULL, NULL, false,
               ${workspaceId}, ${ts}, ${ts}, ${ts})
    `;

    return { featureId, claims, featureNotes };
  });

  auditFeatureChange(
    project.slug,
    featureId,
    '__created',
    null,
    { id: featureId, title: issue.title, sourceIssueId: issue.id },
    actor,
  );

  return {
    id: featureId,
    title: issue.title,
    claims,
    status: 'open',
    attempts: 0,
    sourceIssueId: issue.id,
    notes: featureNotes,
  };
}

/** Mutate an issue in place to mark it promoted (caller persists via saveIssues). */
function linkIssueToFeature(issue: Issue, featureId: string, actor: string): void {
  issue.linkedFeatureId = featureId;
  issue.status = 'fixing';
  issue.notes.push({
    ts: new Date().toISOString(),
    by: actor,
    text: `Promoted to ${featureId}`,
  });
}

export type PromoteIssueResult =
  | { ok: true; issue: Issue; feature: PromotedFeature }
  | { ok: false; error: string; status: number };

/**
 * Promote a SINGLE issue (the human-facing route path). Loads canonical issues,
 * enforces the `linkedFeatureId` dedup guard, mints the F-FIX feature, links +
 * saves. Returns a structured result the route maps to a Response.
 */
export async function promoteIssueToFeature(
  project: ProjectEntry,
  issueId: string,
  opts: PromoteOpts = {},
): Promise<PromoteIssueResult> {
  const actor = opts.actor ?? 'human';
  const file = await loadIssuesOrSeed(project);
  const issue = file.issues.find((i) => i.id === issueId);
  if (!issue) return { ok: false, error: 'issue not found', status: 404 };
  if (issue.linkedFeatureId) {
    return { ok: false, error: 'already linked to ' + issue.linkedFeatureId, status: 400 };
  }
  const feature = await mintFixFeatureRow(project, issue, { ...opts, actor });
  linkIssueToFeature(issue, feature.id, actor);
  await saveIssues(project, file);
  return { ok: true, issue, feature };
}

export interface ConvertResult {
  /** `{issueId, featureId}` for each issue promoted this sweep. */
  promoted: Array<{ issueId: string; featureId: string }>;
}

/**
 * The automated CONVERT_ISSUES sweep for ONE harness (P-011). Loads canonical
 * issues, selects open critical|major un-linked candidates, mints an F-FIX
 * feature for each (inheriting source_plan + workspace), links them, and saves
 * once. Serialized per `(workspace, harness)` by the in-process mutex so the
 * tick+refill double-fire can't double-mint; a skipped concurrent call returns
 * `{ promoted: [] }`. Never throws issue-promotion errors into the dispatch
 * path — the caller still wraps it, but individual mint failures are isolated.
 */
export async function convertOpenIssuesToFeatures(
  project: ProjectEntry,
  opts: PromoteOpts = {},
): Promise<ConvertResult> {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const actor = opts.actor ?? 'orchestrator';
  const key = `${workspaceId}:${project.slug}`;
  const res = await withHarnessSweepLock(key, async (): Promise<ConvertResult> => {
    const file = await loadIssuesOrSeed(project);
    const candidates = selectConvertCandidates(file.issues);
    if (candidates.length === 0) return { promoted: [] };

    // Guard: a harness whose per-schema `harness_features` relation is absent has nothing
    // to promote — skip QUIETLY instead of logging a "relation does not exist" error per
    // candidate. This happens for an EPHEMERAL gym harness whose schema was dropped between
    // the dispatch-sweep tick and here (the sweep races teardown), and for a not-yet-scaffolded
    // schema. `to_regclass` resolves via the legacy client's `harness_<slug>` search_path.
    const probeRows = (await harnessQuery(
      project.slug,
      (sql) => sql`SELECT to_regclass('harness_features') AS rel`,
    )) as unknown as Array<{ rel: string | null }>;
    if (!probeRows[0]?.rel) return { promoted: [] };

    const promoted: Array<{ issueId: string; featureId: string }> = [];
    for (const issue of candidates) {
      try {
        const feature = await mintFixFeatureRow(project, issue, { workspaceId, actor });
        linkIssueToFeature(issue, feature.id, actor);
        promoted.push({ issueId: issue.id, featureId: feature.id });
      } catch (err) {
        // Isolate a single bad issue — keep promoting the rest.
        console.warn(
          `[convert-issues] ${project.slug} failed to promote ${issue.id}:`,
          (err as Error)?.message ?? err,
        );
      }
    }
    if (promoted.length > 0) await saveIssues(project, file);
    return { promoted };
  });
  return 'skipped' in res ? { promoted: [] } : res;
}
