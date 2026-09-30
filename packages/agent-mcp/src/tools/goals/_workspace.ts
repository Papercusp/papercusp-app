/**
 * Shared workspace resolution for the goals tools.
 *
 * Every goals tool is workspace-scoped and a goal cannot be filed workspace-less
 * (the table's CHECK rejects a blank), so resolve GUC-first and REFUSE rather than
 * write against the wrong tenant. Extracted from projects.ts so update.ts's stop
 * fan-out resolves the tenant by exactly the same rule — a fan-out that resolved
 * the workspace differently from the write it accompanies could gate placement in
 * one tenant while updating a goal in another.
 */

import type { Sql } from 'postgres';

export async function resolveGoalWorkspace(ctx: {
  tx: unknown;
  // Widened to `null` as well as `undefined`: the goals tools are reached through
  // two different context types (the tooldef ctx and UnifiedToolContext) and only
  // one of them declares this optional. Accepting both keeps one resolver for all
  // of them rather than forking the rule per call site.
  workspaceId?: string | null;
}): Promise<string | null> {
  const tx = ctx.tx as Sql;
  const [gucRow] = await tx<Array<{ ws: string | null }>>`
    SELECT NULLIF(current_setting('app.workspace_id', true), '') AS ws
  `;
  return gucRow?.ws || (ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : null);
}
