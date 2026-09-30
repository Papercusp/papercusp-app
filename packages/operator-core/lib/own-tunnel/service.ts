/**
 * The own-tunnel service (external-app-access P-009, D-001; plan Decision "P-009 design"):
 * the one API the setup wizard's "use my own tunnel" step and the Remote access screen
 * (P-010) call. It joins the pieces:
 *
 *   config.ts / provision.ts  — what to create in the user's Cloudflare account
 *   store.ts                  — the install's single remote_access_own_tunnel row
 *   runtime.ts                — the external-ingress listener seam, cloudflared, sign-in
 *
 * and owns the RECONCILER that makes this process match the row.
 *
 * Who acts (the EI-126 rule applied to tunnels):
 *  - The external-ingress LISTENER opens in every request-serving process of the operator
 *    whose port equals the row's operator_port (cluster workers share it with reusePort).
 *    A second operator on the same database (the dev box's staging host) never opens it.
 *  - The cloudflared CONNECTOR runs in exactly one process per database: the host
 *    singleton (cluster primary + background owner). cloudflared dials 127.0.0.1, so the
 *    connector and the listener only need to share the machine, not the process.
 *  - The desktop's operator port is a cold-start hint and can change between launches. The
 *    host singleton therefore adopts the tunnel (rewrites operator_port to its own port)
 *    when it serves requests itself and the recorded operator no longer answers.
 *  - PAPERCUSP_EXTERNAL_INGRESS_PORT (P-004) still works and wins: hono-host then opens a
 *    static listener at boot and this module never opens or closes one.
 *
 * The listener only ever runs `externalIngressHandler` (host-handler.ts), so a request
 * arriving through the tunnel can never reach local trust (P-004 / R-7).
 */
import { createServer } from 'node:net';
import { hostname as osHostname } from 'node:os';
import { pinModuleState } from '@papercusp/module-singleton';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { externalIngressPort } from '../auth/forwarded-request-trust';
import { isHostSingleton } from '../background-workers';
import { cloudflareApi, CloudflareApiError, type CloudflareApi, type CloudflareZone } from './cloudflare-api';
import {
  assertPort,
  type ArgoTunnelLogin,
  normalizeHostname,
  normalizeLabel,
  OWN_TUNNEL_DEFAULT_LABEL,
  OwnTunnelInputError,
  publicMcpUrl,
  tunnelNameFor,
  zoneCandidates,
} from './config';
import { provisionCloudflareTunnel, removeCloudflareTunnel } from './provision';
import {
  cancelLogin,
  completedLogin,
  connectorRunning,
  connectorStatus,
  ensureIngressListener,
  ingressListenerPort,
  loginStatus,
  resolveCloudflaredBinary,
  startConnector,
  startLogin,
  stopConnector,
  type ConnectorStatus,
  type LoginStatus,
} from './runtime';
import {
  deleteOwnTunnel,
  readOwnTunnel,
  readOwnTunnelSecrets,
  recordOwnTunnelError,
  saveCloudflareTunnel,
  saveManualTunnel,
  setOwnTunnelEnabled,
  setOwnTunnelOperatorPort,
  type OwnTunnelMode,
  type OwnTunnelRow,
  type OwnTunnelSecrets,
  type OwnTunnelStoreOptions,
  type SaveCloudflareTunnel,
} from './store';

/** How often every serving process re-reads the row. Bounds kill-switch convergence across cluster processes. */
export const OWN_TUNNEL_RECONCILE_INTERVAL_MS = 5_000;
/** Minimum spacing between cloudflared restarts after it exits on its own. */
export const CONNECTOR_RESTART_BACKOFF_MS = 30_000;
/** A connector that has stayed up this long clears the row's last error. */
export const CONNECTOR_HEALTHY_AFTER_MS = 15_000;

