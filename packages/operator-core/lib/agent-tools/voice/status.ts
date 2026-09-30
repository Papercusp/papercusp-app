import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { voiceStatus } from '../../voice-node/manager';

export default defineTool({
  name: 'voice:status',
  profile: 'engineer',
  description: 'Live voice state: active channel, mute, and in-channel peers (id/label/muted/speaking).',
  capability: 'operator:read',
  guidance: {
    when: `Read who's in the active voice channel right now (presence is in-band — liveness IS the peer connection).`,
    notWhen: `The durable channel LIST is \`voice:channels {op:'list'}\` — status only covers the channel this node is in.`,
    seeAlso: [
      'voice:channels (the durable channel list)',
      'voice:join (join a channel)',
    ],
  },
  requirePrincipal: false,
  // Sentinel-as-Herald: the voice-first Herald reads voice status too.
  agentRoles: ['operator', 'architect', 'papercup'],
  rolesQuota: { architect: { perRun: 100 }, operator: { perRun: 400 } },
  args: z.object({}),
  async handler() {
    return { data: { ok: true, status: voiceStatus() } };
  },
});
