/**
 * Real-effect wiring for the commit → reproject primitive (P-016 / D-007 / D-021).
 *
 * Binds `CommitReprojectDeps` to live fs + git + the engine loader + the PG
 * projector, and exposes `acceptProposalViaCommit` — the gym-accept path that
 * REPLACES the ungated `PUT /harness/:slug/prompts/:role` (which wrote
 * `harness_prompt_overrides` with no commit). The accepted prompt/blueprint edit is
 * committed to the TARGET harness's own `.papercusp/` git tree (NOT the operator's
 * tree) and re-projected to PG; the proposal is marked accepted ONLY on success.
 *
 * Kept separate from the pure `commit-reproject.ts` (mirroring ab-runner /
 * ab-runner-real) so the orchestration core stays unit-testable without fs/git/PG;
 * the git wiring (`realGitCommit`) is exported + tested against a real temp repo.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { projectBlueprintToPg } from './project-to-pg';
import {
  commitAndReproject,
  type CommitReprojectDeps,
  type CommitReprojectResult,
} from './commit-reproject';

const execFileP = promisify(execFileCb);

/**
 * Commit the given repo-relative paths in `harnessDir`, returning the new commit SHA.
 * Returns null when the dir is NOT a git repo (a `requiresRepo:false` target — the
 * file edit stands without a commit). A no-op edit (proposed === current) does not
 * create a commit; it returns the existing HEAD, so the reprojection still refreshes
 * the cache.
 */
export async function realGitCommit(harnessDir: string, relPaths: string[], message: string): Promise<string | null> {
  // Is this a git work tree? A repo-less target has none → no commit.
  try {
    await execFileP('git', ['-C', harnessDir, 'rev-parse', '--is-inside-work-tree']);
  } catch {
    return null;
  }
  await execFileP('git', ['-C', harnessDir, 'add', '--', ...relPaths]);
  // Anything actually staged? `git diff --cached --quiet` exits non-zero iff there are
  // staged changes; a clean (no-op) edit skips the commit and returns current HEAD.
  let hasStaged = false;
  try {
    await execFileP('git', ['-C', harnessDir, 'diff', '--cached', '--quiet', '--', ...relPaths]);
  } catch {
    hasStaged = true;
  }
  if (hasStaged) {
    await execFileP('git', ['-C', harnessDir, 'commit', '-m', message, '--', ...relPaths]);
  }
  const { stdout } = await execFileP('git', ['-C', harnessDir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

/** Live `CommitReprojectDeps` — fs writes, git commit in the TARGET repo, loader + PG projector. */
export function realCommitReprojectDeps(sql: Sql): CommitReprojectDeps {
  return {
    ensureDir: (p) => mkdirSync(p, { recursive: true }),
    writeFile: (p, c) => writeFileSync(p, c, 'utf8'),
    gitCommit: realGitCommit,
    loadBlueprint: (path) => {
      const l = loadBlueprintFromFile(path);
      return { blueprint: l.blueprint, contentHash: l.contentHash, sourcePath: l.sourcePath };
    },
    projectToPg: (input) => projectBlueprintToPg(sql, input),
  };
}

export interface AcceptViaCommitInput {
  workspaceId: string;
  harnessSlug: string;
  /** The TARGET harness's repo/dir (parent of `.papercusp/`) — resolved from the registry by the caller. */
  harnessDir: string;
  proposalId: string;
  role: string;
  proposedMd: string;
  now?: number;
}

export interface AcceptViaCommitResult extends CommitReprojectResult {
  /** True iff the proposal row was flipped pending → accepted (only after a successful commit+reproject). */
  proposalMarked: boolean;
}

/**
 * Accept a gym proposal the git-canonical way (D-007): commit its prompt edit to the
 * target's `.papercusp/prompts/<role>.md`, re-project the blueprint, THEN mark the
 * proposal accepted. A failed commit/reproject leaves the proposal PENDING (never a
 * half-applied accept) — the discipline the old ungated PUT lacked.
 */
export async function acceptProposalViaCommit(sql: Sql, input: AcceptViaCommitInput): Promise<AcceptViaCommitResult> {
  const res = await commitAndReproject(
    {
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      harnessDir: input.harnessDir,
      edit: { kind: 'prompt', role: input.role, md: input.proposedMd },
    },
    realCommitReprojectDeps(sql),
  );
  if (!res.ok) return { ...res, proposalMarked: false };
  const now = input.now ?? Date.now();
  const updated = await sql`
    UPDATE harness_shared.gym_proposals SET status = 'accepted', decided_at = ${now}
     WHERE id = ${input.proposalId} AND status = 'pending'`;
  return { ...res, proposalMarked: (updated.count ?? 0) > 0 };
}
