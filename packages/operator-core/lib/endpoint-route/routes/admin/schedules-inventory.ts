import { defineTool } from '@papercusp/agent-mcp';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { collectScheduleInventory, summarizeInventory } from '../../../schedule-inventory';

/**
 * Admin schedule inventory — read-only HTTP view backing the /admin/schedules
 * page (plan schedule-inventory-and-ephemeral-tier-2026-06-26, P-003).
 *
 * Mirrors the /admin/dbos/status endpoint shape: a self-fetching client (the
 * operator-vite route reuses `SchedulesClient`) hits this. Shares the SAME
 * aggregation as the `schedule:inventory` MCP tool (P-002) — collectScheduleInventory().
 * Gated by FLAGS.SCHEDULE_INVENTORY (default ON); returns { enabled: false } when
 * off so the page can render a hint instead of a broken table. Read-only.
 */
export default defineTool({
  method: 'GET',
  path: '/admin/schedules/inventory',
  // unverified-loopback: cookie-less desktop webview (EI-338) — the packaged
  // desktop app's SchedulesClient pane bare-fetches this route from localhost
  // with no session cookie, so it only ever resolves 'unverified-loopback'
  // trust. Read-only (EI-18834967602055309).
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req): Promise<Response> {
    const enabled = await getFlag(FLAGS.SCHEDULE_INVENTORY, 'admin:schedule-inventory').catch(() => true);
    if (!enabled) {
      return Response.json({ enabled: false, summary: { total: 0, bySource: {}, byTier: {} }, rows: [] });
    }
    const url = new URL(req.url);
    const source = url.searchParams.get('source');
    const tier = url.searchParams.get('tier');
    let rows = await collectScheduleInventory();
    if (source) rows = rows.filter((r) => r.source === source);
    if (tier) rows = rows.filter((r) => r.tier === tier);
    return Response.json({ enabled: true, summary: summarizeInventory(rows), rows });
  },
});
