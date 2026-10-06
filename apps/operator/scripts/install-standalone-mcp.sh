#!/usr/bin/env bash
# install-standalone-mcp.sh — set up papercusp's superuser MCP endpoint
# for an OMP / Claude Code / Codex shell launched outside papercusp.
# (Gemini is NOT a supported client.)
#
# What this does:
#   1. Generates a 32-byte random token
#   2. Writes ~/.papercusp/superuser-token (mode 0600)
#   3. MERGES a `papercusp-su` server entry into ~/.omp/agent/mcp.json
#      AND ~/.claude.json (preserves any other MCP servers already
#      configured in either client).
#   4. Writes the engineer-collaborator playbook + coordination extension
#      as standalone OPT-IN files under ~/.papercusp/, and installs `psu`
#      (the one launcher). The `*-su` wrappers are RETIRED — `psu` →
#      `bootstrap-su` → `buildLaunchSpec` assembles the playbook + MCP +
#      flags per-launch and execs the RAW CLI. Plain `omp` / `claude` /
#      `codex` are left untouched.
#   4b. Installs the SU-locks ENFORCEMENT hook scripts + wires them where
#      the client actually reads them:
#        - Claude → Pre/PostToolUse in ~/.claude/settings.json (USER-level,
#          automatic — survives a raw `claude`/`psu` launch).
#        - OMP    → coord-hook.ts, loaded per-launch by psu via `-e`.
#        - Codex  → hooks.json in the per-session CODEX_HOME psu mints.
#          Current managed Codex builds fire Pre/PostToolUse on apply_patch;
#          owner-scoped runtime markers decide automatic vs explicit-manual
#          mode instead of a static version assumption.
#      Claude and Codex share one hook-script pair (same hook wire format).
#   5. Verifies HTTP 200 against the running operator
#
# Re-running REUSES the existing token (so live shells keep working),
# updates the MCP entry, and refreshes the playbook, the coordination
# extension, and `psu`. To rotate the token deliberately, delete
# ~/.papercusp/superuser-token first, then re-run.
#
# Threat model: friction, not enforcement. Any process running as the
# same user can read ~/.papercusp/superuser-token. See
# /docs/endpoint-system/superuser-mode.

set -euo pipefail

# `pwd -P` resolves symlinks so SCRIPT_DIR is the PHYSICAL path. The generated
# psu/ptool shims `exec node "${SCRIPT_DIR}/<x>.mjs"`, and Node realpaths the main
# module for `import.meta.url`; if SCRIPT_DIR kept a symlink (e.g. invoked via the
# papercup→papercusp compat link), argv[1] != import.meta.url and the launcher's
# `isMain` guard fails → psu/ptool exit 0 doing nothing. Canonicalize here.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# WI-1457 hardening (mcp-host-availability-resilience P-005/P-006): when the
# resilient MCP proxy's systemd unit is ACTIVE, mint configs against the proxy —
# a :3070 deploy restart is then invisible to sessions (retry-on-refused; never
# double-applies a write). The /api/health check through the proxy is ADVISORY
# only (mcp-outage-triage-2026-07-02): a transient health blip at mint time used
# to bake a direct-:3070 default into durable config — the exact regression this
# block exists to prevent — so health failure now warns instead of rerouting.
# An explicit PAPERCUSP_OPERATOR_URL still wins; PAPERCUSP_MCP_PROXY=0 opts out.
# This is precisely the re-mint path that silently REGRESSED the P-006 cutover
# (configs re-baked to direct :3070 while the proxy sat active-but-unrouted).
MCP_PROXY_PORT="${PAPERCUSP_MCP_PROXY_PORT:-9071}"
# An INHERITED default-direct pin (a parent process exporting the plain :3070
# base — e.g. a long-lived pre-cutover session spawning this install) is NOT an
# intentional override for MINTING purposes: baking a transient env pin into
# durable config is exactly the WI-1457 regression. Only a NON-default explicit
# PAPERCUSP_OPERATOR_URL suppresses the proxy preference.
case "${PAPERCUSP_OPERATOR_URL:-}" in
  ''|http://localhost:3070|http://127.0.0.1:3070) MINT_ENV_AUTHORITATIVE=0 ;;
  *) MINT_ENV_AUTHORITATIVE=1 ;;
esac
if [ "$MINT_ENV_AUTHORITATIVE" = "0" ] && [ "${PAPERCUSP_MCP_PROXY:-1}" != "0" ] \
  && systemctl --user is-active --quiet papercup-mcp-proxy 2>/dev/null; then
  OPERATOR_URL="http://127.0.0.1:${MCP_PROXY_PORT}"
  echo "→ Resilient MCP proxy ACTIVE on :${MCP_PROXY_PORT} — minting configs against the proxy (WI-1457)"
  if [ "$(curl -s -o /dev/null -m 6 -w '%{http_code}' "http://127.0.0.1:${MCP_PROXY_PORT}/api/health" 2>/dev/null)" != "200" ]; then
    echo "  ⚠ /api/health through the proxy did not return 200 right now — minting against it anyway" >&2
    echo "    (the proxy bridges operator restarts; a direct :3070 default would be the permanent regression)." >&2
  fi
  if [ -n "${PAPERCUSP_OPERATOR_URL:-}" ]; then
    echo "  (inherited PAPERCUSP_OPERATOR_URL=${PAPERCUSP_OPERATOR_URL} is the plain direct default — not baked into durable config)"
  fi
else
  # P-007 (mcp-reliability-hardening-2026-07-11): the resilient MCP proxy is the
  # DEFAULT fallback — never a bare direct :3070. The else branch is reached in
  # three sub-cases; keep them distinct so a transient proxy-inactive at mint time
  # can no longer silently bake the deploy-fragile direct default (the exact
  # WI-1457 / P-006-cutover regression the block above warns about):
  #   (A) an explicit NON-default PAPERCUSP_OPERATOR_URL  → honour it verbatim;
  #   (B) an explicit proxy opt-out (PAPERCUSP_MCP_PROXY=0) → direct :3070 by design;
  #   (C) the proxy systemd unit is merely inactive right now → STILL mint against
  #       the proxy port (:9071). The proxy is the always-up resilient front; if it
  #       is momentarily down the per-launch env (resolveOperatorUrl) overrides, and
  #       baking a direct :3070 fallback here is the permanent regression, not a fix.
  if [ "$MINT_ENV_AUTHORITATIVE" = "1" ]; then
    OPERATOR_URL="${PAPERCUSP_OPERATOR_URL}"                 # (A) explicit override wins
  elif [ "${PAPERCUSP_MCP_PROXY:-1}" = "0" ]; then
    OPERATOR_URL="http://localhost:3070"                     # (B) explicit opt-out → direct
  else
    OPERATOR_URL="http://127.0.0.1:${MCP_PROXY_PORT}"        # (C) proxy is the resilient default
    echo "→ Resilient MCP proxy unit not active right now — minting configs against its default port :${MCP_PROXY_PORT} anyway (WI-1457/P-007: a direct :3070 fallback is the regression, not a fix)"
  fi
fi
TOKEN_PATH="${HOME}/.papercusp/superuser-token"

# Parse --profile=engineer|power (default: engineer).
# engineer — full Papercusp-engineer playbook (238 tools, all scopes).
# power    — power-engineer subset (generic Group B + Group C harness tools).
PROFILE="engineer"
for arg in "$@"; do
  case "$arg" in
    --profile=engineer) PROFILE="engineer" ;;
    --profile=power)    PROFILE="power" ;;
    --profile=*)
      echo "! Unknown profile '${arg#--profile=}'. Valid: engineer, power" >&2
      exit 1
      ;;
  esac
done

PROMPTS_DIR="${SCRIPT_DIR}/../prompts"
PLAYBOOK_PATH="${PROMPTS_DIR}/papercusp-su-${PROFILE}.tools.md"
# Per-client tooling overlays (profile-independent). The shared base
# playbook carries client-neutral guidance; each client's native
# task/workflow tooling (OMP vs Claude Code vs Codex) lives in its own
# overlay, spliced into the base at the CLIENT-TOOLING-OVERLAY marker by
# render_playbook below. This is what keeps OMP-only task-tool guidance
# out of the Claude/Codex playbooks.
OVERLAY_OMP="${PROMPTS_DIR}/papercusp-su.omp.md"
OVERLAY_CLAUDE="${PROMPTS_DIR}/papercusp-su.claude.md"
OVERLAY_CODEX="${PROMPTS_DIR}/papercusp-su.codex.md"
# The repo project guide (psu-isolation P-001 / D-002): SCRIPT_DIR is
# apps/operator/scripts, so the repo root is three up. CLAUDE.md is the single
# editable source (AGENTS.md is a symlink to it); render_playbook splices it at
# the PROJECT-GUIDE marker for the engineer profile's static fallback.
PROJECT_GUIDE_PATH="${SCRIPT_DIR}/../../../CLAUDE.md"

# Splice a client overlay (+ the project guide) into the base playbook at the
# markers. Falls back to appending if the overlay marker is absent, or to
# base-only if the overlay file is missing. One source of truth for the base.
#
# args: <base_path> <overlay_path> <dest_path> <project_guide_path>
#
# PROJECT-GUIDE marker (psu-isolation P-001 / D-002): splice the repo's CLAUDE.md
# (the single editable project guide; AGENTS.md is a symlink to it) at the marker,
# with the SAME provenance wrapper renderProjectGuideSection() writes in the TS
# path, so this static fallback matches the live per-launch render.
#
# OTHER GENERATED-section markers (WIRE-SCHEMAS / COORD-LEGEND / WORKSPACE-MAP)
# are rendered by the TS path (renderSuPlaybook) only — this shell path has no
# renderer, so it STRIPS any remaining PAPERCUSP-SU:* markers rather than shipping
# them literally. (The installer-written ~/.papercusp playbooks are the vestigial
# fallback; psu launches render fresh via the TS path, which DOES render those.)
render_playbook() {
  python3 - "$1" "$2" "$3" "${4:-}" <<'PYEOF'
import re
import sys
base_path, overlay_path, dest_path = sys.argv[1], sys.argv[2], sys.argv[3]
guide_path = sys.argv[4] if len(sys.argv) > 4 else ""
marker = "<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->"
guide_marker = "<!-- PAPERCUSP-SU:PROJECT-GUIDE -->"
with open(base_path) as f:
    base = f.read()
try:
    with open(overlay_path) as f:
        overlay = f.read().rstrip("\n")
except FileNotFoundError:
    overlay = ""
out = base.replace(marker, overlay) if marker in base else base.rstrip("\n") + "\n\n" + overlay + "\n"
# Project guide (P-001 / D-002): splice the repo CLAUDE.md at its marker.
if guide_marker in out:
    section = ""
    try:
        with open(guide_path) as f:
            body = f.read().rstrip("\n").strip()
        if body:
            section = (
                "## Project guide — repo conventions\n\n"
                "> The following is the working repo's project guide (`CLAUDE.md` at the\n"
                "> repo root — the single editable source; `AGENTS.md` is a symlink to it).\n"
                "> It is spliced in here so a psu session gets these conventions WITHOUT the\n"
                "> client auto-loading the file (which would also drag in the launching\n"
                "> user's personal/global config). To change it, edit the repo's `CLAUDE.md`.\n\n"
                + body + "\n"
            )
    except (FileNotFoundError, OSError):
        section = ""
    out = out.replace(guide_marker, section)
# agent-managed-compaction: splice the self-management compaction protocol at its
# marker (before the generic PAPERCUSP-SU:* strip below would remove the leftover).
compaction_marker = "<!-- PAPERCUSP-SU:COMPACTION -->"
if compaction_marker in out:
    protocol = ""
    try:
        import os
        proto_path = os.path.join(os.path.dirname(base_path), "papercusp-compaction.protocol.md")
        with open(proto_path) as pf:
            protocol = pf.read().rstrip("\n")
    except (FileNotFoundError, OSError):
        protocol = ""
    out = out.replace(compaction_marker, protocol)
out = re.sub(r"<!-- PAPERCUSP-SU:[A-Z-]+ -->\n?", "", out)
with open(dest_path, "w") as f:
    f.write(out)
PYEOF
}

