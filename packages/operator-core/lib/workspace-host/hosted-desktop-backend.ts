/**
 * hosted-desktop-backend.ts — the side-effecting half of P-013's desktop plane:
 * the `HostedDesktopBackend` the workspace-host adapter is handed.
 *
 * `hosted-desktop-channel.ts` decides (which credential, is the target loopback,
 * how often to heartbeat) and `hosted-session-host.ts` sequences. This module is
 * the only one of the three that touches a registry, a socket, or the filesystem,
 * which is what keeps the other two testable with neither a KasmVNC install nor a
 * network.
 *
 * ## Where a desktop's endpoint and credentials actually come from
 *
 * NOT from the registry, and NOT from re-minting. Measured 2026-08-30:
 * `mintKasmvncSessionCredentials` WRITES a kasmvncpasswd file with fresh random
 * secrets, and its only caller is `desktop-provisioner.ts:442` at provision time.
 * The file it writes holds hashes, and the plaintext secrets exist in exactly one
 * place afterwards — the `SandboxDesktop` handle `desktop-lease.ts` holds in
 * process. So:
 *
 *   - re-minting per lookup would ROTATE both secrets, and two viewers opening at
 *     once would race (the second mint invalidates the first's un-dialled grant);
 *   - the PG row cannot answer it at all, and `desktop-lease.ts` states plainly
 *     that its in-process map is the authority for liveness while the row is a
 *     best-effort mirror.
 *
 * Hence `lookup` resolves through `leasedDesktopBySessionId`, and the registry is
 * used only for what it is genuinely authoritative about: the ROSTER (every
 * session for this tenant, including kinds this process never provisioned) and the
 * `last_active_at` heartbeat.
 *
 * ## How the dial authenticates (D-020 / D-024)
 *
 * `buildXServerCommand` starts KasmVNC with `-KasmPasswordFile <file>` and
 * BasicAuth left ON, so the per-session credential is checked by KasmVNC's HTTP
 * layer at the WebSocket UPGRADE — not inside the RFB stream. That is what makes
 * D-024's model coherent: the secret is spent on the upgrade request and the RFB
 * bytes behind it stay opaque, so the relay needs no RFB parser and the view-only
 * restriction is enforced by KasmVNC against the authenticated user rather than by
 * a byte filter we would have to write and could get wrong.
 *
 * ⚠ THAT IS TRUE ONLY BECAUSE OF `-SecurityTypes None`, and it was aspirational
 * until WI-1250866 measured it. Left to its default KasmVNC ALSO demands VncAuth
 * inside the RFB stream, and `-KasmPasswordFile` does not populate a VncAuth
 * password — so every viewer died at a second authentication this comment said did
 * not exist, and no relay could have answered it. The property that keeps the model
 * coherent now lives in `x-server-backend.ts` security property 5; if that flag is
 * ever removed, this paragraph becomes false again and the hosted viewer stops
 * working entirely. `hosted-desktop-kasmvnc-contract.test.ts` pins the pair.
 */
import { readFile, stat } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { DESKTOP_CAPTURE_DIR } from '../deployment/desktop-capture';
import type { HostedDesktopEndpoint } from '../desktop/hosted-desktop-channel';
import type { DesktopSessionRecord } from '../desktop/desktop-session-registry';
import type { SandboxDesktop } from '../agent-tools/computer/desktop-provisioner';
import type {
  HostedDesktopBackend,
  HostedDesktopDialInput,
  HostedDesktopRosterEntry,
  HostedDesktopSessionRecord,
  HostedDesktopSocket,
} from './hosted-session-host';

/**
 * KasmVNC serves its RFB websocket on the noVNC/websockify convention path.
 *
 * ⚠ This is the ONE value in this module not machine-checked against a local
 * install (no KasmVNC on the build box), so it is a named, overridable constant
 * rather than an inline string: a host whose pack serves a different path passes
 * `websocketPath` instead of patching this file.
 */
