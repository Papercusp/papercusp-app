/**
 * hosted-connector-client.ts — the VM half of the outbound hosted relay: the
 * WebSocket CLIENT that dials the control plane and pumps relay envelopes into
 * `HostedWorkspaceHostSessionAdapter`.
 *
 * ## Why this module exists
 *
 * `hosted-session-host.ts` is a pure envelope machine: it is handed envelopes and
 * hands back envelopes, and deliberately owns no socket. Until this module there
 * was no code anywhere that constructed it — measured 2026-08-30, the adapter had
 * ZERO non-test importers (WI-1064431) — so both the hosted PTY relay and the
 * P-013 desktop viewer were libraries with no host process. This is that process's
 * transport half.
 *
 * ## Direction of the dial (D-023 ruling 1)
 *
 * The workspace host NEVER listens. It dials `wss://…/api/hosted/connectors/socket`
 * outbound and presents its enrollment bearer; the control plane authenticates it
 * (`authenticateHostedConnectorSocket` → `role: 'connector'`) and attaches it to
 * `HostedWorkspaceSessionBroker`. Everything after that is envelopes over that one
 * socket. A customer VM therefore needs no inbound firewall hole, which is the
 * property the whole hosted lane is built on.
 *
 * ## The binding comes from the control plane, not from local config
 *
 * On attach the broker sends `{ type: 'bound', role: 'connector', protocol, binding }`
 * (`hosted-workspace-session.ts:140`). That is the AUTHORITATIVE binding — the
 * control plane is the side that authenticated the bearer and therefore the side
 * that knows the current `generation`. Configuring organizationId/hostId/generation
 * on the VM instead would put a rotatable value in two places and let a rotated
 * host keep stamping audit rows with a stale generation. So this client does not
 * accept a binding; it LEARNS one, and the composition root builds the adapter only
 * once `bound` has arrived.
 */
import { WebSocket } from 'ws';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';
import type { HostedHostOutboundEnvelope } from './hosted-session-host';

/** Path the control plane accepts a connector upgrade on (`hosted-handler.ts`). */
export const HOSTED_CONNECTOR_SOCKET_PATH = '/api/hosted/connectors/socket';

/** Close code the gateway uses when a binding is revoked or rotated out. */
export const HOSTED_CONNECTOR_REVOKED_CLOSE_CODE = 4001;

export const HOSTED_CONNECTOR_MIN_BACKOFF_MS = 1_000;
export const HOSTED_CONNECTOR_MAX_BACKOFF_MS = 60_000;

/**
 * Liveness, watched from the VM side (P-002 of plan
 * psu-cloud-connector-liveness-multi-signin-2026-09-29).
 *
 * A TCP link can die with neither end seeing a FIN or RST: a NAT or load balancer
 * forgets the mapping, the VM is suspended, the path changes. `ws` then reports the
 * socket OPEN forever and no `close` ever fires, so the reconnect loop below never
 * runs. The control plane pings every 30s and terminates its own end (P-001), but
 * that cannot reach a VM whose half still believes it is connected.
 *
 * So the client watches for silence itself. It pings on its own cadence, counts ANY
 * inbound frame (open, message, ping, pong) as proof of life, and terminates and
 * reconnects once nothing has arrived for `HOSTED_CONNECTOR_SILENCE_TIMEOUT_MS`.
 * The window also covers a handshake that never completes, because the clock starts
 * when the socket is created, not when it opens.
 */
export const HOSTED_CONNECTOR_PING_INTERVAL_MS = 25_000;
export const HOSTED_CONNECTOR_SILENCE_TIMEOUT_MS = 75_000;

/** The narrow client surface used here; `ws.WebSocket` satisfies it. */
export interface HostedConnectorClientSocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'ping' | 'pong', listener: () => void): unknown;
  /** Optional so a minimal socket still works; `ws` has both, and the watchdog uses them. */
  ping?(): unknown;
  terminate?(): unknown;
}

/**
 * Why a connector stopped for good.
 *
 * `revoked` is the one that must NOT be retried: the gateway closes 4001 when the
 * binding is revoked or its generation rotated, so the bearer this process holds
 * is dead. Reconnecting on it would be an infinite authenticated-looking hammer at
 * the control plane with a credential that can never succeed again — the failure
 * mode a plain "always reconnect" loop produces, and the reason terminality is
 * modelled here rather than left to the caller's backoff.
 */
export type HostedConnectorTerminalReason = 'revoked' | 'stopped';

