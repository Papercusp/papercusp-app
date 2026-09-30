/**
 * The coord-op registry (`coordination-ops-as-blueprint-primitives-2026-06-04`
 * D-001 / D-004). A name → `CoordOp` map. Ops self-register on import (mirroring
 * the `defineTool` registration pattern); the durable `coordProgramWorkflow` and
 * the dual-surface tool wrappers both resolve ops through here. The keyset is also
 * what the operator passes to `validateBlueprint({ knownOps })` so a program that
 * names a nonexistent op fails at author/load time, not at run time.
 */
import type { CoordOp } from './types.js';

const REGISTRY = new Map<string, CoordOp>();

/** Register a coord op (idempotent re-register replaces — dev prompt-reload safe). */
export function registerCoordOp(op: CoordOp): void {
  REGISTRY.set(op.name, op as CoordOp);
}

/** Look up an op by name, or undefined. */
export function getCoordOp(name: string): CoordOp | undefined {
  return REGISTRY.get(name);
}

/** Look up an op, throwing a clear error when absent (the executor's strict path). */
export function requireCoordOp(name: string): CoordOp {
  const op = REGISTRY.get(name);
  if (!op) {
    throw new Error(
      `coord-op "${name}" is not registered (known: ${[...REGISTRY.keys()].sort().join(', ') || '<none>'})`,
    );
  }
  return op;
}

/** Every registered op (for tool projection + the reactive-graph view). */
export function listCoordOps(): CoordOp[] {
  return [...REGISTRY.values()];
}

/** The registered op names — passed to validateBlueprint as `knownOps`. */
export function coordOpNames(): Set<string> {
  return new Set(REGISTRY.keys());
}

/** True if the op is registered. */
export function hasCoordOp(name: string): boolean {
  return REGISTRY.has(name);
}
