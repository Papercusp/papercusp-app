#!/usr/bin/env bash
# gate-sidecar-boots.sh — the packed sidecar must actually BOOT before we ship it.
#
# WHY THIS EXISTS
# 0.0.9 shipped a sidecar that could not start on ANY platform. Five green cuts
# missed it. The bundle's closure-copier followed only `dependencies`, so sharp's
# native binary (an optionalDependency — that is the napi convention) was never
# copied; the installed app died at import with `Could not load the "sharp" module`.
#
# It survived every check because of a FALLBACK. When its own sidecar fails, the
# desktop app falls back to an operator on :3070 — which exists on our dev boxes
# and on NO user's machine. So the app looked healthy exactly where we tested it
# and was dead everywhere else.
#
#   A FALLBACK THAT HIDES A FATAL ERROR IS WORSE THAN NO FALLBACK, and
#   VERIFICATION PERFORMED IN AN ENVIRONMENT THAT SUPPLIES A DEPENDENCY THE
#   ARTIFACT IS SUPPOSED TO CARRY CANNOT SEE THE FAILURE.
#
# We already gate PACKED (the host-bake byte check) and DELIVERED (the ARRIVES
# /proc/<pid>/environ probe). Nothing gated "the thing we packed can START" —
# that gap IS how this shipped. This is that gate.
#
# WHAT IT DOES
# Runs the PACKED serve.mjs with the BUNDLED node, in an isolated root, with the
# same env the Rust host passes (src-tauri/src/main.rs), and requires it to SERVE
# HTTP. Nothing is mocked: it is the shipped artifact, started the shipped way.
#
# THE ISOLATION IS THE WHOLE POINT — DO NOT WEAKEN IT
# Node resolves a missing module by walking node_modules UPWARD from the file. Run
# the bundle from inside the repo and a missing native resolves out of the REPO's
# node_modules — the broken bundle boots fine and the gate passes vacuously. So we
# copy the bundle to a base with NO node_modules in any ancestor, and REFUSE TO RUN
# if we cannot find one. (This is not theoretical: the first base tried was $HOME,
# and this box has a ~/node_modules that supplied the exact missing native.)
#
# `--ensure` IS SAFE HERE ONLY BECAUSE HOME IS PRIVATE. serve's reconcileEnsure
# reads ~/.papercusp/operator.json and, on a build-identity mismatch, SIGTERM+
# SIGKILLs the operator it finds. Pointed at the real HOME it would kill the live
# operator the whole fleet is using. The private HOME means it finds no discovery
# record, cold-starts, and cannot see — let alone kill — anything real. Never run
# this against the developer's HOME.
#
#   bash bin/gate-sidecar-boots.sh [sidecar-dir]     # exits 0 = boots, 1 = DOA
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SIDECAR="${1:-$ROOT/src-tauri/sidecar}"
BOOT_TIMEOUT="${PAPERCUSP_BOOT_GATE_TIMEOUT:-180}"

fail() { echo "❌ BOOT GATE FAILED: $*" >&2; exit 1; }

[[ -d "$SIDECAR" ]]            || fail "no sidecar dir at $SIDECAR"
[[ -f "$SIDECAR/serve.mjs" ]]  || fail "no serve.mjs in $SIDECAR"

# The bundled node is `node` on linux/mac, `node.exe` on Windows — resolve either,
# and always run THE NODE WE SHIP (never the box's), since a stale foreign node
# would mask exactly the kind of runtime-mismatch this gate exists to catch.
NODE_BIN=""
for cand in "$SIDECAR/bin/node" "$SIDECAR/bin/node.exe"; do
  [[ -f "$cand" ]] && { NODE_BIN="$cand"; break; }
done
[[ -n "$NODE_BIN" ]] || fail "no BUNDLED node at $SIDECAR/bin/{node,node.exe} — the gate must use the node we ship, not the box's"

echo "== boot gate: can the PACKED sidecar actually start?"

