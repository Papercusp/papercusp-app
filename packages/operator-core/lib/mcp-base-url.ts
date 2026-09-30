/**
 * mcp-base-url.ts — resolve the BASE URL that agent MCP `.mcp.json` entries point at (WI-573).
 *
 * WHY: the agent MCP endpoint is `<operator>/api/mcp`, and the operator (`:3070`) RESTARTS on every
 * deploy. A native MCP client (Claude Code / Codex / OMP) pinned directly at `:3070` drops its
 * connection on that restart and does not re-discover tools → a "toolless session". The always-up
 * local proxy (apps/operator/lib/mcp-proxy/proxy.ts, default `127.0.0.1:9071`) fronts `:3070` and
 * RETRIES a refused upstream, so the restart is invisible to the client.
 *
 * OPT-IN (safe by construction): we redirect agents through the proxy only when the operator
 * environment explicitly sets `PAPERCUSP_MCP_PROXY_BASE` (e.g. `http://127.0.0.1:9071` on the dev
 * box, where the proxy runs) and the caller points at the live operator. The proxy fronts `:3070`,
 * not the staging/current-build operator at `:3170`; a staging launch must stay on its own port or
 * a reviewer can read an older projection and manufacture a false grading-integrity failure. Unset
 * (CI, a fresh deploy with no proxy) → the caller's own operator base is used unchanged, so this
 * can NEVER break an environment that has no proxy. The signed/superuser query params + the bearer
 * header are preserved either way (the proxy is a pure passthrough), so auth is unaffected.
 */

/**
 * The base URL to embed in an agent's MCP server config. Returns the configured proxy base when
 * `PAPERCUSP_MCP_PROXY_BASE` is set (deploy-restart-resilient), else the operator base unchanged.
 * Trailing slashes are normalized off so callers can append `/api/mcp` consistently.
 */
export function resolveAgentMcpBaseUrl(operatorBaseUrl: string): string {
  const proxy = process.env.PAPERCUSP_MCP_PROXY_BASE?.trim();
  // The resilient proxy is intentionally a live-operator (:3070) transport. Any
  // explicit non-live operator port (:3170 staging, :3271 current-build, hermetic
  // gym/smoke hosts, …) must stay authoritative: routing one through :9071 silently
  // changes its runtime vintage back to green main. The old check special-cased only
  // :3170, so a :3271 capability:launch-agent command kept its requested --stack
  // argv but bootstrapped against stale :3070 and persisted an empty identity stack.
  let isExplicitNonLiveRuntime = false;
  try {
    const port = new URL(operatorBaseUrl).port;
    isExplicitNonLiveRuntime = port.length > 0 && port !== '3070';
  } catch {
    // Preserve the historical proxy fallback for malformed/relative inputs.
  }
  const base = proxy && proxy.length > 0 && !isExplicitNonLiveRuntime ? proxy : operatorBaseUrl;
  return base.replace(/\/$/, '');
}

/**
 * Resolve the stable MCP endpoint for a long-lived CLI session. The operator
 * that starts a session may be a staging host whose direct port restarts often;
 * persistent clients use the stable proxy instead.
 */
export function resolveLongLivedSessionMcpBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configuredProxy = env.PAPERCUSP_MCP_PROXY_BASE?.trim();
  return (configuredProxy || 'http://127.0.0.1:9071').replace(/\/+$/, '');
}

/**
 * Resolve an INHERITED `PAPERCUSP_OPERATOR_URL` (which may already carry a
 * `/api/mcp` suffix — some producers, e.g. dbos/orchestrator-runner.ts, set it
 * that way) down to the bare origin a native MCP client's OWN `.mcp.json`
 * template expects, routed through the resilient `:9071` proxy when
 * configured.
 *
 * WHY: a client's own MCP template (`~/.claude.json`'s `papercusp-su` entry)
 * unconditionally appends `/api/mcp` itself. A resumed session that inherits
 * the already-suffixed form ends up with the doubled, 404ing path
 * `.../api/mcp/api/mcp` and its papercusp-su MCP never connects. Use this for
 * any `PAPERCUSP_OPERATOR_URL` export a spawned `claude`/`omp` child will feed
 * straight into its own MCP config — for a raw-HTTP consumer that expects the
 * suffix preserved as originally set, see capability-bash's own
 * suffix-preserving wrapper instead.
 */
export function resolveInheritedOperatorBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return raw;
  const base = trimmed.replace(/\/api\/mcp\/?$/, '').replace(/\/$/, '');
  return resolveAgentMcpBaseUrl(base);
}

/**
 * Resolve THIS process's OWN operator base URL, for use as the callback/API-signing
 * env of a child THIS process spawns (a desktop terminal, an ad-hoc agent, a fleet
 * member, …) — WI-6154.
 *
 * BUG CLASS THIS FIXES: `apps/operator/.env.local` unconditionally sets
 * `PAPERCUSP_OPERATOR_URL="http://localhost:3070/api/mcp"` (the LIVE operator), and
 * that value is inherited by EVERY operator process that sources `.env.local` —
 * including the `:3170` staging host (which additionally exports its own
 * `PAPERCUSP_HONO_PORT=3170` on top) and any hermetic gym/smoke instance. Five spawn
 * sites (capability:launch-agent, capability:terminal, fleet:launch-on-plan,
 * fleet-headcount-action, delegated-spawn-honor) each hand-rolled an identical
 * resolver that checked the inherited `PAPERCUSP_OPERATOR_URL` FIRST — so a terminal
 * or agent spawned FROM the staging host got wired to talk to the LIVE :3070
 * operator instead of its actual spawner (matching the gym-worker root cause of
 * WI-6154: every gym eval agent handshook :3070, where `role=worker` has zero
 * granted capabilities, so 100% of runs escalated with an empty diff).
 *
 * FIX: when THIS process knows its own serving port (`PAPERCUSP_HONO_PORT` is set —
 * true for every operator host: live, staging, hermetic gym/smoke), that identity
 * wins over any inherited `PAPERCUSP_OPERATOR_URL`, which may just be leaked-through
 * config for a DIFFERENT host. Only a process with no server identity of its own (a
 * bare client/agent session, never itself hosting an operator) falls back to the
 * inherited value — which there correctly names the operator it is actually talking
 * to (dbos/orchestrator-runner.ts's `spawnInvokeOnce` pin, EI-286 leg (b), already
 * uses this exact precedence for its own spawn path; this is the same fix for the
 * other five).
 */
export function resolveSpawnHostOperatorBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  // The desktop sidecar listens on OPERATOR_DEV_PORT. Its shell can also
  // inherit PAPERCUSP_HONO_PORT from a different staging host; that inherited
  // value must not redirect a child launch away from this process's source.
  const desktopPort = env.OPERATOR_DEV_PORT?.trim();
  if (desktopPort && Number.isInteger(Number(desktopPort)) && Number(desktopPort) > 0) {
    return `http://localhost:${desktopPort}`;
  }
  const honoPort = env.PAPERCUSP_HONO_PORT?.trim();
  if (honoPort) return `http://localhost:${honoPort}`;
  const fromEnv = env.PAPERCUSP_OPERATOR_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/api\/mcp\/?$/, '').replace(/\/$/, '');
  return 'http://localhost:3070';
}
