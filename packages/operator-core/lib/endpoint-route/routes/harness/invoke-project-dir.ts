import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { classifyDir } from '../../../harness/classify-tree';

export type InvokeProjectDirResult =
  | {
      ok: true;
      projectDir: string;
      source: 'harness-root' | 'frozen-repair-worktree';
    }
  | {
      ok: false;
      code:
        | 'repair_worktree_role_mismatch'
        | 'repair_worktree_invalid_path'
        | 'repair_worktree_outside_harness'
        | 'repair_worktree_not_linked'
        | 'repair_worktree_wrong_repo';
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function failure(
  code: Extract<InvokeProjectDirResult, { ok: false }>['code'],
  message: string,
): InvokeProjectDirResult {
  return { ok: false, code, message };
}

/**
 * Resolve the cwd for the loopback /invoke spawn.
 *
 * Ordinary invokes stay byte-identical on the registered harness root. A frozen-candidate
 * release-fixer may request its gate-owned linked worktree through
 * body.releaseFixerContext.repairWorktree. That override fails closed unless it is:
 *
 *   1. requested by the release-fixer role,
 *   2. physically inside <harness>/.papercusp/worktrees after symlink resolution,
 *   3. classified by the existing harness tree classifier as a linked worktree, and
 *   4. linked back to this harness's own .git/worktrees directory.
 *
 * The same resolved directory is used for the tracked session row and spawnInvokeOnce, so
 * bookkeeping can never claim one cwd while the child actually starts in another.
 */
export function resolveInvokeProjectDir(input: {
  projectPath: string;
  role: string;
  body: unknown;
}): InvokeProjectDirResult {
  const body = isRecord(input.body) ? input.body : null;
  const context = body && isRecord(body.releaseFixerContext) ? body.releaseFixerContext : null;
  const requested = context?.repairWorktree;

  if (requested === undefined) {
    return { ok: true, projectDir: input.projectPath, source: 'harness-root' };
  }
  if (input.role !== 'release-fixer') {
    return failure(
      'repair_worktree_role_mismatch',
      'releaseFixerContext.repairWorktree is accepted only for role=release-fixer',
    );
  }
  if (typeof requested !== 'string' || requested.trim().length === 0 || !isAbsolute(requested)) {
    return failure(
      'repair_worktree_invalid_path',
      'releaseFixerContext.repairWorktree must be a non-empty absolute path',
    );
  }

  try {
    const projectRoot = realpathSync(input.projectPath);
    const repairRoot = realpathSync(join(projectRoot, '.papercusp', 'worktrees'));
    const repairWorktree = realpathSync(requested);
    if (!strictlyInside(repairRoot, repairWorktree)) {
      return failure(
        'repair_worktree_outside_harness',
        `repair worktree must resolve inside ${repairRoot}`,
      );
    }

    const classified = classifyDir(projectRoot, repairWorktree, '__invoke__');
    if (!classified || classified.kind !== 'worktree') {
      return failure(
        'repair_worktree_not_linked',
        'repair worktree must contain a linked-worktree .git pointer',
      );
    }

    const ownedGitdirs = realpathSync(join(projectRoot, '.git', 'worktrees'));
    const linkedGitdir = realpathSync(resolve(repairWorktree, classified.gitDirTarget));
    if (!strictlyInside(ownedGitdirs, linkedGitdir)) {
      return failure(
        'repair_worktree_wrong_repo',
        'repair worktree must link to this harness repository',
      );
    }

    return {
      ok: true,
      projectDir: repairWorktree,
      source: 'frozen-repair-worktree',
    };
  } catch (error) {
    return failure(
      'repair_worktree_invalid_path',
      `repair worktree validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
