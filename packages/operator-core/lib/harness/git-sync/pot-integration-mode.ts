/**
 * pot-integration-mode — where a pot's combined agent work goes
 * (plan pot-review-integration-mode-2026-10-05, P-014 / P-015; decisions D-005, D-006, D-007).
 *
 * One per-pot switch, stored in the FEDERATED `hive_settings` store under
 * `hiveGit.integration` (beside `hiveGit.mode`, and deliberately orthogonal to
 * it — D-005: `hiveGit.mode` decides WHO pushes, this decides WHERE the pot's
 * work lands):
 *
 *   - `direct` (DEFAULT, and the value for every pot with no setting): today's
 *     behavior byte for byte — git-sync pushes the pot's repository as before.
 *   - `review` ("into a working copy", D-007): inside the pot nothing changes —
 *     agents share the tree and git-sync commits as today (D-006) — but git-sync
 *     pushes to the POT'S OWN FORK instead of the main repository. The main
 *     repository receives the pot's combined work only through PRs.
 *
 * FAIL DIRECTION (the inverse of `hive-git-mode`'s fail-open, on purpose).
 * `hiveGit.mode` fails OPEN to legacy because a blip silencing a healthy hive's
 * pushes was judged worse than a brief double-push. Here the asymmetry runs the
 * other way: a working-copy pot exists to keep unreviewed work OUT of the main
 * repository, so a store read that throws — or a value nobody can interpret —
 * must never resolve to "push the main repository". {@link resolveIntegrationPushRemote}
 * therefore turns `error` and `malformed` into COMMIT-ONLY (the work stays
 * committed locally and is pushed on the next healthy tick), and only a pot that
 * has NO setting at all (`absent`) or an explicit `direct` keeps today's push.
 * A review pot with no fork configured is commit-only too: it never falls back
 * to the main repository.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { getHiveSetting, setHiveSetting, deleteHiveSetting } from '../../hive-settings-store';
import { parseGithubUrl } from '../clone-github';
import type { EnsureForkOpts, EnsureForkResult } from '../ensure-fork';
import { resolveForkPushTarget, setForkRemote, type SetForkRemoteResult } from './fork-remote';

let execFileAsyncMemo: typeof execFile.__promisify__ | null = null;
const execFileAsync = ((...args: unknown[]) =>
  Reflect.apply((execFileAsyncMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;

/** Where this pot's combined work goes. */
export type PotIntegrationMode = 'direct' | 'review';

/** The federated hive_settings key carrying the mode (D-005). */
export const POT_INTEGRATION_SETTING_KEY = 'hiveGit.integration';

export const POT_INTEGRATION_MODES: readonly PotIntegrationMode[] = ['direct', 'review'] as const;

/** The git remote NAME git-sync uses for a working-copy pot's fork. */
export const POT_FORK_REMOTE_NAME = 'pot-fork';

/** Junk-safe coercion: exactly `review` is review; anything else reads as `direct`. */
export function coercePotIntegrationMode(v: unknown): PotIntegrationMode {
  return v === 'review' ? 'review' : 'direct';
}

/**
 * Why the pot read as the mode it did. Only `set` and `absent` are trustworthy;
 * `malformed` and `error` mean the mode could not be established, and the push
 * resolver refuses to push anywhere for them.
 */
export type PotIntegrationModeSource = 'set' | 'absent' | 'malformed' | 'error';

export interface PotIntegrationModeRead {
  /** Always a usable mode — `direct` whenever the source is not `set`. */
  mode: PotIntegrationMode;
  source: PotIntegrationModeSource;
}

