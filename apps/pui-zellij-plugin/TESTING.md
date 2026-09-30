# Testing — `pui-companion` (companion zellij plugin)

The thin `wasm32-wasip1` zellij plugin that is `pui`'s eyes + hands inside zellij
(SP-TUI P-004 / D-008). It links full-duplex to `pui` over one long-lived
`zellij pipe` child; the wire protocol lives in `pui-companion-proto`.

## Run

```bash
cd apps/pui-zellij-plugin

# Offline (fast, CI): pure logic unit tests + lints. Builds natively with an
# empty fn main (the ZellijPlugin impl is wasm-gated).
cargo test
cargo clippy --all-targets                      # native lints, 0 warnings

# The real artifact + its lints (the shipping target):
cargo build --release --target wasm32-wasip1    # → target/wasm32-wasip1/release/pui_companion.wasm
cargo clippy --release --target wasm32-wasip1    # 0 warnings

# Build + install the matched native pui + companion generation (the old
# plugin-only script delegates to this canonical path):
../tui/scripts/install-update.sh

# Live duplex smoke (needs zellij installed; spins up its OWN isolated session):
python3 scripts/live-smoke.py                   # exit 0 = all live checks passed

# Dockview dock-verbs live e2e (Brief 50): drives the FULL proto→plugin→zellij
# path against the real workbench swap presets in an isolated session.
python3 scripts/dock-verbs-smoke.py             # exit 0 = all dock-verb checks passed
```

## What's covered

- **`cargo test` (native)** — `build_topology` (the pure `PaneManifest`+`TabInfo`
  → wire `Topology` mapping; the plugin's "serialize side"). The host-shim half
  (`ZellijPlugin` impl, `cli_pipe_output`, `open_command_pane`, …) is
  `#[cfg(target_arch = "wasm32")]`-gated — zellij's wasm host imports don't link
  natively — so it is exercised by the live smoke, not `cargo test`.
- **`pui-companion-proto`** — the JSON-line protocol round-trips (the "both
  sides" message-format tests live there, shared by plugin + `pui`).
- **`scripts/live-smoke.py`** — the real `zellij pipe` duplex end-to-end against
  a live, fully-isolated zellij session: hello handshake, live topology,
  open-command-pane on command, focus-follow, close → `pane_closed`, and a
  command pane's natural exit → `pane_exited` with the real exit code.
- **`scripts/dock-verbs-smoke.py`** — the dockview dock-verbs (Brief 50 /
  `dockview-workbench-2026-06-05`) end-to-end against the real workbench KDL
  presets in an isolated session: `swap_layout` reported over the wire,
  stack-on-open (`OpenCommandPane{stack:true}` → the agents land in the work
  stack, HUD keeps its slot), `select_swap_layout` to each named preset (incl.
  `:dock left`/`right` mirrors), `next`/`prev` cycling, `stack_panes` by id, and
  `toggle_pane_float` float→re-embed round-trip.

## Non-obvious facts (verified against zellij 0.44.3 — don't re-derive)

- **`bin`, not `cdylib`.** zellij's loader requires a callable `_start`. A
  `wasm32-wasip1` *cdylib* is a "reactor" (only `_initialize`) → zellij fails
  with "could not find exported function". A `bin` is a "command" module:
  `register_plugin!`'s generated `fn main` becomes `_start`, and the
  `#[no_mangle]` load/update/pipe/render exports are still emitted.
- **Permissions.** The plugin requests `ReadApplicationState` +
  `ChangeApplicationState` + **`RunCommands`** + **`ReadCliPipes`**. `RunCommands`
  is required for `open_command_pane` (zellij gates command panes behind it, NOT
  `ChangeApplicationState`); `ReadCliPipes` is required for the
  `cli_pipe_output`/block/unblock that ARE the duplex link.
- **The permission-cache key is the BARE wasm path** (`/abs/path.wasm`), with NO
  `file:` prefix — even though the plugin's data-cache dir uses the `file:` URL.
  `~/.cache/zellij/permissions.kdl`. (The live smoke pre-seeds this in its
  isolated cache; a real first run prompts once — press `y` in the plugin pane.)
- **Routing.** `cli_pipe_output(name, …)` routes back to a CLI pipe by its
  **`pipe_id`** (the per-invocation UUID from `PipeSource::Cli`), NOT the
  `--name`. The plugin captures the id from the first inbound message.
- **Heartbeat.** The `zellij pipe` CLI only drains the plugin's async
  `cli_pipe_output` while in its recv loop; `pui` (and the smoke) send a periodic
  `ping` so events flush while otherwise idle.

## After editing

`cargo test` + `cargo clippy --all-targets` (native) AND
`cargo build --release --target wasm32-wasip1` + its clippy (0 warnings). If you
touched the protocol or the plugin's event/command handling, re-run
`../tui/scripts/install-update.sh && python3 scripts/live-smoke.py`.
