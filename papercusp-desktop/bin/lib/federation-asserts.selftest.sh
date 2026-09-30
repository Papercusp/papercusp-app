#!/usr/bin/env bash
# federation-asserts.selftest.sh — focused unit test for the PORT SELF-DISCOVERY
# hardening (WI-754) in federation-asserts.sh. It proves fed_probe_sidecar +
# fed_discover_sidecar_os pick the REAL sidecar port out of an instance's
# listeners and reject a decoy listener (the code-server class), using synthetic
# HTTP listeners — NO real desktop / .deb / VM boot. Pure, hermetic, ~2s.
#
#   bash bin/lib/federation-asserts.selftest.sh     # exit 0 = PASS, 1 = FAIL
#
# Why a bash self-test and not Vitest: the unit under test is bash (the rig's
# assert core). This is the rig's own micro-test; the four canonical TS/Cargo/LLM
# frameworks don't host shell units. The full rig (the *.sh smokes) is the
# integration test.
set -uo pipefail
# EI-21266614790118256: gate_selftest() (live-federation-gate.sh) now runs this
# script from an immutable copy OUTSIDE bin/lib/ (its own untracked $WORK
# scratch dir, not the git-tracked source tree) so a desktop auto-commit sweep
# can never catch the ephemeral snapshot mid-run. It injects GATE_SELFTEST_LIB_DIR
# pointing at the REAL bin/lib so this script still resolves federation-asserts.sh
# and its ../ driver siblings exactly as if it were running in place. A bare
# manual invocation (bash bin/lib/federation-asserts.selftest.sh) has no such
# override and falls back to its own on-disk location, unchanged.
DIR="${GATE_SELFTEST_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=federation-asserts.sh
source "$DIR/federation-asserts.sh"
set +e   # this self-test owns its own exit codes (asserts may intentionally fail a probe)

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 unavailable"; exit 0; }
command -v curl    >/dev/null 2>&1 || { echo "SKIP: curl unavailable"; exit 0; }

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

sample_gist_stream=$'\n0123456789abcdef0123456789abcdef\n\nnpm notice New major version of npm available!\n'
if [ "$(printf '%s' "$sample_gist_stream" | fed_extract_attestation_gist_id)" = "0123456789abcdef0123456789abcdef" ]; then
  ok "attestation preflight extracts gist id despite trailing npm notices (WI-40905)"
else
  bad "attestation preflight gist-id extraction regression (WI-40905)"
fi

WORK="$(mktemp -d /tmp/fed-selftest.XXXXXX)"
WORK2="$(mktemp -d /tmp/fed-selftest.XXXXXX)"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$WORK" "$WORK2"; }
trap cleanup EXIT

# EI-21235839358679656: prove the immutable child copy survives a destructive
# edit to the original after execution starts.  This is the child-script form
# of live-federation-gate's existing EI-16828 self-snapshot invariant.
SNAP_SOURCE="$WORK/mutable-long-smoke.sh"
SNAP_COPY="$WORK/snapshots/long-smoke.sh"
SNAP_OUT="$WORK/snapshot.out"
printf '#!/usr/bin/env bash\necho before-edit\nsleep 1\necho after-edit\n' >"$SNAP_SOURCE"
if ! fed_snapshot_shell_script "$SNAP_SOURCE" "$SNAP_COPY"; then
  bad "fed_snapshot_shell_script could not create a syntax-checked immutable child copy"
else
  bash "$SNAP_COPY" >"$SNAP_OUT" 2>&1 & snapshot_pid=$!
  for _ in $(seq 1 20); do
    grep -q '^before-edit$' "$SNAP_OUT" 2>/dev/null && break
    sleep 0.05
  done
  printf '#!/usr/bin/env bash\nthis is a syntax error (\n' >"$SNAP_SOURCE"
  if wait "$snapshot_pid" \
    && grep -q '^before-edit$' "$SNAP_OUT" \
    && grep -q '^after-edit$' "$SNAP_OUT" \
    && ! bash -n "$SNAP_SOURCE" 2>/dev/null; then
    ok "fed_snapshot_shell_script insulates a running child from a destructive mid-run source edit"
  else
    bad "fed_snapshot_shell_script did not insulate a running child from a destructive mid-run source edit"
  fi
fi

# EI-21823254822396581: a sidecar smoke must snapshot the shared build output
# under the writer's reader lock before launching its long-lived instances.
# The behavioral probe uses a tiny synthetic bundle, so it is hermetic and does
# not copy the real multi-GB sidecar. First prove the snapshot survives the
# atomic directory replacement a concurrent publisher performs; then, on hosts
# with flock(1), prove an exclusive publisher blocks the snapshot until release.
SIDECAR_SOURCE="$WORK/sidecar-source"
SIDECAR_SNAPSHOT="$WORK/sidecar-snapshot"
SIDECAR_LOCK="$SIDECAR_SOURCE.lock"
mkdir -p "$SIDECAR_SOURCE/bin" "$SIDECAR_SOURCE/node_modules"
printf 'old-sidecar\n' >"$SIDECAR_SOURCE/serve.mjs"
printf 'old-node\n' >"$SIDECAR_SOURCE/bin/node"
if fed_snapshot_sidecar_bundle "$SIDECAR_SOURCE" "$SIDECAR_SNAPSHOT" "$SIDECAR_LOCK" "$SIDECAR_SOURCE.lockdir" 2 >/dev/null 2>&1 \
  && grep -qx 'old-sidecar' "$SIDECAR_SNAPSHOT/serve.mjs"; then
  mv "$SIDECAR_SOURCE" "$WORK/sidecar-source-old"
  mkdir -p "$SIDECAR_SOURCE/bin" "$SIDECAR_SOURCE/node_modules"
  printf 'new-sidecar\n' >"$SIDECAR_SOURCE/serve.mjs"
  if grep -qx 'old-sidecar' "$SIDECAR_SNAPSHOT/serve.mjs"; then
    ok "fed_snapshot_sidecar_bundle keeps a per-run snapshot stable across an atomic sidecar publish (EI-218)"
  else
    bad "fed_snapshot_sidecar_bundle snapshot changed after the source sidecar was atomically replaced (EI-218)"
  fi
else
  bad "fed_snapshot_sidecar_bundle could not create a hermetic sidecar snapshot (EI-218)"
fi
if command -v flock >/dev/null 2>&1; then
  SIDECAR_LOCK_READY="$WORK/sidecar-lock-ready"
  SIDECAR_LOCK_RELEASE="$WORK/sidecar-lock-release"
  (
    exec 8>"$SIDECAR_LOCK"
    flock -x 8
    : >"$SIDECAR_LOCK_READY"
    while [ ! -e "$SIDECAR_LOCK_RELEASE" ]; do sleep 0.02; done
  ) &
  SIDECAR_HOLDER_PID=$!
  for _ in $(seq 1 50); do
    [ -e "$SIDECAR_LOCK_READY" ] && break
    sleep 0.02
  done
  rm -rf "$SIDECAR_SNAPSHOT"
  fed_snapshot_sidecar_bundle "$SIDECAR_SOURCE" "$SIDECAR_SNAPSHOT" "$SIDECAR_LOCK" "$SIDECAR_SOURCE.lockdir" 2 >"$WORK/sidecar-snapshot.log" 2>&1 &
  SIDECAR_SNAPSHOT_PID=$!
  sleep 0.1
  if kill -0 "$SIDECAR_SNAPSHOT_PID" 2>/dev/null; then
    : >"$SIDECAR_LOCK_RELEASE"
    wait "$SIDECAR_HOLDER_PID" 2>/dev/null || true
    if wait "$SIDECAR_SNAPSHOT_PID" \
      && grep -qx 'new-sidecar' "$SIDECAR_SNAPSHOT/serve.mjs"; then
      ok "fed_snapshot_sidecar_bundle waits for an exclusive publisher before copying (EI-218)"
    else
      bad "fed_snapshot_sidecar_bundle did not complete after the exclusive publisher released (EI-218)"
    fi
  else
    bad "fed_snapshot_sidecar_bundle ignored an exclusive sidecar publisher lock (EI-218)"
    : >"$SIDECAR_LOCK_RELEASE"
    wait "$SIDECAR_HOLDER_PID" 2>/dev/null || true
    wait "$SIDECAR_SNAPSHOT_PID" 2>/dev/null || true
  fi
fi

# WI-40912: a single transient authenticated GET /user failure must not red-pin
# the entire live federation gate.  Stub gh with file-backed counters because
# command substitution runs the helper in a subshell.
GH_RETRY_EVENTUAL_COUNT="$WORK/gh-retry-eventual.count"
GH_RETRY_NEVER_COUNT="$WORK/gh-retry-never.count"
GH_RETRY_JSON_EVENTUAL_COUNT="$WORK/gh-retry-json-eventual.count"
GH_RETRY_JSON_NEVER_COUNT="$WORK/gh-retry-json-never.count"
printf '0\n' >"$GH_RETRY_EVENTUAL_COUNT"
printf '0\n' >"$GH_RETRY_NEVER_COUNT"
printf '0\n' >"$GH_RETRY_JSON_EVENTUAL_COUNT"
printf '0\n' >"$GH_RETRY_JSON_NEVER_COUNT"
gh() {
  local counter count output
  case "${GH_TOKEN:-}" in
    retry-eventual)
      counter="$GH_RETRY_EVENTUAL_COUNT"
      ;;
    retry-never)
      counter="$GH_RETRY_NEVER_COUNT"
      ;;
    retry-json-eventual) counter="$GH_RETRY_JSON_EVENTUAL_COUNT" ;;
    retry-json-never) counter="$GH_RETRY_JSON_NEVER_COUNT" ;;
    *) command gh "$@"; return $? ;;
  esac
  count="$(cat "$counter")"; count=$((count + 1)); printf '%s\n' "$count" >"$counter"
  [[ "${GH_TOKEN:-}" != *never ]] && [ "$count" -ge 3 ] || return 1
  output='{"id":12345,"login":"ownerhandle"}'
  case " $* " in
    *" --jq .login "*) printf 'ownerhandle\n' ;;
    *) printf '%s\n' "$output" ;;
  esac
}
retry_login="$(fed_github_login_with_retry retry-eventual 3 0)"; retry_rc=$?
if [ "$retry_rc" -eq 0 ] && [ "$retry_login" = ownerhandle ] \
  && [ "$(cat "$GH_RETRY_EVENTUAL_COUNT")" = 3 ]; then
  ok "fed_github_login_with_retry recovers after two transient GET /user failures (WI-40912)"
else
  bad "fed_github_login_with_retry did not recover on attempt 3 (rc=$retry_rc login=$retry_login attempts=$(cat "$GH_RETRY_EVENTUAL_COUNT"))"
fi
if fed_github_login_with_retry retry-never 3 0 >/dev/null \
  || [ "$(cat "$GH_RETRY_NEVER_COUNT")" != 3 ]; then
  bad "fed_github_login_with_retry does not fail closed after three exhausted attempts (WI-40912)"
else
  ok "fed_github_login_with_retry fails closed after three exhausted attempts (WI-40912)"
fi
retry_user_json="$(fed_github_user_json_with_retry retry-json-eventual 3 0)"; retry_json_rc=$?
if [ "$retry_json_rc" -eq 0 ] \
  && [ "$retry_user_json" = '{"id":12345,"login":"ownerhandle"}' ] \
  && [ "$(cat "$GH_RETRY_JSON_EVENTUAL_COUNT")" = 3 ]; then
  ok "fed_github_user_json_with_retry recovers full GET /user JSON after two transient failures (WI-40912)"
else
  bad "fed_github_user_json_with_retry did not recover full JSON on attempt 3 (rc=$retry_json_rc json=$retry_user_json attempts=$(cat "$GH_RETRY_JSON_EVENTUAL_COUNT"))"
fi
if fed_github_user_json_with_retry retry-json-never 3 0 >/dev/null \
  || [ "$(cat "$GH_RETRY_JSON_NEVER_COUNT")" != 3 ]; then
  bad "fed_github_user_json_with_retry does not fail closed after three exhausted attempts (WI-40912)"
else
  ok "fed_github_user_json_with_retry fails closed after three exhausted attempts (WI-40912)"
fi

# EI-21237890330979066: join-pot returns after the local view/rekey commit;
# pot_members arrives asynchronously through federation.  The shared relational
# probe must recover delayed convergence and still fail closed when absent.
ASYNC_PROBE_EVENTUAL_COUNT="$WORK/async-probe-eventual.count"
ASYNC_PROBE_NEVER_COUNT="$WORK/async-probe-never.count"
printf '0\n' >"$ASYNC_PROBE_EVENTUAL_COUNT"
printf '0\n' >"$ASYNC_PROBE_NEVER_COUNT"
async_probe() {
  local mode="$1" counter count
  if [ "$mode" = eventual ]; then counter="$ASYNC_PROBE_EVENTUAL_COUNT"; else counter="$ASYNC_PROBE_NEVER_COUNT"; fi
  count="$(cat "$counter")"; count=$((count + 1)); printf '%s\n' "$count" >"$counter"
  [ "$mode" = eventual ] && [ "$count" -ge 3 ] && printf 'workspace-joined\n'
}
async_value="$(fed_capture_nonempty_with_retry 3 0 -- async_probe eventual)"; async_rc=$?
if [ "$async_rc" -eq 0 ] && [ "$async_value" = workspace-joined ] \
  && [ "$(cat "$ASYNC_PROBE_EVENTUAL_COUNT")" = 3 ]; then
  ok "fed_capture_nonempty_with_retry recovers an asynchronous projection on attempt 3"
else
  bad "fed_capture_nonempty_with_retry missed delayed convergence (rc=$async_rc value=$async_value attempts=$(cat "$ASYNC_PROBE_EVENTUAL_COUNT"))"
fi
if fed_capture_nonempty_with_retry 3 0 -- async_probe never >/dev/null \
  || [ "$(cat "$ASYNC_PROBE_NEVER_COUNT")" != 3 ]; then
  bad "fed_capture_nonempty_with_retry does not fail closed after an exhausted projection wait"
else
  ok "fed_capture_nonempty_with_retry fails closed after an exhausted projection wait"
fi
unset -f async_probe
unset -f gh

# WI-40905: direct from-repo runs must share the live gate's fail-fast
# credentialed REST preflight. Pin both the two-account verdict and the ordering
# (preflight call before testnet/sidecar launch) so a future refactor cannot
# silently reintroduce a multi-minute product-shaped quota failure.
gh() {
  [ "${1:-}" = auth ] && [ "${2:-}" = token ] && [ "${3:-}" = --user ] \
    && { printf 'token-%s\n' "$4"; return 0; }
  command gh "$@"
}
curl() {
  if [[ " $* " == *" token-ownerhandle "* ]]; then
    printf '%s' "${WI40905_B_HTTP:-200}"
  else
    printf '200'
  fi
}
P_A_USER=papercupai P_B_USER=ownerhandle
if preflight_out="$(GITHUB_REST_PREFLIGHT_RETRY_DELAY_SEC=0 preflight_github_rest_accounts https://github.com/octocat/Hello-World)" \
  && grep -qF 'user=papercupai code=ok http=200' <<<"$preflight_out" \
  && grep -qF 'user=ownerhandle code=ok http=200' <<<"$preflight_out"; then
  ok "preflight_github_rest_accounts proves both smoke identities before rig launch (WI-40905)"
else
  bad "preflight_github_rest_accounts did not verify both identities (output='$preflight_out')"
fi
if WI40905_B_HTTP=403 GITHUB_REST_PREFLIGHT_RETRY_DELAY_SEC=0 preflight_github_rest_accounts https://github.com/octocat/Hello-World >/dev/null; then
  bad "preflight_github_rest_accounts accepted a quota-exhausted B identity (WI-40905)"
else
  ok "preflight_github_rest_accounts fails closed when either smoke identity is quota-exhausted (WI-40905)"
fi
direct_smoke="$DIR/../two-instance-hive-from-repo-smoke.sh"
direct_preflight_ln="$(grep -n 'GH_PREFLIGHT_OUTPUT=.*preflight_github_rest_accounts' "$direct_smoke" | head -1 | cut -d: -f1)"
direct_testnet_ln="$(grep -n 'fed_start_testnet_dht' "$direct_smoke" | head -1 | cut -d: -f1)"
if [ -n "$direct_preflight_ln" ] && [ -n "$direct_testnet_ln" ] \
  && [ "$direct_preflight_ln" -lt "$direct_testnet_ln" ]; then
  ok "direct from-repo witness runs the shared REST preflight before DHT/sidecar launch (WI-40905)"
else
  bad "direct from-repo witness no longer proves GitHub REST before rig launch (preflight=$direct_preflight_ln testnet=$direct_testnet_ln)"
fi
gate_script="$DIR/../live-federation-gate.sh"
gate_matrix_preflight_ln="$(grep -n 'GH_MATRIX_PREFLIGHT_OUTPUT=.*preflight_github_rest_accounts' "$gate_script" | head -1 | cut -d: -f1)"
gate_matrix_run_ln="$(grep -n 'run_smoke content-matrix two-instance-content-matrix-smoke.sh' "$gate_script" | head -1 | cut -d: -f1)"
if [ -n "$gate_matrix_preflight_ln" ] && [ -n "$gate_matrix_run_ln" ] \
  && [ "$gate_matrix_preflight_ln" -lt "$gate_matrix_run_ln" ]; then
  ok "live-federation-gate reruns the shared REST preflight immediately before content-matrix, closing the build-window gap (EI-21243220400364630)"
else
  bad "live-federation-gate content-matrix has no REST preflight recheck between build and launch (preflight=$gate_matrix_preflight_ln run=$gate_matrix_run_ln)"
fi
unset -f gh curl
unset WI40905_B_HTTP

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }

