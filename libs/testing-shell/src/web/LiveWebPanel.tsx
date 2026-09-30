/**
 * LiveWebPanel — the customTab for the `live` browser variant
 * (P-003 of testing-shell-platform-variants-2026-06-01).
 *
 * Runs startWebObserver() for the lifetime of the panel and renders the
 * captured console/error/CLS/long-task events. Snapshots the buffer on an
 * interval (the observer mutates an array, which React doesn't track). Pure
 * client; no backend. Mounted by a host via TestingShell `customTabs`.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { startWebObserver, type WebObserver, type WebObserverEvent, type WebObserverEventKind } from './observer';

const KIND_COLOR: Record<WebObserverEventKind, string> = {
  'console-error': 'var(--bad)',
  'console-warn': 'var(--warn)',
  'window-error': 'var(--bad)',
  unhandledrejection: 'var(--bad)',
  // qualitative metric hue for layout-shift events — no semantic token equivalent
  cls: '#a78bfa',
  longtask: 'var(--accent)',
};

export default function LiveWebPanel(): ReactElement {
  const obsRef = useRef<WebObserver | null>(null);
  const [events, setEvents] = useState<WebObserverEvent[]>([]);

  useEffect(() => {
    const obs = startWebObserver();
    obsRef.current = obs;
    const id = setInterval(() => setEvents(obs.events.slice()), 1000);
    return () => {
      clearInterval(id);
      obs.stop();
      obsRef.current = null;
    };
  }, []);

  const clear = () => {
    const obs = obsRef.current;
    if (obs) obs.events.length = 0;
    setEvents([]);
  };

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto', color: 'var(--fg)', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Live (browser)</h2>
        <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
          passive observer — console / window-error / unhandledrejection / CLS / long-tasks in this session
        </span>
        <button
          type="button"
          onClick={clear}
          style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--fg-dim)', fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}
        >
          Clear ({events.length})
        </button>
      </div>
      {events.length === 0 ? (
        <div style={{ background: 'var(--bg-2)', border: '1px dashed var(--border)', borderRadius: 4, padding: 24, color: 'var(--fg-mute)', fontSize: 13 }}>
          No events yet. Interact with the app — console errors/warnings, unhandled errors, layout shifts and long
          tasks will appear here live.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
          {events.map((e, i) => (
            <li key={`${e.ts}-${i}`} style={{ display: 'flex', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ color: KIND_COLOR[e.kind], minWidth: 150 }}>{e.kind}</span>
              <span style={{ color: 'var(--fg-mute)', minWidth: 70 }}>{new Date(e.ts).toLocaleTimeString()}</span>
              <span style={{ color: 'var(--fg-dim)', wordBreak: 'break-all' }}>{e.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
