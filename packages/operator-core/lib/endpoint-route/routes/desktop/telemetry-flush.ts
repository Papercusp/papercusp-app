/**
 * POST /api/desktop/telemetry-flush — flush buffered telemetry now.
 *
 * Ported from app/api/desktop/telemetry-flush/route.ts. `auth: {}`.
 */
import { flushTelemetry } from '../../../telemetry-flush';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/desktop/telemetry-flush',
  auth: {},
  async handler() {
    try {
      const result = await flushTelemetry();
      return Response.json(result);
    } catch (e: any) {
      return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
    }
  },
});
