/**
 * doc-fs — read doc BODIES from the harness repo's docs tree. The body is the
 * git-synced markdown file (D-007); a doc_id is its path relative to the docs root.
 * Mirrors project-docs.ts's walk/guard so the merged read and the legacy FS read
 * agree on what a doc_id is.
 */

import { promises as fs, existsSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';

export interface DocRoots {
  docsRoot: string;
  /** Namespaced, file-authoritative sources validated by resolveDocsSources. */
  sources?: Record<string, string>;
}

function roots(input: string | DocRoots): DocRoots {
  return typeof input === 'string' ? { docsRoot: input } : input;
}

/** Resolve one doc ID to its canonical source file, never to a second copy. */
export function docFilePath(input: string | DocRoots, docId: string): string | null {
  const { docsRoot, sources } = roots(input);
  const slash = docId.indexOf('/');
  const namespace = slash > 0 ? docId.slice(0, slash) : '';
  return sources && Object.hasOwn(sources, namespace)
    ? safeJoinUnderRoot(sources[namespace], docId.slice(slash + 1))
    : safeJoinUnderRoot(docsRoot, docId);
}

/** Map git's repo-relative changed path back to the same ID the read uses. */
export function docIdForRepoPath(repoRoot: string, input: string | DocRoots, repoPath: string): string | null {
  if (!/\.(md|mdx)$/i.test(repoPath)) return null;
  const all = roots(input);
  const candidates = [['', all.docsRoot], ...Object.entries(all.sources ?? {})]
    .sort((a, b) => b[1].length - a[1].length);
  for (const [namespace, root] of candidates) {
    const rel = relative(repoRoot, root).split(sep).join('/');
    const prefix = rel ? rel + '/' : '';
    if (!repoPath.startsWith(prefix)) continue;
    const id = repoPath.slice(prefix.length);
    if (id) return namespace ? `${namespace}/${id}` : id;
  }
  return null;
}

/** Recursively collect every .md/.mdx file under docsRoot — relative + sorted. */
export async function listDocBodies(input: string | DocRoots): Promise<string[]> {
  const { docsRoot, sources } = roots(input);
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && /\.(md|mdx)$/i.test(e.name)) out.push(relative(docsRoot, full));
    }
  }
  await walk(docsRoot);
  for (const [namespace, root] of Object.entries(sources ?? {})) {
    const files = await listDocBodies(root);
    out.push(...files.map((file) => `${namespace}/${file}`));
  }
  return out.sort();
}

/** Guard against `../` traversal — resolved path must stay under docsRoot. */
export function safeJoinUnderRoot(root: string, rel: string): string | null {
  const resolved = resolvePath(root, rel);
  const safeRoot = resolvePath(root) + sep;
  if (resolved !== resolvePath(root) && !resolved.startsWith(safeRoot)) return null;
  return resolved;
}

/** Read a doc body by docs-root-relative path, or null (missing / traversal). */
export async function readDocBody(input: string | DocRoots, relPath: string): Promise<string | null> {
  const abs = docFilePath(input, relPath);
  if (!abs || !existsSync(abs)) return null;
  try {
    const { docsRoot, sources } = roots(input);
    const namespace = relPath.split('/')[0];
    const realRoot = await fs.realpath(sources && Object.hasOwn(sources, namespace) ? sources[namespace] : docsRoot);
    const realFile = await fs.realpath(abs);
    if (!realFile.startsWith(realRoot + sep)) return null;
    return await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Pick a sensible default doc: index → README → first. */
export function chooseDefaultDoc(files: string[]): string | null {
  if (files.length === 0) return null;
  return (
    files.find((f) => /^index\.(md|mdx)$/i.test(f)) ??
    files.find((f) => /^README\.(md|mdx)$/i.test(f)) ??
    files[0]
  );
}
