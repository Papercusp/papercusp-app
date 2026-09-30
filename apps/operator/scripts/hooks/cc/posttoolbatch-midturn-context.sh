#!/usr/bin/env bash
# PostToolBatch hook — MID-TURN CONTEXT PUSH
# (context-injection-audit-2026-07-28 P-015, decisions D-026 + D-027).
#
# Recall used to arrive at exactly ONE boundary per turn: UserPromptSubmit.
# A turn that submits one prompt and then makes fifty tool calls got a single
# injection and then silence — so an agent could burn twenty greps re-deriving
# something already sitting in memory, because nothing after the prompt ever
# asked. This hook is that missing boundary.
#
# ── THIN EXEC SHIM (codex-context-injection-parity-2026-08-09 P-002 / D-001) ──
# The transport that used to live here (python-in-shell: parse the batch, clamp
# a digest, POST, print Claude's additionalContext shape) now lives in the ONE
# shared dispatcher with a per-client adapter:
#
#     apps/operator/scripts/hooks/inject/            (repo)
#     ~/.papercusp/hooks/inject/                     (installed, beside this dir)
#
# The client still invokes a COMMAND — unchanged, and this file remains that
# command — but the behaviour now has exactly one implementation across every
# TUI. Copying this script per client was explicitly rejected: three copies of a
# transport is three places for the clamps to drift apart.
#
# ⚠ WHY PostToolBatch AND NOT PreToolUse (D-027 — do not "fix" this back):
# PreToolUse does NOT inject additionalContext unless it is accompanied by a
# `permissionDecision`, and emitting `permissionDecision: 'allow'` from a
# CONTEXT hook would blanket auto-approve every tool call it matches, bypassing
# the permission system. A hook that only wants to SAY something must never also
# vote on whether the call runs. PostToolBatch is the documented channel for
# this, carries no permission semantics at all, and fires once after a batch
# resolves BEFORE THE NEXT MODEL REQUEST — exactly the moment the agent is about
# to decide what to do next. This was found by building the PreToolUse version
# first and watching it deliver nothing with every unit test green. The event
# name now lives in adapters/claude.mjs portForEvent(); the reasoning is
# repeated there so a reader of either file cannot "simplify" it away.
#
# ⚠ NOTE FOR OTHER CLIENTS: PostToolBatch is CLAUDE-SPECIFIC. codex has no batch
# event — its analogue is PostToolUse, which fires PER CALL — so the frozen
# InjectionRequest carries `toolCalls` as an ARRAY and codex simply sends a
# one-element one (D-002 §5). Do not "unify" the event names.
#
# DUMB TRANSPORT BY DESIGN: it ships a CLAMPED digest (<=12 calls x 400 chars per
# field); the SERVER derives the query, applies the budget, enforces the cost
# ceiling, and runs the one admission pipeline under the session-epoch dedup
# (port 'mid-turn'). All of that stays fixable without reinstalling this script
# on every box in the fleet.
#
# WHAT THE DISPATCHER PRESERVES (D-001 invariants, enforced + unit-tested in
# adapters/claude.mjs + core.mjs rather than here):
#   * no PAPERCUSP_SID              -> exit 0, no output (not a psu session)
#   * hard 1.5s wall on mid-turn    -> the turn proceeds un-augmented, never late
#   * any failure                   -> exit 0, no output. Never exit 2: on this
#                                      event a non-zero exit STOPS the agentic loop.
#   * PAPERCUSP_MID_TURN_CONTEXT=off SUPPRESSES the port outright — unlike its
#     turn-start sibling, which DEGRADES (still fires, memoryEnabled=false).
#     That asymmetry is deliberate and load-bearing: mid-turn carries recall
#     ONLY, so skipping the call loses nothing, whereas turn-start also carries
#     the one-shot CTRL transition. See D-003 §2 — ports.mjs encodes it as a
#     MODE so the two cannot be collapsed into one boolean by accident.
#
# WHY NOT `exec`: the dispatcher's contract is "always exit 0", but `exec` would
# also surface an interpreter-level failure (a missing `node`) as this hook's
# exit code — and here a non-zero exit does not merely fail the hook, it stops
# the loop. Running it as a child and forcing exit 0 closes that hole. stderr is
# swallowed for the same reason; stdout passes through untouched, since that IS
# the injection payload.
#
# ⚠ GUARD ON -f AND PREFER `node`, NOT `-x` — this bit once, in the exact shape
# this whole plan exists to eliminate. The dispatcher's FILE MODE differs by
# copy: the installer writes index.mjs 0755, but the REPO copy is 0644, and the
# sidecar `cp -a` propagates whatever the source had. A `[ -x ]` guard therefore
# passes in one layout and FAILS SILENTLY (exit 0, no output) in another — a
# broken hook and a hook with nothing to say are byte-identical from outside.
# Invoking through `node` removes the file mode from the contract entirely; it
# adds no new dependency, because the 0755 copy's `#!/usr/bin/env node` shebang
# needs node on PATH anyway. Direct execution stays as the fallback for a
# packaged box where node is only reachable via that shebang.

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || exit 0
dispatcher="$here/../inject/index.mjs"
[ -f "$dispatcher" ] || exit 0

if command -v node >/dev/null 2>&1; then
  node "$dispatcher" --client=claude --event=PostToolBatch 2>/dev/null || true
elif [ -x "$dispatcher" ]; then
  "$dispatcher" --client=claude --event=PostToolBatch 2>/dev/null || true
fi
exit 0
