#!/usr/bin/env bash
# federation-asserts.sh — the single shared orchestration/assert core for ALL
# two-instance federation proofs (D-003 of linux-test-vm-and-federation-2026-06-04).
#
# Consumed by three drivers:
#   • bin/two-instance-federation-smoke.sh  (local driver: boot + isolation + discovery)
#   • bin/two-instance-merge-smoke.sh       (local driver: + write-free bidirectional MERGE)
#   • bin/vm-federation.sh                  (vm driver: the same asserts over SSH into VMs)
#
# The lib never decides WHERE an instance runs. A driver defines three
# primitives, then calls the fed_* asserts:
#
#   drv_exec <inst>         run a bash script (stdin) in the instance's exec
#                           context (local driver: this host; vm driver: ssh)
#   drv_applog <inst>       app-log path AS SEEN INSIDE that exec context
#   drv_psql <inst> <sql>   run one `psql -tA -c` statement against the
#                           instance's embedded PG (from inside its machine)
#
# plus per-instance metadata in global assoc arrays (filled by fed_wait_boot):
#   FED_PG[inst]  FED_SC[inst]      — embedded-PG / sidecar (hono-host) ports
#
# Every network probe (curl to the sidecar, psql) deliberately goes THROUGH
# drv_exec / drv_psql: a packaged instance binds 127.0.0.1 and is reachable
# only from inside its own machine — the locality is the driver's business.
#
# Conventions: functions return non-zero on failure and print why; the DRIVER
# owns exit codes and overall pass/fail policy (behavior parity with the
# pre-refactor smokes).

declare -gA FED_PG FED_SC
declare -ga FED_KILL_PIDS
declare -ga FED_PORT_LOCK_FDS FED_PORT_LOCK_PATHS

fed_log() { printf '\n=== %s ===\n' "$*"; }

# fed_snapshot_shell_script <source> <immutable-copy>
#
# Bash re-reads a long-running script by byte offset while it executes.  A
# concurrent in-place edit can therefore make the running parser consume a
# mixture of old and new bytes even when both complete file versions are valid.
# Copy + syntax-check the exact bytes before launch so the process never reads
# the shared working-tree file again during the run (EI-21235839358679656).
fed_snapshot_shell_script() {
  local source_script="$1" snapshot_script="$2"
  [ -f "$source_script" ] || return 1
  mkdir -p "$(dirname "$snapshot_script")" || return 1
  cp -- "$source_script" "$snapshot_script" || return 1
  chmod +x "$snapshot_script" || return 1
  bash -n "$snapshot_script"
}

# fed_snapshot_sidecar_bundle <source> <destination> [lock] [lockdir] [wait-sec]
#
# Sidecar builds publish with a short exclusive lock and an atomic directory
# rename. A federation smoke must never execute the shared output directory:
# doing so lets a later publish replace the bytes (or lets the smoke's cleanup
# remove the release input) while the smoke is still serving two instances.
# Take a shared reader lock while making a per-run snapshot, then launch only
# from that snapshot. Same-device hardlinks keep the normal 6GB bundle cheap;
# the independent-copy fallback handles a cross-device snapshot (and a host
# whose cp lacks --reflink=auto).
#
# The lock is deliberately held by the copy operation, not by the long-lived
# smoke processes. With flock(1) this uses the same sidecar.lock protocol as
# build-desktop-sidecar.sh and tauri-guarded. macOS has no flock(1), so mirror
# the builder's PID-stamped mkdir lockdir fallback.
fed_snapshot_sidecar_bundle() {
  local source="${1:-}" destination="${2:-}"
  local source_real lock lockdir wait_sec
  local destination_parent holder deadline result

  [ -n "$source" ] && [ -d "$source" ] || {
    echo "fed_snapshot_sidecar_bundle: source sidecar is missing: ${source:-<empty>}" >&2
    return 1
  }
  [ -n "$destination" ] || {
    echo "fed_snapshot_sidecar_bundle: destination is required" >&2
    return 1
  }

  # Resolve symlinked source roots before deriving the lock path. Otherwise a
  # caller that names a symlink would lock /link.lock while the builder holds
  # /real/sidecar.lock, defeating the reader/writer protocol.
  source_real="$(cd "$source" 2>/dev/null && pwd -P)" || {
    echo "fed_snapshot_sidecar_bundle: could not resolve source sidecar: $source" >&2
    return 1
  }
  lock="${3:-$source_real.lock}"
  lockdir="${4:-$source_real.lockdir}"
  wait_sec="${5:-60}"
  [[ "$wait_sec" =~ ^[0-9]+$ ]] || {
    echo "fed_snapshot_sidecar_bundle: wait-sec must be a non-negative integer (got '$wait_sec')" >&2
    return 1
  }

  # A destination nested in the source would be copied into itself, and a
  # source/destination alias would make cleanup destructive. Refuse both
  # before touching either tree.
  case "$destination/" in
    "$source_real/"*|"$source_real/")
      echo "fed_snapshot_sidecar_bundle: destination must not be inside source ($destination)" >&2
      return 1
      ;;
  esac
  case "$source_real/" in
    "$destination/"*|"$destination/")
      echo "fed_snapshot_sidecar_bundle: source must not be inside destination ($source_real)" >&2
      return 1
      ;;
  esac

  destination_parent="$(dirname "$destination")"
  mkdir -p "$destination_parent" || return 1
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    echo "fed_snapshot_sidecar_bundle: destination already exists; refusing to remove a possible live snapshot: $destination" >&2
    return 1
  fi

  fed_copy_sidecar_snapshot() {
    if cp -al "$source_real" "$destination" 2>/dev/null; then
      echo "→ sidecar snapshot uses same-device hardlinks: $source_real → $destination" >&2
      return 0
    fi

    # cp -al may leave a partial destination after an EXDEV or filesystem
    # capability failure. Remove it before trying the independent copy.
    rm -rf "$destination" || return 1
    if cp -a --reflink=auto "$source_real" "$destination" 2>/dev/null; then
      echo "→ sidecar snapshot uses an independent copy: $source_real → $destination" >&2
      return 0
    fi

    rm -rf "$destination" || return 1
    cp -a "$source_real" "$destination" || return 1
    echo "→ sidecar snapshot uses a portable independent copy: $source_real → $destination" >&2
  }

  if command -v flock >/dev/null 2>&1; then
    (
      exec 8>>"$lock" || exit 1
      flock -s -w "$wait_sec" 8 || {
        echo "fed_snapshot_sidecar_bundle: timed out after ${wait_sec}s waiting for sidecar lock $lock" >&2
        exit 1
      }
      fed_copy_sidecar_snapshot
    )
    return $?
  fi

  # BSD/macOS fallback: the sidecar builder uses the same lockdir shape. An
  # empty/malformed holder is not evidence of a dead writer, so wait until the
  # bounded deadline instead of deleting an unknown lock.
  mkdir -p "$(dirname "$lockdir")" || return 1
  deadline=$(( $(date +%s) + wait_sec ))
  while ! mkdir "$lockdir" 2>/dev/null; do
    holder="$(cat "$lockdir/pid" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$lockdir"
      continue
    fi
    if (( $(date +%s) >= deadline )); then
      echo "fed_snapshot_sidecar_bundle: timed out after ${wait_sec}s waiting for sidecar lockdir $lockdir" >&2
      return 1
    fi
    sleep 1
  done
  printf '%s\n' "$$" >"$lockdir/pid" || {
    rm -rf "$lockdir"
    return 1
  }
  result=0
  fed_copy_sidecar_snapshot || result=$?
  rm -rf "$lockdir"
  return "$result"
}

# fed_capture_nonempty_with_retry <attempts> <delay-sec> -- <command...>
#
# Run a read-side probe until it returns a non-empty value, print that value,
# and otherwise fail after a bounded number of attempts.  Federation projections
# are asynchronous: an API mutation can commit its local view before a remote
# projection becomes queryable, so a one-shot relational read is not a valid
# convergence verdict (EI-21237890330979066).
fed_capture_nonempty_with_retry() {
  local attempts="$1" retry_delay="$2" attempt probe_out probe_rc
  shift 2
  [ "${1:-}" = -- ] && shift
  [ "$#" -gt 0 ] || return 1
  [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || attempts=40
  [[ "$retry_delay" =~ ^[0-9]+([.][0-9]+)?$ ]] || retry_delay=3

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    probe_out="$("$@")"
    probe_rc=$?
    if [ "$probe_rc" -eq 0 ] && [ -n "$probe_out" ]; then
      printf '%s\n' "$probe_out"
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ] && [ "$retry_delay" != 0 ]; then
      sleep "$retry_delay"
    fi
  done
  return 1
}

# fed_select_newest_deb_by_package <debian-package-name> <candidate>...
#
# Select by the writer-owned Debian Package field first, then by mtime.  GUI and
# Server bundles intentionally share a Papercusp*.deb filename family, so a
# filename-only newest-artifact choice can silently cross product roles.
fed_select_newest_deb_by_package() {
  local expected_package="$1" candidate candidate_package newest="" seen=0
  shift
  for candidate in "$@"; do
    [ -f "$candidate" ] || continue
    seen=$((seen + 1))
    candidate_package="$(dpkg-deb -f "$candidate" Package 2>/dev/null || true)"
    [ "$candidate_package" = "$expected_package" ] || continue
    if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then
      newest="$candidate"
    fi
  done
  if [ -z "$newest" ]; then
    printf 'FATAL: no Debian package with Package=%s among %s existing candidate(s)\n' \
      "$expected_package" "$seen" >&2
    return 1
  fi
  printf '%s\n' "$newest"
}

# _fed_github_user_with_retry <token> <json|login> [attempts] [delay-sec]
#
# Shared bounded GET /user primitive.  Callers that need the numeric id as well
# as the login consume the full JSON; identity-only callers use the login mode.
# Keeping both paths here prevents a nested smoke from accidentally reintroducing
# the one-shot read that red-pinned WI-40912 after the wrapper preflight recovered.
_fed_github_user_with_retry() {
  local token="$1" output_mode="$2" attempts="${3:-3}" retry_delay="${4:-10}"
  local attempt user_out gh_rc

  [ -n "$token" ] || return 1
  [[ "$output_mode" = json || "$output_mode" = login ]] || return 1
  [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || attempts=3
  [[ "$retry_delay" =~ ^[0-9]+([.][0-9]+)?$ ]] || retry_delay=10

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if [ "$output_mode" = login ]; then
      user_out="$(GH_TOKEN="$token" gh api user --jq .login 2>/dev/null)"
      gh_rc=$?
    else
      user_out="$(GH_TOKEN="$token" gh api user 2>/dev/null)"
      gh_rc=$?
    fi
    if [ "$gh_rc" -eq 0 ] && [ -n "$user_out" ]; then
      printf '%s\n' "$user_out"
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ] && [ "$retry_delay" != 0 ]; then
      sleep "$retry_delay"
    fi
  done
  return 1
}

# fed_github_user_json_with_retry <token> [attempts] [delay-sec]
fed_github_user_json_with_retry() {
  _fed_github_user_with_retry "$1" json "${2:-3}" "${3:-10}"
}

# fed_github_login_with_retry <token> [attempts] [delay-sec]
#
# Resolve the authenticated GitHub login with the same bounded retry posture as
# live-federation-gate's credentialed REST preflight.  GitHub can transiently
# fail one credentialed GET /user (edge/rate-limit class) while the token is
# otherwise valid; treating that single sample as a durable identity failure
# red-pins the whole federation gate before any product proof runs.
fed_github_login_with_retry() {
  _fed_github_user_with_retry "$1" login "${2:-3}" "${3:-10}"
}

# Extract the attestation gist id from a mixed stdout/stderr stream. The
# producer prints the id on its own line; npm may append notices afterward.
fed_extract_attestation_gist_id() {
  grep -E '^[[:space:]]*[0-9A-Fa-f]{32}[[:space:]]*$' | tail -1 | tr -d '[:space:]'
}

# fed_preflight_attestation_account <expected-user> <token> <repo-dir> <identity-dir>
#
# Prove the exact production device-attestation write + readback path before a
# federation rig launches.  A successful repo read or GET /user does not prove
# gist write capability, and relying on boot-time self-publish lets a quota wall
# produce an UNATTESTED announce after the expensive pair is already running.
# Both live smoke entrypoints share this helper and the same durable per-GitHub
# identity store so their admission posture cannot drift (EI-21239383769017696).
fed_preflight_attestation_account() {
  local expected_user="$1" token="$2" repo_dir="$3" identity_dir="$4"
  local user_json user_id login gist_id
  local identity_attempts="${ATTESTATION_IDENTITY_ATTEMPTS:-3}"
  local identity_retry_delay="${ATTESTATION_IDENTITY_RETRY_DELAY_SEC:-10}"

  user_json="$(fed_github_user_json_with_retry "$token" "$identity_attempts" "$identity_retry_delay")" || {
    echo "FATAL: GitHub identity preflight failed for '$expected_user' (GET /user after ${identity_attempts} attempts)"
    return 1
  }
  user_id="$(printf '%s' "$user_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id", ""))' 2>/dev/null)"
  login="$(printf '%s' "$user_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("login", ""))' 2>/dev/null)"
  [[ "$user_id" =~ ^[1-9][0-9]*$ ]] && [ -n "$login" ] || {
    echo "FATAL: GitHub identity preflight returned an invalid user for '$expected_user'"
    return 1
  }
  [[ "${login,,}" = "${expected_user,,}" ]] || {
    echo "FATAL: token requested for '$expected_user' authenticates as '$login'"
    return 1
  }

  gist_id="$(
    cd "$repo_dir" &&
      # Keep gh/npx and any encrypted-key fallback HOME-scoped to this account;
      # ambient HOME must never influence a cross-account preflight.
      HOME="$identity_dir" \
      PAPERCUSP_IDENTITY_DIR="$identity_dir" \
      PAPERCUSP_ATTEST_TOKEN="$token" \
      PAPERCUSP_ATTEST_USER_ID="$user_id" \
      PAPERCUSP_ATTEST_LOGIN="$login" \
      npx tsx -e '
        import { ensureAttestationGist, loadOrGenerateDeviceKeypair, verifyAttestation, probeGistWriteCapability } from "./packages/operator-core/lib/identity/attest.ts";
        import { resolveDeviceKeychainId } from "./packages/operator-core/lib/identity/device-keychain-id.ts";
        async function main() {
          const githubUserId = Number(process.env.PAPERCUSP_ATTEST_USER_ID);
          const githubLogin = process.env.PAPERCUSP_ATTEST_LOGIN!;
          const token = process.env.PAPERCUSP_ATTEST_TOKEN!;
          const cap = await probeGistWriteCapability(token);
          if (!cap.ok) {
            throw new Error(
              `${githubLogin} CANNOT create attestation gists (${cap.code}): ${cap.detail}` +
                (cap.remediation ? ` -- remediate: ${cap.remediation}` : ""),
            );
          }
          const keychainId = resolveDeviceKeychainId(githubUserId);
          const keypair = await loadOrGenerateDeviceKeypair(keychainId);
          const gistId = await ensureAttestationGist({
            keychainId,
            pubkeyBase64: keypair.pubkeyBase64,
            deviceLabel: `papercusp-${githubLogin}`,
            githubUserId,
            githubLogin,
            token,
          });
          const verified = await verifyAttestation(gistId, keypair.pubkeyBase64, githubUserId, {
            skipCache: true,
            token,
          });
          if (!verified.valid) throw new Error(`attestation ${gistId} failed verification: ${verified.reason}`);
          console.log(gistId);
        }
        main().catch((err) => { console.error(String(err)); process.exit(1); });
      ' 2>&1
  )" || {
    echo "FATAL: real device-attestation preflight failed for '$login': $gist_id"
    return 1
  }
  # npx may append an npm update notice to stderr after the script's stdout;
  # never assume the gist id is the final line.
  gist_id="$(printf '%s\n' "$gist_id" | fed_extract_attestation_gist_id)"
  [[ "$gist_id" =~ ^[0-9a-fA-F]{32}$ ]] || {
    echo "FATAL: attestation preflight for '$login' returned no valid gist id"
    return 1
  }
  echo "ATTESTATION: $login#$user_id ready (gist=$gist_id, identity_dir=$identity_dir)"
}

