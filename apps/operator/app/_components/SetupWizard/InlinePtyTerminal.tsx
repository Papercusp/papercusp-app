'use client';

/**
 * InlinePtyTerminal — small xterm.js panel wired to a Tauri-native pty.
 *
 * Used by the Setup Wizard's install + sign-in steps to show real
 * terminal output (ANSI colors, progress bars, OAuth URLs) without
 * popping out an external terminal. Only renders when running inside
 * the Tauri webview — the parent decides what to show as fallback.
 *
 * Read-write: user keystrokes are forwarded to the pty (needed for
 * sign-in flows that prompt for confirmation). Set `readOnly` to
 * disable input.
 */
import { useEffect, useRef, useState } from 'react';
import { commands } from '@papercusp/operator-core/lib/tauri-bindings';
import { isTauriNative } from '@papercusp/operator-core/lib/pty-tauri';

type TauriListenFn = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

interface WindowWithTauri extends Window {
  __TAURI__?: { event?: { listen: TauriListenFn } };
}

export interface InlinePtyTerminalProps {
  /** Binary to spawn (`bash`, `powershell.exe`, `claude`, `omp`, …). */
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string | null;
  readonly env?: Record<string, string>;
  readonly readOnly?: boolean;
  readonly rows?: number;
  readonly cols?: number;
  /**
   * Fired when the pty exits. Receives the exit code. Use this to
   * trigger detection refresh (e.g. did the install succeed?).
   *
   * The callback is captured in a ref, so changing its identity does
   * NOT respawn the pty.
   */
  readonly onExit?: (code: number) => void;
  /**
   * Fired when the pty could not be spawned at all (or its event
   * channel failed to attach). Without this the parent's "running"
   * state sticks forever — the wizard sat on "Installing…" with a
   * dead pane (found live 2026-06-12). Captured in a ref like onExit.
   */
  readonly onSpawnError?: (message: string) => void;
  /**
   * Text shown — with a small spinner — centered over the empty pane until
   * the pty writes its first byte, so a slow-to-start, sign-in-gated, or
   * network-waiting command never reads as a dead black box (the
   * "blank setup terminal" report, WI-2934). Defaults to "Starting…".
   */
  readonly placeholder?: string;
}

function base64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(new ArrayBuffer(0));
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(s);
}

/**
 * The pane shows the placeholder until the pty produces its first byte — and
 * stops once there's output, a spawn/attach error, or the process has exited.
 * Pure + exported so every show/hide branch is unit-tested WITHOUT booting
 * xterm in jsdom (its dynamic import is not reliably mockable under vitest —
 * see TerminalTab.test.tsx).
 */
export function shouldShowPtyPlaceholder(s: {
  hasOutput: boolean;
  error: string | null;
  exitedCode: number | null;
}): boolean {
  return !s.hasOutput && !s.error && s.exitedCode === null;
}

/**
 * True iff the chunk contains bytes beyond the Windows ConPTY init
 * handshake `\x1b[6n` (cursor-position query). On Windows, portable_pty's
 * ConPTY emits that quad before the child writes anything — and when
 * wsl.exe wedges under ConPTY it is the ONLY thing ever emitted (WI-3033),
 * so counting it as output hid the placeholder over a permanently dead
 * pane. Mirrors pty.rs `contains_real_output`, which keeps the Rust-side
 * silent-wedge watchdog armed through the same bytes. Pure + exported for
 * unit tests (same rationale as shouldShowPtyPlaceholder above).
 */
export function chunkHasRealOutput(bytes: Uint8Array): boolean {
  let i = 0;
  while (
    i + 4 <= bytes.length &&
    bytes[i] === 0x1b &&
    bytes[i + 1] === 0x5b &&
    bytes[i + 2] === 0x36 &&
    bytes[i + 3] === 0x6e
  ) {
    i += 4;
  }
  return i < bytes.length;
}

