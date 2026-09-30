# MCP load-test regression gate — /api/mcp p95 + success-rate SLO
URL: /internal/docs/testing/mcp-load-slo-gate

How the concurrent-load regression gate for /api/mcp works, how to run it against a live operator, how to tune the SLO budgets, and how to read a breach. The end-to-end gate for the mcp-reliability-hardening plan (P-011).


The **MCP load-test regression gate** drives N concurrent agents through the real
`/api/mcp` HTTP transport and asserts a **p95-latency + success-rate SLO**. It is
the end-to-end regression gate for `mcp-reliability-hardening-2026-07-11` (P-011):
P-001…P-010 made the transport resilient (pg-restart detection, a resilient proxy,
result-replay idempotency, event-loop admission control); this gate pins that it
**stays** resilient under concurrent, fleet-shaped load.

## The two files (and why the split)

| File | Layer | Runs in CI? | Purpose |
|---|---|---|---|
| `packages/operator-core/lib/endpoint-route/routes/transport/mcp-load-slo.ts` | pure | — | The SLO math + PASS/FAIL verdict. No I/O, no clock, no env at call time. |
| `…/mcp-load-slo.test.ts` | unit | **always** | Unit-gates the verdict logic (percentile, outcome classification, budget breaches). |
| `…/mcp-load-slo.integration.test.ts` | integration | **only when an operator is reachable** | The live driver: fires the concurrent load, measures each request, evaluates. |

The verdict logic lives in the pure module so it is **green-gated in CI on every
run** — no live server needed. The integration test only *measures*; it **skips
cleanly when no operator is reachable** (same pattern as
`su-locks-http-mcp.integration.test.ts`). A load gate must never red CI for a
missing server — it runs as a real gate wherever `:3070` / `:3170` /
`OPERATOR_BASE_URL` is up, which is what a release check or a dedicated load host
runs.

## The SLO — three outcome classes

Every request is classified into exactly one bucket, and this classification is
the crux of the gate:

- **`ok`** — HTTP 2xx with a non-error JSON-RPC envelope. Only these feed the p95.
- **`shed`** — HTTP 429. This is **P-010 admission control** shedding a
  `tools/call` under CRITICAL event-loop pressure. It is **not a failure**: the
  tool never ran (no side effect ⇒ write-safe), the P-005 resilient proxy
  absorbs + retries it, and the agent just waits a beat. Graceful backpressure is
  the *designed* behavior under overload, so a shed never fails the gate — but a
  **near-total** shed does (we served ~nothing), and `shedRate` is always surfaced.
- **`fail`** — everything else: a 5xx, a transport error/timeout, or a JSON-RPC
  error envelope. **This is what the gate guards against** — the hard failures
  under concurrency that the whole plan set out to kill.

The gate PASSES iff there are **no breaches**:

| Breach | Condition | What it points at |
|---|---|---|
| `fail-rate` | hard-failure rate > `maxFailRate` (default 2%) | A real regression: the transport is dropping/erroring requests under load. Start at the event-loop-lag gauge (see the saturation insight) and the operator logs. |
| `p95` | p95 over ok requests > `p95Ms` (default 3000ms) | Latency regression under concurrency. Could be genuine main-thread saturation (profile it — see P-009 `analyze-loop-profiles.mjs`) or a busy host. |
| `shed-rate` | shed rate > `maxShedRate` (default 80%) | The operator shed almost everything — critically saturated the whole run. Either the box is genuinely overloaded, or admission control is too aggressive. |
| `no-requests` | zero samples collected | The driver never issued load — a harness bug, never a vacuous pass. |

A p95 breach is only asserted when there is at least one `ok` sample to measure —
you cannot regress a latency you never observed; the "served nothing" case is
already caught by the fail/shed guards.

## Running it

Against the default local operator (`:3070`):

```bash
node node_modules/vitest/vitest.mjs run \
  --config packages/operator-core/vitest.integration.config.ts \
  packages/operator-core/lib/endpoint-route/routes/transport/mcp-load-slo.integration.test.ts
```

