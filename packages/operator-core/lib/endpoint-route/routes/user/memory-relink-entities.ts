/**
 * POST /api/user/memory/relink-entities
 *
 * Entity re-link backfill (EI-10218): re-extract CLEAN COMPOUND entities for
 * every memory still linked from a junk (regex-fallback) COMPOUND entity, so
 * the existing corpus gets the EI-10183 fix that otherwise only helps NEW
 * writes. Delta-driven + re-run-safe; `maxMemories` caps a single call so a
 * large corpus can't blow the request timeout (call again to continue).
 *
 * SAFETY: this MUTATES live memory data — it DELETES junk entity rows and
 * re-links memories. Unlike the idempotent re-embed, that is not reversible, so
 * `dryRun` DEFAULTS TO true: an accidental / body-less POST only REPORTS what
 * would change (`junkDeleted` = how many rows a real run would remove). The
 * owner must explicitly send `{ "dryRun": false }` to actually run the backfill.
 *
 * Mirrors `/user/memory/reembed`: `auth: 'loopback'` (auth-tier Wave 1),
 * `timeoutSec: 600`. Kill-switch: PAPERCUSP_MEMORY_ENTITY_RELINK=off → 409.
 */
import { getSessionUserOrDefault } from '../../../auth';
import { relinkEntities } from '../../../memory/relink-entities';
import { defineTool } from '@papercusp/agent-mcp';

// The library caps a call at 1000 by default; bound an explicit override so a
// single request stays inside the 600s budget.
const MAX_MEMORIES_CAP = 5000;

export default defineTool({
  method: 'POST',
  path: '/user/memory/relink-entities',
  auth: 'loopback',
  timeoutSec: 600,
  async handler(req) {
    // Session is optional (single-user default fallback); the `loopback` auth
    // tier is the real gate. The backfill is not per-user.
    await getSessionUserOrDefault(req.headers);

    let body: { dryRun?: unknown; maxMemories?: unknown; userId?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      // An empty/invalid body is a SAFE report-only dry-run, not an error.
      body = {};
    }

    // Default dryRun TRUE (safety): only an explicit `false` mutates live data.
    const dryRun = body.dryRun !== false;

    let maxMemories: number | undefined;
    if (body.maxMemories !== undefined) {
      const n = Number(body.maxMemories);
      if (!Number.isInteger(n) || n <= 0) {
        return Response.json({ error: 'invalid_maxMemories' }, { status: 400 });
      }
      maxMemories = Math.min(n, MAX_MEMORIES_CAP);
    }

    let userId: string | undefined;
    if (body.userId !== undefined) {
      if (typeof body.userId !== 'string' || body.userId.length === 0) {
        return Response.json({ error: 'invalid_userId' }, { status: 400 });
      }
      userId = body.userId;
    }

    try {
      const result = await relinkEntities({ dryRun, maxMemories, userId });
      return Response.json({ ok: true, ...result });
    } catch (err) {
      const message = (err as Error).message;
      // Kill-switch (PAPERCUSP_MEMORY_ENTITY_RELINK=off) → relink_disabled.
      const status = message === 'relink_disabled' ? 409 : 500;
      return Response.json({ error: 'relink_failed', message }, { status });
    }
  },
});
