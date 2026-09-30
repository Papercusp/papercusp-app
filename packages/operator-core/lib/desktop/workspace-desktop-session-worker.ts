/** The pack's socket-activated, credential-free desktop worker. No operator store imports. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { provisionSandboxDesktop, type DesktopProvisionRuntime } from '../agent-tools/computer/desktop-provisioner-core';
import { startA11yBus } from './a11y-bus-core';
import { serveWorkspaceDesktop } from './workspace-desktop-session';

export const WORKSPACE_DESKTOP_HOME = '/var/lib/papercusp-desktop';
/** Neutral grey, so a desktop with no windows is visibly alive in Watch (WI-10002863). */
export const WORKSPACE_DESKTOP_ROOT_COLOR = '#4b5563';

export function assertWorkspaceDesktopIdentity(identity: { uid: number; username: string; home: string }): void {
  if (identity.uid <= 0 || identity.username !== 'papercusp-desktop' || identity.home !== WORKSPACE_DESKTOP_HOME) {
    throw new Error('desktop worker requires the dedicated desktop identity and home');
  }
}

/**
 * Explicit allowlist: this child never receives service/agent/provider/database credentials.
 *
 * SHELL is FIXED here, not inherited (WI-10003133). The desktop account is `nologin` on
 * purpose, and XFCE Terminal picks `$SHELL` before the passwd shell — without it every
 * terminal window execs `/usr/sbin/nologin`, which exits at once and closes the window
 * (the "flash"). This allowlist wipes the unit's `Environment=` lines, so a SHELL set on
 * the systemd unit never reaches the session; it has to be set in this function.
 */
export function workspaceDesktopEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { HOME: WORKSPACE_DESKTOP_HOME, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', SHELL: '/bin/bash' };
  for (const key of ['DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS', 'NO_AT_BRIDGE', 'GTK_MODULES', 'QT_ACCESSIBILITY']) {
    if (env[key] !== undefined) clean[key] = env[key];
  }
  return clean;
}

const runtime: DesktopProvisionRuntime = {
  spawn: async (command, args, _spec, options) => {
    const child = spawn(command, [...args], options?.spawnOptions ?? {});
    // Report errors through the provisioner diagnostics without an unhandled EventEmitter error.
    child.on('error', () => {});
    return { child, taskId: null, scopeUnit: null, confined: false, row: { detail: { unledgered: true } } };
  },
  startBus: display => startA11yBus(display),
  // The dedicated systemd unit supplies mount, Unix-user and whole-cgroup containment.
  // GL is measured in that SAME process environment; do not claim a nested bwrap probe.
  sandbox: async () => ({
    forGlProbe: command => [...command],
    forApp: command => ({ binary: command[0], argv: command.slice(1), sandboxed: false }),
  }),
  appEnv: (env, overlays) => ({ ...workspaceDesktopEnvironment(env), ...overlays }),
};

export async function runWorkspaceDesktopWorker(argv: string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write('papercusp-desktop-session --stdio | --check\n');
    return 0;
  }
  const identity = userInfo();
  assertWorkspaceDesktopIdentity({ uid: identity.uid, username: identity.username, home: process.env.HOME ?? '' });
  const clean = workspaceDesktopEnvironment({});
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, clean);
  if (argv.length === 1 && argv[0] === '--check') return 0;
  if (argv.length === 1 && argv[0] === '--stdio') {
    const locks = `${WORKSPACE_DESKTOP_HOME}/display-locks`;
    mkdirSync(locks, { recursive: true, mode: 0o700 });
    // Kernel flock lifetime covers provisioning AND the whole lease. No stale PID-file cleanup
    // or race between two socket-activated instances selecting the same display.
    for (let display = 110; display <= 250; display++) {
      if (existsSync(`/tmp/.X${display}-lock`)) continue;
      const status = await new Promise<number>((resolve, reject) => {
        const child = spawn('/usr/bin/flock', ['-n', '-E', '75', `${locks}/${display}`, process.execPath, process.argv[1], '--display', String(display)], { stdio: 'inherit', env: clean });
        child.once('error', reject);
        child.once('exit', code => resolve(code ?? 1));
      });
      if (status !== 75) return status;
    }
    throw new Error('no isolated desktop display available');
  }
  if (argv.length !== 2 || argv[0] !== '--display' || !/^\d+$/.test(argv[1])) throw new Error('invalid desktop worker arguments');
  const number = Number(argv[1]);
  if (number < 110 || number > 250 || existsSync(`/tmp/.X${number}-lock`)) throw new Error('desktop display unavailable');
  await serveWorkspaceDesktop(process.stdin, process.stdout, options => provisionSandboxDesktop({
    ...options, displayNumber: number, xServer: 'kasmvnc', rootColor: WORKSPACE_DESKTOP_ROOT_COLOR, desktopSession: 'xfce',
    credentialDir: `${WORKSPACE_DESKTOP_HOME}/credentials`, sandboxHomeDir: WORKSPACE_DESKTOP_HOME,
  }, runtime));
  return 0;
}
