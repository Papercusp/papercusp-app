/**
 * @papercupai/pi-coding — embed the Pi coding-agent terminal.
 *
 * Reference plugin for spec §14.7 P7 — replaces the legacy hard-coded `pi`
 * tab on the harness dashboard. The actual tab rendering is iframe-mode:
 * the manifest's `dashboardTabs[0].iframeUrlConfigKey: 'piUrl'` makes the
 * host fetch the configured Pi terminal URL into a sandboxed iframe.
 *
 * The plugin module itself is a near-empty Plugin shell — no `init()`, no
 * lifecycle hooks. The host loads the manifest's contribution surface
 * directly; this file only exists so the loader has an entry to require().
 *
 * Earlier versions imported `./tab` and registered it via `component:`,
 * but that was the pre-Phase-6b pattern. The component file (`tab.tsx`)
 * is kept around for reference but is no longer wired.
 */
import type { Plugin } from '@papercusp/plugin-sdk';

const plugin: Plugin = {
  name: '@papercupai/pi-coding',
  version: '0.1.1',
  papercusp: '^0.1.0',
  description: 'Pi coding-agent terminal as a dashboard tab.',
  capabilities: ['ui:dashboard-tab'],
};

export default plugin;