export interface HostedConnectorClientOptions {
  /** Absolute control-plane socket URL, e.g. `wss://app.papercusp.com/api/hosted/connectors/socket`. */
  url: string;
  /** The enrollment bearer this host registered with. Sent as `Authorization: Bearer`. */
  bearer: string;
  /** Called for every inbound relay envelope — normally `adapter.accept`. */
  onEnvelope: (envelope: unknown) => void;
  /**
   * Called once the control plane has told us who we are. Fires on EVERY (re)connect,
   * because a reconnect can legitimately carry a new generation; the composition root
   * rebuilds its adapter on each one rather than reusing an adapter bound to the old.
   */
  onBound: (binding: HostedConnectorBinding) => void;
  /** Called when the socket drops, so the caller can tear down the adapter it built. */
  onDisconnect?: (reason: string) => void;
  /** Called when the client will make no further attempts. */
  onTerminal?: (reason: HostedConnectorTerminalReason, detail: string) => void;
  createSocket?: (url: string, headers: Record<string, string>) => HostedConnectorClientSocket;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Defaults to `HOSTED_CONNECTOR_PING_INTERVAL_MS`; also the watchdog's check cadence. */
  pingIntervalMs?: number;
  /** Defaults to `HOSTED_CONNECTOR_SILENCE_TIMEOUT_MS`. */
  silenceTimeoutMs?: number;
  /** Injected for tests; defaults to `Math.random`. */
  random?: () => number;
}

function isRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return null;
}

/**
 * Read the binding out of a `bound` frame.
 *
 * Returns null rather than throwing on a malformed frame: the control plane is a
 * separately deployed peer across a real version skew, so an unrecognised frame is
 * an expected event, not a crash. An unbound socket simply carries no adapter.
 */
export function readBoundBinding(value: unknown): HostedConnectorBinding | null {
  const frame = isRecord(value);
  if (!frame || frame.type !== 'bound' || frame.role !== 'connector') return null;
  const binding = isRecord(frame.binding);
  if (!binding) return null;
  const strings = ['controlPlaneWorkspaceId', 'organizationId', 'customerWorkspaceId', 'hostId', 'routeLabel'] as const;
  for (const key of strings) if (typeof binding[key] !== 'string' || !binding[key]) return null;
  if (typeof binding.generation !== 'number' || !Number.isSafeInteger(binding.generation)) return null;
  return binding as unknown as HostedConnectorBinding;
}

function defaultCreateSocket(url: string, headers: Record<string, string>): HostedConnectorClientSocket {
  return new WebSocket(url, { headers }) as unknown as HostedConnectorClientSocket;
}

/**
 * One managed outbound connector session, with reconnect.
 *
 * State is deliberately coarse — there is exactly one socket at a time, and every
 * transition goes through `scheduleReconnect` or `stop`, so there is no path that
 * leaves two live sockets racing to deliver envelopes into the same adapter.
 */
export class HostedWorkspaceConnectorClient {
  private socket: HostedConnectorClientSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private liveness: ManagedHandle | null = null;
  private lastInboundAt = 0;
  private readonly createSocket: (url: string, headers: Record<string, string>) => HostedConnectorClientSocket;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly pingIntervalMs: number;
  private readonly silenceTimeoutMs: number;
  private readonly random: () => number;

  constructor(private readonly options: HostedConnectorClientOptions) {
    this.createSocket = options.createSocket ?? defaultCreateSocket;
    this.minBackoffMs = options.minBackoffMs ?? HOSTED_CONNECTOR_MIN_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? HOSTED_CONNECTOR_MAX_BACKOFF_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? HOSTED_CONNECTOR_PING_INTERVAL_MS;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? HOSTED_CONNECTOR_SILENCE_TIMEOUT_MS;
    this.random = options.random ?? Math.random;
  }

