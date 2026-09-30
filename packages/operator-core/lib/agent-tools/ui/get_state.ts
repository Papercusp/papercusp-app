/**
 * ui:get_state — read the current URL + parsed nuqs params for a
 * browser tab.
 *
 * Defaults `client_id` to `ctx.uiClientId` so an in-chat agent can
 * call this with no arguments and see exactly what the user is
 * looking at.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { uiCrossWorkspaceBlock } from './_workspace-guard';

function parseUrl(raw: string): { pathname: string; params: Record<string, string>; hash: string | null } {
  try {
    const u = new URL(raw);
    const params: Record<string, string> = {};
    for (const [k, v] of u.searchParams.entries()) params[k] = v;
    return { pathname: u.pathname, params, hash: u.hash || null };
  } catch {
    return { pathname: raw, params: {}, hash: null };
  }
}

export default defineTool({
  name: 'ui:get_state',
  description:
    'Read the URL state of a browser tab (defaults to the tab that spawned the agent via ctx.uiClientId). Returns { url, pathname, params, title, last_seen_at }. Use to answer "what is the user looking at?" — nuqs serializes panel/tab/filter/selection state to the URL, so the params object reflects most UI state.',
  capability: 'ui:read',
  guidance: {
    when: 'User asks "what am I looking at?", "what page am I on?", or you need to verify a panel state before acting ("is the panel already open?").',
    notWhen: 'Tool calls ARE idempotent — `panel_open` when already open is fine. Don\'t pre-check just to skip a call; the persona rule is "always call". Use `ui:get_state` only when you need to BRANCH on what the user is looking at.',
    seeAlso: [
      'ui:dispatch (act on the UI)',
      'ui:list_clients (which tabs are open)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    /** Defaults to ctx.uiClientId. Required if the agent wasn't spawned from a tab. */
    client_id: z.string().optional(),
  }),
  async handler(args, ctx) {
    const clientId = args.client_id ?? ctx.uiClientId ?? null;
    if (!clientId) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: 'client_id_required: no client_id passed and ctx.uiClientId is unset (the agent was not spawned from a browser tab). Call ui:list_clients to pick a tab.',
        }],
      };
    }
    // F-M7: refuse to read a UI client owned by another workspace (flag-gated).
    const block = await uiCrossWorkspaceBlock(clientId);
    if (block) {
      return { isError: true, content: [{ type: 'text', text: block }] };
    }
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ url: string; title: string | null; workspace_id: string | null; last_seen_at: Date | string; opened_at: Date | string }>>`
      SELECT url, title, workspace_id, last_seen_at, opened_at
      FROM harness_shared.ui_clients
      WHERE client_id = ${clientId}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `client_not_found: no ui_clients row for client_id="${clientId}". The tab may have closed or never registered.`,
        }],
      };
    }
    const r = rows[0]!;
    const parsed = parseUrl(r.url);
    const lastSeen = new Date(r.last_seen_at);
    const openedAt = new Date(r.opened_at);
    const ageSec = Math.floor((Date.now() - lastSeen.getTime()) / 1000);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          client_id: clientId,
          workspace_id: r.workspace_id,
          url: r.url,
          pathname: parsed.pathname,
          params: parsed.params,
          hash: parsed.hash,
          title: r.title,
          opened_at: openedAt.toISOString(),
          last_seen_at: lastSeen.toISOString(),
          age_seconds: ageSec,
          stale: ageSec > 60,
        }),
      }],
    };
  },
});
