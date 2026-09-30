"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Tab rendering is driven by the manifest's `dashboardTabs[].iframeUrlConfigKey`
// (papercusp.json). The runtime-loaded plugin model can't `import` a React
// component (Turbopack can't dynamic-import .tsx via createRequire), and the
// manifest's iframe pattern handles the docs-as-iframe case directly.
//
// `tab.tsx` is kept on disk for build-time hosts that resolve `componentId`
// against an in-host registry. For marketplace runtime install, it's unused.
const plugin = {
    kind: 'plugin',
    name: '@papercupai/starlight',
    version: '0.1.0',
    papercusp: '^0.1.0',
    description: 'Starlight docs site embedded in a dashboard tab.',
    capabilities: ['ui:dashboard-tab'],
};
exports.default = plugin;
