/**
 * Pure command plans for materialising a THROWAWAY substrate clone at a PINNED
 * commit (D-009). A real `git clone` (not a tarball export) so the harness's
 * worker can commit on top and the trace collector can recover the produced
 * work with `git diff <pinned-commit> HEAD` (P-002/P-003).
 *
 * v1 does a full clone (works for any reachable commit, local or remote);
 * local-path sources get `--local` so git hardlinks the object store (cheap).
 * Fetching an arbitrary SHA shallowly depends on server config
 * (`uploadpack.allowAnySHA1InWant`) and is deliberately avoided. A reference /
 * cache clone is a later optimization, not a v1 concern.
 */

export interface GitCommand {
  argv: string[];
  /**
   * Extra environment for THIS command only (e.g. `GIT_INDEX_FILE` to build a
   * tree without touching the working tree, or a pinned author identity so a
   * generated commit is reproducible). Merged over the executor's own env.
   */
  env?: Record<string, string>;
  /** Bytes to write to the command's stdin (e.g. `update-index --index-info`). */
  stdin?: string;
}

export interface CloneSubstratePlan {
  commands: GitCommand[];
}

export interface CloneSubstrateInput {
  /** Local path OR remote URL (https / scp-style) of the substrate repo. */
  source: string;
  /** The immutable commit to pin to — must be a hex SHA, not a ref. */
  commit: string;
  /** Absolute scratch dir to clone into. */
  destDir: string;
}

/** A pin is an immutable commit SHA (full or abbreviated), never a ref/branch/tag. */
export function isPinnedCommit(commit: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(commit);
}

/** True when `source` is a local filesystem path rather than a remote URL. */
function isLocalSource(source: string): boolean {
  // Remote forms: `scheme://…` (https, ssh, git, file) or scp-style `user@host:path`.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return false;
  if (/^[^/]+@[^/]+:/.test(source)) return false;
  return true;
}

export function buildSubstrateCloneCommands(input: CloneSubstrateInput): CloneSubstratePlan {
  const { source, commit, destDir } = input;
  if (!isPinnedCommit(commit)) {
    throw new Error(`gym substrate commit must be a pinned hex SHA, got: ${JSON.stringify(commit)}`);
  }

  const cloneArgv = ['git', 'clone', '--quiet'];
  if (isLocalSource(source)) cloneArgv.push('--local');
  cloneArgv.push(source, destDir);

  return {
    commands: [
      { argv: cloneArgv },
      { argv: ['git', '-C', destDir, 'checkout', '--detach', commit] },
    ],
  };
}
