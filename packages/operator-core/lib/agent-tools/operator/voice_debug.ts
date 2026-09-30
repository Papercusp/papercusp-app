/**
 * operator:voice_debug — read or append the process-local voice-debug
 * ring buffer. Same buffer the legacy /api/agent-mcp/voice-debug
 * route reads/writes; this exposes it via MCP for agents diagnosing
 * voice-state issues from out-of-process.
 *
 * Operations:
 *   - { op: 'append', event, detail?, ts? } → append + return count
 *   - { op: 'read', since? }                → newest-first events
 *   - { op: 'clear' }                       → flush ring (operator only)
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  appendVoiceDebugEvent,
  clearVoiceDebugEvents,
  readVoiceDebugEvents,
} from '../../voice-debug-ring';

export default defineTool({
  name: 'operator:voice_debug',
  profile: 'engineer',
  description: 'Read, append, or clear the process-local voice-debug ring buffer (same buffer as the agent-mcp/voice-debug route).',
  capability: 'operator:write',
  guidance: {
    when: `Debug snapshot of the voice engine state — engine in use, last connection, transcript queue. Diagnostic only.`,
    notWhen: `For voice preferences, use \`operator:voice_prefs\`. voice_debug is read-only diagnostic.`,
    seeAlso: [
      'operator:voice_prefs (voice preferences / defaults)',
      'operator:conv_voice (live conversational voice state)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'reviewer'],
  args: z.discriminatedUnion('op', [
    z.object({
      op: z.literal('append'),
      event: z.string().min(1),
      detail: z.unknown().optional(),
      ts: z.number().int().nonnegative().optional(),
    }),
    z.object({
      op: z.literal('read'),
      since: z.number().int().nonnegative().optional(),
    }),
    z.object({ op: z.literal('clear') }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'append') {
      const count = appendVoiceDebugEvent({ event: args.event, detail: args.detail, ts: args.ts });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, count }) }] };
    }
    if (args.op === 'read') {
      const events = readVoiceDebugEvents(args.since);
      return { content: [{ type: 'text', text: JSON.stringify({ count: events.length, events }) }] };
    }
    if (ctx.role !== 'operator') {
      throw new Error('voice_debug clear requires operator role');
    }
    clearVoiceDebugEvents();
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, cleared: true }) }] };
  },
});
