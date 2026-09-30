/**
 * Minimal Hetzner Cloud client (`cloud-deployment-layer-2026-06-06` P-018 —
 * the SECOND driver that proves the abstraction isn't Latitude-shaped).
 *
 * Hetzner's API shape is DELIBERATELY different from Latitude's: a flat
 * `{ server: { id, status, public_net: { ipv4: { ip } } } }` envelope (not
 * JSON:API `data.attributes`), `server_type`/`image`/`location` attributes (not
 * `plan`/`operating_system`/`site`). That the same `DeploymentDriver` interface
 * absorbs both differences is the point of P-018.
 */
export interface HetznerServerAttributes {
  name: string;
  /** Instance type slug — e.g. `cx22` (from config.size). */
  server_type: string;
  /** Image slug — e.g. `ubuntu-22.04`. */
  image: string;
  /** Datacenter location — e.g. `nbg1`, `ash` (from config.region). */
  location?: string;
  ssh_keys?: Array<string | number>;
  user_data?: string;
  start_after_create?: boolean;
  /** Hetzner labels (`GET /servers?label_selector=...` matches on these) — WI-1628
   *  uses this to stamp the CREATING AGENT's owner id onto every ad-hoc rig frame,
   *  so an orphan-frame reaper can resolve who to check liveness for. */
  labels?: Record<string, string>;
}

export interface HetznerServer {
  id: string;
  /** `initializing` | `starting` | `running` | `off` | … */
  status: string;
  name?: string;
  ipv4?: string;
  labels?: Record<string, string>;
  /** ISO creation timestamp (Hetzner's `created` field) — the reaper's age gate. */
  createdAt?: string;
  raw?: unknown;
}

export class HetznerApiError extends Error {
  constructor(readonly op: string, readonly status: number, readonly body: unknown) {
    super(`Hetzner API ${op} failed (HTTP ${status}): ${typeof body === 'string' ? body : JSON.stringify(body)?.slice(0, 400)}`);
    this.name = 'HetznerApiError';
  }
}

export interface HetznerApiClient {
  createServer(attrs: HetznerServerAttributes): Promise<HetznerServer>;
  getServer(id: string): Promise<HetznerServer>;
  deleteServer(id: string): Promise<void>;
  /** `GET /servers` (optionally filtered) — WI-1628's orphan-frame reaper enumerates
   *  every server so it can match the rig naming pattern client-side (label-based
   *  filtering would silently miss older, unlabeled rig frames). */
  listServers(opts?: { labelSelector?: string }): Promise<HetznerServer[]>;
}

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

function parseServer(json: unknown): HetznerServer {
  const s = (json as { server?: Record<string, unknown> } | null)?.server ?? {};
  return parseServerRecord(s);
}

function parseServerRecord(s: Record<string, unknown>): HetznerServer {
  const publicNet = s.public_net as { ipv4?: { ip?: string } } | undefined;
  return {
    id: String(s.id ?? ''),
    status: String(s.status ?? 'unknown'),
    name: typeof s.name === 'string' ? s.name : undefined,
    ipv4: publicNet?.ipv4?.ip,
    labels: (s.labels as Record<string, string> | undefined) ?? {},
    createdAt: typeof s.created === 'string' ? s.created : undefined,
    raw: s,
  };
}

export function createHetznerApiClient(opts: {
  apiToken: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}): HetznerApiClient {
  const baseUrl = (opts.baseUrl ?? 'https://api.hetzner.cloud/v1').replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const headers = {
    Authorization: `Bearer ${opts.apiToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  return {
    async createServer(attrs) {
      const res = await fetchImpl(`${baseUrl}/servers`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ start_after_create: true, ...attrs, image: attrs.image || 'ubuntu-22.04' }),
      });
      const json = await res.json().catch(() => null);
      if (res.status !== 201 && res.status !== 200) throw new HetznerApiError('createServer', res.status, json);
      return parseServer(json);
    },
    async getServer(id) {
      const res = await fetchImpl(`${baseUrl}/servers/${encodeURIComponent(id)}`, { headers });
      const json = await res.json().catch(() => null);
      if (res.status !== 200) throw new HetznerApiError('getServer', res.status, json);
      return parseServer(json);
    },
    async deleteServer(id) {
      const res = await fetchImpl(`${baseUrl}/servers/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
      // Hetzner returns 200 (with an action) or 204 on delete.
      if (res.status !== 200 && res.status !== 204) {
        const body = await res.text().catch(() => '');
        throw new HetznerApiError('deleteServer', res.status, body);
      }
    },
    async listServers(opts) {
      const qs = opts?.labelSelector ? `?label_selector=${encodeURIComponent(opts.labelSelector)}` : '';
      const res = await fetchImpl(`${baseUrl}/servers${qs}`, { headers });
      const json = await res.json().catch(() => null);
      if (res.status !== 200) throw new HetznerApiError('listServers', res.status, json);
      const servers = (json as { servers?: Record<string, unknown>[] } | null)?.servers ?? [];
      return servers.map(parseServerRecord);
    },
  };
}