/** Read the pot's integration mode and why it reads that way. Never throws. */
export async function readPotIntegrationMode(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<PotIntegrationModeRead> {
  let rec: Awaited<ReturnType<typeof getHiveSetting>>;
  try {
    rec = await getHiveSetting(workspaceId, potHomeSlug, POT_INTEGRATION_SETTING_KEY, sql);
  } catch {
    return { mode: 'direct', source: 'error' };
  }
  if (!rec || rec.value == null) return { mode: 'direct', source: 'absent' };
  if (rec.value === 'direct' || rec.value === 'review') return { mode: rec.value, source: 'set' };
  return { mode: 'direct', source: 'malformed' };
}

/** What git-sync should do with this tick's push, given the pot's integration mode. */
export type IntegrationPushDecision =
  /** `direct` mode: the existing push logic applies, unchanged. */
  | { kind: 'unchanged'; reason: string }
  /** `review` mode with a fork: push to the fork through the `pot-fork` remote. */
  | { kind: 'fork'; remoteName: typeof POT_FORK_REMOTE_NAME; url: string; reason: string }
  /** Commit locally, push nowhere. Never falls back to the main repository. */
  | {
      kind: 'commit-only';
      reason: 'working_copy_fork_missing' | 'integration_mode_unknown' | 'integration_mode_malformed';
      message: string;
    };

export interface ResolveIntegrationPushInput {
  read: PotIntegrationModeRead;
  /** The pot's fork remote URL (registry `fork_remote`), when configured. */
  forkRemote?: string;
}

/** PURE: decide this tick's push target from the mode read and the fork URL. */
export function resolveIntegrationPushRemote(input: ResolveIntegrationPushInput): IntegrationPushDecision {
  const { read } = input;
  if (read.source === 'error') {
    return {
      kind: 'commit-only',
      reason: 'integration_mode_unknown',
      message:
        'could not read hiveGit.integration (settings store error) — committing locally and pushing nowhere this ' +
        'tick, so a working-copy pot can never leak unreviewed work into the main repository on a read failure',
    };
  }
  if (read.source === 'malformed') {
    return {
      kind: 'commit-only',
      reason: 'integration_mode_malformed',
      message:
        'hiveGit.integration holds an unrecognized value — committing locally and pushing nowhere until it is set ' +
        "to 'direct' or 'review'",
    };
  }
  if (read.mode === 'direct') {
    return {
      kind: 'unchanged',
      reason: read.source === 'set' ? 'integration mode direct (explicit)' : 'integration mode direct (default — not configured)',
    };
  }
  // The fork URL comes through the shared fork-remote seam (P-014). No upstream is
  // passed, so the seam can only answer `fork` or `none`; it can never pick the
  // main repository for a working-copy pot.
  const target = resolveForkPushTarget({ forkRemote: input.forkRemote });
  if (target.target !== 'fork') {
    return {
      kind: 'commit-only',
      reason: 'working_copy_fork_missing',
      message:
        'pot is in working-copy (review) mode but has no fork configured — committing locally and pushing nowhere; ' +
        'the main repository only receives this pot’s work through a PR',
    };
  }
  return {
    kind: 'fork',
    remoteName: POT_FORK_REMOTE_NAME,
    url: target.remote,
    reason: 'working-copy mode — git-sync pushes the pot’s own fork, never the main repository (D-006)',
  };
}

/** The registry fields {@link integrationModeGovernsHarness} reads. */
export interface IntegrationModeHarnessEntry {
  slug: string;
  hive_slug?: string | null;
  self_repo?: boolean | null;
  fork_remote?: string | null;
}

/**
 * PURE (WI-10006333): does the pot's working-copy mode govern THIS harness's push?
 *
 * Working-copy mode protects the pot's SUBJECT repository — the one a working copy
 * (fork) stands in for. A pot member is always governed, fail-closed without a fork.
 * A self_repo pot HOME is governed only when it is itself the subject: when it carries
 * no fork of its own while a member of its pot does, the working copy lives on that
 * member and the home's repo is the pot's own metadata repository, which pushes as
 * usual. Any other home stays governed (fail-closed), so a self-hosted pot whose home
 * IS the subject repo can never leak into it while its fork is missing.
 */
export function integrationModeGovernsHarness(
  entry: IntegrationModeHarnessEntry,
  projects: readonly IntegrationModeHarnessEntry[],
): boolean {
  if (entry.hive_slug) return true;
  if (entry.fork_remote) return true;
  return !projects.some((p) => p.slug !== entry.slug && p.hive_slug === entry.slug && Boolean(p.fork_remote));
}

export type RunGit = (args: string[], cwd: string) => Promise<{ stdout: string }>;

const defaultRunGit: RunGit = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return { stdout };
};

