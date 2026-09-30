/**
 * MCP Resource: papercusp://docs/section/{section}
 *
 * Templated resource. `list()` expands the template into one entry per
 * section in the engineering docs tree. `read()` returns the
 * concatenated markdown for every page in that section — same
 * rendering pipeline as the /llms-full.txt twin via
 * @papercusp/docs-engine + starlightContentAdapter.
 */

import { defineResource } from '@papercusp/agent-mcp';
import type { ResourceContents, ResourceListEntry } from '@papercusp/agent-mcp';
import { buildOutline, withPreamble } from '@papercusp/docs-engine';
import { engineeringAdapter as adapter } from './_engineering-adapter';

export default defineResource({
  name: 'docs:section',
  uri: 'papercusp://docs/section/{section}',
  capability: 'docs:read',
  mimeType: 'text/markdown',
  description:
    'Whole-section consolidated engineering reference (markdown). One entry per top-level section in /internal/docs; reading returns every page in that section joined.',
  async list(): Promise<ResourceListEntry[]> {
    const outline = await buildOutline(adapter);
    return outline.sections
      .filter((s) => s.slug !== '_root')
      .map((s) => ({
        uri: `papercusp://docs/section/${s.slug}`,
        name: s.title,
        description:
          s.description ??
          `Consolidated markdown for every page under /internal/docs/${s.slug}.`,
        mimeType: 'text/markdown',
      }));
  },
  async read(uri): Promise<ResourceContents> {
    const match = /^papercusp:\/\/docs\/section\/([^/]+)$/.exec(uri);
    const section = match?.[1];
    if (!section) throw new Error(`Invalid docs/section URI: ${uri}`);
    const pages = await adapter.listPages();
    const sectionPages = pages.filter((p) => p.slugs[0] === section);
    if (sectionPages.length === 0) {
      throw new Error(`docs:section: no pages found under section '${section}'`);
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
    return {
      uri,
      mimeType: 'text/markdown',
      text: rendered.join('\n\n'),
    };
  },
});