# start_listener <port> <sidecar|decoy> — a synthetic instance http listener.
# The sidecar answers GET /api/desktop/preflight with 200; the decoy 404s it
# (like code-server). The unique $WORK is in argv so the /proc-scoped discovery
# path can attribute it to this instance.
start_listener() {
  local port="$1" kind="$2"
  python3 - "$port" "$kind" "$WORK" <<'PY' &
import http.server, socketserver, sys
port = int(sys.argv[1]); is_sidecar = (sys.argv[2] == 'sidecar')
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/desktop/preflight' and is_sidecar:
            self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
        else:
            self.send_response(404); self.end_headers()
    def log_message(self, *a): pass
with socketserver.TCPServer(('127.0.0.1', port), H) as s:
    s.serve_forever()
PY
  PIDS+=("$!")
}

SIDE_PORT="$(free_port)"; DECOY_PORT="$(free_port)"
[ "$SIDE_PORT" != "$DECOY_PORT" ] || DECOY_PORT="$(free_port)"
start_listener "$SIDE_PORT" sidecar
start_listener "$DECOY_PORT" decoy
for _ in $(seq 1 50); do
  if curl -s -o /dev/null -m 1 "http://127.0.0.1:$SIDE_PORT/" \
     && curl -s -o /dev/null -m 1 "http://127.0.0.1:$DECOY_PORT/"; then break; fi
  sleep 0.2
done

echo "fed port self-discovery self-test (sidecar=$SIDE_PORT decoy=$DECOY_PORT)"

# instance 't' on the local driver; its log WRONGLY labels the DECOY as [serve]
# (the code-server-won-the-grep race) and also mentions the real sidecar port.
LOGF="$WORK/t.applog"
printf 'embedded-postgres-server ready on 127.0.0.1:55555\n[serve] listening on http://127.0.0.1:%s\nHTTP server listening on http://127.0.0.1:%s/\n' \
  "$DECOY_PORT" "$SIDE_PORT" > "$LOGF"
FED_LOG[t]="$LOGF"

# 1) fed_probe_sidecar classifies correctly
fed_probe_sidecar t "$SIDE_PORT"  && ok "fed_probe_sidecar accepts the real sidecar ($SIDE_PORT)"      || bad "fed_probe_sidecar rejected the real sidecar ($SIDE_PORT)"
fed_probe_sidecar t "$DECOY_PORT" && bad "fed_probe_sidecar wrongly accepted the decoy ($DECOY_PORT)"  || ok "fed_probe_sidecar rejects the decoy ($DECOY_PORT)"

# 2) self-heal: FED_SC points at the DECOY → discovery must adopt the real port
FED_SC[t]="$DECOY_PORT"
if fed_discover_sidecar_os t; then
  [ "${FED_SC[t]}" = "$SIDE_PORT" ] \
    && ok "fed_discover_sidecar_os self-healed FED_SC $DECOY_PORT → $SIDE_PORT" \
    || bad "fed_discover_sidecar_os resolved ${FED_SC[t]}, expected $SIDE_PORT"
else
  bad "fed_discover_sidecar_os found no sidecar (expected $SIDE_PORT)"
fi

# 3) negative: an instance (separate scope) whose only known port is a decoy → return 1
LOGF2="$WORK2/t2.applog"
printf '[serve] listening on http://127.0.0.1:%s\n' "$DECOY_PORT" > "$LOGF2"
FED_LOG[t2]="$LOGF2"; FED_SC[t2]="$DECOY_PORT"
if fed_discover_sidecar_os t2; then
  bad "fed_discover_sidecar_os should have failed (only a decoy is in t2's scope), resolved ${FED_SC[t2]}"
else
  ok "fed_discover_sidecar_os returns 1 when no port in scope answers the sidecar preflight"
fi

# 4) fed_pick_free_port skips a held port and returns a higher, free one
held="$SIDE_PORT"   # the sidecar synthetic listener is bound here
got="$(fed_pick_free_port "$held")"
port_probe="$(ss -tlnH "sport = :$got" 2>/dev/null || true)"
if [ "${got:-0}" -gt "$held" ] 2>/dev/null && ! grep -q . <<<"$port_probe"; then
  ok "fed_pick_free_port skipped held :$held → free :$got"
else
  bad "fed_pick_free_port returned '$got' for held :$held (expected a higher, free port)"
fi

# 5) advisory port locks close the ss-probe → bind selection race
LOCK_DIR="$WORK/port-locks"
LOCK_PORT="$((SIDE_PORT + 20))"
if fed_acquire_port_lock "$LOCK_PORT" "$LOCK_DIR"; then
  if bash -c 'source "$1"; fed_acquire_port_lock "$2" "$3"' _ "$DIR/federation-asserts.sh" "$LOCK_PORT" "$LOCK_DIR"; then
    bad "fed_acquire_port_lock allowed a concurrent holder on :$LOCK_PORT"
  else
    ok "fed_acquire_port_lock rejects a concurrent holder on :$LOCK_PORT"
  fi
  fed_release_port_locks
  if fed_acquire_port_lock "$LOCK_PORT" "$LOCK_DIR"; then
    ok "fed_acquire_port_lock is reusable after release"
    fed_release_port_locks
  else
    bad "fed_acquire_port_lock did not release :$LOCK_PORT"
  fi
else
  bad "fed_acquire_port_lock could not acquire :$LOCK_PORT"
fi

# 6) fed_local_launch_sidecar rejects same/empty hono+pg ports (the 2026-07-03
#    P-002 class: argless fed_pick_free_port x4 handed 18000 to everything and
#    every instance EADDRINUSE'd at boot — the guard must fail LOUDLY instead)
if fed_local_launch_sidecar "$WORK/g-home" /dev/null "$WORK" 18000 18000 2>/dev/null; then
  bad "fed_local_launch_sidecar accepted hono_port == pg_port (18000/18000)"
else
  ok "fed_local_launch_sidecar rejects hono_port == pg_port"
fi
if fed_local_launch_sidecar "$WORK/g-home" /dev/null "$WORK" "" "" 2>/dev/null; then
  bad "fed_local_launch_sidecar accepted empty ports"
else
  ok "fed_local_launch_sidecar rejects empty ports"
fi

# EI-20241165263819645: a token passed as a trailing env assignment survives in
# the sidecar's /proc environment (and in transient-systemd unit metadata).
# Reject it before spawn; callers select a gh account by non-secret login.
if fed_local_launch_sidecar "$WORK/g-home" /dev/null "$WORK" 18001 18002 GH_TOKEN=sentinel 2>/dev/null; then
  bad "fed_local_launch_sidecar accepted a persistent GH_TOKEN assignment"
else
  ok "fed_local_launch_sidecar rejects persistent GitHub-token assignments"
fi

# 7) ambient-env neutralization (the 2026-07-03 P-002 layer-4 class): fleet
#    shells carry PAPERCUSP_DHT_HOST=<bridge-ip> and PAPERCUSP_DHT_BOOTSTRAP=
#    <bridge-ip:port>; a launcher that INHERITS either swarm-binds/bootstraps
#    loopback smokes on the bridge → 0 peer dials. Static guard: every local
#    launcher must force-empty BOTH (trailing "$@" still lets callers opt in).
#    They must also force PAPERCUSP_BACKGROUND_WORKERS=1: request-only ambient
#    mode skips the hyperbee substrate and leaves content-matrix outboxes stuck.
for fn in fed_local_launch fed_local_launch_sidecar; do
  body="$(declare -f "$fn")"
  for var in PAPERCUSP_DHT_HOST PAPERCUSP_DHT_BOOTSTRAP; do
    if grep -q "${var}= " <<<"$body"; then
      ok "$fn force-empties ambient $var"
    else
      bad "$fn no longer force-empties ambient $var (P-002 layer-4 regression)"
    fi
  done
  if grep -q 'PAPERCUSP_BACKGROUND_WORKERS=1' <<<"$body"; then
    ok "$fn forces packaged federation background workers on"
  else
    bad "$fn no longer forces PAPERCUSP_BACKGROUND_WORKERS=1 (WI-3350 regression)"
  fi
  # EI-15308: both local launchers set HOME="$home" to isolate the instance, but
  # serve.ts's PAPERCUSP_DIR = process.env.PAPERCUSP_HOME || homedir()+".papercusp"
  # PREFERS PAPERCUSP_HOME over that isolated HOME. Every su/dev shell carries
  # PAPERCUSP_HOME ambiently, so a launcher that doesn't `env -u` it collapses the
  # instance onto the caller's real shared operator home (cold-start lock/port
  # collision — "another `serve` holds the cold-start lock; aborting"), defeating
  # isolation. Same env-inheritance class as the DATABASE_URL family above.
  if grep -q -- '-u PAPERCUSP_HOME' <<<"$body"; then
    ok "$fn scrubs ambient PAPERCUSP_HOME (isolation-leak guard)"
  else
    bad "$fn no longer scrubs ambient PAPERCUSP_HOME (EI-15308 shared-home isolation-leak regression)"
  fi
  if [ "$fn" = fed_local_launch_sidecar ] \
    && grep -q -- '-u GH_TOKEN' <<<"$body" \
    && grep -q -- '-u GITHUB_TOKEN' <<<"$body"; then
    ok "$fn scrubs ambient GitHub credential variables"
  elif [ "$fn" = fed_local_launch_sidecar ]; then
    bad "$fn no longer scrubs ambient GH_TOKEN/GITHUB_TOKEN (EI-20241165263819645)"
  fi
  if [ "$fn" = fed_local_launch_sidecar ] \
    && grep -q 'PAPERCUSP_PARENT_DEATH_WATCH=0' <<<"$body"; then
    ok "$fn opts out of the desktop parent-death watch for detached headless sidecars (EI-21255273747013942)"
  elif [ "$fn" = fed_local_launch_sidecar ]; then
    bad "$fn no longer opts out of PAPERCUSP_PARENT_DEATH_WATCH for detached headless sidecars (EI-21255273747013942)"
  fi
done

# WI-22048803455221383: the VM federation driver must exercise the packaged
# Server role, never the GUI/X shell. In --vms=1 mode the host half must use
# the same extracted Server sidecar helper as the local federation smokes, with
# two independently selected ports.
vm_federation_file="$DIR/../vm-federation.sh"
vm_launch_body="$(awk '/^launch_vm_instance\(\)/{p=1} p{print} p&&/^}$/{exit}' "$vm_federation_file")"
local_launch_body="$(awk '/^launch_local_instance\(\)/{p=1} p{print} p&&/^}$/{exit}' "$vm_federation_file")"
if grep -qF '/usr/bin/papercusp-server --headless-service' <<<"$vm_launch_body" \
  && grep -qF 'PAPERCUSP_SIDECAR_DIR=' <<<"$vm_launch_body" \
  && grep -qF 'PAPERCUSP_PORT=' <<<"$vm_launch_body" \
  && grep -qF 'PAPERCUSP_EMBEDDED_PG_ROOT=' <<<"$vm_launch_body" \
  && grep -qF 'export HOME="$home"' <<<"$vm_launch_body" \
  && ! grep -qE 'xdpyinfo|DISPLAY=|/usr/bin/papercusp-desktop' <<<"$vm_launch_body"; then
  ok "vm-federation launches the packaged Server headless-service with explicit isolated state (WI-22048803455221383)"
else
  bad "vm-federation still launches the GUI/X path or omits an explicit Server state contract (WI-22048803455221383)"
fi
if grep -qF 'fed_local_launch_sidecar' <<<"$local_launch_body" \
  && ! grep -qF 'fed_local_launch "' <<<"$local_launch_body" \
  && grep -qF 'FED_LOCAL_HONO[a]=' "$vm_federation_file" \
  && grep -qF 'FED_LOCAL_PG[a]=' "$vm_federation_file" \
  && grep -qF 'fed_pick_free_port' "$vm_federation_file" \
  && grep -qF 'PAPERCUSP_GITHUB_LOGIN=' <<<"$local_launch_body"; then
  ok "vm-federation --vms=1 uses the extracted Server sidecar with distinct ports and account selection (WI-22048803455221383)"
else
  bad "vm-federation --vms=1 can regress to GUI/X launch or collide local sidecar ports (WI-22048803455221383)"
fi

# WI-40905: credentialed attestation preflight must not inherit the operator's
# ambient HOME; gh/npx and encrypted-key fallback state stay account-scoped.
if grep -q 'HOME="\$identity_dir"' "$DIR/federation-asserts.sh"; then
  ok "attestation preflight scopes HOME to the account identity directory (WI-40905)"
else
  bad "attestation preflight inherits ambient HOME (WI-40905 cross-account identity leak)"
fi
verified_attestation_call="$(
  sed -n '/const verified = await verifyAttestation/,/});/p' "$DIR/federation-asserts.sh"
)"
if grep -q 'token,' <<<"$verified_attestation_call"; then
  ok "attestation preflight reuses its validated token for final candidate verification (WI-40905)"
else
  bad "attestation preflight drops its validated token before final candidate verification (WI-40905)"
fi


# Every committed caller that needs a distinct identity must pass only the
# account selector. The launch helper rejects legacy token assignments, and
# this static guard makes that migration failure obvious before a live drill.
for account_launcher in \
  "$DIR/../two-instance-content-matrix-smoke.sh" \
  "$DIR/../two-instance-hive-directory-smoke.sh" \
  "$DIR/../two-instance-merge-smoke.sh" \
  "$DIR/../work-distribution-drill.sh"; do
  if grep -q 'PAPERCUSP_GITHUB_LOGIN=' "$account_launcher"; then
    ok "$(basename "$account_launcher") selects sidecar identity without a credential env var"
  else
    bad "$(basename "$account_launcher") lacks PAPERCUSP_GITHUB_LOGIN account selection"
  fi
done

# WI-38376 P-002: the writer-progress high-water rides periodic signed announce
# re-flushes. Pin the rig-only 15s default AND both launch paths: setup and
# restart each need the outer SSH handoff plus the inner sidecar env assignment.
# Extract function bodies so two duplicate tokens elsewhere cannot false-green
# a missing restart wire.
RIG_LIB_FILE="$DIR/deb-hetzner-rig.sh"
rig_setup_body="$(awk '/^rig_setup_frame\(\)/{p=1} p{print} p&&/^}$/{exit}' "$RIG_LIB_FILE")"
rig_restart_body="$(awk '/^rig_restart_sidecar\(\)/{p=1} p{print} p&&/^}$/{exit}' "$RIG_LIB_FILE")"
if grep -q 'RIG_ANNOUNCE_REFLUSH_MS="${RIG_ANNOUNCE_REFLUSH_MS:-15000}"' "$RIG_LIB_FILE" \
  && grep -q "RIG_ANNOUNCE_REFLUSH='" <<<"$rig_setup_body" \
  && grep -q 'PAPERCUSP_ANNOUNCE_REFLUSH_MS=' <<<"$rig_setup_body" \
  && grep -q "RIG_ANNOUNCE_REFLUSH='" <<<"$rig_restart_body" \
  && grep -q 'PAPERCUSP_ANNOUNCE_REFLUSH_MS=' <<<"$rig_restart_body"; then
  ok "deb rig applies the 15s announce re-flush heartbeat on initial launch and restart (WI-38376)"
else
  bad "deb rig no longer carries the 15s announce re-flush through BOTH initial and restart env blocks (WI-38376)"
fi

# 7b) EI-15308 (smoke-local copy): two-instance-hive-from-repo-smoke.sh's sc_launch
# is a script-local launcher (not in this sourced lib, so `declare -f` can't see
# it) that likewise sets HOME="$home". Static-grep it for the same PAPERCUSP_HOME
# scrub so the smoke's private launcher can't regress the isolation leak either.
SC_LAUNCH_FILE="$DIR/../two-instance-hive-from-repo-smoke.sh"
if grep -q -- '-u PAPERCUSP_HOME' "$SC_LAUNCH_FILE"; then
  ok "two-instance-hive-from-repo-smoke sc_launch scrubs ambient PAPERCUSP_HOME (EI-15308)"
else
  bad "two-instance-hive-from-repo-smoke sc_launch no longer scrubs PAPERCUSP_HOME (EI-15308 regression)"
fi
if grep -q 'fed_snapshot_sidecar_bundle "\$SIDECAR_SOURCE" "\$SIDECAR_SNAPSHOT"' "$SC_LAUNCH_FILE" \
  && grep -q 'SIDECAR_SRC="\$SIDECAR_SNAPSHOT"' "$SC_LAUNCH_FILE" \
  && grep -q 'PAPERCUSP_SMOKE_SIDECAR_LOCK_WAIT_SEC' "$SC_LAUNCH_FILE"; then
  ok "from-repo sidecar mode snapshots the shared build output before launching instances (EI-218)"
else
  bad "from-repo sidecar mode can still launch directly from the shared build output (EI-218)"
fi
if grep -q 'PAPERCUSP_PARENT_DEATH_WATCH=0' "$SC_LAUNCH_FILE"; then
  ok "two-instance-hive-from-repo-smoke sc_launch opts out of the desktop parent-death watch for detached headless sidecars (EI-21255273747013942)"
else
  bad "two-instance-hive-from-repo-smoke sc_launch no longer opts out of PAPERCUSP_PARENT_DEATH_WATCH for detached headless sidecars (EI-21255273747013942)"
fi

# 7c) WI-37222 — SUBSET-FAILURE HONESTY + EVIDENCE PRESERVATION.
# The from-repo smoke's core exit verdict covers the TWELVE CORE federation legs only; the WITNESS
# (C-001 re-key) / MODERATION / ATTESTATION subsets are scored as separate gate legs. That split is
# correct, but it had two teeth missing: a subset failure took the `exit 0` branch, so (a) the
# artifact's LAST line read `OVERALL: PASS ... proven end-to-end` on a run containing a C-001
# read-plane BREACH, and (b) the instance-log preservation never ran — deleting the frame serve.log
# that holds the ONLY copy of the rekey_boundary_* boot events (boot-history is in-memory only,
# EI-18655247267756605). That is why WI-37195 survived 5 consecutive gate reds un-root-caused: the
# harness destroyed the evidence for the breach it had just detected.
# Subject paths are env-overridable so falsifiability can be proven by the COPY-OUT mutation-probe
# tier (scripts/mutation-probe.sh) without ever mutating this shared tree.
FROMREPO_SMOKE_FILE="${PROBE_FROMREPO_SMOKE:-$DIR/../two-instance-hive-from-repo-smoke.sh}"
MATRIX_SMOKE_FILE="${PROBE_MATRIX_SMOKE:-$DIR/../two-instance-content-matrix-smoke.sh}"
GATE_FILE="${PROBE_GATE_FILE:-$DIR/../live-federation-gate.sh}"

