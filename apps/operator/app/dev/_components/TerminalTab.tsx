/**
 * /dev Terminal tab — minimal xterm.js terminal driven by the operator's
 * existing pty API. Doubles as a live exercise of the @papercusp/sse stack:
 *
 *   spawn pty → server pty (node-pty)
 *               ↓
 *               SSE via @papercusp/sse (sseResponse + sink.eventRaw)
 *               ↓
 *               createResilientEventSource here in the browser
 *               ↓
 *               xterm.term.write()
 *
 * Input flows back via POST /pty/<id>/input (batched at rAF).
 *
 * The pty spawn route requires a registered harness slug for path resolution.
 * We piggyback on the first installed project — the dev terminal just needs
 * SOMEWHERE to spawn bash; the project's cwd is fine. Resolved at mount time
 * via /api/installed.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createResilientEventSource } from '@papercusp/sse';
import { useLexicon } from '@/lib/useLexicon';
import '@xterm/xterm/css/xterm.css';

interface PtyHandle {
  id: string;
  pid: number;
  command: string;
}

async function resolveHarnessSlug(): Promise<string | null> {
  try {
    const r = await fetch('/api/installed');
    if (!r.ok) return null;
    const d = (await r.json()) as { projects?: Array<{ slug: string; exists?: boolean }> };
    return d.projects?.find((p) => p.exists !== false)?.slug ?? null;
  } catch { return null; }
}

export default function TerminalTab(): React.JSX.Element {
  const t = useLexicon();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const sourceRef = useRef<{ close: () => void } | null>(null);
  const handleRef = useRef<PtyHandle | null>(null);
  const slugRef = useRef<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'spawning' | 'connecting' | 'live' | 'exited' | 'error'>('idle');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (handleRef.current) return;
    setStatus('spawning');
    setExitCode(null);
    setErrorMsg(null);

    const slug = slugRef.current ?? await resolveHarnessSlug();
    if (!slug) {
      setErrorMsg(`no ${t('pot', { lower: true })} project found — install one from /dev/harnesses first`);
      setStatus('error');
      return;
    }
    slugRef.current = slug;

    const spawnRes = await fetch(`/api/harness/${slug}/pty/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command: 'bash',
        cols: 80,
        rows: 24,
      }),
    }).catch((e) => { setErrorMsg(String(e)); return null; });
    if (!spawnRes) { setStatus('error'); return; }
    if (!spawnRes.ok) {
      setErrorMsg(`spawn failed (${slug}): ${spawnRes.status}`);
      setStatus('error');
      return;
    }
    const handle: PtyHandle = await spawnRes.json();
    handleRef.current = handle;

    // Boot xterm dynamically (SSR-safe).
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]);
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#0d1117', foreground: '#c9d1d9' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (!containerRef.current) return;
    term.open(containerRef.current);
    try { fit.fit(); } catch { /* ignore */ }
    termRef.current = term;
    fitRef.current = fit;

    // Resize sync to server.
    const onResize = () => {
      try { fit.fit(); } catch { /* ignore */ }
      const cols = term.cols, rows = term.rows;
      void fetch(`/api/harness/${slug}/pty/${handle.id}/resize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => { /* best-effort */ });
    };
    const resizeObs = new ResizeObserver(onResize);
    if (containerRef.current) resizeObs.observe(containerRef.current);

    // Batched input.
    let pending = '';
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      if (!pending) return;
      const b64 = btoa(unescape(encodeURIComponent(pending)));
      pending = '';
      void fetch(`/api/harness/${slug}/pty/${handle.id}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: b64 }),
        keepalive: true,
      }).catch(() => { /* best-effort */ });
    };
    term.onData((data) => {
      pending += data;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    });

    // SSE subscribe via @papercusp/sse — proves the full migration end-to-end.
    setStatus('connecting');
    const source = createResilientEventSource({
      url: `/api/harness/${slug}/pty/${handle.id}/stream`,
      handlers: {
        data: (b64) => {
          setStatus('live');
          try {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            term.write(bytes);
          } catch { /* malformed — drop */ }
        },
        exit: (data) => {
          try {
            const payload = JSON.parse(data);
            setExitCode(typeof payload.code === 'number' ? payload.code : 0);
          } catch {
            setExitCode(0);
          }
          setStatus('exited');
          source.close();
        },
      },
      onError: (err) => {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      },
    });
    sourceRef.current = source;

    return () => {
      resizeObs.disconnect();
      source.close();
      try { term.dispose(); } catch { /* ignore */ }
    };
  }, [t]);

  // Auto-start on mount.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void start().then((c) => { cleanup = c; });
    return () => {
      cleanup?.();
      sourceRef.current?.close();
      sourceRef.current = null;
      const h = handleRef.current;
      handleRef.current = null;
      const slug = slugRef.current;
      if (h && slug) {
        void fetch(`/api/harness/${slug}/pty/${h.id}/kill`, { method: 'POST', keepalive: true })
          .catch(() => { /* best-effort */ });
      }
    };
  }, [start]);

  const restart = useCallback(() => {
    const h = handleRef.current;
    handleRef.current = null;
    sourceRef.current?.close();
    sourceRef.current = null;
    termRef.current?.dispose();
    termRef.current = null;
    const slug = slugRef.current;
    if (h && slug) {
      void fetch(`/api/harness/${slug}/pty/${h.id}/kill`, { method: 'POST' })
        .catch(() => { /* best-effort */ });
    }
    void start();
  }, [start]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        fontSize: 11, fontFamily: 'ui-monospace, monospace', color: '#8b949e',
      }}>
        <strong style={{ color: '#c9d1d9' }}>Terminal</strong>
        <span>
          status: <span style={{
            color: status === 'error' ? 'var(--bad)'
              : status === 'live' ? '#3fb950'
              : status === 'exited' ? '#d29922'
              : '#58a6ff',
          }}>{status}</span>
          {exitCode !== null && <> (exit code {exitCode})</>}
        </span>
        {slugRef.current && <span>{t('pot', { lower: true })}: {slugRef.current}</span>}
        {handleRef.current && <span>pid: {handleRef.current.pid}</span>}
        {errorMsg && <span style={{ color: 'var(--bad)' }}>error: {errorMsg}</span>}
        <button
          onClick={restart}
          style={{
            marginLeft: 'auto',
            padding: '2px 8px',
            background: '#21262d',
            color: '#c9d1d9',
            border: '1px solid #30363d',
            borderRadius: 4,
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          restart
        </button>
      </div>
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 240,
          background: '#0d1117',
          padding: 8,
          borderRadius: 4,
        }}
      />
    </div>
  );
}
