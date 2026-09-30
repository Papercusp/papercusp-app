/**
 * boot-integrity-first.ts — the FIRST import of the operator entrypoint(s).
 *
 * ES modules evaluate depth-first in import order, so importing THIS module before
 * `./host-bootstrap` (which transitively imports `@papercusp/plugin-loader`, the MCP
 * SDK, mem0, …) runs the integrity preflight BEFORE those heavy imports are
 * evaluated. If `node_modules` is inconsistent with the source (the 2026-06-25
 * MODULE_NOT_FOUND crash-loop class), we log one named diagnostic and exit fast —
 * instead of the import graph throwing a raw `Cannot find module` deep in boot and,
 * under PAPERCUSP_CLUSTER, every worker crash-looping until the respawn budget burns
 * out (~35 min of "connection refused on all pages").
 *
 * It imports ONLY the dependency-free preflight (which imports only Node built-ins —
 * `node:module`, `node:fs`, `node:path`, `node:url`), so this guard can never be a
 * victim of the inconsistency it checks for. Keep it import-light, and keep it FIRST
 * in the entrypoint import list.
 */
import { runBootIntegrityGuardOrExit } from '@papercusp/operator-core/lib/boot-integrity-preflight';

runBootIntegrityGuardOrExit();