# (i) Every subset verdict block that can print "<NAME> OVERALL: INCOMPLETE" must record that
# failure in the FAILED_SUBSETS accumulator. Anchored to the PROPERTY (one append per failure
# branch), NOT to the three subset names — so a fourth subset added later is covered automatically
# instead of silently escaping the guard.
subset_incomplete_n="$(grep -cE 'echo "[A-Z]+ OVERALL: INCOMPLETE' "$FROMREPO_SMOKE_FILE" 2>/dev/null || true)"
subset_recorded_n="$(grep -cE 'FAILED_SUBSETS="\$FAILED_SUBSETS ' "$FROMREPO_SMOKE_FILE" 2>/dev/null || true)"
if [ "${subset_incomplete_n:-0}" -gt 0 ] && [ "${subset_recorded_n:-0}" -ge "${subset_incomplete_n:-0}" ]; then
  ok "from-repo smoke records every subset failure in FAILED_SUBSETS ($subset_recorded_n appends >= $subset_incomplete_n INCOMPLETE branches, WI-37222)"
else
  bad "from-repo smoke has $subset_incomplete_n subset INCOMPLETE branch(es) but only $subset_recorded_n FAILED_SUBSETS append(s) — a subset failure will exit 0 silently and its instance logs will be DESTROYED (WI-37222)"
fi

# (ii) The core-PASS branch must ITSELF test FAILED_SUBSETS and preserve the instance logs.
# ⚠ This is deliberately SLICED to the pass-branch region, not grepped file-wide. The first version
# of this guard grepped the whole file and SURVIVED its own mutation probe (replacing the pass
# branch's `if [ -n "${FAILED_SUBSETS:-}" ]` with `if false` left the guard green), because the
# else-branch carries the same two tokens — it matched a SPELLING that occurs twice rather than the
# PROPERTY that the PASS path consults the accumulator. Bind guards to the property, not the token.
# Fails CLOSED: if the region can't be sliced (the verdict block was restructured), it reports bad.
pass_branch="$(sed -n '/\$create_ok" = 1/,/^  exit 0$/p' "$FROMREPO_SMOKE_FILE" 2>/dev/null || true)"
if grep -q 'preserve_instance_logs' <<<"$pass_branch" \
  && grep -qE '\[ -n "\$\{FAILED_SUBSETS' <<<"$pass_branch"; then
  ok "from-repo smoke's core-PASS branch itself tests FAILED_SUBSETS and preserves instance logs (WI-37222)"
else
  bad "from-repo smoke's core-PASS branch no longer tests FAILED_SUBSETS / preserves instance logs — a subset failure exits 0 and the rekey_boundary_* boot events that diagnose a K2 epoch 0→0 are DESTROYED on exit (WI-37222)"
fi

# (iii) The gate's CORE-leg verdict pattern must be ANCHORED. Unanchored, `OVERALL: PASS` also
# matches `WITNESS OVERALL: PASS` / `MODERATION OVERALL: PASS` / `ATTESTATION OVERALL: PASS`, so a
# run whose core legs FAILED scores the core leg green off a subset's line — a false GREEN on the
# release gate. The subset legs are scored separately by design and must never stand in for it.
if grep -qE "grep -qaE 'OVERALL: PASS'" "$GATE_FILE"; then
  bad "live-federation-gate run_smoke matches a BARE 'OVERALL: PASS' — a subset verdict line satisfies the CORE leg's verdict (WI-37222). Anchor it: '^OVERALL: PASS'"
else
  ok "live-federation-gate core-leg verdict pattern is anchored so subset lines cannot satisfy it (WI-37222)"
fi

# WI-40008 detector integrity: early from-repo failures must bank their serve
# logs from the EXIT path, and the gate must provide a per-run destination.
if grep -q 'bank_instance_logs' "$FROMREPO_SMOKE_FILE" \
  && grep -q 'PAPERCUSP_SMOKE_LOG_BANK_DIR=' "$GATE_FILE"; then
  ok "from-repo smoke banks instance logs on the shared EXIT path, including pre-verdict failures (WI-40008)"
else
  bad "from-repo smoke/gate no longer wires PAPERCUSP_SMOKE_LOG_BANK_DIR through the EXIT cleanup — early boot/create failures will delete their only frame logs (WI-40008)"
fi

# WI-10003237: the SAME class in the content-matrix smoke. Its EXIT trap's
# fed_cleanup_scoped rm -rf's the pair dir, so the banking must run INSIDE the trap and
# BEFORE the cleanup (order checked on the trap line itself), and the gate must hand the
# content-matrix leg its own destination — the from-repo wiring above does not cover it.
if grep -qE "^trap '.*bank_instance_logs.*fed_cleanup_scoped" "$MATRIX_SMOKE_FILE" \
  && grep -q 'PAPERCUSP_SMOKE_LOG_BANK_DIR="$WORK/pair-logs-content-matrix"' "$GATE_FILE" \
  && grep -q 'membership-fatal.diag' "$MATRIX_SMOKE_FILE"; then
  ok "content-matrix smoke banks serve logs + the membership-fatal diag on its EXIT path before cleanup, and the gate wires its bank dir (WI-10003237)"
else
  bad "content-matrix smoke/gate no longer banks serve logs before fed_cleanup_scoped (or lost the membership-fatal diag) — an early content-matrix FATAL deletes its only evidence again (WI-10003237)"
fi

# 8) Route-cutover guard (WI-2929): the live federation driver runs against the
# current pot route. A stale /hives/from-repo call hard-404s on current packaged
# binaries before the matrix can exercise federation at all.
# WI-3350: the join route likewise moved to /api/discovery/join-pot; stale
# /join-hive curls hard-404 during the content-matrix B-join step.
ROUTE_FILES=(
  "$DIR/federation-asserts.sh"
  "$DIR/../two-instance-content-matrix-smoke.sh"
  "$DIR/../two-instance-hive-from-repo-smoke.sh"
  "$DIR/../deb-hetzner-fast-iterate.sh"
  "$DIR/deb-hetzner-rig.sh"
  "$DIR/../work-distribution-drill.sh"
)
route_bad=0
for file in "${ROUTE_FILES[@]}"; do
  if grep -q 'hives/from-repo' "$file"; then
    bad "$(basename "$file") still references retired hives/from-repo route"
    route_bad=1
  fi
  if grep -Eq 'curl .*/api/discovery/join-hive' "$file"; then
    bad "$(basename "$file") still curls retired discovery/join-hive route"
  fi
  # mig-557 lexicon sweep: /api/discovery/hives → /api/discovery/pots. The old
  # route 404s {"error":"not_found"} on current builds and red-fails the whole
  # discovery leg (caught live 2026-07-16 — the from-repo smoke's B poll).
  if grep -Eq 'curl .*/api/discovery/hives' "$file"; then
    bad "$(basename "$file") still curls retired discovery/hives route (renamed /api/discovery/pots)"
    route_bad=1
  fi
done
if [ "$route_bad" = 0 ]; then
  ok "live federation scripts use current pots/from-repo and discovery/join-pot routes"
fi

# 8) Packaged-deb discovery guard (WI-3344): after the GUI/Server product split,
# Linux artifacts are named "Papercusp GUI_..._amd64.deb". A stale
# Papercusp_0.0.2_amd64.deb default made the live gate file content-matrix REDs
# before the smoke even extracted a package. The gate must ignore missing explicit
# overrides, and the direct smoke must not keep the retired filename as its default.
gate_file="$DIR/../live-federation-gate.sh"
matrix_file="$DIR/../two-instance-content-matrix-smoke.sh"
from_repo_file="$DIR/../two-instance-hive-from-repo-smoke.sh"
hive_git_drill_file="$DIR/../hive-git-drill.sh"
verify_file="$DIR/../verify-sidecar-bundle.sh"

# D-084 / EI-214124 recurrence guard. The generic 600-second pc-heavy lease is
# intentionally shorter than an exclusive materializer's 900-second drain. It therefore
# must cover only the first real federation leg, never selftests/build/repack. The live
# failure this guards started the lease while build.log was still advancing and reached
# content-matrix with less than three minutes left. Require exactly one publication call,
# inside the non-skipped content-matrix branch and after the post-repack boundary.
ready_call_lines="$(grep -nE '^[[:space:]]*gate_preempt_protect_until_first_verdict[[:space:]]*$' "$gate_file" | cut -d: -f1 || true)"
ready_call_count="$(printf '%s\n' "$ready_call_lines" | awk 'NF { n += 1 } END { print n + 0 }')"
ready_call_line="$(printf '%s\n' "$ready_call_lines" | head -1)"; ready_call_line="${ready_call_line:-0}"
post_repack_line="$(grep -nF 'memory_phase_guard "post-repack/pre-smokes"' "$gate_file" | head -1 | cut -d: -f1 || true)"; post_repack_line="${post_repack_line:-0}"
matrix_branch_line="$(grep -nF 'if [ "$SKIP_MATRIX" != 1 ]; then' "$gate_file" | head -1 | cut -d: -f1 || true)"; matrix_branch_line="${matrix_branch_line:-0}"
matrix_run_line="$(grep -nF 'run_smoke content-matrix' "$gate_file" | head -1 | cut -d: -f1 || true)"; matrix_run_line="${matrix_run_line:-0}"
ready_release_line="$(grep -nE '^[[:space:]]*gate_preempt_release_after_first_verdict[[:space:]]*$' "$gate_file" | head -1 | cut -d: -f1 || true)"; ready_release_line="${ready_release_line:-0}"
if [ "$ready_call_count" -eq 1 ] \
  && [ "$ready_call_line" -gt "$post_repack_line" ] \
  && [ "$ready_call_line" -gt "$matrix_branch_line" ] \
  && [ "$ready_call_line" -lt "$matrix_run_line" ] \
  && [ "$ready_release_line" -gt "$matrix_run_line" ]; then
  ok "live-federation-gate spends its bounded after-ready lease only around content-matrix, after build/repack (EI-214124)"
else
  bad "live-federation-gate after-ready boundary drifted (calls=$ready_call_count ready=$ready_call_line post-repack=$post_repack_line matrix-if=$matrix_branch_line matrix-run=$matrix_run_line release=$ready_release_line; EI-214124)"
fi

if grep -qF 'desktop_head="$(cd "$DESKTOP_DIR" 2>/dev/null && git rev-parse --short HEAD' "$gate_file" \
  && grep -qF '"desktop_head":"%s"' "$gate_file" \
  && grep -qF '"$head" "$desktop_head"' "$gate_file" \
  && grep -qF '"$invoker" "$$"' "$gate_file"; then
  ok "live-federation-gate verdicts bank the executed Desktop submodule SHA beside the operator-parent head (WI-40958)"
else
  bad "live-federation-gate verdict provenance cannot identify the executed Desktop script/driver bytes (WI-40958)"
fi

# WI-40958 behavioral guard: exercise the real verdict writer through its cheap
# FRESH exit. Explicitly neutralize an inherited GATE_FORCE from an outer live
# gate so this hermetic probe can never fall through into build/GitHub work.
verdict_state="$WORK/verdict-state"
verdict_log="$verdict_state/verdicts.jsonl"
mkdir -p "$verdict_state"
date +%s >"$verdict_state/last-green"
# A real outer gate runs this self-test while holding pc-heavy's unique after-ready marker.
# The nested FRESH probe is not a new protected gate run and must never inherit/re-publish
# that parent-owned path. Seed an occupied marker to make the regression deterministic, then
# explicitly scrub it for the nested process while retaining PC_HEAVY_BYPASS from the parent.
inherited_ready_marker="$WORK/inherited-pc-heavy-ready"
printf '%s\n' "parent-$$" >"$inherited_ready_marker"
if (
  export PC_HEAVY_PREEMPT_READY_FILE="$inherited_ready_marker"
  # This is already the nested, synthetic FRESH probe—not a new heavy gate run.
  # Without the explicit bypass, an ordinary `npm test` invocation re-enrols here
  # and can wait the production pc-heavy timeout before reading synthetic last-green.
  PC_HEAVY_BYPASS=1 PC_HEAVY_PREEMPT_AFTER_READY=0 PC_HEAVY_PREEMPT_READY_FILE= \
    GATE_FORCE=0 GATE_SUCCESS_TTL_H=22 GATE_STATE_DIR="$verdict_state" \
    GATE_VERDICT_LOG="$verdict_log" GATE_NO_FILE=1 GATE_SKIP_SELFTEST=1 \
    bash "$gate_file"
) >"$WORK/verdict-fresh.out" 2>&1; then
  banked_desktop_head="$(python3 -c 'import json,sys; print(json.loads(open(sys.argv[1], encoding="utf-8").read().splitlines()[-1])["desktop_head"])' "$verdict_log" 2>/dev/null)"
  expected_desktop_head="$(git -C "$DIR/.." rev-parse --short HEAD 2>/dev/null)"
  if [ -n "$banked_desktop_head" ] \
    && [ "$banked_desktop_head" = "$expected_desktop_head" ] \
    && git -C "$DIR/.." cat-file -e "$banked_desktop_head:bin/live-federation-gate.sh" 2>/dev/null; then
    ok "banked desktop_head resolves to the commit containing the executed live-federation-gate.sh (WI-40958)"
  else
    bad "banked desktop_head '$banked_desktop_head' does not resolve to executed Desktop HEAD '$expected_desktop_head' (WI-40958)"
  fi
else
  verdict_probe_rc=$?
  bad "isolated live-federation-gate FRESH probe failed before banking desktop_head (rc=$verdict_probe_rc, WI-40958); nested output follows"
  # WI-40905: this probe once red-pinned the outer standing gate, but the EXIT
  # cleanup removed $WORK and took the only causal output with it. A later
  # exact-byte/exact-env rerun passed, leaving no honest root-cause diagnosis.
  # Copy the bounded nested output into this self-test's stdout so gate_selftest
  # persists it in the outer run's durable selftest.log before cleanup.
  sed 's/^/    | /' "$WORK/verdict-fresh.out" 2>/dev/null || \
    echo "    | <nested verdict-fresh.out missing>"
fi
if grep -q 'fed_snapshot_shell_script "$smoke_source" "$smoke_snapshot"' "$gate_file" \
  && grep -q 'bash "$smoke_snapshot"' "$gate_file" \
  && grep -qF 'DESKTOP_DIR="${DESKTOP_DIR:-' "$matrix_file" \
  && grep -qF 'DESKTOP_DIR="${DESKTOP_DIR:-' "$from_repo_file"; then
  ok "live-federation-gate snapshots both mutable child smokes and injects canonical DESKTOP_DIR (EI-21235839358679656)"
else
  bad "live-federation-gate can execute a long child smoke directly from the mutable tree (EI-21235839358679656)"
fi
if grep -q 'fed_snapshot_shell_script "$__source" "$__snapshot"' "$gate_file" \
  && grep -q 'bash "$__snapshot"' "$gate_file" \
  && grep -qF '__snapshot="$WORK/gate-selftest-snapshot-$__script"' "$gate_file" \
  && grep -qF 'GATE_SELFTEST_LIB_DIR="$DESKTOP_DIR/bin/lib"' "$gate_file" \
  && ! grep -q 'bash "$DESKTOP_DIR/bin/lib/$__script"' "$gate_file"; then
  ok "live-federation-gate snapshots its own selftests immutably, outside the tracked tree, without changing dirname semantics (EI-21245861434158598 / EI-21266614790118256)"
else
  bad "live-federation-gate can tear its selftest, move it away from required relative siblings, or snapshot it back inside the git-tracked bin/lib (EI-21245861434158598 / EI-21266614790118256)"
fi

# EI-21266614790118256 — BEHAVIORAL proof, not just the static grep above: a live
# gate_selftest() run must never place its snapshot inside the git-TRACKED bin/lib
# directory, even transiently. Desktop auto-commit 04226ec6 (WI-40905 verification)
# committed exactly such a transient dotfile before cleanup could remove it, leaving
# the submodule dirty. Exercise the REAL gate_selftest() against a slow fixture
# script inside a throwaway git repo and poll bin/lib for any new path while it
# runs; $WORK is a POSITIVE CONTROL proving the poll itself can see a snapshot file
# when one legitimately exists there (so a probe that saw neither would be a broken
# instrument, not a passing test).
gateselftest_snippet="$(awk '/^gate_selftest\(\)/{p=1} p{print} p&&/^}$/{exit}' "$gate_file")"
gs_snapshot_helper_snippet="$(declare -f fed_snapshot_shell_script)"
if [ -z "$gateselftest_snippet" ]; then
  bad "could not extract gate_selftest() from live-federation-gate.sh (structure changed — update this test)"
else
  GS_ROOT="$(mktemp -d /tmp/fed-selftest-gateselftest.XXXXXX)"
  GS_DESKTOP="$GS_ROOT/papercusp-desktop"
  mkdir -p "$GS_DESKTOP/bin/lib"
  (
    cd "$GS_DESKTOP" && git init -q && git config user.email t@t && git config user.name t
  ) >/dev/null 2>&1
  cat >"$GS_DESKTOP/bin/lib/slow-selftest.sh" <<'EOF'
