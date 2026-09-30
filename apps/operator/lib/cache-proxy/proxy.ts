/**
 * Transparent Anthropic prompt-cache proxy
 * (gateway-cache-plane-shared-prefix-ttl-2026-07-19 P-006, D-005).
 *
 * WHY: the prompt-cache rewrites (extended ttl + the org-shared tools-span breakpoint) can only
 * be applied where we control the REQUEST BODY. The inference gateway is that point for
 * pool-routed sessions — but the fleet launches almost everything with `--account=default`,
 * which deliberately SKIPS the gateway and uses the machine's own Claude credential. Those
 * sessions are also the LARGEST single sharing cohort (one org = one cache pool), so leaving
 * them uncovered would forfeit most of the win.
 *
 * WHAT THIS IS NOT: an account substitution. This proxy forwards the client's ORIGINAL
 * credentials verbatim (Authorization / x-api-key, anthropic-version, anthropic-beta, …). The
 * upstream sees the same identity, the same org, the same billing as a direct call. The ONLY
 * difference is the body rewrite. [owner 2026-07-19 "cant we also make the default-account
 * take advantage of these features too... the caching is org scoped"]
 *
 * WHY NOT REUSE THE GATEWAY: the gateway owns account-pool selection and 503s when no pool
 * account is available. Default-account traffic must never inherit that failure mode — it has
 * its own working credential and must keep working when the pool is empty, throttled, or down.
 * Hence a separate, deliberately minimal process, modeled on the mcp-proxy pattern that has
 * proven deploy-independent in production (its own systemd unit + liveness watchdog, so a
 * :3070 deploy never restarts it).
 *
 * DESIGN RULES (reliability first — this sits in the path of every inference request):
 *  - NO retries, NO buffering of responses: bodies stream straight through (SSE included), so
 *    latency and streaming semantics are unchanged. Claude Code owns its own retry policy.
 *  - NO timeouts imposed on upstream: an inference request legitimately runs for minutes.
 *  - A rewrite failure is never fatal — the original bytes forward unchanged.
 *  - A connect failure surfaces as 502 so the client's own retry handles it.
 */
import http from 'node:http';
import https from 'node:https';
import {
  CACHE_POLICY_VERSION,
  deferLargeToolsEnabled,
  deferMinToolBytesFromEnv,
  rewriteAnthropicCacheBody,
} from '@papercusp/operator-core/lib/inference-gateway/cache-policy';

export interface CacheProxyOptions {
  listenPort: number;
  listenHost?: string;
  /** Upstream host — api.anthropic.com in production; a local stub in tests. */
  upstreamHost?: string;
  upstreamPort?: number;
  /** Use plain HTTP upstream (tests only; production is TLS). */
  upstreamInsecure?: boolean;
  log?: (msg: string) => void;
}

/** Headers we must not copy verbatim: hop-by-hop + framing we recompute. `host` is re-derived
 *  so TLS SNI and the upstream vhost match; `content-length` changes when we rewrite. */
const STRIP_REQUEST = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'proxy-connection']);
const STRIP_RESPONSE = new Set(['connection', 'transfer-encoding', 'keep-alive']);

/** Only `/v1/messages` carries a cacheable prompt; everything else (models, count_tokens,
 *  batches) forwards untouched. */
