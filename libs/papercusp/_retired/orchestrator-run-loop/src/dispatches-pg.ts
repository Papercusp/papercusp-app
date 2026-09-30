/**
 * Postgres-backed inter-harness dispatch log — Phase 2 of the
 * orchestrator → PG arc. Replaces `<stateDir>/logs/nexth-<slug>-<ts>.json`
 * with structured rows.
 *
 * Schema:
 *
 *   CREATE TABLE harness_shared.harness_dispatches (
 *     workspace_id  TEXT NOT NULL DEFAULT 'default',
 *     parent_slug   TEXT NOT NULL,
 *     child_slug    TEXT NOT NULL,
 *     child_role    TEXT,
 *     dispatch_at   BIGINT NOT NULL,
 *     result_body   JSONB,
 *     PRIMARY KEY (workspace_id, parent_slug, child_slug, dispatch_at)
 *   );
 */
import { pgJson, type OrchestratorPg } from './invoke';

export interface DispatchesPgContext {
  pg: OrchestratorPg;
  workspaceId: string;
}

/** SQL DDL for the dispatches table. Idempotent. */
export const DISPATCHES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_dispatches (
    workspace_id  TEXT NOT NULL DEFAULT 'default',
    parent_slug   TEXT NOT NULL,
    child_slug    TEXT NOT NULL,
    child_role    TEXT,
    dispatch_at   BIGINT NOT NULL,
    result_body   JSONB,
    PRIMARY KEY (workspace_id, parent_slug, child_slug, dispatch_at)
  );
  CREATE INDEX IF NOT EXISTS harness_dispatches_parent_idx
    ON harness_shared.harness_dispatches (workspace_id, parent_slug, dispatch_at DESC);
`;

export async function recordDispatchPg(
  ctx: DispatchesPgContext,
  parentSlug: string,
  childSlug: string,
  childRole: string | null,
  resultBody: unknown,
): Promise<void> {
  const now = Date.now();
  // jsonb goes through pgJson (sql.json), NOT JSON.stringify — postgres-js would
  // double-encode a pre-stringified value into a jsonb string scalar. NULL stays
  // NULL.
  const bodyJson: unknown =
    resultBody === undefined || resultBody === null ? null : pgJson(ctx.pg, resultBody);
  await ctx.pg`
    INSERT INTO harness_shared.harness_dispatches
      (workspace_id, parent_slug, child_slug, child_role, dispatch_at, result_body)
    VALUES (${ctx.workspaceId}, ${parentSlug}, ${childSlug}, ${childRole},
            ${now}, ${bodyJson})
    ON CONFLICT (workspace_id, parent_slug, child_slug, dispatch_at) DO NOTHING
  `;
}
