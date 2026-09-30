/**
 * dev:resolve_owner — resolve a coordination owner id to its session(s).
 *
 * WI-1279. Given an agent owner id (the `from` field on plan-events /
 * coord:presence / coord:whoami's ownerId — su-… interactive SU, s-… fleet bee,
 * pus-… power-user), return the session(s) it ran in: the native resume
 * session_id (claude/codex — what you pass to `claude --resume`), omp_thread_id
 * (omp), the spawn/run ids, plan, cwd, and the per-turn telemetry activity
 * attributed to that owner. Closes the owner→session gap dev:sessions has.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveOwnerSessions } from '../../dev-data';

const ownerResolutionSchema = z.object({
  owner_id: z.string(),
  sessions: z.array(
    z.object({
      source: z.enum(['adv_sessions', 'spawned_agents']),
      owner_id: z.string(),
      session_id: z.string().nullable(),
      omp_thread_id: z.string().nullable(),
      spawn_id: z.string().nullable(),
      run_id: z.string().nullable(),
      agent: z.string().nullable(),
      role: z.string().nullable(),
      mode: z.string().nullable(),
      harness_slug: z.string().nullable(),
      plan_slug: z.string().nullable(),
      cwd: z.string().nullable(),
      status: z.string().nullable(),
      started_at: z.string().nullable(),
      ended_at: z.string().nullable(),
    }),
  ),
  activity: z.array(
    z.object({
      spawn_id: z.string(),
      workspace_id: z.string().nullable(),
      harness_slug: z.string().nullable(),
      tool_count: z.number().int().nonnegative(),
      error_count: z.number().int().nonnegative(),
      started_at: z.string(),
      ended_at: z.string(),
    }),
  ),
});

export default defineTool({
  name: 'dev:resolve_owner',
  profile: 'engineer',
  description:
    'Resolve a coordination owner id (su-…/s-…/pus-…) to its session(s): the native resume session_id (claude/codex), omp_thread_id, spawn/run ids, plan, cwd, and per-turn telemetry activity. The owner↔session link the dev:sessions list lacks.',
  capability: 'intel:read',
  guidance: {
    when: `You have an agent OWNER id (from coord:presence, a plan-event's \`from\`, or coord:whoami) and need the session it ran in — e.g. the id to pass to \`claude --resume\`.`,
    notWhen: `You already have a spawn_id — use \`dev:session_detail\`. For the session LIST, use \`dev:sessions\`.`,
    seeAlso: [
      'dev:session_detail (drill into the resolved spawn)',
      'dev:sessions (the session list)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    ownerId: z.string().min(1),
  }),
  // Keep the lossless object available as MCP structuredContent for programmatic
  // callers (ptool / MCP clients that request `_meta.structured`). The text body
  // still goes through the ordinary result door, but a large JSON text block can
  // otherwise be cut before callers receive the complete owner resolution.
  result: ownerResolutionSchema,
  async handler(args) {
    const result = await resolveOwnerSessions(args.ownerId);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});
