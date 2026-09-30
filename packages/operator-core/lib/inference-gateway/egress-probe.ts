/**
 * Egress probe — the clean-IP gate behind `accounts:test-egress` (B-EGRESS / per-account IP routing).
 *
 * For one account it builds the SAME per-account dispatcher the gateway uses (egress-dispatcher.ts),
 * fetches an IP-echo endpoint THROUGH it to learn the real exit IP, looks up that IP's reputation
 * (flagged as proxy/hosting/datacenter? + ASN), and — the gate — compares against the OTHER accounts'
 * exit IPs so you never pin an IP that shares an ASN/subnet with another account (which defeats the
 * whole per-account point) or that looks like a flagged datacenter/proxy to a consumer-Max org.
 *
 * Read-only. All network deps are injectable so it is unit-testable with NO live network. This is
 * also the post-apply VERIFY primitive `accounts:set-egress` reuses (D-005) — proving a freshly-pinned
 * egress actually routes through the new IP.
 */
import type { AccountEgress, ClaudeAccount } from '../deployment/account-pool';
import { buildEgressDispatcher, resolveAccountEgress } from './egress-dispatcher';

type UndiciModule = typeof import('undici');

export interface IpReputation {
  /** The IP is a known anonymizing proxy/VPN. */
  proxy: boolean;
  /** The IP belongs to a hosting/datacenter network (not residential/ISP). */
  hosting: boolean;
  /** flagged = proxy || hosting — a datacenter/proxy IP looks non-residential to a consumer-Max org,
   *  which is WORSE than the shared default IP. The clean-IP gate's red signal. */
  flagged: boolean;
  /** Autonomous System number, e.g. "AS15169". */
  asn?: string;
  asname?: string;
  org?: string;
  isp?: string;
  /** Which reputation source answered (e.g. "ip-api.com"). */
  source: string;
}

export interface EgressProbe {
  accountId: string;
  egress?: AccountEgress;
  /** false ⇒ this account has no egress, so the DEFAULT shared egress was probed. */
  hasEgress: boolean;
  /** The IP an IP-echo saw — the real exit IP for this account's egress. null on failure. */
  exitIp: string | null;
  reputation: IpReputation | null;
  asn: string | null;
  /** A non-http(s) proxyUrl (e.g. socks://) that was IGNORED → the default egress was probed instead. */
  ignoredProxyUrl?: string;
  error?: string;
}

export interface EgressCollision {
  accountId: string;
  exitIp: string | null;
  asn: string | null;
  /** Why it collides: same ASN, or same /24 subnet. */
  reason: 'asn' | 'subnet';
}

export interface TestEgressResult extends EgressProbe {
  /** True when this account's exit IP is on a DIFFERENT ASN and /24 from every other account's egress
   *  (the per-account-distinctness half of the clean-IP gate). When `compareOthers` is false this is
   *  reported as true with `comparedOthers:false` (not actually checked). */
  distinctFromOthers: boolean;
  /** Whether the other accounts were probed for the distinctness check. */
  comparedOthers: boolean;
  /** The accounts that collide (same ASN or same /24) — empty when distinct. */
  collisions: EgressCollision[];
  /** Overall verdict: a clean IP to pin = has an exit IP, NOT flagged, and distinct from the others. */
  clean: boolean;
}

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  importUndici?: () => Promise<UndiciModule>;
  /** IP-echo endpoint returning the caller's source IP. Default https://api.ipify.org?format=json. */
  echoUrl?: string;
  /** Reputation lookup for an exit IP. Default: ip-api.com (free, no key). Injectable for tests / a
   *  keyed provider (e.g. ipqualityscore) later. */
  reputationLookup?: (ip: string, fetchImpl: typeof fetch) => Promise<IpReputation | null>;
  /** Per-network-call timeout (ms). Default 10000. */
  timeoutMs?: number;
}

const DEFAULT_ECHO_URL = 'https://api.ipify.org?format=json';
const DEFAULT_TIMEOUT_MS = 10_000;

/** First three octets of an IPv4 — the /24 block. null for non-IPv4 / missing. */
export function subnet24(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p)) ? `${parts[0]}.${parts[1]}.${parts[2]}` : null;
}

/** ip-api.com free tier (HTTP, no key): proxy/hosting flags + ASN. The data is about a PUBLIC IP, so
 *  no secret crosses the wire; swap in a keyed HTTPS provider via ProbeDeps.reputationLookup. */
