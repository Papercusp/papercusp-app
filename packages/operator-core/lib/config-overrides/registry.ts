/**
 * Runtime-config override registry (live-configurability-audit-2026-06-20 P-024/P-025).
 *
 * The plan's #1 reviewer gap (D-005): once N concerns each get their own override store,
 * an operator debugging odd fleet behavior would have to check N stores plus the code —
 * the same opaque-config trap the whole effort exists to kill, one layer up. So every
 * runtime-config concern self-registers here, and two generic tools read across all of
 * them: `config:list-overrides` (what diverges from baked defaults, + which layer won, +
 * the last audit row) and `config:reset-overrides` (revert one concern, or all, to
 * defaults — audited via the control harness).
 *
 * A generic READ/RESET across concerns is consistent with D-001's "no generic settings
 * get/set" rule — that rule forbids a generic WRITE god-tool with per-concern semantics;
 * observability + a blanket revert-to-defaults are cross-cutting by nature.
 *
 * Concerns register at module load (side effect), like tools self-register into the tool
 * registry. Idempotent (keyed by name) so a re-import never duplicates.
 */

/** One key that currently diverges from its baked default. */
export interface OverrideEntry {
  /** the tunable / setting key */
  key: string;
  /** the current effective value (the override) */
  effective: unknown;
  /** the baked-in default, when the concern can supply it without duplicating a drift-prone literal */
  default?: unknown;
  /** which layer set this value, e.g. 'routine-payload' | 'pg-settings' | 'env' */
  layer: string;
}

export interface OverrideConcern {
  /** stable concern id, e.g. 'watchdog-tunables' */
  name: string;
  /** one-line human description for the readback */
  description?: string;
  /** the gateway-control audit action this concern's writes use ('<group>:<verb>'), so the
   *  readback can attach the latest audit row (who/when) from harness_shared.audit_log. */
  auditAction?: string;
  /** Keys currently diverging from baked defaults (the override set). */
  diff(): Promise<OverrideEntry[]>;
  /** Capture the full current override state — the snapshot an audited reset replays on revert. */
  capture(): Promise<unknown>;
  /** Revert ALL of this concern's overrides to baked defaults; returns the new state. */
  reset(): Promise<unknown>;
  /** Re-apply a captured snapshot (the reset's revert primitive). */
  restore(snap: unknown): Promise<void>;
}

const REGISTRY = new Map<string, OverrideConcern>();

/** Register (or replace) a runtime-config concern. Idempotent by name. */
export function registerOverrideConcern(concern: OverrideConcern): void {
  REGISTRY.set(concern.name, concern);
}

/** All registered concerns (insertion order). */
export function listOverrideConcerns(): OverrideConcern[] {
  return [...REGISTRY.values()];
}

/** One concern by name, or undefined. */
export function getOverrideConcern(name: string): OverrideConcern | undefined {
  return REGISTRY.get(name);
}
