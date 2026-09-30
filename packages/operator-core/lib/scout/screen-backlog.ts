/**
 * In-tree entrypoint for the Scout-idea prior-art screen (WI-9476).
 *
 * The screen's four modules (`idea-cluster-screen`, `code-existence-probe`,
 * `code-search-deps`, `plan-slug-leg`) only ever referenced EACH OTHER — the
 * sole entrypoint was a `/tmp/scout-screen/run.ts` scratch file. That made the
 * whole cluster unreachable dead code by exactly the criterion used to condemn
 * `codeExistenceCheck` in EI-19480829864185465 (zero callers), and a box reset
 * would have lost the only way to run any of it. This module is the caller.
 *
 * ## Why the cohort predicate is a PURE, TESTED function here
 *
 * The prose range "07-04→07-17" is ambiguous by a factor that matters:
 * `< '2026-07-17'` selects 157 rows, `< '2026-07-18'` selects 279, because
 * 07-17 alone holds a 124-item spike. That off-by-one was injected into this
 * work's own checks twice, and the scratch runner had drifted to a THIRD bound
 * (`< '2026-07-16'`) while the checkpoint documented `< '2026-07-17'` as
 * canonical — i.e. the runner and its own documentation disagreed silently,
 * because nothing tested the predicate.
 *
 * `toExclusive` is named for its semantics precisely so the ambiguity cannot be
 * restated wrongly, and `buildCohortQuery` is pure so the bound is asserted in
 * tests rather than trusted in prose.
 */
import type { CodeSearchDeps } from './code-existence-probe';
import {
  screenIdeaClusters,
  screenCoverage,
  renderScreenCoverage,
  summariseClusterRow,
  type ClusterScreenRow,
  type ScreenableIdea,
} from './idea-cluster-screen';
import { isCliEntry } from '../util/cli-entry';

/** Canonical bounds of the untriaged Scout-idea cohort this screen targets. */
export interface CohortBounds {
  /** Lower bound on `created_at`, INCLUSIVE (`YYYY-MM-DD`). */
  fromInclusive: string;
  /**
   * Upper bound on `created_at`, **EXCLUSIVE** (`YYYY-MM-DD`). Named for its
   * semantics on purpose: a prose range cannot express this without ambiguity,
   * and the 07-17 boundary carries a 124-item spike, so an off-by-one here is a
   * 122-item error rather than a rounding difference.
   */
  toExclusive: string;
  /**
   * Restrict to ids with this prefix. Defaults to `EI-`: the cohort is Scout
   * IDEAS, and omitting this silently screens `WI-` work-items too (the scratch
   * runner did exactly that).
   */
  idPrefix: string;
  /** Skip stubs — a body this short carries no premise to screen. */
  minBodyChars: number;
  /** Max rows to screen. */
  limit: number;
}

/**
 * The cohort as measured: 157 open rows at 2026-08-04T00:47Z.
 *
 * ⚠ `state='open'` is NOT claimability — the real claim path applies ~12 floors
 * and only ~75 of these are actually claimable. This bound selects what is
 * SCREENABLE, never what is claimable; use `work_items:claimable` for that.
 */
export const DEFAULT_COHORT: CohortBounds = {
  fromInclusive: '2026-07-04',
  toExclusive: '2026-07-17',
  idPrefix: 'EI-',
  minBodyChars: 200,
  limit: 200,
};

/**
 * Build the cohort SELECT. Pure — no DB handle — so the predicate can be
 * asserted in tests instead of described in prose.
 *
 * `lane IS NULL` is the discriminator against the ~5,340-row `lane='observation'`
 * population, which is a DIFFERENT corpus. Only two lane values exist, so
 * `lane IS NULL` ≡ `lane <> 'observation'`.
 */
export function buildCohortQuery(bounds: CohortBounds = DEFAULT_COHORT): {
  sql: string;
  params: unknown[];
} {
  return {
    sql: `SELECT issue_id, title, coalesce(body,'') AS body, created_at
            FROM harness_shared.engineer_issues
           WHERE workspace_id = 'papercusp-workspace'
             AND scope = 'harness:papercusp'
             AND state = 'open'
             AND lane IS NULL
             AND issue_id LIKE $1
             AND created_at >= $2
             AND created_at < $3
             AND length(coalesce(body,'')) > $4
           ORDER BY created_at
           LIMIT $5`,
    params: [
      `${bounds.idPrefix}%`,
      bounds.fromInclusive,
      bounds.toExclusive,
      bounds.minBodyChars,
      bounds.limit,
    ],
  };
}

