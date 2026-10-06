/**
 * On-demand desktop VNC sessions
 * (`hive-frame-desktops-live-view-2026-06-06` P-008/P-010, D-002;
 *  `agent-virtual-desktops-2026-08-23` P-004).
 *
 * TWO TARGETS, ONE MACHINE. Originally this served only DEPLOYED FRAMES over the
 * deploy layer's SSH channel. P-004 added LOCAL desktops — the Xvfb displays this
 * host leases to pots and frame slots — and did it by generalising the single
 * thing that differs (the process that speaks RFB on its stdio) rather than by
 * forking the module. Ticket minting, single-use consumption, the TTL, the WS
 * bridge, teardown, and audit are shared verbatim; a local session is the same
 * `x11vnc + socat` script with no `ssh` in front of it.
 *
 * ⚠ The local target carries a gate the frame target does not need: this host
 * also runs the human's real desktop, so a display number from a caller is a
 * request and never an authorisation. See `createVncSession`.
 *
 * The live-view click-through: a noVNC client in the operator webview connects
 * to a loopback WebSocket here; each accepted connection spawns
 * `x11vnc -inetd` on the frame OVER THE DEPLOY LAYER'S SSH CHANNEL and pipes
 * RFB bytes WS ↔ ssh-child-stdio. Properties this buys:
 *
 *   - **No VNC listener on the frame, ever.** `-inetd` speaks RFB on
 *     stdin/stdout of the per-session process — there is no 5900, not even on
 *     localhost. (Stronger than the plan's "localhost-only" floor.)
 *   - **On-demand lifecycle**: the x11vnc process exists exactly while a
 *     viewer's WS is open (`-once`); WS close kills the ssh child (P-010 idle
 *     teardown), plus a hard max-session TTL.
 *   - **Ticketed auth** (P-010): sessions are minted by the authenticated
 *     HTTP route (session cookie) and the WS connect must present the
 *     single-use ticket within 30s. The WS itself binds loopback-only (the
 *     desktop-voice-ws model).
 *   - **Read-only by default** (D-002): `-viewonly` unless the session was
 *     explicitly created with mode 'takeover'; takeover start/stop is written
 *     to the workspace audit_log.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { recordDesktopAudit } from '../desktop/desktop-audit';
import { buildSshStreamArgs } from './remote-exec';
import { sshTargetForFrame } from './frame-installer';
import { loadDeployedFrame } from './deployed-frame';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import {
  resolveLocalDesktopByDisplay,
  setDesktopViewer,
  touchDesktopSession,
} from '../desktop/desktop-session-registry';
import { desktopViewerHeartbeatMs } from '../desktop/desktop-lifecycle';
import type { HostedDesktopEndpoint, HostedDesktopGrant } from '../desktop/hosted-desktop-channel';
import type { HostedDesktopDialInput, HostedDesktopSocket } from '../workspace-host/hosted-session-host';

export type VncMode = 'watch' | 'takeover';

/**
 * Where the desktop being viewed lives (P-004).
 *
 *  - `frame` — a DEPLOYED frame reached over the deploy layer's SSH channel.
 *    The original path; unchanged.
 *  - `local` — an Xvfb desktop on THIS host (a pot lease or a frame slot). No
 *    SSH hop: the same bridge script is spawned directly. Admission is NOT the
 *    caller's display number — see `resolveLocalDesktopByDisplay`.
 */
export type VncTarget = 'frame' | 'local';

export interface VncSessionRequest {
  slug: string;
  workspaceId: string;
  display: number;
  mode: VncMode;
  /** Who asked (the session user) — recorded on the audit events. */
  actor: string;
  /** Defaults to 'frame', which is the pre-P-004 behaviour. */
  target?: VncTarget;
}

