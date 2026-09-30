/**
 * POST /api/admin/deploy-accounts/link-status — poll a held one-click OAuth link.
 *
 * claude CLI ≥2.1.200 `setup-token` runs a localhost callback listener: when the approving
 * browser is on the SAME machine as the operator, claude.com delivers the code straight to the
 * CLI and the owner sees "You're all set up … close this window" — NO code to paste. The server
 * auto-finalizes (account-link-cli watcher); the Accounts tab polls THIS route while the owner
 * is in the browser so that path lands visibly. Body: { linkId } →
 * { ok, status: 'pending' | 'completed' | 'failed' | 'unknown', account?, error? }.
 */
import { getCliLinkStatus } from '../../../deployment/account-link-cli';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/deploy-accounts/link-status',
  // unverified-loopback: cookie-less desktop webview (EI-338) — mirrors /link-complete.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    let body: { linkId?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    if (!body?.linkId) {
      return Response.json({ ok: false, error: 'linkId required' }, { status: 400 });
    }
    return Response.json({ ok: true, ...getCliLinkStatus(String(body.linkId)) });
  },
});
