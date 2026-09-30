/**
 * GET /api/coord/inbox/sse → text/event-stream
 *
 * Push wake for the human-facing coord inbox (P-002 / tui-workbench D-003b).
 * Rides the `coord_inbox` NOTIFY (migration 126) via `coord-inbox-bus`: the bus
 * peeks each new `coord_event_log` row and signals only when one is
 * human-relevant (a message/handoff addressed to `'human'`, or any escalation —
 * see `isHumanRelevantRow`). On a signal we emit an `invalidate` event
 * `{name:'coord.inbox'}` so a client (the pui TUI) refetches `GET /api/coord/inbox`
 * (the existing human-facing reader) and diffs against what it has seen. No polling.
 *
 * Human-relevance is decided in the bus by `body.to`, NOT by the NOTIFY payload's
 * `writer_key` — for a direct message that key is the SENDER, never `'human'`, so
 * a `writer_key`-based filter would never fire (see coord-inbox-bus.ts).
 *
 * `auth: 'public'` + `sampleRate: 0` mirror the sibling coord read routes +
 * `zero-harness/sse` (pure sync transport, exempt from route-invocation telemetry).
 */
import { sseResponse } from '@papercusp/sse';
import { onCoordInbox } from '../../../coord-inbox-bus';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/coord/inbox/sse',
  auth: 'public',
  // Long-lived SSE — exempt from the route-stack watchdog (EI-110: the 30s
  // default 408'd healthy streams).
  timeoutSec: null,
  sampleRate: 0,
  async handler(req) {
    return sseResponse({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      setup: (sink) => {
        const off = onCoordInbox(() => {
          if (sink.closed) return;
          sink.event('invalidate', { name: 'coord.inbox' });
        });
        sink.onClose(off);
      },
    });
  },
});
