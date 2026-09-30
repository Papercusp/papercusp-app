/**
 * Vitest LOAD-TEST RIG for the inference gateway (inference-gateway-stability-ownership P-001).
 *
 * The REGRESSION rig the bare-burst-429 fixes are measured against — a deterministic, in-process,
 * NO-real-spend twin of the live `load-test.ts` (which hits api.anthropic.com). It boots a REAL
 * gateway (real per-account governors, real admission queue, real AIMD + absorb) against a MOCK
 * upstream that enforces a per-account SUB-MINUTE BURST cap and returns a BARE-burst 429
 * (`x-should-retry:true`, NO `retry-after`, NO `anthropic-ratelimit-unified-*` headers) on overshoot —
 * the exact shape `classify429Shape` tags `'bare-burst'` and the gateway absorbs + retries.
 *
 * It reproduces the storm (P-001) and measures BOTH what the bee sees (final 503 / forwarded 429) AND
 * the upstream-429 count (the storm magnitude that bee-facing absorb hides). The dominant-mechanism
 * verdict (P-002) and the second-driver probe (P-004) import `runGatewayBurstRig` to vary one lever at
 * a time (smoothRpm on/off, burst cap, rotation-retry) and compare upstream429.
 *
 * Why the numbers are faithful: the gateway's per-account governors come from DEFAULT_FLOORS.anthropic
 * = { maxConcurrent: 3, rpm: 45 } — the SAME `rpm:45` that, under the per-minute COUNT gate alone,
 * lets 45 requests fire INSTANTLY at window start (the tumbling-window burst). smoothRpm floors the
 * pace at 60_000/45 ≈ 1333ms so the same allowance is spread evenly. The rig flips exactly that lever.
 *
 * TIMING (why a storm case takes ~15s): a bare-burst 429 penalizes the account for
 * `BARE_429_FAILOVER_BACKOFF_MS` = 15s (gov.penalize + pool.onExhausted) — so a sub-minute burst takes
 * the WHOLE account out of rotation for 15s, and when every account bursts the pool goes dark and held
 * requests wait that out (then succeed). That 15s is intrinsic real-timer production behaviour (it is
 * also why the SU-3650 absorb tests run 15s), not a rig artifact — and it is itself an amplifier the
 * smoothing fix avoids by never bursting. Storm cases therefore run ~15s; the smoothed (ON) case is
 * fast because it never trips the penalty. Keep storm-case timeouts generous on a loaded box.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ACCOUNT_HEADER, createInferenceGateway } from './gateway';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import type { ActiveAccount } from './provider-contracts';
import { createFailoverPool } from './account-failover';
import { aggregateCodexNonStreamResponse } from './codex-oauth-proxy';
import type {
  GatewayRequestOutcome,
  GatewayRequestTelemetrySnapshot,
  GatewayRequestTimeline,
  GatewayTelemetryProtocol,
} from './request-stage-telemetry';

export interface MockUpstreamOptions {
  /** Per-account SUB-MINUTE burst cap: how many requests may land within `burstWindowMs` before the
   *  upstream returns a bare-burst 429. This models Anthropic's sub-minute burst limit (distinct from
   *  the per-minute average). */
  burstCap: number;
  /** The sliding sub-minute window (ms) the burst cap is measured over. */
  burstWindowMs: number;
  /** OPTIONAL hard per-account 60s RPM ceiling (the per-minute average wall). Omit ⇒ only the burst gate
   *  fires, which is the bare-burst storm in isolation. */
  rpm?: number;
  /** Latency of a 200 (ms). Default 0 — keep the rig fast; raise to model TTFB. */
  latencyMs?: number;
}

export interface MockUpstream {
  fetchImpl: typeof fetch;
  /** Total bare-burst 429s emitted across all accounts (the storm magnitude at the upstream). */
  upstream429(): number;
  /** Per-account bare-burst 429 tally — the rotation/clustering signal (P-004). */
  perAccount429(): Record<string, number>;
  /** Total upstream calls received (200s + 429s) — the denominator. */
  total(): number;
}

