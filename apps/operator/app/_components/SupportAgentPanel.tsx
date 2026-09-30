'use client';

/**
 * AI support chat panel — Sonnet 4.6 + RAG over papercusp-spec.
 *
 * Streams from POST /v1/support/chat (SSE). Per-session budget cap is
 * enforced server-side; this component just surfaces it.
 *
 * Falls through to the Chatwoot human-support widget when the AI can't
 * help (user clicks "Talk to a human" or the budget cap is hit).
 */

import { useEffect, useRef, useState } from 'react';
import { MarkdownPreview } from './MarkdownEditor';
import { Button } from '../harness/Button';
import { Tooltip } from '../harness/Tooltip';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const API_BASE = process.env.NEXT_PUBLIC_PAPERCUSP_API_BASE ?? 'https://api.papercuspai.com';

function newSessionId(): string {
  // Per-tab session id; survives re-mounts but resets on hard reload.
  if (typeof sessionStorage !== 'undefined') {
    let id = sessionStorage.getItem('papercusp-support-session');
    if (!id) {
      id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem('papercusp-support-session', id);
    }
    return id;
  }
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function SupportAgentPanel({ surface = 'operator' }: { surface?: 'public' | 'operator' | 'demo' }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [costUsd, setCostUsd] = useState(0);
  const [budgetCap, setBudgetCap] = useState(0.5);
  const [capExceeded, setCapExceeded] = useState(false);
  const [agentAvailable, setAgentAvailable] = useState<boolean | null>(null);
  const sessionIdRef = useRef<string>('');
  const responseEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sessionIdRef.current = newSessionId();
    // api.papercuspai.com's CORS response doesn't include localhost in
    // Access-Control-Allow-Origin, so the status check fires console
    // errors on every desktop mount. Skip it in dev / on localhost —
    // assume the agent is available; if /v1/support/chat fails on send,
    // the user sees the failure inline.
    const isLocalhost = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|$)/i.test(location.host);
    if (isLocalhost) {
      setAgentAvailable(true);
      return;
    }
    fetch(`${API_BASE}/v1/support/status`)
      .then((r) => r.json())
      .then((s) => {
        setAgentAvailable(!!s.ok);
        if (typeof s.budgetCapUsd === 'number') setBudgetCap(s.budgetCapUsd);
      })
      .catch(() => setAgentAvailable(false));
  }, []);

  useEffect(() => {
    responseEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    setBusy(true);

    try {
      const res = await fetch(`${API_BASE}/v1/support/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionIdRef.current, message: text, surface }),
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => 'request failed');
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: `❌ ${errText}` };
          return copy;
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Parse SSE frames: each is "event: X\ndata: Y\n\n"
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const eventMatch = frame.match(/^event:\s*(.+)$/m);
          const dataMatch = frame.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const event = eventMatch[1].trim();
          let data: unknown;
          try { data = JSON.parse(dataMatch[1]); } catch { data = dataMatch[1]; }
          if (event === 'token' && typeof data === 'string') {
            setMessages((prev) => {
              const copy = [...prev];
              copy[copy.length - 1] = { role: 'assistant', content: copy[copy.length - 1].content + data };
              return copy;
            });
          } else if (event === 'done' && typeof data === 'object' && data) {
            const info = data as { costUsd?: number; capExceeded?: boolean };
            if (typeof info.costUsd === 'number') setCostUsd(info.costUsd);
            if (info.capExceeded) setCapExceeded(true);
          } else if (event === 'error') {
            setMessages((prev) => {
              const copy = [...prev];
              copy[copy.length - 1] = { role: 'assistant', content: `❌ ${typeof data === 'string' ? data : 'agent error'}` };
              return copy;
            });
          }
        }
      }
    } finally {
      setBusy(false);
    }
  };

  if (agentAvailable === false) {
    return null; // Don't render at all when the agent isn't configured
  }

  return (
    <div
      style={{
        marginBottom: 24,
        padding: 20,
        background: 'var(--bg-1)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
          🤖 Try the AI assistant
        </h3>
        <span style={{ fontSize: 11, color: 'var(--fg-mute)', fontFamily: 'monospace' }}>
          ${costUsd.toFixed(4)} / ${budgetCap.toFixed(2)}
        </span>
      </div>
      <p style={{ fontSize: 13, color: 'var(--fg-mute)', margin: '0 0 12px', lineHeight: 1.5 }}>
        Ask anything about Papercusp — install, harness setup, plugins, errors. Powered by Claude over the spec docs. Per-session ${budgetCap.toFixed(2)} cap; falls back to a human if it can't help.
      </p>

      {messages.length > 0 && (
        <div
          style={{
            maxHeight: 320,
            overflowY: 'auto',
            padding: 12,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            marginBottom: 12,
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          {messages.map((m, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: m.role === 'user' ? 'var(--accent)' : 'var(--fg-mute)',
                  textTransform: 'uppercase',
                  marginBottom: 4,
                }}
              >
                {m.role === 'user' ? 'You' : 'Papercusp AI'}
              </div>
              <div style={{ color: 'var(--fg)' }}>
                {m.content
                  ? (m.role === 'assistant'
                      ? <MarkdownPreview value={m.content} outline="left" />
                      : <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>)
                  : (busy && i === messages.length - 1 ? '…' : '')}
              </div>
            </div>
          ))}
          <div ref={responseEndRef} />
        </div>
      )}

      {capExceeded && (
        <div
          style={{
            padding: 10,
            background: 'rgba(255, 165, 0, 0.1)',
            border: '1px solid rgba(255, 165, 0, 0.3)',
            borderRadius: 6,
            fontSize: 12,
            marginBottom: 12,
          }}
        >
          ⚠ Budget cap hit for this session. Refresh the page to start a new one — or click below for a human.
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        style={{ display: 'flex', gap: 8 }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? 'thinking…' : 'How do I set up my first harness?'}
          disabled={busy || capExceeded}
          style={{
            flex: 1,
            padding: '10px 12px',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--fg)',
            fontSize: 14,
          }}
        />
        <Button
          type="submit"
          size="lg"
          variant="accent"
          disabled={busy || !input.trim() || capExceeded}
          style={{ padding: '10px 16px' }}
        >
          {busy ? '…' : 'Ask'}
        </Button>
        <Tooltip label="Talk to a human via Support">
          <Button
            size="lg"
            variant="accent"
            onClick={() => window.dispatchEvent(new CustomEvent('papercusp:open-support'))}
            style={{ padding: '10px 16px', background: 'var(--bg)' }}
            aria-label="Talk to a human via Support"
          >
            👤
          </Button>
        </Tooltip>
      </form>
    </div>
  );
}
