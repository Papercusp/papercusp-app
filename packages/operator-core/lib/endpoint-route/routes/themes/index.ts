/**
 * /api/themes/* — user-authored custom color themes, persisted to a per-workspace
 * local file (see lib/custom-themes.ts; D-1 of the theme plan).
 *
 *   GET    /api/themes            → { themes: CustomTheme[] }
 *   PUT    /api/themes/:id        body { theme: CustomTheme } → 200 CustomTheme | 400
 *   DELETE /api/themes/:id        → 204
 *
 * `auth: 'public'` — matches /api/dock-layouts; these are local presentation
 * artifacts on a loopback-bound operator. The token-contract + CSS-value safety
 * are enforced in validateCustomTheme (lib/theme-tokens.ts), shared with the
 * client, so a hand-edited file or a crafted body can't inject CSS.
 */
import { defineTool } from '@papercusp/agent-mcp';
import {
  listCustomThemes,
  listThemeCatalog,
  saveCustomTheme,
  deleteCustomTheme,
  CustomThemeValidationError,
} from '../../../custom-themes';
import { removeInstalledTheme } from '../../../cupboard/install-theme-io';
import { notifyThemeCatalogChanged } from '../../../cupboard/theme-catalog-sync';

const list = defineTool({
  method: 'GET',
  path: '/themes',
  auth: 'public',
  async handler() {
    return Response.json({ themes: await listThemeCatalog() });
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/themes/:id',
  auth: 'loopback',
  async handler(req, ctx) {
    let body: { theme?: unknown };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    if (!body?.theme || typeof body.theme !== 'object') {
      return Response.json({ error: 'missing { theme }' }, { status: 400 });
    }
    // The path id is authoritative — the saved theme's slug derives from its own
    // id/label in validateCustomTheme, so ignore mismatches rather than trust the
    // body blindly; the client always PUTs to /themes/<theme.id>.
    const incoming = { ...(body.theme as Record<string, unknown>), id: ctx.params.id };
    try {
      const saved = await saveCustomTheme(incoming);
      await notifyThemeCatalogChanged().catch(() => {});
      return Response.json(saved);
    } catch (err) {
      if (err instanceof CustomThemeValidationError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/themes/:id',
  auth: 'loopback',
  async handler(_req, ctx) {
    if (ctx.params.id.startsWith('installed:')) {
      const removed = await removeInstalledTheme(ctx.params.id);
      if (!removed.ok) return Response.json({ error: removed.error }, { status: removed.status });
    } else {
      await deleteCustomTheme(ctx.params.id);
    }
    await notifyThemeCatalogChanged().catch(() => {});
    return new Response(null, { status: 204 });
  },
});

export default [list, put, del];
