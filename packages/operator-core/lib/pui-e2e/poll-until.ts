/**
 * Deadline polling for the PTY e2e fixtures that stays correct when the
 * OBSERVER itself is blocked (WI-10003175).
 *
 * These fixtures observe on the vitest worker's one event loop: node-pty
 * reads, the fake HTTP servers, and (in agent-chat-pty) the in-process
 * operator all share it. When that loop is blocked for seconds, `pui` keeps
 * drawing into the kernel PTY buffer and requests keep arriving on sockets,
 * but none of it is read until the loop runs again. The loop every fixture
 * used to hand-roll —
 *
 *     while (Date.now() < deadline) { if (check()) return; await sleep(60); }
 *     throw new Error('timed out …');
 *
 * — wakes from such a block already past its deadline and throws WITHOUT
 * reading what arrived, so it reports "not on screen" for output that was
 * sitting in the buffer, and its message blames the product for time the
 * test process could not run at all.
 *
 * `pollUntil` owns that shape once:
 *  - every sleep is followed by one I/O turn (`setImmediate` runs after
 *    libuv's poll phase, where socket and PTY reads are delivered), so each
 *    check sees everything that had already been written;
 *  - the check always runs once more after the deadline has passed;
 *  - it measures how late each sleep woke, so a timeout can SAY the observer
 *    was blocked instead of reading as a product failure.
 */

export interface PollOutcome {
  ok: boolean;
  /**
   * The largest amount by which one sleep overshot its interval: a lower
   * bound on the longest time the observer's event loop was blocked.
   */
  maxLateMs: number;
}

export interface PollOptions {
  timeoutMs: number;
  /** Sleep between checks. Default 60ms. */
  intervalMs?: number;
  /** Runs after each failed check, before the sleep. */
  onMiss?: () => void;
}

export async function pollUntil(
  check: () => boolean | Promise<boolean>,
  opts: PollOptions,
): Promise<PollOutcome> {
  const intervalMs = opts.intervalMs ?? 60;
  const deadline = Date.now() + opts.timeoutMs;
  let maxLateMs = 0;
  for (;;) {
    // Read the clock BEFORE the check, and give up only on a check that began
    // after the deadline had already passed. A check that itself outlasts the
    // deadline (a block inside it, a slow query) therefore gets one more look,
    // and the final check always follows the final I/O turn, so bytes that
    // arrived during a block are read before the verdict.
    const expired = Date.now() >= deadline;
    if (await check()) return { ok: true, maxLateMs };
    if (expired) return { ok: false, maxLateMs };
    opts.onMiss?.();
    const due = Date.now() + intervalMs;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    maxLateMs = Math.max(maxLateMs, Date.now() - due);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A sleep this late means the observer was blocked, not merely busy. */
export const OBSERVER_BLOCK_REPORT_MS = 1_000;

/**
 * Suffix for a timeout message: names an observer block when one happened
 * during the wait, and is empty otherwise.
 */
export function describeObserverBlock(maxLateMs: number): string {
  return maxLateMs >= OBSERVER_BLOCK_REPORT_MS
    ? ` [the test worker's event loop was blocked for up to ${maxLateMs}ms during this wait: `
      + 'it could not read PTY output or answer in-process requests meanwhile, so suspect a '
      + 'synchronous call in the test worker before the product]'
    : '';
}
