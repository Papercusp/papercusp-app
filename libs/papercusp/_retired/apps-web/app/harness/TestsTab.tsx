'use client';

import { useCallback, useEffect, useState } from 'react';
import { Play, RefreshCw, Check, X, Minus } from 'lucide-react';
import { toast } from 'sonner';

interface TestItem {
  id: string;
  summary: string;
  file: string;
  framework: 'playwright' | 'vitest' | 'pytest';
  coversVALs: string[];
  status: 'passing' | 'failing' | 'skipped' | 'not_run';
  lastRunTs: number;
  durationMs: number;
  phase: 'staging' | 'testing' | 'production';
  kind?: 'contract' | 'edge';
}

interface Props {
  slug: string;
  phase: 'staging' | 'testing' | 'production';
}

const STATUS_ICON = {
  passing: <Check size={11} style={{ color: '#10b981' }} />,
  failing: <X size={11} style={{ color: '#ef4444' }} />,
  skipped: <Minus size={11} style={{ color: '#9ca3af' }} />,
  not_run: <Minus size={11} style={{ color: '#4b5563' }} />,
};

function fmtAgo(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts * 1000;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export default function TestsTab({ slug, phase }: Props) {
  const [tests, setTests] = useState<TestItem[]>([]);
  const [running, setRunning] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/tests?phase=${phase}`).then((r) => r.json());
      setTests(d.tests ?? []);
    } catch {}
  }, [slug, phase]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const runOne = async (id: string) => {
    setRunning((s) => new Set(s).add(id));
    try {
      const res = await fetch(`/api/harness/${slug}/tests/${id}/run?phase=${phase}`, { method: 'POST' });
      const body = await res.json();
      if (body.ok) toast.success(`${id} passed`);
      else toast.error(`${id} failed — click for output`);
      load();
    } catch (e: any) {
      toast.error(`Run failed: ${e.message ?? e}`);
    } finally {
      setRunning((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  if (tests.length === 0) {
    return (
      <div style={{ padding: 20, color: 'var(--fg-dim)', fontSize: 12, textAlign: 'center' }}>
        {phase === 'staging'
          ? 'Tests are generated in the testing phase. Promote staging → testing to begin.'
          : 'No tests yet. The tester agent generates them from the validation contract.'}
      </div>
    );
  }

  const passCount = tests.filter((t) => t.status === 'passing').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        padding: '6px 10px',
        display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: '1px solid var(--border)',
        fontSize: 11, flexShrink: 0,
      }}>
        <span style={{ color: 'var(--fg)' }}><b>{passCount}</b> / {tests.length} passing</span>
        <span style={{ marginLeft: 'auto' }}>
          <button
            onClick={() => tests.forEach((t) => runOne(t.id))}
            style={{
              fontSize: 10, padding: '2px 8px',
              background: 'var(--accent, #5e6ad2)', color: 'white', border: 'none', borderRadius: 3,
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          ><Play size={10} /> run all</button>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {tests.map((t) => {
          const isRunning = running.has(t.id);
          return (
            <div key={t.id} style={{
              display: 'grid',
              gridTemplateColumns: 'auto auto minmax(0,1fr) auto auto',
              alignItems: 'center', gap: 8,
              padding: '6px 10px',
              borderBottom: '1px solid color-mix(in oklab, var(--border), transparent 50%)',
              fontSize: 11,
            }}>
              {isRunning ? <RefreshCw size={11} className="h-spin" /> : STATUS_ICON[t.status]}
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: 'var(--fg-dim)' }}>
                {t.id}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.file}>
                  {t.summary}
                </div>
                <div style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                  {t.framework} · {t.coversVALs.join(', ') || 'no VAL link'}
                  {t.kind === 'edge' && <span style={{ color: '#a855f7', marginLeft: 4 }}>[edge]</span>}
                </div>
              </div>
              <span style={{ fontSize: 10, color: 'var(--fg-dim)', fontFamily: 'ui-monospace, monospace' }}>
                {t.lastRunTs ? fmtAgo(t.lastRunTs) : '—'}
                {t.durationMs ? ` · ${t.durationMs}ms` : ''}
              </span>
              <button
                onClick={() => runOne(t.id)}
                disabled={isRunning}
                style={{
                  fontSize: 10, padding: '2px 6px',
                  background: 'transparent', color: 'var(--fg-dim)',
                  border: '1px solid var(--border)', borderRadius: 3,
                  cursor: isRunning ? 'not-allowed' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 2,
                }}
                title="Re-run this test"
              >
                {isRunning ? '…' : 'run'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
