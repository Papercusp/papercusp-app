/**
 * hosted-workspace-host-runtime.ts — the composition root of the workspace-host
 * relay: the process-side thing that was MISSING (WI-1064431).
 *
 * `hosted-session-host.ts` had zero non-test importers, which meant the hosted PTY
 * relay and the P-013 desktop viewer were both libraries with no host. This module
 * is what constructs the adapter, gives it a transport, gives it a desktop plane,
 * and gives its audit seam somewhere to land.
 *
 * ## The lifetime is per-CONNECTION, not per-process
 *
 * An adapter is bound to one `HostedConnectorBinding`, and a binding carries a
 * `generation` that the control plane rotates. So the adapter is built when the
 * control plane sends `bound` and torn down when the socket drops — never reused
 * across a reconnect. Reusing one would let a rotated host keep serving channels
 * stamped with a superseded generation, which is precisely what the generation is
 * there to prevent.
 *
 * ## What is deliberately NOT here
 *
 * Enrollment. This runtime consumes a bearer that some earlier provisioning step
 * produced; obtaining one is an operator action with its own lifecycle. A revoked
 * bearer therefore ends the runtime (`onTerminal('revoked')`) rather than being
 * retried — see `hosted-connector-client.ts` for why retrying it is harmful.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import { DEFAULT_WORKSPACE_ID, activeWorkspaceId, ensureCurrentWorkspace } from '../workspace-registry';
import {
  listDesktopSessions,
  reconcileLocalDesktopSessions,
  touchDesktopSession,
} from '../desktop/desktop-session-registry';
import {
  ensureHiveDesktop,
  hiveDesktopSessionId,
  leasedDesktopBySessionId,
  leasedDesktopSessionIds,
  reapDeadDesktops,
} from '../agent-tools/computer/desktop-lease';
import { hostedDesktopAuditRow, recordDesktopAudit } from '../desktop/desktop-audit';
import { desktopThumbnailer } from '../desktop/desktop-thumbnail';
import { getActiveClaimForOwner } from '../work-item-claims';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';
import { configureAgentSpawnTransform } from '@papercusp/papercusp-shared/agent';
import { installHostedCustomerAgentIdentity } from './hosted-agent-identity';
import { createHostedDesktopBackend, type HostedDesktopBackendDeps } from './hosted-desktop-backend';
import {
  HostedWorkspaceHostSessionAdapter,
  type HostedDesktopBackend,
  type HostedHostAuditEvent,
  type HostedHostSessionHandoff,
  type HostedWorkspaceHostOptions,
} from './hosted-session-host';
import {
  HostedWorkspaceConnectorClient,
  HOSTED_CONNECTOR_SOCKET_PATH,
  type HostedConnectorTerminalReason,
} from './hosted-connector-client';

export interface HostedWorkspaceHostRuntimeOptions {
  /**
   * D-421: install the customer-account agent spawn transform at start. Defaults on; only
   * tests that construct a runtime without a customer account set it false.
   */
  installAgentIdentity?: boolean;
  /** Absolute control-plane socket URL. */
  url: string;
  /** The enrollment bearer this host registered with. */
  bearer: string;
  /** The one server-selected project root every file operation is confined to. */
  workspaceRoot: string;
  /**
   * Omit on a host with no desktop pack: a `kind:'desktop'` open is then REFUSED
   * rather than opening a channel that can never carry pixels.
   */
  desktop?: HostedDesktopBackend;
  onAudit?: (event: HostedHostAuditEvent) => void;
  onTerminal?: (reason: HostedConnectorTerminalReason, detail: string) => void;
  onWarning?: (message: string) => void;
  /**
   * Called with every binding BEFORE its adapter is built. The production default
   * (`ensureHostedWorkspaceHostRuntime`) is {@link registerHostedCustomerWorkspace}.
   * A throw is reported through `onWarning`, never fatal: a registry write failure
   * must not cost the customer their connector.
   */
  onBinding?: (binding: HostedConnectorBinding) => void;
  /**
   * P-328 (D-030 #4): the portal's relay usage for this workspace, sent on each relayed app
   * call. Defaults to {@link defaultRelayUsageReport}, which raises the relay-limit alert.
   */
  onRelayUsage?: (customerWorkspaceId: string, relayUsage: unknown) => void;
  /**
   * WI-10004257: the portal's report of this organization's removed members, already checked
   * against the binding's organization. Defaults to {@link defaultMembershipReport}, which stores
   * it for the connected-app creator-removed alert.
   */
  onMembershipReport?: (report: unknown) => void;
  /** Test seam — swap the transport. */
  createClient?: (options: ConstructorParameters<typeof HostedWorkspaceConnectorClient>[0]) => HostedWorkspaceConnectorClient;
  /** Test seam — swap the PTY factory every adapter this runtime builds uses. */
  createPty?: HostedWorkspaceHostOptions['createPty'];
  /**
   * The channel kinds every adapter this runtime builds serves. Absent on a Papercusp-hosted
   * machine (all kinds); a relay-linked local install passes LOCAL_RELAY_CHANNEL_KINDS (D-031 #7).
   */
  allowedChannelKinds?: HostedWorkspaceHostOptions['allowedChannelKinds'];
}

