/**
 * The registered derived-read producers — the three measured offenders from the
 * WI-5460 audit (precompute-derived-sync-reads-2026-07-19 P-003/P-004/P-005).
 *
 * Each one moves an expensive computation OFF the user-facing sync read path and
 * onto background refreshes. Most run from the
 * `system:precompute-derived-reads` routine; demand-driven producers run only
 * after an actual read observes a missing or stale snapshot. The resolver then
 * does a plain SELECT against `harness_shared.derived_read_snapshots`.
 *
 * Imported for side effect by the routine action and by the sync resolver, so a
 * read and a refresh always agree on which producers exist.
 *
 * TTLs are chosen from how fast the underlying signal actually moves, NOT from
 * how expensive the compute is — an expensive producer with a short ttl is the
 * routine's problem to schedule, never the reader's problem to wait for.
 *
 * ── Changing a producer's payload shape? Bump `producerVersion` (WI-7289) ────
 * registry.ts:204/380 treat a snapshot's `producer_version` as the ONLY thing
 * that makes a shape change self-enforcing — a shape change shipped WITHOUT a
 * version bump ships inert (a stored old-version row keeps passing the
 * reader's version check and serves the superseded shape forever). This has
 * happened three times already (learning.improvements WI-7275/WI-7279,
 * coord.history WI-7295, learning.observations WI-7303, plans.lint
 * repeatedly), every time with green tests and clean types, because nothing
 * tied the shape to the version number. `derived-reads/shape-fingerprint.ts`
 * is a test-time detector for exactly this: it fingerprints a producer's REAL
 * sample output and requires the fingerprint to match a value recorded
 * against its LIVE registered `producerVersion`, so a shape drift without a
 * version bump fails a test instead of shipping silently. Wired today for
 * `learning.improvements`, `coord.history`, `learning.observations`, and
 * `plans.lint` (the four with a proven history of this exact defect) — see
 * their respective test files. The remaining producers here are NOT yet
 * covered; adding coverage for one is cheap (see shape-fingerprint.ts's
 * module doc for the pattern) and welcome, but is not assumed done.
 */
import { withWorkspace } from '@papercusp/db-org';
import { registerDerivedRead } from './registry';

// ── storage.usage (P-003) — measured 20.0s on the read path ──────────────────
//
// A recursive du-style disk walk plus PG catalog sizing. The pre-fix code ran it
// inline and mitigated the pain with a wall-clock budget (DISK_BUDGET_MS,
// EI-6045) that returned PARTIAL sizes with an apologetic note — a mitigation
// that existed only because the walk was on the read path. Precomputed, the walk
// can run to completion and report accurate sizes.
//
// Disk usage moves slowly; a 30-minute snapshot is far fresher than a Settings
// page needs.
registerDerivedRead({
  key: 'storage.usage',
  ttlMs: 30 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { computeStorageUsage } = await import('../storage/usage');
    // `offReadPath` raises the disk-walk budget: nobody is waiting on this, so
    // the walk can finish and report complete sizes instead of the partial ones
    // the 20s read-path budget produced on a large store.
    return computeStorageUsage({ offReadPath: true });
  },
});

