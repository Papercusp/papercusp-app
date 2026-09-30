/**
 * Host-adapter shim → `@papercusp/locks` (inWorkspaceTxn).
 *
 * The per-workspace advisory-lock transaction wrapper moved to the package
 * (P-010). This shim keeps `@/lib/agent-tools/locks/in-workspace-txn`
 * resolving for the tool wrappers and the locks test suite. Imports
 * `./configure` for the host seam, then re-exports the package barrel.
 */
import './configure';
export * from '@papercusp/locks';
