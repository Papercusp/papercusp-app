/**
 * AiExplorePanel — generic Stagehand LLM-walk UI (Phase 3 of
 * universal-testing-domains-generic-2026-06-03).
 *
 * Ported from the operator's AIExploreTab. Generalized: the run endpoint +
 * defaults are PROPS; the operator-only credential-management UI is dropped
 * (the backend route owns the API key — a missing key comes back as a run
 * error). Self-contained: no import from ../server (that would pull node code
 * into the client bundle); the model menu is an inline default overridable via
 * the `models` prop. Parses the SSE `event: <type>` / `data: <json>` frames
 * that both spawnAiExploreSSE (Hono) and the operator's sseResponse emit.
 */
'use client';
import { useCallback, useRef, useState, type ReactElement } from 'react';

const alpha = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

export interface AiExploreModelOption {
  value: string;
  label: string;
}

export interface AiExplorePanelProps {
  /** POST { goal, startUrl, model, maxSteps, maxCostUsd, headless } → SSE event frames. */
  runEndpoint: string;
  /** Base URL the LLM walk drives (the host's app). */
  defaultStartUrl: string;
  /** Optional seed goal. */
  defaultGoal?: string;
  /** Model menu; defaults to the three Claude models. */
  models?: AiExploreModelOption[];
}

const DEFAULT_PANEL_MODELS: AiExploreModelOption[] = [
  { value: 'anthropic/claude-sonnet-4-6', label: 'Sonnet 4.6 (default)' },
  { value: 'anthropic/claude-haiku-4-5', label: 'Haiku 4.5 (cheaper)' },
  { value: 'anthropic/claude-opus-4-7', label: 'Opus 4.7 (slowest, smartest)' },
];

interface EventEntry { id: number; ts: number; type: string; [k: string]: unknown }

const inputStyle = { background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--fg)', borderRadius: 4, padding: '6px 8px', fontSize: 13 } as const;