async function defaultReputationLookup(ip: string, fetchImpl: typeof fetch): Promise<IpReputation | null> {
  try {
    const res = await fetchImpl(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,proxy,hosting,as,asname,org,isp,query`,
    );
    const j = (await res.json()) as Record<string, unknown>;
    if (!j || j.status !== 'success') return null;
    const proxy = !!j.proxy;
    const hosting = !!j.hosting;
    const asRaw = typeof j.as === 'string' ? j.as : undefined;
    const asn = asRaw ? (asRaw.match(/^AS\d+/i)?.[0] ?? asRaw) : undefined;
    return {
      proxy,
      hosting,
      flagged: proxy || hosting,
      asn,
      asname: typeof j.asname === 'string' ? j.asname : undefined,
      org: typeof j.org === 'string' ? j.org : undefined,
      isp: typeof j.isp === 'string' ? j.isp : undefined,
      source: 'ip-api.com',
    };
  } catch {
    return null;
  }
}

/** Fetch the exit IP an echo endpoint sees through this egress's dispatcher (or default egress).
 *  Exported so the EgressProvider health-probe (`egress-providers/health-probe.ts`, B-PROV) reuses the
 *  SAME exit-IP mechanics instead of a divergent copy — one implementation of "what IP does this
 *  binding actually egress from" for both the account-level gate and the provider-level probe. */
export async function fetchExitIp(
  egress: AccountEgress | undefined,
  deps: ProbeDeps,
): Promise<{ exitIp: string | null; ignoredProxyUrl?: string; error?: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const echoUrl = deps.echoUrl ?? DEFAULT_ECHO_URL;
  let dispatcher: { close?: () => Promise<void> } | undefined;
  try {
    const built = await buildEgressDispatcher(egress, { importUndici: deps.importUndici });
    dispatcher = built.dispatcher as { close?: () => Promise<void> } | undefined;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const init: RequestInit & { dispatcher?: unknown } = { signal: ac.signal };
      if (built.dispatcher) init.dispatcher = built.dispatcher;
      const res = await fetchImpl(echoUrl, init as RequestInit);
      const ct = res.headers.get('content-type') ?? '';
      let ip: string | null = null;
      if (ct.includes('json')) {
        const body = (await res.json().catch(() => null)) as { ip?: string; query?: string } | null;
        ip = body?.ip ?? body?.query ?? null;
      } else {
        ip = (await res.text().catch(() => '')).trim() || null;
      }
      return { exitIp: ip, ignoredProxyUrl: built.ignoredProxyUrl };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { exitIp: null, error: (e as Error).message };
  } finally {
    // Close the throwaway dispatcher so we don't leak sockets (per-probe, not cached).
    void dispatcher?.close?.();
  }
}

/** Probe ONE account's egress: exit IP + reputation + ASN. Read-only, no live-gateway change. */
export async function probeEgress(account: ClaudeAccount, deps: ProbeDeps = {}): Promise<EgressProbe> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Resolve through the SAME selector the gateway routes on — `account.egress` alone skips `egressPool`
  // entirely, which reports a pool-configured account as having no egress and then probes the box-default
  // IP instead of its configured proxy (EI-18664933641195210).
  const egress = resolveAccountEgress(account);
  const hasEgress = !!(egress && (egress.proxyUrl || egress.localAddress));
  const { exitIp, ignoredProxyUrl, error } = await fetchExitIp(egress, deps);
  let reputation: IpReputation | null = null;
  if (exitIp) {
    const lookup = deps.reputationLookup ?? defaultReputationLookup;
    reputation = await lookup(exitIp, fetchImpl).catch(() => null);
  }
  return {
    accountId: account.id,
    egress,
    hasEgress,
    exitIp,
    reputation,
    asn: reputation?.asn ?? null,
    ignoredProxyUrl,
    error,
  };
}

/**
 * The `accounts:test-egress` orchestration: probe the target account, and (unless `compareOthers` is
 * false) probe the other accounts to compute distinct-ASN/subnet. Returns null for an unknown id.
 */
export async function testEgressForAccount(
  accounts: ClaudeAccount[],
  id: string,
  deps: ProbeDeps & { compareOthers?: boolean } = {},
): Promise<TestEgressResult | null> {
  const target = accounts.find((a) => a.id === id);
  if (!target) return null;
  const targetProbe = await probeEgress(target, deps);
  const compareOthers = deps.compareOthers ?? true;

  let collisions: EgressCollision[] = [];
  if (compareOthers) {
    const others = accounts.filter((a) => a.id !== id);
    const otherProbes = await Promise.all(
      others.map((a) => probeEgress(a, deps).catch(() => null)),
    );
    const tAsn = targetProbe.asn;
    const tSub = subnet24(targetProbe.exitIp);
    for (const o of otherProbes) {
      if (!o || !o.exitIp) continue;
      if (tAsn && o.asn && o.asn === tAsn) {
        collisions.push({ accountId: o.accountId, exitIp: o.exitIp, asn: o.asn, reason: 'asn' });
      } else if (tSub && subnet24(o.exitIp) === tSub) {
        collisions.push({ accountId: o.accountId, exitIp: o.exitIp, asn: o.asn, reason: 'subnet' });
      }
    }
  }

  const distinctFromOthers = collisions.length === 0;
  const clean = !!targetProbe.exitIp && targetProbe.reputation?.flagged !== true && distinctFromOthers;
  return { ...targetProbe, distinctFromOthers, comparedOthers: compareOthers, collisions, clean };
}