async function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * A mock `api.anthropic.com` that enforces a per-account sliding-window BURST cap and returns a
 * BARE-burst 429 on overshoot. Keyed on the `Authorization` Bearer token so EACH pool account is
 * rate-limited INDEPENDENTLY (the real per-account / per-IP throttle — rotation across accounts is the
 * capacity lever the gateway exploits, and the storm is when rotation can't outrun the burst).
 */
export function mockBurstUpstream(opts: MockUpstreamOptions): MockUpstream {
  const hist = new Map<string, number[]>(); // token → accept timestamps (ms)
  const c429 = new Map<string, number>();
  let total = 0;
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    total += 1;
    const h = new Headers(init?.headers);
    const auth = h.get('authorization') ?? '';
    const tok = auth.replace(/^Bearer\s+/i, '').trim() || 'anon';
    const now = Date.now();
    const recent = (hist.get(tok) ?? []).filter((t) => now - t < 60_000);
    const inBurst = recent.filter((t) => now - t < opts.burstWindowMs).length;
    const overBurst = inBurst >= opts.burstCap;
    const overRpm = opts.rpm !== undefined && recent.length >= opts.rpm;
    if (overBurst || overRpm) {
      c429.set(tok, (c429.get(tok) ?? 0) + 1);
      // BARE-burst 429: x-should-retry:true, NO retry-after, NO unified util headers → classify429Shape
      // returns 'bare-burst' (a 429 with no window headers + x-should-retry). The body names a generic
      // rate_limit_error, NOT a usage/session cap, so it is never misread as a hard per-account wall.
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'bare burst (sub-minute)' } }),
        {
          status: 429,
          headers: { 'content-type': 'application/json', 'x-should-retry': 'true' },
        },
      );
    }
    recent.push(now);
    hist.set(tok, recent);
    await abortableDelay(opts.latencyMs ?? 0, init?.signal);
    return new Response(
      JSON.stringify({
        id: 'msg_rig',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    upstream429: () => [...c429.values()].reduce((a, b) => a + b, 0),
    perAccount429: () => Object.fromEntries(c429),
    total: () => total,
  };
}

export interface RigOptions {
  /** Pool size — distinct accounts (tokens). Default 4. */
  accounts?: number;
  /** Total requests fired at the gateway. Default 12. */
  n?: number;
  /** Gateway admission concurrency cap (the AIMD ceiling). Default = n (let the whole burst race). */
  concurrency?: number;
  /** The FIX under test: smooth each account's per-minute allowance into an even pace. Default false
   *  (reproduce the storm). */
  smoothRpm?: boolean;
  /** Mock per-account sub-minute burst cap. Default 2. */
  burstCap?: number;
  /** Mock sub-minute burst window (ms). Default 800. */
  burstWindowMs?: number;
  /** Mock per-account 60s RPM ceiling (omit ⇒ burst gate only). */
  rpm?: number;
  /** Gateway admission/absorb wait budget (ms). Must exceed the smoothing pace for the ON case to
   *  drain without bee-facing timeouts. Default 8000. */
  maxQueueWaitMs?: number;
  /** OPTIONAL client-side launch spacing (ms) between logical requests. Default 0 = the fleet-concurrency
   *  burst. Set this to spread the same per-minute volume without enabling gateway smoothing, which
   *  separates "static rpm floor too high" from "instantaneous tumbling-window burst" in P-002. */
  launchIntervalMs?: number;
  /** The gateway's transient-429 ABSORB budget (ms) — how long it holds + retries a bare-burst before
   *  giving up. The rig defaults this to 4000 (vs the 60s production default) so the OFF storm-repro
   *  drains/relents in a few seconds instead of sitting the full budget — keeps the vitest run fast and
   *  off the load-fragile real-timer cliff. Raise it to model a longer storm. */
  requestAbsorbMs?: number;
  /** Test-only override for the production 15s bare-429 penalty; lower values make second-driver
   *  amplification tests fast while preserving the same retry/rotation state transitions. */
  bare429FailoverBackoffMs?: number;
  /** Pin concurrency by setting the AIMD floor = cap, so the OFF↔ON comparison isolates the SMOOTHING
   *  variable (AIMD shrinking would otherwise also reduce the burst). Default true. Pass false to let
   *  AIMD adapt (e.g. to measure AIMD under-reaction for P-002). */
  pinConcurrency?: boolean;
  model?: string;
}

export interface RigResult {
  n: number;
  /** Bee saw a 200. */
  ok: number;
  /** Bee saw a forwarded upstream 429. */
  beeFacing429: number;
  /** Bee saw a gateway-final 503 (load-shed / absorb-exhausted). */
  beeFacing503: number;
  /** Any other non-200 (transport, etc.). */
  otherFail: number;
  /** Bare-burst 429s the UPSTREAM emitted — the storm magnitude (what bee-facing absorb hides). */
  upstream429: number;
  /** The gateway's own upstream-429 counter (gw.stats().upstream429) — cross-check on the mock tally. */
  gatewayUpstream429: number;
  /** Per-account upstream bare-burst 429s — rotation/clustering signal (P-004). */
  perAccount429: Record<string, number>;
  /** Cross-account failovers (rotations) the storm provoked — the fan-out denominator (P-004). */
  failovers: number;
  /** G1 (WI-649) bare-429 rotate-retries SUPPRESSED because ≥half the pool was out of rotation — the
   *  damping that stops a fleet-wide bare-burst from multiplying upstream load (P-004). */
  bareBurstRotateSuppressed: number;
  /** 429s shed at admission because the WHOLE pool was throttled (fail-fast, frees the slot). */
  shedAllThrottled: number;
  /** Fan-out ratio = upstream calls per LOGICAL request (upstream429+ok)/n ≈ how much one bee request
   *  multiplied into upstream load via rotation-retry. >1 ⇒ amplification. */
  upstreamCallsPerRequest: number;
  wallMs: number;
}

/**
 * Boot a gateway against the mock burst-upstream, fire `n` concurrent requests, and return the
 * bee-facing + upstream metrics. Closes the gateway before returning. The registry is a process
 * singleton, so the caller (the vitest harness) must `resetGovernorRegistry()` between runs to avoid
 * a prior run's learned rpmFactor / window leaking in.
 */
export async function runGatewayBurstRig(opts: RigOptions = {}): Promise<RigResult> {
  const accounts = opts.accounts ?? 4;
  const n = opts.n ?? 12;
  const concurrency = opts.concurrency ?? n;
  const smoothRpm = opts.smoothRpm ?? false;
  const pin = opts.pinConcurrency ?? true;

  const entries: ActiveAccount[] = Array.from({ length: accounts }, (_, i) => ({
    accountId: `rig-acct-${i}`,
    token: async () => `rig-tok-${i}`,
  }));
  const pool = createFailoverPool(entries);
  const upstream = mockBurstUpstream({
    burstCap: opts.burstCap ?? 2,
    burstWindowMs: opts.burstWindowMs ?? 800,
    ...(opts.rpm !== undefined ? { rpm: opts.rpm } : {}),
  });

  const gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl: upstream.fetchImpl,
    concurrency,
    smoothRpm,
    selfHeal: { enabled: false },
    maxQueueWaitMs: opts.maxQueueWaitMs ?? 8000,
    requestAbsorbMs: opts.requestAbsorbMs ?? 4000,
    ...(opts.bare429FailoverBackoffMs !== undefined ? { bare429FailoverBackoffMs: opts.bare429FailoverBackoffMs } : {}),
    ...(pin ? { aimd: { floor: concurrency } } : {}),
    log: () => {},
  });
  const port = await gw.listen(0);
  const model = opts.model ?? 'claude-opus-4';

  const fire = async (i: number): Promise<{ status: number }> => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 4, messages: [{ role: 'user', content: `ping ${i}` }] }),
      });
      await res.text();
      return { status: res.status };
    } catch {
      return { status: 0 };
    }
  };

  const t0 = Date.now();
  const launchIntervalMs = opts.launchIntervalMs ?? 0;
  const results = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      if (launchIntervalMs > 0) await new Promise((r) => setTimeout(r, i * launchIntervalMs));
      return fire(i);
    }),
  );
  const wallMs = Date.now() - t0;
  const stats = gw.stats();
  await gw.close();

  const ok = results.filter((r) => r.status === 200).length;
  const totalUpstreamCalls = upstream.total();
  return {
    n,
    ok,
    beeFacing429: results.filter((r) => r.status === 429).length,
    beeFacing503: results.filter((r) => r.status === 503).length,
    otherFail: results.filter((r) => r.status !== 200 && r.status !== 429 && r.status !== 503).length,
    upstream429: upstream.upstream429(),
    gatewayUpstream429: stats.upstream429,
    perAccount429: upstream.perAccount429(),
    failovers: stats.failovers,
    bareBurstRotateSuppressed: stats.bareBurstRotateSuppressed,
    shedAllThrottled: stats.shedAllThrottled,
    upstreamCallsPerRequest: Math.round((totalUpstreamCalls / n) * 100) / 100,
    wallMs,
  };
}

