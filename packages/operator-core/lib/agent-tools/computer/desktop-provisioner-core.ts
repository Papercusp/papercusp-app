/**
 * desktop-provisioner.ts — stand up a disposable, ISOLATED sandbox desktop
 * (Xvfb + window manager + optional apps) for a bee to operate through
 * capability:computer. NEVER the host display :0.
 *
 * Two worlds, one shape:
 *   - On a deployed desktop FRAME, the Xvfb displays are pre-stood-up by
 *     `frame-bootstrap` and leased per-agent via `display-allocator`
 *     (`acquireAgentDisplay`), which sets the agent's DISPLAY. This provisioner
 *     is NOT used there.
 *   - On a plain box (local dev / a single-node demo), THIS provisioner starts
 *     its own Xvfb + WM + apps so the capability works without the cloud frame.
 *     It is also the reference for exactly what the frame bootstrap does.
 *
 * The returned `display` is what the capability:computer lease env
 * (`PAPERCUSP_COMPUTER_DISPLAY`) is set to for the operating agent.
 */
import { spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyGlStrategy, detectGlStrategy, hostGlProbe, type GlStrategy } from '../../desktop/gl-strategy';
import type { managedSpawn, markManagedSpawnTeardown } from '../../task-manager/managed-spawn';
import type { killScopeUnit, killTask } from '../../task-manager/control';
import { sandboxXEnv } from './desktop-driver';
import type { startA11yBus, A11yBus } from '../../desktop/a11y-bus-core';
import {
  buildXServerCommand,
  kasmvncWebsocketPort,
  type DesktopXServer,
} from '../../desktop/x-server-backend';
import {
  mintKasmvncSessionCredentials,
  type KasmvncSessionCredentials,
} from '../../desktop/kasmvnc-credentials';
import type { DesktopSandboxSession } from './desktop-sandbox';

const DEFAULT_W = 1024;
const DEFAULT_H = 768;
const BASE_DISPLAY = 110; // well clear of :0 (host) and the frame pool default (:99)

export interface SandboxDesktop {
  /**
   * False once the desktop is gone: its X server exited (a desktop this process
   * provisioned) or its worker's socket closed (a worker-served one). Sampled at call
   * time, never cached.
   */
  isAlive?: () => boolean;
  /**
   * WI-10004206 — settles once, when the X server at the root of this desktop exits,
   * whether a release killed it or it died on its own. Absent for a desktop served by
   * another process, where the socket is the only liveness signal.
   *
   * THE FAILURE THIS CLOSES. The X server was spawned with `stdio: 'ignore'` and nothing
   * watched it, so when it died the worker kept its socket open and the lease kept
   * offering a `ready` desktop whose every dial failed `desktop_dial_failed`, with no
   * trace of why in any journal (measured on owner-test 2026-09-30).
   */
  xServerExited?: Promise<DesktopXServerExit>;
  /** X display string, e.g. ":110". Set this as PAPERCUSP_COMPUTER_DISPLAY for the agent. */
  display: string;
  number: number;
  width: number;
  height: number;
  /**
   * The GL stack the desktop's apps were launched under, MEASURED at provision time.
   *
   * This is the honest answer to "will a screenshot of this desktop show anything?" — a
   * bare Xvfb gives WebKitGTK no EGL context, so GTK/WebKitGTK apps paint nothing and
   * every capture comes back blank regardless of the DOM
   * (agent-insights/headless-desktop-testing-needs-gl). `gl.tier === 'none'` means pixel
   * evidence from this desktop is not trustworthy; callers should gate on it rather than
   * capture and believe the result. Feeds `capabilities.gl` in the D-004 registry, which
   * is specified as MEASURED and never assumed.
   */
  gl: GlStrategy;
  /**
   * WI-1223202 — was `gl` measured INSIDE the sandbox the apps run in?
   *
   * The provenance of the measurement, carried beside the measurement, because the two
   * answer different questions and a consumer of `gl.tier` cannot tell them apart. `false`
   * is not a fault: it is the correct and honest state for a desktop whose apps are NOT
   * sandboxed, where the host IS the app's machine. `false` on a SANDBOXED desktop would be
   * the D-031 failure mode returning — a tier describing a different machine than the apps
   * run on — which is why this is a field a test can assert rather than a comment.
   */
  glProbeSandboxed: boolean;
  /**
   * P-005 — the task-ledger id of the Xvfb, when the ledger enrolled it.
   *
   * This is what makes the desktop governable ACROSS PROCESSES: the in-process
   * `release()` below dies with this operator loop, but a task id is a durable
   * handle any process on the host can freeze, thaw or kill. The lifecycle
   * governor (`gc-desktop-sessions`) has no other way to reach these processes.
   *
   * `null` when the task manager is off or its ledger write failed. That is a
   * legal, degraded state, not an error: the desktop works, it simply cannot be
   * frozen — and the governor reports exactly that rather than no-opping.
   */
  taskId: string | null;
  /**
   * P-007 — this desktop's accessibility bus, when one came up.
   *
   * Absent means screenshot-only, which is a legal degraded state and NOT an error:
   * a host with no `at-spi2-core` still gets a perfectly good desktop. Callers that
   * need the tree should read this rather than assume, exactly as they read `gl`
   * rather than assume pixels.
   */
  a11y?: A11yBus;
  /**
   * D-006 — the capture bounding box requested for this lease, if the caller asked
   * for one. Absent means "use the 1024x768 default", which is what both the
   * registry and `capability:computer` apply — it does NOT mean "capture full size".
   *
   * Optional on purpose: not requesting a box is the overwhelmingly common case, and
   * making it required would force every construction site to restate the default,
   * which is how one default becomes three copies that drift.
   */
  capture?: { width: number; height: number };
  /**
   * P-012 — which X server occupies the root of this desktop's process tree.
   *
   * Read this rather than inferring from the presence of `endpoint`: it is what the
   * D-007 registry row's `kind` must agree with, and mislabelling a KasmVNC desktop
   * as `xvfb-local` would tell the viewer lane there is nothing to connect to.
   */
  xServer: DesktopXServer;
  /**
   * P-012 / D-020 — the LOOPBACK websocket this desktop's pixels are served on, or
   * absent for a backend that serves none (`Xvfb` runs `-nolisten tcp`).
   *
   * Never routable off-host by construction: P-013's ticket-gated proxy is the only
   * thing that dials it, and `x-server-backend.ts` pins the bind address rather than
   * inheriting KasmVNC's shipped `interface: all`.
   */
  endpoint?: { host: string; port: number };
  /**
   * P-012 / D-020 — this session's rotated watch/takeover credentials, when the
   * backend authenticates. Absent for `xvfb`, which has nothing to authenticate to.
   */
  credentials?: KasmvncSessionCredentials;
  /**
   * WI-1105361 — what each requested app actually DID, so a blank framebuffer can be
   * told apart from an app that never ran.
   *
   * THE FAILURE THIS CLOSES. Apps were spawned with `stdio: 'ignore'`, so when one died
   * on launch the only observable was pixels that never changed. A caller watching the
   * framebuffer — `desktop-gl-live.test.ts` polling for first paint — then reported "the
   * strategy claimed GL, the pixels disagree" after 30s, which reads as an indictment of
   * the GL ladder and is the wrong question entirely when `vglrun` exited non-zero in the
   * first 200ms and printed the reason to a discarded stderr. Measured 2026-08-30: the
   * live GL suite failed ~2 runs in 4 that way, and neither the verdict nor the poll
   * duration could distinguish "painted nothing" from "was never running".
   *
   * `stderrTail` is bounded (last {@link APP_STDERR_TAIL_BYTES} bytes) — a long-lived
   * chatty app must not grow this without limit — and holds the app's OWN stderr, which
   * for a sandboxed GL app is where `[VGL] ERROR:` and `bwrap:` refusals surface.
   *
   * Reading it is a snapshot: `alive` is sampled at call time, never cached.
   */
  appDiagnostics: () => DesktopAppDiagnostic[];
  /** Tear the desktop down — kill apps, WM, and the X server. Idempotent. */
  release: () => Promise<void>;
}

