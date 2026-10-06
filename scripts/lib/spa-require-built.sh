# shellcheck shell=bash
# scripts/lib/spa-require-built.sh — WI-10004972.
#
# Sourced by scripts/verify-tauri-headless.sh just before it freezes the shared
# SPA dist. It answers the one question the quiesce gate cannot: does this dist
# CONTAIN the source edits the caller is about to verify?
#
# Why quiescence is not enough. The shared dist is built by the oneshot
# papercup-vite-rebuild.timer -> ~/.local/bin/papercup-vite-rebuild.sh (an
# `npm run build`, NOT a `vite build --watch`), and one build was measured at
# 26 minutes. A dist that has stopped changing can still predate an edit by the
# whole build window. Freezing it silently produced a FAIL verdict on a correct
# fix (WI-10004955, run 20261001T180209Z-205316).
#
# The signal. After `npm run build` succeeds, that rebuild script touches
# dist/.vite-rebuild-source-stamp to the time the build STARTED reading source.
# A source file whose mtime is NEWER than the stamp was not read by the build
# that produced this dist.
#
# Opt-in by design. At any moment dozens of frontend sources are newer than the
# stamp because of fleet churn (32 measured at 18:21Z on 2026-10-01), so an
# always-on gate would refuse nearly every run. The caller names the paths it
# is verifying; everyone else gets one informational line (spa_require_built_note).

# The import surface papercup-vite-rebuild.sh watches. An edit outside these
# roots never triggers a rebuild on its own.
SRB_REBUILD_ROOTS=(apps/operator-vite/src apps/operator/app packages/operator-core/lib libs/generic)

_srb_log() {
  if declare -F log >/dev/null 2>&1; then log "$*"; else printf '[spa-require-built] %s\n' "$*" >&2; fi
}

_srb_mtime() { stat -c '%Y' "$1" 2>/dev/null; }

_srb_iso() {
  local s="$1"
  [ -n "$s" ] || { printf 'unknown'; return 0; }
  date -u -d "@$s" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '%s' "$s"
}

# spa_require_built_newer STAMP ABS_PATH
#   Prints the first file at or under ABS_PATH whose mtime is newer than STAMP,
#   or nothing when none is. A directory is scanned with the rebuild script's
#   own prunes (node_modules, dist, *.test.*, *.spec.*). Returns 2 when the
#   answer is UNKNOWN (stamp gone, find failed): callers must treat that as
#   "not proven built", never as "nothing newer".
spa_require_built_newer() {
  local stamp="$1" p="$2" out rc
  [ -f "$stamp" ] || return 2
  if [ -d "$p" ]; then
    out="$(find "$p" \( -path '*/node_modules/*' -o -path '*/dist/*' -o -name '*.test.*' -o -name '*.spec.*' \) -prune \
      -o -type f -newer "$stamp" -print -quit 2>/dev/null)"
    rc=$?
  else
    out="$(find "$p" -maxdepth 0 -newer "$stamp" -print 2>/dev/null)"
    rc=$?
  fi
  if [ -n "$out" ]; then printf '%s\n' "$out"; return 0; fi
  [ "$rc" -eq 0 ] || return 2
  return 0
}

