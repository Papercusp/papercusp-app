/**
 * The PUBLIC user manual, not the authenticated engineering corpus.
 * Built by apps/papercusp-docs and mirrored into public/docs.
 */
import { Hono } from 'hono';
import { resolve } from 'node:path';
import { servePublicDocs } from '@papercusp/operator-core/lib/public-docs';

const root = process.env.PAPERCUSP_PUBLIC_DOCS_ROOT
  ? resolve(process.env.PAPERCUSP_PUBLIC_DOCS_ROOT)
  : resolve(__dirname, '..', 'public', 'docs');

export const publicDocsRoutes = new Hono();
publicDocsRoutes.all('/docs', (c) => servePublicDocs(c.req.raw, root));
publicDocsRoutes.all('/docs/*', (c) => servePublicDocs(c.req.raw, root));
