/**
 * a11y-bus.ts — stand up a sandbox desktop's OWN accessibility bus
 * (agent-virtual-desktops-2026-08-23 P-007; D-010).
 *
 * Sibling of `gl-strategy.ts` and built the same way: constants + pure command
 * builders here, so the in-process provisioner and any future frame bootstrap derive
 * the recipe from ONE place instead of hand-maintaining two copies of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A MINIMAL BUS AND NOT `dbus-run-session`. This is the whole design, and it
 * was arrived at by measurement after four probes failed for reasons that all
 * LOOKED like "accessibility does not work headless".
 *
 * AT-SPI needs a session bus to activate `org.a11y.Bus`. The obvious way to get one
 * is `dbus-run-session`, which uses the system's real service directory — and that
 * directory contains `xdg-desktop-portal`. Measured on this box 2026-08-23, a GTK
 * app on such a session triggers a cascade: portal.Desktop → portal.Documents →
 * impl.portal.desktop.gnome → impl.portal.desktop.kde → gvfs → secrets/keyring,
 * with `fusermount3: failed to access mountpoint /run/user/1000/doc: Permission
 * denied` in the middle of it. The app does not paint for tens of seconds, and the
 * screenshots taken while that is happening are BLANK — which reads exactly like a
 * GL problem and sent this investigation down a renderer rabbit-hole (GSK_RENDERER,
 * GDK_GL, LIBGL_ALWAYS_SOFTWARE — none of which changed anything, because none of
 * them was the cause).
 *
 * A bus whose ONLY activatable service is `org.a11y.Bus` cannot start a portal.
 * Measured with it: the app painted within 4 seconds (200 distinct colours), and the
 * accessibility walk returned exactly ONE application — the app itself, with no
 * portal noise in the tree at all.
 *
 * ORDERING IS PART OF THE RECIPE, not an implementation detail. An app reads the
 * accessibility bus address ONCE, when its atk-bridge initialises. Start it before
 * the bus exists and it logs `Unable to acquire the address of the accessibility
 * bus` and never registers — it stays permanently invisible to accessibility even
 * though the bus comes up moments later. So the bus must be up BEFORE any app is
 * spawned, which is why this returns an address the caller then puts in the app env.
 *
 * DO NOT run `at-spi-bus-launcher` directly. It races the D-Bus service activation
 * and dies with `Failed to launch bus: Bus exited with code 0` (measured on :121).
 * Activating it THROUGH the bus — `org.a11y.Bus.GetAddress` — both starts it and
 * returns its address, which is why that one call is the whole bootstrap.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseA11yBusAddress, a11yBusCommand, A11Y_APP_ENV } from '../agent-tools/computer/accessibility-tree';
import { sandboxXEnv } from '../agent-tools/computer/desktop-driver';
import type {
  beginSyncEnrolment,
  completeSyncEnrolment,
  finishSyncEnrolment,
} from '../task-manager/enroll-sync';
import type { TaskSpec } from '../task-manager/types';

export { A11Y_APP_ENV };

/** The system service file that makes `org.a11y.Bus` activatable. */
export const A11Y_SERVICE_FILE = '/usr/share/dbus-1/services/org.a11y.Bus.service';

/**
 * A session bus config whose service directory contains ONLY what we copy into it.
 * That is the entire mechanism by which the portal cascade is prevented: D-Bus can
 * only activate what a servicedir advertises.
 */
