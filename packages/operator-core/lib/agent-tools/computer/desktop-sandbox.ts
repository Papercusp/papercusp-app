/**
 * desktop-sandbox.ts — P-010 / D-015: the bubblewrap tier for apps on a leased desktop.
 *
 * WHY THIS IS NOT `buildCapabilitySandboxCommand`. That builder is correctly shaped for a
 * `capability:bash` payload — a writable cwd, build caches, and a private `/tmp`. The last
 * of those is exactly wrong here, because a desktop app reaches BOTH of the things that
 * make it useful through sockets under `/tmp`:
 *
 *   /tmp/.X11-unix/X<n>   the X server
 *   /tmp/dbus-XXXXXXXX    this desktop's accessibility bus (P-007's `unix:tmpdir=/tmp`)
 *
 * So this module reuses that one's PRIMITIVES — the bwrap probe, `scrubExecEnv`, and the
 * credential mask lists — and composes its own mount plan. One probe, one env allowlist,
 * one mask policy; two mount plans, because the payloads genuinely differ.
 *
 * ⚠ THE NON-OBVIOUS PART (D-015, measured — do not "simplify" this away). An X client on
 * Linux can reach its server two ways, and Xvfb listens on both:
 *
 *     @/tmp/.X11-unix/X191   ABSTRACT socket  — lives in the NETWORK namespace
 *      /tmp/.X11-unix/X191   FILESYSTEM socket — lives in the MOUNT namespace
 *
 * Those are different namespaces, so each confinement knob hits a different half and
 * NEITHER ALONE breaks the display. Measured with `xterm -e true` against a real Xvfb:
 *
 *   | --tmpfs /tmp | --unshare-net | X socket re-bound | result |
 *   |--------------|---------------|-------------------|--------|
 *   | yes          | no            | no                | WORKS  |  (abstract socket carries it)
 *   | yes          | YES           | no                | FAILS  |  "Can't open display"
 *   | yes          | YES           | yes, after tmpfs  | WORKS  |
 *   | no           | YES           | (via --ro-bind /) | WORKS  |
 *
 * The trap is that each knob looks individually safe, and the combination — which is
 * precisely what a security-minded default would pick — is the fatal one. The a11y bus has
 * the MIRROR exposure: dbus resolves `unix:tmpdir=/tmp` to a real FILE (measured:
 * `unix:path=/tmp/dbus-85DYQtR2WE`), so it is immune to `--unshare-net` and destroyed by
 * `--tmpfs /tmp`. Losing it is silent — apps still run, `computer:observe` just falls back
 * to pixels, turning P-008's measured 10.48x token win back into screenshot-every-step
 * while every test stays green.
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { GlTier } from '../../desktop/gl-strategy';
import { capabilityBwrapWorks, credentialMaskArgs, scrubExecEnv } from '../capability/exec-sandbox';

/**
 * Resolve `papercusp-desktop-app-sandbox` at provision time.
 *
 * ON by default (alpha default-on). FAILS OPEN on a flag-IO error — a PostHog hiccup must
 * never stop desktops provisioning, and the builder is itself fail-open, so the worst case
 * is an app that launches exactly as it did before P-010.
 */
export async function desktopAppSandboxEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.DESKTOP_APP_SANDBOX, 'system');
  } catch {
    return false;
  }
}

/** The X socket directory. Every display's filesystem socket lives here. */
export const X11_SOCKET_DIR = '/tmp/.X11-unix';

/**
 * Matches the NVIDIA proprietary driver's character devices in `/dev`:
 * `nvidiactl`, `nvidia0`…`nvidiaN`, `nvidia-modeset`, `nvidia-uvm`, `nvidia-uvm-tools`.
 */
const NVIDIA_DEVICE_NODE = /^nvidia(ctl|-modeset|-uvm|-uvm-tools|\d+)$/;

