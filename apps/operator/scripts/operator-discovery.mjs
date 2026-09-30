/**
 * operator-discovery.mjs — resolve the LIVE operator base URL for the
 * sidecar-shipped CLIs (onboard-launcher, tutorial-runner, ptool).
 *
 * A packaged desktop install runs its operator on a DYNAMICALLY-assigned
 * localhost port (re-picked on every boot) and records it in
 * ~/.papercusp/operator.json — the fixed :3070 exists only on the dev box.
 * Any CLI that defaults straight to :3070 dies with "can't reach the
 * Papercusp server at http://127.0.0.1:3070" on EVERY shipped install
 * (owner hit this live launching the tutorial on the seeded mac install,
 * 2026-07-05, WI-2903 thread). Same discovery convention as
 * psu-launcher.mjs `resolveOperatorUrl()` step 2 (WI-1457) — psu keeps its
 * own richer copy because it additionally probes the dev-box resilient
 * MCP proxy, which these CLIs never need.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** @typedef {Record<string, string | undefined>} EnvironmentMap */

/**
 * The desktop operator's recorded address from ~/.papercusp/operator.json,
 * or null when the file is missing/unreadable (the dev box).
 */
export function discoverOperatorUrl({ home = homedir() } = {}) {
  try {
    const d = JSON.parse(readFileSync(join(home, '.papercusp', 'operator.json'), 'utf8'));
    if (d && typeof d.httpUrl === 'string' && d.httpUrl) return d.httpUrl;
    if (d && d.port) return `http://127.0.0.1:${d.port}`;
  } catch {
    /* no operator.json → not a packaged desktop install */
  }
  return null;
}

/**
 * Standard CLI precedence: explicit --operator-url arg → PAPERCUSP_OPERATOR_URL
 * env override → live desktop discovery (operator.json) → dev-box :3070.
 * Callers that run inside an operator host can opt into self-host precedence;
 * that inserts the host's valid PAPERCUSP_HONO_PORT before the inherited env
 * override, preventing a staging process from routing its writes to green.
 *
 * Returns a BASE ORIGIN — callers append their own path (ptool posts to
 * `base + '/api/mcp'`). `PAPERCUSP_OPERATOR_URL` is OVERLOADED and cannot be
 * assumed to be one: `apps/operator/.env.local` unconditionally exports it WITH
 * the endpoint path (`http://localhost:3070/api/mcp`) because MCP-config
 * consumers want the full endpoint, and every operator process that sources
 * `.env.local` — including bg-host — inherits that form. Appending `/api/mcp`
 * to it yields `/api/mcp/api/mcp`, which the host answers `404 {"error":"not_found"}`,
 * so the CLI reports "could not reach the operator" for a host that is perfectly
 * healthy. Strip the suffix here, exactly as operator-core's
 * `resolveInheritedOperatorBaseUrl` / `resolveSpawnHostOperatorBaseUrl` already do
 * for the same overloaded variable (the WI-6154 bug class).
 *
 * @param {{operatorUrl?: string | null}} [args]
 * @param {EnvironmentMap} [env]
 * @param {{home?: string, preferSelfPort?: boolean}} [opts]
 * @returns {string}
 */
export function resolveOperatorBase(args = {}, env = process.env, opts = {}) {
  const selfPort = opts.preferSelfPort ? validLocalPort(env.PAPERCUSP_HONO_PORT) : null;
  const selfBase = selfPort
    ? operatorBaseForSelfPort(selfPort, env)
    : null;
  return (
    args.operatorUrl ??
    selfBase ??
    env.PAPERCUSP_OPERATOR_URL ??
    discoverOperatorUrl(opts) ??
    'http://127.0.0.1:3070'
  )
    .replace(/\/api\/mcp\/?$/, '')
    .replace(/\/$/, '');
}

/**
 * Return a dialable TCP port from an operator-host environment. `0` means
 * "bind any free port" and is not an address callers can connect to; malformed
 * and out-of-range values are likewise ignored so the normal discovery chain
 * remains authoritative.
 */
function validLocalPort(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? value : null;
}

/**
 * Resolve the current host's MCP base, preserving the resilient proxy only
 * when it fronts this exact host. A staging host must otherwise stay on its
 * own source tree even when `.env.local` handed it green's URL.
 */
function operatorBaseForSelfPort(selfPort, env) {
  const proxyBase = typeof env.PAPERCUSP_MCP_PROXY_BASE === 'string'
    ? env.PAPERCUSP_MCP_PROXY_BASE.trim()
    : '';
  const proxyTargetPort = validLocalPort(env.PAPERCUSP_MCP_PROXY_TARGET_PORT ?? '3070') ?? '3070';
  if (proxyBase && selfPort === proxyTargetPort) return proxyBase;
  return `http://127.0.0.1:${selfPort}`;
}

/**
 * Swap `url`'s origin for `freshBase`, keeping path/query/hash. Returns null
 * when either side is unparseable or the origin is already `freshBase` (no
 * move). Exported for tests.
 */
