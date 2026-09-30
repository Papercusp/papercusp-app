/**
 * `system:oddsmith-paper-cycle` — durable replacement for the oddsmith
 * every-15-minutes crontab line (`apps/desktop/scripts/paper-cron.sh`).
 *
 * Runs one PAPER-mode market-making cycle on live PUBLIC Polymarket data (NO
 * credentials, NO real money) via `npm run paper-cycle -w @oddsmith/desktop`,
 * feeding the eval loop with a `source:'paper'` eval_run. See
 * `oddsmith-cron-shared.ts` for why this replaces the hand-rolled
 * `cron-alarm.sh` streak file with a plain thrown error (scheduling-and-
 * liveness-source-of-truth-2026-08-31 P-005).
 */
import { activeWorkspaceId } from '../../workspace-registry';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { assertRunOk, resolveOddsmithRoot, runBounded, shouldSkipForOddsmith } from './oddsmith-cron-shared';

/** ~10 min — generous headroom under the 15-min cadence so a wedged run cannot
 *  overlap its own next fire. */
export const ODDSMITH_PAPER_CYCLE_TIMEOUT_MS = 10 * 60_000;

registerSystemAction('oddsmith-paper-cycle', async (ctx: SystemActionCtx) => {
  const gate = shouldSkipForOddsmith(ctx.installSlug);
  if (gate.skip) {
    console.log(`[oddsmith-paper-cycle] skip: ${gate.reason}`);
    return;
  }
  const workspaceId = ctx.workspaceId || activeWorkspaceId();
  const root = await resolveOddsmithRoot(workspaceId);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Same tunables paper-cron.sh set, same defaults — a true continuous paper
    // account (persist=1), not stateless per-run snapshots.
    ODDSMITH_PAPER_TICKS: process.env.ODDSMITH_PAPER_TICKS ?? '10',
    ODDSMITH_PAPER_WATCH: process.env.ODDSMITH_PAPER_WATCH ?? '5',
    ODDSMITH_PAPER_RUN_ID: process.env.ODDSMITH_PAPER_RUN_ID ?? 'paper-mm',
    ODDSMITH_PAPER_PERSIST: process.env.ODDSMITH_PAPER_PERSIST ?? '1',
  };
  const r = await runBounded('npm', ['run', '--silent', 'paper-cycle', '-w', '@oddsmith/desktop'], {
    cwd: root,
    env,
    timeoutMs: ODDSMITH_PAPER_CYCLE_TIMEOUT_MS,
  });
  assertRunOk('oddsmith-paper-cycle', r);
  console.log(`[oddsmith-paper-cycle] ok: ${(r.stdout || '').trim().split('\n').slice(-1)[0]}`);
});
