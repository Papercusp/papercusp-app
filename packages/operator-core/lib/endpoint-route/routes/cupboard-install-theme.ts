import { defineTool } from '@papercusp/agent-mcp';
import { installThemeFromCupboard } from '../../cupboard/install-theme-io';
import { notifyThemeCatalogChanged } from '../../cupboard/theme-catalog-sync';

export default defineTool({
  method: 'POST',
  path: '/cupboard/install-theme',
  auth: 'loopback',
  timeoutSec: 120,
  async handler(req) {
    let body: { listingId?: string; githubUrl?: string; listingRef?: string; update?: boolean };
    try { body = await req.json(); }
    catch { return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }
    const result = await installThemeFromCupboard({
      ...(body.listingId ? { listingId: body.listingId } : {}),
      ...(body.githubUrl ? { githubUrl: body.githubUrl } : {}),
      ...(body.listingRef ? { listingRef: body.listingRef } : {}),
      ...(body.update === true ? { update: true } : {}),
    });
    if (!result.ok) return Response.json({ ok: false, error: result.error, detail: result.detail }, { status: result.status });
    await notifyThemeCatalogChanged().catch(() => {});
    return Response.json({ ...result.result, activeThemeId: `custom:${result.result.id}` });
  },
});
