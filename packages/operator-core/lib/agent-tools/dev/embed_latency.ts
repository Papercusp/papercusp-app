/**
 * dev:embed_latency — read the process-local query-embed latency ring.
 *
 * The search package already records every graded query embed at its choke
 * point, and the embed-latency watchdog consumes the same ring for periodic
 * escalation. Until this tool existed, an operator could only see the
 * watchdog's downstream verdict or infer latency from a degraded search.
 * Expose the ring directly so diagnosis can distinguish a slow embed from a
 * down sidecar and compare each caller with the budget it actually used.
 *
 * This is deliberately a separate diagnostic tool rather than another service
 * probe: the ring is in-process search state, not endpoint liveness. Like the
 * sibling cache counters, the response names its process and cluster caveat;
 * one request reports only the worker that handled it.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  EMBED_LATENCY_CAPACITY,
  embedLatencyObservedCount,
  readEmbedLatency,
} from '@papercusp/search';
// ⚠ `clusterSize` MUST come from the resolver, never a hand-read env var:
// PAPERCUSP_CLUSTER_WORKERS SHADOWS PAPERCUSP_CLUSTER and both are set on this box
// (6 and 16). Reading PAPERCUSP_CLUSTER directly — which this tool did until
// EI-23365791722890491 — reported 16 workers where the operator forks 6, and the
// wrong number was quoted straight at the caller in `perWorkerCaveat`.
import { resolveClusterWorkers } from '../../cluster-fork';
import { getResourceProfile } from '../../resource-profile';

/** Workers observed across calls in this process's lifetime. */
const SEEN_PIDS = new Set<number>();

export default defineTool({
  name: 'dev:embed_latency',
  profile: 'engineer',
  description:
    'Read the process-local query-embed latency ring: per-caller count, timeout/error totals, p50/p99/max, and the budget each caller actually used. The ring is bounded and in-memory; `truncatedByCapacity` means counts are floors. ⚠ On clustered operators this is one worker only — read `pid`/`clusterSize` and repeat to sample workers.',
  capability: 'intel:read',
  guidance: {
    when:
      'Diagnosing a degraded hybrid or context-recall search where the embed sidecar is healthy: compare each caller\'s p99/p50 with its own recorded budget instead of inferring latency from a lexical-only result.',
    notWhen:
      'Service up/down — dev:service_health. Durable recall outcomes — dev:pg_query over memory_recall_stats. This ring is process-local and is not an audit log.',
    returns:
      '{ ok, pid, clusterSize, sampledWorkers, perWorkerCaveat, uptimeSec, observedCount, capacity, windowMs, embeds, callers, oldestSampleMs, newestSampleMs, truncatedByCapacity }. Each caller includes { caller, n, ok, timeout, error, budgetMs, p50Ms, p99Ms, maxMs }; a null budget means the samples were unbounded and are not budget-gradable.',
    seeAlso: [
      'dev:service_health (is the embed sidecar endpoint up)',
      'dev:pg_query (durable memory_recall_stats outcomes)',
      'dev:rate_governor_status (provider-pool pressure)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    windowMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60_000)
      .optional()
      .describe('Trailing window in milliseconds (default 3600000; maximum 24 hours).'),
  }),
  result: z
    .object({
      ok: z.unknown().optional(),
      pid: z.unknown().optional(),
      clusterSize: z.unknown().optional(),
      sampledWorkers: z.unknown().optional(),
      perWorkerCaveat: z.unknown().optional(),
      uptimeSec: z.unknown().optional(),
      observedCount: z.unknown().optional(),
      capacity: z.unknown().optional(),
      windowMs: z.unknown().optional(),
      embeds: z.unknown().optional(),
      callers: z.unknown().optional(),
      oldestSampleMs: z.unknown().optional(),
      newestSampleMs: z.unknown().optional(),
      truncatedByCapacity: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args) {
    const pid = process.pid;
    SEEN_PIDS.add(pid);
    const window = readEmbedLatency(args?.windowMs === undefined ? {} : { windowMs: args.windowMs });
    const clusterSize = resolveClusterWorkers(process.env, getResourceProfile().httpWorkers);
    return {
      data: {
        ok: true,
        pid,
        clusterSize,
        sampledWorkers: SEEN_PIDS.size,
        perWorkerCaveat:
          clusterSize > 1
            ? `ring is THIS worker's only (pid ${pid}); ${clusterSize} workers serve the operator, so repeat the read to sample others`
            : null,
        uptimeSec: Math.round(process.uptime()),
        observedCount: embedLatencyObservedCount(),
        capacity: EMBED_LATENCY_CAPACITY,
        ...window,
      },
    };
  },
});
