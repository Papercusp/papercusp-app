/**
 * loadRecentClaimAttempts — pure read of LOCAL claim_audit rows.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24
 *       (P-039 audit query side).
 *
 * Reads the last N rows from harness_shared.claim_audit for diagnostic
 * surfaces (admin substrate panel, harness Insights debug section).
 * Pure logic — injectable runQuery; defensive against missing table.
 *
 * Cross-cuts: this loader is read-only. Writes happen via
 * apps/operator/lib/orchestrator/claim-audit.ts `recordClaimAttempt`.
 */

export interface ClaimAttemptRow {
  /** PG bigserial id. */
  id: number;
  feature_id: string;
  claimer_pubkey: string;
  claimer_github_user_id: number;
  ts: number;
  outcome: 'won' | 'lost' | 'error' | string;
  detail: string | null;
}

export interface LoadRecentClaimAttemptsOpts {
  workspace_id: string;
  harness_slug: string;
  limit?: number;
  /** Filter to one feature_id. */
  feature_id?: string;
  /** Filter to one outcome. */
  outcome?: 'won' | 'lost' | 'error';
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

interface RawRow {
  id: string | number;
  feature_id: string;
  claimer_pubkey: string;
  claimer_github_user_id: string | number;
  ts: string | Date;
  outcome: string;
  detail: string | null;
}

function toNumberOrZero(v: string | number): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function tsToEpoch(v: string | Date): number {
  if (v instanceof Date) return v.getTime();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

export async function loadRecentClaimAttempts(
  opts: LoadRecentClaimAttemptsOpts,
): Promise<ClaimAttemptRow[]> {
  const { workspace_id, harness_slug, runQuery } = opts;
  const limit = opts.limit ?? 50;
  const params: unknown[] = [workspace_id, harness_slug, limit];
  let where = `WHERE workspace_id = $1 AND harness_slug = $2`;
  if (opts.feature_id) {
    where += ` AND feature_id = $${params.length}`;
    params.splice(params.length - 1, 0, opts.feature_id);
  }
  if (opts.outcome) {
    where += ` AND outcome = $${params.length}`;
    params.splice(params.length - 1, 0, opts.outcome);
  }
  const query = `
    SELECT id::text AS id, feature_id, claimer_pubkey,
           claimer_github_user_id, ts, outcome, detail
      FROM harness_shared.claim_audit
      ${where}
     ORDER BY ts DESC
     LIMIT $${params.length}
  `;
  let rows: RawRow[] = [];
  try {
    rows = await runQuery<RawRow>(query, params);
  } catch {
    return [];
  }
  return rows.map((r) => ({
    id: toNumberOrZero(r.id),
    feature_id: r.feature_id,
    claimer_pubkey: r.claimer_pubkey,
    claimer_github_user_id: toNumberOrZero(r.claimer_github_user_id),
    ts: tsToEpoch(r.ts),
    outcome: r.outcome,
    detail: r.detail,
  }));
}

export interface ClaimAttemptStats {
  total: number;
  won: number;
  lost: number;
  error: number;
}

/**
 * Cheap rollup over the same table for a status pill. Defensive against
 * missing table — returns zeros.
 */
export async function loadClaimAttemptStats(
  opts: Omit<LoadRecentClaimAttemptsOpts, 'limit' | 'feature_id' | 'outcome'>,
): Promise<ClaimAttemptStats> {
  const { workspace_id, harness_slug, runQuery } = opts;
  try {
    const rows = await runQuery<{ outcome: string; n: string | number }>(
      `SELECT outcome, COUNT(*) AS n
         FROM harness_shared.claim_audit
        WHERE workspace_id = $1
          AND harness_slug = $2
        GROUP BY outcome`,
      [workspace_id, harness_slug],
    );
    let won = 0;
    let lost = 0;
    let error = 0;
    for (const r of rows) {
      const n = toNumberOrZero(r.n);
      if (r.outcome === 'won') won += n;
      else if (r.outcome === 'lost') lost += n;
      else if (r.outcome === 'error') error += n;
    }
    return { total: won + lost + error, won, lost, error };
  } catch {
    return { total: 0, won: 0, lost: 0, error: 0 };
  }
}
