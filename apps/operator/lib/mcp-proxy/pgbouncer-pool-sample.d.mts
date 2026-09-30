/**
 * Types for the PgBouncer pool sampler's exported surface (EI-19384024494946006).
 *
 * `pgbouncer-pool-sample.mjs` is plain ESM, imported by the watchdog entrypoint (which itself
 * must stay runnable without a build step — see watchdog.d.mts's identical rationale). This
 * file restores type-checking for its test suite the same way.
 */

export const SAMPLE_LOG_FILE: string;
export const MIN_SAMPLE_INTERVAL_MS: number;

export function buildShowPoolsArgs(opts?: { host?: string; port?: number; user?: string }): string[];

export function samplePgBouncerPools(
  reason: string,
  opts?: {
    execFileImpl?: (
      cmd: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (err: (Error & { message: string }) | null, stdout: string, stderr: string) => void,
    ) => void;
    now?: () => number;
  },
): Promise<{ ok: boolean; output?: string; error?: string | null; skipped?: string }>;

export function _resetSampleDebounceForTests(): void;
