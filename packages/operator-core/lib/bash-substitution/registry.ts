/**
 * Read the substitution registry for matching
 * (plan `bash-to-tool-substitution-2026-07-26`, P-015).
 *
 * The rows this returns feed {@link matchCommandToSubstitutions}, which is
 * reached on the hot path: a PreToolUse gate consulting the registry runs once
 * per raw shell command, for every agent on the box. So the read is cached —
 * but briefly, and with an explicit invalidation, because the whole point of
 * D-002 is that changing a row changes behaviour without a code change, and a
 * long cache would turn "update the table" into "update the table and restart
 * the operator", which is a code change wearing a disguise.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { SubstitutionRow } from './match';
import type { EquivalenceVerdict, SubstitutionTier } from './types';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * How long a fetched row set is reused.
 *
 * 30s is chosen against the two failure modes rather than as a round number.
 * Too long and a tier promotion (P-020) or an emergency `enabled = false` on a
 * false-positive rule takes minutes to reach the fleet — and the reason to
 * disable a rule in a hurry is that it is actively obstructing agents. Too
 * short and every bash command in a 100-agent fleet becomes a database query.
 * At 30s the registry costs at most 2 queries/minute per operator process, and
 * a bad rule is gone within one turn of noticing it.
 */
export const REGISTRY_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  rows: SubstitutionRow[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop cached rows — call after any write that changes matching behaviour. */
export function invalidateSubstitutionRegistryCache(workspaceId?: string): void {
  if (workspaceId === undefined) cache.clear();
  else cache.delete(workspaceId);
}

interface RawRow {
  intent_label: string;
  bash_pattern: string;
  bash_pattern_flags: string | null;
  tool_name: string;
  tier: string;
  advisory_text: string | null;
  equivalence_verdict: string;
}

/**
 * Every enabled registry row for a workspace, newest-verdict-first ordering
 * being irrelevant (matching is set-like), so ordered by intent for stable
 * output in tests and generated docs.
 *
 * `enabled = false` rows are excluded in SQL rather than filtered afterwards:
 * disabling a rule is the emergency stop for a false-positive, and it should
 * cost nothing to honour.
 */
export async function fetchSubstitutionRows(
  workspaceId: string,
  client?: OrgSql,
  opts?: { includeDisabled?: boolean },
): Promise<SubstitutionRow[]> {
  const sql = client ?? getOrgPg().sql;
  const includeDisabled = opts?.includeDisabled === true;
  const rows = (await sql`
    SELECT intent_label, bash_pattern, bash_pattern_flags, tool_name,
           tier, advisory_text, equivalence_verdict
      FROM harness_shared.bash_tool_substitutions
     WHERE workspace_id = ${workspaceId}
       AND (enabled OR ${includeDisabled})
     ORDER BY intent_label
  `) as unknown as RawRow[];

  return rows.map((r) => ({
    intentLabel: r.intent_label,
    bashPattern: r.bash_pattern,
    bashPatternFlags: r.bash_pattern_flags ?? '',
    toolName: r.tool_name,
    tier: r.tier as SubstitutionTier,
    advisoryText: r.advisory_text,
    equivalenceVerdict: r.equivalence_verdict as EquivalenceVerdict,
  }));
}

/**
 * Cached {@link fetchSubstitutionRows}.
 *
 * Returns the STALE row set if a refresh throws. A registry read failing must
 * not turn into a command failing — the caller is a gate whose entire contract
 * is fail-open, and an advisory is worth strictly less than an agent's turn.
 * An empty result is returned only when there is genuinely nothing cached.
 */
export async function getSubstitutionRows(
  workspaceId: string,
  now = Date.now(),
): Promise<SubstitutionRow[]> {
  const hit = cache.get(workspaceId);
  if (hit && now - hit.fetchedAt < REGISTRY_CACHE_TTL_MS) return hit.rows;

  try {
    const rows = await fetchSubstitutionRows(workspaceId);
    cache.set(workspaceId, { rows, fetchedAt: now });
    return rows;
  } catch {
    return hit?.rows ?? [];
  }
}