// ---------------------------------------------------------------------------
// P-006 — permanent matched-control latency/protocol certification battery.
// ---------------------------------------------------------------------------

export const GATEWAY_LATENCY_CERT_CONCURRENCIES = [1, 3, 5] as const;
export type GatewayLatencyCertConcurrency = (typeof GATEWAY_LATENCY_CERT_CONCURRENCIES)[number];
export type GatewayLatencyCertRoute = 'direct' | 'gateway';

export const GATEWAY_LATENCY_CERT_THRESHOLDS = {
  samplesPerRouteAndConcurrency: 30,
  stageCoverageMin: 0.999,
  gatewayOverheadP95Ms: { 1: 500, 3: 1_000, 5: 1_000 } as const,
  queueWaitP95Ms: 250,
  healthyAttemptsPerRequestMax: 1.05,
  failoverRequestRateMax: 0.01,
  gatewayAddedTtftP95Ms: 1_000,
} as const;

export interface GatewayLatencyCertSample {
  pairId: string;
  ownerId: string;
  route: GatewayLatencyCertRoute;
  concurrency: GatewayLatencyCertConcurrency;
  model: string;
  accountId: string;
  protocol: GatewayTelemetryProtocol;
  streaming: boolean;
  status: number | null;
  outcome: GatewayRequestOutcome;
  ttftMs: number;
  /** A bounded, secret-free response-shape signature used for non-stream protocol parity. */
  protocolSignature: string;
  cancelled: boolean;
  /** Gateway-only correlated stage timeline. Direct controls deliberately have none. */
  timeline?: GatewayRequestTimeline;
}

