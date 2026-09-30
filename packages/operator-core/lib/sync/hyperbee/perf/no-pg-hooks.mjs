/**
 * no-pg-hooks.mjs — module-resolution hooks that keep `@papercusp/db-org` (and
 * therefore drizzle-orm) OUT of a perf peer-child process.
 *
 * WHY (plan harden-shared-hive-to-256-peers-2026-06-29, P-012 / D-024 / D-025):
 * a perf peer never queries Postgres — `peer-child.ts` supplies `applyOverride`,
 * `loadRevokedOverride`, `verifyBindingOverride` and `announceIdentityOverride`
 * precisely so the rig exercises the substrate and not the projection stack. But
 * the substrate's own module graph reaches `@papercusp/db-org` by 51 distinct
 * STATIC paths (8 top-level edges out of boot.ts / swarm.ts), and one surviving
 * edge loads the whole thing. Measured cost in a fresh process, `node --expose-gc
 * --import tsx`, RSS after 3x GC: the peer-child module graph is 247-254MB with
 * db-org and 130-142MB with it stubbed. That ~112MB per peer is pure import cost
 * for an ORM the child never calls, and at 256 peers it is ~29GB — which is why
 * `decideMeshCapacity()` refuses anything much above 64 peers on this host.
 *
 * WHY A LOADER RATHER THAN LAZY IMPORTS IN THE SUBSTRATE: making the 51 paths
 * lazy means touching ~40 production projection modules plus the boot composer,
 * for zero production benefit (the operator queries PG constantly, so production
 * pays for drizzle either way) and a real correctness/gate risk on shared code.
 * The rig-local loader recovers the whole 112MB with no production edit at all.
 *
 * FAIL LOUD, NEVER SILENT: the stub THROWS on use rather than returning a fake
 * `sql`. If a perf peer ever does reach a Postgres path, the run must die with a
 * message that says so — a rig that silently degrades is exactly the instrument
 * defect this lane has produced eight times. A run that dies here is telling you
 * the rig's override set no longer covers the boot path; fix the override or the
 * boot path, do not soften this stub.
 *
 * Wired in `child-driver.ts` as a second `--import` after tsx. Written as .mjs on
 * purpose: resolution hooks run on a separate loader thread, where relying on
 * tsx to transpile the hook module itself is an avoidable failure mode.
 */

const STUB = new URL('./no-pg-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@papercusp/db-org') {
    return { url: STUB, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
