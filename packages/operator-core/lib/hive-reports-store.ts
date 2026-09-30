/**
 * hive-reports-store — PG access to harness_shared.pot_reports, the moderation
 * report queue (Brief EN-3 / P-MOD; migration 318).
 *
 * Any admitted MEMBER files a report against content or another member; the report
 * is written origin='local' on the reporter's box and federates over the hive-home
 * seam to the OWNER's moderation queue. The owner actions ('actioned') or dismisses
 * ('dismissed') it; the resolution federates back. Reports go member→owner (the
 * member is the writer), which is why they can't ride the owner-SIGNED policy and
 * need this separate federated table.
 *
 * report_id is the single-column federation key (caller-minted, globally unique;
 * the store mints a uuid when absent). Crypto-free + PG-only; explicit
 * `WHERE workspace_id = $1` (RLS backstop, D-004); every fn takes an optional `sql`.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

export type ReportTargetKind = 'content' | 'member';
export type ReportStatus = 'open' | 'actioned' | 'dismissed';

export interface ReportRecord {
  workspaceId: string;
  potHomeSlug: string;
  reportId: string;
  reporterGithubUserId: number;
  reporterGithubUsername: string | null;
  targetKind: ReportTargetKind;
  /** content ref (feature/work-item id) or the reported member's github id. */
  targetRef: string;
  reportReason: string | null;
  status: ReportStatus;
  createdAt: number;
  updatedAt: number;
}

export interface FileReportInput {
  workspaceId: string;
  potHomeSlug: string;
  /** Optional caller-minted id (for idempotency); a uuid is generated when absent. */
  reportId?: string;
  reporterGithubUserId: number;
  reporterGithubUsername?: string | null;
  targetKind: ReportTargetKind;
  targetRef: string;
  reportReason?: string | null;
}

interface ReportPgRow {
  workspace_id: string;
  harness_slug: string;
  report_id: string;
  reporter_github_user_id: string | number;
  reporter_github_username: string | null;
  target_kind: string;
  target_ref: string;
  report_reason: string | null;
  status: string;
  created_at: string | number;
  updated_at: string | number;
}

function num(v: string | number): number {
  return typeof v === 'number' ? v : Number(v);
}

function rowToRecord(r: ReportPgRow): ReportRecord {
  return {
    workspaceId: r.workspace_id,
    potHomeSlug: r.harness_slug,
    reportId: r.report_id,
    reporterGithubUserId: num(r.reporter_github_user_id),
    reporterGithubUsername: r.reporter_github_username,
    targetKind: (r.target_kind as ReportTargetKind) ?? 'content',
    targetRef: r.target_ref,
    reportReason: r.report_reason,
    status: (r.status as ReportStatus) ?? 'open',
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

const COLS = `workspace_id, harness_slug, report_id, reporter_github_user_id,
  reporter_github_username, target_kind, target_ref, report_reason, status,
  created_at, updated_at`;

/** File a moderation report (status='open'). Idempotent on report_id. */
export async function fileReport(input: FileReportInput, sql?: Sql): Promise<ReportRecord> {
  const reportId = input.reportId ?? randomUUID();
  const rows = (await pg(sql).unsafe(
    `INSERT INTO harness_shared.pot_reports
       (workspace_id, harness_slug, report_id, reporter_github_user_id,
        reporter_github_username, target_kind, target_ref, report_reason, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open')
     ON CONFLICT (workspace_id, harness_slug, report_id) DO UPDATE SET
       report_reason = EXCLUDED.report_reason,
       updated_at    = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
     RETURNING ${COLS}`,
    [
      input.workspaceId,
      input.potHomeSlug,
      reportId,
      input.reporterGithubUserId,
      input.reporterGithubUsername ?? null,
      input.targetKind,
      input.targetRef,
      input.reportReason ?? null,
    ],
  )) as unknown as ReportPgRow[];
  return rowToRecord(rows[0]);
}

/** Get one report. */
export async function getReport(
  workspaceId: string,
  potHomeSlug: string,
  reportId: string,
  sql?: Sql,
): Promise<ReportRecord | null> {
  const rows = (await pg(sql).unsafe(
    `SELECT ${COLS} FROM harness_shared.pot_reports
      WHERE workspace_id = $1 AND harness_slug = $2 AND report_id = $3 LIMIT 1`,
    [workspaceId, potHomeSlug, reportId],
  )) as unknown as ReportPgRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * List a Hive's reports — the owner moderation queue. Default status='open'; pass
 * status=null for the full history. Newest first.
 */
export async function listReports(
  workspaceId: string,
  potHomeSlug: string,
  opts: { status?: ReportStatus | null } = {},
  sql?: Sql,
): Promise<ReportRecord[]> {
  const status = opts.status === undefined ? 'open' : opts.status;
  const rows = (await pg(sql).unsafe(
    status == null
      ? `SELECT ${COLS} FROM harness_shared.pot_reports
           WHERE workspace_id = $1 AND harness_slug = $2
           ORDER BY created_at DESC`
      : `SELECT ${COLS} FROM harness_shared.pot_reports
           WHERE workspace_id = $1 AND harness_slug = $2 AND status = $3
           ORDER BY created_at DESC`,
    status == null ? [workspaceId, potHomeSlug] : [workspaceId, potHomeSlug, status],
  )) as unknown as ReportPgRow[];
  return rows.map(rowToRecord);
}

/**
 * Count reports filed by one reporter in a Hive since `sinceMs` (epoch ms) —
 * WI-567 (report-spam abuse vector): the caller (pot:report) uses this to rate-gate
 * a single reporter hammering the queue. Counts across ALL statuses (a spammer
 * dismissed-and-refiled still consumed queue attention).
 */
export async function countReportsSince(
  workspaceId: string,
  potHomeSlug: string,
  reporterGithubUserId: number,
  sinceMs: number,
  sql?: Sql,
): Promise<number> {
  const rows = (await pg(sql).unsafe(
    `SELECT count(*)::int AS n FROM harness_shared.pot_reports
      WHERE workspace_id = $1 AND harness_slug = $2 AND reporter_github_user_id = $3
        AND created_at >= $4`,
    [workspaceId, potHomeSlug, reporterGithubUserId, sinceMs],
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/** Owner resolves a report ('actioned' | 'dismissed'). Federates back. */
export async function setReportStatus(
  workspaceId: string,
  potHomeSlug: string,
  reportId: string,
  status: Exclude<ReportStatus, 'open'>,
  sql?: Sql,
): Promise<ReportRecord | null> {
  const rows = (await pg(sql).unsafe(
    `UPDATE harness_shared.pot_reports
        SET status = $4, updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
      WHERE workspace_id = $1 AND harness_slug = $2 AND report_id = $3
      RETURNING ${COLS}`,
    [workspaceId, potHomeSlug, reportId, status],
  )) as unknown as ReportPgRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}
