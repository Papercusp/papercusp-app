import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { enableVoiceAgent, voiceAgentEnabled, voiceAgentSay } from '../../voice-node/agent-peer';
import {
  enableVoiceAgentBrain,
  voiceAgentBrainEnabled,
  voiceAgentSpeaking,
} from '../../voice-node/agent-brain';
import { hardText } from '../limits';

export default defineTool({
  name: 'voice:agent',
  profile: 'engineer',
  description:
    'Voice agent peer: toggle channel listening (STT) or the converse BRAIN (auto-reply), report status, or speak text (TTS) into the active channel.',
  capability: 'operator:write',
  guidance: {
    when: `Toggle the agent's ears ({op:'enable'|'disable'}), its auto-reply brain ({op:'brain', on}), read {op:'status'}, or speak into the channel ({op:'say', text}).`,
    notWhen: `Joining/leaving the channel itself is \`voice:join\`/\`voice:leave\`; this controls only the agent's listen/think/speak behaviors on top.`,
    chaining: `voice:join → voice:agent {op:'brain', on:true} (ears + auto-reply: peer speech → operator-converse → spoken reply). For manual control use {op:'enable'} then {op:'say', text:'…'}.`,
    seeAlso: [
      'voice:join (join a channel first)',
      'voice:transcript (hear peers WITHOUT auto-reply)',
      'voice:say (speak one line manually)',
    ],
  },
  requirePrincipal: false,
  // Sentinel-as-Herald: the sentinel is the voice-first Herald, so it drives the
  // voice channel like the operator does (paired with its operator:write cap).
  agentRoles: ['operator', 'architect', 'papercup'],
  rolesQuota: { architect: { perRun: 50 }, operator: { perRun: 200 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('enable') }),
    z.object({ op: z.literal('disable') }),
    z.object({ op: z.literal('brain'), on: z.boolean() }),
    z.object({ op: z.literal('status') }),
    z.object({ op: z.literal('say'), text: hardText(4000) }),
  ]),
  async handler(args) {
    if (args.op === 'say') {
      const frames = await voiceAgentSay(args.text);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: frames > 0, frames }) }] };
    }
    if (args.op === 'enable') enableVoiceAgent(true);
    if (args.op === 'disable') {
      enableVoiceAgentBrain(false); // brain needs the ears — drop it too
      enableVoiceAgent(false);
    }
    if (args.op === 'brain') enableVoiceAgentBrain(args.on);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            enabled: voiceAgentEnabled(),
            brain: voiceAgentBrainEnabled(),
            speaking: voiceAgentSpeaking(),
          }),
        },
      ],
    };
  },
});
