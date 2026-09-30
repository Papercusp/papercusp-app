#!/usr/bin/env bash
# offline-installer-journey.sh — P-521 "Full installer" row driver (WI-10003962).
#
# Acceptance row (shared-pot-release-testing/P521-HARDENED-ACCEPTANCE-2026-09-05.md):
#   "Run the full offline-installer journey as a separate compatibility check
#    against the same source and protocol contract. The minimal witness does not
#    replace it."  Candidate admission: "Record the full installer identity
#    separately" from the runtime artifact, and "resolve each installed process
#    back to those exact bytes before each journey and after a restart."
#
# The MINIMAL WITNESS is what the P-505 drill boots: the Server .deb extracted in
# place on the tower (hive-git-drill.sh, never dpkg-installed) and the updater
# tarball "Papercusp Server.app.tar.gz" booted headless on the Mac VM (D-079).
# Neither runs an installer. THIS driver runs the real GUI + Server installers
# on a target host with internet egress denied, then proves the installed and
# RUNNING bytes are the witness's bytes (same source => same protocol contract:
# the protocol code ships inside serve.mjs, and the schema inside db-sql/).
#
# Runs ON THE TOWER; drives the target over ssh. It never installs anything on
# the host it runs on. Targets:
#   linux  a disposable clean-room VM (scripts/linux-test-vm/vmctl) — apt/dpkg
#          install of BOTH .debs with an in-guest egress firewall (enforced).
#   mac    a macOS host — DMG install of BOTH apps; egress is MEASURED only
#          (--offline verify), so an egress-capable Mac cannot claim offline.
#
# LEGS (each one: pass | fail | void | unmeasured — a skipped or unmeasured leg
# is never a pass; the overall verdict is PASS only when every leg passes):
#   installer-identity   sha256+bytes of each installer, matched to the release
#                        ledger (harness_shared.releases.artifacts). No ledger =>
#                        unmeasured.
#   runtime-identity     serve.mjs / bin/node / build-provenance.json sha256 and a
#                        db-sql migration-set digest, read from the WITNESS bytes
#                        (recorded separately from the installer identity).
#   preflight-fresh      no Papercusp product installed, nothing answering on the
#                        operator record, remote dir writable.
#   os-prerequisites     (linux) WHILE ONLINE, before egress is denied: install the
#                        Depends + Recommends that BOTH .debs declare, read from
#                        their control fields, via `apt-get satisfy` — never a
#                        Papercusp package. The provisioned package=version list
#                        is recorded (osPrerequisites.provisioned). An
#                        unsatisfiable declared dependency FAILS the row (plan
#                        ruling amending D-083 item 1: "offline" means the
#                        Papercusp install and first launch fetch nothing; the
#                        distro's declared dependencies are a prerequisite).
#   offline              egress measured before (positive control) and denied
#                        after; a target that can still reach the internet voids.
#   install              real installers, exit status recorded; on linux both
#                        .debs install through apt with egress DENIED, the
#                        dependency closure is simulated first and every package
#                        apt would still have to DOWNLOAD is named (plus apt's own
#                        E: line), and any remote Get/Err/Ign apt prints fails
#                        the leg (install.remoteFetches must be 0). Not
#                        --no-download: apt 2.8 cannot install a local .deb with
#                        it ("Pathname to install is not absolute").
#   installed-bytes      runtime digest of the installed tree.
#   witness-compat       installed digest == witness digest, field by field.
#   first-launch         Server started through its supported entry; /api/health
#                        sha/version equal the candidate; the listening process's
#                        executable is the installed bin/node, byte-identical.
#   offline-restore      the seeded pot ($EXPECT_POT) appears in pot:list on the
#                        offline install (the installed node + mcp-call.mjs).
#                        POLLED for up to --restore-timeout seconds (default 180)
#                        after health, never one read (plan D-088: the offline
#                        self-admit runs after the join attempt gives up, so a
#                        read 1s after health measures nothing — run 7). The
#                        bootstrap's '[papercusp-hive]' journal lines (pre-join
#                        seed restore, offline self-admit) are recorded as
#                        DIAGNOSTICS (restore.seedRestore / restore.bootstrapLast)
#                        and never gate the leg.
#   restart-reresolve    restart; a NEW pid serves, re-resolved to the same bytes.
#   join-runtime-match   (plan D-083) this row needs no live peer join only when
#                        the runtime artifact sha256 (the witness) is the one the
#                        Discovery/join evidence names for the same candidate
#                        (its subject.debSha256 / subject.artifactSha256). No
#                        --join-evidence => unmeasured; a different sha => fail.
#
# The evidence is an `operational-test-evidence` document declaring
# p521Journey 'full-installer-compat', with the runtime sha256 under the same
# subject keys the Discovery/join evidence uses (subject.debSha256 for a .deb
# witness, subject.artifactSha256 always), so the P-521 readiness manifest
# (apps/operator/lib/release/p2p-candidate-evidence.ts) binds and joins it.
#
# Usage:
#   offline-installer-journey.sh --platform linux|mac \
#     --gui-artifact PATH --server-artifact PATH [--witness PATH] \
#     --evidence-out PATH [--ledger-json PATH] [--expected-version V] \
#     [--expected-sha SHA] [--ssh-host H] [--ssh-port N] [--ssh-key K] \
#     [--ssh-option K=V]... [--remote-dir DIR] [--offline enforce|verify] \
#     [--expect-pot SLUG] [--mcp-call PATH] [--health-timeout SEC] \
#     [--restore-timeout SEC] \
#     [--install-timeout SEC] [--keep-offline] [--join-evidence PATH] \
#     [--expected-health-sha SHA]
#   --expected-health-sha is the /api/health identity: the release's baked
#   buildSha. The Tauri binary compiles in PAPERCUSP_BUILD_SHA and hands it to
#   the sidecar (src-tauri/src/main.rs), and verify-provenance.sh checks the
#   same equality. It defaults to the witness provenance buildSha. Shipped
#   sidecar provenance leaves that empty, and its gitHead is the workspace
#   SOURCE sha, which is never the health identity. With neither, the run
#   refuses (exit 2) before touching a target. --expected-sha is the source
#   identity; it is recorded, not compared against /api/health.
#   --join-evidence is the Discovery/join operational-test-evidence JSON for
#   the same candidate (e.g. docs/evidence/p505-run34-exact-0025-physical-*.json).
#   --witness defaults to the Server .deb on linux (the drill's exact bytes);
#   on mac pass the updater "Papercusp Server.app.tar.gz" the Mac VM boots.
#   --ledger-json is a JSON array of {name, sha256, size|bytes}, e.g.
#     sudo -n -u postgres psql -d papercusp -Atc "SELECT artifacts FROM
#       harness_shared.releases WHERE workspace_id='papercusp-workspace'
#       AND version='0.0.25' AND channel='alpha'" > ledger.json
#
# Exit: 0 PASS · 1 FAIL (a leg failed) · 2 usage/setup · 3 INCOMPLETE (no leg
#       failed, but one is void/unmeasured — never reportable as a pass).
#
# Test hooks (never set in a real run): PC_SSH / PC_SCP replace ssh/scp,
# PCOIJ_TARGET_ROOT prefixes every target install path, PCOIJ_HEALTH_POLL sets
# the health poll interval (default 3s), PCOIJ_RESTORE_POLL the pot:list poll
# interval (default 5s).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SCHEMA="p521-offline-installer-journey/v1"