# spa_require_built_gate DIST REPO_DIR SPEC
#   SPEC: repo-relative files or directories, separated by commas and/or spaces.
#   Returns 0 once DIST's build stamp is newer than every listed path, waiting up
#   to PAPERCUSP_SPA_REQUIRE_BUILT_WAIT_SEC (default 2400) and polling every
#   PAPERCUSP_SPA_REQUIRE_BUILT_POLL_SEC (default 15). Returns 1 on refusal,
#   after logging exactly one line that starts with SPA_STALE_VS_SOURCE.
spa_require_built_gate() {
  local dist="$1" repo="$2" spec="$3"
  local stamp="$dist/.vite-rebuild-source-stamp"
  local max_wait="${PAPERCUSP_SPA_REQUIRE_BUILT_WAIT_SEC:-2400}"
  local poll="${PAPERCUSP_SPA_REQUIRE_BUILT_POLL_SEC:-15}"
  local -a rels=() abs=() items=()
  local item rel r in_root
  # read -a, not an unquoted ${spec//,/ }: word-splitting that way also GLOBS.
  IFS=$', \t\n' read -r -d '' -a items <<<"$spec" || true
  for item in "${items[@]}"; do
    rel="${item#"$repo"/}"
    rel="${rel#./}"
    rel="${rel%/}"
    [ -n "$rel" ] || continue
    case "$rel" in
      /*)
        _srb_log "SPA_STALE_VS_SOURCE reason=path-not-in-repo path=$item — VERIFY_TAURI_REQUIRE_BUILT takes paths relative to $repo"
        return 1
        ;;
    esac
    if [ ! -e "$repo/$rel" ]; then
      _srb_log "SPA_STALE_VS_SOURCE reason=path-missing path=$rel — nothing at $repo/$rel; name the files your change edited"
      return 1
    fi
    case "${rel##*/}" in
      *.test.* | *.spec.*)
        _srb_log "WARNING: VERIFY_TAURI_REQUIRE_BUILT ignores $rel — test and spec files are never bundled into the SPA"
        continue
        ;;
    esac
    in_root=0
    for r in "${SRB_REBUILD_ROOTS[@]}"; do
      case "$rel/" in "$r"/*) in_root=1 ;; esac
    done
    [ "$in_root" -eq 1 ] || _srb_log "WARNING: $rel is outside the SPA rebuild roots (${SRB_REBUILD_ROOTS[*]}). papercup-vite-rebuild.sh does not rebuild when it changes, so this wait ends only if an in-root edit triggers a build."
    rels+=("$rel")
    abs+=("$repo/$rel")
  done
  if [ "${#rels[@]}" -eq 0 ]; then
    _srb_log "SPA_STALE_VS_SOURCE reason=no-paths spec='$spec' — VERIFY_TAURI_REQUIRE_BUILT named nothing that is bundled into the SPA"
    return 1
  fi
  if [ ! -f "$stamp" ]; then
    _srb_log "SPA_STALE_VS_SOURCE reason=stamp-missing stamp=$stamp — this dist was not produced by papercup-vite-rebuild.sh, so which sources it contains cannot be proven. Build the SPA yourself and point PAPERCUSP_SHARED_SPA_DIST at it, or unset VERIFY_TAURI_REQUIRE_BUILT."
    return 1
  fi

  local started now waited stale rc i last_report
  started=$(date +%s)
  last_report=$started
  while :; do
    stale=""
    for i in "${!abs[@]}"; do
      stale="$(spa_require_built_newer "$stamp" "${abs[$i]}")"
      rc=$?
      # UNKNOWN fails closed: report the path itself as not proven built.
      [ "$rc" -eq 0 ] || stale="${abs[$i]}"
      [ -n "$stale" ] && break
    done
    now=$(date +%s)
    waited=$((now - started))
    if [ -z "$stale" ]; then
      _srb_log "SPA_REQUIRE_BUILT ok: build stamp $(_srb_iso "$(_srb_mtime "$stamp")") is newer than all ${#rels[@]} required path(s) (waited ${waited}s)."
      return 0
    fi
    if [ "$waited" -ge "$max_wait" ]; then
      _srb_log "SPA_STALE_VS_SOURCE reason=timeout path=${stale#"$repo"/} source_mtime=$(_srb_iso "$(_srb_mtime "$stale")") stamp=$(_srb_iso "$(_srb_mtime "$stamp")") waited=${waited}s — the shared SPA dist does not contain this edit, so a verdict on it would be about OLD code. Refusing to freeze."
      return 1
    fi
    if [ $((now - last_report)) -ge 60 ]; then
      _srb_log "waiting for an SPA rebuild that includes ${stale#"$repo"/} (source $(_srb_iso "$(_srb_mtime "$stale")"), build stamp $(_srb_iso "$(_srb_mtime "$stamp")")); waited ${waited}s of ${max_wait}s"
      last_report=$now
    fi
    sleep "$poll"
  done
}

# spa_require_built_note DIST REPO_DIR
#   One informational line for every run: when the frozen bundle's build started,
#   and how many in-root frontend sources are newer than it (capped at 500).
#   Never fails the run. This is the hint the WI-10004955 FAIL verdict lacked.
spa_require_built_note() {
  local dist="$1" repo="$2"
  local stamp="$dist/.vite-rebuild-source-stamp" r n
  if [ ! -f "$stamp" ]; then
    _srb_log "SPA build stamp: none at $stamp — which source edits this bundle contains cannot be told."
    return 0
  fi
  local -a roots=()
  for r in "${SRB_REBUILD_ROOTS[@]}"; do
    [ -d "$repo/$r" ] && roots+=("$repo/$r")
  done
  n=0
  if [ "${#roots[@]}" -gt 0 ]; then
    n=$(find "${roots[@]}" \( -path '*/node_modules/*' -o -path '*/dist/*' -o -name '*.test.*' -o -name '*.spec.*' \) -prune \
      -o -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) -newer "$stamp" -print 2>/dev/null | head -n 500 | wc -l)
    n="${n//[[:space:]]/}"
  fi
  local more=""
  [ "$n" -ge 500 ] && more="+"
  _srb_log "SPA build stamp: $(_srb_iso "$(_srb_mtime "$stamp")") (when the bundle's build started). ${n}${more} frontend source file(s) are newer and NOT in this bundle. Verifying an edit? Set VERIFY_TAURI_REQUIRE_BUILT=<the paths you edited> to wait for a build that contains them (WI-10004972)."
  return 0
}