# preflight_github_rest_accounts [github-repo-url]
#
# Probe the exact authenticated REST read both federation smoke identities need
# before launching a DHT and two heavyweight sidecars. GitHub can leave
# /rate_limit and git-over-HTTPS healthy while credentialed repo reads return
# 403/5xx; without this guard a credential outage becomes a product-shaped
# discovery/join red after several minutes. Shared by live-federation-gate and
# direct two-instance-hive-from-repo-smoke invocations so the two entrypoints
# cannot drift on this classification again (WI-40905).
preflight_github_rest_accounts() {
  local repo_url="${1:-${HIVE_SMOKE_REPO_URL:-https://github.com/octocat/Hello-World}}"
  local repo_path api_url user token code attempt failed=0
  local attempts="${GITHUB_REST_PREFLIGHT_ATTEMPTS:-3}"
  local retry_delay="${GITHUB_REST_PREFLIGHT_RETRY_DELAY_SEC:-10}"

  case "$repo_url" in
    https://github.com/*) repo_path="${repo_url#https://github.com/}" ;;
    git@github.com:*) repo_path="${repo_url#git@github.com:}" ;;
    *)
      echo "GITHUB_REST: code=unsupported_repo_url url=$repo_url"
      return 1
      ;;
  esac
  repo_path="${repo_path%.git}"; repo_path="${repo_path%/}"
  api_url="https://api.github.com/repos/$repo_path"

  for user in "${P_A_USER:-papercupai}" "${P_B_USER:-ownerhandle}"; do
    token="$(gh auth token --user "$user" 2>/dev/null || true)"
    if [ -z "$token" ]; then
      echo "GITHUB_REST: user=$user code=token_missing detail=no-gh-token"
      failed=1
      continue
    fi

    code=000
    for attempt in $(seq 1 "$attempts"); do
      if ! code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
        -H "Authorization: Bearer $token" "$api_url" 2>/dev/null)"; then
        code=000
      fi
      [ "$code" = 200 ] && break
      [ "$attempt" -lt "$attempts" ] && [ "$retry_delay" != 0 ] && sleep "$retry_delay"
    done
    if [ "$code" = 200 ]; then
      echo "GITHUB_REST: user=$user code=ok http=200"
    else
      echo "GITHUB_REST: user=$user code=unhealthy http=$code attempts=$attempts"
      failed=1
    fi
  done
  return "$failed"
}

# scn_diag [prefix] — EI-18762718908280875: a scenario's diagnostic output only
# SURVIVES a PASSING matrix run if every line starts with the `·` marker
# (deb-hetzner-matrix.sh greps for it after a scenario returns 0 — see WI-6057).
# An unmarked line is silently dropped from the run's live/terminal output, and
# is indistinguishable from a probe that never executed at all — which is
# exactly backwards, since the PASS run is usually the one you need the detail
# from (e.g. confirming a fix actually took effect). Pipe any diagnostic dump
# through this instead of hand-writing `sed 's/^/  ·   .../'` at each call site,
# so the marker can never accidentally be typo'd/dropped/"tidied" away by a
# later edit: `drv_psql a "SELECT …" 2>&1 | scn_diag "a: "`. `prefix` (default
# empty) is inserted after the marker, before each line — pass a frame label
# ("a: " / "b: ") to keep multi-frame dumps disambiguated, same as the
# hand-written convention it replaces.
scn_diag() { awk -v p="${1:-}" '{ print "  ·   " p $0 }'; }

# fed_run_with_heartbeat <label> <heartbeat_interval_sec> -- <command...>
# Runs <command...> synchronously (stdout+stderr captured, echoed on completion —
# a `x="$(fed_run_with_heartbeat ...)"` caller works exactly like a bare
# `x="$(command...)"`) but prints a "still waiting" heartbeat line every
# <heartbeat_interval_sec> while it runs, so a long-but-not-hung step (a curl
# against a sidecar mid-churn, an SSH round-trip, …) is never indistinguishable
# from total silence. Motivated by a P-307 leader audit (2026-07-10): a FULL
# hive-git-drill.sh run hung >4min with zero output — the culprit was one of the
# genuinely-silent waits this lib does (fed_wait_boot/fed_wait_api, now
# heartbeat-instrumented directly; long curl calls like fed_hive_create_from_repo's
# -m 610 stay silent because the request itself is the whole body). NOT for
# fed_wait_boot/fed_wait_api themselves — those fill FED_PG/FED_SC globals and
# MUST run in the current shell (a background subshell here would lose the fill,
# same hazard as $(…) — see their own doc comments); this helper is for
# stdout-only commands (curl, etc.) that don't need that.
# Returns the wrapped command's real exit code (via `wait`).
fed_run_with_heartbeat() {
  local label="$1" interval="$2"; shift 2
  [ "${1:-}" = "--" ] && shift
  local outf; outf="$(mktemp)"
  ( "$@" >"$outf" 2>&1 ) & local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$interval"
    waited=$((waited + interval))
    kill -0 "$pid" 2>/dev/null && echo "  … still waiting on: $label (${waited}s elapsed)" >&2
  done
  wait "$pid"; local rc=$?
  cat "$outf"; rm -f "$outf"
  return $rc
}

# ── .deb extraction + integrity ─────────────────────────────────────────────

# fed_extract_deb <deb> <pkgdir> [expected-binary] — extract; assert the
# requested role binary exists. The GUI remains the default for existing
# federation callers; server-only drills must opt in to papercusp-server.
# Also detects + exports FED_APP_DIRNAME (the /usr/lib/<name> install dir): the
# 2026-07-01 two-role split renamed the GUI productName "Papercusp" → "Papercusp
# GUI", so the install root is no longer a constant. Every path consumer reads
# fed_sidecar_dir instead of hardcoding it.
fed_extract_deb() {
  local deb="$1" pkg="$2" expected_binary="${3:-papercusp-desktop}" appdir
  [ -f "$deb" ] || { echo "FATAL: .deb not found: $deb"; return 1; }
  case "$expected_binary" in
    papercusp-desktop|papercusp-server) ;;
    *) echo "FATAL: unsupported Papercusp role binary: $expected_binary"; return 1 ;;
  esac
  mkdir -p "$pkg"; dpkg-deb -x "$deb" "$pkg"
  [ -x "$pkg/usr/bin/$expected_binary" ] || { echo "FATAL: binary missing in .deb: $pkg/usr/bin/$expected_binary"; return 1; }
  appdir="$(find "$pkg/usr/lib" -maxdepth 2 -type d -name sidecar 2>/dev/null | head -1)"
  [ -n "$appdir" ] || { echo "FATAL: no */sidecar dir under $pkg/usr/lib in the .deb"; return 1; }
  FED_APP_DIRNAME="$(basename "$(dirname "$appdir")")"
  export FED_APP_DIRNAME
  echo "  install root: /usr/lib/$FED_APP_DIRNAME"
}

# fed_sidecar_dir [pkgdir] — the sidecar dir: under a pkg extraction when given,
# else the ON-TARGET absolute path. Falls back to the legacy 'Papercusp' name if
# fed_extract_deb has not run.
fed_sidecar_dir() {
  if [ -n "${1:-}" ]; then printf '%s/usr/lib/%s/sidecar' "$1" "${FED_APP_DIRNAME:-Papercusp}"
  else printf '/usr/lib/%s/sidecar' "${FED_APP_DIRNAME:-Papercusp}"; fi
}

# fed_clobber_check <pkgdir> — the build-clobber defect ships 0-byte sidecar
# files; a clobbered .deb cannot boot embedded-PG or the operator.
fed_clobber_check() {
  local pkg="$1" side clobbered=0 f sz
  side="$(fed_sidecar_dir "$1")"
  # SP1 C5 layout: serve.mjs is the boot entry (host.mjs retired); the
  # embedded-postgres-server package ships under sidecar/node_modules so
  # serve.mjs's externalized bare-specifier import resolves.
  for f in "$side/serve.mjs" \
           "$side/node_modules/@papercusp/embedded-postgres-server/src/index.js" \
           "$side/node_modules/@papercusp/embedded-postgres-server/node_modules/@embedded-postgres/linux-x64/native/bin/initdb" \
           "$side/node_modules/@papercusp/embedded-postgres-server/node_modules/@embedded-postgres/linux-x64/native/bin/postgres" \
           "$side/spa/index.html"; do
    sz=$(stat -c%s "$f" 2>/dev/null || echo MISSING)
    printf '  %10s  %s\n' "$sz" "$f"
    { [ "$sz" = "0" ] || [ "$sz" = "MISSING" ]; } && clobbered=1
  done
  if [ "$clobbered" = "1" ]; then
    echo
    echo "FATAL: this .deb is CORRUPT — 0-byte/missing sidecar files (the"
    echo "       build-desktop-sidecar.sh concurrent-build clobber). Rebuild with a"
    echo "       clean, non-concurrent build and re-run."
    return 1
  fi
}

# fed_assert_deb_swarm_support <pkgdir> — P-011 fail-fast: an older .deb
# silently ignores PAPERCUSP_DHT_BOOTSTRAP (public DHT → same-box/bridge
# discovery cannot work) and emits no [swarm] logs (failures invisible).
# The env-var name and log prefix are literal strings in the esbuild-bundled
# host.mjs, so a static grep is a reliable version gate.
fed_assert_deb_swarm_support() {
  local serve_mjs
  serve_mjs="$(fed_sidecar_dir "$1")/serve.mjs"
  grep -q 'PAPERCUSP_DHT_BOOTSTRAP' "$serve_mjs" 2>/dev/null \
    || { echo "FATAL: .deb too old — serve.mjs lacks PAPERCUSP_DHT_BOOTSTRAP support (swarm.ts, landed 2026-06-02). Rebuild from a current tree."; return 1; }
  grep -q '\[swarm\]' "$serve_mjs" 2>/dev/null \
    || { echo "FATAL: .deb too old — serve.mjs lacks the [swarm] boot diagnostics (boot.ts). Rebuild from a current tree."; return 1; }
  echo "✓ .deb honors PAPERCUSP_DHT_BOOTSTRAP + emits [swarm] logs (static check)"
}

# ── headless display (host-side) ────────────────────────────────────────────

# fed_ensure_display <num> <work> — reuse :num if up, else start Xvfb.
# Echoes 1 if we started it (caller kills it on cleanup), 0 if reused.
fed_ensure_display() {
  local num="$1" work="$2"
  if DISPLAY=":$num" xdpyinfo >/dev/null 2>&1; then echo 0; return 0; fi
  fed_log "starting Xvfb :$num (headless — never the user's :0)" >&2
  nohup Xvfb ":$num" -screen 0 1280x1024x24 >"$work/xvfb.log" 2>&1 &
  sleep 2; echo 1
}

# fed_fresh_display <num> <work> — refuse a busy display (never share a peer's
# Xvfb), start a dedicated one. Appends its pid to FED_KILL_PIDS.
fed_fresh_display() {
  local num="$1" work="$2"
  if DISPLAY=":$num" xdpyinfo >/dev/null 2>&1; then
    echo "FATAL: :$num busy — set PAPERCUSP_SMOKE_DISPLAY to a free one"; return 1
  fi
  fed_log "start Xvfb :$num" >&2
  Xvfb ":$num" -screen 0 1280x1024x24 >"$work/xvfb.log" 2>&1 & FED_KILL_PIDS+=("$!")
  sleep 2
}

# ── local testnet DHT (deterministic discovery without the public DHT) ──────