PLATFORM=""
GUI_ARTIFACT=""
SERVER_ARTIFACT=""
WITNESS=""
EVIDENCE_OUT=""
LEDGER_JSON=""
EXPECTED_VERSION=""
EXPECTED_SHA=""
EXPECTED_HEALTH_SHA=""
SSH_HOST="${PCOIJ_SSH_HOST:-}"
SSH_PORT="${PCOIJ_SSH_PORT:-22}"
SSH_KEY="${PCOIJ_SSH_KEY:-}"
SSH_OPTIONS=()
REMOTE_DIR=""
OFFLINE_MODE=""
EXPECT_POT="papercusp"
MCP_CALL="$REPO_ROOT/scripts/mcp-call.mjs"
HEALTH_TIMEOUT=300
RESTORE_TIMEOUT=180
INSTALL_TIMEOUT=1800
KEEP_OFFLINE=0
JOIN_EVIDENCE=""
ORIG_CMD="$(printf '%q ' "$0" "$@")"

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --join-evidence) JOIN_EVIDENCE="${2:-}"; shift 2 ;;
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --gui-artifact) GUI_ARTIFACT="${2:-}"; shift 2 ;;
    --server-artifact) SERVER_ARTIFACT="${2:-}"; shift 2 ;;
    --witness) WITNESS="${2:-}"; shift 2 ;;
    --evidence-out) EVIDENCE_OUT="${2:-}"; shift 2 ;;
    --ledger-json) LEDGER_JSON="${2:-}"; shift 2 ;;
    --expected-version) EXPECTED_VERSION="${2:-}"; shift 2 ;;
    --expected-sha) EXPECTED_SHA="${2:-}"; shift 2 ;;
    --expected-health-sha) EXPECTED_HEALTH_SHA="${2:-}"; shift 2 ;;
    --ssh-host) SSH_HOST="${2:-}"; shift 2 ;;
    --ssh-port) SSH_PORT="${2:-}"; shift 2 ;;
    --ssh-key) SSH_KEY="${2:-}"; shift 2 ;;
    --ssh-option)
      [[ "${2:-}" == *=* ]] || { echo "--ssh-option needs NAME=VALUE" >&2; exit 2; }
      SSH_OPTIONS+=("$2"); shift 2 ;;
    --remote-dir) REMOTE_DIR="${2:-}"; shift 2 ;;
    --offline) OFFLINE_MODE="${2:-}"; shift 2 ;;
    --expect-pot) EXPECT_POT="${2:-}"; shift 2 ;;
    --mcp-call) MCP_CALL="${2:-}"; shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT="${2:-}"; shift 2 ;;
    --restore-timeout) RESTORE_TIMEOUT="${2:-}"; shift 2 ;;
    --install-timeout) INSTALL_TIMEOUT="${2:-}"; shift 2 ;;
    --keep-offline) KEEP_OFFLINE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die2() { echo "offline-installer-journey: $*" >&2; exit 2; }
case "$PLATFORM" in
  linux) : "${OFFLINE_MODE:=enforce}"; : "${REMOTE_DIR:=/tmp/pcoij}" ;;
  mac) : "${OFFLINE_MODE:=verify}"; : "${REMOTE_DIR:=/tmp/pcoij}"
       [[ "$OFFLINE_MODE" == verify ]] || die2 "--offline enforce is not implemented for mac (egress is measured, never assumed)" ;;
  *) die2 "--platform linux|mac is required" ;;
esac
[[ "$OFFLINE_MODE" == enforce || "$OFFLINE_MODE" == verify ]] || die2 "--offline must be enforce|verify"
[[ -f "$GUI_ARTIFACT" ]] || die2 "--gui-artifact not found: ${GUI_ARTIFACT:-<unset>}"
[[ -f "$SERVER_ARTIFACT" ]] || die2 "--server-artifact not found: ${SERVER_ARTIFACT:-<unset>}"
[[ -n "$EVIDENCE_OUT" ]] || die2 "--evidence-out PATH is required"
[[ -n "$SSH_HOST" || -n "${PC_SSH:-}" ]] || die2 "--ssh-host is required"
[[ -f "$MCP_CALL" ]] || die2 "--mcp-call not found: $MCP_CALL"
[[ -z "$JOIN_EVIDENCE" || -f "$JOIN_EVIDENCE" ]] || die2 "--join-evidence not found: $JOIN_EVIDENCE"
[[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ && "$INSTALL_TIMEOUT" =~ ^[0-9]+$ && "$RESTORE_TIMEOUT" =~ ^[0-9]+$ ]] || die2 "timeouts must be integers"
if [[ -z "$WITNESS" ]]; then
  [[ "$PLATFORM" == linux ]] || die2 "--witness is required on mac (the Server.app.tar.gz the Mac VM boots)"
  WITNESS="$SERVER_ARTIFACT"
fi
[[ -f "$WITNESS" ]] || die2 "--witness not found: $WITNESS"
case "$PLATFORM:$GUI_ARTIFACT:$SERVER_ARTIFACT" in
  linux:*.deb:*.deb|mac:*.dmg:*.dmg) ;;
  *) die2 "installers must be .deb (linux) or .dmg (mac): $GUI_ARTIFACT / $SERVER_ARTIFACT" ;;