# ── 1. An isolation base with NO node_modules above it ────────────────────────
# Without this the box lends the bundle what the bundle failed to carry.
ancestors_clean() {
  local p="$1"
  while [[ "$p" != "/" ]]; do
    [[ -d "$p/node_modules" ]] && { echo "$p/node_modules"; return 1; }
    p="$(dirname "$p")"
  done
  [[ -d /node_modules ]] && { echo "/node_modules"; return 1; }
  return 0
}
dev_of() { df --output=source "$1" 2>/dev/null | tail -1 | tr -d ' '; }

SIDE_DEV="$(dev_of "$SIDECAR")"
ISO_BASE=""
for cand in "${PAPERCUSP_BOOT_GATE_BASE:-}" /var/tmp "${TMPDIR:-/tmp}" /tmp; do
  [[ -n "$cand" && -d "$cand" && -w "$cand" ]] || continue
  if contaminated="$(ancestors_clean "$cand")"; then
    ISO_BASE="$cand"
    # Same device ⇒ `cp -al` hardlinks: instant, and adds no disk (a cut has died
    # on disk pressure before). Keep looking if this base is on another device.
    [[ "$(dev_of "$cand")" == "$SIDE_DEV" ]] && break
  else
    echo "   skipping $cand — contaminated: $contaminated"
  fi
done
[[ -n "$ISO_BASE" ]] || fail "no isolation base free of an ancestor node_modules — the gate cannot prove anything, so it refuses to pass"

ISO="$(mktemp -d "$ISO_BASE/pc-bootgate-XXXXXX")"

# Bundle isolation and mutable boot state have different placement needs. The
# bundle prefers the sidecar's device so `cp -al` remains instant and free, but
# PGDATA performs thousands of writes + fsyncs during a fresh migration boot.
# Keeping both below $ISO_BASE put that mutable database on the nearly-full
# release filesystem on the 0.0.19 cut: PostgreSQL's final CHECKPOINT consumed
# the gate's remaining 107 seconds. The exact same isolated bundle served in
# 24 seconds when only HOME/PGDATA/log moved to /tmp. Keep those concerns split.
STATE_BASE="${PAPERCUSP_BOOT_GATE_STATE_BASE:-${TMPDIR:-/tmp}}"
[[ -d "$STATE_BASE" && -w "$STATE_BASE" ]] \
  || fail "mutable-state base is not a writable directory: $STATE_BASE (set PAPERCUSP_BOOT_GATE_STATE_BASE)"
STATE="$(mktemp -d "$STATE_BASE/pc-bootgate-state-XXXXXX")" \
  || fail "could not create private mutable boot state below $STATE_BASE"
cleanup() {
  [[ -n "${PID:-}" ]] && { kill -TERM "-$PID" 2>/dev/null; sleep 1; kill -KILL "-$PID" 2>/dev/null; }
  rm -rf "$ISO" "$STATE"
}
trap cleanup EXIT
echo "   isolated at $ISO (no ancestor node_modules)"
echo "   mutable boot state at $STATE (HOME, PGDATA, logs)"

HARDLINKED=0
if cp -al "$SIDECAR" "$ISO/sidecar" 2>/dev/null; then
  HARDLINKED=1
  echo "   bundle hardlinked (same device — no copy, no disk)"
else
  echo "   bundle on another device — real copy (slower)"
  cp -a "$SIDECAR" "$ISO/sidecar" || fail "could not stage the bundle"
fi
B="$ISO/sidecar"
B_NODE="$B/bin/$(basename "$NODE_BIN")"   # node or node.exe, inside the isolated copy
mkdir -p "$STATE/home" "$STATE/pgdata" "$STATE/dev-source"
# Hardlinks share inodes: a sidecar that wrote to its OWN dir IN PLACE would mutate
# the real staged bundle the cut is about to pack. It doesn't today (the shipped
# sidecar lives read-only under /usr/lib, so it can't), and this marker proves it
# still doesn't — rather than trusting that it never will.
touch "$ISO/.before-boot"

