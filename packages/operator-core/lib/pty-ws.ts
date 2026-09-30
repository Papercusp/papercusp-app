/**
 * pty-ws.ts — WebSocket transport for the embedded pty bridge.
 *
 * Client connects to ws://<host>:<PAPERCUSP_PTY_WS_PORT>/pty/<id> after
 * a successful POST /api/harness/:slug/pty/spawn. The id comes from
 * that response. The HTTP control plane (spawn/prewarm/kill) is
 * unchanged — this just replaces the SSE output + POST input data
 * channels with one full-duplex WebSocket.
 *
 * Wire format:
 *   server → client : binary frames, raw pty bytes (no base64).
 *                     xterm.js's AttachAddon is the canonical consumer
 *                     and decodes Uint8Array as UTF-8.
 *   client → server : binary frames are user input bytes (forwarded to
 *                     writePty). text frames are JSON control messages:
 *                       {type:"resize", cols, rows}
 *                       {type:"ack",    bytes}     // flow control
 *                       {type:"kill"}
 *
 * Flow control (VS Code shape, not Wetty's): coalesce server→client
 * data via a 5 ms throttle, and pause the pty when more than 100 KB
 * of output is unacknowledged by the client. Resume when it drains
 * back below the low watermark. node-pty's own handleFlowControl is
 * also enabled at spawn so pty children that emit XOFF/XON cooperate.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import type { IncomingMessage } from 'node:http';
import {
  getPty,
  getPtyAccessScope,
  writePty,
  resizePty,
  killPty,
  markActive,
  getScreenSerialization,
  ptyRegistryClusterRefusal,
} from './pty-bridge';
import {
  PTY_WS_PROTOCOL,
  ptyTicketFromProtocolHeader,
  redeemPtyTicket,
  type PtyAccessScope,
} from './pty-ticket';
import {
  recordViewerAttached,
  refreshViewerAttached,
  clearViewerAttached,
} from './pty-viewer-heartbeat';

// VS Code's terminal flow-control numbers, from
// vscode/src/vs/platform/terminal/common/terminal.ts FlowControlConstants.
// Flow-control watermarks for pty -> ws. Aligned with wetty's defaults
// (2 MB high / 512 KB low) — large enough that interactive pty echo
// never trips pause/resume. Earlier 100 KB cap was tight enough that a
// few omp prompt-redraws filled it, paused the pty mid-burst, and
// produced perceptible jitter on chatty sessions. Client must ack at
// least every (HIGH - LOW) bytes for flow control to work.
const HIGH_WATERMARK_BYTES = 2_097_152;
const LOW_WATERMARK_BYTES = 524_288;

// 2 ms tinybuffer-style coalesce of pty -> ws output. Lifted from
// wetty (mature Node + node-pty browser-terminal); below human
// perception (one frame is 16 ms) and short enough that keystroke
// echo never feels delayed, but long enough to batch the ~7 sub-
// chunks an omp prompt redraw emits per keystroke into one ws
// message. Without it, the 7 chunks become 7 separate term.write
// calls inside one rAF window — measurably stalls that frame on
// the client (51 ms vs 17 ms baseline rAF gap, observed in browser).
//
// Native impls (ttyd, gotty) skip this because their TCP layer
// coalesces with kernel-side TCP_CORK; Node + ws + a chatty shell
// like omp benefit from an explicit JS-side batcher.
const COALESCE_INTERVAL_MS = 2;

interface OriginCheckOptions {
  /** Exact origins (scheme + host + optional port) allowed for remote upgrades. */
  allowedOrigins: string[];
  /** Hosts (without scheme) that may originate WS upgrades. Production. */
  allowedHosts: string[];
  /** Whether to additionally allow localhost-family hosts. Dev. */
  allowLocalhost: boolean;
}

function isAllowedOrigin(origin: string | undefined, opts: OriginCheckOptions): boolean {
  if (!origin) return false;
  let host: string;
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin) return false;
    host = parsed.host;
  } catch {
    return false;
  }
  if (opts.allowedOrigins.includes(origin)) return true;
  if (opts.allowedHosts.includes(host)) return true;
  if (opts.allowLocalhost) {
    if (host.startsWith('localhost:') || host === 'localhost') return true;
    if (host.startsWith('127.0.0.1:') || host === '127.0.0.1') return true;
    if (host.startsWith('[::1]:') || host === '[::1]') return true;
  }
  return false;
}