export interface HostedWorkspaceHostRuntime {
  start(): void;
  stop(reason?: string): void;
  /** The live adapter, or null while unbound. Observability + tests. */
  readonly adapter: HostedWorkspaceHostSessionAdapter | null;
  /** The binding the control plane last asserted, or null. */
  readonly binding: HostedConnectorBinding | null;
}

/**
 * The default audit sink: the workspace audit_log, same table the local lane writes.
 * This is the HOST's database; the control plane records its own copy of the desktop
 * events from the relay (WI-10004167).
 */
export function defaultHostedAudit(event: HostedHostAuditEvent): void {
  recordDesktopAudit(hostedDesktopAuditRow(event), {
    idPrefix: 'hosted-vnc',
    onError: (error) => console.warn('[hosted-workspace-host] audit write failed:', error),
  });
}

/**
 * The lease key of the one desktop a hosted workspace host serves (D-404).
 *
 * One key, not one per viewer: the connector binding scopes this host to ONE
 * customer workspace, so every viewer of it shares a desktop, and a second
 * `desktop.start` coalesces onto `ensureHiveDesktop`'s existing lease.
 */
export const HOSTED_WORKSPACE_DESKTOP_LEASE = 'hosted-workspace';

/**
 * The default relay-usage sink: the relay-limit alert on this operator's attention rail.
 * Loaded lazily so the runtime's static graph does not pull in the org database client.
 */
export function defaultRelayUsageReport(customerWorkspaceId: string, relayUsage: unknown): void {
  void import('../connected-apps/alert-sweep')
    .then(({ onRelayUsageReported }) => onRelayUsageReported(customerWorkspaceId, relayUsage))
    .catch((error) => console.warn('[hosted-workspace-host] relay usage report failed:', error));
}

/**
 * The default membership-report sink: store the portal's removed-member set on this machine
 * (WI-10004257), where the connected-app alert sweep reads it. Lazy for the same reason as
 * {@link defaultRelayUsageReport}.
 */
export function defaultMembershipReport(report: unknown): void {
  void import('../connected-apps/membership-report')
    .then(({ onMembershipReported }) => onMembershipReported(report))
    .catch((error) => console.warn('[hosted-workspace-host] membership report failed:', error));
}

/**
 * The desktop plane wired to this operator's real registry and lease map.
 *
 * Separate from `createHostedWorkspaceHostRuntime` so a host with no desktop pack —
 * or a test — can compose the runtime without pulling a registry dependency in.
 */
export function createDefaultDesktopBackend(
  workspaceId: string | (() => string),
  overrides: Partial<HostedDesktopBackendDeps> = {},
): HostedDesktopBackend {
  // A resolver, not a value, in production: the backend is composed at boot, BEFORE the
  // first `bound` registers this host's workspace (WI-10003163), so a value captured
  // here would pin every desktop row to whatever the registry said pre-registration.
  const scope = typeof workspaceId === 'function' ? workspaceId : () => workspaceId;
  return createHostedDesktopBackend({
    leasedDesktop: leasedDesktopBySessionId,
    // Not filtered by caller (D-025 ruling 2): the connector binding already scopes
    // this adapter to ONE organization + customer workspace, and that binding IS the
    // authorization boundary. A second, weaker filter here would imply it is not.
    listSessions: () => listDesktopSessions({ workspaceId: scope() }),
    touchSession: (id) => touchDesktopSession(id),
    // The desktop pack's socket service (D-363) is what `ensureHiveDesktop`
    // provisions through on a workspace host, so this needs no pack-specific code.
    ensureDesktop: async () => {
      await ensureHiveDesktop(HOSTED_WORKSPACE_DESKTOP_LEASE);
      return hiveDesktopSessionId(HOSTED_WORKSPACE_DESKTOP_LEASE);
    },
    // Sole owner by construction: a workspace host runs one operator, and its
    // desktops die with that operator's socket (D-363), so every row it holds no
    // lease for was left by a previous incarnation of it (WI-10002797).
    reconcile: async () => {
      // A lease whose desktop died is not live, whatever the map still holds (WI-10004206):
      // release it first, which closes its row, so the roster stops offering it.
      // EVERY live lease vouches for its row — agent desktops included (D-012). Listing
      // only the shared pot lease here made the sole-owner sweep below mark each
      // agent-started desktop dead on the next reconcile while it was still running.
      const dead = await reapDeadDesktops();
      const liveIds = leasedDesktopSessionIds();
      return dead.length + (await reconcileLocalDesktopSessions({ workspaceId: scope(), liveIds, soleOwner: true })).reaped;
    },
    // P-005 / D-008: an agent-started desktop is absent from the bootstrap-time capture
    // loop's display list, so its thumbnail is grabbed on demand by the grid read.
    grabThumbnail: (display) => desktopThumbnailer().thumbnail(display),
    // D-009: the tile's work-item label is the owner's live claim, read now.
    activeClaimFor: async (owner) => {
      const claim = await getActiveClaimForOwner(scope(), owner);
      return claim ? { workItemId: claim.workItemId, intent: claim.intent || null } : null;
    },
    ...overrides,
  });
}

