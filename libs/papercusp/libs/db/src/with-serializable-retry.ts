/**
 * withSerializableRetry — run a transaction at SERIALIZABLE with automatic
 * retry on serialization failure (plan locks-correctness-hardening-2026-06-04,
 * D-002).
 *
 * We run READ COMMITTED by default, which is unguarded against *write skew*:
 * a `read-set → decide → write` path where two transactions each read an
 * overlapping set, each decide independently, and each write disjointly — the
 * two writes individually satisfy the invariant but together violate it (the
 * textbook example: "this is the last open feature → mark the plan complete",
 * run twice concurrently). PostgreSQL's SERIALIZABLE (SSI) detects exactly
 * these dangerous read/write dependency cycles and aborts one offender with
 * SQLSTATE 40001 (`serialization_failure`). The contract is "retry on 40001",
 * which this wrapper makes safe + automatic.
 *
 * For HOT single-row invariants prefer materializing the invariant onto one
 * row and taking `SELECT … FOR UPDATE` on it (cheaper, no abort/retry) — see
 * `withProjectBudget` in budget-enforcement.ts. Reach for SERIALIZABLE when the
 * invariant spans multiple rows that can't be collapsed to one lock target.
 *
 * The wrapped fn MUST be idempotent / free of un-rolled-back side effects: it
 * can run more than once. Keep all writes inside the passed `tx`; do not send
 * email / enqueue / mutate process state from inside it.
 *
 * ([PG SSI](https://wiki.postgresql.org/wiki/SSI))
 */

import type { Sql } from 'postgres';

/** serialization_failure — SSI aborted us to preserve serializability. */
const SERIALIZATION_FAILURE = '40001';
/** deadlock_detected — also transient + safe to retry (a lock-order cycle). */
const DEADLOCK_DETECTED = '40P01';

export interface SerializableRetryOptions {
  /** Max RETRIES after the first attempt. Default 5 (→ up to 6 total tries). */
  maxRetries?: number;
  /** Base backoff in ms; grows exponentially with full jitter. Default 10. */
  baseDelayMs?: number;
  /**
   * Upper bound on any ONE backoff sleep's jitter ceiling (ms). Default: uncapped.
   * Lets a caller raise `maxRetries` for a high-contention class without the
   * exponential ceiling growing into multi-second sleeps.
   */
  maxDelayMs?: number;
  /** Observability hook fired before each retry sleep (attempt is 1-based). */
  onRetry?: (info: { attempt: number; code: string }) => void;
  /** Injectable sleeper (tests pass a no-op to avoid real timers). */
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown when retries are exhausted and the txn still can't serialize. */
export class SerializableRetryExhaustedError extends Error {
  readonly pgCode: string;
  readonly attempts: number;
  constructor(attempts: number, pgCode: string, cause: unknown) {
    super(`serializable transaction failed to commit after ${attempts} attempts (pg ${pgCode})`);
    this.name = 'SerializableRetryExhaustedError';
    this.pgCode = pgCode;
    this.attempts = attempts;
    this.cause = cause;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(code: string | undefined): boolean {
  return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
}

/**
 * Run `fn` inside a SERIALIZABLE transaction, retrying on 40001 / 40P01 with
 * exponential backoff + full jitter. Non-serialization errors propagate
 * immediately (no retry). Returns whatever `fn` returns.
 */
export async function withSerializableRetry<T>(
  sql: Sql,
  fn: (tx: Sql) => Promise<T>,
  opts: SerializableRetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 10;
  const sleep = opts.sleep ?? defaultSleep;
  const rand = () => Math.random();

  let lastErr: unknown;
  let lastCode = '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as Sql;
        // Must be the FIRST statement in the txn — before any snapshot is taken.
        await tx`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;
        return fn(tx);
      });
      return result as T;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (!isRetryable(code)) throw err;
      lastErr = err;
      lastCode = code as string;
      if (attempt >= maxRetries) break;
      opts.onRetry?.({ attempt: attempt + 1, code: lastCode });
      // Exponential backoff with full jitter: random in [0, base * 2^attempt].
      const ceil = Math.min(baseDelayMs * 2 ** attempt, opts.maxDelayMs ?? Number.POSITIVE_INFINITY);
      await sleep(Math.floor(rand() * ceil));
    }
  }
  throw new SerializableRetryExhaustedError(maxRetries + 1, lastCode, lastErr);
}
