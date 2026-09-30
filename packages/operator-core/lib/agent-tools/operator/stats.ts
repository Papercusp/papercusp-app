/**
 * operator:stats — 7-day operator KPI aggregation.
 *
 * Wraps `readOperatorStats()` (apps/operator/lib/operator-stats.ts) so
 * agents can reach the same numbers the /settings/operator page shows.
 * Read-only, role-gated (any role); no quota — local PG aggregation.
 *
 * First-party operator-side tool: lives in apps/operator/lib/agent-tools/
 * because it depends on operator-app-only helpers (workspace registry,
 * audit_log readers, budget) that aren't reachable from the standalone
 * @papercusp/agent-mcp package. The tool registers via the same
 * `defineTool({ requirePrincipal: false })` path as packages-side tools.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readOperatorStats } from '../../operator-stats';

export default defineTool({
  name: 'operator:stats',
  profile: 'engineer',
  description: '7-day operator KPIs: card counts, auto-dispatch rate, dismissal rate, escalation rate, median ack latency, spend.',
  capability: 'operator:read',
  guidance: {
    when: `Aggregate operator stats — scans/day, dispatches/day, mode-flip counts. For dashboards / status reports.`,
    notWhen: `For LIVE state, use the specific dedicated tool. stats is historical aggregates.`,
    seeAlso: [
      'operator:budget (spend / budget rollup)',
      'dev:telemetry (live observability datapoints)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({}),
  async handler() {
    const stats = await readOperatorStats();
    return { data: stats };
  },
});
