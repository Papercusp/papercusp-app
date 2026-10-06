/**
 * `system:psu-pty-host-events-ingest` — the registration seam for
 * {@link ingestPsuPtyHostEvents} (psu-pty-turn-boundary-generalization-2026-09-22, P-007).
 *
 * Thin by design, matching `gc-dead-loops-action.ts`: the ingest/GC logic and every safety
 * condition live in `psu-pty-host-events-ingest.ts`; this file only puts it on a cadence.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `row_retention_days`  — override HOST_EVENT_ROW_RETENTION_DAYS_DEFAULT (90).
 *   - `file_retention_days` — override HOST_EVENT_FILE_RETENTION_DAYS_DEFAULT (14).
 *   - `max_files_per_run`   — override HOST_EVENT_MAX_FILES_PER_RUN_DEFAULT (500).
 *   - `dry_run`             — report what would be ingested/deleted, mutating nothing.
 *
 * Workspace-scoped rather than harness-scoped: the JSONL files are keyed by the SESSION that
 * wrote them and a psu session can be working in any pot, so sweeping per-install would strand
 * every file belonging to a pot that no longer runs a routine tick — the same reasoning that
 * makes gc-dead-loops workspace-scoped.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';
import {
  ingestPsuPtyHostEvents,
  type PsuPtyHostEventsIngestOptions,
  type PsuPtyHostEventsIngestResult,
} from './psu-pty-host-events-ingest';
import { recordPtyHostMechanismEpisode, type PtyHostIssueResult, type WedgeIssueDeps } from './pty-host-wedge-issue';

const INTERACTIVE_STALE_HOST_MECHANISM = 'interactive-stale-host-direct-3170';
const ISSUE_DETAILS_LIMIT = 25;

interface InteractiveStaleHostEvidenceRow {
  total_owners: number;
  evidence_digest: string;
  owner_id: string | null;
  ts: Date | string | null;
  mode: string | null;
  loaded: string | null;
  on_disk: string | null;
}

export interface InteractiveStaleHostEvidence {
  /** Bounded host sample used in the issue body. */
  ownerIds: string[];
  /** Full distinct-host population, computed in Postgres. */
  totalOwners: number;
  /** Digest over the latest qualifying persisted row for every owner. */
  digest: string;
  /** Redacted, bounded detail lines; never contain the operator URL or environment. */
  details: string[];
}

/**
 * Read the persisted D-008 refusal class from the ingest table. The JSONB predicates are
 * intentionally exact: a headless `no-reexec-code` gap, a non-3170 pin, or an older row
 * without the closed pin enum must not create this issue. The table's retention sweep bounds
 * the history; Postgres computes the complete owner count and digest while returning at most
 * 25 redacted detail rows.
 */
