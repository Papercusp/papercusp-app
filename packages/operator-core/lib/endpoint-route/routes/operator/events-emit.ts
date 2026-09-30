/**
 * POST /api/operator/events-emit — the HTTP bridge for the oddsmith engine's
 * `events:emit` (UP) leg (oddsmith P-020).
 *
 * The oddsmith trading engine runs as a separate local sidecar process that must
 * stay free of any `@papercusp/*` dependency. It announces its domain events
 * (`forecast.produced` / `fill.happened` / `market.resolved` / `drawdown` /
 * `api.unreachable`) UP to this operator by POSTing here; this route forwards them
 * straight into {@link emitAwaitedEvent} — the SAME internal function the
 * `events:emit` MCP tool calls — so the oddsmith-ops reactive overlay's
 * `DataCondition` ({ event: { equals: '<name>' } }) matches and the subscribed
 * reactive role wakes, identically to a native `events:emit`.
 *
 * CONTRACT (mirrors the oddsmith bridge — `operator-bridge-wiring.ts` `emit` +
 * `engine/src/loop.ts` `EventEmitFn`): the request body is the engine's emit args
 *   { event: string; payload?: unknown; summary?: string; to?: string[] }
 * `event` maps to the await-event `key`; `payload` / `summary` / `to` pass straight
 * through. The emitter `source` is stamped `oddsmith-engine`.
 *
 * ADDITIVE + INERT: nothing POSTs here until the oddsmith bridge is armed (its
 * `ODDSMITH_OPERATOR_URL` env is set in a later step), so mounting this route does
 * not change any running behaviour. DEFENSIVE: a malformed body → 400; any internal
 * error → a swallowed 200 `{ ok: false, dropped: true }` (the engine's emit leg is
 * best-effort and must never be stalled by the operator), so the route can never
 * throw a 5xx into a trading tick.
 *
 * `auth: 'loopback'` — the engine sidecar is a local process; the host's dispatch
 * chokepoint rejects any non-loopback caller. No principal is required (the
 * deterministic engine has no Papercusp identity).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { emitAwaitedEvent } from '../../../events/await/engine';

/** The emit args the oddsmith bridge POSTs (engine `EventEmitFn` arg shape). */
interface EventsEmitBody {
  event: string;
  payload?: unknown;
  summary?: string;
  to?: string[];
}

export default defineTool({
  method: 'POST',
  path: '/operator/events-emit',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => null)) as EventsEmitBody | null;
    if (!body || typeof body.event !== 'string' || body.event.trim().length === 0) {
      return Response.json({ ok: false, error: 'event (non-empty string) required' }, { status: 400 });
    }

    const to = Array.isArray(body.to) ? body.to.filter((t): t is string => typeof t === 'string' && t.length > 0) : undefined;

    try {
      const result = await emitAwaitedEvent({
        key: body.event,
        payload: body.payload,
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        to: to && to.length > 0 ? to : undefined,
        source: 'oddsmith-engine',
      });
      return Response.json({
        ok: true,
        event: result.key,
        woken: result.woken,
        notified: result.notified.length,
      });
    } catch (err) {
      // Best-effort: the engine's emit leg already swallows non-2xx, but never let
      // an internal fault surface as a 5xx into a trading tick — drop it safely.
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, dropped: true, error: message });
    }
  },
});