export interface VncTicket {
  ticket: string;
  wsPath: string;
  /** Loopback WS port (null until the server bound). */
  wsPort: number | null;
  mode: VncMode;
  display: number;
  slug: string;
  target: VncTarget;
  /** The registry row this session views — local sessions only. */
  desktopSessionId: string | null;
  /**
   * Which RFB server is on the far end (agent-multi-desktops-grid D-015). A
   * KasmVNC desktop needs the viewer's KasmVNC RFB class (its PointerEvent is not
   * stock); an x11vnc stream needs stock noVNC.
   */
  rfb: 'kasmvnc' | 'standard';
}

/**
 * How the bridge reaches a registry desktop's own KasmVNC websocket (D-015): its
 * loopback endpoint and the ONE credential the viewer's mode earns (watch → the
 * view user, take over → the control user). Held only in this process's memory,
 * like the lease it came from; never sent to the webview.
 */
export interface KasmDialPlan {
  endpoint: HostedDesktopEndpoint;
  grant: HostedDesktopGrant;
}

interface PendingSession extends VncSessionRequest {
  ticket: string;
  createdAt: number;
  target: VncTarget;
  /**
   * The process that speaks RFB on its stdio. `ssh …` for a frame, `bash -c …`
   * for a local desktop — the bridge below does not care which, which is the
   * point of naming it for what it is rather than for one of its two shapes.
   */
  spawnCmd: { cmd: string; args: string[] };
  /** Registry row to bind the viewer onto (local sessions only). */
  desktopSessionId: string | null;
  /** Set when the bridge dials the desktop's KasmVNC instead of `spawnCmd` (D-015). */
  kasm?: KasmDialPlan | null;
}

export interface ActiveVncSession {
  slug: string;
  display: number;
  mode: VncMode;
  actor: string;
  sinceMs: number;
  target: VncTarget;
}

/** Unconsumed tickets expire after this long (P-010). */
export const VNC_TICKET_TTL_MS = 30_000;
/** Hard cap on a connected session (safety net over idle teardown). */
export const VNC_MAX_SESSION_MS = 2 * 60 * 60 * 1000;

/**
 * How long a bridged stream may go without a single byte FROM the viewer before
 * it is torn down (P-014 idle-stream teardown).
 *
 * ⚠ The direction is the whole design, and the other one would not work. RFB is a
 * client-PULL protocol: after each update the viewer sends its own
 * FramebufferUpdateRequest, so viewer→server traffic flows continuously for a
 * `watch` session exactly as it does for `takeover`, and it STOPS the moment the
 * viewer wedges. Server→viewer bytes prove nothing by comparison — x11vnc keeps
 * writing into a half-open socket until the kernel buffer fills, so a stream
 * measured that way looks alive long after the human is gone.
 *
 * This is what makes the heartbeat below trustworthy rather than circular. A
 * heartbeat with no idle detector behind it keeps asserting "someone is watching"
 * for a viewer whose TCP connection is half-open, which is the same leak the old
 * six-hour `VIEWER_HOLD_SEC` existed to bound — just at a shorter interval and
 * with more confidence. Detecting the dead stream is what earns the shorter hold.
 *
 * Pinned against `VIEWER_STREAM_TEARDOWN_CEILING_SEC` by a test: the governor's
 * hold is derived from that ceiling, so a longer window here would silently make
 * the hold too short for this lane.
 */
export const VNC_STREAM_IDLE_MS = 10 * 60 * 1000;
export const VNC_WS_PATH = '/api/deploy/vnc';

