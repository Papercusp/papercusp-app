/** Generation-bound relay between one outbound workspace connector and browser sessions. */
import { randomUUID } from 'node:crypto';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { parseHostedPsuCustomerArgv } from '../workspace-host/hosted-psu-session';
import { HOSTED_RELAY_FRAME_REGISTRY } from '../workspace-host/hosted-relay-confidentiality-registry';
import { byocSealedContentType, isByocSealedPacket } from '../workspace-host/byoc-sealed-channel';
import type {
  HostedConnectorBinding,
  HostedConnectorTicketBinding,
} from './hosted-workspace-connector';
import type {
  AppRelayChannel,
  AppRelayChannelKind,
  AppRelayConnector,
  AppRelayOpenOptions,
  AppRelayPort,
} from '../workspace-host/hosted-app-relay';

export const HOSTED_WORKSPACE_SESSION_PROTOCOL = 'papercusp-hosted-workspace.v1';
export const HOSTED_WORKSPACE_MAX_MESSAGE_BYTES = 1024 * 1024;
export const HOSTED_WORKSPACE_SESSION_IDLE_MS = 15 * 60_000;
/**
 * WebSocket ping cadence for every relay socket (P-001,
 * psu-cloud-connector-liveness-multi-signin-2026-09-29).
 *
 * Two jobs. The traffic keeps idle timers on the path from expiring: Cloudflare
 * closes an idle proxied WebSocket after ~100s and Cloud NAT drops an idle
 * mapping after 20 minutes. And a socket that has not answered the previous
 * ping by the next sweep is dead, so it is terminated instead of lingering
 * half-open (avi-test, 2026-09-29: the VM believed it was connected for hours
 * while this broker had no connector). `ws` answers pings automatically, so
 * already-deployed workspace hosts need no change.
 */
export const HOSTED_WORKSPACE_PING_INTERVAL_MS = 30_000;

export type HostedWorkspaceTabRole = 'controller' | 'observer';

/** The narrow WebSocket surface used by the broker; `ws.WebSocket` satisfies it. */
export interface HostedWorkspaceRelaySocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string | Buffer, options?: { binary?: boolean }): unknown;
  close(code?: number, reason?: string): unknown;
  /** Liveness probe. A socket without it is never pinged or reaped. */
  ping?(): unknown;
  /** Drop the connection without a closing handshake (the peer is presumed gone). */
  terminate?(): unknown;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close' | 'error' | 'pong', listener: () => void): unknown;
}

export interface HostedWorkspaceSessionAuditEvent {
  action: string;
  /** The control-plane workspace the binding belongs to; where a persisted row lands. */
  controlPlaneWorkspaceId: string;
  organizationId: string;
  customerWorkspaceId: string;
  hostId: string;
  generation: number;
  userId?: string;
  hostedSessionId?: string;
  channelId?: string;
  detail?: string;
}

export interface HostedWorkspaceSessionBrokerOptions {
  idleMs?: number;
  maxMessageBytes?: number;
  randomId?: () => string;
  onAudit?: (event: HostedWorkspaceSessionAuditEvent) => void;
  /**
   * What this broker observed about a connector socket: `true` when it attaches and
   * on every pong, `false` when the current socket for that generation goes away.
   * The host persists it as `heartbeat_at`, which is what `reachable` reads.
   */
  onConnectorLiveness?: (binding: HostedConnectorBinding, alive: boolean) => void;
  /** Ping cadence; `0` arms no timer (callers then drive `sweepLiveness()` themselves). */
  pingIntervalMs?: number;
  /** Clock for connector last-seen stamps (the app relay's offline check). */
  now?: () => number;
  /**
   * WI-10004257: the `membership.report` frame for a connector's organization — the addresses
   * whose membership in it is no longer active — or null to send nothing. Sent after `bound`,
   * then re-read every `membershipRefreshMs` and re-sent only when it changed. Absent: no
   * reports (tests and hosts without the membership tables).
   */
  membershipReport?: (binding: HostedConnectorBinding) => Promise<unknown | null>;
  /** Re-read cadence for `membershipReport`, driven by the liveness sweep. */
  membershipRefreshMs?: number;
}

/** How often the broker re-reads each organization's membership report (WI-10004257). */
export const HOSTED_MEMBERSHIP_REFRESH_MS = 5 * 60_000;

type LivenessEntry = { awaitingPong: boolean; connector: HostedConnectorBinding | null };

