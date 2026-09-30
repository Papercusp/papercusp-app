/**
 * `system:session-dir-gc` — the periodic janitor for the per-session isolation
 * dirs (`session-claude/`, `session-mcp/`, `su-codex-homes/`, the legacy
 * `role-codex-homes/`) that the launch paths materialize and never clean up. The
 * EI-155 follow-on the unify-launch-mechanics work surfaced; design + safety
 * model live in `session-dir-gc.ts`.
 *
 * Runs as ONE durable step (the system-actions contract) — safe to re-run from
 * the top: the sweep is idempotent (a removed dir simply isn't rediscovered, and
 * removal is `force`), and the protected-set is re-gathered each tick.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `retention_days` — collect a not-live, not-resumable dir once unmaterialized
 *     this long (default 7).
 *   - `dry_run` — plan + log but remove nothing (handy to preview a first run).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { runSessionDirGc, DEFAULT_RETENTION_MS, LEGACY_RETENTION_MS } from '../../session-dir-gc';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

registerSystemAction('session-dir-gc', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const retentionDays = Number(cfg.retention_days);
  // No explicit knob → pick by the archive kill-switch (session-db-archive-
  // retire-dirs P-012): archive ON = deletion is lossless (dirs live in
  // session_archives) so 2h; archive OFF = deletion is lossy again → the
  // legacy 7d window. NOTE: the cadence is now CODE-OWNED in
  // dbos/periodic-workflows.ts (sessionDirGc, hourly @:50) — this routine
  // action remains as a manual/admin lever only.
  const archiveOn = await getFlag(FLAGS.SESSION_ARCHIVE_AT_END, 'system').catch(() => false);
  const retentionMs =
    Number.isFinite(retentionDays) && retentionDays > 0
      ? retentionDays * 24 * 60 * 60 * 1000
      : archiveOn
        ? DEFAULT_RETENTION_MS
        : LEGACY_RETENTION_MS;
  const dryRun = cfg.dry_run === true;

  // The archive guard verifies each collectible dir's sessions are committed to
  // session_archives before deletion. It is meaningful only when the archive is
  // ON; in legacy mode there is no archive to verify against (and retention is
  // the 7d lossy window instead).
  const result = await runSessionDirGc({ retentionMs, dryRun, archiveGuard: archiveOn });
  if (result.skipped) {
    console.warn(`[session-dir-gc] sweep skipped (${result.skipped}) — nothing removed`);
    return;
  }
  console.log(
    `[session-dir-gc] scanned ${result.scanned} dir(s) → ` +
      `${result.dryRun ? 'WOULD remove' : 'removed'} ${result.removed.length}, ` +
      `kept ${result.keptProtected} live/resumable + ${result.keptFresh} within retention` +
      (result.keptUnarchived ? ` + ${result.keptUnarchived} not-yet-archived` : '') +
      (result.errors.length ? `, ${result.errors.length} error(s)` : '') +
      ` (retention ${Math.round(retentionMs / 86_400_000)}d)`,
  );
  if (result.errors.length) {
    for (const e of result.errors) console.warn(`[session-dir-gc]   ! ${e.path}: ${e.error}`);
  }
});
