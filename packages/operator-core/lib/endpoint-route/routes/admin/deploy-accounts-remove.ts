/**
 * POST /api/admin/deploy-accounts/remove — drop a deploy account from the pool.
 * Body: { id }. Removes the pool entry; does NOT delete the credential file (a frame may still be
 * bound to it — file GC is a separate concern).
 */
import { removeAccount } from '../../../deployment/account-pool';
import { updateAccountPool } from '../../../deployment/account-pool-store';
import { notifySyncInvalidate } from '../../../sync-sse';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/deploy-accounts/remove',
  // unverified-loopback: cookie-less desktop webview (EI-338) — see credentials/index.ts.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    let body: { id?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    if (!body?.id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });
    await updateAccountPool((p) => removeAccount(p, String(body.id)));
    // Live UI reflection — the Accounts tab reads the accounts.pool sync query.
    void notifySyncInvalidate('accounts.pool', {}).catch(() => {});
    return Response.json({ ok: true, removed: true });
  },
});
