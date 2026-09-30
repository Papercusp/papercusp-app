/**
 * operator:conv_voice — read or set the EL Conv AI agent's voice.
 *
 * Mirrors GET / POST /api/agent-mcp/operator-conv-voice. Set handles
 * the "voice not yet in library" case by adding the public voice
 * before patching the agent.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readConvVoice, setConvVoice } from '../../conv-voice';

export default defineTool({
  name: 'operator:conv_voice',
  profile: 'engineer',
  description: 'Read or set the EL Conv AI agent voice (voice_id, optional model_id). Adds public voices to library if needed.',
  capability: 'operator:write',
  guidance: {
    when: `Read voice-conversation state (mode, engine, transcript). Diagnostic for the voice-converse pipeline.`,
    notWhen: `For voice PREFS (defaults), use \`operator:voice_prefs\`. conv_voice is runtime, not config.`,
    seeAlso: [
      'operator:voice_prefs (voice defaults / prefs)',
      'operator:voice_debug (voice engine debug snapshot)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect'],
  rolesQuota: { architect: { perRun: 20 }, operator: { perRun: 50 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      voiceId: z.string().min(15).max(30).regex(/^[A-Za-z0-9]+$/),
      modelId: z.string().optional(),
    }),
  ]),
  async handler(args) {
    if (args.op === 'get') {
      const result = await readConvVoice();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    const result = await setConvVoice({ voiceId: args.voiceId, modelId: args.modelId });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});
