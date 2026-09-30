/**
 * buildOutline — source-agnostic outline of a documentation corpus.
 *
 * Returns sections (alpha-sorted by slug), pages within (alpha-sorted),
 * and per-page headings. Reads optional section metadata via
 * source.getSectionMeta. Used by docs:outline, harness:docs_outline, and
 * any future *_outline surfaces.
 */

import type { DocSource, EngineCtx, OutlinePayload, OutlinePageEntry, OutlineSectionEntry } from './types.js';
import { humanize } from './shared.js';

export async function buildOutline(source: DocSource, ctx: EngineCtx = {}): Promise<OutlinePayload> {
  if (ctx.signal?.aborted) throw new Error('cancelled');
  const pages = await source.listPages();
  if (ctx.signal?.aborted) throw new Error('cancelled');

  // Group by first slug segment (or '_root' when the page has no section).
  const bySection = new Map<string, OutlinePageEntry[]>();
  for (const page of pages) {
    const sectionSlug = page.slugs.length > 1 ? page.slugs[0] : '_root';
    const entry: OutlinePageEntry = {
      slug: page.slug || '_root',
      title: page.title || humanize(page.slugs.join('-') || 'index'),
      ...(page.description ? { description: page.description } : {}),
      headings: page.toc.map((h) => ({ id: h.id, text: h.text, depth: h.depth })),
    };
    const arr = bySection.get(sectionSlug) ?? [];
    arr.push(entry);
    bySection.set(sectionSlug, arr);
  }

  const sectionSlugs = [...bySection.keys()].sort((a, b) => a.localeCompare(b));
  const sections: OutlineSectionEntry[] = await Promise.all(
    sectionSlugs.map(async (slug) => {
      const meta = slug === '_root' ? {} : ((await source.getSectionMeta?.(slug)) ?? {});
      const entries = (bySection.get(slug) ?? []).sort((a, b) => a.slug.localeCompare(b.slug));
      const title = meta.title ?? (slug === '_root' ? 'Top-level' : humanize(slug));
      return {
        slug,
        title,
        ...(meta.description ? { description: meta.description } : {}),
        pages: entries,
      };
    }),
  );

  return {
    generatedAt: new Date().toISOString(),
    sectionCount: sections.length,
    pageCount: pages.length,
    sections,
  };
}