/** Everything the service touches outside its own logic — injectable for tests. */
export interface OwnTunnelDeps {
  readonly store: {
    read(): Promise<OwnTunnelRow | null>;
    readSecrets(): Promise<OwnTunnelSecrets>;
    saveCloudflare(t: SaveCloudflareTunnel): Promise<void>;
    saveManual(t: { ingressPort: number; operatorPort: number | null; hostname?: string | null }): Promise<void>;
    setEnabled(enabled: boolean): Promise<boolean>;
    recordError(message: string | null): Promise<void>;
    setOperatorPort(port: number): Promise<void>;
    remove(): Promise<void>;
  };
  readonly api: (apiToken: string) => CloudflareApi;
  readonly env: NodeJS.ProcessEnv;
  /** Is this process the one per database that runs cloudflared? */
  readonly isConnectorOwner: () => boolean;
  /** Does this process serve requests (has hono-host registered the listener seam)? */
  readonly servesRequests: () => boolean;
  readonly ensureListener: (port: number | null) => Promise<boolean>;
  readonly listenerPort: () => number | null;
  readonly connector: {
    readonly running: () => boolean;
    readonly status: () => ConnectorStatus;
    readonly start: (runToken: string, bin: string) => Promise<void>;
    readonly stop: () => Promise<void>;
  };
  readonly cloudflaredBin: () => string | null;
  /** The finished one-click sign-in (runtime.ts), if any. */
  readonly signIn: {
    readonly completed: () => ArgoTunnelLogin | null;
    readonly clear: () => void;
  };
  readonly pickFreePort: (avoid: readonly number[]) => Promise<number>;
  /** Does an operator answer on this loopback port? Used before adopting a stale operator_port. */
  readonly operatorAnswers: (port: number) => Promise<boolean>;
  readonly installLabel: () => string;
  readonly now: () => number;
}

function storeDeps(opts?: OwnTunnelStoreOptions): OwnTunnelDeps['store'] {
  return {
    read: () => readOwnTunnel(opts),
    readSecrets: () => readOwnTunnelSecrets(opts),
    saveCloudflare: (t) => saveCloudflareTunnel(t, opts),
    saveManual: (t) => saveManualTunnel(t, opts),
    setEnabled: (enabled) => setOwnTunnelEnabled(enabled, opts),
    recordError: (message) => recordOwnTunnelError(message, opts),
    setOperatorPort: (port) => setOwnTunnelOperatorPort(port, opts),
    remove: () => deleteOwnTunnel(opts),
  };
}

/** Ask the kernel for a free loopback port (bind :0, read it, close), avoiding `avoid`. */
export async function pickFreeLoopbackPort(avoid: readonly number[] = []): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen({ port: 0, host: '127.0.0.1' }, () => {
        const addr = srv.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
    if (port > 0 && !avoid.includes(port)) return port;
  }
  throw new Error('could not find a free loopback port for the external-ingress listener');
}

async function defaultOperatorAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The port this operator serves on — the same resolution hono-host uses. */
export function currentOperatorPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const n = Number(env.PAPERCUSP_HONO_PORT ?? env.PORT ?? 3070);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

const state = pinModuleState('@papercusp/operator-core.own-tunnel.service', () => ({
  seamConfigured: false,
  reconcilerArmed: false,
  reconcileInFlight: null as Promise<ReconcileResult> | null,
  lastConnectorStartAt: 0,
  lastLoggedError: null as string | null,
}));

/** hono-host calls this after it registers the listener seam (runtime.configureIngressListener). */
export function markOwnTunnelListenerSeamConfigured(configured = true): void {
  state.seamConfigured = configured;
}

export function defaultOwnTunnelDeps(overrides: Partial<OwnTunnelDeps> = {}, storeOpts?: OwnTunnelStoreOptions): OwnTunnelDeps {
  return {
    store: storeDeps(storeOpts),
    api: (apiToken) => cloudflareApi({ apiToken }),
    env: process.env,
    isConnectorOwner: () => isHostSingleton(),
    servesRequests: () => state.seamConfigured,
    ensureListener: ensureIngressListener,
    listenerPort: ingressListenerPort,
    connector: {
      running: connectorRunning,
      status: connectorStatus,
      start: (runToken, bin) => startConnector(runToken, { bin }),
      stop: () => stopConnector(),
    },
    cloudflaredBin: () => resolveCloudflaredBinary(),
    signIn: { completed: completedLogin, clear: cancelLogin },
    pickFreePort: pickFreeLoopbackPort,
    operatorAnswers: defaultOperatorAnswers,
    installLabel: () => osHostname(),
    now: () => Date.now(),
    ...overrides,
  };
}

// ── status ────────────────────────────────────────────────────────────────────────

export type OwnTunnelHealth = 'not-configured' | 'off' | 'starting' | 'up' | 'down';