/**
 * Make `<repoPath>`'s `pot-fork` git remote point at `url`: add it when missing,
 * re-point it when it drifted, leave it alone when it already matches.
 */
export async function ensurePotForkGitRemote(
  repoPath: string,
  url: string,
  runGit: RunGit = defaultRunGit,
): Promise<'added' | 'updated' | 'unchanged'> {
  let current: string | null = null;
  try {
    current = (await runGit(['remote', 'get-url', POT_FORK_REMOTE_NAME], repoPath)).stdout.trim();
  } catch {
    current = null;
  }
  if (current === null) {
    await runGit(['remote', 'add', POT_FORK_REMOTE_NAME, url], repoPath);
    return 'added';
  }
  if (current !== url) {
    await runGit(['remote', 'set-url', POT_FORK_REMOTE_NAME, url], repoPath);
    return 'updated';
  }
  return 'unchanged';
}

/** The push-target slice of the git-sync tick config that working-copy mode rewrites. */
export interface IntegrationPushConfig {
  push?: boolean;
  remote?: string;
  pushSubmoduleOrigins?: boolean;
  /**
   * P-016: in working-copy mode, the main repository git-sync merges back into
   * the copy's staging each tick (so the next standing PR shows only new work).
   * Set only on the `fork` path; absent means no sync-back.
   */
  syncBack?: { upstreamRemote: string; upstreamBranch: string };
  /**
   * WI-10006301 (D-011): the branch git-sync commits and pushes. On the `fork`
   * path this is {@link WORKING_COPY_INTEGRATION_BRANCH}, never the release ref.
   */
  branch?: string;
}

/**
 * The main repository's branch the standing PR targets and sync-back absorbs.
 * The pot's green-checkpoint promotes to its own `main` and the standing PR
 * opens against the same-named branch upstream (promotion-push-target.ts).
 */
export const SYNC_BACK_UPSTREAM_BRANCH = 'main';

/**
 * WI-10006301 (plan D-011): the branch a working-copy pot integrates on.
 *
 * git-sync commits and pushes here and sync-back merges the main repository into
 * it; the pot's green gate judges it and promotes it to the copy's `main`, which
 * is the standing PR's head. It must differ from the release ref: a working copy
 * that integrated on `main` itself left its gate permanently "up-to-date"
 * (integration branch == release ref), so nothing was ever promoted and the
 * standing PR never opened (P-023 pilot, pipeline_events 586805).
 */
export const WORKING_COPY_INTEGRATION_BRANCH = 'staging';

/** What {@link ensureWorkingCopyIntegrationBranch} found and did. */
export type IntegrationBranchLayout =
  | { kind: 'on-branch' }
  | { kind: 'attached'; from: string | null; created: boolean; fastForwarded: boolean }
  | { kind: 'conflict'; message: string };

/**
 * Put the working copy's checkout on {@link WORKING_COPY_INTEGRATION_BRANCH}
 * without touching the worktree or the index.
 *
 * Already there: nothing to do. Otherwise the branch is created at HEAD, or an
 * existing branch that is an ancestor of HEAD is fast-forwarded to it, and HEAD
 * is re-pointed with `symbolic-ref`. HEAD's commit never changes, so agents'
 * uncommitted edits are untouched. A branch that is ahead of or diverged from
 * HEAD is a `conflict`: moving it would discard work, so the caller commits
 * locally and pushes nowhere until a person resolves it.
 */
