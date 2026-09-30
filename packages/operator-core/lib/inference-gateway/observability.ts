/**
 * Rate observability read-model for the hive inference gateway (hive-inference-gateway P-014).
 *
 * The gateway is the ONLY thing in the fleet that sees `anthropic-ratelimit-*` on every response
 * (the subprocess path is blind to them — D-006). It exposes its live view at `GET /stats`; this
 * module fetches that and PROJECTS it into a normalized "how close to the cap + how backed up is
 * the queue" read-model the operator `/admin` surface renders. The gateway runs in its own process
 * (separate governor registry), so the operator can't read its buckets directly — it reads them
 * over this localhost hop.
 */
import type { GatewayStats } from './gateway';
import { gatewayPort } from './spawn-env';
import type { RawGatewayStats } from './gateway-wedge';
import type { LocalBackend, LocalBackendCandidate, LocalBackendEngineCapacity } from './local-backend-pool';

export interface GatewayHeadroom {
  /** Provider whose admission/account fields were projected from /stats. */
  provider?: 'claude' | 'codex';
  reachable: boolean;
  accountId?: string;
  /** Epoch ms when the gateway process started, when the live /stats payload is new enough to expose it. */
  processStartedAt?: number;
  /** Milliseconds since the gateway process started. Fresh restarts can briefly report zero capacity. */
  processUptimeMs?: number;
  /** Most-constraining unified window: '5h' | '7d' | 'unified' (D-009). */
  window?: string;
  /** 0..1+ utilization of that window (1.0 = at cap). */
  utilization?: number;
  /** Human percent, rounded. */
  utilizationPct?: number;
  /** Whether the binding window is currently rejected (hard-limited). */
  rejected?: boolean;
  /** Seconds until the binding window resets (0 if unknown / already reset). */
  resetInSec?: number;
  /** Currently paused (any reason) until this epoch ms (0 = not paused). */
  pausedUntil?: number;
  paused?: boolean;
  /** Queue: how many bee requests are forwarding now vs waiting for a slot. */
  inFlight?: number;
  queueDepth?: number;
  /** Per-priority queue breakdown (queen/interactive vs batch). */
  byPriority?: { priority: number; count: number }[];
  /** Pool-wide count of accounts that can serve a request RIGHT NOW (the `GatewayStats.healthyAccounts`
   *  top-level field — reported unconditionally, unlike `priorityTiers.healthyAccounts` which is absent
   *  under flag-OFF). `0` = the whole pool is walled/paused, so there is no remote capacity at all.
   *  Undefined when the live gateway predates the field (deploy-skew) — treat as UNKNOWN, not as zero. */
  healthyAccounts?: number;
  /** Per-TIER admission breakdown (gateway-priority-tiers-2026-06-22) — present only when the gateway's
   *  tier layer is on (GATEWAY_PRIORITY_TIERS). The pool-wide `healthyAccounts` capacity denominator, the
   *  reserved tier-1 floor, and per-tier {cap,inFlight,queued}. Feeds the Queen's `fleet:capacity` /
   *  capacity-aware dispatch (the SOURCE-side read of the SHARED oracle, D-007). */
  priorityTiers?: {
    healthyAccounts: number;
    tier1Reserve: number;
    tiers: { tier: number; minShare: number | null; inFlight: number; queued: number }[];
  };
  totalRequests?: number;
  upstream429?: number;
  queued429?: number;
  /** RPM-smoothing summary for the bound account (P-005): is the burst-dodging pace ENGAGED, and the
   *  EFFECTIVE inter-request pace (ms) actually enforced on it. `effectivePaceMs > 0` ⇒ requests are
   *  being spaced (smoothing is live, not just configured). Undefined when the gateway has no per-account
   *  governor yet. */
  smoothingEngaged?: boolean;
  smoothRpm?: boolean;
  effectivePaceMs?: number;
  /** The bound account's effective per-minute allowance = floor(rpm × learned factor). */
  effRpm?: number | null;
  error?: string;
}