# Workspace root = the parent of this checkout. All papercup worktrees
# (papercup, papercup-<topic>, …) are siblings under it; the lock hooks
# scope enforcement to this dir so a plain `claude`/`codex` editing an
# unrelated git repo never locks it into the shared store.
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
# The dependency mutex is keyed to the checkout itself, not the workspace
# parent. Keep this explicit so the generated ptool shim protects the same
# node_modules tree as install:safe, even when the installer was invoked via
# the papercup -> papercusp compatibility symlink.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# Shared Claude+Codex lock-enforcement hooks. Both clients implement the
# same hook wire format (PreToolUse/PostToolUse, settings.json,
# permissionDecision), so ONE script pair serves both. Installed to a
# stable runtime location (the repo copy isn't on the agents' radar).
CC_HOOK_SRC_DIR="${SCRIPT_DIR}/hooks/cc"
CC_HOOK_DEST_DIR="${HOME}/.papercusp/hooks/cc"
CC_PRE_HOOK="${CC_HOOK_DEST_DIR}/pretooluse-locks-acquire.sh"
CC_POST_HOOK="${CC_HOOK_DEST_DIR}/posttooluse-locks-release.sh"
# Separate PostToolUse hook: mirror every native tool call into the cross-CLI
# ACTIVITY BRIDGE (papercusp-worker-integration-2026-06-04) → the pui fleet view
# + curator, AND (EI-11405 / coordination-hook-rpc-fanout-collapse-2026-07-16)
# fold in NEW coord:inbox messages mid-turn on the SAME round trip — the
# separate posttooluse-coord-inbox.sh hook this used to be paired with is
# retired. psu sessions only (scopes itself via PAPERCUSP_SID). Its own
# settings.json entry, matcher "*"; synchronous (it reads the folded response).
CC_ACTIVITY_HOOK="${CC_HOOK_DEST_DIR}/posttooluse-activity-report.sh"
# PostToolUse full-write byte-integrity diagnostic (EI-21220966892195714):
# compare the requested UTF-8 bytes with the resulting file immediately after
# Write/capability:write dispatch. The copy loop below installs the payload;
# this variable is the settings-registration path.
CC_WRITE_BYTE_INTEGRITY_HOOK="${CC_HOOK_DEST_DIR}/posttooluse-write-byte-integrity-guard.mjs"
# PreToolUse counterpart (EI-8997): the SAME activity bridge, reported at
# dispatch time instead of completion — closes the D-003 claim-renewal gap a
# single long-running tool call leaves during PostToolUse-only reporting.
CC_PRE_ACTIVITY_HOOK="${CC_HOOK_DEST_DIR}/pretooluse-activity-report.sh"
# SessionStart/SessionEnd hook: report a worker's session LIFECYCLE (appeared/left)
# into the activity bridge — a kind='lifecycle' marker for the fleet view.
CC_LIFECYCLE_HOOK="${CC_HOOK_DEST_DIR}/lifecycle-report.sh"
# Claude-only progressive enhancement (papercusp-worker-integration D-005): a
# statusline rendering the cross-CLI fleet glance from the activity bridge.
# Registered NON-destructively (only when the user has no existing statusLine) so
# it never clobbers a personal statusline; trivially removable.
CC_STATUSLINE="${CC_HOOK_DEST_DIR}/statusline-fleet.sh"
# PostToolUse objective-title hook (session-objective-display-2026-06-22): set the
# terminal title to this session's coord:glance self.objective — the Codex/OMP
# counterpart of the Claude statusline's leading 🔭 segment (those CLIs have no
# statusline but own a tty). Wired into each per-session codex hooks.json by
# writeCodexLockHooks; the OMP coord-hook fires it per-turn.
CC_OBJECTIVE_HOOK="${CC_HOOK_DEST_DIR}/posttooluse-objective-title.sh"
# PreToolUse Bash gate: refuse a raw destructive command (systemctl restart /
# psql -f / …) that collides with an in-flight EXCLUSIVE hold on a registered
# named resource (plan named-resource-locks-drain, P-026). Its own settings
# entry, matcher "Bash"; fail-open + a local keyword pre-filter so the vast
# majority of commands never hit the operator.
CC_BASH_GATE_HOOK="${CC_HOOK_DEST_DIR}/pretooluse-bash-resource-gate.sh"
# PreToolUse plans-read guard (kickoff-prompt-absorption-2026-07-17, P-003(b)):
# teach `plans:get` at the point of failure when a Read/Grep targets a
# docs/plans/*.md file — that on-disk markdown is a PROJECTION of the live
# plan store, missing computed effectiveStatus/decisions/links. Its own
# settings entry, matcher "Read|Grep"; fail-open, narrowly scoped (see the
# script's own header for what it deliberately does NOT cover).
CC_PLANS_GUARD_HOOK="${CC_HOOK_DEST_DIR}/pretooluse-plans-read-guard.sh"
# PostToolUse + Stop/SessionEnd hook: the PER-TURN VERIFY-not-CREATE work-item
# BACKSTOP (enforce-system-on-generic-work-2026-06-29, P-019). Marks a session that
# edited workspace code; at turn/session end, if the session holds no objective in
# the ledger (coord:glance self.objective empty) it emits ONE reminder to open a
# work-item. Never creates anything; gated behind papercusp-workitem-verify-nudge
# (default ON); fail-open + fire-and-forget + psu-gated. Own settings entries.
CC_WORKITEM_NUDGE_HOOK="${CC_HOOK_DEST_DIR}/workitem-verify-nudge.sh"
# UserPromptSubmit turn-provenance hook (turn-provenance-owner-vs-agent-2026-07-11
# P-003): classify every submitted prompt against the injectors' envelope+nonce
# ledger (~/.papercusp/turn-provenance/) and stamp additionalContext — VERIFIED
# agent-origin / UNVERIFIED origin claim / affirmative OWNER — so agents stop
# mis-attributing machine-injected turns (wakes, loop fires, compaction
# continuations) to the owner. Local-file-only hot path, fail-open, psu-gated.
CC_PROVENANCE_HOOK="${CC_HOOK_DEST_DIR}/userpromptsubmit-provenance.sh"
# UserPromptSubmit hook (memory-delivery-unification-2026-07-12 P-003a):
# turn-start memory delta — small high-precision recall for THIS prompt via
# the local operator, deduped per session epoch (never re-pays what the
# initialize prelude / orient / a claim port already injected). Fail-open,
# psu-gated, 2.5s wall.
CC_TURN_MEMORY_HOOK="${CC_HOOK_DEST_DIR}/userpromptsubmit-memory.sh"
# PostToolBatch hook (context-injection-audit-2026-07-28 P-015, D-026 + D-027):
# the MID-TURN half of the same delta. turn-start fires once per prompt, so a turn
# with fifty tool calls got one injection and then silence; this fires once per
# resolved tool batch, before the next model request, epoch-deduped through the
# same ledger under port 'mid-turn' at ~1/10th the budget.
# ⚠ NOT PreToolUse (D-027): that event only injects additionalContext alongside a
# permissionDecision, and a context hook emitting 'allow' would blanket
# auto-approve every call it matched. PostToolBatch takes no matcher and carries
# no permission semantics. Fail-open, psu-gated, 1.5s wall.
CC_MIDTURN_CONTEXT_HOOK="${CC_HOOK_DEST_DIR}/posttoolbatch-midturn-context.sh"
# Claude native edit-batch lock lifecycle: PostToolUse defers union-lock
# release, and this matcher-less PostToolBatch hook releases it once.
CC_POST_BATCH_LOCKS_HOOK="${CC_HOOK_DEST_DIR}/posttoolbatch-locks-release.sh"
# Stop hook (deterministic-context-carry-2026-07-14 P-012): per-turn journal —
# pings journal:record-turn at each turn end; the server extracts the agent's
# ⟦journal⟧ line (mechanical first-line fallback, flagged). Fire-and-forget,
# fail-open, psu-gated.
CC_TURN_JOURNAL_HOOK="${CC_HOOK_DEST_DIR}/stop-turn-journal.sh"
# PreToolUse+PostToolUse+Notification+Stop hook (owner-inbox-single-pane-2026-07-17
# P-001): the owner-gate CAPTURE + MIRROR layer. PreToolUse/PostToolUse (matcher
# "AskUserQuestion|ExitPlanMode") open/close a client-agnostic blocked-session gate
# (sessions:ingest-gate-event, P-002) around the two Claude-native dialogs;
# Notification captures a permission-wait; Stop parses the turn's final text for a
# structured `<ask>` block (mirrors it to coord:escalate) or BOUNCES a bare
# question-shaped ending with no structured mirror (loop-guarded via
# stop_hook_active). Own settings entries (4 — see the script's own header).
CC_ASK_GATE_HOOK="${CC_HOOK_DEST_DIR}/ask-gate-mirror.sh"
CC_GUARD_OPERATOR_DESKTOP_HOOK="${CC_HOOK_DEST_DIR}/guard-operator-desktop.mjs"
# PreToolUse hook (git-sync-dx-hardening-2026-06-17 P-013, wired WI-5543): advisory
# curly/"smart"-quote content-lint on .ts/.tsx Edit|Write|MultiEdit — catches a hard
# tsc/esbuild parse failure at EDIT time instead of ~10-50min later post-commit via the
# git-sync content-guard. Fail-open, never blocks.
CC_CONTENT_LINT_HOOK="${CC_HOOK_DEST_DIR}/pretooluse-content-lint.mjs"
# PostToolUse MDX compiler nudge (EI-19450114644493388): reads the complete
# resulting .mdx file and reports a real compiler error before git-sync quarantine.
CC_MDX_NUDGE_HOOK="${CC_HOOK_DEST_DIR}/posttooluse-mdx-nudge.mjs"
# PostToolUse frozen-candidate edit nudge (frozen-candidate-compliance-enforcement-2026-08-30
# P-004/P-005): you edited a path the FROZEN gate candidate is failing on, so the fix lands
# above the judged sha and the gate cannot see it. Reads a marker file projected by the
# queue's own write path; costs one failed read when nothing is frozen.
CC_FROZEN_CANDIDATE_EDIT_HOOK="${CC_HOOK_DEST_DIR}/posttooluse-frozen-candidate-edit-nudge.mjs"
# PreToolUse hard-DENY hook (su-papercusp-way-gate-2026-07-06 P-006, wired WI-5542):
# blocks a key-shaped secret (sk-/ghp_/AKIA…/PEM block) from ever reaching a
# shared git-sync tree file. Was orphaned at repo-root scripts/cc-hooks/ and never
# wired into any installer — see the script's own header.
CC_SECRETS_GUARD_HOOK="${CC_HOOK_DEST_DIR}/pretooluse-secrets-guard.mjs"
# PreToolUse hard-DENY hook (EI-18896033546676518): blocks Edit/MultiEdit on any file
# that already contains a raw NUL byte — the Edit tool has a confirmed round-trip
# corruption bug on such files (silently writes a different byte than requested while
# reporting success). See the script's own header for the full writeup.
CC_NUL_BYTE_EDIT_GUARD_HOOK="${CC_HOOK_DEST_DIR}/pretooluse-nul-byte-edit-guard.mjs"
# PreToolUse observational hook (EI-18680056073436345): enrolls the Claude-CLI-native
# ScheduleWakeup tool into the turn-provenance ledger AT SCHEDULE TIME (hash + a
# per-row ttl sized to the requested delay), so its eventual delivery classifies
# VERIFIED agent-origin instead of the affirmative-OWNER default. Never blocks.
CC_SCHEDULE_WAKEUP_PROVENANCE_HOOK="${CC_HOOK_DEST_DIR}/pretooluse-schedule-wakeup-provenance.mjs"
# PreToolUse ADVISORY hook (EI-19966323166806405): warns (never denies) when a Write
# targets an existing file with no matching Read/Edit/MultiEdit/Write earlier in the
# session's transcript — the native Write tool silently overwrote a 350-line un-Read
# file instead of refusing, per its own stated contract. See the script's own header.
CC_WRITE_OVERWRITE_GUARD_HOOK="${CC_HOOK_DEST_DIR}/pretooluse-write-overwrite-guard.mjs"

