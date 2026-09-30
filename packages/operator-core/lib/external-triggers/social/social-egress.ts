/**
 * Social adapter egress allowlist — P-024.
 *
 * WHAT THIS ENFORCES. Every social adapter in this directory takes its HTTP
 * client as an INJECTED dependency and never calls `fetch` itself. That is good
 * for testing and it has one consequence nobody had written down: there is no
 * single place where a social API host is chosen, so until now nothing could
 * have said which hosts an adapter is entitled to reach. This module is that
 * place. `SocialPlatformRow.egress` declares the budget; `assertSocialEgressAllowed`
 * is the seam a client implementation calls before it opens a connection.
 *
 * WHY A HOST BUDGET IS NOT PARANOIA HERE. Two of the four read transports take
 * their host from data we do not control:
 *
 *   - Mastodon advertises its own streaming endpoint at
 *     `configuration.urls.streaming`, and the registry row records — as a
 *     measured fact — that it MAY legitimately differ from the API host. An
 *     instance is therefore in a position to name any host on the internet as
 *     the place we should open an authenticated stream to.
 *   - Bluesky's XRPC is served by the account's PDS, which is likewise
 *     per-account rather than platform-wide.
 *
 * Both are legitimate designs. Both mean "the provider tells us where to
 * connect", and a token travels on that connection. Bounding the answer to the
 * connection's own host (and hosts beneath it) keeps the flexibility those
 * designs need while making the redirect-to-attacker case unrepresentable.
 *
 * FAIL CLOSED, ALWAYS. Every branch below denies. There is no "unknown host, but
 * it looks fine" path, no wildcard, no suffix match against a declared API host,
 * and an empty `apiHosts` under `hostPolicy: 'fixed'` denies everything rather
 * than allowing everything — which is precisely the state the three unverified
 * rows are in, and precisely the behaviour D-005 wants from an unverified row.
 */
import {
  getSocialPlatform,
  type SocialEgressSpec,
  type SocialPlatformRow,
} from './platform-registry';

/** Schemes an adapter may egress on. Plaintext is absent deliberately — see below. */
const ALLOWED_SCHEMES = new Set(['https:', 'wss:']);

/**
 * Why a URL was refused. Each value names a DIFFERENT defect, because "denied"
 * alone sends the reader to re-derive which of six things went wrong.
 */
export type SocialEgressDenialReason =
  /** No such platform in the registry. */
  | 'unknown-platform'
  /** The URL did not parse at all. */
  | 'unparseable-url'
  /** `http:`/`ws:`/`file:`/anything else. A downgrade is an attack, not a fallback. */
  | 'forbidden-scheme'
  /** `https://good.example@evil.example/` — legal URL, and never a legitimate API call. */
  | 'embedded-credentials'
  /** A literal IP or `localhost`. No declared host is one, and it is how a budget gets bypassed. */
  | 'ip-literal-host'
  /** A `per-connection` platform was checked without saying which connection. */
  | 'connection-host-required'
  /** The supplied connection host is not a bare hostname. */
  | 'connection-host-invalid'
  /** The host is well-formed and simply not in this platform's budget. */
  | 'host-not-declared';

export interface SocialEgressAllowed {
  allowed: true;
  /** The normalized hostname that was matched. */
  host: string;
  /** Which half of the budget admitted it. */
  via: 'declared-api-host' | 'connection-host';
}

export interface SocialEgressDenied {
  allowed: false;
  reason: SocialEgressDenialReason;
  /** Human-readable specifics: what was asked for, and what was allowed. */
  detail: string;
  /** The normalized hostname, when one could be derived. */
  host: string | null;
}

export type SocialEgressDecision = SocialEgressAllowed | SocialEgressDenied;

export interface SocialEgressOptions {
  /**
   * The host this connection is bound to — a Mastodon instance, a Bluesky PDS.
   * REQUIRED for a `per-connection` platform and IGNORED for a `fixed` one
   * (ignored rather than rejected because ignoring can only narrow the budget,
   * never widen it).
   */
  connectionHost?: string | null;
}

export class SocialEgressDeniedError extends Error {
  readonly platformId: string;
  readonly reason: SocialEgressDenialReason;
  readonly host: string | null;

  constructor(platformId: string, denial: SocialEgressDenied) {
    super(`social_egress_denied:${platformId}:${denial.reason}: ${denial.detail}`);
    this.name = 'SocialEgressDeniedError';
    this.platformId = platformId;
    this.reason = denial.reason;
    this.host = denial.host;
  }
}

/**
 * Lowercase a hostname and drop one trailing dot.
 *
 * `graph.facebook.com.` is the same host as `graph.facebook.com` in DNS but not
 * in string comparison, so without this the fully-qualified spelling would be
 * denied. Normalizing can only ever MERGE two spellings of one host; it never
 * admits a host that was not already declared.
 */