#!/usr/bin/env bash
sleep 1
exit 0
EOF
  chmod +x "$GS_DESKTOP/bin/lib/slow-selftest.sh"
  ( cd "$GS_DESKTOP" && git add -A && git commit -q -m init ) >/dev/null 2>&1
  GS_WORK="$(mktemp -d /tmp/fed-selftest-gateselftest-work.XXXXXX)"
  GS_LOG="$GS_WORK/selftest.log"
  GS_TRACKED_SEEN="$GS_WORK/tracked-snapshot-seen"
  GS_UNTRACKED_SEEN="$GS_WORK/untracked-snapshot-seen"
  (
    DESKTOP_DIR="$GS_DESKTOP" WORK="$GS_WORK" bash -c "
log() { :; }
verdict() { :; }
$gs_snapshot_helper_snippet
$gateselftest_snippet
gate_selftest label slow-selftest.sh '$GS_LOG' broken
"
  ) >/dev/null 2>&1 &
  GS_PID=$!
  for _ in $(seq 1 60); do
    # Capture each producer to completion before matching: under `set -o pipefail`
    # a `| grep -q` consumer exits on the first line and SIGPIPEs the still-writing
    # `find`, so the pipeline reports 141 even though the match succeeded and the
    # marker below is never written — turning a real match into a false miss.
    [ -n "$(find "$GS_DESKTOP/bin/lib" -mindepth 1 -maxdepth 1 -name '.gate-selftest-snapshot-*' 2>/dev/null)" ] && : >"$GS_TRACKED_SEEN"
    [ -n "$(find "$GS_WORK" -mindepth 1 -maxdepth 1 -name 'gate-selftest-snapshot-*' 2>/dev/null)" ] && : >"$GS_UNTRACKED_SEEN"
    kill -0 "$GS_PID" 2>/dev/null || break
    sleep 0.05
  done
  wait "$GS_PID" 2>/dev/null
  if [ ! -e "$GS_TRACKED_SEEN" ] && [ -e "$GS_UNTRACKED_SEEN" ]; then
    ok "gate_selftest never places a snapshot inside the git-tracked bin/lib directory (EI-21266614790118256)"
  elif [ -e "$GS_TRACKED_SEEN" ]; then
    bad "gate_selftest wrote a snapshot INSIDE the git-tracked bin/lib directory — an auto-commit sweep can commit it (EI-21266614790118256)"
  else
    bad "gate_selftest regression probe never observed a snapshot file anywhere — poll window too short or fixture broken; this probe cannot be trusted as written (EI-21266614790118256)"
  fi
  rm -rf "$GS_ROOT" "$GS_WORK"
fi
if grep -q 'fed_capture_nonempty_with_retry' "$matrix_file" \
  && grep -q 'membership-persistence=PASS' "$matrix_file"; then
  ok "content-matrix waits for the authoritative asynchronous pot_members projection (EI-21237890330979066)"
else
  bad "content-matrix still treats pot_members as synchronous immediately after join-pot (EI-21237890330979066)"
fi
if grep -q 'fed_preflight_attestation_account "$1" "$2" "$REPO_DIR" "$MACHINE_IDENTITY_DIR"' "$matrix_file" \
  && grep -q 'fed_preflight_attestation_account "$P_A_USER" "$A_TOKEN" "$DESKTOP_DIR/.." "$A_IDENTITY_DIR"' "$from_repo_file" \
  && grep -q 'fed_preflight_attestation_account "$P_B_USER" "$B_TOKEN" "$DESKTOP_DIR/.." "$B_IDENTITY_DIR"' "$from_repo_file" \
  && [ "$(grep -c 'PAPERCUSP_IDENTITY_DIR="\$[AB]_IDENTITY_DIR"' "$from_repo_file")" -ge 4 ] \
  && [ "$(grep -c 'PAPERCUSP_GITHUB_LOGIN="$P_[AB]_USER"' "$from_repo_file")" -ge 4 ]; then
  ok "both live smokes share full attestation preflight and durable per-GitHub identity bindings (EI-21239383769017696)"
else
  bad "from-repo smoke can still launch fresh identities without full attestation proof + durable binding (EI-21239383769017696)"
fi
if grep -q 'A_IDENTITY_DIR=".*MACHINE_IDENTITY_DIR/\$P_A_USER' "$from_repo_file" \
  && grep -q 'B_IDENTITY_DIR=".*MACHINE_IDENTITY_DIR/\$P_B_USER' "$from_repo_file"; then
  ok "from-repo smoke isolates durable per-account identity roots (WI-40905)"
else
  bad "from-repo smoke shares an identity root across accounts (WI-40905 cross-instance Hive-key regression)"
fi
if grep -q 'A_IDENTITY_DIR="$(readlink -m -- "\$A_IDENTITY_DIR")"' "$from_repo_file" \
  && grep -q 'B_IDENTITY_DIR="$(readlink -m -- "\$B_IDENTITY_DIR")"' "$from_repo_file" \
  && grep -q '\[ "\$A_IDENTITY_DIR" != "\$B_IDENTITY_DIR" \]' "$from_repo_file"; then
  ok "from-repo smoke fails closed when resolved A/B identity roots are equal (WI-40905)"
else
  bad "from-repo smoke lacks a resolved A!=B identity-root admission guard (WI-40905)"
fi
# WI-40905 / WI-38088 sibling recurrence: sharing the durable device-identity
# directory must not collapse the two local processes onto one persisted
# Hyperswarm Noise identity. Pin both distinct defaults and every deb/sidecar
# launch path so an omitted branch cannot leave DHT healthy while all peer and
# directory channels stay at zero.
if grep -q 'FROMREPO_SWARM_ID_A="${PAPERCUSP_FROM_REPO_SWARM_ID_A:-fromrepo-$P_A_USER-a}"' "$from_repo_file" \
  && grep -q 'FROMREPO_SWARM_ID_B="${PAPERCUSP_FROM_REPO_SWARM_ID_B:-fromrepo-$P_B_USER-b}"' "$from_repo_file" \
  && [ "$(grep -c 'PAPERCUSP_SWARM_IDENTITY_ID="$FROMREPO_SWARM_ID_A"' "$from_repo_file")" -ge 2 ] \
  && [ "$(grep -c 'PAPERCUSP_SWARM_IDENTITY_ID="$FROMREPO_SWARM_ID_B"' "$from_repo_file")" -ge 2 ]; then
  ok "from-repo smoke gives A/B distinct persisted Hyperswarm transport identities on every launch path (WI-40905/WI-38088)"
else
  bad "from-repo smoke can give A/B the same machine-scoped Hyperswarm identity and prevent self-peering (WI-40905/WI-38088)"
fi
if grep -q 'does not exist — ignoring stale override' "$gate_file"; then
  ok "live-federation-gate ignores a missing GATE_DEB override instead of feeding it to the smoke"
else
  bad "live-federation-gate no longer guards missing GATE_DEB overrides (WI-3344 regression)"
fi
if grep -q 'fresh sidecar build failed — refusing to run content-matrix/from-repo against fallback stale artifacts' "$gate_file" \
  && grep -q '^  SKIP_MATRIX=1$' "$gate_file" \
  && grep -q '^  SKIP_FROMREPO=1$' "$gate_file"; then
  ok "live-federation-gate fails closed on a sidecar build error instead of testing fallback stale artifacts (WI-40008)"
else
  bad "live-federation-gate can still run consumer legs after FAIL_BUILD=1 — an empty GATE_DEB will silently select a stale .deb/sidecar and forge secondary reds (WI-40008)"
fi
# WI-40905: GUI and Server artifacts intentionally share the Papercusp*.deb
# filename family. A filename-only newest-file selector repacked papercusp-server
# and handed it to the GUI content matrix. Pin the live call and the executable
# guard, then exercise the shared selector below with real synthetic packages.
if grep -q 'fed_select_newest_deb_by_package papercusp-gui' "$gate_file" \
  && grep -q 'test -x pkg/usr/bin/papercusp-desktop' "$gate_file"; then
  ok "live-federation-gate selects a Debian GUI package by writer-owned identity and verifies its desktop executable (WI-40905)"
else
  bad "live-federation-gate can select/repack a non-GUI Papercusp Debian artifact for the GUI content matrix (WI-40905)"
fi
if grep -qF 'fed_extract_deb "$DEB" "$PKG" papercusp-server' "$hive_git_drill_file"; then
  ok "hive-git drill explicitly admits the Server role binary instead of assuming a GUI package (WI-3496)"
else
  bad "hive-git drill can reject the canonical Server release artifact through the GUI-default extractor (WI-3496)"
fi
if command -v dpkg-deb >/dev/null 2>&1; then
  DEB_FIXTURE="$WORK/deb-selector"
  mkdir -p "$DEB_FIXTURE"
  make_selector_deb() {
    local output="$1" package="$2" binary="$3" root appdir
    root="$DEB_FIXTURE/root-$package"
    rm -rf "$root"
    case "$binary" in
      papercusp-desktop) appdir='Papercusp GUI' ;;
      papercusp-server) appdir='Papercusp Server' ;;
      *) appdir='Papercusp Test' ;;
    esac
    mkdir -p "$root/DEBIAN" "$root/usr/bin" "$root/usr/lib/$appdir/sidecar"
    printf 'Package: %s\nVersion: 1.0.0\nArchitecture: amd64\nMaintainer: Papercusp Test <test@example.invalid>\nDescription: selector fixture\n' \
      "$package" >"$root/DEBIAN/control"
    printf '#!/usr/bin/env bash\nexit 0\n' >"$root/usr/bin/$binary"
    chmod +x "$root/usr/bin/$binary"
    : >"$root/usr/lib/$appdir/sidecar/.fixture"
    dpkg-deb -b "$root" "$output" >/dev/null
  }
  GUI_DEB="$DEB_FIXTURE/Papercusp_GUI_older_amd64.deb"
  SERVER_DEB="$DEB_FIXTURE/Papercusp_Server_newer_amd64.deb"
  make_selector_deb "$GUI_DEB" papercusp-gui papercusp-desktop
  make_selector_deb "$SERVER_DEB" papercusp-server papercusp-server
  if fed_extract_deb "$GUI_DEB" "$DEB_FIXTURE/gui-extract" >"$DEB_FIXTURE/gui-extract.out" 2>&1; then
    ok "deb extractor keeps papercusp-desktop as the fail-closed default role"
  else
    bad "deb extractor rejected a valid GUI package: $(cat "$DEB_FIXTURE/gui-extract.out")"
  fi
  if fed_extract_deb "$SERVER_DEB" "$DEB_FIXTURE/server-extract" papercusp-server >"$DEB_FIXTURE/server-extract.out" 2>&1; then
    ok "deb extractor accepts a Server package only when the caller explicitly selects papercusp-server (WI-3496)"
  else
    bad "deb extractor rejected an explicitly selected Server package: $(cat "$DEB_FIXTURE/server-extract.out")"
  fi
  if fed_extract_deb "$SERVER_DEB" "$DEB_FIXTURE/server-as-gui" >"$DEB_FIXTURE/server-as-gui.out" 2>&1; then
    bad "deb extractor accepted a Server package through the GUI-default role"
  elif grep -qF 'binary missing in .deb:' "$DEB_FIXTURE/server-as-gui.out" \
    && grep -qF '/usr/bin/papercusp-desktop' "$DEB_FIXTURE/server-as-gui.out"; then
    ok "deb extractor still fails closed when a Server artifact reaches a GUI-only caller"
  else
    bad "deb extractor rejected a Server-as-GUI package without the expected role diagnostic: $(cat "$DEB_FIXTURE/server-as-gui.out")"
  fi
  touch -t 202608230800 "$GUI_DEB"
  touch -t 202608230801 "$SERVER_DEB"
  selected_deb="$(fed_select_newest_deb_by_package papercusp-gui "$GUI_DEB" "$SERVER_DEB" 2>"$DEB_FIXTURE/select.err")"
  if [ "$selected_deb" = "$GUI_DEB" ]; then
    ok "deb selector keeps the older GUI package when a newer Server package exists (WI-40905)"
  else
    bad "deb selector chose '$selected_deb' instead of older GUI '$GUI_DEB' with newer Server present (WI-40905)"
  fi
  if no_gui_diag="$(fed_select_newest_deb_by_package papercusp-gui "$SERVER_DEB" 2>&1)"; then
    bad "deb selector accepted a Server-only candidate set for the GUI content matrix (WI-40905)"
  elif grep -qF 'no Debian package with Package=papercusp-gui' <<<"$no_gui_diag"; then
    ok "deb selector fails closed with an explicit diagnostic when no GUI package exists (WI-40905)"
  else
    bad "deb selector rejected a Server-only set without the required no-GUI diagnostic: $no_gui_diag (WI-40905)"
  fi
else
  ok "deb selector behavior test skipped: dpkg-deb unavailable on this host"
fi
# EI-20580419609576585: the .deb REPACK produces $GATE_DEB, and $GATE_DEB is what the gate
# passes to local-matrix.sh as `--deb=`. Gating that repack on SKIP_MATRIX ALONE couples two
# unrelated things: the attestation wall sets SKIP_MATRIX=1 to force-skip the two GITHUB legs,
# and thereby also starves the attestation-INDEPENDENT local-matrix leg of its artifact. With
# no --deb that leg falls back to its implicit newest-bundle pick and hard-fails common.sh's
# staleness guard — AFTER provisioning frames and evicting 24 exclusive host cores, executing
# ZERO scenarios. Measured 2026-08-16 on three consecutive forced runs. The wall's own design
# comment says it runs local-matrix precisely BECAUSE that leg is attestation-independent, so
# this coupling silently defeats the wall's stated intent.
# Anchored to the PROPERTY — the guard enclosing the repack must consult the local-matrix
# admission predicate — not to the exact condition text, so a reworded but correct guard passes.
# Pattern tolerates repack FLAGS changing (e.g. -Zgzip added since this guard was
# written) — anchored to "repacks pkg/ into $GATE_DEB", not the exact flag set,
# for the same reason the guard-consult check below is anchored to a property.
repack_ln="$(grep -nE 'dpkg-deb[^|]* -b pkg "\$GATE_DEB"' "$gate_file" | head -1 | cut -d: -f1)"
if [ -z "$repack_ln" ]; then
  bad "live-federation-gate no longer contains the .deb repack (dpkg-deb ... -b pkg \"\$GATE_DEB\") — the EI-20580419609576585 guard cannot verify anything"
else
  repack_guard="$(head -n "$repack_ln" "$gate_file" | grep -n '^  if \[ ' | tail -1 | cut -d: -f2-)"
  if grep -q 'local_matrix_due' <<<"$repack_guard"; then
    ok "live-federation-gate repacks the .deb whenever a consumer leg is due, not on SKIP_MATRIX alone (EI-20580419609576585)"
  else
    bad "live-federation-gate's .deb repack no longer consults local_matrix_due — the attestation wall will starve the local-matrix leg of --deb, and it will die on the staleness guard after provisioning frames + evicting 24 cores (EI-20580419609576585)"
  fi
  # EI-23005428051787372: the gate .deb is a throwaway, but a DEFAULT-level compressor (bare
  # -Zgzip = gzip -9, the xz default, the dpkg zstd default) spends 25-60 single-core minutes
  # on the ~4.9GB sidecar tree, which every exact-SHA release certification waits behind.
  # Anchored to the PROPERTY (an explicit fast level or no compression), not one flag spelling.
  repack_line="$(sed -n "${repack_ln}p" "$gate_file")"
  if grep -qE -- '-Znone|-z[0-3]([^0-9]|$)' <<<"$repack_line"; then
    ok "live-federation-gate repacks the gate .deb at an explicit fast compression level (EI-23005428051787372)"
  else
    bad "live-federation-gate's .deb repack uses a default (slow) compression level — gzip -9 costs 25-60 single-core min per run and delays every release certification; pass -z1 (or -Znone) (EI-23005428051787372)"
  fi
fi
# EI-20578660332729593: local-matrix.sh must validate every cheap host-side precondition
# BEFORE the first state-creating step. Three inputs — the sidecar node binary, the .deb, and
# a frame's gh token — were each in turn discovered missing only AT THEIR POINT OF USE, every
# time after the frame image was built, containers provisioned and 24 exclusive host cores
# evicted, having executed ZERO scenarios. The first two were patched with their own bespoke
# earlier checks; this guard defends the CLASS fix (one preflight covering all of them) so the
# next such input does not become a fourth point-fix.
# Anchored to the ORDERING PROPERTY — the preflight call must precede every state-creating step
# by line number — not to the preflight's wording, so a rewritten but correctly-placed preflight
# passes and one relocated below provisioning fails.
lm_file="$DIR/../local-matrix.sh"
pf_call_ln="$(grep -n 'preflight_host_preconditions || exit 1' "$lm_file" | head -1 | cut -d: -f1)"
first_state_ln=""
for _pat in 'docker network create' 'docker build -q -t "\$IMAGE_TAG"' 'docker run -d --name "\$CN_A"'; do
  _ln="$(grep -n "$_pat" "$lm_file" | head -1 | cut -d: -f1)"
  [ -n "$_ln" ] || continue
  if [ -z "$first_state_ln" ] || [ "$_ln" -lt "$first_state_ln" ]; then first_state_ln="$_ln"; fi
done
if [ -z "$pf_call_ln" ] || [ -z "$first_state_ln" ]; then
  bad "local-matrix.sh: cannot locate the host preflight (line='$pf_call_ln') or the first state-creating step (line='$first_state_ln') — the EI-20578660332729593 ordering guard can verify nothing"
elif [ "$pf_call_ln" -ge "$first_state_ln" ]; then
  bad "local-matrix.sh runs its host preflight at line $pf_call_ln, AT OR BELOW the first state-creating step at line $first_state_ln — a missing sidecar/.deb/gh-token will again surface only after provisioning + 24-core eviction (EI-20578660332729593)"
else
  ok "local-matrix.sh validates host preconditions (line $pf_call_ln) before any state-creating step (line $first_state_ln) (EI-20578660332729593)"
