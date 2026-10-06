#!/usr/bin/env bash
# P-012 (desktop-build-hardening-tri-platform-2026-07-11): release:install-and-relaunch-verify.
# The ONE canonical "did installing a new build ACTUALLY replace the running
# operator, in place, without losing its address?" check — the live proof that
# closes EI-9002 + WI-3783, so no agent re-hand-rolls it and mistakes a silent
# no-op update for a successful one.
#
# What it proves (the sequence, per platform):
#   1. BEFORE: snapshot the RUNNING operator — /api/health {sha,version} + its
#      sticky port (from operator.json). This is the pre-update operator.
#   2. PUSH: transfer the new GUI + matching Server installers to the VM; the
#      GUI does not own the operator. macOS streams each artifact through a
#      capacity-admitted remote shell so the reservation lives for the whole
#      write. On Windows, also push every provenance-listed Inno span companion.
#   3. INSTALL: run the GUI + Server installers. They replace the app bytes on
#      disk but the OLD operator keeps serving (that is exactly the EI-9002
#      scenario).
#   4. RELAUNCH — WITHOUT TERMINATING. We DELIBERATELY never kill the app or the
#      operator. We only re-launch the (now newly-installed) app and let its
#      `serve --ensure` do the work: it must detect the build-identity mismatch,
#      terminate the stale foreign operator, and cold-start fresh. If we killed
#      the operator ourselves we would be testing a cold start, NOT the
#      adopt-vs-refuse decision that EI-9002 fixed. THIS IS LOAD-BEARING.
#   5. ASSERT FLIP (EI-9002): poll /api/health until sha (and version) FLIP from
#      the pre-update values to the installed artifact's own sha. If it never
#      flips, the install was a silent no-op update — the exact EI-9002 bug.
#   6. ASSERT STICKY-PORT-HOLD (WI-3783): the operator must come back on the SAME
#      port it held before. Pre-fix, every update moved the port (17043->18384)
#      because the sticky port was resolved before the stale operator was
#      terminated. A moved port fails long-lived pinned URLs (spawned members'
#      MCP configs, tutorial-runner --operator-url, dock CLIs).
#
# Verification standard (D-007; VMs unavailable + the Windows VM must NOT be
# touched — EI-9022): this script is `bash -n`-clean and exercised against a
# MOCK ssh/scp responder (PC_SSH / PC_SCP) that models the before->after flip.
# It performs NO live VM run here. The composed tool release:install-and-relaunch-verify
# wraps it and is dryRun-validated only (no VM contact).
#
# Usage:
#   install-and-relaunch-verify.sh --artifact PATH [options]
# Options:
#   --platform windows|mac|linux   (default windows — the EI-9002/WI-3783 platform)
#   --artifact PATH                the NEW installer to push+install (required)
#   --server-artifact PATH         matching Server installer. Required for the
#                                  split Windows/macOS/Linux products; auto-resolved
#                                  beside --artifact when the exact-version file
#                                  is unambiguous. Windows Inno spans are read
#                                  from provenance.
#   --expected-sha SHA             the new build's sha; default: buildSha from a
#                                  build-provenance.json next to the artifact
#   --expected-version VER         optional; default: version from that provenance
#   --ssh-key / --ssh-port / --ssh-host / --distro / --app-image
#                                  endpoint defaults are PER PLATFORM (flags win,
#                                  then VM_SSH_KEY/VM_SSH_PORT/VM_SSH_HOST):
#                                    windows  user@127.0.0.1:2223  ~/.ssh/papercup-vm-win
#                                    mac      macuser@127.0.0.1:2222 ~/.ssh/papercup-vm-mac
#                                             (MAC_VM_SSH_HOST overrides the user@host)
#                                    linux    derived from scripts/linux-test-vm/vmctl
#                                             endpoint <PAPERCUSP_LINUX_SMOKE_VM|clean>
#                                             (tester@127.0.0.1:2224, papercup-vm-linux)
#                                  A leg whose endpoint resolves to ANOTHER platform's
#                                  VM port or key is refused (exit 2).
#   --ssh-option NAME=VALUE    repeatable extra -o option for SSH
#   --scp-option NAME=VALUE    repeatable extra -o option for SCP
#   --remote-dir DIR               where to scp the artifact (default per platform)
#   --install-cmd CMD              installer command; `__ARTIFACT__` -> remote path
#   --server-install-cmd CMD       Server installer command;
#                                  `__SERVER_ARTIFACT__` -> remote stub path
#   --verify-installed-mac         resume a prior completed DMG install: require
#                                  exact mounted-DMG/installed tree equality and
#                                  strict codesign for BOTH roles, then relaunch.
#                                  Does not copy/replace apps; reported explicitly.
#   --relaunch-cmd CMD             relaunch command (must NOT terminate the operator)
#   --flip-timeout SEC             how long to wait for the post-install health flip (default 180)
#   --baseline-timeout SEC         how long to wait for a healthy pre-update operator (default 900)
#   --install-timeout SEC          budget for the installer step (default 900);
#                                  a timeout FAILS the run (installer may still
#                                  be running detached on the VM — no relaunch)
#   --poll-interval SEC            poll cadence while waiting (default 5)
#   --smoke-receipt-tag TAG        after a PASS, atomically record a content-bound
#                                  platform smoke receipt for this release tag.
#                                  Also accepts PAPERCUSP_SMOKE_RECEIPT_TAG.
#   --smoke-provenance PATH        build-provenance.json to bind; default: nearest
#                                  ancestor of --artifact (up to the bundle root)
#   --json                         emit a machine-readable verdict
# Exit: 0 = flip happened AND port held (update genuinely replaced the operator
#       in place) · 1 = a verification assertion failed (no-flip / port-moved /
#       version-mismatch) · 2 = usage/setup (bad args, unreachable, nothing to flip).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/release-artifacts.sh
source "$HERE/lib/release-artifacts.sh"

PLATFORM="windows"
ARTIFACT=""
SERVER_ARTIFACT=""
EXPECTED_SHA=""
EXPECTED_VERSION=""
# SSH endpoint: --ssh-* flags win, then VM_SSH_* env, then the PER-PLATFORM
# default resolved after argument parsing (WI-10004052 — a single Windows
# default used to send the Linux leg to the Windows VM's :2223 with its key).
SSH_KEY="${VM_SSH_KEY:-}"
SSH_PORT="${VM_SSH_PORT:-}"
SSH_HOST="${VM_SSH_HOST:-}"
DISTRO="${DISTRO:-papercup-runtime}"
APP_IMAGE="papercusp-desktop.exe"
REMOTE_DIR=""
INSTALL_CMD=""
SERVER_INSTALL_CMD=""
RELAUNCH_CMD=""
OPJSON_PATH=""
FLIP_TIMEOUT="${FLIP_TIMEOUT:-180}"
BASELINE_TIMEOUT="${BASELINE_TIMEOUT:-900}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
# 300s proved too short live (0.0.8: the 479M GUI installer needs ~5min; the
# 3.4GB Server payload far more) — and a timeout-killed ssh leaves the VM-side
# installer RUNNING detached, so the step must fail loudly, never barrel on.
INSTALL_TIMEOUT="${INSTALL_TIMEOUT:-900}"
JSON=0
SMOKE_RECEIPT_TAG="${PAPERCUSP_SMOKE_RECEIPT_TAG:-}"
SMOKE_PROVENANCE=""
VERIFY_INSTALLED_MAC=0
SSH_OPTIONS=()
SCP_OPTIONS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --artifact) ARTIFACT="${2:-}"; shift 2 ;;
    --server-artifact) SERVER_ARTIFACT="${2:-}"; shift 2 ;;
    --expected-sha) EXPECTED_SHA="${2:-}"; shift 2 ;;
    --expected-version) EXPECTED_VERSION="${2:-}"; shift 2 ;;
    --ssh-key) SSH_KEY="${2:-}"; shift 2 ;;
    --ssh-port) SSH_PORT="${2:-}"; shift 2 ;;
    --ssh-host) SSH_HOST="${2:-}"; shift 2 ;;
    --ssh-option)
      [[ -n "${2:-}" ]] || { echo "--ssh-option needs NAME=VALUE" >&2; exit 2; }
      SSH_OPTIONS+=("${2}"); shift 2 ;;
    --scp-option)
      [[ -n "${2:-}" ]] || { echo "--scp-option needs NAME=VALUE" >&2; exit 2; }
      SCP_OPTIONS+=("${2}"); shift 2 ;;
    --distro) DISTRO="${2:-}"; shift 2 ;;
    --app-image) APP_IMAGE="${2:-}"; shift 2 ;;
    --remote-dir) REMOTE_DIR="${2:-}"; shift 2 ;;
    --install-cmd) INSTALL_CMD="${2:-}"; shift 2 ;;
    --server-install-cmd) SERVER_INSTALL_CMD="${2:-}"; shift 2 ;;
    --verify-installed-mac) VERIFY_INSTALLED_MAC=1; shift ;;
    --relaunch-cmd) RELAUNCH_CMD="${2:-}"; shift 2 ;;
    --flip-timeout) FLIP_TIMEOUT="${2:-}"; shift 2 ;;
    --baseline-timeout) BASELINE_TIMEOUT="${2:-}"; shift 2 ;;
    --install-timeout) INSTALL_TIMEOUT="${2:-}"; shift 2 ;;
    --poll-interval) POLL_INTERVAL="${2:-}"; shift 2 ;;
    --smoke-receipt-tag) SMOKE_RECEIPT_TAG="${2:-}"; shift 2 ;;
    --smoke-provenance) SMOKE_PROVENANCE="${2:-}"; shift 2 ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '2,70p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$ARTIFACT" ]] || { echo "need --artifact PATH (the new installer to push+install)" >&2; exit 2; }
