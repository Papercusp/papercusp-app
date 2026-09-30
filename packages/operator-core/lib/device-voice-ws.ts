/**
 * WS transport for /api/device/voice. Pure pipe: validate JWT, forward
 * transcripts to the dispatcher, write back any frames the dispatcher
 * emits. All logic lives in `device-voice-dispatch.ts` (and is unit-tested).
 *
 * Why a separate WS server: Next App Router can't expose ws-upgrade hooks
 * to route handlers. The pty router uses the same workaround.
 *
 * v1 protocol (text only):
 *   client → server: { kind: 'hello', wakeWord? }                 (once on connect)
 *                  | { kind: 'transcript', text }                 (each utterance)
 *                  | { kind: 'status', status: 'idle'|'speaking' } (phone TTS state)
 *   server → client: { kind: 'speak', text, source, agentId?, format? }
 *                  | { kind: 'status', status }
 *
 * Phone runs Web Speech locally; this WS carries plain text in both directions.
 *
 * Port handling: tries `MOBILE_VOICE_WS_PORT` (default 3068), falls back
 * through the next 8 ports on EADDRINUSE. The chosen port is exported via
 * `getMobileVoicePort()` and surfaced through `/api/device/runtime-config`
 * so the phone connects deterministically. If all ports fail, logs loudly
 * — silent failure on this path leaves voice mysteriously dead.
 *
 * Default port note: was 3056 historically, which collided with pty-ws
 * (also 3056) — under HMR re-runs of this module's caller this WSS would
 * walk up the range (3057, 3058, …) and squat ports the marketplace-api
 * needs. Default is now 3068 so the two servers stay independent.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import type { IncomingMessage } from 'node:http';
import { verifyDeviceToken } from './device-jwt';
import { dispatchTranscript, type OutgoingFrame } from './device-voice-dispatch';
import { RESERVED_SERVICE_PORTS } from './reserved-service-ports';
import { loopbackPeerUidPolicyActive } from './auth/loopback-peer-trust';

// Read at start time (not module init) so launch wrappers/tests that set the
// env after import still take effect.
const basePort = () => Number(process.env.MOBILE_VOICE_WS_PORT ?? 3068);
const PORT_RANGE = 8;
// Papercusp service ports the walk must NEVER squat (EI-294: with 3068 held,
// the staging host's walk reached :3070 during a green-host restart window
// and the voice WSS answered the operator API port with 426s while the real
// host crash-looped on EADDRINUSE). Shared canonical set — desktop-voice-ws
// guards its walk with the same one.
const RESERVED_PORTS = RESERVED_SERVICE_PORTS;
const DEFAULT_WAKE_WORD = process.env.MOBILE_WAKE_WORD ?? 'hey operator';

// Pin started/chosenPort on globalThis so Next dev HMR re-imports of
// this module don't re-trigger the port-walk. Module-local `let started`
// resets on each fresh module instance, and the caller is a route
// handler (`api/[[...route]]/route.ts`), which Next re-imports on edits
// to any file in the route's chunk graph.
type MobileVoiceGlobals = typeof globalThis & {
  __papercuspMobileVoiceWs?: {
    started: boolean;
    chosenPort: number | null;
    wss: WebSocketServer | null;
  };
};
const _mvGlobals = globalThis as MobileVoiceGlobals;
const mvState = _mvGlobals.__papercuspMobileVoiceWs ?? {
  started: false,
  chosenPort: null,
  wss: null,
};
_mvGlobals.__papercuspMobileVoiceWs = mvState;

export function getMobileVoicePort(): number | null {
  return mvState.chosenPort;
}

/**
 * Test-only seam: close the listening server (if one is up) and reset module
 * state so a subsequent `startMobileVoiceWs()` binds fresh. Mirrors the
 * `_reset*ForTests` seams used elsewhere (e.g. agent-mcp's
 * `_resetStateChannelForTests`). Never called in production. Returns a promise
 * that resolves once the socket is fully closed, so a port can be rebound.
 */