/** Project a raw gateway /stats payload into the normalized headroom read-model. */
export function projectHeadroom(
  stats: GatewayStats,
  now = Date.now(),
  opts: { provider?: 'claude' | 'codex' } = {},
): GatewayHeadroom {
  const provider = opts.provider ?? 'claude';
  // /stats carries independent admission and account-health signals for Claude and Codex. Never
  // project Claude's headline into a Codex read: that was the false "pool exhausted" verdict that
  // blocked a healthy ChatGPT-subscription launch (EI-20183190844096359).
  const admission = provider === 'codex' ? stats.codexAdmission : stats.admission;
  const healthyAccounts = provider === 'codex' ? stats.codexHealthyAccounts : stats.healthyAccounts;
  const priorityTiers =
    provider === 'codex'
      ? admission?.byTier && healthyAccounts !== undefined
        ? {
            healthyAccounts,
            tier1Reserve: admission.tier1Reserve ?? 0,
            tiers: admission.byTier,
          }
        : undefined
      : stats.priorityTiers;
  const u = provider === 'claude' ? stats.unified : undefined;
  // P-005: surface the bound account's smoothing pace (the /stats `smoothing.byAccount[accountId]` entry).
  const sm = provider === 'claude' ? stats.smoothing?.byAccount?.[stats.accountId] : undefined;
  const processStartedAt = Number.isFinite(stats.processStartedAt) ? stats.processStartedAt : undefined;
  const processUptimeMs = Number.isFinite(stats.processUptimeMs)
    ? stats.processUptimeMs
    : processStartedAt != null
      ? Math.max(0, now - processStartedAt)
      : undefined;
  return {
    provider,
    reachable: true,
    // stats.accountId is the Claude pool's active account; do not label it as Codex capacity.
    accountId: provider === 'claude' ? stats.accountId : undefined,
    processStartedAt,
    processUptimeMs,
    window: u?.window,
    utilization: u?.utilization,
    utilizationPct: u ? Math.round(u.utilization * 100) : undefined,
    rejected: u?.rejected,
    resetInSec: u?.resetAt ? Math.max(0, Math.round((u.resetAt - now) / 1000)) : undefined,
    pausedUntil: provider === 'claude' ? stats.pausedUntil : undefined,
    paused: provider === 'claude' ? stats.pausedUntil > now : undefined,
    inFlight: admission?.running,
    queueDepth: admission?.queued,
    healthyAccounts: Number.isFinite(healthyAccounts) ? healthyAccounts : undefined,
    byPriority: admission?.byPriority,
    priorityTiers,
    totalRequests: provider === 'codex' ? stats.codex?.requests : stats.totalRequests,
    upstream429: provider === 'codex' ? stats.codex?.upstream429 : stats.upstream429,
    queued429: provider === 'claude' ? stats.queued429 : undefined,
    smoothingEngaged: provider === 'claude' ? stats.smoothing?.engaged : undefined,
    smoothRpm: sm?.smoothRpm,
    effectivePaceMs: sm?.effectivePaceMs,
    effRpm: sm?.effRpm,
  };
}

/**
 * Fetch + project the live gateway headroom. Returns `{ reachable:false, error }` when the gateway
 * service is down (never throws) so `/admin` can render "gateway offline" rather than 500.
 */
