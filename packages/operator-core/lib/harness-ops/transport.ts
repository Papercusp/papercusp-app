/**
 * Operator → harness dispatch transport (`harness-provided-cadence-ops-2026-06-26`
 * P-004 / P-005 / D-001).
 *
 * A harness-provided op (declared in a blueprint's `ops:` manifest) executes in
 * the HARNESS's own runtime, not operator-core (the security + repo/process/DB
 * isolation boundary, D-001). When the durable `coordProgramWorkflow` runs such
 * an op, the proxy CoordOp's `run()` DISPATCHES the call here: this module finds
 * where the harness's sidecar is and POSTs `/api/op/<name>` to it.
 *
 * WHERE the sidecar is (resolution order in `harnessApiBase`):
 *   1. ENV OVERRIDE `PAPERCUSP_HARNESS_ENDPOINT__<SLUG>` — a full base URL. The
 *      test/dev escape hatch (and a way to pin a sidecar without PG).
 *   2. DEPLOYED frame — `http://{frame.host}:{frame.callablePort}` when the harness
 *      runs on a provisioned cloud frame (the frame carries the callable op port).
 *   3. LOCAL registration (P-005) — the sidecar advertised `{host,port}` on boot
 *      (`registerHarnessLocalEndpoint`, persisted in the harness_registry project
 *      row in workspace PG). The durable LOCAL path: survives operator restarts,
 *      generic across harnesses, no home-dir-path guessing.
 *   4. else — throw a clear "endpoint not registered" error. Dispatch fails CLOSED
 *      (the cadence cron is seeded INACTIVE, so this never fires silently).
 *
 * Network resilience reuses the loopback retry shape (`isTransientNetworkError` +
 * bounded backoff) so a sidecar mid-restart rides over a transient refuse.
 */
import {
  loadHarnessRegistry,
  mutateHarnessRegistry,
  type HarnessLocalEndpoint,
} from '../harness-registry';
import { loadDeployedFrame } from '../deployment/deployed-frame';
import { isTransientNetworkError, isConnRefused, describeFetchError, readJsonBody } from '../loopback-fetch';
import type { Frame } from '@papercusp/deployment-driver';

export type { HarnessLocalEndpoint };

/** Env-var name for a per-harness base-URL override (test/dev pin). */
export function harnessEndpointEnvVar(slug: string): string {
  const norm = slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `PAPERCUSP_HARNESS_ENDPOINT__${norm}`;
}

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/**
 * Persist a harness sidecar's advertised LOCAL endpoint (P-005). Called by the
 * `POST /harness/endpoint` route when a sidecar advertises on boot. Idempotent
 * upsert into the harness_registry project row; if no project row exists for the
 * slug yet (a harness whose install hasn't projected), it's a no-op (the advert
 * is best-effort — the sidecar re-advertises on its next boot).
 */
export async function registerHarnessLocalEndpoint(
  slug: string,
  endpoint: { host: string; port: number; pid?: number },
  workspaceId?: string,
): Promise<{ ok: boolean; reason?: string }> {
  const advertised: HarnessLocalEndpoint = {
    host: endpoint.host,
    port: endpoint.port,
    ...(endpoint.pid != null ? { pid: endpoint.pid } : {}),
    advertisedAt: new Date().toISOString(),
  };
  let matched = false;
  await mutateHarnessRegistry((reg) => {
    const projects = reg.projects.map((p) => {
      if (p.slug !== slug) return p;
      matched = true;
      return { ...p, localEndpoint: advertised };
    });
    return { ...reg, projects };
  }, workspaceId);
  return matched ? { ok: true } : { ok: false, reason: `no harness_registry project for slug '${slug}'` };
}

/** Read a harness's advertised LOCAL endpoint, or undefined. */
export async function getHarnessLocalEndpoint(
  slug: string,
  workspaceId?: string,
): Promise<HarnessLocalEndpoint | undefined> {
  const reg = await loadHarnessRegistry(workspaceId);
  return reg.projects.find((p) => p.slug === slug)?.localEndpoint;
}

