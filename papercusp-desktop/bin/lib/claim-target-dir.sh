#!/usr/bin/env bash
# claim-target-dir.sh — pick a Rust target dir this desktop instance can own ALONE.
#
# SOURCE this, do not execute it: it exports CARGO_TARGET_DIR into the caller's
# environment and holds a lock fd that the caller's later `exec` must inherit.
#
#   . "$(dirname "$0")/lib/claim-target-dir.sh"
#   exec npm run tauri -- dev ...
#
# WHY THIS EXISTS (WI-7101)
# Cargo configuration pins a shared `build.target-dir` for the whole box
# (originally ~/.cargo-target, later relocated to the data disk). So every
# papercusp-desktop build shares ONE target dir — including the GENERATED
# app-manifest under `<target>/debug/build/papercusp-desktop-*/out/app-manifest`.
# Two concurrent builds interleave writes to it and BOTH die with:
#
#   thread 'main' panicked at build.rs:305:6:
#   failed to run tauri_build with the app-command manifest (WI-1976):
#   failed to parse JSON: expected `,` or `]` at line 14 column 9
#
# That is not a tracked file, so `git status` is clean and every checked-in
# capabilities/*.json parses fine — which is exactly why it reads as a mystery.
#
# The expensive part: `tauri dev` REBUILDS ON CHANGE, so an agent starting a
# second instance corrupts the manifest under the OWNER'S already-running
# desktop and takes it down too. On 2026-08-02 that is precisely what happened,
# and the agent was FOLLOWING the documented advice (CLAUDE.md "start the shell
# and drive it" + the stored guidance to use an isolated Xvfb instance rather
# than drive the owner's window). The recommended safe practice was the thing
# that broke the owner's desktop. Hence a fix in the wrapper, not a new warning.
#
# THE APPROACH: target-dir SLOTS, claimed by non-blocking flock.
# Slot 0 is the existing shared dir, so the ordinary single-instance case is
# unchanged and keeps its warm cache. A second instance takes slot 1, a third
# slot 2, and so on. Slots have STABLE names, which is the whole point — a
# per-pid dir would isolate just as well but pay a COLD (~10min) build every
# single launch, whereas a slot keeps its own incremental cache across runs.
#
# Why flock rather than "is another instance running?": a pgrep/pidfile test is
# check-then-act, so two launches racing at the same moment both see "nobody
# there" and both take slot 0 — reproducing the exact bug. The flock IS the
# decision, so the claim is atomic. A POSIX lock lives on the open file
# DESCRIPTION, so it survives the caller's `exec` and is released automatically
# when the process dies: no trap, no cleanup, no stale lock to reap.
#
# Escape hatches:
#   CARGO_TARGET_DIR=...                    already set ⇒ respected, no claim
#   PAPERCUSP_DESKTOP_TARGET_SLOTS=N        how many slots to offer (default 4)
#   PAPERCUSP_DESKTOP_TARGET_SLOTS=0        disable entirely (legacy behaviour)

# Lock files live OUTSIDE the target dirs they guard: a `cargo clean` (or an
# agent reclaiming disk) wipes a target dir, and a lock file vanishing out from
# under a live holder would let a second instance claim a slot that is still in use.
__pc_slot_lockdir="${HOME}/.papercusp/desktop-dev-slots"

# Release cuts retain their finished artifacts and the target roots that contain
# them. Load the shared retention helper here so slot selection can skip a root
# protected by any active cut, even when this wrapper is used directly rather
# than through release-local.sh.
__pc_claim_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release-artifacts.sh
source "$__pc_claim_dir/release-artifacts.sh"
# shellcheck source=cargo-target-root.sh
source "$__pc_claim_dir/cargo-target-root.sh"