export interface OwnTunnelStatus {
  readonly configured: boolean;
  readonly mode: OwnTunnelMode | null;
  readonly enabled: boolean;
  readonly hostname: string | null;
  /** The URL an outside app uses for MCP, when a hostname is known. */
  readonly mcpUrl: string | null;
  /** The loopback port the tunnel must forward to. */
  readonly ingressPort: number | null;
  readonly ingressPortSource: 'env' | 'row' | null;
  /** Service URL a manual tunnel should point at. */
  readonly ingressTarget: string | null;
  readonly operatorPort: number | null;
  /** This operator is the one that serves the tunnel's listener. */
  readonly servedByThisOperator: boolean;
  /** This process currently has the listener open. */
  readonly listening: boolean;
  /** Connector state, when this process owns the connector; null when another process does. */
  readonly connector: ConnectorStatus | null;
  readonly cloudflaredInstalled: boolean;
  readonly login: LoginStatus;
  readonly health: OwnTunnelHealth;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly cloudflare: {
    readonly accountId: string | null;
    readonly zoneName: string | null;
    readonly tunnelId: string | null;
    readonly tunnelName: string | null;
  } | null;
}

function effectiveIngressPort(row: OwnTunnelRow | null, env: NodeJS.ProcessEnv): { port: number | null; source: 'env' | 'row' | null } {
  const envPort = externalIngressPort(env);
  if (envPort !== null) return { port: envPort, source: 'env' };
  if (row) return { port: row.ingressPort, source: 'row' };
  return { port: null, source: null };
}

export async function ownTunnelStatus(deps: OwnTunnelDeps = defaultOwnTunnelDeps()): Promise<OwnTunnelStatus> {
  const row = await deps.store.read();
  const { port, source } = effectiveIngressPort(row, deps.env);
  const opPort = currentOperatorPort(deps.env);
  const ownsConnector = deps.isConnectorOwner();
  const connector = ownsConnector ? deps.connector.status() : null;
  const servedHere = !!row && row.operatorPort === opPort;
  let health: OwnTunnelHealth;
  if (!row) health = 'not-configured';
  else if (!row.enabled) health = 'off';
  else if (row.mode === 'manual') health = row.lastError ? 'down' : 'up';
  else if (connector) {
    const upFor = connector.running && connector.startedAt ? deps.now() - Date.parse(connector.startedAt) : 0;
    health = !connector.running ? 'down' : upFor < CONNECTOR_HEALTHY_AFTER_MS && row.lastError === null ? 'starting' : row.lastError ? 'down' : 'up';
  } else {
    health = row.lastError ? 'down' : 'up';
  }
  return {
    configured: !!row,
    mode: row?.mode ?? null,
    enabled: row?.enabled ?? false,
    hostname: row?.hostname ?? null,
    mcpUrl: row?.hostname ? publicMcpUrl(row.hostname) : null,
    ingressPort: port,
    ingressPortSource: source,
    ingressTarget: port !== null ? `http://127.0.0.1:${port}` : null,
    operatorPort: row?.operatorPort ?? null,
    servedByThisOperator: servedHere,
    listening: port !== null && deps.listenerPort() === port,
    connector,
    cloudflaredInstalled: deps.cloudflaredBin() !== null,
    login: loginStatus(),
    health,
    lastError: row?.lastError ?? null,
    lastErrorAt: row?.lastErrorAt ? new Date(row.lastErrorAt).toISOString() : null,
    cloudflare:
      row?.mode === 'cloudflare'
        ? { accountId: row.cfAccountId, zoneName: row.cfZoneName, tunnelId: row.cfTunnelId, tunnelName: row.cfTunnelName }
        : null,
  };
}

// ── sign-in ───────────────────────────────────────────────────────────────────────

/** Start `cloudflared tunnel login` (isolated HOME) and return the sign-in URL to show. */
export async function beginCloudflareSignIn(deps: OwnTunnelDeps = defaultOwnTunnelDeps()): Promise<{ loginUrl: string | null; state: string }> {
  const bin = deps.cloudflaredBin();
  if (!bin) throw new OwnTunnelInputError('cloudflared_missing', 'cloudflared is not installed on this computer');
  return startLogin({ bin });
}

export function cancelCloudflareSignIn(): void {
  cancelLogin();
}

/** After sign-in completes: the zone the user picked, so the wizard can offer `<name>.<zone>`. */
export async function signedInZone(deps: OwnTunnelDeps = defaultOwnTunnelDeps()): Promise<{ zoneId: string; zoneName: string } | null> {
  const login = deps.signIn.completed();
  if (!login) return null;
  const zone = await deps.api(login.apiToken).getZone(login.zoneId);
  return { zoneId: zone.id, zoneName: zone.name };
}