esac
for tool in python3 tar; do command -v "$tool" >/dev/null || die2 "missing local tool: $tool"; done
[[ "$PLATFORM" == mac ]] || command -v dpkg-deb >/dev/null || die2 "missing local tool: dpkg-deb"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pcoij-run.XXXXXX")" || die2 "cannot create run dir"
LEGS="$RUN_DIR/legs.tsv"; IDS="$RUN_DIR/identity.tsv"; : > "$LEGS"; : > "$IDS"
LOG_DIR="$RUN_DIR/logs"; mkdir -p "$LOG_DIR"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FIREWALL_APPLIED=0

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# leg NAME STATUS DETAIL [LOG]  — one row per leg; the evidence JSON is built from it.
leg() {
  local detail="${3//$'\t'/ }"; detail="${detail//$'\n'/ | }"
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$(now)" "$detail" "${4:-}" >> "$LEGS"
  printf '  %-8s %-18s %s\n' "$(printf '%s' "$2" | tr '[:lower:]' '[:upper:]')" "$1" "$3" >&2
}
ident() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$IDS"; }   # SCOPE KEY VALUE
# KEY FILE. Keys carry '/' (bin/node), so the sed delimiter is '|'.
kv() { [[ -f "$2" ]] || return 0; sed -n "s|^PCOIJ $1=||p" "$2" | tail -1; }
# Two spellings name the same commit when both are >= 7 chars and one is a
# prefix of the other: /api/health reports a short sha, provenance a full one.
sha_matches() { local a="$1" b="$2"; [[ ${#a} -ge 7 && ${#b} -ge 7 ]] || return 1; [[ "$a" == "$b"* || "$b" == "$a"* ]]; }

sha256_local() { sha256sum "$1" | awk '{print $1}'; }

# ── ONE runtime-digest implementation, used locally (witness) AND remotely
# (installed tree). bash-3.2 / POSIX safe: the Mac VM's /bin/bash is 3.2.
read -r -d '' RUNTIME_DIGEST_FN <<'FN'
pcoij_sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
pcoij_sha_stdin() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'; else shasum -a 256 | awk '{print $1}'; fi; }
pcoij_json_field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$2" | head -1; }
pcoij_runtime_digest() { # $1 = sidecar dir, $2 = key prefix
  d="$1"; p="$2"
  for f in serve.mjs bin/node build-provenance.json; do
    if [ -f "$d/$f" ]; then echo "PCOIJ $p.$f=$(pcoij_sha "$d/$f")"; else echo "PCOIJ $p.$f=MISSING"; fi
  done
  if [ -d "$d/db-sql" ]; then
    n=$(cd "$d/db-sql" && find . -type f | wc -l | tr -d ' ')
    dg=$(cd "$d/db-sql" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do printf '%s %s\n' "$f" "$(pcoij_sha "$f")"; done | pcoij_sha_stdin)
    top=$(cd "$d/db-sql" && ls | LC_ALL=C sort -n | tail -1)
    echo "PCOIJ $p.db-sql.count=$n"; echo "PCOIJ $p.db-sql.digest=$dg"; echo "PCOIJ $p.db-sql.head=$top"
  else
    echo "PCOIJ $p.db-sql.digest=MISSING"
  fi
  if [ -f "$d/build-provenance.json" ]; then
    echo "PCOIJ $p.version=$(pcoij_json_field version "$d/build-provenance.json")"
    echo "PCOIJ $p.buildSha=$(pcoij_json_field buildSha "$d/build-provenance.json")"
    echo "PCOIJ $p.gitHead=$(pcoij_json_field gitHead "$d/build-provenance.json")"
  fi
}
FN
RUNTIME_FIELDS="serve.mjs bin/node build-provenance.json db-sql.count db-sql.digest db-sql.head version buildSha gitHead"

# ── Remote plumbing ──────────────────────────────────────────────────────────
SSH_BIN="${PC_SSH:-ssh}"; SCP_BIN="${PC_SCP:-scp}"
ssh_args=(-o BatchMode=yes -o ConnectTimeout=15 -p "$SSH_PORT")
scp_args=(-o BatchMode=yes -o ConnectTimeout=15 -P "$SSH_PORT")
[[ -n "$SSH_KEY" ]] && { ssh_args+=(-i "$SSH_KEY"); scp_args+=(-i "$SSH_KEY"); }
for o in ${SSH_OPTIONS[@]+"${SSH_OPTIONS[@]}"}; do ssh_args+=(-o "$o"); scp_args+=(-o "$o"); done
# The remote side is always `bash -s` fed a script on stdin; the header carries
# the only parameters, so nothing is re-parsed by an intermediate shell.
remote_header() {
  printf 'PCOIJ_ROOT=%q\nREMOTE_DIR=%q\nPLATFORM=%q\n' "${PCOIJ_TARGET_ROOT:-}" "$REMOTE_DIR" "$PLATFORM"
  printf 'HEALTH_TIMEOUT=%q\nHEALTH_POLL=%q\nEXPECT_POT=%q\n' "$HEALTH_TIMEOUT" "${PCOIJ_HEALTH_POLL:-3}" "$EXPECT_POT"
  printf 'RESTORE_TIMEOUT=%q\nRESTORE_POLL=%q\n' "$RESTORE_TIMEOUT" "${PCOIJ_RESTORE_POLL:-5}"
  printf '%s\n' "$RUNTIME_DIGEST_FN"
  cat <<'PATHS'
if [ "$PLATFORM" = linux ]; then
  SERVER_ROOT="$PCOIJ_ROOT/usr/lib/Papercusp Server"; SIDECAR="$SERVER_ROOT/sidecar"
  GUI_MARK="$PCOIJ_ROOT/usr/bin/papercusp-desktop"
else
  SERVER_ROOT="$PCOIJ_ROOT/Applications/Papercusp Server.app"; SIDECAR="$SERVER_ROOT/Contents/Resources/sidecar"
  GUI_MARK="$PCOIJ_ROOT/Applications/Papercusp GUI.app"
fi
OPJSON="$HOME/.papercusp/operator.json"
PATHS
}
# remote LOGNAME SCRIPT [TIMEOUT] — stdout/stderr to logs/LOGNAME.log; echoes the exit code.
remote() {
  local name="$1" body="$2" to="${3:-600}" log="$LOG_DIR/$1.log" rc
  { remote_header; printf '%s\n' "$body"; } > "$RUN_DIR/$name.remote.sh"
  if [[ -n "${PC_SSH:-}" ]]; then
    timeout "$to" "$SSH_BIN" "${ssh_args[@]}" "$SSH_HOST" 'bash -s' < "$RUN_DIR/$name.remote.sh" > "$log" 2>&1; rc=$?
  else
    timeout "$to" "$SSH_BIN" "${ssh_args[@]}" "$SSH_HOST" 'bash -s' < "$RUN_DIR/$name.remote.sh" > "$log" 2>&1; rc=$?
  fi
  echo "$rc"
}
push() { # LOCAL REMOTE_PATH
  "$SCP_BIN" "${scp_args[@]}" "$1" "$SSH_HOST:$2" >> "$LOG_DIR/push.log" 2>&1
}

finish() {
  local rc
  if [[ "$FIREWALL_APPLIED" == 1 && "$KEEP_OFFLINE" != 1 ]]; then
    rc=$(remote offline-restore-egress "$OFFLINE_DOWN" 60)
    [[ "$rc" == 0 ]] || echo "WARNING: egress firewall removal exited $rc — see $LOG_DIR/offline-restore-egress.log" >&2
  fi
}
trap finish EXIT

# ── Leg 1: installer identity (local) ────────────────────────────────────────
echo "== offline-installer journey ($PLATFORM) run=$RUN_DIR" >&2
for role in gui server; do
  f="$GUI_ARTIFACT"; [[ "$role" == server ]] && f="$SERVER_ARTIFACT"
  ident "installer.$role" name "$(basename "$f")"
  ident "installer.$role" sha256 "$(sha256_local "$f")"
  ident "installer.$role" bytes "$(stat -c %s "$f")"
done
ident witness name "$(basename "$WITNESS")"
WITNESS_SHA="$(sha256_local "$WITNESS")"
ident witness sha256 "$WITNESS_SHA"
ident witness bytes "$(stat -c %s "$WITNESS")"
if [[ -z "$LEDGER_JSON" ]]; then
  leg installer-identity unmeasured "no --ledger-json: installer sha256 recorded but not matched to the release ledger"
else
  ledger_out="$(python3 - "$LEDGER_JSON" "$IDS" <<'PY'
import json, sys
led = json.load(open(sys.argv[1]))
if isinstance(led, dict): led = led.get('artifacts', [])
by = {a.get('name'): a for a in led if isinstance(a, dict)}
ids = {}
for line in open(sys.argv[2]):
    s, k, v = line.rstrip('\n').split('\t', 2); ids.setdefault(s, {})[k] = v
bad = []
for role in ('installer.gui', 'installer.server'):
    i = ids[role]; a = by.get(i['name'])
    if a is None: bad.append(f"{i['name']}: not in ledger"); continue
    size = a.get('size', a.get('bytes'))
    if a.get('sha256') != i['sha256']: bad.append(f"{i['name']}: sha256 {i['sha256']} != ledger {a.get('sha256')}")
    if size is not None and int(size) != int(i['bytes']): bad.append(f"{i['name']}: bytes {i['bytes']} != ledger {size}")
print('OK' if not bad else 'BAD ' + '; '.join(bad))
PY
)"
  if [[ "$ledger_out" == OK ]]; then leg installer-identity pass "GUI+Server installer sha256/bytes match the release ledger"
  else leg installer-identity fail "${ledger_out#BAD }"; fi
fi

# ── Leg 1b: the runtime sha the Discovery/join evidence names (D-083) ─────────
# Without a live peer join, this row stands only if its runtime artifact is the
# exact artifact the discovery-join evidence proved for the same candidate.
if [[ -z "$JOIN_EVIDENCE" ]]; then
  leg join-runtime-match unmeasured "no --join-evidence: the runtime sha256 is not compared with the discovery-join evidence (D-083)"
else
  ident join evidencePath "$JOIN_EVIDENCE"
  ident join evidenceSha256 "$(sha256_local "$JOIN_EVIDENCE")"
  join_out="$(python3 - "$JOIN_EVIDENCE" "$WITNESS_SHA" <<'PY'
import json, re, sys
try:
    doc = json.load(open(sys.argv[1]))
except Exception as e:  # unreadable evidence cannot vouch for anything
    print(f"VOID unreadable join evidence: {e}"); sys.exit(0)
want = sys.argv[2]
subj = doc.get('subject') if isinstance(doc, dict) and isinstance(doc.get('subject'), dict) else {}
named = sorted({subj[k] for k in ('debSha256', 'artifactSha256')
                if isinstance(subj.get(k), str) and re.fullmatch(r'[0-9a-f]{64}', subj[k])})
if not named:
    print('VOID join evidence names no runtime sha256 (subject.debSha256 / subject.artifactSha256)')
elif want in named:
    print(f'PASS {want}')
else:
    print(f"FAIL runtime sha256 {want} != discovery-join {','.join(named)}")
PY
)"
  case "$join_out" in
    PASS\ *) ident join runtimeSha256 "${join_out#PASS }"
             leg join-runtime-match pass "runtime sha256 ${WITNESS_SHA:0:16} is the one the discovery-join evidence names" ;;
    FAIL\ *) leg join-runtime-match fail "${join_out#FAIL }" ;;
    VOID\ *) leg join-runtime-match void "${join_out#VOID }" ;;
    *) leg join-runtime-match void "join evidence check produced no verdict" ;;
  esac