/**
 * Vendor GPU device nodes present on this host, for the HARDWARE tier to bind back.
 *
 * ⚠ WHY THIS EXISTS AT ALL, and why `/dev/dri` was never enough (WI-1105361, measured
 * 2026-08-30). `/dev/dri` is the DRM/Mesa interface. The NVIDIA proprietary stack does not
 * use it for rendering — it needs its OWN nodes, and `--dev /dev` builds a minimal `/dev`
 * that contains neither until something binds them back. We bound only `/dev/dri`, so
 * inside the sandbox NVIDIA's EGL could not initialise and libglvnd fell through to the
 * Mesa ICD, which cannot drive an NVIDIA device:
 *
 *     libEGL warning: pci id for fd 4: 10de:2204, driver (null)
 *     libEGL warning: egl: failed to create dri2 screen
 *
 * Measured with the byte-exact production argv, n=20 per arm, one variable:
 *
 *   | /dev/nvidia* bound | renderer reached inside the sandbox      |
 *   |--------------------|------------------------------------------|
 *   | no  (as shipped)   | llvmpipe (LLVM 20.1.2)   20/20 fallback  |
 *   | yes                | NVIDIA GeForce RTX 3090  20/20, 0 fallback|
 *
 * THE FAILURE WAS SILENT, which is why it survived: llvmpipe is a working rasterizer, so
 * pixels still appeared and every non-blank assertion still passed. The desktop merely
 * rendered in SOFTWARE while `gl-strategy` recorded `tier: 'hardware'` — because
 * `probeRenderer` runs OUTSIDE the sandbox, where NVIDIA works fine. The registry was
 * describing a world the app never ran in. The only visible symptom was a ~1-in-6
 * desktop-gl-live failure, which was llvmpipe missing the 30s paint deadline under load,
 * not a GL fault.
 *
 * Discovery is by ENUMERATION rather than a fixed list so a multi-GPU host binds every
 * `nvidiaN` it actually has. Each is bound with `--dev-bind-try`, so a host with no NVIDIA
 * hardware — notably the GPU-less GCP workspace VM this plan's A-bar clause 6 targets —
 * silently binds nothing and keeps its software path.
 */
export function discoverGpuDeviceNodes(): string[] {
  try {
    return readdirSync('/dev')
      .filter((entry) => NVIDIA_DEVICE_NODE.test(entry))
      .map((entry) => `/dev/${entry}`)
      .sort();
  } catch {
    // A /dev we cannot read is not a reason to fail provisioning: bind nothing extra and
    // let the app fall back exactly as it did before this function existed.
    return [];
  }
}

/**
 * Env keys a sandboxed desktop app needs that `scrubExecEnv`'s allowlist does NOT carry.
 *
 * These are not secrets and not toolchain config — they are the address of the display and
 * of the a11y bus, i.e. the whole point of the process. Passed as `extraAllow` rather than
 * added to the shared allowlist because they are meaningless outside a desktop payload.
 */
export const DESKTOP_ENV_EXTRA_ALLOW: readonly string[] = Object.freeze([
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
]);

export interface DesktopSandboxInput {
  /** The app argv, GL prefix already applied (e.g. `['vglrun','-d','egl0','xterm']`). */
  cmd: readonly string[];
  /** The sandbox display, e.g. `:110`. Used to bind that display's socket. */
  display: string;
  /**
   * Filesystem path of this desktop's a11y bus socket, from `a11yBusSocketPath()`.
   * `null`/omitted ⇒ no bus to carry (a screenshot-only desktop, `accessibility:false`).
   */
  a11yBusPath?: string | null;
  /**
   * GL tier in force for this desktop. `'hardware'` needs `/dev/dri`, which `--dev /dev`
   * would otherwise hide — silently downgrading a GPU desktop to no-GL and undoing P-002.
   */
  glTier?: GlTier;
  /** Home directory to give the app a PRIVATE writable copy of. Defaults to `os.homedir()`. */
  homeDir?: string;
}