/** Which resolution step provided a dispatch base (see the module header order).
 *  Only the `local` source is self-healed on a persistent refuse (WI-1385) — an
 *  env pin and a deployed frame have a different lifecycle and are never cleared. */
export type HarnessApiBaseSource = 'env' | 'frame' | 'local';

/**
 * Thrown by {@link resolveHarnessApiBase} when a harness has NO reachable dispatch
 * endpoint (no env override, no deployed frame callablePort, no local registration).
 * It is a distinct, recoverable state — the sidecar may register later — so callers
 * that fire harness-op cadences (blueprint-run) key on it to WITHHOLD the run instead
 * of reporting a program FAILURE, and it re-fires once the endpoint appears (WI-1087).
 */
export class HarnessEndpointUnavailableError extends Error {
  readonly code = 'harness_endpoint_unavailable' as const;
  readonly harnessSlug: string;
  constructor(slug: string, message: string) {
    super(message);
    this.name = 'HarnessEndpointUnavailableError';
    this.harnessSlug = slug;
  }
}

/**
 * Resolve the base URL the operator dispatches harness ops to AND record which
 * resolution step provided it. See the module header for the resolution order.
 * `frame` may be passed (the caller already loaded the deployed frame) or omitted
 * (looked up from the registry). The `source` lets `harnessApiFetch` invalidate a
 * stale LOCAL registration on a persistent connection-refuse without touching an
 * env override or a deployed-frame base (WI-1385).
 */
export async function resolveHarnessApiBase(
  slug: string,
  workspaceId?: string,
  frame?: Frame,
): Promise<{ base: string; source: HarnessApiBaseSource }> {
  // 1. Env override.
  const envBase = process.env[harnessEndpointEnvVar(slug)];
  if (envBase && envBase.trim()) return { base: normalizeBase(envBase.trim()), source: 'env' };

  // 2. Deployed frame (passed, or looked up).
  let f = frame;
  if (!f && workspaceId) {
    const loaded = await loadDeployedFrame(slug, workspaceId);
    f = loaded?.frame;
  }
  if (f?.host && f.callablePort) {
    return { base: normalizeBase(`http://${f.host}:${f.callablePort}`), source: 'frame' };
  }

  // 3. Local registration (the durable LOCAL path). A registry-read failure is
  // treated as "not registered" (→ fail closed below); the cron retries next tick.
  let local: HarnessLocalEndpoint | undefined;
  try {
    local = await getHarnessLocalEndpoint(slug, workspaceId);
  } catch {
    local = undefined;
  }
  if (local?.host && local.port) {
    return { base: normalizeBase(`http://${local.host}:${local.port}`), source: 'local' };
  }

  // 4. Fail closed with actionable guidance. Typed so a cadence caller can WITHHOLD
  // (the sidecar may register later) instead of reporting a hard program failure.
  throw new HarnessEndpointUnavailableError(
    slug,
    `harness '${slug}' has no dispatch endpoint registered — the harness sidecar must advertise ` +
      `{host,port} on boot (POST /harness/endpoint → registerHarnessLocalEndpoint), be DEPLOYED ` +
      `with a frame.callablePort, or set ${harnessEndpointEnvVar(slug)} to a base URL.`,
  );
}

/**
 * Resolve the dispatch base URL (see the module header for the resolution order).
 * Thin wrapper over `resolveHarnessApiBase` for callers that don't need the source.
 */
export async function harnessApiBase(
  slug: string,
  workspaceId?: string,
  frame?: Frame,
): Promise<string> {
  return (await resolveHarnessApiBase(slug, workspaceId, frame)).base;
}

/**
 * Drop a harness's cached LOCAL endpoint (WI-1385 self-heal). Called by
 * `harnessApiFetch` when a dispatch to a locally-registered base is REFUSED across
 * all retries: the sidecar has died or MOVED to a new port, so the cached
 * `{host,port}` is stale. Clearing it makes the next dispatch fail closed with a
 * clear "endpoint not registered" error — and re-populate the moment the sidecar
 * re-advertises its live port on boot — instead of hammering the dead port forever.
 * Best-effort + idempotent: a no-op if the slug has no project row or no endpoint.
 */
