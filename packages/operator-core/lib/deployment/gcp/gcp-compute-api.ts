/**
 * Minimal GCP Compute Engine REST client for the deployment layer — the API half
 * of `GcpDriver`, mirroring `hetzner/hetzner-api.ts` in shape so the driver above
 * it reads the same on both providers.
 *
 * WHY THIS EXISTS (p2p-public-release-remaining-lanes-2026-07-16 D-086): the
 * cross-machine acceptance harness needs TWO separate public-IP hosts. It was
 * carried as rig-blocked because the on-disk Hetzner tokens are dead (HTTP 401),
 * and a cred-gated leg that SKIPS is indistinguishable from one that is absent.
 * GCP is live for this workspace, and the harness is provisioner-agnostic
 * (`remote-peer.ts` has zero hetzner/hcloud references; `sshPeerLauncher` takes a
 * plain `SshSlotSpec`). So the fix is one more driver behind the existing seam —
 * NOT a fork of the harness.
 *
 * Scope is deliberately narrow: create / get / delete one instance, plus the zone
 * operation polling those need. Anything richer belongs in
 * `workspace-host/gcp-api-client.ts`, which serves a different (workspace-host)
 * concern.
 */

/** A non-2xx GCP API response. `status` is the HTTP status, so callers can branch on 404/409/412. */
export class GcpApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'GcpApiError';
    this.status = status;
    this.body = body;
  }
}

/** Attributes for creating one Compute Engine instance. */
export interface GcpInstanceAttributes {
  /** RFC1035 instance name (lowercase alphanumeric + hyphen, <=63 chars). */
  name: string;
  /** Zone, e.g. `us-east1-b`. GCP zones are the region vocabulary for this driver. */
  zone: string;
  /** Machine type short name, e.g. `e2-standard-4`. */
  machineType: string;
  /** Full image URL or family URL. Defaults to Ubuntu 22.04 LTS at the driver layer. */
  sourceImage: string;
  bootDiskGb?: number;
  /** `metadata.ssh-keys` value: `"<user>:<ssh-ed25519 AAAA... comment>"`, newline-separated for several. */
  sshKeys?: string;
  /** Extra metadata entries (e.g. `startup-script`). */
  metadata?: Record<string, string>;
  /** Network tags (firewall targeting). */
  tags?: string[];
  /** VPC network URL; defaults to the project's `global/networks/default`. */
  network?: string;
}

/** The subset of an instance this layer cares about. */
export interface GcpInstance {
  id: string;
  name: string;
  zone: string;
  /** PROVISIONING | STAGING | RUNNING | STOPPING | TERMINATED | ... */
  status: string;
  /** External (1:1 NAT) IPv4, once assigned. */
  ipv4?: string;
}

export interface GcpComputeApiClient {
  createInstance(attrs: GcpInstanceAttributes): Promise<GcpInstance>;
  getInstance(zone: string, name: string): Promise<GcpInstance>;
  deleteInstance(zone: string, name: string): Promise<void>;
}

export interface GcpComputeApiClientOptions {
  projectId: string;
  /** Returns a bearer token. Injected so tests never touch ADC and callers pick their auth. */
  getAccessToken: () => Promise<string>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Operation poll interval (default 3s) and ceiling (default 10min). */
  operationPollIntervalMs?: number;
  operationTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_URL = 'https://compute.googleapis.com/compute/v1';

/**
 * RFC1035-normalize a candidate instance name. GCP rejects uppercase, underscores,
 * a leading digit and a trailing hyphen — and a 400 on create is a confusing way to
 * discover that a label like `ash-0` or `US-East` was the problem.
 */
export function toGcpInstanceName(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '');
  if (!s || !/^[a-z]/.test(s)) s = `pc-${s}`;
  s = s.slice(0, 63).replace(/-+$/, '');
  return s;
}

/** Last path segment of a GCP self-link (`.../zones/us-east1-b` → `us-east1-b`). */
export function lastSegment(url: string | undefined): string {
  if (!url) return '';
  const i = url.lastIndexOf('/');
  return i === -1 ? url : url.slice(i + 1);
}

interface RawInstance {
  id?: string | number;
  name?: string;
  zone?: string;
  status?: string;
  networkInterfaces?: Array<{ accessConfigs?: Array<{ natIP?: string }> }>;
}