export function normalizeEgressHost(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/** True for a literal IPv4/IPv6 address or a loopback name. */
function isIpLiteralOrLoopback(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // `new URL` hands IPv6 back in brackets.
  if (host.startsWith('[') && host.endsWith(']')) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/** A bare hostname: labels and dots, nothing that could carry a port, path or userinfo. */
function isBareHostname(value: string): boolean {
  if (!value || value.length > 253) return false;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(value);
}

/**
 * True when `host` is the connection host itself or a host BENEATH it.
 *
 * The subdomain half is what makes the real Mastodon shape expressible:
 * `mastodon.social` advertising streaming at `streaming.mastodon.social` is the
 * documented case, and refusing it would make the guard unusable and therefore
 * removed. What it must not admit is `evil-mastodon.social`, which shares a
 * suffix but not a label boundary — hence the explicit dot.
 */
function isWithinConnectionHost(host: string, connectionHost: string): boolean {
  return host === connectionHost || host.endsWith(`.${connectionHost}`);
}

/**
 * The hosts one row declares, as sets.
 *
 * Exported because the static containment gate needs the same reading of the
 * row that the runtime guard uses. Two readings of one declaration is how a
 * guard ends up passing while the thing it guards is wrong.
 */
export function socialEgressHostBudget(spec: SocialEgressSpec): {
  apiHosts: Set<string>;
  permalinkHosts: Set<string>;
} {
  return {
    apiHosts: new Set(spec.apiHosts.map(normalizeEgressHost)),
    permalinkHosts: new Set((spec.permalinkHosts ?? []).map(normalizeEgressHost)),
  };
}

/**
 * Decide whether `url` is inside `platformId`'s declared egress budget.
 *
 * Returns a decision rather than throwing so a caller that is auditing (the
 * containment gate, an admin surface listing what a platform may reach) does not
 * have to use exceptions for control flow. `assertSocialEgressAllowed` is the
 * throwing wrapper for the call path.
 */
export function socialEgressDecision(
  platformId: string,
  url: string,
  opts: SocialEgressOptions = {},
): SocialEgressDecision {
  const row: SocialPlatformRow | undefined = getSocialPlatform(platformId);
  if (!row) {
    return {
      allowed: false,
      reason: 'unknown-platform',
      detail: `no registry row for '${platformId}'`,
      host: null,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      allowed: false,
      reason: 'unparseable-url',
      detail: `not a URL: ${JSON.stringify(url)}`,
      host: null,
    };
  }

  // Checked BEFORE the host is trusted for anything. `https://graph.facebook.com@evil.example/`
  // parses with hostname `evil.example`, so exact matching already refuses it —
  // but userinfo in an API URL is a smuggling attempt or a credential leak into
  // logs either way, and naming it is more useful than a generic host mismatch.
  if (parsed.username || parsed.password) {
    return {
      allowed: false,
      reason: 'embedded-credentials',
      detail: 'URL carries userinfo; no social API is called with credentials in the URL',
      host: normalizeEgressHost(parsed.hostname),
    };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return {
      allowed: false,
      reason: 'forbidden-scheme',
      detail: `scheme '${parsed.protocol}' is not one of ${[...ALLOWED_SCHEMES].join(', ')}`,
      host: normalizeEgressHost(parsed.hostname),
    };
  }

  const host = normalizeEgressHost(parsed.hostname);

  if (isIpLiteralOrLoopback(host)) {
    return {
      allowed: false,
      reason: 'ip-literal-host',
      detail: `'${host}' is a literal address; every declared social host is a name`,
      host,
    };
  }

  const budget = socialEgressHostBudget(row.egress);
  if (budget.apiHosts.has(host)) {
    return { allowed: true, host, via: 'declared-api-host' };
  }

  if (row.egress.hostPolicy === 'per-connection') {
    const raw = opts.connectionHost;
    if (raw === undefined || raw === null || raw.trim() === '') {
      return {
        allowed: false,
        reason: 'connection-host-required',
        detail: `'${platformId}' resolves its host per connection; pass connectionHost to say which`,
        host,
      };
    }
    const connectionHost = normalizeEgressHost(raw);
    if (!isBareHostname(connectionHost) || isIpLiteralOrLoopback(connectionHost)) {
      return {
        allowed: false,
        reason: 'connection-host-invalid',
        detail: `connectionHost ${JSON.stringify(raw)} is not a bare hostname`,
        host,
      };
    }
    if (isWithinConnectionHost(host, connectionHost)) {
      return { allowed: true, host, via: 'connection-host' };
    }
    return {
      allowed: false,
      reason: 'host-not-declared',
      detail: `'${host}' is neither '${connectionHost}' nor beneath it`,
      host,
    };
  }

  const declared = [...budget.apiHosts];
  return {
    allowed: false,
    reason: 'host-not-declared',
    detail:
      declared.length === 0
        ? `'${platformId}' declares no API hosts (unverified row): every host is denied`
        : `'${host}' is not one of ${declared.join(', ')}`,
    host,
  };
}

/**
 * Throwing form of `socialEgressDecision`, returning the parsed URL on success.
 *
 * Returning the parsed `URL` rather than the original string is deliberate: a
 * caller that re-parses the string afterwards could reach a different host than
 * the one that was authorized if the two parses ever disagree. Handing back the
 * exact object that was checked removes that gap.
 */
export function assertSocialEgressAllowed(
  platformId: string,
  url: string,
  opts: SocialEgressOptions = {},
): URL {
  const decision = socialEgressDecision(platformId, url, opts);
  if (!decision.allowed) throw new SocialEgressDeniedError(platformId, decision);
  return new URL(url);
}
