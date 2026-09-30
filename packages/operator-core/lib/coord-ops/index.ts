/**
 * `@papercusp/operator-core` coord-ops — the composable coordination primitive
 * library (`coordination-ops-as-blueprint-primitives-2026-06-04`). Importing this
 * module once registers every op into the registry (the `defineTool` self-
 * registration pattern). The durable `coordProgramWorkflow` and the dual-surface
 * tool wrappers both resolve ops through the registry.
 *
 * D-004: only `coord:collect` + `vote:aggregate` are genuinely new; the rest wrap
 * shipped primitives (threads/conversations, the spawn runner, escalate, the
 * subscribe→inject substrate). The composition ops (`coord:vote` /
 * `coord:deliberate` / `coord:ask`) that run a sub-blueprint program register
 * here too (compose.ts).
 */
export * from './types.js';
export {
  registerCoordOp,
  getCoordOp,
  requireCoordOp,
  listCoordOps,
  coordOpNames,
  hasCoordOp,
} from './registry.js';
// The pure vote tally + structured-post parsing live in the generic
// `@papercusp/step-program` lib (generalize-libs-to-generic-2026-06-05 #5); the
// `vote:aggregate` op (ops/aggregate.ts) wraps `aggregateVotes`. Re-exported here
// so existing coord-ops importers keep one import site.
export { aggregateVotes, parsePost } from '@papercusp/step-program';
export type { AggregateResult, ParsedVote, ParsedAdvocate } from '@papercusp/step-program';

// Register the P0 ops (wrap-existing + the 2 new) — side-effect imports.
import './ops/thread-open.js';
import './ops/thread-post.js';
import './ops/spawn-roles.js';
import './ops/escalate.js';
import './ops/subscribe.js';
import './ops/collect.js';
import './ops/aggregate.js';
import './ops/resolve.js';
// Composition ops (coord:vote / coord:deliberate / coord:ask) — run a sub-program.
import './ops/compose.js';
// Internal accepted-operation program steps; execution is owned by DBOS.
import './ops/blueprint-child.js';
