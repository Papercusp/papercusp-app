/**
 * Build the per-account egress undici dispatcher (per-account IP routing — D-003 / B-GW-3).
 *
 * Single source of truth for "given an AccountEgress, what undici Dispatcher routes this account's
 * upstream through its OWN IP". Two consumers:
 *   - the inference gateway's `dispatcherFor` (the live egress chokepoint), and
 *   - `accounts:test-egress` / the egress-probe (the clean-IP gate) — so the gate verifies the EXACT
 *     dispatcher the gateway would use, never a divergent copy.
 *
 * `proxyUrl` supports two forward-proxy schemes: `http(s)://` (undici's `ProxyAgent`, HTTP-CONNECT)
 * and `socks5://`/`socks://` (undici's `Socks5ProxyAgent`, native SOCKS5 — WI-284; undici marks it
 * experimental as of the pinned version, but it is a real, HTTPS-aware `Dispatcher`). A URL in NEITHER
 * scheme (e.g. `ftp://`) CONSTRUCTS-without-error-but-fails-at-request-time for the old ProxyAgent path
 * — rather than risk that class of silent per-request 502 for a genuinely unrecognized scheme, it is
 * IGNORED (falls through to a bound source IP if set, else the default shared egress) and surfaced via
 * `ignoredProxyUrl` so the caller can warn.
 *
 * NOTE (convergence): the gateway's `dispatcherFor` still inlines this logic + a per-account cache;
 * it should adopt this helper so the two never drift (coordinated with the B-HOT-2 dispatcher-close
 * work). Until then, keep the two IN LOCKSTEP by hand — this module is the canonical version.
 */
import { egressEntries, type AccountEgress, type ClaudeAccount } from '../deployment/account-pool';

type UndiciDispatcher = import('undici').Dispatcher;
type UndiciModule = typeof import('undici');

export interface EgressDispatcherResult {
  /** The dispatcher to attach to fetch's `dispatcher` option; undefined ⇒ default shared egress. */
  dispatcher?: UndiciDispatcher;
  /** The http(s) proxy URL actually honored (undefined when none / a different scheme was used/ignored). */
  httpProxy?: string;
  /** The socks5/socks proxy URL actually honored (undefined when none / a different scheme was used/ignored). */
  socks5Proxy?: string;
  /** The bound source IP actually used (undefined when a proxy was used / none). */
  localAddress?: string;
  /** A proxyUrl in a scheme we do NOT route through (neither http(s) nor socks5) — caller should warn. */
  ignoredProxyUrl?: string;
}

let cachedUndici: UndiciModule | undefined;

/** True iff `proxyUrl` is an http(s) forward proxy undici's ProxyAgent can route through. */
export function egressIsHttpProxy(proxyUrl: string | undefined): boolean {
  return !!proxyUrl && /^https?:\/\//i.test(proxyUrl);
}

/** True iff `proxyUrl` is a socks5/socks forward proxy undici's Socks5ProxyAgent can route through
 *  (WI-284). Accepts both `socks5://` and the bare `socks://` alias Socks5ProxyAgent itself accepts. */
export function egressIsSocks5Proxy(proxyUrl: string | undefined): boolean {
  return !!proxyUrl && /^socks5?:\/\//i.test(proxyUrl);
}

/** True iff `proxyUrl` is in a scheme this module actually routes through (http(s) or socks5/socks). */
export function egressIsSupportedProxy(proxyUrl: string | undefined): boolean {
  return egressIsHttpProxy(proxyUrl) || egressIsSocks5Proxy(proxyUrl);
}

/**
 * The egress an ACCOUNT actually routes through: the FIRST `egressPool` entry (the gateway's rotation
 * head), falling back to the singular legacy `egress`. An empty `{}` pool entry means the box-default IP.
 *
 * Canonical because selecting the egress is the step BEFORE `buildEgressDispatcher`, and a consumer that
 * reads `account.egress` directly silently skips the whole pool: for a pool-configured account it sees
 * `undefined`, reports "no egress", and probes the box-default IP — an answer that looks like a measured
 * verdict but never touched the configured proxy (EI-18664933641195210).
 */
export function resolveAccountEgress(account: ClaudeAccount): AccountEgress | undefined {
  // Delegates to the canonical pool resolver rather than re-deriving it — a second copy of this rule is
  // exactly the divergence that caused the bug above.
  return egressEntries(account)[0];
}

/** A stable per-account dispatcher cache key (matches the gateway's `accountId|proxyUrl|localAddress`).
 *  A proxyUrl in an unsupported scheme collapses to empty — it never partitions the cache (it is never
 *  honored, so two accounts differing only in an ignored scheme share the same "default egress" entry). */
export function egressCacheKey(accountId: string, egress: AccountEgress | undefined): string {
  const proxy = egressIsSupportedProxy(egress?.proxyUrl) ? egress!.proxyUrl : '';
  return `${accountId}|${proxy ?? ''}|${egress?.localAddress ?? ''}`;
}

/**
 * Build (without caching — callers cache) the undici dispatcher for an egress config. Returns
 * `{ dispatcher: undefined }` when the egress is absent or only an unsupported-scheme proxy was given
 * (→ default shared egress, with `ignoredProxyUrl` set). `importUndici` is injectable for tests.
 */
export async function buildEgressDispatcher(
  egress: AccountEgress | undefined,
  deps: { importUndici?: () => Promise<UndiciModule> } = {},
): Promise<EgressDispatcherResult> {
  if (!egress || (!egress.proxyUrl && !egress.localAddress)) return {};
  const httpProxy = egressIsHttpProxy(egress.proxyUrl) ? egress.proxyUrl : undefined;
  const socks5Proxy = !httpProxy && egressIsSocks5Proxy(egress.proxyUrl) ? egress.proxyUrl : undefined;
  const ignoredProxyUrl = egress.proxyUrl && !httpProxy && !socks5Proxy ? egress.proxyUrl : undefined;
  if (!httpProxy && !socks5Proxy && !egress.localAddress) return { ignoredProxyUrl };
  const mod = deps.importUndici ? await deps.importUndici() : (cachedUndici ??= await import('undici'));
  const dispatcher: UndiciDispatcher = httpProxy
    ? new mod.ProxyAgent(httpProxy)
    : socks5Proxy
      ? new mod.Socks5ProxyAgent(socks5Proxy)
      : new mod.Agent({ connect: { localAddress: egress.localAddress } });
  return {
    dispatcher,
    httpProxy,
    socks5Proxy,
    localAddress: httpProxy || socks5Proxy ? undefined : egress.localAddress,
    ignoredProxyUrl,
  };
}