# ── 2. Boot it the way the product does ───────────────────────────────────────
# Mirrors the sidecar spawn env in src-tauri/src/main.rs. Without the resource
# paths, serve falls back to REPO-RELATIVE defaults that do not exist inside a
# bundle, and dies on missing migrations — a gate artifact that looks exactly
# like a real failure. If main.rs gains a resource path, add it here too; the
# drift check below prints the ones we do not pass.
#
# HERMETIC: PAPERCUSP_DISABLE_DOGFOOD_HIVE=1 suppresses the first-boot hive clone
# of github.com/Papercusp/papercup. Without it, serve kicks off a best-effort
# multi-GB clone that git authenticates through the BUILD BOX's own `gh`
# credential helper — so the gate would touch the network and lean on a per-box
# credential to prove something (sidecar startup) that has nothing to do with the
# hive. It also produces the alarming-but-benign `x-access-token:gho_…` clone URL
# in the process list: that token is the operator resolving the box's gh login at
# clone time (clone-github.ts), NOT anything carried in the bundle — the packed
# seed + bundle were both verified free of it. The gate needs the sidecar to
# START and SERVE; it does not need it to clone. Disable it and stay hermetic.
# A port with a listener is occupied; a refused connect means very likely free.
# This only narrows the race (something can still grab the port between the check
# and PG's bind) — the collision RETRY below closes it. Uses bash /dev/tcp so it
# needs no ss/lsof.
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
pick_port() {  # pick_port LO SPAN → echoes a currently-free port in [LO, LO+SPAN)
  local lo=$1 span=$2 p
  for _ in $(seq 1 20); do p=$(( lo + RANDOM % span )); port_free "$p" && { echo "$p"; return 0; }; done
  echo $(( lo + RANDOM % span ))  # all 20 busy? use the last — the retry loop still covers it
}

# ── 3. Boot, and require it to SERVE. Exit = death; silence to the deadline =
# death. A PORT COLLISION is NEITHER — it is an infra flake of THIS box (a busy
# shared machine), not a defect in the bundle. Retrying a genuine DOA would be
# how the gate masks the very failure it exists to catch, so the retry keys
# STRICTLY on the postmaster's bind-failure signature and nothing else: a real
# boot error (missing native, bad module) still fails on the first attempt.
PORT_COLLISION_RE='could not bind|Address already in use|could not create any TCP/IP sockets|EADDRINUSE'
MAX_ATTEMPTS="${PAPERCUSP_BOOT_GATE_ATTEMPTS:-3}"
PG_SEED="$B/db-seed.dump"
[[ -s "$PG_SEED" ]] || PG_SEED="$B/db-seed.tar.gz" # old-bundle compatibility

