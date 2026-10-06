/**
 * Host-mediated fetch for integration providers (generalized-integrations
 * D-006 / P-001).
 *
 * Providers never receive tokens. They call `host.fetch({ source, request })`;
 * the host resolves the source's provider, refuses any URL outside the
 * provider's declared egress hosts, injects the access token for exactly that
 * source's account, and returns the response. The same function backs
 * in-process `js` providers and (via the daemon bridge) sandboxed daemon
 * providers.
 */
import {
  providerEgressAllows,
  type HostFetch,
  type HostFetchRequest,
  type HostFetchResponse,
} from '@papercusp/plugin-sdk';
import type { ProviderRegistry } from './provider-registry';
import { serviceCredentialForHost, serviceCredentialResolver } from './service-credentials';

export type HostFetchErrorCode =
  | 'unknown-source'
  | 'source-provider-mismatch'
  | 'egress-denied'
  | 'insecure-url'
  | 'caller-authorization-header'
  | 'token-unavailable'
  | 'service-credential-unavailable';

export class HostFetchError extends Error {
  constructor(
    readonly code: HostFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostFetchError';
  }
}

export interface HostFetchSource {
  sourceId: string;
  providerId: string;
}

export interface HostFetchDeps {
  registry: ProviderRegistry;
  /** Resolves a source id to its owning provider; null when unknown. */
  resolveSource(sourceId: string): Promise<HostFetchSource | null>;
  /** Returns a fresh access token for exactly this source's account; null when the source needs none. */
  accessToken(source: HostFetchSource): Promise<string | null>;
  /**
   * Mints the host-held service credential registered under `ref` (D-018.1).
   * Defaults to the service-credentials registry.
   */
  serviceAccessToken?(ref: string): Promise<string>;
  fetchImpl?: typeof fetch;
}

async function defaultServiceAccessToken(ref: string): Promise<string> {
  const resolver = serviceCredentialResolver(ref);
  if (!resolver) throw new Error(`service credential "${ref}" is not registered`);
  return resolver.accessToken();
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization']);

/**
 * Build a host fetch bound to ONE provider. A provider can only fetch for
 * sources it owns, so a hostile provider cannot borrow another provider's
 * account by naming a foreign source id.
 */
export function createHostFetch(providerId: string, deps: HostFetchDeps): HostFetch {
  const doFetch = deps.fetchImpl ?? fetch;
  return async ({ source, request }: { source: string; request: HostFetchRequest }): Promise<HostFetchResponse> => {
    const resolved = await deps.resolveSource(source);
    if (!resolved) throw new HostFetchError('unknown-source', `host.fetch: unknown source "${source}"`);
    if (resolved.providerId !== providerId) {
      throw new HostFetchError(
        'source-provider-mismatch',
        `host.fetch: source "${source}" belongs to provider "${resolved.providerId}", not "${providerId}"`,
      );
    }
    const registered = deps.registry.get(providerId);
    if (!registered) throw new HostFetchError('unknown-source', `host.fetch: provider "${providerId}" is not registered`);

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new HostFetchError('egress-denied', `host.fetch: invalid URL "${request.url}"`);
    }
    if (url.protocol !== 'https:') {
      throw new HostFetchError('insecure-url', `host.fetch: only https URLs are allowed (got ${url.protocol})`);
    }
    if (url.username || url.password) {
      throw new HostFetchError('egress-denied', 'host.fetch: URLs with embedded credentials are refused');
    }
    if (!providerEgressAllows(registered.descriptor.egressHosts, url.hostname)) {
      throw new HostFetchError(
        'egress-denied',
        `host.fetch: ${url.hostname} is not in provider "${providerId}" egressHosts`,
      );
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      const lower = name.toLowerCase();
      if (lower === 'authorization') {
        throw new HostFetchError(
          'caller-authorization-header',
          'host.fetch: providers may not set Authorization; the host injects the source credential',
        );
      }
      if (!HOP_BY_HOP.has(lower)) headers.set(name, value);
    }
    // A host declared under serviceCredentials gets the host-held service
    // identity, never the source's user token (D-018.1).
    const service = serviceCredentialForHost(registered.descriptor.serviceCredentials, url.hostname);
    if (service) {
      let serviceToken: string;
      try {
        serviceToken = await (deps.serviceAccessToken ?? defaultServiceAccessToken)(service.ref);
      } catch (error) {
        throw new HostFetchError(
          'service-credential-unavailable',
          `host.fetch: service credential "${service.ref}" is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      headers.set('authorization', `Bearer ${serviceToken}`);
    } else {
      const token = await deps.accessToken(resolved);
      if (registered.descriptor.oauth && !token) {
        throw new HostFetchError('token-unavailable', `host.fetch: no access token for source "${source}"`);
      }
      if (token) headers.set('authorization', `Bearer ${token}`);
    }

    const body =
      request.body === undefined
        ? undefined
        : request.bodyEncoding === 'base64'
          ? Buffer.from(request.body, 'base64')
          : request.body;
    const response = await doFetch(url, {
      method: request.method ?? 'GET',
      headers,
      body,
      redirect: 'manual',
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() !== 'set-cookie') responseHeaders[name] = value;
    });
    const contentType = response.headers.get('content-type') ?? '';
    const textual = /^(text\/|application\/(json|xml|[a-z.+-]*\+json|[a-z.+-]*\+xml|x-www-form-urlencoded))/i.test(contentType) || contentType === '';
    const buffer = Buffer.from(await response.arrayBuffer());
    return textual
      ? { status: response.status, headers: responseHeaders, body: buffer.toString('utf8'), bodyEncoding: 'utf8' }
      : { status: response.status, headers: responseHeaders, body: buffer.toString('base64'), bodyEncoding: 'base64' };
  };
}
