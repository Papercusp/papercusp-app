#!/usr/bin/env bash
set -euo pipefail

# ── network preflight (EI-20574262390154687) ─────────────────────────────────
#
# This script CANNOT complete without internet: it apt-installs base packages
# and then downloads three pinned artifacts (overmind from github.com, kopia
# from kopia.io + packages.kopia.io, node from nodejs.org). That is a surprising
# dependency for an installer that already ships ~3.4 GB, so make it EXPLICIT
# and fail on it FIRST.
#
# Before this existed, a machine that was offline, behind a strict proxy, or on
# a network blocking any one of those hosts failed PARTWAY THROUGH provisioning
# — after the Windows installer had already reported success and written its
# uninstall entry — surfacing a raw curl/apt error from inside a WSL distro.
# The user saw a first-launch failure with no indication of which host was
# unreachable or that the network was the problem at all.
#
# This check runs INSIDE the distro deliberately. It is the only place that
# sees the network stack that will actually perform the downloads: the distro's
# resolver, its proxy environment, and its REAL apt mirror — which is baked
# into the rootfs and therefore cannot be known from the Windows side. The
# Windows-side preflight (wsl_setup.rs, before `wsl --import`) is the fail-fast
# half; this one is the authoritative half.
#
# Constraints this block must respect, all of them load-bearing:
#   * No curl — curl is one of the packages installed BELOW, so it is not
#     guaranteed to exist yet on a minimal image. bash's /dev/tcp needs no
#     packages at all.
#   * Prompt-free and idempotent, like every other step here (see the kopia
#     --batch --yes note below for what a single interactive prompt costs).
#   * Runs before ANY mutation, so a failure leaves the distro untouched.

preflight_hostport() {
  # "https://host:port/path" -> "host:port", defaulting the port from the
  # scheme. Strips userinfo so a mirror with credentials still resolves.
  local uri="$1" scheme rest host
  scheme="${uri%%://*}"
  rest="${uri#*://}"
  rest="${rest%%/*}"
  rest="${rest##*@}"
  case "$rest" in
    *:*) printf '%s\n' "$rest" ;;
    *)
      case "$scheme" in
        https) printf '%s:443\n' "$rest" ;;
        *)     printf '%s:80\n'  "$rest" ;;
      esac
      ;;
  esac
}

