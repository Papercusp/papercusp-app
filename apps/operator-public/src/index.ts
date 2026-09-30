/**
 * Cupboard server entrypoint (Cloudflare Worker).
 *
 * Mounted at cupboard.papercusp.dev (per v5 §10 / addendum 1).
 * D1 + KV bindings declared in wrangler.toml; secrets installed via
 * `wrangler secret put GITHUB_CLIENT_ID` etc.
 */

import type { Env } from './env.ts';
import { buildApi } from './routes/index.ts';
import { indexBatch } from './indexer.ts';

const api = buildApi();

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return api.fetch(req, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // P-076 — hourly stats indexer refreshes tier-A fields on each
    // listed harness from the GitHub API. Capped batch per tick;
    // early-exits on rate-limit. Best-effort; failures audited.
    ctx.waitUntil(indexBatch(env).then(() => undefined).catch(() => undefined));
  },
};
