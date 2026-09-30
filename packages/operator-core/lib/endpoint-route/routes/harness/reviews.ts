/**
 * Architect pending-review queue:
 *
 *   GET  /api/harness/:slug/reviews            — list pending reviews
 *   GET  /api/harness/:slug/reviews/:id        — one review (PG canonical)
 *   POST /api/harness/:slug/reviews/:id/resolve — answer + unblock the feature
 *
 * Reviews are PG-canonical via `harness_shared.pending_reviews` (written at
 * producer time — promote.ts on create, resolveReview on resolve). The
 * fs-watcher FS→PG mirror was retired (fs-watcher-retirement step 3); the
 * `.papercusp/pending-reviews/<id>.json` file is now only overwritten in
 * place on resolve so the architect chat can still read it for review context
 * (architect/prompts.ts) — nothing mirrors it back to PG.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 22).
 */
import { existsSync } from 'node:fs';
import { writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getOrgPg, harnessQuery } from '@papercusp/db-org';
import { resolvePhasedProject, harnessDir } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import type { ProjectEntry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

interface PendingReview {
  id: string;
  featureId: string;
  kind: string;
  question: string;
  recommendedAnswer?: string;
  tradeoff?: string;
  context?: string;
  ts: number;
  claim?: string;
  resolved?: boolean;
  userResponse?: string;
}

const reviewsDir = (p: ProjectEntry) => join(harnessDir(p), 'pending-reviews');

const listReviews = defineTool({
  method: 'GET',
  path: '/harness/:slug/reviews',
  auth: 'public',
  async handler(req, ctx) {
    const { listPendingReviews } = await import('../../../harness-readers');
    const result = await listPendingReviews(ctx.params.slug as string, phaseFromReq(req));
    return Response.json(result);
  },
});

const getReview = defineTool({
  method: 'GET',
  path: '/harness/:slug/reviews/:id',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const phase = phaseFromReq(req);
    const id = String(ctx.params.id).replace(/[^A-Za-z0-9_.-]/g, '');
    const { db } = getOrgPg();
    const { generated } = await import('@papercusp/db-org');
    const { and, eq } = await import('drizzle-orm');
    const prev = generated.pendingReviewsInHarnessShared;
    const rows = await db
      .select({ payload: prev.payload, review_id: prev.reviewId, resolved: prev.resolved, ts: prev.ts })
      .from(prev)
      .where(and(eq(prev.harnessSlug, slug), eq(prev.phase, phase), eq(prev.reviewId, id)))
      .limit(1);
    if (!rows.length) return Response.json({ error: 'not found' }, { status: 404 });
    const row = rows[0] as { payload: PendingReview; review_id: string; resolved: boolean; ts: number };
    return Response.json({ ...row.payload, id: row.review_id, resolved: row.resolved, ts: row.ts });
  },
});

const resolveReview = defineTool({
  method: 'POST',
  path: '/harness/:slug/reviews/:id/resolve',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const phase = phaseFromReq(req);
    const project = await resolvePhasedProject(slug, phase);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = String(ctx.params.id).replace(/[^A-Za-z0-9_.-]/g, '');
    const body = (await req.json()) as { response?: string; accept?: boolean };

    const { db } = getOrgPg();
    const { generated } = await import('@papercusp/db-org');
    const { and, eq } = await import('drizzle-orm');
    const prev = generated.pendingReviewsInHarnessShared;
    const rows = await db
      .select({ payload: prev.payload })
      .from(prev)
      .where(and(eq(prev.harnessSlug, slug), eq(prev.phase, phase), eq(prev.reviewId, id)))
      .limit(1);
    if (!rows.length) return Response.json({ error: 'not found' }, { status: 404 });
    const review: PendingReview = { ...(rows[0].payload as PendingReview) };
    review.resolved = true;
    review.userResponse = body.response ?? (body.accept ? review.recommendedAnswer : '');

    // Update PG immediately so GET /reviews + Zero reflect the resolution
    // before the watcher catches the FS move.
    await db
      .update(prev)
      .set({ resolved: true, payload: review as any })
      .where(and(eq(prev.harnessSlug, slug), eq(prev.phase, phase), eq(prev.reviewId, id)));

    // Append the response to supervisor-notes.md (PG canonical, FS mirror).
    const notesPath = join(harnessDir(project), 'supervisor-notes.md');
    const block = `\n## human ${new Date().toISOString()}\n\nReview ${review.id} resolved for ${review.featureId} (${review.kind}):\n\n> ${review.question}\n\nAnswer: ${review.userResponse || '(no text)'}\n`;
    const { appendTextArtifact } = await import('../../../text-artifacts');
    await appendTextArtifact(slug, 'supervisor-notes.md', block);
    try { await appendFile(notesPath, block, 'utf8'); } catch {}

    // Keep the FS copy in sync for the architect's review-context read
    // (architect/prompts.ts) — overwrite in place with resolved:true if the
    // file exists. PG is canonical; the fs-watcher mirror was retired (step 3),
    // so this no longer races a watcher deleteReview.
    const path = join(reviewsDir(project), `${id}.json`);
    if (existsSync(path)) {
      await writeFile(path, JSON.stringify(review, null, 2), 'utf8');
    }

    // Unblock the feature in PG so the orchestrator can pick it up again.
    if (review.featureId) {
      try {
        await harnessQuery(project.slug, (sql) => sql`
          UPDATE harness_features SET status = 'todo', updated_ts = ${Date.now()}
            WHERE harness_slug = ${project.slug} AND feature_id = ${review.featureId} AND status = 'blocked'
        `);
      } catch {}
    }

    return Response.json({ ok: true, review });
  },
});

export default [listReviews, getReview, resolveReview];