export function InlinePtyTerminal(props: InlinePtyTerminalProps) {
  const { command, args, cwd, env, readOnly = false, rows = 20, cols = 100, onExit, onSpawnError, placeholder = 'Starting…' } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onExitRef = useRef(onExit);
  const onSpawnErrorRef = useRef(onSpawnError);
  const [error, setError] = useState<string | null>(null);
  const [exitedCode, setExitedCode] = useState<number | null>(null);
  // False until the pty writes its first byte — drives the placeholder so the
  // pane is never a blank black box while a slow or sign-in-gated command spins
  // up (WI-2934). The ref mirror avoids a setState on every subsequent pty-data
  // event and a stale-closure read inside the listener.
  const [hasOutput, setHasOutput] = useState(false);
  const hasOutputRef = useRef(false);

  // Keep latest callbacks accessible without making useEffect respawn.
  useEffect(() => { onExitRef.current = onExit; }, [onExit]);
  useEffect(() => { onSpawnErrorRef.current = onSpawnError; }, [onSpawnError]);

  useEffect(() => {
    if (!isTauriNative() || !containerRef.current) return;
    const container = containerRef.current;

    // Re-arm the placeholder for this (re)spawn.
    hasOutputRef.current = false;
    setHasOutput(false);

    /** Set as soon as ptySpawn resolves successfully. Used by cleanup
     *  to kill the pty even if cleanup races ahead of the post-spawn
     *  bookkeeping below. */
    let liveId: string | null = null;
    let cancelled = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let ro: ResizeObserver | null = null;
    let disposeTerm: (() => void) | null = null;

    void (async () => {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      const { WebLinksAddon } = await import('@xterm/addon-web-links');
      await import('@xterm/xterm/css/xterm.css');

      const term = new Terminal({
        rows,
        cols,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        theme: { background: '#101418' },
        scrollback: 5000,
        convertEol: true,
        disableStdin: readOnly,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon((_, url) => window.open(url, '_blank')));

      if (cancelled) { term.dispose(); return; }
      term.open(container);
      try { fit.fit(); } catch { /* container not yet measured */ }
      disposeTerm = () => term.dispose();

      const spawnRes = await commands.ptySpawn({
        command,
        args: args ? [...args] : [],
        cwd: cwd ?? null,
        env: env ?? {},
        cols: term.cols,
        rows: term.rows,
      });
      if (spawnRes.status === 'error') {
        setError(spawnRes.error);
        term.writeln(`\r\n\x1b[31mspawn error: ${spawnRes.error}\x1b[0m`);
        onSpawnErrorRef.current?.(spawnRes.error);
        return;
      }
      const id = spawnRes.data.id;
      if (cancelled) {
        // Cleanup raced ahead of the spawn — kill what we just created.
        void commands.ptyKill(id);
        return;
      }
      liveId = id;

      const w = window as WindowWithTauri;
      const listen = w.__TAURI__?.event?.listen;
      if (!listen) {
        setError('Tauri event.listen unavailable');
        void commands.ptyKill(id);
        liveId = null;
        onSpawnErrorRef.current?.('Tauri event.listen unavailable');
        return;
      }
      unlistenData = await listen<{ id: string; data: string }>('pty-data', (ev) => {
        if (ev.payload.id !== id) return;
        const bytes = base64ToBytes(ev.payload.data);
        // Only REAL child output reveals the terminal — the bare ConPTY
        // handshake must keep the placeholder up (WI-3033, see
        // chunkHasRealOutput). Every byte is still written to xterm.
        if (!hasOutputRef.current && chunkHasRealOutput(bytes)) {
          hasOutputRef.current = true;
          setHasOutput(true); // first real byte → reveal terminal, hide placeholder
        }
        term.write(bytes);
      });
      unlistenExit = await listen<{ id: string; code: number }>('pty-exit', (ev) => {
        if (ev.payload.id !== id) return;
        setExitedCode(ev.payload.code);
        term.writeln(
          `\r\n\x1b[${ev.payload.code === 0 ? '32' : '31'}m[process exited with code ${ev.payload.code}]\x1b[0m`,
        );
        liveId = null; // process already gone — don't double-kill in cleanup
        onExitRef.current?.(ev.payload.code);
      });

      if (cancelled) {
        // Cleanup raced ahead of listener setup too.
        try { unlistenData?.(); } catch { /* */ }
        try { unlistenExit?.(); } catch { /* */ }
        void commands.ptyKill(id);
        liveId = null;
        return;
      }

      if (!readOnly) {
        term.onData((data) => {
          if (!liveId) return;
          const bytes = new TextEncoder().encode(data);
          void commands.ptyWrite(liveId, bytesToBase64(bytes));
        });
      }

      ro = new ResizeObserver(() => {
        if (!liveId) return;
        try {
          fit.fit();
          void commands.ptyResize(liveId, term.cols, term.rows);
        } catch { /* ignore */ }
      });
      ro.observe(container);
    })().catch((e) => {
      const msg = String(e?.message ?? e);
      setError(msg);
      onSpawnErrorRef.current?.(msg);
    });

    return () => {
      cancelled = true;
      try { ro?.disconnect(); } catch { /* */ }
      try { unlistenData?.(); } catch { /* */ }
      try { unlistenExit?.(); } catch { /* */ }
      if (liveId) {
        void commands.ptyKill(liveId);
        liveId = null;
      }
      try { disposeTerm?.(); } catch { /* */ }
    };
    // `onExit` deliberately omitted — captured in onExitRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, args, cwd, env, readOnly, rows, cols]);

  if (!isTauriNative()) return null;

  const showPlaceholder = shouldShowPtyPlaceholder({ hasOutput, error, exitedCode });

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ position: 'relative' }}>
        <div
          ref={containerRef}
          style={{
            background: '#101418',
            borderRadius: 6,
            padding: 8,
            height: rows * 16 + 16,
            overflow: 'hidden',
          }}
        />
        {showPlaceholder && (
          <div
            aria-live="polite"
            data-testid="inline-pty-placeholder"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              // Never intercept keystrokes meant for the (already-focused)
              // terminal underneath — interactive sign-in flows can accept
              // input before the first byte is echoed back.
              pointerEvents: 'none',
              color: 'var(--fg-mute, #9a9aa3)',
              fontSize: 13,
              fontFamily: 'system-ui, sans-serif',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 14,
                height: 14,
                border: '2px solid currentColor',
                borderTopColor: 'transparent',
                borderRadius: '50%',
                animation: 'inline-pty-spin 0.7s linear infinite',
              }}
            />
            <span>{placeholder}</span>
            <style>{`@keyframes inline-pty-spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        )}
      </div>
      {error && (
        <p style={{ marginTop: 6, color: 'var(--bad, #d33)', fontSize: 12 }}>
          {error}
        </p>
      )}
      {exitedCode !== null && (
        <p style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
          Process exited with code {exitedCode}.
        </p>
      )}
    </div>
  );
}
