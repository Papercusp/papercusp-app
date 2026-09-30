/** Shared provisioner algorithm, wired to the operator's process and sandbox owners. */
import { managedSpawn, markManagedSpawnTeardown } from '../../task-manager/managed-spawn';
import { killScopeUnit, killTask } from '../../task-manager/control';
import { startA11yBus } from '../../desktop/a11y-bus';
import { a11yBusSocketPath, desktopAppSandboxEnabled, desktopSandboxSession, desktopSandboxEnv } from './desktop-sandbox';
import * as core from './desktop-provisioner-core';
export * from './desktop-provisioner-core';

const releaseDeps = { killTask, killScopeUnit, markManagedTeardown: markManagedSpawnTeardown };
const operatorRuntime: core.DesktopProvisionRuntime = {
  spawn: managedSpawn,
  startBus: startA11yBus,
  sandbox: async (display, env, opts) => desktopSandboxSession(
    { display, a11yBusPath: a11yBusSocketPath(env.DBUS_SESSION_BUS_ADDRESS),
      ...(opts.sandboxHomeDir ? { homeDir: opts.sandboxHomeDir } : {}) },
    { enabled: opts.sandboxApps ?? await desktopAppSandboxEnabled(),
      ...(opts.denyAppNetwork ? { denyNetwork: true } : {}) },
  ),
  appEnv: desktopSandboxEnv,
  releaseDeps,
};
export function provisionSandboxDesktop(opts: core.ProvisionOptions = {}, runtime: Partial<core.DesktopProvisionRuntime> = {}) {
  return core.provisionSandboxDesktop(opts, { ...operatorRuntime, ...runtime });
}
export function releaseDesktopProcesses(...[procs, root, deps]: Parameters<typeof core.releaseDesktopProcesses>) {
  return core.releaseDesktopProcesses(procs, root, { ...releaseDeps, ...deps });
}
export function releaseDesktopResources(...[procs, root, a11y, deps]: Parameters<typeof core.releaseDesktopResources>) {
  return core.releaseDesktopResources(procs, root, a11y, { ...releaseDeps, ...deps });
}