export const KASMVNC_WEBSOCKET_PATH = '/websockify';

/**
 * How stale a capture JPEG may be and still count as "the current screen".
 *
 * The capture loop writes every `DESKTOP_CAPTURE_DEFAULT_INTERVAL_SEC` (5s) and
 * DELETES the file for a display with no active client, so a stale-but-present
 * file means the loop itself stopped — a paused capture, a dead ffmpeg. Serving
 * that as live is the exact failure the loop's own delete-on-skip exists to
 * prevent, so age is re-checked at read time on this side of the relay too.
 */
export const HOSTED_THUMBNAIL_MAX_AGE_MS = 60_000;

export interface HostedDesktopBackendDeps {
  /** The live desktop behind a registry id — `desktop-lease.leasedDesktopBySessionId`. */
  leasedDesktop: (desktopSessionId: string) => SandboxDesktop | undefined;
  /** Every non-terminal session for this tenant — `desktop-session-registry.listDesktopSessions`. */
  listSessions: () => Promise<DesktopSessionRecord[]>;
  /** Touch `last_active_at` — `desktop-session-registry.touchDesktopSession`. */
  touchSession: (desktopSessionId: string) => Promise<void>;
  /**
   * Lease this workspace's one desktop (or return the live lease) and name its
   * registry row — `desktop-lease.ensureHiveDesktop` + `hiveDesktopSessionId`.
   * Undefined means the desktop runs but has no row, so nothing can resolve it.
   */
  ensureDesktop: () => Promise<string | undefined>;
  /**
   * Retire registry rows no live lease backs — `reconcileLocalDesktopSessions` as
   * sole owner. Run once, before the first roster or start: a row a previous
   * operator incarnation left `ready` (a reboot, an upgrade's new boot disk, a plain
   * restart) otherwise shows in the picker as openable AND blocks the next desktop's
   * row on the live scope/display unique indexes, so `start` answers null
   * (WI-10002797). A failure is warned and retried on the next call.
   */
  reconcile?: () => Promise<number>;
  /**
   * Grab one frame on demand for a desktop this host leases when the capture loop has
   * no fresh file for it — `desktopThumbnailer().thumbnail` (plan
   * agent-multi-desktops-grid-2026-10-06 P-005 / D-008). The loop's display list is
   * fixed at frame bootstrap, so a desktop an agent starts later is only ever seen
   * through this path. Only a grid read calls it, so idle cost stays zero. Omitted:
   * no fallback (a missing or stale capture file answers null).
   */
  grabThumbnail?: (display: number) => Promise<Buffer | null>;
  /**
   * The work-item an agent is on right now — its most recent live claim
   * (`work-item-claims.getActiveClaimForOwner`). Plan agent-multi-desktops-grid
   * D-009: the grid labels each agent desktop with it, derived at roster time and
   * never stored on the desktop row. Omitted, or a failed read: no label.
   */
  activeClaimFor?: (owner: string) => Promise<HostedDesktopOwnerClaim | null>;
  /** Override the capture directory (tests, or a pack that relocates it). */
  captureDir?: string;
  /** Override the KasmVNC websocket path. */
  websocketPath?: string;
  /** Override the KasmVNC dial deadline (tests). */
  dialTimeoutMs?: number;
  createSocket?: (url: string, headers: Record<string, string>) => HostedDesktopWireSocket;
  /** Injected for tests. */
  now?: () => number;
  /** Reported when a background heartbeat or capture read fails. */
  onWarning?: (message: string) => void;
}

/** The narrow `ws` client surface this module drives. */
export interface HostedDesktopWireSocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: Buffer, options?: { binary?: boolean }): unknown;
  close(code?: number, reason?: string): unknown;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

export class HostedDesktopDialError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'HostedDesktopDialError';
  }
}