export async function ensureWorkingCopyIntegrationBranch(
  repoPath: string,
  runGit: RunGit = defaultRunGit,
): Promise<IntegrationBranchLayout> {
  const branch = WORKING_COPY_INTEGRATION_BRANCH;
  const ref = `refs/heads/${branch}`;
  const read = async (args: string[]): Promise<string | null> => {
    try {
      return (await runGit(args, repoPath)).stdout.trim();
    } catch {
      return null;
    }
  };
  const current = (await read(['symbolic-ref', '--quiet', '--short', 'HEAD'])) || null;
  if (current === branch) return { kind: 'on-branch' };
  const head = await read(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!head) return { kind: 'conflict', message: `cannot resolve HEAD in ${repoPath}` };
  const existing = (await read(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) || null;
  const on = current ? `'${current}'` : 'a detached HEAD';
  if (existing && existing !== head && (await read(['merge-base', '--is-ancestor', existing, head])) === null) {
    return {
      kind: 'conflict',
      message:
        `local '${branch}' (${existing.slice(0, 12)}) is ahead of or diverged from ${on} (${head.slice(0, 12)}); ` +
        `moving it would discard work`,
    };
  }
  try {
    // The expected old value makes each ref move atomic: all-zeros means "must not exist yet".
    if (existing !== head) await runGit(['update-ref', ref, head, existing ?? '0'.repeat(40)], repoPath);
    await runGit(['symbolic-ref', 'HEAD', ref], repoPath);
  } catch (err) {
    return {
      kind: 'conflict',
      message: `could not move ${on} onto '${branch}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { kind: 'attached', from: current, created: existing === null, fastForwarded: existing !== null && existing !== head };
}

/** What {@link ensureForkIntegrationBranch} found and did. */
export type ForkBranchSeed =
  | { kind: 'present' }
  | { kind: 'seeded'; sha: string }
  /** The fork could not be asked; git-sync's own fetch reports the network error. */
  | { kind: 'unknown'; message: string }
  | { kind: 'failed'; message: string };

/**
 * Make sure the fork has {@link WORKING_COPY_INTEGRATION_BRANCH} before git-sync
 * fetches it.
 *
 * git-sync reconciles by fetching `<remote> <branch>` and treats a missing remote
 * branch as a failed fetch ("cannot reconcile"), deliberately: a mistyped branch
 * must fail rather than silently create one. A fresh fork only has `main`, so the
 * first working-copy tick failed exactly that way (P-023 pilot, 02:58Z). This
 * creates the fork's `staging` at the fork's own `main` tip: a commit the fork
 * already has, so nothing new is published, and git-sync's normal fetch / merge /
 * fast-forward push takes over from there.
 */
export async function ensureForkIntegrationBranch(
  repoPath: string,
  runGit: RunGit = defaultRunGit,
): Promise<ForkBranchSeed> {
  const branch = WORKING_COPY_INTEGRATION_BRANCH;
  const release = SYNC_BACK_UPSTREAM_BRANCH;
  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  try {
    // Fetched before: the remote-tracking ref exists, so the fork has the branch.
    await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${POT_FORK_REMOTE_NAME}/${branch}`], repoPath);
    return { kind: 'present' };
  } catch {
    /* not fetched yet — ask the fork */
  }
  let listed: string;
  try {
    listed = (await runGit(['ls-remote', POT_FORK_REMOTE_NAME, `refs/heads/${branch}`, `refs/heads/${release}`], repoPath))
      .stdout;
  } catch (err) {
    return { kind: 'unknown', message: errText(err) };
  }
  const refs = new Map(
    listed
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols.length === 2)
      .map(([sha, ref]) => [ref, sha] as const),
  );
  if (refs.has(`refs/heads/${branch}`)) return { kind: 'present' };
  const sha = refs.get(`refs/heads/${release}`);
  if (!sha) return { kind: 'failed', message: `the fork has neither '${branch}' nor '${release}' to start from` };
  try {
    try {
      await runGit(['cat-file', '-e', `${sha}^{commit}`], repoPath);
    } catch {
      await runGit(['fetch', POT_FORK_REMOTE_NAME, `refs/heads/${release}`], repoPath);
    }
    await runGit(['push', POT_FORK_REMOTE_NAME, `${sha}:refs/heads/${branch}`], repoPath);
  } catch (err) {
    return { kind: 'failed', message: `could not create the fork's '${branch}' at ${sha.slice(0, 12)}: ${errText(err)}` };
  }
  return { kind: 'seeded', sha };
}

