/**
 * GET/POST/PUT /api/agent-mcp/operator-stt-spend — STT spend tracker.
 * Ported from app/api/agent-mcp/operator-stt-spend/route.ts. `auth: 'public'`.
 */
import {
  loadSttSpend,
  recordSttSpend,
  saveSttSpend,
  DEFAULT_STT_SPEND_STATE,
  type SttSpendState,
} from '../../../stt-spend';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-stt-spend',
  auth: 'public',
  async handler() {
    return Response.json(await loadSttSpend());
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-stt-spend',
  auth: 'loopback',
  async handler(req) {
    let body: { minutes?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response('bad-json', { status: 400 });
    }
    const m = Number(body.minutes);
    if (!Number.isFinite(m) || m < 0 || m > 60) {
      return new Response('bad-minutes', { status: 400 });
    }
    const update = await recordSttSpend(m);
    return Response.json({
      todayUsd: update.todayUsd,
      fireSoftCap: update.fireSoftCap,
      hardCapTripped: update.hardCapTripped,
    });
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/agent-mcp/operator-stt-spend',
  auth: 'loopback',
  async handler(req) {
    let body: Partial<SttSpendState> = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response('bad-json', { status: 400 });
    }
    const cur = await loadSttSpend();
    const next: SttSpendState = {
      ...DEFAULT_STT_SPEND_STATE,
      ...cur,
      ...body,
      spend: cur.spend,
    };
    await saveSttSpend(next);
    return Response.json(next);
  },
});

export default [get, post, put];
