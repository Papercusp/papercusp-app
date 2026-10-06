/**
 * pot-review-integration-mode P-016 (D-006/D-007): SYNC-BACK.
 *
 * A working-copy ("review") pot pushes its own fork; the main repository only
 * receives work through the standing PR. When the main repository's `main` moves —
 * including when it merges OUR standing PR — the working copy must absorb it, or
 * the next PR re-lists already-merged commits and drifts further from upstream.
 *
 * In review mode `applyIntegrationPushTarget` repoints `cfg.remote` at the fork
 * (`pot-fork`), so `origin` still names the MAIN repository. Sync-back therefore
 * fetches `origin/<mainBranch>` and merges it into the copy's integration branch.
 *
 * A conflict is aborted to a clean tree and reported (never left half-merged, never
 * resolved by picking a side): the caller turns it into a fix-it work-item in the pot.
 */

export type SyncBackRunGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface SyncBackConfig {
  /** Remote naming the MAIN repository (`origin` in review mode). */
  upstreamRemote: string;
  /** The main repository's integration target, normally `main`. */
  upstreamBranch: string;
}

export type SyncBackDecision =
  | { action: 'skip'; reason: string }
  | { action: 'up-to-date'; upstreamSha: string }
  | { action: 'merge'; upstreamSha: string };

/** Pure: what sync-back should do given what git reported. */
export function decideSyncBack(input: {
  /** Only the copy's integration branch (staging) absorbs upstream. */
  currentBranch: string;
  integrationBranch: string;
  /** Resolved upstream tip after the fetch, or null when it could not be resolved. */
  upstreamSha: string | null;
  /** `git merge-base --is-ancestor upstream HEAD` succeeded. */
  upstreamIsAncestorOfHead: boolean;
}): SyncBackDecision {
  if (input.currentBranch !== input.integrationBranch) {
    return {
      action: 'skip',
      reason: `on '${input.currentBranch}', not the integration branch '${input.integrationBranch}'`,
    };
  }
  if (!input.upstreamSha) return { action: 'skip', reason: 'upstream tip could not be resolved' };
  if (input.upstreamIsAncestorOfHead) return { action: 'up-to-date', upstreamSha: input.upstreamSha };
  return { action: 'merge', upstreamSha: input.upstreamSha };
}

export type SyncBackResult =
  | { status: 'skipped'; reason: string }
  | { status: 'up-to-date'; upstreamSha: string }
  | { status: 'merged'; upstreamSha: string; mergedSha: string }
  | { status: 'conflict'; upstreamSha: string; conflictedFiles: string[] }
  | { status: 'error'; message: string };

const detail = (r: { code: number; stdout: string; stderr: string }): string =>
  (r.stderr.trim() || r.stdout.trim() || `git exited with code ${r.code}`).slice(0, 300);

/**
 * Fetch the main repository's branch and merge it into the current branch when it is
 * not already contained. Never leaves the tree mid-merge.
 */
