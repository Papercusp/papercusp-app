#!/usr/bin/env bash
# UserPromptSubmit hook — TURN-START CTRL TRANSITION + MEMORY DELTA
# (agent-operability P-014; memory-delivery-unification P-003a).
#
# ── THIN EXEC SHIM (codex-context-injection-parity-2026-08-09 P-002 / D-001) ──
# This file used to carry ~60 lines of python-in-shell that parsed the hook
# event, POSTed to the operator, and printed Claude's additionalContext shape.
# That logic now lives in the ONE shared dispatcher, with a per-client adapter:
#
#     apps/operator/scripts/hooks/inject/            (repo)
#     ~/.papercusp/hooks/inject/                     (installed, beside this dir)
#
# Owner directive [owner 2026-08-09]: "there is a single inject context
# function that calls the appropriate function for each tui." The clients still
# invoke a COMMAND — that contract is unchanged, and this file remains that
# command — but every behaviour now has exactly one implementation. Copying this
# script per client was explicitly rejected: it triples the drift surface.
#
# WHAT THE DISPATCHER PRESERVES (D-001 invariants — all still enforced, in
# adapters/claude.mjs + core.mjs, and unit-tested there rather than here):
#   * no PAPERCUSP_SID              -> exit 0, no output (not a psu session)
#   * hard 2.5s wall on turn-start  -> a slow/down operator costs the turn nothing
#   * any failure                   -> exit 0, no output (never wedge a turn)
#   * prompt clamped to 4000 chars  -> bounds the server's query construction
#   * PAPERCUSP_TURN_START_MEMORY=off DEGRADES, it does not suppress: the request
#     still fires with memoryEnabled=false, because turn-start carries the
#     one-shot CTRL transition (mode / loop / route) as well as the memory delta,
#     and a MEMORY preference must never be able to hide a safety-critical
#     control transition. (ports.mjs encodes this as a MODE, not a boolean, so it
#     cannot be flattened by accident — see D-003 §2.)
#
# WHY NOT `exec`: the dispatcher's contract is "always exit 0", but `exec`
# would also surface an interpreter-level failure (a missing `node`) as this
# hook's exit code, which is exactly the class of error that must never reach a
# turn. Running it as a child and forcing exit 0 costs one process and closes
# that hole. stderr is swallowed for the same reason; stdout passes through
# untouched, since that IS the injection payload.
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
  node "$dispatcher" --client=claude --event=UserPromptSubmit 2>/dev/null || true
elif [ -x "$dispatcher" ]; then
  "$dispatcher" --client=claude --event=UserPromptSubmit 2>/dev/null || true
fi
exit 0