export async function fetchGatewayHeadroom(
  opts: { port?: number; fetchImpl?: typeof fetch; timeoutMs?: number; provider?: 'claude' | 'codex' } = {},
): Promise<GatewayHeadroom> {
  const port = opts.port ?? gatewayPort();
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1500);
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/stats`, { signal: ctrl.signal });
    if (!res.ok) return { reachable: false, error: `gateway /stats ${res.status}` };
    const stats = (await res.json()) as GatewayStats;
    return projectHeadroom(stats, Date.now(), { provider: opts.provider });
  } catch (e) {
    return { reachable: false, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pure predicate: does an ALREADY-FETCHED headroom read show the gateway
 * WHOLESALE-throttled — the bound account paused, or its unified window hard-rejected
 * (the all-accounts 429 storm / no-fresh-account state), with no priority-tier capacity
 * to fall back on? Factored out of `gatewayWholesaleThrottled` (WI-3186) so a caller that
 * already called `fetchGatewayHeadroom` for another reason (e.g. the desktop setup-status
 * probe) can reuse the SAME decision without a second `/stats` round-trip. Returns false
 * when the read isn't reachable — the conservative answer, matching `gatewayWholesaleThrottled`.
 */
export function isWholesaleThrottled(h: GatewayHeadroom): boolean {
  if (h.reachable !== true) return false;
  if (h.priorityTiers) {
    const serviceable =
      h.priorityTiers.healthyAccounts > 0 &&
      h.priorityTiers.tiers.some((t) => t.minShare === null || t.minShare > t.inFlight + t.queued);
    if (serviceable) return false;
  }
  return h.paused === true || h.rejected === true;
}

/**
 * Best-effort predicate: is the inference gateway WHOLESALE-throttled right now — see
 * {@link isWholesaleThrottled} for the decision itself. Used to tell a CAPACITY-SHED
 * mid-turn spawn death (a transient capacity event — RETRYABLE) from a real launcher-host
 * loss (terminal): a spawn whose 1st gateway call succeeded then exits-1 when its 2nd call
 * hits the all-accounts storm was being mislabeled `infra_loss` / "host dead/unstable",
 * sending debuggers hunting a phantom host bug (spawn-classification audit P-006/H13;
 * agent-insights/rate-limit-is-usually-account-routing-not-capacity Fault #5).
 *
 * Never throws (delegates to fetchGatewayHeadroom, which swallows transport errors) and
 * uses a short timeout so a wedged gateway can't stall the spawn-fire classifier.
 * Returns false when the gateway is unreachable OR healthy — the conservative answer,
 * so the caller keeps the legacy `infra_loss` label and never relabels on uncertainty.
 */
export async function gatewayWholesaleThrottled(
  opts: { port?: number; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  // TEST-SAFE: the DEFAULT path fetches the LIVE :8788 gateway — under a vitest runner that makes any
  // test on the no-turn spawn-classification path (durable-spawn / launch-blueprint) NONDETERMINISTIC
  // (it reads whatever real gateway happens to be running + throttled on the box). Skip the live probe
  // under VITEST → false (the conservative infra_loss default), so the classifier never reaches a live
  // gateway in tests. A test that injects its own `fetchImpl` (observability.test.ts) opts INTO the real
  // logic, so that path still runs. Production (VITEST unset) is unchanged.
  if (process.env.VITEST && !opts.fetchImpl) return false;
  const h = await fetchGatewayHeadroom({ timeoutMs: 800, ...opts });
  return isWholesaleThrottled(h);
}

/**
 * EI-8797 residual: tell the LIVE gateway process to readmit `ids` into its failover rotation NOW.
 * `accounts:reset-rate` resets the PERSISTED account-pool store, but the gateway keeps its own
 * in-memory exhausted/pause map — without this poke, `/stats` keeps reporting healthyAccounts=0
 * (split-brain) until the stale pause naturally expires, and capacity readers (fleet sizing,
 * `fleet:capacity`) under-count. Best-effort BY DESIGN: returns `{ reachable:false, error }` when
 * the gateway is down or predates `POST /admin/readmit` (deploy-skew) — never throws, so the store
 * reset (the durable half) always succeeds regardless. Reports the gateway's fresh healthyAccounts
 * so the caller can VERIFY the live pool cleared instead of assuming.
 */
export async function readmitGatewayAccounts(
  ids: readonly string[],
  opts: { port?: number; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ reachable: boolean; readmitted: string[]; healthyAccounts?: number; error?: string }> {
  const port = opts.port ?? gatewayPort();
  const doFetch = opts.fetchImpl ?? fetch;
  const readmitted: string[] = [];
  let healthyAccounts: number | undefined;
  for (const id of ids) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1200);
    try {
      const res = await doFetch(`http://127.0.0.1:${port}/admin/readmit?account=${encodeURIComponent(id)}`, {
        method: 'POST',
        signal: ctrl.signal,
      });
      if (!res.ok) return { reachable: false, readmitted, error: `gateway /admin/readmit ${res.status}` };
      const body = (await res.json()) as { readmitted?: string[]; healthyAccounts?: number };
      readmitted.push(...(body.readmitted ?? [id]));
      healthyAccounts = body.healthyAccounts;
    } catch (e) {
      return { reachable: false, readmitted, error: (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
  return { reachable: true, readmitted, healthyAccounts };
}

/** One local-backend row as the gateway's `GET /admin/local-backends` reports it: the durable
 *  registry record PLUS the two live in-process values the operator cannot see any other way
 *  (`inFlight` from the pool's counter map, `health` from its probe map). */
interface LocalBackendAdminRow {
  id?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  models?: unknown;
  maxConcurrent?: unknown;
  enabled?: unknown;
  inFlight?: unknown;
  health?: { healthy?: unknown } | null;
  engineCapacity?: LocalBackendEngineCapacity | null;
}

export interface LocalBackendsSnapshot {
  /** False when the gateway is down / the route 404s (deploy-skew) — the caller must treat this as
   *  UNKNOWN capacity and fail closed, never as "zero backends". */
  reachable: boolean;
  /** The gateway runs without a local-backend pool at all (`configured:false`) — a genuine, known
   *  zero, distinct from `reachable:false`. */
  configured: boolean;
  /** Live selection candidates, in exactly the shape `local-backend-pool`'s pure predicates take. */
  candidates: LocalBackendCandidate[];
  error?: string;
}

/**
 * Fetch the LIVE local-backend pool (registry + per-backend `inFlight` + health) over the same
 * localhost hop `/stats` uses. The pool's in-flight counters live in the GATEWAY process's memory
 * (`createLocalBackendPool`'s `inFlightCounts` Map), so `GET /admin/local-backends` is the ONLY way
 * another process can read real local capacity — the durable `local_backends` table carries
 * `maxConcurrent` but knows nothing about what is running right now.
 *
 * Never throws (mirrors fetchGatewayHeadroom): an unreachable gateway returns `reachable:false` so
 * a capacity reader fails CLOSED rather than mistaking silence for an idle pool.
 */
export async function fetchLocalBackends(
  opts: { port?: number; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<LocalBackendsSnapshot> {
  const port = opts.port ?? gatewayPort();
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1500);
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/admin/local-backends`, { signal: ctrl.signal });
    if (!res.ok) return { reachable: false, configured: false, candidates: [], error: `gateway /admin/local-backends ${res.status}` };
    const body = (await res.json()) as { configured?: unknown; backends?: unknown };
    const rows: LocalBackendAdminRow[] = Array.isArray(body.backends) ? (body.backends as LocalBackendAdminRow[]) : [];
    const candidates: LocalBackendCandidate[] = [];
    for (const r of rows) {
      const maxConcurrent = Number(r.maxConcurrent);
      if (typeof r.id !== 'string' || !Number.isFinite(maxConcurrent)) continue; // malformed row — not capacity
      candidates.push({
        backend: {
          id: r.id,
          kind: (typeof r.kind === 'string' ? r.kind : 'llama-server') as LocalBackend['kind'],
          baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : '',
          models: Array.isArray(r.models) ? (r.models.filter((m) => typeof m === 'string') as string[]) : [],
          maxConcurrent,
          enabled: r.enabled !== false,
        },
        inFlight: Number.isFinite(Number(r.inFlight)) ? Number(r.inFlight) : 0,
        // Mirrors the pool's OWN optimistic default (candidatesFor): never-probed ⇒ usable; only a
        // real probe/live failure demotes a backend. Diverging here would count capacity the
        // gateway's own selection refuses, or vice versa.
        healthy: r.health?.healthy !== false,
        engineCapacity:
          r.engineCapacity && typeof r.engineCapacity === 'object'
            ? {
                freeSlots: Number.isFinite(Number(r.engineCapacity.freeSlots)) ? Number(r.engineCapacity.freeSlots) : null,
                totalSlots: Number.isFinite(Number(r.engineCapacity.totalSlots)) ? Number(r.engineCapacity.totalSlots) : null,
                contextTokens: Number.isFinite(Number(r.engineCapacity.contextTokens)) ? Number(r.engineCapacity.contextTokens) : null,
                observedAtMs: Number(r.engineCapacity.observedAtMs),
                source: typeof r.engineCapacity.source === 'string' ? r.engineCapacity.source : undefined,
              }
            : null,
      });
    }
    return { reachable: true, configured: body.configured === true, candidates };
  } catch (e) {
    return { reachable: false, configured: false, candidates: [], error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the RAW gateway `/stats` payload for the wedge/throttle detector (B-GW-5). Unlike
 * `fetchGatewayHeadroom` (which projects the normalized admin read-model), this returns the raw
 * shape the `gateway-wedge` detector reads — typed loosely (`RawGatewayStats`) because the live
 * :8788 binary may predate the B-GW-1 AIMD fields (deploy-skew). Returns `null` (never throws) when
 * the gateway is unreachable so the health collector greys the panel rather than erroring the tab.
 */
export async function fetchGatewayStatsRaw(
  opts: { port?: number; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<RawGatewayStats | null> {
  const port = opts.port ?? gatewayPort();
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1500);
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/stats`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as RawGatewayStats;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
