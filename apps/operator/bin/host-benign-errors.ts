/**
 * host-benign-errors — re-export shim.
 *
 * The classifiers moved to `@papercusp/operator-core/lib/host-benign-errors`
 * (P-006, plan p2p-parity-parallel-lanes-2026-07-09) so the sidecar-spawn
 * shutdown-hook layer (`packages/operator-core/lib/process-supervision/
 * sidecar-spawn-shared.ts`) can reuse the SAME benign-error classification
 * hono-host.ts already uses — previously the sidecar shutdown hook's own
 * `uncaughtException` listener had no such filter and tore down a perfectly
 * healthy spawner/substrate sidecar on every benign `write EPIPE` (a client
 * disconnect), producing the ~6min sidecar die/respawn churn (EI-8810
 * residue). `packages/` cannot import from `apps/`, so the implementation
 * lives in operator-core and this file re-exports it for the existing
 * `./host-benign-errors` import in hono-host.ts.
 */
export * from '@papercusp/operator-core/lib/host-benign-errors';