fi

# ── Leg 2: runtime identity from the WITNESS bytes (local) ───────────────────
wdir="$RUN_DIR/witness"; mkdir -p "$wdir"
case "$WITNESS" in
  *.deb)
    dpkg-deb --fsys-tarfile "$WITNESS" 2>"$LOG_DIR/witness-extract.log" | tar -x -C "$wdir" --wildcards \
      '*/sidecar/serve.mjs' '*/sidecar/bin/node' '*/sidecar/build-provenance.json' '*/sidecar/db-sql/*' \
      >>"$LOG_DIR/witness-extract.log" 2>&1 ;;
  *.tar.gz|*.tgz)
    tar -xzf "$WITNESS" -C "$wdir" --wildcards \
      '*/Contents/Resources/sidecar/serve.mjs' '*/Contents/Resources/sidecar/bin/node' \
      '*/Contents/Resources/sidecar/build-provenance.json' '*/Contents/Resources/sidecar/db-sql/*' \
      >"$LOG_DIR/witness-extract.log" 2>&1 ;;
  *) die2 "--witness must be a .deb or an .app.tar.gz: $WITNESS" ;;
esac
wside="$(find "$wdir" -type f -name serve.mjs -path '*/sidecar/serve.mjs' -not -path '*/env-sidecars/*' | head -1)"
if [[ -z "$wside" ]]; then
  leg runtime-identity fail "witness carries no sidecar/serve.mjs ($LOG_DIR/witness-extract.log)" "$LOG_DIR/witness-extract.log"
  WITNESS_OK=0
else
  bash -c "$RUNTIME_DIGEST_FN"$'\n'"pcoij_runtime_digest \"\$1\" witness" _ "$(dirname "$wside")" > "$RUN_DIR/witness.kv" 2>>"$LOG_DIR/witness-extract.log"
  for k in $RUNTIME_FIELDS; do ident runtime.witness "$k" "$(kv "witness.$k" "$RUN_DIR/witness.kv")"; done
  [[ -n "$EXPECTED_VERSION" ]] || EXPECTED_VERSION="$(kv witness.version "$RUN_DIR/witness.kv")"
  if [[ -z "$EXPECTED_SHA" ]]; then
    EXPECTED_SHA="$(kv witness.buildSha "$RUN_DIR/witness.kv")"
    [[ -n "$EXPECTED_SHA" ]] || EXPECTED_SHA="$(kv witness.gitHead "$RUN_DIR/witness.kv")"
  fi
  missing="$(grep -E '=MISSING$' "$RUN_DIR/witness.kv" | sed 's/^PCOIJ //' | tr '\n' ' ')"
  if [[ -n "$missing" ]]; then leg runtime-identity fail "witness runtime incomplete: $missing"; WITNESS_OK=0
  elif [[ -z "$EXPECTED_SHA" || -z "$EXPECTED_VERSION" ]]; then
    leg runtime-identity fail "witness provenance names no version/buildSha/gitHead and none was passed"; WITNESS_OK=0
  else
    leg runtime-identity pass "witness serve.mjs=$(kv witness.serve.mjs "$RUN_DIR/witness.kv" | cut -c1-16) db-sql head=$(kv witness.db-sql.head "$RUN_DIR/witness.kv") version=$EXPECTED_VERSION sha=${EXPECTED_SHA:0:12}"
    WITNESS_OK=1
  fi
fi
ident candidate expectedVersion "$EXPECTED_VERSION"
ident candidate expectedSha "$EXPECTED_SHA"
# /api/health reports the release's baked buildSha, never the source gitHead
# (run 6 of WI-10003962 false-failed first-launch by comparing against it).
[[ -n "$EXPECTED_HEALTH_SHA" ]] || EXPECTED_HEALTH_SHA="$(kv witness.buildSha "$RUN_DIR/witness.kv")"
[[ -n "$EXPECTED_HEALTH_SHA" ]] || die2 "no /api/health identity: the witness provenance buildSha is empty and --expected-health-sha was not passed. Pass the release's baked buildSha (e.g. from the candidate provenance evidence); gitHead is the source sha, not the health identity."
ident candidate expectedHealthSha "$EXPECTED_HEALTH_SHA"

# ── Remote scripts ───────────────────────────────────────────────────────────
read -r -d '' PREFLIGHT <<'SH'
echo "PCOIJ uname=$(uname -srm)"
mkdir -p "$REMOTE_DIR" && [ -w "$REMOTE_DIR" ] && echo "PCOIJ remoteDir=ok" || echo "PCOIJ remoteDir=unwritable"
if [ "$PLATFORM" = linux ]; then
  st=$(dpkg-query -W -f='${Package}=${db:Status-Abbrev} ' papercusp-server papercusp-gui 2>/dev/null)
  echo "PCOIJ dpkgStatus=$st"
  case "$st" in *ii*|*iU*|*iF*|*rc*) echo "PCOIJ existing=yes" ;; *) echo "PCOIJ existing=no" ;; esac
else
  if [ -e "$SERVER_ROOT" ] || [ -e "$GUI_MARK" ]; then echo "PCOIJ existing=yes"; else echo "PCOIJ existing=no"; fi
fi
[ -e "$SIDECAR" ] && echo "PCOIJ sidecarPresent=yes" || echo "PCOIJ sidecarPresent=no"
if [ -f "$OPJSON" ]; then
  port=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$OPJSON" | head -1)
  if [ -n "$port" ] && curl -s -o /dev/null -m 3 "http://127.0.0.1:$port/api/health"; then echo "PCOIJ priorOperator=answering:$port"; else echo "PCOIJ priorOperator=stale-record"; fi
else echo "PCOIJ priorOperator=none"; fi
SH

EGRESS_PROBE='egress() { for u in https://archive.ubuntu.com/ https://pub-cb5359a346e94c0c88562bd41db9295a.r2.dev/ https://github.com/; do if curl -s -o /dev/null -m 6 "$u"; then echo "reachable:$u"; return 0; fi; done; echo denied; return 1; }'
read -r -d '' OFFLINE_UP <<SH
$EGRESS_PROBE
echo "PCOIJ egressBefore=\$(egress)"
if [ "\$PLATFORM" = linux ] && [ "$OFFLINE_MODE" = enforce ]; then
  if command -v iptables >/dev/null 2>&1; then
    for t in iptables ip6tables; do
      command -v \$t >/dev/null 2>&1 || continue
      sudo -n \$t -N PCOIJ_OFFLINE 2>/dev/null || sudo -n \$t -F PCOIJ_OFFLINE
      sudo -n \$t -A PCOIJ_OFFLINE -o lo -j RETURN
      # Keep the driver's own control session alive: the conntrack match below loads
      # nf_conntrack mid-session, so this ssh flow's next reply is first seen as NEW
      # and would hit REJECT (measured on the Linux clean-room VM, 0.0.25 run).
      # Replies FROM the guest's sshd are not egress; outbound ssh uses --dport 22.
      sudo -n \$t -A PCOIJ_OFFLINE -p tcp --sport 22 -j RETURN
      sudo -n \$t -A PCOIJ_OFFLINE -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
      sudo -n \$t -A PCOIJ_OFFLINE -j REJECT
      sudo -n \$t -C OUTPUT -j PCOIJ_OFFLINE 2>/dev/null || sudo -n \$t -I OUTPUT 1 -j PCOIJ_OFFLINE
    done
    echo "PCOIJ firewall=iptables"
  else
    echo "PCOIJ firewall=unavailable"
  fi
fi
echo "PCOIJ egressAfter=\$(egress)"
SH
read -r -d '' OFFLINE_DOWN <<'SH'
for t in iptables ip6tables; do
  command -v $t >/dev/null 2>&1 || continue
  sudo -n $t -D OUTPUT -j PCOIJ_OFFLINE 2>/dev/null
  sudo -n $t -F PCOIJ_OFFLINE 2>/dev/null; sudo -n $t -X PCOIJ_OFFLINE 2>/dev/null
done
echo "PCOIJ firewall=removed"
SH

