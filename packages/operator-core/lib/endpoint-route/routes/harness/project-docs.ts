/**
 * GET /api/harness/:slug/project-docs?path=<rel>
 *
 * Lists + reads a harness project's `docs/` markdown so the /adv Docs tab can
 * render it INLINE. (#7) The legacy `/project-docs` Next.js page is dead after
 * the operator-vite migration — the SPA fallback served the operator shell into
 * the docs iframe, which read as an error on any harness with the starlight
 * docs plugin. This route is the universal data source: it resolves ANY harness
 * via the registry and returns a typed empty/unknown state instead of throwing
 * when a harness has no docs, so every harness behaves the same.
 *
 * Auth: 'public' — loopback gate is the trust boundary (same as sibling harness
 * routes).
 */

import { promises as fs, existsSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { loadHarnessRegistry } from '../../../harness-registry';

async function resolveProjectPath(slug: string): Promise<string | null> {
  return (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
}

/**
 * Resolve the harness's docs root. A harness can re-point it via its own
 * contract surface `.papercusp/docs.json` (`{ "root": "<repo-relative dir>" }`)
 * — e.g. papercup points at its real Starlight corpus
 * (`apps/operator-docs/src/content/docs`) instead of the stray top-level
 * `docs/` (D-004c, pui-completion-and-polish-2026-06-05). The declared root
 * must resolve INSIDE the project (traversal-guarded) and exist; a missing or
 * invalid declaration falls back to `<project>/docs`.
 */
export async function resolveDocsRoot(projectPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(join(projectPath, '.papercusp', 'docs.json'), 'utf8');
    const parsed = JSON.parse(raw) as { root?: unknown };
    if (typeof parsed.root === 'string' && parsed.root.trim()) {
      const declared = safeJoinUnderRoot(projectPath, parsed.root.trim());
      if (declared && existsSync(declared)) return declared;
    }
  } catch {
    /* absent/malformed → default */
  }
  return join(projectPath, 'docs');
}

/**
 * Additional file-authoritative corpora share tracking, not publication.
 * Namespaces keep the existing engineering/project root and doc IDs intact.
 * Reject both lexical and symlink escapes before a corpus can be read/tracked.
 */
export async function resolveDocsSources(projectPath: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const config = JSON.parse(await fs.readFile(join(projectPath, '.papercusp/docs.json'), 'utf8'));
    if (!config.sources || typeof config.sources !== 'object' || Array.isArray(config.sources)) return out;
    const primary = await resolveDocsRoot(projectPath);
    const realProject = await fs.realpath(projectPath);
    for (const [namespace, rel] of Object.entries(config.sources)) {
      if (!/^[a-z][a-z0-9-]*$/.test(namespace) || typeof rel !== 'string') continue;
      const root = safeJoinUnderRoot(projectPath, rel);
      if (!root || root === primary || existsSync(join(primary, namespace))) continue;
      const real = await fs.realpath(root).catch(() => null);
      if (!real || !real.startsWith(realProject + sep) || !(await fs.stat(real)).isDirectory()) continue;
      out[namespace] = real;
    }
  } catch { /* absent/malformed source declarations do not change the primary corpus */ }
  return out;
}

/** Recursively collect every .md/.mdx file under docsRoot, relative + sorted. */
async function listDocs(docsRoot: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && /\.(md|mdx)$/i.test(e.name)) out.push(relative(docsRoot, full));
    }
  }
  await walk(docsRoot);
  return out.sort();
}

/** Guard against `?path=../../etc` traversal — the resolved path must stay under docsRoot. */
function safeJoinUnderRoot(root: string, rel: string): string | null {
  const resolved = resolvePath(root, rel);
  const safeRoot = resolvePath(root) + sep;
  if (resolved !== resolvePath(root) && !resolved.startsWith(safeRoot)) return null;
  return resolved;
}

function chooseDefaultPath(files: string[]): string | null {
  if (files.length === 0) return null;
  return (
    files.find((f) => /^index\.(md|mdx)$/i.test(f)) ??
    files.find((f) => /^README\.(md|mdx)$/i.test(f)) ??
    files[0]
  );
}

const getProjectDocs = defineTool({
  method: 'GET',
  path: '/harness/:slug/project-docs',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const requestedPath = new URL(req.url).searchParams.get('path')?.trim() ?? '';

    const projectPath = await resolveProjectPath(slug);
    if (!projectPath) {
      return Response.json({ ok: false, reason: 'unknown_harness', files: [], activePath: null, content: null });
    }

    const docsRoot = await resolveDocsRoot(projectPath);
    if (!existsSync(docsRoot)) {
      return Response.json({ ok: true, reason: 'no_docs_dir', projectPath, files: [], activePath: null, content: null });
    }

    const files = await listDocs(docsRoot);
    if (files.length === 0) {
      return Response.json({ ok: true, reason: 'empty', projectPath, files: [], activePath: null, content: null });
    }

    const activePath = requestedPath && files.includes(requestedPath) ? requestedPath : chooseDefaultPath(files);
    const abs = activePath ? safeJoinUnderRoot(docsRoot, activePath) : null;
    const content = abs && existsSync(abs) ? await fs.readFile(abs, 'utf8') : null;

    return Response.json({ ok: true, projectPath, files, activePath, content });
  },
});

export default [getProjectDocs];