# fed_start_testnet_dht <operator_dir> <work> [advertise_host] [keep_up]
# Spins a hyperdht/testnet on the host — ALWAYS 3 nodes. A single-node testnet
# can NEVER work (WI-1910 root cause): dht-rpc sends announce commits only to
# closestReplies and bootstrap nodes never take commits, so a bootstrap-only DHT
# stores zero announces — joins print green, lookups return [], zero dials.
# Minimum viable testnet = bootstrap + ≥2 storage nodes (createTestnet(3)).
# With no advertise_host it binds 127.0.0.1 (same-box loopback discovery). With
# an advertise_host (a VM-bridge IP) all nodes bind 0.0.0.0 and the bootstrap
# is advertised on that host — the shape live-proven by
# papercup-isolated-dht.service (172.31.44.1, tower↔VM federation flowing).
# (The pre-WI-1910 claim that bridge secondaries advertise 127.0.0.1 doesn't
# match current testnet.js — bindHost is 0.0.0.0 whenever host≠127.0.0.1. If a
# bridge rig ever shows secondaries advertising an unreachable addr, fall back
# to the containerized 3-node shape in local-matrix.sh.)
# Echoes the bootstrap list (host:port,…); appends the node pid to FED_KILL_PIDS
# UNLESS keep_up=1 (WI-6192). --keep-up's whole purpose is a working rig left
# standing for follow-up work, but a caller's cleanup() still runs
# fed_cleanup_scoped($work) unconditionally, which kills every process whose
# argv carries $work — including this node's, since $work normally rides its
# argv as a cleanup marker (see below). Under keep_up=1 we tag the node with a
# DIFFERENT marker fed_cleanup_scoped's `grep -F "$work"` can never match, and
# skip the FED_KILL_PIDS append (belt-and-suspenders: today's callers all
# invoke this via `$(...)` command substitution, which already runs the whole
# function — including that append — in a throwaway subshell, but a future
# direct caller should still get the keep_up contract for free). We print the
# surviving pid + bootstrap so the caller can reap it manually or point a
# follow-up run at it via --dht-bootstrap=HOST:PORT.
fed_start_testnet_dht() {
  local operator_dir="$1" work="$2" host="${3:-}" keep_up="${4:-0}"
  fed_log "spin local testnet DHT (hyperdht/testnet, 3 nodes${host:+, advertised on $host}${keep_up:+$([ "$keep_up" = 1 ] && echo ", kept up past cleanup")})" >&2
  # $work rides argv as a cleanup marker: killing the launching subshell pid
  # orphans the node child, but fed_cleanup_scoped's `grep -F "$work"` over
  # ps args catches it (the pre-refactor smokes leaked these DHT nodes). Under
  # keep_up=1 we deliberately use a marker that does NOT contain $work as a
  # substring (grep -F is a substring match, so "$work-suffix" would still be
  # caught), so that same scan leaves this node alone.
  local marker="$work"
  [ "$keep_up" = 1 ] && marker="papercusp-persist-dht-$$"
  ( cd "$operator_dir" && PAPERCUSP_DHT_HOST="$host" node --input-type=module -e '
      import createTestnet from "hyperdht/testnet.js";
      const host = process.env.PAPERCUSP_DHT_HOST || undefined;
      // ALWAYS 3 nodes — a bootstrap-only testnet can never store an announce (WI-1910).
      const t = await createTestnet(3, host ? { host } : {});
      console.log("BOOTSTRAP=" + t.bootstrap.map(b => b.host + ":" + b.port).join(","));
      console.error("[testnet] nodes=" + t.nodes.length + " bootstrap=" + JSON.stringify(t.bootstrap));
      process.stdin.resume();
    ' "$marker" ) >"$work/dht.log" 2>&1 &
  local launch_pid=$!
  [ "$keep_up" = 1 ] || FED_KILL_PIDS+=("$launch_pid")
  local i bootstrap=""
  for i in $(seq 1 20); do
    bootstrap=$(grep -oE 'BOOTSTRAP=[^ ]+' "$work/dht.log" 2>/dev/null | head -1 | cut -d= -f2)
    [ -n "$bootstrap" ] && break; sleep 1
  done
  [ -n "$bootstrap" ] || { echo "FATAL: testnet DHT did not start"; cat "$work/dht.log"; return 1; }
  if [ "$keep_up" = 1 ]; then
    local dht_pid
    dht_pid="$(pgrep -f "$marker" 2>/dev/null | head -1)"
    fed_log "testnet DHT kept up: pid=${dht_pid:-unknown} bootstrap=$bootstrap — survives cleanup; reap manually (kill ${dht_pid:-<pid>}) or reuse with --dht-bootstrap=$bootstrap" >&2
  fi
  echo "$bootstrap"
}

# ── the LOCAL driver (an isolated packaged instance on THIS host) ───────────
# Both pre-refactor smokes launched instances the same way (isolated $HOME,
# shared gh config, bundled-node-first PATH, vglrun on a headless display);
# vm-federation.sh --vms=1 reuses it for the host-side instance.

# fed_local_launch <home> <logf> <bin> <display_num> [VAR=val ...]
fed_local_launch() {
  local home="$1" logf="$2" bin="$3" disp="$4"; shift 4
  mkdir -p "$home/.config"
  ln -sf "$HOME/.config/gh" "$home/.config/gh"          # share gh auth (announce identity)
  ln -sf "$HOME/.gitconfig" "$home/.gitconfig" 2>/dev/null || true
  ( cd "$(dirname "$bin")"
    # Ambient-env neutralization (2026-07-03 P-002): fleet shells carry
    # PAPERCUSP_DHT_HOST / PAPERCUSP_DHT_BOOTSTRAP for the tower↔VM rig; a
    # loopback smoke inheriting them swarm-binds/bootstraps on the bridge →
    # 0 peer dials. Trailing "$@" VAR=val args win for callers that want them.
    # Packaged federation smokes must also force background workers ON: fleet
    # shells can export PAPERCUSP_BACKGROUND_WORKERS=0 for request-only hosts,
    # which skips the hyperbee substrate and leaves content outboxes undrained.
    # WI-1666 env-inheritance leg (2026-07-03): agent shells also export
    # DATABASE_URL / *_DATABASE_URL pointing at the box's SHARED native :5432 —
    # an "isolated" instance inheriting one reads/writes the tower's PG (how a
    # fresh from-repo smoke saw a pre-existing hello-world-hive). UNSET them
    # (env -u, not VAR= — an empty DSN string breaks spawn-mcp downstream).
    # PAPERCUSP_HOME is scrubbed for the same reason the sidecar launcher scrubs
    # it (EI-15308, see fed_local_launch_sidecar's docblock): every su/dev shell
    # carries PAPERCUSP_HOME ambiently, and serve.ts's
    # PAPERCUSP_DIR = process.env.PAPERCUSP_HOME || homedir()+".papercusp" PREFERS
    # it over the isolated HOME="$home" below — so an unscrubbed GUI launch would
    # collapse the instance onto the caller's real shared operator home, the
    # identical isolation leak. Same env-inheritance class as the DATABASE_URL
    # family (an unlisted `env VAR=val cmd` var is inherited, never cleared).
    # EI-18729820545388373: a BOOT_TIMEOUT'd run's rescued log came back as a
    # single 315-byte dbind warning even after ~6 min across 3 boot attempts —
    # a diagnostic gap, not proof the app printed nothing. Redirecting to a
    # file makes glibc stdio fully block-buffer stdout/stderr, and a hard
    # `setsid`-group kill on timeout never gives the process a chance to
    # flush; whatever it *did* print is lost with it. `stdbuf -oL -eL` forces
    # line buffering on the wrapped command's own streams so a future failed
    # attempt actually yields a diagnosable log instead of an empty one.
    env -u DATABASE_URL -u PAPERCUSP_DATABASE_URL \
      -u HARNESS_DATABASE_URL -u HARNESS_ADMIN_DATABASE_URL \
      -u PAPERCUSP_HOME \
      DISPLAY=":$disp" HOME="$home" PATH="$(dirname "$(command -v node)"):$PATH" \
      PAPERCUSP_BACKGROUND_WORKERS=1 \
      PAPERCUSP_DHT_HOST= PAPERCUSP_DHT_BOOTSTRAP= "$@" \
      setsid nohup stdbuf -oL -eL vglrun -d egl0 "$bin" >"$logf" 2>&1 < /dev/null ) &
  FED_KILL_PIDS+=("$!")
}

# fed_local_launch_sidecar <home> <logf> <sidecar_dir> <hono_port> <pg_port> [VAR=val ...]
# The PACKAGED-SIDECAR launcher — the two-role split (2026-07-01) made
# usr/bin/papercusp-desktop a GUI-ONLY role that gtk-launches a separate
# "Papercusp Server" bundle; in an extracted-pkg smoke no Server app is
# installed, so the GUI boots NO sidecar and fed_wait_boot times out (found
# 2026-07-03, P-002 shared-hive-p2p-release-readiness: every GUI-launch smoke
# BOOT_TIMEOUTed on the fresh .deb). The federating unit is the sidecar
# (serve.mjs owns embedded-PG + migrations + the Hono host + the substrate) —
# launch IT directly from the extracted package, mirroring what the Server
# bundle spawns. Lifted from two-instance-hive-from-repo-smoke.sh's sc_launch.
# The trailing $FED_SMOKE_SCOPE argv (default $home, which lives under the
# smoke's $WORK) is the cleanup marker fed_cleanup_scoped greps ps args for.
fed_local_launch_sidecar() {
  local home="$1" logf="$2" side="$3" hono_port="$4" pg_port="$5"; shift 5
  # Recurrence guard (2026-07-03 P-002): an ARGLESS fed_pick_free_port returns
  # 18000 for every pre-bind call, so naive "$(fed_pick_free_port)" x4 hands the
  # SAME port to hono+pg and to A+B -> EADDRINUSE at boot. Ports must be
  # distinct + non-empty; pick with staggered starts per instance (see
  # two-instance-hive-from-repo-smoke.sh, WI-754 pattern).
  if [ -z "$hono_port" ] || [ -z "$pg_port" ] || [ "$hono_port" = "$pg_port" ]; then
    echo "fed_local_launch_sidecar: hono_port/pg_port must be DISTINCT non-empty (got hono='$hono_port' pg='$pg_port') — use staggered fed_pick_free_port starts (e.g. 18071/18532, B offset from A)" >&2
    return 1
  fi
  # EI-20241165263819645: never make a long-lived packaged service inherit a
  # GitHub credential. Besides /proc/<pid>/environ, a transient systemd launch
  # preserves Environment=/ExecStart metadata for the unit lifetime. Select a
  # distinct already-authenticated gh account with the NON-SECRET
  # PAPERCUSP_GITHUB_LOGIN instead; gh-token.ts resolves it via
  # `gh auth token --user <login>` inside the process and caches it in memory.
  local launch_arg
  for launch_arg in "$@"; do
    case "$launch_arg" in
      GH_TOKEN=*|GITHUB_TOKEN=*)
        echo "fed_local_launch_sidecar: refusing secret ${launch_arg%%=*} in a persistent sidecar environment; pass PAPERCUSP_GITHUB_LOGIN=<login>" >&2
        return 1
        ;;
    esac
  done
  # EI-18687938054040755: record the bundle this instance is about to RUN, keyed
  # by its log path (the one identifier every local caller already threads
  # through FED_LOG). drv_appbundle_local reverse-maps inst → log → bundle, so
  # every existing call site is wired with NO change at the call site and a new
  # caller cannot forget to register it. That "cannot forget" property is the
  # point: a local driver that silently resolves NO bundle degrades to
  # capability=unknown ⇒ don't-skip ⇒ strict fires ⇒ fail-closed on an old
  # build — the original disease wearing the fix as a costume.
  FED_BUNDLE_BY_LOG["$logf"]="$side/serve.mjs"
  local sc_node="$side/bin/node"; [ -x "$sc_node" ] || sc_node="$(command -v node)"
  mkdir -p "$home/.config" "$home/.papercusp"
  ln -sf "$HOME/.config/gh" "$home/.config/gh"
  ln -sf "$HOME/.gitconfig" "$home/.gitconfig" 2>/dev/null || true
  # PAPERCUSP_DHT_HOST and PAPERCUSP_DHT_BOOTSTRAP are force-EMPTIED (→
  # hyperswarm defaults): fleet desktop sessions carry ambient
  # PAPERCUSP_DHT_HOST=<bridge-ip> AND PAPERCUSP_DHT_BOOTSTRAP=<bridge-ip:port>
  # for the tower↔VM rig, and a loopback smoke inheriting either binds /
  # advertises / bootstraps the swarm on the bridge → peers never dial
  # (0 peer_connected fleet-wide, 2026-07-03; the BOOTSTRAP leg found by
  # su-b5d1c/su-c02fa on their fleet shells). A caller that WANTS either passes
  # PAPERCUSP_DHT_HOST=<ip> / PAPERCUSP_DHT_BOOTSTRAP=<ip:port> in the trailing
  # VAR=val args ("$@" below wins over the earlier assignment) — all committed
  # smokes already pass DHT_BOOTSTRAP explicitly when they spin a testnet.
  # PAPERCUSP_BACKGROUND_WORKERS is forced ON for the same reason: packaged
  # content smokes need the in-process hyperbee substrate, and request-only
  # ambient worker mode makes joins look green while outboxes never drain.
  # PAPERCUSP_HOME is scrubbed (2026-07-17, r8/WI-5129 finding): every su/dev
  # session on this box carries PAPERCUSP_HOME ambiently (its own per-workspace
  # operator home). serve.ts's PAPERCUSP_DIR = process.env.PAPERCUSP_HOME ||
  # homedir()+".papercusp" PREFERS PAPERCUSP_HOME over the isolated HOME="$home"
  # below, so an unscrubbed caller session silently collapses BOTH local
  # instances onto the CALLER's real, live, SHARED operator home — defeating
  # isolation entirely (each instance fights the live operator, and each
  # other, over the same operator.lock / operator-port.json / embedded-pg.json
  # — "another `serve` holds the cold-start lock; aborting" is the signature).
  # 100% reproducible from an su fleet session until this -u; confirmed fixed
  # via a standalone single-instance repro. Same leak class as the
  # DATABASE_URL family above (WI-1666) and PAPERCUSP_BACKGROUND_WORKERS
  # (EI-13590) — an unlisted `env VAR=val cmd` var is inherited, never cleared.
  # This launcher is a headless shell-owned sidecar, not a Tauri child. The
  # shell deliberately exits after setsid/nohup detaches serve.mjs; applying
  # the desktop parent-death watch here would interpret that expected
  # reparenting as an orphan and kill the witness during boot.
  ( cd "$side"
    env -u DATABASE_URL -u PAPERCUSP_DATABASE_URL \
        -u HARNESS_DATABASE_URL -u HARNESS_ADMIN_DATABASE_URL \
        -u PAPERCUSP_HOME -u GH_TOKEN -u GITHUB_TOKEN \
        HOME="$home" \
        PATH="$side/bin:$(dirname "$(command -v node)"):$PATH" \
        NODE_ENV=production PAPERCUSP_DESKTOP=1 \
        PAPERCUSP_PARENT_DEATH_WATCH=0 \
        PAPERCUSP_BIND_HOST=127.0.0.1 HOSTNAME=127.0.0.1 \
        PAPERCUSP_BACKGROUND_WORKERS=1 \
        PAPERCUSP_DHT_HOST= \
        PAPERCUSP_DHT_BOOTSTRAP= \
        PAPERCUSP_HONO_PORT="$hono_port" PAPERCUSP_PG_PORT="$pg_port" \
        PAPERCUSP_PG_DATA_DIR="$home/.papercusp/embedded-pg-data" \
        PAPERCUSP_PG_SQL_DIR="$side/db-sql" \
        PAPERCUSP_HARNESS_DIR="$side/harness" \
        PAPERCUSP_PROMPTS_DIR="$side/prompts" \
        PAPERCUSP_DOCS_ROOT="$side/internal-docs" \
        PAPERCUSP_SPA_DIST="$side/spa" \
        PAPERCUSP_SERVE_UI=0 \
        "$@" \
        setsid nohup "$sc_node" "$side/serve.mjs" "${FED_SMOKE_SCOPE:-$home}" >"$logf" 2>&1 < /dev/null ) &
  FED_KILL_PIDS+=("$!")
}

# Local-driver primitives. A script that only runs local instances can use
# these as-is: FED_LOG[inst]=<host log path>, FED_DB[inst]=<host DSN>.
declare -gA FED_LOG FED_DB
drv_exec_local()   { bash -s; }
drv_applog_local() { echo "${FED_LOG[$1]}"; }
drv_psql_local()   { psql "${FED_DB[$1]}" -tA -c "$2"; }

# drv_appbundle <inst> → absolute path, ON THAT INSTANCE'S MACHINE, of the
# serve.mjs it is running (empty = cannot resolve). Fourth vtable entry, added
# for EI-18687938054040755 so the data-path CAPABILITY probe is driver-agnostic
# like every other assert here instead of hardcoding the packaged .deb layout.
# The local driver reverse-maps inst → FED_LOG[inst] → the bundle recorded by
# fed_local_launch_sidecar; the SSH/rig drivers override it with their own path.
declare -A FED_BUNDLE_BY_LOG=()
drv_appbundle_local() {
  local lg="${FED_LOG[$1]:-}"
  [ -n "$lg" ] && echo "${FED_BUNDLE_BY_LOG[$lg]:-}" || echo ""
}

# Default vtable = local. vm-federation.sh / deb-hetzner-rig.sh override these.
drv_exec()      { drv_exec_local "$@"; }
drv_applog()    { drv_applog_local "$@"; }
drv_psql()      { drv_psql_local "$@"; }
drv_appbundle() { drv_appbundle_local "$@"; }

# ── boot / isolation ────────────────────────────────────────────────────────