Against the staging operator (`:3170`) or any host:

```bash
OPERATOR_BASE_URL=http://localhost:3170 node node_modules/vitest/vitest.mjs run \
  --config packages/operator-core/vitest.integration.config.ts \
  packages/operator-core/lib/endpoint-route/routes/transport/mcp-load-slo.integration.test.ts
```

It reads the superuser bearer from `~/.papercusp/superuser-token` and calls
`/api/mcp?superuser=1&all_workspaces=1` (the `all_workspaces=1` opts out of the
scoped-superuser-workspace clamp, since the per-worker client ids are throwaway
owners with no registered workspace). A healthy operator prints, e.g.:

```
[mcp-load-slo] PASS — 240 reqs: 240 ok / 0 shed / 0 fail | p50=14ms p95=47ms max=73ms (budget p95≤3000ms, fail≤2.0%)
```

If no operator is reachable, the single test **skips** (green, not failed).

## Tuning (all env, all optional)

| Env var | Default | Meaning |
|---|---|---|
| `PAPERCUSP_MCP_LOAD_CONCURRENCY` | 24 | Concurrent workers (≈ simultaneous agents). |
| `PAPERCUSP_MCP_LOAD_REQUESTS` | 240 | Total requests across the run. |
| `PAPERCUSP_MCP_LOAD_REQ_TIMEOUT_MS` | 15000 | Per-request timeout (a timeout ⇒ `fail`). |
| `PAPERCUSP_MCP_LOAD_TOOL` | `locks:queue` | The representative read to hammer (side-effect-free). |
| `PAPERCUSP_MCP_LOAD_P95_MS` | 3000 | p95 latency budget (ms). |
| `PAPERCUSP_MCP_LOAD_MAX_FAIL_RATE` | 0.02 | Hard-failure ceiling (0..1). |
| `PAPERCUSP_MCP_LOAD_MAX_SHED_RATE` | 0.80 | Near-total-shed ceiling (0..1). |
| `PAPERCUSP_MCP_LOAD_TEST_TIMEOUT_MS` | derived | Whole-test ceiling; defaults from waves × per-request timeout + 30s. |

The default budgets are deliberately **generous** — the gate usually drives a real
box already carrying a live fleet, so the ceiling guards against a genuine
*regression*, not a p50 target. To use it as a tight SLO, run it on a **dedicated,
otherwise-idle load host** and tighten `PAPERCUSP_MCP_LOAD_P95_MS` /
`PAPERCUSP_MCP_LOAD_MAX_FAIL_RATE` there:

```bash
PAPERCUSP_MCP_LOAD_CONCURRENCY=64 PAPERCUSP_MCP_LOAD_REQUESTS=2000 \
PAPERCUSP_MCP_LOAD_P95_MS=800 PAPERCUSP_MCP_LOAD_MAX_FAIL_RATE=0.005 \
node node_modules/vitest/vitest.mjs run --config packages/operator-core/vitest.integration.config.ts \
  packages/operator-core/lib/endpoint-route/routes/transport/mcp-load-slo.integration.test.ts
```

## Related

- **Admission control (P-010):** `…/transport/mcp-admission.ts` — the 429 shedder
  this gate exercises. Kill-switch: `PAPERCUSP_MCP_ADMISSION_CONTROL=0`.
- **Resilient MCP proxy (P-005):** `apps/operator/lib/mcp-proxy/proxy.ts` — absorbs
  the 429 (drain → wait Retry-After → retry). Kill-switch:
  `PAPERCUSP_MCP_PROXY_ABSORB_429=0`.
- **Internal metric SLOs:** `packages/operator-core/lib/system-health/perf-regression-rig.ts`
  (`evaluatePerfRegression`, loop-lag-p95 budgets) — the *internal* watchdog SLO,
  complementary to this *end-to-end request* SLO.
- **Diagnosing a p95 breach:** the `agent-mcp-slow-but-health-fast` saturation
  insight (read the event-loop-lag gauge first) and P-009's
  `scripts/analyze-loop-profiles.mjs` (attributes on-loop CPU to its app caller).
