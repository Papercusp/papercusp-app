#!/usr/bin/env bash
# PreToolUse hook — WORN IDENTITY GUARDS (the pre-tool GUARD port).
#
# Its only possible output is a DENY for this one pending call, naming the
# identity and rule. Silence approves nothing: the client's own permission flow
# still decides. A slow or down operator (1.5s wall) means no verdict, never a
# refusal; a guard that fails to EVALUATE refuses, server-side, where it can be
# named. Never exit 2 here — that would block every call on a hook fault.
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
  node "$dispatcher" --client=claude --event=PreToolUse 2>/dev/null || true
elif [ -x "$dispatcher" ]; then
  "$dispatcher" --client=claude --event=PreToolUse 2>/dev/null || true
fi
exit 0
