/**
 * POST /api/agent-mcp/console/launch-claim
 * POST /api/agent-mcp/console/launch-result
 *
 * The webview half of the Windows console-launch bridge (WI-3289, see
 * lib/console-launch-bridge.ts for the full design). The desktop webview's
 * DesktopConsoleLaunchBridge component:
 *   1. receives an opaque `console.launch-request` ticket targeted to a UI client,
 *   2. POSTs launch-claim { ticket, clientId } to atomically redeem the envelope,
 *   3. invokes the Tauri `console_launch` command with the claimed envelope,
 *   4. POSTs launch-result { ticket, ok, pid?, error? } which resolves the
 *      operator-side pending promise in requestDesktopConsoleLaunch.
 *
 * auth 'loopback' — same trust boundary as the sibling console/record route:
 * only the desktop shell's same-origin webview (or the owner's own box) can
 * reach the loopback-bound operator.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { claimConsoleLaunch, completeConsoleLaunch } from '../../../console-launch-bridge';

function jsonRes(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const claim = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/launch-claim',
  auth: 'loopback',
  async handler(req) {
    let body: { ticket?: string; clientId?: string } = {};
    try {
      body = JSON.parse(await req.text());
    } catch {
      /* fall through to the validation below */
    }
    if (
      !body.ticket ||
      typeof body.ticket !== 'string' ||
      !body.clientId ||
      typeof body.clientId !== 'string'
    ) {
      return jsonRes({ status: 'error', error: 'ticket + clientId required' }, 400);
    }
    return jsonRes({ status: 'ok', ...claimConsoleLaunch(body.ticket, body.clientId) });
  },
});

const result = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/launch-result',
  auth: 'loopback',
  async handler(req) {
    let body: { ticket?: string; ok?: boolean; pid?: number | null; error?: string | null } = {};
    try {
      body = JSON.parse(await req.text());
    } catch {
      /* fall through to the validation below */
    }
    if (!body.ticket || typeof body.ticket !== 'string' || typeof body.ok !== 'boolean') {
      return jsonRes({ status: 'error', error: 'ticket + ok required' }, 400);
    }
    const known = completeConsoleLaunch(body.ticket, {
      ok: body.ok,
      pid: typeof body.pid === 'number' ? body.pid : null,
      error: typeof body.error === 'string' ? body.error : null,
    });
    return jsonRes({ status: 'ok', known });
  },
});

export default [claim, result];
