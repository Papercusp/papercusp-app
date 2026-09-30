/**
 * POST /api/admin/spawn-signing/rotate — coarse revocation: rotate the
 * spawn-URL signing key + bump the in-process cache.
 *
 * Ported from app/api/admin/spawn-signing/rotate/route.ts.
 * `auth: { trust: ['trusted'] }`.
 */
import { rotateSpawnSigningKey } from '../../../spawn-signing';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/spawn-signing/rotate',
  auth: { trust: ['trusted'] },
  async handler() {
    try {
      // WI-3190: the report enumerates the spawns THIS operator just invalidated,
      // so whoever triggers a rotate SEES the blast radius (who must be re-spawned)
      // instead of the rotate being a silent revocation.
      const blastRadius = await rotateSpawnSigningKey({ remediate: true });
      return Response.json({ ok: true, rotatedAt: blastRadius.rotatedAt, blastRadius });
    } catch (err) {
      return Response.json(
        { error: 'rotate_failed', detail: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  },
});
