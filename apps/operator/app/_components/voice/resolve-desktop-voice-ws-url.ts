/**
 * resolve-desktop-voice-ws-url — deterministic discovery of the desktop voice
 * bridge URL for the OPERATOR-VOICE client (voice-unified-sentinel-pipeline
 * P-009, paritying the channel client's resolve-voice-ws-url).
 *
 * The bridge (desktop-voice-ws) binds DESKTOP_VOICE_WS_PORT (default 3076) with
 * an 8-port walk on EADDRINUSE, so the webview can't just assume :3076. The
 * operator surfaces the CHOSEN port via `GET /api/desktop/voice-config`; this
 * helper resolves it once per page load and falls back to the common default
 * when the route is unreachable (the walk only triggers when 3076 is taken).
 */

export const DEFAULT_DESKTOP_VOICE_WS_PATH = '/api/desktop/voice';
export const DEFAULT_DESKTOP_VOICE_WS_URL = 'ws://127.0.0.1:3076/api/desktop/voice';

interface DesktopVoiceConfig {
  port?: unknown;
  path?: unknown;
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

let cached: Promise<string> | null = null;

/** Test-only: drop the per-page-load cache. */
export function _resetDesktopVoiceWsUrlCacheForTests(): void {
  cached = null;
}

async function resolveOnce(fetchImpl: FetchLike): Promise<string> {
  try {
    const res = await fetchImpl('/api/desktop/voice-config');
    if (res.ok) {
      const cfg = (await res.json().catch(() => null)) as DesktopVoiceConfig | null;
      if (cfg && typeof cfg.port === 'number' && Number.isFinite(cfg.port)) {
        const path =
          typeof cfg.path === 'string' && cfg.path ? cfg.path : DEFAULT_DESKTOP_VOICE_WS_PATH;
        return `ws://127.0.0.1:${cfg.port}${path}`;
      }
    }
  } catch {
    /* route unreachable — fall through to the default */
  }
  return DEFAULT_DESKTOP_VOICE_WS_URL;
}

/** Resolve the operator-voice WS URL (cached per page load). */
export function resolveDesktopVoiceWsUrl(
  fetchImpl?: FetchLike,
): Promise<string> {
  if (fetchImpl) return resolveOnce(fetchImpl);
  if (!cached) cached = resolveOnce((u) => fetch(u) as unknown as ReturnType<FetchLike>);
  return cached;
}
