/**
 * dev:rate_governor_status — the on-demand snapshot of the fleet rate-limit layer
 * (RB-009 + rate-limit-layer-v2). Serves the shared `buildFleetRateStatus` read-model:
 * the live config (maxSimultaneousAgents + AIMD floor), the fleet cap vs in-flight vs
 * AIMD-effective concurrency (D-004/D-005), one row per live `(provider, modelClass)`
 * governor bucket (paused/until, in-flight vs cap, RPM/ITPM/OTPM headroom), and the
 * recent usage telemetry (tokens, $spend, usage% where a ceiling is known — D-002).
 * The governor additionally broadcasts a coord message + toast on each pause
 * transition (agent-governor-observer); this tool is the pull-side status.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { buildFleetRateStatus, type FleetRateStatus } from '../../fleet-rate-status';
import { runtimeDiagnostic, type RuntimeDiagnostic } from '../../runtime-diagnostic';

type GovernorRootCause = { component: 'governor'; reason: string };

export function buildRateGovernorDiagnostic(status: FleetRateStatus): RuntimeDiagnostic<
  FleetRateStatus['config'],
  FleetRateStatus['fleet'],
  { pausedBuckets: FleetRateStatus['buckets']; usage: FleetRateStatus['usage']; opusBudget: FleetRateStatus['opusBudget'] },
  GovernorRootCause
> {
  const pausedBuckets = status.buckets.filter((bucket) => bucket.paused);
  const rootCause: GovernorRootCause | null = pausedBuckets.length > 0
    ? { component: 'governor', reason: `${pausedBuckets.length} rate bucket(s) paused` }
    : status.fleet.effective < status.fleet.cap
      ? { component: 'governor', reason: `AIMD effective concurrency ${status.fleet.effective}/${status.fleet.cap}` }
      : null;
  return runtimeDiagnostic({
    configured: status.config,
    effective: status.fleet,
    evidence: { pausedBuckets, usage: status.usage, opusBudget: status.opusBudget },
    rootCause,
    // Admission is the decisive next read before anyone edits a rate cap: it
    // distinguishes genuine upstream pacing from queued-while-idle defects.
    nextVerb: rootCause ? 'gateway:status' : null,
  });
}

export default defineTool({
  name: 'dev:rate_governor_status',
  description:
    'Snapshot fleet rate limiting with the standard runtime fields { configured, effective, evidence, rootCause, nextVerb }: configured policy vs AIMD-effective concurrency, paused buckets, RPM/ITPM/OTPM headroom, usage, and opus-budget pacing. If throttled, nextVerb points to gateway:status so admission defects are ruled out before anyone edits a cap. Buckets are empty until a governed turn has run.',
  guidance: {
    when: 'Diagnose whether agent spawns / stateless LLM calls are being paced or paused by the rate-limit governor (e.g. "why are runs slow / stalled?"), or read the fleet cap / effective concurrency / usage% the top-bar shows.',
    notWhen: 'Service up/down — dev:service_health. Migration drift — db:check_drift. EDITING the cap — operator:rate_limit_config.',
    returns: '{ configured, effective, evidence, rootCause, nextVerb, config, fleet, buckets, usage, opusBudget }',
    seeAlso: [
      'dev:service_health (service up / down)',
      'operator:rate_limit_config (edit the cap)',
    ],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  // + overwatch (overwatch-role-2026-06-15 B-01): the supervisor reads the governor's
  // paused buckets / failovers / 429s to detect the token-saturation anomaly (the
  // 2026-06-15 opus-pacing stall) and nudge the Queen.
  agentRoles: ['scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'operator', 'documenter', 'curator', 'cup', 'kettle'],
  args: z.object({
    usageWindowMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional()
      .describe('Lookback for the usage/$spend aggregation (default 60 minutes).'),
  }),
  result: z
    .object({
      configured: z.unknown().optional(),
      effective: z.unknown().optional(),
      evidence: z.unknown().optional(),
      rootCause: z.unknown().nullable().optional(),
      nextVerb: z.string().nullable().optional(),
      config: z.unknown().optional(),
      fleet: z.unknown().optional(),
      buckets: z.unknown().optional(),
      usage: z.unknown().optional(),
      opusBudget: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args) {
    const status = await buildFleetRateStatus((args.usageWindowMinutes ?? 60) * 60_000);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ...status,
          bucketCount: status.buckets.length,
          ...buildRateGovernorDiagnostic(status),
        }),
      }],
    };
  },
});
