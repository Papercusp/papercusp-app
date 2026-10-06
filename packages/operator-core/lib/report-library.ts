/**
 * report-library.ts — the owner-facing Reports library store
 * (`harness_shared.report_library` + `harness_shared.report_library_chunks`,
 * migration 1166). Canonical store for plan reports-library-2026-09-15, P-002.
 *
 * ## The three independent axes (plan D-001)
 * A report records three things that are routinely collapsed into one "scope"
 * field. This store keeps them apart because they answer different questions and
 * a single field cannot answer more than one of them:
 *
 *   * ORIGIN (`origin_*`) — where it was WRITTEN. SERVER-STAMPED from the calling
 *     session, never caller-supplied: a caller that can name its own author id can
 *     forge provenance, and provenance is precisely the axis a reader uses to
 *     decide how much to trust the report. Hence `PublishReportInput` has no
 *     author fields — origin arrives in a separate `origin` argument that the tool
 *     layer fills from ctx, so a caller-supplied payload cannot reach it.
 *   * SUBJECT (`subject_*`) — what it is ABOUT. May be entirely outside this
 *     workspace (`subject_kind = 'external'`), which is exactly why it cannot be
 *     folded into origin: "written in pot A" and "about pot B" are both true at
 *     once and a reader needs to filter on either.
 *   * VISIBILITY (`visibility`) — who may READ it. Independent of both: a report
 *     written in pot A about pot B may still be readable workspace-wide.
 *
 * ## Lineage instead of edits (plan D-004)
 * A published body is never edited in place and never hard-deleted, so a citation
 * to a report id stays resolvable forever. A redone report PUBLISHES A NEW ROW
 * carrying `supersedes`, inheriting its predecessor's `lineage_id`; the library
 * lists the latest row per lineage while the full history stays reachable through
 * {@link listReportLineage}. `retired_at` is a SOFT state — a retired report still
 * resolves by id, it just leaves the default list.
 *
 * ## One visibility predicate, one implementation
 * {@link visibleTo} returns a SQL fragment and is the ONLY expression of the
 * visibility rule (R-7). There is deliberately no JavaScript twin that evaluates
 * the same matrix in memory: two implementations of one security rule drift, and
 * the drift is silent in the permissive direction. Every read path composes this
 * fragment instead.
 *
 * Transport-agnostic: every function TAKES the `sql` handle, so the same code
 * serves the live `getOrgPg()` connection and the integration test's testcontainer
 * handle (mirrors code-recipes-store.ts).
 *
 * Server-only.
 */
import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  parseGoalOwnerReportSnapshot, serializeGoalOwnerReportSnapshot,
  type GoalOwnerReportSnapshotV1,
} from '@papercusp/chat-protocol';

/**
 * Hard cap on a stored markdown body (R-1). An over-cap body is REFUSED with its
 * overage, never stored truncated: a silently truncated report is worse than a
 * rejected one, because the reader cannot tell the difference between "the audit
 * ended here" and "the audit was cut off here".
 */
export const REPORT_BODY_MAX_BYTES = 512 * 1024;

