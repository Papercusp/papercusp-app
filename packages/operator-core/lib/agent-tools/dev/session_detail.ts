/**
 * dev:session_detail — full drilldown for one spawn_id or native session id.
 *
 * Returns: the spawned_agents row, the tool_invocations timeline,
 * direct-child spawns, and related agent_chats (same harness+feature).
 * Drives the Sessions tab expansion panel.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getSessionDetail } from '../../dev-data';

export default defineTool({
  name: 'dev:session_detail',
  profile: 'engineer',
  description: 'Drilldown for one spawn_id or native session_id: agent metadata, tool invocations timeline, child spawns, related chats.',
  capability: 'intel:read',
  guidance: {
    when: `Read full detail of one /dev session — request history, env, traces. Accepts the spawn_id from dev:sessions or a native session_id/omp_thread_id from sessions:* or the session roster.`,
    notWhen: `For the SESSION LIST, use \`dev:sessions\` first.`,
    seeAlso: [
      'dev:sessions (the session list)',
      'dev:resolve_owner (map an owner id to its session)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z
    .object({
      spawnId: z.string().min(1).optional().describe('spawn_id from dev:sessions.'),
      sessionId: z.string().min(1).optional().describe('Native session_id or omp_thread_id from the session roster or sessions:*.'),
    })
    .refine(({ spawnId, sessionId }) => Boolean(spawnId || sessionId), {
      message: 'pass exactly one of spawnId or sessionId',
    })
    .refine(({ spawnId, sessionId }) => !(spawnId && sessionId), {
      message: 'pass exactly one of spawnId or sessionId',
    }),
  async handler(args) {
    const result = await getSessionDetail(args.sessionId ?? args.spawnId!);
    if (!result) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'spawn not found' }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});
