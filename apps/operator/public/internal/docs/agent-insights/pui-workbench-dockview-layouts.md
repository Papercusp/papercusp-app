# pui workbench is a dockview — stacked work area, swap presets, dock-verbs
URL: /internal/docs/agent-insights/pui-workbench-dockview-layouts

>-

## What

The pui workbench (`apps/tui`, run via `pui workbench`) lays its work area out
like a **dockview**: agent panes open into a zellij **stacked** group (tab-like
— one expanded, the rest collapsed to title rows) beside the fixed HUD, instead
of tiling ever-thinner. It ships:

* **A stacked-by-default KDL** (`apps/tui/src/layout.rs`, `WORKBENCH_KDL`) with
  four `swap_tiled_layout` presets cycled by zellij's default `Alt+[` / `Alt+]`:
  `stacked` (default), `stacked-left` (HUD docked left), `split` (work as even
  rows), `grid` (work auto-tiled 2D).
* **Palette dock-verbs** (`apps/tui/src/app.rs`): `:stack` (gather the work area
  into one stack), `:float [pane]` (float/embed the HUD, or a named work pane),
  `:dock left|right` (dock the HUD to a side via a mirrored preset),
  `:layout next|prev|<name>` (cycle/select a preset).
* **The wire path** — pui → the companion zellij plugin
  (`apps/pui-zellij-plugin`) over `pui-companion-proto`: new `Command`s
  `StackPanes` / `TogglePaneFloat` / `SelectSwapLayout` / `NextSwapLayout` /
  `PrevSwapLayout`, plus a `stack` flag on `OpenCommandPane`; `TabNode` carries
  the active `swap_layout` back so pui labels it in the palette.

Full design + the measured spike: plan `dockview-workbench-2026-06-05` (Brief 50).

## Why it matters

Four zellij 0.44.3 facts (measured in an isolated session, plan D-007) shape the
implementation — get them wrong and the workbench misbehaves:

1. **Stacking on open must be imperative.** With the stacked preset active, a
   plain `new-pane` joins the stack *only when focus is inside the stack* — but
   pui launches fire from the HUD pane, and a plain open from HUD focus **splits
   the HUD 50/50** instead. So the companion opens the pane and then calls
   `stack_panes([work… , new])` using the PaneId `open_command_pane` returns
   synchronously (focus-independent). `new-pane --stacked` is also wrong — it
   stacks onto the *focused* pane (the HUD).
2. **`:dock` rides mirrored presets, not `move-pane`.** A `move-pane left` from
   the HUD gets **absorbed into the adjacent stack** (stacks swallow directional
   moves). So `:dock left/right` selects the `stacked-left`/`stacked` mirror
   preset instead, via a `SelectSwapLayout` state machine (fire
   `next_swap_layout`, re-check the active name on each `TabUpdate`, bounded).
3. **`max_panes` counts ALL panes** — the two plugin bars + the HUD included. For
   W work panes the tab holds W + 3, so tier a preset on `W + 3`, not `W`.
4. **`toggle-pane-embed-or-floating` round-trips cleanly** — floating then
   re-embedding the HUD restores its exact slot, so `:float` is safe.

Also: pui identifies its own HUD pane from `$ZELLIJ_PANE_ID` (set per pane), so
the bare `:float`/`:dock` verbs target the HUD without command-matching; the
work set is "the active tab's non-plugin panes minus the HUD".

## How to apply

* **Editing the presets?** They live in one place — `WORKBENCH_KDL` +
  `SWAP_PRESETS` in `apps/tui/src/layout.rs`. The cycle order in `SWAP_PRESETS`
  must match the `swap_tiled_layout` block order (a unit test pins this), and the
  palette reads `SWAP_PRESETS` to show the cycle. The HUD command pane (`pui
  hud`) and both bars must be re-declared in **every** preset so a swap re-slots
  them.
* **Adding a dock-verb?** It's a four-touch change kept in lockstep:
  `pui-companion-proto` (the `Command`), the plugin's `handle_command`
  (`apps/pui-zellij-plugin/src/main.rs`), the `Companion` send method +
  `MuxAction` CLI fallback (`companion.rs` / `mux.rs`), and the palette
  parse→reducer→`Action::Dock` path (`app.rs`) + the run-loop arm (`main.rs`).
  **Edit both proto ends in the same batch** — a proto field added without
  updating `companion.rs`'s `OpenCommandPane` construction reds the whole
  `apps/tui` build for every peer.
* **Verifying?** `cargo test` covers the pure layers (KDL contract, parser,
  reducer dispatch, work-set/HUD resolution, argv). The live wire path —
  proto → plugin → real zellij — is
  `apps/pui-zellij-plugin/scripts/dock-verbs-smoke.py` (a sibling of
  `live-smoke.py`; spins up its OWN isolated zellij session, never the user's).
  Run it after `./scripts/build-install.sh` reinstalls the wasm.