# fed_wait_boot <inst> [tries] — poll the instance's app log for embedded-PG +
# sidecar readiness; fill FED_PG/FED_SC. Accepts both current and older boot
# markers (union of the two pre-refactor smokes' patterns).
# The sidecar grep MUST be anchored to the '[serve] listening' (or legacy
# 'hono-host] listening') prefix: the packaged app hosts OTHER http listeners
# (code-server logs a generic 'HTTP server listening on http://127.0.0.1:N/'
# well before the sidecar is up), and a bare 'listening on' grep races them —
# PG-ready lands first, the only 'listening' match is code-server, and every
# API call then hits the wrong port (405s; share/finalize "returns" empty).
# Seen live 2026-06-07: B sc grabbed code-server twice in a row while A won
# the race both times.
# MUST be called directly (NOT in a $(…) command substitution — the array
# fills would die in the subshell). On failure sets FED_BOOT_ERR and returns 1.
declare -g FED_BOOT_ERR=""
fed_wait_boot() {
  local inst="$1" tries="${2:-50}" i out pg sc logf slog
  logf="$(drv_applog "$inst")"
  # WI-6180: scan the sidecar's OWN log as well as the GUI stdout capture — the
  # packaged app's boot markers live in the former, so grepping only the latter
  # false-REDed every 2-VM run as BOOT_TIMEOUT against a healthy, fully-booted
  # app. Resolved through the driver vtable (empty for host-local instances, so
  # a local probe can never pick up the HOST operator's ports) and guarded with
  # command -v so drivers that predate drv_sidecar_log keep working unchanged.
  slog=""
  if command -v drv_sidecar_log >/dev/null 2>&1; then slog="$(drv_sidecar_log "$inst")"; fi
  for i in $(seq 1 "$tries"); do
    out="$(drv_exec "$inst" <<EOF
log="$logf"
slog="$slog"
logs="\$log"; [ -n "\$slog" ] && [ -f "\$slog" ] && logs="\$log \$slog"
pg=\$(grep -hoE 'ready on localhost:[0-9]+ db=papercusp' \$logs 2>/dev/null | grep -oE '[0-9]+' | tail -1)
[ -n "\$pg" ] || pg=\$(grep -hoE 'embedded-postgres-server ready on 127\.0\.0\.1:[0-9]+' \$logs 2>/dev/null | grep -oE '[0-9]+\$' | tail -1)
sc=\$(grep -hoE '\[serve\] listening on http://127\.0\.0\.1:[0-9]+' \$logs 2>/dev/null | grep -oE '[0-9]+\$' | tail -1)
[ -n "\$sc" ] || sc=\$(grep -hoE 'hono-host\] listening on http://127\.0\.0\.1:[0-9]+' \$logs 2>/dev/null | grep -oE '[0-9]+\$' | tail -1)
[ -n "\$sc" ] || sc=\$(grep -hoE '(operator|sidecar) ready on :[0-9]+' \$logs 2>/dev/null | grep -oE '[0-9]+' | tail -1)
if grep -qiE 'falling through to pglite|initdb may have failed|failed to spawn embedded-postgres-server|\[serve\] fatal' \$logs 2>/dev/null; then echo "PGFAIL"; exit 0; fi
[ -n "\$pg" ] && [ -n "\$sc" ] && echo "\$pg \$sc"
EOF
)"
    case "$out" in
      PGFAIL) FED_BOOT_ERR="EMBEDDED_PG_FAILED"; return 1 ;;
      "")     # HEARTBEAT (P-307 hardening, leader audit 2026-07-10): this loop is
              # silent by default — up to tries*3s (a caller passing tries=80 waits
              # up to 240s with zero output), which a live drill mistook for a total
              # hang. Print progress every 5 tries (~15s) so a slow-but-alive boot is
              # never indistinguishable from a wedged one.
              [ $((i % 5)) -eq 0 ] && echo "  … still waiting for $inst to boot ($((i * 3))s elapsed, try $i/$tries)" >&2
              sleep 3 ;;
      *)      pg=${out%% *}; sc=${out##* }
              FED_PG[$inst]="$pg"; FED_SC[$inst]="$sc"
              # Populate the per-instance DSN here (was only set by the directory
              # smoke's explicit lines) so drv_psql / fed_merge_assert work in
              # EVERY smoke + mode — incl. the from-repo smoke's sidecar mode,
              # where FED_DB was unbound and crashed the post-join merge probe.
              [ -n "${FED_DB[$inst]:-}" ] || FED_DB[$inst]="postgresql://harness_admin:harness_admin_pwd@localhost:${pg}/papercusp"
              return 0 ;;
    esac
  done
  # PORT SELF-DISCOVERY recovery (WI-754) — the loop timed out without BOTH log
  # markers. The PG marker is reliable (one PG listener, no competitor); the
  # SIDECAR marker is the fragile one (it can drift, or lose the log race to
  # code-server's own 'listening on' line). Before declaring BOOT_TIMEOUT, re-read
  # PG directly and, if it is up, OS-discover the sidecar port — so a pure
  # marker-drift on the '[serve] listening' line no longer false-REDs a healthy
  # boot. Called DIRECTLY (not in $(…)) so the FED_SC fill survives.
  local pg2
  # WI-6180: this recovery re-read PG from the SAME log as the main loop, so when
  # the whole log had moved (not merely the sidecar marker drifting) pg2 came back
  # empty and the recovery short-circuited before fed_discover_sidecar_os() was
  # ever consulted. Scan the same candidate list the loop uses.
  pg2="$(drv_exec "$inst" <<EOF
log="$logf"
slog="$slog"
logs="\$log"; [ -n "\$slog" ] && [ -f "\$slog" ] && logs="\$log \$slog"
pg=\$(grep -hoE 'ready on localhost:[0-9]+ db=papercusp' \$logs 2>/dev/null | grep -oE '[0-9]+' | tail -1)
[ -n "\$pg" ] || pg=\$(grep -hoE 'embedded-postgres-server ready on 127\.0\.0\.1:[0-9]+' \$logs 2>/dev/null | grep -oE '[0-9]+\$' | tail -1)
echo "\$pg"
EOF
)"
  if [ -n "$pg2" ] && fed_discover_sidecar_os "$inst"; then
    FED_PG[$inst]="$pg2"
    [ -n "${FED_DB[$inst]:-}" ] || FED_DB[$inst]="postgresql://harness_admin:harness_admin_pwd@localhost:${pg2}/papercusp"
    fed_log "fed_wait_boot: $inst recovered via OS port discovery — PG=$pg2 sidecar=${FED_SC[$inst]} (sidecar log marker missing/drifted)" >&2
    FED_BOOT_ERR=""; return 0
  fi
  FED_BOOT_ERR="BOOT_TIMEOUT"; return 1
}

# fed_assert_isolated <instA> <instB> — distinct PG + sidecar ports. (Trivially
# true across two VMs; the check matters for two instances on one machine.)
fed_assert_isolated() {
  local a="$1" b="$2"
  if [ "${FED_PG[$a]}" != "${FED_PG[$b]}" ] && [ "${FED_SC[$a]}" != "${FED_SC[$b]}" ]; then
    echo "✓ isolated (distinct PG + sidecar ports)"
  else
    echo "FATAL: port collision — instances not isolated"; return 1
  fi
}

# ── sidecar API readiness ────────────────────────────────────────────────────

# fed_wait_api <inst> [tries] — the boot log's "[serve] listening" line can
# precede the API actually accepting connections; poll the sidecar preflight until
# it answers 2xx (the sidecar's GET /api/desktop/preflight contract) so the share/
# register curls don't race a not-quite-ready sidecar. Returns 1 on timeout.
#
# PORT SELF-DISCOVERY hardening (WI-754): the configured FED_SC[inst] can be the
# WRONG listener — the packaged app runs OTHER http servers (code-server, pty-ws)
# and code-server's 'HTTP server listening on http://127.0.0.1:N/' can win
# fed_wait_boot's log-grep race. Those answer 404, not 2xx, so requiring 2xx
# distinguishes the real sidecar; and when the configured port never answers 2xx,
# we OS-discover the real one (scoped to THIS instance — never a concurrent
# sibling's, EI-1739) and adopt it. Must be called DIRECTLY (the FED_SC self-heal
# would die in a $(…) subshell).
fed_wait_api() {
  # EI-521/run25-26 flake fix: a fresh VM's sidecar needs embedded-PG init + ~400
  # migrations + (with the join-hive/rekey fix) the owner-bootstrap before preflight
  # answers 2xx — comfortably past the old 20×2s≈40s, so fed_wait_api timed out +
  # 'accepted liberally', and from-repo then fired against an un-ready API (empty
  # response = the run25/26 root cause). Wait up to 60×2s≈120s.
  local inst="$1" tries="${2:-60}" i code last="000"
  for i in $(seq 1 "$tries"); do
    code="$(drv_exec "$inst" <<EOF
curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${FED_SC[$inst]}/api/desktop/preflight" 2>/dev/null || echo 000
EOF
)"
    [ -n "$code" ] && last="$code"
    case "$code" in 2??) return 0 ;; esac   # the sidecar preflight contract = 2xx
    # HEARTBEAT (P-307 hardening, leader audit 2026-07-10): silent otherwise —
    # up to tries*2s (default 60*2s=120s) with zero output.
    [ $((i % 5)) -eq 0 ] && echo "  … still waiting for $inst's sidecar preflight (last code=$last, $((i * 2))s elapsed, try $i/$tries)" >&2
    sleep 2
  done
  # Self-heal: the configured port never answered the preflight with 2xx. Discover
  # the REAL sidecar port from the OS and adopt it (fed_discover_sidecar_os sets
  # FED_SC[inst] + confirms 2xx).
  if fed_discover_sidecar_os "$inst"; then
    fed_log "fed_wait_api: $inst sidecar self-discovered on :${FED_SC[$inst]} (configured port answered '$last', not 2xx) — recovered" >&2
    return 0
  fi
  if [ "$last" != "000" ]; then
    # Backward-compat safety net: the configured port answered (just not 2xx) and OS
    # discovery found nothing better — preserve the pre-hardening liberal acceptance
    # rather than regress a smoke that used to pass, but say so loudly.
    #
    # DIAGNOSTIC-GAP FIX (2026-07-20, live-fed-gate content-matrix RED triage): this
    # branch used to return WITHOUT ever calling fed_dump_instance_diag, so a run that
    # took this path left ZERO record of the instance's real listening ports / app-log
    # tail — and fed_cleanup_scoped's `rm -rf $WORK` on the smoke's later hard failure
    # (e.g. the subsequent "create failed" API call) destroys the only other copy.
    # Observed live: 3 consecutive gate attempts (2026-07-20 10:45-11:01 EDT) took
    # EXACTLY this branch (last never a bare "000" — some curl/heredoc interaction can
    # yield a non-'000' sentinel like '000000' even on a hard connection failure) and
    # left no diagnostics for what should have been the FAIL path. Always dump — this
    # is pure additional stderr logging, it does not change the return value/behavior.
    fed_log "fed_wait_api: $inst — :${FED_SC[$inst]} answered '$last' (not 2xx) and no other sidecar port resolved; accepting (legacy liberal) — downstream API calls may be unreliable; instance diagnostics follow:" >&2
    fed_dump_instance_diag "$inst" >&2
    return 0
  fi
  fed_log "fed_wait_api: $inst sidecar never answered on :${FED_SC[$inst]}; instance diagnostics follow:" >&2
  fed_dump_instance_diag "$inst" >&2
  return 1
}

# ── PORT SELF-DISCOVERY helpers (WI-754) ─────────────────────────────────────
# Resolve the sidecar port from the OS instead of trusting a (fragile) log line.
# Concurrency-safe: candidates are drawn ONLY from THIS instance's own footprint
# (the listening sockets of the process tree under its unique run dir, plus the
# 127.0.0.1 ports its OWN app-log mentions), so they can never name a concurrent
# sibling rig's sidecar (EI-1739). The discriminator is a 2xx on the sidecar-only
# GET /api/desktop/preflight — the packaged app's OTHER listeners (code-server,
# pty-ws) 404 that path. All probes go THROUGH drv_exec → driver-agnostic
# (local / ssh / vm).

# fed_pick_free_port <start> — echo the first free localhost TCP port >= <start>.
# The ASSIGN side of port self-discovery: hand an instance a known-free port via
# PAPERCUSP_HONO_PORT / PAPERCUSP_PG_PORT instead of hardcoding one that may
# collide. Single source for every rig (the from-repo smoke delegates here).
fed_pick_free_port() {
  local p="${1:-18000}"
  while ss -tlnH "sport = :$p" 2>/dev/null | grep -q .; do p=$((p + 1)); done
  echo "$p"
}

# fed_acquire_port_lock <port> [lock_dir] — hold an advisory lock for the
# lifetime of a launcher so two concurrent local launchers cannot both select
# the same port in the ss-probe → bind gap. The kernel releases the lock if a
# launcher dies, so stale lock files are harmless. Call fed_release_port_locks
# after the owned processes have stopped.
fed_acquire_port_lock() {
  local port="$1" dir="${2:-${TMPDIR:-/tmp}/papercusp-port-locks}" fd path
  command -v flock >/dev/null 2>&1 || {
    echo "fed_acquire_port_lock: flock is required for concurrent port safety" >&2
    return 1
  }
  mkdir -p "$dir" || {
    echo "fed_acquire_port_lock: cannot create lock directory $dir" >&2
    return 1
  }
  path="$dir/$port.lock"
  exec {fd}>"$path" || {
    echo "fed_acquire_port_lock: cannot open $path" >&2
    return 1
  }
  if ! flock -n "$fd"; then
    eval "exec ${fd}>&-"
    return 1
  fi
  FED_PORT_LOCK_FDS+=("$fd")
  FED_PORT_LOCK_PATHS+=("$path")
  return 0
}

fed_release_port_locks() {
  local fd
  for fd in "${FED_PORT_LOCK_FDS[@]:-}"; do
    eval "exec ${fd}>&-"
  done
  FED_PORT_LOCK_FDS=()
  FED_PORT_LOCK_PATHS=()
}

# fed_probe_sidecar <inst> <port> — true iff <port> answers the sidecar preflight 2xx.
fed_probe_sidecar() {
  local inst="$1" port="$2" code
  code="$(drv_exec "$inst" <<EOF
curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${port}/api/desktop/preflight" 2>/dev/null || echo 000
EOF
)"
  case "$code" in 2??) return 0 ;; *) return 1 ;; esac
}

# fed_discover_sidecar_os <inst> — find the REAL sidecar port from the OS; on
# success set FED_SC[inst] + return 0, else return 1. MUST be called DIRECTLY (not
# in $(…) — the FED_SC fill would die in the subshell).
fed_discover_sidecar_os() {
  local inst="$1" logf scope cands port
  logf="$(drv_applog "$inst")"
  scope="$(dirname "$logf")"   # the run's unique $WORK — a mktemp dir, never shared
  cands="$(drv_exec "$inst" <<EOF
scope="$scope"; log="$logf"
{
  # (a) listening TCP ports of the process tree scoped to this instance's run dir
  #     (the sidecar + embedded-PG carry a path under \$scope in their argv). ss
  #     shows pid only for our own sockets — exactly the instance we launched.
  if command -v ss >/dev/null 2>&1; then
    pids=""
    for d in /proc/[0-9]*; do
      [ -r "\$d/cmdline" ] || continue
      if tr '\0' ' ' < "\$d/cmdline" 2>/dev/null | grep -qF "\$scope"; then pids="\$pids \${d#/proc/}"; fi
    done
    for pid in \$pids; do
      ss -tlnpH 2>/dev/null | awk -v p="pid=\$pid," 'index(\$0,p){ n=split(\$4,a,":"); print a[n] }'
    done
  fi
  # (b) any 127.0.0.1:PORT this instance's OWN app-log mentions (unambiguously its own)
  grep -oE '127\.0\.0\.1:[0-9]+' "\$log" 2>/dev/null | grep -oE '[0-9]+\$'
} | awk 'NF' | awk '!seen[\$0]++'
EOF
)"
  for port in $cands; do
    case "$port" in ''|*[!0-9]*) continue ;; esac
    if fed_probe_sidecar "$inst" "$port"; then
      FED_SC[$inst]="$port"
      return 0
    fi
  done
  return 1
}

# fed_dump_instance_diag <inst> — the instance's listening TCP ports + app-log
# tail. The actionable diagnostic that replaces an opaque "API never came up".
fed_dump_instance_diag() {
  local inst="$1" logf; logf="$(drv_applog "$inst")"
  drv_exec "$inst" <<EOF
log="$logf"
echo "  [$inst] listening TCP ports:"
ss -tlnH 2>/dev/null | awk '{print "      "\$4}' | sort -u | head -20
echo "  [$inst] app-log tail (\$log):"
tail -15 "\$log" 2>/dev/null | sed 's/^/      /'
EOF
}

# ── share (swarm-topic join) — RETIRED per-harness path ──────────────────────
# fed_register_project + fed_share_finalize drive the PER-HARNESS sharing
# endpoints (/api/harness/projects + /api/harness/<slug>/share/finalize), RETIRED
# by comb-retire-per-harness-sharing-2026-06-11 when per-harness sharing became the
# HIVE model — share/finalize now 404s, so a rig that calls these sets up NO hive
# (substrate attempted=0 → no [swarm] → merges fail). Kept only for the legacy
# smokes that still reference them; NEW federation-setup uses the fed_hive_*
# helpers below (create-from-repo → discover → join-hive). See vm-federation.sh §9
# and two-instance-hive-from-repo-smoke.sh.

# ⛔ Runtime fail-fast (EI-680): the wires below 404 on every current build. A rig
# that drives them joins NO swarm topic and every later federation assert times
# out — masquerading as a federation regression. Die at the choke point instead
# of letting the 404 propagate as a bogus FAIL.
_fed_retired_share_die() {
  cat >&2 <<'EOF'
✗ RETIRED WIRE (fail-fast, EI-680): the per-harness share endpoints
  (/api/harness/projects + /api/harness/<slug>/share/finalize) were retired
  2026-06-11 (comb-retire-per-harness-sharing → the HIVE model) and 404 on
  current builds — driving them sets up NO hive/swarm topic, so every later
  federation assert times out looking like a federation regression.
  Use the CURRENT-flow helpers: fed_hive_create_from_repo → fed_hive_dir_row →
  fed_hive_join (see vm-federation.sh §9 / two-instance-hive-from-repo-smoke.sh).
  Delete this guard only if the per-harness wire is deliberately resurrected.
EOF
  exit 64
}

# fed_register_project <inst> <slug> <parent_dir> <folder>  [RETIRED — see above]
# Register a harness project (the share endpoint needs a registered harness).
fed_register_project() {
  _fed_retired_share_die
  local inst="$1" slug="$2" parent="$3" folder="$4"
  drv_exec "$inst" <<EOF >/dev/null
curl -s -m 60 -X POST "http://127.0.0.1:${FED_SC[$inst]}/api/harness/projects" \
  -H 'content-type: application/json' \
  -d '{"slug":"$slug","parentDir":"$parent","folderName":"$folder"}'
EOF
}

# fed_share_finalize <inst> <slug> <state_json> — POST share/finalize; echoes
# the interesting response fragments (bindingPublished / state).
fed_share_finalize() {
  _fed_retired_share_die
  local inst="$1" slug="$2" state_json="$3"
  drv_exec "$inst" <<EOF
curl -s -m 90 -X POST "http://127.0.0.1:${FED_SC[$inst]}/api/harness/$slug/share/finalize" \
  -H 'content-type: application/json' \
  -d '{"state":$state_json}' | head -c 400
EOF
}