/** Bounded stderr retained per app — enough for a launch failure, never a log sink. */
export const APP_STDERR_TAIL_BYTES = 4096;

/** Bounded X server stderr. Xkasmvnc logs every client connect, so this is a tail, never a sink. */
export const X_SERVER_STDERR_TAIL_BYTES = 8192;

/** WI-10004206 — how a desktop's X server ended, as seen by the process that spawned it. */
export interface DesktopXServerExit {
  code: number | null;
  signal: string | null;
  /** Last {@link X_SERVER_STDERR_TAIL_BYTES} bytes of the X server's own stderr. */
  stderrTail: string;
}

/** Thrown when the X server exits before its display accepts connections. */
export class DesktopXServerExitedError extends Error {
  constructor(readonly display: string, readonly exit: DesktopXServerExit) {
    super(`desktop-provisioner — X server for ${display} exited before accepting connections (code=${exit.code ?? '-'} signal=${exit.signal ?? '-'})`);
    this.name = 'DesktopXServerExitedError';
  }
}

/** One journal line for an X server exit: the reason, then its last words. */
export function describeXServerExit(display: string, exit: DesktopXServerExit): string {
  const tail = exit.stderrTail.trim();
  return `X server for ${display} exited code=${exit.code ?? '-'} signal=${exit.signal ?? '-'}` +
    (tail ? `; stderr tail:\n${tail}` : '; it wrote nothing to stderr');
}

/**
 * Watch the X server at the root of a desktop: drain and tail its stderr, and settle
 * `exited` when it goes. Liveness reads the child, never a cached boolean.
 */
export function watchXServer(child: ChildProcess): {
  isAlive: () => boolean;
  exited: Promise<DesktopXServerExit>;
  exit: () => DesktopXServerExit | null;
} {
  let stderrTail = '';
  let exit: DesktopXServerExit | null = null;
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-X_SERVER_STDERR_TAIL_BYTES);
  });
  // A failed diagnostic pipe must not take the desktop with it.
  child.stderr?.on('error', () => {});
  const exited = new Promise<DesktopXServerExit>((resolve) => {
    const settle = (code: number | null, signal: string | null): void => {
      exit ??= { code, signal, stderrTail };
      resolve(exit);
    };
    child.once('exit', (code, signal) => {
      // 'close' follows once stderr has drained, so waiting for it keeps the server's
      // last words. Bounded, because a descendant that inherited the pipe can hold it open.
      const timer = setTimeout(() => settle(code, signal), 1000);
      timer.unref?.();
      child.once('close', () => { clearTimeout(timer); settle(code, signal); });
    });
    // A spawn that never started emits 'error' and no 'exit'.
    child.once('error', (error) => {
      if (child.pid !== undefined) return;
      stderrTail = `${stderrTail}${error.message}`.slice(-X_SERVER_STDERR_TAIL_BYTES);
      settle(null, null);
    });
  });
  return {
    isAlive: () => exit === null && child.exitCode === null && child.signalCode === null,
    exited,
    exit: () => exit ?? (child.exitCode === null && child.signalCode === null
      ? null
      : { code: child.exitCode, signal: child.signalCode, stderrTail }),
  };
}