/** Minimal query seam — satisfied by a `pg` Pool, and by a fake in tests. */
export interface QueryRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Load the cohort rows and shape them for the screen. */
export async function loadCohort(
  db: QueryRunner,
  bounds: CohortBounds = DEFAULT_COHORT,
): Promise<ScreenableIdea[]> {
  const { sql, params } = buildCohortQuery(bounds);
  const { rows } = await db.query(sql, params);
  return rows.map((r) => ({
    id: String(r.issue_id),
    text: `${String(r.title ?? '')}\n\n${String(r.body ?? '')}`,
    createdAt: new Date(r.created_at as string).toISOString(),
  }));
}

/**
 * Resolve asserted refs to the STATE of the item they point at — the leg that
 * separates prior art (terminal) from live duplication (open). This is what
 * gives COLLAPSE detection with no embeddings at all.
 */
export function makeRefStateResolver(db: QueryRunner) {
  return async (ids: string[]): Promise<Map<string, string>> => {
    if (ids.length === 0) return new Map();
    const { rows } = await db.query(
      `SELECT issue_id, state FROM harness_shared.engineer_issues
        WHERE workspace_id = 'papercusp-workspace' AND issue_id = ANY($1)`,
      [ids],
    );
    return new Map(rows.map((r) => [String(r.issue_id), String(r.state)]));
  };
}

/**
 * Load the harness's plans ONCE for the plan-slug leg. The leg is pure token
 * overlap, so a per-idea query would buy nothing but latency.
 *
 * ⚠ `harness_plans` is multi-tenant — scope on workspace_id AND harness_slug or
 * the leg silently ranks against another tenant's plans.
 */
export async function loadPlans(db: QueryRunner) {
  const { rows } = await db.query(
    `SELECT plan_slug, title, status FROM harness_shared.harness_plans
      WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
        AND archived = false`,
  );
  return rows.map((r) => ({
    slug: String(r.plan_slug),
    title: (r.title ?? undefined) as string | undefined,
    status: (r.status ?? undefined) as string | undefined,
  }));
}

/** Run the screen over the cohort. */
export async function runBacklogScreen(
  db: QueryRunner,
  deps: CodeSearchDeps,
  bounds: CohortBounds = DEFAULT_COHORT,
): Promise<ClusterScreenRow[]> {
  const ideas = await loadCohort(db, bounds);
  return screenIdeaClusters(ideas, deps, {
    maxTerms: 8,
    resolveRefStates: makeRefStateResolver(db),
  });
}

/**
 * Render the full report.
 *
 * The coverage header is emitted at BOTH ends deliberately: it is the only
 * thing distinguishing "this screen found prior art" from "a retrieval whose
 * strongest leg reaches ~9% of items found nothing". Printed once at the top, a
 * tail-read consumes 43 GREENLIGHTs uncaveated and reads them as "novel" — the
 * defect this header was added to fix.
 */
export function formatScreenReport(rows: ClusterScreenRow[]): string {
  const header = renderScreenCoverage(screenCoverage(rows));
  const rank: Record<string, number> = {
    DROP: 0,
    'COLLAPSE-AND-RESCOPE': 1,
    INCONCLUSIVE: 2,
    GREENLIGHT: 3,
  };
  const ordered = [...rows].sort(
    (a, b) =>
      (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9) ||
      b.premiseAgeDays.oldest - a.premiseAgeDays.oldest,
  );
  return [header, '', ...ordered.map((r) => summariseClusterRow(r)), '', header].join('\n');
}

async function main(): Promise<void> {
  const [{ Pool }, { getHarnessAdminUrl }, { createGitGrepDeps }] = await Promise.all([
    import('pg'),
    import('../embedded-pg-discovery'),
    import('./code-search-deps'),
  ]);

  const repo = process.env.SCREEN_REPO ?? process.cwd();
  const bounds: CohortBounds = {
    ...DEFAULT_COHORT,
    ...(process.env.LIMIT ? { limit: Number(process.env.LIMIT) } : {}),
    ...(process.env.FROM_INCLUSIVE ? { fromInclusive: process.env.FROM_INCLUSIVE } : {}),
    ...(process.env.TO_EXCLUSIVE ? { toExclusive: process.env.TO_EXCLUSIVE } : {}),
  };

  const pool = new Pool({ connectionString: getHarnessAdminUrl() });
  try {
    const plans = await loadPlans(pool);
    process.stderr.write(`[plan-slug leg] ${plans.length} plans loaded\n`);
    const deps = createGitGrepDeps({
      cwd: repo,
      maxFiles: 40,
      timeoutMs: 20_000,
      searchPlans: async () => plans,
    });
    const t0 = Date.now();
    const rows = await runBacklogScreen(pool, deps, bounds);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    process.stderr.write(`[screen] ${rows.length} cluster(s) in ${secs}s\n`);
    process.stdout.write(`${formatScreenReport(rows)}\n`);
  } finally {
    await pool.end();
  }
}

if (isCliEntry(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