// ── provisioning ──────────────────────────────────────────────────────────────────

export interface ProvisionOwnTunnelInput {
  /** Full hostname, e.g. papercusp.example.com. */
  readonly hostname?: string;
  /** Just the first label; the zone picked at sign-in supplies the rest. */
  readonly label?: string;
  /** Advanced: a pasted API token (Tunnel:Edit + DNS:Edit) instead of the one-click sign-in. */
  readonly apiToken?: string;
}

async function zoneForHostname(api: CloudflareApi, hostname: string): Promise<CloudflareZone> {
  for (const candidate of zoneCandidates(hostname)) {
    const zone = await api.findZoneByName(candidate);
    if (zone) return zone;
  }
  throw new OwnTunnelInputError('zone_not_found', `no zone this API token can see contains ${hostname}`);
}

async function chooseIngressPort(deps: OwnTunnelDeps, row: OwnTunnelRow | null): Promise<number> {
  const envPort = externalIngressPort(deps.env);
  if (envPort !== null) return envPort;
  const opPort = currentOperatorPort(deps.env);
  if (row && row.ingressPort !== opPort) return row.ingressPort;
  return deps.pickFreePort(opPort !== null ? [opPort] : []);
}

/**
 * Create (or re-use) the tunnel in the user's Cloudflare account, save it, and bring it up.
 * Idempotent: running it again with the same hostname converges on the same tunnel.
 */
export async function provisionOwnTunnel(
  input: ProvisionOwnTunnelInput,
  deps: OwnTunnelDeps = defaultOwnTunnelDeps(),
): Promise<OwnTunnelStatus> {
  const pasted = input.apiToken?.trim();
  const login = pasted ? null : deps.signIn.completed();
  if (!pasted && !login) {
    throw new OwnTunnelInputError('not_signed_in', 'sign in to Cloudflare first, or paste an API token');
  }
  const api = deps.api(pasted ?? login!.apiToken);

  let hostname: string;
  let accountId: string;
  let zoneId: string | null;
  if (login) {
    accountId = login.accountId;
    zoneId = login.zoneId;
    if (input.hostname) hostname = normalizeHostname(input.hostname);
    else {
      const zone = await api.getZone(login.zoneId);
      hostname = normalizeHostname(`${normalizeLabel(input.label ?? OWN_TUNNEL_DEFAULT_LABEL)}.${zone.name}`);
    }
  } else {
    if (!input.hostname) throw new OwnTunnelInputError('hostname_required', 'enter the full hostname to use (for example papercusp.example.com)');
    hostname = normalizeHostname(input.hostname);
    const zone = await zoneForHostname(api, hostname);
    if (!zone.account?.id) throw new OwnTunnelInputError('account_unknown', `Cloudflare did not say which account owns ${zone.name}`);
    accountId = zone.account.id;
    zoneId = zone.id;
  }

  const row = await deps.store.read();
  const ingressPort = await chooseIngressPort(deps, row);
  const provisioned = await provisionCloudflareTunnel(api, {
    accountId,
    zoneId,
    hostname,
    ingressPort,
    tunnelName: tunnelNameFor(deps.installLabel()),
  });
  await deps.store.saveCloudflare({
    ingressPort,
    operatorPort: currentOperatorPort(deps.env),
    hostname: provisioned.hostname,
    accountId: provisioned.accountId,
    zoneId: provisioned.zoneId,
    zoneName: provisioned.zoneName,
    tunnelId: provisioned.tunnelId,
    tunnelName: provisioned.tunnelName,
    dnsRecordId: provisioned.dnsRecordId,
    apiToken: pasted ?? login!.apiToken,
    runToken: provisioned.runToken,
  });
  if (login) deps.signIn.clear();
  await reconcileOwnTunnel(deps);
  return ownTunnelStatus(deps);
}

/** Manual mode: the user runs another outbound tunnel (Tailscale Funnel, ngrok, …) at the ingress port. */
export async function useManualTunnel(
  input: { port?: number; hostname?: string | null },
  deps: OwnTunnelDeps = defaultOwnTunnelDeps(),
): Promise<OwnTunnelStatus> {
  const opPort = currentOperatorPort(deps.env);
  const row = await deps.store.read();
  let ingressPort: number;
  if (input.port !== undefined) {
    ingressPort = assertPort(input.port, 'ingress port');
    if (ingressPort === opPort) {
      throw new OwnTunnelInputError('ingress_is_operator_port', `port ${ingressPort} is the operator's own port; the tunnel must use a separate listener`);
    }
  } else ingressPort = await chooseIngressPort(deps, row);
  const hostname = input.hostname ? normalizeHostname(input.hostname) : null;
  if (row?.mode === 'cloudflare') await removeCloudflareSide(row, deps);
  await deps.store.saveManual({ ingressPort, operatorPort: opPort, hostname });
  await reconcileOwnTunnel(deps);
  return ownTunnelStatus(deps);
}

