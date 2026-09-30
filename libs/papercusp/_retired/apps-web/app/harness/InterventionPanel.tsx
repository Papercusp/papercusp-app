'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  slug: string;
  alive: boolean;
  onClose: () => void;
}

export default function InterventionPanel({ slug, alive, onClose }: Props) {
  const [notes, setNotes] = useState<string | null>(null);
  const [mtimeMs, setMtimeMs] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const notesRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/notes`).then((r) => r.json());
      setNotes(d.content ?? null);
      setMtimeMs(d.mtimeMs ?? null);
    } catch (e) {
      setToast(`load failed: ${e}`);
    }
  }, [slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // Auto-scroll notes to bottom when content changes
  useEffect(() => {
    if (notesRef.current) notesRef.current.scrollTop = notesRef.current.scrollHeight;
  }, [notes]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) {
      setToast('type a message first');
      setTimeout(() => setToast(null), 2000);
      return;
    }
    setSending(true);
    try {
      const r = await fetch(`/api/harness/${slug}/escalation/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: text, action: 'keep' }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setDraft('');
      setToast('appended to supervisor-notes.md');
      await load();
    } catch (e) {
      setToast(`send failed: ${e}`);
    } finally {
      setSending(false);
      setTimeout(() => setToast(null), 2500);
    }
  }, [draft, slug, load]);

  // Ctrl/Cmd+Enter to send
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        send();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [send]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#0b0e14', border: '1px solid #374151', borderRadius: 6, width: '70vw', maxWidth: 900, height: '75vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong style={{ color: '#e5e7eb' }}>Intervention — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: '0.75rem' }}>.papercusp/supervisor-notes.md</span>
          {alive && (
            <span style={{ color: '#10b981', fontSize: '0.75rem', marginLeft: '0.5rem' }}>
              ● mission running — next orchestrator iteration will read your note
            </span>
          )}
          {toast && (
            <span style={{ marginLeft: 'auto', color: /failed|first/i.test(toast) ? '#f87171' : '#10b981', fontSize: '0.8rem' }}>
              {toast}
            </span>
          )}
          <button
            onClick={onClose}
            style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem', marginLeft: toast ? 0 : 'auto' }}
          >
            close
          </button>
        </div>

        {/* Notes read pane */}
        <div style={{ flex: '1 1 60%', display: 'flex', flexDirection: 'column', minHeight: 0, borderBottom: '1px solid #1f2937' }}>
          <div style={{ fontSize: '0.75rem', color: '#9ca3af', padding: '0.4rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            history
            {mtimeMs && (
              <span style={{ color: '#6b7280' }}>
                · updated {Math.round((Date.now() - mtimeMs) / 1000)}s ago
              </span>
            )}
            <span style={{ marginLeft: 'auto', color: '#6b7280' }}>polls every 5s</span>
          </div>
          <pre
            ref={notesRef}
            style={{ flex: 1, overflow: 'auto', margin: 0, padding: '0.75rem 1rem', fontSize: '0.8rem', fontFamily: 'ui-monospace, monospace', color: '#d1d5db', whiteSpace: 'pre-wrap', background: '#0b0e14' }}
          >
            {notes ?? '(no notes yet — send your first message below to seed supervisor-notes.md)'}
          </pre>
        </div>

        {/* Compose */}
        <div style={{ flex: '0 0 auto', padding: '0.75rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            placeholder="Your message to the orchestrator. Gets appended to supervisor-notes.md with a timestamp. Next iteration will read it as authoritative guidance. (Cmd/Ctrl+Enter to send)"
            style={{
              width: '100%', boxSizing: 'border-box',
              background: '#111827', color: '#e5e7eb',
              border: '1px solid #374151', borderRadius: 3,
              padding: '0.5rem 0.7rem',
              fontSize: '0.85rem',
              fontFamily: 'ui-monospace, monospace',
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span style={{ fontSize: '0.7rem', color: '#6b7280' }}>
              Cmd/Ctrl+Enter to send
            </span>
            <button
              onClick={send}
              disabled={sending || !draft.trim()}
              style={{
                marginLeft: 'auto',
                background: draft.trim() ? '#2563eb' : '#374151',
                color: 'white', border: 'none', borderRadius: 3,
                padding: '0.4rem 0.9rem',
                cursor: sending ? 'wait' : (draft.trim() ? 'pointer' : 'not-allowed'),
                fontWeight: 600, fontSize: '0.85rem',
              }}
            >
              {sending ? 'sending…' : 'append to notes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
