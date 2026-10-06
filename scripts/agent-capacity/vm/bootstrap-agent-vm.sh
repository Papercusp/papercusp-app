#!/usr/bin/env bash
# Bootstrap a GCP VM to run real and replayed agents for the agent-capacity test
# (plan agent-capacity-and-cost-gcp-2026-09-30, P-004 calibration and the P-005 ramps).
#
#   CLAUDE_VERSION=2.1.284 CODEX_VERSION=0.159.2 bootstrap-agent-vm.sh <tasks.json>
#
# Installs the same CLI versions the corpus was recorded with, then builds each repo's
# prepared checkout the way the recorder did: clone at the pinned sha and run the repo's
# own `setup` commands from tasks.json (plus its `systemPackages`). Checkouts are built on
# the VM, not copied from the recording host, because a prepared Python venv links to the
# host's interpreter by absolute path and does not survive a copy.
#
# Model traffic from real agents reaches the tower's gateway through an SSH reverse tunnel
# (`gcloud compute ssh <vm> -- -R 8788:127.0.0.1:8788`), so nothing here holds credentials.
#
# CACHE_XFS_GB=<n> (optional, the P-005 ramps) first mounts an n-GB XFS volume with reflink
# at the cache dir, backed by a loop file beside it (CACHE_XFS_IMAGE overrides its path).
# Every replay starts by copying a 0.6-1.2 GB prepared checkout into replay-work/ with
# `cp --reflink=auto`. On the image's ext4 boot disk that is a full copy, about 60 GB of
# writes at N=64, and that IO is not charged to the agent slice being measured. On XFS with
# reflink, prepared/ and replay-work/ share one filesystem, so each copy is a metadata-only
# clone. The volume must exist before anything is put in the cache, so a non-empty cache
# dir that is not already a mount point is refused rather than hidden under the mount.
#
# CODEX_SKILL_ROOTS=create (default) | leave. Codex's skills watcher watches each skills
# root, and for a MISSING root it watches the nearest existing ancestor with an inotify mask
# that includes IN_OPEN. On a bare VM that is /etc and $HOME, so every process start (each
# opens /etc/ld.so.cache) and every open of a file in $HOME wakes every Codex session
# (EI-21417256075155406, measured 2026-10-01). `create` makes the empty roots
# (/etc/codex/skills, ~/.agents/skills, ~/.codex/skills); `leave` keeps the as-shipped
# behaviour, which is what the P-005 baseline VMs ran with.
#
# Codex runs every tool call inside bwrap (`--sandbox workspace-write`). Ubuntu 24.04 sets
# kernel.apparmor_restrict_unprivileged_userns=1, which denies an unconfined bwrap the user
# namespace it needs, so every Codex shell or apply_patch call fails ("bwrap: loopback: Failed
# RTM_NEWADDR: Operation not permitted") while the session still exits 0 having done no work
# (measured 2026-10-01, plan D-012, WI-10004618). The bubblewrap package alone does not fix
# it; /usr/bin/bwrap also needs its own AppArmor profile granting `userns`. Both are installed
# here, and the bring-up fails unless a sandboxed Codex write actually succeeds.
#
# DRY_RUN=1 prints each command as `RUN <argv>` instead of running it, and each written
# file as `RUN write <path>` followed by its lines prefixed `FILE ` (used by the test).
set -euo pipefail

TASKS=${1:?usage: bootstrap-agent-vm.sh <tasks.json>}
: "${CLAUDE_VERSION:?set CLAUDE_VERSION to the recorded claude version}"
: "${CODEX_VERSION:?set CODEX_VERSION to the recorded codex version}"
# The recording host's node (the tower runs 25.9.0). A different major ships a different
# toolset: Node 24 bundles corepack and 25 does not, so a recorded `command -v corepack` that
# failed on the tower succeeded on a 24.x VM and the replay's tool outcomes diverged
# (WI-10004683). load-driver refuses a replay whose node major differs from a session's env.node.
NODE_VERSION=${NODE_VERSION:-25.9.0}
CACHE=${AGENT_CAPACITY_CACHE:-$HOME/.cache/agent-capacity}
CACHE_XFS_GB=${CACHE_XFS_GB:-}
CACHE_XFS_IMAGE=${CACHE_XFS_IMAGE:-$CACHE.xfs.img}
CODEX_SKILL_ROOTS=${CODEX_SKILL_ROOTS:-create}
case "$CODEX_SKILL_ROOTS" in
  create | leave) ;;
  *) echo "BOOTSTRAP_FAILED CODEX_SKILL_ROOTS must be create or leave, got '$CODEX_SKILL_ROOTS'" >&2; exit 2 ;;