// ── plans.lint (P-004) — measured 13.8s on the read path, 158.8s to compute ──
//
// ⚠ THIS PRODUCER ALSO FIXES A SILENTLY-BROKEN QUERY (found while backfilling).
//
// The resolver has always done `Array.isArray(r?.reports) ? r.reports : []`. But
// the lint tool's ALL-PLANS default branch returns `summarizeLintReports(reports)`
// — a bounded summary object with NO `reports` field. (⚠ CORRECTION, WI-7221:
// this comment used to add "and on the per-slug bulk envelope". That is WRONG —
// the per-slug path returns `{ results:[{ ok, slug, report }] }`, so `reports`
// exists ONLY on the `full: true` branch. That wrong clause is precisely what
// hid the fact that the resolver's ARGS-BEARING branch was returning [] too;
// it is fixed in sync-resolver/index.ts.) So the nullary
// `plans.lint` sync query has ALWAYS returned `[]`: it linted the entire corpus
// and threw the result away. The backfill made it obvious — 158.8s of compute
// producing a 5-byte payload.
//
// Passing `full: true` gives the resolver the `reports` array it always declared.
// `full` is documented as OFF-by-default because the complete dump (484 plans ×
// hundreds of warnings → 170KB+) can exceed the AGENT result-size cap — a limit
// that does not apply here: this payload goes into a jsonb column, not an agent's
// context, and it is no longer on a read path at all.
//
// DEMAND-DRIVEN (WI-7230). At ~159s per compute this is the most expensive
// producer, yet the nullary sync query has NO application consumer. Running it
// every six hours on every operator paid real event-loop and filesystem cost to
// produce bytes nobody requested. It is therefore excluded from the periodic
// sweep and refreshed only after an actual read observes a missing or stale
// snapshot. The read returns immediately with empty/stale data while the
// deduplicated refresh runs in the background (D-003), so zero consumers means
// zero computes without deleting the future query surface.
//
// The six-hour ttl now defines when an observed snapshot is stale, not a cron
// cadence. If a live consumer needs tighter freshness, make the lint itself
// incremental (lint only plans whose updated_at moved), not this 159s walk more
// frequent — see WI-5460.
//
// ── WI-7221: the stored shape is a SUMMARY, not the full dump ────────────────
//
// `full: true` (above) is what the RESOLVER needs to see a `reports` array at
// all, but storing those reports verbatim measured 561,007 B over 913 rows —
// 2.24x the 250,000 B default sync-read ceiling, and the largest unallowlisted
// violation in the tree. Where that went:
//
//   warnings  421,839 B  75.2%   (629/913 rows)
//   errors     48,661 B   8.7%   (158/913 rows)
//   slug       42,862 B   7.6%
//   archived+exempt+legacy 40,172 B 7.2%  — constant `false` on ALL 913 rows
//
// 355,049 B of that is `message` PROSE generated from only 18 distinct `code`
// values — the same remediation sentences repeated across the corpus. A code
// tally carries the same information for a list view at a fraction of the size.
//
// So the snapshot stores, per plan:
//   • `errors` IN FULL — they block, they are rare (158 rows), and a panel
//     shows them verbatim;
//   • `warnings` as a COUNT + per-code tally — the bulk, and the part that is
//     reconstructible prose;
//   • the three booleans OMITTED WHEN FALSE (D-025 null-omit) — lossless,
//     since a true value still round-trips.
//
// Measured: 561,007 -> 133,328 B (-76.2%), 913 rows unchanged. Full per-plan
// detail is NOT lost — the resolver's ARGS-BEARING branch still computes a
// complete report live for a drill-in, which is the same list/detail split
// P-006 applied to `featuresConsolidated`.
//
// ⚠ producerVersion MUST stay ahead of any change to this shape: the registry
// treats a snapshot from an older version as absent rather than serving a
// superseded shape (registry.ts:204).
//
// ── Why not just reuse `summarizeLintReports` (plans/lint.ts)? ───────────────
// It is the canonical summarizer and its per-plan `LintSummaryPlan` shape is
// deliberately mirrored here (errorCount/warningCount, errors inlined, the
// booleans omitted when false). But it returns ONE `LintSummary` OBJECT with a
// `plans[]` inside, and storing that would make this snapshot a single fat row.
// The sync layer delta-hashes ROWS: at 922 rows one plan's lint change re-sends
// ~146 B, whereas a 1-row aggregate re-sends the entire ~130KB blob on any
// change. That 1-row-fat-aggregate shape is a known payload anti-pattern in
// this tree (learning.improvements is 317,455 B in ONE row), so row-per-plan is
// the deliberate choice, not an oversight.
//
// The other deliberate difference: `summarizeLintReports` DROPS plans with zero
// findings entirely; this keeps them as a slug-only row (246 of 922). A sync
// read is a materialized list — a consumer needs to know a plan was linted and
// came back clean, which absence cannot express.
type PlanLintReport = {
  slug?: unknown;
  errors?: unknown[];
  warnings?: { code?: unknown }[];
  archived?: unknown;
  exempt?: unknown;
  legacy?: unknown;
};

export function summarizePlanLintReport(report: PlanLintReport): Record<string, unknown> {
  const out: Record<string, unknown> = { slug: report.slug };
  const errors = Array.isArray(report.errors) ? report.errors : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  if (errors.length > 0) {
    out.errorCount = errors.length;
    out.errors = errors;
  }
  if (warnings.length > 0) {
    const byCode: Record<string, number> = {};
    for (const w of warnings) {
      const code = typeof w?.code === 'string' ? w.code : 'unknown';
      byCode[code] = (byCode[code] ?? 0) + 1;
    }
    out.warningCount = warnings.length;
    out.warningCodes = byCode;
  }
  // D-025 null-omit: these are `false` on every row today, so emitting them
  // costs 40KB to say nothing. A `true` still round-trips.
  if (report.archived) out.archived = true;
  if (report.exempt) out.exempt = true;
  if (report.legacy) out.legacy = true;
  return out;
}

registerDerivedRead({
  key: 'plans.lint',
  ttlMs: 6 * 60 * 60_000,
  // 2 -> 3: the summary projection. 3 -> 4: `errorCount` added to mirror
  // LintSummaryPlan. A v3 snapshot was already stored on :3170 by then, and
  // with a 6h ttl it would have been served in the old shape until it expired.
  producerVersion: 4,
  scope: 'workspace',
  excludeFromDefaultSweep: true,
  refreshOnRead: true,
  compute: async () => {
    const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
    const r = (await callPlansRead('lint', { full: true })) as { reports?: unknown[] };
    if (!Array.isArray(r?.reports)) return [];
    return r.reports.map((report) => summarizePlanLintReport((report ?? {}) as PlanLintReport));
  },
});

