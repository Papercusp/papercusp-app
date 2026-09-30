/**
 * fleet/spawn-tree — durable read/write of the parent→child spawn tree
 * (harness_shared.spawned_agents).
 *
 * The structured-concurrency toolkit (@papercusp/structured-concurrency) defines the
 * SpawnTreeStore port; the actual SQL lives in `./pg-stores`. This module keeps the
 * historical `<fn>(sql, …)` entry points (consumed by the fleet:* tools and the
 * integration suite) as thin re-exports of the PG store ops, so callers compose inside a
 * transaction exactly as before.
 */
export type { RecordSpawnInput, FinishSpawnInput } from '@papercusp/structured-concurrency';
export {
  recordSpawnPg as recordSpawn,
  finishSpawnPg as finishSpawn,
  getSpawnPg as getSpawn,
  getSubtreePg as getSubtree,
  openChildrenPg as openChildren,
  directChildrenPg as directChildren,
} from './pg-stores';

// getSubtree's options type is the toolkit's SubtreeQuery — re-exported under the
// historical name for call sites that referenced it.
export type { SubtreeQuery as SubtreeOptions } from '@papercusp/structured-concurrency';
