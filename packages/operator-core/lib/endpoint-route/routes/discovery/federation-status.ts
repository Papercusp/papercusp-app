/**
 * GET /api/discovery/federation-status → { ok, substrate, hives }
 *
 * Brief M / G-004 — the desktop's first LIVE federation status read. Before this
 * the desktop had member counts (registry), "N/M set up" (local hasState), and a
 * declared-visibility badge, but NO surface for "is my hive reaching peers / is my
 * substrate live" — so a user who published to 0 peers (the G-001 stranded-publish
 * case) or whose substrate is degraded had no corrective in-app signal (findings-G
 * G-004: a gap, not a lie). This read closes the gap with the signals that are
 * HONEST and available today; the UI (PotFederationStatus) labels each precisely.
 *
 * The composition lives in `build-federation-status.ts` (buildFederationStatus) so
 * this loopback GET AND the `network.federationStatus` sync resolver serve the
 * IDENTICAL payload — one composition, no drift (data-sync-push-completion P-009;
 * the same split as buildNetworkBoard behind network.board + `network:board`). The
 * full honesty contract lives on that builder.
 *
 * `auth: 'loopback'` — same perimeter as /api/discovery/pots: the cookie-less
 * desktop webview over the loopback bind. Read-only; lists nothing private.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { buildFederationStatus } from './build-federation-status';

export default defineTool({
  method: 'GET',
  path: '/discovery/federation-status',
  auth: 'loopback',
  async handler() {
    return Response.json(await buildFederationStatus());
  },
});
