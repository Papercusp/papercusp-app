/**
 * WS bridge for the DESKTOP voice surface (holepunch-voice-channels P-015, D-002).
 *
 * The Tauri webview is a browser context and can't open the operator's local
 * voice unix socket (`local-audio-socket`) directly, so this exposes that exact
 * binary protocol over a loopback WebSocket. It is a DUMB BYTE PIPE: the browser
 * and the unix socket both speak the same `[4B len][1B type][payload]` framing
 * (@papercusp/p2p-voice), so the bridge forwards bytes verbatim in both
 * directions — CTRL/MIC up, CTRL(status/channels)/MIX down. The desktop client
 * reuses the same FrameDecoder + encodeFrame helpers the pui's Rust client
 * mirrors, so one voice channel works identically on desktop and in the pui.
 *
 * Auth: loopback only — the desktop is the local user's own machine (same model
 * as the operator's other local surfaces). Remote peers are rejected at connect.
 *
 * Port handling mirrors device-voice-ws: a dedicated port (DESKTOP_VOICE_WS_PORT,
 * default 3076) with an 8-port walk on EADDRINUSE; the chosen port is exported
 * via getDesktopVoicePort() for the runtime-config surface the webview reads.
 *
 * Scope: this transport bridge is the verifiable core of P-015. The getUserMedia
 * capture + Web-Audio playback + channel UI live in the desktop webview
 * (operator-vite) and need a live Tauri shell + a microphone to verify — that's
 * the remaining P-015 slice (see plan decision D-014).
 */
import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { startLocalVoiceSocket } from './local-audio-socket';
import { isReservedServicePort } from '../reserved-service-ports';
import { foreignLoopbackPeerForSocket } from '../auth/loopback-peer-trust';

// Read at start time (not module init) so launch wrappers/tests that set the
// env after import still take effect.
const basePort = () => Number(process.env.DESKTOP_VOICE_WS_PORT ?? 3076);
const PORT_RANGE = 8;
const WS_PATH = '/api/desktop/voice';

// Pin state on globalThis so dev HMR re-imports don't re-trigger the port-walk
// (mirrors device-voice-ws's mvState).
type DesktopVoiceGlobals = typeof globalThis & {
  __papercuspDesktopVoiceWs?: {
    started: boolean;
    chosenPort: number | null;
    wss: WebSocketServer | null;
  };
};
const _g = globalThis as DesktopVoiceGlobals;
const dvState = _g.__papercuspDesktopVoiceWs ?? {
  started: false,
  chosenPort: null as number | null,
  wss: null as WebSocketServer | null,
};
_g.__papercuspDesktopVoiceWs = dvState;

export function getDesktopVoicePort(): number | null {
  return dvState.chosenPort;
}

/**
 * Test-only seam: expose the bound address so integration tests can verify
 * the listener is actually loopback-only, rather than relying on the
 * application-layer remote-address check after accepting a remote socket.
 */
export function _getDesktopVoiceWsAddressForTests(): ReturnType<WebSocketServer['address']> {
  return dvState.wss?.address() ?? null;
}

/**
 * Test-only seam: close the listening server and reset module state so a
 * subsequent `startDesktopVoiceWs()` binds fresh. Never called in production.
 */
export function _stopDesktopVoiceWsForTests(): Promise<void> {
  const cur = dvState.wss;
  dvState.started = false;
  dvState.chosenPort = null;
  dvState.wss = null;
  return new Promise<void>((resolve) => {
    if (!cur) return resolve();
    try {
      cur.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

export function startDesktopVoiceWs(): void {
  if (dvState.started) return;
  dvState.started = true;
  void tryListen(basePort(), 0);
}

async function tryListen(port: number, attempt: number): Promise<void> {
  // Never squat a core service's canonical port (EI-294 class): a reserved
  // port that's free right now belongs to a service whose next (re)start
  // would crash-loop on EADDRINUSE behind our WS-only listener. The walk
  // still consumes the attempt so the range stays bounded.
  if (isReservedServicePort(port)) {
    if (attempt + 1 < PORT_RANGE) {
      console.warn(`[desktop-voice] port ${port} is a reserved papercusp service port — skipping`);
      void tryListen(port + 1, attempt + 1);
    } else {
      console.error(
        `[desktop-voice] FATAL: walk exhausted at reserved port ${port}; desktop voice WS will not start.`,
      );
      dvState.started = false;
    }
    return;
  }
  const wss = new WebSocketServer({ host: '127.0.0.1', port, path: WS_PATH });
  wss.on('connection', handleConnection);
  wss.on('listening', () => {
    dvState.chosenPort = port;
    dvState.wss = wss;
    console.log(`[desktop-voice] listening on :${port}${WS_PATH}`);
  });
  wss.on('error', (e) => {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      if (attempt + 1 < PORT_RANGE) {
        const next = port + 1;
        console.warn(`[desktop-voice] port ${port} in use, trying ${next}`);
        try {
          wss.close();
        } catch {
          /* ignore */
        }
        void tryListen(next, attempt + 1);
        return;
      }
      console.error(
        `[desktop-voice] FATAL: ports ${basePort()}..${port} all in use; ` +
          `desktop voice WS will not start.`,
      );
      dvState.started = false;
      return;
    }
    console.error('[desktop-voice] server error', e);
  });
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

export function handleConnection(ws: WebSocket, req: IncomingMessage): void {
  if (!isLoopback(req)) {
    ws.close(1008, 'loopback only');
    return;
  }
  // WI-10003621: on a hosted workspace host the customer account shares loopback, so the
  // address alone would pipe a customer process into the operator's voice socket.
  if (foreignLoopbackPeerForSocket(req.socket)) {
    ws.close(1008, 'loopback peer uid denied');
    return;
  }
  let socketPath: string;
  try {
    socketPath = startLocalVoiceSocket().socketPath;
  } catch (e) {
    console.error('[desktop-voice] voice socket unavailable', e);
    ws.close(1011, 'voice socket unavailable');
    return;
  }
  bridgeConnection(ws, socketPath);
}

/** The minimal WS surface the byte-pipe needs (satisfied by `ws.WebSocket`). */
export interface BridgeWs {
  on(event: 'message', cb: (data: Buffer) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/**
 * Byte-pipe a desktop WS ↔ the local voice unix socket. Forwards bytes verbatim
 * in both directions and tears down each side when the other closes. Exported
 * for the integration test (driven with a mock unix socket + a fake WS).
 */
export function bridgeConnection(ws: BridgeWs, socketPath: string): void {
  const sock = net.connect(socketPath);
  let open = true;
  const closeBoth = () => {
    if (!open) return;
    open = false;
    try {
      sock.destroy();
    } catch {
      /* gone */
    }
    try {
      ws.close();
    } catch {
      /* gone */
    }
  };
  sock.on('data', (chunk: Buffer) => {
    try {
      ws.send(chunk);
    } catch {
      /* ws gone */
    }
  });
  sock.on('error', closeBoth);
  sock.on('close', closeBoth);
  ws.on('message', (data: Buffer) => {
    try {
      sock.write(data);
    } catch {
      /* socket gone */
    }
  });
  ws.on('close', closeBoth);
}