export interface FrameVncDeps {
  loadFrame?: typeof loadDeployedFrame;
  spawn?: typeof nodeSpawn;
  /** Audit sink — defaults to the workspace audit_log writer. */
  audit?: (ev: { action: string; actor: string; subject: string; details: Record<string, unknown> }) => void;
  now?: () => number;
  /** P-004 admission gate for local desktops; defaults to the registry. */
  resolveLocalDesktop?: typeof resolveLocalDesktopByDisplay;
  /** P-004 viewer binding on the registry row; defaults to the registry. */
  setViewer?: typeof setDesktopViewer;
  /**
   * P-014 connected-viewer heartbeat (D-008 rule 4); defaults to the registry.
   *
   * Injectable because `managedSetInterval` is deliberately inert under Vitest,
   * so the heartbeat is driven through this seam in tests rather than by letting
   * a real timer fire inside a worker.
   */
  touchSession?: typeof touchDesktopSession;
  /**
   * P-014 test seam for the per-connection heartbeat timer.
   *
   * `managedSetInterval` is deliberately inert under Vitest (a production timer
   * firing inside a worker mid-mock turns a passing run into an unhandled
   * rejection), so a test that arms a real one measures nothing. Injecting the
   * timer lets a test drive the tick directly and assert on what it DID, which is
   * the behaviour that matters, rather than on the fact that a timer exists.
   */
  armHeartbeat?: (intervalMs: number, fn: () => void) => ManagedHandle;
  /** D-015: the KasmVNC dial plan for a local desktop, or null to use x11vnc. */
  resolveKasmDesktop?: (desktopSessionId: string, mode: VncMode) => Promise<KasmDialPlan | null>;
  dialKasm?: (input: HostedDesktopDialInput) => Promise<HostedDesktopSocket>;
}

const pending = new Map<string, PendingSession>();
const active = new Map<string, ActiveVncSession>();

let depsOverride: FrameVncDeps = {};
export function _setFrameVncDepsForTests(d: FrameVncDeps): void {
  depsOverride = d;
}
export function _resetFrameVncForTests(): void {
  depsOverride = {};
  pending.clear();
  active.clear();
}

const now = () => (depsOverride.now ?? Date.now)();

/**
 * Default audit sink: the workspace audit_log (same table audit:list reads).
 *
 * Delegates to `desktop/desktop-audit.ts` so this lane and the hosted one write
 * through ONE function. The namespace comment at the mint site below explains why
 * a second namespace would silently answer for half the population; sharing the
 * writer is what makes that true by construction rather than by convention.
 */
function defaultAudit(ev: { action: string; actor: string; subject: string; details: Record<string, unknown> }): void {
  recordDesktopAudit(ev, {
    idPrefix: 'vnc',
    now,
    onError: (err) => console.warn('[frame-vnc] audit write failed:', err),
  });
}

const audit = (ev: { action: string; actor: string; subject: string; details: Record<string, unknown> }) =>
  (depsOverride.audit ?? defaultAudit)(ev);

/**
 * Publish (or clear) this session's viewer on its registry row.
 *
 * A no-op for frame sessions, which have no registry row of their own — those
 * are covered by the frame status stream's own `viewers` field. Errors are
 * swallowed by design: the viewer column is an INDICATOR, and a live desktop
 * session must not die because a cosmetic write lost a race with a release.
 */
function bindViewer(session: PendingSession, mode: VncMode | 'none'): void {
  if (!session.desktopSessionId) return;
  const setter = depsOverride.setViewer ?? setDesktopViewer;
  void Promise.resolve(
    setter(session.desktopSessionId, {
      mode,
      actor: mode === 'none' ? null : session.actor,
    }),
  ).catch((err) => {
    console.warn('[frame-vnc] viewer indicator write failed:', err);
  });
}

/**
 * Refresh this session's `last_active_at` while its stream is carrying traffic
 * (P-014 / D-008 rule 4).
 *
 * Same fire-and-forget contract as `bindViewer`, and for the same reason: a
 * failed beat must never tear down a working viewer. A MISSED beat is safe by
 * construction — `DESKTOP_VIEWER_HEARTBEAT_DIVISOR` sizes the cadence so a viewer
 * survives four consecutive misses before its desktop looks idle.
 */
/**
 * Arm the per-connection viewer heartbeat.
 *
 * Named + listable rather than a bare `setInterval`, so a leaked per-connection
 * timer shows up in `schedule:inventory` instead of only in a memory graph;
 * `instanced` because every concurrent viewer arms one under the same name.
 */
