#!/bin/sh
# Reference render process for the TUI pane surface (revive-plugin-system D-002).
#
# The pui opens this in a zellij pane via the plugin's declared command
# (["sh", "render.sh"]) with cwd = this plugin's install dir. A real plugin
# would render its own TUI (ratatui or anything that draws to the terminal);
# this demo just paints a small live view so the pane is visibly "alive".
#
# It only uses `sh` + coreutils; the plugin declares `compute:exec:sh`, the
# capability the resolver gates on before handing this command to the pui.
trap 'exit 0' INT TERM
while true; do
  clear 2>/dev/null || printf '\033[2J\033[H'
  printf '┌─ example-tui-pane ───────────────────────────────\n'
  printf '│ Papercusp TUI plugin surface — reference pane (D-002)\n'
  printf '│ This pane is rendered by the example-tui-pane plugin.\n'
  printf '│ %s\n' "$(date 2>/dev/null || echo '(date unavailable)')"
  printf '└──────────────────────────────────────────────────\n'
  sleep 1
done