export default function AiExplorePanel({ runEndpoint, defaultStartUrl, defaultGoal = '', models = DEFAULT_PANEL_MODELS }: AiExplorePanelProps): ReactElement {
  const [goal, setGoal] = useState(defaultGoal);
  const [startUrl, setStartUrl] = useState(defaultStartUrl);
  const [model, setModel] = useState(models[0]?.value ?? 'anthropic/claude-sonnet-4-6');
  const [maxSteps, setMaxSteps] = useState(20);
  const [maxCostUsd, setMaxCostUsd] = useState(1);
  const [headless, setHeadless] = useState(true);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  const push = useCallback((evt: { type: string; [k: string]: unknown }) => {
    setEvents((cur) => [...cur, { id: ++seqRef.current, ts: Date.now(), ...evt }]);
  }, []);

  const launch = useCallback(async () => {
    if (running || !goal.trim()) return;
    setEvents([]);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(runEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({ goal, startUrl, model, maxSteps, maxCostUsd, headless }),
      });
      if (!res.ok || !res.body) {
        const msg = (await res.text().catch(() => '')) || `HTTP ${res.status}`;
        push({ type: 'error', message: msg });
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      let currentEvent: string | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line === '') { currentEvent = null; continue; }
          if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue; }
          if (line.startsWith('data: ') && currentEvent) {
            try {
              push({ type: currentEvent, ...JSON.parse(line.slice(6)) });
            } catch { /* skip malformed frame */ }
            if (currentEvent === 'done') setRunning(false);
          }
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) push({ type: 'log', level: 'info', line: 'Run aborted by user' });
      else push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [running, goal, startUrl, model, maxSteps, maxCostUsd, headless, runEndpoint, push]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const last = (t: string) => [...events].reverse().find((e) => e.type === t);
  const lastMetrics = last('metrics');
  const lastDone = last('done');
  const lastError = last('error');

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto', color: 'var(--fg)', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>AI Explore</h2>
        <p style={{ fontSize: 12, color: 'var(--fg-dim)', margin: '4px 0 0' }}>
          Stagehand drives Playwright with an LLM picking each action over <code>{startUrl}</code>. A hard cost cap aborts the run.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
          Goal
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} disabled={running} placeholder="e.g. open the first item, switch to a tab, click into a detail view" style={{ ...inputStyle, width: '100%', marginTop: 4, fontFamily: 'inherit', boxSizing: 'border-box' }} />
        </label>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
            Start URL<br /><input type="text" value={startUrl} onChange={(e) => setStartUrl(e.target.value)} disabled={running} style={{ ...inputStyle, width: 260, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
            Model<br />
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={running} style={{ ...inputStyle, marginTop: 4 }}>
              {models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
            Max steps<br /><input type="number" min={1} max={50} value={maxSteps} onChange={(e) => setMaxSteps(Number(e.target.value))} disabled={running} style={{ ...inputStyle, width: 70, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
            Cost cap $<br /><input type="number" min={0.05} max={20} step={0.05} value={maxCostUsd} onChange={(e) => setMaxCostUsd(Number(e.target.value))} disabled={running} style={{ ...inputStyle, width: 80, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12, color: 'var(--fg-dim)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} disabled={running} /> Headless
          </label>
          {!running ? (
            <button type="button" onClick={launch} disabled={!goal.trim()} style={{ background: alpha('var(--accent)', 13), border: `1px solid ${alpha('var(--accent)', 40)}`, color: 'var(--accent)', borderRadius: 4, padding: '6px 14px', cursor: goal.trim() ? 'pointer' : 'not-allowed', fontWeight: 600 }}>Run</button>
          ) : (
            <button type="button" onClick={stop} style={{ background: alpha('var(--bad)', 13), border: `1px solid ${alpha('var(--bad)', 40)}`, color: 'var(--bad)', borderRadius: 4, padding: '6px 14px', cursor: 'pointer', fontWeight: 600 }}>Stop</button>
          )}
        </div>
      </div>

      {(events.length > 0 || running) && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--fg-mute)', marginBottom: 6 }}>
            Live log
            {lastMetrics ? <span> · ${Number(lastMetrics.costUsd ?? 0).toFixed(4)} · {Number(lastMetrics.totalTokens ?? 0).toLocaleString()} tokens</span> : null}
            {lastDone ? <span> · {Math.round(Number(lastDone.totalMs ?? 0) / 1000)}s · {String(lastDone.steps ?? 0)} steps</span> : null}
          </div>
          {lastError ? (
            <div style={{ padding: 8, marginBottom: 8, background: alpha('var(--bad)', 14), border: '1px solid var(--bad)', borderRadius: 4, fontSize: 12, color: 'var(--bad)' }}>
              <strong>error:</strong> {String(lastError.message)}
            </div>
          ) : null}
          <div style={{ maxHeight: 420, overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 11, lineHeight: 1.6, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 4, padding: 8 }}>
            {events.map((e) => {
              const ts = new Date(e.ts).toLocaleTimeString();
              const lead = <span style={{ color: 'var(--fg-mute)' }}>{ts}</span>;
              if (e.type === 'start') return <div key={e.id}>{lead} <span style={{ color: 'var(--good)' }}>start</span> goal: {String(e.goal ?? '')}</div>;
              if (e.type === 'step') return <div key={e.id}>{lead} <span style={{ color: e.ok ? 'var(--good)' : 'var(--bad)' }}>step {String(e.n ?? '')}</span> {String(e.action ?? '')} ({String(e.durationMs ?? '')}ms){e.result ? ` — ${String(e.result)}` : ''}</div>;
              if (e.type === 'metrics') return <div key={e.id}>{lead} <span style={{ color: 'var(--fg-dim)' }}>metrics</span> ${Number(e.costUsd ?? 0).toFixed(4)} · in {Number(e.inputTokens ?? 0).toLocaleString()} · out {Number(e.outputTokens ?? 0).toLocaleString()}</div>;
              if (e.type === 'done') return <div key={e.id}>{lead} <span style={{ color: Number(e.exitCode ?? 0) === 0 ? 'var(--good)' : 'var(--bad)' }}>done</span> {Math.round(Number(e.totalMs ?? 0) / 1000)}s · {String(e.steps ?? 0)} steps · ${Number(e.costUsd ?? 0).toFixed(4)}</div>;
              if (e.type === 'error') return <div key={e.id} style={{ color: 'var(--bad)' }}>{lead} error {String(e.message ?? '')}</div>;
              const level = String(e.level ?? 'info');
              const col = level === 'error' ? 'var(--bad)' : level === 'warn' ? 'var(--warn)' : 'var(--fg-dim)';
              return <div key={e.id}>{lead} <span style={{ color: col }}>{level}</span> {String(e.line ?? '')}</div>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}