function armHeartbeat(intervalMs: number, fn: () => void): ManagedHandle {
  const arm =
    depsOverride.armHeartbeat ??
    ((ms: number, tick: () => void) =>
      // D-004: 'must-sample' — a viewer-liveness beat against an external VNC session;
      // there is no event source to subscribe to for "the viewer is still there".
      managedSetInterval('frame-vnc-viewer-heartbeat', ms, tick, {
        category: 'lifecycle',
        instanced: true,
        classification: 'must-sample',
      }));
  return arm(intervalMs, fn);
}

function beatViewer(session: PendingSession): void {
  if (!session.desktopSessionId) return;
  const touch = depsOverride.touchSession ?? touchDesktopSession;
  void Promise.resolve(touch(session.desktopSessionId)).catch((err) => {
    console.warn('[frame-vnc] viewer heartbeat failed:', err);
  });
}

/**
 * The command a session runs on the frame (exported for tests).
 *
 * x11vnc's `-inetd` mode does NOT work over an SSH channel: it does socket
 * syscalls (getnameinfo/setsockopt TCP_NODELAY) on stdin/stdout, but SSH gives
 * PIPES, not sockets, so it bails before the RFB greeting ("Socket operation
 * on non-socket" — verified live 2026-06-06). So instead: x11vnc listens on a
 * fresh LOCALHOST-only autoport (never 0.0.0.0 — not network-exposed), and
 * `socat` bridges that port to the SSH stdio. Properties preserved:
 *   - no network-exposed VNC port (x11vnc `-localhost`, autoport ≥5900),
 *   - on-demand (`-once` → x11vnc exits when socat, its one client, leaves;
 *     `-timeout 30` → self-exit if the bridge never connects),
 *   - read-only via `-viewonly` for watch mode (D-002).
 * The whole thing is a `bash -c` so buildSshStreamArgs can prefix `sudo -H`.
 */
export function vncBridgeScript(display: number, mode: VncMode): string {
  const viewonly = mode === 'takeover' ? '' : ' -viewonly';
  // No single quotes inside the script: the frame path wraps it in single quotes.
  //
  // The binary preflight is not ceremony. Without it a MISSING x11vnc reports
  // `x11vnc-no-port`, which reads as "x11vnc ran and gave no port" — the exact
  // opposite of the truth, and the reader goes hunting for a display problem
  // that does not exist. Verified on a host with no x11vnc installed.
  return (
    `command -v x11vnc >/dev/null 2>&1 || { echo "x11vnc-not-installed" >&2; exit 10; }; ` +
    `command -v socat >/dev/null 2>&1 || { echo "socat-not-installed" >&2; exit 11; }; ` +
    `P=$(x11vnc -display :${display} -localhost -nopw${viewonly} -once -timeout 30 -autoport 5900 -bg 2>/dev/null ` +
    `| sed -n "s/.*PORT=\\([0-9]*\\).*/\\1/p"); ` +
    `[ -n "$P" ] || { echo "x11vnc-no-port" >&2; exit 9; }; ` +
    `exec socat STDIO TCP:127.0.0.1:$P`
  );
}

export function vncRemoteCommand(display: number, mode: VncMode): string {
  return `bash -c '${vncBridgeScript(display, mode)}'`;
}

/**
 * The LOCAL equivalent (P-004): the SAME bridge script, spawned directly instead
 * of over SSH.
 *
 * It is deliberately the same script and not a second, simpler implementation.
 * Node could dial the x11vnc port itself and pipe WS ↔ TCP socket, skipping
 * socat — but that is a SECOND byte-pipe and a second teardown path, and the two
 * would drift. Reusing the script means local and frame sessions share one
 * bridge, one `-once`/`-timeout` lifecycle, and one kill path; the only thing
 * that differs between them is whether an `ssh` prefix is in front of it.
 *
 * There is no `sudo` here (the frame path adds one for its non-root login): the
 * operator already owns the Xvfb it is connecting to, so asking for privilege
 * would be asking for more than the job needs.
 */
export function localVncCommand(display: number, mode: VncMode): { cmd: string; args: string[] } {
  return { cmd: 'bash', args: ['-c', vncBridgeScript(display, mode)] };
}