export function createHostedWorkspaceHostRuntime(
  options: HostedWorkspaceHostRuntimeOptions,
): HostedWorkspaceHostRuntime {
  const onAudit = options.onAudit ?? defaultHostedAudit;
  const warn = options.onWarning ?? ((message: string) => console.warn(`[hosted-workspace-host] ${message}`));
  let adapter: HostedWorkspaceHostSessionAdapter | null = null;
  let binding: HostedConnectorBinding | null = null;
  // PTY sessions a dropped connector released ALIVE, waiting for the next `bound` to adopt them
  // (P-318 J5, D-392). A Papercusp outage must not kill the customer's running processes.
  let parked: HostedHostSessionHandoff[] = [];

  // Terminal (revoked / stopped): access ends, so every PTY dies, held ones included.
  const teardown = (reason: string): void => {
    adapter?.close(reason);
    adapter = null;
    for (const handoff of parked) handoff.kill();
    parked = [];
  };

  // Transient (connector dropped, or rebinding): channels close, PTYs survive.
  const release = (reason: string): void => {
    if (!adapter) return;
    parked.push(adapter.release(reason));
    adapter = null;
  };

  const clientOptions: ConstructorParameters<typeof HostedWorkspaceConnectorClient>[0] = {
    url: options.url,
    bearer: options.bearer,
    onEnvelope: (envelope) => {
      // Envelopes arriving before `bound` have no binding to be audited against, so
      // they are dropped rather than served by an adapter with a guessed identity.
      if (!adapter) return;
      void adapter.accept(envelope).catch((error) => warn(`envelope failed: ${String(error)}`));
    },
    onBound: (next) => {
      // Every (re)connect rebuilds. See the header: a binding carries a rotatable
      // generation, and an adapter outliving its binding would stamp channels with
      // a superseded one. The PTY SESSIONS are not the adapter's to lose, though:
      // the new adapter adopts them (same connector identity only).
      release('rebinding');
      binding = next;
      try {
        options.onBinding?.(next);
      } catch (error) {
        warn(`binding hook failed: ${String(error)}`);
      }
      adapter = new HostedWorkspaceHostSessionAdapter({
        binding: next,
        workspaceRoot: options.workspaceRoot,
        send: (message) => {
          if (!client.send(message)) warn(`dropped outbound ${message.type} — connector down`);
        },
        onAudit,
        onWarning: warn,
        onRelayUsage: (relayUsage) => (options.onRelayUsage ?? defaultRelayUsageReport)(next.customerWorkspaceId, relayUsage),
        onMembershipReport: options.onMembershipReport ?? defaultMembershipReport,
        ...(options.desktop ? { desktop: options.desktop } : {}),
        ...(options.createPty ? { createPty: options.createPty } : {}),
        ...(options.allowedChannelKinds ? { allowedChannelKinds: options.allowedChannelKinds } : {}),
      });
      for (const handoff of parked) adapter.adopt(handoff);
      parked = [];
    },
    onDisconnect: (reason) => release(`connector_closed: ${reason}`),
    onTerminal: (reason, detail) => {
      teardown(`connector_${reason}`);
      binding = null;
      options.onTerminal?.(reason, detail);
    },
  };

  const client = (options.createClient ?? ((value) => new HostedWorkspaceConnectorClient(value)))(clientOptions);

  return {
    start: () => client.start(),
    stop: (reason = 'host_stopped') => client.stop(reason),
    get adapter() {
      return adapter;
    },
    get binding() {
      return binding;
    },
  };
}

/**
 * The one runtime this process runs, pinned to `globalThis`.
 *
 * Pinned rather than a bare module-scoped `let` for the reason `@papercusp/module-singleton`
 * exists: several ordinary loader seams here produce two module records, and two
 * records would mean two outbound connectors dialling the control plane under ONE
 * enrollment — which the broker would see as a connector replacing itself in a loop,
 * not as an error anyone gets told about.
 */
const started = pinModuleState<{ runtime: HostedWorkspaceHostRuntime | null }>(
  '@papercusp/operator-core.hosted-workspace-host-runtime',
  () => ({ runtime: null }),
);