/** Live bookkeeping behind {@link SandboxDesktop.appDiagnostics}. */
interface AppRecord {
  argv: readonly string[];
  child: ChildProcess;
  /** Mutated by the stderr listener; trimmed to APP_STDERR_TAIL_BYTES on every append. */
  stderrTail: string;
}

/**
 * Snapshot the app records. Separate from the closure so the shape is testable and so
 * `alive` is unambiguously sampled HERE rather than at spawn time — a cached liveness
 * boolean is the same lie the discarded stderr was.
 */
function snapshotAppDiagnostics(records: readonly AppRecord[]): DesktopAppDiagnostic[] {
  return records.map((record) => ({
    argv: record.argv,
    pid: record.child.pid ?? null,
    // `exitCode === null && signalCode === null` is the only state that means "still
    // running": node sets one of them the moment the process is reaped.
    alive: record.child.exitCode === null && record.child.signalCode === null,
    exitCode: record.child.exitCode,
    exitSignal: record.child.signalCode,
    stderrTail: record.stderrTail,
  }));
}

/** WI-1105361 — one app's observed launch outcome. See {@link SandboxDesktop.appDiagnostics}. */
export interface DesktopAppDiagnostic {
  /** The app as the CALLER asked for it, before the GL prefix and sandbox wrap. */
  argv: readonly string[];
  pid: number | null;
  /** Sampled when `appDiagnostics()` is called, not when the app was spawned. */
  alive: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  /** Last {@link APP_STDERR_TAIL_BYTES} bytes of the app's own stderr. */
  stderrTail: string;
}

export interface ProvisionOptions {
  /** Force a display number (must be > 0). Default: lowest free ≥ 110. */
  displayNumber?: number;
  width?: number;
  height?: number;
  /**
   * D-006 — request a larger (or smaller) CAPTURE bounding box than the 1024x768
   * default. The X server still runs at `width`x`height`; this only changes what
   * `capability:computer` serves the model, and is the deliberate opt-out for an
   * agent that genuinely needs more detail and accepts the token cost.
   */
  captureWidth?: number;
  captureHeight?: number;
  /** Launch a window manager (openbox). Default true. */
  windowManager?: boolean;
  /**
   * What runs on the display. `'openbox'` (default) is the bare WM agent desktops use.
   * `'xfce'` is a full XFCE session for the customer-facing hosted desktop (WI-10002863);
   * xfwm4 replaces openbox. Anything launched from its panel inherits the session, not the
   * per-app bubblewrap wrapper, so use it only where the enclosing unit is the sandbox (the
   * pack's papercusp-desktop@ worker). Ignored when `windowManager` is false.
   */
  desktopSession?: 'openbox' | 'xfce';
  /**
   * Paint the X root this solid `#rrggbb` colour once the display is up. Default: leave
   * the server's black root. A customer-facing desktop sets it so that an empty desktop
   * reads differently from a dead stream (WI-10002863); requires `xsetroot`.
   */
  rootColor?: string;
  /** Apps to launch on the desktop, as argv arrays (e.g. [['xterm'], ['firefox','--no-remote']]). */
  apps?: string[][];
  /** How long to wait for the X server to accept connections. Default 8s. */
  readyTimeoutMs?: number;
  /**
   * Override the GL strategy instead of measuring it. Default: measure the live display
   * via `detectGlStrategy`. Present so a test can pin a rung (and so a caller who has
   * ALREADY measured this display need not pay the probe again) — not a way to assert a
   * capability the host does not have: whatever is passed here is what gets recorded, so
   * passing a hardware strategy on a GL-less box produces exactly the dishonest
   * capability record the measurement exists to prevent.
   */
  gl?: GlStrategy;
  /**
   * P-005 task-ledger provenance — who this desktop is FOR. Shows up in
   * `processes:list`, which is the whole reason the ledger exists: `ps` can tell
   * you an Xvfb is running and never why, so a stray one is undiagnosable and
   * therefore never cleaned up. Defaults to `system:desktop-provisioner`.
   */
  launchedBy?: string;
  /** Harness the desktop belongs to, recorded on its ledger rows. */
  harnessSlug?: string;
  /**
   * P-007 — stand up an accessibility bus for this desktop. Default true.
   *
   * Default-ON because it is what makes `computer:observe` work at all, and because
   * it is cheap and additive: one `dbus-daemon` whose only activatable service is
   * `org.a11y.Bus` (deliberately NOT a full session — see a11y-bus.ts for the portal
   * cascade that measurement ruled out). Set false for a desktop that will only ever
   * be screenshotted.
   */
  accessibility?: boolean;
  /**
   * P-010 — wrap each app in bubblewrap. Defaults to the `papercusp-desktop-app-sandbox`
   * flag. Present as an override so a test can pin either side without touching flag IO,
   * and so a caller launching something that genuinely needs the host FS can opt out
   * per-desktop rather than flipping the flag off for everyone.
   */
  sandboxApps?: boolean;
  /**
   * P-010 — also deny the apps NETWORK access (`--unshare-net`). Default false, per
   * D-015 §3: a desktop exists to run real apps, and a silently network-less browser is a
   * worse failure than an un-isolated one. Safe to combine with the sandbox — the mount
   * plan keeps the display reachable when the abstract X socket disappears with the netns.
   */
  denyAppNetwork?: boolean;
  /** P-010 — HOME to give apps a private writable copy of. Defaults to the operator's. */
  sandboxHomeDir?: string;
  /**
   * P-012 / D-020 — which X server to boot this desktop on. Default `'xvfb'`.
   *
   * `'kasmvnc'` boots `Xkasmvnc`, which is an X server AND a web-native pixel
   * transport in one process, and is what the BYOC desktop pack installs. The rest of
   * this function does not branch on it: D-021 keeps the WM, the a11y bus, the GL
   * measurement, the bwrap plan and the ledger enrolment X-bound, so they are
   * identical either way. That sameness is the point — it is what makes "local-dev
   * Xvfb parity" a structural property rather than a maintained claim.
   */
  xServer?: DesktopXServer;
  /**
   * P-012 — an existing kasmvncpasswd file to start the server against. Omit and a
   * fresh per-session pair of watch/takeover credentials is minted under
   * `credentialDir`. Present so a caller that already provisioned credentials (the
   * pack's pool warmer) does not mint a second, orphaned set.
   */
  kasmvncPasswordFile?: string;
  /** P-012 — directory for a minted credential file. Default `/run/papercusp/desktop`. */
  credentialDir?: string;
  /**
   * P-012 — absolute path to the X server binary when it is not on PATH. The BYOC
   * pack installs to a system path, so this exists for harnesses that run an
   * extracted, un-installed build.
   */
  xServerBinaryPath?: string;
  /** P-012 — path to `kasmvncpasswd`, when not on PATH. Pairs with `xServerBinaryPath`. */
  kasmvncPasswdBinaryPath?: string;
  /**
   * P-012 / D-020 — enable the DRI3 `-hw3d` rung against this render node. Only
   * meaningful where a GPU exists; the GPU-less BYOC VMs leave it unset and take
   * gl-strategy's measured mesa-software rung.
   */
  kasmvncDrinode?: string;
}