read -r -d '' PROVISION_LINUX <<'SH'
GUI="$REMOTE_DIR/gui.deb"; SRV="$REMOTE_DIR/server.deb"
# Declared Depends + Recommends of BOTH .debs, from their control fields. An entry
# naming a Papercusp package (alternatives included) is dropped: this step must
# never install Papercusp itself.
decl=""
for d in "$SRV" "$GUI"; do
  for f in Depends Recommends; do
    v=$(dpkg-deb -f "$d" "$f" 2>/dev/null | tr '\n' ' ')
    echo "PCOIJ declared.$(basename "$d" .deb).$f=$v"
    [ -n "$v" ] && decl="$decl${decl:+, }$v"
  done
done
keep=$(printf '%s' "$decl" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' | grep -v 'papercusp' | paste -sd, - | sed 's/,/, /g')
echo "PCOIJ satisfy=$keep"
dpkg-query -W -f='${Package}=${Version}\n' 2>/dev/null | LC_ALL=C sort > "$REMOTE_DIR/dpkg-before.txt"
if [ -z "$keep" ]; then
  echo "PCOIJ satisfyExit=0"
else
  sudo -n apt-get update > "$REMOTE_DIR/apt-update.log" 2>&1; echo "PCOIJ aptUpdateExit=$?"
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get satisfy --yes "$keep" > "$REMOTE_DIR/apt-satisfy.log" 2>&1
  echo "PCOIJ satisfyExit=$?"
  echo "PCOIJ satisfyError=$(grep -E '^E:' "$REMOTE_DIR/apt-satisfy.log" | head -2 | tr '\n' ' ')"
fi
dpkg-query -W -f='${Package}=${Version}\n' 2>/dev/null | LC_ALL=C sort > "$REMOTE_DIR/dpkg-after.txt"
prov=$(LC_ALL=C comm -13 "$REMOTE_DIR/dpkg-before.txt" "$REMOTE_DIR/dpkg-after.txt")
echo "PCOIJ provisioned=$(printf '%s' "$prov" | tr '\n' ' ')"
echo "PCOIJ provisionedCount=$(printf '%s' "$prov" | grep -c .)"
echo "PCOIJ provisionedPapercusp=$(printf '%s' "$prov" | grep '^papercusp' | tr '\n' ' ')"
SH

read -r -d '' INSTALL_LINUX <<'SH'
GUI="$REMOTE_DIR/gui.deb"; SRV="$REMOTE_DIR/server.deb"
# Offline dependency closure: anything apt would still have to fetch is named.
# Simulate WITHOUT --no-download: `-s` never downloads, and with --no-download apt
# aborts ("Unable to fetch some archives") before printing a single Inst line,
# which left this list empty on the real 0.0.25 VM run.
sudo -n apt-get -s install "$SRV" "$GUI" > "$REMOTE_DIR/apt-sim.log" 2>&1; echo "PCOIJ aptSimExit=$?"
need=$(sed -n 's/^Inst \([^ ]*\).*/\1/p' "$REMOTE_DIR/apt-sim.log" | grep -v '^papercusp-' | while read -r p; do
  ls "$PCOIJ_ROOT"/var/cache/apt/archives/"${p}"_*.deb >/dev/null 2>&1 || printf '%s ' "$p"; done)
echo "PCOIJ needsDownload=$need"
# NOT --no-download: apt "fetches" a local .deb argument into its archive through
# its own acquire step, which --no-download disables, so apt 2.8 aborts with
# "Internal Error, Pathname to install is not absolute" (measured, 0.0.25 VM run 4).
# "Fetch nothing" is instead ENFORCED by the egress firewall above and PROVEN
# below: every remote Get/Err/Ign line apt prints is counted and must be zero.
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install --yes "$SRV" "$GUI" > "$REMOTE_DIR/apt-install.log" 2>&1
echo "PCOIJ installExit=$?"
echo "PCOIJ remoteFetches=$(grep -cE '^(Get|Err|Ign):[0-9]+ [a-z0-9+.-]+://' "$REMOTE_DIR/apt-install.log")"
echo "PCOIJ aptError=$(grep -E '^E:' "$REMOTE_DIR/apt-install.log" | head -2 | tr '\n' ' ')"
tail -n 20 "$REMOTE_DIR/apt-install.log" | sed 's/^/PCOIJ-LOG /'
st=$(dpkg-query -W -f='${Package}=${db:Status-Abbrev} ' papercusp-server papercusp-gui 2>/dev/null)
echo "PCOIJ dpkgStatus=$st"
SH
read -r -d '' INSTALL_MAC <<'SH'
rc_all=0
for role in Server GUI; do
  dmg="$REMOTE_DIR/$(echo "$role" | tr 'A-Z' 'a-z').dmg"; app="Papercusp $role"
  mnt=$(mktemp -d /tmp/pcoij-dmg.XXXXXX); target="$PCOIJ_ROOT/Applications/$app.app"; stage="$PCOIJ_ROOT/Applications/.$app.app.pcoij.$$"
  ( set -e
    hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null
    test -d "$mnt/$app.app"
    rm -rf "$stage"; ditto --noextattr --noqtn "$mnt/$app.app" "$stage"; xattr -cr "$stage"
    codesign --verify --deep --strict "$stage"
    mv "$stage" "$target" )
  rc=$?; hdiutil detach "$mnt" >/dev/null 2>&1; rmdir "$mnt" 2>/dev/null; rm -rf "$stage"
  echo "PCOIJ install.$role=$rc"; [ "$rc" = 0 ] || rc_all=$rc
done
echo "PCOIJ installExit=$rc_all"
SH

read -r -d '' INSTALLED_BYTES <<'SH'
pcoij_runtime_digest "$SIDECAR" installed
SH

# Health: bind the operator the install started (operator record first, like
# vm-rig/vmcall.sh), then resolve the LISTENING pid's executable. A 200 from a
# process outside the installed tree is not the artifact (EI-19426130546444930).
read -r -d '' HEALTH_FN <<'SH'
pid_for_port() {
  if [ "$PLATFORM" = linux ]; then ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1
  else lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; fi
}
exe_for_pid() {
  if [ "$PLATFORM" = linux ]; then readlink -f "/proc/$1/exe"
  else lsof -p "$1" -a -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; fi
}
wait_health() { # $1 = label
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    port=""; [ -f "$OPJSON" ] && port=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$OPJSON" | head -1)
    if [ -n "$port" ]; then
      body=$(curl -s -m 5 "http://127.0.0.1:$port/api/health" 2>/dev/null)
      case "$body" in *'"sha"'*)
        pid=$(pid_for_port "$port"); exe=""; [ -n "$pid" ] && exe=$(exe_for_pid "$pid")
        echo "PCOIJ $1.port=$port"; echo "PCOIJ $1.body=$(printf '%s' "$body" | tr -d '\n')"
        echo "PCOIJ $1.sha=$(printf '%s' "$body" | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
        echo "PCOIJ $1.version=$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
        echo "PCOIJ $1.pid=$pid"; echo "PCOIJ $1.exe=$exe"
        [ -n "$exe" ] && [ -f "$exe" ] && echo "PCOIJ $1.exeSha=$(pcoij_sha "$exe")"
        return 0 ;;
      esac
    fi
    sleep "$HEALTH_POLL"
  done
  echo "PCOIJ $1.timeout=${HEALTH_TIMEOUT}s"; return 1
}
SH
read -r -d '' LAUNCH <<'SH'
if [ "$PLATFORM" = linux ]; then
  # A headless peer dies with the last login unless the user lingers (WI-479556).
  sudo -n loginctl enable-linger "$(id -un)" >/dev/null 2>&1; echo "PCOIJ linger=$?"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  systemctl --user daemon-reload; systemctl --user enable --now papercusp-server.service; echo "PCOIJ launchExit=$?"
else
  open -n "$SERVER_ROOT"; echo "PCOIJ launchExit=$?"
