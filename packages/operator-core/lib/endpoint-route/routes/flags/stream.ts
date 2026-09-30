/**
 * GET /api/flags/stream → text/event-stream
 *
 * SSE: `flag_changed` events broadcast from the in-process flag bus,
 * with Last-Event-ID resume support.
 *
 * Ported from app/api/flags/stream/route.ts. `auth: 'public'`.
 */
import { bridgeChannel, parseLastEventId, sseResponse } from '@papercusp/sse';

import { getFlagBus, type FlagChangeEnvelope } from '../../../flag-bus';
import { defineTool } from '@papercusp/agent-mcp';

type FlagStreamVocabulary = {
  flag_changed: FlagChangeEnvelope;
};

export default defineTool({
  method: 'GET',
  path: '/flags/stream',
  auth: 'public',
  // Long-lived SSE — exempt from the route-stack watchdog (EI-110: the 30s
  // default 408'd healthy streams).
  timeoutSec: null,
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  handler(req) {
    const lastEventId = parseLastEventId(req);
    const bus = getFlagBus();
    return sseResponse<FlagStreamVocabulary>({
      signal: req.signal,
      lastEventId,
      // P-008 (agent-tool-delta-protocol): if a reconnecting client's Last-Event-ID
      // fell below the bus ring floor (>64 flag changes evicted) or is past the max
      // (process restart → id reset), it can't resume from replay — emit the
      // standardized `resync` so it refetches the full flag set. Flags have a
      // full-refetch sync path, so the fallback is safe.
      resumeBounds: () => {
        const r = bus.recent;
        return r.length ? { floorId: r[0].id, maxId: r[r.length - 1].id } : null;
      },
      replay: () =>
        bus.recentSince(lastEventId ?? null).map(({ id, event }) => ({
          name: 'flag_changed',
          data: event,
          id,
        })),
      setup: async (sink) => {
        await bridgeChannel(bus.subscribe(), sink, ({ id, event }) => ({
          name: 'flag_changed',
          data: event,
          opts: { id },
        }));
      },
    });
  },
});
