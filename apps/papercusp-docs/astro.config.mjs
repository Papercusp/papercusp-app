import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicManualSource } from './scripts/source-contract.mjs';

const isLintAsCommittedClone = process.env.PAPERCUSP_LINT_AS_COMMITTED_CLONE === '1';
function normalizeExternalAstroModuleIds() {
  const projectRoot = fileURLToPath(new URL('./', import.meta.url));
  return {
    name: 'papercusp-clone-astro-id-normalizer',
    enforce: 'pre',
    resolveId(id, importer) {
      const queryIndex = id.indexOf('?');
      const pathEnd = queryIndex === -1 ? undefined : queryIndex;
      const idQuery = queryIndex === -1 ? '' : id.slice(queryIndex);
      const importerQueryIndex = importer?.indexOf('?') ?? -1;
      const importerQuery = importerQueryIndex === -1 ? '' : importer.slice(importerQueryIndex);
      const importerHasAstroQuery = new URLSearchParams(importerQuery.slice(1)).has('astro');
      const importerId = importer === undefined
        ? null
        : importerQueryIndex === -1
          ? importer
          : importer.slice(0, importerQueryIndex);
      const importerFilename = importerId?.startsWith('/@fs/')
        ? importerId.slice('/@fs'.length)
        : importerId;
      const importerIsPath = importerFilename !== null && importerFilename !== undefined &&
        importerFilename.charCodeAt(0) !== 0 && !importerFilename.startsWith('/@id/') &&
        !/^[A-Za-z][A-Za-z\d+.-]*:/.test(importerFilename);
      const absoluteImporter = importerIsPath ? resolvePath(projectRoot, importerFilename) : null;
      const importerRelativePath = absoluteImporter === null ? '' : relative(projectRoot, absoluteImporter);
      const importerOutsideProjectRoot = absoluteImporter !== null && (
        importerRelativePath === '..' || importerRelativePath.startsWith(`..${sep}`) || isAbsolute(importerRelativePath)
      );
      // A relative external component imported by Astro's virtual page module has its
      // `?astro&type=page` context on the importer, not on the queryless target ID.
      // Carry that context so Astro resolves the component against the same compile key.
      const query = queryIndex === -1 && importerHasAstroQuery ? importerQuery : idQuery;
      const isAstroVirtualRequest = new URLSearchParams(query.slice(1)).has('astro');
      const hasFilesystemPrefix = id.startsWith('/@fs/');
      const filename = hasFilesystemPrefix
        ? id.slice('/@fs'.length, pathEnd)
        : id.slice(0, pathEnd);
      if (!filename.endsWith('.astro')) {
        // Vite/Rollup treats a relative import from an external Astro virtual module
        // as though the `/@fs` importer were under config.root. Resolve against its
        // physical source path through Vite so extension/package rules stay intact.
        if (id.startsWith('.') && importerHasAstroQuery && importerFilename?.endsWith('.astro') && importerOutsideProjectRoot && absoluteImporter) {
          return this.resolve(id, absoluteImporter, { skipSelf: true });
        }
        return null;
      }
      const resolutionBase = !isAbsolute(filename) && absoluteImporter
        ? dirname(absoluteImporter)
        : projectRoot;
      const absoluteFilename = isAbsolute(filename)
        ? resolvePath(filename)
        : resolvePath(resolutionBase, filename);

      const relativePath = relative(projectRoot, absoluteFilename);
      const outsideProjectRoot =
        relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
      if (!outsideProjectRoot) return null;
      // Keep virtual Astro requests under /@fs so Astro uses the same external compile
      // metadata key for a component's main module and its style/script virtual modules.
      return `${isAstroVirtualRequest ? '/@fs' : ''}${absoluteFilename}${query}`;
    },
  };
}

// Public-facing user manual for Papercusp. Engine: Starlight (on Astro).
// The internal *engineering* docs are a separate app — apps/operator-docs.
//
// `base: '/docs'` is load-bearing: every in-content link is written as
// `/docs/<slug>` (carried over from the previous fumadocs `/docs/[[...slug]]`
// route), so the site must mount under /docs for those links to resolve.
// If this is ever deployed at a bare docs subdomain, flip base to '/' and
// rewrite the in-content links.
export default defineConfig({
  site: 'https://app.papercusp.com',
  base: '/docs',
  // lint:as-committed links dependencies to the shared install. Main external Astro IDs resolve
  // to physical paths; virtual ?astro IDs retain /@fs so Astro maps them to the same compile key.
  ...(isLintAsCommittedClone
    ? {
        vite: {
          resolve: {
            preserveSymlinks: false,
          },
          plugins: [normalizeExternalAstroModuleIds()],
        },
      }
    : {}),
  // Match `apps/operator-docs`: pages emitted as `<slug>.html` (not
  // `<slug>/index.html`), so the operator Hono host's `/docs/*` resolver
  // (`host-docs-public.ts`) can slug→.html-lookup uniformly.
  build: { format: 'file' },
  integrations: [
    {
      name: 'public-manual-source-contract',
      hooks: { 'astro:build:start': () => { assertPublicManualSource(); } },
    },
    starlight({
      title: 'Papercusp Docs',
      description: 'Public documentation for the Papercusp platform.',
      pagefind: true,
      customCss: ['./src/styles/blue-frost.css'],
      // The canonical repo lives under the `Papercusp` GitHub Organization —
      // `papercupai` is the maintainer's personal GitHub User login, not an
      // org, and does not own the product repos (WI-4978).
      social: [
        { icon: 'github', label: 'Source', href: 'https://github.com/Papercusp/papercusp-app' },
        { icon: 'external', label: 'Open portal', href: 'https://app.papercusp.com/' },
      ],
      sidebar: [
        { label: 'Welcome', slug: '' },
        {
          label: 'Sections',
          items: [
            'quickstart',
            'using-the-app',
            'accounts-and-billing',
            'workspaces-and-agents',
            'plans-and-work',
            'agent-modes-and-fleets',
            'voice',
            'cloud-workspaces',
            'harness-templates',
            'harness-snapshots',
            'plugins',
            'remote-access',
            'troubleshooting',
          ],
        },
      ],
    }),
  ],
});
