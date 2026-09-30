/**
 * GET/PUT /api/agent-mcp/operator-tts-spend — TTS spend state + knobs.
 * Ported from app/api/agent-mcp/operator-tts-spend/route.ts. `auth: 'public'`.
 */
import { loadSpend, saveSpend } from '../../../tts-spend';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-tts-spend',
  auth: 'public',
  async handler() {
    return Response.json(await loadSpend());
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/agent-mcp/operator-tts-spend',
  auth: 'loopback',
  async handler(req) {
    let body: { perKCharRate?: number; softCapUsd?: number; hardCapUsd?: number } = {};
    try {
      body = await req.json();
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }
    const cur = await loadSpend();
    const next = { ...cur };
    if (typeof body.perKCharRate === 'number' && body.perKCharRate >= 0) {
      next.perKCharRate = body.perKCharRate;
      if (next.spend[0]) {
        next.spend[0].estimatedUsd = (next.spend[0].chars / 1000) * next.perKCharRate;
      }
    }
    if (typeof body.softCapUsd === 'number' && body.softCapUsd >= 0) next.softCapUsd = body.softCapUsd;
    if (typeof body.hardCapUsd === 'number' && body.hardCapUsd >= 0) next.hardCapUsd = body.hardCapUsd;
    await saveSpend(next);
    return Response.json(next);
  },
});

export default [get, put];
