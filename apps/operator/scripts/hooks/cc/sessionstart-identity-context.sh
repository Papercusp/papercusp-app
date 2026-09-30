#!/usr/bin/env bash
# SessionStart hook — WORN IDENTITY COMPACTION RULES (the compaction context port).
#
# Fires on a fresh context: source=compact|clear, and source=startup only when
# the operator knows this owner has taken a turn before (a respawned session,
# D-024 §3). A resume replays a transcript that already holds the context.
#
# portable-identity-packages-2026-09-26 P-011 (plan Decisions D-023 + D-024).
# THIN EXEC SHIM for the ONE shared dispatcher (apps/operator/scripts/hooks/inject/,
# installed beside this dir as ~/.papercusp/hooks/inject/). Every decision —
# which rules a worn identity has at this sink, budgets, fail-open vs fail-closed,
# the render shape — lives in the dispatcher, adapters/claude.mjs and the operator.
# See posttoolbatch-midturn-context.sh for why this runs the dispatcher through
# `node` as a child (never `exec`, never a `-x` guard) and forces exit 0.
#
# PAPERCUSP_IDENTITY_HOOKS=off suppresses this port outright (ports.mjs).

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || exit 0
dispatcher="$here/../inject/index.mjs"
[ -f "$dispatcher" ] || exit 0

if command -v node >/dev/null 2>&1; then
  node "$dispatcher" --client=claude --event=SessionStart 2>/dev/null || true
elif [ -x "$dispatcher" ]; then
  "$dispatcher" --client=claude --event=SessionStart 2>/dev/null || true
fi
exit 0