export function _stopMobileVoiceWsForTests(): Promise<void> {
  const cur = mvState.wss;
  mvState.started = false;
  mvState.chosenPort = null;
  mvState.wss = null;
  return new Promise<void>((resolve) => {
    if (!cur) return resolve();
    try {
      cur.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

export function startMobileVoiceWs(): void {
  if (mvState.started) return;
  mvState.started = true;
  void tryListen(basePort(), 0);
}

async function tryListen(port: number, attempt: number): Promise<void> {
  // Skip reserved papercusp service ports instead of binding them (the walk
  // still consumes the attempt so the range stays bounded).
  if (RESERVED_PORTS.has(port)) {
    if (attempt + 1 < PORT_RANGE) {
      console.warn(`[mobile-voice] port ${port} is a reserved papercusp service port — skipping`);
      void tryListen(port + 1, attempt + 1);
    } else {
      console.error(
        `[mobile-voice] FATAL: walk exhausted at reserved port ${port}; voice WS will not start.`,
      );
      mvState.started = false;
    }
    return;
  }
  const wss = new WebSocketServer({
    port,
    // WI-10003621: a hosted workspace host has no LAN phone to serve, so the
    // all-interfaces bind is pure exposure there; keep it loopback-only.
    ...(loopbackPeerUidPolicyActive() ? { host: '127.0.0.1' } : {}),
    path: '/api/device/voice',
    // Accept any `papercusp.bearer.*` subprotocol the client offers
    // (header-auth path). Clients on the legacy `?token=` path send no
    // subprotocol and `handleProtocols` is not invoked, so the connection
    // opens as before. Auth is enforced in handleConnection.
    handleProtocols: (protocols) => {
      for (const p of protocols) if (p.startsWith('papercusp.bearer.')) return p;
      // First protocol the client offered is best fallback — never
      // reject just because of subprotocol mismatch (auth comes later).
      const arr = Array.from(protocols);
      return arr[0] ?? false;
    },
  });

  wss.on('connection', handleConnection);

  wss.on('listening', () => {
    mvState.chosenPort = port;
    mvState.wss = wss;
    console.log(`[mobile-voice] listening on :${port}/api/device/voice`);
  });

  wss.on('error', (e) => {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      if (attempt + 1 < PORT_RANGE) {
        const next = port + 1;
        console.warn(`[mobile-voice] port ${port} in use, trying ${next}`);
        try { wss.close(); } catch { /* ignore */ }
        void tryListen(next, attempt + 1);
        return;
      }
      console.error(
        `[mobile-voice] FATAL: ports ${basePort()}..${port} all in use; ` +
        `voice WS will not start. Mobile clients won't be able to connect.`,
      );
      mvState.started = false;
      return;
    }
    console.error('[mobile-voice] server error', e);
  });
}

export function handleConnection(ws: WebSocket, req: IncomingMessage): void {
  // Auth: prefer Sec-WebSocket-Protocol (header-based, doesn't leak into
  // proxy access logs), fall back to ?token=<jwt> for browser dev / older
  // clients. The phone uses subprotocol form `papercusp.bearer.<jwt>`.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const subproto = String(req.headers['sec-websocket-protocol'] ?? '');
  const protoToken = subproto.startsWith('papercusp.bearer.')
    ? subproto.slice('papercusp.bearer.'.length).split(',')[0].trim()
    : '';
  const token = protoToken || (url.searchParams.get('token') ?? '');
  const claims = verifyDeviceToken(token);
  if (!claims) {
    ws.close(1008, 'unauthorized');
    return;
  }

  console.log(`[mobile-voice] device=${claims.sub} ws=open`);
  ws.send(JSON.stringify({ kind: 'status', status: 'idle' }));

  // Periodic WS ping to keep the connection alive across NAT and the
  // Android WebView's idle-close behavior (~30s). Browsers and ws
  // respond to ping with pong automatically, so the phone doesn't
  // need any new code.
  let alive = true;
  const pinger = managedSetInterval('device-voice-ws-ping', 20_000, () => {
    if (!alive) {
      try { ws.terminate(); } catch { /* ignore */ }
      return;
    }
    alive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }, { category: 'lifecycle', instanced: true });
  ws.on('pong', () => { alive = true; });
  ws.on('close', () => pinger.stop());

  // Per-connection state — wake word arrives in `hello`, then is cached
  // for the lifetime of the connection. Prevents per-transcript drift if
  // the user toggles wake-word mid-session.
  let wakeWord = DEFAULT_WAKE_WORD;
  let phoneSpeaking = false;

  const send = (frame: OutgoingFrame) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };

  ws.on('message', async (data) => {
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.kind === 'hello') {
      if (typeof msg.wakeWord === 'string' && msg.wakeWord.length > 0) {
        wakeWord = msg.wakeWord;
      }
      return;
    }

    if (msg.kind === 'status') {
      // Phone tells us when its TTS is busy so we can suppress further
      // dispatch frames during that window (avoids stacking utterances).
      phoneSpeaking = msg.status === 'speaking';
      return;
    }

    if (msg.kind === 'transcript' && typeof msg.text === 'string') {
      // Optional back-compat: phones from before the hello frame still
      // send wakeWord per-transcript. Honor it.
      if (typeof msg.wakeWord === 'string' && msg.wakeWord.length > 0) {
        wakeWord = msg.wakeWord;
      }
      if (phoneSpeaking) {
        // The phone shouldn't send transcripts while speaking, but if
        // it does (TTS feedback bleed), drop them — better than echoing.
        return;
      }
      await dispatchTranscript(claims, msg.text, wakeWord, send);
    }
  });

  ws.on('close', () => console.log(`[mobile-voice] device=${claims.sub} ws=close`));
  ws.on('error', (e) => console.error('[mobile-voice] error', e));
}
