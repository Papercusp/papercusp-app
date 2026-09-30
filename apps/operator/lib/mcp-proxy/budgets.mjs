/**
 * The ONE definition of the mcp-proxy timing budgets — WI-6738.
 *
 * WHY THIS FILE EXISTS
 *
 * `papercup-mcp-proxy.service` exists so that "a :3070 deploy restart is invisible to MCP
 * clients" (mcp-host-availability-resilience-2026-06-22 P-005). It delivers that by
 * retrying a refused upstream for up to `retryWindowMs`. But the CLIENT it protects — psu —
 * independently chose a 45s request timeout, i.e. it gave up in HALF the time the front
 * door was still willing to wait. So the resilience layer worked exactly as designed and
 * the user still saw a hard failure:
 *
 *     psu: /api/agent-mcp/console/bootstrap-su/options timed out after 45000ms
 *
 * That is the 2026-08-01 report ("the system is down" — it was not; it self-recovered ~90s
 * later). ANY :3070 gap between 45s and 90s was a guaranteed user-visible failure that the
 * proxy would otherwise have absorbed completely.
 *
 * The bug was not either number. It was that they were chosen INDEPENDENTLY, in different
 * files, with no expressed relationship — and so could drift apart silently. Worse, the 90s
 * budget was itself written out three separate times (bin/mcp-proxy.ts, and twice in
 * bin/host-bootstrap.ts, once as the string '90000' handed to a spawned child), so "change
 * the retry window" was a four-file edit nobody would get right.
 *
 * THE INVARIANT, stated once, here:
 *
 *     a client's request timeout MUST be >= the proxy's retry window,
 *     or the proxy's patience is unreachable and its whole purpose is defeated.
 *
 * `budgets.test.ts` asserts it, so the inversion cannot silently return.
 *
 * PLAIN .mjs ON PURPOSE: psu-launcher.mjs runs under bare `node` (it is exec'd straight from
 * the release checkout, unbundled) so it cannot import TypeScript; bin/mcp-proxy.ts and
 * bin/host-bootstrap.ts run under `tsx` and import this happily. `.mjs` + `budgets.d.mts` is
 * the only shape both can share. Do not "promote" this to .ts — that silently un-shares it
 * from psu, which is the exact bug this file fixes.
 */

/** Env override, when it parses to a positive finite number; otherwise null. */
function envMs(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * How long the proxy keeps retrying a refused upstream (a :3070 restart) before giving up.
 * Observed real recoveries on 2026-08-01: ~30 attempts spanning 20.5s … 92.0s.
 */
export const MCP_PROXY_RETRY_WINDOW_MS = envMs('PAPERCUSP_MCP_PROXY_RETRY_MS') ?? 90_000;

/**
 * The one path the proxy answers ITSELF, before any upstream forwarding.
 *
 * It lives here — in the module BOTH the proxy and its watchdog already import — so the two
 * cannot drift apart. That is the whole point: while the retry window above is holding a real
 * request through a :3070 restart, this is the ONLY path that can still answer, so it is the
 * only sound liveness probe for the proxy's event loop. The watchdog used to poll `/api/health`
 * instead, which the proxy forwards, so every deploy looked like a proxy outage — 272 false
 * `unreachable` incidents, and a genuine wedge rendered indistinguishable from them (WI-6743).
 */
export const MCP_PROXY_LOCAL_HEALTH_PATH = '/__mcp_proxy_health';

/**
 * Margin added on top of the proxy's window for a client's own overhead — connection setup,
 * the upstream's response time once it IS back, and the fact that the measured worst case
 * (91981ms) already sits a whisker under the 90s nominal window.
 */
export const PSU_CLIENT_HEADROOM_MS = 30_000;

/**
 * Pure derivation, exported for the invariant test.
 *
 * An explicit operator override always wins — including one BELOW the retry window. That is
 * deliberate: a human debugging a wedged box may genuinely want to fail fast, and a guard
 * that silently overrode them would be its own bug. `psuTimeoutInvertsProxyBudget()` lets a
 * caller notice and say so, rather than this function quietly "fixing" the request.
 */
export function derivePsuTimeoutMs({ overrideMs = null, retryWindowMs = MCP_PROXY_RETRY_WINDOW_MS, headroomMs = PSU_CLIENT_HEADROOM_MS } = {}) {
  if (overrideMs !== null && Number.isFinite(overrideMs) && overrideMs > 0) return overrideMs;
  return retryWindowMs + headroomMs;
}

/** True when a client budget is shorter than the proxy's — the WI-6738 defect condition. */
export function psuTimeoutInvertsProxyBudget(timeoutMs, retryWindowMs = MCP_PROXY_RETRY_WINDOW_MS) {
  return timeoutMs < retryWindowMs;
}

/**
 * psu's per-request timeout. Defaults to the proxy's window + headroom (120s) instead of the
 * old independently-chosen 45s. A truly wedged host still fails with the same guidance — just
 * after the proxy has genuinely exhausted its retries, rather than while they are still in
 * flight. Override with PAPERCUSP_PSU_TIMEOUT_MS.
 */
export const PSU_REQUEST_TIMEOUT_MS = derivePsuTimeoutMs({ overrideMs: envMs('PAPERCUSP_PSU_TIMEOUT_MS') });