export async function runSyncBack(
  runGit: SyncBackRunGit,
  repoPath: string,
  opts: SyncBackConfig & {
    integrationBranch: string;
    /** Network leg (fetch); defaults to `runGit`. git-sync passes its HTTPS-fallback runner. */
    runNetworkGit?: SyncBackRunGit;
    /** Identity args for the merge commit (`-c user.name=… -c user.email=…`). */
    identityArgs?: string[];
    log?: (message: string) => void;
  },
): Promise<SyncBackResult> {
  const network = opts.runNetworkGit ?? runGit;
  const log = opts.log ?? (() => {});
  const upstreamRef = `refs/remotes/${opts.upstreamRemote}/${opts.upstreamBranch}`;

  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  if (branch.code !== 0) return { status: 'error', message: `could not read current branch: ${detail(branch)}` };
  const currentBranch = branch.stdout.trim();
  if (currentBranch !== opts.integrationBranch) {
    const d = decideSyncBack({
      currentBranch,
      integrationBranch: opts.integrationBranch,
      upstreamSha: null,
      upstreamIsAncestorOfHead: false,
    });
    return { status: 'skipped', reason: d.action === 'skip' ? d.reason : 'not the integration branch' };
  }

  const fetched = await network(
    ['fetch', '--no-tags', opts.upstreamRemote, `+refs/heads/${opts.upstreamBranch}:${upstreamRef}`],
    repoPath,
  );
  if (fetched.code !== 0) {
    return { status: 'error', message: `sync-back fetch of ${opts.upstreamRemote}/${opts.upstreamBranch} failed: ${detail(fetched)}` };
  }
  const resolved = await runGit(['rev-parse', '--verify', '--quiet', `${upstreamRef}^{commit}`], repoPath);
  const upstreamSha = resolved.code === 0 ? resolved.stdout.trim() || null : null;
  const ancestor = upstreamSha
    ? await runGit(['merge-base', '--is-ancestor', upstreamSha, 'HEAD'], repoPath)
    : { code: 1, stdout: '', stderr: '' };

  const decision = decideSyncBack({
    currentBranch,
    integrationBranch: opts.integrationBranch,
    upstreamSha,
    upstreamIsAncestorOfHead: ancestor.code === 0,
  });
  if (decision.action === 'skip') return { status: 'skipped', reason: decision.reason };
  if (decision.action === 'up-to-date') return { status: 'up-to-date', upstreamSha: decision.upstreamSha };

  const merge = await runGit(
    [
      ...(opts.identityArgs ?? []),
      'merge',
      '--no-edit',
      '-m',
      `git-sync: sync-back ${opts.upstreamRemote}/${opts.upstreamBranch} (${decision.upstreamSha.slice(0, 12)})`,
      decision.upstreamSha,
    ],
    repoPath,
  );
  if (merge.code !== 0) {
    const unmerged = await runGit(['diff', '--name-only', '--diff-filter=U', '-z'], repoPath);
    const conflictedFiles = unmerged.code === 0 ? unmerged.stdout.split('\0').filter(Boolean) : [];
    await runGit(['merge', '--abort'], repoPath);
    if (conflictedFiles.length === 0) {
      return { status: 'error', message: `sync-back merge failed (no conflicted paths): ${detail(merge)}` };
    }
    log(
      `[git-sync] ${repoPath}: sync-back of ${opts.upstreamRemote}/${opts.upstreamBranch} conflicts in ` +
        `${conflictedFiles.length} path(s); aborted to a clean tree`,
    );
    return { status: 'conflict', upstreamSha: decision.upstreamSha, conflictedFiles };
  }
  const head = await runGit(['rev-parse', 'HEAD'], repoPath);
  log(`[git-sync] ${repoPath}: synced back ${opts.upstreamRemote}/${opts.upstreamBranch} @ ${decision.upstreamSha.slice(0, 12)}`);
  return { status: 'merged', upstreamSha: decision.upstreamSha, mergedSha: head.stdout.trim() };
}

/** Stable title for the fix-it work-item a sync-back conflict files in the pot (dedupe key). */
export function syncBackConflictTitle(upstreamRemote: string, upstreamBranch: string, upstreamSha: string): string {
  return `${syncBackConflictTitlePrefix(upstreamRemote, upstreamBranch)} @ ${upstreamSha.slice(0, 12)} into the working copy`;
}

/**
 * The sha-free head of {@link syncBackConflictTitle}. Dedupe matches on THIS, not the full
 * title: while one conflict stays unresolved, upstream keeps advancing, and a sha-keyed
 * dedupe would file a fresh fix-it item on every upstream push for the same stuck merge.
 */
export function syncBackConflictTitlePrefix(upstreamRemote: string, upstreamBranch: string): string {
  return `Sync-back conflict: merge ${upstreamRemote}/${upstreamBranch}`;
}

export interface SyncBackConflictFilingDeps {
  /** Id of an OPEN (non-terminal) work-item whose title starts with `titlePrefix`, or null. */
  findOpenByTitlePrefix(titlePrefix: string): Promise<string | null>;
  /** Create the fix-it work-item; returns its id. */
  create(input: { title: string; summary: string }): Promise<string>;
}

/**
 * The watchdog key a pot's sync-back conflict is filed under. The dedupe lookup and the
 * create MUST use this one function: if they ever diverge, the lookup never finds the
 * item it filed and a stuck merge re-files a fresh work-item on every tick.
 */
export function syncBackConflictWatchdogKey(slug: string, titlePrefix: string): string {
  return `git-sync:sync-back-conflict:${slug}:${titlePrefix}`;
}

const TERMINAL_STATES = new Set(['done', 'dropped', 'resolved', 'closed']);
/** Cap on conflicted paths attached to the filed item (the summary still lists them all). */
export const SYNC_BACK_CONFLICT_PATHS_CAP = 20;

export interface SyncBackConflictCaptureInput {
  title: string;
  kind: 'bug';
  severity: 'major';
  body: string;
  watchdogKey: string;
  workspaceId: string;
  scope: string;
  sourceRole: 'system';
  filedByRole: 'git-sync';
  createdBy: 'system:git-sync';
  paths: string[];
}

