'use client';

import { useCallback, useEffect, useState } from 'react';

interface SmokeResult {
  url: string;
  expectStatus: number;
  actualStatus: string;
  ok: boolean;
  reason: string;
  bodyHead: string;
}

interface SmokeData {
  status: 'pass' | 'fail' | 'unknown';
  mtimeMs: number | null;
  pass: string | null;
  failure: string | null;
  results: SmokeResult[] | null;
  startupLog: string | null;
}

interface Props {
  slug: string;
  onClose: () => void;
}

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function SmokeTestPanel({ slug, onClose }: Props) {
  const [data, setData] = useState<SmokeData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runOutput, setRunOutput] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${slug}/smoke-test`);
      if (!r.ok) throw new Error(`${r.status}`);
      setData(await r.json());
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, [slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const runNow = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setRunOutput('Running…');
    try {
      const r = await fetch(`/api/harness/${slug}/smoke-test/run`, { method: 'POST' });
      const d = await r.json();
      setRunOutput(d.output ?? '(no output)');
      await load();
    } catch (e) {
      setRunOutput(`error: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [slug, busy, load]);

  const tone = data?.status === 'pass' ? '#10b981' : data?.status === 'fail' ? '#f87171' : '#9ca3af';

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#0b0e14', border: '1px solid #374151', borderRadius: 6, width: '80vw', maxWidth: 1000, height: '75vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: '#e5e7eb' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Smoke test — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: '0.75rem' }}>bin/service-smoke-test.sh</span>
          {data && (
            <span style={{
              fontSize: '0.75rem', padding: '0.15rem 0.55rem',
              border: `1px solid ${tone}`, color: tone, borderRadius: 3,
              textTransform: 'uppercase', fontWeight: 600,
            }}>
              {data.status}
            </span>
          )}
          {data?.mtimeMs && <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{fmtTs(data.mtimeMs)}</span>}
          <button
            onClick={runNow}
            disabled={busy}
            style={{
              marginLeft: 'auto',
              background: '#3b82f6', color: 'white', border: 'none',
              padding: '0.35rem 0.85rem', borderRadius: 3,
              cursor: busy ? 'wait' : 'pointer', fontSize: '0.8rem', fontWeight: 600,
            }}
          >
            {busy ? 'running…' : '▶ Run now'}
          </button>
          <button onClick={onClose} style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}>close</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
          {err && <div style={{ color: '#f87171', marginBottom: 12 }}>err: {err}</div>}

          {data?.results && data.results.length > 0 && (
            <section style={{ marginBottom: 18 }}>
              <div style={{ fontSize: '0.7rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                URL checks ({data.results.filter((r) => r.ok).length}/{data.results.length} passed)
              </div>
              <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#9ca3af', borderBottom: '1px solid #1f2937' }}>
                    <th style={{ padding: '0.3rem 0.5rem' }}>URL</th>
                    <th style={{ padding: '0.3rem 0.5rem' }}>Expected</th>
                    <th style={{ padding: '0.3rem 0.5rem' }}>Actual</th>
                    <th style={{ padding: '0.3rem 0.5rem' }}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #1f2937' }}>
                      <td style={{ padding: '0.3rem 0.5rem', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                        <span style={{ marginRight: 6, color: r.ok ? '#10b981' : '#f87171' }}>{r.ok ? '✓' : '✗'}</span>
                        {r.url}
                      </td>
                      <td style={{ padding: '0.3rem 0.5rem', fontFamily: 'monospace', color: '#9ca3af' }}>{r.expectStatus}</td>
                      <td style={{ padding: '0.3rem 0.5rem', fontFamily: 'monospace', color: r.ok ? '#10b981' : '#f87171' }}>{r.actualStatus}</td>
                      <td style={{ padding: '0.3rem 0.5rem', color: '#d1d5db', fontSize: '0.75rem' }}>{r.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {data?.failure && (
            <section style={{ marginBottom: 18 }}>
              <div style={{ fontSize: '0.7rem', color: '#f87171', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Failure report</div>
              <pre style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 3, padding: '0.75rem', margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', whiteSpace: 'pre-wrap', color: '#fde68a' }}>
                {data.failure}
              </pre>
            </section>
          )}

          {data?.pass && !data?.failure && (
            <section style={{ marginBottom: 18 }}>
              <div style={{ fontSize: '0.7rem', color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Last pass</div>
              <pre style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 3, padding: '0.75rem', margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', whiteSpace: 'pre-wrap', color: '#d1d5db' }}>
                {data.pass}
              </pre>
            </section>
          )}

          {runOutput && (
            <section style={{ marginBottom: 18 }}>
              <div style={{ fontSize: '0.7rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Last manual run</div>
              <pre style={{ background: '#000', border: '1px solid #1f2937', borderRadius: 3, padding: '0.75rem', margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: '0.7rem', whiteSpace: 'pre-wrap', color: '#d1d5db', maxHeight: 240, overflow: 'auto' }}>
                {runOutput}
              </pre>
            </section>
          )}

          {data?.status === 'unknown' && !runOutput && (
            <div style={{ color: '#9ca3af', fontStyle: 'italic', fontSize: '0.85rem' }}>
              No smoke test has run yet. Enable <code style={{ color: '#fde68a' }}>smokeTest.enabled</code> in config and configure URLs, or click <strong>Run now</strong>.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