fi
# Class coverage: the preflight must still check all three members, or it has decayed back
# toward point-fixes. `case` rather than a `grep -q` pipe on purpose — an early-exiting pipe
# consumer can report a false absence under pipefail (repo convention).
pf_body="$(sed -n '/^preflight_host_preconditions() {/,/^}/p' "$lm_file")"
missing_cover=""
case "$pf_body" in *'sidecar/bin/node'*) : ;; *) missing_cover="$missing_cover sidecar-node" ;; esac
case "$pf_body" in *'default_deb'*)      : ;; *) missing_cover="$missing_cover deb" ;; esac
case "$pf_body" in *'gh auth token'*)    : ;; *) missing_cover="$missing_cover gh-token" ;; esac
case "$pf_body" in *'gh api user'*)      : ;; *) missing_cover="$missing_cover gh-identity-auth" ;; esac
if [ -z "$missing_cover" ]; then
  ok "local-matrix.sh's host preflight covers the whole precondition class (sidecar node, .deb, authenticated gh identities)"
else
  bad "local-matrix.sh's host preflight no longer checks:$missing_cover — the class fix has decayed back toward point-fixes (EI-20578660332729593)"
fi
# The preflight probes a gh identity by name, so its default must track the one the run will
# actually register; a silent drift would validate a user nobody uses and skip the one that fails.
lm_b_default="$(grep -o 'P_B_USER:-[A-Za-z0-9_-]*' "$lm_file" | head -1)"
gate_b_default="$(grep -o 'P_B_USER:-[A-Za-z0-9_-]*' "$gate_file" | head -1)"
if [ -n "$lm_b_default" ] && [ "$lm_b_default" = "$gate_b_default" ]; then
  ok "local-matrix.sh's preflight frame-b identity default tracks live-federation-gate.sh (\${$lm_b_default})"
else
  bad "local-matrix.sh's preflight frame-b identity default ('$lm_b_default') has drifted from live-federation-gate.sh ('$gate_b_default') — the preflight would clear a gh user the run never registers while missing the one that aborts it (EI-20578660332729593)"
fi

if grep -q 'Papercusp\\ GUI_' "$gate_file" && grep -q 'Papercusp\\ GUI_' "$matrix_file"; then
  ok "live federation deb discovery includes the current 'Papercusp GUI' artifact name"
else
  bad "live federation deb discovery is missing the current 'Papercusp GUI' artifact glob"
fi
if grep -q 'Papercusp_0.0.2_amd64.deb' "$matrix_file"; then
  bad "content-matrix smoke still carries the retired Papercusp_0.0.2_amd64.deb default"
else
  ok "content-matrix smoke no longer carries the retired default deb filename"
fi
if grep -q 'OVERALL: PASS' "$matrix_file"; then
  ok "content-matrix smoke emits the OVERALL verdict live-federation-gate parses"
else
  bad "content-matrix smoke no longer emits OVERALL: PASS (live-federation-gate will mark it FAIL)"
fi
if grep -qF 'grep -acF "[swarm:unpaired] ⚠ topic ${ST:0:16}"' "$matrix_file" \
  && grep -q "harness_slug IN ('\$SLUG','\$HIVE_SLUG')" "$matrix_file"; then
  ok "content-matrix announce discriminator is scoped to the tested topic + harnesses (WI-40008)"
else
  bad "content-matrix announce discriminator is gate-wide — unrelated private topics can be misreported as the tested hive's pairing failure (WI-40008)"
fi

# D-030 / EI-20192345878553998: a matrix run uses two throwaway HOME dirs, but
# device identity must remain machine-scoped so an already-attested key is
# reused. The REAL ensureAttestationGist path must run before package extraction,
# otherwise an account unable to attest stays local-only and burns the full
# matrix timeout before emitting a misleading replication RED.
attest_line="$(grep -n 'preflight_attestation "\$P_A_USER"' "$matrix_file" | head -1 | cut -d: -f1)"
extract_line="$(grep -n 'log "extract \$DEB"' "$matrix_file" | head -1 | cut -d: -f1)"
if [ -n "$attest_line" ] && [ -n "$extract_line" ] && [ "$attest_line" -lt "$extract_line" ] \
  && grep -q 'fed_preflight_attestation_account "$1" "$2" "$REPO_DIR" "$MACHINE_IDENTITY_DIR"' "$matrix_file" \
  && grep -q 'ensureAttestationGist' "$DIR/federation-asserts.sh" \
  && grep -q 'verifyAttestation' "$DIR/federation-asserts.sh"; then
  ok "content-matrix proves the real device attestation before expensive package extraction (D-030)"
else
  bad "content-matrix no longer fail-fast proves real device attestation before package extraction (D-030)"
fi
if grep -q 'fed_preflight_attestation_account "$1" "$2" "$REPO_DIR" "$MACHINE_IDENTITY_DIR"' "$matrix_file" \
  && [ "$(grep -c 'PAPERCUSP_IDENTITY_DIR="\$MACHINE_IDENTITY_DIR"' "$matrix_file")" -ge 2 ]; then
  ok "content-matrix preflight and both sidecars share the durable machine identity directory (D-030)"
else
  bad "content-matrix fake HOMEs can mint run-scoped device keys instead of reusing machine identity (D-030)"
fi
# WI-38088: device identity sharing above must NOT collapse the two local
# processes onto one persisted Hyperswarm transport identity. Hyperswarm rejects
# a remote with its own Noise key, yielding zero peer_connected and an all-red
# matrix even though publish reports announced=true. The product-supported
# multi-process escape hatch must be distinct on the two launch lines.
if grep -q 'PAPERCUSP_SWARM_IDENTITY_ID="\$MATRIX_SWARM_ID_A"' "$matrix_file" \
  && grep -q 'PAPERCUSP_SWARM_IDENTITY_ID="\$MATRIX_SWARM_ID_B"' "$matrix_file" \
  && grep -q 'MATRIX_SWARM_ID_A="\${PAPERCUSP_MATRIX_SWARM_ID_A:-d030-\$P_A_USER-a}"' "$matrix_file" \
  && grep -q 'MATRIX_SWARM_ID_B="\${PAPERCUSP_MATRIX_SWARM_ID_B:-d030-\$P_B_USER-b}"' "$matrix_file"; then
  ok "content-matrix gives A/B distinct persisted Hyperswarm transport identities (WI-38088)"
else
  bad "content-matrix can give A/B the same machine-scoped Hyperswarm identity and prevent self-peering (WI-38088)"
fi
if grep -q 'D-030 requires two distinct GitHub accounts' "$matrix_file"; then
  ok "content-matrix refuses same-account A/B fallback instead of weakening admission coverage (D-030)"
else
  bad "content-matrix no longer refuses a same-account A/B configuration (D-030)"
fi

# WI-38136: a member project can be projected into BOTH the active workspace's
# registry and the joined Pot's real persistence workspace. An unordered
# harness_registry lookup by member slug selected the wrong row during a clean
# D-030 run, causing pot_members_pot_fkey SETUP-FAIL plus false B→A misses. Bind
# the post-join selector to the actual persisted Pot AND B-account membership.
ws_b_joined_block="$(sed -n '/^WS_B_JOINED=/,/^if \[ -n "\$WS_B_JOINED" \]/p' "$matrix_file" 2>/dev/null || true)"
if grep -q 'FROM harness_shared.pot_members m' <<<"$ws_b_joined_block" \
  && grep -q 'JOIN harness_shared.pots p' <<<"$ws_b_joined_block" \
  && grep -q "p.canonical_pot_home_slug = m.pot_home_slug" <<<"$ws_b_joined_block" \
  && grep -q "lower(m.github_username) = lower('\$P_B_USER')" <<<"$ws_b_joined_block"; then
  ok "content-matrix resolves B's post-join workspace from the persisted Pot + actual B membership (WI-38136)"
else
  bad "content-matrix post-join workspace selector is no longer bound to the persisted Pot + B account; duplicate registry projections can false-RED B→A (WI-38136)"
fi

# 8b) RED-EI dedup guard (2026-07-09, EI-8385-class fix): a prior version filed a BRAND
# NEW work_items:create bug on EVERY hourly RED run — no dedup key, and the title embeds a
# run timestamp so no similarity guard ever caught the duplicates — piling up 30+ open
# "live-federation-gate RED: content-matrix failed…" bugs for the SAME unresolved regression
# over 3 days (WI-3358..WI-3477+). The gate must suppress re-filing within RED_REFILE_H and
# clear the suppression marker on the next GREEN (never hide a real fix behind stale state).
if grep -q 'RED_MARKER="\$STATE_DIR/red-ei-filed"' "$gate_file" && grep -q 'red_marker_age_h' "$gate_file"; then
  ok "live-federation-gate dedups RED EI filings via a red-ei-filed marker"
else
  bad "live-federation-gate no longer dedups RED EI filings (duplicate-bug-storm regression)"
fi
if grep -q 'rm -f "\$STATE_DIR/stale-ei-filed" "\$STATE_DIR/red-ei-filed"' "$gate_file"; then
  ok "live-federation-gate clears the RED-EI marker on the next GREEN"
else
  bad "live-federation-gate no longer clears red-ei-filed on GREEN (would hide a real fix behind stale suppression)"
fi

# 8c) PASS-971 downgrade doesn't false-RED on a zero-match grep (2026-07-09 fix, the
# ACTUAL root cause behind WI-3358/WI-3477 — the RED-EI dedup above only masked the
# symptom). `grep -c PATTERN FILE || echo 0` ALWAYS prints a count (even "0") but exits
# 1 when that count is 0, so a zero-match run fired BOTH the printed "0" AND the
# `|| echo 0` fallback, leaving X_TOTAL/X_OTHER a two-line "0\n0" string that blew up
# `[ "$X_OTHER" -eq 0 ]` with "integer expression expected" (visible in journalctl) —
# so a content-matrix FAIL that fully qualified for the documented PASS-971 carve-out
# was left as a genuine RED on EVERY real run (all 3 checked 2026-07-09). Exercise the
# gate's actual downgrade snippet (not a re-implementation) against a synthetic
# zero-X_OTHER fixture and assert it downgrades cleanly with no stderr noise.
if grep -qE 'grep -ac.*\|\| echo 0' "$gate_file"; then
  bad "live-federation-gate downgrade logic still uses the 'grep -c ... || echo 0' double-output trap (false-RED regression)"
else
  DOWNGRADE_FIXTURE="$(mktemp /tmp/fed-selftest-downgrade.XXXXXX)"
  { echo '✓ B joined'; echo '  ✗ features         incr-B→A NEVER crossed (src outbox=1/1)'; } >"$DOWNGRADE_FIXTURE"
  downgrade_snippet="$(awk '/^  if \[ "\$MATRIX_RES" = FAIL \]/{p=1} p{print} p&&/^  fi$/{exit}' "$gate_file")"
  if [ -z "$downgrade_snippet" ]; then
    bad "could not extract the PASS-971 downgrade snippet from live-federation-gate.sh (structure changed — update this test)"
  else
    DOWNGRADE_STDERR="$(mktemp /tmp/fed-selftest-downgrade-stderr.XXXXXX)"
    downgrade_result="$(MATRIX_RES=FAIL WORK="$(dirname "$DOWNGRADE_FIXTURE")" bash -c "
      WORK_FILE='$DOWNGRADE_FIXTURE'
      $(echo "$downgrade_snippet" | sed "s#\"\$WORK/content-matrix.out\"#\"\$WORK_FILE\"#g")
      echo \"\$MATRIX_RES\"
    " 2>"$DOWNGRADE_STDERR")"
    if [ "$downgrade_result" = "PASS-971" ] && ! grep -q "integer expression expected" "$DOWNGRADE_STDERR"; then
      ok "PASS-971 downgrade handles a zero-X_OTHER run cleanly (no false-RED, no stderr noise)"
    else
      bad "PASS-971 downgrade false-RED regression: result='$downgrade_result' stderr='$(cat "$DOWNGRADE_STDERR")'"
    fi
    rm -f "$DOWNGRADE_STDERR"
  fi
  rm -f "$DOWNGRADE_FIXTURE"
fi
# 8d) run_smoke retries a BOOT-READINESS flake, not just a discovery flake (WI-3734,
# 2026-07-10): an EMPTY-body "create failed"/"B join failed" (fed_wait_api accepted a
# sidecar — incl. via its "legacy liberal accept" fallback — before it actually finished
# booting under load) used to fall through every retry check and kill the whole gate
# run on attempt 1. Exercise the ACTUAL run_smoke() function (not a re-implementation)
# against a synthetic "smoke script" stand-in that fails empty-body on its first
# invocation and passes on its second — assert it retries and returns PASS, and that a
# GENUINE (non-empty-body) failure is still NOT retried.
runsmoke_snippet="$(awk '/^run_smoke\(\)/{p=1} p{print} p&&/^}$/{exit}' "$gate_file")"
snapshot_helper_snippet="$(declare -f fed_snapshot_shell_script)"
if [ -z "$runsmoke_snippet" ]; then
  bad "could not extract run_smoke() from live-federation-gate.sh (structure changed — update this test)"
else
  # run_smoke does: ( cd "$DESKTOP_DIR/.." && bash "papercusp-desktop/bin/$script" ) — so
  # the fake layout needs an actual "papercusp-desktop/bin/" child under DESKTOP_DIR's
  # parent, with DESKTOP_DIR itself pointing at the "papercusp-desktop" dir (absolute,
  # so it's unambiguous regardless of cwd).
  RS_ROOT="$(mktemp -d /tmp/fed-selftest-runsmoke.XXXXXX)"
  RS_BIN_DIR="$RS_ROOT/papercusp-desktop/bin"; mkdir -p "$RS_BIN_DIR"
  RS_WORK="$(mktemp -d /tmp/fed-selftest-runsmoke-work.XXXXXX)"
  RS_COUNTER="$RS_WORK/calls"
  # attempt 1: empty-body create failure (the boot-readiness flake); attempt 2: PASS.
  # A marker-EXISTENCE test, deliberately not a `$(cat … || echo 0)` call counter:
  # that counter shape is exactly R1-permissive-coercion (a command-substitution-derived
  # value coerced on empty, then numerically asserted), which check-assert-integrity
  # scans this tree for and rejects. The fixture must not model the very anti-pattern the
  # rig lints against — and existence is all this stand-in ever needed, since nothing
  # reads the count. Same behaviour: first call fails empty-body, every later call PASSes,
  # and the `rm -f "$RS_COUNTER"` below still resets it between cases.
  cat >"$RS_BIN_DIR/flaky-then-pass.sh" <<EOF
#!/usr/bin/env bash
if [ -e "$RS_COUNTER" ]; then echo 'OVERALL: PASS'; else : >"$RS_COUNTER"; echo '✗ create failed: '; fi
EOF
  chmod +x "$RS_BIN_DIR/flaky-then-pass.sh"
  # a genuine (non-empty-body) failure must NOT retry — stays FAIL every attempt.
  cat >"$RS_BIN_DIR/genuine-fail.sh" <<'EOF'
#!/usr/bin/env bash
echo '✗ create failed: {"error":"duplicate hive slug"}'
EOF
  chmod +x "$RS_BIN_DIR/genuine-fail.sh"

  flaky_result="$(
    DESKTOP_DIR="$RS_ROOT/papercusp-desktop" WORK="$RS_WORK" DISCOVERY_ATTEMPTS=3 \
    bash -c "$(cat <<BASH
log() { :; }
$snapshot_helper_snippet
$runsmoke_snippet
run_smoke flaky flaky-then-pass.sh ""
BASH
)"
  )"
  rm -f "$RS_COUNTER"
  genuine_result="$(
    DESKTOP_DIR="$RS_ROOT/papercusp-desktop" WORK="$RS_WORK" DISCOVERY_ATTEMPTS=3 \
    bash -c "$(cat <<BASH
log() { :; }
$snapshot_helper_snippet
$runsmoke_snippet
run_smoke genuine genuine-fail.sh ""
BASH
)"
  )"
  if [ "$flaky_result" = PASS ]; then
    ok "run_smoke retries an empty-body create/join failure (boot-readiness flake) and recovers to PASS"
  else
    bad "run_smoke did not retry the empty-body boot-readiness flake: got '$flaky_result' (expected PASS on attempt 2)"
  fi
  if [ "$genuine_result" = FAIL ]; then
    ok "run_smoke does NOT retry a genuine (non-empty-body) create failure — stays FAIL"
  else
    bad "run_smoke incorrectly retried/passed a genuine create failure: got '$genuine_result' (expected FAIL)"
  fi
  rm -rf "$RS_ROOT" "$RS_WORK"
fi

# 9) EI-505: fed_plan_part_merge_assert must SKIP (not spuriously FAIL) when
# harness_plan_parts is absent on either frame — a shipped .deb built before mig
# 270/271 landed has neither the table nor its capture trigger, and the raw INSERT
# used to hard-error ("relation ... does not exist"), reading as a genuine merge
# FAILURE and sinking deb-hetzner-federation.sh's OVERALL to INCOMPLETE even though
# discovery + feature + coord merges all passed. Stub drv_psql to simulate both
# frames, with no real PG / network involved — pure, hermetic.
declare -A EI505_HAS_TABLE=()
EI505_MERGED=0
drv_psql() {
  local inst="$1" sql="$2"
  case "$sql" in
    *"to_regclass('harness_shared.harness_plan_parts')"*)
      [ "${EI505_HAS_TABLE[$inst]:-0}" = 1 ] && echo t || echo f ;;
    *"INSERT INTO harness_shared.harness_plan_parts"*)
      EI505_MERGED=1 ;;
    *"SELECT origin||'|'||body FROM harness_shared.harness_plan_parts"*)
      [ "$EI505_MERGED" = 1 ] && echo "remote|xmerge-proof-from-src" ;;
    *"harness_features_consolidated WHERE harness_slug"*)
      echo "fake-ws" ;;
  esac
}