  /** True while a socket is open and usable. */
  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === this.socket.OPEN;
  }

  start(): void {
    if (this.stopped || this.socket || this.timer) return;
    this.connect();
  }

  /** Stop for good. Idempotent, and never reconnects afterwards. */
  stop(reason = 'host_stopped'): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unwatch();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, reason);
    } catch {
      /* a socket already torn down by the peer is the normal case here */
    }
    this.options.onTerminal?.('stopped', reason);
  }

  /**
   * Forward one outbound envelope. `false` means it was dropped because no socket
   * is up — never an exception: the adapter emits these from inside channel
   * teardown paths, where a throw would strand the channel it was closing.
   */
  send(message: HostedHostOutboundEnvelope): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private connect(): void {
    this.timer = null;
    if (this.stopped) return;
    let socket: HostedConnectorClientSocket;
    try {
      socket = this.createSocket(this.options.url, { Authorization: `Bearer ${this.options.bearer}` });
    } catch (error) {
      // A constructor throw (bad URL, no `ws` runtime) is retried on the same
      // backoff as a refused connection: from here they are indistinguishable, and
      // a transient DNS failure must not be fatal to a long-lived host.
      this.scheduleReconnect(`socket_create_failed: ${String(error)}`);
      return;
    }
    this.socket = socket;
    this.watch(socket);

    socket.on('open', () => {
      this.markInbound(socket);
      // The attempt counter resets on OPEN, not on `bound`. A control plane that
      // accepts the socket and then closes it is still a reachable control plane;
      // resetting only on `bound` would keep a healthy host at max backoff forever
      // if the broker ever stopped sending that frame.
      this.attempt = 0;
    });

    // `ws` answers the control plane's pings by itself; hearing them, or the pongs to
    // our own pings, is what tells a quiet-but-healthy link from a dead one.
    socket.on('ping', () => this.markInbound(socket));
    socket.on('pong', () => this.markInbound(socket));

    socket.on('message', (data, isBinary) => {
      this.markInbound(socket);
      if (isBinary) return;
      const raw = text(data);
      if (raw === null) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const binding = readBoundBinding(parsed);
      if (binding) {
        this.options.onBound(binding);
        return;
      }
      this.options.onEnvelope(parsed);
    });

    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.unwatch();
      const detail = `${code}${reason ? `: ${text(reason) ?? ''}` : ''}`;
      this.options.onDisconnect?.(detail);
      if (code === HOSTED_CONNECTOR_REVOKED_CLOSE_CODE) {
        // Terminal by design — see HostedConnectorTerminalReason. Re-enrolment is
        // an operator action, not something this client can retry into.
        this.stopped = true;
        this.options.onTerminal?.('revoked', detail);
        return;
      }
      this.scheduleReconnect(detail);
    });

    socket.on('error', () => {
      // `ws` always follows an error with a close, which is where reconnect is
      // decided. Handling it here too would double-schedule.
    });
  }

  private markInbound(socket: HostedConnectorClientSocket): void {
    if (this.socket === socket) this.lastInboundAt = Date.now();
  }

  /** One watchdog per socket; it is replaced whenever the socket is. */
  private watch(socket: HostedConnectorClientSocket): void {
    this.unwatch();
    this.lastInboundAt = Date.now();
    this.liveness = managedSetInterval(
      'hosted-connector-liveness',
      this.pingIntervalMs,
      () => this.checkLiveness(socket),
      { category: 'lifecycle', instanced: true, classification: 'timeout-reaper' },
    );
  }

  private unwatch(): void {
    this.liveness?.stop();
    this.liveness = null;
  }

  private checkLiveness(socket: HostedConnectorClientSocket): void {
    if (this.socket !== socket) {
      this.unwatch();
      return;
    }
    const silentMs = Date.now() - this.lastInboundAt;
    if (silentMs >= this.silenceTimeoutMs) {
      this.dropSilentSocket(socket, `liveness_timeout: no inbound frame for ${Math.round(silentMs / 1000)}s`);
      return;
    }
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.ping?.();
    } catch {
      /* a socket dying under us; the silence check reaps it on a later tick */
    }
  }

  /**
   * Treat a silent socket as dead. It is detached BEFORE it is terminated, so the
   * `close` that `ws` emits afterwards is ignored by the handler's identity check and
   * cannot schedule a second reconnect.
   */
  private dropSilentSocket(socket: HostedConnectorClientSocket, detail: string): void {
    this.socket = null;
    this.unwatch();
    try {
      if (socket.terminate) socket.terminate();
      else socket.close(4000, 'liveness_timeout');
    } catch {
      /* already torn down */
    }
    this.options.onDisconnect?.(detail);
    this.scheduleReconnect(detail);
  }

  private scheduleReconnect(detail: string): void {
    if (this.stopped || this.timer) return;
    void detail;
    const exponential = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    // Full jitter. A fleet of hosts that all lost the same control plane must not
    // return in a synchronised wave — that turns one restart into a thundering herd
    // against the endpoint that just came back.
    const delay = Math.max(this.minBackoffMs, Math.floor(exponential * this.random()));
    this.timer = setTimeout(() => this.connect(), delay);
    // Never hold the process open on a reconnect timer: a host with nothing else
    // running should exit rather than idle forever waiting for a dead control plane.
    this.timer.unref?.();
  }
}