# Is a live process EXECUTING out of this target dir?
#
# The flock below proves only that a LAUNCHER is alive. It is held by the launcher
# process (`npm run tauri dev`, or the tauri CLI on the `npm run tauri -- dev` path)
# and is NOT inherited by the desktop binary that CLI spawns. Measured 2026-08-09 on a
# desktop running 57min past its build: `fuser` reported ONLY npm (pid 599420) holding
# slot0.lock, while the app (pid 599886) held no fd on it at all. So a desktop whose
# launcher was reaped — routine here, where a service-cgroup restart takes out
# agent-owned children (EI-9748) — keeps running out of its target dir holding NO lock,
# and the next launcher correctly sees a free slot and builds into a dir a live desktop
# depends on. That is the gap this closes.
#
# Read the kernel's executable links, never argv. The check this replaces could,
# and did, get fooled: `pgrep -af '[t]auri dev'`
# matched the wrapper's OWN ANCESTOR on every `npm run tauri -- dev` launch, because npm
# rewrites its process title to `npm run tauri dev …` — and it also matched any peer
# agent's shell that had merely typed the string. Bracketing `[t]auri` guards the pgrep's
# own argv only, never an ancestor's. That false positive is why this file used to print
# "a desktop build is already running but holds NO slot lock" on launches where nothing
# else was running at all, and it is the reason a warning was never enough here (WI-37452).
#
# Linux uses one in-process /proc scan, reading only exe links. `fuser -s` also
# walks unrelated processes' file descriptors and stalled a verifier for minutes
# BEFORE Cargo started (EI-22467167909855383). Spawning readlink once per PID is
# expensive too; Node is already required by this npm launcher. A renamed or
# deleted executable under the target root still protects that root.
# KNOWN BLIND SPOT:
#   - A build started OUTSIDE this wrapper (a bare `cargo tauri dev`) has no app running
#     yet, so nothing here can see it. That path is unprotected by construction.
__pc_desktop_running_in() {
  local dir="$1"
  if [[ -d /proc/self ]]; then
    local status=0
    # An unavailable probe must never be interpreted as an unused target root.
    node - "$dir" <<'JS' || status=$?
const fs = require('node:fs');
const path = require('node:path');
let root = path.resolve(process.argv[2]);
try { root = fs.realpathSync(root); } catch (error) {
  if (error.code !== 'ENOENT') process.exit(2);
}
let pids;
try { pids = fs.readdirSync('/proc'); } catch { process.exit(2); }
let unknown = false;
for (const pid of pids) {
  if (!/^\d+$/.test(pid)) continue;
  try {
    const exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
    if (exe.startsWith(root + path.sep)) process.exit(0);
  } catch (error) {
    // Match fuser's visibility: exited/kernel tasks have no executable link;
    // nondumpable tasks (including the same user's keyring) deny ptrace reads.
    // Those denials say nothing about this target root. The launcher flock is
    // still authoritative, and ordinary orphaned desktop executables remain
    // readable. Unexpected probe failures retain the safety fence.
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) continue;
    unknown = true;
  }
}
process.exit(unknown ? 2 : 1);
JS
    if [[ "$status" == 1 ]]; then return 1; fi
    if [[ "$status" != 0 ]]; then
      echo "→ executable identity probe unavailable for $dir — treating the slot as occupied" >&2
    fi
    return 0
  fi
  command -v fuser >/dev/null 2>&1 || return 1
  fuser -s "${dir}/debug/papercusp-desktop" 2>/dev/null
}