// ── learning.soakReport (P-005) — measured 27.3s on the read path ────────────
//
// The worst offender: a host-global `journalctl` scan that sat INSIDE a per-pot
// fan-out, so ~12 hives meant ~24 concurrent scans of a 1.2GB journal per
// Learnings-tab load, all returning byte-identical results.
//
// Precompute replaces the getOrSet cache landed earlier in WI-5460, which was
// always a stopgap: a cache still pays the full 27s on cold load, and on a host
// with no journald it fails rather than degrades (see the P-005 capability
// detection in pot/soak-report.ts).
//
// The rolling window is 12–24h, so the report barely moves minute to minute;
// 10 minutes is comfortably fresh for a readiness panel. EI-22753375938788500:
// this compute also runs the placement-frontier queries once per pot, which made
// it the largest continuous PG consumer when it stayed in the shared sweep even
// with zero Learnings readers. Use the registry's existing demand-driven mode:
// a read serves the last-known-good snapshot immediately and refreshes behind it
// only when that snapshot is stale. Zero reads therefore means zero recomputes.
registerDerivedRead({
  key: 'learning.soakReport',
  ttlMs: 10 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  excludeFromDefaultSweep: true,
  refreshOnRead: true,
  compute: async ({ workspaceId }) => {
    const { listPots } = await import('../agent-tools/pot/_resolve');
    const { readPotSoakReport } = await import('../pot/soak-report');
    const homes = await listPots(workspaceId).catch(() => []);
    const reports = (
      await Promise.all(
        homes.map(async (home: { slug: string }) => {
          try {
            return await readPotSoakReport(home.slug, {});
          } catch {
            return null;
          }
        }),
      )
    ).filter((report): report is NonNullable<typeof report> => report != null);
    return [{ hives: reports }];
  },
});

// ── The three dev.* diagnostics (WI-5476) ────────────────────────────────────
//
// `dev.serviceHealth` / `dev.deployState` / `dev.gitPipelineHives` each spawned a
// subprocess (systemctl / git) on the /admin/git panel's read (measured 1.34s /
// and the git ones per-hive). They are DEV-only — the rail that reads them is
// gated `import.meta.env.DEV` and absent from user builds — so the shipped-desktop
// hard-fail hazard is muted, but they still spawned on a sync read and the
// no-heavy-io-on-read-path guard rightly flagged them. Precompute takes the
// subprocess off the read entirely, so the resolver is a plain snapshot SELECT.
//
// These share the substrate's per-producer ttl, so the routine's short (2-min)
// cadence keeps them fresh without re-running the expensive storage/plans/soak
// producers, which stay gated behind their own long ttls.

// deployState + gitPipelineHives track the deploy pipeline, which moves on a
// ~15-min cadence, so a 5-minute snapshot is amply fresh.
registerDerivedRead({
  key: 'dev.deployState',
  ttlMs: 5 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { devDeployState } = await import('../dev-deploy-state');
    return [await devDeployState()];
  },
});

registerDerivedRead({
  key: 'dev.gitPipelineHives',
  ttlMs: 5 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async ({ workspaceId }) => {
    const { gitPipelineHiveRows } = await import('../git-pipeline-hives');
    return gitPipelineHiveRows(workspaceId);
  },
});

// dev.gitPipeline (whole-app-sync-payload-audit P-007) — measured 3.1s COLD /
// 13ms warm on the /admin Git panel's `dev.gitPipeline` sync read. The snapshot's
// PG sub-reads (routines/escalations/pipeline_events) are cheap; the cost is
// `gitPipelineSnapshot()` → `devDeployState()`, which fans out ~6 `git` fork/execs
// to resolve staging/main/deployed refs + gaps. That git spawn was pinned TWICE as
// the #1 application-attributable event-loop cost (P-015, P-009). devDeployState's
// own 10s single-flight cache did NOT cover this read path in practice: GitClient
// polls with staleTime 30s > the 10s TTL, so EVERY panel refetch was a cold fan-out.
//
// Precompute mirrors the two siblings above (dev.deployState, dev.gitPipelineHives,
// both precomputed in the same WI-5476 effort) — the resolver becomes a plain
// snapshot SELECT and no git spawns on the sync read path. This slims ONLY the
// UI-sync boundary: every DIRECT caller of gitPipelineSnapshot() (git-pipeline-
// position, why-chain, release-deploy-launch, the green-stall / release-deploy-
// staleness watchdogs, the release:trace tool) still computes a LIVE snapshot and
// is untouched — matching the P-005/P-006 "slim at the UI boundary, never the
// shared loader" pattern.
//
// 90s ttl (NOT the 5-min of the deploy-gap siblings): unlike a slow deploy gap,
// this snapshot carries liveness-sensitive gate-health verdicts (consecutiveReds,
// verdictStale, fireStale) that a human watches on the /admin Git panel during a
// pipeline incident. 90s < the routine's 2-min cron floor, so it recomputes on
// EVERY tick — the freshest the substrate offers, same rationale as serviceHealth.
// The panel surfaces computedAt via _meta.derivedRead ("as of HH:MM").
registerDerivedRead({
  key: 'dev.gitPipeline',
  ttlMs: 90_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { gitPipelineSnapshot } = await import('../git-pipeline-stats');
    // includeActiveRun (overview-tab-expansion P-001): the "judging vs idle" systemd
    // probe runs HERE, in the background precompute, so the Overview Deploy tile gets
    // it while live gitPipelineSnapshot() callers stay fork-free.
    return [await gitPipelineSnapshot(undefined, { includeActiveRun: true })];
  },
});

// serviceHealth is a LIVENESS probe — a stale snapshot is more misleading than
// for the pipeline ones — so it gets a short ttl (recomputed on essentially every
// 2-min routine tick). The panel surfaces the snapshot's computedAt via _meta, so
// a viewer sees "as of HH:MM:SS" rather than mistaking stale for live.
registerDerivedRead({
  key: 'dev.serviceHealth',
  ttlMs: 90_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { probeAll } = await import('../service-health');
    const services = await probeAll();
    return [{ services }];
  },
});