export interface GatewayLatencyRolloutEvidence {
  killSwitch: string;
  killSwitchRetained: boolean;
  fixedPathDefaultOn: boolean;
  isolatedOwnerCompletedAt: string;
  smallFleetCompletedAt: string;
  fixedPathDefaultedOnAt: string;
  /** Removing the fallback is a separate decision. It may remain in place during observation. */
  legacyFallbackRemoved: boolean;
  legacyFallbackDeprecationCriterionRef?: string;
}

export interface GatewayLatencyCertificationInput {
  samples: readonly GatewayLatencyCertSample[];
  telemetryByConcurrency: Partial<Record<GatewayLatencyCertConcurrency, GatewayRequestTelemetrySnapshot>>;
  queuedWithIdleViolations: number;
  rollout?: GatewayLatencyRolloutEvidence;
}

export interface GatewayLatencyCertificationGate {
  id: string;
  passed: boolean;
  actual: number | string | boolean;
  requirement: string;
}

export interface GatewayLatencyCertificationReport {
  gates: GatewayLatencyCertificationGate[];
  measurementVerdict: 'passed' | 'failed';
  rolloutVerdict: 'pending' | 'passed' | 'failed';
  shipReady: boolean;
  metrics: {
    samples: number;
    stageCoverage: number;
    unclassifiedOutcomes: number;
    healthyAttemptsPerRequest: number;
    failoverRequestRate: number;
    gatewayAddedTtftP95Ms: number | null;
    queuedWithIdleViolations: number;
  };
}

function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] ?? null;
}

function countOutcome(snapshot: GatewayRequestTelemetrySnapshot): number {
  return Object.values(snapshot.outcomes).reduce((sum, count) => sum + count, 0);
}

function parsedTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Evaluate one matched-control run. This is deliberately a pure counter/threshold function: a live
 * canary and the deterministic rig below feed the same evidence shape, and no LLM judges the result.
 */
