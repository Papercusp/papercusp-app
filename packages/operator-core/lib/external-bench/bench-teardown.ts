/**
 * bench-teardown — retire a benchmark run's work-items at run end so it never leaves DEBRIS in the
 * frontier (benchmark-coordination-topologies, recurrence fix).
 *
 * WHY: a crashed/finished xbench run left ~253 non-terminal work-items in the shared workspace; the
 * papercup-hive's WORKSPACE-WIDE survey treated them as ready→"Queen-unresolvable"→a ~13k aging-
 * escalation storm. The durable fix is for the bench driver to retire its own items at run end
 * (success, crash, AND signal-teardown paths). Idempotent + guarded: it only ever touches BENCHMARK
 * harnesses (xbench* / *instance_*), NEVER a real dogfood-home harness (`papercup*` / `papercusp*`).
 */

/** Non-terminal feature states that, for a benchmark harness, are stale debris once the run is over. */
export const BENCH_NONTERMINAL_STATUSES = [
  'todo',
  'failing',
  'in_progress',
  'validating',
  'pending',
  'failed',
] as const;

/**
 * PURE: is this (harness_slug, status) a stale BENCHMARK work-item the run-end teardown should retire?
 * True iff it's a benchmark harness (xbench* or contains `instance_`) in a non-terminal state and NOT
 * a protected dogfood-home harness — `papercup*` (legacy) OR `papercusp*` (the home hive + its members,
 * post papercup→papercusp generalization). That guard is what makes a bulk retire safe. Mirrors the
 * guarded SQL in {@link retireBenchDebris} so the scope is unit-testable without PG.
 */
export function isStaleBenchDebris(harnessSlug: string, status: string): boolean {
  // Benchmark harness naming across drivers: `xbench*` (su/queen), `xbq*` (hive-member slugs),
  // `extbench*` (external-bench scratch), or anything carrying `instance` (the SWE-bench instance id).
  const isBench = /^(xbench|xbq|extbench)/.test(harnessSlug) || harnessSlug.includes('instance');
  const isProtected = /^papercu(p|sp)/.test(harnessSlug);
  return isBench && !isProtected && (BENCH_NONTERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The minimal tagged-template sql surface {@link retireBenchDebris} needs (postgres-js shape). */
export type DebrisSql = <R = unknown>(strings: TemplateStringsArray, ...vals: unknown[]) => Promise<R[]>;

/**
 * Retire stale benchmark work-items (→ `deprecated`) so a finished OR crashed bench run leaves no
 * debris in the frontier. Idempotent + guarded (never touches `papercup*`). Returns the count retired.
 * Never throws into the caller — a best-effort cleanup. Two forms:
 *
 *   - SCOPED (`opts.slugPrefix`): retire ONLY one run's hive — its slug + members `${prefix}-…`. This is
 *     the SAFE form a LIVE launcher calls at its own run-end / signal-teardown: the per-run hive prefix is
 *     a random `xbench-su-<nanoid>`, so a scoped retire can NEVER touch a concurrent PEER benchmark run.
 *     Always prefer this when a benchmark may be running elsewhere on the box.
 *   - UNSCOPED (no prefix): the workspace-wide recovery sweep over every benchmark slug family
 *     (`xbench`/`xbq`/`extbench`/`*instance_*`/`F-INSTANCE*`). Run DELIBERATELY for abandoned-debris
 *     cleanup — NOT while a peer benchmark is live (it would deprecate the peer's in-flight items).
 */
export async function retireBenchDebris(
  sql: DebrisSql,
  nowMs: number,
  opts: { slugPrefix?: string } = {},
): Promise<number> {
  try {
    const rows = opts.slugPrefix
      ? await sql<{ feature_id: string }>`
          UPDATE harness_shared.harness_features_consolidated
             SET status = 'deprecated', updated_ts = ${nowMs}
           WHERE harness_slug LIKE ${opts.slugPrefix + '%'}
             AND harness_slug NOT LIKE 'papercup%'
             AND harness_slug NOT LIKE 'papercusp%'
             AND status IN ('todo', 'failing', 'in_progress', 'validating', 'pending', 'failed')
          RETURNING feature_id`
      : await sql<{ feature_id: string }>`
          UPDATE harness_shared.harness_features_consolidated
             SET status = 'deprecated', updated_ts = ${nowMs}
           WHERE (harness_slug LIKE 'xbench%' OR harness_slug LIKE 'xbq%' OR harness_slug LIKE 'extbench%'
                  OR harness_slug LIKE '%instance\\_%' OR feature_id LIKE 'F-INSTANCE%')
             AND harness_slug NOT LIKE 'papercup%'
             AND harness_slug NOT LIKE 'papercusp%'
             AND status IN ('todo', 'failing', 'in_progress', 'validating', 'pending', 'failed')
          RETURNING feature_id`;
    return rows.length;
  } catch {
    return 0; // teardown is best-effort — never wedge a run on a cleanup failure
  }
}
