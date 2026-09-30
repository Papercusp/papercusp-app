/**
 * The few Cloudflare API v4 calls the own-tunnel setup needs (external-app-access P-009, D-001).
 *
 * Everything runs in the USER's Cloudflare account with a token the user supplied — either the one
 * `cloudflared tunnel login` leaves in its cert.pem, or one they pasted. The tunnel is remotely
 * managed (`config_src: "cloudflare"`): its ingress lives in Cloudflare, and the connector on this
 * machine only needs the tunnel's run token.
 *
 * `fetch` and the base URL are injectable so tests drive a local fake of the API.
 */

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareApiError extends Error {
  readonly status: number;
  /** The first Cloudflare error code, when the envelope carried one. */
  readonly cfCode: number | null;
  constructor(status: number, message: string, cfCode: number | null) {
    super(message);
    this.name = 'CloudflareApiError';
    this.status = status;
    this.cfCode = cfCode;
  }
  /** The token was refused or lacks a permission the step needs. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface CloudflareZone {
  readonly id: string;
  readonly name: string;
  readonly account?: { readonly id: string };
}
export interface CloudflareTunnel {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly deleted_at?: string | null;
  readonly connections?: ReadonlyArray<unknown>;
}
export interface CloudflareDnsRecord {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly proxied?: boolean;
}

export interface CloudflareApiOptions {
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

interface Envelope<T> {
  readonly success?: boolean;
  readonly errors?: ReadonlyArray<{ code?: number; message?: string }>;
  readonly result?: T;
}

export function cloudflareApi(opts: CloudflareApiOptions) {
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/+$/, '');
  if (!opts.apiToken || typeof opts.apiToken !== 'string') throw new Error('cloudflareApi: apiToken is required');

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.apiToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new CloudflareApiError(0, `Cloudflare API unreachable: ${(err as Error)?.message ?? String(err)}`, null);
    }
    let env: Envelope<T> | null = null;
    try {
      env = (await res.json()) as Envelope<T>;
    } catch {
      env = null;
    }
    if (!res.ok || !env || env.success === false) {
      const first = env?.errors?.[0];
      const msg = first?.message ?? `HTTP ${res.status}`;
      throw new CloudflareApiError(res.status, `Cloudflare ${method} ${path.split('?')[0]}: ${msg}`, first?.code ?? null);
    }
    return env.result as T;
  }

  const enc = encodeURIComponent;
  return {
    getZone: (zoneId: string) => call<CloudflareZone>('GET', `/zones/${enc(zoneId)}`),
    findZoneByName: async (name: string): Promise<CloudflareZone | null> => {
      const zones = await call<CloudflareZone[]>('GET', `/zones?name=${enc(name)}`);
      return zones.find((z) => z.name === name) ?? null;
    },
    listTunnelsByName: (accountId: string, name: string) =>
      call<CloudflareTunnel[]>('GET', `/accounts/${enc(accountId)}/cfd_tunnel?name=${enc(name)}&is_deleted=false`),
    getTunnel: (accountId: string, tunnelId: string) =>
      call<CloudflareTunnel>('GET', `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}`),
    createTunnel: (accountId: string, name: string) =>
      call<CloudflareTunnel>('POST', `/accounts/${enc(accountId)}/cfd_tunnel`, { name, config_src: 'cloudflare' }),
    putTunnelConfig: (accountId: string, tunnelId: string, config: unknown) =>
      call<unknown>('PUT', `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/configurations`, { config }),
    getTunnelToken: (accountId: string, tunnelId: string) =>
      call<string>('GET', `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/token`),
    cleanupConnections: (accountId: string, tunnelId: string) =>
      call<unknown>('DELETE', `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/connections`),
    deleteTunnel: (accountId: string, tunnelId: string) =>
      call<unknown>('DELETE', `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}`),
    listDnsRecords: (zoneId: string, name: string) =>
      call<CloudflareDnsRecord[]>('GET', `/zones/${enc(zoneId)}/dns_records?name=${enc(name)}`),
    createCname: (zoneId: string, name: string, target: string) =>
      call<CloudflareDnsRecord>('POST', `/zones/${enc(zoneId)}/dns_records`, {
        type: 'CNAME',
        name,
        content: target,
        proxied: true,
        comment: 'Papercusp remote access (own tunnel)',
      }),
    deleteDnsRecord: (zoneId: string, recordId: string) =>
      call<unknown>('DELETE', `/zones/${enc(zoneId)}/dns_records/${enc(recordId)}`),
  };
}

export type CloudflareApi = ReturnType<typeof cloudflareApi>;
