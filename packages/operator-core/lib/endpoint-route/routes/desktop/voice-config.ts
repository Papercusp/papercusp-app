/**
 * GET /api/desktop/voice-config  (+ OPTIONS preflight)
 *
 * Runtime-config for the desktop voice surface (holepunch-voice-channels
 * P-015, D-014 item 3): the webview's deterministic discovery of the voice
 * bridge. `desktop-voice-ws` binds DESKTOP_VOICE_WS_PORT (default 3076) with
 * an 8-port walk on EADDRINUSE, so the webview can't assume :3076 — this
 * route returns the CHOSEN port (mirroring the mobile `getMobileVoicePort()`
 * runtime-config pattern on /device/runtime-config).
 *
 * `port` is null until the bridge finishes binding (host-bootstrap starts it
 * at boot, so in practice it's set by the time the webview asks); the client
 * helper (`resolveDesktopVoiceWsUrl`) falls back to the default on null.
 *
 * auth: 'public' mirrors /desktop/version — the payload is a loopback port
 * number + audio constants (nothing owner-level); the WS itself rejects
 * non-loopback peers at connect.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getDesktopVoicePort } from '../../../voice-node/desktop-voice-ws';
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from '../../../voice-node/codec';

const WS_PATH = '/api/desktop/voice';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default [
  defineTool({
    method: 'GET',
    path: '/desktop/voice-config',
    auth: 'public',
    handler() {
      return new Response(
        JSON.stringify({
          port: getDesktopVoicePort(),
          path: WS_PATH,
          sampleRate: VOICE_SAMPLE_RATE,
          frameSamples: VOICE_FRAME_SAMPLES,
        }),
        { headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
      );
    },
  }),
  defineTool({
    method: 'OPTIONS',
    path: '/desktop/voice-config',
    auth: 'public',
    handler() {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    },
  }),
];