/** The kill switch. Off closes the listener and stops cloudflared here at once; other processes follow within one reconcile tick. */
export async function setOwnTunnelEnabledNow(enabled: boolean, deps: OwnTunnelDeps = defaultOwnTunnelDeps()): Promise<OwnTunnelStatus> {
  const found = await deps.store.setEnabled(enabled);
  if (!found) throw new OwnTunnelInputError('not_configured', 'no tunnel is set up yet');
  await reconcileOwnTunnel(deps);
  return ownTunnelStatus(deps);
}

async function removeCloudflareSide(row: OwnTunnelRow, deps: OwnTunnelDeps): Promise<'done' | 'skipped'> {
  const { apiToken } = await deps.store.readSecrets();
  if (!apiToken || !row.cfAccountId || !row.cfZoneId || !row.cfTunnelId || !row.hostname) return 'skipped';
  await removeCloudflareTunnel(deps.api(apiToken), {
    accountId: row.cfAccountId,
    zoneId: row.cfZoneId,
    tunnelId: row.cfTunnelId,
    hostname: row.hostname,
    dnsRecordId: row.cfDnsRecordId,
  });
  return 'done';
}

export interface RemoveOwnTunnelResult {
  readonly removed: boolean;
  readonly cloudflare: 'done' | 'skipped' | 'failed';
  readonly error: string | null;
}

/**
 * Remove the tunnel: stop it locally, delete what we created in Cloudflare (only our CNAME
 * and our tunnel), then delete the row. With `keepIfCloudflareFails`, a Cloudflare failure
 * leaves the row (disabled) so the user can retry instead of orphaning the tunnel.
 */
export async function removeOwnTunnel(
  opts: { keepIfCloudflareFails?: boolean } = {},
  deps: OwnTunnelDeps = defaultOwnTunnelDeps(),
): Promise<RemoveOwnTunnelResult> {
  const row = await deps.store.read();
  if (!row) return { removed: false, cloudflare: 'skipped', error: null };
  await deps.store.setEnabled(false);
  await reconcileOwnTunnel(deps);
  let cloudflare: RemoveOwnTunnelResult['cloudflare'] = 'skipped';
  let error: string | null = null;
  if (row.mode === 'cloudflare') {
    try {
      cloudflare = await removeCloudflareSide(row, deps);
    } catch (err) {
      cloudflare = 'failed';
      error = err instanceof Error ? err.message : String(err);
      if (opts.keepIfCloudflareFails) {
        await deps.store.recordError(`removing the tunnel from Cloudflare failed: ${error}`);
        return { removed: false, cloudflare, error };
      }
    }
  }
  await deps.store.remove();
  await reconcileOwnTunnel(deps);
  return { removed: true, cloudflare, error };
}

// ── reconciler ────────────────────────────────────────────────────────────────────

export interface ReconcileResult {
  readonly listener: 'open' | 'closed' | 'static' | 'not-serving' | 'failed';
  readonly connector: 'running' | 'started' | 'stopped' | 'not-owner' | 'backoff' | 'missing-binary' | 'failed' | 'idle';
  readonly adoptedOperatorPort: number | null;
  readonly error: string | null;
}