EI505_HAS_TABLE=( [src]=1 [dst]=0 ); EI505_MERGED=0
res="$(fed_plan_part_merge_assert src dst slug 1)"
[ "$res" = skip ] && ok "fed_plan_part_merge_assert SKIPs when harness_plan_parts is absent on dst (EI-505)" \
                   || bad "fed_plan_part_merge_assert expected 'skip' (table absent on dst), got '$res'"

EI505_HAS_TABLE=( [src]=0 [dst]=1 ); EI505_MERGED=0
res="$(fed_plan_part_merge_assert src dst slug 1)"
[ "$res" = skip ] && ok "fed_plan_part_merge_assert SKIPs when harness_plan_parts is absent on src (EI-505)" \
                   || bad "fed_plan_part_merge_assert expected 'skip' (table absent on src), got '$res'"

EI505_HAS_TABLE=( [src]=1 [dst]=1 ); EI505_MERGED=0
res="$(fed_plan_part_merge_assert src dst slug 1)"
[ "$res" = 1 ] && ok "fed_plan_part_merge_assert still MERGES (returns 1) when the table is present on both frames" \
               || bad "fed_plan_part_merge_assert expected '1' (table present, merge lands), got '$res'"

# 9b) WI-5399 iteration 2 (D-050 class): fed_plan_part_merge_assert must resolve
# workspace_id DETERMINISTICALLY, and must FAIL LOUD rather than guess.
#
# This function was MISSED by the iteration-2 sweep that fixed its siblings. It
# resolved the INSERT's workspace via an UNORDERED
#   `harness_features_consolidated WHERE harness_slug=... LIMIT 1`
# COALESCEd under an origin='local' pot_members lookup. Once federation carries
# foreign cards INTO those tables, the unordered LIMIT 1 is a coin flip, and on a
# JOINER frame the origin='local' rung structurally never matches (the joiner's own
# membership row is authored by the owner and arrives origin='remote'). Losing that
# flip stamps the row with a workspace_id NO drain scope selects: it sits
# drained_at=NULL forever, dst polls 0 rows, and the leg reads RED with no error
# anywhere — the exact WI-5399 signature that burned three sessions on the
# replication layer while the bug was on the WRITE side.
#
# The stub records the workspace the INSERT actually used. It must write to a FILE:
# fed_plan_part_merge_assert is invoked via `$(...)`, so a variable assigned inside
# the stub dies with that subshell and would silently read as empty.
WS53_LOG="$WORK/ws5399-insert-ws.txt"
declare -A WS53=()
drv_psql() {
  local inst="$1" sql="$2"
  case "$sql" in
    # The INSERT arm MUST come first. A regressed INSERT EMBEDS the workspace
    # subquery (`VALUES (COALESCE((SELECT ... FROM pot_members WHERE ...`), so any
    # read-arm listed above it would match the write and swallow it — the stub would
    # then classify a WRITE as a READ, log nothing, and the case would fail for the
    # wrong reason while looking right.
    *"INSERT INTO harness_shared.harness_plan_parts"*)
      # Log the workspace_id expression VERBATIM (up to the first comma), not just a
      # quoted literal, so a regression that defers resolution back INTO SQL is
      # reported as what it is instead of parsing to empty and reading as "wrote ''".
      # The shell cannot evaluate that expression and cannot fail loud on it; the DB
      # silently performs the old lottery.
      printf '%s\n' "$sql" | sed -n "s/.*VALUES (\([^,]*\),.*/\1/p" | tr -d "'" >> "$WS53_LOG" ;;
    *"to_regclass('harness_shared.harness_plan_parts')"*) echo t ;;
    *"pot_members WHERE pot_home_slug="*)                 echo "${WS53[byslug]:-}" ;;
    *"pot_members WHERE coalesce(origin"*)                echo "${WS53[bylocal]:-}" ;;
    *"harness_features_consolidated WHERE harness_slug"*)
      # the FIXED rung is origin-filtered; the LOTTERY rung is not
      case "$sql" in
        *"coalesce(origin,'local')='local'"*) echo "${WS53[featlocal]:-}" ;;
        *)                                    echo "${WS53[featany]:-}" ;;
      esac ;;
    *"SELECT origin||'|'||body"*) echo "remote|xmerge-proof-from-src" ;;
  esac
}

# THE FALSIFIER: RIG_HIVE_ID is set (the rig scenario family — 00-base.sh,
# deb-hetzner-federation.sh, deb-hetzner-fast-iterate.sh all call this with it in
# scope), the frame's real workspace is resolvable by pot_home_slug, and a FOREIGN
# federated-in card is sitting in harness_features_consolidated waiting to win the
# old unordered LIMIT 1. The INSERT must use the real workspace, never the foreign one.
: > "$WS53_LOG"
WS53=( [byslug]=real-ws-A [bylocal]="" [featlocal]="" [featany]=FOREIGN-ws-B )
RIG_HIVE_ID=some-pot res="$(fed_plan_part_merge_assert src dst slug 1)"
unset RIG_HIVE_ID
used="$(tr -d '[:space:]' < "$WS53_LOG")"
[ "$used" = real-ws-A ] \
  && ok "fed_plan_part_merge_assert stamps the pot_home_slug-resolved workspace, not a federated-in foreign one (WI-5399)" \
  || bad "fed_plan_part_merge_assert wrote under workspace '$used' (want real-ws-A) — the WI-5399 lottery is back; that row would never drain"

# A joiner frame: pot_home_slug resolves, but origin='local' matches NOTHING (every
# membership row federated in as 'remote'). The old code fell through to the lottery.
: > "$WS53_LOG"
WS53=( [byslug]=joiner-ws [bylocal]="" [featlocal]="" [featany]=FOREIGN-ws-B )
RIG_HIVE_ID=some-pot res="$(fed_plan_part_merge_assert src dst slug 1)"
unset RIG_HIVE_ID
used="$(tr -d '[:space:]' < "$WS53_LOG")"
[ "$used" = joiner-ws ] \
  && ok "fed_plan_part_merge_assert resolves on a JOINER frame, where origin='local' structurally never matches (WI-5399 iter-2)" \
  || bad "fed_plan_part_merge_assert wrote under '$used' (want joiner-ws) on a joiner frame"

# FAIL LOUD: nothing resolves. It must NOT invent a workspace, and must say so.
: > "$WS53_LOG"
WS53=( [byslug]="" [bylocal]="" [featlocal]="" [featany]="" )
err="$(fed_plan_part_merge_assert src dst slug 1 2>&1 >/dev/null)"
used="$(tr -d '[:space:]' < "$WS53_LOG")"
[ -z "$used" ] && case "$err" in *"could not resolve a real workspace_id"*) true ;; *) false ;; esac \
  && ok "fed_plan_part_merge_assert FAILS LOUD instead of writing under an unresolvable workspace (D-050)" \
  || bad "fed_plan_part_merge_assert wrote '$used' / said '$err' — expected no INSERT and a FATAL (D-050 silent-fallback regression)"

# CONTROL (calibration): a non-rig caller with no RIG_HIVE_ID still resolves via the
# owner-frame origin='local' rung, so this fix cannot have broken those callers.
: > "$WS53_LOG"
WS53=( [byslug]="" [bylocal]=owner-ws [featlocal]="" [featany]=FOREIGN-ws-B )
res="$(fed_plan_part_merge_assert src dst slug 1)"
used="$(tr -d '[:space:]' < "$WS53_LOG")"
[ "$used" = owner-ws ] && [ "$res" = 1 ] \
  && ok "non-rig caller (no RIG_HIVE_ID) still resolves via the owner origin='local' rung and still merges" \
  || bad "non-rig caller wrote '$used' / returned '$res' (want owner-ws / 1) — the fix broke a pre-existing caller"

# CONTROL (calibration): the last-resort feature-row rung must be the ORIGIN-FILTERED
# one. If this ever reads FOREIGN-ws-B, the unordered lottery has been reintroduced.
: > "$WS53_LOG"
WS53=( [byslug]="" [bylocal]="" [featlocal]=own-feature-ws [featany]=FOREIGN-ws-B )
res="$(fed_plan_part_merge_assert src dst slug 1)"
used="$(tr -d '[:space:]' < "$WS53_LOG")"
[ "$used" = own-feature-ws ] \
  && ok "last-resort feature-row rung is origin-filtered (the frame's OWN row), not an unordered LIMIT 1" \
  || bad "last-resort rung wrote '$used' (want own-feature-ws) — an unordered LIMIT 1 is back in the ladder"

# deb-hetzner-federation.sh's OVERALL logic must treat a SKIPped plan-part leg as
# N/A, not a failure, and must not label it FAIL in the summary line.
FED_SCRIPT="$DIR/../deb-hetzner-federation.sh"
if grep -qE '\[ "\$ppab" != skip \]' "$FED_SCRIPT" && grep -q 'ppab" = skip \] \|\| \[ "\$ppab" = 1' "$FED_SCRIPT"; then
  ok "deb-hetzner-federation.sh's OVERALL condition treats a SKIPped plan-part leg as N/A, not FAIL"
else
  bad "deb-hetzner-federation.sh no longer excludes a SKIPped plan-part leg from the OVERALL gate (EI-505 regression)"
fi
if grep -q 'pp_label()' "$FED_SCRIPT" && grep -q 'skip) echo SKIP' "$FED_SCRIPT"; then
  ok "deb-hetzner-federation.sh reports plan-part legs as PASS/SKIP/FAIL, not a binary PASS/FAIL"
else
  bad "deb-hetzner-federation.sh no longer distinguishes SKIP from FAIL in its summary line (EI-505 regression)"
fi
unset -f drv_psql

required_line="$(grep '^REQUIRED_TOOLS=' "$verify_file" || true)"
case "$required_line" in
  *" omp "*|*" omp\""*)
    bad "verify-sidecar-bundle still requires retired bundled omp (WI-3344/WI-3343 regression)" ;;
  *)
    ok "verify-sidecar-bundle does not require retired bundled omp" ;;
esac

# fed_wait_api must ALWAYS dump instance diagnostics (listening ports + app-log
# tail) when it cannot confirm a 2xx sidecar — via EITHER exit path: the
# hard-FAIL branch (last literally "000") already did this; the "legacy
# liberal accept" branch (last non-2xx but not exactly the 3-char sentinel
# "000") used to return silently, losing the only record of why the sidecar
# never answered (2026-07-20 live-fed-gate triage: 3 consecutive content-matrix
# RED attempts all took this exact branch and left zero diagnostics before
# fed_cleanup_scoped's `rm -rf $WORK` destroyed the real app logs). Exercise
# the ACTUAL fed_wait_api against a port nothing listens on, with a log file
# fed_discover_sidecar_os cannot resolve to anything — forcing a non-2xx exit
# — and assert the diagnostic dump fires regardless of which non-2xx branch
# it took.
WAPI_WORK="$(mktemp -d /tmp/fed-selftest-waitapi.XXXXXX)"
WAPI_LOG="$WAPI_WORK/inst-y.applog"
echo "some unrelated boot log content, no discoverable sidecar port here" > "$WAPI_LOG"
FED_LOG[y]="$WAPI_LOG"
CLOSED_PORT="$(free_port)"   # bound+released — nothing is listening on it
declare -A FED_SC; FED_SC[y]="$CLOSED_PORT"
# Stub fed_discover_sidecar_os to fail FAST (real one does an O(all /proc entries)
# scan — correct in production but would make this hermetic ~2s selftest both slow
# AND host-load-dependent; every OTHER function this test doesn't target is a
# no-op/stub too, same pattern as the fed_plan_part_merge_assert stubs above).
eval "$(declare -f fed_discover_sidecar_os | sed '1s/.*/fed_discover_sidecar_os_real()/')"
fed_discover_sidecar_os() { return 1; }
WAPI_STDERR="$(mktemp /tmp/fed-selftest-waitapi-stderr.XXXXXX)"
fed_wait_api y 1 2>"$WAPI_STDERR" >/dev/null
unset -f fed_discover_sidecar_os; eval "$(declare -f fed_discover_sidecar_os_real | sed '1s/.*/fed_discover_sidecar_os()/')"; unset -f fed_discover_sidecar_os_real
if grep -q "listening TCP ports:" "$WAPI_STDERR" && grep -q "app-log tail" "$WAPI_STDERR"; then
  ok "fed_wait_api dumps instance diagnostics on a non-2xx exit (both the hard-FAIL and legacy-liberal-accept branches)"
else
  bad "fed_wait_api took a non-2xx exit but did not dump instance diagnostics (stderr: $(cat "$WAPI_STDERR" | tr '\n' '|'))"
fi
rm -rf "$WAPI_WORK" "$WAPI_STDERR"

# 10) EI-18687938054040755: the discovery gate must assert on a DATA-PATH proof,
# never on bare `[swarm] peer_connected`. The product deliberately logs
# `peer_connected(signalling-only) (data path NOT yet demonstrated)` for a
# connection that has carried no bytes, and the old strict grep had no word
# boundary — so it MATCHED that line and "peers discovered" passed on a dead
# connection. These cases exist so that loosening the pattern back fails HERE
# instead of silently restoring a false-PASS months later.
#
# Hermetic: real log files + the real local drv_exec (`bash -s`), so the actual
# greps run — only drv_applog is redirected at the temp logs.
DISC_WORK="$(mktemp -d /tmp/fed-disc-selftest.XXXXXX)"
declare -A DISC_LOG=( [a]="$DISC_WORK/a.log" [b]="$DISC_WORK/b.log" )
drv_applog() { echo "${DISC_LOG[$1]}"; }

SIGNALLING_ONLY='2026-07-26T07:00:00Z [swarm] peer_connected(signalling-only) harness=hello-world peer=1ea65f92c8a4… relayed=false'
DATA_PATH_UP='2026-07-26T07:00:01Z [swarm] peer_data_path_up topic=8f2a1c9b4e6d0537… peer=1ea65f92c8a4… bytesReceived=4096 packetsReceived=7 relayed=false remoteHost=203.0.113.9'

# --- the control that documents the bug: the OLD pattern matched the honest line
if grep -qE '\[swarm\] peer_connected' <<<"$SIGNALLING_ONLY"; then
  ok "CONTROL: the OLD bare-peer_connected pattern DOES match the signalling-only line (this was the false-PASS)"
else
  bad "CONTROL FAILED: the old pattern no longer matches the signalling-only line — this selftest's premise is wrong, re-derive the bug before trusting anything below"
fi

# --- THE NEGATIVE REGRESSION: strict must NOT hit on a signalling-only log
printf '%s\n' "$SIGNALLING_ONLY" > "${DISC_LOG[a]}"; : > "${DISC_LOG[b]}"
res="$(_fed_disc_probe a strict)"
[ -z "$res" ] && ok "_fed_disc_probe strict does NOT hit on peer_connected(signalling-only) — the false-PASS stays fixed" \
              || bad "_fed_disc_probe strict HIT on a signalling-only line (got '$res') — THE FALSE-PASS IS BACK"

# --- the positive control: strict DOES hit the real data-path line
printf '%s\n' "$DATA_PATH_UP" > "${DISC_LOG[a]}"
res="$(_fed_disc_probe a strict)"
[ "$res" = HIT ] && ok "_fed_disc_probe strict HITs on a real [swarm] peer_data_path_up line" \
                 || bad "_fed_disc_probe strict missed a real peer_data_path_up line (got '$res') — the gate can never pass"

# --- join FAILED still short-circuits
printf '%s\n' '2026-07-26T07:00:00Z [swarm] join FAILED topic=abc' > "${DISC_LOG[a]}"
res="$(_fed_disc_probe a strict)"
[ "$res" = FAILED ] && ok "_fed_disc_probe strict still reports FAILED on a [swarm] join FAILED line" \
                    || bad "_fed_disc_probe strict lost the join-FAILED short-circuit (got '$res')"

# --- capability preflight: emitter ABSENT ⇒ skip (N/A), NEVER a peer_connected fallback.
# The log deliberately contains ONLY a signalling-only line: if any fallback to
# the old pattern survives anywhere in this path, this case returns 1 and fails.
printf '%s\n' "$SIGNALLING_ONLY" > "${DISC_LOG[a]}"; printf '%s\n' "$SIGNALLING_ONLY" > "${DISC_LOG[b]}"
_fed_disc_capability() { echo no; }
FED_DISC_CAP=()
res="$(fed_wait_discovery a b strict 1 2>/dev/null)"
[ "$res" = skip ] && ok "fed_wait_discovery echoes 'skip' when the build predates the peer_data_path_up emitter (EI-505 shape)" \
                  || bad "fed_wait_discovery expected 'skip' for an emitter-less build, got '$res'"
[ "$res" != 1 ] && ok "fed_wait_discovery does NOT fall back to peer_connected on skip — skip means NO verdict, not 'discovery passed'" \
                || bad "fed_wait_discovery PASSED on a signalling-only log via a fallback — the false-PASS is back through the skip path"

# --- capability present ⇒ the honest assertion runs and can pass
printf '%s\n' "$DATA_PATH_UP" > "${DISC_LOG[a]}"
_fed_disc_capability() { echo yes; }
FED_DISC_CAP=()
res="$(fed_wait_discovery a b strict 1 2>/dev/null)"
[ "$res" = 1 ] && ok "fed_wait_discovery returns 1 when the emitter is present AND the data path is proven" \
               || bad "fed_wait_discovery expected 1 (capability yes + data-path line present), got '$res'"

# --- capability UNKNOWN must NOT skip (an unreadable bundle must not silence the gate)
printf '%s\n' "$SIGNALLING_ONLY" > "${DISC_LOG[a]}"; printf '%s\n' "$SIGNALLING_ONLY" > "${DISC_LOG[b]}"
_fed_disc_capability() { echo unknown; }
FED_DISC_CAP=()
res="$(fed_wait_discovery a b strict 1 2>/dev/null)"
[ "$res" = 0 ] && ok "fed_wait_discovery does NOT skip on an UNKNOWN capability — an unreadable bundle can't silently N/A the gate" \
               || bad "fed_wait_discovery returned '$res' for unknown capability; expected 0 (assert normally, never auto-skip)"