export async function readInteractiveStaleHostEvidence(
  sql: Sql,
  workspaceId: string,
): Promise<InteractiveStaleHostEvidence> {
  const rows = await sql<InteractiveStaleHostEvidenceRow[]>`
    WITH matching AS MATERIALIZED (
      SELECT DISTINCT ON (owner_id)
             owner_id,
             ts,
             row_digest,
             payload ->> 'mode' AS mode,
             payload ->> 'loaded' AS loaded,
             payload ->> 'onDisk' AS on_disk
        FROM harness_shared.psu_pty_host_events
       WHERE workspace_id = ${workspaceId}
         AND kind = 'host-code-stale'
         AND payload ->> 'notAdoptingReason' = 'interactive-tty'
         AND payload ->> 'bridgeTty' = 'true'
         AND payload ->> 'operatorPin' = 'direct-3170'
       ORDER BY owner_id, ts DESC, row_digest DESC
    ),
    summary AS (
      SELECT COUNT(*)::int AS total_owners,
             md5(COALESCE(string_agg(row_digest, ',' ORDER BY owner_id), '')) AS evidence_digest
        FROM matching
    ),
    recent AS (
      SELECT owner_id, ts, mode, loaded, on_disk
        FROM matching
       ORDER BY ts DESC, owner_id
       LIMIT ${ISSUE_DETAILS_LIMIT}
    )
    SELECT summary.total_owners,
           summary.evidence_digest,
           recent.owner_id,
           recent.ts,
           recent.mode,
           recent.loaded,
           recent.on_disk
      FROM summary
      LEFT JOIN recent ON TRUE
     ORDER BY recent.ts DESC NULLS LAST, recent.owner_id
  `;

  const first = rows[0];
  const totalOwners = Math.max(0, Number(first?.total_owners) || 0);
  const ownerRows = rows.filter((row): row is InteractiveStaleHostEvidenceRow & { owner_id: string; ts: Date | string } =>
    typeof row.owner_id === 'string' && row.owner_id.length > 0 && row.ts !== null,
  );
  const ownerIds = ownerRows.map((row) => row.owner_id);
  const details = ownerRows.map((row) => {
    const date = row.ts instanceof Date ? row.ts : new Date(row.ts);
    const seenAt = Number.isNaN(date.getTime()) ? 'time unavailable' : date.toISOString();
    const loaded = row.loaded ? row.loaded.slice(0, 12) : 'unknown';
    const onDisk = row.on_disk ? row.on_disk.slice(0, 12) : 'unknown';
    const mode = row.mode ? `, mode ${row.mode}` : '';
    return `${row.owner_id} at ${seenAt}: loaded ${loaded}, on-disk ${onDisk}${mode}`;
  });

  return {
    ownerIds,
    totalOwners,
    digest: typeof first?.evidence_digest === 'string' ? first.evidence_digest : '',
    details,
  };
}

/** File the exact interactive direct-:3170 class through the existing P-008 mechanism writer. */
export function fileInteractiveStaleHostIssue(
  evidence: InteractiveStaleHostEvidence,
  deps: WedgeIssueDeps,
  nowIso?: string,
): Promise<PtyHostIssueResult> {
  return recordPtyHostMechanismEpisode(
    {
      mechanism: INTERACTIVE_STALE_HOST_MECHANISM,
      title: 'Interactive psu-pty hosts are serving stale code while pinned to :3170',
      summary:
        'A bridged interactive PTY host recorded stale loaded code and correctly refused host-code adoption ' +
        'to preserve its live TUI while directly pinned to the :3170 staging operator. Restart the full host ' +
        'when practical; this record does not authorize re-executing a bridged TTY.',
      ownerIds: evidence.ownerIds,
      totalOwners: evidence.totalOwners,
      details: evidence.details,
      digest: evidence.digest,
      createdBy: 'system:psu-pty-host-events-ingest',
      foundDuring: 'psu-pty-host-events-ingest',
      sourcePlanSlug: 'psu-pty-turn-boundary-generalization-2026-09-22',
      severity: 'minor',
      ...(nowIso ? { nowIso } : {}),
    },
    deps,
  );
}

export interface PsuPtyHostEventsActionDeps {
  sql?: Sql;
  ingest?: (options: PsuPtyHostEventsIngestOptions) => Promise<PsuPtyHostEventsIngestResult>;
  /** Injection seam for the unit test; production loads the existing issue store lazily. */
  issueDeps?: WedgeIssueDeps;
}

async function issueStoreDeps(): Promise<WedgeIssueDeps> {
  const issues = await import('../../issues-engineer');
  return {
    listIssues: (filter) => issues.listIssues(filter as Parameters<typeof issues.listIssues>[0]),
    createIssue: (input) =>
      issues.createIssue({
        ...input,
        admission: input.admission ?? null,
      } as Parameters<typeof issues.createIssue>[0]),
    commentIssue: (id, body, authorId) => issues.commentIssue(id, body, authorId),
    mergeIssuePayload: (id, patch) => issues.mergeIssuePayload(id, patch),
  };
}

