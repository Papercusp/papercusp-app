/**
 * dev:cache_stats — runtime observability for the operator read cache
 * (no-http-anywhere-2026-07-28 D-074).
 *
 * `cachedRead` has recorded per-tool hit/miss/stale/bypass/deadline counters
 * since it was written, and the shared `Cache` keeps its own hit/miss/build/
 * single-flight tallies — but NOTHING consumed either. `snapshotCachedReadStats`
 * was exported and re-exported at `cache/index.ts` and read by no caller, so
 * cache health was invisible in the running operator. That gap has a measured
 * cost: chasing P-007's parallelism ceiling, two successive root-cause
 * hypotheses (a 16-worker L1 split, then a tag-bust storm) were each formed by
 * INFERRING cache behaviour from response latency, and each was refuted — the
 * counters that would have settled it in one call existed the whole time.
 * Same fix, same reason as P-003(b), which published the concurrency gate's
 * live depth after a saturated gate proved unobservable from the running app.
 *
 * ⚠ PER-WORKER BY CONSTRUCTION. These counters live in ONE process's memory and
 * `:3070` runs a reuseport CLUSTER, so a single call is answered by whichever
 * worker took the request and reports only that worker's tallies. `pid` and
 * `clusterSize` are returned so the numbers are never read as fleet-wide, and
 * `sampledWorkers` accumulates across repeat calls so a caller can tell "I
 * sampled one of N" from "I sampled them all".
 *
 * ⚠ `clusterSize` MUST come from `resolveClusterWorkers()` (cluster-fork.ts) and
 * never from a hand-read env var: PAPERCUSP_CLUSTER_WORKERS SHADOWS
 * PAPERCUSP_CLUSTER, and on this box BOTH are set (6 and 16 respectively). This
 * tool read PAPERCUSP_CLUSTER directly until EI-23365791722890491 and so reported
 * 16 workers where the operator forks 6 — scaling every per-worker extrapolation
 * a caller makes from it by 2.67x, in the direction that understates per-worker
 * load. Call the resolver; do not re-derive the precedence here (derived-truth
 * ladder rung 1 — cluster-fork.ts owns this truth).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { snapshotCachedReadStats } from '../../cache';
import { resolveClusterWorkers } from '../../cluster-fork';
import { getResourceProfile } from '../../resource-profile';
import { declaredResourceDomainKind, resourceDomainKindsHealth } from '../locks/resource-domain-kinds';

/** Workers observed across calls in THIS process's lifetime — see the pid caveat. */
const SEEN_PIDS = new Set<number>();

