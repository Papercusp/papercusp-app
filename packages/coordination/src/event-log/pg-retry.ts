/**
 * Bounded retry for PostgreSQL writes that lose a transient lock race.
 *
 * A coord event-log write is a short, retry-safe statement. PostgreSQL's
 * `lock_timeout` (55P03) and `statement_timeout` (57014) can cancel that
 * statement while another shared-db writer holds the needed lock. Retrying
 * only those SQLSTATEs prevents a transient contention dip from losing a
 * coordination message, while non-contention failures still surface at once.
 */

export interface PgContentionRetryOptions {
  /** Delay before each retry. The initial operation is attempt zero. */
  backoffsMs?: readonly number[];
  /** Injectable delay for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Short bounded delays: enough to ride out a brief shared-db lock race. */
export const PG_CONTENTION_BACKOFFS_MS = [100, 250, 500] as const;

/** PostgreSQL SQLSTATEs used for transient lock/statement timeout contention. */
export function isPgContentionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; pgCode?: string; name?: string };
  return (
    candidate.name === 'WorkspaceContendedError' ||
    candidate.code === '55P03' ||
    candidate.code === '57014' ||
    candidate.pgCode === '55P03' ||
    candidate.pgCode === '57014'
  );
}

/**
 * Run a retry-safe PostgreSQL write, retrying only transient contention.
 * `backoffsMs.length` is the maximum number of retries; an empty array means
 * one attempt with no retry.
 */
export async function withPgContentionRetry<T>(
  run: () => Promise<T>,
  options: PgContentionRetryOptions = {},
): Promise<T> {
  const backoffs = options.backoffsMs ?? PG_CONTENTION_BACKOFFS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isPgContentionError(error) || attempt >= backoffs.length) throw error;
      await sleep(backoffs[attempt]);
    }
  }
}
