/**
 * Persistence for the dead-window residue sample ring (P-013 / D-017).
 *
 * The ring lives in `harness_shared.routines.metadata -> 'residue_census'` for the
 * `system:task-reconcile` row, following the same shape as the green-checkpoint
 * gate_health markers (`release/gate-health-merge.ts`). Two properties are
 * borrowed from that helper deliberately:
 *
 * 1. SHALLOW MERGE via `jsonb_set`, never a whole-metadata replace — other code
 *    writes sibling keys on this row.
 * 2. SCOPED BY BOTH `install_slug` AND `workspace_id`. `harness_shared.routines`
 *    is multi-tenant, one row per harness per workspace; scoping on the slug
 *    alone writes another tenant's row on a box hosting the same slug twice.
 *
 * WHY NOT `system_health_ticks`: that table exists and is a real time series, but
 * its retention is 14 days. This indicator has to see a multi-WEEK floor (the
 * failure it exists to catch was 16 days of silent accumulation), so a 14-day
 * window can structurally never contain both halves of the comparison.
 *
 * WHY NO MIGRATION: the row and the jsonb column already exist. A new table for
 * ~400 integers would be a parallel durable surface where an existing one fits.
 *
 * BEST-EFFORT BY CONTRACT: every function here swallows its own errors and the
 * reader returns `[]` on failure. This is a diagnostic riding alongside the
 * reconcile tick — it must never break, or slow, the tick it observes. A caller
 * that needs to know a write landed must read it back.
 *
 * ⚠ `[]` from the reader therefore means "no history OR unreadable", which is
 * exactly why `evaluateResidueTrend` answers `unknown` (never a healthy-looking
 * `steady`) on thin input: a storage failure must not render as "no accumulation".
 */

import type { ResidueSample } from './terminal-residue-census';

const TARGET_ROLE = 'system:task-reconcile';
const METADATA_KEY = 'residue_census';

/**
 * Which sample ring a call addresses. Two INDEPENDENT populations share this
 * row, and they must never be mixed:
 *
 *   `residue_census` — dead-WINDOW terminal scopes (the original P-013 indicator).
 *   `reaper_floor`   — agent-session residue that SURVIVED a reaper pass
 *                      (WI-41607). Its healthy value is 0: a working pass leaves
 *                      nothing behind, so a floor that stays above zero means
 *                      enforcement is failing, not that the host is busy.
 *
 * A string UNION rather than a free `string`: these values are interpolated into
 * the jsonb path of the statements below, so a literal union is what keeps that
 * interpolation injection-proof by construction instead of by review.
 */
export type ResidueRing = typeof METADATA_KEY | 'reaper_floor';

export interface ResidueStoreTarget {
  installSlug: string;
  workspaceId: string;
}

/** Parse a persisted ring defensively — anything malformed reads as empty. */
export function parseResidueSamples(raw: unknown): ResidueSample[] {
  if (!Array.isArray(raw)) return [];
  const out: ResidueSample[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { atMs, scopesDead } = entry as Record<string, unknown>;
    if (typeof atMs !== 'number' || !Number.isFinite(atMs)) continue;
    if (typeof scopesDead !== 'number' || !Number.isFinite(scopesDead)) continue;
    out.push({ atMs, scopesDead });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

export async function readResidueSamples(
  target: ResidueStoreTarget,
  ring: ResidueRing = METADATA_KEY,
): Promise<ResidueSample[]> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = await sql.unsafe(
      `SELECT metadata->'${ring}'->'samples' AS samples
         FROM harness_shared.routines
        WHERE install_slug = $1 AND workspace_id = $2 AND target_role = '${TARGET_ROLE}'
        LIMIT 1`,
      [target.installSlug, target.workspaceId],
    );
    return parseResidueSamples((rows as Array<{ samples?: unknown }>)[0]?.samples);
  } catch {
    return [];
  }
}

/**
 * Read the persisted `lastCensusAtMs` watermark (EI-19407950136194410).
 *
 * This is the restart-proof half of the census due-check: the reconcile tick hydrates
 * it ONCE per process, then gates on wall-clock elapsed time instead of an in-process
 * tick counter that a restart resets to zero.
 *
 * Returns null when the key is absent or the read fails — which `isMaintDue`
 * deliberately reads as DUE, per this module's standing "a storage failure must not
 * render as healthy" contract (see the header note on `evaluateResidueTrend`).
 */
export async function readLastCensusAtMs(target: ResidueStoreTarget): Promise<number | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = await sql.unsafe(
      `SELECT metadata->'${METADATA_KEY}'->>'lastCensusAtMs' AS last_at
         FROM harness_shared.routines
        WHERE install_slug = $1 AND workspace_id = $2 AND target_role = '${TARGET_ROLE}'
        LIMIT 1`,
      [target.installSlug, target.workspaceId],
    );
    const raw = (rows as Array<{ last_at?: unknown }>)[0]?.last_at;
    const parsed = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeResidueSamples(
  target: ResidueStoreTarget,
  samples: readonly ResidueSample[],
  extra: Record<string, unknown> = {},
  ring: ResidueRing = METADATA_KEY,
): Promise<void> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const patch = { samples, ...extra };
    await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{${ring}}',
                COALESCE(metadata->'${ring}', '{}'::jsonb) || $3::jsonb,
                true
              ),
              updated_at = now()
        WHERE install_slug = $1 AND workspace_id = $2 AND target_role = '${TARGET_ROLE}'`,
      [target.installSlug, target.workspaceId, JSON.stringify(patch)],
    );
  } catch {
    /* best-effort diagnostic — never let this break the reconcile tick */
  }
}
