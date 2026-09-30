/**
 * Papercusp API entrypoint. Mounts the framework's Hono routers:
 *   /api/harness/*  — harness CRUD (project picker, features, audit, proposals…)
 *   /api/plugins/*  — installed-plugin metadata
 *
 * Plus the static credentials/profile/auth/marketplace routes which live as
 * regular Next.js route handlers in app/api/{credentials,profile,auth,marketplace,installed}/.
 */
import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { harness } from '../_hono/harness';
import { plugins } from '../_hono/plugins';
import { registerPty } from '../_hono/pty';
import { registerOperatorNotes } from '../_hono/operator-notes';
import { registerAgentChats } from '../_hono/agent-chats';
import { registerProjects } from '../_hono/projects';
import { mountPluginApiRoutes } from '../../../lib/plugin-api-mount';

export const dynamic = 'force-dynamic';

const app = new Hono().basePath('/api');

// CORS — preview origins (admin tooling). Tightens on production.
const adminPreviewCors = async (c: any, next: any) => {
  const origin = c.req.header('origin');
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'content-type, x-actor');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
};

app.use('/harness/*', adminPreviewCors);
app.use('/plugins/*', adminPreviewCors);

registerPty(harness);
registerOperatorNotes(harness);
registerAgentChats(harness);
registerProjects(harness);
app.route('/harness', harness);
app.route('/plugins', plugins);

// Phase 6b item 2 — discover + mount plugin apiRoutes at /api/plugins/<name>.
// Fire-and-forget; the mount happens once at module init. Idempotent.
//
// KNOWN LIMITATION: Next.js's runtime cannot dynamic-import `.ts` plugin
// files (works under tsx but not Next's bundler). Plugins must ship a
// pre-compiled `.js` entry point to be mounted in-process. The mount
// surface itself is verified end-to-end via the standalone smoke test
// in lib/plugin-api-mount.smoke.ts.
mountPluginApiRoutes(app)
  .then((r) => {
    if (r.mounted > 0) {
      // eslint-disable-next-line no-console
      console.log(`[plugin-mount] ${r.mounted} plugin apiRoutes mounted`);
    }
    if (r.errors.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[plugin-mount] ${r.errors.length} discovery errors (see lib/plugin-api-mount.ts)`);
    }
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.warn('[plugin-mount] unexpected rejection:', e);
  });

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);