export async function invalidateHarnessLocalEndpoint(
  slug: string,
  workspaceId?: string,
): Promise<{ cleared: boolean }> {
  let cleared = false;
  await mutateHarnessRegistry((reg) => {
    const projects = reg.projects.map((p) => {
      if (p.slug !== slug || !p.localEndpoint) return p;
      cleared = true;
      const next = { ...p };
      delete next.localEndpoint;
      return next;
    });
    return { ...reg, projects };
  }, workspaceId);
  return { cleared };
}

const DEFAULT_BACKOFFS_MS = [400, 800, 1200];

/**
 * `fetch()` to a harness sidecar with bounded retry on transient network errors
 * (a sidecar mid-restart refuses the connection briefly). Mirrors `loopbackFetch`.
 * `path` is appended to the resolved base (leading `/` optional).
 */
export async function harnessApiFetch(
  slug: string,
  path: string,
  init?: RequestInit,
  opts: { workspaceId?: string; frame?: Frame; backoffsMs?: number[] } = {},
): Promise<Response> {
  const { base, source } = await resolveHarnessApiBase(slug, opts.workspaceId, opts.frame);
  const url = `${base}/${path.replace(/^\/+/, '')}`;
  const backoffs = opts.backoffsMs ?? DEFAULT_BACKOFFS_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (isTransientNetworkError(err) && attempt < backoffs.length) {
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
        continue;
      }
      // Self-heal (WI-1385): a LOCAL-registered base that REFUSES across every
      // retry is a dead or MOVED sidecar — drop the stale cached endpoint so the
      // next dispatch fails closed until the sidecar re-advertises, instead of
      // hammering a dead port forever. Scoped tightly: only the `local` source
      // (an env pin / deployed frame has a different lifecycle) and only on
      // connection-refused (a timeout/reset may recover on the same port). The
      // cleanup is best-effort — never let it mask the real dispatch error.
      if (source === 'local' && isConnRefused(err)) {
        try {
          await invalidateHarnessLocalEndpoint(slug, opts.workspaceId);
        } catch {
          /* best-effort: the next tick re-reads and fails closed anyway */
        }
      }
      throw new Error(`harness '${slug}' dispatch to ${url} failed: ${describeFetchError(err)}`, { cause: err });
    }
  }
  throw lastErr; // unreachable
}

/** The harness-side `/api/op/<name>` response envelope (P-006). */
export type HarnessOpResponse<R = unknown> =
  | { ok: true; result: R }
  | { ok: false; error: string };

/**
 * Dispatch one harness op: POST `/api/op/<name>` with `{ args, ctx }` and return
 * the harness's `result`. Throws on a transport failure or an `{ok:false}` body.
 * The proxy CoordOp's `run()` validates the returned `result` against the
 * manifest's `resultSchema` (the trust boundary) — this layer is transport only.
 */
export async function dispatchHarnessOp<R = unknown>(
  slug: string,
  opName: string,
  args: unknown,
  opts: {
    workspaceId?: string;
    frame?: Frame;
    ctx?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
): Promise<R> {
  const res = await harnessApiFetch(
    slug,
    `/api/op/${encodeURIComponent(opName)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args, ctx: opts.ctx ?? {} }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    { workspaceId: opts.workspaceId, frame: opts.frame },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `harness '${slug}' op '${opName}' dispatch HTTP ${res.status}${text ? `: ${text.slice(0, 400)}` : ''}`,
    );
  }
  const body = await readJsonBody<HarnessOpResponse<R>>(res, `harness ${slug} op ${opName}`);
  if (!body || typeof body !== 'object' || !('ok' in body)) {
    throw new Error(`harness '${slug}' op '${opName}' returned a malformed envelope (expected {ok,result})`);
  }
  if (body.ok === false) {
    throw new Error(`harness '${slug}' op '${opName}' failed: ${body.error}`);
  }
  return body.result;
}
