/**
 * A connected app's recorded LLM spend, and the cap check at the dispatch seat
 * (external-app-access-to-workspaces-2026-09-29 P-011, D-028, R-27).
 *
 * An app runs LLM work only through its accepted blueprint operations. The worker sessions launched
 * for one carry `launch_spec.acceptedOperation.pin.callerId` = `operationCallerId(principal.slug)`,
 * i.e. `app:<id>` or `app:<id>/<suffix>` (an access token, or an MCP client suffix). The app's spend
 * is the usage ledger's recorded cost over those sessions — the same `agent_usage_samples` rows every
 * other spend surface reads, so there is no second meter to drift.
 */

import { getOrgPg } from '@papercusp/db-org';
import { BLUEPRINT_OPERATION_TOOLS } from '../blueprint/operation-tool-names';
import { APP_PRINCIPAL_SLUG_PREFIX } from './principal';

/**
 * Tools whose call starts or restarts LLM work. A key at its cap is refused these; reads and
 * cancel stay allowed, so an app over its cap can still see and stop what it started.
 */
export const LLM_RUNNING_TOOLS: ReadonlySet<string> = new Set([
  BLUEPRINT_OPERATION_TOOLS.submit,
  BLUEPRINT_OPERATION_TOOLS.resume,
]);

/** Share of the cap at which a cap-near alert is raised (D-006 wording: "about to be hit"). */
export const SPEND_CAP_NEAR_RATIO = 0.8;

export interface AppSpendStatus {
  /** Null = the key has no cap. */
  capCents: number | null;
  /** Recorded spend inside the cap window (the whole lifetime when windowSec is null). */
  spentCents: number;
  windowSec: number | null;
}

export type SpendCapVerdict =
  | { state: 'no-cap' | 'under'; spentCents: number; capCents: number | null }
  | { state: 'near'; spentCents: number; capCents: number }
  | { state: 'reached'; spentCents: number; capCents: number };

/** Pure: where a key's recorded spend stands against its cap. */
export function spendCapVerdict(status: AppSpendStatus): SpendCapVerdict {
  const { capCents, spentCents } = status;
  if (capCents === null || capCents === undefined) return { state: 'no-cap', spentCents, capCents: null };
  if (spentCents >= capCents) return { state: 'reached', spentCents, capCents };
  if (spentCents >= capCents * SPEND_CAP_NEAR_RATIO) return { state: 'near', spentCents, capCents };
  return { state: 'under', spentCents, capCents };
}

/**
 * The key's cap and its recorded spend inside the cap window. Null when the key does not exist.
 * One key row read plus one indexed ledger sum (migration 1265 `adv_sessions_app_operation_caller_idx`).
 */
export async function loadAppSpendStatus(appId: string, now: Date = new Date()): Promise<AppSpendStatus | null> {
  const { sql } = getOrgPg();
  const keys = await sql<Array<{ workspace_id: string; cap: number | null; window_sec: number | null }>>`
    SELECT workspace_id, spend_cap_cents::float8 AS cap, spend_cap_window_sec AS window_sec
      FROM harness_shared.connected_apps
     WHERE id = ${appId} AND kind IN ('app', 'service')
     LIMIT 1
  `;
  const key = keys[0];
  if (!key) return null;
  const sinceMs = key.window_sec === null ? null : now.getTime() - key.window_sec * 1000;
  const caller = `${APP_PRINCIPAL_SLUG_PREFIX}${appId}`;
  const [row] = await sql<Array<{ cents: number | null }>>`
    SELECT (COALESCE(SUM(u.cost_usd), 0) * 100)::float8 AS cents
      FROM harness_shared.adv_sessions s
      JOIN harness_shared.agent_usage_samples u
        ON u.workspace_id = s.workspace_id AND u.session_id = s.session_id
     WHERE s.workspace_id = ${key.workspace_id}
       AND s.launch_spec ? 'acceptedOperation'
       AND split_part(s.launch_spec->'acceptedOperation'->'pin'->>'callerId', '/', 1) = ${caller}
       AND u.session_id IS NOT NULL
       AND (${sinceMs}::bigint IS NULL OR COALESCE(u.event_ts, u.ts) >= ${sinceMs}::bigint)
  `;
  return { capCents: key.cap, spentCents: Number(row?.cents ?? 0), windowSec: key.window_sec };
}
