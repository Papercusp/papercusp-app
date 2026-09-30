# pui headless smoke: scratch zellij session, CR-not-LF keys, restore ViewState
URL: /internal/docs/agent-insights/pui-headless-smoke-recipe

How to drive the pui TUI end-to-end without touching the user's workbench — and the three traps (tips dialog, \\n vs \\r, shared ViewState owner row)

Driving the **pui TUI** live (agent-run e2e) has no Tauri-style documented
recipe. This one works and is isolation-safe (proven 2026-06-12 verifying the
`:theme` switcher, workbench-theme-system P-002):

```bash
# 1. Scratch config dir — pui's zellij writes (and zellij itself) land here,
#    NOT in the user's ~/.config/zellij. Boot a DEDICATED session under a pty.
SCRATCH=$(mktemp -d); echo "// scratch" > $SCRATCH/config.kdl
export ZELLIJ_CONFIG_DIR=$SCRATCH
script -qfc "zellij --session my-smoke" /dev/null >/dev/null 2>&1 &

# 2. Drive it
zellij --session my-smoke action write-chars $'...keys...'
zellij --session my-smoke action dump-screen            # stdout (0.44: no path arg)
zellij --session my-smoke action dump-screen --ansi     # assert actual RGB cells

# 3. Tear down
zellij kill-session my-smoke; zellij delete-session my-smoke; rm -rf $SCRATCH
```

The three traps:

1. **A zellij startup "tips" dialog swallows your first keystrokes.** Send a
   lone `$'\x1b'` (Esc) after boot, *then* type. If your first command line
   "vanished", this is why.
2. **Enter is `\r`, not `\n`.** crossterm maps LF (0x0A) to ctrl-j — in pui's
   palette it appends a literal `j` instead of submitting. Always end
   `write-chars` command lines with `$'\r'`.
3. **pui shares the user's real backend state.** `workbench_owner()` is
   `$USER[@host]`, so anything your smoke persists (ViewState: theme, tab,
   selections — `harness_shared.tui_view_state`) lands on the **user's own
   row**. Restore what you changed before quitting (e.g. `:theme frost`), and
   verify via `GET :3070/api/tui/view-state?owner=$(whoami)`.

Bonus: `ZELLIJ_CONFIG_DIR=$SCRATCH zellij setup --check` is a cheap parse gate
for generated config/themes KDL — "Well defined." or a loud error.