# Merge our PreToolUse + PostToolUse lock hooks into a settings.json
# (Claude's ~/.claude/settings.json or a codex-su CODEX_HOME). Idempotent
# and non-destructive: removes any prior entry pointing at our two
# scripts (so re-runs don't duplicate), preserves every other user hook,
# then appends fresh entries with the given tool-name matcher.
#   $1 = settings.json path   $2 = matcher regex (e.g. "Edit|Write")
merge_lock_hooks() {
  python3 - "$1" "$2" "$CC_PRE_HOOK" "$CC_POST_HOOK" "$CC_POST_BATCH_LOCKS_HOOK" "$WORKSPACE_ROOT" <<'PYEOF'
import json, os, sys, time
path, matcher, pre, post, post_batch, workspace_root = sys.argv[1:7]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {
    pre, post, post_batch,
    os.path.basename(pre), os.path.basename(post), os.path.basename(post_batch),
}

def drop_ours(entry):
    # See the sibling merge_* helpers below for why this filters at the command
    # level, not the whole-entry level (EI-8997 follow-up).
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

# Pass the workspace root through so the hook scopes correctly even on a
# non-default layout. Claude/Codex run hook commands through a shell, so
# an env prefix is honored.
pre_cmd = f"PAPERCUSP_WORKSPACE_ROOT={workspace_root!r} {pre}"
post_cmd = f"PAPERCUSP_WORKSPACE_ROOT={workspace_root!r} {post}"
post_batch_cmd = f"PAPERCUSP_WORKSPACE_ROOT={workspace_root!r} {post_batch}"

hooks = cfg.setdefault('hooks', {})
for event, cmd in (('PreToolUse', pre_cmd), ('PostToolUse', post_cmd)):
    arr = [e for e in (drop_ours(x) for x in hooks.get(event, [])) if e]  # drop stale ours
    arr.append({'matcher': matcher,
                'hooks': [{'type': 'command', 'command': cmd}]})
    hooks[event] = arr

# PostToolBatch has no matcher. Keep the lock-release hook before the context
# injector so the union is released/cleaned before the next model request.
arr = [e for e in (drop_ours(x) for x in hooks.get('PostToolBatch', [])) if e]
if os.path.isfile(post_batch):
    arr.append({'hooks': [{'type': 'command', 'command': post_batch_cmd}]})
hooks['PostToolBatch'] = arr

# Claude Code: auto-approve project-scoped .mcp.json servers (the operator-SIGNED papercusp MCP)
# so a :3070 restart that re-mints .mcp.json never drops the session to "pending approval" and go
# dark (2026-07-01 MCP auto-reconnect fix). Approval keys to the server NAME, not the URL, so a
# URL re-mint is transparent — the client's own reconnect re-attaches with no human /mcp. Claude-
# only key; skip codex homes.
if path.rstrip('/').endswith('.claude/settings.json'):
    cfg['enableAllProjectMcpServers'] = True

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the turn-provenance UserPromptSubmit hook as its OWN entry (no matcher —
# UserPromptSubmit fires on every prompt). Idempotent: drops any prior entry
# pointing at our script, preserves all other hooks, then appends fresh. The hook
# scopes itself to psu sessions via PAPERCUSP_SID and is local-file-only + fail-
# open, so it is inert outside psu and can never block a prompt.
#   $1 = settings.json path
merge_provenance_hook() {
  python3 - "$1" "$CC_PROVENANCE_HOOK" "$WORKSPACE_ROOT" <<'PYEOF'
import json, os, sys, time
path, prov, workspace_root = sys.argv[1:4]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {prov, os.path.basename(prov)}

def drop_ours(entry):
    # Command-level filter, not whole-entry (EI-8997 follow-up): keep co-located
    # foreign commands in the same entry.
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

cmd = f"PAPERCUSP_WORKSPACE_ROOT={workspace_root!r} {prov}"

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('UserPromptSubmit', [])) if e]
arr.append({'hooks': [{'type': 'command', 'command': cmd}]})
hooks['UserPromptSubmit'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the turn-start memory UserPromptSubmit hook (memory-delivery-
# unification-2026-07-12 P-003a) as its OWN entry — same idempotent
# drop-ours-then-append shape as merge_provenance_hook.
#   $1 = settings.json path
merge_turn_memory_hook() {
  python3 - "$1" "$CC_TURN_MEMORY_HOOK" "$WORKSPACE_ROOT" <<'PYEOF'
import json, os, sys, time
path, hook, workspace_root = sys.argv[1:4]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {hook, os.path.basename(hook)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

cmd = f"PAPERCUSP_WORKSPACE_ROOT={workspace_root!r} {hook}"

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('UserPromptSubmit', [])) if e]
arr.append({'hooks': [{'type': 'command', 'command': cmd}]})
hooks['UserPromptSubmit'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the mid-turn context PostToolBatch hook (context-injection-audit-2026-07-28
# P-015, D-027) as its OWN entry, matcher-less (PostToolBatch takes no matcher) —
# same idempotent drop-ours-then-append shape as merge_turn_memory_hook.
#   $1 = settings.json path
merge_midturn_context_hook() {
  python3 - "$1" "$CC_MIDTURN_CONTEXT_HOOK" "$WORKSPACE_ROOT" <<'PYEOF'
import json, os, sys, time
path, hook, workspace_root = sys.argv[1:4]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {hook, os.path.basename(hook)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

cmd = f"PAPERCUSP_WORKSPACE_ROOT={workspace_root!r} {hook}"

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PostToolBatch', [])) if e]
arr.append({'hooks': [{'type': 'command', 'command': cmd}]})
hooks['PostToolBatch'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the per-turn journal Stop hook as its OWN entry (no matcher — fires at
# each turn end). deterministic-context-carry-2026-07-14 P-012. Idempotent:
# drops any prior entry pointing at our script, preserves all other hooks.
#   $1 = settings.json path
merge_turn_journal_hook() {
  python3 - "$1" "$CC_TURN_JOURNAL_HOOK" <<'PYEOF'
import json, os, sys, time
path, hook = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {hook, os.path.basename(hook)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('Stop', [])) if e]
arr.append({'hooks': [{'type': 'command', 'command': hook}]})
hooks['Stop'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the activity-report PostToolUse hook as its OWN entry (matcher "*" —
# every tool, so each native tool call is mirrored into the activity bridge).
# Idempotent: drops any prior entry pointing at our script, preserves all other
# hooks, then appends fresh. The hook scopes itself to psu sessions via
# PAPERCUSP_SID + is fire-and-forget, so it's inert/cheap outside a psu session.
#   $1 = settings.json path
merge_activity_hook() {
  python3 - "$1" "$CC_ACTIVITY_HOOK" <<'PYEOF'
import json, os, sys, time
path, activity = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {activity, os.path.basename(activity)}

def drop_ours(entry):
    # Filter OUT just OUR command(s) from one hook entry (command-level, not whole-
    # entry): keeps a co-located FOREIGN command, e.g. a live settings.json's Bash
    # entry carrying both our gate hook and a third-party `rtk hook claude` — a
    # whole-entry drop silently destroyed that foreign command (EI-8997 follow-up).
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

# The hook reads PAPERCUSP_SID + cwd from the session env (Claude passes the
# session env to hooks), so no baking is needed — just the script path.
hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PostToolUse', [])) if e]
arr.append({'matcher': '*',
            'hooks': [{'type': 'command', 'command': activity}]})
hooks['PostToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the full-write byte-integrity diagnostic as its OWN PostToolUse entry.
# A full Write carries the complete requested content, so the hook can compare
# the requested UTF-8 bytes with the resulting file. Edit/MultiEdit are
# intentionally excluded because their inputs are fragments. Idempotent and
# non-destructive: remove only prior copies of this command, preserve foreign
# commands, then append the current registration.
#   $1 = settings.json path
merge_write_byte_integrity_guard_hook() {
  python3 - "$1" "$CC_WRITE_BYTE_INTEGRITY_HOOK" <<'PYEOF'
import json, os, sys, time
path, hook = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {hook, os.path.basename(hook)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PostToolUse', [])) if e]
arr.append({
    'matcher': 'Write|mcp__.*__capability_write',
    'hooks': [{'type': 'command', 'command': hook}],
})
hooks['PostToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the activity-report PreToolUse hook as its OWN entry (matcher "*" —
# every tool, mirroring merge_activity_hook but on the PreToolUse array). Same
# idempotency contract.
#   $1 = settings.json path
merge_activity_pre_hook() {
  python3 - "$1" "$CC_PRE_ACTIVITY_HOOK" <<'PYEOF'
import json, os, sys, time
path, activity = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {activity, os.path.basename(activity)}

def drop_ours(entry):
    # Filter OUT just OUR command(s) from one hook entry (command-level, not whole-
    # entry): keeps a co-located FOREIGN command, e.g. a live settings.json's Bash
    # entry carrying both our gate hook and a third-party `rtk hook claude` — a
    # whole-entry drop silently destroyed that foreign command (EI-8997 follow-up).
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PreToolUse', [])) if e]
arr.append({'matcher': '*',
            'hooks': [{'type': 'command', 'command': activity}]})
hooks['PreToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the lifecycle hook as SessionStart + SessionEnd entries (no tool matcher —
# these are session events). Idempotent: drops any prior entry pointing at our
# script, preserves all others. The hook self-gates on PAPERCUSP_SID + reads the
# event name from stdin, so one script serves both events.
#   $1 = settings.json path
merge_lifecycle_hooks() {
  python3 - "$1" "$CC_LIFECYCLE_HOOK" <<'PYEOF'
import json, os, sys, time
path, lifecycle = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {lifecycle, os.path.basename(lifecycle)}

def drop_ours(entry):
    # Filter OUT just OUR command(s) from one hook entry (command-level, not whole-
    # entry): keeps a co-located FOREIGN command, e.g. a live settings.json's Bash
    # entry carrying both our gate hook and a third-party `rtk hook claude` — a
    # whole-entry drop silently destroyed that foreign command (EI-8997 follow-up).
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
for event in ('SessionStart', 'SessionEnd'):
    arr = [e for e in (drop_ours(x) for x in hooks.get(event, [])) if e]
    arr.append({'hooks': [{'type': 'command', 'command': lifecycle}]})
    hooks[event] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the work-item VERIFY-nudge backstop hook (P-019). ONE script, three entries:
# a PostToolUse "Edit|Write|MultiEdit" marker entry + Stop + SessionEnd nudge entries
# (no tool matcher on the latter — session/turn events). The script self-gates on
# PAPERCUSP_SID, reads the event name from stdin, is gated behind the
# papercusp-workitem-verify-nudge flag (default ON), and is fail-open + fire-and-forget,
# so it's inert/cheap outside a psu session. Idempotent: drops any prior entry pointing
# at our script across all three events, preserves every other hook, then appends fresh.
#   $1 = settings.json path
merge_workitem_nudge_hook() {
  python3 - "$1" "$CC_WORKITEM_NUDGE_HOOK" <<'PYEOF'
import json, os, sys, time
path, nudge = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {nudge, os.path.basename(nudge)}

def drop_ours(entry):
    # Filter OUT just OUR command(s) from one hook entry (command-level, not whole-
    # entry): keeps a co-located FOREIGN command, e.g. a live settings.json's Bash
    # entry carrying both our gate hook and a third-party `rtk hook claude` — a
    # whole-entry drop silently destroyed that foreign command (EI-8997 follow-up).
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
# PostToolUse marker entry (file-edit tools only).
post = [e for e in (drop_ours(x) for x in hooks.get('PostToolUse', [])) if e]
post.append({'matcher': 'Edit|Write|MultiEdit',
             'hooks': [{'type': 'command', 'command': nudge}]})
hooks['PostToolUse'] = post
# Stop + SessionEnd nudge entries (no tool matcher — session/turn events).
for event in ('Stop', 'SessionEnd'):
    arr = [e for e in (drop_ours(x) for x in hooks.get(event, [])) if e]
    arr.append({'hooks': [{'type': 'command', 'command': nudge}]})
    hooks[event] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Register the fleet statusline NON-destructively: set cfg['statusLine'] only when
# the user has no existing statusLine (never clobber a personal one). Idempotent: a
# prior install of OUR statusline is overwritten in place; a foreign one is left
# untouched. Progressive — the baseline never depends on it.
#   $1 = settings.json path
merge_statusline() {
  python3 - "$1" "$CC_STATUSLINE" <<'PYEOF'
import json, os, sys, time
path, statusline = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

existing = cfg.get('statusLine')
mine = isinstance(existing, dict) and statusline in str(existing.get('command', ''))
if existing and not mine:
    # A personal/foreign statusLine — leave it; the bridge degrades gracefully.
    sys.exit(0)
cfg['statusLine'] = {'type': 'command', 'command': statusline}

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Codex sibling of merge_statusline (TS twin: mergeCodexStatusLineToml in
# packages/operator-core/lib/desktop-install/papercusp-files.ts — KEEP THE TWO IN SYNC).
# A plain `codex` reads ~/.codex/config.toml, whose default status_line=None renders NOTHING
# ("no status lines in codex at all"). Merge our native [tui].status_line in NON-destructively:
# only when status_line is entirely absent (any user/`/statusline` choice, incl. an explicit [], is
# preserved). Never CREATES ~/.codex (codex not set up ⇒ nothing to do). tomllib-validated: an insert
# that would corrupt the TOML is discarded. codex has no command-backed item (openai/codex#17827), so
# this shows codex's OWN items, not the fleet chips.
#   $1 = ~/.codex/config.toml path
merge_codex_statusline() {
  python3 - "$1" <<'PYEOF'
import re, sys
path = sys.argv[1]
try:
    with open(path) as f:
        raw = f.read()
except FileNotFoundError:
    sys.exit(0)  # no ~/.codex/config.toml — don't create one

try:
    import tomllib
    have_tomllib = True
except ModuleNotFoundError:
    have_tomllib = False

# Already configured? Leave it (respect the user / a prior install).
if have_tomllib:
    try:
        data = tomllib.loads(raw)
    except Exception:
        sys.exit(0)  # unparseable — never clobber
    if isinstance(data.get('tui'), dict) and data['tui'].get('status_line') is not None:
        sys.exit(0)
elif re.search(r'(?m)^\s*status_line\s*=', raw):
    sys.exit(0)

block = (
    '[tui]\n'
    'status_line = ["run-state", "model-with-reasoning", "context-remaining", "git-branch"]\n'
)
lines = raw.splitlines(keepends=True)
# Insert the [tui] block before the FIRST table header (so it lands after any top-level bare keys
# and before any [tui.subtable], which keeps it valid TOML); append at EOF if there is no table.
insert_at = next((i for i, ln in enumerate(lines) if ln.lstrip().startswith('[')), len(lines))
if insert_at < len(lines):
    out = ''.join(lines[:insert_at]) + block + '\n' + ''.join(lines[insert_at:])
else:
    sep = '' if raw.endswith('\n') or raw == '' else '\n'
    out = raw + sep + '\n' + block

if have_tomllib:
    try:
        tomllib.loads(out)  # discard an insert that would break the file
    except Exception:
        sys.exit(0)

with open(path, 'w') as f:
    f.write(out)
print('merged [tui].status_line into ' + path)
PYEOF
}

# Merge the named-resource Bash gate as its OWN PreToolUse entry (matcher
# "Bash"). Idempotent: drops any prior entry pointing at our script. The hook
# fail-opens + pre-filters locally, so it's inert until a registered resource
# is mid-exclusive.
#   $1 = settings.json path
merge_bash_gate_hook() {
  python3 - "$1" "$CC_BASH_GATE_HOOK" "$WORKSPACE_ROOT" <<'PYEOF'
import json, os, sys, time
path, gate, workspace_root = sys.argv[1:4]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {gate, os.path.basename(gate)}

def drop_ours(entry):
    # Filter OUT just OUR command(s) from one hook entry (command-level, not whole-
    # entry): keeps a co-located FOREIGN command, e.g. a live settings.json's Bash
    # entry carrying both our gate hook and a third-party `rtk hook claude` — a
    # whole-entry drop silently destroyed that foreign command (EI-8997 follow-up).
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

cmd = f"PAPERCUSP_WORKSPACE_ROOT={workspace_root!r} {gate}"

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PreToolUse', [])) if e]
# EI-21971958067151594: `capability:bash` is the SAME shell over MCP and was
# exempt from every deny in the gate (measured: `tauri-agent-tools dom` denied
# as Bash, ran as capability:bash against a foreign webview). Mirrors
# bashShellMatcher in packages/operator-core/lib/desktop-install/papercusp-files.ts
# — KEEP THE TWO IN SYNC.
arr.append({'matcher': 'Bash|mcp__.*__capability_bash',
            'hooks': [{'type': 'command', 'command': cmd}]})
hooks['PreToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the plans-read guard as its OWN PreToolUse entry (matcher "Read|Grep").
# Idempotent: drops any prior entry pointing at our script. No workspace-root
# threading needed — the hook is a pure path-pattern match on its own input.
#   $1 = settings.json path
merge_plans_read_guard_hook() {
  python3 - "$1" "$CC_PLANS_GUARD_HOOK" <<'PYEOF'
import json, os, sys, time
path, guard = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {guard, os.path.basename(guard)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PreToolUse', [])) if e]
arr.append({'matcher': 'Read|Grep',
            'hooks': [{'type': 'command', 'command': guard}]})
hooks['PreToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the owner-gate mirror hook (owner-inbox-single-pane-2026-07-17 P-001) as
# FOUR entries — one script, four hook_event_name branches (see the script's own
# header): PreToolUse + PostToolUse scoped to the two Claude-native dialog tools
# (matcher "AskUserQuestion|ExitPlanMode"), plus matcher-less Notification + Stop
# entries (those fire for every notification/turn-end; the script itself narrows
# what it acts on). Idempotent per event, same command-level drop_ours pattern as
# every sibling merge_* function.
#   $1 = settings.json path
merge_ask_gate_hook() {
  python3 - "$1" "$CC_ASK_GATE_HOOK" <<'PYEOF'
import json, os, sys, time
path, hook = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {hook, os.path.basename(hook)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
# PreToolUse + PostToolUse: matcher-scoped to the two dialog tools.
for event in ('PreToolUse', 'PostToolUse'):
    arr = [e for e in (drop_ours(x) for x in hooks.get(event, [])) if e]
    arr.append({'matcher': 'AskUserQuestion|ExitPlanMode',
                'hooks': [{'type': 'command', 'command': hook}]})
    hooks[event] = arr
# Notification + Stop: no tool matcher — the script's own event-name branch narrows.
for event in ('Notification', 'Stop'):
    arr = [e for e in (drop_ours(x) for x in hooks.get(event, [])) if e]
    arr.append({'hooks': [{'type': 'command', 'command': hook}]})
    hooks[event] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the desktop-guard hook (EI-16981) as its own PreToolUse entry, matcher-
# scoped to the browser-navigation MCP tools + the Skill tool. Bash is
# deliberately NOT matched — see the script's own header (a text-scanning Bash
# matcher would false-positive on anything that merely mentions these ports).
# Idempotent: drops any prior entry pointing at our script.
#   $1 = settings.json path
merge_guard_operator_desktop_hook() {
  python3 - "$1" "$CC_GUARD_OPERATOR_DESKTOP_HOOK" <<'PYEOF'
import json, os, sys, time
path, guard = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {guard, os.path.basename(guard)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PreToolUse', [])) if e]
arr.append({'matcher': 'mcp__playwright__browser_navigate|mcp__claude-in-chrome__navigate|mcp__claude-in-chrome__tabs_create_mcp|Skill',
            'hooks': [{'type': 'command', 'command': guard}]})
hooks['PreToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# merge_content_lint_hook — PreToolUse, matcher 'Edit|Write|MultiEdit' (P-013, wired WI-5543).
merge_content_lint_hook() {
  python3 - "$1" "$CC_CONTENT_LINT_HOOK" <<'PYEOF'
import json, os, sys, time
path, hook = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {hook, os.path.basename(hook)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PreToolUse', [])) if e]
arr.append({'matcher': 'Edit|Write|MultiEdit|mcp__.*__capability_(edit|write|multi_?edit)', 'hooks': [{'type': 'command', 'command': hook}]})
hooks['PreToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# merge_frozen_candidate_edit_hook — PostToolUse, matcher 'Edit|Write|MultiEdit'
# (frozen-candidate-compliance-enforcement-2026-08-30 P-004). Advisory only; warns that an
# edit to one of the frozen candidate's failing paths lands ABOVE the sha the gate is judging,
# and names the single sanctioned command that puts it on the judged lineage.
merge_frozen_candidate_edit_hook() {
  python3 - "$1" "$CC_FROZEN_CANDIDATE_EDIT_HOOK" <<'PYEOF'
import json, os, sys, time
path, hook = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {hook, os.path.basename(hook)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PostToolUse', [])) if e]
arr.append({'matcher': 'Edit|Write|MultiEdit', 'hooks': [{'type': 'command', 'command': hook}]})
hooks['PostToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# merge_mdx_nudge_hook — PostToolUse, matcher native edits + docs:author MCP variants
# (EI-19450114644493388 / EI-22997442030423826). Advisory only; the hook reads the
# complete resulting file for native edits and checks the affected source-to-served
# mirror mapping after a successful docs:author write.
merge_mdx_nudge_hook() {
  python3 - "$1" "$CC_MDX_NUDGE_HOOK" <<'PYEOF'
import json, os, sys, time
path, hook = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {hook, os.path.basename(hook)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PostToolUse', [])) if e]
arr.append({'matcher': 'Edit|Write|MultiEdit|docs:author|mcp__.*__docs[_:-]author', 'hooks': [{'type': 'command', 'command': hook}]})
hooks['PostToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# merge_secrets_guard_hook — PreToolUse, matcher 'Edit|Write|MultiEdit' (su-papercusp-way-gate
# P-006, wired WI-5542): hard DENY backstop against a key-shaped secret reaching a shared
# git-sync tree file.
merge_secrets_guard_hook() {
  python3 - "$1" "$CC_SECRETS_GUARD_HOOK" <<'PYEOF'
import json, os, sys, time
path, hook = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {hook, os.path.basename(hook)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PreToolUse', [])) if e]
arr.append({'matcher': 'Edit|Write|MultiEdit|mcp__.*__capability_(edit|write|multi_?edit)', 'hooks': [{'type': 'command', 'command': hook}]})
hooks['PreToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# merge_schedule_wakeup_provenance_hook — PreToolUse, matcher 'ScheduleWakeup'
# (EI-18680056073436345): observational turn-provenance ledger enrollment for the
# Claude-CLI-native ScheduleWakeup tool — see the script's own header. Never denies.
merge_schedule_wakeup_provenance_hook() {
  python3 - "$1" "$CC_SCHEDULE_WAKEUP_PROVENANCE_HOOK" <<'PYEOF'
import json, os, sys, time
path, hook = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {hook, os.path.basename(hook)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PreToolUse', [])) if e]
arr.append({'matcher': 'ScheduleWakeup', 'hooks': [{'type': 'command', 'command': hook}]})
hooks['PreToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# merge_nul_byte_edit_guard_hook — PreToolUse, matcher 'Edit|MultiEdit' (EI-18896033546676518):
# hard DENY on Edit/MultiEdit against a file that already contains a raw NUL byte. Write is
# deliberately NOT in the matcher — see the script's own header for why.
merge_nul_byte_edit_guard_hook() {
  python3 - "$1" "$CC_NUL_BYTE_EDIT_GUARD_HOOK" <<'PYEOF'
import json, os, sys, time
path, hook = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {hook, os.path.basename(hook)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PreToolUse', [])) if e]
arr.append({'matcher': 'Edit|MultiEdit|mcp__.*__capability_(edit|multi_?edit)', 'hooks': [{'type': 'command', 'command': hook}]})
hooks['PreToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# merge_write_overwrite_guard_hook — PreToolUse, matcher 'Write' (EI-19966323166806405):
# ADVISORY (additionalContext, never a deny) warning when a Write targets an existing
# file with no matching Read/Edit/MultiEdit/Write earlier in the transcript. See the
# script's own header for why this is advisory-only rather than a hard deny.
merge_write_overwrite_guard_hook() {
  python3 - "$1" "$CC_WRITE_OVERWRITE_GUARD_HOOK" <<'PYEOF'
import json, os, sys, time
path, hook = sys.argv[1:3]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {hook, os.path.basename(hook)}

def drop_ours(entry):
    kept = [h for h in (entry.get('hooks') or []) if not any(o in h.get('command', '') for o in ours)]
    return {**entry, 'hooks': kept} if kept else None

hooks = cfg.setdefault('hooks', {})
arr = [e for e in (drop_ours(x) for x in hooks.get('PreToolUse', [])) if e]
arr.append({'matcher': 'Write|mcp__.*__capability_write', 'hooks': [{'type': 'command', 'command': hook}]})
hooks['PreToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# OMP looks for its MCP server config at ~/.omp/agent/mcp.json. The
# directory may not exist on a fresh OMP install — create it.
OMP_CONFIG_DIR="${HOME}/.omp/agent"
OMP_CONFIG_PATH="${OMP_CONFIG_DIR}/mcp.json"

mkdir -p "$(dirname "$TOKEN_PATH")"
mkdir -p "$OMP_CONFIG_DIR"

# 1+2. Superuser token. Reuse the existing token if one is already
# present — re-runs refresh the playbook / extension / wrapper and must
# NOT disrupt live shells by rotating their bearer. A fresh 32-byte
# token is minted only on first install. To rotate deliberately, delete
# the token file and re-run.
umask 077
if [ -s "$TOKEN_PATH" ]; then
  TOKEN="$(cat "$TOKEN_PATH")"
  echo "✓ Reusing existing superuser token from $TOKEN_PATH"
else
  TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '+/=' | head -c 32)
  printf '%s\n' "$TOKEN" > "$TOKEN_PATH"
  chmod 600 "$TOKEN_PATH"
  echo "✓ Minted $TOKEN_PATH (mode 0600)"
fi

# 2b. Stable agent_id (UUID) for SU-locks coordination.
# Generated ONCE per machine+user, baked into the MCP URL as the
# `?client=` param. NOTE: this is a per-machine FALLBACK identity only.
# The lock system prefers a per-SESSION id — the MCP transport's
# Mcp-Session-Id header for cooperative calls, and Claude Code's
# session_id for hook calls — so two shells on one machine get
# distinct lock owners. This baked id is used only when no per-session
# id is available. Re-runs of the install script preserve it.
AGENT_ID_PATH="${HOME}/.papercusp/su-agent-id"
if [ ! -s "$AGENT_ID_PATH" ]; then
  if command -v uuidgen >/dev/null 2>&1; then
    AGENT_ID="$(uuidgen | tr 'A-Z' 'a-z')"
  else
    AGENT_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  fi
  printf '%s\n' "$AGENT_ID" > "$AGENT_ID_PATH"
  chmod 600 "$AGENT_ID_PATH"
  echo "✓ Minted $AGENT_ID_PATH (mode 0600)"
else
  AGENT_ID="$(cat "$AGENT_ID_PATH")"
  echo "✓ Reusing existing agent_id from $AGENT_ID_PATH"
fi

# 3. Merge `papercusp-su` into the existing OMP MCP config.
# We use python because jq is not guaranteed and the merge needs to be
# idempotent (re-runs just rotate the token, don't duplicate the entry).
python3 - "$OMP_CONFIG_PATH" "$OPERATOR_URL" "$TOKEN" "$AGENT_ID" "$PROFILE" <<'PYEOF'
import json, os, sys
path, operator_url, token, agent_id, profile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
try:
    with open(path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
except json.JSONDecodeError:
    print(f'! existing {path} is invalid JSON; backing up and starting fresh', file=sys.stderr)
    os.rename(path, path + '.bak.' + str(int(__import__('time').time())))
    cfg = {}

cfg.setdefault('mcpServers', {})
# Preserve any user-configured Hindsight MCP server. OMP-native Hindsight is
# enabled through `omp config set memory.backend hindsight` below; standalone
# Hindsight MCP entries are no longer stripped by the Papercusp installer.
# `?client=<agent_id>` surfaces as ctx.uiClientId in tool handlers so
# locks:* can identify ownership without per-call args. That static
# machine id is the FALLBACK; the x-papercusp-client header below carries
# the PER-SESSION id (read header-first by the operator) when present.
profile_param = '&profile=power' if profile == 'power' else ''
cfg['mcpServers']['papercusp-su'] = {
    'type': 'http',
    'url': operator_url + '/api/mcp?superuser=1' + profile_param + '&client=' + agent_id,
    'headers': {
        'Authorization': 'Bearer ' + token,
        # Per-session coord/lock identity for OMP. OMP can't env-interpolate
        # the mcp.json URL (so the &client= above stays the static machine
        # id), but it DOES resolve header values at connect time
        # (config/resolve-config-value.ts): a leading "!" runs the rest in a
        # subshell that inherits the OMP process env. `psu` exports a
        # per-launch PAPERCUSP_SID, so this resolves to that per-session SID
        # — and is DROPPED (empty stdout => undefined) for a plain `omp` with
        # no SID, falling back to the static &client=. The operator reads
        # x-papercusp-client header-first (tooldef-http buildHttpSpawnContext),
        # so it overrides the static machine id. OMP's analogue of Claude's
        # ${PAPERCUSP_SID} URL interpolation + Codex's per-launch
        # `-c ...&client=<sid>` bake — see three-client-lock-enforcement plan.
        'x-papercusp-client': '!printf %s "${PAPERCUSP_SID:-}"',
        # Per-session workspace + profile scope, same header trick: psu exports
        # PAPERCUSP_WORKSPACE/-_PROFILE per launch; empty stdout => header
        # dropped => the operator falls back to its SID→adv-row lookup, then
        # '*' (unscoped) / the URL profile. Without this, every omp SU session
        # ran unscoped and workspace-scoped tools failed "no workspace
        # transaction" no matter what the psu picker selected.
        'x-papercusp-workspace': '!printf %s "${PAPERCUSP_WORKSPACE:-}"',
        'x-papercusp-profile': '!printf %s "${PAPERCUSP_PROFILE:-}"',
    },
}
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
chmod 600 "$OMP_CONFIG_PATH"
echo "✓ Merged 'papercusp-su' into $OMP_CONFIG_PATH (mode 0600)"

# 3a. Merge the same `papercusp-su` entry into Claude Code's config.
# Claude Code reads ~/.claude.json (per-user, global) for MCP servers
# in addition to per-project .mcp.json files. We only touch it if the
# file already exists — a missing ~/.claude.json means Claude Code has
# never been launched on this machine, and creating one would seed
# unrelated defaults the user didn't ask for. The merge preserves
# every other MCP server already registered.
CLAUDE_CONFIG_PATH="${HOME}/.claude.json"
if [ -f "$CLAUDE_CONFIG_PATH" ]; then
  python3 - "$CLAUDE_CONFIG_PATH" "$OPERATOR_URL" "$TOKEN" "$AGENT_ID" "$PROFILE" <<'PYEOF'
import json, os, sys, time
path, operator_url, token, agent_id, profile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
try:
    with open(path) as f:
        cfg = json.load(f)
except json.JSONDecodeError:
    print(f'! existing {path} is invalid JSON; backing up and starting fresh', file=sys.stderr)
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

cfg.setdefault('mcpServers', {})
# Per-session identity + native-session proof + scope: Claude Code expands
# ${VAR}/${VAR:-default} in the MCP URL at launch. psu exports PAPERCUSP_SID /
# PAPERCUSP_WORKSPACE / PAPERCUSP_PROFILE per launch, while Claude supplies
# CLAUDE_CODE_SESSION_ID for the native CLI incarnation. The operator checks
# that this native session is still bound to the claimed coord owner, so a
# nested CLI cannot act as its parent just by inheriting PAPERCUSP_SID.
# Each shell gets a DISTINCT ?client= (coord/lock owner) and a scoped MCP ctx — the psu
# picker's workspace finally reaching tool dispatch (the recurring
# "no workspace transaction" failure). Plain `claude` (no env) falls back
# to the static machine id / the SID→adv-row server fallback then '*' /
# the install-time profile. NOTE: this ${...} form is written only here
# (Claude); OMP/Codex don't do url env-interpolation.
profile_default = 'power' if profile == 'power' else ''
# WI-1457: the BASE is env-interpolated too — `${PAPERCUSP_OPERATOR_URL:-<mint-time
# base>}` — matching desktop-install/claude-integration.ts. psu exports the live,
# proxy-preferring PAPERCUSP_OPERATOR_URL per launch (resolveOperatorUrl), so a
# re-mint of this file can never again pin sessions to a stale literal base; the
# mint-time default (proxy when active, else :3070) only serves bare `claude`.
# Keep in sync with desktop-install/claude-integration.ts buildClaudeMcpEntry (the
# other writer of this entry): tools= is the trimmed tool-surface seed, ctx_tier=
# the payload tier (context-trimming-tiers D-004) — both env-expanded per launch by
# psu; empty ⇒ full catalog / unshaped payloads.
cfg['mcpServers']['papercusp-su'] = {
    'type': 'http',
    'url': ('${PAPERCUSP_OPERATOR_URL:-' + operator_url + '}' + '/api/mcp?superuser=1'
            + '&client=${PAPERCUSP_SID:-' + agent_id + '}'
            + '&native_session=${CLAUDE_CODE_SESSION_ID:-}'
            + '&workspace=${PAPERCUSP_WORKSPACE:-}'
            + '&profile=${PAPERCUSP_PROFILE:-' + profile_default + '}'
            + '&tools=${PAPERCUSP_TOOLS:-}'
            + '&ctx_tier=${PAPERCUSP_CONTEXT_TIER:-}'),
    'headers': {
        'Authorization': 'Bearer ' + token,
    },
}
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
  chmod 600 "$CLAUDE_CONFIG_PATH"
  echo "✓ Merged 'papercusp-su' into $CLAUDE_CONFIG_PATH (mode 0600)"
else
  echo "· $CLAUDE_CONFIG_PATH not found — skipping Claude Code MCP merge (launch \`claude\` once then re-run to opt in)"
fi

# 3b. Disable OMP-native memory (psu-isolation P-003 / D-001). A psu session
# uses the hybrid `memory:*` MCP tools (the papercusp-su server), NOT OMP's
# built-in store. Earlier versions of this script ENABLED the Hindsight backend
# (`memory.backend hindsight` + autoRecall/autoRetain) — that actively steered
# OMP to its native memory, contradicting "use memory:*", and (because omp's
# config is GLOBAL) leaked native auto-recall/retain into every psu omp session.
# Set the backend to "off" (a valid MemoryBackendId: off|local|hindsight — see
# @oh-my-pi/pi-coding-agent/src/memory-backend/types.ts; it is the SOLE runtime
# selector, so the legacy `memories.enabled` toggle no longer matters) so OMP
# injects no native-memory developer instructions and never auto-recalls/retains.
# Plain `omp` is affected too — intended: the hybrid memory is the one path.
set_omp_config() {
  local key="$1"
  local value="$2"
  if command -v omp >/dev/null 2>&1 && omp config set "$key" "$value" >/dev/null 2>&1; then
    echo "✓ OMP config $key=$value"
  else
    echo "! Could not set OMP config $key (is omp installed and healthy?)"
  fi
}
set_omp_config "memory.backend" "off"

# 4. Render the per-client playbooks as standalone OPT-IN files.
# The shared base playbook (papercusp-su-<profile>.tools.md) carries all
# client-neutral guidance; the client-specific task/workflow tooling
# (OMP vs Claude Code vs Codex) is spliced in from a small overlay so
# that, e.g., OMP's "don't use the Claude task tools" guidance never
# lands in the Claude or Codex playbook; the repo project guide is spliced
# at the PROJECT-GUIDE marker (P-001).
#
# These static files are a VESTIGIAL FALLBACK: the `*-su` wrappers are retired
# (psu → bootstrap-su → buildLaunchSpec → renderSuPlaybook renders fresh per
# launch via the TS path). They're kept as an opt-in reference / a render the
# user can read; plain `omp`/`claude`/`codex` never auto-load them.
#
# Destinations:
#   omp    → ~/.papercusp/${PROFILE}-collaborator.md
#   claude → ~/.papercusp/${PROFILE}-collaborator.claude.md
#   (codex: no static file — its AGENTS.md is minted per-session server-side by
#    writeSuCodexHome, role-codex-home.ts)
PLAYBOOK_DEST="${HOME}/.papercusp/${PROFILE}-collaborator.md"
PLAYBOOK_DEST_CLAUDE="${HOME}/.papercusp/${PROFILE}-collaborator.claude.md"
if [ ! -f "$PLAYBOOK_PATH" ]; then
  echo "! Expected base playbook at $PLAYBOOK_PATH; skipping playbook install"
else
  for ov in "$OVERLAY_OMP" "$OVERLAY_CLAUDE" "$OVERLAY_CODEX"; do
    [ -f "$ov" ] || echo "! Missing client overlay $(basename "$ov") — that playbook falls back to base-only"
  done
  render_playbook "$PLAYBOOK_PATH" "$OVERLAY_OMP" "$PLAYBOOK_DEST" "$PROJECT_GUIDE_PATH"
  chmod 644 "$PLAYBOOK_DEST"
  echo "✓ Wrote ${PROFILE} OMP playbook to $PLAYBOOK_DEST"
  render_playbook "$PLAYBOOK_PATH" "$OVERLAY_CLAUDE" "$PLAYBOOK_DEST_CLAUDE" "$PROJECT_GUIDE_PATH"
  chmod 644 "$PLAYBOOK_DEST_CLAUDE"
  echo "✓ Wrote ${PROFILE} Claude Code playbook to $PLAYBOOK_DEST_CLAUDE"
fi

# 4a. Migration cleanup: strip the legacy always-on managed block from
# ~/.omp/agent/CLAUDE.md left by earlier versions of this script, so
# plain `omp` stops auto-loading the playbook. Idempotent — a no-op once
# the block is gone. Content outside the BEGIN/END markers is preserved.
LEGACY_CTX="${HOME}/.omp/agent/CLAUDE.md"
if [ -f "$LEGACY_CTX" ]; then
  STRIPPED="$(python3 - "$LEGACY_CTX" <<'PYEOF'
import re, sys
path = sys.argv[1]
begin = "<!-- BEGIN papercusp-su playbook (managed by install-standalone-mcp.sh) -->"
end = "<!-- END papercusp-su playbook -->"
with open(path) as f:
    text = f.read()
pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", re.DOTALL)
if pattern.search(text):
    with open(path, "w") as f:
        f.write(pattern.sub("", text).lstrip("\n"))
    print("stripped")
PYEOF
)"
  if [ "$STRIPPED" = "stripped" ]; then
    echo "✓ Removed legacy always-on playbook block from $LEGACY_CTX"
  fi
fi

# 4a-bis. Same migration cleanup for ~/.claude/AGENTS.md: an earlier version
# wrote an always-on managed playbook block here too. Strip it so the playbook
# reaches Claude ONLY via the claude-su wrapper's --append-system-prompt-file
# (not as an always-on copy that drifts — it had gone stale to the pre-Starlight
# fumadocs layout). Idempotent; content outside the BEGIN/END markers preserved.
CLAUDE_CTX="${HOME}/.claude/AGENTS.md"
if [ -f "$CLAUDE_CTX" ]; then
  STRIPPED_CLAUDE="$(python3 - "$CLAUDE_CTX" <<'PYEOF'
import re, sys
path = sys.argv[1]
begin = "<!-- BEGIN papercusp-su playbook (managed by install-standalone-mcp.sh) -->"
end = "<!-- END papercusp-su playbook -->"
with open(path) as f:
    text = f.read()
pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", re.DOTALL)
if pattern.search(text):
    with open(path, "w") as f:
        f.write(pattern.sub("", text).lstrip("\n"))
    print("stripped")
PYEOF
)"
  if [ "$STRIPPED_CLAUDE" = "stripped" ]; then
    echo "✓ Removed legacy always-on playbook block from $CLAUDE_CTX"
  fi
fi

# 4c. Install the coordination extension as a standalone OPT-IN file.
#
# OMP loads `pi.on(...)` factory modules via the extension runner and
# AUTO-DISCOVERS any `*.ts` under ~/.omp/agent/extensions/ — which made
# the coordination runtime (locks enforcement, turn-start injection)
# load on every `omp`. It now lives at ~/.papercusp/papercusp-coord.ts
# and is loaded only by the `omp-su` wrapper (step 4d) via `-e`. The
# legacy auto-discovered copy is removed so plain `omp` no longer picks
# it up.
# OMP loads these TypeScript files outside the esbuild bundle. Copy the entry
# point AND every sibling module, then run an install-side relative-import check
# so a missing companion is reported before the next session can look inert.
install_omp_hook_bundle() {
  local source_dir="$1"
  local destination_dir="$2"
  local source_entry="$3"
  local destination_entry="$4"
  local source_file base destination_file
  local found=0

  mkdir -p "$destination_dir"
  while IFS= read -r -d '' source_file; do
    base="${source_file##*/}"
    if [ "$base" = "$source_entry" ]; then
      destination_file="${destination_dir}/${destination_entry}"
      found=1
    else
      destination_file="${destination_dir}/${base}"
    fi
    cp "$source_file" "$destination_file"
    chmod 644 "$destination_file"
  done < <(find "$source_dir" -maxdepth 1 -type f -name '*.ts' -print0 | sort -z)

  if [ "$found" -ne 1 ]; then
    echo "! OMP hook bundle entry missing: ${source_dir}/${source_entry}" >&2
    return 1
  fi

  if ! python3 - "$destination_dir" <<'PYEOF'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
pattern = re.compile(
    r"\bfrom\s+['\"](\.[^'\"]+)['\"]|"
    r"\bimport\s+['\"](\.[^'\"]+)['\"]|"
    r"\bimport\s*\(\s*['\"](\.[^'\"]+)['\"]\s*\)"
)
unresolved = []
for importer in sorted(root.glob('*.ts')):
    text = importer.read_text(encoding='utf-8')
    for match in pattern.finditer(text):
        specifier = next((value for value in match.groups() if value), None)
        if not specifier:
            continue
        raw = (importer.parent / specifier.split('?', 1)[0].split('#', 1)[0]).resolve()
        stem = raw.with_suffix('') if raw.suffix else raw
        candidates = [raw, raw.with_suffix('.ts'), stem.with_suffix('.ts'), stem / 'index.ts']
        if not any(candidate.is_file() for candidate in candidates):
            unresolved.append(f'{importer.name} -> {specifier}')

if unresolved:
    print(
        '[install-standalone-mcp] OMP hook bundle load check FAILED: ' + '; '.join(unresolved),
        file=sys.stderr,
    )
    raise SystemExit(1)
PYEOF
  then
    echo "! OMP hook bundle load check failed under ${destination_dir}" >&2
  fi
}

COORD_EXT_SRC="${SCRIPT_DIR}/hooks/omp/coord-hook.ts"
COORD_EXT_DEST="${HOME}/.papercusp/papercusp-coord.ts"
LEGACY_EXT="${OMP_CONFIG_DIR}/extensions/papercusp-coord.ts"
if [ -f "$COORD_EXT_SRC" ]; then
  if install_omp_hook_bundle "${SCRIPT_DIR}/hooks/omp" "${HOME}/.papercusp" "coord-hook.ts" "papercusp-coord.ts"; then
    echo "✓ Installed coordination extension bundle to $COORD_EXT_DEST"
  fi
else
  echo "! Expected coord extension at $COORD_EXT_SRC; skipping (coordination inactive in omp-su)"
fi
if [ -f "$LEGACY_EXT" ]; then
  rm -f "$LEGACY_EXT"
  echo "✓ Removed legacy auto-discovered extension at $LEGACY_EXT"
fi

# 4c-ter. Context-injection dispatcher + the omp injection hook
# (omp-context-injection-parity-2026-08-09 P-003 / D-001).
#
# TWO pieces, and they are installed together on purpose:
#   hooks/inject/   — the SHARED dispatcher (index/core/ports + per-client
#                     adapters). Client-agnostic; claude and codex reach it too.
#   hooks/omp/inject-hook.ts — the omp client-native artifact, passed by
#                     psu-launcher as `--hook`. It locates the dispatcher
#                     RELATIVE TO ITSELF first (../inject/index.mjs), which is
#                     why both land under the same ~/.papercusp/hooks root.
#
# Installing a client hook WITHOUT the dispatcher is the one arrangement that
# fails quietly: the hook loads, finds no dispatcher, and fail-silently injects
# nothing on every turn — indistinguishable from "no memories were relevant".
#
# ⚠ THEIR GATES ARE SEPARATE, AND THAT IS THE POINT (codex-context-injection-
# parity-2026-08-09 P-002). These two used to share ONE `if`, which was correct
# while omp was the dispatcher's only consumer. It is no longer: the claude cc
# hooks (userpromptsubmit-memory.sh, posttoolbatch-midturn-context.sh) are now
# thin shims onto this same dispatcher, and codex reaches it from its per-session
# hooks.json. Under the old shared gate a missing omp artifact would have skipped
# the DISPATCHER too — silently disabling injection for CLAUDE, which is ~100% of
# real traffic, because of an unrelated omp file. Gate each on its own source.
INJECT_SRC_DIR="${SCRIPT_DIR}/hooks/inject"
INJECT_DEST_DIR="${HOME}/.papercusp/hooks/inject"
OMP_INJECT_HOOK_SRC="${SCRIPT_DIR}/hooks/omp/inject-hook.ts"
OMP_INJECT_HOOK_DEST="${HOME}/.papercusp/hooks/omp/inject-hook.ts"
if [ -f "${INJECT_SRC_DIR}/index.mjs" ]; then
  mkdir -p "${INJECT_DEST_DIR}/adapters"
  cp "${INJECT_SRC_DIR}"/*.mjs "${INJECT_DEST_DIR}/"
  cp "${INJECT_SRC_DIR}"/adapters/*.mjs "${INJECT_DEST_DIR}/adapters/"
  chmod 644 "${INJECT_DEST_DIR}"/*.mjs "${INJECT_DEST_DIR}"/adapters/*.mjs
  chmod 755 "${INJECT_DEST_DIR}/index.mjs"
  echo "✓ Installed context-injection dispatcher to $INJECT_DEST_DIR (claude + codex + omp)"
else
  echo "! Context-injection dispatcher missing under ${INJECT_SRC_DIR}; skipping (turn-start/mid-turn injection inactive for ALL clients)"
fi
if [ -f "$OMP_INJECT_HOOK_SRC" ]; then
  if install_omp_hook_bundle "${SCRIPT_DIR}/hooks/omp" "${HOME}/.papercusp/hooks/omp" "inject-hook.ts" "inject-hook.ts"; then
    echo "✓ Installed omp injection hook bundle to $OMP_INJECT_HOOK_DEST"
  fi
else
  echo "! omp injection hook missing under ${SCRIPT_DIR}/hooks/omp; skipping (omp injection inactive; claude/codex unaffected)"
fi

# 4c-bis. Install the shared Claude+Codex lock-enforcement hooks to a
# stable runtime location. settings.json (Claude in step 4e, Codex in
# step 4f) references these absolute paths. The OMP equivalent is the
# coord extension above (loaded via `-e`); Claude/Codex use these.
if [ -f "${CC_HOOK_SRC_DIR}/pretooluse-locks-acquire.sh" ]; then
  mkdir -p "$CC_HOOK_DEST_DIR"
  cp "${CC_HOOK_SRC_DIR}/pretooluse-locks-acquire.sh" "$CC_PRE_HOOK"
  cp "${CC_HOOK_SRC_DIR}/posttooluse-locks-release.sh" "$CC_POST_HOOK"
  if [ -f "${CC_HOOK_SRC_DIR}/posttoolbatch-locks-release.sh" ]; then
    cp "${CC_HOOK_SRC_DIR}/posttoolbatch-locks-release.sh" "$CC_POST_BATCH_LOCKS_HOOK"
  fi
  chmod 755 "$CC_PRE_HOOK" "$CC_POST_HOOK" "$CC_POST_BATCH_LOCKS_HOOK" 2>/dev/null || true
  if [ -f "${CC_HOOK_SRC_DIR}/posttooluse-activity-report.sh" ]; then
    cp "${CC_HOOK_SRC_DIR}/posttooluse-activity-report.sh" "$CC_ACTIVITY_HOOK"
    chmod 755 "$CC_ACTIVITY_HOOK"
  fi
  if [ -f "${CC_HOOK_SRC_DIR}/pretooluse-activity-report.sh" ]; then
    cp "${CC_HOOK_SRC_DIR}/pretooluse-activity-report.sh" "$CC_PRE_ACTIVITY_HOOK"
    chmod 755 "$CC_PRE_ACTIVITY_HOOK"
  fi
  if [ -f "${CC_HOOK_SRC_DIR}/lifecycle-report.sh" ]; then
    cp "${CC_HOOK_SRC_DIR}/lifecycle-report.sh" "$CC_LIFECYCLE_HOOK"
    chmod 755 "$CC_LIFECYCLE_HOOK"
  fi
  # Shared python lib imported by statusline-fleet.sh + posttooluse-objective-title.sh
  # (they resolve it off their own dirname, so it MUST land beside them). Copy it BEFORE
  # its importers: a hook that lands without pc_tty.py raises ImportError, fails open, and
  # silently stops setting the terminal title — the exact WI-3665 failure, reintroduced.
  # apps/operator/lib/tty-title-target.test.ts fails if any hooks/cc file stops being copied
  # here (or into the desktop sidecar / desktop installer — all three paths are guarded).
  if [ -f "${CC_HOOK_SRC_DIR}/pc_tty.py" ]; then
    cp "${CC_HOOK_SRC_DIR}/pc_tty.py" "${CC_HOOK_DEST_DIR}/pc_tty.py"
    chmod 644 "${CC_HOOK_DEST_DIR}/pc_tty.py"
  fi
  # EI-20782070131658758: copy every hook payload by ENUMERATION, never a hand-maintained
  # list of `cp` lines. The list form had silently drifted to 12 of 18 .mjs hooks never
  # copied here — every PostToolUse nudge, plus the control-bytes, generated-file-edit,
  # tool-prompt-weight and unreserved-migration PreToolUse guards. Each was absent from a
  # standalone install while its own unit tests passed, because a unit test proves a hook
  # WORKS, never that it is INSTALLED. The guard meant to catch exactly this
  # (apps/operator/lib/tty-title-target.test.ts, "copies every hooks/cc file") filtered to
  # *.sh/*.py and therefore could not see a single .mjs hook; it now covers *.mjs too.
  #
  # Destination basenames are unchanged: every CC_*_HOOK variable above is defined as
  # "${CC_HOOK_DEST_DIR}/<same basename>", so this loop lands each already-copied file at
  # byte-identical paths and merely stops forgetting the rest.
  for cc_hook_src in "${CC_HOOK_SRC_DIR}"/*.sh "${CC_HOOK_SRC_DIR}"/*.mjs "${CC_HOOK_SRC_DIR}"/*.py; do
    [ -f "$cc_hook_src" ] || continue  # unmatched glob stays literal; skip it
    cc_hook_name="$(basename "$cc_hook_src")"
    case "$cc_hook_name" in
      *.tmp | *.bak*) continue ;;  # residue from an interrupted install / hand-kept backups
    esac
    cp "$cc_hook_src" "${CC_HOOK_DEST_DIR}/${cc_hook_name}"
    case "$cc_hook_name" in
      *.py) chmod 644 "${CC_HOOK_DEST_DIR}/${cc_hook_name}" ;;
      *) chmod 755 "${CC_HOOK_DEST_DIR}/${cc_hook_name}" ;;
    esac
  done
  echo "✓ Installed Claude/Codex lock + coord hooks to $CC_HOOK_DEST_DIR"
else
  echo "! Expected CC lock hooks at $CC_HOOK_SRC_DIR; skipping (Claude/Codex lock enforcement inactive)"
fi

# 4e-hooks. Merge the SU-locks Pre/PostToolUse hooks into Claude Code's
# USER settings (~/.claude/settings.json). User-level so both `claude`
# and `claude-su` enforce locks; the matcher limits them to file edits,
# and the hook itself scopes to the papercup workspace + no-ops when
# Papercusp isn't installed.
if [ -x "$CC_PRE_HOOK" ]; then
  CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
  merge_lock_hooks "$CLAUDE_SETTINGS" "Edit|Write|MultiEdit|mcp__.*__capability_(edit|write|multi_?edit)"
  [ -x "$CC_ACTIVITY_HOOK" ] && merge_activity_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_WRITE_BYTE_INTEGRITY_HOOK" ] && merge_write_byte_integrity_guard_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_PRE_ACTIVITY_HOOK" ] && merge_activity_pre_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_LIFECYCLE_HOOK" ] && merge_lifecycle_hooks "$CLAUDE_SETTINGS"
  [ -x "$CC_WORKITEM_NUDGE_HOOK" ] && merge_workitem_nudge_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_STATUSLINE" ] && merge_statusline "$CLAUDE_SETTINGS"
  [ -x "$CC_BASH_GATE_HOOK" ] && merge_bash_gate_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_PLANS_GUARD_HOOK" ] && merge_plans_read_guard_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_PROVENANCE_HOOK" ] && merge_provenance_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_TURN_MEMORY_HOOK" ] && merge_turn_memory_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_MIDTURN_CONTEXT_HOOK" ] && merge_midturn_context_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_TURN_JOURNAL_HOOK" ] && merge_turn_journal_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_ASK_GATE_HOOK" ] && merge_ask_gate_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_GUARD_OPERATOR_DESKTOP_HOOK" ] && merge_guard_operator_desktop_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_CONTENT_LINT_HOOK" ] && merge_content_lint_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_MDX_NUDGE_HOOK" ] && merge_mdx_nudge_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_FROZEN_CANDIDATE_EDIT_HOOK" ] && merge_frozen_candidate_edit_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_SECRETS_GUARD_HOOK" ] && merge_secrets_guard_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_NUL_BYTE_EDIT_GUARD_HOOK" ] && merge_nul_byte_edit_guard_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_SCHEDULE_WAKEUP_PROVENANCE_HOOK" ] && merge_schedule_wakeup_provenance_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_WRITE_OVERWRITE_GUARD_HOOK" ] && merge_write_overwrite_guard_hook "$CLAUDE_SETTINGS"
  chmod 600 "$CLAUDE_SETTINGS"
  echo "✓ Merged SU-locks + coord + activity hooks (+ fleet statusline) into $CLAUDE_SETTINGS"
else
  echo "· Claude lock hooks not installed (no $CC_PRE_HOOK) — skipping settings merge"
fi

# Codex status line — independent of the Claude-hooks gate above (targets ~/.codex, not settings.json).
# A plain `codex` renders NO status line by default (status_line=None); merge our native [tui].status_line
# into an EXISTING ~/.codex/config.toml (never creates one). Sibling of the papercusp-files.ts TS merge.
merge_codex_statusline "${HOME}/.codex/config.toml"

# Install an executable wrapper through a same-directory temporary file and one
# atomic rename. Writing an already-running shebang script in place leaves a
# window where a concurrent exec sees ETXTBSY (or a truncated script), which is
# especially damaging here because `ptool` is also the recovery transport used
# to repair installs. The temporary file is created beside the destination so
# the rename stays on the same filesystem.
install_executable_atomic() {
  local destination="$1"
  local mode="$2"
  local temporary

  temporary="$(mktemp "${destination}.tmp.XXXXXX")"
  if ! cat > "$temporary"; then
    rm -f -- "$temporary" || true
    return 1
  fi
  if ! chmod "$mode" "$temporary"; then
    rm -f -- "$temporary" || true
    return 1
  fi
  if ! mv -f -- "$temporary" "$destination"; then
    rm -f -- "$temporary" || true
    return 1
  fi
}

# 4g. Install the `psu` command — THE launcher (the *-su wrappers are gone).
# `psu` prompts for agent + harness + plan, records a tracked /adv session
# via the operator's bootstrap-su endpoint, then execs the RAW CLI with the
# playbook + MCP + flags assembled per-launch (buildLaunchSpec). It's a thin
# shim over the Node launcher in the repo (which resolves @inquirer/prompts
# from the operator's node_modules). Scripting escape:
#   psu --no-picker --agent=<claude|omp|codex> --harness=<slug> [--plan=<slug>|--no-plan]
PSU_LAUNCHER="${SCRIPT_DIR}/psu-launcher.mjs"
PSU_BIN_DIR="${HOME}/.local/bin"
PSU_PATH="${PSU_BIN_DIR}/psu"
if [ -f "$PSU_LAUNCHER" ]; then
  mkdir -p "$PSU_BIN_DIR"
  install_executable_atomic "$PSU_PATH" 755 <<WRAPEOF
#!/usr/bin/env bash
# papercusp tracked SU launcher (managed by install-standalone-mcp.sh).
# Picks agent + harness + plan, records a tracked /adv session, then execs
# the raw agent CLI with the playbook + MCP + flags assembled per-launch.
exec node "${PSU_LAUNCHER}" "\$@"
WRAPEOF
  chmod 755 "$PSU_PATH"
  echo "✓ Installed $PSU_PATH (tracked picker launcher)"
  case ":${PATH}:" in
    *":${PSU_BIN_DIR}:"*) : ;;
    *) echo "! $PSU_BIN_DIR is not on PATH — add it or invoke $PSU_PATH by full path" ;;
  esac
else
  echo "! psu launcher not found at $PSU_LAUNCHER; skipping psu install"
fi

# 4h. Install the `ptool` command — an interactive CLI for invoking any
# `defineTool` endpoint from the terminal. Pick a service → an endpoint →
# ptool prompts for each argument (from the tool's inputSchema) and calls it
# over the same superuser MCP surface psu uses (/api/mcp?superuser=1 +
# ~/.papercusp/superuser-token). Thin shim over the Node launcher in the repo
# (which resolves @inquirer/prompts + the MCP SDK from the operator's
# node_modules). Scripting escape (prefer stdin/file JSON for arbitrary text):
#   ptool <group:verb> --json - <<'JSON'   |   ptool --list [filter]
#   {"evidence":"it's safe"}
#   JSON
#   ptool <group:verb> --json-file payload.json
PTOOL_LAUNCHER="${SCRIPT_DIR}/ptool.mjs"
PTOOL_BIN_DIR="${HOME}/.local/bin"
PTOOL_PATH="${PTOOL_BIN_DIR}/ptool"
if [ -f "$PTOOL_LAUNCHER" ]; then
  mkdir -p "$PTOOL_BIN_DIR"
  install_executable_atomic "$PTOOL_PATH" 755 <<WRAPEOF
#!/usr/bin/env bash
# papercusp defineTool CLI (managed by install-standalone-mcp.sh).
# Pick a service + endpoint, prompts for args, calls it over the superuser
# MCP surface. Scripting: ptool <group:verb> --json - <<'JSON' ... JSON;
# ptool <group:verb> --json-file payload.json; ptool --list. Avoid single-quoted
# inline JSON when text can contain apostrophes (for example loop:checkpoint
# recheck strings), because the shell splits the payload before ptool runs.
# Dispatch directly. ptool is also the recovery transport used to repair or
# coordinate dependency/install failures, so putting it behind install-safe's
# reader guard can make a completed write invocation exit after printing only
# the guard banner, without ever reaching MCP (EI-21267836337650976).
exec node "${PTOOL_LAUNCHER}" "\$@"
WRAPEOF
  chmod 755 "$PTOOL_PATH"
  echo "✓ Installed $PTOOL_PATH (defineTool CLI)"
  case ":${PATH}:" in
    *":${PTOOL_BIN_DIR}:"*) : ;;
    *) echo "! $PTOOL_BIN_DIR is not on PATH — add it or invoke $PTOOL_PATH by full path" ;;
  esac
else
  echo "! ptool launcher not found at $PTOOL_LAUNCHER; skipping ptool install"
fi

# 5. Verify the endpoint accepts the token.
echo
echo "→ Verifying loopback access at ${OPERATOR_URL}/api/mcp?superuser=1"
# curl writes %{http_code} on stdout even on connection failure
# (it's just "000" in that case), so we don't need an `|| echo "000"`
# fallback — and adding one duplicates the output to "000000".
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -X POST "${OPERATOR_URL}/api/mcp?superuser=1" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  --max-time 5 || true)
[ -z "$status" ] && status="000"

if [ "$status" = "200" ]; then
  echo "✓ Endpoint responded 200"
else
  echo "✗ Endpoint responded $status (expected 200) — operator may not be running"
  exit 1
fi

cat <<EOF

Done.  Profile: ${PROFILE}

  Plain OMP / Claude Code / Codex — vanilla coding assistant, no playbook:
    \$ omp     \$ claude     \$ codex

  ${PROFILE^}-collaborator mode is launched by ONE command — \`psu\` (the
  *-su wrappers are retired). \`psu\` records a tracked /adv session, then
  execs the RAW CLI per-launch with the playbook + papercusp-su MCP + the
  right flags assembled for the chosen agent:
    \$ psu                                                          # interactive picker
    \$ psu --no-picker --agent=claude --harness=papercup --no-plan  # scripting
    \$ psu --resume          # or --resume=<session-id> / --resume <id>
    \$ psu --role=<role> --harness=<slug> [--feature=<id>]          # role-scoped session

  SU-locks coordination — an edit to a file another SU agent holds:
    - Claude → Pre/PostToolUse hooks in ~/.claude/settings.json (user-level,
      automatic — BLOCKS the edit with the holder's intent + expiry).
    - OMP    → coord-hook.ts loaded via \`-e\` by psu's omp launch (automatic).
    - Codex  → lock PreToolUse is INERT (codex doesn't fire it on edits —
      upstream openai/codex #20204), so codex coordinates LOCKS by calling
      \`locks:*\` itself, per its playbook; the lock hooks.json is ready and
      activates once codex fixes PreToolUse emission. BUT codex's PostToolUse
      DOES fire (Bash / apply_patch / MCP), so the per-session SU CODEX_HOME's
      activity-report PostToolUse hook also folds in new coord:inbox messages
      mid-turn (EI-11405), same as Claude.
  Enforcement scopes to the papercup workspace + fails open when the
  operator is down. /coord surfaces "enforcement offline".

  psu assembles the SAME base playbook with each client's tooling overlay
  spliced in, so OMP-only task-tool guidance never lands in the Claude or
  Codex playbook.

  One-off, by hand (psu does this for you):
    \$ omp    --approval-mode yolo --append-system-prompt ${PLAYBOOK_DEST} \\
             -e ~/.papercusp/papercusp-coord.ts
    \$ claude --dangerously-skip-permissions --append-system-prompt-file ${PLAYBOOK_DEST_CLAUDE}

  Switch profiles:
    \$ install-standalone-mcp.sh --profile=engineer   # full Papercusp-engineer playbook
    \$ install-standalone-mcp.sh --profile=power      # power-engineer subset (generic tools)

The papercusp-su MCP server is registered user-level for \`omp\` + \`claude\`
(entries in ~/.omp/agent/mcp.json and ~/.claude.json) so a raw launch sees
the SU tools; psu adds the playbook (+ for OMP the coordination extension)
per-launch. For Codex, psu mints a per-session CODEX_HOME with the superuser
MCP — plain \`codex\` (CODEX_HOME=~/.codex) stays fully vanilla.

OMP-native Hindsight memory is enabled by this installer:
  memory.backend=hindsight
  hindsight.apiUrl=${PAPERCUSP_HINDSIGHT_API_URL:-${HINDSIGHT_API_URL:-http://localhost:8888}}
  hindsight.scoping=per-project-tagged
Start a local server if you are not using Hindsight Cloud:
  docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest

Project docs — point the docs:* tools at YOUR project's docs (instead
of Papercusp engineering docs) by setting the env var below before
launching a session:
    \$ export PAPERCUSP_PROJECT_DOCS_ROOT=\$PWD/docs
The docs:* tools (outline/get/search) then read from that dir on every
no-harness call. Unset → docs:* returns no_docs_source for non-SU
callers (rather than silently leaking Papercusp's docs).

To rotate the token, delete $TOKEN_PATH and re-run. To revoke, delete:
  $TOKEN_PATH
  $PLAYBOOK_DEST
  $PLAYBOOK_DEST_CLAUDE
  $COORD_EXT_DEST
  $PSU_PATH   (the tracked picker launcher)
  $CC_HOOK_DEST_DIR   (the shared Claude/Codex lock hooks)
  ~/.papercusp/su-codex-homes   (per-session codex homes psu minted, if any)
  (remove the 'papercusp-su' entry from both $OMP_CONFIG_PATH and $CLAUDE_CONFIG_PATH,
   and the SU-locks Pre/PostToolUse entries from ${HOME}/.claude/settings.json)

EOF