# Restore a missing relocation referent without replacing its symlink.
#
__pc_restore_missing_symlink_referent() {
  local root="${1:?symlink root required}"
  local label="${2:-target}"
  local raw_target target parent

  [[ -L "$root" && ! -e "$root" ]] || return 0
  raw_target="$(readlink "$root")" || {
    echo "ERROR: cannot read $label symlink: $root" >&2
    return 1
  }
  [[ -n "$raw_target" ]] || {
    echo "ERROR: $label symlink has an empty referent: $root" >&2
    return 1
  }
  case "$raw_target" in
    /*) target="$raw_target" ;;
    *) target="$(dirname "$root")/$raw_target" ;;
  esac
  parent="$(dirname "$target")"
  [[ -d "$parent" ]] || {
    echo "ERROR: $label symlink $root points below missing parent $parent — refusing to manufacture the relocation hierarchy" >&2
    return 1
  }
  if ! mkdir -- "$target" 2>/dev/null && [[ ! -d "$target" ]]; then
    echo "ERROR: cannot recreate missing $label referent $target for $root" >&2
    return 1
  fi
  echo "→ restored missing $label referent $target (preserved symlink $root)" >&2
}

# Materialize a derived target root before handing it to Cargo.  The configured
# shared root can live below a parent that the desktop user may traverse but
# cannot modify (the production /mnt/data/cargo-target placement is exactly
# that shape).  In that case Cargo cannot create a sibling such as
# /mnt/data/cargo-target-dev2: its own temporary mkdir fails with EACCES before
# compilation begins.  Keep the preferred sibling when its parent permits it;
# otherwise place the stable slot inside the already-writable shared root.  The
# fallback remains on the configured filesystem and outside Cargo's ordinary
# debug/release namespace.
__pc_prepare_derived_target_root() {
  local preferred="${1:?preferred target root required}"
  local shared="${2:?shared target root required}"
  local slot_name="${3:?slot name required}"
  local fallback_parent fallback

  if [[ -d "$preferred" && -w "$preferred" && -x "$preferred" ]]; then
    printf '%s\n' "$preferred"
    return 0
  fi
  if [[ ! -e "$preferred" && ! -L "$preferred" ]] \
    && mkdir -- "$preferred" 2>/dev/null; then
    printf '%s\n' "$preferred"
    return 0
  fi

  fallback_parent="$shared/.papercusp-target-slots"
  fallback="$fallback_parent/$slot_name"
  if [[ ! -d "$shared" || ! -w "$shared" || ! -x "$shared" ]]; then
    echo "ERROR: cannot prepare target slot $preferred and shared root is not writable: $shared" >&2
    return 1
  fi
  if ! mkdir -p -- "$fallback_parent" 2>/dev/null; then
    echo "ERROR: cannot prepare target-slot fallback parent: $fallback_parent" >&2
    return 1
  fi
  if [[ -e "$fallback" && ! -d "$fallback" ]]; then
    echo "ERROR: target-slot fallback exists but is not a directory: $fallback" >&2
    return 1
  fi
  if [[ ! -e "$fallback" ]] && ! mkdir -- "$fallback" 2>/dev/null; then
    echo "ERROR: cannot prepare target-slot fallback: $fallback" >&2
    return 1
  fi
  if [[ ! -w "$fallback" || ! -x "$fallback" ]]; then
    echo "ERROR: target-slot fallback is not writable: $fallback" >&2
    return 1
  fi

  echo "→ target slot $preferred cannot be materialized; using writable same-filesystem fallback $fallback" >&2
  printf '%s\n' "$fallback"
}

# Prepare a source-tree collection target without replacing relocation links.
# The completed package already lives in an isolated Cargo root and must be
# copied into the canonical source-tree target. Recreate only the missing
# referent directory when its immediate parent already exists; never replace
# the symlink, manufacture a missing parent hierarchy, or route around a
# non-directory occupant.
papercusp_prepare_collection_target_root() {
  local root="${1:?collection target root required}"

  __pc_restore_missing_symlink_referent "$root" "collection target" || return 1

  if [[ -e "$root" && ! -d "$root" ]]; then
    echo "ERROR: collection target root exists but is not a directory: $root" >&2
    return 1
  fi
  [[ ! -L "$root" || -d "$root" ]] || {
    echo "ERROR: collection target symlink remains unusable after recovery: $root" >&2
    return 1
  }
}

# Ask Cargo for its effective placement, including project configuration,
# CARGO_HOME and CARGO_BUILD_TARGET_DIR. Parsing one TOML file or retaining the
# historical HOME/.cargo-target name silently overrides a configured relocation
# (EI-22589688521091797). Query the actual target project, not the current
# orchestrator's checkout, when executing an exact-source release retry.
__pc_cargo_target_root() {
  local project="${PAPERCUSP_DESKTOP_TARGET_ROOT:-${ROOT:-$PWD}}"
  if [[ -f "$project/src-tauri/Cargo.toml" ]]; then
    project="$project/src-tauri"
  elif [[ ! -f "$project/Cargo.toml" ]]; then
    project="$__pc_claim_dir/../../src-tauri"
  fi
  # The shared resolver (bin/lib/cargo-target-root.sh) is the single reader.
  papercusp_cargo_metadata_target_dir "$project"
}

# PRIVATE OVERFLOW SLOTS — reaping and warm reuse (WI-10004764)
#
# When every named slot is busy the claim falls back to a private per-pid root
# (`<shared>-pid<N>`, or `<shared>/.papercusp-target-slots/pid<N>` below a
# non-writable parent). Nothing ever removed one. Each is a COLD Cargo root of
# 27-65 GiB, and on this box overflow is routine: on 2026-10-01 the data disk held
# 131 of them, 774 GiB, and was at 99%. A finished private root is only garbage —
# so reap it, and let the next overflow launch ADOPT the newest dead one as a warm
# cache instead of paying another cold build and another 60 GiB of writes.
#
# A private root is reapable only when ALL hold:
#   - no live claimant: its lock (`<lockdir>/pid<N>.lock`, taken by every new
#     private claim and inherited across `exec` like the named-slot locks) is
#     free; a LEGACY root with no lock file needs its claiming pid to be gone,
#     and a live — possibly recycled — pid keeps it (fails toward keeping);
#   - nothing references it: no process executes from it, runs inside it, or has
#     CARGO_TARGET_DIR pointing into it (one /proc pass; an unreadable /proc
#     keeps everything);
#   - it is idle past PAPERCUSP_DESKTOP_PRIVATE_SLOT_GRACE_SEC (default 1800);
#   - no release-retention lease covers it (a finished cut's artifacts live in
#     exactly these roots; the lease expiring is what releases them).
# Reaping renames the root aside under a lock (atomic, same filesystem), then
# deletes through release_artifacts_guarded_delete, which re-checks leases and
# writes the deletion audit. Deletion runs in the background at idle I/O
# priority so a launch never waits on it; an interrupted deletion leaves a
# `.reaping-*` dir that the next reaper finishes.
#
#   PAPERCUSP_DESKTOP_PRIVATE_SLOT_REAP=0      never reap or adopt
#   PAPERCUSP_DESKTOP_PRIVATE_SLOT_GRACE_SEC   idle time before a dead root is touched
#   PAPERCUSP_DESKTOP_PRIVATE_SLOT_REAP_SYNC=1 delete in the foreground (tests, reap-only runs)

# Print "<dir>\t<slot-name>" for every private root under a shared root.
__pc_private_slot_candidates() {
  local shared="${1:?shared target root required}" dir name sibling_prefix
  sibling_prefix="${shared##*/}-"
  for dir in "${shared}"-pid* "${shared}/.papercusp-target-slots"/pid*; do
    [[ -d "$dir" && ! -L "$dir" ]] || continue
    name="${dir##*/}"
    name="${name#"$sibling_prefix"}"
    [[ "$name" =~ ^pid[0-9]+(-[0-9]+)?$ ]] || continue
    printf '%s\t%s\n' "$dir" "$name"
  done
}

