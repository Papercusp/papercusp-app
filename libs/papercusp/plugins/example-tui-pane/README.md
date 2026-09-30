# example-tui-pane

Reference plugin for the **TUI pane surface** (plan `revive-plugin-system-2026-06-04`, D-002).

It demonstrates the smallest possible `tui-pane` UI contribution: a plugin that
draws its own content in a terminal pane the **pui** (`apps/tui`) manages.

## How it works

The manifest declares a `tui-pane` UI surface plus the two capabilities the
resolver gates on:

```json
"capabilities": ["ui:tui-pane", "compute:exec:sh"],
"ui": [{ "type": "tui-pane", "slug": "demo", "label": "Example TUI Pane", "command": ["sh", "render.sh"] }]
```

1. The pui calls the operator tool `plugins:tui_panes` (`POST
   /api/agent-tools/plugins/tui_panes`), which returns every `tui-pane`
   contribution whose plugin holds **both** `ui:tui-pane` and
   `compute:exec:<command[0]>` (two-tier: manifest ∩ user-granted).
2. The user picks this pane in the pui's Plugins tab and presses Enter.
3. The pui allocates a **zellij pane it manages** and runs `command`
   (`sh render.sh`) in it, with `cwd` = this plugin's install dir — so
   `render.sh` resolves by relative path. The plugin renders its own content;
   zellij is just the pui's layout engine, not the plugin contract.

`render.sh` paints a tiny live view (a clock) so the pane is visibly alive. A
real plugin would render a ratatui app, a log tail, a docs viewer, etc.

## Authoring your own TUI pane

- Add `"ui:tui-pane"` and `"compute:exec:<your-bin>"` to `capabilities`.
- Add a `ui[]` entry of `type: "tui-pane"` with a `command` argv. `command[0]`
  must be a PATH basename (or absolute path) you hold `compute:exec:` for.
- Ship your render binary/script in the plugin dir; reference it relative to the
  plugin dir (the process runs with `cwd` set there).
