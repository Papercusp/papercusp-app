/**
 * desktop-health — P-019 of fleet-coordination-painpoints (Phase 3b).
 *
 * The Tauri DESKTOP shell has no HTTP health endpoint (CLAUDE.md: it's a desktop
 * app, not a webapp), so the endpoint poller in `service-health.ts` can't reach
 * it. This probes it from three signals the desktop exposes locally:
 *
 *   (a) the tauri-agent-tools DEV BRIDGE — a `/eval` round-trip proves the
 *       webview is up AND executes JS (not white-screened / wedged). The bridge
 *       runs ONLY inside the Tauri shell (papercusp-desktop `dev_bridge.rs`), so
 *       a live bridge token (`/tmp/tauri-dev-bridge-<pid>.token` with a live pid)
 *       is also our "is the desktop even running" signal.
 *   (b) the Tauri↔operator IPC unix socket — CONNECTABLE, which is strictly
 *       weaker than "serving". See the warning on `attemptIpcConnect` below: a
 *       bare connect() is completed by the kernel from the listen backlog, so it
 *       stays true against a process whose event loop is fully blocked. It
 *       detects a DEAD or ABSENT socket (the Plans-tab "loading forever" bug),
 *       not a wedged one. For the recurring probe it is resolved per bridge:
 *       authenticated `/health` supplies that bridge's live selected API port,
 *       then `endpoint-ipc.<port>.json` supplies only that operator's socket.
 *       The raw singleton is never used on this path (EI-7760 / EI-19357343092509867).
 *   (c) an application-level round-trip to the operator the desktop routes
 *       `/api/*` to (WI-7355) — the ONLY signal here that proves the sidecar can
 *       actually SERVE. (a) exercises the desktop app process and (b) only the
 *       kernel, so before this existed a sidecar that answered nothing for
 *       minutes still reported `desktop: up` (EI-19406226890070872: accept queue
 *       full at 512/511, every /api/health timing out at 4s, no signal emitted).
 *   (d) toastLog.recent — recent ERROR toasts = the app is running but unhappy.
 *       Surfaced as detail (`recentErrors` + the note); it does NOT by itself
 *       flip up/down, so a single transient error toast can't turn into a DOWN
 *       broadcast (Phase 1 just killed the notify firehose — don't recreate it).
 *
 * CRUCIAL non-noise rule: when NO desktop is running (no live bridge token — the
 * common case on the systemd dev box, where the operator runs WITHOUT the
 * desktop), the probe reports `present: false`. `diffHealth` skips absent
 * services, so the 1-min tick never broadcasts a phantom "desktop DOWN". We only
 * transition to DOWN when the desktop IS present but a liveness signal fails.
 *
 * The signal-gatherers are injected (`DesktopSignals`) so the decision logic is
 * unit-tested without a live desktop / bridge / kopia.
 */
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import type { ProbeResult } from './service-health';
import { readEndpointIpcDiscovery, readEndpointIpcDiscoveryForPort, type EndpointIpcDiscovery } from './endpoint-ipc-discovery';
import { listToasts } from './toast-log-data';

/** Error-toast look-back window — matches the 1-min service-health tick. */
export const DESKTOP_ERROR_WINDOW_MS = 60_000;

const BRIDGE_TOKEN_DIR = '/tmp';
const BRIDGE_TOKEN_PREFIX = 'tauri-dev-bridge-';
const BRIDGE_TOKEN_SUFFIX = '.token';

export interface LiveBridge {
  port: number;
  token: string;
  pid: number;
}

