/**
 * GET /api/marketplace/spawnable
 *
 * Returns the catalog filtered to entries declaring
 * `spawnable: { kind, requires }` in their manifest. Consumed by the
 * executor's scaffold_harness verb + prompt-build's "Available
 * templates" section.
 *
 * UNGATED (revive-cupboard-distribution D-004): the legacy `FLAGS.MARKETPLACE`
 * is retired with the `/marketplace` UI; this stays as an internal
 * scaffold-support endpoint (bundled catalog + local harness `spawnable`
 * manifests, no `:3057`).
 *
 * Ported from app/api/marketplace/spawnable/route.ts. `auth: 'public'`.
 */
import { getSpawnableTemplates } from '../../../spawnable-templates';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/marketplace/spawnable',
  auth: 'public',
  async handler() {
    const result = await getSpawnableTemplates();
    return Response.json(result);
  },
});
