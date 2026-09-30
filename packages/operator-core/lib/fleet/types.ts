/**
 * fleet/types — re-exports the shared vocabulary from @papercusp/structured-concurrency
 * plus the papercusp-local `Db` handle type. The generic spawn-tree / status vocabulary
 * now lives in the toolkit; this file keeps the in-app import paths (`./types`) stable.
 */
export type { Db } from './pg-stores';
export {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  isActiveStatus,
  isTerminalStatus,
} from '@papercusp/structured-concurrency';
export type { SpawnStatus, RestartStrategy, SpawnNode, IntensityResult, CompletionGate } from '@papercusp/structured-concurrency';
