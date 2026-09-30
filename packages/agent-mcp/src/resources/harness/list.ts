/**
 * `papercusp://workspace/harnesses` — workspace-scoped harness inventory.
 *
 * Concrete (non-templated) resource. Same data as the `harness:list`
 * tool; exposed as a resource so agents can browse and cache without
 * a tool call.
 */

import { defineResource } from '@papercusp/tooldef';
import type { ResourceContents } from '@papercusp/tooldef';
import type { PapercuspToolContext } from '@papercusp/operator-core/lib/agent-tools/_tool-context';

export default defineResource({
  name: 'harness:list',
  uri: 'papercusp://workspace/harnesses',
  capability: 'harness:read',
  mimeType: 'application/json',
  description:
    'List of harnesses in the current workspace: slug, name, status, last-activity timestamp.',

  async read(uri, ctx: PapercuspToolContext): Promise<ResourceContents> {
    const tx = ctx.tx!;
    const rows = await tx<
      Array<{ slug: string; name: string; status: string; updated_ts: number }>
    >`
      SELECT slug, name, status, updated_ts
        FROM harness_shared.projects
       ORDER BY updated_ts DESC
    `;
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ harnesses: rows }, null, 2),
    };
  },
});
