/**
 * cache-proxy entry (gateway-cache-plane-shared-prefix-ttl-2026-07-19 P-006).
 *
 * A deliberately tiny, deploy-independent process: it applies the prompt-cache request-body
 * policy to default-account (non-gateway) Claude traffic and forwards to Anthropic with the
 * caller's own credentials. Run by papercup-cache-proxy.service; never restarted by a :3070
 * deploy, so a deploy can't drop inference requests.
 *
 * Env:
 *   PAPERCUSP_CACHE_PROXY_PORT   listen port (default 9073)
 *   PAPERCUSP_CACHE_PROXY_HOST   listen host (default 127.0.0.1)
 *   PAPERCUSP_CACHE_UPSTREAM     upstream host (default api.anthropic.com)
 *   PAPERCUSP_CACHE_POLICY=0             disable the rewrite entirely (pure passthrough)
 *   PAPERCUSP_CACHE_TOOLS_BREAKPOINT=0   ttl-only mode (no shared tools-span breakpoint)
 */
import { startCacheProxy } from '../lib/cache-proxy/proxy';

const port = Number(process.env.PAPERCUSP_CACHE_PROXY_PORT ?? 9073);
const host = process.env.PAPERCUSP_CACHE_PROXY_HOST ?? '127.0.0.1';
const upstreamHost = process.env.PAPERCUSP_CACHE_UPSTREAM ?? 'api.anthropic.com';

startCacheProxy({ listenPort: port, listenHost: host, upstreamHost });

// A crash here silently strips every default-account session of the cache policy, so make the
// failure loud in the journal rather than dying quietly.
process.on('uncaughtException', (e) => {
  console.error('[cache-proxy] uncaught', e);
});
process.on('unhandledRejection', (e) => {
  console.error('[cache-proxy] unhandled rejection', e);
});
