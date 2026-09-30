/**
 * schedule:inventory — the central read-only view of EVERY scheduled/recurring
 * thing in the operator host, regardless of cadence
 * (plan schedule-inventory-and-ephemeral-tier-2026-06-26, P-002).
 *
 * Unions DBOS scheduled workflows (durable) + harness_shared.routines (durable) +
 * in-process-periodic sweeps (ephemeral) into one row shape. The aggregation logic
 * lives in ../../schedule-inventory so the /admin/schedules data path (P-003) shares
 * it. The managedSetInterval registry (P-006) and per-process registries (P-014)
 * plug in as additional sources without touching this tool.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { collectScheduleInventory, summarizeInventory, SCHEDULE_SOURCES } from '../../schedule-inventory';

export default defineTool({
  name: 'schedule:inventory',
  profile: 'engineer',
  description:
    'Central read-only inventory of EVERY scheduled/recurring thing in the operator host regardless of cadence: DBOS scheduled workflows (durable tier), harness_shared.routines (durable tier), live managedSetInterval timers + in-process-periodic health sweeps (ephemeral tier), and bespoke separate-process timers (external-process: the inference gateway, its watchdog, the psu-launcher — listed for visibility, live fire-state pending federation). One row shape {source,scope,tier,category,name,cadence,armed,lastFire,nextFire,lastError,groupSlug}. groupSlug (WI-5018) is populated for `routines` rows only — null elsewhere/ungrouped. Read-only.',
  capability: 'operator:read',
  guidance: {
    when: 'See ALL cadences in one place — what runs on a schedule and how often (DBOS crons, system routines, in-process sweeps) — before tuning/pausing one or diagnosing a missing tick. Pass group to narrow to one routines group instead of the flat cross-source list.',
    notWhen:
      'To CHANGE a routine use routines:set; for DBOS execution rows (status counts/recent runs) use the /admin/dbos view; for routine-only detail (incl. group filter/rollup) use routines:list.',
    chaining: 'routines:set to retune a routine row you find here; routines:list for routine-only detail (incl. { rollup:true } for the group view).',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 30 } },
  args: z.object({
    source: z
      .enum(SCHEDULE_SOURCES)
      .optional()
      .describe('Filter to one source (dbos | routines | in-process | managed | external-process).'),
    tier: z
      .enum(['durable', 'ephemeral'])
      .optional()
      .describe('Filter to one execution tier (durable = DBOS-backed; ephemeral = in-process).'),
    name: z
      .string()
      .optional()
      .describe('Case-insensitive substring filter on `name` — bound a single-routine lookup instead of pulling every row (e.g. every harness_shared.routines row) into context.'),
    installSlug: z
      .string()
      .optional()
      .describe('Case-insensitive substring filter on `installSlug` (routines only; other sources have installSlug=null and never match).'),
    group: z
      .string()
      .optional()
      .describe('Filter to one routine group slug (WI-5018; routines source only — other sources have groupSlug=null and never match). Pass "" for ungrouped-only.'),
  }),
  async handler(args) {
    let rows = await collectScheduleInventory();
    if (args.source) rows = rows.filter((r) => r.source === args.source);
    if (args.tier) rows = rows.filter((r) => r.tier === args.tier);
    if (args.name) {
      const needle = args.name.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(needle));
    }
    if (args.installSlug) {
      const needle = args.installSlug.toLowerCase();
      rows = rows.filter((r) => (r.installSlug ?? '').toLowerCase().includes(needle));
    }
    if (args.group !== undefined) {
      rows = args.group === '' ? rows.filter((r) => r.groupSlug === null) : rows.filter((r) => r.groupSlug === args.group);
    }
    const summary = summarizeInventory(rows);
    return { data: { summary, rows } };
  },
});