/** Why a working-copy tick commits locally and pushes nowhere. */
export type IntegrationCommitOnlyReason =
  | Extract<IntegrationPushDecision, { kind: 'commit-only' }>['reason']
  | 'working_copy_no_repo_path'
  | 'working_copy_fork_remote_setup_failed'
  | 'working_copy_branch_layout_conflict'
  | 'working_copy_fork_branch_seed_failed';

/** Seams for {@link applyIntegrationPushTarget}; the defaults run real git. */
export interface ApplyIntegrationPushDeps {
  ensureRemote?: (repoPath: string, url: string) => Promise<unknown>;
  ensureBranch?: (repoPath: string) => Promise<IntegrationBranchLayout>;
  ensureForkBranch?: (repoPath: string) => Promise<ForkBranchSeed>;
}

/**
 * pot-review-integration-mode P-014: apply this tick's working-copy push target
 * to the git-sync config, in place.
 *
 * `fork` points the `pot-fork` remote at the fork and pushes there; submodule
 * origins are NOT pushed (they are the main repositories' submodules — pushing
 * them would leak unreviewed work past the PR). `commit-only`, or a fork remote
 * that cannot be set up, commits locally and pushes nowhere. Never falls back to
 * the main repository. Returns the commit-only reason, or null when it pushes.
 *
 * WI-10006301 (D-011): the `fork` path also puts the checkout on
 * {@link WORKING_COPY_INTEGRATION_BRANCH} and sets `cfg.branch` to it, so the
 * pot integrates on `staging` and its gate can promote to `main`. A branch layout
 * it cannot fix safely is commit-only, loudly.
 */
export async function applyIntegrationPushTarget(
  slug: string,
  cfg: IntegrationPushConfig,
  decision: IntegrationPushDecision | undefined,
  repoPath: string | null | undefined,
  deps: ApplyIntegrationPushDeps = {},
): Promise<IntegrationCommitOnlyReason | null> {
  const ensureRemote = deps.ensureRemote ?? ensurePotForkGitRemote;
  const ensureBranch = deps.ensureBranch ?? ((p: string) => ensureWorkingCopyIntegrationBranch(p));
  const ensureForkBranch = deps.ensureForkBranch ?? ((p: string) => ensureForkIntegrationBranch(p));
  if (!decision || decision.kind === 'unchanged') return null;
  const commitOnly = (reason: IntegrationCommitOnlyReason): IntegrationCommitOnlyReason => {
    cfg.push = false;
    cfg.pushSubmoduleOrigins = false;
    return reason;
  };
  if (decision.kind === 'commit-only') {
    console.log(`[git-sync] ${slug}: ${decision.message} (${decision.reason})`);
    return commitOnly(decision.reason);
  }
  if (!repoPath) {
    console.log(`[git-sync] ${slug}: working-copy mode but no checkout path — committing locally, pushing nowhere`);
    return commitOnly('working_copy_no_repo_path');
  }
  try {
    await ensureRemote(repoPath, decision.url);
  } catch (err) {
    console.log(
      `[git-sync] ${slug}: could not set up the ${POT_FORK_REMOTE_NAME} remote ` +
        `(${err instanceof Error ? err.message : String(err)}) — committing locally, pushing nowhere`,
    );
    return commitOnly('working_copy_fork_remote_setup_failed');
  }
  const layout = await ensureBranch(repoPath);
  if (layout.kind === 'conflict') {
    console.log(
      `[git-sync] ${slug}: ⚠ working copy cannot integrate on '${WORKING_COPY_INTEGRATION_BRANCH}' — ` +
        `${layout.message}. Committing locally, pushing nowhere until the branches are reconciled by hand.`,
    );
    return commitOnly('working_copy_branch_layout_conflict');
  }
  if (layout.kind === 'attached') {
    console.log(
      `[git-sync] ${slug}: moved the working copy from ${layout.from ? `'${layout.from}'` : 'a detached HEAD'} ` +
        `onto '${WORKING_COPY_INTEGRATION_BRANCH}'` +
        (layout.created ? ' (created at HEAD)' : layout.fastForwarded ? ' (fast-forwarded to HEAD)' : ''),
    );
  }
  const seed = await ensureForkBranch(repoPath);
  if (seed.kind === 'failed') {
    console.log(
      `[git-sync] ${slug}: ⚠ the fork has no '${WORKING_COPY_INTEGRATION_BRANCH}' branch and it could not be created — ` +
        `${seed.message}. Committing locally, pushing nowhere.`,
    );
    return commitOnly('working_copy_fork_branch_seed_failed');
  }
  if (seed.kind === 'seeded') {
    console.log(
      `[git-sync] ${slug}: created the fork's '${WORKING_COPY_INTEGRATION_BRANCH}' at its '${SYNC_BACK_UPSTREAM_BRANCH}' (${seed.sha.slice(0, 12)})`,
    );
  }
  cfg.branch = WORKING_COPY_INTEGRATION_BRANCH;
  // P-016: capture the main repository's remote BEFORE repointing the push at the
  // fork — sync-back fetches upstream from it and merges into the copy's staging.
  cfg.syncBack = { upstreamRemote: cfg.remote ?? 'origin', upstreamBranch: SYNC_BACK_UPSTREAM_BRANCH };
  cfg.remote = decision.remoteName;
  cfg.pushSubmoduleOrigins = false;
  console.log(`[git-sync] ${slug}: ${decision.reason}`);
  return null;
}

