/**
 * Host-adapter shim → `@papercusp/locks` (storage layer).
 *
 * The SU-locks store moved to the package (P-010,
 * papercusp-systems-abstraction-2026-05-29). This shim keeps the path
 * `@/lib/agent-tools/locks/su-lock-store` resolving unchanged for the tool
 * wrappers, `plans/with-plan-lock.ts`, and the locks test suite. It imports
 * `./configure` first so the `getAdminBaseUrl` host seam is wired before any
 * store call, then re-exports the package barrel.
 */
import './configure';
export * from '@papercusp/locks';
