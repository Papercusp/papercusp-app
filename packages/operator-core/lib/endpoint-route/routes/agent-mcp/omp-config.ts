/**
 * GET  /api/agent-mcp/omp-config — full settings tree.
 * POST /api/agent-mcp/omp-config — { key, value } or { key, unset: true }.
 * Ported from app/api/agent-mcp/omp-config/route.ts. `auth: 'public'`.
 */
import { readOmpConfig, setOmpConfig, unsetOmpConfig } from '../../../omp-config';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/omp-config',
  auth: 'public',
  async handler() {
    try {
      const sections = await readOmpConfig();
      return Response.json({ ok: true, sections });
    } catch (err) {
      return Response.json(
        { ok: false, error: (err as Error).message ?? 'omp config list failed' },
        { status: 500 },
      );
    }
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/omp-config',
  auth: 'loopback',
  async handler(req) {
    let body: { key?: unknown; value?: unknown; unset?: unknown } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty */ }
    const key = typeof body.key === 'string' ? body.key : '';
    if (!key) return Response.json({ ok: false, error: 'key required' }, { status: 400 });
    try {
      if (body.unset === true) {
        await unsetOmpConfig(key);
        return Response.json({ ok: true, unset: true });
      }
      const result = await setOmpConfig(key, body.value);
      return Response.json({ ok: true, raw: result.raw });
    } catch (err) {
      return Response.json(
        { ok: false, error: (err as Error).message ?? 'omp config set failed' },
        { status: 500 },
      );
    }
  },
});

export default [get, post];
