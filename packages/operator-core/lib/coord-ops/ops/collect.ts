/**
 * `coord:collect` (NEW — D-004) — a push-driven barrier: watch a thread and
 * resolve when `posts ≥ quorum OR elapsed > timeout`. The genuinely-new bit is
 * the *barrier* logic; the substrate (the thread + its posts) is shipped. The
 * vote/deliberate `collect` step blocks here until enough voters have posted, so
 * the program proceeds on quorum without waiting for every (possibly-failed)
 * voter.
 *
 * Implementation: a bounded poll over `caps.listPosts` (default 2s interval).
 * "Push, no poll" (subscribe→inject / `pg_notify` wake) is the future
 * optimisation — the poll is the robust floor and, crucially, makes the whole
 * collect ONE durable DBOS step (a crash re-runs it, re-reading the current
 * posts; the votes already persisted so it resumes where it left off — D-003 /
 * D-005). The iteration budget (`timeout_s / poll_ms`) bounds it deterministically
 * without a wall-clock, which keeps the timeout path unit-testable with an instant
 * `caps.sleep`.
 *
 * NOTE on the spawn model: the `spawn-roles` step awaits its agents, so by the
 * time `collect` runs the posts are usually already present and it resolves on
 * the first poll. The barrier still earns its keep for partial-failure (proceed
 * on quorum < max_voters) and the future fire-and-forget spawn path.
 */
import { z } from 'zod';
import type { CoordOp } from '../types.js';
import { registerCoordOp } from '../registry.js';

const collectedPost = z.object({
  id: z.number(),
  author_id: z.string().nullable(),
  body: z.string(),
  created_ts: z.string(),
});

const args = z.object({
  conversation_id: z.string().min(1),
  /** Resolve once at least this many posts exist. */
  quorum: z.number().int().positive().default(3),
  /** Resolve (timeout) after this many seconds even if quorum is not met. */
  timeout_s: z.number().positive().default(300),
  /** Poll interval in ms (default 2s; tests pass a small value + instant sleep). */
  poll_ms: z.number().int().positive().default(2000),
});

const result = z.object({
  posts: z.array(collectedPost),
  count: z.number().int(),
  reason: z.enum(['quorum', 'timeout']),
});

/** Safety ceiling so a pathological (tiny poll / huge timeout) config can't spin forever. */
const MAX_POLLS = 100_000;

export const collectOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'coord:collect',
  description: 'Wait until a thread reaches quorum posts (or a timeout) — the vote barrier.',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const maxPolls = Math.min(MAX_POLLS, Math.max(1, Math.ceil((a.timeout_s * 1000) / a.poll_ms)));
    let posts = await ctx.caps.listPosts(a.conversation_id);
    for (let poll = 0; poll < maxPolls; poll++) {
      if (posts.length >= a.quorum) {
        return { posts, count: posts.length, reason: 'quorum' };
      }
      await ctx.caps.sleep(a.poll_ms);
      posts = await ctx.caps.listPosts(a.conversation_id);
    }
    // Final read already done by the loop's last iteration; quorum may have been
    // hit exactly at the budget edge.
    if (posts.length >= a.quorum) return { posts, count: posts.length, reason: 'quorum' };
    return { posts, count: posts.length, reason: 'timeout' };
  },
};

registerCoordOp(collectOp);