/** The durable root handle used to tear down a provisioned desktop safely. */
export interface DesktopTaskHandle {
  taskId: string | null;
  scopeUnit: string | null;
  confined: boolean;
  /** False when the task manager was disabled or ledger registration degraded. */
  ledgered: boolean;
}

/** An OS-supervised worker supplies process ownership without receiving operator DB credentials. */
export interface DesktopProvisionRuntime {
  spawn: (...args: Parameters<typeof managedSpawn>) => Promise<{ child: ChildProcess; scopeUnit: string | null; confined: boolean; row: { detail: { unledgered?: boolean } }; taskId: string | null }>;
  startBus: typeof startA11yBus;
  sandbox: (display: string, env: NodeJS.ProcessEnv, opts: ProvisionOptions) => Promise<{
    forGlProbe: DesktopSandboxSession['forGlProbe'];
    forApp: (...args: Parameters<DesktopSandboxSession['forApp']>) => Pick<ReturnType<DesktopSandboxSession['forApp']>, 'binary' | 'argv' | 'sandboxed'>;
  }>;
  appEnv: (env: NodeJS.ProcessEnv, overlays: Record<string, string>) => NodeJS.ProcessEnv;
  releaseDeps?: DesktopReleaseDeps;
}

export interface DesktopReleaseDeps {
  /** Injectable so teardown order is regression-tested without systemd or PG. */
  killTask?: typeof killTask;
  /** Safe fallback for a confined scope that has no ledger row. */
  killScopeUnit?: typeof killScopeUnit;
  /** Mark systemd-run clients before their owning scope is intentionally drained. */
  markManagedTeardown?: typeof markManagedSpawnTeardown;
  sleep?: (ms: number) => Promise<void>;
}

type KillableProcess = Pick<ChildProcess, 'kill'>;

/**
 * Tear down the desktop's managed scopes before touching systemd-run client handles.
 *
 * For a confined, ledgered desktop, the ChildProcess values are systemd-run CLIENTS;
 * killing those first lets the payload scopes outlive their owners (WI-37509). The
 * task-manager root kill addresses the Xvfb scope and its logically-nested children,
 * after which the client handles are safe to finish. A task-manager-disabled desktop
 * has no scope/ledger and retains the old direct-process fallback.
 */