fi
wait_health launch
SH
read -r -d '' RESTORE <<'SH'
# Plan D-088: the offline self-admit lands only after the first-boot join attempt
# gives up, so ONE read right after health measures nothing (run 7 read at +1s).
# Poll until the pot is listed or RESTORE_TIMEOUT elapses.
start=$(date +%s); deadline=$(( start + RESTORE_TIMEOUT )); n=0; present=no; rc=""
while :; do
  n=$((n + 1))
  port=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$OPJSON" 2>/dev/null | head -1)
  PAPERCUSP_HONO_PORT="$port" "$SIDECAR/bin/node" "$REMOTE_DIR/mcp-call.mjs" pot:list '{}' > "$REMOTE_DIR/pot-list.out" 2>&1
  rc=$?
  if [ "$rc" = 0 ] && grep -Eq "\"slug\"[[:space:]]*:[[:space:]]*\"$EXPECT_POT\"" "$REMOTE_DIR/pot-list.out"; then present=yes; break; fi
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep "$RESTORE_POLL"
done
echo "PCOIJ potListExit=$rc"; echo "PCOIJ potPresent=$present"
echo "PCOIJ potListAttempts=$n"; echo "PCOIJ potListElapsedSec=$(( $(date +%s) - start ))"
head -c 1500 "$REMOTE_DIR/pot-list.out" | tr '\n' ' ' | sed 's/^/PCOIJ-LOG /'; echo
# DIAGNOSTICS only (never gate): the bootstrap's own '[papercusp-hive]' lines —
# the pre-join seed restore outcome and the offline self-admit / join outcome.
if [ "$PLATFORM" = linux ]; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  journalctl --user -u papercusp-server.service --no-pager -o cat > "$REMOTE_DIR/journal.out" 2> "$REMOTE_DIR/journal.err"
  echo "PCOIJ journalExit=$?"
  grep -a '\[papercusp-hive\]' "$REMOTE_DIR/journal.out" | head -40 | sed 's/^/PCOIJ-HIVE /'
  # The evidence is built from TSV rows: a tab in a journal line must not split one.
  seed=$(grep -a '\[papercusp-hive\] seed restore' "$REMOTE_DIR/journal.out" | tail -1 | sed 's/.*\[papercusp-hive\] //' | tr '\t' ' ')
  last=$(grep -a '\[papercusp-hive\]' "$REMOTE_DIR/journal.out" | tail -1 | sed 's/.*\[papercusp-hive\] //' | tr '\t' ' ')
  echo "PCOIJ seedRestore=${seed:-no seed-restore line in the server journal}"
  echo "PCOIJ bootstrapLast=${last:-no [papercusp-hive] line in the server journal}"
else
  echo "PCOIJ journalExit=unavailable"
  echo "PCOIJ seedRestore=unmeasured: no server journal on $PLATFORM"
  echo "PCOIJ bootstrapLast=unmeasured: no server journal on $PLATFORM"
fi
SH
read -r -d '' RESTART <<'SH'
if [ "$PLATFORM" = linux ]; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  systemctl --user restart papercusp-server.service; echo "PCOIJ restartExit=$?"
else
  # Stop exactly the pid serving the operator record (never by name), then relaunch.
  port=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$OPJSON" | head -1)
  old=$(pid_for_port "$port"); [ -n "$old" ] && kill -TERM "$old"
  for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$old" 2>/dev/null || break; sleep 2; done
  open -n "$SERVER_ROOT"; echo "PCOIJ restartExit=$?"
fi
sleep 2
wait_health restart
SH

# ── Leg 3: preflight ─────────────────────────────────────────────────────────
rc=$(remote preflight "$PREFLIGHT" 60); PF="$LOG_DIR/preflight.log"
if [[ "$rc" != 0 ]] && ! grep -q '^PCOIJ uname=' "$PF"; then
  leg preflight-fresh void "target unreachable (exit $rc) — see $PF" "$PF"; TARGET_OK=0
elif [[ "$(kv remoteDir "$PF")" != ok ]]; then
  leg preflight-fresh void "remote dir $REMOTE_DIR not writable" "$PF"; TARGET_OK=0
elif [[ "$(kv existing "$PF")" != no || "$(kv sidecarPresent "$PF")" != no ]]; then
  leg preflight-fresh void "target already carries a Papercusp install ($(kv dpkgStatus "$PF")) — not a fresh install" "$PF"; TARGET_OK=0
elif [[ "$(kv priorOperator "$PF")" == answering:* ]]; then
  leg preflight-fresh void "an operator already answers ($(kv priorOperator "$PF")) — a stray listener could satisfy the health probe" "$PF"; TARGET_OK=0
else
  leg preflight-fresh pass "$(kv uname "$PF"); no prior install; prior operator record: $(kv priorOperator "$PF")" "$PF"; TARGET_OK=1
fi
ident target uname "$(kv uname "$PF")"
ident target host "$SSH_HOST"

skip_rest() { # mark every remaining leg unmeasured with one reason
  local l; for l in "$@"; do leg "$l" unmeasured "$REASON"; done
}
REMAINING="offline install installed-bytes witness-compat first-launch offline-restore restart-reresolve"
[[ "$PLATFORM" == linux ]] && REMAINING="os-prerequisites $REMAINING"
if [[ "$TARGET_OK" != 1 ]]; then
  REASON="not reached: preflight did not pass"; skip_rest $REMAINING