export function rebaseUrl(url, freshBase) {
  try {
    const u = new URL(url);
    const b = new URL(freshBase);
    if (u.protocol === b.protocol && u.host === b.host) return null;
    return `${b.protocol}//${b.host}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

/**
 * Resilient fetch for the sidecar CLIs — the shared, smaller sibling of
 * psu-launcher's fetchWithResilience (WI-3141). A packaged desktop operator is
 * routinely MID-BOOT when the user first opens the app and immediately clicks
 * the Setup/Tutorial icon: serve.mjs starts embedded-PG + runs migrations +
 * boots the Hono host, a multi-second window during which a plain fetch fails
 * "connection refused". The onboarding launchers used a bare fetch with NO
 * retry, so that unavoidable first-boot window surfaced as a hard "I can't reach
 * the Papercusp server" and the user had to relaunch until the boot finished
 * (owner 2026-07-05: "after 3 attempts the tutorial FINALLY showed up"). This
 * rides THROUGH it: CONNECTION failures (refused/reset — undici "fetch failed")
 * are retried on a short backoff until `connectBudgetMs` elapses; a bounded
 * per-request timeout stops a wedged host hanging forever; TIMEOUTs are retried
 * a small fixed number of times.
 *
 * A caller-supplied `init.signal` (e.g. the docs-qa stream's AbortController)
 * OWNS abort — once it fires we stop and rethrow — but a CONNECTION failure that
 * happens BEFORE it fires still retries within the budget, so a streamed call
 * also rides through a brief operator blip. `onRetry` fires once, the first time
 * a retry is scheduled, so a caller can show a "still starting…" note.
 *
 * `rediscover` (WI-3283): the operator may RESTART ONTO A DIFFERENT PORT while
 * we retry — packaged installs re-pick the port when the sticky one is taken,
 * and a `--operator-url` argv/env pin captured at spawn then points at a dead
 * socket for the rest of the process's life (the long-running tutorial shell is
 * the victim: "can't reach the papercusp server" mid-tutorial). Pass
 * `rediscover: discoverOperatorUrl` and every CONNECTION-failure retry re-reads
 * the live discovery file and FOLLOWS the move; `onRebase(newBase)` lets the
 * caller update its own long-lived base. The common same-port mid-boot window
 * stays a plain retry (discovery returns the same origin → no rebase), and a
 * TIMEOUT (reachable-but-slow) never rebases.
 *
 * Deps injected for tests (operator-discovery.test.ts) — fetchImpl/sleep/now
 * make the retry timing deterministic without real sockets or timers.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{
 *   fetchImpl?: (url: string, init: RequestInit) => Promise<any>,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   connectBudgetMs?: number,
 *   timeoutRetries?: number,
 *   onRetry?: (() => void) | null,
 *   rediscover?: (() => string | null) | null,
 *   onRebase?: ((base: string) => void) | null,
 * }} [deps]
 * @returns {Promise<any>}
 */
export async function fetchResilient(
  url,
  init = {},
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    timeoutMs = 20_000,
    connectBudgetMs = 30_000,
    timeoutRetries = 1,
    onRetry = null,
    rediscover = null,
    onRebase = null,
  } = {},
) {
  // A caller-supplied AbortSignal owns the request lifetime; without one we cap
  // each attempt with AbortSignal.timeout so a wedged host can't hang forever.
  const callerSignal = init.signal ?? null;
  const connectDeadline = now() + connectBudgetMs;
  let timeoutRetriesLeft = timeoutRetries;
  let announced = false;
  let lastErr;
  for (;;) {
    try {
      return await fetchImpl(url, {
        ...init,
        signal: callerSignal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastErr = e;
      // The caller's own signal aborted (its deadline/cancel) — never retry it.
      if (callerSignal?.aborted) break;
      const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      if (isTimeout) {
        // Reachable but slow — a retry costs another full timeout, so keep few.
        if (timeoutRetriesLeft <= 0) break;
        timeoutRetriesLeft -= 1;
        if (!announced) {
          announced = true;
          try {
            onRetry?.();
          } catch {
            /* a notice must never break the fetch */
          }
        }
        await sleep(1_000);
        continue;
      }
      // Connection refused/reset ("fetch failed") — operator mid-boot / recycle.
      // Retry on a short backoff until the wall-clock budget elapses.
      const remaining = connectDeadline - now();
      if (remaining <= 0) break;
      if (rediscover) {
        try {
          const fresh = rediscover();
          const moved = fresh ? rebaseUrl(url, fresh) : null;
          if (moved) {
            url = moved;
            try {
              onRebase?.(String(fresh).replace(/\/$/, ''));
            } catch {
              /* a notice must never break the fetch */
            }
          }
        } catch {
          /* rediscovery must never break the retry loop */
        }
      }
      if (!announced) {
        announced = true;
        try {
          onRetry?.();
        } catch {
          /* a notice must never break the fetch */
        }
      }
      await sleep(Math.min(2_000, Math.max(0, remaining)));
    }
  }
  throw lastErr ?? new Error(`could not reach ${url}`);
}
