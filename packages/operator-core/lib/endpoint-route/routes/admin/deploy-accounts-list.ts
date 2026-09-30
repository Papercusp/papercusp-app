/**
 * GET /api/admin/deploy-accounts — list the deploy-account pool with each account's rate headroom.
 * The "Deploy Accounts" admin UI reads this to render the table. (account-pool / cloud-deployment-layer.)
 */
import { accountStatus } from '../../../deployment/account-pool-store';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/admin/deploy-accounts',
  // unverified-loopback: cookie-less desktop webview (EI-338) — see credentials/index.ts.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler() {
    try {
      return Response.json({ ok: true, accounts: await accountStatus() });
    } catch (err) {
      return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
    }
  },
});
