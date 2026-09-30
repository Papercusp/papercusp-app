/**
 * Boot gate — projection refuses to start until BOTH ensure-paths
 * (SQL migrations + ensure-schema.ts runtime ensure) report
 * complete.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031a.
 *
 * Pattern matches the Phase 1a P-013 boot flag: each ensure-path
 * sets its respective flag on `globalThis.__papercuspEnsureFlags`
 * when it finishes. The projection's `awaitEnsurePaths()` resolves
 * when both flags are set; throws on a hard timeout.
 *
 * Why globalThis: the operator process spans multiple modules with
 * different load orders depending on whether we're in dev/prod/test.
 * A module-scoped singleton would race; the global is safer.
 */

interface EnsureFlags {
  sql_migrations_complete?: boolean;
  runtime_ensure_complete?: boolean;
  /**
   * WI-5441/WI-5764 boot-window federation-capture-hole guard: flips the
   * instant `applyPendingMigrationsAtBoot()` returns (host-bootstrap.ts),
   * BEFORE the rest of the substrate-boot IIFE (system-principals healing,
   * bench reapers, substrate boot itself) runs — deliberately a narrower,
   * earlier signal than sql_migrations_complete/runtime_ensure_complete
   * above (those additionally wait on the substrate boot-gate flip, which is
   * unrelated and would delay request-serving for no reason). A background
   * process marks this after its boot migration runner completes; a
   * request-only host runs the same coordinated preflight in
   * waitForBootMigrationGate before marking its own process-local flag.
   * Each request-serving process keeps its own flag because globalThis is not
   * shared across cluster workers.
   */
  request_gate_migrations_applied?: boolean;
}

declare global {
  var __papercuspEnsureFlags: EnsureFlags | undefined;
}

function flags(): EnsureFlags {
  if (!globalThis.__papercuspEnsureFlags) {
    globalThis.__papercuspEnsureFlags = {};
  }
  return globalThis.__papercuspEnsureFlags;
}

export function markSqlMigrationsComplete(): void {
  flags().sql_migrations_complete = true;
}

export function markRuntimeEnsureComplete(): void {
  flags().runtime_ensure_complete = true;
}

/** WI-5441/WI-5764: see the field doc on `request_gate_migrations_applied`. */
export function markMigrationsAppliedForRequestGate(): void {
  flags().request_gate_migrations_applied = true;
}

/** WI-5441/WI-5764: see the field doc on `request_gate_migrations_applied`. */
export function isMigrationsAppliedForRequestGate(): boolean {
  return flags().request_gate_migrations_applied === true;
}

export function isReadyForProjection(): boolean {
  const f = flags();
  return f.sql_migrations_complete === true && f.runtime_ensure_complete === true;
}

export interface AwaitOpts {
  /** Max wait, ms. Defaults to 30s — enough for typical SQL migration runs. */
  timeoutMs?: number;
  /** Poll interval, ms. Defaults to 100ms. */
  pollMs?: number;
}

export class BootGateTimeoutError extends Error {
  constructor(public flags: EnsureFlags, public waited_ms: number) {
    super(`boot gate timeout: waited ${waited_ms}ms; flags=${JSON.stringify(flags)}`);
  }
}

export async function awaitEnsurePaths(opts: AwaitOpts = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 100;
  const start = Date.now();
  while (!isReadyForProjection()) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      throw new BootGateTimeoutError({ ...flags() }, elapsed);
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}

/**
 * WI-5441/WI-5764: poll until `markMigrationsAppliedForRequestGate()` has
 * fired, or throw a BootGateTimeoutError past `timeoutMs`. Deliberately
 * separate from `awaitEnsurePaths` (which additionally waits on the
 * substrate boot-gate) — see the field doc on `request_gate_migrations_applied`.
 * Callers in host-bootstrap.ts treat a timeout as non-fatal (log + serve
 * anyway) to match this whole boot path's log-and-continue philosophy.
 */
export async function awaitMigrationsAppliedForRequestGate(opts: AwaitOpts = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const pollMs = opts.pollMs ?? 50;
  const start = Date.now();
  while (!isMigrationsAppliedForRequestGate()) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      throw new BootGateTimeoutError({ ...flags() }, elapsed);
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}

/** For tests. */
export function _resetFlagsForTests(): void {
  globalThis.__papercuspEnsureFlags = {};
}