# --- loose mode can never be a discovery verdict
printf '%s\n' "$SIGNALLING_ONLY" > "${DISC_LOG[a]}"
res="$(fed_wait_discovery a b loose 1 2>/dev/null)"
[ "$res" != 1 ] && ok "fed_wait_discovery never returns 1 for loose mode — legacy markers are a hint, not a verdict" \
                || bad "fed_wait_discovery returned 1 for loose mode — a legacy marker just became a discovery PASS"

# --- the positive control inside the capability probe is load-bearing; guard it
if grep -q "grep -qF 'peer_connected' \"\$bundle\"" "$DIR/federation-asserts.sh"; then
  ok "_fed_disc_capability still carries its positive control (a failed bundle read cannot masquerade as 'emitter absent')"
else
  bad "_fed_disc_capability LOST its positive control — an unreadable bundle now reads as 'emitter absent' ⇒ every run silently SKIPs ⇒ unfalsifiable-by-default"
fi

# --- drv_appbundle: the LOCAL driver must genuinely resolve a bundle.
# Leader ruling (ms1heq5g): "unknown ⇒ don't skip" is only safe if LOCAL actually
# resolves one — otherwise local ⇒ unknown ⇒ don't skip ⇒ strict fires ⇒
# fail-closed, i.e. the original disease wearing the fix as a costume.
FED_LOG[t]="$DISC_WORK/t.log"
FED_BUNDLE_BY_LOG["$DISC_WORK/t.log"]="$DISC_WORK/side/serve.mjs"
res="$(drv_appbundle_local t)"
[ "$res" = "$DISC_WORK/side/serve.mjs" ] \
  && ok "drv_appbundle_local reverse-maps inst → FED_LOG → the recorded bundle" \
  || bad "drv_appbundle_local failed to resolve a registered bundle (got '$res')"

unset 'FED_LOG[t]'
res="$(drv_appbundle_local t)"
[ -z "$res" ] && ok "drv_appbundle_local returns empty (not an error) for an unknown instance" \
              || bad "drv_appbundle_local should return empty for an unknown instance, got '$res'"

# --- the launcher must REGISTER the bundle, or the local map is always empty
if grep -q 'FED_BUNDLE_BY_LOG\["\$logf"\]="\$side/serve.mjs"' "$DIR/federation-asserts.sh"; then
  ok "fed_local_launch_sidecar registers the bundle it launches (local driver can resolve without call-site changes)"
else
  bad "fed_local_launch_sidecar no longer registers FED_BUNDLE_BY_LOG — the local driver resolves NOTHING, so every local run degrades to capability=unknown and strict fires fail-closed on old builds"
fi