[[ -f "$ARTIFACT" ]] || { echo "artifact not found: $ARTIFACT" >&2; exit 2; }
REMOTE_BASENAME="$(basename "$ARTIFACT")"
if [[ "$VERIFY_INSTALLED_MAC" == 1 ]]; then
  [[ "$PLATFORM" == mac && "$REMOTE_BASENAME" == *.dmg && -z "$INSTALL_CMD" && -z "$SERVER_INSTALL_CMD" ]] || {
    echo "--verify-installed-mac requires macOS DMGs and forbids custom install commands" >&2
    exit 2
  }
fi

# ── JSON field extractors (health body + provenance) ────────────────────────
json_str() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }
json_num() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" | head -1; }

# Render the remote install command for one macOS DMG role. Product is one of
# our fixed bundle names, and artifact_placeholder is replaced with the quoted
# remote path after platform resolution. Keeping this in one helper prevents
# the GUI and Server safety sequences from drifting apart.
mac_dmg_install_command() { # $1=product name, $2=artifact placeholder
  local product="$1" artifact_placeholder="$2" script
  # Send the maintained portable check-and-reserve helper with the remote command.
  # The receiving shell owns its reservation through copy/verification/replacement;
  # no second process can accidentally release the claim before staging finishes.
  script="$(
    cat "$HERE/lib/disk-preflight.sh"
    printf '\nset -e; set -o pipefail; '
    printf 'mount_dir=$(mktemp -d /tmp/papercusp-dmg.XXXXXX); stage="/Applications/.%s.app.install.$$"; target="/Applications/%s.app"; rollback="${target}.rollback"; rollback_old="${rollback}.old.$$.${RANDOM}"; had_target=0; had_rollback=0; cleanup() { hdiutil detach "$mount_dir" >/dev/null 2>&1 || true; rmdir "$mount_dir" >/dev/null 2>&1 || true; rm -rf "$stage"; if [ "$had_target" = 1 ] && [ ! -e "$target" ] && [ -e "$rollback" ]; then mv "$rollback" "$target" >/dev/null 2>&1 || true; fi; if [ "$had_rollback" = 1 ] && [ ! -e "$rollback" ] && [ -e "$rollback_old" ]; then mv "$rollback_old" "$rollback" >/dev/null 2>&1 || true; fi; if [ -e "$target" ] && [ -e "$rollback" ] && [ -e "$rollback_old" ]; then rm -rf "$rollback_old"; fi; }; trap cleanup EXIT HUP INT TERM; hdiutil attach -nobrowse -readonly -mountpoint "$mount_dir" %s >/dev/null; app_src="$mount_dir/%s.app"; test -d "$app_src"; ' \
      "$product" "$product" "$artifact_placeholder" "$product"
    cat <<'INSTALL'
app_kib=$(du -sk "$app_src" | awk '{print $1}')
case "$app_kib" in ''|*[!0-9]*) echo "cannot measure expanded app size: $app_src" >&2; exit 2 ;; esac
need_gb=$(( (app_kib + 1048575) / 1048576 ))
papercusp_require_free_gb "$(dirname "$target")" "$need_gb" "native app staging"
rm -rf "$stage"
ditto --noextattr --noqtn "$app_src" "$stage"
xattr -cr "$stage"
codesign --verify --deep --strict "$stage"
# Maintain exactly one known rollback. The previous rollback is not discarded
# until the verified stage is published; cleanup restores both generations if
# either rename fails or the remote shell is interrupted between them.
if [ -e "$target" ]; then
  had_target=1
  if [ -e "$rollback" ]; then
    had_rollback=1
    mv "$rollback" "$rollback_old"
  fi
  mv "$target" "$rollback"
fi
mv "$stage" "$target"
rm -rf "$rollback_old"
INSTALL
  )"
  # %q keeps the helper and paths intact across SSH's remote-shell boundary.
  printf 'bash -c %q' "$script"
}

# Stream a macOS artifact through the SAME remote shell that owns the disk
# reservation. A standalone preflight followed by scp would release its
# pid-bound claim before the first byte crossed the wire (check-then-hope).
# The default 16 GiB floor is the measured full-candidate staging requirement
# from EI-22528361121225839; callers may raise it, never silently lower it.
mac_artifact_stage_command() { # $1=remote path, $2=expected bytes, $3=required GiB
  local remote_path="$1" expected_bytes="$2" need_gb="$3" script
  script="$(
    cat "$HERE/lib/disk-preflight.sh"
    printf '\nset -e; set -o pipefail; target=%q; expected_bytes=%q; need_gb=%q; ' \
      "$remote_path" "$expected_bytes" "$need_gb"
    cat <<'STAGE'
# PAPERCUSP_NATIVE_ARTIFACT_STAGE
tmp="${target}.incoming.$$.$RANDOM"
cleanup() {
  rm -f "$tmp"
  papercusp_release_disk_reservation
}
trap cleanup EXIT HUP INT TERM
papercusp_require_free_gb "$(dirname "$target")" "$need_gb" "native artifact transfer staging"
cat > "$tmp"
actual_bytes="$(wc -c < "$tmp" | tr -d '[:space:]')"
case "$actual_bytes" in ''|*[!0-9]*) echo "cannot measure transferred artifact: $tmp" >&2; exit 2 ;; esac
if [ "$actual_bytes" != "$expected_bytes" ]; then
  echo "transferred artifact size mismatch: got $actual_bytes bytes, expected $expected_bytes" >&2
  exit 2
fi
mv -f "$tmp" "$target"
printf 'PAPERCUSP_NATIVE_ARTIFACT_STAGE_OK\n'
STAGE
  )"
  printf 'bash -c %q' "$script"
}

mac_dmg_verify_installed_command() { # $1=product, $2=artifact placeholder
  local product="$1" artifact_placeholder="$2" script
  script="$(
    printf 'set -eu; set -o pipefail; mount_dir=$(mktemp -d /tmp/papercusp-dmg.XXXXXX); target="/Applications/%s.app"; cleanup() { hdiutil detach "$mount_dir" >/dev/null 2>&1 || true; rmdir "$mount_dir" >/dev/null 2>&1 || true; }; trap cleanup EXIT HUP INT TERM; hdiutil attach -nobrowse -readonly -mountpoint "$mount_dir" %s >/dev/null; app_src="$mount_dir/%s.app"; ' \
      "$product" "$artifact_placeholder" "$product"
    cat <<'VERIFY_INSTALLED'
# PAPERCUSP_VERIFY_INSTALLED_MAC
test -d "$app_src"
test -d "$target"
# Check content, executable modes, symlink targets, missing files AND extra
# files. A successful rsync exit alone is not equality: dry-run differences
# are returned on stdout and must also be empty. Never mutate the installed app.
changes=$(rsync -rclpn --delete --itemize-changes "$app_src/" "$target/")
if [ -n "$changes" ]; then
  echo "installed macOS bundle differs from the supplied DMG: $target" >&2
  exit 2
fi
codesign --verify --deep --strict "$target"
printf 'PAPERCUSP_VERIFY_INSTALLED_MAC_OK\n'
VERIFY_INSTALLED
  )"
  printf 'bash -c %q' "$script"
}

