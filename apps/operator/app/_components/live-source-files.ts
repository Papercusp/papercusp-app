import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Directories that cannot contain live application source for these guards.
 *
 * Keep this enumerator filesystem-only. A source guard must not create a child
 * process (or ask git to create grep worker threads) just to discover files;
 * under fleet load that turns an otherwise-valid assertion into a false red.
 * Generated and dependency trees are excluded explicitly so the walk keeps the
 * same source-only scope as the old git grep path.
 */
function isGeneratedOrDependencyDirectory(name: string): boolean {
  return (
    name === '.git' ||
    name === '.next' ||
    name.startsWith('.next-') ||
    name === '.papercusp' ||
    name === '.vitest-tmp' ||
    name.startsWith('.tmp') ||
    name.startsWith('node_modules') ||
    name === 'build' ||
    name.startsWith('build-') ||
    name === 'coverage' ||
    name === 'dist' ||
    name.startsWith('dist-') ||
    name === 'public' ||
    name === 'target'
  );
}

function isTypeScriptSource(name: string): boolean {
  return name.endsWith('.ts') || name.endsWith('.tsx');
}

/** Enumerate live TypeScript source without invoking git or another process. */
export async function listLiveTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isGeneratedOrDependencyDirectory(entry.name)) {
          await visit(join(directory, entry.name), relativePath);
        }
      } else if (entry.isFile() && isTypeScriptSource(entry.name)) {
        files.push(relativePath);
      }
    }
  }

  await visit(root, '');
  return files.sort();
}
