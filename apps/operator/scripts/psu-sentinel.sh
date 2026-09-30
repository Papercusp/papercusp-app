#!/usr/bin/env bash
# psu-sentinel — dock 🛡 Sentinel pane launcher (sentinel-as-claude-tui-2026-06-22).
#
# Registers THIS zellij pane's id + session so /api/operator/sentinel-input can
# write voice transcripts straight to the Sentinel pane (via `write-chars
# --pane-id`), instead of whatever pane happens to be focused. Then launches the
# Sentinel Claude TUI exactly as before. Re-runs on every dock relaunch (the
# dock is volatile), so the registration always reflects the current pane.
#
# Source of truth lives in the repo at apps/operator/scripts/psu-sentinel.sh;
# this is the PATH-resolvable shim the dock layout invokes by name.
mkdir -p "$HOME/.papercusp" 2>/dev/null || true
if [ -n "$ZELLIJ_PANE_ID" ] && [ -n "$ZELLIJ_SESSION_NAME" ]; then
  printf '%s %s' "$ZELLIJ_SESSION_NAME" "$ZELLIJ_PANE_ID" \
    > "$HOME/.papercusp/sentinel-pane" 2>/dev/null || true
fi
# Session MODEL override (model-override-sidebar-2026-06-23): the Sentinel sidebar
# tab writes the chosen `model[:effort]` spec to ~/.papercusp/sentinel-model
# (projected from owner-steering by hive:set-steering — the bash wrapper can't read
# PG). Present ⇒ launch the Sentinel at that spec. Absent ⇒ DEFAULT to a FAST spec:
# this pane is the papercup-fast voice front-end and must answer inside the voice
# pipeline's response window — the old absent⇒workspace-default fallback is how the
# pane became a too-slow heavy Opus session that voice turns died against
# (voice-public-release-readiness D-007). The `model:effort` colon form is Claude
# Code's native --model format (e.g. `sonnet:medium`), passed through verbatim.
# Re-read every launch (the dock is volatile) so a change applies on relaunch.
# Keep in lockstep with the packaged twin (writeSentinelShim in
# packages/operator-core/lib/desktop-install/papercusp-files.ts).
spec='sonnet:medium'
if [ -s "$HOME/.papercusp/sentinel-model" ]; then
  file_spec="$(tr -d ' \t\r\n' < "$HOME/.papercusp/sentinel-model" 2>/dev/null)"
  [ -n "$file_spec" ] && spec="$file_spec"
fi
model_args=("--model=$spec")
# Role is `papercup` (sentinel→papercup rename, 2026-07: PROMPT_ROLES + the
# papercup.persona*.md prompt set). Passing the retired `--role=sentinel` makes
# buildRoleLaunchSpec→assembleRolePrompt fail to resolve the (renamed) prompt
# files, so the pane's psu agent errors out "about the sentinel". The launcher
# SCRIPT name + the ~/.papercusp/sentinel-pane registration file keep their old
# names on purpose (the dock layout invokes this shim by name; the pane-input
# reader agrees on that path) — only the ROLE flag moved.
exec psu --no-picker --agent=claude --role=papercup "${model_args[@]}"