# ── hive publish / join (the CURRENT federation-setup) ───────────────────────
# Replaces the retired register+share/finalize step. A creates a hive from a real
# PUBLIC GitHub repo (clone + blueprint + hive home + member + AUTO-PUBLISH on the
# directory topic — visibility is DERIVED from repo privacy, so a public repo
# announces publicly; the route ignores a client `visibility` field). B discovers
# A's announce over the wire and JOINS as a hive, which re-keys B onto the owner's
# Hive-pubkey topic so writes actually federate (EI-681). Every probe goes THROUGH
# drv_exec — a packaged instance binds 127.0.0.1, reachable only from inside its
# own machine.

# fed_json <json> <python-expr over `d`> — host-side JSON probe for a drv_exec
# curl response (the curl runs IN the instance; the parse runs on the driver host,
# which has python3). Prints the expression's value, or nothing on any error.
fed_json() {
  printf '%s' "$1" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
try: print($2)
except Exception: pass
" 2>/dev/null
}

# fed_hive_create_from_repo <inst> <repo_url> [extra_json_fields]
# POST /api/harness/pots/from-repo — clone + blueprint + hive home + member +
# auto-publish. runTests:false + shallow keep it light (route timeoutSec is 600).
# Echoes the raw JSON: { ok, created:{potSlug,memberSlug}, publish:{announced}, … } (potSlug was hiveSlug pre-rename).
#
# force:true (WI-6186): every fed run WIPEs the instance's ~/.papercusp before
# this call (§7), so A never has a local hive for this repo — but a PRIOR run
# against the same REPO_URL (default octocat/Hello-World) auto-published to
# the Cupboard central index, which is NOT wiped (it's an external, persistent
# service). So the paste-time lookup (lookup-hive-for-repo.ts leg 3) finds that
# stale global record and the route returns `{ok:true, existing:{...}}` instead
# of `{ok:true, created:{...}}` — every re-run against the same repo hard-fails.
# That `existing` hit carries only `potId` (a repo coordinate or a display
# title fallback — NOT the real local slug), `hivePubkey`, and `memberLinks`;
# none of it resolves to a usable LOCAL potSlug/memberSlug for A, because the
# instance that originally created that hive has itself long since been wiped.
# There is nothing to recover — the correct behavior is a fresh local
# hive+member every run, which is exactly what `force:true` does: it skips the
# existing-lookup short-circuit (_create_from_repo.ts: `if (!opts.force) return
# {ok:true, existing:found}`) and always clones + creates a brand-new pot/member
# with its own locally-unique slug, flagged `duplicateOf` for the supersede
# flow. The best-effort re-publish may then report a Cupboard uniqueness
# conflict in `publish.cupboard.errors` — harmless here; the P2P
# discover→join→merge legs below only need A's own local hive to exist.
fed_hive_create_from_repo() {
  local inst="$1" repo="$2" extra="${3:-}"
  drv_exec "$inst" <<EOF
curl -s -m 610 -X POST "http://127.0.0.1:${FED_SC[$inst]}/api/harness/pots/from-repo" \
  -H 'content-type: application/json' \
  -d '{"githubUrl":"$repo","visibility":"public","runTests":false,"shallow":true,"force":true$extra}'
EOF
}

# fed_hive_dir_row <inst> <potId> — GET /api/discovery/pots; echo the matching
# row's JSON (incl. memberLinks[]) or nothing if that pot isn't listed yet.
# (Route renamed hives→pots in the mig-557 lexicon sweep — the old
# /api/discovery/hives 404s {"error":"not_found"} on current builds, which
# red-failed the whole discovery leg of every smoke on 2026-07-16.)
fed_hive_dir_row() {
  local inst="$1" hive="$2" body
  body="$(drv_exec "$inst" <<EOF
curl -s -m 10 "http://127.0.0.1:${FED_SC[$inst]}/api/discovery/pots"
EOF
)"
  fed_json "$body" "json.dumps(next(r for r in d['rows'] if r['potId']=='$hive'))"
}

# fed_hive_join <inst> <hiveId> <memberLinks_json_array> — POST /api/discovery/join-pot.
# memberLinks must be a JSON array string (e.g. '["pear://…"]'). Echoes the raw
# JSON: { ok, members:[{ok,…}], … }.
fed_hive_join() {
  local inst="$1" hive="$2" links="$3"
  drv_exec "$inst" <<EOF
curl -s -m 610 -X POST "http://127.0.0.1:${FED_SC[$inst]}/api/discovery/join-pot" \
  -H 'content-type: application/json' \
  -d '{"potId":"$hive","memberLinks":$links}'
EOF
}

# ── discovery ───────────────────────────────────────────────────────────────

# fed_wait_discovery <instA> <instB> <mode> [tries]
#   strict — require [swarm] peer_data_path_up, the line that proves a BYTE
#            CROSSED. A [swarm] join FAILED line on either side fails
#            immediately. If the running artifact predates that emitter, echoes
#            "skip" (see the capability preflight below) — callers must treat
#            skip as N/A, not FAIL, when computing OVERALL.
#   loose  — legacy signalling-level markers. NEVER a discovery verdict: it
#            echoes WARN, never HIT, and fed_wait_discovery never returns 1 for
#            it. Kept only so an old caller can still surface a hint.
# Echoes 1 (data path proven) · 0 (not proven / join FAILED) · skip (N/A).
#
# EI-18687938054040755 — WHY THIS ASSERTS ON peer_data_path_up AND NOT
# peer_connected. The product deliberately reports a tri-state: boot.ts logs
# `peer_connected(signalling-only) (data path NOT yet demonstrated)` for a
# connection that has NOT carried a byte. The old strict leg grepped a bare
# `[swarm] peer_connected` with no word boundary, so it MATCHED that very line
# — "peers discovered" passed on connections that never moved data, and every
# federation green before 2026-07-26 is suspect because of it. Verified
# mechanically: printf that line | grep -qE '\[swarm\] peer_connected' MATCHES.
# The negative regression in federation-asserts.selftest.sh exists so that
# loosening this pattern later fails a test instead of silently restoring the
# false-PASS. DO NOT re-add a peer_connected fallback anywhere in this path.
fed_wait_discovery() {
  local a="$1" b="$2" mode="$3" tries="${4:-30}" i out capa capb
  # `loose` is not a verdict mode — it can only ever hint. Resolve it up front
  # so no amount of polling can turn a legacy marker into a discovery PASS.
  if [ "$mode" != "strict" ]; then
    out="$(_fed_disc_probe "$a" "$mode")$(_fed_disc_probe "$b" "$mode")"
    case "$out" in *WARN*) echo "⚠ loose discovery marker seen — NOT a data-path verdict" >&2 ;; esac
    echo 0; return 1
  fi
  # CAPABILITY PREFLIGHT (the EI-505 shape, generalized). An artifact packed
  # before the emitter landed cannot satisfy the assertion, so asserting on it
  # would fail CLOSED and read exactly like a genuine product failure. Probe
  # once per instance, before polling: the answer is static for the run.
  capa="$(_fed_disc_capability "$a")"; capb="$(_fed_disc_capability "$b")"
  if [ "$capa" = no ] || [ "$capb" = no ]; then
    echo "⊘ discovery N/A — this build predates the [swarm] peer_data_path_up emitter (a=$capa b=$capb, EI-18687938054040755)" >&2
    echo skip; return 0
  fi
  for i in $(seq 1 "$tries"); do
    out="$(_fed_disc_probe "$a" "$mode")$(_fed_disc_probe "$b" "$mode")"
    case "$out" in
      *FAILED*) echo "✗ swarm join FAILED — see [swarm] lines in the instance logs" >&2; echo 0; return 1 ;;
      *HIT*)    echo 1; return 0 ;;
    esac
    sleep 3
  done
  echo 0; return 1
}

# _fed_disc_capability <inst> → yes | no | unknown   (memoized per instance)
#
# Does the build this instance is RUNNING contain the peer_data_path_up
# emitter at all? Resolved from the serve.mjs the live process actually
# loaded (via /proc), so it is immune to install-path drift and to a
# hotpatch having swapped the bundle underneath us; falls back to the path
# the .deb installs.
#
# THE POSITIVE CONTROL IS LOAD-BEARING, DO NOT REMOVE IT. If the bundle read
# fails for any reason — missing path, unreadable as this user, a driver that
# cannot see the process — a naive probe reports "token absent", which means
# SKIP, which means every run silently goes N/A and the rig stops asserting
# anything at all. That is this bug's own disease in a new costume: green (or
# rather, unfalsifiable) by default. So a known-present token must be found in
# the SAME bundle before "absent" is allowed as a verdict. No control ⇒
# "unknown" ⇒ we do NOT skip, and the strict assertion runs normally.
declare -A FED_DISC_CAP=()
_fed_disc_capability() {
  local inst="$1" verdict hint script
  if [ -n "${FED_DISC_CAP[$inst]:-}" ]; then echo "${FED_DISC_CAP[$inst]}"; return 0; fi
  # Driver-supplied path first (drv_appbundle), then the running process's own
  # bundle via /proc, then the packaged .deb layout. Three independent
  # resolutions so no single driver quirk silently yields "unknown".
  hint="$(drv_appbundle "$inst" 2>/dev/null || true)"
  script="BUNDLE_HINT=$(printf '%q' "${hint:-}")
$(cat <<'CAPEOF'
bundle=""
# (1) driver-supplied path.
[ -n "$BUNDLE_HINT" ] && [ -r "$BUNDLE_HINT" ] && bundle="$BUNDLE_HINT"
# (2) the ABSOLUTE serve.mjs path out of a running process's own argv. This is
# the resolution that actually survives a container: /proc/<pid>/cwd reads back
# EMPTY on the docker frames local-matrix.sh builds (verified on 10.99.0.11 —
# both sidecar pids returned an empty cwd), while argv is readable. The greedy
# sed keeps paths containing SPACES intact, which matters: the installed
# directory is "/usr/lib/Papercusp GUI/sidecar".
if [ -z "$bundle" ]; then
  cand="$(pgrep -af 'serve\.mjs' 2>/dev/null | sed -n 's|.* \(/.*serve\.mjs\).*|\1|p' | head -1)"
  [ -n "$cand" ] && [ -r "$cand" ] && bundle="$cand"
fi
# (3) cwd of a running process (works where /proc is not restricted).
if [ -z "$bundle" ]; then
  for pid in $(pgrep -f 'serve\.mjs' 2>/dev/null); do
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" || continue
    [ -n "$cwd" ] && [ -r "$cwd/serve.mjs" ] && { bundle="$cwd/serve.mjs"; break; }
  done
fi
# (4) installed layout, GLOBBED — the product was renamed to "Papercusp GUI",
# so a hardcoded /usr/lib/Papercusp/sidecar path silently resolves nothing.
if [ -z "$bundle" ]; then
  for c in /usr/lib/Papercusp*/sidecar/serve.mjs; do
    [ -r "$c" ] && { bundle="$c"; break; }
  done
fi
[ -n "$bundle" ] || { echo unknown; exit 0; }
grep -qF 'peer_connected' "$bundle" 2>/dev/null || { echo unknown; exit 0; }
if grep -qF 'peer_data_path_up' "$bundle" 2>/dev/null; then echo yes; else echo no; fi
CAPEOF
)"
  verdict="$(drv_exec "$inst" <<<"$script")"
  case "$verdict" in yes|no) ;; *) verdict=unknown ;; esac
  FED_DISC_CAP[$inst]="$verdict"
  echo "$verdict"
}

_fed_disc_probe() {  # <inst> <mode> → HIT / FAILED / WARN / ""
  local inst="$1" mode="$2" logf; logf="$(drv_applog "$inst")"
  if [ "$mode" = "strict" ]; then
    # The trailing space is a safe anchor: swarm.ts emits
    # `[swarm] peer_data_path_up topic=<hex>…` and that ` topic=` is
    # unconditional — every later field is a conditional concatenation.
    drv_exec "$inst" <<EOF
if grep -qE '\[swarm\] join FAILED' "$logf" 2>/dev/null; then echo FAILED;
elif grep -qE '\[swarm\] peer_data_path_up ' "$logf" 2>/dev/null; then echo HIT; fi
EOF
  else
    drv_exec "$inst" <<EOF
grep -qiE 'peer_connected|peer connected|onAnnounce|admit' "$logf" 2>/dev/null && echo WARN || true
EOF
  fi
}

# ── the MERGE assert (the hard bidirectional gate) ──────────────────────────

# fed_diagnose_unmerged <src> <key> [dst]
# Explain WHY a merge probe did not land, instead of leaving a bare "0".
#
# WI-6209: a merge probe that reads 0 has TWO utterly different causes, and the
# bare 0 cannot tell them apart — which cost hours of misdirected transport
# debugging, twice. The probe INSERT can be MIS-TARGETED (written to a
# (workspace_id, harness_slug) tuple this frame has never booted), in which case
# it enqueues and NO binding ever drains it — indistinguishable, from the dst
# side, from a dead wire. The trap is easy to fall into because the two frames
# name the SAME pot differently: pots.public_key is identical across machines
# while (workspace_id, pot_home_slug) is LOCAL to each (fed-a
# workspace-319be5e5/spoon-knife-pot vs fed-b workspace-b31a7a01/octocat-spoon-knife).
# Resolve a workspace_id on one frame, write it on the other, and the row lands
# in a tuple that publishes nothing. It does not even error: the
# assert_work_item_pot_membership trigger FAILS OPEN when
# workspace_platform_pot() is NULL for an unknown workspace.
#
# harness_shared.substrate_outbox.drained_at is the mechanism-level
# discriminator (verified on the live rig — orphans drained=f, both genuinely
# federated probes drained=t). Diagnostics go to STDERR on purpose: every caller
# captures these functions' stdout in `$(...)` to read the 1/0.
fed_diagnose_unmerged() {
  local src="$1" key="$2" dst="${3:-}" rec ws slug drained quar drained_log_key drained_at dst_cursor
  # Emit EXPLICIT Y/N tokens rather than letting the booleans render themselves:
  # `boolean || text` casts via boolean::text, which yields 'true'/'false' — NOT
  # psql's 't'/'f'. A guard comparing against 't' therefore misclassifies every
  # row. Caught only by running this against the live rig; the fixture test had
  # encoded the same wrong assumption and passed happily (WI-6209).
  rec="$(drv_psql "$src" "SELECT coalesce(workspace_id,'?')||'|'||coalesce(harness_slug,'?')||'|'||CASE WHEN drained_at IS NOT NULL THEN 'Y' ELSE 'N' END||'|'||CASE WHEN quarantined_at IS NOT NULL THEN 'Y' ELSE 'N' END||'|'||coalesce(drained_log_key,'?')||'|'||coalesce(drained_at::text,'?') FROM harness_shared.substrate_outbox WHERE key='$key' ORDER BY id DESC LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$rec" ]; then
    echo "DIAG($src,$key): the write never reached substrate_outbox at all — the capture trigger did not enqueue it, so the INSERT targeted something not federated. TEST-TARGETING bug, not a replication failure." >&2
    return 0
  fi
  ws="${rec%%|*}"; rec="${rec#*|}"
  slug="${rec%%|*}"; rec="${rec#*|}"
  drained="${rec%%|*}"; rec="${rec#*|}"
  quar="${rec%%|*}"; rec="${rec#*|}"
  drained_log_key="${rec%%|*}"; drained_at="${rec#*|}"
  if [ "$quar" = "Y" ]; then
    echo "DIAG($src,$key): outbox row $ws/$slug is QUARANTINED — the substrate refused to publish it. Not a transport failure." >&2
  elif [ "$drained" != "Y" ]; then
    echo "DIAG($src,$key): outbox row $ws/$slug enqueued but NEVER DRAINED — no booted substrate binding on '$src' owns ($ws,$slug), so nothing will ever publish it. TEST-TARGETING bug, NOT a replication failure: a workspace_id/slug was almost certainly resolved on the OTHER frame. Pair frames by harness_shared.pots.public_key and resolve each frame's OWN (workspace_id,harness_slug). See WI-6209." >&2
  else
    dst_cursor=""
    if [ -n "$dst" ] && [ -n "$drained_log_key" ] && [ "$drained_log_key" != "?" ]; then
      dst_cursor="$(drv_psql "$dst" "SELECT workspace_id||'/'||harness_slug||' pos='||position::text||' apply='||coalesce(apply_binding,'<none>')||' lifecycle='||peer_lifecycle_state||' updated='||updated_at::text FROM harness_shared.substrate_merge_cursor WHERE log_keyhex='$drained_log_key' ORDER BY updated_at DESC LIMIT 4;" 2>/dev/null | paste -sd ';' -)"
      [ -n "$dst_cursor" ] || dst_cursor="ABSENT (destination never admitted or cursor-tracked this drained log)"
    else
      dst_cursor="unavailable (no destination or drained_log_key attribution)"
    fi
    echo "DIAG($src,$key): outbox row $ws/$slug DRAINED to log=$drained_log_key at=$drained_at but never arrived at $dst; destination cursor/lifecycle=$dst_cursor. This IS a genuine replication/transport failure, OR the arrival was simply slower than the poll window (WI-6209 observed a legitimate >90s arrival on a healthy link)." >&2
  fi
}

