/**
 * /api/activity/* — the push side of the cross-CLI worker activity bridge
 * (papercusp-worker-integration-2026-06-04, D-003).
 *
 * The per-CLI hooks WRITE activity via the `activity:report` MCP tool; these routes
 * are the live READ seam the pui fleet-status view rides. The pull-side reader is the
 * `activity:recent` MCP tool. `auth: 'public'` mirrors the sibling /api/tui/* +
 * /api/coord/* routes (loopback-protected by the host bind).
 *
 *   GET /api/activity/stream?owner=&harness=&since_id=   SSE of new activity rows
 */
import stream from './stream';

export default [stream];
