import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Public-facing user manual for Papercusp. Engine: Starlight (on Astro).
// The internal *engineering* docs are a separate app — apps/operator-docs.
//
// `base: '/docs'` is load-bearing: every in-content link is written as
// `/docs/<slug>` (carried over from the previous fumadocs `/docs/[[...slug]]`
// route), so the site must mount under /docs for those links to resolve.
// If this is ever deployed at a bare docs subdomain, flip base to '/' and
// rewrite the in-content links.
export default defineConfig({
  site: 'https://papercup.ai',
  base: '/docs',
  // Match `apps/operator-docs`: pages emitted as `<slug>.html` (not
  // `<slug>/index.html`), so the operator Hono host's `/docs/*` resolver
  // (`host-docs-public.ts`) can slug→.html-lookup uniformly.
  build: { format: 'file' },
  integrations: [
    starlight({
      title: 'Papercusp Docs',
      description: 'Public documentation for the Papercusp platform.',
      pagefind: true,
      customCss: ['./src/styles/blue-frost.css'],
      // The canonical repo lives under the `Papercusp` GitHub Organization —
      // `papercupai` is the maintainer's personal GitHub User login, not an
      // org, and does not own the product repos (WI-4978).
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/Papercusp/papercup' },
      ],
      sidebar: [
        { label: 'Welcome', link: '/docs/' },
        {
          label: 'Sections',
          items: [
            'using-the-app',
            'harness-templates',
            'harness-snapshots',
            'plugins',
          ],
        },
      ],
    }),
  ],
});