export type SetPotIntegrationModeResult =
  | { ok: true; mode: PotIntegrationMode | null }
  | { ok: false; error: 'green_cmd_required' | 'fork_required' | 'submodules_unsupported'; message: string };

/**
 * WI-10006107: does the pot's checkout use git submodules? Working-copy mode cannot
 * carry them yet: submodule commits are deliberately never pushed to the main
 * repository's submodules (that would leak unreviewed work), and no per-submodule
 * fork exists, so the copy's gitlinks would point at commits that exist nowhere
 * remote. `undefined` when the checkout path is unknown.
 */
export function repoHasSubmodules(checkoutPath: string | null | undefined): boolean | undefined {
  if (!checkoutPath) return undefined;
  return existsSync(join(checkoutPath, '.gitmodules'));
}

/** The plain refusal shown when a repo with submodules asks for a working copy (WI-10006107). */
export const SUBMODULES_UNSUPPORTED_MESSAGE =
  'working-copy mode does not support repositories with submodules yet: their submodule commits would have ' +
  'nowhere reviewable to go, so the working copy and its PR could not be checked out. Keep this pot straight in.';

export interface SetPotIntegrationModeInput {
  workspaceId: string;
  potHomeSlug: string;
  /** `null` clears the setting (the pot reads as default `direct` again). */
  mode: PotIntegrationMode | null;
  /** The pot's resolved green-gate test command (release.greenCmd), if any. */
  greenCmd: string | null | undefined;
  /** The pot's fork remote URL, if one is configured. */
  forkRemote: string | null | undefined;
  /** WI-10006107: the pot's checkout has git submodules ({@link repoHasSubmodules}). */
  hasSubmodules?: boolean;
  sql?: Sql;
}

/**
 * Set the pot's integration mode. Choosing `review` (working copy) is refused
 * unless the pot has a configured green-gate test command (P-015 — "passed the
 * test suite" must never be vacuous) and a fork to push to (the guided switch
 * creates the fork first). An unknown mode throws: a WRITE never coerces.
 */
export async function setPotIntegrationMode(input: SetPotIntegrationModeInput): Promise<SetPotIntegrationModeResult> {
  const { workspaceId, potHomeSlug, mode, sql } = input;
  if (mode === null) {
    await deleteHiveSetting(workspaceId, potHomeSlug, POT_INTEGRATION_SETTING_KEY, sql);
    return { ok: true, mode: null };
  }
  if (!POT_INTEGRATION_MODES.includes(mode)) {
    throw new Error(
      `setPotIntegrationMode: unknown mode '${String(mode)}' (expected ${POT_INTEGRATION_MODES.join(' | ')})`,
    );
  }
  if (mode === 'review') {
    if (input.hasSubmodules === true) {
      return { ok: false, error: 'submodules_unsupported', message: SUBMODULES_UNSUPPORTED_MESSAGE };
    }
    if (!input.greenCmd || !input.greenCmd.trim()) {
      return {
        ok: false,
        error: 'green_cmd_required',
        message:
          'working-copy mode needs a test suite: set the pot’s green-gate test command (release.greenCmd) first, ' +
          'so a PR built from the working copy has really passed tests',
      };
    }
    if (!input.forkRemote) {
      return {
        ok: false,
        error: 'fork_required',
        message: 'working-copy mode needs the pot’s own fork: create or configure the fork first',
      };
    }
  }
  await setHiveSetting({ workspaceId, potHomeSlug, settingKey: POT_INTEGRATION_SETTING_KEY, value: mode }, sql);
  return { ok: true, mode };
}

