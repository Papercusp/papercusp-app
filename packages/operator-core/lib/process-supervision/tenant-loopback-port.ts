/**
 * Per-tenant ports for the fixed-port loopback services (WI-10005481).
 *
 * WHY: the inference gateway (:8788) and the packaged MCP proxy (:9071) listen on FIXED
 * loopback ports, and both supervisors adopt "whatever already answers there". On a Linux
 * host with two Papercusp Servers (one per user, the P-011 shared multi-tenant host, or any
 * multi-user box) the second Server found the first one's listeners, adopted them, and
 * pointed its agents at them: tenant 2's LLM calls egressed under tenant 1's account and its
 * MCP calls reached tenant 1's operator. Observed on cap-p011, 2026-10-02.
 *
 * Refusing the adoption alone does not fix it, because every client reads the port from
 * `PAPERCUSP_GATEWAY_PORT` / `PAPERCUSP_MCP_PROXY_PORT` (default 8788 / 9071). So the fix is
 * to decide the port ONCE per process, by listener ownership, and write the decision into
 * those env vars before anything spawns. Every in-process reader (spawn-env `gatewayPort()`,
 * the orchestrator's gateway configs, `resolveAgentMcpBaseUrl`) and every child inherits it.
 *
 * The rule, per service:
 *   - the configured port (explicit env, else the default) is FREE or held only by THIS uid
 *     -> keep it (the dev box's systemd gateway runs as the same user and is still adopted);
 *   - the host cannot say who owns it (no /proc/net/tcp: macOS, Windows) -> keep it, i.e.
 *     the behaviour before this fix (a residual, named in the result);
 *   - another uid holds it and the port came from the DEFAULT -> move to this uid's tenant
 *     port: `rangeBase + (uid % span)`, walking forward inside the range past ports another
 *     uid holds. The port is a pure function of the uid plus the census, so every process of
 *     one tenant (primary, cluster workers, restarts) lands on the same one;
 *   - another uid holds an EXPLICITLY configured port -> keep it but report
 *     `explicit-foreign`: someone pointed this tenant at a neighbour's service on purpose or
 *     by mistake, and the supervisor must refuse to adopt rather than silently move.
 */
import { loopbackListenerUids } from './sidecar-spawn-shared';

export interface TenantLoopbackService {
  /** Short name for logs. */
  label: string;
  /** Env var every reader of this port consults. */
  envVar: string;
  defaultPort: number;
  /** First port of this service's tenant range. Below the Linux ephemeral range (32768). */
  rangeBase: number;
  /** Number of ports in the tenant range. */
  span: number;
  /** Further env to set when the port MOVES (and the var is not already set explicitly). */
  derivedEnv?: (port: number) => Record<string, string>;
}

export const GATEWAY_TENANT_SERVICE: TenantLoopbackService = {
  label: 'inference-gateway',
  envVar: 'PAPERCUSP_GATEWAY_PORT',
  defaultPort: 8788,
  rangeBase: 23800,
  span: 1000,
};

export const MCP_PROXY_TENANT_SERVICE: TenantLoopbackService = {
  label: 'mcp-proxy',
  envVar: 'PAPERCUSP_MCP_PROXY_PORT',
  defaultPort: 9071,
  rangeBase: 24800,
  span: 1000,
  // Agent MCP configs come from resolveAgentMcpBaseUrl / the claude-integration fallback,
  // which read PAPERCUSP_MCP_PROXY_BASE and otherwise bake the literal :9071.
  derivedEnv: (port) => ({ PAPERCUSP_MCP_PROXY_BASE: `http://127.0.0.1:${port}` }),
};

/**
 * WI-10005586: the voice WebSocket walks (8 ports from a fixed base) are host-global too, so
 * on a shared host only the first 7 (mobile) / 8 (desktop) tenants got voice and the rest
 * logged FATAL with health still green (cap-p011, K=16). Clients never hard-code these ports:
 * the chosen one reaches them through getMobileVoicePort() (device pairing / runtime-config)
 * and getDesktopVoicePort() (desktop voice-config), so moving a tenant is invisible to them.
 * Mobile voice binds every interface; the census counts wildcard listeners, which block it too.
 */
export const MOBILE_VOICE_TENANT_SERVICE: TenantLoopbackService = {
  label: 'mobile-voice-ws',
  envVar: 'MOBILE_VOICE_WS_PORT',
  defaultPort: 3068,
  rangeBase: 25800,
  span: 1000,
};

export const DESKTOP_VOICE_TENANT_SERVICE: TenantLoopbackService = {
  label: 'desktop-voice-ws',
  envVar: 'DESKTOP_VOICE_WS_PORT',
  defaultPort: 3076,
  rangeBase: 26800,
  span: 1000,
};

