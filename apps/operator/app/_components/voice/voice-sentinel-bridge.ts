/**
 * voice-sentinel-bridge — the PRIMARY voice-IN route (voice-public-release-
 * readiness-2026-07-12 P-019/D-004/D-007). A final STT transcript is POSTed to
 * `/api/operator/papercup-input`, which writes it into the dock's Papercup
 * pane (a `psu --role=papercup` Claude-Code TUI — the persistent fast
 * front-end) so the user talks to Papercup by voice. The dock ships on ALL
 * platforms (D-004); when the pane route is unavailable (503: no dock / no
 * registered pane) the caller (VoiceAppBridge) falls back to the in-process
 * converse brain via submitVoiceTurn.
 *
 * LOCAL APP USER ONLY (owner constraint): the local STT→pane pipeline, NOT the
 * P2P voice-channel system.
 */
export async function routeVoiceToSentinelPane(text: string): Promise<boolean> {
  const t = text.trim();
  if (!t) return false;
  try {
    const res = await fetch('/api/operator/papercup-input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // EI-10563: this bridge is voice-IN only (see the module docstring) — the
      // route/pane can't otherwise tell this transcript apart from typed text.
      body: JSON.stringify({ text: t, spoken: true }),
    });
    return res.ok;
  } catch {
    // Dock not reachable / offline — drop the turn rather than throw.
    return false;
  }
}

/**
 * Phase D voice-OUT: drain the Sentinel spoken-line FIFO in local mode. The
 * webview polls this while voice is active and no full-agent session owns the
 * shared voice path. The buffer is filled by the Sentinel calling `voice:say`.
 */
export async function drainSentinelOutput(): Promise<string[]> {
  try {
    const res = await fetch('/api/operator/papercup-output', { method: 'GET' });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as { says?: unknown } | null;
    return Array.isArray(data?.says)
      ? data.says.filter((s): s is string => typeof s === 'string')
      : [];
  } catch {
    return [];
  }
}

/** The chat-thread marker a settled deep-delegation answer carries (mirrors
 *  papercup-deep-watch.ts's DEEP_ANSWER_PREFIX) — reads badly aloud, so it is
 *  stripped before speaking; the chat thread keeps the raw headline verbatim
 *  (this only affects what gets spoken, never what's persisted). */
const DEEP_ANSWER_MARKER = /^\[deep-answer[^\]]*\]\s*/i;

/**
 * Phase E voice-OUT (WI-5174): drain "while you were away" hindsight
 * notifications (a settled deep-delegation answer, or another async
 * completion) in local mode, pre-formatted for speech.
 *
 * The realtime-engine (EL Conv-AI / OpenAI Realtime) path already surfaces
 * these via `drainHindsightOnConnect` in voice-mode.ts — but that seam feeds
 * `realtimeSession.sendSystem`, so it only exists while a full-agent session
 * is live. Local engines (Kokoro/whisper — the default desktop voice config
 * since operator-chat-sidebar-revival made converse the primary brain) never
 * called it, so when a deep-delegation answer's Sentinel-pane write failed
 * (`no-dock` — the normal desktop case, no zellij dock running) and it fell
 * back to `notifyOperatorHindsight`, the answer landed in the chat thread as
 * TEXT ONLY: leg 2 of that fallback appends a system turn straight to PG,
 * bypassing every code path that calls `speak()` (WI-5174, owner-repro
 * 2026-07-17). Polling this — the same way the webview already polls the
 * Sentinel FIFO above — closes that gap for local-mode voice.
 */
export async function drainHindsightForSpeech(): Promise<string[]> {
  try {
    const res = await fetch('/api/agent-mcp/operator-hindsight?drain=1', { method: 'GET' });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as { items?: unknown } | null;
    const items = Array.isArray(data?.items) ? data.items : [];
    return items
      .map((it) =>
        it && typeof it === 'object' && typeof (it as { headline?: unknown }).headline === 'string'
          ? (it as { headline: string }).headline
          : '',
      )
      .map((headline) => headline.replace(DEEP_ANSWER_MARKER, '').trim())
      .filter((s) => s.length > 0)
      .map((s) => `While you were away: ${s}`);
  } catch {
    return [];
  }
}