# ── Per-platform defaults ───────────────────────────────────────────────────
# windows = the validated platform (EI-9002/WI-3783 live on the WSL operator).
# mac/linux command DEFAULTS are caller-overridable. The macOS DMG path stages
# and verifies the app before replacing the installed bundle so a failed copy or
# signature check cannot destroy the known-good app or trigger a relaunch.
case "$PLATFORM" in
  windows)
    REMOTE_DIR="${REMOTE_DIR:-C:/Users/user}"
    OPJSON_PATH="/home/papercup/.papercusp/operator.json"        # distro-side (absolute)
    # The GUI must be CLOSED before a silent install: Inno's RestartManager
    # cannot close an app across sessions (ssh session vs console session ->
    # "Session Mismatch"), so with /SUPPRESSMSGBOXES the file-in-use box is
    # auto-answered Abort and the whole install rolls back (exit 5 — live-
    # diagnosed on the 0.0.8 GUI install, 2026-07-11). Killing the GUI does NOT
    # terminate the WSL-side operator: the stale operator surviving app exit is
    # exactly the EI-9002 scenario the flip assertion exists to test.
    INSTALL_CMD="${INSTALL_CMD:-taskkill /f /im $APP_IMAGE >nul 2>&1 & __ARTIFACT__ /VERYSILENT /SUPPRESSMSGBOXES /NORESTART}"
    SERVER_INSTALL_CMD="${SERVER_INSTALL_CMD:-__SERVER_ARTIFACT__ /VERYSILENT /SUPPRESSMSGBOXES /NORESTART}"
    # BOTH apps: papercusp-e2e launches the GUI (shell only); papercusp-server-e2e
    # launches the Server app — whose startup is the ONLY thing that runs
    # `serve --ensure` in WSL, i.e. the flip cannot happen without it (0.0.8
    # live finding: GUI-only relaunch left the stale operator adopted forever).
    # Both tasks are provisioned on the win VM (papercusp-launch.cmd /
    # papercusp-server-launch.cmd, console session via schtasks).
    # Use an explicit cmd parser: the OpenSSH Windows command host is not
    # guaranteed to apply cmd.exe's compound-command semantics, so an
    # unwrapped `&` can fail before schtasks runs.
    RELAUNCH_CMD="${RELAUNCH_CMD:-cmd /c \"schtasks /run /tn papercusp-e2e & schtasks /run /tn papercusp-server-e2e\"}"
    ;;
  mac)
    REMOTE_DIR="${REMOTE_DIR:-/tmp}"
    OPJSON_PATH="\$HOME/.papercusp/operator.json"                # remote shell expands $HOME
    if [[ "$REMOTE_BASENAME" == *.dmg ]]; then
      # `ditto` preserves FinderInfo/resource-fork xattrs by default. Strict
      # codesign then rejects the otherwise-valid copied bundle with
      # "resource fork, Finder information, or similar detritus not allowed".
      # Copy without xattrs/quarantine, clear any residue, and verify the staged
      # bundle BEFORE replacing /Applications. The old app therefore survives
      # every fail-closed path and no relaunch happens unless strict codesign is
      # green (EI-21177389547731632).
      INSTALL_CMD="${INSTALL_CMD:-$(mac_dmg_install_command "Papercusp GUI" "__ARTIFACT__")}"
      SERVER_INSTALL_CMD="${SERVER_INSTALL_CMD:-$(mac_dmg_install_command "Papercusp Server" "__SERVER_ARTIFACT__")}"
      if [[ "$VERIFY_INSTALLED_MAC" == 1 ]]; then
        INSTALL_CMD="$(mac_dmg_verify_installed_command "Papercusp GUI" "__ARTIFACT__")"
        SERVER_INSTALL_CMD="$(mac_dmg_verify_installed_command "Papercusp Server" "__SERVER_ARTIFACT__")"
      fi
    else
      INSTALL_CMD="${INSTALL_CMD:-installer -pkg __ARTIFACT__ -target CurrentUserHomeDirectory}"
    fi
    # macOS is the same split product as Windows: the GUI attaches when a Server
    # operator already answers, so GUI-only relaunch can never exercise the
    # build-mismatch replacement. Launch the newly-installed Server first; its
    # own serve --ensure must replace the stale operator. The verifier itself
    # never kills it (EI-21178626752348167).
    RELAUNCH_CMD="${RELAUNCH_CMD:-open -n \"/Applications/Papercusp Server.app\"; open -n \"/Applications/Papercusp GUI.app\"}"
    ;;
  linux)
    REMOTE_DIR="${REMOTE_DIR:-/tmp}"
    OPJSON_PATH="\$HOME/.papercusp/operator.json"
    # `dpkg -i` unpacks a .deb but deliberately does not resolve its declared
    # dependencies. On a pristine Ubuntu VM that leaves the GUI in iU state
    # when WebKit is absent, so the relaunch fails before the bundled operator
    # can report the target build. A golden-image overlay can also carry stale
    # package lists: the first dependency install then requests versions that
    # mirrors have already retired and fails with 404s. Refresh the indexes in
    # the same remote command before apt's local-file install resolves and
    # configures the dependency closure.
    INSTALL_CMD="${INSTALL_CMD:-sudo apt-get update -qq && sudo env DEBIAN_FRONTEND=noninteractive apt-get install --yes __ARTIFACT__}"
    SERVER_INSTALL_CMD="${SERVER_INSTALL_CMD:-sudo env DEBIAN_FRONTEND=noninteractive apt-get install --yes __SERVER_ARTIFACT__}"
    # Linux now follows the same thin-GUI / Server-owned runtime contract as the
    # other platforms. Restart the packaged user service first; only then close
    # and reopen the GUI shell. A GUI-only relaunch cannot prove the Server
    # payload, and may attach to an old operator while appearing healthy.
    # The GUI pkill stays anchored so the remote shell cannot match itself.
    RELAUNCH_CMD="${RELAUNCH_CMD:-systemctl --user daemon-reload; systemctl --user enable --now papercusp-server.service; systemctl --user restart papercusp-server.service; pkill -f '^/usr/bin/papercusp-desktop' 2>/dev/null || true; sleep 2; export DISPLAY=\${DISPLAY:-:0} XAUTHORITY=\${XAUTHORITY:-\$HOME/.Xauthority}; setsid bash -c 'exec /usr/bin/papercusp-desktop' >\$HOME/papercusp-relaunch.log 2>&1 </dev/null & disown; sleep 2; echo relaunched}"
    ;;
  *) echo "unknown --platform: $PLATFORM (want windows|mac|linux)" >&2; exit 2 ;;
esac

# ── Per-platform SSH endpoint (WI-10004052) ─────────────────────────────────
# Each platform's leg must dial ITS OWN VM. The Linux clean-room VM's endpoint
# is derived from vmctl (ports_for/SSH_KEY/VM_USER in lib/common.sh), never
# restated here, so a VM_SSH_BASE / PAPERCUSP_TESTVM_* override moves both.
LINUX_VMCTL="${PAPERCUSP_LINUX_VMCTL:-$HERE/../scripts/linux-test-vm/vmctl}"
linux_vm_endpoint_field() { # $1=field name; reads `vmctl endpoint` output on stdin
  sed -n "s/^$1=//p" | head -1
}
LINUX_ENDPOINT=""
linux_endpoint() {
  if [[ -z "$LINUX_ENDPOINT" ]]; then
    LINUX_ENDPOINT="$(bash "$LINUX_VMCTL" endpoint "${PAPERCUSP_LINUX_SMOKE_VM:-clean}" 2>/dev/null)" || LINUX_ENDPOINT=""
  fi
  printf '%s\n' "$LINUX_ENDPOINT"
}
DERIVED_LINUX_ENDPOINT=0
case "$PLATFORM" in
  windows|mac)
    # One source with bin/smoke-target-preflight.sh (WI-10004346).
    # shellcheck source=lib/smoke-endpoints.sh
    source "$HERE/lib/smoke-endpoints.sh"
    smoke_endpoint_defaults "$PLATFORM"
    ;;
  linux)
    if [[ -z "$SSH_PORT" || -z "$SSH_KEY" || -z "$SSH_HOST" ]]; then
      endpoint="$(linux_endpoint)"
      linux_port="$(linux_vm_endpoint_field ssh_port <<<"$endpoint")"
      linux_key="$(linux_vm_endpoint_field ssh_key <<<"$endpoint")"
      linux_host="$(linux_vm_endpoint_field ssh_host <<<"$endpoint")"
      [[ "$linux_port" =~ ^[0-9]+$ && -n "$linux_key" && -n "$linux_host" ]] || {
        echo "cannot derive the Linux test VM SSH endpoint from $LINUX_VMCTL endpoint — pass --ssh-port/--ssh-key/--ssh-host" >&2
        exit 2
      }
      [[ -n "$SSH_PORT" ]] || { SSH_PORT="$linux_port"; DERIVED_LINUX_ENDPOINT=1; }
      SSH_KEY="${SSH_KEY:-$linux_key}"
      SSH_HOST="${SSH_HOST:-$linux_host}"
    fi
    ;;
