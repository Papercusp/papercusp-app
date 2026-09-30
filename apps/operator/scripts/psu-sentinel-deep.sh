#!/usr/bin/env bash
# psu-sentinel-deep — dock deep-brain pane launcher
# (voice-public-release-readiness-2026-07-12 P-014/D-006).
#
# The papercup-deep pane: the persistent, parked-until-woken heavy half of the
# ONE user-facing "Papercup" identity. The fast front-end pane (psu-sentinel →
# role=papercup) delegates real investigation to this session over coord/wake;
# this pane just has to EXIST and stay resident so those wakes land somewhere.
#
# Registers THIS zellij pane's id + session to ~/.papercusp/sentinel-deep-pane
# (parity with the front-end's sentinel-pane registration — pane-targeted
# writes, debugging, future P-006 channel needs). Re-runs on every dock
# relaunch (the dock is volatile), so the registration always reflects the
# current pane.
#
# Source of truth lives in the repo at apps/operator/scripts/psu-sentinel-deep.sh;
# this is the PATH-resolvable shim the dock layout invokes by name. Keep in
# lockstep with the packaged twin (writeSentinelDeepShim in
# packages/operator-core/lib/desktop-install/papercusp-files.ts).
mkdir -p "$HOME/.papercusp" 2>/dev/null || true
if [ -n "$ZELLIJ_PANE_ID" ] && [ -n "$ZELLIJ_SESSION_NAME" ]; then
  printf '%s %s' "$ZELLIJ_SESSION_NAME" "$ZELLIJ_PANE_ID" \
    > "$HOME/.papercusp/sentinel-deep-pane" 2>/dev/null || true
fi
# Session MODEL override: ~/.papercusp/sentinel-deep-model holds `model[:effort]`
# when the owner overrides it. Absent ⇒ DEFAULT to the HEAVY spec — this session
# exists to take long, deep, uninterruptable turns (the exact opposite of the
# front-end's sonnet:medium fast default); depth is its contract, the fast pane
# owns responsiveness (D-006/D-007). Colon form is Claude Code's native --model
# format, passed through verbatim. Re-read every launch.
spec='opus:xhigh'
if [ -s "$HOME/.papercusp/sentinel-deep-model" ]; then
  file_spec="$(tr -d ' \t\r\n' < "$HOME/.papercusp/sentinel-deep-model" 2>/dev/null)"
  [ -n "$file_spec" ] && spec="$file_spec"
fi
model_args=("--model=$spec")
# Role `papercup-deep` (PROMPT_ROLES + papercup-deep.persona.md): a
# workspace-level role session (no --harness), same launch shape as the
# front-end pane. Never user-facing — it speaks only over coord.
exec psu --no-picker --agent=claude --role=papercup-deep "${model_args[@]}"
