/**
 * Single source of the lock TTL / wait defaults (live-configurability-audit-2026-06-20 P-013, D-006).
 *
 * These were copy-pasted across the lock agent-tools (acquire, acquire_granular, acquire_resource,
 * heartbeat, heartbeat_resource, file-lock-guard, resource-lock-guard) — a ~6-way desync footgun: a
 * runtime change to one copy silently mis-sets the lease elsewhere. Consolidated here; the companion
 * one-source test (lock-config.test.ts) asserts no surviving `*_TTL_SEC = <literal>` re-declaration in
 * this directory. The locks STORE (libs/papercusp/packages/locks/coordinator.ts) keeps its own default
 * for direct-store callers — a separate package layer.
 *
 * P-013 EXPOSE (the runtime locks:lock_config tool) is the next step: it will make the DEFAULT settable
 * (a sync-cached operator_lock_config read at the call site); MAX_LOCK_TTL_SEC / MAX_LOCK_WAIT_SEC stay
 * hard zod ceilings (schema-time consts), with any configured soft-max validated in the handler.
 */

/** Default lock lease (20 min) — matches the PreToolUse per-edit hook lease. */
export const DEFAULT_LOCK_TTL_SEC = 1200;
/** Hard cap on a lock lease (1 h). */
export const MAX_LOCK_TTL_SEC = 3600;
/** Max blocking same-turn wait — past this, end your turn with wake_on_grant.
 *
 *  ⚠ MUST stay under the ~55s MCP client deadline WITH tail margin (EI-21389299859182434):
 *  the MCP client kills the call at ~55s (-32001, UNKNOWN OUTCOME) while the server keeps
 *  blocking to wait.max_sec — the old 300s ceiling made every >55s blocking wait strand its
 *  caller, and the post-timeout lucky-race grant could then orphan a lock until TTL lapse.
 *  45s + the handler's post-wait tail (expireWaiter + busy re-read + enrichBusy) keeps the
 *  whole call inside the transport deadline — same class of fix as testing:run's 50s
 *  foreground clamp. A longer wait belongs to wake_on_grant (returns immediately, no turn
 *  held). Raising this back above ~45 re-introduces the unknown-outcome class; the guard
 *  test in lock-config.test.ts fails on it. */
export const MAX_LOCK_WAIT_SEC = 45;
