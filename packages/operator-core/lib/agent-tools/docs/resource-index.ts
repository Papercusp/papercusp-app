/**
 * MCP Resource: papercusp://docs/index
 *
 * Concrete (single-URI) resource that returns the same sitemap as
 * `/internal/docs/llms.txt` — cheap discovery payload for MCP clients
 * (Cursor, Claude Desktop, etc.) that prefer browsable resources over
 * tool calls. Reads the static file produced by starlight-llms-txt at
 * build time (apps/operator-docs/dist/llms.txt, copied into the
 * operator's public/ on every operator-docs build).
 */

import { promises as fs } from 'node:fs';
import { defineResource } from '@papercusp/agent-mcp';
import type { ResourceContents } from '@papercusp/agent-mcp';
import { LLMS_TXT_PATH as LLMS_TXT } from './_repo-paths';

export default defineResource({
  name: 'docs:index',
  uri: 'papercusp://docs/index',
  capability: 'docs:read',
  mimeType: 'text/plain',
  description:
    'Papercusp engineering reference sitemap — flat list of every page in /internal/docs (the /llms.txt content emitted by starlight-llms-txt).',
  async read(uri): Promise<ResourceContents> {
    const text = await fs.readFile(LLMS_TXT, 'utf-8');
    return { uri, mimeType: 'text/plain', text };
  },
});
