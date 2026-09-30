/**
 * scenario-types.ts — the contract between the runner and individual
 * p2p-perf scenarios (P-001).
 */

import type { PerfArtifact } from './artifact';

export type PerfProfile = 'smoke' | 'ci' | 'full' | 'deep';

export interface ScenarioRunCtx {
  /** Effort profile — scenarios size their internal matrices off this. */
  profile: PerfProfile;
  /**
   * History sizes to sweep, when the scenario has a history axis. The runner
   * defaults this per profile: `smoke` = [1k], `ci` = [1k, 10k],
   * `full` = [1k, 10k, 100k], `deep` = [1k, 10k, 100k, 1M].
   */
  sizes: number[];
  /** Peer counts to sweep, when the scenario has a peer axis. */
  peerCounts: number[];
  /** Emit one finished artifact (the runner persists + reports it). */
  emit(artifact: PerfArtifact): Promise<void>;
  /** Progress line → runner stdout. */
  log(line: string): void;
  /** Corpus seed (fixed default so runs are comparable; overridable for noise checks). */
  seed: number;
}

export interface PerfScenario {
  /** Stable id — artifact `scenario` fields are `<id>` or `<id>.<variant>`. */
  id: string;
  tier: 1 | 2 | 3;
  describe: string;
  run(ctx: ScenarioRunCtx): Promise<void>;
}
