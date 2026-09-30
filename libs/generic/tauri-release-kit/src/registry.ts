/**
 * Target-driver registry. Mirrors @papercusp/deployment-driver/registry:
 * the host registers the drivers it can run (built-in linux-local + any VM
 * drivers it wires), and the orchestrator resolves by TargetKey.
 */
import type { TargetDriver, TargetKey } from './types.js';

const registry = new Map<TargetKey, TargetDriver>();

export function registerTargetDriver(driver: TargetDriver): void {
  registry.set(driver.key, driver);
}

export function hasTargetDriver(key: TargetKey): boolean {
  return registry.has(key);
}

export function resolveTargetDriver(key: TargetKey): TargetDriver {
  const d = registry.get(key);
  if (!d) {
    throw new Error(
      `no build target driver registered for "${key}" (have: ${listTargetDrivers().join(', ') || 'none'})`,
    );
  }
  return d;
}

export function listTargetDrivers(): TargetKey[] {
  return [...registry.keys()];
}

/** Test seam: drop all registered drivers. */
export function clearTargetDrivers(): void {
  registry.clear();
}
