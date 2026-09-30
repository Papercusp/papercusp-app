/**
 * preview-libs.mjs — discover the borrowable `libs/generic/*` TypeDoc entry
 * points for the DOCS_PREVIEW Starlight site (docs-and-memory-as-projections
 * P-005 / starlight-projection-site build plan).
 *
 * Mirrors the lib-discovery in scripts/gen-lib-api-docs.ts so the human
 * Starlight render (starlight-typedoc) and the agent-form artifact
 * (`npm run gen:lib-api`) project from the SAME entry points — the two
 * independent projections of one source that D-004 describes. Kept in this app
 * (not imported from the root script) so astro.config stays free of the
 * registry/tsx import chain; the logic is tiny and stable.
 *
 * Only loaded when DOCS_PREVIEW is set — the default docs build never touches it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function resolveEntry(dir) {
  for (const cand of ['src/index.ts', 'src/index.tsx', 'index.ts']) {
    const p = join(dir, cand);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * @param {string} repoRoot absolute path to the monorepo root
 * @returns {string[]} absolute paths to each generic lib's source entry point
 */
export function discoverGenericLibEntryPoints(repoRoot) {
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const entries = [];
  for (const ws of rootPkg.workspaces ?? []) {
    if (!ws.startsWith('libs/generic/')) continue;
    const dir = join(repoRoot, ws);
    if (!existsSync(join(dir, 'package.json'))) continue;
    const entry = resolveEntry(dir);
    if (entry) entries.push(entry);
  }
  return entries;
}