esac

run() {
  if [ "${DRY_RUN:-0}" = 1 ]; then printf 'RUN %s\n' "$*"; else "$@"; fi
}

# write_root_file <path> <content>: install a root-owned 0644 file.
write_root_file() {
  if [ "${DRY_RUN:-0}" = 1 ]; then
    printf 'RUN write %s\n' "$1"
    printf '%s' "$2" | sed 's/^/FILE /'
  else
    printf '%s' "$2" | sudo install -m 0644 -o root -g root /dev/stdin "$1"
  fi
}

BWRAP_APPARMOR_PROFILE='abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
'

# Validate the volume request before running anything, so a bad request changes nothing.
mount_cache=0
if [ -n "$CACHE_XFS_GB" ]; then
  case "$CACHE_XFS_GB" in
    '' | *[!0-9]* | 0*) echo "BOOTSTRAP_FAILED CACHE_XFS_GB must be a positive whole number of GB, got '$CACHE_XFS_GB'" >&2; exit 2 ;;
  esac
  if mountpoint -q "$CACHE" 2>/dev/null; then
    fstype=$(stat -f -c %T "$CACHE")
    [ "$fstype" = xfs ] || { echo "BOOTSTRAP_FAILED $CACHE is already a $fstype mount, want xfs" >&2; exit 2; }
  elif [ -d "$CACHE" ] && [ -n "$(ls -A "$CACHE")" ]; then
    echo "BOOTSTRAP_FAILED $CACHE is not empty; CACHE_XFS_GB would hide its contents under the mount. Run the bootstrap before uploading anything to the cache." >&2
    exit 2
  else
    mount_cache=1
  fi
fi

# One line per repo: name<TAB>url<TAB>sha<TAB>setup commands joined by \x1f.
repos() {
  python3 - "$TASKS" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
for name, r in sorted(c['repos'].items()):
    print('\t'.join([name, r['url'], r['sha'], '\x1f'.join(r.get('setup', []))]))
PY
}
system_packages() {
  python3 - "$TASKS" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
print(' '.join(sorted({p for r in c['repos'].values() for p in r.get('systemPackages', [])})))
PY
}

xfs_packages=
[ -n "$CACHE_XFS_GB" ] && xfs_packages=xfsprogs
# apt's default per-connection timeout is 120 s, so a mirror connection that stalls mid-body is
# never abandoned: on 2026-10-01 cap-p005-s8 sat 12+ min in `apt-get install` on one stalled
# connection to the GCE mirror while three sibling VMs finished in 3 min. Bound each fetch and retry.
apt_opts=(-o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=5)
run sudo apt-get update -q "${apt_opts[@]}"
# shellcheck disable=SC2046,SC2086 # word-splitting the package lists is intended
run sudo env DEBIAN_FRONTEND=noninteractive apt-get install -yq "${apt_opts[@]}" git curl ca-certificates xz-utils zstd build-essential python3 bubblewrap $xfs_packages $(system_packages)
write_root_file /etc/apparmor.d/bwrap "$BWRAP_APPARMOR_PROFILE"
run sudo apparmor_parser -r /etc/apparmor.d/bwrap

if [ "$mount_cache" = 1 ]; then
  run mkdir -p "$CACHE"
  run fallocate -l "${CACHE_XFS_GB}G" "$CACHE_XFS_IMAGE"
  run mkfs.xfs -q -m reflink=1 "$CACHE_XFS_IMAGE"
  run sudo mount -o loop "$CACHE_XFS_IMAGE" "$CACHE"
  run sudo chown "$(id -u):$(id -g)" "$CACHE"
  # Persist the mount, or the first restart (a spot reclaim, P-007) hides the corpus, the prepared
  # repos and every run's output under an empty boot-disk dir: measured on cap-p007, 2026-10-02.
  # nofail: a missing image must not stop the VM from booting. Idempotent on a re-run.
  run sudo sh -c "grep -qsF '$CACHE_XFS_IMAGE $CACHE ' /etc/fstab || echo '$CACHE_XFS_IMAGE $CACHE xfs loop,nofail 0 0' >> /etc/fstab"