function toInstance(raw: RawInstance, fallbackZone: string, fallbackName: string): GcpInstance {
  const natIP = raw.networkInterfaces?.[0]?.accessConfigs?.find((a) => a.natIP)?.natIP;
  return {
    id: raw.id != null ? String(raw.id) : fallbackName,
    name: raw.name ?? fallbackName,
    zone: lastSegment(raw.zone) || fallbackZone,
    status: raw.status ?? 'UNKNOWN',
    ipv4: natIP,
  };
}

export function createGcpComputeApiClient(opts: GcpComputeApiClientOptions): GcpComputeApiClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const pollIntervalMs = opts.operationPollIntervalMs ?? 3_000;
  const operationTimeoutMs = opts.operationTimeoutMs ?? 10 * 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const project = opts.projectId;

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await opts.getAccessToken();
    const res = await doFetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const detail =
        (body as { error?: { message?: string } } | undefined)?.error?.message ?? text.slice(0, 400);
      throw new GcpApiError(`GCP ${init?.method ?? 'GET'} ${path} failed (${res.status}): ${detail}`, res.status, body);
    }
    return body as T;
  }

  /**
   * Poll a zone operation to DONE. A create/delete POST returns an ACCEPTED
   * operation, not a completed one — the same "2xx is an accepted action, not a
   * confirmed result" trap the Hetzner driver documents for teardown. An
   * operation that finishes with `error` is surfaced as a GcpApiError so a failed
   * create cannot masquerade as a slow one and burn the whole poll timeout.
   */
  async function waitForZoneOperation(zone: string, opName: string): Promise<void> {
    const deadline = Date.now() + operationTimeoutMs;
    for (;;) {
      const op = await call<{
        status?: string;
        error?: { errors?: Array<{ code?: string; message?: string }> };
        httpErrorStatusCode?: number;
        httpErrorMessage?: string;
      }>(`/projects/${project}/zones/${zone}/operations/${encodeURIComponent(opName)}`);
      if (op.status === 'DONE') {
        if (op.error) {
          const msg = (op.error.errors ?? []).map((e) => `${e.code ?? '?'}: ${e.message ?? '?'}`).join('; ');
          throw new GcpApiError(
            `GCP zone operation ${opName} finished with error: ${msg || op.httpErrorMessage || 'unknown'}`,
            op.httpErrorStatusCode ?? 500,
            op.error,
          );
        }
        return;
      }
      if (Date.now() >= deadline) {
        throw new GcpApiError(
          `GCP zone operation ${opName} not DONE after ${Math.round(operationTimeoutMs / 1000)}s (last status '${op.status ?? 'unknown'}')`,
          504,
          op,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  return {
    async createInstance(attrs: GcpInstanceAttributes): Promise<GcpInstance> {
      const metadataItems = Object.entries({
        ...(attrs.sshKeys ? { 'ssh-keys': attrs.sshKeys } : {}),
        ...(attrs.metadata ?? {}),
      }).map(([key, value]) => ({ key, value }));

      const payload = {
        name: attrs.name,
        machineType: `zones/${attrs.zone}/machineTypes/${attrs.machineType}`,
        disks: [
          {
            boot: true,
            autoDelete: true,
            initializeParams: {
              sourceImage: attrs.sourceImage,
              diskSizeGb: String(attrs.bootDiskGb ?? 20),
            },
          },
        ],
        networkInterfaces: [
          {
            network: attrs.network ?? `projects/${project}/global/networks/default`,
            // ONE_TO_ONE_NAT is what gives the frame a distinct EXTERNAL IP. The
            // two-host holepunch requirement is about two DISTINCT public IPs on
            // separate machines; the NAT-like inbound-drop that makes the punch
            // meaningful is applied IN-GUEST by bench-bootstrap, not here.
            accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }],
          },
        ],
        ...(metadataItems.length ? { metadata: { items: metadataItems } } : {}),
        ...(attrs.tags?.length ? { tags: { items: attrs.tags } } : {}),
      };

      const op = await call<{ name?: string }>(`/projects/${project}/zones/${attrs.zone}/instances`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (op.name) await waitForZoneOperation(attrs.zone, op.name);
      return this.getInstance(attrs.zone, attrs.name);
    },

    async getInstance(zone: string, name: string): Promise<GcpInstance> {
      const raw = await call<RawInstance>(
        `/projects/${project}/zones/${zone}/instances/${encodeURIComponent(name)}`,
      );
      return toInstance(raw, zone, name);
    },

    async deleteInstance(zone: string, name: string): Promise<void> {
      const op = await call<{ name?: string }>(
        `/projects/${project}/zones/${zone}/instances/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      if (op.name) await waitForZoneOperation(zone, op.name);
    },
  };
}
