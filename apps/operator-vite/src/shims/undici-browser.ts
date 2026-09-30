/**
 * Browser shim for `undici` (server-only Node HTTP client).
 *
 * Server-only inference-gateway modules (`operator-core/lib/inference-gateway/{gateway,egress-dispatcher,egress-probe}.ts`,
 * `loopback-fetch.ts`, `operator-elevenlabs-ws-init.ts`) lazily `await import('undici')` to build
 * per-account egress dispatchers (`Agent`/`ProxyAgent`/`Socks5ProxyAgent`) for outbound LLM/API calls —
 * pure server-side proxy/egress plumbing the SPA never runs. Rolldown still has to resolve the dynamic
 * import target to emit a chunk even though no browser code path ever calls it, which drags `undici`'s
 * ~20 transitive `node:*` imports (node:assert/stream/util/events/net/crypto/buffer/zlib/http/...) into
 * the externalized-warnings count (WI-4518 erosion tracking). Calling anything on this shim in a real
 * browser throws, same contract as the postgres/dbos shims above.
 */

function serverOnly(): never {
  throw new Error('undici is server-only and cannot run in the operator-vite browser bundle');
}

const trap: ProxyHandler<object> = {
  get(_t, prop) {
    if (prop === Symbol.toPrimitive || prop === 'toString') return () => '[undici-browser-shim]';
    return serverOnly;
  },
  apply: serverOnly,
  construct: serverOnly,
};

export const Agent = new Proxy(function Agent() {
  serverOnly();
}, trap) as never;
export const ProxyAgent = new Proxy(function ProxyAgent() {
  serverOnly();
}, trap) as never;
export const Socks5ProxyAgent = new Proxy(function Socks5ProxyAgent() {
  serverOnly();
}, trap) as never;
/**
 * `buildConnector` is imported by `operator-core/lib/agent-tools/capability/fetch-policy.ts`
 * (server-side egress TLS/connect policy). Same server-only contract as the agents above:
 * resolvable so Rolldown can link the chunk, throws if a browser path ever calls it.
 */
export const buildConnector = new Proxy(function buildConnector() {
  serverOnly();
}, trap) as never;
export default new Proxy({}, trap) as never;