// ── health.toolEfficiency (P-010 + P-011, decision D-008) ────────────────────
//
// The single most expensive read-path offender measured on this box: FOUR
// tool_invocations aggregates run inline on every computeSystemHealth. A live
// pg_stat_statements delta (2026-07-27) caught the three heaviest advancing in
// LOCKSTEP — +93/+94/+94 calls in the same 3.6-minute window — which is what
// proved they share ONE caller rather than being three independent problems:
//
//   limit-failure rollup 14d   300.8 ms  72.8 CPU-h lifetime
//   coord_owner empty-runs     216.6 ms  45.5 CPU-h
//   `oriented` CTE 24h         125.8 ms  30.4 CPU-h
//
// ~26 calls/min fleet-wide across ~49 uncoordinated agent processes = ~0.28
// DB-cores burned continuously recomputing identical fleet-wide numbers.
//
// TTL rationale (the header's rule: ttl follows how fast the SIGNAL moves, not
// how expensive the compute is): the underlying windows are 24h, 7d and 14d, so
// a value seconds-old and one ten-minutes-old are indistinguishable — nothing in
// a 14-day error count changes meaningfully inside a routine tick. 10 minutes is
// chosen ALSO because WI-5471 runs producers shortest-ttl-first: a heavy
// four-scan producer must never sort ahead of the liveness-sensitive short-ttl
// ones (dev.serviceHealth 90s, learning.improvements 90s) and head-of-line-block
// them. Scope is workspace — the aggregates are fleet-wide and carry no harness
// filter, so a per-harness snapshot would be N identical copies.
registerDerivedRead({
  key: 'health.toolEfficiency',
  ttlMs: 10 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { computeToolEfficiencyHealth } = await import('../system-health/tool-efficiency');
    return computeToolEfficiencyHealth();
  },
});

// ── rubrics.list (owner-reported 2026-07-19: the Learnings → Rubrics tab took
// ~0.7s to OPEN on a LOCAL desktop app — "loading a little data should be
// instant"). Root cause: an N+1 over-fetch on the user-facing read path. The
// resolver ran, PER rubric, a `listScorecards({ rubricRef, limit: 500 })` (≈13
// rubrics × up to 500 FULL scorecard rows) purely to project each rubric's
// latest + average score10 in JS. score10 is a read-time projection over the
// ratings jsonb, so the aggregation is genuinely expensive to do on read.
//
// This class was MISSED by the WI-5460 audit, which enumerated only the
// `learning.*` sync queries — the `rubrics.*` / `scorecards.*` namespace behind
// the imported RubricsPanel slipped through (the audit gap the owner flagged).
// It also evaded the no-heavy-io-on-read-path guard, which catches
// subprocess/recursive-fs, not a heavy N+1 PG over-fetch.
//
// The Rubrics tab is a read-mostly REVIEW surface (agents grade via
// scorecards:emit; this tab reviews health/scores/trends), so a short precompute
// lag on the aggregate OVERVIEW is invisible — the per-rubric DETAIL panel
// (scorecards.list / rubrics.trend) stays a live read. 2-min ttl recomputes on
// essentially every routine tick; the list surfaces computedAt via _meta.
registerDerivedRead({
  key: 'rubrics.list',
  ttlMs: 2 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { listRubrics } = await import('../rubrics');
    const { listScorecards, scorecardTotalCountsByRubric } = await import('../scorecards');
    const rubrics = await listRubrics({});
    // Per-rubric latest/avg window (WI-5415: a per-rubric window, not one shared
    // globally-capped read, so a high-volume rubric never crowds a low-volume one
    // out of the window) + a real UNBOUNDED total count.
    const [totalCounts, perRubricScorecards] = await Promise.all([
      scorecardTotalCountsByRubric(),
      // WI-6124: no includeLinks — this aggregation reads only `createdAt` and `score10`
      // (below), never `linkedItems`, so it takes the opt-in default and skips the
      // outbound-links join. This is the highest-volume listScorecards caller in the tree
      // (~13 rubrics x up to 500 rows EVERY producer run); back when links were eager it
      // paid ~13 of those join-heavy queries per run for a field it never read.
      Promise.all(rubrics.map((r) => listScorecards({ rubricRef: r.rubricId, limit: 500 }))),
    ]);
    return rubrics.map((r, i) => {
      const cards = perRubricScorecards[i] ?? [];
      let latestAt: string | null = null;
      let latestScore10: number | null = null;
      let scoreSum = 0;
      let scoreN = 0;
      for (const s of cards) {
        if (!latestAt || s.createdAt > latestAt) {
          latestAt = s.createdAt;
          latestScore10 = s.score10;
        }
        // avgScore10 = mean of the read-time 0–10 projections; null-scored
        // (all-unknown) scorecards excluded, matching the per-scorecard rule.
        if (s.score10 !== null) {
          scoreSum += s.score10;
          scoreN += 1;
        }
      }
      return {
        rubricId: r.rubricId,
        characteristic: r.characteristic,
        title: r.title,
        status: r.status,
        proposedBy: r.proposedBy,
        ratifiedBy: r.ratifiedBy,
        criteriaCount: r.criteria.length,
        ratingScale: r.ratingScale,
        methodRef: r.methodRef,
        updatedAt: r.updatedAt,
        // TRUE unbounded total (WI-5415) — never the capped per-rubric read length.
        scorecardCount: totalCounts[r.rubricId] ?? cards.length,
        latestScorecardAt: latestAt,
        latestScore10,
        avgScore10: scoreN > 0 ? Math.round((scoreSum / scoreN) * 10) / 10 : null,
      };
    });
  },
});