export function minimalSessionBusConfig(serviceDir: string): string {
  return `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <servicedir>${serviceDir}</servicedir>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;
}

/** `dbus-daemon` invocation that forks and prints its address and owned PID. */
export function sessionBusCommand(configPath: string): { bin: string; args: string[] } {
  // Use explicit stdout descriptors for both values. The options take an
  // optional descriptor, so leaving the descriptor implicit makes a following
  // option easy to misread as that descriptor on older dbus-daemon builds.
  return {
    bin: 'dbus-daemon',
    args: [`--config-file=${configPath}`, '--fork', '--print-address=1', '--print-pid=1'],
  };
}

/** Parse the PID printed by `dbus-daemon --print-pid=1`. */
export function parseSessionBusPid(stdout: string): number | null {
  const line = (stdout ?? '').split(/\r?\n/).map((part) => part.trim()).find((part) => /^\d+$/.test(part));
  if (!line) return null;
  const pid = Number(line);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/** Parse the address printed by `dbus-daemon --print-address=1`. */
export function parseSessionBusAddress(stdout: string): string | null {
  const line = (stdout ?? '').split(/\r?\n/).map((part) => part.trim()).find((part) =>
    /^(?:unix|tcp|nonce-tcp|autolaunch):/.test(part),
  );
  return line || null;
}

/** Parse the two values emitted by the session-bus startup command. */
export function parseSessionBusStartup(stdout: string): { sessionBus: string; pid: number } | null {
  const sessionBus = parseSessionBusAddress(stdout);
  const pid = parseSessionBusPid(stdout);
  return sessionBus && pid !== null ? { sessionBus, pid } : null;
}

export interface OwnedDaemonReleaseOptions {
  /** Injectable for tests; production uses the process signal primitive. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Ran exactly once, AFTER the signal attempt, on the first release only.
   * Exists so the caller can close the daemon's task-ledger row without having
   * to re-implement the `released` latch — a second, independently-guarded
   * closure is how a row gets closed twice (or, worse, not at all when the two
   * latches disagree). Never throws into the release path: a ledger write must
   * not be able to turn a successful teardown into an exception.
   */
  onRelease?: () => void;
}

/**
 * Make a best-effort, idempotent release handle for a daemon started with
 * `--fork`. The dbus parent exits immediately, so the returned PID is the only
 * process handle available to the provisioner. SIGTERM asks dbus to tear down
 * its activated at-spi children as well; an already-exited daemon is harmless.
 */
export function createOwnedDaemonRelease(pid: number, opts: OwnedDaemonReleaseOptions = {}): () => void {
  let released = false;
  const kill = opts.kill ?? ((ownedPid: number, signal: NodeJS.Signals) => process.kill(ownedPid, signal));
  return () => {
    if (released) return;
    released = true;
    try {
      kill(pid, 'SIGTERM');
    } catch {
      // The daemon may have exited during a failed start or an earlier release.
    }
    try {
      opts.onRelease?.();
    } catch {
      // The process is already signalled; a bookkeeping failure must not
      // propagate into a caller that is tearing a desktop down.
    }
  };
}

/**
 * Publish the bus on the display's root window, the way `at-spi-bus-launcher` would.
 *
 * This is what makes the binding DISCOVERABLE ACROSS PROCESSES with no registry
 * column and no in-process map: the display itself carries the answer to "which
 * accessibility bus is yours". An `observe` running in the operator can therefore
 * resolve a desktop provisioned by some other process, and an app launched later by
 * anyone at all finds the right bus on its own.
 */
export function publishBusPropertyCommand(display: string, busAddress: string): { bin: string; args: string[] } {
  return {
    bin: 'xprop',
    args: ['-display', display, '-root', '-f', 'AT_SPI_BUS', '8s', '-set', 'AT_SPI_BUS', busAddress],
  };
}

/**
 * Does this a11y bus actually belong to `display`?
 *
 * at-spi names its socket after the display it was started under — `bus_110` for
 * `:110` — so the address is self-describing and this is a cheap, exact check rather
 * than a heuristic. It exists because the failure it catches is SILENT and severe: a
 * launcher that inherited the wrong DISPLAY hands back a perfectly well-formed
 * address for someone else's session (measured: `bus_0`, the operator's own), and
 * every consumer downstream then works correctly against the wrong desktop.
 *
 * A bus whose name carries no display suffix at all is ACCEPTED: at-spi is entitled
 * to name its socket differently, and refusing an unrecognised shape would disable
 * accessibility on hosts where nothing is actually wrong. This rejects only the case
 * that is positively identifiable as another display's bus.
 */
export function busBelongsToDisplay(busAddress: string, display: string): boolean {
  const n = /^:(\d+)/.exec(display.trim())?.[1];
  if (!n) return false;
  const named = /at-spi\/bus_(\d+)/.exec(busAddress);
  if (!named) return true; // no display suffix to contradict us
  return named[1] === n;
}

export interface A11yBus {
  /** Address of the desktop's own minimal session bus. */
  sessionBus: string;
  /** Address of the accessibility bus that session activated. */
  a11yBus: string;
  /** Env additions an app must be launched with to register on it. */
  env: Record<string, string>;
  /** Stop the owned session daemon. Safe to call repeatedly. */
  release: () => void;
}

export interface StartA11yBusOptions {
  /** Seconds to allow for `GetAddress` (which also starts at-spi). Default 20. */
  timeoutSec?: number;
  /** A system service already owns the entire worker cgroup; it has no operator DB authority. */
  externallySupervised?: boolean;
  enrollment?: { begin: typeof beginSyncEnrolment; complete: typeof completeSyncEnrolment; finish: typeof finishSyncEnrolment };
}

/**
 * Bring up `display`'s accessibility bus and return everything needed to launch apps
 * onto it. Returns null — never throws — when the host cannot support accessibility,
 * because a desktop without an a11y bus is a perfectly usable screenshot-only
 * desktop, and failing provisioning over an optional capability would be a
 * regression for every caller that never wanted it.
 */
export function startA11yBus(display: string, opts: StartA11yBusOptions = {}): A11yBus | null {
  if (!existsSync(A11Y_SERVICE_FILE)) return null;
  const timeout = (opts.timeoutSec ?? 20) * 1000;
  let releaseDaemon: (() => void) | undefined;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'pc-a11y-'));
    const serviceDir = join(dir, 'services');
    spawnSync('mkdir', ['-p', serviceDir]);
    copyFileSync(A11Y_SERVICE_FILE, join(serviceDir, 'org.a11y.Bus.service'));
    const confPath = join(dir, 'session.conf');
    writeFileSync(confPath, minimalSessionBusConfig(serviceDir), 'utf8');

    const busCmd = sessionBusCommand(confPath);
    // 🚨 THE DAEMON'S ENV IS WHAT DECIDES WHICH DISPLAY at-spi BINDS TO, and getting
    // this wrong is silent. `at-spi-bus-launcher` is activated BY this daemon, so it
    // inherits THIS env, and it names its bus after the DISPLAY it sees. Spawned with
    // the operator's inherited environment it sees `DISPLAY=:0` and creates
    // `…/at-spi/bus_0` — the HOST's bus. Measured exactly that way on the first live
    // run of this code: a desktop provisioned at :110 came up bound to `bus_0`, which
    // means the sandbox's own apps would have registered on the OPERATOR'S session and
    // `observe` would have read the owner's real desktop. Same leak as the walker's
    // (D-010(b)), entering through the provisioner instead.
    //
    // `sandboxXEnv` both refuses `:0` outright and pins DISPLAY to the sandbox; the
    // host bus keys are stripped on top so an inherited session address cannot win.
    const daemonEnv = sandboxXEnv(display);
    delete daemonEnv.DBUS_SESSION_BUS_ADDRESS;
    delete daemonEnv.AT_SPI_BUS_ADDRESS;
    // NOT managedSpawn: --fork means this process exits immediately and the daemon it
    // left behind is the thing we want, so there is no child handle to enrol. The
    // daemon is reaped with the desktop by `release()`, which kills the bus address's
    // socket owner along with the rest of the display's processes. The daemon is
    // reparented after `--fork`, so capture its explicit PID instead of assuming it
    // remains under Xvfb's process tree.
    //
    // ── WI-41108: LEDGERED, DELIBERATELY UNCONFINED ──────────────────────────
    // The daemon still has to be ENROLLED even though it cannot be a managed child:
    // an unledgered process is invisible to `processes:list` and reads as
    // `unaccounted` to the reconciler, which is the whole no-escape property this
    // subsystem exists to provide. `beginSyncEnrolment` is the seam for exactly this
    // shape — a spawn that cannot become async — and the PID we register is the
    // FORKED daemon's (`--print-pid=1`), never the `spawnSync` client's, which is
    // already gone by the time the row is written.
    //
    // `confine: false` is a deliberate, precedented caller-side veto (the same knob
    // substrate-sidecar-spawn.ts uses), and it is the honest answer for THIS site on
    // three independent grounds:
    //
    //  1. OWNERSHIP. A cgroup scope asserts that the spawning client owns this
    //     lifetime. It does not — `--fork` is self-daemonization, and the bus's real
    //     owner is the DISPLAY, a cross-process fact published on the X root window
    //     and keyed on by ./a11y-bus-sweep. `caller-veto` states that accurately;
    //     confining would encode an ownership claim the code does not have.
    //  2. FAILURE MODE. `startA11yBus` returns null on ANY failure, and a desktop
    //     without a11y is by design "a perfectly usable screenshot-only desktop". So
    //     a `systemd-run` that could not start would DEGRADE ACCESSIBILITY SILENTLY
    //     on every provisioned desktop rather than announcing itself. That is not a
    //     failure mode to ship unverified — and it cannot be verified from an agent
    //     session, because the native-scheduler guard refuses transient-unit creation
    //     there. Three specifics would need a real measurement first: that the
    //     `--print-address=1`/`--print-pid=1` stdout survives the wrapper, that the
    //     scope outlives the `--fork` client exit, and that `systemd-run` still
    //     reaches the user manager when this env deliberately deletes
    //     DBUS_SESSION_BUS_ADDRESS (it would have to fall back to
    //     $XDG_RUNTIME_DIR/bus, which `stripHostX` does preserve).
    //  3. NOTHING IS LOST BY WAITING. Enrolment alone buys the visibility that was
    //     missing; confinement would only add a better *how* to kill (the whole
    //     at-spi subtree in one go), and the sweep already supplies the *when*,
    //     which is the harder half and the one age cannot answer.
    //
    // Enrolment is NOT gated on the task-manager flag being flipped on: WI-6844
    // graduated `papercusp-task-manager` out of DARK_FLAGS on 2026-08-02, so it
    // derives default-ON and `taskManagerEnabledSync()` fails OPEN. An explicit OFF
    // still restores byte-identical pre-feature behaviour via `enrolment.enrolled`.
    const taskSpec: TaskSpec = {
      class: 'desktop',
      title: `a11y session bus ${display}`,
      argv: [busCmd.bin, ...busCmd.args],
      launchedBy: 'system:a11y-bus',
      detail: { display, confDir: dir },
    };
    const enrolment = opts.enrollment?.begin(taskSpec, { confine: false });
    // Only close a row that was actually opened. `releaseDaemon` is armed from the
    // partial-PID path BEFORE registration, so an early release must not try to
    // close a task id the ledger has never seen.
    let registered = false;
    const onRelease = () => {
      if (registered && enrolment) opts.enrollment?.finish(enrolment, { state: 'killed' });
    };

    const started = spawnSync(busCmd.bin, busCmd.args, { encoding: 'utf8', timeout, env: daemonEnv });
    const partialPid = parseSessionBusPid(started.stdout ?? '');
    releaseDaemon = partialPid === null ? undefined : createOwnedDaemonRelease(partialPid, { onRelease });
    const startup = parseSessionBusStartup(started.stdout ?? '');
    if (!startup) {
      // A daemon can successfully fork and print only one of the two values before
      // startup fails. Recover the PID independently so even that partial start is
      // not leaked.
      releaseDaemon?.();
      return null;
    }
    const { sessionBus, pid } = startup;
    // `partialPid` is the same PID on a complete startup; assigning the handle
    // above means every path after the fork, including a malformed output, owns
    // exactly one idempotent cleanup closure.
    const ownedRelease = releaseDaemon ?? createOwnedDaemonRelease(pid, { onRelease });
    releaseDaemon = ownedRelease;
    // Fire-and-forget by contract: a ledger write must never be able to fail a
    // desktop's accessibility bootstrap. A lost write degrades to an `unaccounted`
    // row on the next reconcile — the alarm that classification exists to raise.
    if (enrolment) {
      opts.enrollment?.complete(enrolment, taskSpec, pid);
      registered = true;
    }

    const probe = a11yBusCommand(sessionBus);
    const got = spawnSync(probe.bin, probe.args, { encoding: 'utf8', env: probe.env, timeout });
    const a11yBus = parseA11yBusAddress(got.stdout ?? '');
    if (!a11yBus) {
      ownedRelease();
      return null;
    }
    if (!busBelongsToDisplay(a11yBus, display)) {
      ownedRelease();
      return null;
    }

    const publish = publishBusPropertyCommand(display, a11yBus);
    spawnSync(publish.bin, publish.args, { env: sandboxXEnv(display), timeout: 5000 });

    return {
      sessionBus,
      a11yBus,
      env: { ...A11Y_APP_ENV, DBUS_SESSION_BUS_ADDRESS: sessionBus, AT_SPI_BUS_ADDRESS: a11yBus },
      release: ownedRelease,
    };
  } catch {
    releaseDaemon?.();
    return null;
  }
}
