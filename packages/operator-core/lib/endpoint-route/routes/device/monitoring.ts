/**
 * Device monitoring dashboard — mobile-apps-revival-v2 Phase B.
 *
 *   GET /device/monitoring   device JWT
 *
 * The phone's "worth glancing at" surface: the release-pipeline gate (P-009),
 * live Pots & Fleets (P-008), this device's connection health (P-010), and the
 * derived owner-attention system alerts — red gate / pool-exhaustion (P-007).
 *
 * READ-ONLY by construction (plan guiding principle: the phone monitors, the
 * desktop is where work happens). Every tile is independently fail-soft — a
 * failed producer returns `null` for that tile, never a broken dashboard —
 * so this route offers no execute/approve/claim affordance and cannot mutate
 * fleet or pipeline state.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { monitoringSnapshot } from '../../../device-monitoring';

const monitoring = defineTool({
  method: 'GET',
  path: '/device/monitoring',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    const snapshot = await monitoringSnapshot({
      deviceId: principal.slug,
      workspaceId: principal.workspaceId,
    });
    return Response.json(snapshot);
  },
});

export default [monitoring];
