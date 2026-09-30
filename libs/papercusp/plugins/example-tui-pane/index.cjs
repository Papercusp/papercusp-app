/**
 * example-tui-pane — reference plugin for the TUI pane surface
 * (revive-plugin-system-2026-06-04 D-002).
 *
 * It contributes a single `tui-pane` UI surface. The pui (apps/tui) resolves
 * it via `plugins:tui_panes` (gated on `ui:tui-pane` + `compute:exec:sh`) and
 * opens it in a zellij pane it manages, running `command` (["sh", "render.sh"])
 * with cwd = this plugin's install dir — so render.sh resolves by relative path.
 *
 * Pure-UI plugin: no actions/tools/hooks. Shipped as CommonJS (.cjs) so the
 * loader's createRequire path can import it without a TS toolchain.
 */
module.exports = {
  kind: 'plugin',
  name: 'example-tui-pane',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Reference TUI pane plugin (D-002).',
  capabilities: ['ui:tui-pane', 'compute:exec:sh'],
  ui: [
    {
      type: 'tui-pane',
      slug: 'demo',
      label: 'Example TUI Pane',
      icon: 'terminal',
      command: ['sh', 'render.sh'],
    },
  ],
};
