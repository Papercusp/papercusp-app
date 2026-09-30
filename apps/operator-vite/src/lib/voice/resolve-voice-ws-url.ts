/**
 * Deterministic discovery of the desktop voice bridge URL
 * (holepunch-voice-channels-2026-06-05 P-015, D-014 item 3).
 *
 * The bridge (desktop-voice-ws) binds DESKTOP_VOICE_WS_PORT (default 3076) with
 * an 8-port walk on EADDRINUSE, so the webview can't just assume :3076. The
 * operator surfaces the CHOSEN port via `GET /api/desktop/voice-config`
 * (mirroring the mobile `getMobileVoicePort()` runtime-config pattern); this
 * helper resolves it once per page load and falls back to the common default
 * when the route is unreachable (the walk only triggers when 3076 is taken).
 */
import { DEFAULT_DESKTOP_VOICE_WS_URL, DESKTOP_VOICE_WS_PATH } from '../video/desktop-video-protocol';

export interface DesktopVoiceConfig {
  port: number | null;
  path: string;
  sampleRate?: number;
  frameSamples?: number;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

let cached: Promise<string> | null = null;

/** Test-only: drop the per-page-load cache. */
export function _resetVoiceWsUrlCacheForTests(): void {
  cached = null;
}

async function resolveOnce(fetchImpl: FetchLike): Promise<string> {
  try {
    const res = await fetchImpl('/api/desktop/voice-config');
    if (res.ok) {
      const cfg = (await res.json()) as DesktopVoiceConfig | null;
      if (cfg && typeof cfg.port === 'number' && Number.isFinite(cfg.port)) {
        const path = typeof cfg.path === 'string' && cfg.path ? cfg.path : DESKTOP_VOICE_WS_PATH;
        return `ws://127.0.0.1:${cfg.port}${path}`;
      }
    }
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_DESKTOP_VOICE_WS_URL;
}

/**
 * The voice-bridge WS URL, runtime-config-resolved (cached per page load).
 * Never rejects — falls back to the :3076 default on any failure.
 */
export function resolveDesktopVoiceWsUrl(fetchImpl?: FetchLike): Promise<string> {
  if (fetchImpl) return resolveOnce(fetchImpl); // injected fetch = test path, uncached
  if (!cached) cached = resolveOnce((u) => fetch(u));
  return cached;
}
