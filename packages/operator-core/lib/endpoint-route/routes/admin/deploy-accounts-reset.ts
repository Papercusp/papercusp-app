/**
 * POST /api/admin/deploy-accounts/reset-rate — clear an account's PROJECTED
 * rate-limit penalty state (pause / penaltyCount / rolling window) back to fresh.
 * The Accounts tab's per-account Reset button (accounts-pool-tab-2026-06-15 P-001).
 * Body: { id }. Mirrors the `accounts:reset-rate` MCP tool (recordAccountReset);
 * does NOT touch live governor buckets (they self-expire) or the credential.
 */
import { getAccount, recordAccountReset } from '../../../deployment/account-pool';
import { loadAccountPool, updateAccountPool } from '../../../deployment/account-pool-store';
import { notifySyncInvalidate } from '../../../sync-sse';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/deploy-accounts/reset-rate',
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
    const id = String(body.id);
    if (!getAccount(await loadAccountPool(), id)) {
      return Response.json({ ok: false, error: 'unknown_account', id }, { status: 404 });
    }
    // Atomic RMW (WI-38164): this button used to write back the whole pool document it
    // had just read, so a Reset click could resurrect accounts removed since the read
    // and erase accounts registered since it.
    const next = await updateAccountPool((pool) => recordAccountReset(pool, id));
    // Live UI reflection — the Accounts tab reads the accounts.pool sync query.
    void notifySyncInvalidate('accounts.pool', {}).catch(() => {});
    return Response.json({ ok: true, account: getAccount(next, id) });
  },
});