preflight_targets() {
  # The fixed downloads this script performs, as "host:port|what it is for".
  printf '%s\n' \
    "github.com:443|the overmind process supervisor" \
    "kopia.io:443|the kopia signing key" \
    "packages.kopia.io:80|the kopia apt repository (backup engine)" \
    "nodejs.org:443|the pinned Node runtime"
  # Plus whatever apt mirrors THIS image is actually configured for — read from
  # the image rather than assumed, since a rebased or mirrored rootfs can point
  # anywhere. Legacy one-line format:
  { cat /etc/apt/sources.list 2>/dev/null || true
    cat /etc/apt/sources.list.d/*.list 2>/dev/null || true
  } | awk '$1 ~ /^deb/ { for (i = 2; i <= NF; i++) if ($i ~ /^https?:\/\//) { print $i; break } }' \
    | while read -r uri; do
        printf '%s|an apt mirror (base packages)\n' "$(preflight_hostport "$uri")"
      done
  # deb822 format (.sources) — Ubuntu 24.04's default:
  { cat /etc/apt/sources.list.d/*.sources 2>/dev/null || true; } \
    | awk 'tolower($1) == "uris:" { for (i = 2; i <= NF; i++) print $i }' \
    | while read -r uri; do
        printf '%s|an apt mirror (base packages)\n' "$(preflight_hostport "$uri")"
      done
}

preflight_reachable() { # host port -> 0 reachable, non-zero not
  timeout 6 bash -c "exec 3<>/dev/tcp/${1}/${2}" 2>/dev/null
}

if [ "${PAPERCUP_SKIP_NETWORK_PREFLIGHT:-0}" != "1" ]; then
  preflight_unreachable=()
  while IFS='|' read -r hostport purpose; do
    [ -n "$hostport" ] || continue
    if ! preflight_reachable "${hostport%%:*}" "${hostport##*:}"; then
      preflight_unreachable+=("${hostport%%:*} — needed for ${purpose}")
    fi
  done < <(preflight_targets | sort -u -t'|' -k1,1)

  if [ "${#preflight_unreachable[@]}" -gt 0 ]; then
    {
      echo "ERROR: papercup provisioning cannot start — the network is unreachable."
      echo
      echo "Setting up the papercup runtime downloads system packages and three"
      echo "pinned binaries, so it cannot run offline. These are unreachable from"
      echo "inside the papercup-runtime WSL distro:"
      for entry in "${preflight_unreachable[@]}"; do
        echo "  - ${entry}"
      done
      echo
      echo "Nothing has been changed: provisioning stopped before making any"
      echo "changes, so simply launch Papercup again once this is fixed."
      echo
      echo "Fix: connect this machine to the internet, or allow the hosts above"
      echo "through your proxy or firewall, then relaunch."
      echo
      echo "If you believe this check is wrong — for example an HTTP proxy that"
      echo "only accepts CONNECT, which a plain TCP probe cannot see — you can"
      echo "skip it by setting PAPERCUP_SKIP_NETWORK_PREFLIGHT=1."
    } >&2
    exit 3
  fi
fi

# Configure the default user. WSL's default-user is set via
# /etc/wsl.conf; create the user if missing.
DEFAULT_USER="papercup"
if ! id "$DEFAULT_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$DEFAULT_USER"
  # Minimal images ship without sudo — the dir appears only when the
  # package installs (added to the apt list below); create it now.
  mkdir -p /etc/sudoers.d
  echo "$DEFAULT_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/papercup
  chmod 0440 /etc/sudoers.d/papercup
fi

cat > /etc/wsl.conf <<WSLCONF
[user]
default=$DEFAULT_USER

[boot]
systemd=true

[interop]
enabled=true
appendWindowsPath=false
WSLCONF

# Base packages.
#
# libasound2t64 is NOT audio support — do not drop it as "WSL has no sound card"
# (WI-4448). The chat dock's `pui` binary links libasound.so.2 via its voice-mode
# cpal dependency, so WITHOUT this package pui cannot even be LOADED inside the
# distro ("error while loading shared libraries") and the Windows dock opens a
# zellij session whose chat pane is a dead binary — the same blank-pane failure
# linux-chat-dock-parity-2026-06-27 already fixed once on Linux. The dynamic
# linker needs the .so present at exec time whether or not a sound device exists.
# (Ubuntu 24.04 renamed libasound2 → libasound2t64 in the t64 transition.)
export DEBIAN_FRONTEND=noninteractive
apt-get update
# Live voice E2E host tools (EI-22457146314869603); the live script
# preflights these commands before connecting to the operator voice host.
apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  curl \
  espeak-ng \
  ffmpeg \
  git \
  jq \
  unzip \
  python3 \
  python3-pip \
  sudo \
  gnupg \
  postgresql-client \
  tmux \
  xz-utils \
  ripgrep \
  iproute2 \
  libasound2t64

# overmind is not in the Ubuntu archive — fetch the release binary.
OVERMIND_VERSION="${OVERMIND_VERSION:-2.5.1}"
curl -fsSL "https://github.com/DarthSim/overmind/releases/download/v${OVERMIND_VERSION}/overmind-v${OVERMIND_VERSION}-linux-amd64.gz" \
  | gunzip > /usr/local/bin/overmind
chmod +x /usr/local/bin/overmind
overmind --version

# kopia — the backup engine ("Enabled by default" per the Setup Wizard);
# without it the Backups feature is unavailable in the Windows runtime.
# Official APT repo per kopia.io/docs/installation.
# --batch --yes: this script re-runs at FIRST BOOT as /opt/papercup/bootstrap
# (see header) — the keyring baked at image-build time already exists then,
# and bare `gpg --dearmor` hangs forever on an interactive "Overwrite? (y/N)"
# prompt (wedged the Windows first-run live, 2026-06-11). Every step in this
# script must stay idempotent AND prompt-free.
curl -fsSL https://kopia.io/signing-key \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/kopia-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/kopia-keyring.gpg] http://packages.kopia.io/apt/ stable main" \
  > /etc/apt/sources.list.d/kopia.list
apt-get update
apt-get install -y --no-install-recommends kopia
kopia --version

# Node into /usr/local — it must be on the DEFAULT non-login PATH: the
# desktop spawns `wsl.exe --exec node` (no shell, no profile read), and
# appendWindowsPath=false above leaves PATH = /usr/local/bin:/usr/bin:…
# Shim/profile installs (fnm, nvm) are invisible there. Keep this exact
# version in lockstep with the bundled sidecar so native addons load under the
# same ABI. The URL is pinned to a release, never a moving latest-v* alias.
NODE_VERSION="${NODE_VERSION:-24.18.1}"
NODE_VERSION="${NODE_VERSION#v}"
if ! [[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: NODE_VERSION must be an exact Node release (for example 24.18.1); got '$NODE_VERSION'" >&2
  exit 2
fi
NODE_TARBALL="node-v${NODE_VERSION}-linux-x64.tar.xz"
install_node_runtime() (
  set -euo pipefail
  local prefix="$1" stage previous_npm=0
  local -a remaining
  stage="$(mktemp -d "$prefix/.papercusp-node.XXXXXX")"
  cleanup_node_stage() {
    local status="$?"
    trap - EXIT
    if [[ "$previous_npm" == 1 && ! -e "$prefix/lib/node_modules/npm" ]]; then
      mv "$stage/previous-npm" "$prefix/lib/node_modules/npm" || {
        echo "ERROR: previous npm retained at $stage/previous-npm" >&2
        exit 1
      }
    fi
    rm -rf -- "$stage"
    exit "$status"
  }
  trap cleanup_node_stage EXIT

  # Download/extract/validate before changing the installed runtime. Overlaying
  # npm preserves dependencies removed by a newer release; Node can then load
  # an obsolete nested module instead of the new hoisted one (minipass 3/7).
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}" \
    | tar -xJ -C "$stage" --strip-components=1
  "$stage/bin/node" --version
  "$stage/bin/node" "$stage/lib/node_modules/npm/bin/npm-cli.js" --version
  mkdir -p "$prefix/bin" "$prefix/lib/node_modules"
  if [[ -e "$prefix/lib/node_modules/npm" || -L "$prefix/lib/node_modules/npm" ]]; then
    mv "$prefix/lib/node_modules/npm" "$stage/previous-npm"
    previous_npm=1
  fi
  mv "$stage/lib/node_modules/npm" "$prefix/lib/node_modules/npm"
  # Rename on the same filesystem also permits replacing Node while the old
  # operator is running; do not truncate its mapped executable inode.
  mv -f "$stage/bin/node" "$prefix/bin/node"
  # Copy the remaining upstream links, headers and share files. Other global
  # packages (pnpm, user tools) remain in place.
  rm -rf -- "$stage/previous-npm"
  previous_npm=0
  # Copy the contents, never the private mktemp directory's own metadata:
  # cp -a "$stage/." "$prefix/" changes /usr/local to 0700, hiding Node
  # from the non-root runtime user while root-run bootstrap checks pass.
  shopt -s dotglob nullglob
  remaining=("$stage"/*)
  if ((${#remaining[@]})); then
    cp -a -- "${remaining[@]}" "$prefix/"
  fi
  # Recover a shared prefix already made private by the old copy operation.
  # This installer serves non-root WSL users; never add write permission.
  chmod a+rx "$prefix"
)
install_node_runtime /usr/local
node --version

# pnpm
npm install -g "pnpm@${PNPM_VERSION:-9.15.0}"

# Papercup repo location convention.
mkdir -p /home/$DEFAULT_USER/papercup
chown -R "$DEFAULT_USER:$DEFAULT_USER" /home/$DEFAULT_USER

# ── install-size trim (install-size-audit 2026-07-07, owner-directed) ────────
# Drop content the RUNTIME never needs — package docs, man/info pages, and
# non-English locale catalogs — plus build/download caches. This deliberately
# does NOT touch build-essential, /usr/include headers, or any library the
# native-module rebuilds (better-sqlite3, node-pty via node-gyp) depend on, so
# no functionality is lost; it only removes reference material + caches, which
# shrinks the exported rootfs (papercup-runtime.tar.gz) on Windows. Every rm is
# tolerant of an already-absent path (safe under `set -euo pipefail`).
rm -rf \
  /usr/share/doc/* \
  /usr/share/man/* \
  /usr/share/info/* \
  /usr/share/doc-base/* \
  /usr/share/lintian/* \
  /root/.npm /root/.cache \
  /tmp/node-compile-cache
# Locales: keep C/POSIX + en*, drop the rest.
find /usr/share/locale -mindepth 1 -maxdepth 1 -type d \
  ! -name 'en*' ! -name 'C*' ! -name 'POSIX' -exec rm -rf {} + 2>/dev/null || true
npm cache clean --force 2>/dev/null || true

apt-get clean
rm -rf /var/lib/apt/lists/*

echo "papercup bootstrap complete"
