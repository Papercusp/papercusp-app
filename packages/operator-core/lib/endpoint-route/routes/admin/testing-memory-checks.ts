/**
 * GET /api/admin/testing/memory/checks — list the registered memory
 * suite checks with metadata so the MemoryTab UI can render an empty
 * list before a run starts.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { buildMemoryCoreChecks } from '../../../memory/suite/checks';

export default defineTool({
  method: 'GET',
  path: '/admin/testing/memory/checks',
  auth: { trust: ['verified', 'trusted'] },
  handler(): Response {
    const checks = buildMemoryCoreChecks('catalog').map((c) => ({ id: c.id, label: c.label }));
    return Response.json({ checks });
  },
});