/** The two persistence seams the real filing uses; injectable so the wiring is testable. */
export interface SyncBackConflictFilingSinks {
  findIssuesByWatchdogKeys(keys: string[]): Promise<ReadonlyArray<{ id: unknown; state?: unknown }>>;
  captureImprovement(input: SyncBackConflictCaptureInput): Promise<{ issue?: { id?: unknown } | null }>;
}

const defaultFilingSinks: SyncBackConflictFilingSinks = {
  findIssuesByWatchdogKeys: async (keys) => (await import('../../issues-engineer')).findIssuesByWatchdogKeys(keys),
  captureImprovement: async (input) => (await import('../improvements/capture-core')).captureImprovement(input),
};

/**
 * The production {@link SyncBackConflictFilingDeps} for one pot: an OPEN item under the
 * pot's sync-back watchdog key is the dedupe hit; otherwise a `major` bug is filed in the
 * pot (`harness:<slug>`) under that same key, carrying the conflicted paths.
 */
export function makeSyncBackConflictFilingDeps(
  input: { slug: string; workspaceId: string; cfg: SyncBackConfig; conflictedFiles: readonly string[] },
  sinks: SyncBackConflictFilingSinks = defaultFilingSinks,
): SyncBackConflictFilingDeps {
  const { slug, workspaceId, cfg, conflictedFiles } = input;
  return {
    findOpenByTitlePrefix: async (prefix) => {
      const found = await sinks.findIssuesByWatchdogKeys([syncBackConflictWatchdogKey(slug, prefix)]);
      const open = found.find((i) => !TERMINAL_STATES.has(String(i.state)));
      return open ? String(open.id) : null;
    },
    create: async ({ title, summary }) => {
      const res = await sinks.captureImprovement({
        title,
        kind: 'bug',
        severity: 'major',
        body: summary,
        watchdogKey: syncBackConflictWatchdogKey(slug, syncBackConflictTitlePrefix(cfg.upstreamRemote, cfg.upstreamBranch)),
        workspaceId,
        scope: `harness:${slug}`,
        sourceRole: 'system',
        filedByRole: 'git-sync',
        createdBy: 'system:git-sync',
        paths: conflictedFiles.slice(0, SYNC_BACK_CONFLICT_PATHS_CAP),
      });
      return String(res.issue?.id ?? '');
    },
  };
}

export type SyncBackConflictFiling =
  | { action: 'none' }
  | { action: 'exists'; id: string }
  | { action: 'filed'; id: string };

/**
 * P-016: "Conflicts become a fix-it work-item in the pot." git-sync's own conflict path
 * (escalation + merge-resolver) merges against the PUSH remote's staging, so it cannot
 * resolve a conflict against the MAIN repo's branch; a sync-back conflict therefore files
 * its own work-item, once per stuck merge (deduped on the open title prefix).
 */
export async function fileSyncBackConflict(
  result: SyncBackResult | undefined,
  cfg: SyncBackConfig,
  deps: SyncBackConflictFilingDeps,
): Promise<SyncBackConflictFiling> {
  if (!result || result.status !== 'conflict') return { action: 'none' };
  const existing = await deps.findOpenByTitlePrefix(syncBackConflictTitlePrefix(cfg.upstreamRemote, cfg.upstreamBranch));
  if (existing) return { action: 'exists', id: existing };
  const upstreamRef = `${cfg.upstreamRemote}/${cfg.upstreamBranch}`;
  const files = result.conflictedFiles.map((f) => `- ${f}`).join('\n');
  const summary = [
    `git-sync could not merge the main repository's ${upstreamRef} (${result.upstreamSha.slice(0, 12)}) into this working copy's staging branch.`,
    `The merge was aborted, so staging is clean but stays behind the main repository until this is resolved,`,
    `and the next pull request will keep showing changes the main repository already has.`,
    '',
    `Conflicted paths (${result.conflictedFiles.length}):`,
    files,
    '',
    'To resolve, on the working copy checkout with staging checked out:',
    `1. git fetch ${cfg.upstreamRemote} ${cfg.upstreamBranch}`,
    `2. git merge ${upstreamRef}`,
    '3. Resolve the conflicted paths and commit the merge.',
    'git-sync pushes the merge commit on its next tick; sync-back then reports up-to-date.',
  ].join('\n');
  const id = await deps.create({
    title: syncBackConflictTitle(cfg.upstreamRemote, cfg.upstreamBranch, result.upstreamSha),
    summary,
  });
  return { action: 'filed', id };
}
