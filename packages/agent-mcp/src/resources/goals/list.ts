/**
 * `papercusp://workspace/goals` — workspace goal inventory.
 *
 * Concrete resource mirroring the `goals:list` tool's full-detail
 * output.
 */

import { defineResource } from '@papercusp/tooldef';
import type { ResourceContents } from '@papercusp/tooldef';
import type { PapercuspToolContext } from '@papercusp/operator-core/lib/agent-tools/_tool-context';

export default defineResource({
  name: 'goals:list',
  uri: 'papercusp://workspace/goals',
  capability: 'goals:read',
  mimeType: 'application/json',
  description:
    'Workspace goal hierarchy: id, title, body, parent_id, budget_cents, created_at.',

  async read(uri, ctx: PapercuspToolContext): Promise<ResourceContents> {
    const tx = ctx.tx!;
    const rows = await tx<Array<Record<string, unknown>>>`
      SELECT id, title, body, parent_id, budget_cents, created_at
        FROM harness_shared.goals
       ORDER BY created_at DESC
       LIMIT 500
    `;
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ goals: rows }, null, 2),
    };
  },
});