served=0
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  HTTP_PORT="$(pick_port 20000 20000)"
  PG_PORT="$(pick_port 40000 20000)"
  echo "   attempt $attempt/$MAX_ATTEMPTS: bundled node $("$B_NODE" --version) → http :$HTTP_PORT, pg :$PG_PORT"

  set -m
  env -i \
    HOME="$STATE/home" \
    PATH="$B/bin:/usr/bin:/bin" \
    LANG=C.UTF-8 TERM=dumb \
    PAPERCUSP_DESKTOP=1 \
    PAPERCUSP_SERVE_UI=0 \
    PAPERCUSP_DISABLE_DOGFOOD_HIVE=1 \
    PAPERCUSP_HONO_PORT="$HTTP_PORT" \
    PAPERCUSP_PG_PORT="$PG_PORT" \
    PAPERCUSP_PG_DATA_DIR="$STATE/pgdata" \
    PAPERCUSP_PG_SQL_DIR="$B/db-sql" \
    PAPERCUSP_PG_SEED_PATH="$PG_SEED" \
    PAPERCUSP_PG_RESTORE_BIN="$B/bin/pg_restore" \
    PAPERCUSP_SEED_DIR="$B/../seed" \
    PAPERCUSP_HARNESS_DIR="$B/harness" \
    PAPERCUSP_RUBRICS_DIR="$B/rubrics" \
    PAPERCUSP_TEMPLATES_DIR="$B/templates" \
    PAPERCUSP_GOAL_PACKAGES_DIR="$B/goal-packages" \
    PAPERCUSP_SIDECAR_DIR="$B" \
    PAPERCUSP_IDENTITY_DIR="$STATE/home/.papercusp-workspaces/.shared/.papercusp/identity" \
    PAPERCUSP_WORKSPACES_ROOT="$STATE/home/.papercusp-workspaces" \
    PAPERCUSP_PROMPTS_DIR="$B/prompts" \
    PAPERCUSP_DOCS_ROOT="$B/internal-docs" \
    PAPERCUSP_SOURCE_ARCHIVE="$B/source.tar.zst" \
    PAPERCUSP_DEV_SOURCE_DIR="$STATE/dev-source" \
    "$B_NODE" "$B/serve.mjs" --ensure > "$STATE/boot.log" 2>&1 &
  PID=$!

  deadline=$(( $(date +%s) + BOOT_TIMEOUT ))
  outcome=""   # served | exited | timeout
  while [[ $(date +%s) -lt $deadline ]]; do
    if ! kill -0 "$PID" 2>/dev/null; then wait "$PID"; rc=$?; outcome="exited"; break; fi
    # "Up" means exactly what the PRODUCT means by up. serve.ts's httpAlive() probes
    # `/api/` and treats ANY response — 404 included — as alive; match a real status
    # code POSITIVELY (a refused connect yields empty/000 and must never read as up).
    code="$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HTTP_PORT/api/" 2>/dev/null)"
    if [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]; then
      echo "   sidecar answered on :$HTTP_PORT (HTTP $code) — it is UP"
      served=1; outcome="served"; break
    fi
    sleep 2
  done
  [[ "$outcome" == "served" ]] && break

  # Tear the attempt's process tree down before deciding, so a retry's ports are free.
  kill -TERM "-$PID" 2>/dev/null; sleep 1; kill -KILL "-$PID" 2>/dev/null; PID=""

  if [[ "$outcome" == "exited" ]] && grep -qiE "$PORT_COLLISION_RE" "$STATE/boot.log"; then
    echo "   ⚠ attempt $attempt hit a PG port collision (infra flake, not a bundle defect) — retrying with new ports" >&2
    continue
  fi

  # Anything else is a REAL failure — do not retry, do not mask it.
  echo "── last 25 lines of the packed sidecar's boot log ──" >&2
  tail -25 "$STATE/boot.log" >&2
  if [[ "$outcome" == "exited" ]]; then
    fail "the packed sidecar EXITED (rc=${rc:-?}) instead of serving. This bundle is DOA on any machine that lacks a fallback operator."
  else
    fail "the packed sidecar never served on :$HTTP_PORT within ${BOOT_TIMEOUT}s — treating silence as failure, not success."
  fi
done

if [[ $served -ne 1 ]]; then
  echo "── last 25 lines of the packed sidecar's boot log ──" >&2
  tail -25 "$STATE/boot.log" >&2
  fail "could not obtain a clean boot in $MAX_ATTEMPTS attempts — every attempt hit a port collision. The box is too busy to gate on; re-run, or set PAPERCUSP_BOOT_GATE_ATTEMPTS higher."
fi

if [[ $HARDLINKED -eq 1 ]]; then
  touched="$(find "$SIDECAR" -newer "$ISO/.before-boot" -type f 2>/dev/null | head -5)"
  [[ -n "$touched" ]] && fail "the booted sidecar wrote INTO ITS OWN BUNDLE DIR, and hardlinks made that a write to the REAL staged bundle:
$touched
  Re-run with PAPERCUSP_BOOT_GATE_BASE set to a dir on ANOTHER device (forces a real copy). The cut must not pack a bundle this gate mutated."
fi

echo "✅ BOOT GATE PASSED — the packed sidecar cold-started and served, with no fallback operator to lean on."

# ── 4. Drift check: has the product's spawn env grown a resource path we omit? ─
# A gate that silently stops matching the product's spawn is a gate that stops
# proving anything. Advisory (a new var is usually optional), but never silent.
MAIN_RS="$ROOT/src-tauri/src/main.rs"
if [[ -f "$MAIN_RS" ]]; then
  missing=""
  for v in $(grep -oE '"PAPERCUSP_[A-Z_]*(DIR|PATH|ROOT|ARCHIVE)"' "$MAIN_RS" | tr -d '"' | sort -u); do
    grep -q "$v=" "${BASH_SOURCE[0]}" || missing="$missing $v"
  done
  [[ -n "$missing" ]] && echo "   ⚠ drift: main.rs passes the sidecar resource path(s)$missing that this gate does not — if a boot failure looks bogus, start here."
fi
exit 0
