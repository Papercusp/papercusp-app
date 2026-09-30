/**
 * POST /api/agent-mcp/provision — provision system:operator + system:oracle principals.
 * Ported from app/api/agent-mcp/provision/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 *
 * The cap lists + provision loop live in `ensure-system-principals.ts` (EI-2048) so this
 * route and the boot-time auto-heal (host-bootstrap) share ONE source of truth — a cap
 * added in one place can't drift from the other.
 */
import { provisionSystemPrincipals } from '../../../ensure-system-principals';
import { papercuspRoot } from '../../../papercusp-root';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/provision',
  auth: 'loopback',
  async handler(req) {
    const { force } = (await req.json().catch(() => ({}))) as { force?: boolean };
    const workspaceId = activeWorkspaceId();
    const provisioned = await provisionSystemPrincipals({
      workspaceId,
      papercuspRoot: papercuspRoot(),
      force,
    });
    return Response.json({ workspaceId, provisioned });
  },
});