export function certifyGatewayLatency(input: GatewayLatencyCertificationInput): GatewayLatencyCertificationReport {
  const standard = input.samples.filter((sample) => !sample.cancelled);
  const gateway = standard.filter((sample) => sample.route === 'gateway');
  const gates: GatewayLatencyCertificationGate[] = [];
  const add = (id: string, passed: boolean, actual: GatewayLatencyCertificationGate['actual'], requirement: string) => {
    gates.push({ id, passed, actual, requirement });
  };

  for (const concurrency of GATEWAY_LATENCY_CERT_CONCURRENCIES) {
    for (const route of ['direct', 'gateway'] as const) {
      const count = standard.filter((sample) => sample.concurrency === concurrency && sample.route === route).length;
      add(
        `samples-${route}-c${concurrency}`,
        count >= GATEWAY_LATENCY_CERT_THRESHOLDS.samplesPerRouteAndConcurrency,
        count,
        `>=${GATEWAY_LATENCY_CERT_THRESHOLDS.samplesPerRouteAndConcurrency}`,
      );
    }
  }

  const pairs = new Map<string, GatewayLatencyCertSample[]>();
  for (const sample of standard) {
    const key = `${sample.concurrency}:${sample.pairId}`;
    const found = pairs.get(key) ?? [];
    found.push(sample);
    pairs.set(key, found);
  }
  let matchedPairs = 0;
  let protocolParity = true;
  let identityParity = true;
  const ttftDeltas: number[] = [];
  for (const samples of pairs.values()) {
    const direct = samples.filter((sample) => sample.route === 'direct');
    const viaGateway = samples.filter((sample) => sample.route === 'gateway');
    if (direct.length !== 1 || viaGateway.length !== 1) {
      protocolParity = false;
      identityParity = false;
      continue;
    }
    matchedPairs++;
    const d = direct[0]!;
    const g = viaGateway[0]!;
    identityParity &&=
      d.model === g.model && d.accountId === g.accountId && d.protocol === g.protocol && d.ownerId === g.ownerId;
    protocolParity &&=
      !d.streaming &&
      !g.streaming &&
      d.status === g.status &&
      d.outcome === g.outcome &&
      d.protocolSignature === g.protocolSignature;
    ttftDeltas.push(g.ttftMs - d.ttftMs);
  }
  add(
    'matched-identity',
    identityParity && matchedPairs === standard.length / 2,
    matchedPairs,
    'one same-model/account/protocol direct+gateway pair per sample id',
  );
  add(
    'nonstream-protocol-parity',
    protocolParity && matchedPairs === standard.length / 2,
    protocolParity,
    'exact status/outcome/shape parity for every non-stream pair',
  );

  const cancellations = input.samples.filter((sample) => sample.cancelled);
  const cancellationGroups = new Map<string, GatewayLatencyCertSample[]>();
  for (const sample of cancellations) {
    const key = `${sample.concurrency}:${sample.pairId}`;
    const found = cancellationGroups.get(key) ?? [];
    found.push(sample);
    cancellationGroups.set(key, found);
  }
  const cancellationParity = GATEWAY_LATENCY_CERT_CONCURRENCIES.every((concurrency) => {
    const groups = [...cancellationGroups.entries()].filter(([key]) => key.startsWith(`${concurrency}:`));
    return (
      groups.length > 0 &&
      groups.every(([, samples]) => {
        const routes = new Set(samples.map((sample) => sample.route));
        return samples.length === 2 && routes.size === 2 && samples.every((sample) => sample.outcome === 'cancelled');
      })
    );
  });
  add(
    'cancellation-parity',
    cancellationParity,
    cancellationGroups.size,
    'at least one direct+gateway cancelled pair at c1/c3/c5',
  );

  const ownerCounts = Object.fromEntries(
    GATEWAY_LATENCY_CERT_CONCURRENCIES.map((concurrency) => [
      concurrency,
      new Set(gateway.filter((sample) => sample.concurrency === concurrency).map((sample) => sample.ownerId)).size,
    ]),
  ) as Record<GatewayLatencyCertConcurrency, number>;
  const ownerShapePassed = ownerCounts[1] === 1 && ownerCounts[3] >= 3 && ownerCounts[5] >= 5;
  add(
    'rollout-owner-shape',
    ownerShapePassed,
    `c1=${ownerCounts[1]},c3=${ownerCounts[3]},c5=${ownerCounts[5]}`,
    'one isolated owner at c1, then >=3 owners at c3 and >=5 owners at c5',
  );

  const snapshots = GATEWAY_LATENCY_CERT_CONCURRENCIES.map((concurrency) => input.telemetryByConcurrency[concurrency]);
  const finalized = snapshots.reduce((sum, snapshot) => sum + (snapshot?.requests.finalized ?? 0), 0);
  const missing = snapshots.reduce((sum, snapshot) => sum + (snapshot?.requests.missingStageTimelines ?? 0), 0);
  const stageCoverage = finalized > 0 ? (finalized - missing) / finalized : 0;
  add(
    'stage-coverage',
    stageCoverage >= GATEWAY_LATENCY_CERT_THRESHOLDS.stageCoverageMin,
    stageCoverage,
    `>=${GATEWAY_LATENCY_CERT_THRESHOLDS.stageCoverageMin}`,
  );
  const reconciled = snapshots.every((snapshot) =>
    Boolean(
      snapshot &&
      snapshot.requests.active === 0 &&
      snapshot.requests.reconciled &&
      snapshot.requests.outcomeReconciled &&
      snapshot.requests.finalized === countOutcome(snapshot),
    ),
  );
  add(
    'request-outcome-reconciliation',
    reconciled,
    reconciled,
    'all snapshots active=0 with exact request and outcome accounting',
  );
  const unclassifiedOutcomes = snapshots.reduce((sum, snapshot) => sum + (snapshot?.outcomes.unclassified ?? 0), 0);
  add('zero-unclassified-requests', unclassifiedOutcomes === 0, unclassifiedOutcomes, '=0');
  add('queued-with-idle', input.queuedWithIdleViolations === 0, input.queuedWithIdleViolations, '=0');

  for (const concurrency of GATEWAY_LATENCY_CERT_CONCURRENCIES) {
    const samples = gateway.filter((sample) => sample.concurrency === concurrency);
    const overhead = percentile(
      samples.flatMap((sample) => sample.timeline?.durationsMs.gatewayOverhead ?? []),
      0.95,
    );
    const overheadLimit = GATEWAY_LATENCY_CERT_THRESHOLDS.gatewayOverheadP95Ms[concurrency];
    add(
      `gateway-overhead-p95-c${concurrency}`,
      overhead !== null && overhead <= overheadLimit,
      overhead ?? 'missing',
      `<=${overheadLimit}ms`,
    );
    const queueWait = percentile(
      samples.flatMap((sample) => sample.timeline?.durationsMs.queueWait ?? []),
      0.95,
    );
    add(
      `queue-wait-p95-c${concurrency}`,
      queueWait !== null && queueWait <= GATEWAY_LATENCY_CERT_THRESHOLDS.queueWaitP95Ms,
      queueWait ?? 'missing',
      `<=${GATEWAY_LATENCY_CERT_THRESHOLDS.queueWaitP95Ms}ms while capacity exists`,
    );
  }

  const attempts = gateway.reduce((sum, sample) => sum + (sample.timeline?.attempts ?? 0), 0);
  const healthyAttemptsPerRequest = gateway.length ? attempts / gateway.length : Number.POSITIVE_INFINITY;
  const failoverRequests = gateway.filter((sample) => (sample.timeline?.failovers ?? 0) > 0).length;
  const failoverRequestRate = gateway.length ? failoverRequests / gateway.length : Number.POSITIVE_INFINITY;
  add(
    'healthy-attempts-per-request',
    healthyAttemptsPerRequest <= GATEWAY_LATENCY_CERT_THRESHOLDS.healthyAttemptsPerRequestMax,
    healthyAttemptsPerRequest,
    `<=${GATEWAY_LATENCY_CERT_THRESHOLDS.healthyAttemptsPerRequestMax}`,
  );
  add(
    'failover-request-rate',
    failoverRequestRate <= GATEWAY_LATENCY_CERT_THRESHOLDS.failoverRequestRateMax,
    failoverRequestRate,
    `<=${GATEWAY_LATENCY_CERT_THRESHOLDS.failoverRequestRateMax}`,
  );
  const gatewayAddedTtftP95Ms = percentile(ttftDeltas, 0.95);
  add(
    'gateway-added-ttft-p95',
    gatewayAddedTtftP95Ms !== null && gatewayAddedTtftP95Ms <= GATEWAY_LATENCY_CERT_THRESHOLDS.gatewayAddedTtftP95Ms,
    gatewayAddedTtftP95Ms ?? 'missing',
    `<=${GATEWAY_LATENCY_CERT_THRESHOLDS.gatewayAddedTtftP95Ms}ms`,
  );

  const measurementGateIds = new Set(gates.map((gate) => gate.id));
  const measurementVerdict = gates.every((gate) => gate.passed) ? 'passed' : 'failed';
  let rolloutVerdict: GatewayLatencyCertificationReport['rolloutVerdict'] = 'pending';
  if (input.rollout) {
    const isolatedAt = parsedTime(input.rollout.isolatedOwnerCompletedAt);
    const fleetAt = parsedTime(input.rollout.smallFleetCompletedAt);
    const defaultAt = parsedTime(input.rollout.fixedPathDefaultedOnAt);
    add(
      'rollout-order',
      Number.isFinite(isolatedAt) && isolatedAt <= fleetAt && fleetAt <= defaultAt,
      `${input.rollout.isolatedOwnerCompletedAt} -> ${input.rollout.smallFleetCompletedAt} -> ${input.rollout.fixedPathDefaultedOnAt}`,
      'isolated owner <= small fleet <= default-on',
    );
    add(
      'rollout-kill-switch',
      Boolean(input.rollout.killSwitch.trim()) && input.rollout.killSwitchRetained,
      input.rollout.killSwitch || 'missing',
      'named kill switch retained through observation',
    );
    add(
      'rollout-default-on',
      input.rollout.fixedPathDefaultOn,
      input.rollout.fixedPathDefaultOn,
      'corrected OAuth non-stream path is the default after the measurement gate passes',
    );
    const deprecationOk =
      !input.rollout.legacyFallbackRemoved || Boolean(input.rollout.legacyFallbackDeprecationCriterionRef?.trim());
    add(
      'legacy-fallback-deprecation',
      deprecationOk,
      input.rollout.legacyFallbackRemoved,
      'removal requires a separately recorded deprecation criterion',
    );
    rolloutVerdict = gates.filter((gate) => !measurementGateIds.has(gate.id)).every((gate) => gate.passed)
      ? 'passed'
      : 'failed';
  }

  return {
    gates,
    measurementVerdict,
    rolloutVerdict,
    shipReady: measurementVerdict === 'passed' && rolloutVerdict === 'passed',
    metrics: {
      samples: input.samples.length,
      stageCoverage,
      unclassifiedOutcomes,
      healthyAttemptsPerRequest,
      failoverRequestRate,
      gatewayAddedTtftP95Ms,
      queuedWithIdleViolations: input.queuedWithIdleViolations,
    },
  };
}

