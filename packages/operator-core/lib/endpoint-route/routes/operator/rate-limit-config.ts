/**
 * GET/PUT /api/operator/rate-limit-config — the live fleet rate-limit knobs
 * (rate-limit-layer-v2 D-004): `maxSimultaneousAgents` + `concurrencyFloor`.
 *
 * GET additionally returns the assembled fleet status (`buildFleetRateStatus`) so the
 * top-bar `<FleetRateControl>` reads config + live cap/eff/in-flight + usage in one
 * round-trip. PUT validates 1..RATE_LIMIT_SANITY_BOUND (P-009 retired the baked 64 ceiling — an
 * explicit user value is deliberate intent, so only absurd input is refused), persists to PG (migration 161),
 * and propagates LIVE via the in-process bus (governor gate + dispatcher honor it with
 * zero restart). `auth: 'loopback'` (auth-tier Wave 1) (loopback-gated like the sibling operator routes).
 */
import { defineTool } from '@papercusp/agent-mcp';
import {
  RATE_LIMIT_SANITY_BOUND,
  readRateLimitConfig,
  writeRateLimitConfig,
} from '../../../rate-limit-config';
import { buildFleetRateStatus } from '../../../fleet-rate-status';

const get = defineTool({
  method: 'GET',
  path: '/operator/rate-limit-config',
  auth: 'loopback',
  async handler(req) {
    const [config, status] = await Promise.all([readRateLimitConfig(), buildFleetRateStatus()]);
    return Response.json({ config, status });
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/operator/rate-limit-config',
  auth: 'loopback',
  async handler(req) {
    let body: { maxSimultaneousAgents?: unknown; concurrencyFloor?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400 });
    }
    const validInt = (v: unknown): v is number =>
      typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= RATE_LIMIT_SANITY_BOUND;
    if (body.maxSimultaneousAgents === undefined && body.concurrencyFloor === undefined) {
      return Response.json({ error: 'maxSimultaneousAgents and/or concurrencyFloor required' }, { status: 400 });
    }
    if (body.maxSimultaneousAgents !== undefined && !validInt(body.maxSimultaneousAgents)) {
      return Response.json({ error: `maxSimultaneousAgents must be an integer 1..${RATE_LIMIT_SANITY_BOUND}` }, { status: 400 });
    }
    if (body.concurrencyFloor !== undefined && !validInt(body.concurrencyFloor)) {
      return Response.json({ error: `concurrencyFloor must be an integer 1..${RATE_LIMIT_SANITY_BOUND}` }, { status: 400 });
    }
    const current = await readRateLimitConfig();
    const config = await writeRateLimitConfig({
      maxSimultaneousAgents: (body.maxSimultaneousAgents as number | undefined) ?? current.maxSimultaneousAgents,
      concurrencyFloor: (body.concurrencyFloor as number | undefined) ?? current.concurrencyFloor,
    });
    return Response.json({ ok: true, config });
  },
});

export default [get, put];
