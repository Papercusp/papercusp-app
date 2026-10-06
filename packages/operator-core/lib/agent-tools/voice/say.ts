import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { pushSentinelSay } from '../../sentinel-output-buffer';

/**
 * voice:say — the Sentinel's voice-OUT (sentinel-as-claude-tui-2026-06-22,
 * Phase D). The voice-first Sentinel (a psu/Claude-Code session) calls this to
 * speak a line ALOUD to the local app user: the text lands in the shared
 * `sentinel_says` FIFO, then either the server-side full-agent pump speaks it
 * onto the voice bus or the local webview drains it via
 * `GET /api/operator/papercup-output`.
 *
 * LOCAL APP USER ONLY (owner constraint): this is the local TTS channel, NOT the
 * P2P voice-channel system (voice:join/etc.). Capability `operator:read` matches
 * the sentinel role's `voice:* → operator:read` mapping (role-principal-caps).
 */
export default defineTool({
  name: 'voice:say',
  profile: 'engineer',
  description:
    "Speak a short line ALOUD to the local app user via the desktop's TTS (the Sentinel's voice-out). LOCAL app user only — not the P2P voice channels.",
  capability: 'operator:read',
  // WI-10004577: speaks ALOUD (writes the shared sentinel_says FIFO) while sharing the `operator:read`
  // capability with genuine readers, so it declares its own write effect — it must not infer 'read'
  // (that would run it during a code:run dryRun preview AND exempt it from the late-completion abort).
  effect: 'write',
  guidance: {
    when: `You are the voice-first Papercup and want the user to HEAR something — call voice:say with the spoken words (short: one or two sentences). The user hears ONLY what you pass here.`,
    notWhen: `Don't speak internal tool steps, long detail, or code aloud. For multi-peer P2P voice use voice:join, not this.`,
    seeAlso: [
      'voice:join (multi-peer P2P voice)',
      'voice:transcript (read what was heard / spoken)',
    ],
  },
  requirePrincipal: false,
  // The voice-first Sentinel is the primary caller; operator may speak too.
  agentRoles: ['papercup', 'operator'],
  rolesQuota: { sentinel: { perRun: 2000 }, papercup: { perRun: 2000 }, operator: { perRun: 400 } }, // papercup: pot-rename dual-accept twin of sentinel (P1 MIGRATE)
  args: z.object({
    text: z.string().min(1).describe('The line to speak aloud to the local user.'),
  }),
  async handler(args) {
    await pushSentinelSay(args.text);
    // Voice ≡ text (WI-4838): the spoken line is persisted HERE, at push
    // time — the single seam every drain path shares (server says-pump when a
    // full-agent session is live, webview local-mode poll otherwise). Persist
    // at drain would tie chat presence to whichever consumer won the FIFO;
    // push-time also means the text reaches chat even if synthesis fails.
    try {
      const { getOrCreateActiveConversation, appendTurn } = await import(
        '../../operator-conversations'
      );
      const conv = await getOrCreateActiveConversation();
      await appendTurn({
        conversationId: conv.id,
        role: 'assistant',
        text: args.text,
        source: 'voice_tts',
        elConvId: null,
      });
      const { notifySyncInvalidate } = await import('../../sync-sse');
      void notifySyncInvalidate('operatorTurns.page', { conversationId: conv.id })
        .catch(() => { /* best-effort */ });
    } catch (err) {
      console.warn('[voice:say] chat persist failed:', (err as Error)?.message ?? err);
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  },
});