export default defineTool({
  name: 'dev:cache_stats',
  description:
    "Live operator READ-CACHE counters (cachedRead), per tool: hits/misses/stale/bypass/deadline, miss reasons, actual factory builds and elapsed build milliseconds. Absent misses combine new/evicted/cleared keys; no key history is retained. buildMs covers buildsCompleted, including failures; builds also includes in-flight work. L2 hits and joined readers do not add factory builds. Also reports this process's resource declaration cache without refreshing it; resource selects one cached declaration. ⚠ PER-WORKER: record pid/uptime/clusterSize and aggregate distinct workers yourself; this result covers one worker. A tool absent from perTool never called cachedRead in this process lifetime. A low hitRatePct alone does not establish expensive rebuilding.",
  guidance: {
    when: "Diagnosing why a read is slow or a cache seems not to serve — read hit/miss here instead of inferring cache behaviour from response latency (that inference is unsound: a cheap query and a cache hit look identical, and it produced two refuted root causes on P-007). Also for confirming the CACHE_LAYER kill-switch state (`bypass`) and whether callers are hitting deadlines.",
    notWhen:
      'Sync-transport concurrency/queue depth — that is the gate probe (window.__sync_metrics__). DB-side cost of a cache MISS — dev:pg_query / pg_stat_statements.',
    seeAlso: ['dev:pg_health (pool + connection health)', 'dev:service_health (is the process up at all)'],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'documenter', 'curator'],
  args: z.object({
    tool: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("Only this tool's row (e.g. 'plans:attention'). Omit for all."),
    resource: z.string().min(1).max(200).optional().describe(
      'Inspect one cached resource domain declaration without loading or refreshing the cache. '
      + 'A null kind means this cache has no non-default declaration, not that the effective lock domain is tree-scoped.',
    ),
  }),
  async handler(args) {
    const pid = process.pid;
    SEEN_PIDS.add(pid);

    // `args` arrives undefined when every field is optional and the caller sends
    // an empty body — the shape the HTTP route (/api/agent-tools/dev/cache_stats)
    // produces, and the shape a bare tools:invoke produces. Found by exercising
    // this live on :3170; the unit tests all passed an object, so they could not
    // have caught it.
    const wanted = args?.tool;

    const snapshot = snapshotCachedReadStats();
    const rows = Object.entries(snapshot)
      .filter(([tool]) => (wanted ? tool === wanted : true))
      .map(([tool, s]) => {
        // Served-without-building = hits + stale (SWR returns the stale value
        // immediately and rebuilds in the background), so both count as "the
        // caller did not wait for a build".
        const served = s.hits + s.stale;
        const total = served + s.misses;
        return {
          tool,
          ...s,
          total,
          hitRatePct: total > 0 ? Number(((served / total) * 100).toFixed(1)) : null,
        };
      })
      .sort((a, b) => b.total - a.total);

    const clusterSize = resolveClusterWorkers(process.env, getResourceProfile().httpWorkers);
    // NOTE: this reduce enumerates fields explicitly, so a counter added to
    // CachedReadToolStats is NOT picked up here automatically the way the per-row
    // `...s` spread above picks it up — add it in BOTH places or the totals silently
    // under-report a counter the rows already show.
    const totals = rows.reduce(
      (acc, r) => ({
        hits: acc.hits + r.hits,
        misses: acc.misses + r.misses,
        stale: acc.stale + r.stale,
        bypass: acc.bypass + r.bypass,
        deadline: acc.deadline + r.deadline,
        // P-007/D-082: the durable L2 tier. `l2Hits` is the number that says whether
        // L2 is doing its job — each one is a cold cross-worker build AVOIDED.
        // A persistently nonzero `l2Errors` means the tier is silently inert.
        l2Hits: acc.l2Hits + r.l2Hits,
        l2Misses: acc.l2Misses + r.l2Misses,
        l2Errors: acc.l2Errors + r.l2Errors,
        missAbsent: acc.missAbsent + r.missAbsent,
        missInvalidated: acc.missInvalidated + r.missInvalidated,
        missHardExpired: acc.missHardExpired + r.missHardExpired,
        builds: acc.builds + r.builds,
        buildsCompleted: acc.buildsCompleted + r.buildsCompleted,
        buildErrors: acc.buildErrors + r.buildErrors,
        buildMs: acc.buildMs + r.buildMs,
        maxBuildMs: Math.max(acc.maxBuildMs, r.maxBuildMs),
      }),
      {
        hits: 0, misses: 0, stale: 0, bypass: 0, deadline: 0, l2Hits: 0, l2Misses: 0, l2Errors: 0,
        missAbsent: 0, missInvalidated: 0, missHardExpired: 0,
        builds: 0, buildsCompleted: 0, buildErrors: 0, buildMs: 0, maxBuildMs: 0,
      },
    );

    return {
      data: {
        ok: true,
        telemetryVersion: 2,
        pid,
        clusterSize,
        sampledWorkers: SEEN_PIDS.size,
        perWorkerCaveat:
          clusterSize > 1
            ? `counters are THIS worker's only (pid ${pid}); ${clusterSize} workers serve :3070, so call repeatedly to sample others`
            : null,
        uptimeSec: Math.round(process.uptime()),
        // Read the existing pinned state synchronously: diagnosing a cold or
        // failed cache must not repair it before the caller can observe it.
        resourceDomainKinds: {
          source: 'current-process',
          ...resourceDomainKindsHealth(),
          declaration: args?.resource === undefined ? null : {
            resource: args.resource,
            kind: declaredResourceDomainKind(args.resource),
          },
          limitations: 'Cached declarations only; a cold or failed refresh may be incomplete. '
            + 'The effective resolver also uses maintained resource-name rules. This read does not refresh the cache.',
        },
        toolCount: rows.length,
        totals,
        killSwitchLikelyOff: totals.bypass > 0 && totals.hits + totals.misses + totals.stale === 0,
        perTool: rows,
      },
    };
  },
});
