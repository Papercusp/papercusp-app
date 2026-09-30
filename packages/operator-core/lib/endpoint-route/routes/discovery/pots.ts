/**
 * GET /api/discovery/pots → { count, rows: DiscoveredHiveRow[] }
 *
 * The HTTP projection of the P2P hive directory for the desktop webview's
 * HiveDirectoryPanel (p2p-hive-directory-2026-06-06 P-007). Mirrors the
 * `discovery:pots` MCP tool (P-005) — same verified, un-muted discovered set —
 * but as a cookie-less loopback GET the panel can fetch directly.
 *
 * `auth: 'loopback'` (auth-tier Wave 1) with an in-handler loopback assertion, exactly like
 * /api/deploy/frames: the desktop webview is cookie-less (the loopback bind is
 * the perimeter), and the discovered set is best-effort gossip (D-002 — listing
 * grants nothing; joining runs the full admission flow).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { buildHiveDirectoryRows } from '../../../discovery-hive-rows';
import { trackDetached } from '../../../detached-imports';

export default defineTool({
  method: 'GET',
  path: '/discovery/pots',
  auth: 'loopback',
  async handler(req) {
    // Lazy-wire the directory (fire-and-forget): a box that gh-authenticated
    // after boot starts listening on the directory topic from the first browse,
    // instead of staying dead until restart. Instant no-op when already wired.
    void trackDetached(import('../../../hive-directory-boot'))
      .then(({ ensureHiveDirectoryWired }) =>
        import('../../../workspace-registry').then(({ activeWorkspaceId }) =>
          ensureHiveDirectoryWired(activeWorkspaceId()),
        ),
      )
      .catch(() => {});
    const url = new URL(req.url);
    const includeExpired = url.searchParams.get('includeExpired') === 'true';
    const rows = await buildHiveDirectoryRows({ includeExpired });
    return Response.json({ count: rows.length, rows });
  },
});
