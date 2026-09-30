/**
 * Host-adapter shim → `@papercusp/locks` (workspace LISTEN bus + janitor).
 *
 * The refcounted per-workspace LISTEN subscriptions and the background
 * expiry janitor timer moved to the package (P-010). This shim keeps
 * `@/lib/agent-tools/locks/workspace-listener` resolving for `acquire.ts`,
 * `in-workspace-txn`, and the locks test suite. Imports `./configure` for
 * the host seam, then re-exports the package barrel.
 */
import './configure';
export * from '@papercusp/locks';
