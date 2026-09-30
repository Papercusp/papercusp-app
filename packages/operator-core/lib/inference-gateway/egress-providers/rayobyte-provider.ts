/**
 * RayobyteProvider — the REST-driven `EgressProvider` for Rayobyte (D-001 of
 * `gateway-live-control-and-egress-plan-2026-06-20`: static-residential/ISP, dedicated IPs, unlimited
 * bandwidth, diverse ASN — the chosen egress vendor for per-account IP routing).
 *
 * ⚠️ NOT YET EXERCISED AGAINST A LIVE RAYOBYTE ACCOUNT. The 8 dedicated IPs running in production
 * today were ordered + whitelisted by hand through Rayobyte's dashboard and registered directly via
 * `accounts:register{egress}` (see `inference-gateway-per-account-egress-ips.mdx`) — this class is the
 * programmatic-provisioning automation WI-288 asks for, built against Rayobyte's documented REST
 * shape (list/order proxies, label = assignment tag), with every endpoint path + response shape
 * CONFIGURABLE (`baseUrl` override) precisely because it has not been round-tripped against a live
 * account. Before relying on this in production: confirm the `/proxies`, `/proxies/order`, and
 * `/proxies/:id/label` paths (and response envelope) against Rayobyte's current API docs, and adjust
 * `baseUrl`/the response parsing here if they differ. `fetchImpl` is injectable so this stays fully
 * unit-testable with no live network (see `rayobyte-provider.test.ts`).
 *
 * IP-whitelist auth (D-006: no proxy user:pass on the wire) is an owner-gated ONE-TIME step done in
 * the Rayobyte dashboard/API (whitelisting this box's outbound IP) — out of scope for this abstraction,
 * same as the credential provisioning itself.
 */
import { resolveSecretRef } from './secret-ref';
import { probeAllocationHealth, type HealthProbeDeps } from './health-probe';
import type { EgressAllocation, EgressHealth, EgressProvider } from './types';

export interface RayobyteProviderConfig {
  /** REST API base URL (no trailing slash needed). Default is a best-effort placeholder — CONFIRM
   *  against Rayobyte's actual API docs before relying on this in production (see module doc). */
  baseUrl?: string;
  /** Secret ref (env:NAME | file:<path> | absolute/~ path) for the Rayobyte API key. Default
   *  `env:RAYOBYTE_API_KEY`. Resolved via `resolveSecretRef` — never the literal key in config. */
  apiKeyRef?: string;
  /** Injectable fetch for tests / a custom runtime. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Health-probe deps threaded to `probeAllocationHealth` (tests inject a fake dispatcher/echo). */
  healthProbeDeps?: HealthProbeDeps;
}

const DEFAULT_BASE_URL = 'https://api.rayobyte.com/v1';
const DEFAULT_API_KEY_REF = 'env:RAYOBYTE_API_KEY';

interface RayobyteProxyRecord {
  id: string;
  ip: string;
  port: number;
  /** The assignment tag this provider uses to track "which account holds this IP" — set via the
   *  `label` PATCH on allocate, cleared (null) on release. Absent/empty ⇒ free. */
  label?: string | null;
  [k: string]: unknown;
}

function proxyUrlFor(p: RayobyteProxyRecord): string {
  return `http://${p.ip}:${p.port}`;
}

function toAllocation(p: RayobyteProxyRecord): EgressAllocation {
  const { id, ip, port, label, ...rest } = p;
  return {
    id,
    proxyUrl: proxyUrlFor(p),
    accountId: label || undefined,
    meta: { ip, port, ...rest },
  };
}

function extractList(body: unknown): RayobyteProxyRecord[] {
  if (Array.isArray(body)) return body as RayobyteProxyRecord[];
  const obj = body as { proxies?: RayobyteProxyRecord[] } | null | undefined;
  return obj?.proxies ?? [];
}

/** Pull the first proxy record out of an order response, whichever of the two shapes the API used —
 *  `{ proxies: [...] }` or a single bare record. Plain field checks (not a `'proxies' in x` narrow)
 *  because `RayobyteProxyRecord`'s index signature would otherwise let a bare record structurally
 *  match the `{ proxies?: [...] }` shape too and defeat the narrow. */
function firstOrderedRecord(body: unknown): RayobyteProxyRecord | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as { proxies?: unknown; id?: unknown };
  if (Array.isArray(obj.proxies)) {
    const first = obj.proxies[0];
    return first && typeof first === 'object' ? (first as RayobyteProxyRecord) : null;
  }
  return typeof obj.id === 'string' ? (obj as RayobyteProxyRecord) : null;
}

export function createRayobyteProvider(config: RayobyteProviderConfig = {}): EgressProvider {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKeyRef = config.apiKeyRef ?? DEFAULT_API_KEY_REF;
  const fetchImpl = config.fetchImpl ?? fetch;
  const healthProbeDeps = config.healthProbeDeps ?? {};

  async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const apiKey = await resolveSecretRef(apiKeyRef);
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(
        `egress: rayobyte ${init.method ?? 'GET'} ${path} → HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ''}`,
      );
    }
    return res;
  }

  async function listRecords(): Promise<RayobyteProxyRecord[]> {
    const res = await authedFetch('/proxies');
    return extractList(await res.json().catch(() => []));
  }

  return {
    name: 'rayobyte',
    async allocate(accountId): Promise<EgressAllocation> {
      // Prefer reusing an already-owned, currently-unlabeled IP over ordering a fresh one — the
      // dedicated IPs are typically ordered once and rotated across accounts, not re-ordered per call.
      const existing = await listRecords();
      const free = existing.find((p) => !p.label);
      if (free) {
        await authedFetch(`/proxies/${encodeURIComponent(free.id)}/label`, {
          method: 'PATCH',
          body: JSON.stringify({ label: accountId }),
        });
        return toAllocation({ ...free, label: accountId });
      }
      const orderRes = await authedFetch('/proxies/order', {
        method: 'POST',
        body: JSON.stringify({ quantity: 1, label: accountId }),
      });
      const ordered = await orderRes.json().catch(() => null);
      const rec = firstOrderedRecord(ordered);
      if (!rec) throw new Error('egress: rayobyte order returned no proxy record');
      return toAllocation({ ...rec, label: rec.label ?? accountId });
    },
    async release(id) {
      try {
        await authedFetch(`/proxies/${encodeURIComponent(id)}/label`, {
          method: 'PATCH',
          body: JSON.stringify({ label: null }),
        });
      } catch (e) {
        // Idempotent per the interface contract — releasing an unknown/already-free id shouldn't throw.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/HTTP 404/.test(msg)) throw e;
      }
    },
    async list() {
      const records = await listRecords();
      return records.map(toAllocation);
    },
    async healthcheck(id): Promise<EgressHealth> {
      const records = await listRecords();
      const rec = records.find((p) => p.id === id);
      if (!rec) return { reachable: false, error: 'egress_allocation_not_found' };
      return probeAllocationHealth(toAllocation(rec), healthProbeDeps);
    },
  };
}
