import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import starlightLlmsTxt from 'starlight-llms-txt';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const section = (label, directory) => ({
  label,
  items: [{ autogenerate: { directory, collapsed: true } }],
});

// ── DOCS_PREVIEW: the P-005 Starlight projection site, OFF by default ──────────
// `docs-and-memory-as-projections-2026-06-05` P-005 / `starlight-projection-site`:
// render the code-derived reference (the `defineTool`→OpenAPI spec and the
// libs/generic TypeDoc API) as a browsable human site, BEHIND a preview route.
// Gated on DOCS_PREVIEW so the default build the fleet/release pipeline runs is
// byte-for-byte unchanged and never depends on the on-demand `.papercusp/*`
// artifacts (which are gitignored and absent in a fresh release checkout). The
// preview is opt-in, built to ./dist-preview, and NEVER mirrored into the served
// docs by postbuild-copy. The ~206 hand-written MDX are untouched — their
// retirement is the owner's separate quiet-window step.
const PREVIEW = process.env.DOCS_PREVIEW === '1' || process.env.DOCS_PREVIEW === 'true';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const previewPlugins = [];
const previewSidebar = [];

if (PREVIEW) {
  const { default: starlightOpenAPI, openAPISidebarGroups } = await import('starlight-openapi');
  const { default: starlightTypeDoc, typeDocSidebarGroup } = await import('starlight-typedoc');
  const { discoverGenericLibEntryPoints } = await import('./preview-libs.mjs');

  // OpenAPI 3.1 spec projected from the defineTool registry by `npm run gen:openapi`
  // (368 operations). starlight-openapi resolves a relative `schema` against the
  // Astro root, so pass the absolute repo-root path.
  const openapiSpec = path.join(REPO_ROOT, '.papercusp', 'openapi.json');
  previewPlugins.push(
    starlightOpenAPI([
      {
        base: 'preview/api',
        schema: openapiSpec,
        sidebar: {
          label: 'Operator API (generated)',
          collapsed: true,
          operations: { badges: true, labels: 'summary', sort: 'alphabetical' },
          tags: { sort: 'alphabetical' },
        },
      },
    ]),
  );
  previewSidebar.push(...openAPISidebarGroups);

  // TypeDoc API for the borrowable libs/generic/* libraries, projected from the
  // SAME entry points `npm run gen:lib-api` uses (D-004: two independent
  // projections of one source). starlight-typedoc runs its own TypeDoc and
  // transforms the markdown into Starlight pages under preview/lib-api.
  // `skipErrorChecking` keeps doc-gen off the tree's tsc baseline (same stance as
  // gen-lib-api); `entryPointStrategy: 'resolve'` documents each lib as its own
  // module; the repo base tsconfig covers the 4 libs without their own.
  previewPlugins.push(
    starlightTypeDoc({
      entryPoints: discoverGenericLibEntryPoints(REPO_ROOT),
      tsconfig: path.join(REPO_ROOT, 'tsconfig.base.json'),
      output: 'preview/lib-api',
      errorOnEmptyDocumentation: false,
      sidebar: { label: 'Lib API (generated)', collapsed: true },
      typeDoc: {
        entryPointStrategy: 'resolve',
        skipErrorChecking: true,
        excludeInternal: true,
        excludePrivate: true,
        readme: 'none',
      },
    }),
  );
  previewSidebar.push(typeDocSidebarGroup);
}