/** Injectable signal-gatherers — real impls below; tests pass stubs. */
export interface DesktopSignals {
  /**
   * ALL live tauri dev-bridges currently running, else []. EI-15095: on this
   * shared fleet dev box several concurrently-running desktop instances (the
   * owner's + any number of agents' own headless verification shells per
   * /internal/docs/testing/agent-e2e) each hold their own bridge under the
   * SAME $HOME at once — plural, not "the" one bridge.
   */
  liveBridges(): Promise<LiveBridge[]>;
  /** A `/eval` round-trip through the webview succeeds (webview up + JS works). */
  bridgeEval(bridge: LiveBridge): Promise<boolean>;
  /**
   * The live operator port THIS bridge routes `/api/*` to, read through the
   * bridge's authenticated `/health` response. `null` means an older bridge or
   * a failed health request; callers must abstain rather than guess globally.
   */
  bridgeApiPort(bridge: LiveBridge): Promise<number | null>;
  /**
   * The selected operator's PER-PORT IPC unix socket is connectable. NOTE:
   * connectable ≠ serving — see `attemptIpcConnect`. Use `apiRoundTrip` for
   * "can it actually answer". Missing strict per-port discovery is unresolved,
   * never a reason to fall back to the last-writer-wins singleton.
   */
  ipcConnectable(apiPort: number): Promise<DesktopIpcResult>;
  /** An application-level round-trip to the same bridge-local API port. */
  apiRoundTrip(apiPort: number): Promise<DesktopApiResult>;
  /** Count of ERROR toasts in the last `windowMs`. */
  recentErrorCount(windowMs: number): Promise<number>;
}

/**
 * Outcome of the `/api` round-trip.
 *
 * `unresolved` is deliberately NOT a failure: it means we never learned which
 * operator this desktop targets (no readable `desktop-build-target.json`), so
 * the port we would have probed is a GUESS. This file's history is a string of
 * false-DOWN regressions (EI-2339, EI-7760, EI-15095, EI-18131725582506957) and
 * alarming on a guessed port would be the next one — so an unresolved target is
 * reported in the note and left out of the up/down decision.
 */
export type DesktopApiState = 'ok' | 'unreachable' | 'unresolved';

export interface DesktopApiResult {
  state: DesktopApiState;
  /** The port probed (or that would have been probed, when `unresolved`). */
  port: number;
}

export type DesktopIpcState = 'ok' | 'unreachable' | 'unresolved';

export interface DesktopIpcResult {
  state: DesktopIpcState;
  port: number;
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process (dead); EPERM = alive but not ours (still alive).
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Scan /tmp for EVERY dev-bridge token whose owning pid is alive (stale =
 * skipped). EI-15095: this used to `return` on the FIRST live match — fine
 * when at most one desktop ever runs, but on this shared fleet dev box
 * `readdir` order is filesystem-dependent and routinely turns up several
 * concurrently-alive bridges (one per desktop instance under the same
 * $HOME — the owner's own + any agent's headless verification shell).
 * Picking exactly one arbitrary bridge meant an unrelated instance's
 * transient webview hiccup could flip the SHARED desktop-health alarm to
 * DOWN even though the instance the health probe actually cares about (the
 * one `ipcConnectable()` resolves via `desktop-build-target.json`) was
 * perfectly fine. `probeDesktop` now keeps every eval/IPC/API result inside a
 * bridge-local tuple before it aggregates them.
 */
async function realLiveBridges(): Promise<LiveBridge[]> {
  let files: string[];
  try {
    files = await readdir(BRIDGE_TOKEN_DIR);
  } catch {
    return [];
  }
  const bridges: LiveBridge[] = [];
  for (const f of files) {
    if (!f.startsWith(BRIDGE_TOKEN_PREFIX) || !f.endsWith(BRIDGE_TOKEN_SUFFIX)) continue;
    try {
      const j = JSON.parse(await readFile(`${BRIDGE_TOKEN_DIR}/${f}`, 'utf8')) as Partial<LiveBridge>;
      const port = Number(j?.port);
      const token = typeof j?.token === 'string' ? j.token : '';
      const pid = Number(j?.pid);
      if (!port || !token || !pidAlive(pid)) continue;
      bridges.push({ port, token, pid });
    } catch {
      // unreadable / corrupt token → skip, keep scanning the rest
    }
  }
  return bridges;
}

/** POST /eval { js:'1' } to the bridge; a 200 means the webview executed JS. */
async function realBridgeEval(bridge: LiveBridge, timeoutMs = 4000): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/eval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ js: '1', token: bridge.token }),
      signal: ctl.signal,
    });
    if (!res.ok) return false; // 504 = webview wedged, 401 = bad token
    const j = (await res.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
    // A round-tripped eval returns a `result`; an `error` field means JS threw.
    return j != null && 'result' in j && j.error == null;
  } catch {
    return false; // bridge process unreachable
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask THIS bridge which operator it routes `/api/*` to right now.
 *
 * EI-19357343092509867: bridge tokens are already per desktop process, while
 * `desktop-build-target.json` is shared and last-writer-wins. The bridge's
 * authenticated `/health` response is therefore the smallest existing seam
 * that can correlate a live webview with its own mutable `SELECTED_API_PORT`.
 */
export async function realBridgeApiPort(bridge: LiveBridge, timeoutMs = 4000): Promise<number | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: bridge.token }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const json = (await res.json().catch(() => null)) as { selected_api_port?: unknown } | null;
    const port = json?.selected_api_port;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** desktop-build-target.json's known content ports → API port (EI-190's api_port_for_target,
 *  mirrored from env_switch.rs): :3055 (bare Vite SPA, no operator of its own) proxies /api
 *  to the :3070 release operator; every other target IS its own API port. Exported for
 *  direct unit testing (mirrors the Rust-side mapping — kept in lockstep by inspection). */
