/**
 * GET /api/provision/state?harness=<h>&plugin=<p>
 *
 * Current provision state for a (harness, plugin) pair — hashes,
 * recorded resources, last setup/verify timestamps, the `setupFailed`
 * banner flag, plus a slice of the audit log.
 *
 * Ported from app/api/provision/state/route.ts. `auth: 'public'`.
 */
import { readState } from '../../../provision/state-store';
import { readAudit } from '../../../provision/audit-log';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/provision/state',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    const url = new URL(req.url);
    const harness = url.searchParams.get('harness') ?? '';
    const plugin = url.searchParams.get('plugin') ?? '';
    const auditLimit = parseInt(url.searchParams.get('auditLimit') ?? '50', 10);
    if (!harness || !plugin) {
      return Response.json({ ok: false, error: 'harness + plugin required' }, { status: 400 });
    }
    const state = await readState(harness, plugin);
    const audit = await readAudit(harness, plugin, { limit: auditLimit });
    return Response.json({ ok: true, state, audit });
  },
});