export async function runPsuPtyHostEventsIngestAction(
  ctx: SystemActionCtx,
  deps: PsuPtyHostEventsActionDeps = {},
): Promise<SystemActionResult | void> {
  const cfg = ctx.triggerConfig ?? {};
  const rowRetentionDays = Number(cfg.row_retention_days);
  const fileRetentionDays = Number(cfg.file_retention_days);
  const maxFilesPerRun = Number(cfg.max_files_per_run);
  const sql = deps.sql ?? getOrgPg().sql;
  const dryRun = cfg.dry_run === true;

  const result = await (deps.ingest ?? ingestPsuPtyHostEvents)({
    sql,
    workspaceId: ctx.workspaceId,
    dryRun,
    ...(Number.isFinite(rowRetentionDays) && rowRetentionDays > 0 ? { rowRetentionDays } : {}),
    ...(Number.isFinite(fileRetentionDays) && fileRetentionDays > 0 ? { fileRetentionDays } : {}),
    ...(Number.isFinite(maxFilesPerRun) && maxFilesPerRun > 0 ? { maxFilesPerRun } : {}),
  });

  if (result.rowsInserted > 0 || result.filesDeleted > 0 || result.rowsExpired > 0) {
    console.log(
      `[psu-pty-host-events-ingest] ${result.dryRun ? 'would ingest' : 'ingested'} ` +
        `${result.rowsInserted} row(s) from ${result.filesIngested}/${result.filesScanned} file(s); ` +
        `${result.dryRun ? 'would delete' : 'deleted'} ${result.filesDeleted} file(s) older than ` +
        `${result.fileRetentionDays}d; expired ${result.rowsExpired} row(s) older than ` +
        `${result.rowRetentionDays}d`,
    );
  }

  // Never silent about a file that is old enough to GC but could not be persisted: that is the
  // one state where the sweep is knowingly leaving the population unbounded, and it must be
  // visible rather than inferred from a file count that stops falling.
  if (result.filesRetainedUningested > 0) {
    console.warn(
      `[psu-pty-host-events-ingest] RETAINED ${result.filesRetainedUningested} expired file(s): ` +
        `ingest failed, so deleting them would lose rows that exist nowhere else`,
    );
  }

  const softErrors: string[] = [];
  if (result.ingestErrors > 0) {
    softErrors.push(
      `event ingest had ${result.ingestErrors} insert error(s)` +
        (result.firstIngestError ? ` (${result.firstIngestError})` : ''),
    );
  }

  // A dry run promises no mutations, including issue filing. Read only rows that this or a
  // prior successful ingest actually persisted; never infer them from the JSONL files.
  if (!dryRun) {
    try {
      const evidence = await readInteractiveStaleHostEvidence(sql, ctx.workspaceId);
      if (evidence.totalOwners > 0) {
        const filed = await fileInteractiveStaleHostIssue(
          evidence,
          deps.issueDeps ?? (await issueStoreDeps()),
        );
        if (filed.action === 'created' || filed.action === 'commented') {
          console.log(
            `[psu-pty-host-events-ingest] P-008 ${filed.action} interactive stale-host issue ${filed.id ?? '(id unavailable)'}`,
          );
        } else if (filed.action === 'failed') {
          const message = filed.reason ?? 'unknown issue-store failure';
          console.warn(`[psu-pty-host-events-ingest] P-008 issue filing failed: ${message}`);
          softErrors.push(`P-008 issue filing failed: ${message}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.warn(`[psu-pty-host-events-ingest] P-008 evidence read failed: ${message}`);
      softErrors.push(`P-008 evidence read failed: ${message}`);
    }
  }

  if (softErrors.length > 0) return { softError: softErrors.join('; ') };
}

registerSystemAction('psu-pty-host-events-ingest', (ctx: SystemActionCtx) =>
  runPsuPtyHostEventsIngestAction(ctx),
);