export interface DesktopSandboxOpts {
  /** The `papercusp-desktop-app-sandbox` flag, resolved by the caller. */
  enabled: boolean;
  /** Injectable for tests; defaults to the live cached probe. */
  bwrapWorks?: boolean;
  /**
   * Vendor GPU device nodes to bind for the `hardware` tier, injectable so this builder
   * stays deterministic in tests; defaults to `discoverGpuDeviceNodes()` (see WI-1105361 —
   * without these, NVIDIA EGL cannot init inside the sandbox and GL silently drops to
   * llvmpipe while the registry still reports `hardware`). Ignored on other tiers.
   */
  gpuDeviceNodes?: readonly string[];
  /**
   * Add `--unshare-net`. OPT-IN per D-015 §3: a desktop exists to run real apps, and a
   * silently network-less browser is a worse failure than an un-isolated one. Safe in
   * combination with the mount plan below, which is the point of that ruling.
   */
  denyNetwork?: boolean;
  /**
   * Existence probe for credential-mask targets, injectable so this builder is genuinely
   * PURE given its opts (it defaults to `existsSync`). The masks SKIP absent targets —
   * bwrap cannot create a mount point under a read-only root and aborts the whole command —
   * so without this seam a unit test's assertions would silently depend on which dotfiles
   * happen to exist on the machine running it.
   */
  maskExists?: (abs: string) => boolean;
}

export interface DesktopSandboxDecision {
  binary: string;
  argv: string[];
  sandboxed: boolean;
  reason: 'flag-off' | 'bwrap-unavailable' | 'sandboxed';
}

/**
 * Parse the filesystem socket path out of a D-Bus address.
 *
 * Returns `null` for an ABSTRACT address (`unix:abstract=...`) rather than a path, because
 * an abstract socket has no path to bind and is unreachable from a new network namespace —
 * so `null` here is the honest "there is nothing I can carry", not a parse failure. Our own
 * bus is filesystem-backed (`unix:tmpdir=/tmp` ⇒ `unix:path=`), but a caller may hand us an
 * externally-provisioned address, and silently treating an abstract one as absent is what
 * keeps the caller's `--unshare-net` decision honest.
 */
export function a11yBusSocketPath(address: string | null | undefined): string | null {
  if (!address) return null;
  for (const part of address.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).replace(/^unix:/, '').trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'path' && value) return value;
  }
  return null;
}

/**
 * The env a sandboxed desktop app runs with: the operator's ambient env SCRUBBED of
 * credentials, with the desktop's own deliberate additions layered back on top.
 *
 * The layering order is the D-011 ruling applied one level down. `overlays` — the DISPLAY,
 * the a11y bus address, the GL strategy's vars — were computed by the desktop layer on
 * purpose; scrubbing them would delete the payload's whole reason for existing. So they are
 * applied AFTER the scrub, never subjected to it.
 */
export function desktopSandboxEnv(
  base: Record<string, string | undefined>,
  overlays: Record<string, string> = {},
): Record<string, string> {
  return { ...scrubExecEnv(base, DESKTOP_ENV_EXTRA_ALLOW), ...overlays };
}

/**
 * Build the bwrap invocation for one desktop app. PURE given its opts, so the whole mount
 * plan is unit-assertable without a live bwrap.
 *
 * FAIL-OPEN, matching the capability sandbox: flag off or bwrap unavailable ⇒ run the app
 * raw. A desktop that refuses to start is a worse outcome than one that starts unconfined,
 * and the caller records which happened.
 */
