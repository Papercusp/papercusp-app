/**
 * `blueprintRegistrySets` — the operator-side bridge that hands the blueprint
 * validator its op + role registries so the load / install / authoring paths
 * ENFORCE the liveness contract (`deterministic-blueprints-migration-2026-06-13`
 * P-001).
 *
 * The pure validator lib (`@papercusp/orchestrator/blueprint`) intentionally
 * doesn't own either registry (D-001/D-004): the coord-op registry lives here in
 * operator-core; the agent-role registry lives in `@papercusp/agent-mcp`. The
 * registry header has always SAID the keyset is "what the operator passes to
 * `validateBlueprint({ knownOps })` so a program that names a nonexistent op fails
 * at author/load time, not at run time" — but until P-001 NO caller actually
 * passed it, so a deterministic-program blueprint (a migrated learning loop, and
 * every future procedure migration) could name a typo'd / unregistered op and
 * validate clean, then throw `requireCoordOp` deep in the durable
 * `coordProgramWorkflow` at run time. This module is that missing bridge.
 *
 * It imports BOTH op-registration entrypoints for their self-registration side
 * effects — the coordination ops (`coord-ops/index`) AND the deterministic
 * step-ops, the migrated learning loops (`blueprint-steps/index`) — then reads
 * the live sets LAZILY (at call time, not import time), so it is robust to import
 * ordering: by the time a blueprint is admitted, every op has registered.
 */
import { coordOpNames } from '../coord-ops/index.js';
import { getKnownRoles } from '../known-roles.js';
import type { BlueprintValidateRegistry } from '@papercusp/orchestrator/blueprint';

// Register the deterministic step-ops (the migrated learning loops) so
// `coordOpNames()` returns the FULL set a program-mode / hybrid blueprint may
// name — `coord-ops/index` (imported above for `coordOpNames`) only registers the
// coordination ops, not this op family.
import '../blueprint-steps/index.js';

/**
 * The live `{ knownOps, knownRoles }` the validator consults: every registered
 * coord-op name + every live agent-role id. Pass into `validateBlueprint` /
 * `resolveBlueprint` / `resolveAndValidateBlueprint` at a blueprint ADMISSION
 * point (authoring, marketplace install, PG projection) so an unknown op is
 * rejected with a clear `unknown-op` at author/load/install time, and a
 * live-but-undeclared role (e.g. a spine dispatching the built-in `worker`
 * without re-declaring it) is not falsely flagged.
 */
export function blueprintRegistrySets(): BlueprintValidateRegistry {
  return { knownOps: coordOpNames(), knownRoles: new Set(getKnownRoles()) };
}
