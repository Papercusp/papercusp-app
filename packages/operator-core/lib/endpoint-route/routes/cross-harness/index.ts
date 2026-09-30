/**
 * Cross-harness coordination routes — Phase A1
 * (endpoint-hono-elimination-2026-05-21). Ported off the legacy
 * `_hono/cross-harness.ts` Hono sub-app (mounted via `registerCrossHarness`).
 *
 *   GET  /api/harness/:slug/supervisor-notes
 *   GET  /api/harness/all/recent-activity
 *
 * All `auth: 'public'` — the legacy sub-app gated none of these (reads
 * are operator-local dashboard polls). Posture preserved verbatim. The
 * `getSpawnableTemplates` helper that lived in the legacy file moved to
 * `lib/spawnable-templates.ts`.
 *
 * (The inbox/outbox reads and the `POST /api/harness/:slug/messages`
 * send_message wrapper — the work-item mail surface — were retired; see
 * retire-work-item-mail-surface-2026-07-26. `readRecentActivity` /
 * supervisor-notes are unrelated and stay live.)
 */
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { readRecentActivity } from '../../../cross-harness-data';

/* eslint-disable @typescript-eslint/no-explicit-any */

function slugToSchema(slug: string): string {
  return 'harness_' + slug.replace(/-/g, '_').toLowerCase();
}

function clampLimit(raw: string | null | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

const supervisorNotes = defineTool({
  method: 'GET',
  path: '/harness/:slug/supervisor-notes',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug;
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 10, 100);
    const schema = slugToSchema(slug);
    try {
      const { sql } = getOrgPg();
      const rows = await sql.unsafe(
        `SELECT id, body, source, created_at
         FROM ${schema}.supervisor_notes
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit],
      );
      return Response.json({ slug, notes: rows });
    } catch (e: any) {
      // scaffoldHarnessSchema is best-effort at join time (join-link.ts) — a
      // harness can be legitimately "usable without schema" (comment there),
      // so an undefined-table/relation error here means "no schema yet", not
      // a real failure. Degrade to an empty list instead of a 500.
      if (e?.code === '42P01' || /relation .* does not exist/i.test(String(e?.message))) {
        return Response.json({ slug, notes: [] });
      }
      return Response.json({ error: 'failed', detail: String(e?.message).slice(0, 300) }, { status: 500 });
    }
  },
});

const recentActivity = defineTool({
  method: 'GET',
  path: '/harness/all/recent-activity',
  auth: 'public',
  async handler(req) {
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 20, 200);
    try {
      return Response.json({ events: await readRecentActivity(limit) });
    } catch (e: unknown) {
      return Response.json(
        { error: 'failed', detail: String((e as Error)?.message).slice(0, 300) },
        { status: 500 },
      );
    }
  },
});

export default [supervisorNotes, recentActivity];

// Note: the `getSpawnableTemplates` helper that the legacy file also
// exported now lives in `lib/spawnable-templates.ts`; `/marketplace/spawnable`
// (routes/marketplace/spawnable.ts) imports it from there.