/**
 * Mint a single-use VNC session ticket for a deployed frame's display. The
 * authenticated HTTP route calls this; the returned ticket is consumed by the
 * WS connect. Throws if the harness has no deployed frame.
 */
export async function createVncSession(req: VncSessionRequest): Promise<VncTicket> {
  const target: VncTarget = req.target ?? 'frame';
  let spawnCmd: { cmd: string; args: string[] };
  let desktopSessionId: string | null = null;
  let kasm: KasmDialPlan | null = null;
  // The slug this session is RECORDED under. For a local desktop the registry
  // row is authoritative, not the caller's URL: admission is keyed on workspace
  // + display, so a caller could otherwise name any slug and file an audit entry
  // against a harness that has nothing to do with the desktop it opened.
  let slug = req.slug;

  if (target === 'local') {
    // ADMISSION GATE. The display number arrives from the caller, and this host
    // also runs the human's real session on :0 — so the number is a REQUEST, never
    // an authorisation. Only a display some agent desktop registered is viewable;
    // anything else (the owner's desktop, a typo, a display that just died) is
    // refused here, before a single x11vnc process is spawned.
    const resolve = depsOverride.resolveLocalDesktop ?? resolveLocalDesktopByDisplay;
    const record = await resolve({ workspaceId: req.workspaceId, display: `:${req.display}` });
    if (!record) {
      throw new Error(
        `:${req.display} is not a registered local agent desktop — refusing to open a VNC session on it`,
      );
    }
    desktopSessionId = record.id;
    slug = record.harnessSlug ?? req.slug;
    spawnCmd = localVncCommand(req.display, req.mode);
    // D-015: a KasmVNC desktop this process leases is viewed over its own websocket.
    const resolveKasm = depsOverride.resolveKasmDesktop ?? defaultResolveKasmDesktop;
    kasm = await resolveKasm(record.id, req.mode).catch(() => null);
  } else {
    const loadFrame = depsOverride.loadFrame ?? loadDeployedFrame;
    const loaded = await loadFrame(req.slug, req.workspaceId);
    if (!loaded) throw new Error(`harness '${req.slug}' has no deployed frame`);
    const sshTarget = sshTargetForFrame(loaded.frame, loaded.config);
    spawnCmd = buildSshStreamArgs(sshTarget, vncRemoteCommand(req.display, req.mode));
  }

  const ticket = randomBytes(24).toString('hex');
  pending.set(ticket, { ...req, slug, target, ticket, createdAt: now(), spawnCmd, desktopSessionId, kasm });
  audit({
    // ONE audit namespace across both targets, on purpose: an operator asking
    // "who took over a desktop" writes one filter and finds every session. Two
    // namespaces would silently answer for only half the population. `target`
    // below is what distinguishes them.
    action: `frame-vnc.${req.mode === 'takeover' ? 'takeover-requested' : 'watch-requested'}`,
    actor: req.actor,
    subject: auditSubject(target, slug, req.display),
    details: { slug, display: req.display, mode: req.mode, target, desktopSessionId },
  });
  // GC stale pending tickets opportunistically.
  for (const [t, s] of pending) {
    if (now() - s.createdAt > VNC_TICKET_TTL_MS) pending.delete(t);
  }
  return {
    ticket,
    wsPath: VNC_WS_PATH,
    wsPort: getFrameVncPort(),
    mode: req.mode,
    display: req.display,
    slug,
    target,
    desktopSessionId,
    rfb: kasm ? 'kasmvnc' : 'standard',
  };
}

/**
 * The production dial plan (D-015): only for a desktop whose lease THIS process
 * holds, because its endpoint and secrets exist only in the leasing process
 * (`desktopRecordForLease`). Anything else returns null and keeps x11vnc.
 */