fi
if [ -n "$CACHE_XFS_GB" ] && [ "${DRY_RUN:-0}" != 1 ]; then
  # Prove the property the ramps depend on, not just the filesystem type.
  printf x >"$CACHE/.reflink-probe"
  cp --reflink=always "$CACHE/.reflink-probe" "$CACHE/.reflink-probe.clone" ||
    { echo "BOOTSTRAP_FAILED $CACHE does not support reflink copies" >&2; exit 5; }
  rm -f "$CACHE/.reflink-probe" "$CACHE/.reflink-probe.clone"
fi

# The Node tarball must match the machine: Arm shapes (c4a/t2a, P-008) need linux-arm64.
# MACHINE_ARCH overrides `uname -m` for the dry-run tests only.
MACHINE_ARCH=${MACHINE_ARCH:-$(uname -m)}
case "$MACHINE_ARCH" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64 | arm64) NODE_ARCH=arm64 ;;
  *) echo "BOOTSTRAP_FAILED no Node build for machine arch $MACHINE_ARCH" >&2; exit 7 ;;
esac
run curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz
run sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
run sudo npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_VERSION}" "@openai/codex@${CODEX_VERSION}"
if [ "$CODEX_SKILL_ROOTS" = create ]; then
  run sudo mkdir -p /etc/codex/skills
  run mkdir -p "$HOME/.agents/skills" "$HOME/.codex/skills"
fi

run curl -LsSf https://astral.sh/uv/install.sh -o /tmp/uv-install.sh
run sudo env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh /tmp/uv-install.sh

run mkdir -p "$CACHE/prepared"
while IFS=$'\t' read -r name url sha setup; do
  dir="$CACHE/prepared/$name"
  if [ "${DRY_RUN:-0}" = 1 ] || [ ! -d "$dir/.git" ]; then run git clone --quiet "$url" "$dir"; fi
  run git -C "$dir" checkout --quiet --detach "$sha"
  IFS=$'\x1f' read -r -a cmds <<<"$setup"
  for cmd in "${cmds[@]}"; do
    [ -n "$cmd" ] && run bash -c "cd '$dir' && $cmd"
  done
  if [ "${DRY_RUN:-0}" != 1 ]; then
    head=$(git -C "$dir" rev-parse HEAD)
    [ "$head" = "$sha" ] || { echo "BOOTSTRAP_FAILED $name at $head, want $sha" >&2; exit 3; }
  fi
done < <(repos)

# The installed CLIs must be the recorded ones, or replayed requests stop matching.
if [ "${DRY_RUN:-0}" != 1 ]; then
  have_claude=$(claude --version)
  have_codex=$(codex --version)
  case "$have_claude" in "$CLAUDE_VERSION"*) ;; *) echo "BOOTSTRAP_FAILED claude is $have_claude, want $CLAUDE_VERSION" >&2; exit 4 ;; esac
  case "$have_codex" in *"$CODEX_VERSION") ;; *) echo "BOOTSTRAP_FAILED codex is $have_codex, want $CODEX_VERSION" >&2; exit 4 ;; esac
  # Prove Codex's own sandbox can run a tool that writes, not just that bwrap is installed.
  probe=$(mktemp -d)
  sandbox_out=$(cd "$probe" && codex sandbox -c sandbox_mode=workspace-write -- bash -c 'echo sandbox-ok >probe && cat probe' 2>&1) || true
  rm -rf "$probe"
  [ "$sandbox_out" = sandbox-ok ] ||
    { echo "BOOTSTRAP_FAILED codex sandbox cannot run a tool: $sandbox_out" >&2; exit 6; }
  echo CODEX_SANDBOX_OK
fi
echo "CODEX_SKILL_ROOTS=$CODEX_SKILL_ROOTS"
echo BOOTSTRAP_OK