export function apiPortForTarget(targetPort: number): number {
  return targetPort === 3055 ? 3070 : targetPort;
}

/** dev :3270 is "the session's OWN working-tree operator" — the desktop's default target
 *  (env_switch.rs TARGETS[0]) when no persisted choice exists yet. */
export const DEFAULT_DESKTOP_TARGET_PORT = 3270;

/**
 * Which operator port does THIS desktop route `/api/*` to?
 *
 * `resolved` distinguishes "the desktop told us" (we read its persisted
 * `desktop-build-target.json`) from "we fell back to the dev default" — the
 * difference between a port worth alarming on and a guess. Only the former may
 * flip the probe DOWN; see `DesktopApiState`.
 */
export async function resolveDesktopApiPort(): Promise<{ apiPort: number; resolved: boolean }> {
  try {
    const raw = await readFile(join(homedir(), '.papercusp', 'desktop-build-target.json'), 'utf8');
    const j = JSON.parse(raw) as { port?: unknown };
    if (typeof j?.port === 'number' && Number.isFinite(j.port)) {
      return { apiPort: apiPortForTarget(j.port), resolved: true };
    }
  } catch {
    /* missing/corrupt → fall through to the dev default (:3270) */
  }
  return { apiPort: apiPortForTarget(DEFAULT_DESKTOP_TARGET_PORT), resolved: false };
}

/**
 * Resolve which operator's IPC discovery file actually describes THIS desktop's
 * `/api` target — not the shared last-writer-wins singleton (EI-7760).
 *
 * `~/.papercusp/endpoint-ipc.json` (the legacy singleton `readEndpointIpcDiscovery`
 * reads) is overwritten by EVERY operator that boots on this box — and this dev box
 * routinely runs many concurrent harness/fleet dev operators on distinct ports at
 * once. Whichever one wrote LAST wins the singleton, so at any given instant it can
 * point at a completely unrelated (and possibly dead) operator, producing a false
 * "ipc socket unreachable" verdict for a desktop whose OWN configured operator is
 * perfectly healthy (confirmed live 2026-07-05: the singleton pointed at a dead pid
 * while the desktop's actual target — port 3270 per desktop-build-target.json — had
 * a live, connectable socket the whole time).
 *
 * The desktop persists which env it's pointed at in `~/.papercusp/desktop-build-target.json`
 * ({name, port} — the exact file `env_switch.rs`'s Rust side reads/writes), so we read
 * THAT to resolve the per-port discovery file (EI-190) for the operator the desktop
 * actually targets. Falls back to the legacy singleton only if no per-port file exists
 * yet (e.g. a very old operator process pre-dating EI-190) — strictly better than
 * always trusting the racy singleton.
 */
export async function resolveDesktopIpcDiscovery(): Promise<EndpointIpcDiscovery | null> {
  const { apiPort } = await resolveDesktopApiPort();
  const perPort = await readEndpointIpcDiscoveryForPort(apiPort).catch(() => null);
  if (perPort) return perPort;
  // Fall back to the legacy singleton (better than nothing if no per-port file exists).
  return readEndpointIpcDiscovery();
}

