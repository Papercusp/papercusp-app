/**
 * dev:ipc_echo — end-to-end verification tool for the endpoint-IPC
 * transport. Emits a small typed event sequence with a short delay
 * between each, then returns. Used by:
 *
 *   - the /dev page's IPC verification button — confirms the
 *     webview→Tauri→Node round-trip works without touching real
 *     production routes;
 *   - the wire-protocol tests in
 *     packages/ipc-endpoint-server/src/server.test.ts, and the
 *     real-tool E2E in lib/endpoint-ipc/dev_ipc_echo_e2e.test.ts.
 *
 * Wire shape (schema-inferred):
 *   delta:    JSON   { text: string }
 *   binary:   binary Uint8Array (4 bytes; small enough to land in one
 *                                EVENT_BIN frame so consumers don't
 *                                need chunk reassembly logic)
 *   progress: JSON   { progress: number; total: number }
 *
 * Default URL: /api/agent-tools/dev/ipc_echo
 * IPC name: dev:ipc_echo (allowlisted in operator instrumentation).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const ArgsSchema = z.object({
  /** Text to echo. Default: 'hello' */
  message: z.string().default('hello'),
  /** Whether to include a binary event in the stream. Default: false. */
  emitBinary: z.boolean().default(false),
  /** Per-delta delay in ms. Cap at 1000ms so the tool can't be used
   *  to wedge a connection. Default 100ms. */
  delayMs: z.number().int().min(0).max(1000).default(100),
});

export default defineTool({
  name: 'dev:ipc_echo',
  expose: { ipc: true },
  profile: 'engineer',
  description:
    'IPC transport verification — echoes the message back as a small typed event stream.',
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  timeoutSec: 30,
  idleTimeoutSec: 5,
  args: ArgsSchema,
  events: {
    delta: z.object({ text: z.string() }),
    binary: z.instanceof(Uint8Array),
    progress: z.object({ progress: z.number(), total: z.number() }),
  },
  async handler(input, ctx) {
    const words = input.message.split(/(\s+)/);
    const total = words.length;
    const sleep = (ms: number): Promise<void> =>
      new Promise((r) => setTimeout(r, ms));

    for (let i = 0; i < words.length; i++) {
      if (ctx.signal?.aborted) {
        throw new Error('aborted');
      }
      ctx.emit('delta', { text: words[i] });
      ctx.emit('progress', { progress: i + 1, total });
      if (input.delayMs > 0) await sleep(input.delayMs);
    }

    if (input.emitBinary) {
      // 4 bytes — small, fits in one EVENT_BIN frame, easy to assert.
      ctx.emit('binary', new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ echo: input.message, words: total }),
        },
      ],
    };
  },
});
