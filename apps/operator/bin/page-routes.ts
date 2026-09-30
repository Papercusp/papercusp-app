/**
 * Page-namespace route handlers — ported from Next `route.ts` files that live
 * at *page* paths (not `/api/*`), so they aren't part of the `_hono/app.ts`
 * API surface. The Hono host ([hono-host.ts]) mounts these alongside `app`.
 *
 *   GET /wiki              — ../app/wiki/route.ts
 *   GET /drizzle-studio    — ../app/drizzle-studio/route.ts
 *   GET /drizzle-studio/*  — was a next.config.js rewrite to the CDN
 *
 * Lives in `apps/operator/bin/` (not operator-vite) so it runs in the
 * operator's module-resolution context — the operator code is CJS and uses
 * the `@/` path alias; importing it from operator-vite's `type: module`
 * package hits an ESM/CJS named-export boundary. See
 * apps/operator/docs/plans/operator-vite-migration-2026-05-20.md (Phase C).
 */
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessRegistry } from '@papercusp/operator-core/lib/harness-registry';

export const pageRoutes = new Hono();

// ---- /wiki -----------------------------------------------------------------

const SEARCH_DIRS = ['.papercusp', '', '.claude/skills'] as const;

// Maps known SpecEditor tab ids to the on-disk filenames they edit.
const TAB_BY_FILENAME: Record<string, string> = {
  'SPEC.md': 'spec',
  'AGENTS.md': 'agents',
  'validation-contract.md': 'contract',
  'supervisor-notes.md': 'supervisor',
  'knowledge.md': 'knowledge',
};

function findInProject(
  projectPath: string,
  target: string,
): { dir: string; filename: string } | null {
  const filename = target.endsWith('.md') ? target : `${target}.md`;
  for (const dir of SEARCH_DIRS) {
    const candidate = dir
      ? join(projectPath, dir, filename)
      : join(projectPath, filename);
    if (existsSync(candidate)) return { dir, filename };
  }
  return null;
}

/**
 * Resolves Obsidian-style `[[wiki-link]]` targets to a harness destination.
 * Found → 302 to `/harness/<slug>?panel=config&specTab=<tab>`.
 * Missing → 302 to `/wiki/missing?...`.
 */
pageRoutes.get('/wiki', async (c) => {
  const target = (c.req.query('target') ?? '').trim();
  const harnessHint = c.req.query('harness')?.trim() || null;

  if (!target) return c.json({ error: 'missing target' }, 400);

  const reg = await loadHarnessRegistry();
  const projects = reg.projects ?? [];

  const ordered = harnessHint
    ? [
        ...projects.filter((p) => p.slug === harnessHint),
        ...projects.filter((p) => p.slug !== harnessHint),
      ]
    : projects;

  const matches: Array<{ slug: string; filename: string; tab: string | null }> = [];
  for (const p of ordered) {
    const hit = findInProject(p.path, target);
    if (!hit) continue;
    matches.push({ slug: p.slug, filename: hit.filename, tab: TAB_BY_FILENAME[hit.filename] ?? null });
    if (harnessHint && p.slug === harnessHint) break;
  }

  if (matches.length === 0) {
    const params = new URLSearchParams({ target });
    if (harnessHint) params.set('harness', harnessHint);
    return c.redirect(`/wiki/missing?${params.toString()}`);
  }

  // First match wins (registry order, harness-hint preferred).
  const best = matches[0];
  const params = new URLSearchParams({ panel: 'config' });
  if (best.tab) params.set('specTab', best.tab);
  if (matches.length > 1) {
    params.set('wikiAlts', matches.slice(1).map((m) => m.slug).join(','));
  }
  return c.redirect(`/harness/${encodeURIComponent(best.slug)}?${params.toString()}`);
});

// ---- /drizzle-studio -------------------------------------------------------

const DRIZZLE_CDN = 'https://local.drizzle.studio';

/**
 * Fetches the Drizzle Studio SPA HTML and injects `<base href="/drizzle-studio/">`
 * so its relative asset URLs resolve under our origin. Serving the SPA
 * same-origin keeps its localhost gateway fetches out of Chrome's
 * Private-Network-Access block.
 */
pageRoutes.get('/drizzle-studio', async (c) => {
  let html: string;
  try {
    const res = await fetch(`${DRIZZLE_CDN}/`);
    html = await res.text();
  } catch {
    return c.html(
      '<!doctype html><html><body style="font-family:monospace;padding:2rem">' +
        '<h2>Could not fetch Drizzle Studio SPA</h2>' +
        '<p>Check network connectivity to <code>local.drizzle.studio</code>.</p>' +
        '</body></html>',
      502,
    );
  }
  const patched = html.replace('<head>', '<head><base href="/drizzle-studio/">');
  return c.html(patched, 200, { 'X-Frame-Options': 'SAMEORIGIN' });
});

/**
 * Asset proxy — was the `/drizzle-studio/:path*` rewrite in next.config.js.
 * Streams the SPA's relative assets through our origin.
 */
pageRoutes.get('/drizzle-studio/*', async (c) => {
  const rest = c.req.path.replace(/^\/drizzle-studio\//, '');
  const upstream = await fetch(`${DRIZZLE_CDN}/${rest}`);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  });
});