async function defaultResolveKasmDesktop(
  desktopSessionId: string,
  mode: VncMode,
): Promise<KasmDialPlan | null> {
  const [{ leasedDesktopBySessionId }, { desktopRecordForLease }, channel] = await Promise.all([
    import('../agent-tools/computer/desktop-lease'),
    import('../workspace-host/hosted-desktop-backend'),
    import('../desktop/hosted-desktop-channel'),
  ]);
  const lease = leasedDesktopBySessionId(desktopSessionId);
  if (!lease) return null;
  const record = desktopRecordForLease(lease);
  if (!record.endpoint) return null;
  return {
    endpoint: channel.assertLoopbackDesktopEndpoint(record.endpoint),
    grant: channel.hostedDesktopGrant(mode === 'takeover' ? 'controller' : 'observer', record.credentials),
  };
}

async function defaultDialKasm(input: HostedDesktopDialInput): Promise<HostedDesktopSocket> {
  const { dialDesktopSocket } = await import('../workspace-host/hosted-desktop-backend');
  return dialDesktopSocket(input);
}

/**
 * The far end of one bridge: something that speaks RFB. The bridge below owns the
 * session lifecycle (registry viewer binding, audit, heartbeat, idle and TTL
 * teardown); an upstream only moves bytes and reports its own end.
 */
interface VncUpstream {
  /** The spawned process, when there is one (tests and callers read it). */
  readonly child: ChildProcess | null;
  start(on: { data: (chunk: Buffer) => void; end: (why: string) => void }): void;
  write(data: Buffer): void;
  close(): void;
}

function childUpstream(session: PendingSession): VncUpstream {
  const spawn = depsOverride.spawn ?? nodeSpawn;
  const child = spawn(session.spawnCmd.cmd, session.spawnCmd.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // own process group → tree-kill on teardown
  });
  return {
    child,
    start(on) {
      child.stdout?.on('data', on.data);
      child.stderr?.on('data', (chunk: Buffer) => {
        const line = String(chunk).trim();
        if (line) console.warn(`[frame-vnc] ${session.slug}:${session.display} ssh: ${line.slice(0, 300)}`);
      });
      child.on('close', () => on.end('remote-closed'));
      child.on('error', () => on.end('spawn-error'));
    },
    write(data) {
      child.stdin?.write(data);
    },
    close() {
      // Kill the whole ssh process group; fall back to a single-PID kill when
      // the group send fails OR the child never got a pid (early spawn failure).
      let killed = false;
      const pid = child.pid;
      if (pid) {
        try {
          process.kill(-pid, 'SIGTERM');
          killed = true;
        } catch {
          /* fall through to single-PID kill */
        }
      }
      if (!killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* gone */
        }
      }
    },
  };
}

/** Bytes the viewer may send before the KasmVNC dial lands (RFB waits for the server first). */
const KASM_PRE_DIAL_QUEUE_MAX = 64;

function kasmUpstream(plan: KasmDialPlan, desktopSessionId: string): VncUpstream {
  const dial = depsOverride.dialKasm ?? defaultDialKasm;
  let socket: HostedDesktopSocket | null = null;
  let closed = false;
  const queued: Buffer[] = [];
  return {
    child: null,
    start(on) {
      dial({ desktopSessionId, endpoint: plan.endpoint, grant: plan.grant }).then(
        (dialled) => {
          if (closed) {
            dialled.close();
            return;
          }
          socket = dialled;
          dialled.onData(on.data);
          dialled.onClose(() => on.end('remote-closed'));
          for (const chunk of queued.splice(0)) dialled.send(chunk);
        },
        (error: unknown) => {
          console.warn(`[frame-vnc] kasmvnc dial for ${desktopSessionId} failed: ${String(error).slice(0, 200)}`);
          on.end('kasmvnc-dial-failed');
        },
      );
    },
    write(data) {
      if (socket) socket.send(data);
      else if (!closed && queued.length < KASM_PRE_DIAL_QUEUE_MAX) queued.push(data);
    },
    close() {
      closed = true;
      queued.length = 0;
      const live = socket;
      socket = null;
      live?.close();
    },
  };
}

/**
 * Frame subjects keep their historical `slug:display` shape; local ones are
 * prefixed so the two can never be confused in the audit log — both targets can
 * legitimately be `h1:99`, and an auditor reading a takeover record needs to know
 * whether it happened on a remote frame or on this machine.
 */