/**
 * One connect attempt to the operator IPC unix socket; success = the socket
 * EXISTS and is listening.
 *
 * ⚠ It does NOT mean the operator can serve. `connect()` is completed by the
 * KERNEL out of the listen backlog — the server process is never scheduled — so
 * this stays `true` against a process whose event loop is completely blocked,
 * until the backlog fills. Measured (WI-7355), a listener probed by a separate
 * process, before and inside a 6s synchronous spin:
 *
 *   loop free  →  unix connect=true   tcp connect=true   http round-trip=true
 *   BLOCKED    →  unix connect=true   tcp connect=true   http round-trip=false
 *
 * i.e. the connect legs cannot tell the two states apart at all. That is why
 * `probeDesktop` also requires `apiRoundTrip` — a wedged sidecar reported
 * `desktop: up` for the whole of EI-19406226890070872 on the strength of this
 * check alone. Keep this as the cheap "is it there" signal; never read it as
 * "is it working".
 */
function attemptIpcConnect(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = net.connect(socketPath);
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/**
 * Connect to the operator IPC unix socket; success = the channel is alive.
 *
 * Retries ONCE after a short delay before reporting unreachable (EI-18131725582506957):
 * a routine, sanctioned `dev:restart { target:'staging' }` (or its ~2min coalesced
 * auto-fire — CLAUDE.md § two-port model, WI-4221) tears down and re-execs the target
 * operator process in a window typically well under `RETRY_DELAY_MS`. Without a retry,
 * a service-health probe tick that lands inside that window sees a refused/absent
 * socket and — since `diffHealth` transitions on a SINGLE bad tick with no debounce —
 * immediately broadcasts a false "desktop DOWN" and auto-files a major `service-down`
 * watchdog bug, even though the operator (and the desktop) were never actually down for
 * any observer outside that exact probe instant. Confirmed live: EI-18131725582506957
 * fired at 03:16:00Z reporting "ipc socket unreachable"; the resolved target socket
 * (staging :3170, pid 2046101) was independently verified connectable moments later
 * with no intervening action — a same-tick restart-window flap, not a real outage. A
 * genuinely dead/wedged operator still fails both attempts and correctly alerts.
 */
export async function realIpcConnectable(timeoutMs = 2000, retryDelayMs = RETRY_DELAY_MS): Promise<boolean> {
  const disc = await resolveDesktopIpcDiscovery();
  if (!disc?.socketPath) return false;
  if (await attemptIpcConnect(disc.socketPath, timeoutMs)) return true;
  await new Promise((r) => setTimeout(r, retryDelayMs));
  return attemptIpcConnect(disc.socketPath, timeoutMs);
}

/**
 * Strict per-port IPC check for one bridge-local tuple.
 *
 * Unlike `realIpcConnectable`, this never consults the legacy singleton. A
 * missing per-port advertisement is `unresolved`: using the singleton would
 * silently attach another desktop/operator's socket to this bridge and
 * recreate EI-19357343092509867.
 */
export async function realIpcConnectableForPort(
  apiPort: number,
  timeoutMs = 2000,
  retryDelayMs = RETRY_DELAY_MS,
): Promise<DesktopIpcResult> {
  const disc = await readEndpointIpcDiscoveryForPort(apiPort).catch(() => null);
  if (!disc?.socketPath) return { state: 'unresolved', port: apiPort };
  if (await attemptIpcConnect(disc.socketPath, timeoutMs)) return { state: 'ok', port: apiPort };
  await new Promise((r) => setTimeout(r, retryDelayMs));
  return {
    state: (await attemptIpcConnect(disc.socketPath, timeoutMs)) ? 'ok' : 'unreachable',
    port: apiPort,
  };
}

/** Delay before the single retry in {@link realIpcConnectable} — comfortably bridges a
 *  routine operator restart's stop→re-exec window without materially slowing a real-down verdict.
 *  Exported so tests can override it (via the `retryDelayMs` param) instead of sleeping for real. */
export const RETRY_DELAY_MS = 1000;

/**
 * Per-attempt budget for the `/api` round-trip. Generous on purpose: this box
 * runs the whole fleet's builds and test suites, and probe impatience has
 * already produced one false-DOWN alarm here (EI-6902 — vite, fixed by raising
 * its timeout to 10s). A genuine wedge lasts minutes, so nothing is lost by
 * waiting seconds. Measured healthy latency on :3070 and :3270: ~1.2ms.
 */
export const API_PROBE_TIMEOUT_MS = 5000;

/** The endpoint used for the round-trip — the same one `HEALTH_ENDPOINTS` uses for
 *  `operator`/`staging-api`, so it is known-served by every operator build and cheap. */
export const API_PROBE_PATH = '/api/desktop/version';

/** One HTTP round-trip attempt against the desktop's `/api` target. */
async function attemptApiRoundTrip(apiPort: number, timeoutMs: number): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}${API_PROBE_PATH}`, { signal: ctl.signal });
    // Drain: an unconsumed body keeps its socket checked out of the pool, and
    // this runs on every 1-min health tick forever. A probe for resource
    // starvation must not itself leak a socket per tick.
    await res.body?.cancel().catch(() => {});
    // Any answered status proves the event loop ran and the router replied. Only
    // a 5xx says the operator itself is broken; a 404 would mean an older build
    // without this route, which is not a liveness failure.
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Does the operator this desktop routes `/api/*` to actually answer? (WI-7355)
 *
 * Retries ONCE for the same reason `realIpcConnectable` does: the desktop's
 * target may be :3170, which `dev:restart { target:'staging' }` legitimately
 * re-execs several times a day (CLAUDE.md § two-port model, WI-4221), and
 * `diffHealth` transitions on a single bad tick with no debounce.
 */
