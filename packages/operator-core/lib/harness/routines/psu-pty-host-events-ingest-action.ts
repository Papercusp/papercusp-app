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
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { ingestPsuPtyHostEvents } from './psu-pty-host-events-ingest';

registerSystemAction('psu-pty-host-events-ingest', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const rowRetentionDays = Number(cfg.row_retention_days);
  const fileRetentionDays = Number(cfg.file_retention_days);
  const maxFilesPerRun = Number(cfg.max_files_per_run);

  const result = await ingestPsuPtyHostEvents({
    workspaceId: ctx.workspaceId,
    dryRun: cfg.dry_run === true,
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
});