/** `":110"` → `110`; null for anything that is not an X display string. */
export function displayNumber(display: string | null | undefined): number | null {
  if (!display) return null;
  const match = /^:(\d+)$/.exec(display);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * The HTTP Basic header KasmVNC checks on the upgrade.
 *
 * Exported so the credential-shaping is testable without opening a socket — this
 * is the single line on which the whole watch/takeover boundary rides, and D-024
 * ruling 1 puts the enforcement in KasmVNC's hands precisely because this header
 * is the only thing we get to decide.
 */
export function basicAuthHeader(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
}

function toBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Buffer.concat(data.filter(Buffer.isBuffer));
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return null;
}

/**
 * The websocket subprotocol KasmVNC requires on the upgrade. Not a preference: the
 * server closes the connection outright without it.
 */
export const KASMVNC_WEBSOCKET_SUBPROTOCOL = 'binary';

/**
 * How long a KasmVNC dial may wait for the upgrade to open (WI-10004214).
 *
 * The host sends `desktop.ready` only after the dial resolves, so a dial with no
 * deadline turns a stalled upgrade into a viewer that says "Opening your desktop…"
 * forever with no error anywhere — measured on the owner's first Take control on
 * avi-test, 2026-09-30. A loopback upgrade that has not opened in this long is not
 * going to; failing it reports `desktop_dial_failed` and lets the viewer retry.
 */
export const KASMVNC_DIAL_TIMEOUT_MS = 10_000;

/**
 * Everything KasmVNC demands on the upgrade BEYOND the credential.
 *
 * ⚠ Measured against a real KasmVNC, one variable at a time (WI-1250866), with a
 * correct BasicAuth header throughout:
 *
 *   | Sec-WebSocket-Protocol | Origin  | result   |
 *   |------------------------|---------|----------|
 *   | absent                 | absent  | closed   |
 *   | absent                 | present | closed   |
 *   | present                | absent  | closed   |
 *   | present                | present | HTTP 101 |
 *
 * BOTH are mandatory, and a missing one is not reported: the server closes with no
 * HTTP response at all — not a 400, not a 426 — so nothing on the wire says which
 * header was omitted. `ws` sends neither by default, so a plain
 * `new WebSocket(url, { headers })` can never reach a KasmVNC desktop.
 *
 * The `Origin` value is not a real browser origin and is not checked as one; KasmVNC
 * only requires the header to be PRESENT. It is set to the endpoint being dialled so
 * a packet capture reads honestly rather than naming a page that does not exist.
 */
export function kasmvncUpgradeHeaders(input: {
  endpoint: HostedDesktopEndpoint;
  grant: { user: string; secret: string };
}): Record<string, string> {
  return {
    Authorization: basicAuthHeader(input.grant.user, input.grant.secret),
    Origin: `http://${endpointHost(input.endpoint)}:${input.endpoint.port}`,
  };
}

function defaultCreateSocket(url: string, headers: Record<string, string>): HostedDesktopWireSocket {
  return new WebSocket(url, [KASMVNC_WEBSOCKET_SUBPROTOCOL], {
    headers,
  }) as unknown as HostedDesktopWireSocket;
}

/**
 * Build the `HostedDesktopSessionRecord` for one live lease.
 *
 * Pure, and exported for its own test, because it encodes the one rule that must
 * never be got wrong: a desktop is dialable only when this process holds BOTH its
 * endpoint and its secrets.
 *
 * The reachable asymmetry is not hypothetical — `desktop-provisioner.ts:442` sets
 * `credentials = null` when the caller supplied its own `kasmvncPasswordFile`, so
 * "endpoint present, secrets absent" is a real state. Treating it as
 * `endpoint: null` makes the dial fail as `endpoint_absent` (the adapter asserts
 * the endpoint before it reads the credentials), which is the honest outcome: this
 * host cannot authenticate to that desktop. The alternative — passing the endpoint
 * through with an empty secret — would attempt an unauthenticated dial, which is
 * the one outcome D-020 exists to make impossible.
 */
