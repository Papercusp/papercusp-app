/**
 * harness/git-sync/standing-pr-merge-live — the production `standingPrMerge` dep
 * for the pr-host poll daemon (plan pot-review-integration-mode-2026-10-05,
 * P-021 / P-024, D-007 / D-008).
 *
 * It resolves, per call, everything `stepStandingPrMerge` needs and FAILS CLOSED:
 *   - policy: `decideStandingPrMergePolicy`. `upstreamPapercuspManaged` is true by
 *     construction at the only call site — the daemon reaches it only after THIS
 *     install's pr-host agent reviewer reviewed the PR and the auto-review gate
 *     returned approve_and_merge. Not in working-copy (review) mode, or auto-merge
 *     off → `left-for-owner`.
 *   - repoDir: the install's checkout (registry path). `origin` there is the main
 *     repository the standing PR targets; the fork is the separate `pot-fork` remote.
 *   - promotedSha: the checkout's local `main`, which the green gate fast-forwards
 *     only on green. Unreadable → null → the gate refuses `nothing-promoted`.
 *   - suite command: the pot's own suite, `resolvePotSuiteCommand` (owner override →
 *     blueprint releaseGate.greenCmd → testCommand) — the same rule the gate, pot
 *     creation and the integration-mode question use (P-015; WI-10006355). No suite →
 *     outcome `error` (never merge untested code). The merge worktree's dependency
 *     install is decided by `makeWorktreeSuiteRunner`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pr } from '../../pr-host/types';
import { projectDirForSlug } from '../../operator-notes';
import { readPotIntegrationMode, type PotIntegrationModeRead } from './pot-integration-mode';
import {
  decideStandingPrMergePolicy,
  stepStandingPrMerge,
  type StandingPrMergeDeps,
  type StandingPrMergeOutcome,
} from './standing-pr-merge';
import {
  createDefaultStandingPrMergeDeps,
  makeWorktreeSuiteRunner,
  type RunSuite,
  type StandingPrMergeMetaStore,
} from './standing-pr-merge-deps';

let execFilePMemo: typeof execFile.__promisify__ | null = null;
const execFileP = ((...args: unknown[]) =>
  Reflect.apply((execFilePMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;

export interface LiveStandingPrMergeArgs {
  workspaceId: string;
  installSlug: string;
  remote: string;
  pr: Pr;
  /** The pr-host install's auto-merge setting. */
  autoMerge: boolean;
  /** contribution-admission verdict for the PR author. */
  authorRevoked: boolean;
  /** A reviewer chose Merge in the PR viewer; see `StandingPrMergeInput.viewerApproved`. */
  viewerApproved?: boolean;
}

export interface LiveStandingPrMergeResolvers {
  repoDir(installSlug: string, workspaceId: string): Promise<string | null>;
  integration(workspaceId: string, installSlug: string): Promise<PotIntegrationModeRead>;
  promotedSha(repoDir: string): Promise<string | null>;
  /** The pot's suite command, or null when it has none. */
  suiteCommand(installSlug: string, workspaceId: string): Promise<string | null>;
  runSuite(command: string): RunSuite;
  buildDeps(args: { repoDir: string; installSlug: string; prNumber: number; runSuite: RunSuite }): StandingPrMergeDeps;
}

export function makeLiveStandingPrMerge(opts: {
  store: StandingPrMergeMetaStore;
  resolvers?: Partial<LiveStandingPrMergeResolvers>;
  onError?: (err: unknown) => void;
}): (args: LiveStandingPrMergeArgs) => Promise<StandingPrMergeOutcome> {
  const r: LiveStandingPrMergeResolvers = {
    repoDir: (slug, ws) => projectDirForSlug(slug, ws),
    integration: (ws, slug) => readPotIntegrationMode(ws, slug),
    async promotedSha(repoDir) {
      try {
        const { stdout } = await execFileP('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'], {
          cwd: repoDir,
        });
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },
    suiteCommand: async (slug, ws) =>
      (await import('../routines/hive-release-env')).resolvePotSuiteCommand(slug, ws),
    runSuite: (command) => makeWorktreeSuiteRunner(command),
    buildDeps: ({ repoDir, installSlug, prNumber, runSuite }) =>
      createDefaultStandingPrMergeDeps({ repoDir, installSlug, prNumber, store: opts.store, runSuite, onError: opts.onError }),
    ...opts.resolvers,
  };

  return async (args) => {
    try {
      const integration = await r.integration(args.workspaceId, args.installSlug);
      const { policy } = decideStandingPrMergePolicy({
        integration,
        upstreamPapercuspManaged: true,
        autoMergeEnabled: args.autoMerge,
      });
      if (policy === 'owner') return { action: 'left-for-owner' };

      const repoDir = await r.repoDir(args.installSlug, args.workspaceId);
      if (!repoDir) return { action: 'error', detail: `No checkout is registered for ${args.installSlug}.` };
      const command = await r.suiteCommand(args.installSlug, args.workspaceId);
      if (!command) {
        return { action: 'error', detail: `${args.installSlug} has no test suite to run on the merge result; not merging.` };
      }
      await opts.store.ensureRecordRow?.(args.installSlug, args.workspaceId);
      const deps = r.buildDeps({
        repoDir,
        installSlug: args.installSlug,
        prNumber: args.pr.ref.number,
        runSuite: r.runSuite(command),
      });
      return await stepStandingPrMerge(
        {
          pr: args.pr,
          policy,
          promotedSha: await r.promotedSha(repoDir),
          authorRevoked: args.authorRevoked,
          viewerApproved: args.viewerApproved === true,
        },
        deps,
      );
    } catch (err) {
      return { action: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
  };
}
