'use client';

/**
 * PiPanel — embedded oh-my-pi (omp) terminal pane.
 *
 * Mounts an xterm.js terminal connected to an EventSource SSE stream from
 * `/api/harness/:slug/pty/:id/stream`. User keystrokes POST back to
 * `/api/harness/:slug/pty/:id/input`. Resize on container change.
 *
 * Lifecycle:
 *   - On mount: POST /spawn → record id → open SSE → wire xterm.
 *   - On unmount or slug/laneId change: POST /kill, close SSE.
 *   - On exit event from the server: render an "exited" banner; user can
 *     click Restart to spawn fresh.
 *
 * NOT a client of node-pty directly — that runs in the sidecar. This is a
 * pure browser-side component.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { createResilientEventSource } from '@papercusp/sse';
import { useQueryState, parseAsBoolean } from 'nuqs';
import '@xterm/xterm/css/xterm.css';
import { Loader2 } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { isTauriNative, openNativeSession, type NativeSession } from '@papercusp/operator-core/lib/pty-tauri';
import './PiPanel.css';
// xterm packages reference `self` at module-load (WebGL context probe,
// canvas factory). Static-importing them breaks Next.js SSR — even
// inside a 'use client' file, the SSR pass evaluates dependencies at
// import time. We dynamically import inside the useEffect below where
// `window` is guaranteed.

/**
 * Resolve the pty WebSocket URL for a given pty id, or null if the
 * server-side WS path isn't available (PAPERCUSP_PTY_WS=0, or we're
 * embedded in a context that doesn't expose it).
 *
 * The port is paged through to the client at build time via NEXT_PUBLIC_*
 * but we also accept a runtime-injected `window.__PAPERCUSP_PTY_WS__` so
 * the desktop sidecar can override (e.g. when the operator is running on
 * a randomized Tauri-allocated port). When neither is set, we default to
 * the development port 3056 alongside the operator's :3055.
 */
