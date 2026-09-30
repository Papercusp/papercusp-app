# Agent integrations in papercusp-desktop

Two agent-friendly facilities live in this Tauri shell. Both are wired
**only under `#[cfg(debug_assertions)]`** — release builds get neither.

## 1. tauri-specta — typed IPC bindings

Every `#[tauri::command]` is annotated with `#[specta::specta]` and
collected into a `tauri_specta::Builder`. On each debug build, the
builder writes a fully-typed TypeScript surface to:

```
../../papercup/apps/operator/lib/tauri-bindings.ts
```

Frontend code should import from there:

```ts
import { commands } from '@/lib/tauri-bindings';
const reg = await commands.workspacesList();         // typed Registry
const r   = await commands.workspacesCreate('foo');  // typed { status, data | error }
```

The legacy hand-rolled wrappers (`lib/{pty,version,workspaces}-tauri.ts`)
still exist and own non-trivial logic (base64 framing, event listeners,
HTTP fallback for web mode). Migrating their internal `invoke('cmd', …)`
calls to the typed `commands.*` is a planned cleanup.

To regenerate bindings without launching the GUI:

```sh
cd src-tauri && cargo run --bin papercusp-desktop &
sleep 2 && pkill papercusp-desktop
```

(The export runs at startup, before any window opens. Killing the
process after 2 s leaves the file in place.)

## 2. tauri-plugin-mcp-bridge — live debug surface for coding agents

Bound to `127.0.0.1:9223` in dev. Lets MCP-aware agents (Claude Code,
Cursor, Windsurf) inspect and drive a running dev build:

- `webview_screenshot` — capture window contents
- `webview_execute_js` — eval JS in the webview
- `webview_dom_snapshot` — accessibility tree
- `read_logs` — stream console/stderr
- IPC monitor — see every Tauri command call live
- 17+ other tools

### Connect from Claude Code

`~/.claude/mcp.json` should have:

```json
{
  "mcpServers": {
    "tauri": {
      "command": "npx",
      "args": ["-y", "@hypothesi/tauri-mcp-server"]
    }
  }
}
```

Then start the desktop shell in dev (`cargo run` here, or `npm run dev`)
so the bridge listens on `:9223`. Restart Claude Code so the MCP server
reconnects. The bridge is **not** active in release builds.

### Why localhost only

The bridge exposes `webview_execute_js` — anyone who can reach the port
can run arbitrary JS in your dev app. We bind `127.0.0.1` explicitly to
keep that off the LAN.
