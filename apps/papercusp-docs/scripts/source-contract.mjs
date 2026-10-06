import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontmatterDocuments, parseDocumentsField } from '../../../packages/operator-core/lib/harness/docs/subject-ref.ts';

export const PUBLIC_MANUAL_GUIDES = [
  'index', 'quickstart', 'using-the-app', 'accounts-and-billing',
  'workspaces-and-agents', 'plans-and-work', 'agent-modes-and-fleets', 'voice',
  'cloud-workspaces', 'harness-templates', 'harness-snapshots', 'plugins',
  'remote-access', 'troubleshooting',
];

/**
 * Build-time documentation-impact guard, shared with the maintained test suite.
 * Reuse the same documents: parser as the post-sync drift/steward pipeline.
 * This verifies coverage/anchors/links, not the semantic truth of prose: the
 * existing baseline and review mechanism owns that separate responsibility.
 */
export function assertPublicManualSource(docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const repo = resolve(docsRoot, '../..');
  const content = resolve(docsRoot, 'src/content/docs');
  const config = readFileSync(resolve(docsRoot, 'astro.config.mjs'), 'utf8');
  const files = readdirSync(content).filter((name) => name.endsWith('.mdx'));
  const errors = [];
  for (const slug of PUBLIC_MANUAL_GUIDES) {
    if (!files.includes(`${slug}.mdx`)) errors.push(`missing guide: ${slug}`);
    if (slug !== 'index' && !config.includes(`'${slug}'`)) errors.push(`missing sidebar guide: ${slug}`);
  }
  for (const file of files) {
    const text = readFileSync(resolve(content, file), 'utf8');
    const refs = parseDocumentsField(frontmatterDocuments(text));
    if (!refs.length) errors.push(`untracked guide: ${file}`);
    for (const ref of refs) {
      if (ref.kind !== 'path') { errors.push(`guide needs concrete source paths: ${file}`); continue; }
      for (const path of ref.globs) {
        const abs = resolve(repo, path);
        if (!abs.startsWith(repo + sep) || !existsSync(abs) ||
            !realpathSync(abs).startsWith(realpathSync(repo) + sep)) {
          errors.push(`dead or escaping source anchor: ${file}: ${path}`);
        }
      }
    }
    if (/\]\(\/internal\/docs/.test(text)) errors.push(`private-doc link: ${file}`);
    for (const match of text.matchAll(/\]\(\/docs\/([^)#?]*)/g)) {
      const slug = match[1].replace(/\/$/, '') || 'index';
      if (!files.includes(`${slug}.mdx`)) errors.push(`broken guide link: ${file}: ${slug}`);
    }
  }
  if (errors.length) throw new Error(`public_manual_source_contract:\n${errors.join('\n')}`);
  return { guides: files.length, sourceRoot: content };
}
