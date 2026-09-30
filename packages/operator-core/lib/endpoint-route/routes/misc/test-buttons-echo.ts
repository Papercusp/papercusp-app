/**
 * POST /api/test-buttons/echo — demo endpoint for the @scope/test-buttons
 * plugin; SSE-echoes the round-trip back to the user's xterm.
 *
 * Ported from app/api/test-buttons/echo/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 * The handler returns the streaming `sseResponse` directly — the
 * route-stack passes it through unchanged. sampleRate 0: streaming
 * demo endpoint, no telemetry value.
 */
import { sseResponse } from '@papercusp/sse';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/test-buttons/echo',
  auth: 'loopback',
  sampleRate: 0,
  timeoutSec: 60,
  async handler(req) {
    const branch = new URL(req.url).searchParams.get('branch') ?? '?';
    const body = (await req.json().catch(() => ({}))) as {
      harness?: string;
      runId?: string;
      button?: string;
      env?: Record<string, unknown>;
    };
    return sseResponse({
      signal: req.signal,
      setup: async (sink) => {
        const send = (s: string) => sink.eventRaw('line', s);
        send(
          `[demo button] called for branch=${branch} harness=${body.harness} runId=${body.runId}`,
        );
        await new Promise((r) => setTimeout(r, 300));
        send(`[demo button] received button name = ${body.button}`);
        await new Promise((r) => setTimeout(r, 300));
        send(`[demo button] env keys = ${Object.keys(body.env ?? {}).join(', ') || '(none)'}`);
        await new Promise((r) => setTimeout(r, 300));
        send(`[demo button] simulating work…`);
        await new Promise((r) => setTimeout(r, 800));
        send(`[demo button] done ✓`);
        sink.close();
      },
    });
  },
});
