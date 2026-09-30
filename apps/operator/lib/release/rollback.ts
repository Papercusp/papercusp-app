/**
 * Standalone rollback — plan release-gate-ready-branch-2026-06-04, D-008.
 *
 * Every deploy is reversible. executeDeploy already auto-rolls-back on a failed
 * swap/migrate/restart/health; THIS is the manual path for "the deploy looked
 * healthy but the fleet is misbehaving" — the release-manager (or a human) runs
 * it to revert the release checkout to the prior commit + restore the pre-deploy
 * snapshot + restart.
 *
 *   tsx rollback.ts                         # PLAN: show what it would revert to
 *   tsx rollback.ts --execute               # revert to the release checkout's PREVIOUS HEAD
 *   tsx rollback.ts --to-sha <sha> --snapshot <kopiaId> --execute
 */

import { releaseConfig, type ReleaseConfig } from './release-config';
import { git } from './git-ops';
import type { DeployDeps, SnapshotInfo } from './deploy';

export interface RollbackResult {
  ok: boolean;
  toSha: string;
  fromSha: string | null;
  restoredSnapshot: boolean;
  error?: string;
}

export async function executeRollback(
  cfg: ReleaseConfig,
  deps: DeployDeps,
  opts: { toSha: string; fromSha: string | null; snapshot?: SnapshotInfo | null },
): Promise<RollbackResult> {
  return deps.withDrain(async (): Promise<RollbackResult> => {
    try {
      deps.log(`↩ reverting release checkout → ${opts.toSha.slice(0, 8)}`);
      await deps.runSetup(opts.toSha);
      let restoredSnapshot = false;
      if (opts.snapshot) {
        await deps.restoreSnapshot(opts.snapshot);
        restoredSnapshot = true;
      }
      await deps.restart();
      const h = await deps.health();
      if (!h.healthy) throw new Error(`post-rollback health failed: ${h.error ?? 'unhealthy'}`);
      await deps.broadcast(
        `↩️ rolled back release checkout to ${opts.toSha.slice(0, 8)}${restoredSnapshot ? ' (+ snapshot restore)' : ''}`,
      );
      return { ok: true, toSha: opts.toSha, fromSha: opts.fromSha, restoredSnapshot };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await deps.broadcast(`⚠️ rollback to ${opts.toSha.slice(0, 8)} FAILED — manual recovery may be needed: ${error}`).catch(() => {});
      return { ok: false, toSha: opts.toSha, fromSha: opts.fromSha, restoredSnapshot: false, error };
    }
  });
}

// CLI
if (require.main === module) {
  const arg = (f: string) => {
    const i = process.argv.indexOf(f);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  (async () => {
    const cfg = releaseConfig();
    const fromSha = await git(cfg.releaseRoot, ['rev-parse', 'HEAD']).catch(() => null);
    // Default rollback target: the release checkout's PREVIOUS HEAD (the prior deploy).
    const toSha = arg('--to-sha') ?? (await git(cfg.releaseRoot, ['rev-parse', 'HEAD@{1}']).catch(() => ''));
    if (!toSha) {
      console.error('[rollback] no --to-sha and no previous release HEAD (reflog) to roll back to');
      process.exit(2);
    }
    const kopiaId = arg('--snapshot');
    const snapshot: SnapshotInfo | null = kopiaId ? { snapshotId: 0, kopiaSnapshotId: kopiaId } : null;

    if (!process.argv.includes('--execute')) {
      console.log(JSON.stringify({ mode: 'plan', fromSha, toSha, restoreSnapshot: !!snapshot }, null, 2));
      console.error('\n[rollback] PLAN ONLY — pass --execute to revert. (Add --snapshot <kopiaId> to also restore the DB.)');
      // NOT process.exit(): it does not drain an async pipe write, so piping the plan
      // would silently truncate it. `return` preserves the early-exit control flow.
      // See scripts/check-undrained-stdout-exit.mjs.
      process.exitCode = 0;
      return;
    }

    const { realDeps } = (await import('./deploy-deps')) as typeof import('./deploy-deps');
    const res = await executeRollback(cfg, realDeps(cfg), { toSha, fromSha, snapshot });
    console.log(JSON.stringify(res, null, 2));
    // NOT process.exit() — see above; this is the last statement, so exitCode alone
    // ends the process with the result fully written.
    process.exitCode = res.ok ? 0 : 1;
  })().catch((e) => {
    console.error('[rollback] FATAL:', e instanceof Error ? e.stack : e);
    process.exit(1);
  });
}
