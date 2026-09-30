/**
 * Host-adapter shim → `@papercusp/locks` (SuLocksCoordinator).
 *
 * `SuLocksCoordinator` (the @papercusp/file-claim adapter) moved to the
 * package (P-010). This shim keeps `@/lib/agent-tools/locks/coordinator`
 * resolving for `heartbeat.ts`, `plans/with-plan-lock.ts`, and
 * `__tests__/coordinator.integration.test.ts`. Imports `./configure` for the host seam,
 * then re-exports the package barrel.
 */
import './configure';
export * from '@papercusp/locks';