/** Mirrors `report_library_kind_allowed`. */
export const REPORT_KINDS = [
  'audit', 'review', 'analysis', 'postmortem', 'status-digest', 'proposal', 'other',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Mirrors `report_library_visibility_allowed`. */
export const REPORT_VISIBILITIES = ['owner', 'pot', 'workspace'] as const;
export type ReportVisibility = (typeof REPORT_VISIBILITIES)[number];

/** Mirrors `report_library_subject_kind_allowed`. */
export const REPORT_SUBJECT_KINDS = [
  'pot', 'plan', 'work_item', 'fleet', 'goal', 'repo', 'external', 'none',
] as const;
export type ReportSubjectKind = (typeof REPORT_SUBJECT_KINDS)[number];

/** What the report is ABOUT — axis 2. */
export interface ReportSubject {
  kind: ReportSubjectKind;
  /** Required for every kind except `none` (mirrors `report_library_subject_ref_present`). */
  ref?: string | null;
  label?: string | null;
}

/**
 * Where the report was WRITTEN — axis 1. SERVER-STAMPED: the tool layer fills
 * this from the calling session's ctx, never from the caller's payload.
 */
export interface ReportOrigin {
  /** The pot the report was written in. */
  harnessSlug?: string | null;
  /** The authoring agent's ownerId. */
  authorOwnerId?: string | null;
  /** A session/turn reference for the write. */
  authorSessionRef?: string | null;
}

export interface PublishReportInput {
  workspaceId: string;
  title: string;
  summary?: string;
  bodyMd?: string;
  /** Optional typed metadata on this existing immutable report row. */
  goalOwnerReport?: GoalOwnerReportSnapshotV1;
  kind?: ReportKind;
  subject?: ReportSubject;
  visibility?: ReportVisibility;
  /** The report id this one replaces; its lineage is inherited. */
  supersedes?: string | null;
  tags?: string[];
  /** `agent` (default) or e.g. `owner` / a backfill marker. */
  source?: string;
}

export interface ReportRecord {
  workspaceId: string;
  reportId: string;
  title: string;
  summary: string;
  bodyMd: string;
  bodySha256: string;
  goalOwnerReport: GoalOwnerReportSnapshotV1 | null;
  kind: ReportKind;
  subject: { kind: ReportSubjectKind; ref: string | null; label: string | null };
  origin: { harnessSlug: string | null; authorOwnerId: string | null; authorSessionRef: string | null };
  visibility: ReportVisibility;
  supersedesReportId: string | null;
  lineageId: string;
  source: string;
  tags: string[];
  publishedAt: string;
  updatedAt: string;
  /** Non-null once retired. The row and its body remain resolvable by id. */
  retiredAt: string | null;
}

/** Who is asking. The human owner sees everything; an agent sees the R-7 matrix. */
export interface ReportViewer {
  /** True for the human owner — sees every report in the workspace. */
  isOwner?: boolean;
  /** The viewing agent's ownerId; matches `author_owner_id` ("reports it authored"). */
  ownerId?: string | null;
  /** The viewing agent's pot; matches `origin_harness_slug` for `pot`-visibility reports. */
  potSlug?: string | null;
}

/** Raised when a body exceeds {@link REPORT_BODY_MAX_BYTES}; carries the overage. */
export class ReportBodyTooLargeError extends Error {
  readonly bytes: number;
  readonly limitBytes: number;
  readonly overageBytes: number;
  constructor(bytes: number) {
    const overage = bytes - REPORT_BODY_MAX_BYTES;
    super(
      `report body is ${bytes} bytes — ${overage} bytes over the ${REPORT_BODY_MAX_BYTES}-byte limit. ` +
        'Refused rather than stored truncated; publish a shorter body or split the report.',
    );
    this.name = 'ReportBodyTooLargeError';
    this.bytes = bytes;
    this.limitBytes = REPORT_BODY_MAX_BYTES;
    this.overageBytes = overage;
  }
}

interface DbRow {
  workspace_id: string;
  report_id: string;
  title: string;
  summary: string;
  body_md: string;
  goal_owner_report: GoalOwnerReportSnapshotV1 | null;
  kind: string;
  subject_kind: string;
  subject_ref: string | null;
  subject_label: string | null;
  origin_harness_slug: string | null;
  author_owner_id: string | null;
  author_session_ref: string | null;
  visibility: string;
  supersedes_report_id: string | null;
  lineage_id: string;
  source: string;
  tags: string[] | null;
  published_at: Date | string;
  updated_at: Date | string;
  retired_at: Date | string | null;
}

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function mapRow(row: DbRow): ReportRecord {
  return {
    workspaceId: row.workspace_id,
    reportId: row.report_id,
    title: row.title,
    summary: row.summary ?? '',
    bodyMd: row.body_md ?? '',
    bodySha256: reportBodySha256(row.body_md ?? ''),
    goalOwnerReport: row.goal_owner_report ?? null,
    kind: row.kind as ReportKind,
    subject: {
      kind: row.subject_kind as ReportSubjectKind,
      ref: row.subject_ref,
      label: row.subject_label,
    },
    origin: {
      harnessSlug: row.origin_harness_slug,
      authorOwnerId: row.author_owner_id,
      authorSessionRef: row.author_session_ref,
    },
    visibility: row.visibility as ReportVisibility,
    supersedesReportId: row.supersedes_report_id,
    lineageId: row.lineage_id,
    source: row.source,
    tags: row.tags ?? [],
    publishedAt: toIso(row.published_at),
    updatedAt: toIso(row.updated_at),
    retiredAt: row.retired_at == null ? null : toIso(row.retired_at),
  };
}

/** Every mapped column, so DISTINCT ON subqueries and plain selects agree. */
const SELECT_COLS = `
  workspace_id, report_id, title, summary, body_md, kind,
  subject_kind, subject_ref, subject_label,
  origin_harness_slug, author_owner_id, author_session_ref,
  visibility, supersedes_report_id, lineage_id, source, tags,
  published_at, updated_at, retired_at, goal_owner_report`;

/** SHA-256 of the exact persisted UTF-8 body; no trimming or normalization. */
export const reportBodySha256 = (bodyMd: string): string =>
  createHash('sha256').update(bodyMd, 'utf8').digest('hex');

const clampLimit = (limit?: number): number =>
  Math.max(1, Math.min(Math.trunc(limit ?? 50), 200));

function requireOneOf<T extends string>(
  value: T | undefined, allowed: readonly T[], fallback: T, field: string,
): T {
  const v = (value ?? fallback) as T;
  if (!allowed.includes(v)) {
    throw new Error(`invalid report ${field} ${JSON.stringify(v)}; expected one of ${allowed.join(', ')}`);
  }
  return v;
}

function normalizeSubject(subject: ReportSubject | undefined): {
  kind: ReportSubjectKind; ref: string | null; label: string | null;
} {
  const kind = requireOneOf(subject?.kind, REPORT_SUBJECT_KINDS, 'none', 'subject.kind');
  const ref = subject?.ref?.trim() || null;
  const label = subject?.label?.trim() || null;
  // Enforced in JS as well as by `report_library_subject_ref_present` so the
  // caller gets a field-named error instead of a raw constraint violation.
  if (kind !== 'none' && !ref) {
    throw new Error(`report subject.ref is required when subject.kind is ${JSON.stringify(kind)}`);
  }
  return { kind, ref, label };
}

/**
 * The visibility rule (R-7), as a composable SQL fragment — the single gate on
 * every read path.
 *
 * The owner sees everything. A non-owner agent sees exactly:
 *   - every `workspace` report,
 *   - `pot` reports whose ORIGIN pot is the agent's own pot,
 *   - every report it authored — which is also what lets an author still read
 *     back its own `owner`-visibility report.
 *
 * A viewer with no ownerId/potSlug therefore sees `workspace` reports only; the
 * `FALSE` branches are explicit because `col = NULL` is NULL, not false, and a
 * NULL inside an OR is far easier to misread than a literal.
 */
export function visibleTo(sql: postgres.Sql, viewer: ReportViewer) {
  if (viewer.isOwner) return sql`TRUE`;
  const ownerId = viewer.ownerId?.trim() || null;
  const potSlug = viewer.potSlug?.trim() || null;
  return sql`(
    visibility = 'workspace'
    OR ${potSlug ? sql`(visibility = 'pot' AND origin_harness_slug = ${potSlug})` : sql`FALSE`}
    OR ${ownerId ? sql`author_owner_id = ${ownerId}` : sql`FALSE`}
  )`;
}

/**
 * Publish a report and return the stored row (R-1).
 *
 * `origin` is a separate argument rather than a field of `input` so that a
 * caller-supplied payload structurally cannot set it.
 *
 * Lineage (R-3): without `supersedes` the report roots its own lineage; with it,
 * the predecessor's `lineage_id` is inherited so the whole chain collapses to one
 * library entry. Superseding an unknown id is an error rather than a silent new
 * lineage — that would quietly orphan the history the caller meant to extend.
 */
export async function publishReport(
  sql: postgres.Sql,
  input: PublishReportInput,
  origin: ReportOrigin = {},
): Promise<ReportRecord> {
  const title = input.title?.trim() ?? '';
  if (!title) throw new Error('report title is required');
  if (!input.workspaceId) throw new Error('report workspaceId is required');

  const snapshot = input.goalOwnerReport === undefined ? null : parseGoalOwnerReportSnapshot(input.goalOwnerReport);
  if (input.goalOwnerReport !== undefined && !snapshot) throw new Error('invalid report goalOwnerReport');
  if (snapshot && snapshot.workspaceId !== input.workspaceId) throw new Error('invalid report snapshot workspaceId');
  if (snapshot && input.subject && (input.subject.kind !== 'goal' || input.subject.ref !== snapshot.goalId)) {
    throw new Error('invalid report snapshot subject');
  }
  const canonicalBody = snapshot ? serializeGoalOwnerReportSnapshot(snapshot) : null;
  if (canonicalBody !== null && input.bodyMd !== undefined && input.bodyMd !== canonicalBody) {
    throw new Error('invalid report snapshot bodyMd: must match the canonical serialization');
  }
  const bodyMd = canonicalBody ?? input.bodyMd ?? '';
  const bytes = Buffer.byteLength(bodyMd, 'utf8');
  if (bytes > REPORT_BODY_MAX_BYTES) throw new ReportBodyTooLargeError(bytes);

  const kind = requireOneOf(input.kind, REPORT_KINDS, 'audit', 'kind');
  const visibility = requireOneOf(input.visibility, REPORT_VISIBILITIES, 'owner', 'visibility');
  const subject = normalizeSubject(snapshot ? { ...input.subject, kind: 'goal', ref: snapshot.goalId } : input.subject);

  const reportId = `rpt_${randomUUID()}`;
  let lineageId = reportId;
  let supersedes: string | null = null;

  const supersedesId = input.supersedes?.trim() || null;
  if (supersedesId) {
    const [prev] = await sql<{ report_id: string; lineage_id: string }[]>`
      SELECT report_id, lineage_id
        FROM harness_shared.report_library
       WHERE workspace_id = ${input.workspaceId} AND report_id = ${supersedesId}`;
    if (!prev) {
      throw new Error(
        `cannot supersede ${JSON.stringify(supersedesId)}: no such report in workspace ${input.workspaceId}`,
      );
    }
    lineageId = prev.lineage_id;
    supersedes = prev.report_id;
  }

  const [row] = await sql<DbRow[]>`
    INSERT INTO harness_shared.report_library (
      workspace_id, report_id, title, summary, body_md, kind,
      subject_kind, subject_ref, subject_label,
      origin_harness_slug, author_owner_id, author_session_ref,
      visibility, supersedes_report_id, lineage_id, source, tags, goal_owner_report
    ) VALUES (
      ${input.workspaceId}, ${reportId}, ${title}, ${input.summary?.trim() ?? ''}, ${bodyMd}, ${kind},
      ${subject.kind}, ${subject.ref}, ${subject.label},
      ${origin.harnessSlug ?? null}, ${origin.authorOwnerId ?? null}, ${origin.authorSessionRef ?? null},
      ${visibility}, ${supersedes}, ${lineageId}, ${input.source ?? 'agent'}, ${input.tags ?? []}::text[],
      ${snapshot === null ? null : sql.json(snapshot as unknown as postgres.JSONValue)}
    )
    RETURNING ${sql.unsafe(SELECT_COLS)}`;
  return mapRow(row);
}

/**
 * Resolve one report by id. Deliberately does NOT filter retired rows: retirement
 * is a soft state and a citation to a report id must keep resolving (R-3).
 * Pass `viewer` to gate the read; omit it only on server-internal paths.
 */
export async function getReport(
  sql: postgres.Sql,
  workspaceId: string,
  reportId: string,
  viewer?: ReportViewer,
): Promise<ReportRecord | null> {
  const gate = viewer ? visibleTo(sql, viewer) : sql`TRUE`;
  const [row] = await sql<DbRow[]>`
    SELECT ${sql.unsafe(SELECT_COLS)}
      FROM harness_shared.report_library
     WHERE workspace_id = ${workspaceId} AND report_id = ${reportId} AND ${gate}`;
  return row ? mapRow(row) : null;
}

export interface ListReportsOptions {
  workspaceId: string;
  /** Gate the read. Omit ONLY on server-internal paths that must see everything. */
  viewer?: ReportViewer;
  kind?: ReportKind;
  /** Filter by what the reports are ABOUT. */
  subject?: { kind: ReportSubjectKind; ref?: string | null };
  /** Filter by the pot a report was WRITTEN in. */
  originHarnessSlug?: string;
  /** Rows must carry ALL of these tags. */
  tags?: string[];
  /** Include soft-retired rows (default false). */
  includeRetired?: boolean;
  /** Show only the newest row per lineage (default true). */
  collapseLineage?: boolean;
  limit?: number;
}

/**
 * The library list: newest first, one entry per lineage by default (R-3), gated
 * by {@link visibleTo}.
 */
export async function listReports(
  sql: postgres.Sql,
  opts: ListReportsOptions,
): Promise<ReportRecord[]> {
  const gate = opts.viewer ? visibleTo(sql, opts.viewer) : sql`TRUE`;
  const filters = sql`
    ${opts.includeRetired ? sql`` : sql`AND retired_at IS NULL`}
    ${opts.kind ? sql`AND kind = ${opts.kind}` : sql``}
    ${opts.subject?.kind ? sql`AND subject_kind = ${opts.subject.kind}` : sql``}
    ${opts.subject?.ref ? sql`AND subject_ref = ${opts.subject.ref}` : sql``}
    ${opts.originHarnessSlug ? sql`AND origin_harness_slug = ${opts.originHarnessSlug}` : sql``}
    ${opts.tags?.length ? sql`AND tags @> ${opts.tags}::text[]` : sql``}`;

  // DISTINCT ON needs its own ORDER BY (lineage first), so the caller-facing
  // recency order is applied by the outer select.
  const rows =
    opts.collapseLineage === false
      ? await sql<DbRow[]>`
          SELECT ${sql.unsafe(SELECT_COLS)}
            FROM harness_shared.report_library
           WHERE workspace_id = ${opts.workspaceId} AND ${gate} ${filters}
           ORDER BY published_at DESC, report_id DESC
           LIMIT ${clampLimit(opts.limit)}`
      : await sql<DbRow[]>`
          SELECT * FROM (
            SELECT DISTINCT ON (lineage_id) ${sql.unsafe(SELECT_COLS)}
              FROM harness_shared.report_library
             WHERE workspace_id = ${opts.workspaceId} AND ${gate} ${filters}
             ORDER BY lineage_id, published_at DESC, report_id DESC
          ) latest
           ORDER BY published_at DESC, report_id DESC
           LIMIT ${clampLimit(opts.limit)}`;
  return rows.map(mapRow);
}

/**
 * The full history behind one library entry, newest first (R-3). Retired rows are
 * included: the history is the record, and hiding a retired step would make the
 * chain read as if it never happened.
 */
export async function listReportLineage(
  sql: postgres.Sql,
  workspaceId: string,
  lineageId: string,
  viewer?: ReportViewer,
): Promise<ReportRecord[]> {
  const gate = viewer ? visibleTo(sql, viewer) : sql`TRUE`;
  const rows = await sql<DbRow[]>`
    SELECT ${sql.unsafe(SELECT_COLS)}
      FROM harness_shared.report_library
     WHERE workspace_id = ${workspaceId} AND lineage_id = ${lineageId} AND ${gate}
     ORDER BY published_at DESC, report_id DESC`;
  return rows.map(mapRow);
}

export interface SearchReportsOptions {
  workspaceId: string;
  /** Free text, parsed by `websearch_to_tsquery` (quoted phrases, OR, -negation). */
  query: string;
  /** Gate the read. Omit ONLY on server-internal paths that must see everything. */
  viewer?: ReportViewer;
  kind?: ReportKind;
  includeRetired?: boolean;
  /** Show only the newest row per lineage (default true). */
  collapseLineage?: boolean;
  limit?: number;
}

export interface ReportSearchHit {
  report: ReportRecord;
  /** `ts_rank` against the weighted `search_tsv`; higher is a better match. */
  rank: number;
}

/**
 * Full-text search over the library, gated by {@link visibleTo}.
 *
 * Ranking rides the STORED generated `search_tsv` column (migration 1166), which
 * weights title > summary/subject_label > body. Searching the generated column
 * rather than re-deriving a tsvector here keeps one definition of "what a report's
 * searchable text is": a second `to_tsvector(...)` expression in this file would
 * silently diverge from the index and quietly stop using it.
 *
 * With `collapseLineage` (the default) the newest row per lineage is selected FIRST
 * and ranked second, so the library never offers a superseded body as a hit — the
 * same "latest per lineage" contract {@link listReports} presents (R-3).
 */
export async function searchReports(
  sql: postgres.Sql,
  opts: SearchReportsOptions,
): Promise<ReportSearchHit[]> {
  const gate = opts.viewer ? visibleTo(sql, opts.viewer) : sql`TRUE`;
  const tsq = sql`websearch_to_tsquery('english', ${opts.query})`;
  const filters = sql`
    ${opts.includeRetired ? sql`` : sql`AND retired_at IS NULL`}
    ${opts.kind ? sql`AND kind = ${opts.kind}` : sql``}`;

  type RankedRow = DbRow & { rank: number | string };
  const rows =
    opts.collapseLineage === false
      ? await sql<RankedRow[]>`
          SELECT ${sql.unsafe(SELECT_COLS)}, ts_rank(search_tsv, ${tsq}) AS rank
            FROM harness_shared.report_library
           WHERE workspace_id = ${opts.workspaceId} AND ${gate}
             AND search_tsv @@ ${tsq} ${filters}
           ORDER BY rank DESC, published_at DESC, report_id DESC
           LIMIT ${clampLimit(opts.limit)}`
      : await sql<RankedRow[]>`
          SELECT * FROM (
            SELECT DISTINCT ON (lineage_id) ${sql.unsafe(SELECT_COLS)},
                   ts_rank(search_tsv, ${tsq}) AS rank
              FROM harness_shared.report_library
             WHERE workspace_id = ${opts.workspaceId} AND ${gate}
               AND search_tsv @@ ${tsq} ${filters}
             ORDER BY lineage_id, published_at DESC, report_id DESC
          ) latest
           ORDER BY rank DESC, published_at DESC, report_id DESC
           LIMIT ${clampLimit(opts.limit)}`;
  return rows.map((row) => ({ report: mapRow(row), rank: Number(row.rank) }));
}

/**
 * Soft-retire a report: it leaves the default list but stays resolvable by id and
 * keeps its body. Idempotent — re-retiring preserves the original `retired_at` so
 * the timestamp still means "when it was retired".
 *
 * Returns the updated record, or null when no such report exists.
 */
export async function retireReport(
  sql: postgres.Sql,
  workspaceId: string,
  reportId: string,
): Promise<ReportRecord | null> {
  const [row] = await sql<DbRow[]>`
    UPDATE harness_shared.report_library
       SET retired_at = COALESCE(retired_at, now()), updated_at = now()
     WHERE workspace_id = ${workspaceId} AND report_id = ${reportId}
     RETURNING ${sql.unsafe(SELECT_COLS)}`;
  return row ? mapRow(row) : null;
}
