/**
 * Hyperbee → PG projection for `harness_shared.pot_reports` — the moderation report
 * queue federated member→owner (Brief EN-3 / P-MOD; migration 318).
 *
 * Mirrors projections/hive-settings.ts (scope column `harness_slug` = Hive home_slug).
 * A MEMBER writes a report (origin='local' → federates to the owner's home projection,
 * the moderation queue); the OWNER's resolution (status='actioned'/'dismissed') federates
 * back. Single-column federation key = report_id. The HLC LWW guard orders a report vs
 * its later resolution. created_at/updated_at are machine-local (NOT federated; mirrors
 * hive_settings).
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

/** Wire-shape of a hive_reports row — the federated subset. Defensive: a malformed
 *  remote op is dropped (decodeValue → null). */
export interface ReportWireRow {
  /** The Hive's home_slug — the per-projection demux key. */
  harness_slug: string;
  report_id: string;
  reporter_github_user_id: number;
  reporter_github_username: string | null;
  target_kind: string;
  target_ref: string;
  report_reason: string | null;
  status: string;
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
function isStrOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isReportWireRow(input: unknown): input is ReportWireRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (typeof r.report_id !== 'string' || r.report_id.length === 0) return false;
  if (!isPosInt(r.reporter_github_user_id)) return false;
  if (!isStrOrNull(r.reporter_github_username)) return false;
  if (typeof r.target_kind !== 'string' || r.target_kind.length === 0) return false;
  if (typeof r.target_ref !== 'string' || r.target_ref.length === 0) return false;
  if (!isStrOrNull(r.report_reason)) return false;
  if (typeof r.status !== 'string' || r.status.length === 0) return false;
  return true;
}

export interface HiveReportsProjectionOpts {
  workspaceId: string;
  /** The registered Hive HOME harness slug — the demux scope. */
  harnessSlug: string;
  sql?: postgres.Sql;
}

/** The peer-log key for a report row == report_id (matches the store + the PK col). */
function composeKey(row: ReportWireRow): string {
  return row.report_id;
}

function decodeValue(raw: unknown): ReportWireRow | null {
  return isReportWireRow(raw) ? raw : null;
}

async function writeToPg(
  opts: HiveReportsProjectionOpts,
  row: ReportWireRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return; // cross-Hive op — drop
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  await sql`
    INSERT INTO harness_shared.pot_reports
      (workspace_id, harness_slug, report_id, reporter_github_user_id, reporter_github_username,
       target_kind, target_ref, report_reason, status, author_pubkey, origin, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.report_id}, ${row.reporter_github_user_id},
       ${row.reporter_github_username}, ${row.target_kind}, ${row.target_ref}, ${row.report_reason},
       ${row.status}, ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, harness_slug, report_id) DO UPDATE SET
      reporter_github_username = EXCLUDED.reporter_github_username,
      target_kind              = EXCLUDED.target_kind,
      target_ref               = EXCLUDED.target_ref,
      report_reason            = EXCLUDED.report_reason,
      status                   = EXCLUDED.status,
      author_pubkey            = EXCLUDED.author_pubkey,
      origin                   = EXCLUDED.origin,
      fed_ts                   = EXCLUDED.fed_ts,
      fed_hlc                  = EXCLUDED.fed_hlc
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(harness_shared.pot_reports.fed_hlc, harness_shared.pot_reports.fed_ts)
  `;
}

async function deleteFromPg(
  opts: HiveReportsProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.pot_reports
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND report_id = ${key}
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildHiveReportsProjection(
  opts: HiveReportsProjectionOpts,
): TableProjection<ReportWireRow> {
  return {
    tableTag: 'hive-reports',
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = { composeKey, decodeValue, isReportWireRow };