esac
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] || { echo "--ssh-port must be numeric (got '$SSH_PORT')" >&2; exit 2; }

# Refuse a leg that resolved to another platform's VM. Keys are compared by
# name everywhere; ports only for loopback hosts, where every rig VM is a
# QEMU hostfwd and a port number therefore IS the machine's identity.
cross_platform_endpoint_owner() {
  local other key_name port_owner="" host_part="${SSH_HOST##*@}"
  key_name="$(basename -- "$SSH_KEY")"
  for other in windows mac linux; do
    [[ "$other" != "$PLATFORM" ]] || continue
    case "$other:$key_name" in
      windows:papercup-vm-win|mac:papercup-vm-mac|linux:papercup-vm-linux)
        printf '%s (key %s)\n' "$other" "$key_name"; return 0 ;;
    esac
  done
  case "$host_part" in
    127.0.0.1|localhost|::1) ;;
    *) return 1 ;;
  esac
  case "$PLATFORM:$SSH_PORT" in
    linux:2222|windows:2222) port_owner=mac ;;
    linux:2223|mac:2223) port_owner=windows ;;
  esac
  if [[ -z "$port_owner" && "$PLATFORM" != linux ]]; then
    local lp
    lp="$(linux_vm_endpoint_field ssh_port <<<"$(linux_endpoint)")"
    [[ -n "$lp" && "$SSH_PORT" == "$lp" ]] && port_owner=linux
  fi
  [[ -n "$port_owner" ]] || return 1
  printf '%s (loopback port :%s)\n' "$port_owner" "$SSH_PORT"
}
if foreign="$(cross_platform_endpoint_owner)"; then
  echo "refusing: --platform $PLATFORM resolved its SSH endpoint ($SSH_HOST:$SSH_PORT, key $SSH_KEY) to the $foreign VM — a $PLATFORM smoke must dial the $PLATFORM VM. Unset the stray VM_SSH_* env or pass this platform's --ssh-port/--ssh-key/--ssh-host." >&2
  exit 2
fi
# The Linux clean-room VM is rebuilt from golden on every reset, and vmctl's own
# policy is not to pin its throwaway loopback host key (lib/common.sh
# _ssh_opts). Apply the same policy when the endpoint itself was derived from
# vmctl, unless the caller already chose a host-key policy.
if [[ "$DERIVED_LINUX_ENDPOINT" == 1 ]]; then
  if [[ " ${SSH_OPTIONS[*]:-} " != *StrictHostKeyChecking=* ]]; then
    SSH_OPTIONS+=( StrictHostKeyChecking=no UserKnownHostsFile=/dev/null LogLevel=ERROR )
  fi
  if [[ " ${SCP_OPTIONS[*]:-} " != *StrictHostKeyChecking=* ]]; then
    SCP_OPTIONS+=( StrictHostKeyChecking=no UserKnownHostsFile=/dev/null LogLevel=ERROR )
  fi
fi
REMOTE_ARTIFACT="$REMOTE_DIR/$REMOTE_BASENAME"
# Real artifacts have spaces ("Papercusp GUI_0.0.7_x64-setup.exe"). Quoting is
# needed ONLY where a remote SHELL parses the path (install/relaunch via ssh —
# double quotes: cmd.exe-safe on Windows AND bash-safe on mac/linux). The scp
# TARGET must stay UNQUOTED: modern OpenSSH scp defaults to SFTP mode (no remote
# shell), so embedded quotes are literal and fail `dest open ""C:/...""`
# (live-repro'd on the 0.0.8 windows verify, 2026-07-11).
REMOTE_Q="\"$REMOTE_ARTIFACT\""

# ── Resolve expected sha/version from the artifact's own provenance ─────────
# (D-002 spirit: the target of the flip is the INSTALLED artifact's own build sha,
# not "the latest release" — so a rollback install is verified the same way.)
PROV="$SMOKE_PROVENANCE"
if [[ -z "$PROV" ]]; then
  PROV="$(release_artifacts_find_provenance "$ARTIFACT" 2>/dev/null || true)"
fi
if [[ -z "$EXPECTED_SHA" || -z "$EXPECTED_VERSION" ]]; then
  if [[ -n "$PROV" && -f "$PROV" ]]; then
    [[ -z "$EXPECTED_SHA" ]] && EXPECTED_SHA="$(json_str buildSha < "$PROV")"
    [[ -z "$EXPECTED_VERSION" ]] && EXPECTED_VERSION="$(json_str version < "$PROV")"
  fi
fi
[[ -n "$EXPECTED_SHA" ]] || { echo "need --expected-sha (or a build-provenance.json next to the artifact naming buildSha)" >&2; exit 2; }

