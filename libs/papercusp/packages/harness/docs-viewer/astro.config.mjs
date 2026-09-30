// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Runs independently of any project repo. Project docs are mounted via
// symlinks into src/content/docs/<slug>/ by bin/docs-viewer.sh at startup,
// so each registered harness project becomes a top-level sidebar section.
export default defineConfig({
  site: 'http://127.0.0.1:4325',
  integrations: [
    starlight({
      title: 'Harness Docs',
      description: 'Auto-generated feature documentation from the autonomous harness.',
      customCss: ['./src/styles/custom.css'],
    }),
  ],
});