/**
 * Start this host's connector if it is an enrolled hosted workspace. Idempotent.
 *
 * Returns null when unenrolled, which is the NORMAL answer on a dev box, on the
 * control plane, and on every non-BYOC operator — so callers treat null as "nothing
 * to do", never as a failure.
 *
 * ⚠ CALL THIS FROM A PRIMARY-ONLY BOOT PATH. A forked request worker inherits the
 * environment, so an unguarded call would open one connector PER worker (17 on the
 * :3070 release cluster) against a single-connector-per-binding broker.
 */
export function ensureHostedWorkspaceHostRuntime(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<HostedWorkspaceHostRuntimeOptions> = {},
): HostedWorkspaceHostRuntime | null {
  if (started.runtime) return started.runtime;
  const config = readHostedWorkspaceHostConfig(env);
  if (!config) return null;
  // D-421: customer-driven agent CLIs (chat brain, New Session) run as the customer
  // workspace account, never as this service account. Only a hosted host installs it.
  if (overrides.installAgentIdentity !== false && process.platform === 'linux') {
    installHostedCustomerAgentIdentity();
  }
  const runtime = createHostedWorkspaceHostRuntime({
    ...config,
    onBinding: registerHostedCustomerWorkspace,
    ...(overrides.desktop === undefined
      ? { desktop: createDefaultDesktopBackend(activeWorkspaceId) }
      : { desktop: overrides.desktop }),
    ...overrides,
  });
  started.runtime = runtime;
  runtime.start();
  return runtime;
}

/** Display name, matching the desktop's fresh-install workspace (workspaces.rs ensure_initialized). */
export const HOSTED_CUSTOMER_WORKSPACE_NAME = 'Default';

/** The id becomes a directory under the workspaces root, so only a plain slug is accepted. */
const WORKSPACE_ID_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Make the bound customer workspace this operator's registered, current workspace (WI-10003163).
 *
 * A hosted host has no desktop shell, so nothing ran the desktop's first-run
 * `ensure_initialized()`: the registry stayed empty, New Session listed no workspace, and
 * every unscoped write fell through to the literal `'default'`, which fails closed as the
 * p2p coordination sentinel (WI-5321 / WI-1564). The binding names exactly one customer
 * workspace, and the operator-http relay deliberately forwards no workspace header because
 * "this operator serves exactly one workspace — its own pin is the only right scope"; this
 * is where that pin is set. Idempotent on every rebind.
 *
 * Throws on an id that is not a plain slug rather than joining it into a filesystem path.
 */
export function registerHostedCustomerWorkspace(binding: HostedConnectorBinding): void {
  const id = binding.customerWorkspaceId;
  if (!WORKSPACE_ID_SLUG.test(id) || id === DEFAULT_WORKSPACE_ID) {
    throw new Error(`refusing to register hosted customer workspace id ${JSON.stringify(id)}: not a plain workspace slug`);
  }
  ensureCurrentWorkspace(id, HOSTED_CUSTOMER_WORKSPACE_NAME);
}

/** Test seam — drop the pinned runtime so a suite can start a fresh one. */
export function __resetHostedWorkspaceHostRuntime(): void {
  started.runtime?.stop('test_reset');
  started.runtime = null;
  configureAgentSpawnTransform(undefined);
}

export interface HostedWorkspaceHostEnvironmentConfig {
  url: string;
  bearer: string;
  workspaceRoot: string;
}

/**
 * Read the runtime's configuration from the environment, or null when this host is
 * not an enrolled hosted workspace.
 *
 * Null is the NORMAL answer on a local dev box and on the control plane itself.
 * Absence of an enrollment is not a misconfiguration, so it must not warn or throw
 * — a host that is not enrolled simply does not dial.
 */
export function readHostedWorkspaceHostConfig(
  env: NodeJS.ProcessEnv = process.env,
): HostedWorkspaceHostEnvironmentConfig | null {
  const bearer = env.PAPERCUSP_HOSTED_CONNECTOR_BEARER?.trim();
  const base = env.PAPERCUSP_HOSTED_CONTROL_PLANE_URL?.trim();
  const workspaceRoot = env.PAPERCUSP_HOSTED_WORKSPACE_ROOT?.trim();
  if (!bearer || !base || !workspaceRoot) return null;
  let url: string;
  try {
    const parsed = new URL(base);
    // Accept either a bare origin or a full socket URL, and normalise https→wss so
    // a caller cannot accidentally configure a cleartext transport for a bearer.
    parsed.protocol = parsed.protocol === 'http:' || parsed.protocol === 'ws:' ? 'ws:' : 'wss:';
    if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = HOSTED_CONNECTOR_SOCKET_PATH;
    url = parsed.toString();
  } catch {
    return null;
  }
  return { url, bearer, workspaceRoot };
}