function errMessage(err: unknown): string {
  if (err instanceof CloudflareApiError || err instanceof OwnTunnelInputError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

async function reconcileOnce(deps: OwnTunnelDeps): Promise<ReconcileResult> {
  let row = await deps.store.read();
  const opPort = currentOperatorPort(deps.env);
  const envPort = externalIngressPort(deps.env);
  let adoptedOperatorPort: number | null = null;
  let error: string | null = null;

  // Adopt a tunnel whose recorded operator is gone (the desktop's port hint moved).
  if (
    row &&
    opPort !== null &&
    row.operatorPort !== opPort &&
    row.ingressPort !== opPort &&
    deps.isConnectorOwner() &&
    deps.servesRequests() &&
    (row.operatorPort === null || !(await deps.operatorAnswers(row.operatorPort)))
  ) {
    await deps.store.setOperatorPort(opPort);
    adoptedOperatorPort = opPort;
    row = await deps.store.read();
  }

  // Listener.
  let listener: ReconcileResult['listener'];
  if (envPort !== null) listener = 'static';
  else if (!deps.servesRequests()) listener = 'not-serving';
  else {
    const want = row && row.enabled && row.operatorPort === opPort ? row.ingressPort : null;
    try {
      await deps.ensureListener(want);
      listener = want === null ? 'closed' : 'open';
    } catch (err) {
      listener = 'failed';
      error = `the external-ingress listener could not open on 127.0.0.1:${want}: ${errMessage(err)}`;
    }
  }

  // Connector.
  let connector: ReconcileResult['connector'];
  if (!deps.isConnectorOwner()) connector = 'not-owner';
  else if (!row || !row.enabled || row.mode !== 'cloudflare') {
    if (deps.connector.running()) {
      await deps.connector.stop();
      connector = 'stopped';
    } else connector = 'idle';
    // A deliberate stop is not a crash: switching back on starts cloudflared without backoff.
    state.lastConnectorStartAt = 0;
  } else {
    const bin = deps.cloudflaredBin();
    if (!bin) {
      connector = 'missing-binary';
      error ??= 'cloudflared is not installed on this computer, so the tunnel cannot run';
    } else if (deps.connector.running()) {
      connector = 'running';
      const st = deps.connector.status();
      const upFor = st.startedAt ? deps.now() - Date.parse(st.startedAt) : 0;
      if (row.lastError && !error && upFor >= CONNECTOR_HEALTHY_AFTER_MS) await deps.store.recordError(null);
    } else if (deps.now() - state.lastConnectorStartAt < CONNECTOR_RESTART_BACKOFF_MS) {
      connector = 'backoff';
      const st = deps.connector.status();
      if (st.exit) {
        const tail = st.logTail[st.logTail.length - 1];
        error ??= `cloudflared exited (code ${st.exit.code ?? 'none'}${st.exit.signal ? `, ${st.exit.signal}` : ''})${tail ? `: ${tail}` : ''}`;
      }
    } else {
      const { runToken } = await deps.store.readSecrets();
      if (!runToken) {
        connector = 'failed';
        error ??= 'the saved tunnel has no run token; set the tunnel up again';
      } else {
        state.lastConnectorStartAt = deps.now();
        try {
          await deps.connector.start(runToken, bin);
          connector = 'started';
        } catch (err) {
          connector = 'failed';
          error ??= `cloudflared could not start: ${errMessage(err)}`;
        }
      }
    }
  }

  if (row && error && error !== row.lastError) await deps.store.recordError(error);
  return { listener, connector, adoptedOperatorPort, error };
}

/** Make this process match the row. Concurrent calls share one pass. Never throws. */
export async function reconcileOwnTunnel(deps: OwnTunnelDeps = defaultOwnTunnelDeps()): Promise<ReconcileResult> {
  if (state.reconcileInFlight) return state.reconcileInFlight;
  const run = reconcileOnce(deps)
    .catch((err): ReconcileResult => {
      const message = errMessage(err);
      if (message !== state.lastLoggedError) {
        state.lastLoggedError = message;
        console.warn('[own-tunnel] reconcile failed:', message);
      }
      return { listener: 'failed', connector: 'failed', adoptedOperatorPort: null, error: message };
    })
    .finally(() => {
      state.reconcileInFlight = null;
    });
  state.reconcileInFlight = run;
  return run;
}

/**
 * Arm the periodic reconciler (idempotent per process) and run one pass now. hono-host calls
 * it once the boot migration gate has passed, from every request-serving process and from
 * the cluster primary (which owns the connector).
 */
export function startOwnTunnelReconciler(deps?: OwnTunnelDeps): void {
  void reconcileOwnTunnel(deps);
  if (state.reconcilerArmed) return;
  state.reconcilerArmed = true;
  managedSetInterval(
    'own-tunnel-reconciler',
    OWN_TUNNEL_RECONCILE_INTERVAL_MS,
    async () => {
      await reconcileOwnTunnel(deps);
    },
    { category: 'watchdog' },
  );
}

/** Test seam: forget module state between cases. */
export function resetOwnTunnelServiceStateForTests(): void {
  state.seamConfigured = false;
  state.reconcilerArmed = false;
  state.reconcileInFlight = null;
  state.lastConnectorStartAt = 0;
  state.lastLoggedError = null;
}
