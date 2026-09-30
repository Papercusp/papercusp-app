import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { joinVoiceChannel } from '../../voice-node/manager';

export default defineTool({
  name: 'voice:join',
  profile: 'engineer',
  description: 'Join a P2P voice channel by id or name — starts the voice swarm, announces the topic, connects to peers.',
  capability: 'operator:write',
  guidance: {
    when: `Enter a voice channel (by id or name from \`voice:channels\`). One active channel at a time; joining another leaves the current one.`,
    notWhen: `Don't poll this — \`voice:status\` reads the live state; the local voice socket pushes status events to UI clients.`,
    chaining: `voice:channels {op:'list'} → voice:join → speak via the local voice socket (pui/desktop) → voice:leave.`,
    seeAlso: [
      'voice:channels (list / create channels)',
      'voice:leave (leave the channel)',
      'voice:status (live channel presence)',
    ],
  },
  requirePrincipal: false,
  // Sentinel-as-Herald: the voice-first Herald drives the voice channel.
  agentRoles: ['operator', 'architect', 'papercup'],
  rolesQuota: { architect: { perRun: 20 }, operator: { perRun: 100 } },
  args: z.object({ channel: z.string().min(1).describe('Channel id (vc-…) or name') }),
  async handler(args) {
    const status = await joinVoiceChannel(args.channel);
    return { data: { ok: true, status } };
  },
});
