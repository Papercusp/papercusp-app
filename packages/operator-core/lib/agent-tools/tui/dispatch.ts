/**
 * tui:dispatch — fire an intent at a running `pui` (the terminal workbench) and
 * wait for the result. The TUI analogue of `ui:dispatch`.
 *
 * Flow (mirrors ui:dispatch):
 *   1. INSERT into tui_intents with status='pending'.
 *   2. Long-poll for the row to leave 'pending' (set by the pui-side dispatcher's
 *      POST /api/tui/intents/:id/result).
 *   3. Return result/error to the agent.
 *
 * If the pui instance doesn't pick up the intent within `timeout_ms` we mark it
 * status='timeout' and return that. pui skips stale timeouts because its UPDATE
 * requires status='pending'.
 *
 * Built-in intents pui understands: get_state ({}), set_tab ({tab}),
 * set_harness ({slug}), select ({list, index}), open_chat ({}), focus_pane
 * ({pane_id}). `client_id` is the target pui's workbench owner key
 * ($USER@$HOSTNAME by default; see workbench_owner()).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { hardText, LIMITS } from '../limits';
import { activeWorkspaceId } from '../../workspace-registry';

const POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;

export default defineTool({
  name: 'tui:dispatch',
  description:
    'Dispatch a control intent to a running pui (terminal workbench) and wait for the result. Built-in intents: get_state ({}) → snapshot of the pui AppState (active tab, selections, counts, chat state, live panes); set_tab ({tab:"Operator"|"Plans"|"Sessions"|"Fleet"|…}); set_harness ({slug}); select ({list:"plans"|"roster"|"inbox"|"features"|"issues"|"docs", index}); open_chat ({}) → focus the operator chat pane; focus_pane ({pane_id}) → focus a worker\'s zellij pane (ids from get_state.panes). client_id targets the pui instance (its workbench owner key, $USER@$HOSTNAME by default).',
  capability: 'tui:dispatch',
  guidance: {
    when: 'You need to drive or read a running pui terminal workbench — switch its tab, change its active harness, move a selection, or read its current state. Side-effect tool: writes a tui_intents row the pui consumes over SSE.',
    notWhen: 'For the browser/desktop UI use `ui:dispatch`. For showing a question + choices use `chat:ask_choice`. For delegating work use `<spawn>` — tui:dispatch is UI control, not work delegation. Boundary to know: this tool only reaches a pui attached to THIS same operator/database. A pui launched by the Tauri desktop app is attached to the desktop\'s own embedded operator (a different database) and can never be reached from here — a timeout against it is misleading ("may not be running") even though the pui is alive on-screen; see the tool\'s timeout error for the two-hypothesis explanation.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    /** Target pui instance (its workbench owner key). */
    client_id: z.string().min(1).max(256),
    /** Intent name, e.g. "get_state" or "set_tab". */
    intent: hardText(LIMITS.SHORT_TITLE),
    /** Args object passed to the intent handler. */
    args: z.record(z.string(), z.unknown()).optional(),
    /** Long-poll budget; default 5000ms, max 60000ms. */
    timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  }),
  async handler(args, ctx) {
    const clientId = args.client_id.trim();
    if (!clientId) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'client_id_required: pass the target pui workbench owner key.' }],
      };
    }
    const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const intentArgs = args.args ?? {};

    const { sql } = getOrgPg();

    const principalSlug = ctx.principal?.slug ?? (ctx.isSuperuser ? 'system:operator' : `agent:${ctx.role ?? 'unknown'}`);
    const argsJson = JSON.stringify(intentArgs);

    const inserted = await sql<Array<{ id: number }>>`
      INSERT INTO harness_shared.tui_intents (client_id, intent, args, requested_by, workspace_id)
      VALUES (${clientId}, ${args.intent}, ${argsJson}::text::jsonb, ${principalSlug}, ${activeWorkspaceId()})
      RETURNING id
    `;
    const id = Number(inserted[0]!.id);

    // P-010 (agent-tool-delta-protocol): wake the /api/tui/intents/stream LISTEN bus
    // so it drains this intent immediately — replaces the route's old 250ms poll.
    // Fires after the INSERT commits; payload is the client_id the stream filters on.
    await sql`SELECT pg_notify('tui_intents', ${clientId})`;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql<Array<{ status: string; result: unknown; error_message: string | null }>>`
        SELECT status, result, error_message
        FROM harness_shared.tui_intents
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
    await sql`
      UPDATE harness_shared.tui_intents
      SET status = 'timeout', completed_at = now(), error_message = 'dispatch_timeout'
      WHERE id = ${id} AND status = 'pending'
    `;
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          id,
          status: 'timeout',
          // EI-581: this INSERT always lands in the *native* PG this operator
          // process talks to via getOrgPg(). A pui launched by the Tauri
          // desktop instead connects (OperatorClient::from_discovery(), IPC
          // socket first) to the desktop's OWN embedded operator, which polls
          // this same-named table in ITS embedded DB — a different database
          // than the one this INSERT just hit. So "It may not be running" was
          // the wrong hypothesis to lead with: the far more common cause is a
          // cross-process/cross-DB boundary this operator cannot see across.
          // Name both hypotheses explicitly so the agent doesn't waste a
          // troubleshooting pass assuming the pui is dead.
          error:
            `dispatch_timeout: no response from pui client_id=${clientId} within ${timeoutMs}ms. ` +
            'Two possible causes: (1) no pui is running for this client_id, or (2) a pui IS running ' +
            'but it is attached to a DIFFERENT operator/database than the one this dispatch wrote to ' +
            '(most commonly: your pui was launched by the Tauri desktop app, which talks to its own ' +
            "embedded operator — this tool's dispatch never reaches it, and never will, from this " +
            'process). If the pui is visibly on-screen and still times out, assume (2), not that it crashed.',
        }),
      }],
    };
  },
});
