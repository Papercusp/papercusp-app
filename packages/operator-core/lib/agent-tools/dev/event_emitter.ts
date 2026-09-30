/**
 * dev:event_emitter — replay-buffer probe.
 *
 * Plan: T2.2 — replay/Last-Event-ID resume on disconnect (phase-4 endpoint-system).
 *
 * Emits `steps` `tick` events at `delayMs` intervals, then returns.
 * Declares `replayBufferSize: 100` so the dispatcher keeps the last
 * N emits per (workspace, tool, runId). A client that disconnects
 * mid-stream and reconnects with `Last-Event-ID + X-Papercusp-Run-Id`
 * receives the buffered tail before the cold stream resumes.
 *
 * Wire shape:
 *   event: tick
 *   data: {"i":<int>}     id: <serial>
 *
 * Used by the pass-9 audit E2E probe; not surfaced to LLMs (role:[]).
 */

import { z } from 'zod';
import { defineTool, type UnifiedToolContext } from '@papercusp/agent-mcp';

const ArgsSchema = z.object({
  steps: z.number().int().min(1).max(50).default(5),
  delayMs: z.number().int().min(0).max(2000).default(150),
});

export default defineTool({
  name: 'dev:event_emitter',
  profile: 'engineer',
  description: 'Replay-buffer probe — emits N tick events with serial ids. Dev-only.',
  capability: 'tasks:read',
  requirePrincipal: false,
  agentRoles: ['operator'],
  timeoutSec: 60,
  replayBufferSize: 100,
  events: {
    tick: z.object({ i: z.number().int() }),
  },
  args: ArgsSchema,
  async handler(args, ctx: UnifiedToolContext) {
    for (let i = 0; i < args.steps; i++) {
      if (ctx.signal?.aborted) break;
      ctx.emit('tick', { i });
      if (args.delayMs > 0) await new Promise((r) => setTimeout(r, args.delayMs));
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, emitted: args.steps }) }],
    };
  },
});
