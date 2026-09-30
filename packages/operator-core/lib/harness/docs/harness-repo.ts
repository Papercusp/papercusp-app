/**
 * harness-repo — resolve a harness slug to its on-disk repo root + docs root.
 *
 * The repo root is the git working tree (subject_ref / anchor_paths + every git
 * drift query are relative to it). The docs root is where doc BODIES live
 * (`<repo>/docs` or the `.papercusp/docs.json`-declared dir); a doc_id is a path
 * relative to the docs root. Mirrors project-docs.ts's resolution exactly so the
 * merged read and the FS read agree on what a doc_id means.
 */

import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { resolveDocsRoot } from '../../endpoint-route/routes/harness/project-docs';

/** The harness's git working-tree root, or null if unknown. For a repo-less
 *  `kind:'hive'` harness this resolves its MEMBER repo's path (git-sync-any-hive:
 *  a coding hive's docs/source live in its member repo, not the empty hive dir). */
export async function resolveHarnessRepoRoot(slug: string): Promise<string | null> {
  return resolveHarnessContentPath(await loadHarnessRegistry(), slug) ?? null;
}

/** Both roots for a harness: the repo (git) root and the docs (bodies) root. */
export async function resolveHarnessDocPaths(
  slug: string,
): Promise<{ repoRoot: string; docsRoot: string } | null> {
  const repoRoot = await resolveHarnessRepoRoot(slug);
  if (!repoRoot) return null;
  const docsRoot = await resolveDocsRoot(repoRoot);
  return { repoRoot, docsRoot };
}
