/**
 * harnessFsAdapter — wrap a harness project directory as a DocSource.
 *
 * Reads from two sources within `<projectPath>/`:
 *   1. `docs/**\/*.md` — user-authored harness documentation
 *   2. Well-known state files (caller-configurable; defaults match
 *      the SCANNED_FILES_FOR_INDEX list used by the operator UI)
 *
 * Slugs are relative paths with the .md extension stripped, e.g.
 *   docs/architecture.md → docs/architecture
 *   SPEC.md              → SPEC
 *   .papercusp/knowledge.md → harness-state/knowledge
 *
 * State files are grouped under the synthetic `harness-state/` slug
 * prefix so they appear as their own section in the outline.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { humanize } from '../shared.js';
import { renderMdxToMarkdown } from '../render-mdx.js';
import type { DocPage, DocSource, SectionMeta } from '../types.js';

export interface HarnessFsAdapterOptions {
  /** Stable identifier for telemetry + cache namespacing. */
  name?: string;
  /**
   * Docs directory to walk instead of `<projectPath>/docs`.
   *
   * State files remain relative to projectPath; this only changes the docs
   * corpus root. When omitted, the legacy `docs/...` slugs are preserved.
   */
  docsRoot?: string;
  /**
   * State files to include in addition to `docs/**\/*.md`. Paths
   * relative to projectPath. Defaults to the operator's
   * SCANNED_FILES_FOR_INDEX list.
   */
  stateFiles?: readonly string[];
  /** Max scan depth under docs/. Defaults to 5. */
  maxDepth?: number;
}

const DEFAULT_STATE_FILES = [
  'SPEC.md',
  'AGENTS.md',
  '.papercusp/knowledge.md',
  '.papercusp/supervisor-notes.md',
  '.papercusp/validation-contract.md',
] as const;

const MAX_FILE_BYTES = 512 * 1024;

interface FsPage extends DocPage {
  absolutePath: string;
}

function slugFromRelPath(rel: string): string {
  const noExt = rel.replace(/\.(md|mdx)$/i, '');
  // .papercusp/knowledge.md → harness-state/knowledge
  if (noExt.startsWith('.papercusp/')) {
    return 'harness-state/' + noExt.slice('.papercusp/'.length);
  }
  // top-level e.g. SPEC.md → harness-state/SPEC
  if (!noExt.includes('/') && !noExt.startsWith('docs')) {
    return 'harness-state/' + noExt;
  }
  return noExt;
}

function extractHeadings(content: string): DocPage['toc'] {
  const out: DocPage['toc'] = [];
  for (const line of content.split('\n')) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    // Anchor convention matches Vditor: non-alphanumerics → '-'
    const id = text.replace(/[^A-Za-z0-9]/g, '-');
    out.push({ id, text, depth: m[1].length });
    if (out.length >= 100) break;
  }
  return out;
}

function extractTitle(content: string, fallback: string): string {
  // First h1 wins; else first heading; else humanized filename
  const lines = content.split('\n');
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  for (const line of lines) {
    const m = /^#{2,6}\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return fallback;
}

async function readSafe(absPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_FILE_BYTES) return null;
    return await fs.readFile(absPath, 'utf-8');
  } catch {
    return null;
  }
}

async function walkDocs(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile() && /\.(md|mdx)$/i.test(e.name)) {
        out.push(full);
      }
    }
  }
  await walk(root, 0);
  return out;
}

export function harnessFsAdapter(projectPath: string, opts: HarnessFsAdapterOptions = {}): DocSource {
  const name = opts.name ?? `harness-fs:${path.basename(projectPath)}`;
  const stateFiles = opts.stateFiles ?? DEFAULT_STATE_FILES;
  const maxDepth = opts.maxDepth ?? 5;
  const docsRoot = opts.docsRoot ?? path.join(projectPath, 'docs');
  const legacyDocsRoot = opts.docsRoot === undefined;

  // Cache pages by slug for getContent lookup.
  let pageCache: Map<string, FsPage> | null = null;

  async function buildPages(): Promise<Map<string, FsPage>> {
    if (pageCache) return pageCache;
    const cache = new Map<string, FsPage>();

    // docs/ tree
    const docsFiles = await walkDocs(docsRoot, maxDepth);
    for (const abs of docsFiles) {
      // The historical default includes the `docs/` directory in the slug.
      // A declared root is itself the docs corpus, so its slugs are relative
      // to that root (e.g. agent-insights/runbook), matching docs:author's
      // returned self-read ref.
      const rel = path.relative(legacyDocsRoot ? projectPath : docsRoot, abs);
      const slug = slugFromRelPath(rel);
      const content = await readSafe(abs);
      if (content === null) continue;
      const slugs = slug.split('/');
      cache.set(slug, {
        slug,
        slugs,
        url: `/project-docs?harness=__SLUG__&path=${encodeURIComponent(rel)}`,
        title: extractTitle(content, humanize(slugs[slugs.length - 1])),
        toc: extractHeadings(content),
        absolutePath: abs,
      });
    }

    // State files
    for (const relFile of stateFiles) {
      const abs = path.join(projectPath, relFile);
      const content = await readSafe(abs);
      if (content === null) continue;
      const slug = slugFromRelPath(relFile);
      const slugs = slug.split('/');
      cache.set(slug, {
        slug,
        slugs,
        url: `/project-docs?harness=__SLUG__&path=${encodeURIComponent(relFile)}`,
        title: extractTitle(content, humanize(path.basename(slug))),
        toc: extractHeadings(content),
        absolutePath: abs,
      });
    }

    pageCache = cache;
    return cache;
  }

  return {
    name,
    async listPages(): Promise<DocPage[]> {
      const cache = await buildPages();
      return [...cache.values()].map(({ absolutePath: _abs, ...page }) => page);
    },
    async getPage(slug: string): Promise<DocPage | null> {
      const cache = await buildPages();
      const fp = cache.get(slug);
      if (!fp) return null;
      const { absolutePath: _abs, ...page } = fp;
      return page;
    },
    async getContent(page: DocPage): Promise<string> {
      const cache = await buildPages();
      const fp = cache.get(page.slug);
      if (!fp) throw new Error(`harnessFsAdapter: page ${page.slug} not found`);
      const content = await readSafe(fp.absolutePath);
      if (content === null) throw new Error(`harnessFsAdapter: could not read ${fp.absolutePath}`);
      // Render MDX→markdown if the file is .mdx; .md passes through.
      if (/\.mdx$/i.test(fp.absolutePath)) {
        return await renderMdxToMarkdown(content, fp.absolutePath);
      }
      return content;
    },
    // WI-1511581: the file exactly as it sits on disk — frontmatter included, MDX
    // unrendered. `readSafe` returning null (missing, not a file, over the size
    // cap) is reported as "no source" so the caller refuses, rather than throwing
    // or falling back to the lossy `getContent` projection.
    async getSource(page: DocPage): Promise<string | null> {
      const cache = await buildPages();
      const fp = cache.get(page.slug);
      if (!fp) return null;
      return await readSafe(fp.absolutePath);
    },
    async getSectionMeta(sectionSlug: string): Promise<SectionMeta> {
      if (sectionSlug === 'harness-state') {
        return {
          title: 'Harness state',
          description: 'Top-level project files + .papercusp/ state (SPEC, AGENTS, knowledge, supervisor-notes, validation-contract).',
        };
      }
      if (sectionSlug === 'docs') {
        return {
          title: 'Project docs',
          description: 'User-authored documentation under the configured project docs root.',
        };
      }
      return {};
    },
  };
}
