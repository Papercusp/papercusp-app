import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  enableTranscriptCapture,
  readTranscripts,
  transcriptCaptureEnabled,
  transcriptLogState,
} from '../../voice-node/transcript-log';

export default defineTool({
  name: 'voice:transcript',
  profile: 'engineer',
  description:
    'Read live speech transcripts from the active voice channel: enable buffering (turns the ears on), then read the most-recent utterances or the delta since a cursor. The OBSERVE seam for an agent to react to spoken input WITHOUT the auto-reply brain.',
  capability: 'operator:read',
  guidance: {
    when: `Let an agent (e.g. a narrator/host) HEAR what peers said and react on its own terms — {op:'enable'} once, then poll {op:'read', since:<cursor>} for new utterances. Unlike voice:agent {op:'brain'}, this never auto-replies — you decide what to do with the speech.`,
    notWhen: `For the agent to AUTO-converse (peer speech → spoken reply) use \`voice:agent {op:'brain', on:true}\` instead. Buffering needs the ears: {op:'enable'} turns them on; {op:'disable'} stops buffering but leaves the shared ears (toggle those via voice:agent).`,
    chaining: `voice:join → voice:transcript {op:'enable'} → voice:transcript {op:'read'} (note the cursor) → … → voice:transcript {op:'read', since:<cursor>} for only what's new.`,
    seeAlso: [
      'voice:agent (auto-converse: peer speech → spoken reply)',
      'voice:join (join before enabling transcription)',
    ],
  },
  requirePrincipal: false,
  // Sentinel-as-Herald: the voice-first Herald reads spoken transcripts.
  agentRoles: ['operator', 'architect', 'papercup'],
  rolesQuota: { architect: { perRun: 200 }, operator: { perRun: 600 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('enable') }),
    z.object({ op: z.literal('disable') }),
    z.object({
      op: z.literal('read'),
      since: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Return only utterances with seq > since (the cursor from a prior read). Omit for everything buffered.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe('Keep only the most-recent N of the match (flags `lossy` if it truncated older ones).'),
    }),
    z.object({ op: z.literal('status') }),
  ]),
  async handler(args) {
    if (args.op === 'enable') {
      enableTranscriptCapture(true);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, ...transcriptLogState() }) }],
      };
    }
    if (args.op === 'disable') {
      enableTranscriptCapture(false);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, ...transcriptLogState() }) }],
      };
    }
    if (args.op === 'status') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, ...transcriptLogState() }) }],
      };
    }
    // op: 'read'
    const { entries, cursor, lossy } = readTranscripts({ since: args.since, limit: args.limit });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            enabled: transcriptCaptureEnabled(),
            entries,
            cursor,
            lossy,
          }),
        },
      ],
    };
  },
});
