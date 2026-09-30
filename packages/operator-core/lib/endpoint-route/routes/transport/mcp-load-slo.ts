/**
 * P-011 load-test regression GATE (mcp-reliability-hardening-2026-07-11).
 *
 * The PURE decision core for the `/api/mcp` concurrency SLO gate. The live
 * driver (mcp-load-slo.integration.test.ts) fires N concurrent agents through
 * the real HTTP MCP transport, collects one {@link McpLoadSample} per request,
 * and hands the batch here to compute the p95 latency + failure/shed rates and
 * decide PASS / FAIL against env-tunable budgets.
 *
 * Extracted from the driver so the SLO math + verdict is UNIT-tested
 * (mcp-load-slo.test.ts, always in CI, no live operator needed) — the same
 * split P-010 used for mcp-admission.ts. The integration test only measures;
 * this module decides, and its decision logic is green-gated regardless of
 * whether a server was reachable.
 *
 * ── Why THREE outcome classes (this is the crux of the gate) ──────────────
 *   • `ok`   — HTTP 2xx carrying a non-error JSON-RPC envelope. The request was
 *              served. Only these count toward the p95 latency budget.
 *   • `shed` — HTTP 429. This is P-010 admission control shedding a `tools/call`
 *              under CRITICAL event-loop pressure. It is NOT a failure: the tool
 *              never ran (no side effect ⇒ write-safe), the P-005 proxy
 *              absorbs+retries it, and the agent just waits a beat. Graceful
 *              backpressure is the DESIGNED behavior under overload, so a shed
 *              must not fail the gate — but we surface `shedRate` so a spike
 *              (drove past the admission ceiling) stays visible, and a NEAR-TOTAL
 *              shed (maxShedRate) is a breach because then we served ~nothing.
 *   • `fail` — everything else: a 5xx, a transport error/timeout, or a JSON-RPC
 *              error envelope. THIS is what the gate guards against — the hard
 *              failures under concurrency that this whole plan set out to kill
 *              ("transient tool errors are normal" is the thing we refuse to accept).
 */

export type McpLoadOutcome = 'ok' | 'shed' | 'fail';

export interface McpLoadSample {
  outcome: McpLoadOutcome;
  /** Wall-clock ms for the request. Meaningful for every class; only `ok` samples feed p95. */
  latencyMs: number;
}

export interface McpLoadBudgets {
  /** p95 latency budget (ms) over OK requests. Breach ⇒ FAIL. */
  p95Ms: number;
  /** Max hard-FAILURE rate (0..1). Breach ⇒ FAIL. This is the primary guard. */
  maxFailRate: number;
  /** Max SHED rate (0..1). A high shed rate is usually informational (we simply
   *  drove past the admission ceiling on a busy box), but a near-total shed means
   *  the server served almost none of our representative reads — treat that as a
   *  breach so "everything 429'd" can't masquerade as a pass. */
  maxShedRate: number;
}

/** Parse a positive-int env var with a floor; fall back to `def` when unset/garbage. */
export function intEnv(name: string, def: number, min = 1): number {
  const raw = process.env[name];
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.trunc(n)) : def;
}

/** Parse a 0..1 (clamped) float env var; fall back to `def` when unset/garbage. */
export function rateEnv(name: string, def: number): number {
  const raw = process.env[name];
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : def;
}

/**
 * The gate's budgets, read from env so a CI job / operator can retune the SLO
 * without a code change (the perf-regression-rig pattern):
 *   PAPERCUSP_MCP_LOAD_P95_MS         (default 3000)  — p95 latency ceiling
 *   PAPERCUSP_MCP_LOAD_MAX_FAIL_RATE  (default 0.02)  — hard-failure ceiling (2%)
 *   PAPERCUSP_MCP_LOAD_MAX_SHED_RATE  (default 0.80)  — near-total-shed ceiling (80%)
 * The defaults are deliberately GENEROUS: this gate drives a real, concurrently
 * loaded operator (often a dev/staging box already carrying a live fleet), so the
 * ceiling guards against a genuine regression, not a p50 target. Tighten via env
 * on a dedicated load host.
 */
export function loadBudgetsFromEnv(): McpLoadBudgets {
  return {
    p95Ms: intEnv('PAPERCUSP_MCP_LOAD_P95_MS', 3000, 1),
    maxFailRate: rateEnv('PAPERCUSP_MCP_LOAD_MAX_FAIL_RATE', 0.02),
    maxShedRate: rateEnv('PAPERCUSP_MCP_LOAD_MAX_SHED_RATE', 0.8),
  };
}

