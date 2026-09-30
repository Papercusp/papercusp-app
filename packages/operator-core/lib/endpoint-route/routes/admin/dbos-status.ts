import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';

/**
 * Admin DBOS status — read-only view over the DBOS Transact system schema
 * (`dbos.*`) for the /admin DBOS tab (dbos-durable-jobs-2026-05-31, P-007).
 *
 * A local PG query, NOT DBOS Conductor (the plan forbids the cloud dashboard,
 * which would reintroduce the external dependency this whole effort avoids).
 * The `dbos` schema only exists once DBOS has launched (PAPERCUSP_DBOS_ENABLE),
 * so the handler returns `{ enabled: false }` gracefully when it's absent
 * rather than 500-ing.
 */
export default defineTool({
  method: 'GET',
  path: '/admin/dbos/status',
  // unverified-loopback: cookie-less desktop webview (EI-338) — the packaged
  // desktop app's DbosClient pane bare-fetches this route from localhost with
  // no session cookie, so it only ever resolves 'unverified-loopback' trust.
  // Read-only (EI-18834967602055309).
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req): Promise<Response> {
    const url = new URL(req.url);
    const statusFilter = url.searchParams.get('status');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    const { sql } = getOrgPg();

    const present = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'dbos'
      ) AS exists`;
    if (!present[0]?.exists) {
      return Response.json({ enabled: false, counts: [], workflows: [], queues: [] });
    }

    const counts = await sql<{ status: string; n: number }[]>`
      SELECT status, count(*)::int AS n
        FROM dbos.workflow_status
       GROUP BY status ORDER BY n DESC`;

    const workflows = await sql<{
      workflow_uuid: string;
      name: string;
      status: string;
      queue_name: string | null;
      application_version: string | null;
      recovery_attempts: string;
      deduplication_id: string | null;
      created_at: string;
      updated_at: string;
      error: string;
    }[]>`
      SELECT workflow_uuid, name, status, queue_name, application_version,
             recovery_attempts, deduplication_id, created_at, updated_at,
             left(coalesce(error, ''), 300) AS error
        FROM dbos.workflow_status
       WHERE ${statusFilter ? sql`status = ${statusFilter}` : sql`true`}
       ORDER BY created_at DESC LIMIT ${limit}`;

    const queues = await sql<{ queue_name: string; depth: number; active: number }[]>`
      SELECT queue_name,
             count(*)::int AS depth,
             count(*) FILTER (
               WHERE started_at_epoch_ms IS NOT NULL
                 AND completed_at_epoch_ms IS NULL
             )::int AS active
        FROM dbos.workflow_queue
       GROUP BY queue_name ORDER BY depth DESC`;

    return Response.json({ enabled: true, counts, workflows, queues });
  },
});
