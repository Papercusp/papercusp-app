/**
 * The deployment-driver registry — the `configure*()` host seam.
 *
 * `cloud-deployment-layer-2026-06-06` P-001 / D-002.
 *
 * `LocalDriver` is always registered (the built-in default), so a fresh process
 * resolves `{ target: 'local' }` with zero host wiring. Cloud backends register
 * via `configureDeployment({ drivers })` (or `registerDeploymentDriver`) at host
 * bootstrap — the same host-seam pattern as `@papercusp/locks`'s `configureLocks`
 * and `@papercusp/host-platform`'s `registerHostPlatform`.
 *
 * Pins the registry to the realm via `@papercusp/module-singleton` so a single
 * registry survives ESM/tsx module-forking (the same reason `@papercusp/memory`
 * does — a module-local `Map` would split into per-fork copies and a driver
 * registered in one fork would be invisible in another).
 */
import { pinModuleState } from '@papercusp/module-singleton';
import type { DeploymentConfig, DeploymentDriver, DeploymentTarget } from './types';
import { LocalDriver } from './local-driver';

/**
 * The pin key — also the id this module reports under in
 * `listModuleDuplications()`, so a split here is visible in the REALM-WIDE
 * report rather than only through this module's own accessors. The string is
 * unchanged from the `Symbol.for(...)` description used before the migration
 * (EI-19469900474673886).
 */
const STATE_KEY = '@papercusp/deployment-driver:registry';

type Registry = Map<DeploymentTarget, DeploymentDriver>;

interface RegistryState {
  registry: Registry;
}

/**
 * Pinned + counted rather than hand-rolled on `globalThis[Symbol.for(...)]`: a
 * hand-rolled slot fixes correctness but is invisible to
 * `listModuleDuplications()`, so the central report answers a clean `[]` while
 * this module is split. Must stay at module scope — `evaluations` is only a
 * module-RECORD count if this runs exactly once per evaluation of this body.
 *
 * Seeding is eager now rather than on first `registry()` call. `LocalDriver` is
 * a static import, so it is already initialised at this point; the observable
 * behaviour is unchanged (`local` was always present on the first read).
 */
const state = pinModuleState<RegistryState>(STATE_KEY, () => ({
  // the built-in default — always present
  registry: new Map<DeploymentTarget, DeploymentDriver>([['local', LocalDriver]]),
}));

function registry(): Registry {
  return state.registry;
}

/**
 * Register one deployment driver (the `configure*()` seam — a cloud backend plugs
 * in here at host bootstrap). Re-registering the same `target` replaces it.
 */
export function registerDeploymentDriver(driver: DeploymentDriver): void {
  registry().set(driver.target, driver);
}

/** Host-seam entry: register a batch of drivers at bootstrap. */
export function configureDeployment(opts: { drivers: DeploymentDriver[] }): void {
  for (const d of opts.drivers) registerDeploymentDriver(d);
}

/**
 * Resolve the driver for a config (defaulting to `local` when the config is
 * absent — every existing harness). Throws a clear error if the target has no
 * registered driver, naming what IS registered.
 */
export function resolveDeploymentDriver(config: DeploymentConfig | undefined | null): DeploymentDriver {
  const target = config?.target ?? 'local';
  const driver = registry().get(target);
  if (!driver) {
    throw new Error(
      `No deployment driver registered for target '${target}'. ` +
        `Registered: [${[...registry().keys()].join(', ')}]. ` +
        `A cloud backend registers via configureDeployment({ drivers }) at host bootstrap.`,
    );
  }
  return driver;
}

/** The set of registered targets (for diagnostics / "what can I deploy to"). */
export function registeredDeploymentTargets(): DeploymentTarget[] {
  return [...registry().keys()];
}

/**
 * Cheap placement check WITHOUT running any driver side effects: does this
 * config's execution plane run on this machine? `local` (or an unregistered
 * target, conservatively) → true; a registered remote driver → false. The
 * launch/orchestrator path (P-004) uses this to decide whether to spawn locally.
 */
export function isLocalDeployment(config: DeploymentConfig | undefined | null): boolean {
  const target = config?.target ?? 'local';
  if (target === 'local') return true;
  const driver = registry().get(target);
  // Unknown target → treat as local (conservative: never silently route work to a
  // frame that isn't wired up; the resolve call will surface the missing driver).
  return driver ? driver.placement === 'local' : true;
}

/** Test-only: reset the registry to just `LocalDriver`. */
export function _resetDeploymentDriversForTests(): void {
  const reg = registry();
  reg.clear();
  reg.set('local', LocalDriver);
}
