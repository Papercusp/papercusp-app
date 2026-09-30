/**
 * MCP Resource: papercusp://harness/{slug}/docs/section/{section}
 *
 * Per-harness, per-section consolidated markdown. One entry per
 * (harness, section) across all registered harnesses.
 */

import { defineResource } from '@papercusp/agent-mcp';
import type { ResourceContents, ResourceListEntry } from '@papercusp/agent-mcp';
import { buildOutline, harnessFsAdapter, withPreamble } from '@papercusp/docs-engine';
import { loadHarnessRegistry } from '../../harness-registry';

export default defineResource({
  name: 'cross_harness:docs_section',
  uri: 'papercusp://harness/{slug}/docs/section/{section}',
  capability: 'harness:read',
  mimeType: 'text/markdown',
  description:
    "Per-harness, per-section consolidated documentation (markdown). One entry per (harness, section) pair across all registered harnesses; reading returns every page in that section joined.",

  async list(): Promise<ResourceListEntry[]> {
    const reg = await loadHarnessRegistry();
    const out: ResourceListEntry[] = [];
    for (const project of reg.projects) {
      let outline;
      try {
        const adapter = harnessFsAdapter(project.path, { name: `harness:${project.slug}` });
        outline = await buildOutline(adapter);
      } catch {
        continue;
      }
      for (const section of outline.sections) {
        if (section.slug === '_root') continue;
        out.push({
          uri: `papercusp://harness/${project.slug}/docs/section/${section.slug}`,
          name: `${project.slug} / ${section.title}`,
          description:
            section.description ??
            `Consolidated markdown for harness "${project.slug}" section "${section.slug}".`,
          mimeType: 'text/markdown',
        });
      }
    }
    return out;
  },

  async read(uri): Promise<ResourceContents> {
    const match = /^papercusp:\/\/harness\/([^/]+)\/docs\/section\/([^/]+)$/.exec(uri);
    const slug = match?.[1];
    const section = match?.[2];
    if (!slug || !section) throw new Error(`Invalid harness/docs/section URI: ${uri}`);

    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) throw new Error(`harness "${slug}" not registered`);

    const adapter = harnessFsAdapter(project.path, { name: `harness:${slug}` });
    const pages = await adapter.listPages();
    const sectionPages = pages
      .filter((p) => p.slugs[0] === section)
      .sort((a, b) => a.slug.localeCompare(b.slug));

    if (sectionPages.length === 0) {
      throw new Error(`No pages found under section "${section}" for harness "${slug}"`);
    }

    const rendered = await Promise.all(
      sectionPages.map(async (p) => {
        const body = await adapter.getContent(p);
        return withPreamble(body, {
          title: p.title,
          url: p.url,
          ...(p.description ? { description: p.description } : {}),
        });
      }),
    );
    return { uri, mimeType: 'text/markdown', text: rendered.join('\n\n---\n\n') };
  },
});
