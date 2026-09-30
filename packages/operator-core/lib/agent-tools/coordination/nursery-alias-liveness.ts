/**
 * nursery-alias-liveness.ts — coord:presence's alias-aware nursery liveness
 * leg (EI-16639, closing the same identity-alias gap migration 225 / EI-311
 * already closed for `harness_shared.fleet_assignment`).
 *
 * THE GAP. A spawned bee has THREE identity aliases: the nursery `spawn_id`
 * (== `session_owner`), and the per-invocation `run_id`. A short-lived bee
 * (or one whose MCP mount degraded to raw-HTTP) may self-identify by any of
 * these and NEVER write its own `coord_presence` row. Migration 225 (EI-311)
 * taught `fleet_assignment`'s `holder` CTE to resolve liveness across all
 * three aliases by joining `harness_shared.spawned_agents` (status='running')
 * — but `coord:presence` (presence-snapshot.ts) never got the same leg: its
 * roster is built ONLY from `coord_presence` + `adv_sessions`. The result:
 * `fleet:assignments` correctly reports `holder_present:true` for such a
 * bee's claim while a targeted `coord:presence { owner: '<alias>' }` lookup
 * for the SAME id returns an EMPTY roster — two tools answering the same
 * "is this claim's holder alive" question with contradictory verdicts,
 * observed live 2026-07-18/19 masking a real Mug placement stall (WI-5417 /
 * WI-5419, filed as EI-16639).
 *
 * THE FIX. Give presence-snapshot.ts the SAME alias leg, expressed as a TS
 * query mirroring migration 225's CTE (kept in lockstep with it — see the
 * SQL comment there), so a nursery-only alias:
 *   1. resolves as a synthesized roster row (`synthesizeNurseryAliasRosterRows`,
 *      the same pattern `recorded-sessions.ts` already uses for adv_sessions),
 *      addressable by a targeted owner lookup instead of coming back empty;
 *   2. classifies via the shared liveness oracle (liveness-oracle.ts's
 *      `deriveVerdict`) the SAME way a live adv_sessions record does — by
 *      folding its alive aliases into the `recordedLiveOwners` set already
 *      threaded through deriveVerdict, so no oracle changes are needed and
 *      `fleet:assignments` / `coord:presence` converge on ONE verdict.
 *
 * A finished spawn (`status <> 'running'`) yields no alias row here, exactly
 * like migration 225's view — a claim whose bee exited still reads
 * unresolved/orphaned, which is the point.
 *
 * Best-effort by construction ([]/empty Set on any DB error or missing
 * table) — this leg must never break the roster read it enriches.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { UnifiedPresenceRecord } from './federated-presence';

/** The `source` marker stamped on a nursery-alias-synthesized roster row —
 *  mirrors `RECORDED_SESSION_SOURCE`'s role in recorded-sessions.ts. */
export const NURSERY_ALIAS_SOURCE = 'nursery-alias';

export interface NurseryAliasRow {
  /** The alias owner id (spawn_id / session_owner / run_id) a claim/lock may
   *  be keyed under. */
  alias: string;
  spawnId: string;
  workspaceId: string;
  /** ISO timestamp, or null if the nursery row never heartbeat. */
  heartbeatAt: string | null;
}

function warnOnce(e: unknown, label: string): void {
  // Best-effort: a missing table (fresh/partial install) or any other DB
  // hiccup must never break the roster read this leg enriches.
  const msg = e instanceof Error ? e.message : String(e);
  if (!/relation .* does not exist/i.test(msg)) {
    console.warn(`[nursery-alias-liveness] ${label} failed: ${msg}`);
  }
}

/**
 * RUNNING nursery rows, addressable by every alias (spawn_id, session_owner,
 * run_id) — the TS mirror of migration 225's `holder` CTE nursery leg.
 * `ownerIds`, when given, scopes the query to just those aliases (the
 * targeted-lookup cost discipline EI-9454 established for this snapshot: a
 * point lookup must not pay a whole-table scan). Bounded + best-effort.
 */
export async function listRunningNurseryAliasRows(
  opts: { workspaceId?: string | null; ownerIds?: string[] } = {},
): Promise<NurseryAliasRow[]> {
  const ws = opts.workspaceId ?? null;
  const ids = opts.ownerIds && opts.ownerIds.length > 0 ? opts.ownerIds : null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{ alias: string; spawn_id: string; workspace_id: string; heartbeat_at: string | Date | null }>
    >`
      SELECT DISTINCT ON (a.alias)
             a.alias, n.spawn_id, n.workspace_id, n.heartbeat_at
        FROM harness_shared.spawned_agents n
        CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
       WHERE n.status = 'running'
         AND a.alias IS NOT NULL AND a.alias <> ''
         AND (${ws}::text IS NULL OR n.workspace_id = ${ws})
         AND (${ids}::text[] IS NULL OR a.alias = ANY(${ids}::text[]))
       ORDER BY a.alias, n.heartbeat_at DESC NULLS LAST
       LIMIT 500
    `;
    return rows.map((r) => ({
      alias: r.alias,
      spawnId: r.spawn_id,
      workspaceId: r.workspace_id,
      heartbeatAt: r.heartbeat_at == null ? null : new Date(r.heartbeat_at).toISOString(),
    }));
  } catch (e) {
    warnOnce(e, 'listRunningNurseryAliasRows');
    return [];
  }
}

/**
 * Project running-nursery-alias rows NOT already covered by the existing
 * roster (`existingOwnerIds` = coord_presence + federated + already-
 * synthesized adv_sessions owner ids) into roster rows — the nursery-leg
 * twin of `synthesizeRecordedRosterRows` in recorded-sessions.ts. Pure.
 */
export function synthesizeNurseryAliasRosterRows(
  rows: readonly NurseryAliasRow[],
  existingOwnerIds: ReadonlySet<string>,
): UnifiedPresenceRecord[] {
  const out: UnifiedPresenceRecord[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (existingOwnerIds.has(r.alias) || seen.has(r.alias)) continue;
    seen.add(r.alias);
    const hb = r.heartbeatAt ?? new Date().toISOString();
    out.push({
      ownerId: r.alias,
      ownerLabel: `bee · ${r.spawnId.slice(0, 10)}`,
      workspaceId: r.workspaceId,
      source: NURSERY_ALIAS_SOURCE,
      intent: '',
      currentPlanSlug: null,
      currentFiles: [],
      host: '',
      pid: null,
      tty: null,
      startedAt: hb,
      heartbeatAt: hb,
      lastActiveAt: null,
      intentDeclaredAt: null,
      agentRole: null,
      potSlug: null,
      capabilityTags: [],
      // A running nursery process IS the liveness signal (no heartbeat-age
      // staleness applies — same rationale as synthesizeRecordedRosterRows'
      // `stale:false`: the query already filtered to status='running').
      stale: false,
      userId: null,
      revoked: false,
      federated: false,
    });
  }
  return out;
}