// ── insights.coordTokens (phase2 P-002) — measured 0.5-0.8s / 4.6KB on the
// Learnings → Tokens subtab's Coordination panel read (WI-5584). Three
// workspace-scoped rollups recomputed on EVERY read: the model_pricing rate book,
// the coord-cost breakdown ($ by turn-trigger and by role-class over a 7-day
// window of harness_shared.agent_usage_samples), and the coord-poll volume (a
// COUNT + COUNT(DISTINCT) over a 1-day window of harness_shared.tool_invocations
// — the ~75%-of-all-rows wake-poll aggregate). All three are GROUP BY / COUNT
// aggregations over the two highest-volume telemetry tables, so the cost scales
// with fleet activity and lands entirely on a user-facing sync read.
//
// Coord cost is fleet-wide, so the resolver's `harness` arg is OPTIONAL and the
// window defaults are fixed (7d cost / 1d poll). Derived-read snapshots key on
// (workspace_id, harness_slug, key) with NO arg dimension, so this producer
// precomputes ONLY the DEFAULT variant (whole-workspace, default windows) — the
// exact shape the Tokens panel requests on mount. A resolver call that passes an
// explicit `harness` or `windowMs` is a non-default view and falls through to
// inline compute (see the gate in sync-resolver/index.ts).
//
// 5-minute ttl: these rollups aggregate 1-7 DAY windows, so they barely move
// minute to minute — a 5-min snapshot is far fresher than the panel needs, and
// on the routine's 2-min cron it recomputes every ~2-3 ticks rather than every
// tick, keeping this off the hot compute path. The panel surfaces computedAt via
// _meta.derivedRead ("as of HH:MM"), and a manual invalidate still forces a live
// refetch of the non-default views.
registerDerivedRead({
  key: 'insights.coordTokens',
  ttlMs: 5 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async ({ workspaceId }) => {
    // BOUNDED (WI-39825) via the SAME extracted fan-out the resolver uses, so the
    // precomputed default and the on-read variants cannot drift — and, the reason
    // it mattered here first, so the copy that runs UNATTENDED every 5 minutes is
    // the one that got the deadline. Three unbounded GROUP BY / COUNT aggregates
    // over the busiest telemetry tables could previously hang and occupy a
    // scheduled routine indefinitely.
    const { readCoordTokens } = await import('../sync-resolver/insights-coordtokens-read');
    return withWorkspace(workspaceId, async (tx) => {
      const runQuery = async <T>(query: string, params: unknown[]): Promise<T[]> =>
        (await tx.unsafe(query, params as never)) as unknown as T[];
      // Default variant only: no harness_slug, default windows (7d cost / 1d poll).
      return readCoordTokens({ runQuery, workspaceId });
    });
  },
});

