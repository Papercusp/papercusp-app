/**
 * GET /api/agent-mcp/operator-budget — cap + today's spend.
 * PUT /api/agent-mcp/operator-budget — set cap.
 * Ported from app/api/agent-mcp/operator-budget/route.ts. `auth: 'public'`.
 */
import { checkBudget, setBudget } from '../../../operator-budget';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-budget',
  auth: 'public',
  async handler() {
    const c = await checkBudget();
    return Response.json({
      configured: !!c.state,
      dailyCapUsd: c.capUsd,
      todaySpendUsd: c.todaySpendUsd,
      exceeded: c.exceeded,
      spendHistory: c.state?.spend ?? [],
    });
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/agent-mcp/operator-budget',
  auth: 'loopback',
  async handler(req) {
    let body: { dailyCapUsd?: unknown } = {};
    try {
      body = (await req.json()) as { dailyCapUsd?: unknown };
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }
    const cap = Number(body.dailyCapUsd);
    if (!Number.isFinite(cap) || cap <= 0) {
      return new Response('dailyCapUsd must be a positive number', { status: 400 });
    }
    const next = await setBudget(cap);
    return Response.json({ ok: true, dailyCapUsd: next.dailyCapUsd });
  },
});

export default [get, put];