export function buildDesktopSandboxCommand(
  input: DesktopSandboxInput,
  opts: DesktopSandboxOpts,
): DesktopSandboxDecision {
  const raw = (reason: 'flag-off' | 'bwrap-unavailable'): DesktopSandboxDecision => ({
    binary: input.cmd[0]!,
    argv: input.cmd.slice(1),
    sandboxed: false,
    reason,
  });
  if (!opts.enabled) return raw('flag-off');
  if (!(opts.bwrapWorks ?? capabilityBwrapWorks())) return raw('bwrap-unavailable');

  const home = input.homeDir ?? homedir();
  const argv: string[] = [
    // Read-only host root: the app can READ the system it needs to run and write nowhere.
    '--ro-bind', '/', '/',

    // A private /tmp. ⚠ ORDER IS LOAD-BEARING (D-015): every bind that must survive has to
    // come AFTER this, because a --tmpfs applied later mounts an empty fs OVER the bind.
    // `buildCapabilitySandboxCommand` documents the same hazard for its cwd.
    '--tmpfs', '/tmp',

    // …now carve the two sockets back in. The X socket dir read-only (a client only
    // connects); the bus socket read-write, because a D-Bus client writes to its socket.
    '--ro-bind', X11_SOCKET_DIR, X11_SOCKET_DIR,
    ...(input.a11yBusPath ? ['--bind', input.a11yBusPath, input.a11yBusPath] : []),

    // A private writable HOME. This is most of the FS containment worth having: it is where
    // an app would otherwise scribble on the operator user's real dotfiles, and a tmpfs
    // makes the desktop genuinely disposable.
    '--tmpfs', home,

    '--proc', '/proc',
    '--dev', '/dev',
  ];

  // `--dev /dev` builds a MINIMAL /dev with no /dev/dri, which would silently drop a
  // hardware-GL desktop to software and undo P-002. Bind the render nodes back for the one
  // tier that needs them — and only that tier, so a software desktop gets no GPU handle.
  if (input.glTier === 'hardware') {
    argv.push('--dev-bind-try', '/dev/dri', '/dev/dri');

    // …and the vendor's OWN nodes beside it. `/dev/dri` alone is the Mesa interface; on an
    // NVIDIA host it leaves the proprietary EGL stack with no device, so libglvnd falls
    // through to Mesa and renders in software while claiming hardware (WI-1105361 — the
    // measurement table is on `discoverGpuDeviceNodes`). `--dev-bind-try` means a host
    // without these nodes binds nothing and is unchanged.
    for (const node of opts.gpuDeviceNodes ?? discoverGpuDeviceNodes()) {
      argv.push('--dev-bind-try', node, node);
    }
  }

  // ⛔ `--unshare-ipc` IS DELIBERATELY ABSENT — do not add it back (WI-1105361).
  //
  // A desktop app is an X client of an Xvfb that lives OUTSIDE this sandbox. MIT-SHM — the
  // extension every serious X client uses to hand the server a frame — works by the client
  // creating a SysV shared segment and the server attaching to it BY ID. A private IPC
  // namespace makes that id unresolvable from the server's side, so the attach fails and the
  // next `XShmPutImage` is a BadValue against a segment the server never attached. X kills
  // the client for it.
  //
  // MEASURED 2026-08-30, three arms against one Xvfb, ten runs each, one variable:
  //     no bwrap                     0/10 died
  //     bwrap, IPC shared            0/10 died
  //     bwrap --unshare-ipc          9/10 died  (X Error, MIT-SHM, X_ShmPutImage, exit 139)
  // It presented as a flaky "the GL app paints nothing" in desktop-gl-live for two
  // investigation cycles, because apps were spawned `stdio:'ignore'` and a killed app and a
  // non-painting one look identical from the framebuffer. VirtualGL is simply where it
  // surfaced first: it does not install the X error handler that GTK/WebKitGTK use to fall
  // back, so it dies where they merely degrade. The exposure was never GL-specific.
  //
  // WHY DROPPING IT COSTS ALMOST NOTHING HERE. This app already holds an authenticated
  // connection to a shared X server, through a socket bound in below. Anything an attacker
  // would want from the IPC namespace — reading another client's pixels, injecting input —
  // is reachable through that connection, which we cannot take away without taking away the
  // desktop. `--unshare-ipc` was buying isolation the X socket had already spent, at the
  // price of breaking the one thing a desktop exists to do. The confinement that does the
  // real work here is the read-only root, the private /tmp and HOME, the credential masks,
  // and (opt-in) `--unshare-net` — all still in force.
  argv.push('--unshare-pid', '--unshare-uts', '--unshare-cgroup-try');
  if (opts.denyNetwork) argv.push('--unshare-net');

  // Credential masking via the SHARED emitter, so the file-vs-dir distinction, the
  // skip-absent rule, and P-019's runtime mask additions cannot drift between the two
  // sandboxes. These paths sit under the private HOME tmpfs already, but the masks are
  // applied anyway: that tmpfs is a consequence of how we chose to give the app a writable
  // home, and a later change to that choice must not silently un-mask ~/.ssh.
  argv.push(...credentialMaskArgs(home, opts.maskExists));

  // `--die-with-parent` — and note this is the OPPOSITE of what the capability sandbox does
  // for a background job, deliberately.
  //
  // EI-16635 removed this flag there because a `capability:bash` background job is supposed
  // to OUTLIVE the call that launched it, so binding it to its launcher killed it 3-6s in.
  // A desktop app is the other shape: bwrap's parent here is the long-lived systemd-run
  // scope client that represents the desktop itself, so "die with parent" means "die when
  // the desktop is torn down" — precisely the lifetime we want.
  //
  // MEASURED, not assumed. Without it, `release()` SIGTERMs the scope client, bwrap keeps
  // holding the app, and managed-spawn reports `the systemd-run client exited but its scope
  // still holds processes` (WI-37509) — an orphaned scope waiting on the reconciler. That is
  // a real leak on a box where desktops churn, and it surfaced as 6 red tests in
  // accessibility-live the first time this module wrapped a provisioned app.
  argv.push('--die-with-parent', '--', ...input.cmd);

  return { binary: 'bwrap', argv, sandboxed: true, reason: 'sandboxed' };
}

