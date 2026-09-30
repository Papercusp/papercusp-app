/**
 * operator:voice_prefs — read or partially update operator voice prefs.
 *
 * Mirrors GET / PUT /api/agent-mcp/operator-voice-prefs. The full schema
 * lives in `apps/operator/lib/voice-prefs.ts` (VoicePrefs interface).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { loadVoicePrefs, saveVoicePrefs, type VoicePrefs } from '../../voice-prefs';

export default defineTool({
  name: 'operator:voice_prefs',
  profile: 'engineer',
  description: 'Read or partial-update operator voice prefs (engine selectors, feature toggles, agent ids).',
  capability: 'operator:write',
  guidance: {
    when: `Read/set voice preferences — engine, wake word, autostart, persona name.`,
    notWhen: `For runtime state of an active session, use \`operator:conv_voice\`. voice_prefs is user-set config.`,
    seeAlso: [
      'operator:conv_voice (runtime state of an active session)',
      'operator:voice_debug (voice engine debug snapshot)',
      'operator:preferences (non-voice operator prefs)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect'],
  rolesQuota: { architect: { perRun: 50 }, operator: { perRun: 200 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      patch: z.record(z.string(), z.unknown()),
    }),
  ]),
  async handler(args) {
    if (args.op === 'get') {
      const prefs = await loadVoicePrefs();
      return { content: [{ type: 'text', text: JSON.stringify(prefs ?? null) }] };
    }
    const next = await saveVoicePrefs(args.patch as Partial<VoicePrefs>);
    return { content: [{ type: 'text', text: JSON.stringify(next) }] };
  },
});
