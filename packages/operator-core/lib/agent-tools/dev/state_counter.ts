/**
 * dev:state_counter — proof-of-concept state-shaped tool.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §5
 *
 * Publishes a counter that ticks `steps` times, with optional per-tick
 * delay. Each tick is a new full snapshot. State-shaped tools opt out
 * of the ring buffer at register time; clients reconnecting mid-run
 * receive the latest snapshot (current count + phase) — never event
 * history.
 *
 * Use cases:
 *   - End-to-end verification of ctx.publishState on the wire.
 *   - Demo for /dev: open the page, kick a counter, kill the SSE
 *     stream, reconnect, see the current count without history bloat.
 *
 * Wire shape (state-snapshot envelope):
 *   { runId, version, snapshot: { openCards: [], toolState: {count, total, phase} } }
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const ArgsSchema = z.object({
  /** Number of tick iterations. 1..50. */
  steps: z.number().int().min(1).max(50).default(5),
  /** Per-tick delay in ms. 0..2000. */
  delayMs: z.number().int().min(0).max(2000).default(150),
});

const StateSchema = z.object({
  count: z.number().int().min(0),
  total: z.number().int().min(1),
  phase: z.enum(['running', 'done']),
});

export default defineTool({
  name: 'dev:state_counter',
  profile: 'engineer',
  description:
    'Demo state-shaped tool: ticks a counter and publishes each tick via ctx.publishState. Reconnect-resilient by construction.',
  capability: 'tasks:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'scoper', 'documenter', 'curator'],
  timeoutSec: 120,
  state: StateSchema,
  args: ArgsSchema,
  async handler(args, ctx) {
    if (!ctx.publishState) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'no_state_channel: dev:state_counter requires a runId-bearing context',
          }),
        }],
        isError: true,
      };
    }
    const total = args.steps;
    for (let i = 0; i <= total; i++) {
      ctx.publishState({
        count: i,
        total,
        phase: i === total ? 'done' : 'running',
      });
      if (i < total && args.delayMs > 0) {
        await new Promise((r) => setTimeout(r, args.delayMs));
      }
      if (ctx.signal.aborted) break;
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: true, ticks: total }),
      }],
    };
  },
});