/**
 * The tier the GL PROBE's sandbox is always built at.
 *
 * ⚠ THIS IS A DELIBERATE CIRCULARITY BREAK, not an oversight. The app's sandbox depends on
 * the GL tier (`hardware` is the one tier that binds `/dev/dri` and the vendor nodes), but
 * the tier is precisely what the probe is measuring — so the probe cannot be built at "the"
 * tier. It is built at the MAXIMAL one instead, and the ladder stays sound because the
 * measurement is MONOTONE in capability:
 *
 *   • probe finds hardware ⇒ the desktop runs at `hardware` ⇒ the app gets the IDENTICAL
 *     sandbox the probe ran in. Exact parity, which is the case that matters.
 *   • probe finds software/none ⇒ the desktop runs at a lower tier, whose sandbox binds
 *     STRICTLY FEWER GPU nodes. Removing device nodes cannot conjure a hardware renderer,
 *     so the app cannot beat a measurement taken with more access than it will have.
 *
 * The unsound direction — probing with LESS access than the app gets, and so under-reporting
 * — is the one this ordering rules out.
 */
export const GL_PROBE_SANDBOX_TIER: GlTier = 'hardware';

/**
 * One desktop's sandbox context, shared by its GL PROBE and its APPS.
 *
 * WI-1223202 exists because those two were built from different places: the apps went
 * through `buildDesktopSandboxCommand`, and the probe went through nothing at all. Handing
 * out both from a single closure over a single `DesktopSandboxInput`/`DesktopSandboxOpts`
 * pair is what makes the parity structural rather than remembered — the fix cannot rot by
 * someone changing the app's mount plan and not knowing a probe existed.
 *
 * FAIL-OPEN inherits from the builder: with the flag off (or bwrap unavailable) `forGlProbe`
 * returns its argv UNCHANGED, which is the correct probe for a desktop whose apps also run
 * unconfined. No caller needs its own `if (sandboxEnabled)`.
 */
export interface DesktopSandboxSession {
  /** Wrap an app argv (GL prefix already applied) at the desktop's MEASURED tier. */
  forApp(cmd: readonly string[], glTier: GlTier): DesktopSandboxDecision;
  /** Wrap the GL probe's argv, at `GL_PROBE_SANDBOX_TIER`. Returns a ready-to-spawn argv. */
  forGlProbe(cmd: readonly string[]): string[];
}

export function desktopSandboxSession(
  input: Omit<DesktopSandboxInput, 'cmd' | 'glTier'>,
  opts: DesktopSandboxOpts,
): DesktopSandboxSession {
  const build = (cmd: readonly string[], glTier: GlTier): DesktopSandboxDecision =>
    buildDesktopSandboxCommand({ ...input, cmd, glTier }, opts);
  return {
    forApp: (cmd, glTier) => build(cmd, glTier),
    forGlProbe: (cmd) => {
      const decision = build(cmd, GL_PROBE_SANDBOX_TIER);
      return [decision.binary, ...decision.argv];
    },
  };
}