# _fed_outbox_drained <src> <key> → "Y" / "N" (bare token, no error text)
# Shared drained_at check used by both fed_merge_assert and fed_hive_merge_probe
# to decide whether a fast-path timeout deserves a second, extended window (see
# WI-6217 below) — kept as one helper so the two callers can't drift on the
# boolean-cast trap fed_diagnose_unmerged's own comment already warns about
# (`boolean || text` casts to 'true'/'false', not psql's 't'/'f' — this query
# emits an explicit Y/N token instead, same as fed_diagnose_unmerged does).
_fed_outbox_drained() {
  local src="$1" key="$2"
  drv_psql "$src" "SELECT CASE WHEN drained_at IS NOT NULL THEN 'Y' ELSE 'N' END FROM harness_shared.substrate_outbox WHERE key='$key' ORDER BY id DESC LIMIT 1;" 2>/dev/null | tr -d '[:space:]'
}

# fed_assert_hive_lifecycle_ready <src> <dst> <canary-fid> <target-harness> <pot-home>
#   [presence-recovery-polls] [presence-recovery-sleep-sec]
#
# Fail-closed admission for the folded re-key witness. HTTP readiness and even
# an earlier content PASS are not enough when the target substrate entered the
# boot-timeout zombie window: the real boot may be late-adopted while the
# presence member cache still rejects the peer, leaving authority one-way and a
# remote cursor that can stall at the later revoke boundary (WI-40905).
#
# Reuse the writers already present instead of inventing a parallel health
# surface:
#   * source outbox proves the same-stream canary actually drained and names its
#     source log;
#   * destination row + merge cursor prove that exact log was applied and is
#     explicitly active;
#   * instance logs prove the target harness never crossed a zombie/late-adopt
#     boundary, its presence topic is wired, any rejection streak recovered,
#     and the exact source log had no named merge-apply stall.
#
# This is deliberately stricter than product liveness. Late adoption remains a
# valid availability repair; it is simply not an admissible substrate for a
# security CUT witness. Diagnostics go to stderr so callers may use the return
# code without contaminating their result tokens.
fed_assert_hive_lifecycle_ready() {
  local src="$1" dst="$2" canary="$3" target_harness="$4" pot_home="$5"
  # The presence writer polls every 5s but unchanged state is emitted on a 30s
  # keep-alive cadence. Allow two refresh-widths by default: one accepted frame
  # is enough to prove that the receiver's membership cache recovered, while a
  # bounded miss still fails closed. The optional arguments are test seams only.
  local presence_recovery_polls="${6:-60}" presence_recovery_sleep_sec="${7:-1}"
  local source_rec log_key drained_ms destination_present cursor_rec cursor_pos cursor_state cursor_binding cursor_ms
  local inst logf qlog qtarget qpot qkey qpolls qsleep scan

  # substrate_outbox.drained_at is already BIGINT epoch-ms (the outbox drain
  # writes Date.now()). Do not apply extract(epoch FROM ...): PostgreSQL rejects
  # that timestamp-only function on BIGINT, and the intentionally quiet probe
  # would then collapse the SQL error into a misleading "no row" admission
  # failure even when the canary drained and materialized (WI-40905).
  source_rec="$(drv_psql "$src" "SELECT coalesce(drained_log_key,'')||'|'||coalesce(drained_at::text,'') FROM harness_shared.substrate_outbox WHERE key='$canary' ORDER BY id DESC LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  log_key="${source_rec%%|*}"; drained_ms="${source_rec#*|}"
  if [ -z "$source_rec" ] || [ "$log_key" = "$source_rec" ] || [ -z "$log_key" ] || [ -z "$drained_ms" ]; then
    echo "LIFECYCLE NOT READY: canary $canary has no attributable drained source-log row on $src (got '${source_rec:-<empty>}')" >&2
    return 1
  fi

  destination_present="$(drv_psql "$dst" "SELECT CASE WHEN count(*)>0 THEN 'Y' ELSE 'N' END FROM harness_shared.harness_features_consolidated WHERE feature_id='$canary' AND origin='remote';" 2>/dev/null | tr -d '[:space:]')"
  if [ "$destination_present" != "Y" ]; then
    echo "LIFECYCLE NOT READY: same-stream canary $canary drained to $log_key but is not materialized origin=remote on $dst" >&2
    return 1
  fi

  cursor_rec="$(drv_psql "$dst" "SELECT position::text||'|'||peer_lifecycle_state||'|'||coalesce(apply_binding,'<none>')||'|'||((extract(epoch FROM updated_at)*1000)::bigint)::text FROM harness_shared.substrate_merge_cursor WHERE log_keyhex='$log_key' ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  IFS='|' read -r cursor_pos cursor_state cursor_binding cursor_ms <<< "$cursor_rec"
  if [ -z "${cursor_pos:-}" ] || [ "$cursor_state" != "active" ] || ! [ "$cursor_pos" -gt 0 ] 2>/dev/null; then
    echo "LIFECYCLE NOT READY: destination cursor for canary log $log_key is not active+advanced (cursor='${cursor_rec:-ABSENT}')" >&2
    return 1
  fi

  for inst in "$src" "$dst"; do
    logf="$(drv_applog "$inst")"
    printf -v qlog '%q' "$logf"
    printf -v qtarget '%q' "$target_harness"
    printf -v qpot '%q' "$pot_home"
    printf -v qkey '%q' "$log_key"
    printf -v qpolls '%q' "$presence_recovery_polls"
    printf -v qsleep '%q' "$presence_recovery_sleep_sec"
    scan="$(drv_exec "$inst" <<EOF
log=$qlog; target=$qtarget; pot=$qpot; key=$qkey; recovery_polls=$qpolls; recovery_sleep=$qsleep
if grep -aqF "::\${target}) zombie window entered" "\$log" 2>/dev/null \
  || grep -aqF "::\${target}) late boot ADOPTED" "\$log" 2>/dev/null \
  || grep -aqF "::\${pot}) zombie window entered" "\$log" 2>/dev/null \
  || grep -aqF "::\${pot}) late boot ADOPTED" "\$log" 2>/dev/null; then
  echo "FAIL target substrate crossed boot-timeout/late-adopt lifecycle"
  exit 0
fi
if grep -aqF "STAGE STALL for \${key}:" "\$log" 2>/dev/null; then
  echo "FAIL exact canary source log recorded a named merge-apply stall"
  exit 0
fi
topic="\$(grep -aF '[wire-presence] wired ' "\$log" 2>/dev/null | grep -F "pot=\$pot" | tail -1 | sed -n 's/.*topic=\([0-9a-f]*\).*/\1/p')"
if [ -z "\$topic" ]; then
  echo "FAIL target presence topic was never wired"
  exit 0
fi
prefix="\${topic:0:12}"
reject_line="\$(grep -anF "REJECTED inbound presence frame on topic \$prefix" "\$log" 2>/dev/null | tail -1 | cut -d: -f1)"
admit_line="\$(grep -anF "inbound presence ADMITTED again on topic \$prefix" "\$log" 2>/dev/null | tail -1 | cut -d: -f1)"
if [ -n "\$reject_line" ] && { [ -z "\$admit_line" ] || [ "\$admit_line" -le "\$reject_line" ]; }; then
  attempt=0
  while [ "\$attempt" -lt "\$recovery_polls" ]; do
    sleep "\$recovery_sleep"
    attempt=\$((attempt + 1))
    # Re-read BOTH edges on every poll. A later rejection must supersede an
    # earlier recovery; announce/device admission alone is not authoritative.
    reject_line="\$(grep -anF "REJECTED inbound presence frame on topic \$prefix" "\$log" 2>/dev/null | tail -1 | cut -d: -f1)"
    admit_line="\$(grep -anF "inbound presence ADMITTED again on topic \$prefix" "\$log" 2>/dev/null | tail -1 | cut -d: -f1)"
    if [ -z "\$reject_line" ] || { [ -n "\$admit_line" ] && [ "\$admit_line" -gt "\$reject_line" ]; }; then
      break
    fi
  done
  if [ -n "\$reject_line" ] && { [ -z "\$admit_line" ] || [ "\$admit_line" -le "\$reject_line" ]; }; then
    echo "FAIL target presence rejection streak is unresolved after \${recovery_polls} bounded poll(s) (topic=\$prefix reject=\$reject_line admit=\${admit_line:-none})"
    exit 0
  fi
fi
# A lifecycle fault may appear while the bounded presence recovery wait is in
# flight. Re-check the fail-closed predicates before returning READY so a later
# accepted heartbeat cannot mask a newly-recorded zombie or exact-log stall.
if grep -aqF "::\${target}) zombie window entered" "\$log" 2>/dev/null \
  || grep -aqF "::\${target}) late boot ADOPTED" "\$log" 2>/dev/null \
  || grep -aqF "::\${pot}) zombie window entered" "\$log" 2>/dev/null \
  || grep -aqF "::\${pot}) late boot ADOPTED" "\$log" 2>/dev/null; then
  echo "FAIL target substrate crossed boot-timeout/late-adopt lifecycle"
  exit 0
fi
if grep -aqF "STAGE STALL for \${key}:" "\$log" 2>/dev/null; then
  echo "FAIL exact canary source log recorded a named merge-apply stall"
  exit 0
fi
# Take the presence-edge snapshot last. A rejection that landed after the poll
# recovered must supersede the earlier admission; this is the closest possible
# append-only-log boundary to the READY verdict.
reject_line="\$(grep -anF "REJECTED inbound presence frame on topic \$prefix" "\$log" 2>/dev/null | tail -1 | cut -d: -f1)"
admit_line="\$(grep -anF "inbound presence ADMITTED again on topic \$prefix" "\$log" 2>/dev/null | tail -1 | cut -d: -f1)"
if [ -n "\$reject_line" ] && { [ -z "\$admit_line" ] || [ "\$admit_line" -le "\$reject_line" ]; }; then
  echo "FAIL target presence rejection streak became unresolved at final admission read (topic=\$prefix reject=\$reject_line admit=\${admit_line:-none})"
  exit 0
fi
echo "READY topic=\$prefix"
EOF
)"
    case "$scan" in
      READY*) ;;
      *)
        echo "LIFECYCLE NOT READY: $inst ${scan:-could not inspect target lifecycle log}" >&2
        return 1
        ;;
    esac
  done

  echo "LIFECYCLE READY: canary=$canary log=$log_key drained_ms=$drained_ms dst_cursor_pos=$cursor_pos lifecycle=$cursor_state apply=$cursor_binding cursor_updated_ms=$cursor_ms" >&2
  return 0
}

# fed_merge_assert <src> <dst> <slug> <feature_id> <title> <status> [tries]
# INSERT origin='local' on src; poll dst for the row with origin='remote'.
# Echoes 1 (merged) or 0. On failure, prints a fed_diagnose_unmerged line to
# stderr naming which of the two failure classes this was (WI-6209).
#
# WI-6217: the fast-path window (tries*3s, default 90s) can expire on a
# perfectly HEALTHY link — one observed delivery took >90s while a sibling
# probe on the same rig moments earlier landed in 6s (~15x spread), and the
# 0 this produced was misread as a dead wire, costing a multi-hour
# misdiagnosis on WI-6209. Once the fast-path window expires, check
# src's substrate_outbox.drained_at: if the write has genuinely DRAINED (left
# this frame), it is neither a dead wire nor a mis-targeted write (the other
# two classes fed_diagnose_unmerged distinguishes) — it is CONFIRMED in
# flight, so give it one further, equally-sized window before giving up. A
# write that never drains (a mis-targeted probe, WI-6209's other class) is
# NOT retried — it fails at the original `tries`, same as before, since
# waiting longer can never make an undrained row arrive.
fed_merge_assert() {
  local src="$1" dst="$2" slug="$3" fid="$4" title="$5" status="$6" tries="${7:-30}" i row ts
  ts="$(date +%s)000"
  drv_psql "$src" "INSERT INTO harness_shared.harness_features_consolidated (harness_slug,feature_id,title,summary,status,attempts,origin,ts,created_ts,updated_ts) VALUES ('$slug','$fid','$title','merge proof','$status',0,'local',$ts,$ts,$ts);" >/dev/null
  for i in $(seq 1 "$tries"); do
    row="$(drv_psql "$dst" "SELECT origin FROM harness_shared.harness_features_consolidated WHERE harness_slug='$slug' AND feature_id='$fid';" 2>/dev/null | tr -d '[:space:]')"
    [ "$row" = "remote" ] && { echo 1; return 0; }
    sleep 3
  done
  if [ "$(_fed_outbox_drained "$src" "$fid")" = "Y" ]; then
    for i in $(seq 1 "$tries"); do
      row="$(drv_psql "$dst" "SELECT origin FROM harness_shared.harness_features_consolidated WHERE harness_slug='$slug' AND feature_id='$fid';" 2>/dev/null | tr -d '[:space:]')"
      [ "$row" = "remote" ] && { echo 1; return 0; }
      sleep 3
    done
  fi
  fed_diagnose_unmerged "$src" "$fid" "$dst"
  echo 0; return 1
}