export async function releaseDesktopProcesses(
  procs: readonly KillableProcess[],
  root: DesktopTaskHandle,
  deps: DesktopReleaseDeps = {},
): Promise<void> {
  const missing = async (): Promise<never> => { throw new Error('managed desktop teardown requires its process owner'); };
  const taskKiller = deps.killTask ?? missing;
  const scopeKiller = deps.killScopeUnit ?? missing;
  const markTeardown = deps.markManagedTeardown ?? (() => () => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // A systemd-run client can exit with SIGTERM while its payload scope is still
  // draining. Mark the handles before issuing the cross-process kill so the exit
  // recorder downgrades that expected handoff to info rather than a false warning.
  const teardownMarkerCleanups: Array<() => void> = [];
  const hasManagedRoot = Boolean((root.ledgered && root.taskId) || (root.confined && root.scopeUnit));
  if (hasManagedRoot) {
    for (const p of procs) teardownMarkerCleanups.push(markTeardown(p));
  }
  const clearTeardownMarkers = (): void => {
    for (const cleanup of teardownMarkerCleanups) cleanup();
    teardownMarkerCleanups.length = 0;
  };

  let managedOutcome:
    | Awaited<ReturnType<typeof killTask>>
    | Awaited<ReturnType<typeof killScopeUnit>>
    | undefined;
  try {
    if (root.ledgered && root.taskId) {
      managedOutcome = await taskKiller(root.taskId, { includeSubtree: true });
      // A row can disappear between provision and release. If the scope handle is
      // still available, use the explicit unledgered control path instead of ever
      // reverting to client-first teardown.
      if (!managedOutcome.ok && managedOutcome.error === 'task_not_found' && root.confined && root.scopeUnit) {
        managedOutcome = await scopeKiller(root.scopeUnit);
      } else if (!managedOutcome.ok && managedOutcome.error === 'task_not_found') {
        // No scope means this was an unconfined/legacy row after all; retain the
        // direct-process fallback rather than treating a missing ledger row as a
        // managed teardown failure.
        managedOutcome = undefined;
      }
    } else if (root.confined && root.scopeUnit) {
      // Registration may have failed after systemd accepted the scope. The scope
      // unit is still a validated, safe handle even though no ledger row exists.
      managedOutcome = await scopeKiller(root.scopeUnit);
    }
  } catch (error) {
    clearTeardownMarkers();
    console.warn(
      `[desktop-provisioner] managed desktop teardown failed for ${root.taskId ?? root.scopeUnit ?? 'unknown root'}: ` +
        `${error instanceof Error ? error.message : String(error)} — leaving client handles untouched`,
    );
    return;
  }

  // `already_gone` is this function's GOAL STATE, not a refusal (WI-1199802): the scope was
  // collected when its payload exited, or holds no processes, so the subtree we exist to kill
  // is already dead. Treating it as a failure was wrong twice over — it logged a teardown
  // warning on the ordinary path (which vitest-fail-on-console then turned into red tests in
  // suites that had actually passed), and it took the early return below, skipping the
  // client-handle sweep that the success path runs. Falling through is also strictly safer:
  // the sweep is a no-op on dead handles, so this can only ever kill MORE, never less.
  if (managedOutcome && !managedOutcome.ok && managedOutcome.error !== 'already_gone') {
    clearTeardownMarkers();
    console.warn(
      `[desktop-provisioner] managed desktop teardown refused for ${root.taskId ?? root.scopeUnit ?? 'unknown root'}: ` +
        `${managedOutcome.error}${managedOutcome.detail ? ` — ${managedOutcome.detail}` : ''} — leaving client handles untouched`,
    );
    return;
  }

  // This is the legacy path only after a safe scope teardown, or when the task
  // manager was genuinely unavailable and there was no scope to address.
  for (const p of [...procs].reverse()) {
    try { p.kill('SIGTERM'); } catch { /* already gone */ }
  }
  await sleep(300);
  for (const p of procs) {
    try { p.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Release all per-desktop resources, including the session bus that is not part
 * of the Xvfb task subtree. Keeping this wrapper separate makes the ownership
 * boundary explicit and gives teardown a single finally path for failed starts.
 */
export async function releaseDesktopResources(
  procs: readonly KillableProcess[],
  root: DesktopTaskHandle,
  a11y: Pick<A11yBus, 'release'> | null | undefined,
  deps: DesktopReleaseDeps = {},
): Promise<void> {
  try {
    await releaseDesktopProcesses(procs, root, deps);
  } finally {
    a11y?.release();
  }
}

/**
 * Lowest free display number ≥ base (no `/tmp/.X<n>-lock`), NEVER 0. Pure over
 * an injectable `exists` so it unit-tests without touching the filesystem.
 */
export function findFreeDisplayNumber(base = BASE_DISPLAY, max = 250, exists: (p: string) => boolean = existsSync): number {
  const from = Math.max(1, base); // never :0
  for (let n = from; n <= max; n++) {
    if (!exists(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error(`desktop-provisioner — no free X display number in [${from}, ${max}]`);
}

/** True once an X server on `display` accepts connections (xdpyinfo succeeds). */
function displayReady(display: string): boolean {
  try {
    return spawnSync('xdpyinfo', ['-display', display], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

async function waitForDisplay(
  display: string,
  timeoutMs: number,
  xServer: Pick<ReturnType<typeof watchXServer>, 'exit'>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Time is read inside the loop; the helper is only reached on the live path.

  while (Date.now() < deadline) {
    if (displayReady(display)) return;
    // A server that already exited will never accept a connection; say so now, with
    // its stderr, instead of timing out on a display nothing is serving.
    const exit = xServer.exit();
    if (exit) throw new DesktopXServerExitedError(display, exit);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`desktop-provisioner — X display ${display} did not come up within ${timeoutMs}ms`);
}

/**
 * The launch for `desktopSession: 'xfce'` (WI-10002863). Pure, so its env contract is
 * testable without an X server.
 *
 * - `dbus-run-session` gives the session its OWN full bus. xfconfd is D-Bus activated, and
 *   the a11y bus's minimal bus carries only org.a11y.Bus, so XFCE on it loses its settings.
 * - The session keeps THIS desktop's `AT_SPI_BUS_ADDRESS`, so apps started from the panel
 *   register on the bus `observe` reads.
 * - at-spi's autostart entry is hidden for the same reason. Left enabled, it launches a
 *   second a11y bus and republishes `AT_SPI_BUS` on the root, pointing `observe` at a bus
 *   the provisioner does not own.
 */
export function xfceSessionLaunch(
  xEnv: Record<string, string>,
  a11yEnv: Record<string, string> | undefined,
  home: string,
): { command: string; args: string[]; env: Record<string, string>; autostartOverride: { path: string; content: string } } {
  const env: Record<string, string> = { ...xEnv, ...(a11yEnv ?? {}), HOME: home };
  delete env.DBUS_SESSION_BUS_ADDRESS;
  return {
    command: 'dbus-run-session',
    args: ['--', 'xfce4-session'],
    env,
    autostartOverride: {
      path: join(home, '.config', 'autostart', 'at-spi-dbus-bus.desktop'),
      content: '[Desktop Entry]\nType=Application\nName=AT-SPI D-Bus Bus\nHidden=true\n',
    },
  };
}

/** Fail before creating credentials or processes when the selected X stack is absent. */
export function assertDesktopPrerequisites(
  opts: ProvisionOptions,
  hasBinary: (binary: string) => boolean = hostGlProbe().hasBinary,
): void {
  const xServer = opts.xServer ?? 'xvfb';
  const required = [opts.xServerBinaryPath ?? (xServer === 'kasmvnc' ? 'Xkasmvnc' : 'Xvfb'), 'xdpyinfo'];
  if (opts.windowManager !== false) {
    required.push(...(opts.desktopSession === 'xfce' ? ['xfce4-session', 'dbus-run-session'] : ['openbox']));
  }
  if (opts.rootColor !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(opts.rootColor)) {
      throw new Error(`desktop-provisioner — rootColor must be #rrggbb, got ${JSON.stringify(opts.rootColor)}`);
    }
    required.push('xsetroot');
  }
  if (xServer === 'kasmvnc' && !opts.kasmvncPasswordFile) {
    required.push(opts.kasmvncPasswdBinaryPath ?? 'kasmvncpasswd');
  }
  const missing = required.filter((binary) => !hasBinary(binary));
  if (missing.length > 0) {
    throw new Error(
      `desktop-provisioner — missing ${xServer} prerequisites: ${missing.join(', ')}. ` +
      'Install the selected desktop stack before provisioning. BYOC hosts are headless by default; ' +
      'their optional desktop pack provides KasmVNC and requires an isolated desktop-user runtime.',
    );
  }
}

/**
 * Provision a disposable sandbox desktop. Starts Xvfb on a free display (never
 * :0), an openbox WM, and any requested apps; returns a handle whose `release()`
 * tears it all down. Throws if Xvfb never comes up (releasing what it started).
 */
export async function provisionSandboxDesktop(opts: ProvisionOptions, runtime: DesktopProvisionRuntime): Promise<SandboxDesktop> {
  const spawnDesktop = runtime.spawn;
  const number = opts.displayNumber ?? findFreeDisplayNumber();
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`desktop-provisioner — refusing to provision on display :${number} (host :0 / invalid)`);
  }
  assertDesktopPrerequisites(opts);
  const display = `:${number}`;
  const width = opts.width ?? DEFAULT_W;
  const height = opts.height ?? DEFAULT_H;
  const procs: ChildProcess[] = [];
  let taskId: string | null = null;
  let a11y: A11yBus | null = null;
  let credentials: KasmvncSessionCredentials | null = null;
  let rootHandle: DesktopTaskHandle = {
    taskId: null,
    scopeUnit: null,
    confined: false,
    ledgered: false,
  };

  const release = async (): Promise<void> => {
    try {
      await releaseDesktopResources(procs, rootHandle, a11y, runtime.releaseDeps);
    } finally {
      // The credential file outlives the process tree it authenticated — it is a file,
      // not a child — so it is destroyed here rather than riding the task teardown. A
      // half-provisioned desktop that threw AFTER minting must not leave a live
      // credential behind pointing at a port something else may later take.
      credentials?.destroy();
    }
  };

  try {
    // P-005 — the Xvfb is enrolled in the task ledger, and the WM/apps are
    // enrolled as its CHILDREN. Three things follow, and only the first is
    // observability:
    //
    //  1. `processes:list` can say what a stray Xvfb is FOR (which pot, which
    //     agent) — `ps` answers none of that.
    //  2. `killTask(taskId, { includeSubtree: true })` reaps the whole desktop
    //     from ANOTHER PROCESS. `release()` below cannot: it is a closure in this
    //     operator loop, so a desktop outliving its operator was previously
    //     unreachable by anything but a hand-run pkill.
    //  3. `freezeTask(taskId)` suspends it without destroying it.
    //
    // ⚠ ONE HONEST LIMIT, stated so nobody discovers it as a bug: each child gets
    // its OWN transient scope (that is what `parentTaskId` models — logically
    // nested tasks, which is why `killTask` needs an explicit `includeSubtree`).
    // So a FREEZE of the root scope suspends the X server, not the app processes.
    // For a guest desktop — the WI-5978 case this rung exists for — that is
    // complete, because the guest IS one process. For an Xvfb desktop it is
    // partial, and deliberately so: an idle X stack costs a few MB and no CPU
    // (which is why the policy freezes those kinds lazily), and real per-desktop
    // containment is P-010's bubblewrap tier, not a wrapper bolted on here.
    // P-012 — the ONE place the two substrates differ: which binary is the root of
    // the tree. `buildXServerCommand` also pins the kasmvnc listener to loopback,
    // which is an override of the package's shipped `interface: all` and not a
    // restatement of it (see x-server-backend.ts).
    const xServer: DesktopXServer = opts.xServer ?? 'xvfb';
    if (xServer === 'kasmvnc') {
      credentials = opts.kasmvncPasswordFile
        ? null
        : mintKasmvncSessionCredentials({
            passwordFile: `${opts.credentialDir ?? '/run/papercusp/desktop'}/kasmvnc-${number}.passwd`,
            ...(opts.kasmvncPasswdBinaryPath
              ? { kasmvncpasswdPath: opts.kasmvncPasswdBinaryPath }
              : {}),
          });
    }
    const xCommand = buildXServerCommand({
      xServer,
      display,
      width,
      height,
      ...(xServer === 'kasmvnc'
        ? {
            websocketPort: kasmvncWebsocketPort(number),
            passwordFile: opts.kasmvncPasswordFile ?? credentials?.passwordFile ?? '',
            ...(opts.kasmvncDrinode ? { hw3d: { drinode: opts.kasmvncDrinode } } : {}),
          }
        : {}),
      ...(opts.xServerBinaryPath ? { binaryPath: opts.xServerBinaryPath } : {}),
    });

    const xvfbTask = await spawnDesktop(
      xCommand.binary,
      xCommand.argv,
      {
        class: 'desktop',
        title: `${xCommand.binary} ${display} (${width}x${height})`,
        launchedBy: opts.launchedBy ?? 'system:desktop-provisioner',
        argv: [],
        ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
      },
      // WI-10004206 — stderr is piped and tailed (drained by `watchXServer`, so a chatty
      // server never blocks on a full pipe). It was `'ignore'`, which threw away the only
      // record of why a desktop's X server died.
      { spawnOptions: { stdio: ['ignore', 'ignore', 'pipe'] } },
    );
    taskId = xvfbTask.taskId;
    // Replace the provisional closure metadata once the Xvfb root exists. The
    // release closure reads these mutable values at invocation time, after all
    // children have been attached to `procs`.
    rootHandle = {
      taskId: xvfbTask.taskId,
      scopeUnit: xvfbTask.scopeUnit,
      confined: xvfbTask.confined,
      ledgered: xvfbTask.row.detail.unledgered !== true,
    };
    procs.push(xvfbTask.child);
    const xWatch = watchXServer(xvfbTask.child);
    await waitForDisplay(display, opts.readyTimeoutMs ?? 8000, xWatch);

    // ISOLATION: the WM + apps run with a host-stripped env bound to the sandbox
    // display only — never the operator's inherited DISPLAY=:0 / gdm XAUTHORITY.
    const env = sandboxXEnv(display);

    // xsetroot sets the root background and exits; openbox never repaints the root, so
    // the order against the WM does not matter. A failure here is a failed desktop, not
    // a cosmetic miss: the colour is what tells Watch "empty" apart from "dead".
    if (opts.rootColor !== undefined) {
      const paint = spawnSync('xsetroot', ['-solid', opts.rootColor], { env, stdio: 'ignore' });
      if (paint.status !== 0) {
        throw new Error(`desktop-provisioner — xsetroot on ${display} exited ${paint.status ?? paint.signal}`);
      }
    }

    // ⚠ GL IS MEASURED FURTHER DOWN, not here (WI-1223202). It used to be measured at this
    // point, which is after `waitForDisplay` — necessary, because every rung probes THROUGH
    // the display and a probe against a display that is not yet accepting connections
    // reports `none` for a desktop that is fine. That constraint still holds; it is just not
    // SUFFICIENT. The probe also has to run inside the same sandbox the apps get, and the
    // sandbox context needs the a11y bus path and the resolved flag, neither of which exists
    // yet at this line. So the measurement moved down to where BOTH conditions hold.
    //
    // Nothing between here and there consumes `gl`: the WM is unwrapped by design and the
    // a11y bus has no GL.

    // The WM is deliberately NOT wrapped: openbox draws window chrome through plain X11
    // and needs no GL context. Wrapping it would pay VirtualGL's interposition cost on
    // the one process that cannot benefit — and the blank-screenshot trap is specifically
    // about app CONTENT, not chrome (the chrome is exactly what still shows up when GL is
    // missing, which is what makes the failure look like a half-broken app).
    if (opts.windowManager !== false && opts.desktopSession !== 'xfce') {
      const wm = await spawnDesktop(
        'openbox',
        [],
        {
          class: 'desktop',
          title: `openbox ${display}`,
          launchedBy: opts.launchedBy ?? 'system:desktop-provisioner',
          argv: [],
          parentTaskId: taskId,
          ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
        },
        { spawnOptions: { env, stdio: 'ignore' } },
      );
      procs.push(wm.child);
    }
    // P-007 (D-010): bring up this desktop's OWN accessibility bus BEFORE any app.
    //
    // The ordering is load-bearing, not tidiness: an app reads the a11y bus address
    // once, at atk-bridge init. Started before the bus exists it logs "Unable to
    // acquire the address of the accessibility bus" and stays invisible to
    // accessibility for its whole life, even though the bus appears moments later.
    // That is why this sits above the app loop rather than beside it.
    a11y = opts.accessibility === false ? null : runtime.startBus(display);
    const appEnv = a11y ? { ...env, ...a11y.env } : env;

    // Unlike openbox, the XFCE session starts AFTER the a11y bus: it is also an app
    // launcher, and everything started from its panel reads the bus address from the
    // env it inherits here, once.
    if (opts.windowManager !== false && opts.desktopSession === 'xfce') {
      const home = opts.sandboxHomeDir ?? env.HOME;
      if (!home) throw new Error('desktop-provisioner — an xfce session needs a HOME (sandboxHomeDir)');
      const launch = xfceSessionLaunch(env, a11y?.env, home);
      mkdirSync(dirname(launch.autostartOverride.path), { recursive: true, mode: 0o700 });
      writeFileSync(launch.autostartOverride.path, launch.autostartOverride.content, { mode: 0o600 });
      const session = await spawnDesktop(
        launch.command,
        launch.args,
        {
          class: 'desktop',
          title: `xfce4-session ${display}`,
          launchedBy: opts.launchedBy ?? 'system:desktop-provisioner',
          argv: launch.args,
          parentTaskId: taskId,
          ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
        },
        { spawnOptions: { env: launch.env, stdio: 'ignore' } },
      );
      procs.push(session.child);
    }

    // P-010 (D-015): apps are the ONLY thing wrapped in bubblewrap. Xvfb and openbox are
    // the desktop's own infrastructure — confining the X server inside a namespace whose
    // whole job is to serve clients outside it buys nothing and breaks the socket the
    // sandbox then has to hand back. The app is the untrusted party here.
    const sandbox = await runtime.sandbox(display, appEnv, opts);

    // MEASURE the GL stack — after waitForDisplay (the ladder probes through the display) AND
    // inside the apps' own sandbox (the ladder must describe the app's GL stack, not the
    // host's). `forGlProbe` is the identity when apps are unsandboxed, so an unconfined
    // desktop is still probed on the host, which is the honest measurement for it.
    const glProbeSandboxed = sandbox.forGlProbe(['glxinfo'])[0] === 'bwrap';
    const gl = opts.gl ?? detectGlStrategy(display, (cmd) => sandbox.forGlProbe(cmd));

    // WI-1105361 — retained so a caller can ask why a framebuffer stayed blank. See
    // SandboxDesktop.appDiagnostics for the failure this closes.
    const appRecords: AppRecord[] = [];

    for (const appArgv of opts.apps ?? []) {
      if (appArgv.length === 0) continue;
      const launch = applyGlStrategy(gl, appEnv, appArgv);
      // The GL prefix is applied BEFORE the sandbox wrap, so `vglrun` runs INSIDE the
      // sandbox rather than around it — otherwise VirtualGL's interposition would sit
      // outside the confinement it is supposed to be subject to.
      const appSandbox = sandbox.forApp(launch.argv, gl.tier);
      const app = await spawnDesktop(
        appSandbox.binary,
        appSandbox.argv,
        {
          class: 'desktop',
          // Keep the APP's name in the title, not `bwrap` — a ledger row reading
          // "bwrap :110" for every app on every desktop is unreadable, which is the exact
          // provenance failure P-005's ledger exists to fix.
          title: `${launch.argv[0]} ${display}${appSandbox.sandboxed ? ' [sandboxed]' : ''}`,
          launchedBy: opts.launchedBy ?? 'system:desktop-provisioner',
          argv: [],
          parentTaskId: taskId,
          ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
        },
        // D-011: the caller-supplied env is the PAYLOAD's. bwrap forwards its own env to
        // the app, so scrubbing here reaches the app while leaving the systemd-run client
        // (which managedSpawn runs with the operator's env) untouched.
        //
        // ⚠ The scrub applies to the AMBIENT inheritance only. The a11y bus address and the
        // GL strategy's vars are what this desktop deliberately computed, and most GL vars
        // (`__GLX_VENDOR_LIBRARY_NAME`, `VGL_*`) are on no allowlist — scrubbing them would
        // silently drop the desktop to no-GL, which is P-002's bug reintroduced by a
        // security change. So they ride as OVERLAYS, applied after the scrub.
        {
          spawnOptions: {
            env: runtime.appEnv(launch.env, { ...(a11y?.env ?? {}), ...gl.env }),
            // WI-1105361 — stdout stays discarded (apps are chatty and nothing reads it),
            // but stderr is PIPED and tailed. This was `stdio: 'ignore'`, which discarded
            // the one artifact that distinguishes "the app painted nothing" from "the app
            // never ran": `[VGL] ERROR:` / `bwrap:` refusals go to stderr and nowhere else.
            // A piped stream MUST be drained (the listener below does) or a chatty app
            // blocks on a full pipe buffer — which is why this is a tail, not a bare pipe.
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        },
      );
      const record: AppRecord = { argv: appArgv, child: app.child, stderrTail: '' };
      app.child.stderr?.setEncoding('utf8');
      app.child.stderr?.on('data', (chunk: string) => {
        record.stderrTail = (record.stderrTail + chunk).slice(-APP_STDERR_TAIL_BYTES);
      });
      // A pipe whose reader errors must not take the desktop down with it: the
      // diagnostic is a convenience, and losing it is strictly better than losing
      // the desktop the caller actually asked for.
      app.child.stderr?.on('error', () => {});
      appRecords.push(record);
      procs.push(app.child);
    }
    return {
      display,
      number,
      width,
      height,
      gl,
      glProbeSandboxed,
      taskId,
      xServer,
      ...(xCommand.endpoint ? { endpoint: xCommand.endpoint } : {}),
      ...(credentials ? { credentials } : {}),
      ...(a11y ? { a11y } : {}),
      // D-006: only carried when the caller actually asked for a box — see the
      // field's comment for why absent means "the default", not "full size".
      ...(opts.captureWidth && opts.captureHeight
        ? { capture: { width: opts.captureWidth, height: opts.captureHeight } }
        : {}),
      appDiagnostics: () => snapshotAppDiagnostics(appRecords),
      isAlive: xWatch.isAlive,
      xServerExited: xWatch.exited,
      release,
    };
  } catch (e) {
    await release(); // never leak a half-provisioned Xvfb
    throw e;
  }
}
