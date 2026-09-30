/**
 * GET /api/harness/:slug/log/history — paginated read into older log
 * history.
 *
 * Reads `run.log.jsonl` plus its rotated `.N.gz` peers, returns the
 * chunk of `limit` events ending at the given `before` timestamp (or
 * the latest in current when omitted). Powers the LogView's
 * "load more" button.
 *
 * Query: ?before=<ISO ts>&limit=N (default 500, capped at 5000).
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 39).
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolvePhasedProject, harnessDir } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/log/history',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const before = url.searchParams.get('before') || null;
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') ?? '500', 10) || 500, 1),
      5000,
    );
    const logsDir = join(harnessDir(project), 'logs');

    const events: Array<{ ts: string; raw: string }> = [];

    const sources: Array<{ path: string; gz: boolean }> = [];
    if (existsSync(join(logsDir, 'run.log.jsonl'))) {
      sources.push({ path: join(logsDir, 'run.log.jsonl'), gz: false });
    }
    for (let i = 1; i <= 20; i++) {
      const p = join(logsDir, `run.log.jsonl.${i}.gz`);
      if (existsSync(p)) sources.push({ path: p, gz: true });
    }

    for (const src of sources) {
      let content: string;
      try {
        const buf = readFileSync(src.path);
        content = src.gz ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const m = line.match(/"ts":"([^"]+)"/);
        if (!m) continue;
        events.push({ ts: m[1], raw: line });
      }
    }
    events.sort((a, b) => b.ts.localeCompare(a.ts));

    const filtered = before ? events.filter((e) => e.ts < before) : events;
    const slice = filtered.slice(0, limit).reverse();

    const parsed: unknown[] = [];
    for (const e of slice) {
      try { parsed.push(JSON.parse(e.raw)); } catch { /* skip malformed */ }
    }

    return Response.json({
      events: parsed,
      hasMore: filtered.length > limit,
      oldest:
        parsed[0] && typeof (parsed[0] as { ts?: string }).ts === 'string'
          ? (parsed[0] as { ts: string }).ts
          : null,
    });
  },
});