# fed_plan_part_merge_assert <src> <dst> <slug> [tries]
# Per-PART plan federation (plan-federation-regrain-2026-06-13 P-008 / D-004): the
# NEW `plan-parts` tableTag (mig 270/271 + projections/harness-plan-parts.ts) must
# federate cross-machine over the real holepunch wire, just like features do. This
# is the direct analog of fed_merge_assert: INSERT a part origin='local' on src
# (the mig-271 capture trigger enqueues it) and poll dst for the same part arriving
# origin='remote' (dst's harness-plan-parts projection applied it). A plain-ASCII
# body keeps the SQL shell-safe (no markdown/backtick quoting hazards). The recompose
# into harness_plans.content + the merge/no-clobber semantics are proven single-box
# on real PG (plan-part-federation-cutover.integration.test.ts, 7/7); THIS proves
# the remaining rung — the table federates across two genuinely-separate machines.
# Echoes 1 (merged), 0 (failed — table present, merge didn't land), or "skip" (the
# harness_plan_parts table is absent on src and/or dst — a shipped .deb built before
# mig 270/271 landed predates the plan-parts lane entirely, EI-505). Callers must
# treat "skip" as N/A, not FAIL, when computing OVERALL.
fed_plan_part_merge_assert() {
  local src="$1" dst="$2" slug="$3" tries="${4:-30}" i row ts ws="" has_src has_dst
  ts="$(date +%s)000"
  # EI-505 gate: probe BOTH frames for the table before touching it. A shipped .deb
  # predating the plan-parts migration has neither the table nor the capture trigger,
  # so the INSERT below would hard-fail with "relation does not exist" and this leg
  # would spuriously read as FAILED even though everything else (discovery, feature
  # merge, coord merge) genuinely passed. SKIP instead — it's not applicable.
  has_src="$(drv_psql "$src" "SELECT to_regclass('harness_shared.harness_plan_parts') IS NOT NULL;" 2>/dev/null | tr -d '[:space:]')"
  has_dst="$(drv_psql "$dst" "SELECT to_regclass('harness_shared.harness_plan_parts') IS NOT NULL;" 2>/dev/null | tr -d '[:space:]')"
  if [ "$has_src" != "t" ] || [ "$has_dst" != "t" ]; then
    echo skip; return 0
  fi
  # D-050 / WI-5399 iteration 2: workspace_id = the operator's REAL workspace (the
  # harness drains WHERE workspace_id=its boot workspace). This function was MISSED
  # by the iteration-2 sweep that fixed its siblings (fed_hive_merge_probe,
  # fed_coord_merge_probe, rig_resolve_ws) and kept two lottery rungs:
  #   (a) an UNORDERED `harness_features_consolidated WHERE harness_slug=... LIMIT 1`
  #       — once content federates IN, that table holds foreign-workspace rows too,
  #       so the unordered LIMIT 1 is exactly the WI-5399 coin-flip, and
  #   (b) a COALESCE onto (a) instead of failing loudly.
  # Either one stamps the part INSERT with a workspace_id no drain scope selects:
  # the row then sits drained_at=NULL forever, dst polls 0 rows, and this leg reads
  # RED with no error anywhere — the WI-5399 signature. Every rung below is
  # deterministic, and exhausting them FAILS LOUD rather than guessing.
  if [ -n "${RIG_HIVE_ID:-}" ]; then
    ws="$(drv_psql "$src" "SELECT workspace_id FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  fi
  # Non-rig callers (no RIG_HIVE_ID) write from the OWNER frame, where the frame's
  # own membership row IS origin='local'; ORDER BY makes it deterministic.
  [ -n "$ws" ] || ws="$(drv_psql "$src" "SELECT workspace_id FROM harness_shared.pot_members WHERE coalesce(origin,'local')='local' ORDER BY joined_at LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  # Last resort: the frame's OWN feature row (origin='local' — never a federated-in
  # foreign card), so the part INSERT still matches the capture trigger + RLS binding.
  [ -n "$ws" ] || ws="$(drv_psql "$src" "SELECT workspace_id FROM harness_shared.harness_features_consolidated WHERE harness_slug='$slug' AND coalesce(origin,'local')='local' ORDER BY ts LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$ws" ]; then
    echo "FATAL fed_plan_part_merge_assert($src,$dst,$slug): could not resolve a real workspace_id — refusing to silently write under a workspace the harness never drains (D-050/WI-5399 class)" >&2
    echo 0; return 1
  fi
  drv_psql "$src" "INSERT INTO harness_shared.harness_plan_parts (workspace_id,harness_slug,plan_slug,part_key,kind,body,ordinal,fed_ts,author,tombstone,origin) VALUES ('$ws','$slug','ppfed-$src','item:P-001','item','xmerge-proof-from-$src',1,$ts,'$src',false,'local');" >/dev/null
  for i in $(seq 1 "$tries"); do
    row="$(drv_psql "$dst" "SELECT origin||'|'||body FROM harness_shared.harness_plan_parts WHERE plan_slug='ppfed-$src' AND part_key='item:P-001';" 2>/dev/null | tr -d '[:space:]')"
    [ "$row" = "remote|xmerge-proof-from-$src" ] && { echo 1; return 0; }
    sleep 3
  done
  echo 0; return 1
}

# fed_hive_merge_probe <src> <dst> <src_slug> <fid> [tries]
# Post-JOIN merge probe for the hive model (hive-federation-cross-machine-merge P-001).
# Slug-AGNOSTIC on the dst side: the hive federation may key/remap harness_slug across
# peers (member vs joined slug), so we INSERT a feature on src's harness and poll dst
# for that feature_id arriving origin='remote' under ANY harness_slug. Answers the open
# question "does a write federate AFTER a hive join?" Echoes "1 <landed_slug>" or "0".
fed_hive_merge_probe() {
  local src="$1" dst="$2" sslug="$3" fid="$4" tries="${5:-30}" i row ts ws="" write_slug=""
  write_slug="$sslug"
  ts="$(date +%s)000"
  # D-050 / WI-5399 iteration 2: workspace_id = the operator's REAL workspace (the
  # harness drains WHERE workspace_id=its boot workspace). Prefer pot_home_slug
  # scoping when a caller has RIG_HIVE_ID in scope (deb-hetzner-rig.sh family) —
  # it works identically on OWNER and JOINER frames, unlike origin='local', which
  # structurally never matches a joiner's own membership row (authored by the
  # owner, federates IN as 'remote'). Falls back to the origin heuristic for
  # callers with no RIG_HIVE_ID (e.g. two-instance-content-matrix-smoke.sh, which
  # manages its own join outside deb-hetzner-rig.sh). Fails loudly instead of
  # silently writing under a workspace_id the harness never drains.
  if [ -n "${RIG_HIVE_ID:-}" ]; then
    ws="$(drv_psql "$src" "SELECT workspace_id FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
    # Pot membership enforcement (migrations 651/652) rejects local work-item
    # writes under a member-repo slug: harness_features_consolidated rows must
    # be homed to a real Pot. RIG_HIVE_ID is the already-resolved Pot identity
    # shared by both frames, so use it for the write as well as for the
    # workspace lookup above. The destination read remains slug-agnostic.
    write_slug="$RIG_HIVE_ID"
  fi
  [ -n "$ws" ] || ws="$(drv_psql "$src" "SELECT workspace_id FROM harness_shared.pot_members WHERE coalesce(origin,'local')='local' ORDER BY joined_at LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$ws" ]; then
    echo "FATAL fed_hive_merge_probe($src,$sslug,$fid): could not resolve a real workspace_id — refusing to silently write under 'default' (D-050/WI-5399 class)" >&2
    echo "0"; return 1
  fi
  if ! drv_psql "$src" "INSERT INTO harness_shared.harness_features_consolidated (workspace_id,harness_slug,feature_id,title,summary,status,attempts,origin,ts,created_ts,updated_ts) VALUES ('$ws','$write_slug','$fid','hive merge probe','P-001','todo',0,'local',$ts,$ts,$ts);" >/dev/null; then
    echo "FATAL fed_hive_merge_probe($src,$sslug,$fid): source write was rejected (resolved Pot home='$write_slug') — refusing to poll for a row that was never authored" >&2
    echo "0"; return 1
  fi
  for i in $(seq 1 "$tries"); do
    row="$(drv_psql "$dst" "SELECT harness_slug FROM harness_shared.harness_features_consolidated WHERE feature_id='$fid' AND origin='remote' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$row" ] && { echo "1 $row"; return 0; }
    sleep 3
  done
  # WI-6217: same extended-window treatment as fed_merge_assert — a fast-path
  # timeout on a row that has genuinely DRAINED (confirmed in flight, not a
  # dead wire or mis-targeted write) gets one further equally-sized window
  # before giving up, instead of reading a legitimately-slow-but-healthy
  # delivery as FAILED.
  if [ "$(_fed_outbox_drained "$src" "$fid")" = "Y" ]; then
    for i in $(seq 1 "$tries"); do
      row="$(drv_psql "$dst" "SELECT harness_slug FROM harness_shared.harness_features_consolidated WHERE feature_id='$fid' AND origin='remote' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
      [ -n "$row" ] && { echo "1 $row"; return 0; }
      sleep 3
    done
  fi
  # WI-6209: distinguish a mis-targeted write (enqueued, never drained) from a
  # genuine replication failure — a bare "0" conflates them.
  fed_diagnose_unmerged "$src" "$fid" "$dst"
  echo "0"; return 1
}

# fed_coord_merge_probe <src> <dst> <sslug> <tag> <tries> → "1" / "0"
# Proves the cross-machine COMMUNICATION path (D-042): authors a HARNESS-SCOPED
# coord_event_log row (the coord feed) on src with origin='local' so the mig-150
# capture trigger federates it over THAT member's peer-log (the SAME wire as
# content), then polls dst for the same globally-unique msg_id at origin='remote'.
# Body shape mirrors a real coord message ({kind,text}) so the coord-message
# projection applies it. Distinct from content (features/plans) — this is comms.
fed_coord_merge_probe() {
  local src="$1" dst="$2" sslug="$3" tag="$4" tries="${5:-30}" i row mid ws=""
  mid="COMM-${tag}-$(date +%s)"
  # D-050 / WI-5399 iteration 2: see fed_hive_merge_probe's comment — prefer
  # pot_home_slug scoping (RIG_HIVE_ID) which works on owner AND joiner; fall back
  # to the origin heuristic when RIG_HIVE_ID isn't in scope; fail loudly, never 'default'.
  if [ -n "${RIG_HIVE_ID:-}" ]; then
    ws="$(drv_psql "$src" "SELECT workspace_id FROM harness_shared.pot_members WHERE pot_home_slug='$RIG_HIVE_ID' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  fi
  [ -n "$ws" ] || ws="$(drv_psql "$src" "SELECT workspace_id FROM harness_shared.pot_members WHERE coalesce(origin,'local')='local' ORDER BY joined_at LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$ws" ]; then
    echo "FATAL fed_coord_merge_probe($src,$sslug): could not resolve a real workspace_id — refusing to silently write under 'default' (D-050/WI-5399 class)" >&2
    echo 0; return 1
  fi
  drv_psql "$src" "INSERT INTO harness_shared.coord_event_log (workspace_id,surface,writer_key,msg_id,body,harness_slug,origin) VALUES ('$ws','messages','comm-probe','$mid','{\"kind\":\"message\",\"text\":\"comm federation probe\"}'::jsonb,'$sslug','local');" >/dev/null
  for i in $(seq 1 "$tries"); do
    row="$(drv_psql "$dst" "SELECT msg_id FROM harness_shared.coord_event_log WHERE msg_id='$mid' AND origin='remote' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$row" ] && { echo 1; return 0; }
    sleep 3
  done
  echo 0; return 1
}

# ── LIVE-1 parity-surface asserts (WI-5067 / P-059, coordination lane) ──────
# The 5 cross-machine coordination parity surfaces (LIVE-1 runbook §"What
# LIVE-1 must prove"), codified so the live parity proof is a green/red exit
# instead of manual PG inspection. These are the ASSERT halves: the drill
# DRIVES each surface from the SOURCE machine via mcp-call.mjs / vmcall.sh
# (coord:send wake:'required' scope:'hive' · events:emit scope:'hive' ·
# scheduler:set_claim_spec scope:'hive' — see the runbook §Run), then calls
# the matching assert against the RECEIVING instance's PG. House style:
# drv_psql poll loop, echo 1/0 + return (see fed_merge_assert). Column sets +
# event/receipt key shapes verified against the live schema and the emitting
# code (coord-message.ts:256/526, inbox-wake.ts:36) on 2026-07-16.
# NOT covered here (needs crafted signed frames — stays with the in-process
# suites, run those at drill time): H1/H2/H3 adversarial presence frames
# (presence-gossip.test.ts), M6 below-steer claim-spec authz + M5b quarantine
# budget (coord-message-federation.integration.test.ts, bee-claim-spec.test.ts).

# fed_assert_wake_bridge <dst> <dst_agent> <since_epoch_ms> [tries]
# Surface 1 (P-002/P-003, wake bridge): after the drill sends a directed
# wake:'required' scope:'hive' message to <dst_agent> (homed on dst), the wake
# must actually be DELIVERED to that agent on dst — a
# harness_shared.event_wake_deliveries row for the agent's
# `coord:inbox-wake:<agent>` key, created after <since_epoch_ms>, reaching
# status='delivered'. Echoes 1 (delivered) or 0.
#
# ⚠ Do NOT "simplify" this back to event_awaits.fired_at (WI-7012). That was the
# original predicate and it is STRUCTURALLY DEAD for this key: the inbox-wake
# watch is always-armed (once=false), and fireAwaitsForKey fires a STANDING row
# with a plain SELECT — "match without consuming" (store.ts:541-548) — while only
# the once=true branch UPDATEs fired_at. So the column is never written for the
# row class the assert targets. Measured on the tower 2026-08-02: once=false =>
# 28,569 rows, 0 EVER fired; once=true => 58 rows, 55 fired. The assert did not
# error and did not warn — it returned a confident, quotable, WRONG 0 for a rail
# that was doing ~350 deliveries an hour.
#
# `delivered` is asserted rather than mere row existence so this cannot pass on a
# wake that queued and then died; dropped/dead/pending are reported as such
# below. Verified satisfiable before being relied on (tower, same moment):
# delivered=33,684 (74 in the last hour), dropped=62 (none since 2026-07-10),
# dead=17 (none since 2026-07-19), and no pending/parked/delivering backlog.
#
# Deliberately NOT workspace-scoped: subscriber_id is a globally-unique agent id,
# so the pair (subscriber_id, event_key) already pins one identity, and pinning a
# workspace here could only ever re-introduce a false negative on a machine whose
# workspace differs from the sender's.
fed_assert_wake_bridge() {
  local dst="$1" agent="$2" since="$3" tries="${4:-30}" i n seen
  local where="subscriber_id='$agent' AND event_key='coord:inbox-wake:$agent' AND created_at > to_timestamp($since/1000.0)"
  for i in $(seq 1 "$tries"); do
    n="$(drv_psql "$dst" "SELECT count(*) FROM harness_shared.event_wake_deliveries WHERE $where AND status='delivered';" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$n" ] && [ "$n" -ge 1 ] 2>/dev/null; then echo 1; return 0; fi
    sleep 3
  done
  # Name WHICH failure this is: no delivery row at all (the bridge produced
  # nothing) reads very differently from one stuck pending or already dropped.
  seen="$(drv_psql "$dst" "SELECT coalesce(string_agg(status || '=' || n, ', ' ORDER BY status), 'no delivery rows at all') FROM (SELECT status, count(*)::text AS n FROM harness_shared.event_wake_deliveries WHERE $where GROUP BY status) s;" 2>/dev/null | tr -d '\n')"
  echo "✗ wake-bridge: no 'delivered' inbox-wake for $agent after ${since}ms — observed: ${seen:-<query failed>}" >&2
  echo 0; return 1
}

# fed_assert_delivery_receipts <src> <msg_id> [tries]
# Surface 2 (P-008 + M5a, delivery receipts): EXACTLY ONE
# `coord:receipt:<msg_id>` fed-event row arrives back on the SENDER's machine
# with payload.delivered=true (M5a: only the machine that actually woke someone
# answers — a 2nd row is the N-1 false-delivered bug; 0 rows = the receipt rail
# is dead). Echoes 1 only on count==1 AND delivered:true.
fed_assert_delivery_receipts() {
  local src="$1" mid="$2" tries="${3:-30}" i row
  for i in $(seq 1 "$tries"); do
    # Persisted shape: sendMessage MERGES `extra` onto the envelope, so the key
    # lives at body->'fed_event' TOP-LEVEL (verified against a real receipt row
    # from the 2026-07-10 gate-clear: fed_event.payload = {delivered,woken,machine}).
    row="$(drv_psql "$src" "SELECT count(*)::text || '|' || coalesce(bool_and((body->'fed_event'->'payload'->>'delivered')::boolean)::text, 'none') FROM harness_shared.coord_event_log WHERE body->'fed_event'->>'key' = 'coord:receipt:$mid';" 2>/dev/null | tr -d '[:space:]')"
    if [ "$row" = "1|true" ]; then echo 1; return 0; fi
    sleep 3
  done
  echo 0; return 1
}

# fed_assert_federated_events <dst> <key> <since_epoch_ms> [tries] [settle_sec]
# Surface 3 (P-009, federated events): the src-emitted scope:'hive' key fires
# dst's registered await EXACTLY ONCE — polls until >=1 fired-after-<since>,
# then holds settle_sec and asserts the fired count did NOT grow (a re-applied
# row re-firing = the exactly-once regression). Echoes 1 or 0.
fed_assert_federated_events() {
  local dst="$1" key="$2" since="$3" tries="${4:-30}" settle="${5:-10}" i n n2 q
  q="SELECT count(*) FROM harness_shared.event_awaits WHERE event_key='$key' AND fired_at IS NOT NULL AND fired_at > to_timestamp($since/1000.0);"
  n=""
  for i in $(seq 1 "$tries"); do
    n="$(drv_psql "$dst" "$q" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$n" ] && [ "$n" -ge 1 ] 2>/dev/null; then break; fi
    sleep 3
  done
  { [ -n "$n" ] && [ "$n" -ge 1 ] 2>/dev/null; } || { echo 0; return 1; }
  sleep "$settle"
  n2="$(drv_psql "$dst" "$q" 2>/dev/null | tr -d '[:space:]')"
  if [ "$n2" = "$n" ]; then echo 1; return 0; fi
  echo "✗ fed-event '$key' re-fired: $n → $n2 (exactly-once regression)" >&2
  echo 0; return 1
}