export type ChoosePotIntegrationModeResult =
  | { ok: true; mode: PotIntegrationMode | null; fork: { url: string; created: boolean } | null }
  | {
      ok: false;
      error:
        | 'green_cmd_required'
        | 'fork_required'
        | 'upstream_remote_required'
        | 'fork_is_main_repository'
        | 'fork_create_failed'
        | 'fork_record_failed'
        | 'standing_pr_open'
        | 'standing_pr_unknown'
        | 'submodules_unsupported';
      message: string;
    };

/** P-019: is the pot's standing PR open on the main repository? `ok:false` = could not tell. */
export type OpenStandingPrLookup =
  | { ok: true; pr: { number: number; url: string } | null }
  | { ok: false; error: string };

export interface ChoosePotIntegrationModeInput extends SetPotIntegrationModeInput {
  /** The pot's registry slug (where `fork_remote` is recorded). */
  harnessSlug: string;
  /** The main repository (registry `github_remote`) the fork is made from. */
  upstreamRemote: string | null | undefined;
}

export interface ChoosePotIntegrationModeDeps {
  ensureFork?: (opts: EnsureForkOpts) => Promise<EnsureForkResult>;
  setForkRemote?: (slug: string, forkUrl: string | null, workspaceId?: string) => Promise<SetForkRemoteResult>;
  setMode?: (input: SetPotIntegrationModeInput) => Promise<SetPotIntegrationModeResult>;
  /** The pot's CURRENT mode (default: readPotIntegrationMode). */
  readMode?: (workspaceId: string, potHomeSlug: string) => Promise<PotIntegrationModeRead>;
  /** Default: the GitHub PR host's open PRs on `upstreamRemote`, through findStandingPr (any base). */
  findOpenStandingPr?: (upstreamRemote: string) => Promise<OpenStandingPrLookup>;
}

