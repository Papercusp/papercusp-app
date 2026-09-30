'use client';

/**
 * Dev IPC-traffic inspector (client recorder).
 *
 * Installs a recorder into `@papercusp/desktop-ipc`'s zero-cost inspector seam
 * and exposes `window.__ipcInspector` so the IPC traffic that is invisible to
 * the browser devtools Network panel (it rides the Tauri unix socket, not HTTP)
 * becomes observable from the Tauri devtools console — or from a headless verify
 * via the bridge `eval`.
 *
 * The headline method is `churn()`: for each EventSource URL it reports how many
 * times the source was CONSTRUCTED vs how many times it (re)connected. A healthy
 * long-lived stream shows ONE construction and many internal reconnects; a
 * consumer recreating the source on every drop shows many constructions — the
 * dev-IPC "constant flashing" made measurable. This is the instrument that turns
 * the Phase D live re-enable from a blind flip into an observed test.
 *
 * Dev-only (not installed in production). Plan: calltool-endpoint-seam (Phase C, P-006).
 */

import { setIpcInspector, type IpcTraceEvent } from '@papercusp/desktop-ipc';

const MAX_EVENTS = 2000;
const buf: IpcTraceEvent[] = [];

function record(ev: IpcTraceEvent): void {
  buf.push(ev);
  if (buf.length > MAX_EVENTS) buf.splice(0, buf.length - MAX_EVENTS);
}

export interface IpcChurnRow {
  path: string;
  /** Distinct IpcEventSource constructions (new IPC channels) for this URL. */
  constructions: number;
  /** Connection attempts that reached OPEN. */
  connects: number;
  /** Transient drops the SAME source recovered from. */
  drops: number;
  errors: number;
  closes: number;
  verdict: string;
}

export interface IpcInvokeRow {
  key: string;
  started: number;
  done: number;
  error: number;
  /** Started but not yet terminal (in-flight or leaked). */
  open: number;
}

export interface IpcInspectorApi {
  /** Per-EventSource-URL churn report — the headline. */
  churn(): IpcChurnRow[];
  /** Per-tool / sys:http-route invoke counts. */
  summary(): IpcInvokeRow[];
  /** Filtered raw events (substring match on path; exact on kind). */
  events(filter?: { path?: string; kind?: IpcTraceEvent['kind']; sinceMs?: number }): IpcTraceEvent[];
  /** Total recorded (capped at the ring size). */
  count(): number;
  clear(): void;
}

function churn(): IpcChurnRow[] {
  const byPath = new Map<
    string,
    { open: number; connect: number; drop: number; error: number; close: number }
  >();
  for (const ev of buf) {
    if (!ev.path || !ev.kind.startsWith('es-')) continue;
    const e = byPath.get(ev.path) ?? { open: 0, connect: 0, drop: 0, error: 0, close: 0 };
    if (ev.kind === 'es-open') e.open++;
    else if (ev.kind === 'es-connect') e.connect++;
    else if (ev.kind === 'es-drop') e.drop++;
    else if (ev.kind === 'es-error') e.error++;
    else if (ev.kind === 'es-close') e.close++;
    byPath.set(ev.path, e);
  }
  return [...byPath.entries()]
    .map(([path, e]) => ({
      path,
      constructions: e.open,
      connects: e.connect,
      drops: e.drop,
      errors: e.error,
      closes: e.close,
      verdict:
        e.open <= 1
          ? `OK — one persistent channel (${e.drop} internal reconnect${e.drop === 1 ? '' : 's'})`
          : `⚠ ${e.open} constructions for ${e.connect} connects — a consumer is recreating the source instead of reusing it`,
    }))
    .sort((a, b) => b.constructions - a.constructions);
}

function summary(): IpcInvokeRow[] {
  // Terminal events (invoke-done / invoke-error) carry only the correlation id,
  // not path/method — so attribute them to their start's route via the id.
  const byId = new Map<number, { key: string; done: boolean; error: boolean }>();
  for (const ev of buf) {
    if (ev.kind === 'invoke') {
      const key =
        ev.tool === 'sys:http'
          ? `sys:http ${ev.method ?? 'GET'} ${ev.path ?? ''}`.trim()
          : ev.tool ?? '(direct)';
      byId.set(ev.id, { key, done: false, error: false });
    } else if (ev.kind === 'invoke-done') {
      const e = byId.get(ev.id);
      if (e) e.done = true;
    } else if (ev.kind === 'invoke-error') {
      const e = byId.get(ev.id);
      if (e) e.error = true;
    }
  }
  const byKey = new Map<string, { started: number; done: number; error: number }>();
  for (const { key, done, error } of byId.values()) {
    const e = byKey.get(key) ?? { started: 0, done: 0, error: 0 };
    e.started++;
    if (done) e.done++;
    if (error) e.error++;
    byKey.set(key, e);
  }
  return [...byKey.entries()]
    .map(([key, e]) => ({ key, ...e, open: Math.max(0, e.started - e.done - e.error) }))
    .sort((a, b) => b.started - a.started);
}

function events(filter?: {
  path?: string;
  kind?: IpcTraceEvent['kind'];
  sinceMs?: number;
}): IpcTraceEvent[] {
  return buf.filter(
    (ev) =>
      (!filter?.path || (ev.path?.includes(filter.path) ?? false)) &&
      (!filter?.kind || ev.kind === filter.kind) &&
      (filter?.sinceMs === undefined || ev.t >= filter.sinceMs),
  );
}

const api: IpcInspectorApi = {
  churn,
  summary,
  events,
  count: () => buf.length,
  clear: () => {
    buf.length = 0;
  },
};

let installed = false;

/**
 * Wire the recorder into the transport seam and publish `window.__ipcInspector`.
 * No-op in production, off-window (SSR), or if already installed. Safe to call
 * at module-eval — installs the recorder before any component opens a stream.
 */
export function installIpcInspector(): void {
  if (installed || typeof window === 'undefined') return;
  // Dev builds: always on. Production: OFF unless explicitly opted in via a
  // localStorage flag. This matters because a RELEASE desktop build is the only
  // build that actually runs IPC (debug builds skip the sidecar spawn) — yet a
  // release build is NODE_ENV=production. Without this opt-in the inspector and
  // IPC could never coexist, making it useless for verifying the SSE-over-IPC
  // churn fork. To observe a release build: localStorage['papercusp.ipcInspector']
  // = '1' then reload. Real users never set it, so it stays off in the wild.
  // Plan: calltool-endpoint-seam-2026-06-01 (Phase C/D).
  if (process.env.NODE_ENV === 'production') {
    try {
      if (window.localStorage?.getItem('papercusp.ipcInspector') !== '1') return;
    } catch {
      return; // localStorage unavailable (sandboxed) → stay off
    }
  }
  installed = true;
  setIpcInspector(record);
  (window as unknown as { __ipcInspector: IpcInspectorApi }).__ipcInspector = api;
   
  console.info(
    '[ipc-inspector] window.__ipcInspector ready — .churn() / .summary() / .events()',
  );
}
