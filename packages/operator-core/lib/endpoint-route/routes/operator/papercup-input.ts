/**
 * POST /api/operator/papercup-input  { text: string, spoken?: boolean }
 *
 * `spoken` (EI-10563): pass true for a voice-originated transcript — it tags
 * the pane write with `[voice]` so the persona can deterministically
 * `voice:say` a reply instead of guessing modality from bare text.
 *
 * Voice-IN for the Sentinel-as-Claude-TUI (sentinel-as-claude-tui-2026-06-22,
 * Phase C). Writes a final STT transcript into the dock's 🛡 Sentinel pane's
 * stdin so the local user can talk to the Sentinel (a `psu --role=sentinel`
 * Claude-Code session) by voice.
 *
 * The pane-write mechanics (registration targeting, warm-up gate, exited-pane
 * guard) live in ../../../sentinel/sentinel-pane-input.ts, shared with the
 * in-process callers (the operator voice host's EL-utterance relay + the
 * deep-delegation answer injection — voice-unified-sentinel-pipeline-2026-07-01
 * D-001: the pane is the ONE brain, so every input path converges here).
 *
 * LOCAL APP USER ONLY (owner constraint, 2026-06-22): this is the local
 * STT→pane pipeline, NOT the P2P voice-channel system. `auth: 'loopback'` — only
 * the local webview reaches it.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { writeToSentinelPane, isExitedPaneScreen } from '../../../papercup/papercup-pane-input';

// Re-exported so existing consumers/tests of the route module keep working.
export { isExitedPaneScreen };

interface Body {
  text?: unknown;
  /** EI-10563: true when this transcript originated as speech — tags the pane
   *  write so the persona can deterministically voice:say a reply. */
  spoken?: unknown;
}

export default defineTool({
  method: 'POST',
  path: '/operator/papercup-input',
  auth: 'loopback',
  async handler(req) {
    // CSRF guard: `auth: 'loopback'` admits the cookie-less webview, so it no
    // longer blocks a foreign browser page from POSTing to 127.0.0.1. This
    // endpoint types straight into the Sentinel's Claude-Code TUI stdin (an
    // RCE-adjacent sink), so a cross-origin write MUST be refused. Origin-based
    // (a browser always stamps it on a cross-origin request; JS can't forge it).
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;

    const body = (await req.json().catch(() => null)) as Body | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return Response.json({ error: 'text required' }, { status: 400 });
    const spoken = body?.spoken === true;

    const res = await writeToSentinelPane(text, { spoken });
    if (res.ok) {
      // Voice↔text unification (WI-4838 D): a spoken transcript accepted by
      // the pane must ALSO land in the shared conversation the chat panes
      // render — the pane consumed it, so no other path will persist it.
      // Only on success: a 503/409 falls back to the converse path, which
      // persists its own user turn (double-write otherwise).
      if (spoken) {
        try {
          const { getOrCreateActiveConversation, appendTurn } = await import(
            '../../../operator-conversations'
          );
          const conv = await getOrCreateActiveConversation();
          await appendTurn({
            conversationId: conv.id,
            role: 'user',
            text,
            source: 'voice_stt',
            elConvId: null,
          });
          const { notifySyncInvalidate } = await import('../../../sync-sse');
          void notifySyncInvalidate('operatorTurns.page', { conversationId: conv.id })
            .catch(() => { /* best-effort */ });
        } catch (err) {
          // The pane got the words either way — never fail the voice turn
          // over the mirror write, but say so in the log.
          console.warn('[papercup-input] voice turn persist failed:', (err as Error)?.message ?? err);
        }
      }
      return Response.json({ ok: true, session: res.session, paneId: res.paneId, targeted: res.targeted });
    }
    switch (res.reason) {
      case 'no-dock':
      case 'no-sentinel-pane':
        // Both mean "the pane route is unavailable" — the client (VoiceAppBridge)
        // falls back to the in-process converse brain (P-019).
        return Response.json({ error: res.error }, { status: 503 });
      case 'pane-exited':
        return Response.json(
          { error: res.error, exited: true, session: res.session, paneId: res.paneId },
          { status: 409 },
        );
      default:
        return Response.json({ error: res.error }, { status: 500 });
    }
  },
});