export interface PtyWsServerOptions {
  port: number;
  /** Exact production browser origins (e.g. ['https://operator.example.com']). */
  allowedOrigins?: string[];
  /** Production hosts to allow (e.g. ['operator.papercup.ai']). */
  allowedHosts?: string[];
  /** Allow localhost / loopback origins. Default true; set false in prod. */
  allowLocalhost?: boolean;
  /**
   * Resolved multi-worker cluster size (`resolveClusterWorkers(...)`). > 1 makes a
   * PTY WS server unserviceable in this process and is REFUSED — see
   * `ptyWsClusterRefusal`. Omitted / 1 ⇒ single-process, start normally.
   */
  clusterWorkers?: number;
}

/**
 * The single wire response for BOTH pre-upgrade rejections that must remain
 * indistinguishable to a caller (no registry entry here / no ticket presented).
 * It deliberately attributes NEITHER cause: see `verifyClient` below. The server
 * log names the real one.
 */
const PTY_UPGRADE_REJECTION = 'pty unavailable or ticket missing';

/**
 * Whether multi-worker clustering makes a PTY WS server unserviceable in this
 * process — and, if so, the one-line reason to log. `null` ⇒ safe to start.
 *
 * The pty registry `pty-bridge` keeps is IN-PROCESS state shared with this host's
 * HTTP `/pty/spawn` routes, so an attach must land in the same process that
 * spawned. Under `node:cluster` it cannot: exactly ONE worker wins the
 * PAPERCUSP_PTY_WS_PORT bind (the rest take the EADDRINUSE path below and skip),
 * while spawn requests round-robin across every acceptor. A terminal whose spawn
 * landed on any other worker finds no registry entry and is rejected at the
 * upgrade — so the failure rate is (workers-1)/workers, strictly interleaved.
 * That is the ~50% of terminal connections failing on the clustered :3070
 * (WI-10001638), and it has been broken since clustering arrived (2026-06-18),
 * NOT since the 2026-08-22 ticket hardening, which only renamed the symptom.
 *
 * The file header above this function already documented the two as incompatible
 * and asserted "the two never coexist". In this deployment they do:
 * papercup-dev-api.service.d/55-memory-envelope.conf sets
 * PAPERCUSP_CLUSTER_WORKERS=6 while PAPERCUSP_PTY_WS_PORT=3056 is also set. So
 * refusing to bind ENFORCES an invariant that was merely assumed, and deletes
 * nothing that worked: the desktop product — the shipping target — pins
 * PAPERCUSP_CLUSTER=0, where this predicate is `null` and terminals are unaffected.
 *
 * Pure + exported for tests; the caller passes the already-resolved worker count.
 */
export function ptyWsClusterRefusal(opts: { clusterWorkers?: number; port: number }): string | null {
  // The DECISION lives on the registry that actually breaks
  // (`ptyRegistryClusterRefusal`), shared with the HTTP/SSE control plane so the two
  // transports cannot disagree about whether terminals are serviceable. This function
  // only renders the WS-specific message. `?? 1` preserves this leg's own contract —
  // an omitted count means single-process here, because every real caller
  // (hono-host) passes the authoritative value and a bare call must not consult env.
  const workers = ptyRegistryClusterRefusal({ clusterWorkers: opts.clusterWorkers ?? 1 });
  if (workers == null) return null;
  return (
    `[pty-ws] REFUSING to start on port ${opts.port}: multi-worker clustering is ACTIVE ` +
    `(${workers} workers). The pty registry is per-process, so only 1-in-${workers} terminal ` +
    `attaches could ever find their handle — the rest would be rejected at the upgrade. ` +
    `Terminals are DISABLED in this process. To run terminals set PAPERCUSP_CLUSTER_WORKERS=0 ` +
    `(or PAPERCUSP_CLUSTER=0); to silence this, unset PAPERCUSP_PTY_WS_PORT.`
  );
}

// Pin started/serverRef on globalThis so HMR re-imports of this module
// (Next dev) don't double-bind the port. Same trick pty-bridge.ts uses
// for the handles map.
type WsGlobals = typeof globalThis & {
  __papercuspPtyWs?: { started: boolean; serverRef: WebSocketServer | null };
};
const _wsGlobals = globalThis as WsGlobals;
const wsState = _wsGlobals.__papercuspPtyWs ?? { started: false, serverRef: null as WebSocketServer | null };
_wsGlobals.__papercuspPtyWs = wsState;

