import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrCreateActiveConversation, appendTurn } from '../../operator-conversations';

/**
 * conversation:append — Phase B of the Sentinel-as-Claude-TUI
 * (sentinel-as-claude-tui-2026-06-22). Mirrors a turn into the SHARED
 * `operator_conversations` thread (the one the app's webview chat live-syncs),
 * so the voice/TUI conversation the user has with the dock Sentinel also appears
 * in the app. Voice-in now lands in the Sentinel pane (Phase C), NOT this thread,
 * so the Sentinel is the *writer of record* — it appends BOTH sides per turn.
 *
 * `operator:converse` (the sentinel holds it — role-principal-caps) over
 * `operator-conversations.ts`; the webview reflects it instantly via useSyncQuery.
 */
export default defineTool({
  name: 'conversation:append',
  profile: 'engineer',
  description:
    "Append a turn to the SHARED operator conversation thread the app's webview chat displays. Mirror your voice/TUI turns here so the local user sees the conversation in the app.",
  capability: 'operator:converse',
  guidance: {
    when: `A user-visible turn happened OUTSIDE the auto-persisted voice flow (e.g. the user typed into your pane, or you replied in text without voice:say) — append it so the app chat stays complete.`,
    notWhen: `Don't mirror the voice flow — it persists itself (WI-4838): a spoken user transcript lands in the thread at papercup-input, and every voice:say line lands as your reply. Appending those again double-writes the turn. No internal tool noise, code, or unspoken scratch.`,
    seeAlso: [
      'conversation:recent (read the shared thread first)',
      'voice:say (speak aloud — ALSO persists the line to this thread)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['papercup', 'operator'],
  rolesQuota: { sentinel: { perRun: 4000 }, papercup: { perRun: 4000 }, operator: { perRun: 400 } }, // papercup: pot-rename dual-accept twin of sentinel (P1 MIGRATE)
  args: z.object({
    role: z.enum(['user', 'assistant']).describe("Who said it — 'user' (the app user) or 'assistant' (you)."),
    text: z.string().min(1).describe('The turn text (what was said).'),
    source: z
      .enum(['voice_stt', 'voice_tts', 'text_typed'])
      .optional()
      .describe("How it was conveyed; defaults to voice_stt for user, voice_tts for assistant."),
  }),
  async handler(args) {
    const conv = await getOrCreateActiveConversation();
    const source = args.source ?? (args.role === 'assistant' ? 'voice_tts' : 'voice_stt');
    const turn = await appendTurn({
      // ConversationRow's id field is `id`, NOT `conversationId` (EI-2905): reading the
      // non-existent `conv.conversationId` passed `undefined` to appendTurn's INSERT `$1`,
      // which postgres-js rejected as `UNDEFINED_VALUE` on 100% of calls.
      conversationId: conv.id,
      role: args.role,
      text: args.text,
      source,
    });
    const { notifySyncInvalidate } = await import('../../sync-sse');
    void notifySyncInvalidate('operatorTurns.page', { conversationId: conv.id })
      .catch(() => { /* best-effort */ });
    return { data: { ok: true, seq: turn.seq } };
  },
});
