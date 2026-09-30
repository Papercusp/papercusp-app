/**
 * GET /api/harness/:slug/clobber-stream → text/event-stream
 *
 * SSE projector for clobber events fired by the substrate's
 * applyHyperbeeOpToPg (Phase 5b P-035). Each `clobber` emission is
 * forwarded as an SSE `clobber` event with the same payload shape
 * the browser-side ClobberToast consumes.
 *
 * Per-harness filtering note: ClobberEvent today carries only table
 * + hbKey + my/theirs writes — not the source harness slug. The
 * substrate's projection registry is bound per-harness, so a
 * harness-scoped filter at the SSE side would require threading
 * harnessSlug into the event. Out of scope for this commit; this
 * endpoint emits all clobber events globally and trusts the
 * browser-side hbKey filter (per-row) to scope what the user sees.
 * Multi-harness contention is a Phase 11 concern; today the operator
 * boots one harness per process.
 */

import { sseResponse } from '@papercusp/sse';
import { defineTool } from '@papercusp/agent-mcp';
import { clobberEvents, type ClobberEvent } from '../../../sync/hyperbee/clobber-events';

type ClobberStreamVocabulary = {
  clobber: ClobberEvent;
};

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/clobber-stream',
  auth: 'public',
  // Long-lived SSE — exempt from the route-stack watchdog (EI-110: the 30s
  // default 408'd healthy streams).
  timeoutSec: null,
  // SSE — one route-stack run per long-lived connection; per-connect
  // sampling carries no signal.
  sampleRate: 0,
  handler(req) {
    return sseResponse<ClobberStreamVocabulary>({
      signal: req.signal,
      setup: (sink) => {
        const handler = (ev: ClobberEvent): void => {
          sink.event('clobber', ev);
        };
        clobberEvents.on('clobber', handler);
        req.signal.addEventListener('abort', () => {
          clobberEvents.off('clobber', handler);
        });
      },
    });
  },
});
