/**
 * A connected app's activity feed (external-app-access-to-workspaces-2026-09-29 P-011, D-028).
 *
 * Every tool call is recorded in `tool_invocations`; for a bearer principal its `coord_owner_id` is
 * `operationCallerId(principal.slug)` — `app:<id>`, or `app:<id>/<suffix>` for an access token or an
 * MCP client. So one key's calls, including those made through its access tokens, are the rows whose
 * first '/'-segment is `app:<id>`. Migration 1265's partial index serves exactly this read.
 */

import { withWorkspace } from '@papercusp/db-org';
import { APP_PRINCIPAL_SLUG_PREFIX } from './principal';
import { loadAppSpendStatus, spendCapVerdict, type SpendCapVerdict } from './spend';

export interface AppActivityEntry {
  id: string;
  toolName: string;
  status: string;
  errorCode: string | null;
  durationMs: number | null;
  harnessSlug: string | null;
  invokedAt: Date;
  /** The exact caller: the key itself, or the key through one access token / client. */
  caller: string;
}

export const APP_ACTIVITY_MAX_LIMIT = 200;

/** The key's most recent calls, newest first. */
export async function listAppActivity(
  workspaceId: string,
  appId: string,
  opts: { limit?: number; before?: Date } = {},
): Promise<AppActivityEntry[]> {
  const limit = Math.max(1, Math.min(APP_ACTIVITY_MAX_LIMIT, Math.floor(opts.limit ?? 50)));
  const caller = `${APP_PRINCIPAL_SLUG_PREFIX}${appId}`;
  const before = opts.before ?? null;
  const rows = await withWorkspace(workspaceId, async (tx) => tx<Array<{
    id: string; tool_name: string; status: string; error_code: string | null; duration_ms: number | null;
    harness_slug: string | null; invoked_at: Date; coord_owner_id: string;
  }>>`
    SELECT id::text, tool_name, status, error_code, duration_ms, NULLIF(harness_slug, '') AS harness_slug,
           invoked_at, coord_owner_id
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${workspaceId}
       AND coord_owner_id LIKE 'app:%'
       AND split_part(coord_owner_id, '/', 1) = ${caller}
       AND (${before}::timestamptz IS NULL OR invoked_at < ${before}::timestamptz)
     ORDER BY invoked_at DESC, id DESC
     LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    toolName: r.tool_name,
    status: r.status,
    errorCode: r.error_code,
    durationMs: r.duration_ms,
    harnessSlug: r.harness_slug,
    invokedAt: r.invoked_at,
    caller: r.coord_owner_id,
  }));
}

export interface AppActivitySummary {
  appId: string;
  spend: SpendCapVerdict & { windowSec: number | null };
  recent: AppActivityEntry[];
}

/** One key's spend against its cap and its recent calls — what the Remote access screen shows. */
export async function appActivitySummary(workspaceId: string, appId: string, limit = 50): Promise<AppActivitySummary | null> {
  const status = await loadAppSpendStatus(appId);
  if (!status) return null;
  const recent = await listAppActivity(workspaceId, appId, { limit });
  return { appId, spend: { ...spendCapVerdict(status), windowSec: status.windowSec }, recent };
}
