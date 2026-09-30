import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { createVoiceChannel, listVoiceChannels, removeVoiceChannel } from '../../voice-node/registry';

export default defineTool({
  name: 'voice:channels',
  profile: 'engineer',
  description: 'List/create/remove P2P voice channels (the durable registry; a channel maps a name to a swarm topic).',
  capability: 'operator:write',
  guidance: {
    when: `Manage the voice-channel registry — list what channels exist, create one before joining it, or remove a stale one.`,
    notWhen: `To enter/exit a channel use \`voice:join\` / \`voice:leave\`; for who's in a channel right now use \`voice:status\`.`,
    chaining: `voice:channels {op:'create'} → voice:join {channel} → voice:status.`,
    seeAlso: [
      'voice:join (enter a channel)',
      'voice:status (who is in a channel right now)',
    ],
  },
  requirePrincipal: false,
  // Sentinel-as-Herald: the voice-first Herald manages its voice channels.
  agentRoles: ['operator', 'architect', 'papercup'],
  rolesQuota: { architect: { perRun: 50 }, operator: { perRun: 200 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('list') }),
    z.object({ op: z.literal('create'), name: z.string().min(1).max(80) }),
    z.object({ op: z.literal('remove'), channel: z.string().min(1) }),
  ]),
  async handler(args) {
    if (args.op === 'create') {
      const channel = await createVoiceChannel(args.name);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, channel }) }] };
    }
    if (args.op === 'remove') {
      const removed = await removeVoiceChannel(args.channel);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: removed }) }] };
    }
    const channels = await listVoiceChannels();
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, channels }) }] };
  },
});