export function ptyWsUrlForId(id: string): string | null {
  if (typeof window === 'undefined') return null;
  type WindowWithPtyWs = Window & {
    __PAPERCUSP_PTY_WS__?: string | null;
    __PAPERCUSP_TAURI__?: { kind: 'native'; spawn: unknown };
  };
  const w = window as WindowWithPtyWs;
  // E. Tauri native pty present? PiPanel detects this and avoids WS entirely.
  //
  // ⚠ This is a TRANSPORT selector, NOT a "terminals are disabled in the
  // desktop" switch — returning null here means "don't use a WebSocket", and
  // the caller then takes the strictly MORE capable native path (see
  // `useNative` below: openNativeSession → Tauri IPC → pty.rs, which is fully
  // wired end-to-end). Misread as a feature-disable it produced WI-7546
  // ("PTY is disabled in the Tauri shell"), which is refuted; don't re-file it.
  //
  // Why the desktop has no xterm terminal PANE at all is a separate and
  // deliberate matter: owner plan `native-terminal-desktop-2026-06-06` P-009
  // (done) retired the xterm.js desktop-terminal path — the desktop terminal
  // is a glued NATIVE sibling window (`pui chat`), never a dockview pane.
  // A guard test enforces it: dock-layouts.test.ts "GUARD: seeds NO terminal
  // pane". Do not reintroduce xterm.js as the desktop terminal.
  //
  // NOTE this branch is belt-and-braces, not the load-bearing one: measured
  // live in the desktop webview 2026-08-03, `__PAPERCUSP_TAURI__` was absent
  // (the main.rs init-script inject had not landed / been re-applied), so the
  // null actually came from the `:3055` port check below. `isTauriNative()`
  // was still true, so the native path was selected regardless.
  if (w.__PAPERCUSP_TAURI__?.kind === 'native') return null;
  const override = w.__PAPERCUSP_PTY_WS__;
  if (override === null) return null; // explicit opt-out
  const buildEnv = process.env.NEXT_PUBLIC_PAPERCUSP_PTY_WS;
  const explicit = (override && typeof override === 'string') ? override : buildEnv;
  if (!explicit) {
    // No configured WS endpoint. The default "operator:3055 + pty-ws:3056"
    // pairing only works when the operator is actually on :3055. When the
    // user has multiple operator processes (e.g. dev :3055 + prod :3070)
    // they share host but only one binds :3056 — the other process owns
    // its own pty handles and can't reach them via WS. Connecting to the
    // wrong process's WS gets a 101 + immediate close ("unknown route"),
    // which the reconnect loop happily retries forever. Skip WS entirely
    // unless we're actually on :3055 (or it's been explicitly configured)
    // and let SSE handle data — same-origin, always points at the
    // process that owns the pty handle.
    if (window.location.port !== '3055') return null;
  }
  const base = explicit
    ?? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:3056`;
  return `${base.replace(/\/$/, '')}/pty/${encodeURIComponent(id)}`;
}

/** Keep client-side ack of consumed bytes in sync with VS Code's watermark. */
const ACK_INTERVAL_BYTES = 50_000;

export interface PiPanelProps {
  /** Harness slug — matches the URL `/harness/<slug>`. */
  slug: string;
  /** Optional feature/lane id; scopes the pty cwd to that worktree. */
  laneId?: string;
  /** Override the spawn command. Default: pi (omp) with --no-pty. */
  command?: string;
  /** Override the spawn args. Default: ['--no-pty']. */
  args?: readonly string[];
  /**
   * Stable id per dock panel (the dockview panel id). Used to scope
   * sessionStorage so each panel resumes its own pty across React
   * unmount/remount cycles (e.g. dashboard tab switches). Without
   * this, two terminals in the same dock would clobber each other's
   * stored pty id.
   */
  panelId?: string;
}

/** sessionStorage key for the pty id this panel last successfully spawned. */
export function ptyResumeKey(slug: string, panelId: string | undefined, laneId: string | undefined): string {
  return `papercusp:pi-pty:${slug}:${panelId ?? 'default'}:${laneId ?? ''}`;
}

/**
 * Module-level coalescing for in-flight spawn POSTs. React StrictMode
 * double-mounts effects in dev, and our spawn fetch is async with a
 * sessionStorage-based resume that races: mount-1 fires spawn, mount-1
 * unmounts before the response, mount-2 reads sessionStorage (empty),
 * mount-2 fires its OWN spawn — and now the server has two ptys for
 * one user-visible panel. The first becomes an orphan that doesn't get
 * reaped for 5 minutes (it has activity from being spawned), so the
 * 16-pty cap fills up after a handful of clicks.
 *
 * We dedupe by `resumeKey` (slug + panelId + laneId): if a spawn is
 * already in flight for this key, the second mount awaits the same
 * Promise instead of firing another POST. Once the spawn settles the
 * entry is removed, so subsequent (genuine) remounts can spawn fresh.
 */
type SpawnResult = { ok: true; handle: PtyHandle } | { ok: false; error: string };
const inFlightSpawns = new Map<string, Promise<SpawnResult>>();


interface AuditSession {
  filename: string;
  tag: string | null;
  timestamp: string | null;
  sessionId: string | null;
  sizeBytes: number;
  mtimeMs: number;
}

interface PtyHandle {
  id: string;
  command: string;
  args: readonly string[];
  cwd: string;
  pid: number;
}

type PaneState =
  | { kind: 'starting' }
  | { kind: 'running'; handle: PtyHandle }
  | { kind: 'exited'; code: number; handle: PtyHandle }
  | { kind: 'error'; message: string };

const DARK_THEME = {
  background: '#0a0a0a',
  foreground: '#e7e7e7',
  cursor: '#6ea8ff',
  cursorAccent: '#0a0a0a',
  selectionBackground: '#3a3a4a',
  black: '#0a0a0a',
  red: '#e27e8a',
  green: '#7ee2a8',
  yellow: '#e2c47e',
  blue: '#7ec3e2',
  magenta: '#caa9e3',
  cyan: '#7ed4cc',
  white: '#e7e7e7',
  brightBlack: '#5a5a5a',
  brightRed: 'var(--bad)',
  brightGreen: '#a8e2c5',
  brightYellow: '#fcd591',
  brightBlue: '#aac7e3',
  brightMagenta: '#dac3eb',
  brightCyan: '#a3dad4',
  brightWhite: '#ffffff',
};

export default function PiPanel({ slug, laneId, command, args, panelId }: PiPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<unknown>(null); // xterm Terminal instance
  const fitAddonRef = useRef<unknown>(null); // FitAddon instance
  const eventSourceRef = useRef<{ close: () => void } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const nativeSessionRef = useRef<NativeSession | null>(null);
  const searchAddonRef = useRef<import('@xterm/addon-search').SearchAddon | null>(null);
  const showFindRef = useRef(false);
  const [showFind, setShowFindState] = useState(false);
  const setShowFind = useCallback((v: boolean) => { showFindRef.current = v; setShowFindState(v); }, []);
  const [remoteTitle, setRemoteTitle] = useState<string | null>(null);
  const [bellTick, setBellTick] = useState(0);
  const [findQuery, setFindQuery] = useState('');
  const handleIdRef = useRef<string | null>(null);
  const [state, setState] = useState<PaneState>({ kind: 'starting' });
  const [restartTick, setRestartTick] = useState(0);
  // showSessions is URL-backed so agents can open it via set_url. showFind
  // stays local — it's ref-coupled to xterm's search addon (sync-read in
  // keyboard handlers) and findQuery would spam the URL on every keystroke.
  const [sessions, setSessions] = useState<AuditSession[] | null>(null);
  const [showSessions, setShowSessions] = useQueryState('piSessions', parseAsBoolean.withDefault(false));

  const refreshSessions = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/pi-sessions/audit`);
      if (!r.ok) { setSessions([]); return; }
      const data = await r.json() as { sessions: AuditSession[] };
      setSessions(data.sessions);
    } catch { setSessions([]); }
  }, [slug]);

  const postKill = useCallback(async (id: string) => {
    try {
      await fetch(`/api/harness/${encodeURIComponent(slug)}/pty/${id}/kill`, {
        method: 'POST',
        keepalive: true,
      });
    } catch { /* best-effort */ }
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    let mounted = true;
    let resizeObs: ResizeObserver | null = null;
    // Anything that needs to run on unmount and isn't covered by the
    // standard refs (term, ws, eventSource). Used by the WS reconnect
    // loop to cancel pending retry timers and dispose AttachAddons.
    const cleanupBag = new Set<() => void>();

    // Resume path: try to adopt our previously-spawned pty if one is
    // recorded for this panel. Persisted in sessionStorage by the
    // success branch below; survives React unmount/remount across
    // dashboard tab switches. The server falls back to prewarm/cold-
    // spawn if the id is stale.
    const resumeKey = ptyResumeKey(slug, panelId, laneId);
    let resumePtyId: string | null = null;
    try { resumePtyId = window.sessionStorage.getItem(resumeKey); } catch { /* private mode */ }

    // E. Tauri detection — when running inside the desktop webview,
    // skip the operator's HTTP spawn entirely and route through
    // openNativeSession (Tauri commands + events). The operator is
    // still consulted via /pty/resolve to build harness-aware args
    // (omp prompt prepend, worktree cwd, MCP env), but the pty fork
    // itself lives in the Tauri Rust process.
    const useNative = isTauriNative();

    // Critical-path: kick the pty spawn POST in parallel with terminal
    // construction so the slow side (omp startup ~500–1500 ms) overlaps
    // with the cheap side (xterm DOM mount). If a resume id is known,
    // the server short-circuits to the existing handle. Otherwise the
    // dock has likely POSTed /pty/prewarm and the server adopts that
    // hot handle. Default 80×24 — a resize() POST follows once xterm
    // has measured the container.
    // Coalesce concurrent spawn POSTs for this resumeKey. If an effect
    // re-run (StrictMode, fast-refresh) hits the same key while the
    // first POST is still in flight, both consumers await the same
    // Promise and the server only sees one spawn. Cleared after the
    // Promise settles so a genuine later remount can spawn fresh.
    let spawnPromise: Promise<SpawnResult> | null = null;
    if (!useNative) {
      const existing = inFlightSpawns.get(resumeKey);
      if (existing) {
        spawnPromise = existing;
      } else {
        const p = (async (): Promise<SpawnResult> => {
          try {
            const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/pty/spawn`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ command, args, laneId, cols: 80, rows: 24, resumePtyId }),
            });
            if (!res.ok) {
              const errBody = await res.json().catch(() => ({} as { error?: string }));
              return { ok: false, error: errBody?.error ?? `spawn failed: HTTP ${res.status}` };
            }
            return { ok: true, handle: (await res.json()) as PtyHandle };
          } catch (err) {
            return { ok: false, error: `spawn failed: ${(err as Error).message}` };
          }
        })();
        // Drop the entry on settle so a real remount (e.g. tab close→reopen
        // after the pty has been killed) can spawn a fresh handle. Do this
        // BEFORE storing the Promise resolution side-effects, so concurrent
        // awaiters always observe the same finished value.
        p.finally(() => {
          if (inFlightSpawns.get(resumeKey) === p) inFlightSpawns.delete(resumeKey);
        });
        inFlightSpawns.set(resumeKey, p);
        spawnPromise = p;
      }
    }

    if (!containerRef.current) return;

    // Dynamic-import the xterm modules to keep SSR clean (they reference
    // `self` at top level). The whole setup body runs inside an async
    // IIFE so we can `await` the imports — the useEffect callback
    // itself stays sync and returns the unmount cleanup directly.
    void (async () => {
    type XtermMods = {
      Terminal: typeof import('@xterm/xterm').Terminal;
      FitAddon: typeof import('@xterm/addon-fit').FitAddon;
      WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon;
      SearchAddon: typeof import('@xterm/addon-search').SearchAddon;
      ClipboardAddonCtor: typeof import('@xterm/addon-clipboard').ClipboardAddon | null;
      WebglAddonCtor: typeof import('@xterm/addon-webgl').WebglAddon | null;
    };
    let mods: XtermMods | null = null;
    try {
      const [xt, ft, wl, sa, cl, wg] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
        import('@xterm/addon-search'),
        import('@xterm/addon-clipboard').catch(() => null),
        process.env.NEXT_PUBLIC_PAPERCUSP_PTY_WEBGL === '0'
          ? Promise.resolve(null)
          : import('@xterm/addon-webgl').catch(() => null),
      ]);
      mods = {
        Terminal: xt.Terminal,
        FitAddon: ft.FitAddon,
        WebLinksAddon: wl.WebLinksAddon,
        SearchAddon: sa.SearchAddon,
        ClipboardAddonCtor: cl?.ClipboardAddon ?? null,
        WebglAddonCtor: wg?.WebglAddon ?? null,
      };
    } catch (err) {
      if (mounted) setState({ kind: 'error', message: `xterm load failed: ${(err as Error).message}` });
      return;
    }
    if (cancelled || !containerRef.current) return;
    const { Terminal, FitAddon, WebLinksAddon, SearchAddon, ClipboardAddonCtor, WebglAddonCtor } = mods;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: DARK_THEME,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    // Search addon — Ctrl+Shift+F opens find-in-scrollback. Common
    // terminal-product feature; xterm.js's official addon, ~25 KB.
    const search = new SearchAddon();
    term.loadAddon(search);
    // Clipboard addon — handles OSC 52 copy/paste so apps that emit it
    // (vim, tmux) interop with the system clipboard. Browser clipboard
    // permission is requested by the addon at use-time.
    if (ClipboardAddonCtor) {
      try { term.loadAddon(new ClipboardAddonCtor()); } catch { /* */ }
    }
    term.open(containerRef.current);

    // Optional GPU renderer — drops CPU on chatty output (e.g. cat largefile,
    // npm install progress). Some Linux GPU drivers have known regressions
    // (Intel iGPU + Mesa pre-23, NVIDIA proprietary in headless contexts);
    // the addon emits a 'contextloss' event and we fall back to canvas. Set
    // NEXT_PUBLIC_PAPERCUSP_PTY_WEBGL=0 to opt out.
    if (WebglAddonCtor) {
      try {
        const webgl = new WebglAddonCtor();
        webgl.onContextLoss(() => { try { webgl.dispose(); } catch { /* */ } });
        term.loadAddon(webgl);
      } catch { /* WebGL unavailable — xterm falls back to its DOM/canvas renderer */ }
    }

    // Title from OSC 0/1/2 sequences (e.g. shell PROMPT_COMMAND that
    // emits `\x1b]0;new title\x07`). Surfaces in the panel header so
    // the user knows what the pty is currently doing.
    cleanupBag.add(term.onTitleChange((title) => {
      if (mounted) setRemoteTitle(title);
    }).dispose);

    // Bell (\x07) — flash the panel header subtle red so the user
    // notices background events without a real audio bell.
    cleanupBag.add(term.onBell(() => {
      if (mounted) {
        setBellTick((t) => t + 1);
      }
    }).dispose);

    // Find-in-scrollback shortcut (Ctrl+Shift+F). xterm intercepts
    // most key events for the pty; we register at the document level
    // and only act if our terminal is focused.
    const findKeyHandler = (ev: KeyboardEvent) => {
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'F' || ev.key === 'f')) {
        if (containerRef.current?.contains(document.activeElement)) {
          ev.preventDefault();
          setShowFind(true);
        }
      }
      if (ev.key === 'Escape' && showFindRef.current) {
        ev.preventDefault();
        setShowFind(false);
        try { search.clearDecorations(); } catch { /* */ }
      }
    };
    document.addEventListener('keydown', findKeyHandler);
    cleanupBag.add(() => document.removeEventListener('keydown', findKeyHandler));
    // Make the search addon reachable from the input handler below.
    searchAddonRef.current = search;

    // fit.fit() can throw `TypeError: Cannot read properties of undefined
    // (reading 'scrollBarWidth')` when the container has 0 dimensions at
    // the moment of the call — happens reliably under dockview when a
    // panel is freshly added to a tab strip and hasn't been laid out
    // yet. Swallow + retry on next animation frame, by which time the
    // container has been measured.
    try { fit.fit(); } catch { /* not yet sized */ }
    requestAnimationFrame(() => {
      if (cancelled) return;
      try { fit.fit(); } catch { /* still 0×0 — user can resize manually */ }
    });
    termRef.current = term;
    fitAddonRef.current = fit;

    // E. Native (Tauri) data path. No HTTP, no WS — Tauri IPC end-to-end.
    if (useNative) {
      (async () => {
        try {
          const session = await openNativeSession({
            slug,
            laneId,
            cols: term.cols,
            rows: term.rows,
            resumePtyId,
          });
          if (cancelled) {
            // Persist id so a remount can resume; do NOT kill.
            try { window.sessionStorage.setItem(resumeKey, session.id); } catch { /* */ }
            session.dispose();
            return;
          }
          nativeSessionRef.current = session;
          handleIdRef.current = session.id;
          try { window.sessionStorage.setItem(resumeKey, session.id); } catch { /* */ }
          if (mounted) {
            setState({
              kind: 'running',
              handle: { id: session.id, command: command ?? '', args: args ?? [], cwd: '', pid: session.pid ?? 0 },
            });
          }
          // Replay history into the fresh xterm.
          if (session.history.length > 0) term.write(session.history);
          // Wire pty bytes → xterm.
          session.onData((chunk) => { term.write(chunk); });
          session.onExit((code) => {
            if (mounted) {
              setState({
                kind: 'exited',
                code,
                handle: { id: session.id, command: command ?? '', args: args ?? [], cwd: '', pid: session.pid ?? 0 },
              });
            }
          });
          // Wire keystrokes → pty.
          const enc = new TextEncoder();
          term.onData((data) => { void session.write(enc.encode(data)); });
          // Wire resize.
          resizeObs = new ResizeObserver(() => {
            try {
              fit.fit();
              void session.resize(term.cols, term.rows);
            } catch { /* not ready */ }
          });
          if (containerRef.current) resizeObs.observe(containerRef.current);
          // Push post-fit dims if they differ from the spawn defaults.
          if (term.cols !== 80 || term.rows !== 24) {
            try { await session.resize(term.cols, term.rows); } catch { /* */ }
          }
        } catch (err) {
          if (mounted) setState({ kind: 'error', message: `native pty failed: ${(err as Error).message}` });
        }
      })();
      // Tauri branch — push our specialized cleanup into cleanupBag so
      // the outer useEffect's return-cleanup runs it. Pre-IIFE-wrapping
      // we returned a fresh cleanup here, but inside an async IIFE
      // `return cleanupFn` only escapes the IIFE, not useEffect.
      cleanupBag.add(() => {
        const session = nativeSessionRef.current;
        if (session) session.dispose();
        nativeSessionRef.current = null;
      });
      return;
    }

    // Web path: now wait on the spawn that's been racing in the background.
    spawnPromise!.then(async (result) => {
      if (cancelled) {
        // Component unmounted before spawn resolved (StrictMode double-
        // mount, or user navigated away). Persist the id so the next
        // mount adopts this pty instead of orphaning it.
        if (result.ok) {
          try { window.sessionStorage.setItem(resumeKey, result.handle.id); } catch { /* ignore */ }
        }
        return;
      }
      if (!result.ok) {
        if (mounted) setState({ kind: 'error', message: result.error });
        return;
      }
      const handle = result.handle;
      handleIdRef.current = handle.id;
      try { window.sessionStorage.setItem(resumeKey, handle.id); } catch { /* ignore */ }
      if (mounted) setState({ kind: 'running', handle });

      // Push the post-fit dims to the pty if they differ from the 80×24
      // we asked for at spawn. Best-effort.
      if (term.cols !== 80 || term.rows !== 24) {
        fetch(`/api/harness/${encodeURIComponent(slug)}/pty/${handle.id}/resize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cols: term.cols, rows: term.rows }),
        }).catch(() => { /* ignore */ });
      }

      // ── Data channel selection ───────────────────────────────────
      // Preferred path: WebSocket via xterm's AttachAddon. Falls back
      // to SSE+POST if the WS server is unreachable (proxy doesn't
      // pass upgrades, PAPERCUSP_PTY_WS=0, etc.). The control plane
      // (POST /spawn etc.) is identical either way — only the data
      // path differs.
      const wsUrl = ptyWsUrlForId(handle.id);
      let attached = false;

      if (wsUrl) {
        // Reconnect state — survives cancellation via the cleanup function
        // below. The backoff schedule mirrors what gotty/code-server use:
        // 250 ms → 500 ms → 1 s → 2 s → 4 s → 8 s, then give up.
        let attempt = 0;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let unackedToServer = 0;
        let onDataDisposable: { dispose: () => void } | null = null;
        const inputEncoder = new TextEncoder();

        const tryConnect = (initial: boolean): Promise<boolean> => new Promise<boolean>((resolve) => {
          let settled = false;
          let socket: WebSocket;
          try {
            socket = new WebSocket(wsUrl);
          } catch {
            resolve(false);
            return;
          }
          socket.binaryType = 'arraybuffer';
          // Only the FIRST attempt has a fallback timeout — once we've
          // ever connected successfully, we stick to WS and reconnect
          // on close instead of falling back to SSE (the user's session
          // state and xterm instance would survive but the data path
          // would silently downgrade, which is worse UX than a brief
          // gap).
          const fallbackTimer = initial ? setTimeout(() => {
            if (settled) return;
            settled = true;
            try { socket.close(); } catch { /* ignore */ }
            resolve(false);
          }, 1500) : null;

          socket.addEventListener('open', () => {
            if (settled) return;
            settled = true;
            if (fallbackTimer) clearTimeout(fallbackTimer);
            attempt = 0;
            wsRef.current = socket;

            // Wire xterm input → WS as BINARY frames. The pty-ws server
            // distinguishes input (binary) from control messages (text
            // JSON: resize/ack/kill/exit). xterm's @xterm/addon-attach
            // sends term.onData as text strings, which the server then
            // tries to JSON.parse and silently drops — the symptom is a
            // terminal that streams output but eats every keystroke.
            // So we wire the input side manually with TextEncoder.
            if (onDataDisposable) {
              try { onDataDisposable.dispose(); } catch { /* ignore */ }
            }
            onDataDisposable = term.onData((data) => {
              const cur = wsRef.current;
              if (!cur || cur.readyState !== WebSocket.OPEN) return;
              try { cur.send(inputEncoder.encode(data)); } catch { /* socket may be closing */ }
            });

            // Push current dims so the server's pty matches the live
            // xterm geometry — important on reconnect because the
            // window may have been resized while we were disconnected.
            try { socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch { /* ignore */ }

            // Flow-control acks. Reset on reconnect since the server's
            // unacked counter is fresh too.
            unackedToServer = 0;
            socket.addEventListener('message', (ev) => {
              const data = ev.data;
              if (data instanceof ArrayBuffer) {
                // Pty bytes → terminal. Wired manually instead of via
                // AttachAddon so the input side (above) can use binary
                // frames without the addon also sending text frames.
                term.write(new Uint8Array(data));
                unackedToServer += data.byteLength;
                if (unackedToServer >= ACK_INTERVAL_BYTES) {
                  try { socket.send(JSON.stringify({ type: 'ack', bytes: unackedToServer })); } catch { /* socket may be closing */ }
                  unackedToServer = 0;
                }
              } else if (typeof data === 'string') {
                try {
                  const msg = JSON.parse(data);
                  if (msg?.type === 'exit') {
                    if (mounted) setState({ kind: 'exited', code: msg.code ?? 0, handle });
                  }
                } catch { /* ignore */ }
              }
            });

            // Set up resize observer once on the very first attach.
            if (initial) {
              resizeObs = new ResizeObserver(() => {
                try {
                  fit.fit();
                  const cur = wsRef.current;
                  if (cur && cur.readyState === WebSocket.OPEN) {
                    cur.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                  }
                } catch { /* not ready yet */ }
              });
              if (containerRef.current) resizeObs.observe(containerRef.current);
              if (term.cols !== 80 || term.rows !== 24) {
                try { socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch { /* ignore */ }
              }
            }

            resolve(true);
          });

          socket.addEventListener('error', () => {
            if (settled) return;
            settled = true;
            if (fallbackTimer) clearTimeout(fallbackTimer);
            try { socket.close(); } catch { /* ignore */ }
            resolve(false);
          });

          // Reconnect-on-close: any close that ISN'T an explicit user
          // unmount (1000) or a server reject (4xxx) triggers a retry.
          // 1006 (abnormal closure) is the common case for laptop sleep
          // / network blip / sidecar restart.
          socket.addEventListener('close', (ev) => {
            wsRef.current = null;
            if (cancelled) return;
            // 4xxx codes from our own server (4403, 4404, 4410): give
            // up — the pty is gone or origin denied. 1000: clean.
            const code = ev.code;
            if (code === 1000 || (code >= 4400 && code < 4500)) return;
            attempt = Math.min(attempt + 1, 6);
            const delay = 250 * Math.pow(2, attempt - 1);
            if (attempt > 6) return; // gave up; user can re-mount the panel
            reconnectTimer = setTimeout(() => {
              if (cancelled) return;
              void tryConnect(false);
            }, delay);
          });
        });

        attached = await tryConnect(true);

        // Carry the reconnect timer into the cleanup closure so unmount
        // cancels any pending retry.
        const reconnectCleanup = () => {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          if (onDataDisposable) { try { onDataDisposable.dispose(); } catch { /* */ } }
        };
        // Hang it off the window-scoped ref via a small registry on the
        // session — easiest: stash on wsRef-adjacent state via closure.
        // We re-do this less awkwardly by piggybacking on the existing
        // cleanup return path: it already closes wsRef.current. The
        // reconnect timer just needs cancellation, so attach it to a
        // module-private list keyed by the term instance.
        cleanupBag.add(reconnectCleanup);
      }

      if (!attached) {
        // ── Fallback: legacy SSE + POST ─────────────────────────────
        const source = createResilientEventSource({
          url: `/api/harness/${encodeURIComponent(slug)}/pty/${handle.id}/stream`,
          handlers: {
            data: (data) => {
              try {
                const bin = atob(data);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                term.write(bytes);
              } catch { /* malformed — drop */ }
            },
            exit: (data) => {
              try {
                const payload = JSON.parse(data);
                if (mounted) setState({ kind: 'exited', code: payload?.code ?? 0, handle });
              } catch {
                if (mounted) setState({ kind: 'exited', code: 0, handle });
              }
              source.close();
            },
          },
        });
        eventSourceRef.current = source;

        // Batched-input fallback: rAF flush, base64 over JSON.
        let pending = '';
        let flushScheduled = false;
        const flushInput = () => {
          flushScheduled = false;
          if (pending.length === 0) return;
          const b64 = btoa(unescape(encodeURIComponent(pending)));
          pending = '';
          fetch(`/api/harness/${encodeURIComponent(slug)}/pty/${handle.id}/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: b64 }),
            keepalive: true,
          }).catch(() => { /* best-effort */ });
        };
        term.onData((data) => {
          pending += data;
          if (!flushScheduled) {
            flushScheduled = true;
            requestAnimationFrame(flushInput);
          }
        });

        resizeObs = new ResizeObserver(() => {
          try {
            fit.fit();
            fetch(`/api/harness/${encodeURIComponent(slug)}/pty/${handle.id}/resize`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ cols: term.cols, rows: term.rows }),
            }).catch(() => { /* ignore */ });
          } catch { /* term not ready */ }
        });
        if (containerRef.current) resizeObs.observe(containerRef.current);
      }
    });
    })(); // close async IIFE wrapping the dynamic-import setup body

    return () => {
      cancelled = true;
      mounted = false;
      resizeObs?.disconnect();
      const es = eventSourceRef.current;
      if (es) es.close();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.close(1000, 'unmount'); } catch { /* ignore */ }
      }
      wsRef.current = null;
      eventSourceRef.current = null;
      // Run any deferred cleanups (reconnect timers, addon disposals).
      for (const fn of cleanupBag) { try { fn(); } catch { /* ignore */ } }
      cleanupBag.clear();
      // Intentionally NOT calling postKill: the pty stays alive on the
      // server so a remount (tab switch back) can resume it via
      // sessionStorage + resumePtyId. The 5-min idle reaper in
      // pty-bridge cleans up genuinely-abandoned handles.
      // term is declared inside the async IIFE; reach it through the
      // ref the IIFE published into.
      const t = termRef.current as { dispose?: () => void } | null;
      try { t?.dispose?.(); } catch { /* ignore */ }
      termRef.current = null;
      fitAddonRef.current = null;
      handleIdRef.current = null;
    };
  // restartTick forces re-spawn on user-clicked Restart.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, laneId, command, args, postKill, restartTick]);

  return (
    <div className={`pi-panel${bellTick > 0 ? ' pi-panel--bell' : ''}`} key={`bell-${bellTick}`}>
      <div className="pi-panel__header">
        <span className="pi-panel__title">pi</span>
        {remoteTitle && (
          <span className="pi-panel__remote-title" title={remoteTitle}>· {remoteTitle.slice(0, 50)}{remoteTitle.length > 50 ? '…' : ''}</span>
        )}
        {state.kind === 'running' && (
          <span className="pi-panel__sub">
            pid {state.handle.pid}{laneId ? ` · ${laneId}` : ''}
          </span>
        )}
        {state.kind === 'exited' && (
          <span className="pi-panel__sub pi-panel__sub--exited">
            exited {state.code}
          </span>
        )}
        {state.kind === 'error' && (
          <span className="pi-panel__sub pi-panel__sub--error">{state.message}</span>
        )}

        {/* Spacer so action chips align right */}
        <span className="pi-panel__spacer" />

        <Tooltip label="Past pi sessions exported to HTML">
          <button
            type="button"
            className="pi-panel__chip"
            onClick={async () => {
              const next = !showSessions;
              setShowSessions(next);
              if (next && sessions === null) await refreshSessions();
            }}
          >
            past sessions{sessions ? ` (${sessions.length})` : ''}
          </button>
        </Tooltip>

        {state.kind === 'exited' && (
          <button
            type="button"
            className="pi-panel__btn"
            onClick={() => setRestartTick((t) => t + 1)}
          >Restart</button>
        )}
      </div>

      {showSessions && sessions !== null && (
        <div className="pi-panel__popover">
          <div className="pi-panel__popover-title">
            Past pi sessions ({sessions.length})
            <Tooltip label="Refresh">
              <button
                type="button"
                className="pi-panel__refresh"
                onClick={refreshSessions}
              >↻</button>
            </Tooltip>
          </div>
          {sessions.length === 0 ? (
            <div className="pi-panel__empty">
              No exported sessions yet. They appear here after a pi pane closes.
            </div>
          ) : (
            <ul className="pi-panel__sessions-list">
              {sessions.map((s) => {
                const date = s.timestamp
                  ? s.timestamp.replace('T', ' ').replace(/-/g, ':').replace(/Z$/, ' UTC').replace('::', '-').replace('::', '-')
                  : null;
                const niceDate = s.mtimeMs ? new Date(s.mtimeMs).toLocaleString() : date;
                return (
                  <li key={s.filename}>
                    <a
                      href={`/api/harness/${encodeURIComponent(slug)}/pi-sessions/audit/${encodeURIComponent(s.filename)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className="pi-panel__session-tag">{s.tag ?? s.filename}</span>
                      {niceDate && <span className="pi-panel__session-date">{niceDate}</span>}
                      <span className="pi-panel__session-size">{Math.round(s.sizeBytes / 1024)}&nbsp;KB</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="pi-panel__term-wrap">
        <div className="pi-panel__term" ref={containerRef} />
        {state.kind === 'starting' && (
          <div className="pi-panel__loading" aria-live="polite">
            <Loader2 size={18} className="pi-panel__loading-spin" />
            <span>starting pi…</span>
          </div>
        )}
        {showFind && (
          <div className="pi-panel__find" role="search" aria-label="Find in terminal scrollback">
            <input
              autoFocus
              aria-label="Find in terminal"
              value={findQuery}
              onChange={(e) => {
                setFindQuery(e.target.value);
                if (e.target.value) searchAddonRef.current?.findNext(e.target.value);
                else searchAddonRef.current?.clearDecorations();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (e.shiftKey) searchAddonRef.current?.findPrevious(findQuery);
                  else searchAddonRef.current?.findNext(findQuery);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setShowFind(false);
                  searchAddonRef.current?.clearDecorations();
                }
              }}
              placeholder="find in terminal — Enter to find, Shift+Enter for previous, Esc to close"
              className="pi-panel__find-input"
            />
            <button
              type="button"
              className="pi-panel__find-close"
              onClick={() => {
                setShowFind(false);
                searchAddonRef.current?.clearDecorations();
              }}
              aria-label="Close find"
            >×</button>
          </div>
        )}
      </div>
    </div>
  );
}