export interface GatewayLatencyCertRigOptions {
  samplesPerRouteAndConcurrency?: number;
  upstreamLatencyMs?: number;
  model?: string;
  rollout?: GatewayLatencyRolloutEvidence;
}

async function mapWithConcurrency<T>(
  count: number,
  concurrency: number,
  run: (index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(count);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (cursor < count) {
        const index = cursor++;
        results[index] = await run(index);
      }
    }),
  );
  return results;
}

function responseSignature(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      id?: unknown;
      type?: unknown;
      role?: unknown;
      content?: unknown;
      output?: unknown;
    };
    return JSON.stringify({
      id: parsed.id ?? null,
      type: parsed.type ?? null,
      role: parsed.role ?? null,
      content: parsed.content ?? null,
      output: parsed.output ?? null,
    });
  } catch {
    return body.slice(0, 256);
  }
}

async function waitForNoActiveRequests(gateway: ReturnType<typeof createInferenceGateway>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while ((gateway.stats().requestStages?.requests.active ?? 0) > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Verify the default-on and named fallback branches through the public gateway route. */
async function probeCodexNonStreamMode(model: string, mode: 'default' | 'fallback'): Promise<boolean> {
  const accountId = `latency-cert-${mode}-account`;
  const accessToken = `latency-cert-${mode}-token`;
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), `gateway-latency-cert-${mode}-`));
  await fs.writeFile(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: accessToken, refresh_token: null, account_id: accountId },
    }),
  );
  let oauthCalls = 0;
  let cliCalls = 0;
  const oauthFetch = (async () => {
    oauthCalls++;
    return new Response(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { id: `resp_latency_cert_${mode}`, object: 'response', model, output: [] },
      })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch;
  const cliAccounts = [{ accountId, home: codexHome }];
  const gw = createInferenceGateway({
    accountId: 'latency-cert-claude-control',
    token: async () => 'latency-cert-claude-token',
    codexCliAccounts: () => cliAccounts,
    codexCliPool: createFailoverPool([{ accountId, token: async () => '' }]),
    codexCliRun: async () => {
      cliCalls++;
      return { text: 'legacy fallback probe', inputTokens: 1, outputTokens: 1 };
    },
    codexOAuthProxy: true,
    ...(mode === 'fallback' ? { codexOAuthNonStream: false } : {}),
    fetchImpl: oauthFetch,
    concurrency: 1,
    aimd: { floor: 1 },
    selfHeal: { enabled: false },
    log: () => {},
  });
  try {
    const port = await gw.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-papercusp-owner': `latency-cert-${mode}-owner`,
        [ACCOUNT_HEADER]: accountId,
      },
      body: JSON.stringify({ model, input: `${mode} mode probe`, stream: false, store: false }),
    });
    await response.arrayBuffer();
    return (
      response.status === 200 &&
      (mode === 'default' ? oauthCalls === 1 && cliCalls === 0 : oauthCalls === 0 && cliCalls === 1)
    );
  } finally {
    await gw.close();
    await fs.rm(codexHome, { recursive: true, force: true });
  }
}