/**
 * Start the pty WS server. Idempotent: a second call (typical under
 * Next dev's instrumentation re-register) is a no-op.
 */
export function startPtyWsServer(opts: PtyWsServerOptions): WebSocketServer | null {
  // Checked BEFORE the idempotency short-circuit on purpose: this is a
  // configuration precondition, not per-call state, so a clustered process must
  // never hand back a server — not even a previously-started one.
  const clusterRefusal = ptyWsClusterRefusal(opts);
  if (clusterRefusal) {
    console.error(clusterRefusal);
    return null;
  }
  if (wsState.started) return wsState.serverRef;
  wsState.started = true;

  const originOpts: OriginCheckOptions = {
    allowedOrigins: opts.allowedOrigins ?? [],
    allowedHosts: opts.allowedHosts ?? [],
    allowLocalhost: opts.allowLocalhost ?? true,
  };
  const verifiedUpgrades = new WeakMap<IncomingMessage, {
    ptyId: string;
    accessScope: PtyAccessScope;
  }>();

  const wss = new WebSocketServer({
    port: opts.port,
    handleProtocols(protocols) {
      return protocols.has(PTY_WS_PROTOCOL) ? PTY_WS_PROTOCOL : false;
    },
    // Authenticate and atomically redeem the one-time ticket before the server
    // emits a 101 response. A rejected browser never reaches `connection`, so a
    // bearerless socket cannot observe even whether a PTY handle exists.
    verifyClient(info, done) {
      const origin = info.origin;
      if (!isAllowedOrigin(origin, originOpts)) {
        done(false, 403, 'origin not allowed');
        return;
      }
      const match = (info.req.url ?? '').match(/^\/pty\/([a-f0-9-]{8,})\/?$/i);
      if (!match) {
        done(false, 404, 'unknown route');
        return;
      }
      const ptyId = match[1]!;
      const accessScope = getPtyAccessScope(ptyId);
      const ticket = ptyTicketFromProtocolHeader(info.req.headers['sec-websocket-protocol']);
      // TWO INDEPENDENT rejections that deliberately SHARE one wire response.
      //
      // `!accessScope` is an in-process REGISTRY MISS: this process never spawned
      // that pty (a stale or already-reaped id — or, before the cluster refusal in
      // startPtyWsServer, a spawn that landed on a different cluster worker).
      // `!ticket` is a genuinely BEARERLESS client. Keep them indistinguishable on
      // the wire: differentiating them would let any allowed-origin caller probe
      // which pty ids exist in this process, which is the property the header
      // comment above claims ("cannot observe even whether a PTY handle exists").
      //
      // They must be distinguishable IN THE LOG, though. Until 2026-09-17 these
      // were one branch answering `'pty ticket required'`, so a registry miss
      // accused the TICKET — and sent two separate investigations (2026-09-16,
      // 2026-09-17) hunting a ticket/HMAC bug that never existed. Whatever else
      // changes here, do not re-merge these two branches under one message.
      if (!accessScope) {
        console.warn(
          `[pty-ws] no registry entry for pty ${ptyId} in this process (pid ${process.pid}) — ` +
            'rejecting the upgrade. This is NOT a ticket failure: the pty was never spawned ' +
            'here, or its handle has already been reaped.',
        );
        done(false, 401, PTY_UPGRADE_REJECTION);
        return;
      }
      if (!ticket) {
        done(false, 401, PTY_UPGRADE_REJECTION);
        return;
      }
      const redeemed = redeemPtyTicket(ticket, {
        ...accessScope,
        ptyId,
        origin: origin!,
        protocol: PTY_WS_PROTOCOL,
      });
      if (!redeemed.ok) {
        done(false, 401, `pty ticket rejected: ${redeemed.reason}`);
        return;
      }
      verifiedUpgrades.set(info.req, { ptyId, accessScope });
      done(true);
    },
    perMessageDeflate: false, // we send mostly small frames, deflate adds latency
  });
  // EADDRINUSE recovery — if HMR re-imports this module and the
  // globalThis guard above doesn't carry across the new instance, the
  // bind will fail. Tear down cleanly so we don't accumulate orphan
  // listeners and reset wsState so a subsequent restart can rebind.
  wss.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[pty-ws] port ${opts.port} already in use — skipping`);
      try { wss.close(); } catch { /* */ }
      wsState.started = false;
      wsState.serverRef = null;
    } else {
      console.error('[pty-ws] server error:', err);
    }
  });
  wsState.serverRef = wss;

  wss.on('connection', (ws, req) => {
    const verified = verifiedUpgrades.get(req);
    if (!verified) {
      ws.close(4401, 'unverified upgrade');
      return;
    }
    verifiedUpgrades.delete(req);
    const { ptyId, accessScope } = verified;
    const handle = getPty(ptyId, accessScope);
    // Accept a connection to an already-EXITED pty while its handle is still in
    // the 30 s grace window (pty-bridge reaps killed handles 30 s after exit
    // precisely so a late subscriber can read the final screen + exit code).
    // attachWsToPty serves an exited handle correctly: it replays the screen
    // serialization and, because handle.exitCode is set, delivers the `exit`
    // frame and closes. Rejecting `handle.killed` here defeated that grace
    // window and raced a fast `exit`-ing command — if the pty won the race
    // against this connection handler the exit frame was dropped (the client
    // saw `open` but never an `exit` frame). Only a missing/reaped handle is a
    // real 4410.
    if (!handle) {
      ws.close(4410, 'pty not found');
      return;
    }

    void attachWsToPty(ws, ptyId, accessScope);
  });

  // ── Heartbeat (gotty / ttyd shape) ──────────────────────────────────
  // Server pings every PING_INTERVAL_MS. If a client misses two pongs
  // in a row, the connection is terminate()d so we don't accumulate
  // half-open sockets behind reverse proxies that silently drop idle
  // connections after N minutes. ws library tracks pong responses via
  // `isAlive` flag (canonical pattern from the README).
  const PING_INTERVAL_MS = 30_000;
  const pingInterval = managedSetInterval('pty-ws-keepalive', PING_INTERVAL_MS, () => {
    for (const ws of wss.clients) {
      const tagged = ws as WebSocket & { _isAlive?: boolean };
      if (tagged._isAlive === false) {
        try { ws.terminate(); } catch { /* */ }
        continue;
      }
      tagged._isAlive = false;
      try { ws.ping(); } catch { /* */ }
    }
  }, { category: 'lifecycle', instanced: true });
  wss.on('connection', (ws) => {
    const tagged = ws as WebSocket & { _isAlive?: boolean };
    tagged._isAlive = true;
    ws.on('pong', () => { tagged._isAlive = true; });
  });
  wss.on('close', () => pingInterval.stop());

  wss.on('listening', () => {
    const addr = wss.address();
    const where = typeof addr === 'string' ? addr : `:${addr?.port}`;
    console.log(`[pty-ws] listening on ${where}`);
  });

  wss.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Likely a stale instrumentation re-run from a previous process —
      // give up silently rather than crash the whole operator.
      console.warn(`[pty-ws] port ${opts.port} in use; another operator instance may be running`);
      wsState.started = false;
      return;
    }
    console.error('[pty-ws] server error:', err);
  });

  return wss;
}

async function attachWsToPty(ws: WebSocket, ptyId: string, accessScope: PtyAccessScope): Promise<void> {
  const handle = getPty(ptyId, accessScope);
  if (!handle) { ws.close(); return; }

  // PTY-panel viewer-attach signal (pty-viewer-heartbeat.ts): record that a human is
  // now viewing this session's terminal so the idle-session reaper hard-exempts its
  // owner — the panel case the wmctrl on-desktop signal can't see. Fire-and-forget +
  // best-effort (never blocks the socket); refreshed on each keepalive pong
  // (PING_INTERVAL_MS = 30s) and cleared on close below.
  void recordViewerAttached(ptyId, handle.ownerSid);
  ws.on('pong', () => { void refreshViewerAttached(ptyId); });

  // ── Server → client coalesce + flow control ─────────────────────────
  // Outgoing chunks are coalesced for COALESCE_INTERVAL_MS into one
  // binary frame (VS Code's TerminalDataBufferer pattern). When the
  // unacknowledged byte count exceeds HIGH_WATERMARK_BYTES we pause
  // the pty (writes from the child block at the kernel pty buffer);
  // the client sends {type:"ack", bytes} as it consumes data, and we
  // resume once back below LOW_WATERMARK_BYTES. node-pty's pause/
  // resume is documented as the right primitive for this.
  let unacked = 0;
  let paused = false;
  // Tinybuffer state: any pending chunks that arrived inside the
  // current 2 ms window. The first chunk after an idle period sets
  // the timer; subsequent chunks within the window get appended.
  let pendingChunks: Buffer[] = [];
  let pendingBytes = 0;
  let flushTimer: NodeJS.Timeout | null = null;

  const flush = () => {
    flushTimer = null;
    if (pendingChunks.length === 0) return;
    const merged = pendingChunks.length === 1 ? pendingChunks[0] : Buffer.concat(pendingChunks);
    pendingChunks = [];
    pendingBytes = 0;
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(merged, { binary: true }); } catch { /* socket likely closing */ }
  };

  const onData = (chunk: Buffer) => {
    unacked += chunk.length;
    pendingChunks.push(chunk);
    pendingBytes += chunk.length;
    if (!flushTimer) flushTimer = setTimeout(flush, COALESCE_INTERVAL_MS);
    if (!paused && unacked > HIGH_WATERMARK_BYTES) {
      paused = true;
      try { handle.pty.pause(); } catch { /* node-pty may not support pause on all platforms */ }
    }
  };

  let exitDelivered = false;
  const onExit = (code: number) => {
    if (exitDelivered) return; // idempotent — handle both the live event and the already-exited replay below
    exitDelivered = true;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flush();
    try { ws.send(JSON.stringify({ type: 'exit', code }), { binary: false }); } catch { /* */ }
    try { ws.close(1000, 'pty exited'); } catch { /* */ }
  };

  // Replay current screen state (P4): a string of ANSI escapes that,
  // written into a fresh client xterm, reproduces the canonical screen
  // including scrollback. Bounded by terminal size, not session bytes
  // — orders of magnitude smaller than the byte history for any pty
  // that has run more than a few seconds, and inherently
  // geometry-correct for vim/htop because the headless Terminal
  // resizes alongside the pty.
  const replay = await getScreenSerialization(ptyId, accessScope);
  if (replay && replay.length > 0) {
    const buf = Buffer.from(replay, 'utf8');
    unacked += buf.length;
    if (ws.readyState === ws.OPEN) {
      try { ws.send(buf, { binary: true }); } catch { /* socket closing */ }
    }
  }

  handle.onData.add(onData);
  handle.onExit.add(onExit);
  // The pty may have already exited during the `await getScreenSerialization`
  // above (e.g. a fast `exit`-ing command). In that case the exit event already
  // fired and handle.onExit was cleared, so the handler we just added will
  // never run — deliver the exit frame + close now from the recorded exitCode.
  if (handle.exitCode !== null) {
    onExit(handle.exitCode);
  }

  // ── Client → server input + control frames ──────────────────────────
  ws.on('message', (data, isBinary) => {
    markActive(ptyId, accessScope);
    if (isBinary) {
      // Raw bytes from xterm input.
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      writePty(ptyId, buf, accessScope);
      return;
    }
    // Text frame: JSON control message.
    let msg: { type?: string; cols?: number; rows?: number; bytes?: number };
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch { return; }
    switch (msg.type) {
      case 'resize':
        if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          resizePty(ptyId, Math.floor(msg.cols), Math.floor(msg.rows), accessScope);
        }
        break;
      case 'ack':
        if (typeof msg.bytes === 'number' && msg.bytes > 0) {
          unacked = Math.max(0, unacked - msg.bytes);
          if (paused && unacked < LOW_WATERMARK_BYTES) {
            paused = false;
            try { handle.pty.resume(); } catch { /* see pause */ }
          }
        }
        break;
      case 'kill':
        killPty(ptyId, accessScope);
        break;
      // Unknown types are ignored — forward-compat.
    }
  });

  ws.on('close', () => {
    void clearViewerAttached(ptyId); // drop the viewer-attach signal (pty-viewer-heartbeat.ts)
    handle.onData.delete(onData);
    handle.onExit.delete(onExit);
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (paused) {
      // Don't leave the pty paused if the only consumer disconnected.
      try { handle.pty.resume(); } catch { /* */ }
    }
    // Intentionally NOT calling killPty: the pty stays alive on the
    // server so a remount (tab switch back) can resume it via the
    // existing resumePtyId path. Same policy as the SSE handler.
  });

  ws.on('error', () => { /* let close handler do cleanup */ });
}
