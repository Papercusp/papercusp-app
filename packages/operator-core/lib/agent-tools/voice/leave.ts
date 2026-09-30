import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { leaveVoiceChannel } from '../../voice-node/manager';

export default defineTool({
  name: 'voice:leave',
  profile: 'engineer',
  description: 'Leave the active P2P voice channel (drops peer connections, releases the swarm topic).',
  capability: 'operator:write',
  guidance: {
    when: `Exit the current voice channel. Safe no-op when not in one.`,
    notWhen: `Removing a channel from the registry is \`voice:channels {op:'remove'}\` — leaving only ends THIS node's participation.`,
    seeAlso: [
      'voice:join (join a channel)',
      'voice:channels (remove a channel from the registry)',
    ],
  },
  requirePrincipal: false,
  // Sentinel-as-Herald: the voice-first Herald drives the voice channel.
  agentRoles: ['operator', 'architect', 'papercup'],
  rolesQuota: { architect: { perRun: 20 }, operator: { perRun: 100 } },
  args: z.object({}),
  async handler() {
    const status = await leaveVoiceChannel();
    return { data: { ok: true, status } };
  },
});
