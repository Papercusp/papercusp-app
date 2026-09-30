import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrCreateActiveConversation, listTurnsRecent } from '../../operator-conversations';

/**
 * conversation:recent — Phase B of the Sentinel-as-Claude-TUI
 * (sentinel-as-claude-tui-2026-06-22). Reads the most recent turns of the SHARED
 * `operator_conversations` thread (the app's webview chat), so the dock Sentinel
 * can see what the user said in the app (typed or voice) and continue ONE thread
 * across the voice/TUI surface and the webview. `operator:converse` capability.
 */
export default defineTool({
  name: 'conversation:recent',
  profile: 'engineer',
  description:
    "Read the most recent turns of the SHARED operator conversation thread (the app's webview chat) so you continue ONE thread across voice/TUI and the app.",
  capability: 'operator:converse',
  guidance: {
    when: `You want the recent context of the shared app conversation — what the user typed or said in the webview chat — e.g. at the start of a voice exchange to continue where the app left off.`,
    notWhen: `For YOUR own scrollback just read your TUI; this is the SHARED webview thread, not your session history.`,
    seeAlso: [
      'conversation:append (append a turn to the thread)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['papercup', 'operator'],
  rolesQuota: { sentinel: { perRun: 4000 }, papercup: { perRun: 4000 }, operator: { perRun: 400 } }, // papercup: pot-rename dual-accept twin of sentinel (P1 MIGRATE)
  args: z.object({
    limit: z.number().int().min(1).max(100).optional().describe('How many recent turns to return (default 20).'),
  }),
  async handler(args) {
    const conv = await getOrCreateActiveConversation();
    const page = await listTurnsRecent({ conversationId: conv.id, limit: args.limit ?? 20 });
    const turns = page.turns.map((t) => ({ role: t.role, text: t.text, source: t.source, seq: t.seq }));
    return { data: { ok: true, turns } };
  },
});
