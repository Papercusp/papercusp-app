/**
 * GET /api/admin/inference-gateway/stats — the live rate-headroom + queue view of the hive
 * inference gateway (hive-inference-gateway-2026-06-09 P-014). The gateway runs as its own
 * localhost service; this reads its `/stats` over the loopback hop and returns the normalized
 * read-model the `/admin` surface renders. `reachable:false` (never an error) when it's offline.
 */
import { fetchGatewayHeadroom } from '../../../inference-gateway/observability';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/admin/inference-gateway/stats',
  // unverified-loopback: cookie-less desktop webview (EI-338) — the deploy-accounts
  // pool view reads this for live per-account utilization, same trust posture as the
  // sibling GET /admin/deploy-accounts (which exposes strictly more — credentialRef).
  // This returns only non-secret rate-headroom (utilization %, account id, queue depth).
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler() {
    const headroom = await fetchGatewayHeadroom();
    return Response.json({ ok: true, gateway: headroom });
  },
});
