/**
 * ChaosWebPanel — the customTab for the `chaos` browser variant
 * (P-005 of testing-shell-platform-variants-2026-06-01).
 *
 * Start/stream/stop UI (mirrors Restart's k6 LoadTestPanel). POSTs to the
 * host's chaos-web spawn endpoint, which runs chaos-runner.mjs and streams its
 * NDJSON back; this panel parses the lines and renders them. The host supplies
 * `runEndpoint` + `baseUrl` when it mounts the panel in TestingShell.customTabs.
 */
import { useRef, useState, type ReactElement } from 'react';

const alpha = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

export interface ChaosWebPanelProps {
  /** Host endpoint that spawns chaos-runner.mjs and streams its NDJSON. */
  runEndpoint: string;
  /** Base URL the chaos run drives (the project's app). */
  baseUrl: string;
  defaultMaxSteps?: number;
}

interface ChaosEvent {
  type: string;
  n?: number;
  action?: string;
  ok?: boolean;
  target?: string;
  note?: string;
  baseUrl?: string;
  maxSteps?: number;
  steps?: number;
  clicks?: number;
  text?: string;
  message?: string;
}

function formatLine(json: string): string {
  let e: ChaosEvent;
  try {
    e = JSON.parse(json) as ChaosEvent;
  } catch {
    return json;
  }
  switch (e.type) {
    case 'start': return `▶ start ${e.baseUrl} (${e.maxSteps} steps)`;
    case 'step': return `#${e.n} ${e.action} ${e.ok ? '✓' : '✗'} ${e.target ?? ''}${e.note ? ` — ${e.note}` : ''}`;
    case 'done': return `✓ done — ${e.clicks} clicks / ${e.steps} steps`;
    case 'console': return `! console.error: ${e.text ?? ''}`;
    case 'pageerror': return `! pageerror: ${e.message ?? ''}`;
    case 'crash': return '✗ PAGE CRASH';
    case 'dialog': return `! dialog: ${e.message ?? ''}`;
    case 'error': return `✗ error: ${e.message ?? ''}`;
    default: return json;
  }
}

function lineColor(line: string): string {
  if (line.startsWith('✗') || line.startsWith('!')) return 'var(--bad)';
  if (line.startsWith('✓')) return 'var(--good)';
  if (line.startsWith('▶')) return 'var(--accent)';
  return 'var(--fg-dim)';
}

export default function ChaosWebPanel({ runEndpoint, baseUrl, defaultMaxSteps = 25 }: ChaosWebPanelProps): ReactElement {
  const [running, setRunning] = useState(false);
  const [maxSteps, setMaxSteps] = useState(defaultMaxSteps);
  const [lines, setLines] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const start = async () => {
    setLines([]);
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(runEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl, maxSteps }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        setLines((l) => [...l, `✗ error: HTTP ${res.status}`]);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        const formatted = parts.map((p) => p.trim()).filter(Boolean).map(formatLine);
        if (formatted.length) setLines((l) => [...l, ...formatted]);
      }
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setLines((l) => [...l, `✗ error: ${String(e)}`]);
    } finally {
      setRunning(false);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  return (
    <div style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column', color: 'var(--fg)', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Chaos (browser)</h2>
        <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}>autonomous clicker over <code>{baseUrl}</code></span>
        <label style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--fg-dim)' }}>
          steps{' '}
          <input
            type="number"
            min={1}
            max={200}
            value={maxSteps}
            disabled={running}
            onChange={(e) => setMaxSteps(Number(e.target.value) || 1)}
            style={{ width: 64, background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--fg)', borderRadius: 4, padding: '4px 6px' }}
          />
        </label>
        {running ? (
          <button type="button" onClick={stop} style={{ background: alpha('var(--bad)', 13), border: `1px solid ${alpha('var(--bad)', 40)}`, color: 'var(--bad)', borderRadius: 4, padding: '6px 12px', cursor: 'pointer' }}>Stop</button>
        ) : (
          <button type="button" onClick={start} style={{ background: alpha('var(--accent)', 13), border: `1px solid ${alpha('var(--accent)', 40)}`, color: 'var(--accent)', borderRadius: 4, padding: '6px 12px', cursor: 'pointer' }}>Run</button>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 4, padding: 12, fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.6 }}>
        {lines.length === 0 ? (
          <span style={{ color: 'var(--fg-mute)' }}>No run yet. Click Run to drive {baseUrl} and look for console errors / crashes.</span>
        ) : (
          lines.map((line, i) => (
            <div key={i} style={{ color: lineColor(line), whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line}</div>
          ))
        )}
      </div>
    </div>
  );
}
