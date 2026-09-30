/**
 * papercup:converse — the Sentinel brain alias.
 *
 * The sentinel watcher is re-homed onto the always-on, voice-first **Sentinel**:
 * the SAME converse brain as `operator:converse`, only loaded with the sentinel
 * persona set (sentinel.persona[.<mode>-mode].md / .converse.md / .tools.md under
 * apps/operator/prompts/). Rather than fork the ~500-line converse handler, this
 * alias registers a thin tool under the `papercup:converse` name that delegates
 * to the operator converse handler with `role` defaulted to 'sentinel'.
 *
 * The route (`/agent-mcp/operator-converse`) resolves `${role}:converse`, so a
 * body with `role:'sentinel'` lands here; the handler then forces the persona to
 * 'sentinel' (the wire arg can still override, but the default IS the point).
 *
 * Registered the same way `operator:converse` is — imported by agent-tools/index
 * so its `defineTool` runs at module load and `lookupByMcpName('papercup:converse')`
 * resolves it. The capability + allowlist gates are the sentinel's
 * (operator:converse cap on the BLUEPRINT_ROLE_CAPS.sentinel grant; the role is
 * already allowlisted on the underlying tool).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import operatorConverse, { ArgsSchema } from './converse';

// The operator converse handler — reused verbatim. It reads `input.role` to pick
// the persona; this alias defaults that to 'sentinel' when the caller omits it.
// Returns the converse ToolResult ({ content: [{ type, text }] }).
const sharedHandler = (operatorConverse as unknown as {
  handler: (
    input: Record<string, unknown>,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}).handler;

export default defineTool({
  name: 'papercup:converse',
  expose: { ipc: true },
  profile: 'engineer',
  description:
    'Sentinel brain conversation turn. The operator:converse brain loaded with the always-on, voice-first Sentinel persona (role=sentinel). Same lifecycle (prompt build, budget gate, LLM stream, spend, mem0); only the persona differs.',
  capability: 'operator:converse',
  requirePrincipal: false,
  agentRoles: ['operator', 'papercup'],
  timeoutSec: 600,
  // WI-2142938: was 120 — same idle-vs-chat:ask_choice mismatch as
  // operator:converse (this tool shares that handler verbatim). See the
  // comment on converse.ts's idleTimeoutSec for the full mechanism.
  idleTimeoutSec: 600,
  replayBufferSize: 5000,
  modality: ['text', 'voice'],
  // Mirror the operator converse arg surface (the REAL converse ArgsSchema, so every
  // field the shared handler reads flows through), only defaulting `role` to 'sentinel'
  // (the whole point of the alias). Reusing ArgsSchema keeps the STRICT arg surface
  // (additionalProperties:false at the wire — tool-input-schema-rejection contract)
  // instead of a `.passthrough()` that opened the schema to unknown keys.
  args: ArgsSchema.extend({
    role: z.string().optional().default('papercup'),
  }),
  events: {
    delta: z.object({ text: z.string() }),
    tool_call: z.object({ name: z.string(), input: z.unknown() }),
  },
  handler: async (input, ctx) => {
    const merged = { ...(input as Record<string, unknown>) };
    if (merged.role == null || merged.role === '') merged.role = 'papercup';
    return sharedHandler(merged, ctx);
  },
});