export function desktopRecordForLease(desktop: SandboxDesktop): HostedDesktopSessionRecord {
  const credentials = desktop.credentials;
  if (!credentials || !desktop.endpoint) {
    return { endpoint: null, credentials: { view: { user: '', secret: '' }, control: { user: '', secret: '' } } };
  }
  return {
    endpoint: { host: desktop.endpoint.host, port: desktop.endpoint.port },
    credentials: { view: credentials.view, control: credentials.control },
  };
}

/** One registry row as the viewer's picker renders it. */
/** An owner's current work-item, as the roster labels its desktops. */
export interface HostedDesktopOwnerClaim {
  workItemId: string;
  intent: string | null;
}

/** Longest claim intent the roster carries: a tile label, not the claim's full text. */
export const HOSTED_ROSTER_INTENT_MAX_CHARS = 160;

export function rosterEntryForSession(
  session: DesktopSessionRecord,
  claim: HostedDesktopOwnerClaim | null = null,
): HostedDesktopRosterEntry {
  const display = displayNumber(session.display);
  const { width, height } = session.displayGeometry;
  // A workspace desktop's scopeRef is the workspace id, which names no owner.
  const owner = session.scope === 'workspace' ? '' : session.scopeRef;
  const intent = claim?.intent?.trim().slice(0, HOSTED_ROSTER_INTENT_MAX_CHARS) ?? '';
  return {
    desktopSessionId: session.id,
    state: session.state,
    ...(display === null ? {} : { displayNumber: display }),
    ...(width && height ? { geometry: `${width}x${height}` } : {}),
    ...(session.lastActiveAt ? { lastActiveAt: session.lastActiveAt.toISOString() } : {}),
    scope: session.scope,
    ...(owner ? { owner } : {}),
    ...(session.name ? { name: session.name } : {}),
    ...(claim ? { workItemId: claim.workItemId } : {}),
    ...(claim && intent ? { workItemIntent: intent } : {}),
  };
}

/**
 * Each agent owner's current claim, read once per owner. A failed read is a missing
 * label, never a failed roster: the grid must still show every desktop.
 */
async function claimsForSessions(
  sessions: readonly DesktopSessionRecord[],
  activeClaimFor: HostedDesktopBackendDeps['activeClaimFor'],
  warn: (message: string) => void,
): Promise<Map<string, HostedDesktopOwnerClaim>> {
  const claims = new Map<string, HostedDesktopOwnerClaim>();
  if (!activeClaimFor) return claims;
  const owners = [...new Set(sessions.filter((s) => s.scope === 'agent').map((s) => s.scopeRef))];
  await Promise.all(
    owners.map(async (owner) => {
      try {
        const claim = await activeClaimFor(owner);
        if (claim) claims.set(owner, claim);
      } catch (error) {
        warn(`hosted-desktop-backend — claim lookup for ${owner} failed: ${String(error)}`);
      }
    }),
  );
  return claims;
}

/**
 * Dial one loopback KasmVNC websocket and adapt it to the adapter's byte-pipe.
 *
 * Resolves only once the socket is OPEN: the adapter attaches its listeners to the
 * returned value and immediately treats the channel as live, so handing back a
 * still-connecting socket would silently drop the viewer's first writes and — worse
 * — report a dial success for an endpoint that then refuses the credential.
 */