export async function realApiRoundTrip(
  timeoutMs = API_PROBE_TIMEOUT_MS,
  retryDelayMs = RETRY_DELAY_MS,
): Promise<DesktopApiResult> {
  const { apiPort, resolved } = await resolveDesktopApiPort();
  if (!resolved) return { state: 'unresolved', port: apiPort };
  return realApiRoundTripForPort(apiPort, timeoutMs, retryDelayMs);
}

/** Application-level liveness check for one already-resolved bridge target. */
export async function realApiRoundTripForPort(
  apiPort: number,
  timeoutMs = API_PROBE_TIMEOUT_MS,
  retryDelayMs = RETRY_DELAY_MS,
): Promise<DesktopApiResult> {
  if (await attemptApiRoundTrip(apiPort, timeoutMs)) return { state: 'ok', port: apiPort };
  await new Promise((r) => setTimeout(r, retryDelayMs));
  return {
    state: (await attemptApiRoundTrip(apiPort, timeoutMs)) ? 'ok' : 'unreachable',
    port: apiPort,
  };
}

async function realRecentErrorCount(windowMs: number): Promise<number> {
  const since = Date.now() - windowMs;
  const { toasts } = await listToasts({ since, limit: 200 });
  return toasts.filter((t) => t.level === 'error').length;
}

export const realDesktopSignals: DesktopSignals = {
  liveBridges: realLiveBridges,
  bridgeEval: realBridgeEval,
  bridgeApiPort: realBridgeApiPort,
  ipcConnectable: (apiPort) => realIpcConnectableForPort(apiPort),
  apiRoundTrip: (apiPort) => realApiRoundTripForPort(apiPort),
  recentErrorCount: realRecentErrorCount,
};

/**
 * Probe the desktop. Returns a `ProbeResult` with `present` set:
 *   - present:false → no desktop running (skipped by diffHealth → no DOWN spam).
 *   - present:true, up:true → at least one COMPLETE bridge-local tuple is
 *     healthy, or a webview is healthy but its target metadata/checks are
 *     unresolved (abstain rather than manufacture a false DOWN).
 *   - present:true, up:false → desktop is up but a liveness signal failed.
 * `recentErrors` + `note` carry the toastLog signal as informational detail.
 *
 * EI-19357343092509867: every eval/IPC/API decision stays inside the bridge
 * tuple that supplied its live selected port. A passing eval from desktop A
 * can never combine with desktop B's healthy operator to manufacture UP (and
 * B's failing operator can never manufacture DOWN for A).
 */
