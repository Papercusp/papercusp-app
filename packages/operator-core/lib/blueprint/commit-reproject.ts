/**
 * Live-edit = commit → reproject (harness-blueprint-orchestration-2026-06-03 P-016 /
 * D-007 / D-021).
 *
 * The andon-pull live fix to a harness — an accepted gym proposal, or any prompt /
 * blueprint edit — is a **git commit to the target's `.papercusp/` files, then a
 * re-projection to the PG cache** (NOT a direct `harness_prompt_overrides` write).
 * This is the path that REPLACES the ungated `PUT /harness/:slug/prompts/:role`
 * (which wrote PG with no commit, so the file source drifted behind): here the file
 * is the source of truth and PG is the cache the interpreter reads, kept in lockstep
 * by re-reading the committed file through the SAME file→PG loader plans/specs/config
 * use (D-021).
 *
 * Order matters: write file → commit → reload → project. We never write the PG cache
 * without committing the file first (that is the drift the old PUT route caused). A
 * repo-less target (no git) still works: the commit step returns null, the file edit
 * stands, and the reprojection runs — the file is authoritative either way.
 *
 * Pure orchestration over injected effects (`CommitReprojectDeps`), so the sequencing
 * is unit-tested with fakes (no real git / fs / PG). `realCommitReprojectDeps` binds
 * the live effects for the route/gym-accept wiring.
 */
import { join } from 'node:path';
import type { Blueprint } from '@papercusp/orchestrator/blueprint';

/** What an accepted proposal edits in the target's `.papercusp/`. */
export type BlueprintEdit =
  | { kind: 'blueprint'; yaml: string }
  | { kind: 'prompt'; role: string; md: string };

export interface CommitReprojectInput {
  workspaceId: string;
  harnessSlug: string;
  /** The target harness's repo/dir — the parent of `.papercusp/`. */
  harnessDir: string;
  edit: BlueprintEdit;
  /** Commit message; a sensible default is generated from the edit. */
  message?: string;
}

export interface LoadedForReproject {
  blueprint: Blueprint;
  contentHash: string;
  sourcePath: string | null;
}

export interface CommitReprojectDeps {
  /** Create a directory (recursive). */
  ensureDir(path: string): void;
  /** Write a UTF-8 file. */
  writeFile(path: string, content: string): void;
  /**
   * Commit the given repo-relative paths in `harnessDir`. Returns the new commit SHA,
   * or null when the dir is not a git repo (a repo-less target) or there was nothing
   * to commit — the caller treats that as "file edit stands, no commit".
   */
  gitCommit(harnessDir: string, relPaths: string[], message: string): Promise<string | null>;
  /** Load + resolve + validate the blueprint from `.papercusp/blueprint.yaml`. */
  loadBlueprint(blueprintPath: string): LoadedForReproject;
  /** Upsert the resolved blueprint into the PG cache; returns the hash written. */
  projectToPg(input: {
    workspaceId: string;
    harnessSlug: string;
    blueprint: Blueprint;
    contentHash: string;
    sourcePath: string | null;
    sourceCommit: string | null;
  }): Promise<{ contentHash: string }>;
}

export interface CommitReprojectResult {
  ok: boolean;
  /** True when a git commit was actually made (false for a repo-less target). */
  committed: boolean;
  commit: string | null;
  /** The reprojected blueprint's content hash. */
  contentHash: string | null;
  /** The file written (the blueprint or the prompt). */
  editedPath: string;
  blueprintPath: string;
  reason?: string;
}

/** The `.papercusp/` paths a target's blueprint + role prompts live at. */
export function papercuspBlueprintPath(harnessDir: string): string {
  return join(harnessDir, '.papercusp', 'blueprint.yaml');
}
export function papercuspPromptPath(harnessDir: string, role: string): string {
  return join(harnessDir, '.papercusp', 'prompts', `${role}.md`);
}

function defaultMessage(edit: BlueprintEdit, slug: string): string {
  return edit.kind === 'blueprint'
    ? `gym: accept blueprint edit for ${slug}`
    : `gym: accept ${edit.role} prompt edit for ${slug}`;
}

/**
 * Apply an accepted edit to the target's `.papercusp/`, commit it, and re-project the
 * blueprint to PG. Both a blueprint edit and a prompt edit re-project the blueprint
 * afterward: a blueprint edit changes the resolved blueprint; a prompt edit leaves it
 * unchanged but refreshes the cache's `source_commit` so the cache tracks the new HEAD.
 */
export async function commitAndReproject(
  input: CommitReprojectInput,
  deps: CommitReprojectDeps,
): Promise<CommitReprojectResult> {
  const blueprintPath = papercuspBlueprintPath(input.harnessDir);
  const editedPath =
    input.edit.kind === 'blueprint' ? blueprintPath : papercuspPromptPath(input.harnessDir, input.edit.role);

  // 1. Write the edited file (the source of truth).
  const editedContent = input.edit.kind === 'blueprint' ? input.edit.yaml : input.edit.md;
  deps.ensureDir(dirOf(editedPath));
  deps.writeFile(editedPath, editedContent);

  // 2. Commit it FIRST — never project the cache ahead of the committed file.
  const relPath = relFromHarnessDir(input.harnessDir, editedPath);
  const message = input.message ?? defaultMessage(input.edit, input.harnessSlug);
  let commit: string | null = null;
  try {
    commit = await deps.gitCommit(input.harnessDir, [relPath], message);
  } catch (e) {
    // A git failure must NOT leave a half-applied edit silently projected: stop here.
    return {
      ok: false,
      committed: false,
      commit: null,
      contentHash: null,
      editedPath,
      blueprintPath,
      reason: `git commit failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 3. Reload the committed blueprint + 4. re-project it to the PG cache.
  try {
    const loaded = deps.loadBlueprint(blueprintPath);
    const { contentHash } = await deps.projectToPg({
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      blueprint: loaded.blueprint,
      contentHash: loaded.contentHash,
      sourcePath: loaded.sourcePath,
      sourceCommit: commit,
    });
    return { ok: true, committed: commit !== null, commit, contentHash, editedPath, blueprintPath };
  } catch (e) {
    return {
      ok: false,
      committed: commit !== null,
      commit,
      contentHash: null,
      editedPath,
      blueprintPath,
      reason: `reprojection failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// Path helpers kept local + pure (no node:fs) so the core stays unit-testable.
function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
function relFromHarnessDir(harnessDir: string, abs: string): string {
  const base = harnessDir.endsWith('/') ? harnessDir : `${harnessDir}/`;
  return abs.startsWith(base) ? abs.slice(base.length) : abs;
}
