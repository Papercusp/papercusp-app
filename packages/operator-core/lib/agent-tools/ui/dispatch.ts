/**
 * ui:dispatch — fire an intent at a browser tab and wait for the
 * result.
 *
 * Flow:
 *   1. INSERT into ui_intents with status='pending'.
 *   2. Long-poll for the row to leave 'pending' (set by the
 *      browser-side dispatcher's POST /api/ui/intents/:id/result).
 *   3. Return result/error to the agent.
 *
 * If the tab doesn't pick up the intent within `timeout_ms` we mark
 * it status='timeout' and return that to the agent. The browser tab
 * will skip stale timeouts because its UPDATE clause requires
 * status='pending'.
 *
 * Built-in intents (always available): set_url, snapshot,
 * read_visible_text, focus, scroll_into_view, click.
 *
 * NOTE: was briefly auto-migrated to drizzle by a phase-3 batch and
 * the generated values-builder broke jsonb encoding for the `args`
 * column. Raw sql shape is correct.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { uiCrossWorkspaceBlock } from './_workspace-guard';
import { hardText, LIMITS } from '../limits';
import { activeWorkspaceId } from '../../workspace-registry';

const POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;

export default defineTool({
  name: 'ui:dispatch',
  description:
    'Dispatch a UI intent to a browser tab and wait for the result. Defaults client_id to ctx.uiClientId (the tab that spawned the agent). Built-in intents: set_url ({path?:"/route", params:{...}} — path switches the route, params merge into the query string), snapshot ({selector?,mode?}), read_visible_text, focus, scroll_into_view, click. Pages can register additional intents via useUiIntent(name, handler).',
  capability: 'ui:dispatch',
  guidance: {
    when: 'You need to make something happen in the user\'s browser tab — open the panel, navigate, focus a card, etc. Side-effect tool: writes a ui_intents row the tab consumes via SSE.',
    notWhen: 'For showing a question + choices in the chat, use `chat:ask_choice` (renders inline buttons). For asking the operator brain to delegate work, use `<spawn>` — `ui:dispatch` is for UI side effects, not work delegation.',
    seeAlso: [
      'ui:get_state (read current UI state before acting)',
      'ui:list_clients (choose which tab to target)',
      'chat:ask_choice (inline question + choices instead of a UI side effect)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    /** Target tab. Defaults to ctx.uiClientId. */
    client_id: z.string().optional(),
    /** Intent name, e.g. "set_url" or a feature-registered name. */
    intent: hardText(LIMITS.SHORT_TITLE),
    /** Args object passed to the intent handler. */
    args: z.record(z.string(), z.unknown()).optional(),
    /** Long-poll budget; default 5000ms, max 60000ms. */
    timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  }),
  async handler(args, ctx) {
    const clientId = args.client_id ?? ctx.uiClientId ?? null;
    if (!clientId) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: 'client_id_required: pass client_id or invoke from a tab-spawned context (ctx.uiClientId).',
        }],
      };
    }
    // F-M7: refuse to dispatch into a UI client owned by another workspace (flag-gated).
    const block = await uiCrossWorkspaceBlock(clientId);
    if (block) {
      return { isError: true, content: [{ type: 'text', text: block }] };
    }
    const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const intentArgs = args.args ?? {};

    const { sql } = getOrgPg();

    const principalSlug = ctx.principal?.slug ?? (ctx.isSuperuser ? 'system:operator' : `agent:${ctx.role ?? 'unknown'}`);
    const argsJson = JSON.stringify(intentArgs);

    const inserted = await sql<Array<{ id: number }>>`
      INSERT INTO harness_shared.ui_intents (client_id, intent, args, requested_by, workspace_id)
      VALUES (${clientId}, ${args.intent}, ${argsJson}::text::jsonb, ${principalSlug}, ${activeWorkspaceId()})
      RETURNING id
    `;
    const id = Number(inserted[0]!.id);

    // P-010 (agent-tool-delta-protocol): wake the /api/ui/intents/stream LISTEN bus
    // so it drains this intent immediately — replaces the route's old 250ms poll.
    // Fires after the INSERT commits; payload is the client_id the stream filters on.
    await sql`SELECT pg_notify('ui_intents', ${clientId})`;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql<Array<{ status: string; result: unknown; error_message: string | null }>>`
        SELECT status, result, error_message
        FROM harness_shared.ui_intents
        WHERE id = ${id}
        LIMIT 1
      `;
      const row = rows[0];
      if (row && row.status !== 'pending') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id,
              status: row.status,
              result: row.result ?? null,
              error: row.error_message ?? null,
            }),
          }],
          isError: row.status === 'error',
        };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    // Timeout: mark the row so the browser tab won't act on it
    // even if it comes back online later.
    await sql`
      UPDATE harness_shared.ui_intents
      SET status = 'timeout', completed_at = now(),
          error_message = 'dispatch_timeout'
      WHERE id = ${id} AND status = 'pending'
    `;
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          id,
          status: 'timeout',
          error: `dispatch_timeout: no response from client_id=${clientId} within ${timeoutMs}ms. The tab may be closed or unresponsive.`,
        }),
      }],
    };
  },
});
