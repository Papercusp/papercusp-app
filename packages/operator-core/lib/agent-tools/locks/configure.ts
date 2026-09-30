/**
 * Operator host-adapter for `@papercusp/locks`.
 *
 * Wires the package's host seam to the operator's runtime:
 *   - `getAdminBaseUrl` → embedded-pg discovery (the package derives the
 *     `papercusp_su` side-database URL from this main admin URL and owns
 *     everything else: pools, migrations, advisory lock, cascade, wait
 *     subsystem, janitor).
 *   - `getTxnTimeouts` → the runtime per-workspace lock_timeout/statement_timeout
 *     dial (live-configurability-audit-2026-06-20 P-020, db:txn-timeouts). SYNC,
 *     reads the D-010 sync cache (zero-await — it's called per-txn).
 *
 * Imported for its side-effect by every operator-side locks shim
 * (su-lock-store / coordinator / in-workspace-txn / workspace-listener /
 * path-normalize), so `configureLocks` runs before any store call no matter
 * which module a consumer loads first. `configureLocks` only sets a module
 * singleton, so repeated imports (ESM evaluates this module once) are a
 * no-op.
 */
import { configureLocks } from '@papercusp/locks';
import { setAdminPoolStatementTimeoutProvider } from '@papercusp/db-org';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { adminPoolStatementTimeoutMs, txnTimeoutsConfig } from '../../txn-timeouts-config';

configureLocks({
  getAdminBaseUrl: () => getHarnessAdminUrl(),
  getTxnTimeouts: () => txnTimeoutsConfig(),
});

// WI-832: inject the admin-pool default statement_timeout into the low-level db connection
// factory (the layering-safe seam — connection.ts can't read operator-core config directly).
// Default config ⇒ adminPoolStatementTimeoutMs() returns 0 ⇒ no GUC ⇒ today's exact behavior.
// This module is imported early + universally (every locks shim pulls it in for side effects),
// so the provider is registered before the first org pool is constructed. NOTE for tests: a
// `vi.mock('@papercusp/db-org', …)` in any test whose import graph reaches a locks shim must
// include this export (vitest throws on ANY access to a missing mock export, so a runtime
// guard here cannot help).
setAdminPoolStatementTimeoutProvider(adminPoolStatementTimeoutMs);
