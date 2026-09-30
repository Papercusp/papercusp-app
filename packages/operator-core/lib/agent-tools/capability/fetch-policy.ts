/** Host-side outbound request policy for capability:fetch. */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, buildConnector, type Dispatcher } from 'undici';

import type { OperationBoundaryProfile } from './boundary-profile';

export const DEFAULT_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CONFINED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'forwarded',
  'host',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);

export type CapabilityFetchPolicyCode =
  | 'forbidden_scheme'
  | 'embedded_url_credentials'
  | 'forbidden_request_header'
  | 'confined_method_forbidden'
  | 'confined_credentials_forbidden'
  | 'confined_private_address'
  | 'dns_resolution_failed'
  | 'dns_resolution_empty'
  | 'redirect_location_missing'
  | 'redirect_limit_exceeded'
  | 'redirect_downgrade_forbidden';

export class CapabilityFetchPolicyError extends Error {
  constructor(
    readonly code: CapabilityFetchPolicyCode,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityFetchPolicyError';
  }
}

export interface ResolvedFetchAddress {
  address: string;
  family: 4 | 6;
}

type FetchInit = RequestInit & { dispatcher?: Dispatcher };
type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

export interface PinnedFetchDispatcher {
  dispatcher: Dispatcher;
  close: () => Promise<void>;
}

export interface CapabilityFetchPolicyDeps {
  lookup: (hostname: string) => Promise<ResolvedFetchAddress[]>;
  fetch: FetchLike;
  createPinnedDispatcher: (address: ResolvedFetchAddress) => PinnedFetchDispatcher;
}