/** Every fixed-port service a Server pins per tenant. Ranges must stay disjoint and below 32768. */
export const TENANT_LOOPBACK_SERVICES: readonly TenantLoopbackService[] = [
  GATEWAY_TENANT_SERVICE,
  MCP_PROXY_TENANT_SERVICE,
  MOBILE_VOICE_TENANT_SERVICE,
  DESKTOP_VOICE_TENANT_SERVICE,
];

export type TenantPortReason =
  | 'default-free'
  | 'default-own'
  | 'explicit'
  | 'explicit-foreign'
  | 'ownership-unknown'
  | 'tenant-port'
  | 'no-tenant-port-free';

export interface TenantPortDecision {
  port: number;
  reason: TenantPortReason;
  /** True when the port differs from what the env/default said. */
  moved: boolean;
  /** uids that hold the configured port when they are not this uid. */
  foreignUids: number[];
}

export interface ResolveTenantPortDeps {
  env?: NodeJS.ProcessEnv;
  uid?: number | null;
  listenerUids?: (port: number) => number[] | null;
}

function configuredPort(service: TenantLoopbackService, env: NodeJS.ProcessEnv): number | null {
  const raw = env[service.envVar]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** Decide this tenant's port for one service. Pure apart from the injected census. */
export function resolveTenantLoopbackPort(
  service: TenantLoopbackService,
  deps: ResolveTenantPortDeps = {},
): TenantPortDecision {
  const env = deps.env ?? process.env;
  const uid = deps.uid === undefined ? currentUid() : deps.uid;
  const census = deps.listenerUids ?? ((p: number) => loopbackListenerUids(p));
  const explicit = configuredPort(service, env);
  const port = explicit ?? service.defaultPort;

  if (uid === null) return { port, reason: 'ownership-unknown', moved: false, foreignUids: [] };
  const holders = census(port);
  if (holders === null) return { port, reason: 'ownership-unknown', moved: false, foreignUids: [] };
  const foreign = holders.filter((u) => u !== uid);
  if (foreign.length === 0) {
    const reason: TenantPortReason = explicit !== null ? 'explicit' : holders.length ? 'default-own' : 'default-free';
    return { port, reason, moved: false, foreignUids: [] };
  }
  if (explicit !== null) return { port, reason: 'explicit-foreign', moved: false, foreignUids: foreign };

  const start = uid % service.span;
  for (let i = 0; i < service.span; i++) {
    const candidate = service.rangeBase + ((start + i) % service.span);
    const at = census(candidate);
    if (at !== null && at.every((u) => u === uid)) {
      return { port: candidate, reason: 'tenant-port', moved: true, foreignUids: foreign };
    }
  }
  return { port, reason: 'no-tenant-port-free', moved: false, foreignUids: foreign };
}

/**
 * Resolve and PIN the port: when it moves, write it (and the service's derived env) into
 * `env` so every later reader and child uses it. Idempotent: once pinned, the env var is
 * set, so a second call resolves it as `explicit` and changes nothing.
 */
export function pinTenantLoopbackPort(
  service: TenantLoopbackService,
  deps: ResolveTenantPortDeps = {},
): TenantPortDecision {
  const env = deps.env ?? process.env;
  const decision = resolveTenantLoopbackPort(service, { ...deps, env });
  if (decision.moved) {
    env[service.envVar] = String(decision.port);
    for (const [k, v] of Object.entries(service.derivedEnv?.(decision.port) ?? {})) {
      if (!env[k]?.trim()) env[k] = v;
    }
    console.warn(
      `[tenant-port] ${service.label}: :${service.defaultPort} is held by uid ${decision.foreignUids.join(',')} ` +
        `(not this uid) — using this tenant's port :${decision.port} (${service.envVar})`,
    );
  } else if (decision.reason === 'explicit-foreign' || decision.reason === 'no-tenant-port-free') {
    console.error(
      `[tenant-port] ${service.label}: :${decision.port} is held by uid ${decision.foreignUids.join(',')} ` +
        `(not this uid) and ${decision.reason === 'explicit-foreign' ? `${service.envVar} pins it explicitly` : 'no tenant port is free'} ` +
        '— the supervisor will NOT adopt it',
    );
  }
  return decision;
}

/** Pin every fixed-port service in TENANT_LOOPBACK_SERVICES, in that order. Call before
 *  anything spawns an agent or binds a voice listener. */
export function pinTenantLoopbackPorts(deps: ResolveTenantPortDeps = {}): TenantPortDecision[] {
  return TENANT_LOOPBACK_SERVICES.map((s) => pinTenantLoopbackPort(s, deps));
}

/** True only when this host can prove someone ELSE listens on 127.0.0.1:`port`. */
export function loopbackPortHeldByForeignUid(
  port: number,
  deps: { uid?: number | null; listenerUids?: (port: number) => number[] | null } = {},
): boolean {
  const uid = deps.uid === undefined ? currentUid() : deps.uid;
  if (uid === null) return false;
  const holders = (deps.listenerUids ?? ((p: number) => loopbackListenerUids(p)))(port);
  return holders !== null && holders.some((u) => u !== uid);
}