/**
 * Deterministic no-spend P-006 certification run. It exercises the corrected ChatGPT-subscription
 * OAuth non-stream path (the P-005 replacement for per-request `codex exec`) through the REAL gateway.
 * The direct control uses the same model, account credential, normalized request, mock ChatGPT backend,
 * and SSE-to-JSON aggregator. Operational canaries feed live samples into `certifyGatewayLatency`; this
 * runner keeps the exact acceptance logic permanently executable in CI without spending provider quota.
 */
export async function runGatewayLatencyCertRig(
  opts: GatewayLatencyCertRigOptions = {},
): Promise<GatewayLatencyCertificationReport> {
  const count = opts.samplesPerRouteAndConcurrency ?? GATEWAY_LATENCY_CERT_THRESHOLDS.samplesPerRouteAndConcurrency;
  const model = opts.model ?? 'gpt-5.5';
  const samples: GatewayLatencyCertSample[] = [];
  const telemetryByConcurrency: GatewayLatencyCertificationInput['telemetryByConcurrency'] = {};
  let queuedWithIdleViolations = 0;
  let isolatedOwnerCompletedAt = '';
  let smallFleetCompletedAt = '';

  for (const concurrency of GATEWAY_LATENCY_CERT_CONCURRENCIES) {
    const accountId = `latency-cert-account-c${concurrency}`;
    const accessToken = `latency-cert-token-c${concurrency}`;
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), `gateway-latency-cert-c${concurrency}-`));
    await fs.writeFile(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: accessToken, refresh_token: null, account_id: accountId },
      }),
    );
    const cliAccounts = [{ accountId, home: codexHome }];
    const oauthFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.get('authorization') !== `Bearer ${accessToken}` || headers.get('chatgpt-account-id') !== accountId) {
        return new Response(JSON.stringify({ error: { message: 'wrong certification account' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      await abortableDelay(opts.upstreamLatencyMs ?? 5, init?.signal);
      const completed = {
        id: `resp_latency_cert_c${concurrency}`,
        object: 'response',
        model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      };
      return new Response(
        `data: ${JSON.stringify({ type: 'response.created', response: { id: completed.id } })}\n\n` +
          `data: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n` +
          'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch;
    const gw = createInferenceGateway({
      accountId: 'latency-cert-claude-control',
      token: async () => 'latency-cert-claude-token',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool([{ accountId, token: async () => '' }]),
      codexCliRun: async () => {
        throw new Error('P-006 OAuth certification unexpectedly selected the legacy CLI fallback');
      },
      codexOAuthProxy: true,
      codexOAuthNonStream: true,
      fetchImpl: oauthFetch,
      concurrency,
      aimd: { floor: concurrency },
      maxQueueWaitMs: 2_000,
      requestAbsorbMs: 0,
      selfHeal: { enabled: false },
      log: () => {},
    });
    const port = await gw.listen(0);
    const gatewayBody = JSON.stringify({
      model,
      input: 'latency certification ping',
      stream: false,
      store: false,
    });
    const directBody = JSON.stringify({
      model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'latency certification ping' }] }],
      stream: true,
      store: false,
    });

    const fire = async (
      route: GatewayLatencyCertRoute,
      index: number,
      cancelled = false,
    ): Promise<GatewayLatencyCertSample> => {
      const pairId = cancelled ? `latency-cert-c${concurrency}-cancel` : `latency-cert-c${concurrency}-${index}`;
      const ownerId = cancelled
        ? `latency-cert-c${concurrency}-cancel-owner`
        : concurrency === 1
          ? 'latency-cert-isolated-owner'
          : `latency-cert-fleet-owner-${index % concurrency}`;
      const controller = new AbortController();
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      if (cancelled) abortTimer = setTimeout(() => controller.abort(), 1);
      const started = performance.now();
      try {
        const response =
          route === 'direct'
            ? await oauthFetch('https://chatgpt.invalid/backend-api/codex/responses', {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: `Bearer ${accessToken}`,
                  'chatgpt-account-id': accountId,
                },
                body: directBody,
                signal: controller.signal,
              })
            : await fetch(`http://127.0.0.1:${port}/v1/responses`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'x-papercusp-owner': ownerId,
                  [ACCOUNT_HEADER]: accountId,
                },
                body: gatewayBody,
                signal: controller.signal,
              });
        const ttftMs = performance.now() - started;
        let responseBody: string;
        if (route === 'direct' && response.ok) {
          if (!response.body) throw new Error('direct OAuth control returned no response body');
          const aggregated = await aggregateCodexNonStreamResponse(
            response.body as unknown as AsyncIterable<Uint8Array>,
            {
              contentType: response.headers.get('content-type'),
              maxBytes: 1_000_000,
              timeoutMs: 2_000,
              signal: controller.signal,
            },
          );
          responseBody = aggregated.toString('utf8');
        } else {
          responseBody = await response.text();
        }
        return {
          pairId,
          ownerId,
          route,
          concurrency,
          model,
          accountId,
          protocol: 'openai-responses',
          streaming: false,
          status: response.status,
          outcome: response.ok ? 'ok' : response.status === 429 ? 'upstream-429' : 'upstream-error',
          ttftMs,
          protocolSignature: responseSignature(responseBody),
          cancelled: false,
        };
      } catch {
        return {
          pairId,
          ownerId,
          route,
          concurrency,
          model,
          accountId,
          protocol: 'openai-responses',
          streaming: false,
          status: null,
          outcome: controller.signal.aborted ? 'cancelled' : 'gateway-error',
          ttftMs: performance.now() - started,
          protocolSignature: controller.signal.aborted ? 'cancelled' : 'error',
          cancelled: controller.signal.aborted,
        };
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
      }
    };

    try {
      const direct = await mapWithConcurrency(count, concurrency, (index) => fire('direct', index));
      const monitor = managedSetInterval(
        'inference-gateway-latency-cert-queue-sampler',
        1,
        () => {
          const stats = gw.stats();
          const admission = stats.codexAdmission ?? stats.admission;
          if (admission.queued > 0 && admission.running < admission.maxConcurrent) queuedWithIdleViolations++;
        },
        { category: 'external-process', classification: 'must-sample', allowInTest: true, instanced: true },
      );
      let viaGateway: GatewayLatencyCertSample[];
      try {
        viaGateway = await mapWithConcurrency(count, concurrency, (index) => fire('gateway', index));
      } finally {
        monitor.stop();
      }
      const cancelled = await Promise.all([fire('direct', count, true), fire('gateway', count, true)]);
      await waitForNoActiveRequests(gw);
      const snapshot = gw.stats().requestStages;
      if (!snapshot)
        throw new Error(`latency certification c${concurrency}: gateway emitted no request-stage telemetry`);
      telemetryByConcurrency[concurrency] = snapshot;
      const standardTimelines = snapshot.recent.filter((timeline) => timeline.outcome !== 'cancelled');
      for (const [index, sample] of viaGateway.entries()) sample.timeline = standardTimelines[index];
      for (const sample of cancelled.filter((candidate) => candidate.route === 'gateway')) {
        sample.timeline = snapshot.recent.find((timeline) => timeline.ownerId === sample.ownerId);
      }
      samples.push(...direct, ...viaGateway, ...cancelled);
      if (concurrency === 1) isolatedOwnerCompletedAt = new Date().toISOString();
      if (concurrency === 5) smallFleetCompletedAt = new Date().toISOString();
    } finally {
      await gw.close();
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  }

  const input = { samples, telemetryByConcurrency, queuedWithIdleViolations };
  if (opts.rollout) return certifyGatewayLatency({ ...input, rollout: opts.rollout });

  const measurement = certifyGatewayLatency(input);
  if (measurement.measurementVerdict === 'failed') return measurement;

  const killSwitchRetained = await probeCodexNonStreamMode(model, 'fallback').catch(() => false);
  const fixedPathDefaultOn = await probeCodexNonStreamMode(model, 'default').catch(() => false);
  const rollout: GatewayLatencyRolloutEvidence = {
    killSwitch: 'PAPERCUSP_GATEWAY_CODEX_OAUTH_NONSTREAM=0',
    killSwitchRetained,
    fixedPathDefaultOn,
    isolatedOwnerCompletedAt,
    smallFleetCompletedAt,
    fixedPathDefaultedOnAt: new Date().toISOString(),
    legacyFallbackRemoved: false,
  };
  return certifyGatewayLatency({ ...input, rollout });
}
