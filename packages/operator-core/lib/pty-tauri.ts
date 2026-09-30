/**
 * pty-tauri.ts — renderer-side wrapper for the Tauri native pty path (E).
 *
 * When the operator UI is running inside the Tauri webview, we bypass
 * the operator's HTTP+WS bridge for ptys and route directly through
 * Tauri commands. The pty fork lives in the Rust process, output is
 * delivered via Tauri events (in-process IPC), input via invoke().
 *
 * Command calls go through the typed tauri-bindings (tauri-specta);
 * pty-data / pty-exit events still use the raw __TAURI__.event.listen
 * surface because they aren't declared as tauri_specta::Event.
 *
 * Public API mirrors what PiPanel needs:
 *   - isTauriNative()           — feature-detect
 *   - openNativeSession(opts)   — POST /resolve + spawn + listen
 */

import { commands, type PtySpawnOpts as BindingsPtySpawnOpts } from './tauri-bindings';

type TauriListenFn = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

interface WindowWithTauri extends Window {
  __PAPERCUSP_TAURI__?: { kind: 'native' };
  __TAURI__?: { event?: { listen: TauriListenFn } };
  __TAURI_INTERNALS__?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
}

/**
 * True iff we're running inside the Tauri webview AND the native pty
 * commands are available. PiPanel calls this to choose its transport.
 *
 * `__TAURI_INTERNALS__` is Tauri's own injection — present in EVERY
 * document of the webview, reload-proof. `__PAPERCUSP_TAURI__` is set by
 * finish_boot's bounded eval loop, so it is LOST on any reload/late
 * navigation — treat it as an optional override (an explicit non-native
 * marker wins), never as a requirement, or the wizard's install/login
 * buttons silently vanish after a reload (found live on Windows
 * 2026-06-11).
 */
export function isTauriNative(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as WindowWithTauri;
  if (!w.__TAURI_INTERNALS__?.invoke) return false;
  if (w.__PAPERCUSP_TAURI__ && w.__PAPERCUSP_TAURI__.kind !== 'native') return false;
  return true;
}

function tauriListen(): TauriListenFn {
  const w = window as WindowWithTauri;
  const fn = w.__TAURI__?.event?.listen;
  if (!fn) throw new Error('Tauri event.listen not available');
  return fn;
}

interface ResolveResult {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

interface OpenNativeOpts {
  slug: string;
  laneId?: string;
  cols: number;
  rows: number;
  /** If passed and the Rust side reports the id alive, reattach instead of spawning. */
  resumePtyId?: string | null;
}

export interface NativeSession {
  id: string;
  pid: number | null;
  resumed: boolean;
  /** Replay buffer (binary). Empty for a fresh spawn. */
  history: Uint8Array;
  /** Subscribe to bytes from the pty. Returns an unsubscribe fn. */
  onData(handler: (chunk: Uint8Array) => void): () => void;
  /** Subscribe to process exit. Returns an unsubscribe fn. */
  onExit(handler: (code: number) => void): () => void;
  /** Send keystroke bytes. */
  write(data: Uint8Array): Promise<void>;
  /** Notify the pty of a new geometry. */
  resize(cols: number, rows: number): Promise<void>;
  /** Hard-kill the pty. Only call on explicit user close. */
  kill(): Promise<void>;
  /** Drop our event listeners without killing the pty. */
  dispose(): void;
}

/**
 * Open or resume a native pty session for the given slug+laneId. Falls
 * through to a fresh spawn if `resumePtyId` is missing or stale.
 */
export async function openNativeSession(opts: OpenNativeOpts): Promise<NativeSession> {
  const listen = tauriListen();

  let id: string | null = null;
  let pid: number | null = null;
  let resumed = false;
  let history: Uint8Array = new Uint8Array(new ArrayBuffer(0));

  if (opts.resumePtyId) {
    const alive = await commands.ptyIsAlive(opts.resumePtyId).catch(() => false);
    if (alive) {
      id = opts.resumePtyId;
      resumed = true;
      const histRes = await commands.ptyHistory(id).catch(() => null);
      if (histRes && histRes.status === 'ok' && histRes.data) {
        history = base64ToBytes(histRes.data);
      }
      // Resize to the new dims now that the renderer is ready.
      await commands.ptyResize(id, opts.cols, opts.rows).catch(() => undefined);
    }
  }

  if (!id) {
    // Resolve harness-aware config from the operator (still over HTTP).
    const r = await fetch(`/api/harness/${encodeURIComponent(opts.slug)}/pty/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ laneId: opts.laneId, cols: opts.cols, rows: opts.rows }),
    });
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({} as { error?: string }));
      throw new Error(errBody.error ?? `pty/resolve HTTP ${r.status}`);
    }
    const cfg = (await r.json()) as ResolveResult;
    const spawnOpts: BindingsPtySpawnOpts = {
      command: cfg.command,
      args: [...cfg.args],
      cwd: cfg.cwd,
      env: cfg.env,
      cols: opts.cols,
      rows: opts.rows,
    };
    const spawnRes = await commands.ptySpawn(spawnOpts);
    if (spawnRes.status === 'error') throw new Error(spawnRes.error);
    id = spawnRes.data.id;
    pid = spawnRes.data.pid;
  }

  // Subscribe to pty-data / pty-exit. These are global events keyed by
  // id in the payload, so each session filters.
  const dataHandlers = new Set<(c: Uint8Array) => void>();
  const exitHandlers = new Set<(code: number) => void>();

  const unlistenData = await listen<{ id: string; data: string }>('pty-data', (ev) => {
    if (ev.payload.id !== id) return;
    const bytes = base64ToBytes(ev.payload.data);
    dataHandlers.forEach((h) => { try { h(bytes); } catch { /* ignore */ } });
  });
  const unlistenExit = await listen<{ id: string; code: number }>('pty-exit', (ev) => {
    if (ev.payload.id !== id) return;
    exitHandlers.forEach((h) => { try { h(ev.payload.code); } catch { /* ignore */ } });
  });

  const sessionId = id!;
  return {
    id: sessionId,
    pid,
    resumed,
    history,
    onData(handler) { dataHandlers.add(handler); return () => dataHandlers.delete(handler); },
    onExit(handler) { exitHandlers.add(handler); return () => exitHandlers.delete(handler); },
    async write(data) {
      const r = await commands.ptyWrite(sessionId, bytesToBase64(data));
      if (r.status === 'error') throw new Error(r.error);
    },
    async resize(cols, rows) {
      const r = await commands.ptyResize(sessionId, cols, rows);
      if (r.status === 'error') throw new Error(r.error);
    },
    async kill() {
      try { await commands.ptyKill(sessionId); } catch { /* already dead */ }
    },
    dispose() {
      dataHandlers.clear();
      exitHandlers.clear();
      try { unlistenData(); } catch { /* */ }
      try { unlistenExit(); } catch { /* */ }
    },
  };
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
  // Chunk to avoid call-stack overflow on >64K inputs.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(s);
}
