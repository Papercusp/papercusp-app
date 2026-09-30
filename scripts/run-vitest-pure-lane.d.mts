import type { Writable } from "node:stream";

export const PURE_LANE_MAX_FILES_PER_FRESH_FORK: number;

export function resolvePureLaneShardCount(
  env?: Readonly<Record<string, string | undefined>>,
  pureFileCount?: number,
): number;

export function buildPureLaneShardArgs(
  shard: number,
  shardCount: number,
  forwardedArgs?: string[],
): string[];

export function runVitestProcess(
  args: string[],
  options?: {
    env?: Readonly<Record<string, string | undefined>>;
    spawnProcess?: (...args: unknown[]) => unknown;
    runGovernedTestProcess?: (...args: unknown[]) => Promise<unknown>;
    createSampler?: (...args: unknown[]) => unknown;
    stderr?: Pick<Writable, "write">;
  },
): Promise<number>;

export function runPureLaneShards(options?: {
  env?: Readonly<Record<string, string | undefined>>;
  forwardedArgs?: string[];
  run?: (args: string[]) => Promise<number>;
  stderr?: Pick<Writable, "write">;
  pureFileCount?: number;
}): Promise<number>;
