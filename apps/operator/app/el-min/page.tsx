'use client';

import { useEffect, useRef, useState } from 'react';

// Minimal EL test inside the operator React tree.
// Imports @elevenlabs/client from the BUNDLED package (same as the failing
// elPure path), but renders no chrome, no providers, no OracleDock, no voice
// button. If this works → contamination is in specific operator components.
// If it fails the same way as elPure → bundling itself is the issue.
//
// **Idle disconnect** (EL credit-burn audit, fix #5): this diagnostic
// page used to leak minutes when left open — click Start, walk away,
// session ran until EL or the browser tore it down. Each accidental
// open could burn unbounded minutes. Now we arm an idle timer on
// startSession (resets only on user transcripts, matching production
// voice-mode behavior) AND a hard 10-minute session-max ceiling.
// Diagnostic, not production — bias toward "auto-stop sooner."

const IDLE_TIMEOUT_MS = 60_000;        // 1 min of user silence → stop
const SESSION_MAX_MS  = 10 * 60_000;   // hard 10min ceiling

export default function Page() {
  const [lines, setLines] = useState<string[]>(['click "Start" to begin…']);
  const convRef = useRef<any>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionMaxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const append = (s: string) =>
    setLines((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${s}`]);

  const clearTimers = () => {
    if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
    if (sessionMaxTimerRef.current) { clearTimeout(sessionMaxTimerRef.current); sessionMaxTimerRef.current = null; }
  };

  // Idle timer — runs only on USER speech (not agent). Matches the
  // production voice-mode behavior — agent-talk reset would let a
  // chatty agent keep the session alive indefinitely.
  const armIdleTimer = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      append('idle 1min — stopping session');
      void stop();
    }, IDLE_TIMEOUT_MS);
  };

  // Hard session-max. Set once at start; not reset on activity.
  const armSessionMaxTimer = () => {
    if (sessionMaxTimerRef.current) clearTimeout(sessionMaxTimerRef.current);
    sessionMaxTimerRef.current = setTimeout(() => {
      sessionMaxTimerRef.current = null;
      append('session hit 10min cap — stopping');
      void stop();
    }, SESSION_MAX_MS);
  };

  const start = async () => {
    setLines([]);
    append('=== minimal-react EL test starting ===');
    append(`auto-stop on ${IDLE_TIMEOUT_MS / 1000}s user-silence OR ${SESSION_MAX_MS / 60_000}m hard max`);
    let token: string, agentId: string;
    try {
      const r = await fetch('/api/agent-mcp/operator-elevenlabs-bootstrap');
      if (!r.ok) {
        append(`mint failed: HTTP ${r.status}`);
        return;
      }
      const j = await r.json();
      token = j.conversationToken;
      agentId = j.agentId;
      append(`token len ${token.length}, agentId ${agentId}`);
    } catch (e: any) {
      append(`mint threw: ${e?.message ?? e}`);
      return;
    }
    append('opening Conversation.startSession (bundled @elevenlabs/client) …');
    try {
      const mod = await import('@elevenlabs/client');
      const conv = await mod.Conversation.startSession({
        conversationToken: token,
        connectionType: 'webrtc',
        textOnly: false,
        clientTools: {},
        onConnect: ({ conversationId }: any) => {
          append(`onConnect — ${conversationId}`);
          armIdleTimer();
          armSessionMaxTimer();
        },
        onDisconnect: (d: any) => {
          append(`onDisconnect ${JSON.stringify(d)}`);
          clearTimers();
        },
        onMessage: ({ message, source }: any) => {
          append(`msg[${source}]: ${String(message).slice(0, 120)}`);
          // ONLY reset idle on user speech, not agent. Matches
          // production voice-mode after the credit-burn audit fix #2.
          if (source === 'user') armIdleTimer();
        },
        onError: (m: string) => append(`error: ${m}`),
        onModeChange: (m: any) => append(`mode: ${JSON.stringify(m)}`),
        onStatusChange: (s: any) => append(`status: ${JSON.stringify(s)}`),
      });
      convRef.current = conv;
      append('startSession resolved — speak now');
    } catch (e: any) {
      append(`startSession failed: ${e?.message ?? e}`);
      clearTimers();
    }
  };

  const stop = async () => {
    clearTimers();
    try { await convRef.current?.endSession(); } catch {}
    convRef.current = null;
    append('stopped');
  };

  // Belt-and-braces: also stop if the user navigates away or closes
  // the tab. EL sessions otherwise live until provider-side teardown.
  useEffect(() => {
    const onBeforeUnload = () => { void stop(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: 'ui-monospace, Menlo, monospace', maxWidth: 720, margin: '0 auto' }}>
      <h1>EL minimal-React test</h1>
      <p>Same minimal diagnostic flow inside the operator React tree (root layout providers still wrap it; no chrome, no OracleDock, no voice button on this route).</p>
      <p>
        <strong>Auto-stops</strong> after {IDLE_TIMEOUT_MS / 1000}s of user silence
        or {SESSION_MAX_MS / 60_000} min hard ceiling — diagnostic page should never
        run unattended.
      </p>
      <p>
        <button onClick={start} style={{ padding: '8px 16px', marginRight: 8 }}>Start</button>
        <button onClick={stop} style={{ padding: '8px 16px' }}>Stop</button>
      </p>
      <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, maxHeight: 500, overflow: 'auto' }}>
        {lines.join('\n')}
      </pre>
    </div>
  );
}
