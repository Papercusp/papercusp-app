/**
 * MCP Resource: papercusp://harness/{slug}/docs/index
 *
 * Templated resource — one entry per registered harness. read() returns
 * a sitemap of that harness's docs for external MCP clients (Cursor,
 * Claude Desktop) that want to browse harness documentation by URI.
 *
 * Lives in cross_harness/ because the URI is explicit-slug-keyed, the
 * same semantics as cross_harness:docs_* tools. Same code surface,
 * different transport projection.
 */

import { defineResource } from '@papercusp/agent-mcp';
import type { ResourceContents, ResourceListEntry } from '@papercusp/agent-mcp';
import { buildOutline, harnessFsAdapter } from '@papercusp/docs-engine';
import { loadHarnessRegistry } from '../../harness-registry';

export default defineResource({
  name: 'cross_harness:docs_index',
  profile: 'engineer',
  uri: 'papercusp://harness/{slug}/docs/index',
  capability: 'harness:read',
  mimeType: 'text/plain',
  description:
    "Per-harness documentation sitemap — flat list of every page under that harness's docs/ folder + state files (one entry per registered harness).",

  async list(): Promise<ResourceListEntry[]> {
    const reg = await loadHarnessRegistry();
    return reg.projects.map((p) => ({
      uri: `papercusp://harness/${p.slug}/docs/index`,
      name: `${p.slug} — docs sitemap`,
      description: `Pages + state files for harness "${p.slug}" at ${p.path}.`,
      mimeType: 'text/plain',
    }));
  },

  async read(uri): Promise<ResourceContents> {
    const match = /^papercusp:\/\/harness\/([^/]+)\/docs\/index$/.exec(uri);
    const slug = match?.[1];
    if (!slug) throw new Error(`Invalid harness/docs URI: ${uri}`);

    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) throw new Error(`harness "${slug}" not registered`);

    const adapter = harnessFsAdapter(project.path, { name: `harness:${slug}` });
    const outline = await buildOutline(adapter);

    const lines: string[] = [`# ${slug} — documentation`, ''];
    for (const section of outline.sections) {
      lines.push(`## ${section.title}`);
      if (section.description) lines.push(section.description);
      lines.push('');
      for (const page of section.pages) {
        const desc = page.description ? ` — ${page.description}` : '';
        lines.push(`- [${page.title}](${page.slug})${desc}`);
      }
      lines.push('');
    }

    return { uri, mimeType: 'text/plain', text: lines.join('\n') };
  },
});
