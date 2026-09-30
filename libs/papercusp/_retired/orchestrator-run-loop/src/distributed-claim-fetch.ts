/**
 * distributed-claim-fetch — Model B Stage-5 (orchestrator side).
 *
 * The orchestrator runs as a subprocess of the operator; substrate
 * handles live in the operator's hono-host (port 3070 by default).
 * Before dispatching a worker, the orchestrator POSTs to
 * /api/harness/:slug/claim-feature to record an LWW ADVISORY claim
 * (D-002 — no merge-order arbitration; appending always succeeds).
 *
 * Observability-first: this module ONLY fetches + returns the result.
 * The caller (main-loop.handleNextWorker) dispatches on `claimed`.
 * `claimed: false` means a human flipped the feature to working
 * (`reason: 'manually-active'`); contention with another peer's later
 * claim is NOT reported here — it surfaces via the clobber toast + the
 * orchestrator backoff downstream.
 *
 * Pure: fetchFn + envGet injected so this module is unit-testable.
 */

export interface FetchClaimOpts {
  /** Operator base, e.g. http://localhost:3070 (note: hono-host port, not the SPA :3055). */
  operatorBase: string;
  harnessSlug: string;
  featureId: string;
  githubUserId: number;
  /** Injected fetch; runtime passes globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** Timeout for the request in ms. Default 3000 (well under the 300ms latency budget in §0.6 P-037c when local; 3s safety bound for cross-network). */
  timeoutMs?: number;
}

export interface ClaimFetchResult {
  /** 'attempted' | 'single-writer-fallback' | 'substrate-not-booted' | 'pubkey-unresolved' | 'manually-active' | 'fetch-failed'. */
  reason: string;
  /**
   * Did the advisory claim get recorded (so the orchestrator should
   * dispatch)? True on a recorded claim OR a single-writer/fetch fallback;
   * false only when blocked (`manually-active`).
   */
  claimed: boolean;
  strategy?: 'distributed' | 'single-writer';
  my_pubkey?: string;
  audit_outcome?: 'won' | 'lost' | 'timeout' | 'error';
  /** Wall-clock ms the round-trip took. Logged for the P-037c latency budget. */
  latencyMs: number;
  /** Error message when reason === 'fetch-failed'. */
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 3_000;

export async function fetchDistributedClaim(
  opts: FetchClaimOpts,
): Promise<ClaimFetchResult> {
  const url = `${opts.operatorBase}/api/harness/${encodeURIComponent(opts.harnessSlug)}/claim-feature`;
  const fetchImpl = opts.fetchFn ?? fetch;
  const start = Date.now();
  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = setTimeout(
    () => controller?.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feature_id: opts.featureId,
        github_user_id: opts.githubUserId,
      }),
      signal: controller?.signal,
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return {
        reason: 'fetch-failed',
        claimed: true, // proceed by default — operator route doesn't know us
        latencyMs,
        error: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      reason: typeof body.reason === 'string' ? body.reason : 'attempted',
      claimed: body.claimed !== false, // default to true on missing field — safer
      strategy: body.strategy as 'distributed' | 'single-writer' | undefined,
      my_pubkey: body.my_pubkey as string | undefined,
      audit_outcome: body.audit_outcome as ClaimFetchResult['audit_outcome'],
      latencyMs,
    };
  } catch (e: unknown) {
    const latencyMs = Date.now() - start;
    const msg = e instanceof Error ? e.message : String(e);
    return {
      reason: 'fetch-failed',
      claimed: true, // network failure = legacy single-writer path
      latencyMs,
      error: msg.slice(0, 200),
    };
  } finally {
    clearTimeout(timeout);
  }
}