else
  # Artifacts go over the control session once, BEFORE egress is denied (scp is
  # not egress either way); linux provisioning reads the .debs' control fields.
  ext=deb; [[ "$PLATFORM" == mac ]] && ext=dmg
  PUSH_OK=0
  push "$GUI_ARTIFACT" "$REMOTE_DIR/gui.$ext" && push "$SERVER_ARTIFACT" "$REMOTE_DIR/server.$ext" && push "$MCP_CALL" "$REMOTE_DIR/mcp-call.mjs" && PUSH_OK=1

  # ── Leg 3b: OS prerequisites, provisioned ONLINE (linux) ─────────────────
  if [[ "$PLATFORM" == linux ]]; then
    if [[ "$PUSH_OK" != 1 ]]; then
      leg os-prerequisites unmeasured "artifact transfer failed — see $LOG_DIR/push.log" "$LOG_DIR/push.log"
    else
      rc=$(remote os-prerequisites "$PROVISION_LINUX" "$INSTALL_TIMEOUT"); PR="$LOG_DIR/os-prerequisites.log"
      for k in declared.server.Depends declared.server.Recommends declared.gui.Depends declared.gui.Recommends satisfy provisioned provisionedCount; do
        ident osPrerequisites "$k" "$(kv "$k" "$PR")"
      done
      ident osPrerequisites satisfyExit "$(kv satisfyExit "$PR")"
      if [[ "$rc" == 124 ]]; then leg os-prerequisites fail "provisioning exceeded ${INSTALL_TIMEOUT}s" "$PR"
      elif [[ -z "$(kv satisfyExit "$PR")" ]]; then
        leg os-prerequisites void "provisioning script returned no satisfyExit (ssh rc=$rc) — not a measurement" "$PR"
      elif [[ "$(kv satisfyExit "$PR")" != 0 ]]; then
        leg os-prerequisites fail "the distro cannot satisfy a declared dependency: apt-get satisfy exit $(kv satisfyExit "$PR"): $(kv satisfyError "$PR")" "$PR"
      elif [[ -n "$(kv provisionedPapercusp "$PR")" ]]; then
        leg os-prerequisites fail "provisioning installed a Papercusp package: $(kv provisionedPapercusp "$PR")" "$PR"
      else
        leg os-prerequisites pass "$(kv provisionedCount "$PR") packages provisioned online from the declared Depends+Recommends of both .debs (no Papercusp package)" "$PR"
      fi
    fi
  fi

  # ── Leg 4: offline ───────────────────────────────────────────────────────
  rc=$(remote offline-deny-egress "$OFFLINE_UP" 120); OF="$LOG_DIR/offline-deny-egress.log"
  [[ "$(kv firewall "$OF")" == iptables ]] && FIREWALL_APPLIED=1
  before="$(kv egressBefore "$OF")"; after="$(kv egressAfter "$OF")"
  ident offline mode "$OFFLINE_MODE"; ident offline egressBefore "$before"; ident offline egressAfter "$after"
  ident offline firewall "$(kv firewall "$OF")"
  if [[ -z "$after" ]]; then
    leg offline void "offline script returned no egressAfter (ssh rc=$rc): the control session was lost while enforcing — not a measurement of egress" "$OF"; OFFLINE_OK=0
  elif [[ "$after" == denied ]]; then
    leg offline pass "egress before=$before; after=denied (mode=$OFFLINE_MODE, firewall=$(kv firewall "$OF"))" "$OF"; OFFLINE_OK=1
  elif [[ "$OFFLINE_MODE" == enforce ]]; then
    leg offline void "egress still $after after enforcement (firewall=$(kv firewall "$OF")) — the run cannot claim offline" "$OF"; OFFLINE_OK=0
  else
    leg offline unmeasured "target has egress ($after) and --offline verify cannot deny it; the install below is NOT an offline proof" "$OF"; OFFLINE_OK=0
  fi

  # ── Leg 5: install ───────────────────────────────────────────────────────
  if [[ "$PUSH_OK" == 1 ]]; then
    body="$INSTALL_LINUX"; [[ "$PLATFORM" == mac ]] && body="$INSTALL_MAC"
    rc=$(remote install "$body" "$INSTALL_TIMEOUT"); IN="$LOG_DIR/install.log"
    ident install needsDownload "$(kv needsDownload "$IN")"
    ident install installExit "$(kv installExit "$IN")"
    ident install remoteFetches "$(kv remoteFetches "$IN")"
    ident install sshExit "$rc"
    if [[ "$rc" == 124 ]]; then leg install fail "installer exceeded ${INSTALL_TIMEOUT}s" "$IN"; INSTALL_OK=0
    elif [[ "$(kv installExit "$IN")" != 0 ]]; then
      apt_err=""; [[ "$PLATFORM" == linux ]] && apt_err="; apt: $(kv aptError "$IN")"
      leg install fail "installer exit $(kv installExit "$IN"); offline-unsatisfied deps: $(kv needsDownload "$IN")$apt_err" "$IN"; INSTALL_OK=0
    elif [[ "$PLATFORM" == linux && "$(kv remoteFetches "$IN")" != 0 ]]; then
      leg install fail "the offline install fetched $(kv remoteFetches "$IN") remote archive(s) — not an offline install" "$IN"; INSTALL_OK=0
    elif [[ "$PLATFORM" == linux && "$(kv dpkgStatus "$IN")" != *papercusp-server=ii* ]] || [[ "$PLATFORM" == linux && "$(kv dpkgStatus "$IN")" != *papercusp-gui=ii* ]]; then
      leg install fail "packages not fully configured: $(kv dpkgStatus "$IN")" "$IN"; INSTALL_OK=0
    else
      fetched=""; [[ "$PLATFORM" == linux ]] && fetched="; 0 remote fetches"
      leg install pass "GUI+Server installers exit 0 ($(kv dpkgStatus "$IN"))$fetched" "$IN"; INSTALL_OK=1
    fi
  else
    leg install fail "artifact transfer failed — see $LOG_DIR/push.log" "$LOG_DIR/push.log"; INSTALL_OK=0
  fi

  if [[ "$INSTALL_OK" != 1 ]]; then
    REASON="not reached: install did not pass"; skip_rest installed-bytes witness-compat first-launch offline-restore restart-reresolve
  else
    # ── Leg 6+7: installed bytes and witness compatibility ─────────────────
    rc=$(remote installed-bytes "$INSTALLED_BYTES" 900); IB="$LOG_DIR/installed-bytes.log"
    for k in $RUNTIME_FIELDS; do ident runtime.installed "$k" "$(kv "installed.$k" "$IB")"; done
    miss="$(grep -E '^PCOIJ installed\..*=MISSING$' "$IB" | sed 's/^PCOIJ //' | tr '\n' ' ')"
    if [[ "$rc" != 0 || -n "$miss" ]]; then leg installed-bytes fail "installed runtime incomplete (exit $rc): $miss" "$IB"
    else leg installed-bytes pass "installed serve.mjs=$(kv installed.serve.mjs "$IB" | cut -c1-16) db-sql head=$(kv installed.db-sql.head "$IB")" "$IB"; fi
    if [[ "$WITNESS_OK" != 1 ]]; then leg witness-compat unmeasured "no witness runtime identity to compare against"
    else
      diffs=""
      for k in $RUNTIME_FIELDS; do
        w="$(kv "witness.$k" "$RUN_DIR/witness.kv")"; i="$(kv "installed.$k" "$IB")"
        # An unmeasured field on either side is a difference, never a match:
        # empty == empty would otherwise pass a comparison that read nothing.
        if [[ -z "$w" || -z "$i" || "$w" == MISSING || "$i" == MISSING ]]; then
          # buildSha is legitimately empty in shipped provenance (gitHead carries it).
          [[ "$k" == buildSha && "$w" == "$i" ]] && continue
          diffs+="$k(unmeasured: witness='${w:0:16}' installed='${i:0:16}') "
        elif [[ "$w" != "$i" ]]; then
          diffs+="$k(witness=${w:0:16} installed=${i:0:16}) "
        fi
      done
      if [[ -z "$diffs" ]]; then leg witness-compat pass "installed runtime == minimal-witness runtime on all $(wc -w <<<"$RUNTIME_FIELDS") fields"
      else leg witness-compat fail "installed runtime differs from the witness: $diffs"; fi
    fi

    # ── Leg 8: first launch, process resolved to the installed bytes ───────
    rc=$(remote launch "$HEALTH_FN"$'\n'"$LAUNCH" $((HEALTH_TIMEOUT + 60))); LA="$LOG_DIR/launch.log"
    node_sha="$(kv installed.bin/node "$IB")"
    check_serving() { # LABEL LOGFILE -> sets SERVE_DETAIL, returns 0 when every binding holds
      local L="$1" F="$2" sha ver exe exesha problems=""
      sha="$(kv "$L.sha" "$F")"; ver="$(kv "$L.version" "$F")"; exe="$(kv "$L.exe" "$F")"; exesha="$(kv "$L.exeSha" "$F")"
      [[ -n "$(kv "$L.timeout" "$F")" ]] && problems+="no /api/health within ${HEALTH_TIMEOUT}s; "
      sha_matches "$sha" "$EXPECTED_HEALTH_SHA" || problems+="health sha '$sha' is not the candidate's baked buildSha ${EXPECTED_HEALTH_SHA:0:12}; "
      [[ "$ver" == "$EXPECTED_VERSION" ]] || problems+="health version '$ver' != $EXPECTED_VERSION; "
      case "$exe" in */sidecar/bin/node) ;; *) problems+="listener exe '$exe' is not the installed sidecar node; " ;; esac
      [[ -n "$exesha" && "$exesha" == "$node_sha" ]] || problems+="listener exe sha ${exesha:0:16} != installed bin/node ${node_sha:0:16}; "
      SERVE_DETAIL="port=$(kv "$L.port" "$F") pid=$(kv "$L.pid" "$F") sha=$sha version=$ver exe=$exe"
      [[ -z "$problems" ]] || { SERVE_DETAIL="$problems$SERVE_DETAIL"; return 1; }
    }
    for k in port pid sha version exe exeSha; do ident serving.launch "$k" "$(kv "launch.$k" "$LA")"; done
    if check_serving launch "$LA"; then leg first-launch pass "$SERVE_DETAIL" "$LA"; LAUNCH_OK=1
    else leg first-launch fail "$SERVE_DETAIL" "$LA"; LAUNCH_OK=0; fi

    if [[ "$LAUNCH_OK" != 1 ]]; then
      REASON="not reached: first launch did not pass"; skip_rest offline-restore restart-reresolve
    else
      # ── Leg 9: the seeded hive restored while offline ──────────────────
      rc=$(remote offline-restore "$RESTORE" $((RESTORE_TIMEOUT + 120))); RS="$LOG_DIR/offline-restore.log"
      ident restore expectPot "$EXPECT_POT"; ident restore timeoutSec "$RESTORE_TIMEOUT"
      for k in potListExit potListAttempts potListElapsedSec journalExit seedRestore bootstrapLast; do
        ident restore "$k" "$(kv "$k" "$RS")"
      done
      polled="after $(kv potListElapsedSec "$RS")s / $(kv potListAttempts "$RS") pot:list reads"
      diag="diagnostics: seed restore '$(kv seedRestore "$RS")'; bootstrap '$(kv bootstrapLast "$RS")'"
      if [[ "$(kv potPresent "$RS")" == yes && "$(kv potListExit "$RS")" == 0 ]]; then
        if [[ "$OFFLINE_OK" == 1 ]]; then leg offline-restore pass "pot '$EXPECT_POT' listed on the offline install $polled" "$RS"
        else leg offline-restore unmeasured "pot '$EXPECT_POT' listed $polled, but egress was not denied — not an offline restore" "$RS"; fi
      else
        leg offline-restore fail "pot '$EXPECT_POT' absent $polled (last pot:list exit $(kv potListExit "$RS")); $diag" "$RS"
      fi
      # ── Leg 10: restart, a new pid re-resolved to the same bytes ───────
      rc=$(remote restart "$HEALTH_FN"$'\n'"$RESTART" $((HEALTH_TIMEOUT + 120))); RR="$LOG_DIR/restart.log"
      for k in port pid sha version exe exeSha; do ident serving.restart "$k" "$(kv "restart.$k" "$RR")"; done
      if ! check_serving restart "$RR"; then leg restart-reresolve fail "$SERVE_DETAIL" "$RR"
      elif [[ "$(kv restart.pid "$RR")" == "$(kv launch.pid "$LA")" ]]; then
        leg restart-reresolve fail "pid $(kv restart.pid "$RR") unchanged — the restart did not replace the operator" "$RR"
      else leg restart-reresolve pass "new pid $(kv restart.pid "$RR") (was $(kv launch.pid "$LA")); $SERVE_DETAIL" "$RR"; fi
    fi
  fi