// ── learning.improvements (phase2 P-003) — measured 0.4-0.5s / 134KB on the
// Learning tab's self-improvement feed (WI-5460 follow-up). buildDigest +
// human-queue ranking + flow-metrics get rebuilt over the WHOLE improvement
// corpus (~380 items) on every user-facing read. Precompute moves that compute
// onto the routine; the resolver's default mount ({} args) becomes a plain
// snapshot SELECT.
//
// The compute is shared with the resolver's live inline path
// (computeLearningImprovementsSnapshot) so the precomputed default and the
// on-read non-default variants can never drift. The `recordQueueExposure`
// owner-preference side-effect is DELIBERATELY excluded from the shared compute
// (it must fire on the real read, not the routine thread) — the resolver fires
// it from whatever humanQueue the read returns.
//
// FRESHNESS (the plan's "verify Scout/owner freshness needs; short ttl"):
//   - Scout reads the improvements:digest TOOL, not this sync resolver, so it is
//     UNAFFECTED by precomputing the resolver.
//   - Owner: a 90s ttl (the liveness-sensitive tier, matching dev.serviceHealth /
//     dev.gitPipeline) recomputes on essentially every 2-min routine tick, so the
//     Learning queue is at most ~one tick stale — consistent with the already
//     shipped, owner-accepted rubrics.list / storage.usage precompute behavior
//     under the substrate's D-003 "a read never computes" invariant. The panel
//     surfaces computedAt via _meta.derivedRead ("as of HH:MM"). NON-default views
//     (state/limit/hive) stay fully live.
registerDerivedRead({
  key: 'learning.improvements',
  ttlMs: 90_000,
  // BUMPED for learning-tab-surface P-002/D-002: the default variant's POPULATION
  // changed (every captured improvement → only what the learning loop produced), so
  // a cached v1 row is not merely stale, it answers a different question. The bump
  // invalidates it instead of serving the old corpus under the new view's name.
  //
  // v2 → v3 (WI-7275): WI-7279 narrowed the humanQueue wire SHAPE to
  // HUMAN_QUEUE_WIRE_FIELDS (22 keys → 12) but did not bump this version, so the
  // fix was INERT on the read it was filed against. A stored v2 row matches the
  // reader's version check (:204), so it kept serving the old fat shape — measured
  // 2026-08-03 02:2xZ: the snapshot path returned 317,812 B / 22 keys while the
  // inline path, same code, returned 223,159 B / 11. Restarting the producer host
  // is NOT sufficient: THREE hosts write this row (:3170, :3070 release, bg-host)
  // and :3070 runs release code, so at equal versions the downgrade guard (:380)
  // permits it to clobber the slim row back indefinitely. The version bump is what
  // makes a shape change self-enforcing — same rule as the v1 → v2 bump above:
  // a superseded SHAPE is treated as absent and re-warmed by the new-code reader.
  //
  // v3 → v4 (WI-39773 / D-008): the humanQueue wire shape changed again —
  // `tierReason` now ships INTERNED as `trc` (a code) plus a per-payload
  // `tierReasonLegend`. A stored v3 row has the fat string and NO legend, so a
  // reader that resolves `trc` through the legend would find neither and show an
  // empty tier reason in quick search — the exact silent-narrowing this encoding
  // was chosen to avoid. Bumping is what makes the change self-enforcing.
  //
  // v4 → v5 (WI-471938): the row gains `sourceOptions`, the CORPUS-wide set of
  // "Filed by" values. The tab's source chips used to derive their options from the
  // windowed rows, so a source whose rows all sat past the 500-row cap offered no chip
  // and could not be selected (measured live 2026-08-28: `system`, 15 corpus rows, 0 in
  // the window). A stored v4 row carries no such field, and the client falls back to the
  // window when it is ABSENT — which is exactly the old, wrong behaviour. So without this
  // bump the fix would ship inert on the very read it was filed against, for the third
  // time on this producer. That is the whole reason this counter exists.
  //
  // v5 → v6: the ambiguous top-level digest rollups (`total`, `returned`,
  // `windowed`, `open`, and the by-* maps) moved into explicit `census` and
  // `window` objects. A stored v5 row is structurally incompatible with readers
  // of the nested contract, so invalidate it rather than serving stale fields as
  // `undefined` until the snapshot TTL happens to turn over.
  producerVersion: 6,
  scope: 'workspace',
  compute: async () => {
    const { computeLearningImprovementsSnapshot } = await import('../harness/improvements/learning-digest-snapshot');
    // The DEFAULT variant: no state filter, default limit, whole workspace (no hive
    // lens), and the DEFAULT provenance scope ('loop' — LearningImprovementsArgs.scope).
    // Keeping this call argument-free is what keeps the tab's own view on the fast
    // path: the resolver only serves its default variant from this snapshot.
    return computeLearningImprovementsSnapshot({});
  },
});

// ── learning.improvements.hive (WI-7432) — the PER-POT variant of the above ──
//
// WHY THIS EXISTS, and why the sibling above was not enough. The workspace-wide
// producer serves only `hive === undefined`, but the Learning tab INHERITS the pot
// lens from the top-bar selector (owner directive 2026-07-26; LearningTab's
// HIVE_AWARE_VIEWS includes "improvements"), so a user with any pot selected sends
// `{hive}` and misses the snapshot on EVERY mount. The precomputed fast path
// therefore served only the All-Pots case — the case nobody is in.
//
// Measured on the owner's own desktop sidecar 2026-08-03, which is what makes this
// a defect rather than a tuning nit: `{hive:'papercusp'}` cost 0.35-0.52s warm and
// 1.56-3.19s cold against a ~10ms plain SELECT for the default variant. That is the
// whole of the owner's "switching to the learning tab takes several seconds" report
// (WI-7432) — NOT transport: 16 concurrent IPC requests finish in 63ms on that box,
// and learning.health (394 B) is 6ms over the same path.
//
// `scope: 'harness'` is the load-bearing choice: the substrate already keys
// snapshots on (workspace_id, harness_slug, key) and `system:precompute-derived-reads`
// already fires PER HARNESS, so the pot dimension the resolver needs is the harness
// dimension the table has had all along. No schema change, no new arg dimension —
// this is the reuse the header of this file asks for.
//
// The advScope lens resolves a member harness to its HIVE HOME slug, so the value
// the resolver passes as `harnessSlug` is always a real harness slug and the fan-out
// is bounded by the registry (8 harnesses here), at ~0.7s each against the 20s
// storage.usage and 27s soakReport already in this routine's pass.
//
// A MISS still falls through to the live compute in the resolver (never an empty
// panel), and `warmMissedSnapshot` fills the cold key in the background, so a pot
// the routine has not reached yet is exactly as fast as today and instant after.
//
// producerVersion tracks the sibling: both call the SAME
// computeLearningImprovementsSnapshot, so a wire-shape change lands on both at once
// and a stale row here must be invalidated for the same reason (WI-7275/WI-7279 —
// an unbumped version keeps serving the old fat shape and ships the fix INERT).
registerDerivedRead({
  key: 'learning.improvements.hive',
  ttlMs: 90_000,
  // v3 → v4 tracks the sibling's tierReason interning (WI-39773 / D-008), per the
  // note above: same compute, same wire shape, so the same stale-row hazard.
  //
  // v4 → v5 tracks the sibling's `sourceOptions` (WI-471938) for the same reason. The
  // hive lens is NOT a view predicate, so this variant takes the same unfiltered branch
  // and gains the same field — a stored v4 row here would leave the hive-scoped tab on
  // the window-derived chip set the bump exists to retire.
  //
  // v5 → v6 tracks the sibling's nested `census` / `window` digest contract.
  // Both producers call the same compute function, so both stale-row keys must
  // be invalidated together.
  producerVersion: 6,
  scope: 'harness',
  compute: async ({ harnessSlug }) => {
    const { computeLearningImprovementsSnapshot } = await import('../harness/improvements/learning-digest-snapshot');
    // Only the hive lens varies from the default variant — state/limit/scope stay
    // at their defaults so this snapshot answers exactly the question the tab's
    // pot-scoped mount asks, and nothing broader.
    return computeLearningImprovementsSnapshot({ hive: harnessSlug });
  },
});