/**
 * Nearest-rank percentile over an ASCENDING-sorted numeric array. Deterministic
 * and small-N-friendly (no interpolation surprises): rank = ceil(p/100 · N),
 * clamped to [1, N]; returns the value at that 1-based rank. Empty ⇒ 0.
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.min(n, Math.max(1, Math.ceil((p / 100) * n)));
  return sortedAsc[rank - 1];
}

/**
 * Classify one request from its HTTP status and whether the JSON-RPC envelope
 * carried an error. 429 ⇒ shed (admission backpressure); a clean 2xx with no RPC
 * error ⇒ ok; anything else (5xx, non-2xx, or an error envelope) ⇒ fail. A thrown
 * transport error / timeout is classified `fail` by the caller (it never gets a
 * status). PURE.
 */
export function classifyHttpOutcome(status: number, rpcError: boolean): McpLoadOutcome {
  if (status === 429) return 'shed';
  if (status >= 200 && status < 300 && !rpcError) return 'ok';
  return 'fail';
}

export interface McpLoadReport {
  total: number;
  ok: number;
  shed: number;
  fail: number;
  failRate: number;
  shedRate: number;
  /** p95 over OK-request latencies (ms); 0 when there were no OK samples. */
  p95Ms: number;
  /** Median (p50) over OK-request latencies (ms) — surfaced for the summary line. */
  p50Ms: number;
  /** Slowest OK-request latency (ms). */
  maxOkMs: number;
  breaches: string[];
  passed: boolean;
}

/**
 * The verdict. Computes the counts/rates/percentiles and lists every breached
 * budget; `passed` is true iff there are none. A p95 breach is only asserted when
 * there IS at least one OK sample to measure — you cannot regress a latency you
 * never observed; that "we served nothing" case is already caught by the fail /
 * shed rate breaches. PURE — no env, no clock, no I/O.
 */
export function evaluateMcpLoad(
  samples: readonly McpLoadSample[],
  budgets: McpLoadBudgets,
): McpLoadReport {
  const total = samples.length;
  let ok = 0;
  let shed = 0;
  let fail = 0;
  const okLatencies: number[] = [];
  for (const s of samples) {
    if (s.outcome === 'ok') {
      ok++;
      okLatencies.push(s.latencyMs);
    } else if (s.outcome === 'shed') {
      shed++;
    } else {
      fail++;
    }
  }
  okLatencies.sort((a, b) => a - b);
  const failRate = total === 0 ? 1 : fail / total;
  const shedRate = total === 0 ? 0 : shed / total;
  const p95Ms = percentile(okLatencies, 95);
  const p50Ms = percentile(okLatencies, 50);
  const maxOkMs = okLatencies.length ? okLatencies[okLatencies.length - 1] : 0;

  const breaches: string[] = [];
  if (total === 0) {
    breaches.push('no-requests: the driver collected zero samples');
  }
  if (failRate > budgets.maxFailRate) {
    breaches.push(
      `fail-rate ${(failRate * 100).toFixed(1)}% > ${(budgets.maxFailRate * 100).toFixed(1)}% (${fail}/${total} hard failures)`,
    );
  }
  if (okLatencies.length > 0 && p95Ms > budgets.p95Ms) {
    breaches.push(`p95 ${Math.round(p95Ms)}ms > ${budgets.p95Ms}ms budget (over ${ok} ok requests)`);
  }
  if (shedRate > budgets.maxShedRate) {
    breaches.push(
      `shed-rate ${(shedRate * 100).toFixed(1)}% > ${(budgets.maxShedRate * 100).toFixed(1)}% (${shed}/${total} shed — served almost nothing)`,
    );
  }

  return {
    total,
    ok,
    shed,
    fail,
    failRate,
    shedRate,
    p95Ms,
    p50Ms,
    maxOkMs,
    breaches,
    passed: breaches.length === 0,
  };
}

/** One-line human summary for the test log / runbook paste. */
export function formatMcpLoadReport(r: McpLoadReport, budgets: McpLoadBudgets): string {
  const verdict = r.passed ? 'PASS' : 'FAIL';
  return (
    `[mcp-load-slo] ${verdict} — ${r.total} reqs: ${r.ok} ok / ${r.shed} shed / ${r.fail} fail | ` +
    `p50=${Math.round(r.p50Ms)}ms p95=${Math.round(r.p95Ms)}ms max=${Math.round(r.maxOkMs)}ms ` +
    `(budget p95≤${budgets.p95Ms}ms, fail≤${(budgets.maxFailRate * 100).toFixed(1)}%)` +
    (r.breaches.length ? ` | breaches: ${r.breaches.join('; ')}` : '')
  );
}