fi

# ── Evidence ─────────────────────────────────────────────────────────────────
FINISHED_AT="$(now)"
for f in "$LOG_DIR"/*.log; do [[ -f "$f" ]] && printf '%s\t%s\n' "$f" "$(sha256_local "$f")"; done > "$RUN_DIR/logs.tsv"
mkdir -p "$(dirname "$EVIDENCE_OUT")"
python3 - "$LEGS" "$IDS" "$RUN_DIR/logs.tsv" "$EVIDENCE_OUT" "$SCHEMA" "$PLATFORM" "$STARTED_AT" "$FINISHED_AT" "$RUN_DIR" "$ORIG_CMD" <<'PY'
import json, os, sys
legs_f, ids_f, logs_f, out, schema, platform, started, finished, run_dir, command = sys.argv[1:11]
legs = []
for line in open(legs_f):
    name, status, at, detail, log = (line.rstrip('\n').split('\t') + [''] * 5)[:5]
    legs.append({'leg': name, 'status': status, 'at': at, 'detail': detail, 'log': log or None})
ids = {}
for line in open(ids_f):
    scope, key, value = line.rstrip('\n').split('\t', 2)
    ids.setdefault(scope, {})[key] = value
statuses = [l['status'] for l in legs]
verdict = 'FAIL' if 'fail' in statuses else ('PASS' if statuses and all(s == 'pass' for s in statuses) else 'INCOMPLETE')
exit_code = {'PASS': 0, 'FAIL': 1, 'INCOMPLETE': 3}[verdict]
witness = ids.get('witness', {})
cand = ids.get('candidate', {})
artifacts, seen = [], set()
for role, scope in (('gui-installer', 'installer.gui'), ('server-installer', 'installer.server'), ('runtime-witness', 'witness')):
    a = ids.get(scope, {})
    if a.get('sha256') and a['sha256'] not in seen:
        seen.add(a['sha256'])
        artifacts.append({'role': role, 'name': a.get('name'), 'sha256': a['sha256'], 'bytes': int(a['bytes']) if a.get('bytes', '').isdigit() else None})
# The runtime sha256 sits under the SAME subject keys the Discovery/join evidence
# uses, so the readiness manifest binds this document to the candidate and can
# join the two rows on it (plan D-083).
subject = {
    'platform': platform,
    'artifact': witness.get('name'),
    'artifactSha256': witness.get('sha256'),
    'version': cand.get('expectedVersion') or None,
    'runtimeBuildSha': cand.get('expectedSha') or None,
    'artifacts': artifacts,
}
if (witness.get('name') or '').endswith('.deb'):
    subject['debSha256'] = witness.get('sha256')
doc = {
    'schemaVersion': 1, 'kind': 'operational-test-evidence',
    'name': f"P-521 full-installer compatibility ({platform}): real GUI+Server installers, offline, serving the minimal-witness bytes",
    'framework': 'operational', 'testLayer': 'e2e', 'evidencePlane': 'live',
    'plan': 'p2p-public-release-endgame-2026-09-01', 'planItem': 'P-521', 'workItem': 'WI-10003962',
    'governingDecisions': ['D-079', 'D-080', 'D-083'], 'p521Journey': 'full-installer-compat',
    'observer': os.environ.get('PAPERCUSP_SID') or None,
    'command': [command.strip()], 'exitCode': exit_code, 'subject': subject,
    'physicalRun': {
        'schemaVersion': 1, 'window': {'startedAt': started, 'finishedAt': finished},
        'legVerdicts': [{'leg': l['leg'], 'status': l['status'], 'scope': 'physical', 'observedAt': l['at']} for l in legs],
    },
    'schema': schema, 'platform': platform, 'startedAt': started, 'finishedAt': finished, 'verdict': verdict,
    'join': ids.get('join', {}),
    'candidate': ids.get('candidate', {}),
    # Installer identity is recorded SEPARATELY from the runtime artifact (P-521 candidate admission).
    'installerIdentity': {'gui': ids.get('installer.gui', {}), 'server': ids.get('installer.server', {})},
    'witness': {'artifact': ids.get('witness', {}), 'runtime': ids.get('runtime.witness', {})},
    'installedRuntime': ids.get('runtime.installed', {}),
    'serving': {'launch': ids.get('serving.launch', {}), 'restart': ids.get('serving.restart', {})},
    'target': ids.get('target', {}), 'offline': ids.get('offline', {}), 'install': ids.get('install', {}),
    # The distro dependencies provisioned ONLINE before egress was denied (package=version).
    'osPrerequisites': ids.get('osPrerequisites', {}),
    'restore': ids.get('restore', {}), 'legs': legs,
    'logs': [dict(zip(('path', 'sha256'), l.rstrip('\n').split('\t'))) for l in open(logs_f) if l.strip()],
    'runDir': run_dir,
    'scopeNote': 'No live peer join here (plan D-083): the Discovery/join row proves joining; this row proves the full installers lay down and serve, offline, the same runtime bytes that row joined with (join-runtime-match).',
}
# An absolute /home/<user>/ path trips git-sync's identity-leak content-lint, which
# then SILENTLY leaves the evidence untracked (runs 3-8 of WI-10003962 never
# committed). Redact the operator's home dir to '~' in every string, and say so.
home = os.path.expanduser('~').rstrip('/')
def redact(v):
    if isinstance(v, str): return v.replace(home + '/', '~/') if home and home != '/' else v
    if isinstance(v, list): return [redact(x) for x in v]
    if isinstance(v, dict): return {k: redact(x) for k, x in v.items()}
    return v
doc = redact(doc)
doc['redactions'] = ["the operator's home directory is written as '~' (identity-leak content-lint)"]
json.dump(doc, open(out, 'w'), indent=2, sort_keys=False)
print(verdict)
PY
verdict_rc=$?
VERDICT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["verdict"])' "$EVIDENCE_OUT" 2>/dev/null)"
echo "== verdict: ${VERDICT:-ERROR} evidence=$EVIDENCE_OUT sha256=$(sha256_local "$EVIDENCE_OUT" 2>/dev/null)" >&2
[[ "$verdict_rc" == 0 ]] || exit 2
case "$VERDICT" in PASS) exit 0 ;; FAIL) exit 1 ;; INCOMPLETE) exit 3 ;; *) exit 2 ;; esac
