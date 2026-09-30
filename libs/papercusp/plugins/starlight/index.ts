/**
 * @papercupai/starlight — embed the docs site as a harness dashboard tab.
 *
 * Successor to @papercupai/fumadocs. fumadocs (the framework) was migrated
 * to Astro Starlight; this plugin is the iframe-tab hookup for the
 * Starlight-served docs. Same mechanism as the fumadocs plugin — the tab
 * is manifest-driven (`dashboardTabs[].iframeUrlConfigKey`), gated by the
 * PAPERCUSP_TABS_FROM_PLUGINS feature flag, and `replaces` the legacy
 * hard-coded `docs` tab (plus the outgoing `fumadocs` plugin tab).
 */
import type { Plugin } from '@papercusp/plugin-sdk';

// Tab rendering is driven by the manifest's `dashboardTabs[].iframeUrlConfigKey`
// (papercusp.json). The runtime-loaded plugin model can't `import` a React
// component (Turbopack can't dynamic-import .tsx via createRequire), and the
// manifest's iframe pattern handles the docs-as-iframe case directly.
//
// `tab.tsx` is kept on disk for build-time hosts that resolve `componentId`
// against an in-host registry. For marketplace runtime install, it's unused.
const plugin: Plugin = {
  kind: 'plugin',
  name: '@papercupai/starlight',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Starlight docs site embedded in a dashboard tab.',
  capabilities: ['ui:dashboard-tab'],
};

export default plugin;
