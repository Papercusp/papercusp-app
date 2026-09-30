/**
 * ui:list_clients — list browser tabs that are currently open and
 * have heart-beat presence within the last `since_seconds`.
 *
 * Companion to `ui:get_state` and `ui:dispatch`. When an agent has
 * been spawned from a tab (chat surfaces), `ctx.uiClientId` already
 * names that tab — so the agent rarely needs this tool. It's useful
 * for operator-shell-style usage and for cross-tab actions.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';

export default defineTool({
  name: 'ui:list_clients',
  description:
    'List open browser tabs (UI clients) with active presence. Each entry is { client_id, workspace_id, url, title, last_seen_at, opened_at, is_self }. is_self=true when the client matches ctx.uiClientId (i.e., the tab that spawned the agent).',
  capability: 'ui:read',
  guidance: {
    when: 'You need to know which browser tab(s) the user has open before calling `ui:dispatch`. Returns client ids the operator can target.',
    notWhen:
      "In the operator-converse path, ctx.uiClientId is already populated — you can target the user's current tab directly via `ui:dispatch`. Only list when you need to choose between multiple tabs.",
    chaining: 'Pair with `ui:get_state` to see what each tab is on, then `ui:dispatch` to act.',
    seeAlso: ['ui:get_state (what each tab is on)', 'ui:dispatch (act on a chosen tab)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    /** Filter by workspace id. Omit to get all visible clients. */
    workspace: z.string().optional(),
    /** Max staleness; default 60 seconds. */
    since_seconds: z.number().int().positive().max(3600).optional(),
    /** Limit; default 50. */
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args, ctx) {
    const { sql } = getOrgPg();
    const sinceSec = args.since_seconds ?? 60;
    const limit = args.limit ?? 50;
    const ws = args.workspace ?? null;
    const workspacePredicate = ws === null ? true : sql`workspace_id = ${ws}`;
    const rows = await sql<
      Array<{
        client_id: string;
        workspace_id: string | null;
        url: string;
        title: string | null;
        opened_at: Date | string;
        last_seen_at: Date | string;
      }>
    >`
      SELECT client_id, workspace_id, url, title, opened_at, last_seen_at
      FROM harness_shared.ui_clients
      WHERE last_seen_at > now() - (${sinceSec}::int * interval '1 second')
        AND ${workspacePredicate}
      ORDER BY last_seen_at DESC
      LIMIT ${limit}
    `;
    const selfId = ctx.uiClientId ?? null;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            self_client_id: selfId,
            count: rows.length,
            clients: rows.map((r) => ({
              client_id: r.client_id,
              workspace_id: r.workspace_id,
              url: r.url,
              title: r.title,
              opened_at: new Date(r.opened_at).toISOString(),
              last_seen_at: new Date(r.last_seen_at).toISOString(),
              is_self: r.client_id === selfId,
            })),
          }),
        },
      ],
    };
  },
});