// ── coord.history (phase2 P-004) — measured 0.1-0.8s (variable) / 160KB on the
// legacy /coord history viewer (WI-5460 follow-up). loadCoordHistory reads the
// ENTIRE coord corpus (all plan-events + messages + escalations + handoffs) then
// filters/sorts/slices in JS — so the compute grows with total coord volume, and
// the variable latency the plan flagged is that full scan.
//
// Only the DEFAULT view (all sources, no planSlug/owner/sinceTs filter, the
// default limit of 200 — exactly what the /coord screen mounts with) is
// precomputed; snapshots have no arg dimension, so any filtered/custom-limit view
// falls through to the live inline scan. The heavy per-item `payload` is KEPT (the
// screen's on-demand expand renders it), served fast from the snapshot's jsonb.
//
// 90s ttl (live-feed tier): the routine recomputes on essentially every 2-min
// tick, so the viewer is ≤1 tick stale — fine for a review/debug surface with a
// manual Refresh (staleTime 30s), and consistent with the substrate's D-003 "a
// read never computes". NOTE (follow-up, not P-004 scope): loadCoordHistory's
// scan-everything-then-filter-in-JS is shared with the /api/coord/history HTTP
// route (pui TUI); pushing the filter/limit into the DB is a broader refactor.
registerDerivedRead({
  key: 'coord.history',
  ttlMs: 90_000,
  // v2 (WI-7295): toHistoryItem stopped shipping the 7 projected columns a
  // SECOND time inside `payload` (it used to be the whole envelope those columns
  // were projected from) — 42,328 B / 16.2% of the default view, which is what
  // put this read over its 250,000 B budget. The bump is LOAD-BEARING: the reader
  // accepts any stored row at the SAME producerVersion, so a shape change without
  // one keeps serving the old fat rows forever and ships INERT (WI-7275/WI-7279
  // burned exactly that way — green tests, clean types, unchanged live bytes).
  // v3 (WI-7297): `payload` is dropped from the snapshot entirely. WI-7295's v2
  // cut removed the REDUNDANT bytes inside it; what remained (`body`,
  // `sections`, `fieldProvenance`, `basedOn` — 75.95% of the read, 159,523 B
  // live on 2026-08-03) is real content, so no further projection of its
  // contents was available. The waste was per-VIEW instead: CoordHistory holds
  // `expanded` as one `useState<string | null>`, so at most ONE row's payload is
  // ever rendered, after a click. The expanded row now fetches its own payload
  // from /api/coord/history/:source/:msg_id (an indexed point lookup), and this
  // snapshot stops storing and serving 200 of them to render zero.
  //
  // The bump is LOAD-BEARING, exactly as v2's was: the reader accepts any stored
  // row at the SAME producerVersion, so without it the already-stored v2
  // snapshots keep passing the version check and serve the old fat rows forever
  // — the cut ships INERT with green tests and clean types (WI-7275/WI-7279
  // burned that way; WI-7289's shape-guard in routes/coord/index.test.ts now
  // fails when this shape moves without a bump).
  producerVersion: 3,
  scope: 'workspace',
  compute: async () => {
    const [{ loadCoordHistory }, { projectCoordHistoryForUi }] = await Promise.all([
      import('../endpoint-route/routes/coord'),
      import('../sync-resolver/coord-ui-projection'),
    ]);
    // DEFAULT variant only: no filters, default limit (200) — the /coord mount.
    return projectCoordHistoryForUi((await loadCoordHistory({})).items) as unknown[];
  },
});

// ── learning.releaseReadiness (phase2 P-005) — measured 0.27s / 2.3KB on the
// Verify stage's GO/NO-GO strip. readReleaseReadiness reruns
// buildProgramSuccessReport + rubric governance reads (getRubric/listScorecards)
// on every mount; small payload, pure compute → a clean thin precompute. No args,
// so the resolver is an unconditional snapshot SELECT. 5-min ttl: release-
// readiness (six success bars + rubric governance state) moves slowly.
registerDerivedRead({
  key: 'learning.releaseReadiness',
  ttlMs: 5 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { readReleaseReadiness } = await import('../sync-resolver/learning-release-readiness-read');
    return [await readReleaseReadiness()];
  },
});

