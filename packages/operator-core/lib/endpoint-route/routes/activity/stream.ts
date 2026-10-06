/**
 * GET /api/activity/stream?owner=&harness=&since_id= — SSE stream of cross-CLI
 * worker activity (papercusp-worker-integration-2026-06-04, D-003).
 *
 * The push side of the activity bridge: the per-CLI hooks write
 * harness_shared.agent_activity (via activity:report), migration 143 fires
 * NOTIFY agent_activity, and this route — riding the `agent-activity-bus` LISTEN —
 * pushes each new row to the subscriber (the pui fleet-status view). No polling:
 * the bus wakes the route, which drains new rows since its cursor.
 *
 * Filters: `owner` (one worker's pane) and `harness` (one project). `since_id`
 * starts the cursor at a known point (replay catch-up); default = only rows that
 * arrive AFTER connect (the consumer seeds history via activity:recent). When a
 * notification's owner_id doesn't match the `owner` filter we skip the query
 * entirely (cheap fan-out).
 *
 * `auth: 'public'` mirrors the sibling /api/tui/* + /api/coord/* routes —
 * loopback-protected by the host bind.
 */
import type { Sql } from 'postgres';
import { sseResponse } from '@papercusp/sse';
import { getOrgPg } from '@papercusp/db-org';
import { isLoopbackRequest } from '../../../superuser-token';
import { onAgentActivity } from '../../../agent-activity-bus';
import { defineTool } from '@papercusp/agent-mcp';

export interface Row {
  id: string;
  owner_id: string;
  agent: string | null;
  session_id: string | null;
  harness_slug: string | null;
  kind: string;
  tool_name: string | null;
  phase: string | null;
  tool_use_id: string | null;
  summary: string | null;
  status: string | null;
  detail: unknown;
  cwd: string | null;
  created_at: string;
}

type Events = { activity: Row };

const DRAIN_LIMIT = 200;

/**
 * One drain page: rows after `cursor`, oldest first, at most `limit`. The caller
 * advances its cursor to the largest id on the page, so the page must be the
 * NUMERICALLY smallest ids after the cursor.
 */
export function queryActivitySince(
  sql: Sql,
  opts: { cursor: number; owner: string | null; harness: string | null; limit: number },
): Promise<Row[]> {
  return sql<Row[]>`
    SELECT id::text AS id, owner_id, agent, session_id, harness_slug, kind, tool_name,
           phase, tool_use_id, summary, status, detail, cwd, created_at
    FROM harness_shared.agent_activity
    WHERE id > ${opts.cursor}
      AND (${opts.owner}::text IS NULL OR owner_id = ${opts.owner})
      AND (${opts.harness}::text IS NULL OR harness_slug = ${opts.harness})
    -- id::bigint, never a bare ORDER BY id: that binds to the "id::text AS id" output
    -- alias and sorts as text ('10' < '8'), so the page-max cursor skipped rows (WI-10004608).
    ORDER BY id::bigint ASC
    LIMIT ${opts.limit}
  `;
}

export default defineTool({
  method: 'GET',
  path: '/activity/stream',
  auth: 'public',
  sampleRate: 0,
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ error: 'loopback_required' }, { status: 403 });
    }
    const url = new URL(req.url);
    const owner = (url.searchParams.get('owner') ?? '').trim() || null;
    const harness = (url.searchParams.get('harness') ?? '').trim() || null;
    const sinceParam = url.searchParams.get('since_id');

    const { sql } = getOrgPg();

    return sseResponse<Events>({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      setup: (sink) => {
        // Cursor: an explicit since_id (replay) or "now" (only new activity).
        let cursor = sinceParam != null && sinceParam !== '' ? Number(sinceParam) || 0 : -1;
        let draining = false;
        let dirty = false;
        let unsubscribe: (() => void) | null = null;

        const queryNew = (): Promise<Row[]> =>
          queryActivitySince(sql, { cursor, owner, harness, limit: DRAIN_LIMIT });

        const drain = async (): Promise<void> => {
          if (sink.closed) return;
          if (draining) { dirty = true; return; }
          draining = true;
          try {
            do {
              dirty = false;
              const rows = await queryNew();
              for (const row of rows) {
                if (sink.closed) return;
                sink.event('activity', row);
                const rid = Number(row.id);
                if (rid > cursor) cursor = rid;
              }
              // A full page means there may be more — keep draining.
              if (rows.length === DRAIN_LIMIT) dirty = true;
            } while (dirty && !sink.closed);
          } catch (e) {
             
            console.warn('[activity-stream] drain error', e);
          } finally {
            draining = false;
          }
        };

        const init = async () => {
          // Seed the cursor at the current max when no explicit since_id, so we only
          // push activity that arrives AFTER connect (history comes from activity:recent).
          if (cursor < 0) {
            try {
              const rows = await sql<{ max_id: string | null }[]>`SELECT COALESCE(MAX(id), 0)::text AS max_id FROM harness_shared.agent_activity`;
              cursor = Number(rows[0]?.max_id ?? 0) || 0;
            } catch {
              cursor = 0;
            }
          }
          // Subscribe AFTER the cursor is set; a notify whose owner doesn't match the
          // filter skips the query (cheap fan-out).
          unsubscribe = onAgentActivity((notifiedOwner) => {
            if (owner && notifiedOwner && notifiedOwner !== owner) return;
            void drain();
          });
          // Catch any rows inserted between cursor-init and subscribe.
          await drain();
        };

        void init();
        sink.onClose(() => {
          if (unsubscribe) unsubscribe();
        });
      },
    });
  },
});