# Windows is a split product: the GUI is only a shell, while the separately
# installed Server owns `serve.mjs --ensure`. A GUI-only install can therefore
# never prove that the target release replaced the operator. Resolve the exact
# Server stub from the same cut (or accept an explicit one), then use its own
# provenance as the authoritative list of disk-spanned Inno companions. This is
# deliberately fail-closed: globbing whatever *.bin happens to be nearby can
# omit a disk while still letting the tiny setup.exe launch.
SERVER_ARTIFACTS=()
if [[ "$PLATFORM" == "windows" ]]; then
  if [[ -z "$SERVER_ARTIFACT" ]]; then
    [[ -n "$EXPECTED_VERSION" ]] || {
      echo "need --server-artifact: cannot auto-resolve the Windows Server installer without an expected version" >&2
      exit 2
    }
    shopt -s nullglob
    server_candidates=( "$(dirname "$ARTIFACT")"/*Server*_"$EXPECTED_VERSION"_x64-setup.exe )
    shopt -u nullglob
    if (( ${#server_candidates[@]} != 1 )); then
      echo "need --server-artifact: expected exactly one Papercusp Server ${EXPECTED_VERSION} installer beside $(basename "$ARTIFACT"), found ${#server_candidates[@]}" >&2
      exit 2
    fi
    SERVER_ARTIFACT="${server_candidates[0]}"
  fi
  [[ -f "$SERVER_ARTIFACT" ]] || { echo "server artifact not found: $SERVER_ARTIFACT" >&2; exit 2; }

  SERVER_PROV="$(release_artifacts_find_provenance "$SERVER_ARTIFACT" 2>/dev/null || true)"
  [[ -f "$SERVER_PROV" ]] || {
    echo "server provenance not found beside $(basename "$SERVER_ARTIFACT"): $SERVER_PROV" >&2
    exit 2
  }
  SERVER_SHA="$(json_str buildSha < "$SERVER_PROV")"
  SERVER_VERSION="$(json_str version < "$SERVER_PROV")"
  [[ "$SERVER_SHA" == "$EXPECTED_SHA" ]] || {
    echo "server artifact buildSha mismatch: got '$SERVER_SHA', expected '$EXPECTED_SHA' from the GUI artifact" >&2
    exit 2
  }
  if [[ -n "$EXPECTED_VERSION" && "$SERVER_VERSION" != "$EXPECTED_VERSION" ]]; then
    echo "server artifact version mismatch: got '$SERVER_VERSION', expected '$EXPECTED_VERSION' from the GUI artifact" >&2
    exit 2
  fi

  SERVER_BASENAME="$(basename "$SERVER_ARTIFACT")"
  SERVER_LIST_OUT="$(python3 - "$SERVER_PROV" "$SERVER_BASENAME" <<'PY'
import json
import pathlib
import re
import sys

provenance_path, stub = sys.argv[1:]
with open(provenance_path, encoding="utf-8") as handle:
    provenance = json.load(handle)
names = [str(item.get("name", "")) for item in provenance.get("artifacts", [])]
if stub not in names:
    raise SystemExit(f"provenance does not name Server stub {stub!r}")
if pathlib.PurePath(stub).name != stub or not stub.lower().endswith(".exe"):
    raise SystemExit(f"unsafe or non-executable Server artifact name: {stub!r}")
stem = stub[:-4]
slices = []
for name in names:
    match = re.fullmatch(re.escape(stem) + r"-(\d+)\.bin", name)
    if match:
        if pathlib.PurePath(name).name != name:
            raise SystemExit(f"unsafe Server span name: {name!r}")
        slices.append((int(match.group(1)), name))
slices.sort()
indexes = [index for index, _ in slices]
if indexes and indexes != list(range(1, indexes[-1] + 1)):
    raise SystemExit(f"non-contiguous Server spans in provenance: {indexes}")
print(stub)
for _, name in slices:
    print(name)
PY
)" || {
    echo "could not resolve the provenance-listed Windows Server artifact set" >&2
    exit 2
  }
  while IFS= read -r server_name; do
    [[ -n "$server_name" ]] || continue
    server_path="$(dirname "$SERVER_ARTIFACT")/$server_name"
    [[ -f "$server_path" ]] || {
      echo "provenance-listed Server artifact missing: $server_path" >&2
      exit 2
    }
    SERVER_ARTIFACTS+=( "$server_path" )
  done <<< "$SERVER_LIST_OUT"
  (( ${#SERVER_ARTIFACTS[@]} > 0 )) || {
    echo "provenance resolved no Windows Server artifacts" >&2
    exit 2
  }
elif [[ "$PLATFORM" == "mac" ]]; then
  if [[ -z "$SERVER_ARTIFACT" ]]; then
    [[ -n "$EXPECTED_VERSION" ]] || {
      echo "need --server-artifact: cannot auto-resolve the macOS Server DMG without an expected version" >&2
      exit 2
    }
    shopt -s nullglob
    server_candidates=( "$(dirname "$ARTIFACT")"/*Server*_$EXPECTED_VERSION\_*.dmg )
    shopt -u nullglob
    if (( ${#server_candidates[@]} != 1 )); then
      echo "need --server-artifact: expected exactly one Papercusp Server ${EXPECTED_VERSION} DMG beside $(basename "$ARTIFACT"), found ${#server_candidates[@]}" >&2
      exit 2
    fi
    SERVER_ARTIFACT="${server_candidates[0]}"
  fi
  [[ -f "$SERVER_ARTIFACT" ]] || { echo "server artifact not found: $SERVER_ARTIFACT" >&2; exit 2; }
  SERVER_BASENAME="$(basename "$SERVER_ARTIFACT")"
  [[ -n "$EXPECTED_VERSION" && "$SERVER_BASENAME" == *"Server_${EXPECTED_VERSION}_"*.dmg ]] || {
    echo "macOS Server artifact filename does not match expected version $EXPECTED_VERSION: $SERVER_BASENAME" >&2
    exit 2
  }
  SERVER_ARTIFACTS+=( "$SERVER_ARTIFACT" )
elif [[ "$PLATFORM" == "linux" ]]; then
  if [[ -z "$SERVER_ARTIFACT" ]]; then
    [[ -n "$EXPECTED_VERSION" ]] || {
      echo "need --server-artifact: cannot auto-resolve the Linux Server deb without an expected version" >&2
      exit 2
    }
    shopt -s nullglob
    server_candidates=(
      "$(dirname "$ARTIFACT")"/*Server*_$EXPECTED_VERSION\_*.deb
      "$(dirname "$ARTIFACT")"/*server*_$EXPECTED_VERSION\_*.deb
    )
    shopt -u nullglob
    if (( ${#server_candidates[@]} != 1 )); then
      echo "need --server-artifact: expected exactly one Papercusp Server ${EXPECTED_VERSION} deb beside $(basename "$ARTIFACT"), found ${#server_candidates[@]}" >&2
      exit 2
    fi
    SERVER_ARTIFACT="${server_candidates[0]}"
  fi
  [[ -f "$SERVER_ARTIFACT" ]] || { echo "server artifact not found: $SERVER_ARTIFACT" >&2; exit 2; }
  SERVER_PROV="$(release_artifacts_find_provenance "$SERVER_ARTIFACT" 2>/dev/null || true)"
  [[ -f "$SERVER_PROV" ]] || {
    echo "server provenance not found for $(basename "$SERVER_ARTIFACT")" >&2
    exit 2
  }
  SERVER_SHA="$(json_str buildSha < "$SERVER_PROV")"
  SERVER_VERSION="$(json_str version < "$SERVER_PROV")"
  [[ "$SERVER_SHA" == "$EXPECTED_SHA" ]] || {
    echo "server artifact buildSha mismatch: got '$SERVER_SHA', expected '$EXPECTED_SHA' from the GUI artifact" >&2
    exit 2
  }
  [[ "$SERVER_VERSION" == "$EXPECTED_VERSION" ]] || {
    echo "server artifact version mismatch: got '$SERVER_VERSION', expected '$EXPECTED_VERSION' from the GUI artifact" >&2
    exit 2
  }
  SERVER_ARTIFACTS+=( "$SERVER_ARTIFACT" )
elif [[ -n "$SERVER_ARTIFACT" ]]; then
  echo "--server-artifact is supported only for --platform windows|mac|linux" >&2
  exit 2
fi
SERVER_REMOTE_Q=""
if (( ${#SERVER_ARTIFACTS[@]} > 0 )); then
  SERVER_REMOTE_Q="\"$REMOTE_DIR/$(basename "${SERVER_ARTIFACTS[0]}")\""
fi

# ── ssh/scp transport (PC_SSH / PC_SCP overridable for the D-007 mock path) ─
SSH_BIN="${PC_SSH:-ssh}"
SCP_BIN="${PC_SCP:-scp}"
SSH=("$SSH_BIN" -i "$SSH_KEY" -p "$SSH_PORT" -o IdentitiesOnly=yes -o ConnectTimeout=10 -o BatchMode=yes)
for option in "${SSH_OPTIONS[@]}"; do SSH+=( -o "$option" ); done
SSH+=("$SSH_HOST")

transport_host_key_failure() {
  grep -Eqi 'host key|known_hosts|offending .*key|remote host identification' <<<"$1"
}

# op_exec: run a command in the operator's network namespace. On Windows the
# operator lives INSIDE the WSL distro, so wrap in `wsl --exec` (space-free args
# survive $* flattening — a quoted `bash -c` would not; mirrors vm-preflight.sh);
# on mac/linux it runs directly on the VM host.
op_exec() {
  if [[ "$PLATFORM" == "windows" ]]; then
    timeout 60 "${SSH[@]}" "wsl -d $DISTRO --user papercup --exec $*" 2>/dev/null | tr -d '\r\0'
  else
    timeout 60 "${SSH[@]}" "$*" 2>/dev/null | tr -d '\r\0'
  fi
}
discover_port() { op_exec cat "$OPJSON_PATH" | json_num port; }
# Retry a few times: a single `wsl --exec` flap (transient, empty output) must
# not abort the whole verify as "no healthy pre-update operator".
read_health() {
  local _port="$1" _attempts="${2:-3}" _body="" _i
  for ((_i = 1; _i <= _attempts; _i++)); do
    _body="$(op_exec curl -sS -m 5 "http://127.0.0.1:$_port/api/health")"
    [[ -n "$_body" ]] && break
    (( _i < _attempts )) && sleep 2
  done
  printf '%s' "$_body"
}

FAILURES=()
NOTES=()
fail_check() { FAILURES+=("$1"); }
note() { NOTES+=("$1"); }

# ── Reachability ────────────────────────────────────────────────────────────
if [[ "$PLATFORM" == "windows" ]]; then
  REACH_CMD='cmd /c echo VM-OK'
else
  REACH_CMD='echo VM-OK'
fi
REACH_OUT=""
REACH_RC=0
REACH_OUT="$("${SSH[@]}" "$REACH_CMD" 2>&1 | tr -d '\r\0')" || REACH_RC=$?
if [[ "$REACH_RC" -ne 0 || "$REACH_OUT" != *VM-OK* ]]; then
  if transport_host_key_failure "$REACH_OUT"; then
    echo "vm unreachable on :$SSH_PORT ($SSH_HOST) — host-key verification failed; for a reset VM pass repeatable --ssh-option StrictHostKeyChecking=no and --ssh-option UserKnownHostsFile=/dev/null (and matching --scp-option values)" >&2
  else
    echo "vm unreachable on :$SSH_PORT ($SSH_HOST) — cannot establish the pre-update baseline" >&2
  fi
  exit 2
fi

# Native application acceptance needs a GUI login, unlike the rig's headless
# health preflight. A test-only LaunchDaemon can also keep restarting an old
# operator (or inject stale BUILD_SHA/VERSION into newly installed code). Never
# alter that supervisor here: fixture repair must precede a NEW honest baseline,
# and this verifier must not stop an operator to manufacture the update flip.
if [[ "$PLATFORM" == "mac" ]]; then
  # The remote predicate body lives in ONE file shared with
  # bin/smoke-target-preflight.sh (the pre-build target check, WI-10004346).
  MAC_PREFLIGHT_CMD="$(cat "$HERE/lib/mac-native-preflight.sh")"
  MAC_PREFLIGHT_OUT=""
  MAC_PREFLIGHT_RC=0
  MAC_PREFLIGHT_OUT="$(timeout 30 "${SSH[@]}" "$MAC_PREFLIGHT_CMD" 2>&1 | tr -d '\r\0')" || MAC_PREFLIGHT_RC=$?
  if [[ "$MAC_PREFLIGHT_RC" -ne 0 || "$MAC_PREFLIGHT_OUT" != *PAPERCUSP_NATIVE_MAC_PREFLIGHT_OK* ]]; then
    echo "macOS native preflight failed (exit $MAC_PREFLIGHT_RC): ${MAC_PREFLIGHT_OUT:0:600} — no artifact push, install, or relaunch attempted" >&2
    exit 2
  fi
fi

# ── 1. BEFORE snapshot ──────────────────────────────────────────────────────
BASELINE_STARTED="$(date +%s)"
BASELINE_DEADLINE=$((BASELINE_STARTED + BASELINE_TIMEOUT))
BASELINE_ATTEMPT=0
BASELINE_PROGRESS_AT=0
PORT_BEFORE=""
BODY_BEFORE=""
SHA_BEFORE=""; VERSION_BEFORE=""
while :; do
  BASELINE_ATTEMPT=$((BASELINE_ATTEMPT + 1))
  PORT_BEFORE="$(discover_port)"
  if [[ -n "$PORT_BEFORE" ]]; then
    # The outer readiness loop owns retries here; one empty WSL/API response
    # must not consume three hidden waits or overrun the shared baseline budget.
    BODY_BEFORE="$(read_health "$PORT_BEFORE" 1)"
    SHA_BEFORE="$(printf '%s' "$BODY_BEFORE" | json_str sha)"
    VERSION_BEFORE="$(printf '%s' "$BODY_BEFORE" | json_str version)"
    if [[ -n "$SHA_BEFORE" || -n "$VERSION_BEFORE" ]]; then
      break
    fi
  fi

  BASELINE_NOW="$(date +%s)"
  if [[ "$BASELINE_NOW" -ge "$BASELINE_DEADLINE" ]]; then
    if [[ -z "$PORT_BEFORE" ]]; then
      echo "no healthy pre-update operator after ${BASELINE_TIMEOUT}s ($BASELINE_ATTEMPT attempts; operator.json did not provide a port) — no artifacts were pushed" >&2
    else
      echo "no healthy pre-update operator after ${BASELINE_TIMEOUT}s ($BASELINE_ATTEMPT attempts; health on port $PORT_BEFORE reports neither sha nor version) — no artifacts were pushed" >&2
    fi
    exit 2
  fi

  if (( BASELINE_PROGRESS_AT == 0 || BASELINE_NOW - BASELINE_PROGRESS_AT >= 30 )); then
    BASELINE_ELAPSED=$((BASELINE_NOW - BASELINE_STARTED))
    if [[ -z "$PORT_BEFORE" ]]; then
      echo "waiting for pre-update operator baseline: operator.json has no port yet ($BASELINE_ELAPSED s/${BASELINE_TIMEOUT}s)" >&2
    else
      echo "waiting for pre-update operator baseline: health at port $PORT_BEFORE has neither sha nor version ($BASELINE_ELAPSED s/${BASELINE_TIMEOUT}s)" >&2
    fi
    BASELINE_PROGRESS_AT="$BASELINE_NOW"
  fi
  sleep "$POLL_INTERVAL"
done
if [[ -n "$SHA_BEFORE" && "$SHA_BEFORE" == "$EXPECTED_SHA" ]]; then
  echo "pre-update operator already reports the target sha $EXPECTED_SHA — nothing to flip (stale target or already-updated)" >&2
  exit 2
fi
# A pre-update build that predates embedded build-provenance reports sha:null
# (and often version 0.0.0). That does NOT block the flip proof: the assertion
# below is sha REACHING $EXPECTED_SHA, and a null->real-sha transition is a
# STRICTLY STRONGER no-op-update signal than a sha-to-sha move (the stale
# operator advertised no sha at all; only a genuine in-place replacement can
# make the port report the real one). Proceed on the port + version baseline.
if [[ -z "$SHA_BEFORE" ]]; then
  note "pre-update build predates embedded build-provenance (sha empty; version='$VERSION_BEFORE') — asserting the FLIP on sha reaching $EXPECTED_SHA plus the version transition to $EXPECTED_VERSION"
fi

# ── 2. PUSH ─────────────────────────────────────────────────────────────────
# A custom staging destination may not exist yet. Create it idempotently and
# require positive readback BEFORE copying any bytes. Windows OpenSSH parses
# command text through cmd.exe: encode PowerShell instead of nesting shell
# quotes around an arbitrary destination (spaces/apostrophes are legitimate).
REMOTE_MKDIR_CMD="$(python3 - "$PLATFORM" "$REMOTE_DIR" <<'PY'
import base64, shlex, sys
platform, directory = sys.argv[1:]
if platform == "windows":
    literal = "'" + directory.replace("'", "''") + "'"
    script = ("$ErrorActionPreference='Stop'; try { "
              f"[System.IO.Directory]::CreateDirectory({literal}) | Out-Null; "
              f"if (-not [System.IO.Directory]::Exists({literal})) {{ throw 'destination missing' }}; "
              "Write-Output 'PC-REMOTE-DIR-READY' } catch { "
              "[Console]::Error.WriteLine($_.Exception.Message); exit 1 }")
    print("powershell -NoProfile -NonInteractive -EncodedCommand " +
          base64.b64encode(script.encode("utf-16le")).decode())
else:
    quoted = shlex.quote(directory)
    print(f"mkdir -p -- {quoted} && test -d {quoted} && printf 'PC-REMOTE-DIR-READY\\n'")
PY
)"
REMOTE_MKDIR_OUT=""
REMOTE_MKDIR_RC=0
REMOTE_MKDIR_OUT="$(timeout 30 "${SSH[@]}" "$REMOTE_MKDIR_CMD" 2>&1 | tr -d '\r\0')" || REMOTE_MKDIR_RC=$?
if [[ "$REMOTE_MKDIR_RC" -ne 0 || "$REMOTE_MKDIR_OUT" != *PC-REMOTE-DIR-READY* ]]; then
  fail_check "remote staging directory: creation/readback failed (exit $REMOTE_MKDIR_RC)${REMOTE_MKDIR_OUT:+ — output: ${REMOTE_MKDIR_OUT:0:400}}"
fi

SCP=("$SCP_BIN" -i "$SSH_KEY" -P "$SSH_PORT" -o IdentitiesOnly=yes -o BatchMode=yes)
for option in "${SCP_OPTIONS[@]}"; do SCP+=( -o "$option" ); done

# Is a byte-identical copy of $1 already staged at remote $2? A resume or retry
# after a timed-out run finds the DMGs the first run already pushed; the first
# run also consumed the very headroom the 16 GiB transfer floor demands, so
# re-streaming them fails on exactly the disk-tight VM the resume exists for
# (WI-10003669). Reuse is decided by exact size AND sha256 — never by name or
# size alone — and any probe failure answers "no", falling through to the
# capacity-admitted transfer.
mac_staged_artifact_matches() { # $1=local path, $2=remote path, $3=bytes
  local local_path="$1" remote_path="$2" bytes="$3" local_sha probe probe_out="" probe_rc=0 remote_sha
  probe="$(
    printf '# PAPERCUSP_NATIVE_ARTIFACT_REUSE_PROBE\ntarget=%q; expected_bytes=%q\n' "$remote_path" "$bytes"
    cat <<'PROBE'
[ -f "$target" ] || exit 0
actual_bytes="$(wc -c < "$target" | tr -d '[:space:]')"
[ "$actual_bytes" = "$expected_bytes" ] || exit 0
remote_sha="$({ shasum -a 256 "$target" 2>/dev/null || sha256sum "$target"; } | awk '{print $1}')"
printf 'PAPERCUSP_STAGED_SHA256=%s\n' "$remote_sha"
PROBE
  )"
  probe_out="$(timeout "$INSTALL_TIMEOUT" "${SSH[@]}" "$probe" 2>/dev/null | tr -d '\r\0')" || probe_rc=$?
  [[ "$probe_rc" -eq 0 ]] || return 1
  remote_sha="$(printf '%s\n' "$probe_out" | sed -n 's/^PAPERCUSP_STAGED_SHA256=\([0-9a-f]\{64\}\)$/\1/p' | head -1)"
  [[ -n "$remote_sha" ]] || return 1
  local_sha="$({ sha256sum "$local_path" 2>/dev/null || shasum -a 256 "$local_path"; } | awk '{print $1}')"
  [[ "$local_sha" =~ ^[0-9a-f]{64}$ && "$local_sha" == "$remote_sha" ]]
}

mac_stage_artifact() { # $1=local path, $2=remote path
  local local_path="$1" remote_path="$2" bytes need_gb headroom command transfer_out="" transfer_rc=0
  bytes="$(wc -c < "$local_path" | tr -d '[:space:]')"
  case "$bytes" in ''|*[!0-9]*) fail_check "push: cannot measure $(basename "$local_path") before transfer"; return ;; esac
  if mac_staged_artifact_matches "$local_path" "$remote_path" "$bytes"; then
    note "push: reused byte-identical staged $(basename "$local_path") at $remote_path (size + sha256 match; no transfer, no staging admission)"
    return
  fi
  need_gb=$(( (bytes + 1073741823) / 1073741824 ))
  [[ "$need_gb" -ge 1 ]] || need_gb=1
  headroom="${PAPERCUSP_MAC_TRANSFER_HEADROOM_GB:-16}"
  case "$headroom" in
    ''|*[!0-9]*) fail_check "push: PAPERCUSP_MAC_TRANSFER_HEADROOM_GB must be a positive integer"; return ;;
    *)
      [[ "$headroom" -ge 16 ]] || { fail_check "push: PAPERCUSP_MAC_TRANSFER_HEADROOM_GB cannot lower the 16 GiB safety floor"; return; }
      [[ "$need_gb" -ge "$headroom" ]] || need_gb="$headroom"
      ;;
  esac
  command="$(mac_artifact_stage_command "$remote_path" "$bytes" "$need_gb")"
  transfer_out="$(timeout "$INSTALL_TIMEOUT" "${SSH[@]}" "$command" < "$local_path" 2>&1 | tr -d '\r\0')" || transfer_rc=$?
  if [[ "$transfer_rc" -ne 0 || "$transfer_out" != *PAPERCUSP_NATIVE_ARTIFACT_STAGE_OK* ]]; then
    fail_check "push: capacity-admitted macOS transfer of $(basename "$local_path") failed (exit $transfer_rc)${transfer_out:+ — output: ${transfer_out:0:500}}"
  fi
}

if [[ ${#FAILURES[@]} -eq 0 ]]; then
if [[ "$PLATFORM" == "mac" ]]; then
  mac_stage_artifact "$ARTIFACT" "$REMOTE_ARTIFACT"
  if [[ ${#FAILURES[@]} -eq 0 ]]; then
    for server_path in "${SERVER_ARTIFACTS[@]}"; do
      mac_stage_artifact "$server_path" "$REMOTE_DIR/$(basename "$server_path")"
      [[ ${#FAILURES[@]} -eq 0 ]] || break
    done
  fi
else
SCP_OUT=""
SCP_RC=0
SCP_OUT="$("${SCP[@]}" "$ARTIFACT" "$SSH_HOST:$REMOTE_ARTIFACT" 2>&1)" || SCP_RC=$?
if [[ "$SCP_RC" -ne 0 ]]; then
  if transport_host_key_failure "$SCP_OUT"; then
    fail_check "push: scp of $REMOTE_BASENAME to $REMOTE_ARTIFACT failed due to host-key verification; pass repeatable --scp-option StrictHostKeyChecking=no and --scp-option UserKnownHostsFile=/dev/null for a reset VM"
  else
    fail_check "push: scp of $REMOTE_BASENAME to $REMOTE_ARTIFACT failed${SCP_OUT:+ — output: ${SCP_OUT:0:400}}"
  fi
fi
for server_path in "${SERVER_ARTIFACTS[@]}"; do
  server_basename="$(basename "$server_path")"
  SCP_OUT=""
  SCP_RC=0
  SCP_OUT="$("${SCP[@]}" "$server_path" "$SSH_HOST:$REMOTE_DIR/$server_basename" 2>&1)" || SCP_RC=$?
  if [[ "$SCP_RC" -ne 0 ]]; then
    if transport_host_key_failure "$SCP_OUT"; then
      fail_check "push: scp of $server_basename to $REMOTE_DIR/$server_basename failed due to host-key verification; pass repeatable --scp-option StrictHostKeyChecking=no and --scp-option UserKnownHostsFile=/dev/null for a reset VM"
    else
      fail_check "push: scp of $server_basename to $REMOTE_DIR/$server_basename failed${SCP_OUT:+ — output: ${SCP_OUT:0:400}}"
    fi
  fi
done
fi
fi

# ── 3. INSTALL (does NOT terminate the operator) ────────────────────────────
run_installer() {
  local label="$1" command="$2" install_rc=0 install_out=""
  install_out="$(timeout "$INSTALL_TIMEOUT" "${SSH[@]}" "$command" 2>&1 | tr -d '\r\0')" || install_rc=$?
  if [[ "$install_rc" -eq 124 ]]; then
    # timeout(1) killed the SSH SESSION, not the VM-side installer — it is very
    # likely STILL RUNNING detached. Relaunching now re-locks the app files under
    # it, so fail loudly and leave the stale operator serving.
    fail_check "$label install: timed out after ${INSTALL_TIMEOUT}s (ssh killed; the VM-side installer may still be running detached) — NOT relaunching; re-probe VM process/disk state before any retry, or raise --install-timeout"
  elif [[ "$install_rc" -ne 0 ]]; then
    # A non-zero installer result means the bytes/configuration are not a
    # trustworthy release candidate. Continuing to relaunch made a missing
    # WebKit dependency look like a silent no-op update and discarded the
    # causal installer error behind a later polling failure.
    fail_check "$label install failed with exit $install_rc${install_out:+ — output: ${install_out:0:400}}"
  elif [[ "$VERIFY_INSTALLED_MAC" == 1 && "$install_out" != *PAPERCUSP_VERIFY_INSTALLED_MAC_OK* ]]; then
    fail_check "$label installed-tree verification returned no success attestation — NOT relaunching"
  fi
}

verify_linux_package_configured() { # $1=remote quoted artifact, $2=label
  local remote_artifact="$1" label="$2"
  local status_out="" status_err="" status_detail="" status_rc=0
  local status_stdout_file status_stderr_file
  # Validate the package named by the artifact, rather than hard-coding the
  # product package name. `install ok installed` is the dpkg state required
  # before a GUI relaunch can load its declared shared libraries.
  # Keep SSH diagnostics on stderr. Reset VMs commonly emit a host-key warning
  # when StrictHostKeyChecking=no is used; merging that stream into stdout made
  # a healthy dpkg status fail the exact verdict below.
  status_stdout_file="$(mktemp)"
  status_stderr_file="$(mktemp)"
  if timeout "$INSTALL_TIMEOUT" "${SSH[@]}" "package=\$(dpkg-deb -f $remote_artifact Package) && dpkg-query -W -f='\${Status}' \"\$package\"" >"$status_stdout_file" 2>"$status_stderr_file"; then
    status_rc=0
  else
    status_rc=$?
  fi
  status_out="$(tr -d '\r\0' <"$status_stdout_file")"
  status_err="$(tr -d '\r\0' <"$status_stderr_file")"
  rm -f -- "$status_stdout_file" "$status_stderr_file"
  status_detail="${status_out}${status_out:+; }${status_err}"
  if [[ "$status_rc" -eq 124 ]]; then
    fail_check "Linux $label package status check timed out after ${INSTALL_TIMEOUT}s — NOT relaunching"
  elif [[ "$status_rc" -ne 0 ]]; then
    fail_check "Linux $label package status check failed with exit $status_rc${status_detail:+ — output: ${status_detail:0:400}} — NOT relaunching"
  elif [[ "$status_out" != "install ok installed" ]]; then
    fail_check "Linux $label package is not configured (dpkg status '$status_out')${status_err:+ — SSH diagnostics: ${status_err:0:400}} — declared dependencies may still be missing; NOT relaunching"
  fi
}

if [[ ${#FAILURES[@]} -eq 0 ]]; then
  INSTALL_RUN="${INSTALL_CMD//__ARTIFACT__/$REMOTE_Q}"
  # Capture (don't discard) installer output — a swallowed exit code cost a full
  # diagnose cycle on 0.0.8 (locked-file Abort looked like a silent no-op).
  run_installer "GUI" "$INSTALL_RUN"
fi
if [[ ${#FAILURES[@]} -eq 0 && ${#SERVER_ARTIFACTS[@]} -gt 0 ]]; then
  SERVER_INSTALL_RUN="${SERVER_INSTALL_CMD//__SERVER_ARTIFACT__/$SERVER_REMOTE_Q}"
  run_installer "Server" "$SERVER_INSTALL_RUN"
fi
if [[ ${#FAILURES[@]} -eq 0 && "$VERIFY_INSTALLED_MAC" == 1 ]]; then
  note "resumed prior installation: both installed apps match their mounted DMGs byte-for-byte and pass strict codesign; no app copy or replacement performed in this run"
fi
if [[ ${#FAILURES[@]} -eq 0 && "$PLATFORM" == "linux" ]]; then
  verify_linux_package_configured "$REMOTE_Q" "GUI"
  [[ ${#FAILURES[@]} -gt 0 ]] || verify_linux_package_configured "$SERVER_REMOTE_Q" "Server"
fi

# ── 4. RELAUNCH — WITHOUT TERMINATING (serve --ensure must do the replacement) ─
if [[ ${#FAILURES[@]} -eq 0 ]]; then
  RELAUNCH_OUT=""
  RELAUNCH_RC=0
  RELAUNCH_OUT="$(timeout 60 "${SSH[@]}" "$RELAUNCH_CMD" 2>&1 | tr -d '\r\0')" || RELAUNCH_RC=$?
  if [[ "$RELAUNCH_RC" -eq 124 ]]; then
    fail_check "relaunch command timed out after 60s${RELAUNCH_OUT:+ — output: ${RELAUNCH_OUT:0:400}}"
  elif [[ "$RELAUNCH_RC" -ne 0 ]]; then
    fail_check "relaunch command failed with exit $RELAUNCH_RC${RELAUNCH_OUT:+ — output: ${RELAUNCH_OUT:0:400}}"
  elif [[ -n "$RELAUNCH_OUT" ]]; then
    note "relaunch output: ${RELAUNCH_OUT:0:400}"
  fi
fi

# ── 5+6. Poll for the FLIP, then assert sticky-port-hold ────────────────────
FLIPPED=false
PORT_AFTER=""
SHA_AFTER=""
VERSION_AFTER=""
if [[ ${#FAILURES[@]} -eq 0 ]]; then
  DEADLINE=$(( $(date +%s) + FLIP_TIMEOUT ))
  while :; do
    PORT_AFTER="$(discover_port)"
    if [[ -n "$PORT_AFTER" ]]; then
      BODY_AFTER="$(read_health "$PORT_AFTER")"
      SHA_AFTER="$(printf '%s' "$BODY_AFTER" | json_str sha)"
      VERSION_AFTER="$(printf '%s' "$BODY_AFTER" | json_str version)"
    fi
    if [[ -n "$SHA_AFTER" && "$SHA_AFTER" == "$EXPECTED_SHA" ]]; then FLIPPED=true; break; fi
    [[ $(date +%s) -ge $DEADLINE ]] && break
    sleep "$POLL_INTERVAL"
  done

  # FLIP (EI-9002): sha must have moved from the pre-update value to the artifact's own.
  if [[ "$FLIPPED" != "true" ]]; then
    fail_check "EI-9002: /api/health sha did NOT flip to $EXPECTED_SHA within ${FLIP_TIMEOUT}s (still '$SHA_AFTER', was '$SHA_BEFORE') — the install did not replace the running operator (silent no-op update)"
  fi
  # VERSION (when known): must reach the expected version too.
  if [[ "$FLIPPED" == "true" && -n "$EXPECTED_VERSION" && "$VERSION_AFTER" != "$EXPECTED_VERSION" ]]; then
    fail_check "version did not reach $EXPECTED_VERSION after the flip (got '$VERSION_AFTER')"
  fi
  # STICKY-PORT-HOLD (WI-3783): the operator must return on the SAME port.
  if [[ "$FLIPPED" == "true" && "$PORT_AFTER" != "$PORT_BEFORE" ]]; then
    fail_check "WI-3783: operator port moved $PORT_BEFORE -> $PORT_AFTER across the update — the sticky port was not preserved (long-lived pinned URLs break)"
  fi
fi

SMOKE_RECEIPT=""
if [[ ${#FAILURES[@]} -eq 0 && -n "$SMOKE_RECEIPT_TAG" ]]; then
  if [[ -z "$PROV" || ! -f "$PROV" ]]; then
    fail_check "smoke receipt requested for $SMOKE_RECEIPT_TAG but no build-provenance.json could be resolved; pass --smoke-provenance PATH"
  else
    EXERCISED_ARTIFACTS=( "$ARTIFACT" "${SERVER_ARTIFACTS[@]}" )
    SMOKE_RECEIPT_OUT="$(release_artifacts_smoke_receipt_write \
      "$SMOKE_RECEIPT_TAG" "$EXPECTED_VERSION" "$PLATFORM" \
      "install-and-relaunch-verify.sh" "$EXPECTED_SHA" "$PROV" \
      "${EXERCISED_ARTIFACTS[@]}" 2>&1)"
    SMOKE_RECEIPT_RC=$?
    if [[ "$SMOKE_RECEIPT_RC" -ne 0 ]]; then
      fail_check "could not persist content-bound smoke receipt: ${SMOKE_RECEIPT_OUT:0:500}"
    else
      SMOKE_RECEIPT="$(printf '%s\n' "$SMOKE_RECEIPT_OUT" | tail -n 1)"
      note "content-bound platform smoke receipt: $SMOKE_RECEIPT"
    fi
  fi
fi

ok=$([[ ${#FAILURES[@]} -eq 0 ]] && echo true || echo false)

if [[ "$JSON" == "1" ]]; then
  jstr() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$1"; }
  printf '{\n'
  printf '  "ok": %s,\n' "$ok"
  printf '  "platform": %s,\n' "$(jstr "$PLATFORM")"
  printf '  "expectedSha": %s,\n' "$(jstr "$EXPECTED_SHA")"
  printf '  "expectedVersion": %s,\n' "$(jstr "$EXPECTED_VERSION")"
  printf '  "installationMode": %s,\n' "$(jstr "$([[ "$VERIFY_INSTALLED_MAC" == 1 ]] && echo verify-existing-dmg || echo install)")"
  printf '  "serverArtifact": %s,\n' "$(jstr "${SERVER_ARTIFACTS[0]:-}")"
  printf '  "serverCompanionCount": %s,\n' "$(( ${#SERVER_ARTIFACTS[@]} > 0 ? ${#SERVER_ARTIFACTS[@]} - 1 : 0 ))"
  printf '  "shaBefore": %s,\n' "$(jstr "$SHA_BEFORE")"
  printf '  "versionBefore": %s,\n' "$(jstr "$VERSION_BEFORE")"
  printf '  "portBefore": %s,\n' "$(jstr "$PORT_BEFORE")"
  printf '  "shaAfter": %s,\n' "$(jstr "$SHA_AFTER")"
  printf '  "versionAfter": %s,\n' "$(jstr "$VERSION_AFTER")"
  printf '  "portAfter": %s,\n' "$(jstr "$PORT_AFTER")"
  printf '  "flipped": %s,\n' "$FLIPPED"
  printf '  "portHeld": %s,\n' "$([[ -n "$PORT_AFTER" && "$PORT_AFTER" == "$PORT_BEFORE" ]] && echo true || echo false)"
  printf '  "smokeReceipt": %s,\n' "$(jstr "$SMOKE_RECEIPT")"
  printf '  "failures": ['
  for i in "${!FAILURES[@]}"; do [[ $i -gt 0 ]] && printf ', '; printf '%s' "$(jstr "${FAILURES[$i]}")"; done
  printf '],\n'
  printf '  "notes": ['
  for i in "${!NOTES[@]}"; do [[ $i -gt 0 ]] && printf ', '; printf '%s' "$(jstr "${NOTES[$i]}")"; done
  printf ']\n}\n'
else
  echo "install-and-relaunch-verify: $([[ "$ok" == "true" ]] && echo PASS || echo FAIL)  platform=$PLATFORM"
  echo "  before: sha=$SHA_BEFORE version=$VERSION_BEFORE port=$PORT_BEFORE"
  echo "  after:  sha=$SHA_AFTER version=$VERSION_AFTER port=$PORT_AFTER  (target sha=$EXPECTED_SHA)"
  echo "  flipped=$FLIPPED  port-held=$([[ -n "$PORT_AFTER" && "$PORT_AFTER" == "$PORT_BEFORE" ]] && echo yes || echo no)"
  for n in "${NOTES[@]:-}"; do [[ -n "$n" ]] && echo "  note: $n"; done
  for f in "${FAILURES[@]:-}"; do [[ -n "$f" ]] && echo "  FAIL: $f"; done
fi

[[ "$ok" == "true" ]] && exit 0 || exit 1