# fed_assert_presence_gossip <dst> <src_machine_label> [tries]
# Surface 4 (P-004/P-005, presence gossip — the PRESENCE_GOSSIP cutover gate):
# with the writer flag ON on both machines, dst's shared_presence AND
# shared_session_presence must carry FRESH (<120s) rows for the src machine —
# the roster-populates leg. Remote ADDRESSABILITY is asserted by the drill's
# follow-up: a coord:send from dst to a src-homed su-id succeeds (surface 1
# reversed). Echoes 1 or 0.
fed_assert_presence_gossip() {
  local dst="$1" mach="$2" tries="${3:-30}" i row
  for i in $(seq 1 "$tries"); do
    row="$(drv_psql "$dst" "SELECT (SELECT count(*) FROM harness_shared.shared_presence WHERE machine_label='$mach' AND last_seen_at > now() - interval '120 seconds')::text || '|' || (SELECT count(*) FROM harness_shared.shared_session_presence WHERE machine_label='$mach' AND last_seen_at > now() - interval '120 seconds');" 2>/dev/null | tr -d '[:space:]')"
    case "$row" in
      0\|*|*\|0|'') sleep 3 ;;
      *) echo 1; return 0 ;;
    esac
  done
  echo 0; return 1
}

# fed_assert_claim_spec_federation <dst> <bee_id> [tries]
# Surface 5 (P-016 + M7, claim-spec federation): the src-set scope:'hive'
# claim spec lands on dst origin='remote' with fed_hlc AND fed_ts stamped
# (M7 — the bee_claim_specs HLC regression guard, mig 439). Echoes 1 or 0.
fed_assert_claim_spec_federation() {
  local dst="$1" bee="$2" tries="${3:-30}" i n
  for i in $(seq 1 "$tries"); do
    n="$(drv_psql "$dst" "SELECT count(*) FROM harness_shared.cup_claim_specs WHERE bee_id='$bee' AND origin='remote' AND fed_hlc IS NOT NULL AND fed_ts IS NOT NULL;" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$n" ] && [ "$n" -ge 1 ] 2>/dev/null; then echo 1; return 0; fi
    sleep 3
  done
  echo 0; return 1
}

# ── teardown ────────────────────────────────────────────────────────────────

# fed_cleanup_scoped <work> — kill FED_KILL_PIDS + every process whose cmdline
# carries THIS run's $work (the packaged instance trees: desktop binary,
# host.mjs sidecar, embedded-PG, code-server). NEVER a broad
# `pkill -f papercusp-desktop` — that kills peers' dev desktops.
# fed_self_and_ancestors — echo " PID PID … " for the current shell + its whole
# ancestor chain. Used so cleanup never KILLS, and reap never counts as "live", the
# very process tree doing the cleanup — which legitimately carries $work in its argv
# (`cleanup-run.sh <WORK>`, the invoking agent shell). Walks /proc PPid (robust to a
# comm with spaces/parens, unlike `stat` field-4). `$$` stays the main shell pid even
# inside this command-substitution (bash special-cases it).
fed_self_and_ancestors() {
  local cur=$$ out=" $$ "
  while :; do
    cur=$(awk '/^PPid:/{print $2}' "/proc/$cur/status" 2>/dev/null)
    { [ -n "$cur" ] && [ "$cur" -gt 1 ] 2>/dev/null; } || break
    out+="$cur "
  done
  printf '%s' "$out"
}

# ── WI-36926: three independent floors under the kill loop ──────────────────
# On 2026-08-08 20:32:15 this function SIGKILLed 1,896 processes in one second —
# including gnome-session-binary, which logged the owner out of their desktop. A
# fuzz harness (sweep-5472.sh) had enumerated every fed_* function via
# `declare -F` and called each with placeholder args `a b c d 1 e f`, so $work
# arrived as the single character "a" and `grep -F "a"` matched nearly every
# process on the box.
#
# The validation existed — `fed_is_rig_work` — but it guarded `fed_cleanup_run`,
# the PUBLIC DOOR, while this function, the one that actually signals, trusted its
# caller. That is the whole bug: a guard on a door is not a guard on the thing
# behind it. Validation now lives HERE, at the kill site, so no caller (selftest,
# fuzzer, future rig, a human sourcing this file) can route around it.
#
# Three floors, deliberately independent — any ONE of them alone stops the 2026-08-08
# incident, so this is not defence-in-depth theatre:
#   1. MARKER SANITY  — $work must be specific enough that `grep -F` over the full
#      process table can only plausibly match one run.
#   2. BLAST-RADIUS CAP — if the scan matches more than N processes then whatever it
#      matched, it is not "one run's leftovers". Refuse rather than guess. This is
#      the floor that needs no knowledge of what a valid marker looks like, which is
#      why it is here even though (1) already rejects "a".
#   3. SESSION FLOOR  — never signal a pid belonging to the owner's login session,
#      no matter how the victim set was derived (scripts/lib/session-floor.sh).
FED_CLEANUP_MAX_VICTIMS="${FED_CLEANUP_MAX_VICTIMS:-40}"

# Load the canonical session floor from the superproject when reachable. This file
# also has to work in a STANDALONE papercusp-desktop checkout, where that path does
# not exist — so an equivalent inline floor follows. `session-floor-parity.test.ts`
# asserts the two agree, so the fallback cannot silently drift weaker.
_FED_SF="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd)/scripts/lib/session-floor.sh"
# shellcheck source=/dev/null
[ -r "$_FED_SF" ] && . "$_FED_SF" 2>/dev/null || true

# Session-critical comms, ALREADY truncated to the kernel's 15-char comm limit.
# Writing `gnome-session-binary` here would match nothing: /proc/<pid>/comm is
# clipped to 15 chars, so the long name silently never compares equal — which is
# exactly how a floor grows a hole that only shows up during an incident.
FED_SESSION_FLOOR_COMMS="${FED_SESSION_FLOOR_COMMS:-systemd gnome-session-b gnome-shell gnome-session-c Xorg Xwayland gdm-x-session gdm-wayland-ses gdm3 gdm plasmashell sddm ksmserver}"

fed_pid_is_session_critical() {
  local pid="$1" comm
  [ -n "$pid" ] || return 0                          # fail closed on garbage
  case "$pid" in ''|*[!0-9]*) return 0;; esac
  # Prefer the canonical oracle when the superproject was reachable above.
  if command -v session_floor_is_protected >/dev/null 2>&1; then
    session_floor_is_protected "$pid"; return $?
  fi
  [ "$pid" -eq 1 ] 2>/dev/null && return 0
  [ -r "/proc/$pid/comm" ] || return 1               # gone => not protected
  comm="$(tr -d '\n' < "/proc/$pid/comm" 2>/dev/null)"
  [ -n "$comm" ] || return 1
  case " $FED_SESSION_FLOOR_COMMS " in *" $comm "*) return 0;; esac
  return 1
}

# fed_is_safe_kill_marker <work> — is $work specific enough to be used as a
# `grep -F` needle against the whole process table? This deliberately does NOT
# reuse `fed_is_rig_work`: that one keys on a hardcoded /tmp/<rig>. prefix list,
# and a real caller (two-instance-content-matrix-smoke.sh) legitimately uses
# $HOME/.papercusp-lane-a-fed. Keying on the PREFIX LIST would have broken a live
# rig while still not describing the actual hazard. The hazard is non-specificity,
# so that is what is measured here.
fed_is_safe_kill_marker() {
  local work="$1" leaf
  [ -n "$work" ] || return 1
  case "$work" in /*) ;; *) return 1;; esac          # must be an absolute path
  [ "${#work}" -ge 12 ] || return 1                  # "a", "/tmp" -> refused
  case "$work" in
    /|/tmp|/tmp/|/home|/home/*/|/usr|/usr/*|/var|/var/*|/etc|/etc/*|/opt|/root|/run|"$HOME"|"$HOME/") return 1;;
  esac
  leaf="${work##*/}"
  [ "${#leaf}" -ge 6 ] || return 1                   # a bare or 1-char final segment
  return 0
}

fed_cleanup_scoped() {
  local work="$1" p pid victims n
  if ! fed_is_safe_kill_marker "$work"; then
    echo "fed_cleanup_scoped: REFUSING '$work' — not a specific per-run marker. This function kills every process whose cmdline CONTAINS \$work, so a short/relative value is a box-wide kill. On 2026-08-08 \$work=\"a\" SIGKILLed 1,896 processes and logged the owner out (WI-36926)." >&2
    return 2
  fi
  # Protect the current process + its ancestors: a STANDALONE caller
  # (`cleanup-run.sh <WORK>`, an agent's shell) carries $work in its OWN argv, so an
  # unguarded `pkill -f "$work"` would match — and kill — the caller / its shell
  # mid-cleanup (EI-1739). The in-rig EXIT trap is unaffected (a rig never has
  # $work in argv — it's a runtime mktemp var).
  local protect; protect="$(fed_self_and_ancestors)"
  for p in "${FED_KILL_PIDS[@]:-}"; do
    [ -n "$p" ] || continue
    case "$protect" in *" $p "*) continue;; esac
    if fed_pid_is_session_critical "$p"; then
      echo "fed_cleanup_scoped: REFUSING FED_KILL_PIDS entry $p — owner login session (WI-36926)" >&2
      continue
    fi
    kill -9 "$p" 2>/dev/null || true
  done
  # Kill every process whose cmdline carries THIS run's $work — except self/ancestors
  # (above) and the scan pipeline itself (`grep -v grep`).
  victims="$(ps -eo pid,args 2>/dev/null | grep -F "$work" | grep -v grep | awk '{print $1}')"
  # Count in-shell rather than with `grep -c`: grep prints 0 and exits 1 both for a
  # genuine no-match AND for a read failure, so the old `|| true` made an UNMEASURABLE
  # count indistinguishable from a real zero (R3-grep-c-unguarded). That is not a
  # cosmetic shape here — this count IS the WI-36926 blast-radius cap, so a false zero
  # silently DISABLES the cap and re-opens the box-wide sweep it exists to stop. A
  # shell loop has no exit code to swallow, and applies the SAME pid filter as the kill
  # loop below, so the cap now counts exactly the set that would be signalled.
  n=0
  while IFS= read -r pid; do
    case "$pid" in ''|*[!0-9]*) continue;; esac
    n=$((n + 1))
  done <<< "$victims"
  if [ "$n" -gt "$FED_CLEANUP_MAX_VICTIMS" ]; then
    echo "fed_cleanup_scoped: REFUSING — marker '$work' matched $n processes (cap $FED_CLEANUP_MAX_VICTIMS). One run's leftovers are never this many; killing them would be a box-wide sweep (WI-36926). Nothing was signalled and \$work was NOT removed." >&2
    return 3
  fi
  printf '%s\n' "$victims" | while read -r pid; do
    case "$pid" in ''|*[!0-9]*) continue;; esac
    case "$protect" in *" $pid "*) continue;; esac
    if fed_pid_is_session_critical "$pid"; then
      echo "fed_cleanup_scoped: REFUSING pid $pid — owner login session (WI-36926)" >&2
      continue
    fi
    kill -9 "$pid" 2>/dev/null || true
  done
  rm -rf "$work" 2>/dev/null || true
}

# ── EI-1739: safe run-SCOPED cleanup for CONCURRENT rigs ───────────────────────
# Multiple agents run the two-instance rigs at once. NEVER clean up leftovers with
# a broad `rm -rf /tmp/<rig>.*` or `pkill -f <rig-name>` — those nuke OTHER agents'
# LIVE runs mid-flight (the EI-1739 collision: a glob over all runs + a name-wide
# pkill deleted a sibling's $WORK mid-initdb and killed its processes). Use:
#   bin/cleanup-run.sh <WORK>   — kill+rm exactly ONE run's $WORK
#   bin/reap-orphans.sh [--dry-run]  — reap ONLY runs whose processes are gone
# Both refuse anything that isn't a single per-run rig $WORK dir, so they can never
# touch a live sibling or a path outside a run sandbox.

# The mktemp -d prefixes every two-instance rig uses (keep in sync if a rig adds one).
FED_RIG_TMP_PREFIXES=(
  /tmp/hive-fromrepo-smoke. /tmp/hive-dir-smoke. /tmp/merge-smoke.
  /tmp/p3-smoke. /tmp/vm-fed. /tmp/deb-hzfed. /tmp/deb-hzfast.
)

# fed_is_rig_work <dir> — true iff <dir> is a REAL per-run rig $WORK: an existing
# directory that is a known mktemp prefix + a non-empty single-segment suffix.
# Refuses '', '/', '/tmp', a bare prefix, a nested subpath, or any non-rig path —
# so a validated caller can never rm/kill outside one run's sandbox.
fed_is_rig_work() {
  local work="$1" pfx suf
  [ -n "$work" ] && [ -d "$work" ] || return 1
  for pfx in "${FED_RIG_TMP_PREFIXES[@]}"; do
    suf="${work#"$pfx"}"
    [ "$work" != "$suf" ] && [ -n "$suf" ] || continue
    case "$suf" in */*) continue;; *) return 0;; esac  # direct rig dir only, no nesting
  done
  return 1
}

# fed_cleanup_run <work> — the SAFE public cleanup for ONE run's leftovers:
# validate then fed_cleanup_scoped. Refuses anything that isn't a single rig $WORK.
fed_cleanup_run() {
  local work="$1"
  if ! fed_is_rig_work "$work"; then
    echo "fed_cleanup_run: refusing '$work' — not a per-run rig \$WORK dir (never broad-glob; pass one /tmp/<rig>.XXXXXX)" >&2
    return 2
  fi
  fed_log "cleanup-run (scoped to $work)" >&2
  fed_cleanup_scoped "$work"
}

# fed_reap_orphans [--dry-run] [--min-age-min N] — reap ONLY dead rig runs: a $WORK
# is reaped iff (a) NO live process references it (`pgrep -f "$dir"` empty) AND (b)
# it is older than N minutes (default 5 — protects a run still in its startup window
# before it has spawned anything). A live sibling always has referencing processes,
# so it is NEVER touched. Safe to run anytime, concurrently, by anyone.
fed_reap_orphans() {
  local dry=0 min_age=5 d suf reaped=0 skipped=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) dry=1;;
      --min-age-min) shift; min_age="$1";;
      *) echo "fed_reap_orphans: unknown arg '$1'" >&2; return 2;;
    esac
    shift
  done
  local protect; protect="$(fed_self_and_ancestors)"
  local prev_nullglob; prev_nullglob="$(shopt -p nullglob)"; shopt -s nullglob
  local pfx pp live
  for pfx in "${FED_RIG_TMP_PREFIXES[@]}"; do
    for d in "$pfx"*; do
      [ -d "$d" ] || continue
      fed_is_rig_work "$d" || continue
      # live iff some process OUTSIDE our own tree references $d (a real instance);
      # exclude self+ancestors so the reaper / invoking agent shell — which may carry
      # $d in its argv — never false-flags a dead run as 'live'.
      live=0
      for pp in $(pgrep -f -- "$d" 2>/dev/null); do
        case "$protect" in *" $pp "*) continue;; esac
        live=1; break
      done
      if [ "$live" = 1 ]; then
        skipped=$((skipped+1)); echo "skip  (live)  $d" >&2; continue
      fi
      if [ -z "$(find "$d" -maxdepth 0 -mmin +"$min_age" 2>/dev/null)" ]; then
        skipped=$((skipped+1)); echo "skip  (young) $d" >&2; continue
      fi
      if [ "$dry" = 1 ]; then echo "REAP  (dry)   $d" >&2
      else echo "REAP          $d" >&2; fed_cleanup_scoped "$d"; fi
      reaped=$((reaped+1))
    done
  done
  eval "$prev_nullglob"
  echo "fed_reap_orphans: reaped=$reaped skipped=$skipped (min_age=${min_age}m)" >&2
}