# 0 when no claimant is alive for this private root.
__pc_private_slot_unclaimed() {
  local name="$1" lock pid
  lock="${__pc_slot_lockdir}/${name}.lock"
  if [[ -e "$lock" ]]; then
    # Held by any live process that inherited the claim's descriptor.
    ( exec 6>>"$lock" && flock -n 6 ) 2>/dev/null || return 1
    return 0
  fi
  pid="${name#pid}"
  pid="${pid%%-*}"
  # Legacy root: its claiming pid is the only liveness signal. A pid owned by
  # another user answers EPERM to kill -0 but still exists in /proc.
  if kill -0 "$pid" 2>/dev/null || [[ -e "/proc/$pid" ]]; then
    return 1
  fi
  return 0
}

# Newest mtime (epoch seconds) of a root and the Cargo profile dirs inside it.
__pc_private_slot_last_active() {
  local dir="$1" newest=0 p t
  for p in "$dir" "$dir/debug" "$dir/release" "$dir/release/bundle"; do
    [[ -e "$p" ]] || continue
    t="$(stat -c %Y -- "$p" 2>/dev/null)" || continue
    (( t > newest )) && newest="$t"
  done
  printf '%s\n' "$newest"
}

# Read candidate roots on stdin; print those a live process references.
# Prints every candidate when /proc cannot be read reliably (fails closed).
__pc_private_slots_referenced() {
  if [[ ! -d /proc/self ]]; then cat; return 0; fi
  local status=0
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const roots = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
const real = roots.map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
const hits = new Set();
const inside = (p, i) => p === real[i] || p.startsWith(real[i] + path.sep)
  || p === roots[i] || p.startsWith(roots[i] + path.sep);
const mark = (p) => { for (let i = 0; i < roots.length; i++) if (inside(p, i)) hits.add(roots[i]); };
let pids;
try { pids = fs.readdirSync("/proc"); } catch { process.exit(2); }
let unknown = false;
const tolerated = ["ENOENT", "ESRCH", "EACCES", "EPERM"];
for (const pid of pids) {
  if (!/^\d+$/.test(pid)) continue;
  for (const link of ["exe", "cwd"]) {
    try { mark(fs.readlinkSync(`/proc/${pid}/${link}`).replace(/ \(deleted\)$/, "")); }
    catch (e) { if (!tolerated.includes(e.code)) unknown = true; }
  }
  try {
    for (const kv of fs.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0")) {
      if (kv.startsWith("CARGO_TARGET_DIR=")) mark(path.resolve(kv.slice(17) || "/nonexistent"));
    }
  } catch (e) { if (!tolerated.includes(e.code)) unknown = true; }
}
if (unknown) process.exit(2);
for (const r of hits) process.stdout.write(r + "\n");
' || status=$?
  if [[ "$status" != 0 ]]; then
    echo "→ private target-slot reference probe unavailable — keeping every private root" >&2
    return 2
  fi
}

