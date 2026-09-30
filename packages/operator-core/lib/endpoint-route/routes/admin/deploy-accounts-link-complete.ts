/**
 * POST /api/admin/deploy-accounts/link-complete — finish the EXPERIMENTAL one-click OAuth
 * account link (accounts-pool-tab-2026-06-15 P-002). Verifies the linkId, exchanges the
 * pasted claude.ai code (Claude) or completed Codex device login → writes the credential bundle
 * server-side (0600) → registerAccount. The TOKEN NEVER appears in the response (only the
 * registered account row). Body: { linkId, code? } → { ok, account } | { ok:false, error }.
 */
import { completeCliLink } from '../../../deployment/account-link-cli';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/deploy-accounts/link-complete',
  // unverified-loopback: cookie-less desktop webview (EI-338) — mirrors /register, /reset-rate.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    let body: { linkId?: string; code?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    if (!body?.linkId) {
      return Response.json({ ok: false, error: 'linkId required' }, { status: 400 });
    }
    const r = await completeCliLink({ linkId: String(body.linkId), code: body.code == null ? undefined : String(body.code) });
    return Response.json(r, { status: r.ok ? 200 : 400 });
  },
});
