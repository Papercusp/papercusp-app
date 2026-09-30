/**
 * POST /api/admin/deploy-accounts/link-start — begin the EXPERIMENTAL one-click OAuth
 * account link (accounts-pool-tab-2026-06-15 P-002). Returns a claude.ai authorize URL
 * + an opaque single-use linkId carrying the PKCE verifier. The SPA surfaces the URL;
 * the owner authorizes in a browser logged into the TARGET Max account, then POSTs
 * /link-complete with { linkId, code }. The PROVEN default is /register (setup-token
 * paste) — this is the beta alternative (claude.ai acceptance owner-verified on wake).
 * Body: { accountId, label?, provider? } → { ok, authorizeUrl, linkId, userCode? } | { ok:false, error }.
 */
import { startCliLink } from '../../../deployment/account-link-cli';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/deploy-accounts/link-start',
  // unverified-loopback: cookie-less desktop webview (EI-338) — mirrors /register, /reset-rate.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    let body: { accountId?: string; label?: string; provider?: 'claude' | 'codex' };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    const r = await startCliLink({ accountId: String(body?.accountId ?? ''), label: body?.label, provider: body?.provider });
    return Response.json(r, { status: r.ok ? 200 : 400 });
  },
});
