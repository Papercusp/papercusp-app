/**
 * GET /api/harness/all/kpis — cross-harness KPI dashboard data.
 *
 * Batched per-schema metrics + parent/child counts + autoloop summary.
 * Cached 10s by default (KPI dashboards aren't real-time).
 *
 * Ported from app/api/harness/all/kpis/route.ts. `auth: 'public'`.
 */
import { getOrgPg } from '@papercusp/db-org';
import os from 'node:os';
import { routeWithWorkspace } from '../../../route-workspace';
import { loadHarnessRegistry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';
import { filterSafeSchemaNames } from './all-kpis-safe-schema-name';
import { aggregateOpCounts, countActiveAutoloops, tallyDirectiveStatuses } from './all-kpis-aggregate';

export async function loadAllKpis() {
    // Harness totals + per-schema metrics derive from the LIVE installed-harness
    // registry (workspace PG, same source as /api/installed) — NOT the legacy
    // harness_shared.projects pots table, which only holds pre-rethink demo rows
    // and made every total render 0 (EI-220).
    const [registryProjects, projTotals] = await routeWithWorkspace(async (tx) => {
      const reg = await loadHarnessRegistry();
      const pt = await tx<{ status: string; n: number }[]>`
        SELECT status, count(*)::int AS n FROM harness_shared.projects GROUP BY status
      `;
      return [reg.projects, pt] as const;
    });
    const schemas = registryProjects
      .filter((p) => typeof p.slug === 'string' && p.slug.length > 0)
      .map((p) => ({ nspname: 'harness_' + p.slug.replace(/-/g, '_') }));

    const { sql } = getOrgPg();
    const projectsByStatus: Record<string, number> = {};
    let projectsTotal = 0;
    for (const r of projTotals) {
      projectsByStatus[r.status] = r.n;
      projectsTotal += r.n;
    }

    let messages24h = 0;
    let executedActions24h = 0;
    const opCounts24h: Record<string, number> = {};
    let directiveOpen = 0, directiveAcked = 0;
    // WI-3885 iteration 7: which named metrics failed to load THIS refresh, so
    // the frontend can flag exactly what's stale/wrong instead of the caller
    // only learning about it from server logs (or, worse, a silently-zero
    // number indistinguishable from a genuine zero). Each failed aggregate
    // already falls back to its zero/empty default below — this array is
    // purely additive surfacing, never a behavior change to the fallback.
    const partialFailures: string[] = [];

    if (schemas.length > 0) {
      const schemaNames = schemas.map((s) => s.nspname);
      type TablePresence = { table_schema: string; table_name: string };
      const presence = await sql<TablePresence[]>`
        SELECT table_schema, table_name
          FROM information_schema.tables
         WHERE table_schema = ANY(${schemaNames})
           AND table_name IN ('messages', 'executed_actions')
      `;
      const hasMessages = new Set(
        presence.filter((r) => r.table_name === 'messages').map((r) => r.table_schema),
      );
      const hasExecutedActions = new Set(
        presence.filter((r) => r.table_name === 'executed_actions').map((r) => r.table_schema),
      );

      const messagesSchemas = filterSafeSchemaNames(hasMessages);
      const executedActionsSchemas = filterSafeSchemaNames(hasExecutedActions);

      if (messagesSchemas.length > 0) {
        const sqlText = messagesSchemas
          .map(
            (n) =>
              `SELECT count(*)::int AS n FROM ${n}.messages WHERE created_at > now() - interval '24 hours'`,
          )
          .join(' UNION ALL ');
        try {
          const r = await sql.unsafe(`SELECT sum(n)::int AS total FROM (${sqlText}) t`);
          messages24h = (r as any)[0]?.total ?? 0;
        } catch (e) {
          // A broken/timed-out messages-count query renders as 0 either way
          // (KPI cards shouldn't 500 over one aggregate) — but log it so a
          // genuinely-zero count is distinguishable from a silently failing
          // one in the server logs.
          console.error('[all-kpis] messages_24h aggregate failed:', e);
          partialFailures.push('messages_24h');
        }
      }

      if (executedActionsSchemas.length > 0) {
        const sqlText = executedActionsSchemas
          .map(
            (n) =>
              `SELECT op, count(*)::int AS n FROM ${n}.executed_actions WHERE executed_at > now() - interval '24 hours' GROUP BY op`,
          )
          .join(' UNION ALL ');
        try {
          const r = await sql.unsafe(
            `SELECT op, sum(n)::int AS n FROM (${sqlText}) t GROUP BY op`,
          );
          const agg = aggregateOpCounts(r as any[]);
          executedActions24h += agg.total;
          for (const [op, n] of Object.entries(agg.byOp)) {
            opCounts24h[op] = (opCounts24h[op] ?? 0) + n;
          }
        } catch (e) {
          console.error('[all-kpis] executed_actions_24h aggregate failed:', e);
          partialFailures.push('executed_actions_24h');
        }
      }

      if (messagesSchemas.length > 0) {
        const sqlText = messagesSchemas
          .map(
            (n) =>
              `SELECT status, count(*)::int AS n FROM ${n}.messages WHERE kind = 'Directive' GROUP BY status`,
          )
          .join(' UNION ALL ');
        try {
          const r = await sql.unsafe(
            `SELECT status, sum(n)::int AS n FROM (${sqlText}) t GROUP BY status`,
          );
          const tally = tallyDirectiveStatuses(r as any[]);
          directiveOpen += tally.open;
          directiveAcked += tally.acknowledged;
        } catch (e) {
          console.error('[all-kpis] directive status tally failed:', e);
          partialFailures.push('directives');
        }
      }
    }

    const parents = await routeWithWorkspace(async (tx) => {
      return await tx<{ slug: string; children: number }[]>`
        SELECT parent_slug AS slug, count(*)::int AS children
          FROM harness_shared.projects
         WHERE parent_slug IS NOT NULL
         GROUP BY parent_slug
         ORDER BY children DESC
      `;
    });
    const parentsDetail = parents.map((p) => ({
      slug: p.slug,
      children_count: p.children,
    }));

    let autoloopActive = 0;
    let lastFires: { harness_slug: string; role: string; last_fired_at: string; last_status: string | null; consecutive_errors: number }[] = [];
    try {
      const a = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM information_schema.tables
                      WHERE table_schema = 'harness_shared' AND table_name = 'autoloop_state') AS exists
      `;
      if (a[0]?.exists) {
        const rows = await sql<any[]>`
          SELECT harness_slug, role,
                 to_char(last_fired_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS last_fired_at,
                 last_status, consecutive_errors
          FROM harness_shared.autoloop_state
          ORDER BY last_fired_at DESC
          LIMIT 20
        `;
        lastFires = rows;
        autoloopActive = countActiveAutoloops(rows);
      }
    } catch (e) {
      console.error('[all-kpis] autoloop_state query failed:', e);
      partialFailures.push('autoloop');
    }

    const body = {
      totals: {
        harnesses: schemas.length,
        projects: projectsTotal,
        projects_by_status: projectsByStatus,
        messages_24h: messages24h,
        executed_actions_24h: executedActions24h,
      },
      parents: parentsDetail,
      directives: { open: directiveOpen, acknowledged: directiveAcked },
      audit: { actions_24h_by_op: opCounts24h },
      autoloop: { active: autoloopActive, recent_fires: lastFires },
      // Always present (possibly empty) — a stable shape the client can check
      // unconditionally rather than treating "field absent" as "no failures".
      partial_failures: partialFailures,
      system: {
        // Host uptime in seconds (node:os.uptime()), NOT the operator
        // process's own uptime — the card reads as "how long has this
        // machine been up", which is what an operator/ops dashboard cares
        // about. Client computes a live-ticking duration from this + the
        // fetch timestamp rather than re-polling for a moving number.
        uptime_seconds: Math.floor(os.uptime()),
      },
    };
    return body;
}

export default defineTool({
  method: 'GET',
  path: '/harness/all/kpis',
  auth: 'public',
  async handler() {
    const body = await loadAllKpis();
    return new Response(JSON.stringify(body), {
      headers: {
        'content-type': 'application/json',
        'Cache-Control': 'private, max-age=10',
      },
    });
  },
});
