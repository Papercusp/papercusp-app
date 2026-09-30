/**
 * `system:oddsmith-error-triage-ingest` — durable replacement for the oddsmith
 * every-14-minutes crontab line (`apps/desktop/scripts/error-triage-cron.sh
 * ingest`).
 *
 * Folds new errors into oddsmith's unified `error_events` log (deterministic,
 * no agent/model call) so its Errors dashboard stays fresh. See
 * `oddsmith-cron-shared.ts` for why this replaces the hand-rolled
 * `cron-alarm.sh` streak file with a plain thrown error, and why an
 * unreachable embedded-pg sidecar is a clean skip rather than a failure (the
 * sidecar watchdog's own fault to report, not this routine's).
 */
import { activeWorkspaceId } from '../../workspace-registry';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import {
  assertRunOk,
  oddsmithDatabaseUrl,
  probeOddsmithPgReachable,
  resolveOddsmithRoot,
  runBounded,
  shouldSkipForOddsmith,
} from './oddsmith-cron-shared';

/** ~5 min — well under the 14-min cadence. */
export const ODDSMITH_ERROR_TRIAGE_INGEST_TIMEOUT_MS = 5 * 60_000;

registerSystemAction('oddsmith-error-triage-ingest', async (ctx: SystemActionCtx) => {
  const gate = shouldSkipForOddsmith(ctx.installSlug);
  if (gate.skip) {
    console.log(`[oddsmith-error-triage-ingest] skip: ${gate.reason}`);
    return;
  }
  if (!(await probeOddsmithPgReachable())) {
    console.log('[oddsmith-error-triage-ingest] skip: oddsmith embedded pg unreachable');
    return;
  }
  const workspaceId = ctx.workspaceId || activeWorkspaceId();
  const root = await resolveOddsmithRoot(workspaceId);
  const env: NodeJS.ProcessEnv = { ...process.env, ODDSMITH_DATABASE_URL: oddsmithDatabaseUrl() };
  const r = await runBounded('npm', ['run', '--silent', 'error-triage', '-w', '@oddsmith/desktop', '--', 'ingest'], {
    cwd: root,
    env,
    timeoutMs: ODDSMITH_ERROR_TRIAGE_INGEST_TIMEOUT_MS,
  });
  assertRunOk('oddsmith-error-triage-ingest', r);
  console.log(`[oddsmith-error-triage-ingest] ok: ${(r.stdout || '').trim().split('\n').slice(-1)[0]}`);
});