/**
 * What a browser attached to. `role` says WHO they are; this says WHAT they carry.
 *
 * `operator-http` (D-418, WI-10002873) carries the portal's operator REST + SSE
 * traffic to the workspace machine's OWN loopback operator. Its client is the
 * portal backend acting for the ticket's user; nothing ever dials a VM address.
 */
export type HostedWorkspaceChannelKind = 'pty' | 'psu' | 'desktop' | 'operator-http' | 'app-http' | 'app-key-mint';

/**
 * A terminal channel: the customer's shell (`pty`), or psu started by the host (`psu`, D-002).
 * Both carry the same PTY frames, so role election and control claims treat them alike.
 */
function isTerminalKind(kind: HostedWorkspaceChannelKind): boolean {
  return kind === 'pty' || kind === 'psu';
}

/**
 * Client→host frames an `app-key-mint` channel may carry: the one mint request of a consented MCP
 * OAuth grant (P-325, D-021), or the one relayed client-credentials token request (P-016, D-022).
 */
export const APP_KEY_MINT_CLIENT_TYPES: ReadonlySet<string> = new Set(['mint.request', 'token.request']);

/**
 * Client→host frames an `operator-http` channel may carry; everything else is refused.
 * A request body travels whole inside `http.request` (the host bounds it well under
 * the message cap — `hosted-operator-http.ts`), so there is no client body frame.
 */
export const OPERATOR_HTTP_CLIENT_TYPES: ReadonlySet<string> = new Set(['http.request', 'http.abort']);

/** True for any frame of the operator-http family (either direction). */
function isOperatorHttpType(type: string): boolean {
  return type.startsWith('http.');
}

/**
 * What the browser asked for on its upgrade (P-013 / D-023 ruling 4).
 *
 * Absent means a PTY, which is what every pre-P-013 client sends. The default is
 * part of the wire contract, not a shim: the browser SPA and the control plane ship
 * independently, so an upgrade from an older client must keep opening terminals.
 */
export interface HostedWorkspaceAttachRequest {
  kind?: HostedWorkspaceChannelKind;
  /** Required for `kind:'desktop'`; the session the viewer picked off the roster. */
  desktopSessionId?: string;
  /**
   * `watch` (default) or `takeover`. EXPLICIT for a desktop, never elected by
   * arrival order — see the role note in `attachBrowser`.
   */
  desktopMode?: 'watch' | 'takeover';
  /**
   * `kind:'psu'` only: psu's arguments, as the client sent them. Unparsed on purpose: the broker
   * checks them against the D-002 allowlist and refuses the attach, rather than a malformed list
   * quietly becoming an empty one.
   */
  argv?: unknown;
  /** The browser has an independently pinned Noise peer and will send only sealed packets. */
  sealed?: boolean;
}

type BrowserSession = {
  channelId: string;
  /** A ticket binding for a browser; the connector's own binding for an `app-http` channel. */
  binding: HostedConnectorTicketBinding | HostedConnectorBinding;
  socket: HostedWorkspaceRelaySocket;
  role: HostedWorkspaceTabRole;
  kind: HostedWorkspaceChannelKind;
  /** The desktop this channel was opened for — the broker's copy, never the host's. */
  desktopSessionId: string | null;
  /** Set once the host's `desktop.ready` has been audited, so a repeat is not a second start. */
  desktopStartAudited: boolean;
  connectorKey: string;
  controllerKey: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  sealed: boolean;
};

function connectorKey(binding: Pick<HostedConnectorBinding,
  'controlPlaneWorkspaceId' | 'organizationId' | 'customerWorkspaceId' | 'hostId' | 'generation'>): string {
  return JSON.stringify([
    binding.controlPlaneWorkspaceId,
    binding.organizationId,
    binding.customerWorkspaceId,
    binding.hostId,
    binding.generation,
  ]);
}

function controllerKey(binding: HostedConnectorTicketBinding): string {
  return `${connectorKey(binding)}\u0000${binding.hostedSessionId ?? ''}`;
}

function byteLength(data: unknown): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return Number.POSITIVE_INFINITY;
}

function text(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return null;
}

function open(socket: HostedWorkspaceRelaySocket): boolean {
  return socket.readyState === socket.OPEN;
}