async function defaultFindOpenStandingPr(upstreamRemote: string): Promise<OpenStandingPrLookup> {
  try {
    const { createGitHubPrHost } = await import('../../pr-host/github');
    const host = await createGitHubPrHost();
    if (!host) return { ok: false, error: 'GitHub is not connected' };
    const listed = await host.listOpenPrs({ remote: upstreamRemote });
    if (!listed.ok) return { ok: false, error: listed.error.message };
    const { findStandingPr } = await import('./standing-pr');
    const pr = findStandingPr(listed.data);
    return { ok: true, pr: pr ? { number: pr.ref.number, url: pr.url } : null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * P-019 guided switching, the working copy → straight-in half: leaving a working
 * copy while its standing PR is open would strand the work waiting in that PR, so
 * the switch is refused until the PR is merged or closed. Fails CLOSED: when the PR
 * cannot be checked, the switch is refused too. Returns null when the switch may go.
 */
async function guardLeavingWorkingCopy(
  input: ChoosePotIntegrationModeInput,
  deps: ChoosePotIntegrationModeDeps,
): Promise<ChoosePotIntegrationModeResult | null> {
  if (input.mode === 'review') return null;
  const current = await (deps.readMode ?? ((w, p) => readPotIntegrationMode(w, p, input.sql)))(
    input.workspaceId,
    input.potHomeSlug,
  );
  // Only a pot that IS (or may be) a working copy can have work waiting in a standing PR.
  if (current.mode === 'direct' && current.source !== 'error') return null;
  const upstream = input.upstreamRemote ? parseGithubUrl(input.upstreamRemote) : null;
  if (!upstream) return null; // no main repository on GitHub ⇒ no standing PR can exist
  const lookup = await (deps.findOpenStandingPr ?? defaultFindOpenStandingPr)(
    `github.com/${upstream.owner}/${upstream.repo}`,
  );
  if (!lookup.ok) {
    return {
      ok: false,
      error: 'standing_pr_unknown',
      message:
        `couldn't check whether this pot's pull request on ${upstream.owner}/${upstream.repo} is still open ` +
        `(${lookup.error}), so the pot stays in its working copy; try again`,
    };
  }
  if (lookup.pr) {
    return {
      ok: false,
      error: 'standing_pr_open',
      message:
        `pull request #${lookup.pr.number} (${lookup.pr.url}) still holds this pot's work: ` +
        'merge or close it first, then switch to straight in, so no work is stranded in the working copy',
    };
  }
  return null;
}

/**
 * P-014: choose the pot's integration mode. Choosing `review` (working copy)
 * CREATES the pot's fork of the main repository when none is recorded
 * (ensureFork) and records it as the registry `fork_remote` before the mode is
 * set, so git-sync's next tick pushes to the fork. The test-command check runs
 * first, so a refused switch never creates a fork. A fork that resolves to the
 * main repository itself (the signed-in account owns it) is refused: working-copy
 * mode must never push the main repository.
 */
export async function choosePotIntegrationMode(
  input: ChoosePotIntegrationModeInput,
  deps: ChoosePotIntegrationModeDeps = {},
): Promise<ChoosePotIntegrationModeResult> {
  const setMode = deps.setMode ?? setPotIntegrationMode;
  const refused = await guardLeavingWorkingCopy(input, deps);
  if (refused) return refused;
  if (input.mode !== 'review' || input.forkRemote) {
    const r = await setMode(input);
    return r.ok ? { ok: true, mode: r.mode, fork: null } : r;
  }
  if (input.hasSubmodules === true) {
    // Refuse before ensureFork, so a refused switch never creates a fork (WI-10006107).
    return { ok: false, error: 'submodules_unsupported', message: SUBMODULES_UNSUPPORTED_MESSAGE };
  }
  if (!input.greenCmd || !input.greenCmd.trim()) {
    return setMode(input) as Promise<ChoosePotIntegrationModeResult>;
  }
  const upstream = input.upstreamRemote ? parseGithubUrl(input.upstreamRemote) : null;
  if (!upstream) {
    return {
      ok: false,
      error: 'upstream_remote_required',
      message: 'working-copy mode needs the pot’s main repository on GitHub, to fork it',
    };
  }
  const ensure =
    deps.ensureFork ?? (async (o: EnsureForkOpts) => (await import('../ensure-fork')).ensureFork(o));
  let fork: EnsureForkResult;
  try {
    fork = await ensure({ upstreamOwner: upstream.owner, upstreamRepo: upstream.repo });
  } catch (err) {
    return {
      ok: false,
      error: 'fork_create_failed',
      message: `could not create the pot’s fork: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (fork.forkFullName.toLowerCase() === `${upstream.owner}/${upstream.repo}`.toLowerCase()) {
    return {
      ok: false,
      error: 'fork_is_main_repository',
      message:
        `the signed-in GitHub account owns ${upstream.owner}/${upstream.repo}, so it cannot fork it; ` +
        'configure a fork owned by another account or organization',
    };
  }
  const recorded = await (deps.setForkRemote ?? setForkRemote)(
    input.harnessSlug,
    `https://github.com/${fork.forkFullName}.git`,
    input.workspaceId,
  );
  if (!recorded.ok || !recorded.forkRemote) {
    return {
      ok: false,
      error: 'fork_record_failed',
      message: recorded.ok ? 'fork remote was not recorded' : recorded.message,
    };
  }
  const r = await setMode({ ...input, forkRemote: recorded.forkRemote });
  return r.ok ? { ok: true, mode: r.mode, fork: { url: recorded.forkRemote, created: fork.created } } : r;
}
