/**
 * operator:voice_utterance_log — append a voice-utterance audit row.
 *
 * Mirrors POST /api/agent-mcp/voice-utterance-log. Best-effort
 * audit; returns `{ ok: true, degraded: true }` if the table isn't
 * migrated yet.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { logVoiceUtterance } from '../../voice-utterance-log';

export default defineTool({
  name: 'operator:voice_utterance_log',
  profile: 'engineer',
  description: 'Append a voice-utterance audit row (source/mode/length/persona-flags/modifications).',
  capability: 'operator:write',
  guidance: {
    when: `Append a voice-utterance audit row after a voice turn (source/mode/length/persona-flags/modifications). This tool records metadata; it does not read transcripts.`,
    notWhen: `For voice-conversation state or transcripts, use \`operator:conv_voice\`; for the process-local debug ring, use \`operator:voice_debug\`. For TEXT chat history, that lives in operator_turns. voice_utterance_log is voice-only.`,
    seeAlso: [
      'operator:voice_spend_summary (voice spend rollup)',
      'operator:voice_debug (runtime voice session state)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'worker'],
  rolesQuota: {
    worker: { perChunk: 50 },
    architect: { perRun: 200 },
    operator: { perRun: 1000 },
  },
  args: z.object({
    source: z.enum(['legacy', 'elevenlabs-conv', 'realtime']).optional(),
    mode: z.string().optional(),
    lengthChars: z.number().int().nonnegative().optional(),
    nameUsed: z.boolean().optional(),
    hadBackstory: z.boolean().optional(),
    modifications: z.array(z.unknown()).optional(),
  }),
  async handler(args) {
    const result = await logVoiceUtterance(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});