export async function dialDesktopSocket(
  input: HostedDesktopDialInput,
  deps: Pick<HostedDesktopBackendDeps, 'createSocket' | 'websocketPath' | 'dialTimeoutMs'> = {},
): Promise<HostedDesktopSocket> {
  const create = deps.createSocket ?? defaultCreateSocket;
  const path = deps.websocketPath ?? KASMVNC_WEBSOCKET_PATH;
  const dialTimeoutMs = deps.dialTimeoutMs ?? KASMVNC_DIAL_TIMEOUT_MS;
  const url = `ws://${endpointHost(input.endpoint)}:${input.endpoint.port}${path}`;
  const socket = create(url, kasmvncUpgradeHeaders({ endpoint: input.endpoint, grant: input.grant }));

  const dataListeners = new Set<(data: Buffer) => void>();
  const closeListeners = new Set<(reason: string) => void>();
  let closed = false;

  const fireClose = (reason: string): void => {
    if (closed) return;
    closed = true;
    for (const listener of [...closeListeners]) listener(reason);
  };

  socket.on('message', (data, isBinary) => {
    void isBinary;
    const buffer = toBuffer(data);
    if (!buffer || buffer.byteLength === 0) return;
    for (const listener of [...dataListeners]) listener(buffer);
  });
  socket.on('close', (code) => fireClose(`desktop_socket_closed_${code}`));

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Abort the pending upgrade so the half-open socket does not outlive the dial.
      try {
        socket.close(1000, 'dial_timeout');
      } catch {
        /* already gone */
      }
      reject(new HostedDesktopDialError('desktop_dial_failed', `dial_timeout_${dialTimeoutMs}ms`));
    }, dialTimeoutMs);
    socket.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve();
    });
    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new HostedDesktopDialError('desktop_dial_failed', String(error)));
    });
    socket.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // A close BEFORE open must reject the dial rather than resolve a dead pipe.
      //
      // ⚠ Do NOT read this as "the credential was rejected" — that reading cost real
      // debugging time (WI-1250866). A rejected BasicAuth arrives as an HTTP 401,
      // which `ws` surfaces as `unexpected-response`. A close with no response at all
      // is KasmVNC refusing the UPGRADE SHAPE — a missing `binary` subprotocol or a
      // missing `Origin` — and it looks identical for both. `kasmvncUpgradeHeaders`
      // supplies them; if this fires, suspect the upgrade shape before the secret.
      reject(new HostedDesktopDialError('desktop_dial_failed', `closed_before_open_${code}`));
    });
  });

  return {
    send(data: Buffer): boolean {
      if (closed || socket.readyState !== socket.OPEN) return false;
      try {
        socket.send(data, { binary: true });
        return true;
      } catch {
        return false;
      }
    },
    close(): void {
      try {
        socket.close(1000, 'viewer_detached');
      } catch {
        /* already gone */
      }
      fireClose('viewer_detached');
    },
    onData(listener: (data: Buffer) => void): () => void {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onClose(listener: (reason: string) => void): () => void {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
}

function endpointHost(endpoint: HostedDesktopEndpoint): string {
  // Bracket a v6 literal so the URL parses. The endpoint is already asserted
  // loopback by the adapter, so this is formatting, not validation.
  return endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host;
}

/** Compose the backend the workspace-host adapter is handed. */
export function createHostedDesktopBackend(deps: HostedDesktopBackendDeps): HostedDesktopBackend {
  const captureDir = deps.captureDir ?? DESKTOP_CAPTURE_DIR;
  const now = deps.now ?? Date.now;
  const warn = deps.onWarning ?? (() => {});

  // Every roster/start reconciles, not only the first (WI-10004206): a desktop can die
  // at any point after boot, and a roster read once is how a dead one stayed `ready`.
  // Concurrent callers share the pass in flight rather than each paying for one.
  let reconciling: Promise<void> | null = null;
  const reconcile = (): Promise<void> => {
    if (!deps.reconcile) return Promise.resolve();
    reconciling ??= deps.reconcile()
      .then(
        (reaped) => {
          if (reaped > 0) warn(`hosted-desktop-backend — retired ${reaped} desktop row(s) no live lease backs`);
        },
        (error) => {
          warn(`hosted-desktop-backend — desktop reconcile failed: ${String(error)}`);
        },
      )
      .finally(() => {
        reconciling = null;
      });
    return reconciling;
  };

  const displayFor = async (desktopSessionId: string): Promise<number | null> => {
    const leased = displayNumber(deps.leasedDesktop(desktopSessionId)?.display);
    if (leased !== null) return leased;
    // A desktop this process did not provision still has a row, and its capture
    // file is still on this host's disk when the capture loop is running for it.
    const session = (await deps.listSessions()).find((entry) => entry.id === desktopSessionId);
    return displayNumber(session?.display);
  };

  return {
    async lookup(desktopSessionId: string): Promise<HostedDesktopSessionRecord | null> {
      const desktop = deps.leasedDesktop(desktopSessionId);
      // null means "not this host's, or not live". Deliberately not distinguished
      // from "unknown id": both are `desktop_session_unknown` to the viewer, and
      // telling an unauthorised caller which desktop ids exist elsewhere is the
      // enumeration oracle this refusal exists to avoid.
      return desktop ? desktopRecordForLease(desktop) : null;
    },

    dial(input: HostedDesktopDialInput): Promise<HostedDesktopSocket> {
      return dialDesktopSocket(input, {
        ...(deps.createSocket ? { createSocket: deps.createSocket } : {}),
        ...(deps.websocketPath ? { websocketPath: deps.websocketPath } : {}),
        ...(deps.dialTimeoutMs ? { dialTimeoutMs: deps.dialTimeoutMs } : {}),
      });
    },

    heartbeat(desktopSessionId: string): void {
      // Fire-and-forget by contract (the adapter's seam is sync): a failed touch
      // costs an idle-reaper false positive at worst, and blocking the relay's
      // heartbeat tick on Postgres would couple pixel delivery to DB latency.
      void deps.touchSession(desktopSessionId).catch((error) => {
        warn(`hosted-desktop-backend — heartbeat ${desktopSessionId} failed: ${String(error)}`);
      });
    },

    async roster(): Promise<HostedDesktopRosterEntry[]> {
      await reconcile();
      const sessions = await deps.listSessions();
      const claims = await claimsForSessions(sessions, deps.activeClaimFor, warn);
      return sessions.map((session) =>
        rosterEntryForSession(session, session.scope === 'agent' ? (claims.get(session.scopeRef) ?? null) : null),
      );
    },

    async start(): Promise<HostedDesktopRosterEntry | null> {
      await reconcile();
      const desktopSessionId = await deps.ensureDesktop();
      // Served only when BOTH halves hold: the row names it, and this process holds
      // the live lease `lookup` dials through. Either alone gives the viewer an id
      // that fails at open as `desktop_session_unknown`.
      if (!desktopSessionId) {
        // The lease's registry write is best-effort and swallows its own failure, so
        // this line is the only trace of a desktop that runs but cannot be named.
        warn('hosted-desktop-backend — desktop.start: the desktop has no registry row');
        return null;
      }
      if (!deps.leasedDesktop(desktopSessionId)) return null;
      const session = (await deps.listSessions()).find((entry) => entry.id === desktopSessionId);
      return session ? rosterEntryForSession(session) : null;
    },

    async thumbnail(desktopSessionId: string): Promise<Buffer | null> {
      const display = await displayFor(desktopSessionId);
      if (display === null) return null;
      const path = `${captureDir}/display-${display}.jpg`;
      let fromLoop: Buffer | null = null;
      try {
        const info = await stat(path);
        if (now() - info.mtimeMs <= HOSTED_THUMBNAIL_MAX_AGE_MS) fromLoop = await readFile(path);
      } catch {
        // Absent is the capture loop's NORMAL answer for a display with no active
        // client (it removes the stale jpeg on purpose), so this is not an error.
      }
      if (fromLoop) return fromLoop;
      // A stale or absent file is never served as live. A desktop this host LEASES is
      // grabbed directly instead — a fresh frame is the truth, and a dead display just
      // yields null. A display number known only from a registry row is not grabbed:
      // it could name an X server this process does not own.
      const leased = displayNumber(deps.leasedDesktop(desktopSessionId)?.display);
      if (leased === null || !deps.grabThumbnail) return null;
      try {
        return await deps.grabThumbnail(leased);
      } catch (error) {
        warn(`hosted-desktop-backend — on-demand thumbnail for ${desktopSessionId} failed: ${String(error)}`);
        return null;
      }
    },
  };
}