export async function probeDesktop(signals: DesktopSignals = realDesktopSignals): Promise<ProbeResult> {
  const start = Date.now();
  const bridges = await signals.liveBridges().catch(() => []);
  if (bridges.length === 0) {
    return {
      name: 'desktop',
      up: false,
      present: false,
      status: null,
      latencyMs: Date.now() - start,
      note: 'not running (no live dev-bridge)',
    };
  }

  const [tuples, recentErrors] = await Promise.all([
    Promise.all(
      bridges.map(async (bridge) => {
        const [evalOk, apiPort] = await Promise.all([
          signals.bridgeEval(bridge).catch(() => false),
          signals.bridgeApiPort(bridge).catch(() => null),
        ]);
        if (apiPort == null) {
          return {
            evalOk,
            apiPort,
            ipc: { state: 'unresolved', port: 0 } as DesktopIpcResult,
            api: { state: 'unresolved', port: 0 } as DesktopApiResult,
          };
        }
        const [ipc, api] = await Promise.all([
          signals.ipcConnectable(apiPort).catch((): DesktopIpcResult => ({ state: 'unresolved', port: apiPort })),
          signals.apiRoundTrip(apiPort).catch((): DesktopApiResult => ({ state: 'unresolved', port: apiPort })),
        ]);
        return { evalOk, apiPort, ipc, api };
      }),
    ),
    signals.recentErrorCount(DESKTOP_ERROR_WINDOW_MS).catch(() => 0),
  ]);

  const healthy = tuples.some((t) => t.evalOk && t.ipc.state === 'ok' && t.api.state === 'ok');
  // A healthy webview whose own target cannot be evaluated remains a plausible
  // healthy desktop. Abstain instead of turning missing/rolling metadata into
  // the fifth false-DOWN class in this probe's history.
  const unresolvedHealthyCandidate = tuples.some(
    (t) => t.evalOk && (t.apiPort == null || t.ipc.state === 'unresolved' || t.api.state === 'unresolved'),
  );
  const up = healthy || unresolvedHealthyCandidate;
  const errNote = recentErrors > 0 ? `${recentErrors} recent error toast${recentErrors === 1 ? '' : 's'}` : '';
  const bridgeTargetUnresolved = tuples.some((t) => t.evalOk && t.apiPort == null);
  const ipcTargetUnresolved = tuples.some((t) => t.evalOk && t.apiPort != null && t.ipc.state === 'unresolved');
  const apiTargetUnresolved = tuples.some((t) => t.evalOk && t.apiPort != null && t.api.state === 'unresolved');
  const unresolvedNote = [
    bridgeTargetUnresolved && 'bridge target unresolved, not checked',
    ipcTargetUnresolved && 'ipc target unresolved, not checked',
    apiTargetUnresolved && 'api target unresolved, not checked',
  ]
    .filter(Boolean)
    .join('; ');
  let note: string;
  if (up) {
    const detail = [unresolvedNote, errNote].filter(Boolean).join('; ');
    note = detail ? `up (${detail})` : 'up';
  } else {
    const fails = Array.from(
      new Set(
        tuples.flatMap((t) => [
          ...(!t.evalOk ? ['webview eval'] : []),
          ...(t.ipc.state === 'unreachable' ? [`ipc socket :${t.ipc.port}`] : []),
          ...(t.api.state === 'unreachable' ? [`api :${t.api.port}`] : []),
        ]),
      ),
    ).join(' + ');
    const bridgeNote = bridges.length > 1 ? ` (${bridges.length} bridges checked)` : '';
    const detail = [unresolvedNote, errNote].filter(Boolean).join('; ');
    note = `unhealthy: ${fails} unreachable${bridgeNote}${detail ? `; ${detail}` : ''}`;
  }

  return {
    name: 'desktop',
    up,
    present: true,
    status: null,
    latencyMs: Date.now() - start,
    note,
    recentErrors,
  };
}
