/**
 * Audit log PG inserter.
 *
 * Loaded via dynamic import from `audit.ts` so the registry doesn't
 * require PG at boot — if the migration hasn't run yet, audit silently
 * no-ops on first failure and we surface a single console.warn.
 */

import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { AgentId } from './types';

interface ActionRow {
  id: string;
  agent: AgentId;
  workspace: string;
  sessionId?: string;
  requestId: string;
  args: unknown;
  status: 'ok' | 'err';
  errorCode?: string;
  durationMs: number;
}

interface QueryRow {
  id: string;
  agent: AgentId;
  workspace: string;
  requestId: string;
  args?: unknown;
  sample: boolean;
}

let tableMissingWarned = false;

export async function writeAuditRows(
  actions: ActionRow[],
  queries: QueryRow[],
): Promise<void> {
  if (!actions.length && !queries.length) return;
  try {
    await withWorkspace(activeWorkspaceId(), async (tx) => {
      if (actions.length) {
        // Multi-row insert via unnest pattern. Each row is independently bound.
        for (const a of actions) {
          await tx`
            INSERT INTO harness_shared.agent_actions (
              ts, agent, command_id, args, status, error_code, duration_ms,
              workspace_id, session_id, request_id
            ) VALUES (
              now(),
              ${a.agent},
              ${a.id},
              ${JSON.stringify(a.args ?? {})}::text::jsonb,
              ${a.status},
              ${a.errorCode ?? null},
              ${a.durationMs},
              ${a.workspace},
              ${a.sessionId ?? null},
              ${a.requestId}
            )
          `;
        }
      }
      if (queries.length) {
        for (const q of queries) {
          await tx`
            INSERT INTO harness_shared.agent_queries (
              ts, agent, query_id, args_compact, workspace_id, request_id
            ) VALUES (
              now(),
              ${q.agent},
              ${q.id},
              ${q.args === undefined ? null : JSON.stringify(q.args)}::text::jsonb,
              ${q.workspace},
              ${q.requestId}
            )
          `;
        }
      }
    });
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    if (/relation .*agent_actions.* does not exist|relation .*agent_queries.* does not exist/i.test(msg)) {
      if (!tableMissingWarned) {
        tableMissingWarned = true;
        console.warn(
          '[agent-audit] tables not yet migrated — audit rows dropped. Run the migration in apps/operator/lib/commands/migrations/ to enable persistence.',
        );
      }
      return;
    }
    throw e;
  }
}