const defaultLookup: CapabilityFetchPolicyDeps['lookup'] = async (hostname) => {
  const literal = stripIpv6Brackets(hostname);
  const literalFamily = isIP(stripZone(literal));
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: stripZone(literal), family: literalFamily }];
  }
  try {
    const answers = await dnsLookup(hostname, { all: true, verbatim: true });
    return answers
      .filter((answer): answer is { address: string; family: 4 | 6 } => answer.family === 4 || answer.family === 6)
      .map((answer) => ({ address: answer.address, family: answer.family }));
  } catch (error) {
    throw new CapabilityFetchPolicyError(
      'dns_resolution_failed',
      `DNS resolution failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

function defaultPinnedDispatcher(address: ResolvedFetchAddress): PinnedFetchDispatcher {
  // Pin this connection to the address we validated. TLS still receives the URL
  // hostname as servername, so certificate verification is not weakened.
  const pinnedLookup = ((
    _hostname: string,
    options: { all?: boolean },
    callback: (error: NodeJS.ErrnoException | null, address: string | ResolvedFetchAddress[], family?: number) => void,
  ) => {
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  }) as unknown as LookupFunction;
  const dispatcher = new Agent({ connect: buildConnector({ lookup: pinnedLookup }) });
  return {
    dispatcher,
    close: async () => { await dispatcher.close(); },
  };
}

const DEFAULT_DEPS: CapabilityFetchPolicyDeps = {
  lookup: defaultLookup,
  // Read the global at CALL time. Tests and host adapters deliberately replace
  // globalThis.fetch; capturing it at module import would bypass that supported
  // seam. Node's implementation is Undici and accepts the dispatcher extension.
  fetch: (url, init) => globalThis.fetch(url, init as RequestInit),
  createPinnedDispatcher: defaultPinnedDispatcher,
};

export interface PolicyFetchInput {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  profile: OperationBoundaryProfile;
  maxRedirects?: number;
}

export interface PolicyFetchResult {
  response: Response;
  finalUrl: string;
  finalMethod: string;
  redirectCount: number;
  resolvedAddress: ResolvedFetchAddress;
  release: () => Promise<void>;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function stripZone(address: string): string {
  const i = address.indexOf('%');
  return i === -1 ? address : address.slice(0, i);
}

function parseIpv4(address: string): number[] | null {
  const pieces = address.split('.');
  if (pieces.length !== 4) return null;
  const out = pieces.map((piece) => Number(piece));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? out : null;
}

function ipv6Bytes(input: string): number[] | null {
  let address = stripZone(input).toLowerCase();
  const dotted = address.lastIndexOf(':');
  if (address.includes('.') && dotted !== -1) {
    const ipv4 = parseIpv4(address.slice(dotted + 1));
    if (!ipv4) return null;
    address = `${address.slice(0, dotted)}:${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }
  if ((address.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = address.split('::');
  const left = leftRaw ? leftRaw.split(':').filter(Boolean) : [];
  const right = rightRaw !== undefined && rightRaw ? rightRaw.split(':').filter(Boolean) : [];
  const hasCompression = address.includes('::');
  const missing = 8 - left.length - right.length;
  if ((!hasCompression && missing !== 0) || (hasCompression && missing < 1)) return null;
  const words = [...left, ...Array(hasCompression ? missing : 0).fill('0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  const bytes: number[] = [];
  for (const word of words) {
    const n = Number.parseInt(word, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function ipv4IsNonPublic(address: string): boolean {
  const b = parseIpv4(address);
  if (!b) return true;
  const [a, c, d] = b;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && c! >= 64 && c! <= 127) ||
    (a === 169 && c === 254) ||
    (a === 172 && c! >= 16 && c! <= 31) ||
    (a === 192 && c === 0 && d === 0) ||
    (a === 192 && c === 0 && d === 2) ||
    (a === 192 && c === 168) ||
    (a === 198 && (c === 18 || c === 19)) ||
    (a === 198 && c === 51 && d === 100) ||
    (a === 203 && c === 0 && d === 113) ||
    a! >= 224
  );
}

/** True for loopback/private/link-local/metadata/multicast/reserved addresses. */
export function isNonPublicFetchAddress(addressInput: string): boolean {
  const address = stripZone(stripIpv6Brackets(addressInput));
  const family = isIP(address);
  if (family === 4) return ipv4IsNonPublic(address);
  if (family !== 6) return true;
  const b = ipv6Bytes(address);
  if (!b) return true;

  const allZero = b.every((n) => n === 0);
  const loopback = b.slice(0, 15).every((n) => n === 0) && b[15] === 1;
  if (allZero || loopback) return true;

  // IPv4-mapped IPv6 — classify the embedded address with the IPv4 rules.
  if (b.slice(0, 10).every((n) => n === 0) && b[10] === 0xff && b[11] === 0xff) {
    return ipv4IsNonPublic(b.slice(12).join('.'));
  }

  return (
    (b[0]! & 0xfe) === 0xfc || // fc00::/7 unique-local
    (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) || // fe80::/10 link-local
    b[0] === 0xff || // multicast
    (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) // documentation
  );
}

function parseAndValidateUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CapabilityFetchPolicyError(
      'forbidden_scheme',
      `capability:fetch allows only http(s), not ${url.protocol}`,
    );
  }
  if (url.username || url.password) {
    throw new CapabilityFetchPolicyError(
      'embedded_url_credentials',
      'credentials embedded in a URL are refused; use an explicitly authorized header',
    );
  }
  return url;
}

function normalizeHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input ?? {})) {
    const name = rawName.trim().toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(name)) {
      throw new CapabilityFetchPolicyError(
        'forbidden_request_header',
        `request header ${rawName} is host/connection-controlled and cannot be overridden`,
      );
    }
    if (/\r|\n/.test(name) || /\r|\n/.test(value)) {
      throw new CapabilityFetchPolicyError(
        'forbidden_request_header',
        `request header ${rawName} contains a line break`,
      );
    }
    headers[name] = value;
  }
  return headers;
}

function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADERS.has(name) || /(?:^|[-_])(?:api[-_]?key|access[-_]?token|secret)$/.test(name);
}

function assertRequestAllowed(
  profile: OperationBoundaryProfile,
  method: string,
  headers: Record<string, string>,
): void {
  if (profile.kind !== 'confined') return;
  if (!CONFINED_METHODS.has(method)) {
    throw new CapabilityFetchPolicyError(
      'confined_method_forbidden',
      `confined capability:fetch permits GET, HEAD, and OPTIONS; ${method} requires trusted integration execution`,
    );
  }
  const credential = Object.keys(headers).find(isCredentialHeader);
  if (credential) {
    throw new CapabilityFetchPolicyError(
      'confined_credentials_forbidden',
      `confined capability:fetch cannot forward credential header ${credential}`,
    );
  }
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort: dispatcher close below still tears down the connection.
  }
}