export default defineConfig({
  // `site` is the absolute origin baked into sitemap.xml, canonical tags,
  // and the starlight-llms-txt manifest links. The engineering docs are
  // served by the operator under /internal/docs; localhost:3070 is the
  // operator's documented HTTP surface (see papercusp-su playbook).
  site: 'http://localhost:3070',
  base: '/internal/docs',
  build: { format: 'file' },
  // ── gfm MUST be explicit — do not delete this as redundant (WI-2145678) ──────
  // Astro 6 made `markdown.gfm` an OPTIONAL key with NO schema default
  // (astro/dist/core/config/schemas/base.js: `gfm: z.boolean().optional()`),
  // because `unified()` supplies the real default for the .md pipeline. But
  // `@astrojs/mdx` resolves `gfm: options.gfm ?? defaults.gfm` → undefined and
  // then adds the plugin under `if (mdxOptions.gfm)` — a TRUTHINESS check, not
  // the `!== false` it uses for smartypants on the very next line. So for .mdx
  // (which is this entire corpus) GFM silently defaulted OFF on the astro 6
  // upgrade. Two things broke, and neither announced itself:
  //   1. Every pipe table rendered as raw text — 365 source docs author one, and
  //      the built mirror went from tables=2 to tables=0 on system/repo-conventions
  //      between 2026-09-02 and 2026-09-05. The BUILD STAYED GREEN throughout.
  //   2. Losing the table extension changes how a row's inline code spans parse,
  //      which turned system/lifecycle.mdx into a hard `astro build` failure and
  //      wedged `npm run docs:rebuild` fleet-wide (EI-22415725782521670).
  // Verify a change here against the BUILT HTML (`grep -c '<table'` on a page
  // whose source has a pipe table), never against the build exit code.
  markdown: { gfm: true },
  // Renamed pages keep their old URL alive. A doc's path is a REFERENCE — agents
  // cite it, humans bookmark it, and prior transcripts/memory rows hold it — so a
  // rename that just moves the file turns every one of those into a 404 with no
  // signal about where the page went. Astro emits a static redirect page per entry,
  // which the postbuild mirror copies like any other page, so this works on the
  // served /internal/docs surface too (there is no server doing the redirecting).
  //
  // NB the TARGET must carry the `base` prefix explicitly. Astro prepends `base`
  // to the redirect's SOURCE key but emits the DESTINATION verbatim — so a bare
  // '/system/knowledge-packs' produces `<meta refresh url=/system/knowledge-packs>`,
  // which 404s under the /internal/docs base. A redirect that 404s is worse than no
  // redirect: it looks handled. Verified against the built page, not assumed.
  redirects: {
    // learning packs → knowledge packs (cupboard-public-release-2026-07-12 P-001).
    '/system/learning-packs': '/internal/docs/system/knowledge-packs',
  },
  // Preview builds go to ./dist-preview so they NEVER reach the committed served
  // mirror (postbuild-copy mirrors ./dist only, and the preview script never runs it).
  outDir: PREVIEW ? './dist-preview' : './dist',
  integrations: [
    react(),
    starlight({
      title: 'Papercusp Internal',
      description: 'Engineering reference for the Papercusp multi-agent coding harness.',
      favicon: '/favicon.svg',
      logo: { src: './src/assets/hive-docs-logo.svg', alt: 'Papercusp Internal' },
      pagefind: true,
      lastUpdated: true,
      customCss: ['./src/styles/blue-frost.css'],
      plugins: [
        starlightLlmsTxt({
          projectName: 'Papercusp',
          description:
            'Internal engineering documentation for Papercusp - a local-first multi-agent coding harness.',
        }),
        ...previewPlugins,
      ],
      sidebar: [
        section('Agents', 'agents'),
        section('Agent Spawning', 'agent-spawning'),
        section('Agent Insights', 'agent-insights'),
        section('Benchmarks', 'benchmarks'),
        section('Build System', 'build-system'),
        section('Data Sync', 'data-sync'),
        section('Design', 'design'),
        section('Desktop', 'desktop'),
        section('Endpoint System', 'endpoint-system'),
        section('Harness', 'harness'),
        section('Implementation', 'implementation'),
        section('Plugins', 'plugins'),
        section('PostHog', 'posthog'),
        section('Reference (generated)', 'reference'),
        section('Security', 'security'),
        section('Snapshots', 'snapshots'),
        section('Spec', 'spec'),
        section('System', 'system'),
        section('Testing', 'testing'),
        ...previewSidebar,
      ],
    }),
  ],
});