# --- RECURRENCE GUARD: any driver that overrides drv_applog must also override
# drv_appbundle. This is what stops the next driver from silently reintroducing
# the "local resolves nothing" hole the leader flagged.
missing=""
for f in "$DIR"/../*.sh "$DIR"/*.sh; do
  case "$f" in *federation-asserts.sh|*selftest*) continue ;; esac
  if grep -q '^drv_applog()' "$f" 2>/dev/null && ! grep -q '^drv_appbundle()' "$f" 2>/dev/null; then
    missing="$missing $(basename "$f")"
  fi
done
[ -z "$missing" ] && ok "every driver overriding drv_applog also overrides drv_appbundle (no driver can silently resolve no bundle)" \
                  || bad "driver(s) override drv_applog but NOT drv_appbundle:$missing — those runs resolve no bundle ⇒ capability unknown ⇒ strict fires fail-closed on an emitter-less build"


# --- RECURRENCE GUARD (WI-6012, leader su-e3b21216): ANY script that JUDGES a
# discovery verdict must handle the "not measured" state EXPLICITLY.
# fed_wait_discovery echoes 1|0|skip and rig_wait_swarm exits 0|1|2. A script that
# compares the result variable against 1/0 WITHOUT also handling skip/2 scores
# "not measured" as FAIL — a false-FAIL indistinguishable from a real product
# break, which is exactly the residue this guard was written for (four OVERALL
# computations survived the original preflight landing).
#
# ENUMERATED BY PRODUCER → RESULT-VARIABLE-NAME → COMPARISON, deliberately, because
# neither half alone finds these: a name-based sweep for `disc*` misses
# two-instance-hive-from-repo-smoke.sh (its variable is `prepeer_ok`), and a
# caller-based sweep finds only ASSIGNMENT lines while the verdict that breaks
# lives on a DIFFERENT line. Widening a contract breaks where a value is JUDGED,
# not where it is produced.
_disc_judge_offenders() {  # <dir-of-scripts>... → offenders on stdout
  local f v
  for f in "$@"; do
    case "$f" in *federation-asserts.sh|*selftest*) continue ;; esac
    [ -f "$f" ] || continue
    # (i) string-verdict layer:  VAR="$(fed_wait_discovery …)"
    for v in $(grep -oE '[A-Za-z_][A-Za-z0-9_]*="\$\(fed_wait_discovery' "$f" 2>/dev/null \
               | sed 's/="\$(fed_wait_discovery//' | sort -u); do
      if grep -qE "\"\\\$$v\" *(=|!=) *1" "$f" && ! grep -qE "\"\\\$$v\" *(=|!=) *skip" "$f"; then
        echo "$(basename "$f"):\$$v(string-verdict)"
      fi
    done
    # (ii) exit-code layer:  rig_wait_swarm …; VAR=$?   (a dok()-style helper counts as handling)
    for v in $(grep -oE 'rig_wait_swarm[^;]*; *[A-Za-z_][A-Za-z0-9_]*=\$\?' "$f" 2>/dev/null \
               | grep -oE '[A-Za-z_][A-Za-z0-9_]*=\$\?$' | sed 's/=\$?//' | sort -u); do
      if grep -qE "\"\\\$$v\" *(=|!=) *[01]" "$f" \
         && ! grep -qE "\"\\\$$v\" *(=|!=) *2" "$f" && ! grep -qE '^ *dok\(\)' "$f"; then
        echo "$(basename "$f"):\$$v(exit-code)"
      fi
    done
  done
}

# CONTROL FIRST: prove the detector can actually FAIL, so a green result below is
# evidence and not a tautology. (Same discipline as the OLD-pattern control above.)
_DJ_CTRL="$(mktemp -d)"
cat > "$_DJ_CTRL/bad-rig.sh" <<'BADRIG'
disc="$(fed_wait_discovery a b strict 30 || true)"
if [ "$disc" = 1 ] && [ "$ab" = 1 ]; then echo "OVERALL: PASS"; fi
BADRIG
if [ -n "$(_disc_judge_offenders "$_DJ_CTRL/bad-rig.sh")" ]; then
  ok "CONTROL: the discovery-judge guard DOES flag a script that scores skip as FAIL (the guard is not vacuous)"
else
  bad "CONTROL FAILED: the discovery-judge guard did not flag a deliberately-broken script — the green result below would be meaningless"
fi
cat > "$_DJ_CTRL/good-rig.sh" <<'GOODRIG'
disc="$(fed_wait_discovery a b strict 30 || true)"
if { [ "$disc" = 1 ] || [ "$disc" = skip ]; } && [ "$ab" = 1 ]; then echo "OVERALL: PASS"; fi
GOODRIG
[ -z "$(_disc_judge_offenders "$_DJ_CTRL/good-rig.sh")" ] \
  && ok "CONTROL: the guard does NOT flag a script that correctly accepts skip (no false positives)" \
  || bad "CONTROL FAILED: the guard flagged a correctly-written script — it would block legitimate work"
rm -rf "$_DJ_CTRL"

# THE REAL SWEEP over every rig script.
unjudged="$(_disc_judge_offenders "$DIR"/../*.sh "$DIR"/*.sh | sort -u | tr '\n' ' ')"
[ -z "$unjudged" ] && ok "every script that judges a discovery verdict handles 'not measured' (skip/exit-2) explicitly — no OVERALL scores unmeasured discovery as FAIL" \
                   || bad "script(s) score an UNMEASURED discovery as FAIL: $unjudged — that is a false-FAIL indistinguishable from a real product break (accept skip alongside 1, and label the PASS line so it is visibly N/A; see WI-6012 / EI-18687938054040755)"
unset -f _disc_judge_offenders

unset -f drv_applog _fed_disc_capability
rm -rf "$DISC_WORK"

# --- RECURRENCE GUARD (WI-6180): fed_wait_boot must find the boot markers when
# they live in the SIDECAR's own structured log rather than the GUI stdout
# capture. In the packaged build ~/papercusp-app.log holds NOTHING but libEGL
# warnings, so grepping it alone false-RED'd a fully-healthy app as BOOT_TIMEOUT
# and blocked the entire 2-VM federation rig at step 8 — every run, invisibly,
# because "boot failed" is exactly what a real boot failure looks like.
#
# BEHAVIOURAL, not a static cross-driver scan: the invariant is "the markers are
# reachable", which a driver may satisfy either by pointing drv_applog straight
# at the sidecar log (deb-hetzner-fast-iterate does) or by defining
# drv_sidecar_log (vm-federation does). A static "must define X" scan encodes the
# wrong rule and false-flags the former. Hermetic: real temp logs + the real
# local drv_exec, so the actual greps run.
BOOT_WORK="$(mktemp -d /tmp/fed-boot-selftest.XXXXXX)"
GUI_LOG="$BOOT_WORK/app.log"; SIDE_LOG="$BOOT_WORK/serve.log"
printf 'libEGL warning: DRI3 error: Could not get DRI3 device\nlibEGL warning: egl: failed to create dri2 screen\n' > "$GUI_LOG"
printf '%s\n%s\n' \
  '[2026-07-26T21:00:00.000Z] [embedded-pg] ready on localhost:24601 db=papercusp' \
  '[2026-07-26T21:00:01.000Z] [serve] listening on http://127.0.0.1:24602' > "$SIDE_LOG"

declare -A FED_PG=() FED_SC=() FED_DB=() FED_KIND=([z]=vm)
drv_exec()   { bash -s; }
drv_applog() { echo "$GUI_LOG"; }
fed_discover_sidecar_os() { return 1; }   # force the marker path to prove itself

drv_sidecar_log() { echo ""; }            # PRE-FIX shape
if fed_wait_boot z 1 >/dev/null 2>&1; then
  bad "CONTROL FAILED: fed_wait_boot passed with the markers ONLY in the sidecar log and no sidecar-log candidate — the WI-6180 premise is wrong, re-derive before trusting the assertion below"
else
  ok "CONTROL: with markers only in the sidecar log and no candidate for it, fed_wait_boot reports BOOT_TIMEOUT (this was the false-RED)"
fi

FED_PG=(); FED_SC=(); FED_DB=()
drv_sidecar_log() { echo "$SIDE_LOG"; }   # FIXED shape
if fed_wait_boot z 1 >/dev/null 2>&1 && [ "${FED_PG[z]:-}" = 24601 ] && [ "${FED_SC[z]:-}" = 24602 ]; then
  ok "fed_wait_boot resolves PG+sidecar ports from the sidecar's own log (WI-6180)"
else
  bad "fed_wait_boot did NOT resolve ports from the sidecar log (got PG=${FED_PG[z]:-unset} sc=${FED_SC[z]:-unset}) — WI-6180 has regressed: a healthy boot will read as BOOT_TIMEOUT"
fi
unset -f drv_applog drv_sidecar_log drv_exec fed_discover_sidecar_os
rm -rf "$BOOT_WORK"

# ── fed_diagnose_unmerged (WI-6209) ────────────────────────────────────────
# A merge probe reading 0 has two utterly different causes and the bare 0 cannot
# tell them apart: a MIS-TARGETED write (enqueued to a tuple this frame never
# booted → nothing ever drains it) vs a GENUINE replication failure. Conflating
# them cost two separate misdirected transport investigations on WI-6209. These
# assertions pin the classification.
#
# Fixtures use the REAL wire format: the SQL emits explicit Y/N tokens because
# `boolean || text` casts via boolean::text ('true'/'false'), NOT psql's 't'/'f'
# — an earlier cut of this guard compared against 't' and misclassified every
# row, and a fixture test that had encoded the same wrong assumption passed
# anyway. Keep these fixtures in the shape the database actually returns.
DIAG_FIXTURE=""
drv_psql() { printf '%s\n' "$DIAG_FIXTURE"; }
diag_out() { DIAG_FIXTURE="$1"; fed_diagnose_unmerged frameA F-TEST-1 2>&1 >/dev/null; }

diag_result="$(diag_out "" || true)"
if grep -qF "never reached substrate_outbox" <<<"$diag_result"; then
  ok "fed_diagnose_unmerged: no outbox row → the write was never federated at all"
else
  bad "fed_diagnose_unmerged did NOT flag a missing outbox row"
fi

diag_result="$(diag_out "workspace-319be5e5|spoon-knife|N|N|?|?" || true)"
if grep -qF "NEVER DRAINED" <<<"$diag_result"; then
  ok "fed_diagnose_unmerged: enqueued-but-undrained → TEST-TARGETING bug (the WI-6209 trap)"
else
  bad "fed_diagnose_unmerged did NOT flag an undrained outbox row — the WI-6209 silent false-negative is back"
fi

diag_result="$(diag_out "workspace-319be5e5|spoon-knife|N|N|?|?" || true)"
if grep -qF "pots.public_key" <<<"$diag_result"; then
  ok "fed_diagnose_unmerged: the undrained diagnosis names the actual fix (pair frames by pots.public_key)"
else
  bad "fed_diagnose_unmerged's undrained diagnosis no longer tells the reader how to fix it"
fi

diag_result="$(diag_out "workspace-b31a7a01|octocat-spoon-knife|Y|N|abc123|1787470000000" || true)"
if grep -qF "genuine replication/transport failure" <<<"$diag_result"; then
  ok "fed_diagnose_unmerged: drained-but-never-arrived → genuine replication failure"
else
  bad "fed_diagnose_unmerged did NOT report a drained-but-unarrived row as a real replication failure"
fi

diag_result="$(diag_out "workspace-b31a7a01|spoon-knife|N|Y|?|?" || true)"
if grep -qF "QUARANTINED" <<<"$diag_result"; then
  ok "fed_diagnose_unmerged: quarantined row is reported as refused-to-publish"
else
  bad "fed_diagnose_unmerged did NOT surface a quarantined outbox row"
fi

# Non-vacuity: the two headline classes must never collapse to the same verdict.
if [ "$(diag_out 'ws|slug|N|N|?|?')" = "$(diag_out 'ws|slug|Y|N|abc123|1787470000000')" ]; then
  bad "CONTROL: fed_diagnose_unmerged gives IDENTICAL output for drained vs undrained — the guard is vacuous"
else
  ok "CONTROL: fed_diagnose_unmerged distinguishes the two failure classes (guard is not vacuous)"
fi
unset -f drv_psql diag_out

# WI-40905: a bare drained=true still conflates two different upstream misses.
# Pin the writer log attribution and the destination's durable cursor/lifecycle
# in the same diagnostic so a failed live witness says whether the destination
# ever admitted that exact log and how far its fold advanced.
drv_psql() {
  local inst="$1" sql="$2"
  if [ "$inst" = frameA ]; then
    echo "ws|pot|Y|N|deadbeef|1787470000000"
  elif grep -qF "FROM harness_shared.substrate_merge_cursor" <<<"$sql"; then
    echo "ws/pot pos=41 apply=pot lifecycle=active updated=2026-08-23 05:00:00+00"
  fi
}
diag_result="$(fed_diagnose_unmerged frameA F-WI40905 frameB 2>&1 >/dev/null || true)"
if grep -qF "DRAINED to log=deadbeef" <<<"$diag_result" \
  && grep -qF "destination cursor/lifecycle=ws/pot pos=41" <<<"$diag_result"; then
  ok "fed_diagnose_unmerged: drained log attribution + destination cursor/lifecycle localize an upstream non-arrival (WI-40905)"
else
  bad "fed_diagnose_unmerged omitted the drained_log_key or destination cursor/lifecycle needed to classify WI-40905 (got '$diag_result')"
fi
unset -f drv_psql

# ── fed_merge_assert / fed_hive_merge_probe extended-window (WI-6217) ──────
# A `fed_merge_assert`/`fed_hive_merge_probe` fast-path timeout on a row that
# genuinely DRAINED (confirmed in flight, not a dead wire or a mis-targeted
# write) must get one further, equally-sized window before reporting FAILED —
# a legitimately-slow-but-healthy delivery must not read as a dead wire (the
# WI-6209 misdiagnosis this observation traces to). A row that never drains
# (the mis-targeted-write class) must NOT get the extra window — waiting
# longer can never make an undrained row arrive, so it must still fail at the
# original `tries`, unchanged from before.
#
# drv_psql runs inside a command-substitution subshell on every call, so a
# plain shell variable can't count calls across invocations — use a tempfile
# counter (same technique two-instance smoke's run_smoke fixture above uses).
WI6217_COUNTER="$(mktemp /tmp/wi6217-selftest-counter.XXXXXX)"; echo 0 > "$WI6217_COUNTER"
WI6217_INSERT="$(mktemp /tmp/wi6217-selftest-insert.XXXXXX)"
WI6217_DRAINED="N"
WI6217_INSERT_FAIL=0
drv_psql() {
  local inst="$1" sql="$2" n
  case "$sql" in
    *"INSERT INTO harness_shared.harness_features_consolidated"*)
      printf '%s\n' "$sql" > "$WI6217_INSERT"
      [ "$WI6217_INSERT_FAIL" = 0 ]
      ;;
    "SELECT origin FROM harness_shared.harness_features_consolidated"*)
      n=$(( $(cat "$WI6217_COUNTER") + 1 )); echo "$n" > "$WI6217_COUNTER"
      [ "$n" -ge 2 ] && echo remote
      ;;
    "SELECT harness_slug FROM harness_shared.harness_features_consolidated"*)
      n=$(( $(cat "$WI6217_COUNTER") + 1 )); echo "$n" > "$WI6217_COUNTER"
      [ "$n" -ge 2 ] && echo "$SLUG_ECHO"
      ;;
    *"SELECT CASE WHEN drained_at IS NOT NULL"*) echo "$WI6217_DRAINED" ;;
    *"SELECT workspace_id FROM harness_shared.pot_members"*) echo "wi6217-fake-ws" ;;  # fed_hive_merge_probe's ws resolution
    *"coalesce(workspace_id"*) : ;;  # fed_diagnose_unmerged's own probe — empty is fine, not under test here
  esac
}

# Case 1: drained but slow — the fast-path window (tries=1) expires with no
# arrival, drained_at is confirmed Y, and the row arrives on the SECOND call
# (i.e. inside the extended window) — must succeed, not report FAILED.
echo 0 > "$WI6217_COUNTER"; WI6217_DRAINED="Y"; SLUG_ECHO=""
res="$(fed_merge_assert src dst slug F-WI6217-SLOW title status 1 2>/dev/null)"
[ "$res" = 1 ] && ok "fed_merge_assert: drained-but-slow delivery succeeds in the extended window instead of reporting FAILED (WI-6217)" \
               || bad "fed_merge_assert did not extend the window for a drained-but-slow delivery (got '$res') — the WI-6217 false-FAIL is back"

# Case 2: never drains — must NOT get the extended window; fails at the
# original `tries` exactly like before this change (the mis-targeted-write /
# dead-wire classes fed_diagnose_unmerged distinguishes — waiting longer
# can't help either one).
echo 0 > "$WI6217_COUNTER"; WI6217_DRAINED="N"
res="$(fed_merge_assert src dst slug F-WI6217-NEVER title status 1 2>/dev/null)"
[ "$res" = 0 ] && ok "fed_merge_assert: a never-drained row still reports FAILED (no pointless extended wait) (WI-6217)" \
               || bad "fed_merge_assert regression: a never-drained row should still FAIL, got '$res'"

# Case 3: fed_hive_merge_probe gets the identical treatment.
echo 0 > "$WI6217_COUNTER"; WI6217_DRAINED="Y"; SLUG_ECHO="dst-slug"
res="$(fed_hive_merge_probe src dst srcslug F-WI6217-HIVE-SLOW 1 2>/dev/null)"
[ "$res" = "1 dst-slug" ] && ok "fed_hive_merge_probe: drained-but-slow delivery succeeds in the extended window (WI-6217)" \
                          || bad "fed_hive_merge_probe did not extend the window for a drained-but-slow delivery (got '$res')"

# Case 4: when the caller supplies the real Pot home through RIG_HIVE_ID, the
# feature write must use that Pot identity rather than the legacy member-repo
# slug passed as sslug. Migration 651/652 rejects the latter, which made every
# live from-repo merge + K4 probe fail before it reached the federation wire.
echo 0 > "$WI6217_COUNTER"; WI6217_DRAINED="Y"; SLUG_ECHO="dst-slug"
res="$(RIG_HIVE_ID=real-pot fed_hive_merge_probe src dst legacy-member F-WI6217-POT-HOME 1 2>/dev/null)"
if [ "$res" = "1 dst-slug" ] \
  && grep -q "VALUES ('wi6217-fake-ws','real-pot','F-WI6217-POT-HOME'" "$WI6217_INSERT"; then
  ok "fed_hive_merge_probe: RIG_HIVE_ID Pot home governs the source write (member slug cannot trip pot-membership enforcement)"
else
  bad "fed_hive_merge_probe did not author under the resolved Pot home (result='$res')"
fi

# A rejected source INSERT can never arrive. Fail immediately rather than
# spending the full poll window and then misreporting a transport timeout.
echo 0 > "$WI6217_COUNTER"; WI6217_INSERT_FAIL=1
res="$(RIG_HIVE_ID=real-pot fed_hive_merge_probe src dst legacy-member F-WI6217-REJECTED 1 2>/dev/null)"
[ "$res" = 0 ] && [ "$(cat "$WI6217_COUNTER")" = 0 ] \
  && ok "fed_hive_merge_probe: rejected source write fails before polling" \
  || bad "fed_hive_merge_probe polled after a rejected source write (result='$res', polls=$(cat "$WI6217_COUNTER"))"

rm -f "$WI6217_COUNTER" "$WI6217_INSERT"
unset -f drv_psql
unset WI6217_COUNTER WI6217_INSERT WI6217_DRAINED WI6217_INSERT_FAIL SLUG_ECHO

# ── fed_coord_merge_probe is `set -u`-safe with RIG_HIVE_ID unset (WI-5472) ──
# WI-5472 reported fed_hive_merge_probe/fed_coord_merge_probe crashing
# "ws: unbound variable" under `set -u` whenever RIG_HIVE_ID is unset — a FALSE
# FAIL on every two-instance-*-smoke.sh federation-merge assertion, since the
# non-rig smokes (content-matrix, merge-smoke) never set RIG_HIVE_ID. The
# D-050/WI-5399 iteration-2 sweep fixed it by initialising `ws=""` in the local
# decl and guarding the read as "${RIG_HIVE_ID:-}", and the WI-6217 block above
# happens to re-cover fed_hive_merge_probe — but NOTHING exercised
# fed_coord_merge_probe, so half the fix had no recurrence guard and a
# regression would have reappeared only as a live-rig false FAIL.
#
# Why the assertion is shaped around stdout rather than a caught signal: these
# probes run inside `$(...)`, so a `set -u` abort kills only the substitution
# subshell — the parent sees an EMPTY capture, never a crash. Empty stdout (not
# "1"/"0") is therefore the regression signature; the stderr check names it.
WI5472_ERR="$(mktemp /tmp/wi5472-selftest-stderr.XXXXXX)"
drv_psql() {
  local inst="$1" sql="$2"
  case "$sql" in
    # BOTH ws-resolution rungs answer, so neither branch can pass by falling
    # through to the other — a regression in either one is caught.
    *"SELECT workspace_id FROM harness_shared.pot_members"*) echo "wi5472-fake-ws" ;;
    *"INSERT INTO harness_shared.coord_event_log"*)          : ;;
    *"SELECT msg_id FROM harness_shared.coord_event_log"*)   echo "wi5472-arrived" ;;
  esac
}

# Case 1: THE WI-5472 CONDITION — RIG_HIVE_ID unset, `set -u` in force.
unset RIG_HIVE_ID
res="$(fed_coord_merge_probe src dst srcslug WI5472 1 2>"$WI5472_ERR")"
if [ "$res" = 1 ] && ! grep -q 'unbound variable' "$WI5472_ERR"; then
  ok "fed_coord_merge_probe: set -u safe with RIG_HIVE_ID unset (WI-5472)"
else
  bad "fed_coord_merge_probe regressed on WI-5472: got '$res' (want '1')$(grep -q 'unbound variable' "$WI5472_ERR" && echo " — 'unbound variable' is BACK: $(grep 'unbound variable' "$WI5472_ERR" | head -1)")"
fi

# Case 2 (CONTROL, so Case 1 cannot pass vacuously): the rig frame — RIG_HIVE_ID
# SET takes the pot_home_slug rung instead. Both branches must stay set -u safe.
res="$(RIG_HIVE_ID=some-pot fed_coord_merge_probe src dst srcslug WI5472R 1 2>"$WI5472_ERR")"
if [ "$res" = 1 ] && ! grep -q 'unbound variable' "$WI5472_ERR"; then
  ok "CONTROL: fed_coord_merge_probe: set -u safe on the RIG_HIVE_ID rung too (WI-5472)"
else
  bad "fed_coord_merge_probe regressed on the RIG_HIVE_ID rung: got '$res' (want '1')"
fi

rm -f "$WI5472_ERR"
unset -f drv_psql
unset WI5472_ERR res

# ── WI-40905 folded-witness lifecycle admission ───────────────────────────
# HTTP/core readiness must not admit a security CUT witness after the target
# substrate crossed a boot-timeout/late-adopt window, while target presence is
# still rejecting its peer, or while the exact same-stream cursor is not active
# and advanced. The preserved 18:22 witness had all three misleading layers:
# core probes passed, K3 passed, but F-RKCUT never reached B's epoch gate.
wi40905_guard_line="$(grep -n 'fed_assert_hive_lifecycle_ready a b F-HIVE3' "$FROMREPO_SMOKE_FILE" 2>/dev/null | head -1 | cut -d: -f1)"
wi40905_first_mutation_line="$(grep -n 'dec="$(mcp_call a "pot:membership_decide"' "$FROMREPO_SMOKE_FILE" 2>/dev/null | tail -1 | cut -d: -f1)"
if [ -n "$wi40905_guard_line" ] && [ -n "$wi40905_first_mutation_line" ] \
  && [ "$wi40905_guard_line" -lt "$wi40905_first_mutation_line" ] \
  && grep -q 'FAILED_SUBSETS="$FAILED_SUBSETS witness-lifecycle"' "$FROMREPO_SMOKE_FILE"; then
  ok "from-repo folded witness invokes the lifecycle guard before its first membership/re-key mutation"
else
  bad "from-repo folded witness no longer fail-closes through the lifecycle guard before mutation"
fi

# F-HIVE3 is only the baseline: the C-001 setup and AK probes run afterward.
# Pin the fresh F-RKCTRL lifecycle check between its own materialization probe
# and the K2 revoke, and pin the revoke inside the witness_cut_ready gate. This
# is the regression guard for the exact live failure where an early same-stream
# PASS was followed by a stalled stream at the later revoke boundary.
wi40905_fresh_probe_line="$(grep -n 'rkctrl="$(fed_hive_merge_probe a b .*F-RKCTRL' "$FROMREPO_SMOKE_FILE" 2>/dev/null | head -1 | cut -d: -f1)"
wi40905_fresh_guard_line="$(grep -n 'fed_assert_hive_lifecycle_ready a b F-RKCTRL' "$FROMREPO_SMOKE_FILE" 2>/dev/null | head -1 | cut -d: -f1)"
wi40905_cut_gate_line="$(grep -n 'if \[ "$witness_cut_ready" = 1 \]; then' "$FROMREPO_SMOKE_FILE" 2>/dev/null | head -1 | cut -d: -f1)"
wi40905_revoke_line="$(grep -n 'rk_revoke_out="$(mcp_call a "substrate:revoke_contributor"' "$FROMREPO_SMOKE_FILE" 2>/dev/null | head -1 | cut -d: -f1)"
if [ -n "$wi40905_fresh_probe_line" ] && [ -n "$wi40905_fresh_guard_line" ] \
  && [ -n "$wi40905_cut_gate_line" ] && [ -n "$wi40905_revoke_line" ] \
  && [ "$wi40905_fresh_probe_line" -lt "$wi40905_fresh_guard_line" ] \
  && [ "$wi40905_fresh_guard_line" -lt "$wi40905_cut_gate_line" ] \
  && [ "$wi40905_cut_gate_line" -lt "$wi40905_revoke_line" ]; then
  ok "from-repo folded witness revalidates the fresh F-RKCTRL stream and gates K2/K4 on that admission"
else
  bad "from-repo folded witness no longer fail-closes K2/K4 behind the fresh F-RKCTRL lifecycle admission"
fi

WI40905_A_LOG="$(mktemp /tmp/wi40905-lifecycle-a.XXXXXX)"
WI40905_B_LOG="$(mktemp /tmp/wi40905-lifecycle-b.XXXXXX)"
WI40905_ERR="$(mktemp /tmp/wi40905-lifecycle-err.XXXXXX)"
WI40905_CURSOR_STATE=active
WI40905_CURSOR_POS=42

write_wi40905_healthy_logs() {
  cat >"$WI40905_A_LOG" <<'EOF'
[wire-presence] wired ws::member — gossipWriter=on topic=abcdef1234567890 pot=pot-home
EOF
  cat >"$WI40905_B_LOG" <<'EOF'
[wire-presence] wired ws::member — gossipWriter=on topic=abcdef1234567890 pot=pot-home
[presence-gossip] REJECTED inbound presence frame on topic abcdef123456… — 0 admitted
[presence-gossip] inbound presence ADMITTED again on topic abcdef123456… after 1 rejected frame(s)
EOF
}
drv_applog() {
  [ "$1" = src ] && echo "$WI40905_A_LOG" || echo "$WI40905_B_LOG"
}
drv_exec() {
  local _inst="$1"
  bash -s
}
drv_psql() {
  local _inst="$1" sql="$2"
  case "$sql" in
    *"FROM harness_shared.substrate_outbox WHERE key='F-CANARY'"*)
      # Live substrate_outbox.drained_at is BIGINT epoch-ms. Reject the exact
      # type error that made the first guarded witness misreport a drained,
      # materialized F-HIVE3 as an absent outbox row.
      if grep -qF 'drained_at::text' <<<"$sql" \
        && ! grep -qF 'extract(epoch FROM drained_at)' <<<"$sql"; then
        echo 'deadbeef1234|1000'
      fi
      ;;
    *"count(*)>0"*"feature_id='F-CANARY'"*) echo Y ;;
    *"FROM harness_shared.substrate_merge_cursor"*) echo "${WI40905_CURSOR_POS}|${WI40905_CURSOR_STATE}|ws::pot-home|2000" ;;
  esac
}

write_wi40905_healthy_logs
if fed_assert_hive_lifecycle_ready src dst F-CANARY member pot-home 2>"$WI40905_ERR"; then
  ok "fed_assert_hive_lifecycle_ready: drained same-stream canary + active cursor + recovered presence is admitted"
else
  bad "fed_assert_hive_lifecycle_ready rejected the healthy control: $(cat "$WI40905_ERR")"
fi

printf '%s\n' '[hyperbee-substrate] (ws::member) zombie window entered after '\''boot timeout after 30000ms'\''' >>"$WI40905_B_LOG"
if ! fed_assert_hive_lifecycle_ready src dst F-CANARY member pot-home 2>"$WI40905_ERR" \
  && grep -q 'boot-timeout/late-adopt lifecycle' "$WI40905_ERR"; then
  ok "fed_assert_hive_lifecycle_ready: a target-harness zombie window fails closed"
else
  bad "fed_assert_hive_lifecycle_ready admitted a target-harness zombie/late-adopt history"
fi

write_wi40905_healthy_logs
sed -i '/ADMITTED again/d' "$WI40905_B_LOG"
(
  sleep 0.10
  printf '%s\n' '[presence-gossip] inbound presence ADMITTED again on topic abcdef123456… after 1 rejected frame(s)' >>"$WI40905_B_LOG"
) &
wi40905_recovery_writer_pid=$!
if fed_assert_hive_lifecycle_ready src dst F-CANARY member pot-home 20 0.05 2>"$WI40905_ERR"; then
  ok "fed_assert_hive_lifecycle_ready: a later accepted presence frame clears a transient rejection"
else
  bad "fed_assert_hive_lifecycle_ready rejected bounded asynchronous presence recovery: $(cat "$WI40905_ERR")"
fi
wait "$wi40905_recovery_writer_pid"

write_wi40905_healthy_logs
sed -i '/ADMITTED again/d' "$WI40905_B_LOG"
if ! fed_assert_hive_lifecycle_ready src dst F-CANARY member pot-home 3 0.02 2>"$WI40905_ERR" \
  && grep -q 'presence rejection streak is unresolved' "$WI40905_ERR"; then
  ok "fed_assert_hive_lifecycle_ready: terminal target-topic admission rejection fails closed after the bounded wait"
else
  bad "fed_assert_hive_lifecycle_ready admitted a terminal presence rejection streak"
fi

write_wi40905_healthy_logs
printf '%s\n' '[presence-gossip] REJECTED inbound presence frame on topic abcdef123456… — later rejection' >>"$WI40905_B_LOG"
if ! fed_assert_hive_lifecycle_ready src dst F-CANARY member pot-home 3 0.02 2>"$WI40905_ERR" \
  && grep -q 'presence rejection streak is unresolved' "$WI40905_ERR"; then
  ok "fed_assert_hive_lifecycle_ready: a later rejection supersedes an earlier accepted recovery"
else
  bad "fed_assert_hive_lifecycle_ready masked a later rejection behind an earlier accepted recovery"
fi

write_wi40905_healthy_logs
WI40905_CURSOR_STATE=retired
if ! fed_assert_hive_lifecycle_ready src dst F-CANARY member pot-home 2>"$WI40905_ERR" \
  && grep -q 'not active+advanced' "$WI40905_ERR"; then
  ok "fed_assert_hive_lifecycle_ready: a retired destination cursor fails closed"
else
  bad "fed_assert_hive_lifecycle_ready admitted a retired destination cursor"
fi

WI40905_CURSOR_STATE=active
printf '%s\n' '[stage-stall] STAGE STALL for deadbeef1234: '\''merge-apply (features::F-CANARY)'\'' still pending after 15000ms' >>"$WI40905_B_LOG"
if ! fed_assert_hive_lifecycle_ready src dst F-CANARY member pot-home 2>"$WI40905_ERR" \
  && grep -q 'exact canary source log recorded a named merge-apply stall' "$WI40905_ERR"; then
  ok "fed_assert_hive_lifecycle_ready: a named stall on the exact canary log fails closed"
else
  bad "fed_assert_hive_lifecycle_ready admitted an exact-log merge-apply stall"
fi

rm -f "$WI40905_A_LOG" "$WI40905_B_LOG" "$WI40905_ERR"
unset -f write_wi40905_healthy_logs drv_applog drv_exec drv_psql
unset WI40905_A_LOG WI40905_B_LOG WI40905_ERR WI40905_CURSOR_STATE WI40905_CURSOR_POS wi40905_recovery_writer_pid

echo
if [ "$FAILS" -eq 0 ]; then echo "PASS — port self-discovery self-test green"; exit 0; fi
echo "FAIL — $FAILS assertion(s) failed"; exit 1
