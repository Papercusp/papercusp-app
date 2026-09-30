/**
 * Merged per-harness docs endpoint (P-007) — supersedes the FS-only project-docs
 * read. One GET returns the unified docs tree (generated · manual · augmented) with
 * source + freshness status + the active doc's body + augmented overlay; the POST
 * actions drive the close-the-loop verbs the docs tab + pui surface:
 *   GET  /api/harness/:slug/docs[?path=<docId>&recompute=1]
 *   POST /api/harness/:slug/docs/verify     { docId }
 *   POST /api/harness/:slug/docs/regenerate { docId }
 *   POST /api/harness/:slug/docs/overlay    { docId, overlay }   ('' clears)
 *   POST /api/harness/:slug/docs/anchor     { docId, documents?, verify? }
 *
 * Auth: 'public' — loopback gate, same trust boundary as the sibling harness routes.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { buildMergedDocs } from '../../../harness/docs/merged-read';
import { anchorManualDoc, verifyManualDoc } from '../../../harness/docs/manual-anchor';
import { requestRegeneration } from '../../../harness/docs/regenerate';
import { getDocRecord, setDocOverlay, upsertDocRecord } from '../../../harness/docs/doc-record';

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return ((await req.json()) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

const getDocs = defineTool({
  method: 'GET',
  path: '/harness/:slug/docs',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const path = url.searchParams.get('path')?.trim() || undefined;
    const recompute = url.searchParams.get('recompute') === '1';
    const merged = await buildMergedDocs(slug, {
      ...(path ? { activePath: path } : {}),
      ...(recompute ? { recomputeActive: true } : {}),
    });
    return Response.json(merged);
  },
});

const verifyDocRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/docs/verify',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const body = await readJson(req);
    const docId = String(body.docId ?? '').trim();
    if (!docId) return Response.json({ ok: false, error: 'docId required' }, { status: 400 });
    const res = await verifyManualDoc(slug, docId);
    return Response.json(res, { status: res.ok ? 200 : 400 });
  },
});

const regenerateDocRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/docs/regenerate',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const body = await readJson(req);
    const docId = String(body.docId ?? '').trim();
    if (!docId) return Response.json({ ok: false, error: 'docId required' }, { status: 400 });
    const res = await requestRegeneration(slug, docId);
    return Response.json(res, { status: res.ok ? 200 : 400 });
  },
});

const overlayDocRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/docs/overlay',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const body = await readJson(req);
    const docId = String(body.docId ?? '').trim();
    if (!docId) return Response.json({ ok: false, error: 'docId required' }, { status: 400 });
    const raw = typeof body.overlay === 'string' ? body.overlay : '';
    const overlay = raw.trim() === '' ? null : raw;
    const existing = await getDocRecord(slug, docId);
    if (!existing) {
      await upsertDocRecord({ harnessSlug: slug, docId, source: 'manual', subjectRef: [], anchorPaths: [], status: 'untracked' });
    }
    await setDocOverlay(slug, docId, overlay);
    const updated = await getDocRecord(slug, docId);
    return Response.json({ ok: true, docId, source: updated?.source, hasOverlay: !!(updated?.overlay && updated.overlay.trim()) });
  },
});

const anchorDocRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/docs/anchor',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const body = await readJson(req);
    const docId = String(body.docId ?? '').trim();
    if (!docId) return Response.json({ ok: false, error: 'docId required' }, { status: 400 });
    const res = await anchorManualDoc({
      harnessSlug: slug,
      docId,
      ...(body.documents !== undefined ? { documents: body.documents } : {}),
      ...(typeof body.verify === 'boolean' ? { verify: body.verify } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
    });
    return Response.json(res, { status: res.ok ? 200 : 400 });
  },
});

export default [getDocs, verifyDocRoute, regenerateDocRoute, overlayDocRoute, anchorDocRoute];