function sendJson(socket: HostedWorkspaceRelaySocket, value: unknown): boolean {
  if (!open(socket)) return false;
  try {
    socket.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function payloadType(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

const CONTROLLER_ONLY = new Set([
  'pty.input',
  'pty.resize',
  'pty.signal',
  'pty.kill',
  'file.write',
  'file.upload',
]);

/**
 * In-process relay state belongs beside the hosted HTTP upgrade listener. The
 * workspace host remains outbound-only: browsers never dial a VM address and
 * connector credentials never enter the browser principal chain.
 */
export class HostedWorkspaceSessionBroker implements AppRelayPort {
  private readonly connectors = new Map<string, HostedWorkspaceRelaySocket>();
  /** The binding and last proof of life of each attached connector (app relay, P-007). */
  private readonly connectorState = new Map<string, { binding: HostedConnectorBinding; lastSeenAt: number }>();
  private readonly now: () => number;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly controllers = new Map<string, string>();
  private readonly idleMs: number;
  private readonly maxMessageBytes: number;
  private readonly randomId: () => string;
  private readonly onAudit: (event: HostedWorkspaceSessionAuditEvent) => void;
  private readonly onConnectorLiveness: (binding: HostedConnectorBinding, alive: boolean) => void;
  private readonly liveness = new Map<HostedWorkspaceRelaySocket, LivenessEntry>();
  private readonly pingTimer: ManagedHandle | null;
  private readonly membershipReport: ((binding: HostedConnectorBinding) => Promise<unknown | null>) | null;
  private readonly membershipRefreshMs: number;
  /** The last membership frame sent on each connector socket, serialized. */
  private readonly membershipSent = new WeakMap<HostedWorkspaceRelaySocket, string>();
  private lastMembershipRefreshAt: number;

  constructor(options: HostedWorkspaceSessionBrokerOptions = {}) {
    this.idleMs = options.idleMs ?? HOSTED_WORKSPACE_SESSION_IDLE_MS;
    this.maxMessageBytes = options.maxMessageBytes ?? HOSTED_WORKSPACE_MAX_MESSAGE_BYTES;
    this.randomId = options.randomId ?? randomUUID;
    this.onAudit = options.onAudit ?? (() => {});
    this.onConnectorLiveness = options.onConnectorLiveness ?? (() => {});
    this.now = options.now ?? Date.now;
    this.membershipReport = options.membershipReport ?? null;
    this.membershipRefreshMs = options.membershipRefreshMs ?? HOSTED_MEMBERSHIP_REFRESH_MS;
    this.lastMembershipRefreshAt = this.now();
    const pingIntervalMs = options.pingIntervalMs ?? HOSTED_WORKSPACE_PING_INTERVAL_MS;
    this.pingTimer = pingIntervalMs > 0
      ? managedSetInterval('hosted-relay-liveness', pingIntervalMs, () => this.sweepLiveness(), {
          category: 'lifecycle',
          classification: 'must-sample',
          instanced: true,
        })
      : null;
  }

  /** Stop the ping timer. Sockets stay as they are. */
  dispose(): void {
    this.pingTimer?.stop();
  }

  /**
   * One liveness pass: terminate every socket that has not answered the previous
   * ping (its `close` handler then detaches it), and ping the rest. Public so tests
   * and hosts without a timer can drive it deterministically.
   */
  sweepLiveness(): void {
    for (const [socket, entry] of [...this.liveness]) {
      if (!open(socket)) continue;
      if (entry.awaitingPong) {
        this.liveness.delete(socket);
        if (entry.connector) this.audit(entry.connector, 'connector_heartbeat_missed');
        try {
          if (socket.terminate) socket.terminate();
          else socket.close(4408, 'heartbeat_timeout');
        } catch {
          // Already gone; its close handler (if any) does the rest.
        }
        continue;
      }
      entry.awaitingPong = true;
      try {
        socket.ping?.();
      } catch {
        // A socket that cannot even be pinged is reaped on the next sweep.
      }
    }
    if (this.membershipReport && this.now() - this.lastMembershipRefreshAt >= this.membershipRefreshMs) {
      void this.refreshMembership();
    }
  }

  /**
   * Re-read the membership report of every attached connector's organization, once per
   * organization, and send it to each of that organization's connectors whose last report differs
   * (WI-10004257). Public so tests and hosts without a timer can drive it.
   */
  async refreshMembership(): Promise<void> {
    if (!this.membershipReport) return;
    this.lastMembershipRefreshAt = this.now();
    const byOrganization = new Map<string, Array<{ binding: HostedConnectorBinding; socket: HostedWorkspaceRelaySocket }>>();
    for (const [key, state] of this.connectorState) {
      const socket = this.connectors.get(key);
      if (!socket || !open(socket)) continue;
      const list = byOrganization.get(state.binding.organizationId) ?? [];
      list.push({ binding: state.binding, socket });
      byOrganization.set(state.binding.organizationId, list);
    }
    await Promise.all([...byOrganization.values()].map(async (connectors) => {
      const frame = await this.loadMembershipFrame(connectors[0].binding);
      if (frame) for (const { socket } of connectors) this.sendMembershipFrame(socket, frame);
    }));
  }

  /** The serialized report for one binding, or null when there is none or the read failed. */
  private async loadMembershipFrame(binding: HostedConnectorBinding): Promise<string | null> {
    if (!this.membershipReport) return null;
    try {
      const frame = await this.membershipReport(binding);
      return frame ? JSON.stringify(frame) : null;
    } catch (error) {
      console.warn(
        `[hosted-relay] could not read the membership report for organization ${binding.organizationId}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  private sendMembershipFrame(socket: HostedWorkspaceRelaySocket, frame: string): void {
    if (this.membershipSent.get(socket) === frame || !open(socket)) return;
    try {
      socket.send(frame);
      this.membershipSent.set(socket, frame);
    } catch {
      // The socket is going away; its replacement gets a fresh report after `bound`.
    }
  }

  /** Enrol a socket in the ping sweep. Any inbound frame counts as proof of life. */
  private watchLiveness(socket: HostedWorkspaceRelaySocket, connector: HostedConnectorBinding | null): void {
    if (typeof socket.ping !== 'function') return;
    const entry: LivenessEntry = { awaitingPong: false, connector };
    this.liveness.set(socket, entry);
    socket.on('pong', () => {
      entry.awaitingPong = false;
      if (connector && this.liveness.get(socket) === entry) this.onConnectorLiveness(connector, true);
    });
    socket.on('message', () => { entry.awaitingPong = false; });
    const forget = () => { if (this.liveness.get(socket) === entry) this.liveness.delete(socket); };
    socket.on('close', forget);
    socket.on('error', forget);
  }

  attachConnector(binding: HostedConnectorBinding, socket: HostedWorkspaceRelaySocket): () => void {
    const key = connectorKey(binding);
    const previous = this.connectors.get(key);
    if (previous && previous !== socket) previous.close(4002, 'connector_replaced');
    this.connectors.set(key, socket);
    const state = { binding, lastSeenAt: this.now() };
    this.connectorState.set(key, state);
    const seen = () => { if (this.connectorState.get(key) === state) state.lastSeenAt = this.now(); };
    socket.on('pong', seen);
    sendJson(socket, { type: 'bound', role: 'connector', protocol: HOSTED_WORKSPACE_SESSION_PROTOCOL, binding });
    // After `bound`: the machine builds its adapter on `bound`, and drops frames that arrive before it.
    if (this.membershipReport) {
      void this.loadMembershipFrame(binding).then((frame) => {
        if (frame && this.connectors.get(key) === socket) this.sendMembershipFrame(socket, frame);
      });
    }
    this.audit(binding, 'connector_attached');
    this.watchLiveness(socket, binding);
    this.onConnectorLiveness(binding, true);

    const onMessage = (data: unknown, isBinary: boolean) => {
      seen();
      if (isBinary || byteLength(data) > this.maxMessageBytes) {
        socket.close(4400, 'invalid_connector_message');
        return;
      }
      const raw = text(data);
      if (!raw) return;
      let message: { type?: string; channelId?: string; payload?: unknown; reason?: string };
      try { message = JSON.parse(raw) as typeof message; } catch { return; }
      if (binding.hosting === 'byoc' && message.type !== 'relay' && message.type !== 'relay.close') {
        // A connector cannot add new control traffic by naming a frame type. Audit
        // only a known type name; an unknown string may itself contain content.
        const frame = typeof message.type === 'string' ? HOSTED_RELAY_FRAME_REGISTRY[message.type] : undefined;
        this.audit(binding, 'byoc_control_frame_dropped', undefined,
          frame?.sensitivity === 'control' ? message.type : 'unknown');
        return;
      }
      if (message.type !== 'relay' && message.type !== 'relay.close') return;
      if (typeof message.channelId !== 'string') return;
      const session = this.sessions.get(message.channelId);
      if (!session || session.connectorKey !== key) return;
      this.touch(session);
      if (message.type === 'relay.close') {
        this.closeSession(session, 4000, message.reason ?? 'host_closed', false);
        return;
      }
      if (session.kind === 'desktop') this.auditDesktopReady(session, message.payload);
      sendJson(session.socket, message.payload);
    };
    const onClose = () => {
      if (this.connectors.get(key) !== socket) return;
      this.connectors.delete(key);
      if (this.connectorState.get(key) === state) this.connectorState.delete(key);
      for (const session of [...this.sessions.values()]) {
        if (session.connectorKey === key) this.closeSession(session, 4412, 'connector_disconnected', false);
      }
      this.audit(binding, 'connector_detached');
      this.onConnectorLiveness(binding, false);
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', onClose);
    return onClose;
  }

  /**
   * The app relay's view of a workspace's connector (P-007): the attached one with
   * the most recent proof of life, or null. Staleness is the caller's call, through
   * the one reachability predicate (`isHostedConnectorLive`).
   */
  appConnector(customerWorkspaceId: string): AppRelayConnector | null {
    let best: { binding: HostedConnectorBinding; lastSeenAt: number } | null = null;
    for (const [key, state] of this.connectorState) {
      const socket = this.connectors.get(key);
      if (state.binding.customerWorkspaceId !== customerWorkspaceId || !socket || !open(socket)) continue;
      if (!best || state.lastSeenAt > best.lastSeenAt) best = state;
    }
    return best ? { binding: best.binding, lastSeenAt: new Date(best.lastSeenAt) } : null;
  }

  /**
   * Open a one-request `app-http` channel to a connector (P-007). There is no browser
   * socket: the portal's own handler is the client, so its frames are delivered to
   * `handlers` in-process. The channel carries only `http.request` / `http.abort`, and
   * the machine opens it with no ticket user — the app's key is the credential.
   */
  openAppChannel(
    connector: AppRelayConnector,
    handlers: { onFrame: (payload: Record<string, unknown>) => void; onClose: (reason: string) => void },
    kind: AppRelayChannelKind = 'app-http',
    openOptions: AppRelayOpenOptions = {},
  ): AppRelayChannel | null {
    // Each kind carries only its own client frames: an app call's http.* pair, or the one
    // mint.request (P-325) / token.request (P-016) of the key channel. The machine fences both too.
    const clientTypes = kind === 'app-key-mint' ? APP_KEY_MINT_CLIENT_TYPES : OPERATOR_HTTP_CLIENT_TYPES;
    const key = connectorKey(connector.binding);
    const connectorSocket = this.connectors.get(key);
    const state = this.connectorState.get(key);
    if (!connectorSocket || !open(connectorSocket) || !state) return null;
    // The portal has no customer-held content key. A BYOC app channel is admitted
    // only when the outside app itself owns a pinned peer and hands us opaque
    // packets; the ordinary portal relay remains refused.
    const sealed = state.binding.hosting === 'byoc' && openOptions.sealed === true;
    if (state.binding.hosting === 'byoc' && !sealed) return null;
    const channelId = this.randomId();
    let closed = false;
    const socket: HostedWorkspaceRelaySocket = {
      OPEN: 1,
      get readyState() { return closed ? 3 : 1; },
      send(data) {
        const raw = text(data);
        if (!raw) return;
        let payload: unknown;
        try { payload = JSON.parse(raw); } catch { return; }
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) handlers.onFrame(payload as Record<string, unknown>);
      },
      close(_code, reason) {
        if (closed) return;
        closed = true;
        handlers.onClose(reason ?? 'closed');
      },
      on() { return undefined; },
    };
    const session: BrowserSession = {
      channelId,
      binding: state.binding,
      socket,
      role: 'controller',
      kind,
      desktopSessionId: null,
      desktopStartAudited: false,
      connectorKey: key,
      controllerKey: `${key}\u0000app:${channelId}`,
      idleTimer: null,
      closed: false,
      sealed,
    };
    this.sessions.set(channelId, session);
    this.touch(session);
    sendJson(connectorSocket, {
      type: 'relay.open',
      channelId,
      kind,
      audience: kind === 'app-key-mint' ? 'portal-oauth' : 'app',
      role: 'controller',
      // P-328: this month's relay usage (counts only), so the machine can raise the limit alert.
      ...(kind === 'app-http' && openOptions.relayUsage ? { relayUsage: openOptions.relayUsage } : {}),
      ...(sealed ? { sealed: true } : {}),
    });
    this.audit(state.binding, 'app_relay_opened', channelId);
    return {
      send: (payload) => {
        if (session.closed || (sealed && !isByocSealedPacket(payload))) return false;
        const type = sealed ? byocSealedContentType(payload) : payloadType(payload);
        if (type !== null && !clientTypes.has(type)) return false;
        const live = this.connectors.get(key);
        if (!live) return false;
        this.touch(session);
        return sendJson(live, { type: 'relay', channelId, payload });
      },
      close: (reason) => this.closeSession(session, 1000, reason, true),
    };
  }

  attachBrowser(
    binding: HostedConnectorTicketBinding,
    socket: HostedWorkspaceRelaySocket,
    attach: HostedWorkspaceAttachRequest = {},
  ): () => void {
    const key = connectorKey(binding);
    const connector = this.connectors.get(key);
    if (!connector || !open(connector)) {
      socket.close(4411, 'connector_unavailable');
      return () => {};
    }
    if (binding.kind !== 'session' || binding.transport !== 'websocket' || binding.state !== 'active' ||
        binding.audience !== 'workspace-operator' || !binding.userId || !binding.hostedSessionId) {
      socket.close(4403, 'session_binding_invalid');
      return () => {};
    }
    // Trust the connector's server-classified hosting mode, not a ticket or attach
    // parameter. No plaintext content channel may reach a customer-account VM.
    const byoc = this.connectorState.get(key)?.binding.hosting === 'byoc';
    if (byoc && attach.sealed !== true) {
      sendJson(socket, {
        type: 'session.denied',
        reason: 'byoc_plaintext_relay_refused',
        alternatives: ['customer_controlled_ingress', 'sealed_channel'],
      });
      socket.close(4403, 'byoc_plaintext_relay_refused');
      return () => {};
    }
    const kind: HostedWorkspaceChannelKind =
      attach.kind === 'desktop' || attach.kind === 'operator-http' || attach.kind === 'psu' ? attach.kind : 'pty';
    const desktopSessionId = kind === 'desktop' ? attach.desktopSessionId : undefined;
    // The host checks the same allowlist again; refusing here too means a bad argument never
    // reaches the machine, and the client learns why on the socket it opened.
    const psuArgv = kind === 'psu' ? parseHostedPsuCustomerArgv(attach.argv) : null;
    if (psuArgv && !psuArgv.ok) {
      socket.close(4403, 'psu_argv_refused');
      return () => {};
    }
    // Refused rather than defaulted: a desktop channel with no session id can never
    // carry pixels, and opening one anyway would surface as a blank viewer instead
    // of an error the user can act on.
    if (kind === 'desktop' && !desktopSessionId) {
      socket.close(4403, 'desktop_session_required');
      return () => {};
    }

    const channelId = this.randomId();
    const controlKey = controllerKey(binding);
    /**
     * ROLE, and why the two kinds decide it differently.
     *
     * PTY keeps arrival-order election: one terminal has one writer, so the first
     * tab drives and later ones observe until they claim control.
     *
     * DESKTOP must NOT be elected. Two independent reasons:
     *  1. Role IS the credential (D-024 ruling 1) — `controller` dials KasmVNC as
     *     the `-w` user. Electing the first arrival controller would hand INPUT to a
     *     user who asked only to watch, silently, because they happened to be first.
     *  2. Watch and takeover are explicitly CONCURRENT — `x-server-backend.ts` passes
     *     `-AlwaysShared 1` with the note that the pairing IS the feature. So a
     *     desktop channel never enters `controllers`: demoting a second viewer to
     *     observer because someone else is already watching would contradict the
     *     server we started.
     */
    // operator-http is a request channel, not a shared screen: there is no second
    // viewer to demote, so it is always `controller` and never enters `controllers`.
    const role: HostedWorkspaceTabRole =
      kind === 'desktop'
        ? (attach.desktopMode === 'takeover' ? 'controller' : 'observer')
        : kind === 'operator-http'
          ? 'controller'
          : this.controllers.has(controlKey) ? 'observer' : 'controller';
    const session: BrowserSession = {
      channelId,
      binding,
      socket,
      role,
      kind,
      desktopSessionId: desktopSessionId ?? null,
      desktopStartAudited: false,
      connectorKey: key,
      controllerKey: controlKey,
      idleTimer: null,
      closed: false,
      sealed: byoc,
    };
    this.sessions.set(channelId, session);
    if (isTerminalKind(kind) && role === 'controller') this.controllers.set(controlKey, channelId);
    this.touch(session);
    this.watchLiveness(socket, null);
    sendJson(socket, {
      type: 'session.bound',
      protocol: HOSTED_WORKSPACE_SESSION_PROTOCOL,
      channelId,
      role,
      // Echoed so a client that asked for a non-PTY kind can verify it got one:
      // an OLDER control plane degrades an unknown kind to a PTY, and an
      // operator-http client talking to a terminal must fail loudly instead.
      kind,
      binding: {
        organizationId: binding.organizationId,
        customerWorkspaceId: binding.customerWorkspaceId,
        hostId: binding.hostId,
        generation: binding.generation,
        hostedSessionId: binding.hostedSessionId,
      },
    });
    sendJson(connector, {
      type: 'relay.open',
      channelId,
      userId: binding.userId,
      hostedSessionId: binding.hostedSessionId,
      audience: binding.audience,
      role,
      // P-013 / D-023 ruling 4. Sent only for a desktop: the host treats an absent
      // `kind` as 'pty', and a workspace host runs on a pinned generation in the
      // customer's VM, so an envelope this control plane mints must keep opening
      // terminals on a host that predates the discriminator.
      // A psu open is sent with its kind; a host that predates it answers `channel_kind_unknown`
      // (or, older still, nothing), never a shell.
      ...(kind === 'desktop'
        ? { kind, desktopSessionId }
        : kind === 'operator-http'
          ? { kind }
          : psuArgv?.ok
            ? { kind, argv: psuArgv.argv }
            : {}),
      ...(byoc ? { sealed: true } : {}),
    });
    this.audit(binding, 'browser_attached', channelId, role);

    const onMessage = (data: unknown, isBinary: boolean) => {
      if (isBinary || byteLength(data) > this.maxMessageBytes) {
        socket.close(4400, 'invalid_browser_message');
        return;
      }
      const raw = text(data);
      if (!raw) return;
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { return; }
      if (session.sealed && !isByocSealedPacket(payload)) {
        socket.close(4403, 'byoc_plaintext_relay_refused');
        return;
      }
      const type = session.sealed ? byocSealedContentType(payload) : payloadType(payload);
      // Noise handshake fragments deliberately expose no application type. They
      // still have to cross the blind relay before either endpoint can encrypt
      // an application frame; only authenticated post-handshake packets carry
      // the clear policy discriminator.
      if (session.sealed && type === null) {
        sendJson(connector, { type: 'relay', channelId, payload });
        return;
      }
      if (!type) return;
      this.touch(session);
      if (type === 'session.claim-control') {
        // REFUSED on a desktop channel, and the refusal is the point (D-024 ruling 2).
        // A desktop's privilege IS the KasmVNC credential, which was consumed by the
        // dial and is not retained, so the host cannot promote a live channel. Letting
        // this through would flip the broker's role and tell the browser it has
        // control while KasmVNC went on dropping its input — a viewer that believes it
        // has the keyboard and does not. A takeover is a FRESH channel, which is also
        // what mints its own audit event.
        if (!isTerminalKind(session.kind)) {
          sendJson(socket, {
            type: 'session.denied',
            reason: session.kind === 'desktop' ? 'desktop_role_fixed_at_open' : 'operator_http_role_fixed',
            requestType: type,
          });
          return;
        }
        this.claimControl(session);
        return;
      }
      if (type === 'session.detach') {
        this.closeSession(session, 1000, 'browser_detached', true);
        return;
      }
      // Kind fences, both directions: an operator-http channel forwards ONLY its
      // own request frames, and a terminal/desktop channel never forwards them —
      // so a PTY attachment cannot be replayed as an operator API call.
      if (session.kind === 'operator-http' ? !OPERATOR_HTTP_CLIENT_TYPES.has(type) : isOperatorHttpType(type)) {
        sendJson(socket, { type: 'session.denied', reason: 'channel_kind_mismatch', requestType: type });
        return;
      }
      if (CONTROLLER_ONLY.has(type) && session.role !== 'controller') {
        sendJson(socket, { type: 'session.denied', reason: 'observer_read_only', requestType: type });
        return;
      }
      sendJson(connector, { type: 'relay', channelId, payload });
      this.audit(binding, type, channelId);
    };
    const onClose = () => this.closeSession(session, 1000, 'browser_disconnected', true);
    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', onClose);
    return onClose;
  }

  closeGeneration(binding: HostedConnectorBinding, code = 4001, reason = 'connector_generation_closed'): void {
    const key = connectorKey(binding);
    // Close browsers first so the authoritative rotate/revoke reason wins over
    // the connector socket's generic `close` callback.
    for (const session of [...this.sessions.values()]) {
      if (session.connectorKey === key) this.closeSession(session, code, reason, false);
    }
    this.connectors.get(key)?.close(code, reason);
  }

  private claimControl(session: BrowserSession): void {
    const previousId = this.controllers.get(session.controllerKey);
    if (previousId === session.channelId) return;
    const previous = previousId ? this.sessions.get(previousId) : undefined;
    if (previous) {
      previous.role = 'observer';
      sendJson(previous.socket, { type: 'session.role', role: 'observer', reason: 'control_claimed_elsewhere' });
      const connector = this.connectors.get(previous.connectorKey);
      if (connector) sendJson(connector, { type: 'relay.role', channelId: previous.channelId, role: 'observer' });
    }
    session.role = 'controller';
    this.controllers.set(session.controllerKey, session.channelId);
    sendJson(session.socket, { type: 'session.role', role: 'controller' });
    const connector = this.connectors.get(session.connectorKey);
    if (connector) sendJson(connector, { type: 'relay.role', channelId: session.channelId, role: 'controller' });
    this.audit(session.binding, 'control_claimed', session.channelId);
  }

  private touch(session: BrowserSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.closeSession(session, 4000, 'session_idle_expired', true);
    }, this.idleMs);
    session.idleTimer.unref?.();
  }

  private closeSession(session: BrowserSession, code: number, reason: string, notifyConnector: boolean): void {
    if (session.closed) return;
    session.closed = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.sessions.delete(session.channelId);
    if (this.controllers.get(session.controllerKey) === session.channelId) {
      this.controllers.delete(session.controllerKey);
      const successor = [...this.sessions.values()].find((candidate) => candidate.controllerKey === session.controllerKey);
      if (successor) this.claimControl(successor);
    }
    if (notifyConnector) {
      const connector = this.connectors.get(session.connectorKey);
      if (connector) sendJson(connector, { type: 'relay.close', channelId: session.channelId, reason });
    }
    if (open(session.socket)) session.socket.close(code, reason);
    this.audit(session.binding, 'browser_detached', session.channelId, reason);
  }

  /**
   * The control plane's own record that a hosted desktop viewer started (WI-10004167).
   *
   * The host audits the same event into ITS database, which nothing on the control
   * plane can read — so a customer takeover was invisible here, including to the P-318
   * customer-acceptance receipt that must verify it. The broker is a sound second
   * witness because it holds every fact except one: it authenticated the browser
   * principal, minted the channel, chose the role and relayed the desktop id. The one
   * thing it takes from the host is that the dial SUCCEEDED, which is what
   * `desktop.ready` says. The mode recorded is the broker's role, never the host's
   * claim, and a host reporting a mode the broker did not open is audited as a
   * mismatch rather than as a start.
   */
  private auditDesktopReady(session: BrowserSession, payload: unknown): void {
    if (session.desktopStartAudited || payloadType(payload) !== 'desktop.ready') return;
    session.desktopStartAudited = true;
    const mode = session.role === 'controller' ? 'takeover' : 'watch';
    const reported = (payload as { action?: unknown }).action;
    const desktop = `desktop=${session.desktopSessionId ?? ''}`;
    if (reported === mode) {
      this.audit(session.binding, `desktop_${mode}_started`, session.channelId, desktop);
    } else {
      this.audit(session.binding, 'desktop_ready_mode_mismatch', session.channelId,
        `${desktop} reported=${reported === 'watch' || reported === 'takeover' ? reported : 'invalid'}`);
    }
  }

  private audit(
    binding: HostedConnectorBinding | HostedConnectorTicketBinding,
    action: string,
    channelId?: string,
    detail?: string,
  ): void {
    this.onAudit({
      action,
      controlPlaneWorkspaceId: binding.controlPlaneWorkspaceId,
      organizationId: binding.organizationId,
      customerWorkspaceId: binding.customerWorkspaceId,
      hostId: binding.hostId,
      generation: binding.generation,
      ...('userId' in binding && binding.userId ? { userId: binding.userId } : {}),
      ...('hostedSessionId' in binding && binding.hostedSessionId ? { hostedSessionId: binding.hostedSessionId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(detail ? { detail } : {}),
    });
  }
}
