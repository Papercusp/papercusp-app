/**
 * POST /api/discovery/set-pot — the HTTP face of the hive listing
 * create/edit/visibility-flip (hive-from-github-url P-015). Mirrors the
 * `discovery:set_pot` MCP tool over the SAME `setHiveListing` composition:
 * private = withdraw (stop re-announce + Cupboard unlist); public/invite =
 * the full publish set. This is what the hive header strip's flip control
 * drives.
 *
 * `auth: 'loopback'` (auth-tier Wave 1), exactly like GET /discovery/pots —
 * the desktop webview is cookie-less; the loopback tier is the perimeter.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isHiveVisibility } from '../../../sync/hyperbee/hive-announce';

export default defineTool({
  method: 'POST',
  path: '/discovery/set-pot',
  auth: 'loopback',
  // Cupboard rows / unlist round-trips can exceed the default route budget.
  timeoutSec: 120,
  async handler(req) {
    let body: {
      potId?: string;
      title?: string;
      description?: string;
      visibility?: string;
      inviteSecret?: string;
    } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      /* empty body */
    }
    const potId = String(body.potId ?? '').trim();
    const title = String(body.title ?? '').trim() || potId;
    if (!potId) {
      return Response.json({ error: 'potId required', code: 'invalid_args' }, { status: 400 });
    }
    if (!isHiveVisibility(body.visibility)) {
      return Response.json(
        { error: 'visibility must be public|invite|private', code: 'invalid_args' },
        { status: 400 },
      );
    }
    if (body.visibility === 'invite' && !body.inviteSecret) {
      return Response.json(
        { error: 'invite visibility requires inviteSecret', code: 'invalid_args' },
        { status: 400 },
      );
    }
    const { setHiveListing } = await import('../../../hive-set-listing');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const res = await setHiveListing(
      {
        potId,
        title,
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        visibility: body.visibility,
        ...(body.inviteSecret ? { inviteSecret: body.inviteSecret } : {}),
      },
      activeWorkspaceId(),
    );
    return Response.json(res);
  },
});