// ── learning.observations (phase2 P-005) — measured 0.22s / 152KB on the
// Observations browse pane. listIssues + countIssues + per-row map/sort over the
// whole OBSERVATION lane on every mount; the 152KB is the per-observation `body`.
// Only the DEFAULT view (no state filter, default limit 200 — the pane's mount)
// is precomputed via the shared computeLearningObservations; a state filter /
// custom limit falls through to the live inline compute (snapshots have no arg
// dimension). 90s ttl (browse feed, invalidated on a new observation file): the
// routine keeps it ≤1 tick fresh, consistent with the substrate's D-003.
registerDerivedRead({
  key: 'learning.observations',
  ttlMs: 90_000,
  // v2 (WI-7303): the mapper now OMITS null-valued keys (D-025) and resolves
  // `sourceRole` from `payload.filedByRole` when `payload.sourceRole` is absent.
  // The bump is load-bearing — without it the cached v1 snapshot keeps serving
  // the old shape and the fix ships INERT (the WI-7275/7279 trap).
  producerVersion: 2,
  scope: 'workspace',
  compute: async () => {
    const { computeLearningObservations } = await import('../sync-resolver/learning-observations-read');
    // DEFAULT view: no state filter, default limit (200).
    return computeLearningObservations({});
  },
});

// ── syncReads.audit (EI-19457924854150358) — the sync-read payload audit ──────
//
// ⚠ THIS PRODUCER IS NOT A READ OPTIMISATION. Every other entry in this file moves
// an expensive computation off a user-facing read path. This one has no read path at
// all: it exists because the registry + `refreshDerivedReads({ only })` is already a
// solved "run an expensive thing on a schedule and keep the last result" mechanism,
// and building a second one would be the reuse-first smell. It is the INSTRUMENT that
// decides whether a sync read has outgrown its byte ceiling.
//
// The gap it closes: `sync-read-audit.ts` is a fine instrument that NOTHING RAN. Its
// own source says "run on demand" — which in practice meant "run when an agent happens
// to look". `plans.list` drifted past its allowlisted ceiling and sat there ~12h until
// an unrelated investigation tripped over it. A ratchet nobody re-measures is a comment,
// not a guard.
//
// ── Why `excludeFromDefaultSweep` (do NOT remove it) ────────────────────────────
// Producers run SEQUENTIALLY and the shared routine is `concurrency: 'skip'`, so this
// audit's cost is charged to the whole sweep on every pass where it is due — a
// minutes-scale producer starves the 90s-ttl `serviceHealth` for several ticks. The
// ttl-ascending ordering (WI-5471) bounds head-of-line blocking only while the heaviest
// producer is seconds-scale. That is WHY the flag exists; this is its first user, and
// the flag is INERT without it. Its own routine drives it via `only: ['syncReads.audit']`.
//
// ── Why in-process rather than over REST ───────────────────────────────────────
// `measureSyncReadPayloadsViaRest` stays the manual on-demand harness and the
// calibration ORACLE, but a producer must not loop HTTP back into its own process:
// that needs the superuser token, a baseUrl/port guess, and an auth posture to keep in
// sync — and it is exactly the self-HTTP `no-http-anywhere-2026-07-28` exists to remove.
// `LATENCY_BUDGET_MS` is also documented as "compute time on the operator", which the
// in-process `ms` measures and the REST round-trip does not.
//
// CALIBRATED, not assumed (2026-08-03, 175 of 218 names): in-process is byte-identical
// to REST on 169/175 including `plans.list` (~700KB). The 6 that differed
// (network.hiveDirectory, automation.catalog, designRegressions.list, dev.fleetGovernor,
// hive.steering, advRoster.list) ALL read process-local/host state, and the calibration
// probe runs its in-process leg in a standalone driver while REST is served by the
// operator — two processes legitimately holding different live state (network.hiveDirectory
// returned a different ROW COUNT, which serialization cannot cause). Zero PG-backed reads
// diverged. Running INSIDE the operator, as this producer does, is precisely the condition
// that removes that confound.
//
// ttl is deliberately BELOW its routine's cadence so a daily fire always finds it due;
// the ttl is not the schedule (the routine is), it is the "don't recompute twice" guard.
registerDerivedRead({
  key: 'syncReads.audit',
  ttlMs: 12 * 60 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  excludeFromDefaultSweep: true,
  compute: async () => {
    const { buildLiveFixtureMap, measureSyncReadPayloadsInProcess } = await import('../sync-resolver/sync-read-audit');
    const { knownQueryNamesV2, getRegistryEntryV2 } = await import('../sync-resolver/index');

    const fixtures = buildLiveFixtureMap(knownQueryNamesV2(), getRegistryEntryV2);
    const report = await measureSyncReadPayloadsInProcess({ fixtures });

    // The two buckets are kept in FULL and DISJOINT — they answer different questions
    // and collapsing them is the WI-7084 defect this audit exists to surface:
    //   violations         = newly fat and unallowlisted
    //   ratchetRegressions = allowlisted but busting its OWN recorded ceiling (worse:
    //                        someone already measured this and the number rotted)
    // `measured` is truncated because the full 218-row table is a browse artifact, not
    // a signal; the heaviest few are what a reader acts on.
    return {
      measuredAt: new Date().toISOString(),
      counts: {
        measured: report.measured.length,
        skipped: report.skipped.length,
        violations: report.violations.length,
        ratchetRegressions: report.ratchetRegressions.length,
      },
      violations: report.violations,
      ratchetRegressions: report.ratchetRegressions,
      heaviest: report.measured.slice(0, 25),
      budgetBytes: report.budgetBytes,
      budgetMs: report.budgetMs,
      // Carried verbatim: without it the `ms` column is uninterpretable, and silently
      // so — treat latency as advisory whenever loadPerCore is above ~1.
      host: report.host,
    };
  },
});