# 0 when every Cargo build-script output in this root was generated AT this path.
#
# A Cargo root is NOT relocatable. Cargo keeps a finished build script's output
# when the root moves, because its fingerprint does not change. Build scripts write
# absolute paths into their OUT_DIR files, and Cargo cannot rewrite those: tauri's
# `out/tauri-core-*-permission-files` lists every permission .toml by absolute path,
# and tauri_build reads the list to build the app manifest. A moved root therefore
# breaks the next `tauri dev` with "failed to read plugin permissions … No such file"
# (WI-10004841). `root-output` records the OUT_DIR each script ran against, so a
# root-output outside this root marks a root that was moved. It may only be reaped.
__pc_private_slot_paths_anchored() {
  local dir="$1" real f stray
  local -a outs=()
  for f in "$dir"/debug/build/*/root-output "$dir"/release/build/*/root-output \
           "$dir"/*/debug/build/*/root-output "$dir"/*/release/build/*/root-output; do
    [[ -f "$f" ]] && outs+=("$f")
  done
  ((${#outs[@]} > 0)) || return 0
  real="$(realpath -- "$dir" 2>/dev/null)" || real="$dir"
  stray="$(printf '%s\0' "${outs[@]}" | xargs -0 grep -L -F -e "$dir/" -e "$real/" -- 2>/dev/null)"
  [[ -z "$stray" ]]
}

# Delete roots already renamed aside (`.reaping-*`), through the audited guard.
__pc_private_slot_delete_renamed() {
  local shared="$1" dir
  local -a doomed=()
  for dir in "${shared%/*}/.${shared##*/}-reaping-"* "${shared}/.papercusp-target-slots"/.reaping-*; do
    [[ -d "$dir" && ! -L "$dir" ]] && doomed+=("$dir")
  done
  ((${#doomed[@]} > 0)) || return 0
  if [[ "${PAPERCUSP_DESKTOP_PRIVATE_SLOT_REAP_SYNC:-0}" == "1" ]]; then
    PAPERCUSP_RELEASE_DELETER=claim-target-dir.sh release_artifacts_guarded_delete "${doomed[@]}" || true
    return 0
  fi
  (
    # Drop every inherited descriptor first. The launcher's slot lock (fd 8) and
    # any caller lock (fd 9, cargo-build-safe) would otherwise stay held for as
    # long as this deletion runs, and the slot would look busy after its build
    # had ended.
    local fd
    for fd in /proc/"$BASHPID"/fd/*; do
      fd="${fd##*/}"
      [[ "$fd" =~ ^[0-9]+$ ]] && ((fd > 2)) && eval "exec ${fd}>&-" 2>/dev/null || true
    done
    command -v ionice >/dev/null 2>&1 && { ionice -c3 -p "$BASHPID" 2>/dev/null || true; }
    renice -n 19 -p "$BASHPID" >/dev/null 2>&1 || true
    PAPERCUSP_RELEASE_DELETER=claim-target-dir.sh release_artifacts_guarded_delete "${doomed[@]}" || true
  ) </dev/null >/dev/null 2>&1 &
}

# __pc_reap_private_target_slots <shared> [adopt-name]
# Reap dead private roots. With adopt-name (the caller's own per-pid slot name),
# ADOPT the newest reapable root IN PLACE instead of deleting it: take that root's
# own lock, keep its path, and set __pc_adopted_private_root to it and
# __pc_adopted_private_lock_fd to the open, flocked descriptor (the caller moves
# its claim onto it). Never rename a root to adopt it: a moved Cargo root strands
# the absolute paths its build scripts wrote (WI-10004841), so a root that an
# older reaper already moved is reaped, never adopted.
__pc_reap_private_target_slots() {
  local shared="${1:?shared target root required}" adopt_name="${2:-}"
  __pc_adopted_private_root=""
  __pc_adopted_private_lock_fd=""
  [[ "${PAPERCUSP_DESKTOP_PRIVATE_SLOT_REAP:-1}" != "0" ]] || return 0
  command -v flock >/dev/null 2>&1 || return 0
  # Empty arrays under `set -u` and {fd} allocation need bash >= 4.4.
  (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )) || return 0
  local grace="${PAPERCUSP_DESKTOP_PRIVATE_SLOT_GRACE_SEC:-1800}"
  [[ "$grace" =~ ^[0-9]+$ ]] || grace=1800

  local reap_fd
  exec {reap_fd}>>"${__pc_slot_lockdir}/private-slots.lock" || return 0
  if ! flock -w 30 "$reap_fd"; then
    exec {reap_fd}>&-
    return 0
  fi

  local now dir name last lease_status reap_lease_tags
  local -a eligible=()
  now="$(date +%s)"
  while IFS=$'\t' read -r dir name; do
    [[ -n "$dir" ]] || continue
    __pc_private_slot_unclaimed "$name" || continue
    last="$(__pc_private_slot_last_active "$dir")"
    (( now - last >= grace )) || continue
    # 0 = leased, 2 = unreadable retention marker: both keep the root. ANY lease
    # keeps a private root (a reaper is no cut, so no own-cut exemption applies);
    # the tags are captured, not discarded to /dev/null, which the release-artifacts
    # selftest forbids for every caller in this file.
    lease_status=0
    reap_lease_tags="$(release_artifacts_retention_path_is_leased "$dir" 2>/dev/null)" || lease_status=$?
    (( lease_status == 1 )) || continue
    eligible+=("$last"$'\t'"$dir"$'\t'"$name")
  done < <(__pc_private_slot_candidates "$shared")

  local refs="" sorted=""
  if ((${#eligible[@]} > 0)); then
    if refs="$(printf '%s\n' "${eligible[@]}" | cut -f2 | __pc_private_slots_referenced)"; then
      # Newest first, so an adoption takes the warmest cache.
      sorted="$(printf '%s\n' "${eligible[@]}" | sort -rn)"
    fi
  fi

  local stamp target adopted=0 adopt_fd
  while IFS=$'\t' read -r last dir name; do
    [[ -n "$dir" ]] || continue
    if grep -qxF -- "$dir" <<< "$refs"; then continue; fi
    if [[ "${PAPERCUSP_DESKTOP_PRIVATE_SLOT_REAP_DRY_RUN:-0}" == "1" ]]; then
      echo "would reap: $dir (idle since $(date -u -d "@$last" +%FT%TZ 2>/dev/null || echo "$last"))"
      continue
    fi
    if [[ -n "$adopt_name" && "$adopted" == 0 ]]; then
      if ! __pc_private_slot_paths_anchored "$dir"; then
        echo "→ dead private target slot $dir was relocated (its build-script outputs point elsewhere) — reaping it instead of adopting (WI-10004841)" >&2
      else
        # A legacy root has no lock file yet; opening one for append creates it.
        adopt_fd=""
        if exec {adopt_fd}>>"${__pc_slot_lockdir}/${name}.lock" && flock -n "$adopt_fd"; then
          touch -- "$dir" || true
          PAPERCUSP_RELEASE_DELETER=claim-target-dir.sh release_artifacts_deletion_audit adopt "$dir" "" \
            "dead private target slot reused in place as a warm cache by $adopt_name" 2>/dev/null || true
          __pc_adopted_private_root="$dir"
          __pc_adopted_private_lock_fd="$adopt_fd"
          adopted=1
          continue
        fi
        # Its lock was taken since the eligibility check: it has a claimant now,
        # so neither adopt nor reap it.
        if [[ -n "$adopt_fd" ]]; then exec {adopt_fd}>&-; fi
        continue
      fi
    fi
    stamp="$(date +%s%N)"
    if [[ "${dir##*/}" == "$name" ]]; then
      target="${dir%/*}/.reaping-${name}-${stamp}"
    else
      target="${dir%/*}/.${shared##*/}-reaping-${name}-${stamp}"
    fi
    if mv -T -- "$dir" "$target" 2>/dev/null; then
      rm -f -- "${__pc_slot_lockdir}/${name}.lock"
      PAPERCUSP_RELEASE_DELETER=claim-target-dir.sh release_artifacts_deletion_audit reap "$dir" "" \
        "dead private target slot (no claimant, unreferenced, idle >= ${grace}s); renamed to $target for deletion" 2>/dev/null || true
      echo "→ reaped dead private target slot $dir" >&2
    fi
  done <<< "$sorted"

  flock -u "$reap_fd" || true
  exec {reap_fd}>&-
  __pc_private_slot_delete_renamed "$shared"
  return 0
}

__pc_claim_target_dir() {
  # An explicit CARGO_TARGET_DIR is a deliberate choice (a .deb cut on an
  # isolated dir, a test harness) — never second-guess it.
  if [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
    echo "→ target dir: honouring preset CARGO_TARGET_DIR=$CARGO_TARGET_DIR (no slot claimed)" >&2
    return 0
  fi

  local slots="${PAPERCUSP_DESKTOP_TARGET_SLOTS:-4}"
  if [[ "$slots" == "0" ]]; then
    echo "⚠ target-dir slots DISABLED (PAPERCUSP_DESKTOP_TARGET_SLOTS=0) — a second concurrent desktop build will corrupt the shared app-manifest (WI-7101)" >&2
    return 0
  fi

  # No flock(1) (macOS ships none) — we cannot claim atomically, so do not
  # pretend to. Leave the shared dir in place and say so, rather than handing
  # back a slot whose exclusivity we cannot actually guarantee.
  if ! command -v flock >/dev/null 2>&1; then
    echo "⚠ flock(1) unavailable — cannot claim a target-dir slot; concurrent desktop builds may corrupt the shared app-manifest (WI-7101)" >&2
    return 0
  fi

  local shared
  shared="$(__pc_cargo_target_root)" || return 1
  # Cargo metadata tells us the authoritative root, but does not promise that
  # it already exists.  Materialize that explicit configured path before slot
  # selection so a writable relocation parent remains usable and every derived
  # fallback has a real shared root to live below.  Preserve symlinks for the
  # guarded recovery path in the loop below.
  if [[ ! -e "$shared" && ! -L "$shared" ]]; then
    if ! mkdir -p -- "$shared" 2>/dev/null; then
      echo "ERROR: cannot materialize configured Cargo target root: $shared" >&2
      return 1
    fi
  elif [[ -e "$shared" && ! -d "$shared" ]]; then
    echo "ERROR: configured Cargo target root exists but is not a directory: $shared" >&2
    return 1
  fi
  mkdir -p "$__pc_slot_lockdir"

  local i j dir lockfile preferred_dir lease_tags
  local slot_count=0 own_slot_index_set=','
  local -a slot_order

  # A resumed cut's own lease identifies where its reusable artifacts live.
  # Prioritize those roots before ordinary free slots, or the first-free scan
  # can send a reuse leg to an empty cache even though its artifacts are leased
  # under a later slot (WI-10003548).
  for ((i = 0; i < slots; i++)); do
    if ((i == 0)); then dir="$shared"; else dir="${shared}-dev$((i + 1))"; fi
    if lease_tags="$(release_artifacts_retention_path_is_leased "$dir" 2>/dev/null)" \
      && release_artifacts_retention_matches_are_own_cut "$lease_tags"; then
      slot_order[$slot_count]="$i"
      slot_count=$((slot_count + 1))
      own_slot_index_set+="$i,"
    fi
  done
  for ((i = 0; i < slots; i++)); do
    case "$own_slot_index_set" in
      *,"$i",*) continue ;;
    esac
    slot_order[$slot_count]="$i"
    slot_count=$((slot_count + 1))
  done

  for ((j = 0; j < slot_count; j++)); do
    i="${slot_order[$j]}"
    # Slot 0 IS Cargo's configured shared dir. Keep its existing warm cache,
    # and derive every extra slot on the same configured filesystem.
    if ((i == 0)); then dir="$shared"; else dir="${shared}-dev$((i + 1))"; fi
    preferred_dir="$dir"
    lockfile="${__pc_slot_lockdir}/slot${i}.lock"

    # fd 8 deliberately: bin/cargo-build-safe.sh uses fd 9 for the sidecar lock,
    # and a launch path can end up holding both.
    exec 8>>"$lockfile" || continue
    if flock -n 8; then
      # A completed cut can outlive its launcher. Never reuse a target root that
      # ANOTHER cut's active retention lease covers; a later cleanup/build must not
      # erase the finalized artifact or its isolated Cargo cache.
      #
      # But a cut must never be refused its OWN lease. Leg 1 (linux) finishes and
      # takes a cut-scoped lease over this slot; leg 2 (mac) then carries the SAME
      # tag, so skipping on any match at all drove it to a private per-pid slot
      # where PAPERCUSP_REUSE_LINUX found no leg-1 artifacts and the leg died after
      # ~35min of redone work. The lease pre-registers the mac and windows paths, so
      # it was authored expecting those legs to run inside it (EI-23946118243608426).
      # Keep the tags the predicate reports instead of discarding them, and defer to
      # the shared own-cut rule, which fails closed on an unset/foreign/invalid tag.
      if lease_tags="$(release_artifacts_retention_path_is_leased "$dir" 2>/dev/null)" \
        && ! release_artifacts_retention_matches_are_own_cut "$lease_tags"; then
        echo "→ slot $i SKIPPED: target root $dir is covered by an active release-retention lease (${lease_tags//$'\n'/,})" >&2
        exec 8>&-
        continue
      fi
      # A slot name can outlive the storage it points at. This host deliberately
      # relocates the warm Cargo caches with symlinks; after the backing root was
      # removed, slot 1 remained a dangling ~/.cargo-target-dev2 symlink. `flock`
      # quite correctly claimed the OUT-OF-TREE lock, but Cargo then failed before
      # compilation with ENOTDIR while trying to create the target directory.
      # Restore only a missing referent whose immediate parent already exists:
      # this preserves the relocation link and makes the stable warm slot usable
      # again without deleting or replacing host state. If the parent is missing,
      # or the referent cannot be recreated, preserve the link and fail closed.
      if [[ -L "$dir" && ! -e "$dir" ]]; then
        if ! __pc_restore_missing_symlink_referent "$dir" "target slot"; then
          echo "→ slot $i SKIPPED: target root $dir is a broken symlink — preserving it and isolating the build" >&2
          exec 8>&-
          continue
        fi
      fi
      if [[ -e "$dir" && ! -d "$dir" ]]; then
        echo "→ slot $i SKIPPED: target root $dir exists but is not a directory — preserving it and isolating the build" >&2
        exec 8>&-
        continue
      fi
      if ((i > 0)); then
        dir="$(__pc_prepare_derived_target_root "$dir" "$shared" "dev$((i + 1))")" || {
          echo "→ slot $i SKIPPED: target root $preferred_dir cannot be prepared safely" >&2
          exec 8>&-
          continue
        }
        # Same own-cut rule as the preferred-root check above: refuse a FOREIGN
        # cut's lease, never this cut's own (EI-23946118243608426).
        if [[ "$dir" != "$preferred_dir" ]] \
          && lease_tags="$(release_artifacts_retention_path_is_leased "$dir" 2>/dev/null)" \
          && ! release_artifacts_retention_matches_are_own_cut "$lease_tags"; then
          echo "→ slot $i SKIPPED: fallback target root $dir is covered by an active release-retention lease (${lease_tags//$'\n'/,})" >&2
          exec 8>&-
          continue
        fi
      elif [[ -d "$dir" && ( ! -w "$dir" || ! -x "$dir" ) ]]; then
        echo "→ slot $i SKIPPED: configured shared target root is not writable: $dir" >&2
        exec 8>&-
        continue
      fi
      # The lock was free — but that only means no LAUNCHER is alive. Before building
      # into this dir, ask the question that actually decides safety: is a desktop still
      # RUNNING out of it? If so, skip the slot and isolate. Failing safe costs a cold
      # target dir; failing open costs a peer their window, which is the WI-7101
      # incident this whole file exists to prevent. Acting beats warning: the old
      # warning was printed at second ~1 of a ~19s build and scrolled past under cargo
      # output, so the damage was committed before anyone could read it.
      if __pc_desktop_running_in "$dir"; then
        echo "→ slot $i SKIPPED: a desktop is still running out of $dir but holds no slot lock (its launcher is gone) — isolating so we cannot corrupt its app-manifest (WI-7101)" >&2
        exec 8>&-
        continue
      fi
      export CARGO_TARGET_DIR="$dir"
      if ((i == 0)); then
        # Both halves of this claim are now CHECKED: the flock says no launcher holds
        # the slot, and the exe probe says nothing is running out of the dir. It used to
        # claim only the first half while an advisory two lines later contradicted it.
        echo "→ target dir: $dir (shared slot 0 — no launcher holds it, nothing running out of it)" >&2
      else
        echo "→ target dir: $dir (slot $i — another desktop instance holds the shared dir; isolating so we cannot corrupt its app-manifest, WI-7101)" >&2
        echo "  first build in this slot is a COLD build; later launches reuse its cache" >&2
      fi
      __pc_reap_private_target_slots "$shared" || true
      return 0
    fi
    # Someone else holds this slot. Drop our handle and try the next one.
    exec 8>&-
  done

  # Every slot busy. Fall back to a private per-pid dir: it is CORRECT, and
  # correctness is what this whole file is protecting. Never fall back to the
  # shared dir — that is precisely the corruption path.
  #
  # The private root is locked like a named slot (fd 8, inherited across exec), so
  # the reaper can tell exactly when its last user is gone. A recycled pid whose
  # earlier private lock is still held by an orphaned descendant gets a unique name.
  local private_name="pid$$"
  exec 8>>"${__pc_slot_lockdir}/${private_name}.lock"
  if ! flock -n 8; then
    exec 8>&-
    private_name="pid$$-$(date +%s)"
    exec 8>>"${__pc_slot_lockdir}/${private_name}.lock"
    flock -n 8 || true
  fi
  # Prefer a dead private root's warm cache over a cold build (WI-10004764).
  __pc_reap_private_target_slots "$shared" "$private_name" || true
  if [[ -n "${__pc_adopted_private_root:-}" ]]; then
    # Move the claim onto the adopted root's own lock: fd 8 is the descriptor the
    # launch inherits. Re-pointing it releases the per-pid lock, which guards no root.
    exec 8>&"$__pc_adopted_private_lock_fd"
    exec {__pc_adopted_private_lock_fd}>&-
    rm -f -- "${__pc_slot_lockdir}/${private_name}.lock"
    export CARGO_TARGET_DIR="$__pc_adopted_private_root"
    echo "⚠ all $slots target-dir slots are busy — reusing a dead private root's warm cache as $CARGO_TARGET_DIR." >&2
    echo "  Raise PAPERCUSP_DESKTOP_TARGET_SLOTS if this box routinely runs more desktops than that." >&2
    return 0
  fi
  local private_target="${shared}-${private_name}"
  private_target="$(__pc_prepare_derived_target_root "$private_target" "$shared" "$private_name")" || {
    echo "ERROR: all target-dir slots are busy and no private target root can be prepared safely" >&2
    return 1
  }
  export CARGO_TARGET_DIR="$private_target"
  echo "⚠ all $slots target-dir slots are busy — using private $CARGO_TARGET_DIR (cold build)." >&2
  echo "  Raise PAPERCUSP_DESKTOP_TARGET_SLOTS if this box routinely runs more desktops than that." >&2
  return 0
}

# PAPERCUSP_DESKTOP_REAP_ONLY=1 loads the helpers without claiming a slot
# (bin/reap-private-target-slots.sh).
if [[ "${PAPERCUSP_DESKTOP_REAP_ONLY:-0}" != "1" ]]; then
  __pc_claim_target_dir
fi