function auditSubject(target: VncTarget, slug: string, display: number): string {
  return target === 'local' ? `local:${slug}:${display}` : `${slug}:${display}`;
}

/** Consume a ticket (single-use, TTL-bounded). Exported for the WS handler + tests. */
export function consumeTicket(ticket: string): PendingSession | undefined {
  const s = pending.get(ticket);
  if (!s) return undefined;
  pending.delete(ticket);
  if (now() - s.createdAt > VNC_TICKET_TTL_MS) return undefined;
  return s;
}

/** Active sessions for a slug — the D-002 session indicator the live view shows. */
export function activeVncSessions(slug?: string): ActiveVncSession[] {
  const all = [...active.values()];
  return slug ? all.filter((s) => s.slug === slug) : all;
}

/** The minimal WS surface the RFB byte-pipe needs (satisfied by `ws.WebSocket`). */
export interface VncBridgeWs {
  on(event: 'message', cb: (data: Buffer) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/**
 * Bridge an accepted (ticket-validated) WS to the session's ssh `x11vnc -inetd`
 * child: WS messages → child stdin, child stdout → WS binary frames. Teardown
 * is symmetric and kills the WHOLE child tree (the ssh process group).
 * Exported for unit tests (driven with a fake spawn + fake WS).
 */
export function bridgeVncSession(ws: VncBridgeWs, session: PendingSession): ChildProcess | null {
  // D-015: a registry desktop this process leases is dialled over its own KasmVNC
  // websocket; every other session keeps its RFB child process.
  const upstream: VncUpstream = session.kasm
    ? kasmUpstream(session.kasm, session.desktopSessionId ?? '')
    : childUpstream(session);
  const key = session.ticket;
  active.set(key, {
    slug: session.slug,
    display: session.display,
    mode: session.mode,
    actor: session.actor,
    sinceMs: now(),
    target: session.target,
  });
  // Publish the viewer on the registry row so OTHER processes can see that this
  // desktop is being watched — `active` above only answers for this operator.
  // Fire-and-forget: a failed indicator write must never break a live session.
  bindViewer(session, session.mode);
  audit({
    action: `frame-vnc.${session.mode === 'takeover' ? 'takeover-started' : 'watch-started'}`,
    actor: session.actor,
    subject: auditSubject(session.target, session.slug, session.display),
    details: {
      slug: session.slug,
      display: session.display,
      mode: session.mode,
      target: session.target,
      desktopSessionId: session.desktopSessionId,
    },
  });

  let open = true;
  // Last byte received FROM the viewer. Seeded at open so a stream that never
  // sends anything still ages out rather than living until VNC_MAX_SESSION_MS.
  let lastViewerByteMs = now();
  // Declared before endSession rather than at its arming site: endSession runs on
  // spawn-error too, and a `let` initialised further down would be in its temporal
  // dead zone there — a ReferenceError inside the teardown path, not a no-op.
  let heartbeat: ManagedHandle | null = null;
  const endSession = (why: string) => {
    if (!open) return;
    open = false;
    clearTimeout(maxTimer);
    heartbeat?.stop();
    heartbeat = null;
    active.delete(key);
    // Clear the cross-process viewer indicator. This runs on EVERY teardown
    // reason — viewer-left, remote-closed, spawn-error, max-session-ttl — so a
    // row can never be left advertising a watcher who is gone.
    bindViewer(session, 'none');
    audit({
      action: 'frame-vnc.ended',
      actor: session.actor,
      subject: auditSubject(session.target, session.slug, session.display),
      details: {
        slug: session.slug,
        display: session.display,
        mode: session.mode,
        target: session.target,
        desktopSessionId: session.desktopSessionId,
        why,
      },
    });
    upstream.close();
    try {
      ws.close();
    } catch {
      /* gone */
    }
  };

  const maxTimer = setTimeout(() => endSession('max-session-ttl'), VNC_MAX_SESSION_MS);

  /**
   * One tick does BOTH halves of P-014's viewer liveness, in this order.
   *
   * The order is load-bearing. The idle check runs FIRST so a stream that has
   * already gone quiet is torn down on this tick instead of being heartbeated one
   * more time — otherwise the beat would keep asserting "a human is watching" for
   * a viewer that is provably gone, which is exactly the stale-binding failure the
   * shorter `VIEWER_HOLD_SEC` no longer has the slack to absorb.
   */
  const tick = () => {
    if (!open) return;
    if (now() - lastViewerByteMs > VNC_STREAM_IDLE_MS) {
      endSession('stream-idle');
      return;
    }
    beatViewer(session);
  };

  heartbeat = armHeartbeat(desktopViewerHeartbeatMs(), tick);

  upstream.start({
    data: (chunk: Buffer) => {
      try {
        ws.send(chunk);
      } catch {
        /* ws gone */
      }
    },
    end: (why: string) => endSession(why),
  });
  ws.on('message', (data: Buffer) => {
    // The liveness signal for VNC_STREAM_IDLE_MS. Stamped before the write and
    // unconditionally: the byte ARRIVED from the viewer, which is what proves the
    // viewer is alive, whether or not the child is still there to receive it.
    lastViewerByteMs = now();
    try {
      upstream.write(data);
    } catch {
      /* upstream gone */
    }
  });
  ws.on('close', () => endSession('viewer-left'));
  return upstream.child;
}

// ── loopback WS server (the desktop-voice-ws model) ─────────────────────────

const BASE_PORT = Number(process.env.PAPERCUSP_FRAME_VNC_WS_PORT ?? 3078);
const PORT_RANGE = 8;

type FrameVncGlobals = typeof globalThis & {
  __papercuspFrameVncWs?: { started: boolean; chosenPort: number | null; wss: unknown };
};
const _g = globalThis as FrameVncGlobals;
const state = _g.__papercuspFrameVncWs ?? { started: false, chosenPort: null as number | null, wss: null as unknown };
_g.__papercuspFrameVncWs = state;

export function getFrameVncPort(): number | null {
  return state.chosenPort;
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

let startingPromise: Promise<number | null> | null = null;

/** Lazy-start the loopback VNC WS bridge (first vnc-session request). Concurrent
 *  callers share ONE in-flight bind (no TOCTOU on `state.started` → null port). */
export async function startFrameVncWs(): Promise<number | null> {
  if (state.chosenPort !== null) return state.chosenPort;
  if (!startingPromise) {
    startingPromise = doStartFrameVncWs().finally(() => {
      startingPromise = null;
    });
  }
  return startingPromise;
}

async function doStartFrameVncWs(): Promise<number | null> {
  if (state.chosenPort !== null) return state.chosenPort;
  state.started = true;
  const { WebSocketServer } = await import('ws');
  await new Promise<void>((resolve) => {
    const tryListen = (port: number, attempt: number) => {
      const wss = new WebSocketServer({ port, host: '127.0.0.1', path: VNC_WS_PATH });
      wss.on('connection', (ws, req) => {
        if (!isLoopback(req)) {
          ws.close(1008, 'loopback only');
          return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const session = consumeTicket(url.searchParams.get('ticket') ?? '');
        if (!session) {
          ws.close(1008, 'invalid or expired ticket');
          return;
        }
        bridgeVncSession(ws as unknown as VncBridgeWs, session);
      });
      wss.on('listening', () => {
        state.chosenPort = port;
        state.wss = wss;
        console.log(`[frame-vnc] listening on 127.0.0.1:${port}${VNC_WS_PATH}`);
        resolve();
      });
      wss.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && attempt + 1 < PORT_RANGE) {
          try {
            wss.close();
          } catch {
            /* ignore */
          }
          tryListen(port + 1, attempt + 1);
          return;
        }
        console.error('[frame-vnc] ws server failed to bind:', e.message);
        state.started = false; // allow a later retry to re-attempt the bind
        resolve();
      });
    };
    tryListen(BASE_PORT, 0);
  });
  return state.chosenPort;
}