export function isCacheableAnthropicPath(url: string): boolean {
  return url.startsWith('/v1/messages') && !url.startsWith('/v1/messages/batches') && !url.includes('count_tokens');
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface CacheProxyStats {
  requests: number;
  rewritten: number;
  ttlUpgraded: number;
  toolsBreakpointInjected: number;
  toolsBreakpointSkippedNoBudget: number;
  /** Tool-search sessions: every tool deferred ⇒ no legal cache anchor (defer_loading +
   *  cache_control on one tool is a hard 400). Expected to be the COMMON case fleet-wide. */
  toolsBreakpointSkippedAllDeferred: number;
  /** P-004: requests where the stable/volatile system split fired (the shared-playbook win). */
  boundarySplit: number;
  upstreamErrors: number;
}

export function createCacheProxy(opts: CacheProxyOptions): http.Server & { stats: CacheProxyStats } {
  const log = opts.log ?? ((s: string) => console.log(`[cache-proxy] ${s}`));
  const upstreamHost = opts.upstreamHost ?? 'api.anthropic.com';
  const upstreamPort = opts.upstreamPort ?? (opts.upstreamInsecure ? 80 : 443);
  const transport = opts.upstreamInsecure ? http : https;
  const stats: CacheProxyStats = {
    requests: 0,
    rewritten: 0,
    ttlUpgraded: 0,
    toolsBreakpointInjected: 0,
    toolsBreakpointSkippedNoBudget: 0,
    toolsBreakpointSkippedAllDeferred: 0,
    boundarySplit: 0,
    upstreamErrors: 0,
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '/';

      // Liveness endpoint for the launcher's spawn-time check + the watchdog. Answered
      // LOCALLY (never forwarded) so a probe costs nothing upstream and stays instant.
      if (url === '/__cache_proxy_health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, upstream: upstreamHost, stats,
          cachePolicy: {
            policyVersion: CACHE_POLICY_VERSION,
            enabled: process.env.PAPERCUSP_CACHE_POLICY !== '0',
            toolsBreakpoint: process.env.PAPERCUSP_CACHE_TOOLS_BREAKPOINT === '1',
            splitBoundary: process.env.PAPERCUSP_CACHE_SPLIT_BOUNDARY !== '0',
            deferLargeTools: deferLargeToolsEnabled(),
          },
        }));
        return;
      }

      stats.requests++;
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        if (!res.headersSent) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'cache-proxy: request body read failed' } }));
        }
        return;
      }

      if (process.env.PAPERCUSP_CACHE_POLICY !== '0' && body.length && isCacheableAnthropicPath(url)) {
        try {
          const out = rewriteAnthropicCacheBody(body, {
            // OPT-IN (measured no-op 2026-07-19; caused EI-16980) — see cache-policy.ts header.
            injectToolsBreakpoint: process.env.PAPERCUSP_CACHE_TOOLS_BREAKPOINT === '1',
            // P-004 stable/volatile split — measured +66k shared tokens per subsequent cohort
            // session. ON by default; kill with PAPERCUSP_CACHE_SPLIT_BOUNDARY=0.
            splitBoundary: process.env.PAPERCUSP_CACHE_SPLIT_BOUNDARY !== '0',
            // P-002 (agent-launch-context-cost-2026-09-18): defer oversized tool schemas and
            // inject the BM25 search tool. ON BY DEFAULT since 2026-09-18 (D-016) — the P-003
            // both-arms live A/B it was waiting on RAN, and D-002 records control 169,167 vs
            // 115,273 at the measured 1200 B threshold (−31.9%). ⚠ That 115,273 is ONE A/B ARM,
            // not the fleet: the plan's headline <120,000 target was NOT met (D-009/D-013 record
            // the live median well above it), so do not read this number as the target reached.
            // The rewrite itself is directly evidenced by a per-request proxy log line. Kill with
            // PAPERCUSP_GATEWAY_DEFER_LARGE_TOOLS=0. See the gateway.ts header for the scoped
            // claim (functional reachability via `tools:invoke`, NOT native schema
            // materialization) and the three mutation-proven EI-16980 rails.
            // P-009(d): BOTH reads delegate to cache-policy's single read site, shared with the
            // gateway.ts forward point. These are separate processes reading the same env var,
            // so an inline re-implementation here could silently split the fleet into fixed and
            // unfixed halves — the guard test pins that this file contains no inline read.
            deferLargeTools: deferLargeToolsEnabled(),
            deferMinToolBytes: deferMinToolBytesFromEnv(),
          });
          if (out.stats) {
            if (out.body !== body) stats.rewritten++;
            stats.ttlUpgraded += out.stats.ttlUpgraded;
            if (out.stats.toolsBreakpointInjected) stats.toolsBreakpointInjected++;
            if (out.stats.toolsBreakpointSkippedNoBudget) stats.toolsBreakpointSkippedNoBudget++;
            if (out.stats.toolsBreakpointSkippedAllDeferred) stats.toolsBreakpointSkippedAllDeferred++;
            if (out.stats.boundarySplit) stats.boundarySplit++;
            // P-002 OBSERVABILITY. Without this line there is NO way to tell, from outside the
            // process, whether the deferral pass fired: the client transcript records what the
            // CLIENT sent, and this rewrite happens after that — so a flag-on arm and a flag-off
            // arm produce byte-identical transcripts. The 2026-09-18 A/B measured a 5,659-token
            // delta with no way to attribute it until this existed. One line per rewriting
            // request, only when it actually deferred something.
            if (out.stats.toolDeferral && out.stats.toolDeferral.toolsDeferred > 0) {
              const d = out.stats.toolDeferral;
              log(
                `deferred ${d.toolsDeferred} tool(s), ${d.toolsDeferredBytes} B` +
                  `${d.searchToolInjected ? ' + injected tool_search_tool_bm25' : ''}` +
                  `${d.skippedCacheControl ? ` (skipped ${d.skippedCacheControl} carrying cache_control)` : ''}` +
                  `${d.heldBackToKeepNonDeferred ? ' (held one back to keep a non-deferred tool)' : ''}`,
              );
            }
          }
          body = out.body;
        } catch (e) {
          // A rewrite must never cost a request — forward the original bytes.
          log(`rewrite skipped (${(e as Error).message})`);
        }
      }

      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (STRIP_REQUEST.has(k.toLowerCase())) continue;
        headers[k] = v;
      }
      headers['host'] = upstreamHost;
      headers['content-length'] = String(body.length);

      const ureq = transport.request(
        { host: upstreamHost, port: upstreamPort, method: req.method, path: url, headers, servername: opts.upstreamInsecure ? undefined : upstreamHost },
        (ures) => {
          const out: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(ures.headers)) {
            if (v === undefined) continue;
            if (STRIP_RESPONSE.has(k.toLowerCase())) continue;
            out[k] = v;
          }
          res.writeHead(ures.statusCode ?? 502, out);
          ures.pipe(res); // stream straight through — SSE stays chunk-for-chunk
        },
      );
      ureq.on('error', (e) => {
        stats.upstreamErrors++;
        log(`upstream error: ${e.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `cache-proxy: upstream unreachable (${e.message})` } }));
        } else {
          try { res.destroy(); } catch { /* already torn down */ }
        }
      });
      // A client disconnect must tear down the upstream request too, or a long stream leaks.
      res.on('close', () => {
        if (!res.writableEnded) {
          try { ureq.destroy(); } catch { /* already settled */ }
        }
      });
      ureq.end(body);
    })();
  });
  // Inference requests legitimately run for many minutes — never clip them at the socket.
  server.timeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  return Object.assign(server, { stats });
}

export function startCacheProxy(opts: CacheProxyOptions): http.Server {
  const log = opts.log ?? ((s: string) => console.log(`[cache-proxy] ${s}`));
  const server = createCacheProxy(opts);
  server.listen(opts.listenPort, opts.listenHost ?? '127.0.0.1', () => {
    log(`listening on http://${opts.listenHost ?? '127.0.0.1'}:${opts.listenPort} → https://${opts.upstreamHost ?? 'api.anthropic.com'} (credentials passed through verbatim)`);
  });
  return server;
}