function redirectedRequest(
  status: number,
  from: URL,
  to: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): { method: string; headers: Record<string, string>; body?: string } {
  if (from.protocol === 'https:' && to.protocol === 'http:') {
    throw new CapabilityFetchPolicyError(
      'redirect_downgrade_forbidden',
      `refusing HTTPS-to-HTTP redirect from ${from.origin} to ${to.origin}`,
    );
  }
  const nextHeaders = { ...headers };
  if (from.origin !== to.origin) {
    for (const name of Object.keys(nextHeaders)) {
      if (isCredentialHeader(name)) delete nextHeaders[name];
    }
  }
  if (status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')) {
    delete nextHeaders['content-type'];
    return { method: 'GET', headers: nextHeaders };
  }
  return { method, headers: nextHeaders, ...(body !== undefined ? { body } : {}) };
}

/**
 * Validate each hop, resolve every A/AAAA answer, and pin the connection to one
 * validated address. Redirects are manual so every new destination repeats the
 * full policy before a second network effect.
 */
export async function fetchWithCapabilityPolicy(
  input: PolicyFetchInput,
  deps: CapabilityFetchPolicyDeps = DEFAULT_DEPS,
): Promise<PolicyFetchResult> {
  let url = parseAndValidateUrl(input.url);
  let method = input.method.toUpperCase();
  let headers = normalizeHeaders(input.headers);
  let body = input.body;
  const maxRedirects = input.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  assertRequestAllowed(input.profile, method, headers);
  if ((method === 'GET' || method === 'HEAD') && body !== undefined) {
    throw new CapabilityFetchPolicyError(
      'confined_method_forbidden',
      `${method} requests cannot carry a body`,
    );
  }

  for (let redirectCount = 0; ; redirectCount += 1) {
    const addresses = await deps.lookup(stripIpv6Brackets(url.hostname));
    if (addresses.length === 0) {
      throw new CapabilityFetchPolicyError(
        'dns_resolution_empty',
        `DNS resolution returned no A/AAAA addresses for ${url.hostname}`,
      );
    }
    if (input.profile.kind === 'confined') {
      const denied = addresses.find((answer) => isNonPublicFetchAddress(answer.address));
      if (denied) {
        throw new CapabilityFetchPolicyError(
          'confined_private_address',
          `confined capability:fetch refuses ${url.hostname}: DNS resolved to non-public address ${denied.address}`,
        );
      }
    }

    const selected = addresses[0]!;
    const pinned = deps.createPinnedDispatcher(selected);
    let response: Response;
    try {
      response = await deps.fetch(url.toString(), {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        signal: input.signal,
        dispatcher: pinned.dispatcher,
      });
    } catch (error) {
      await pinned.close();
      throw error;
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return {
        response,
        finalUrl: url.toString(),
        finalMethod: method,
        redirectCount,
        resolvedAddress: selected,
        release: pinned.close,
      };
    }

    const location = response.headers.get('location');
    await cancelResponse(response);
    await pinned.close();
    if (!location) {
      throw new CapabilityFetchPolicyError(
        'redirect_location_missing',
        `HTTP ${response.status} from ${url.toString()} did not include Location`,
      );
    }
    if (redirectCount >= maxRedirects) {
      throw new CapabilityFetchPolicyError(
        'redirect_limit_exceeded',
        `capability:fetch exceeded its ${maxRedirects}-redirect limit`,
      );
    }

    const next = parseAndValidateUrl(new URL(location, url).toString());
    const redirected = redirectedRequest(response.status, url, next, method, headers, body);
    url = next;
    method = redirected.method;
    headers = redirected.headers;
    body = redirected.body;
    assertRequestAllowed(input.profile, method, headers);
  }
}
