/**
 * Repo-relative path resolution for the docs MCP tools + resources.
 *
 * The Starlight engineering docs live at apps/operator-docs/ — a sibling
 * of apps/operator/. The docs:* tools read the source `.mdx` tree via
 * @papercusp/docs-engine's starlightContentAdapter; the docs:index
 * resource reads the built llms.txt from the operator's public/.
 *
 * The operator process runs with cwd = apps/operator (next dev), the
 * standalone build dir, or occasionally the repo root — so a fixed
 * process.cwd()-relative path is wrong. It was: the docs:* tools
 * silently resolved apps/operator/apps/operator-docs/... and returned
 * zero pages. Walk up from cwd to the directory that actually contains
 * the docs content tree.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';

const DOCS_CONTENT_REL = path.join('apps', 'operator-docs', 'src', 'content', 'docs');
const LLMS_TXT_REL = path.join('apps', 'operator', 'public', 'internal', 'docs', 'llms.txt');

function findRepoRoot(): string {
  let dir = path.resolve(process.cwd());
  for (let i = 0; i < 16; i += 1) {
    if (existsSync(path.join(dir, DOCS_CONTENT_REL))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback for the common cwd = .../apps/operator case when the docs
  // tree can't be located by walking up (e.g. a packaged build).
  const cwd = path.resolve(process.cwd());
  if (cwd.endsWith(path.join('apps', 'operator'))) {
    return path.resolve(cwd, '..', '..');
  }
  return cwd;
}

/** Monorepo root, resolved once at module load. */
export const REPO_ROOT = findRepoRoot();

/** Absolute path to the Starlight engineering-docs content tree. */
export const DOCS_CONTENT_ROOT = path.join(REPO_ROOT, DOCS_CONTENT_REL);

/** Absolute path to the built llms.txt served from the operator's public/. */
export const LLMS_TXT_PATH = path.join(REPO_ROOT, LLMS_TXT_REL);
