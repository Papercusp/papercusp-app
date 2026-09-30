/**
 * doc-fs — read doc BODIES from the harness repo's docs tree. The body is the
 * git-synced markdown file (D-007); a doc_id is its path relative to the docs root.
 * Mirrors project-docs.ts's walk/guard so the merged read and the legacy FS read
 * agree on what a doc_id is.
 */

import { promises as fs, existsSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';

/** Recursively collect every .md/.mdx file under docsRoot — relative + sorted. */
export async function listDocBodies(docsRoot: string): Promise<string[]> {
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
export async function readDocBody(docsRoot: string, relPath: string): Promise<string | null> {
  const abs = safeJoinUnderRoot(docsRoot, relPath);
  if (!abs || !existsSync(abs)) return null;
  try {
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
