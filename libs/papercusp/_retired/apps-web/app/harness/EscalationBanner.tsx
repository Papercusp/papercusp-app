'use client';

import { useCallback, useEffect, useState } from 'react';

interface EscalationPayload {
  escalation: string | null;
  supervisorNotes: string | null;
  mtimeMs: number | null;
}

interface Props {
  slug: string;
  escalated: boolean;
  onResumed: () => void;
}

export default function EscalationBanner({ slug, escalated, onResumed }: Props) {
  const [payload, setPayload] = useState<EscalationPayload | null>(null);
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState<null | 'respond' | 'clear' | 'keep'>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);

  useEffect(() => {
    if (!escalated) {
      setPayload(null);
      setResponse('');
      setToast(null);
      return;
    }
    fetch(`/api/harness/${slug}/escalation`)
      .then((r) => r.json())
      .then((d) => setPayload(d))
      .catch((e) => setToast(`load failed: ${e}`));
  }, [escalated, slug]);

  const resolve = useCallback(async (action: 'clear' | 'keep') => {
    if (busy) return;
    setBusy(action === 'clear' ? 'clear' : 'keep');
    try {
      const r = await fetch(`/api/harness/${slug}/escalation/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response, action }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      if (action === 'clear') {
        const resume = await fetch(`/api/harness/${slug}/resume`, { method: 'POST' });
        if (!resume.ok) throw new Error(`resume: ${resume.status}`);
        setToast('responded & resumed');
        setResponse('');
        setPayload(null);
        onResumed();
      } else {
        const d = await r.json();
        setPayload((prev) => prev ? { ...prev, supervisorNotes: d.supervisorNotes } : prev);
        setToast('note saved');
        setResponse('');
      }
    } catch (e) {
      setToast(`error: ${e}`);
    } finally {
      setBusy(null);
      setTimeout(() => setToast(null), 2500);
    }
  }, [busy, slug, response, onResumed]);

  const respondAndResume = useCallback(() => {
    if (!response.trim()) {
      setToast('type a response first, or use "clear without responding"');
      setTimeout(() => setToast(null), 2500);
      return;
    }
    resolve('clear');
  }, [response, resolve]);

  const clearWithoutResponse = useCallback(async () => {
    if (busy) return;
    if (!confirm('Clear escalation.md without leaving a note and resume the run?')) return;
    setBusy('clear');
    try {
      const r = await fetch(`/api/harness/${slug}/escalation/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: '', action: 'clear' }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const resume = await fetch(`/api/harness/${slug}/resume`, { method: 'POST' });
      if (!resume.ok) throw new Error(`resume: ${resume.status}`);
      setToast('cleared & resumed');
      setPayload(null);
      onResumed();
    } catch (e) {
      setToast(`error: ${e}`);
    } finally {
      setBusy(null);
      setTimeout(() => setToast(null), 2500);
    }
  }, [busy, slug, onResumed]);

  if (!escalated || !payload || !payload.escalation) return null;

  return (
    <div style={{
      background: '#451a03',
      border: '1px solid #b45309',
      borderLeft: '4px solid #f59e0b',
      borderRadius: 4,
      padding: '0.75rem 1rem',
      marginBottom: '1rem',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
        <span style={{ color: '#fbbf24', fontWeight: 700, fontSize: '0.85rem' }}>⚠ ESCALATION — mission halted, awaiting human</span>
        {payload.mtimeMs && (
          <span style={{ color: '#d97706', fontSize: '0.75rem' }}>
            raised {Math.round((Date.now() - payload.mtimeMs) / 60_000)}m ago
          </span>
        )}
        {toast && (
          <span style={{ marginLeft: 'auto', color: /error|failed/i.test(toast) ? '#fca5a5' : '#a7f3d0', fontSize: '0.75rem' }}>
            {toast}
          </span>
        )}
      </div>

      <pre style={{
        background: '#1c0f02',
        color: '#fde68a',
        padding: '0.5rem 0.75rem',
        borderRadius: 3,
        margin: '0 0 0.5rem 0',
        fontSize: '0.8rem',
        fontFamily: 'ui-monospace, monospace',
        whiteSpace: 'pre-wrap',
        maxHeight: '20vh',
        overflow: 'auto',
      }}>
        {payload.escalation}
      </pre>

      {payload.supervisorNotes && (
        <div style={{ marginBottom: '0.5rem' }}>
          <button
            onClick={() => setShowNotes((v) => !v)}
            style={{ background: 'transparent', color: '#fbbf24', border: 'none', cursor: 'pointer', fontSize: '0.75rem', padding: 0 }}
          >
            {showNotes ? '▾' : '▸'} supervisor-notes.md ({payload.supervisorNotes.length.toLocaleString()} chars)
          </button>
          {showNotes && (
            <pre style={{
              background: '#1c1917',
              color: '#d6d3d1',
              padding: '0.5rem 0.75rem',
              borderRadius: 3,
              margin: '0.25rem 0 0 0',
              fontSize: '0.75rem',
              fontFamily: 'ui-monospace, monospace',
              whiteSpace: 'pre-wrap',
              maxHeight: '15vh',
              overflow: 'auto',
            }}>
              {payload.supervisorNotes.slice(-2048)}
            </pre>
          )}
        </div>
      )}

      <textarea
        value={response}
        onChange={(e) => setResponse(e.target.value)}
        placeholder="Your response — will be appended to supervisor-notes.md as the authoritative guidance for the next orchestrator/planner iteration."
        rows={4}
        style={{
          width: '100%',
          background: '#1c0f02',
          color: '#fde68a',
          border: '1px solid #78350f',
          borderRadius: 3,
          padding: '0.5rem',
          fontSize: '0.8rem',
          fontFamily: 'ui-monospace, monospace',
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', alignItems: 'center' }}>
        <button
          onClick={respondAndResume}
          disabled={!!busy}
          style={{
            background: busy === 'clear' ? '#92400e' : '#b45309',
            color: 'white',
            border: '1px solid #d97706',
            borderRadius: 3,
            padding: '0.4rem 0.9rem',
            cursor: busy ? 'wait' : 'pointer',
            fontSize: '0.8rem',
            fontWeight: 600,
          }}
        >
          {busy === 'clear' ? '…' : '↻ respond & resume'}
        </button>
        <button
          onClick={() => resolve('keep')}
          disabled={!!busy || !response.trim()}
          style={{
            background: 'transparent',
            color: '#fbbf24',
            border: '1px solid #78350f',
            borderRadius: 3,
            padding: '0.4rem 0.9rem',
            cursor: busy || !response.trim() ? 'not-allowed' : 'pointer',
            fontSize: '0.8rem',
            opacity: !response.trim() ? 0.5 : 1,
          }}
          title="Save note to supervisor-notes.md without clearing escalation (add more context before resuming)"
        >
          {busy === 'keep' ? '…' : 'save note only'}
        </button>
        <button
          onClick={clearWithoutResponse}
          disabled={!!busy}
          style={{
            background: 'transparent',
            color: '#a8a29e',
            border: '1px solid #44403c',
            borderRadius: 3,
            padding: '0.4rem 0.9rem',
            cursor: busy ? 'wait' : 'pointer',
            fontSize: '0.75rem',
            marginLeft: 'auto',
          }}
          title="Emergency: clear escalation.md and resume without leaving a note"
        >
          clear without responding
        </button>
      </div>
    </div>
  );
}
