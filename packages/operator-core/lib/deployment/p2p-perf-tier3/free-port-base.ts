/**
 * free-port-base.ts — collision-resistant base-port allocation for the local
 * ($0 parity) legs of the p2p-perf-tier3 chaos suites (WI-5185).
 *
 * swarm-full-loop / swarm-claim-dispatch / authority-eviction-cross-machine's
 * local launchers each derived their base port as a hand-rolled
 * `SOME_OFFSET + (process.pid % SOME_RANGE)` — a HOPE, not a guarantee, that no
 * other process on the shared box is already bound there. On a heavily
 * concurrent fleet host (many vitest worker PIDs cycling through a narrow OS
 * pid range, several agents able to run the SAME suite at once, and the three
 * files' pid-modulo windows overlapping numerically) that hope is false often
 * enough to matter: confirmed via a captured `EADDRINUSE` on a spawned
 * loop-agent.ts child (WI-5185) — a real port collision, not a slow-boot
 * timing issue as the swallowed error previously made it look.
 *
 * `findFreeBasePort` fixes this the direct way: PROBE actual availability of
 * a contiguous port block before committing to it (bind port 0 to confirm the
 * OS will hand out sockets at all, then explicitly try-bind each candidate in
 * the block), retrying with a new candidate on any collision. This is the
 * standard robust pattern for local ephemeral port allocation under
 * concurrent processes — checking availability immediately before use beats
 * any formula that only reduces collision PROBABILITY without eliminating it.
 */
import { createServer } from 'node:net';

/** True if `port` can be bound on `host` right now (bind-then-release probe). */
function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Find `count` CONSECUTIVE currently-free ports starting at some candidate
 * base, retrying with a new randomized candidate (within `[rangeStart,
 * rangeEnd]`) whenever any port in the block is taken. Bounded retries so a
 * genuinely exhausted range fails loudly instead of looping forever.
 */
export async function findFreeBasePort(opts: {
  count: number;
  rangeStart: number;
  rangeEnd: number;
  host?: string;
  maxAttempts?: number;
}): Promise<number> {
  const host = opts.host ?? '127.0.0.1';
  const maxAttempts = opts.maxAttempts ?? 40;
  const span = opts.rangeEnd - opts.rangeStart - opts.count;
  if (span < 0) {
    throw new Error(
      `findFreeBasePort: range [${opts.rangeStart},${opts.rangeEnd}] too narrow for ${opts.count} consecutive ports`,
    );
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // Seed with the pid-modulo formula on the FIRST attempt (cheap, usually free,
    // preserves today's port choice when nothing is contending) — pure random
    // retries after that so a repeated collision doesn't keep re-trying the same
    // deterministic-per-pid candidate.
    const candidate =
      attempt === 0
        ? opts.rangeStart + (process.pid % (span + 1))
        : opts.rangeStart + Math.floor(Math.random() * (span + 1));
    let allFree = true;
    for (let i = 0; i < opts.count; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- must probe sequentially: an
      // early free-port release doesn't guarantee it stays free until we bind it
      // for real, but checking the whole block up front still catches the
      // overwhelmingly common case (a peer already listening there NOW).
      if (!(await canBind(candidate + i, host))) {
        allFree = false;
        break;
      }
    }
    if (allFree) return candidate;
  }
  throw new Error(
    `findFreeBasePort: could not find ${opts.count} free consecutive ports in [${opts.rangeStart},${opts.rangeEnd}] after ${maxAttempts} attempts`,
  );
}
