# shellcheck shell=bash
# Resolve bundle_host_workers for build-desktop-sidecar.sh across an orchestrator/target split.
#
# Exact-source release cuts run the CURRENT orchestrator's build-desktop-sidecar.sh against a
# FROZEN target tree (EI-21078401508503033). The target tree's apps/operator/bin/
# bundle-host-common.sh is sourced first on purpose: its esbuild boundary (HOST_BANNER,
# NATIVE_PKGS, HOST_COMMON_EXTERNALS) must match the TARGET's host import graph.
#
# bundle_host_workers is different. The orchestrator script CALLS it, so under that same rule it
# has to follow the orchestrator's revision. A target older than the shared worker bundler
# (superproject c809329d3f, 2026-09-27) does not define it at all, and the cut died with
# "bundle_host_workers: command not found" after the SPA and serve.mjs were already built
# (WI-10003497: the 0.0.22-alpha cut of 7708e704).
#
# papercusp_ensure_host_worker_bundler <orchestrator bundle-host-common.sh>
#   No-op when the already-sourced target helper defines bundle_host_workers. Otherwise it
#   imports ONLY bundle_host_workers + HOST_WORKER_OUTPUTS from the orchestrator's copy. It
#   never re-sources that copy into this shell: the helper's load-once guard would turn a
#   re-source into a silent no-op, and a real re-source would replace the target's esbuild
#   boundary variables.
papercusp_ensure_host_worker_bundler() {
  declare -F bundle_host_workers >/dev/null 2>&1 && return 0
  local common="${1:-}" defs
  if [[ -z "$common" || ! -f "$common" ]]; then
    echo "FATAL: the target tree's bundle-host-common.sh does not define bundle_host_workers, and the orchestrator copy is missing at '${common}'" >&2
    return 1
  fi
  if ! defs="$(env -u PAPERCUSP_BUNDLE_HOST_COMMON_LOADED bash -c '
      source "$1" >/dev/null || exit 1
      declare -F bundle_host_workers >/dev/null || exit 1
      declare -p HOST_WORKER_OUTPUTS >/dev/null 2>&1 || exit 1
      declare -f bundle_host_workers
      declare -p HOST_WORKER_OUTPUTS
    ' _ "$common")"; then
    echo "FATAL: orchestrator helper '$common' does not define bundle_host_workers + HOST_WORKER_OUTPUTS" >&2
    return 1
  fi
  # declare -p prints `declare -a NAME=(...)`; evaluated inside this function that would create a
  # LOCAL array, so promote it to a global. Function definitions are always global.
  defs="${defs/declare -a HOST_WORKER_OUTPUTS=/declare -ga HOST_WORKER_OUTPUTS=}"
  eval "$defs" || return 1
  declare -F bundle_host_workers >/dev/null 2>&1 || return 1
  echo "    ✓ target helper predates bundle_host_workers; using the orchestrator's ($common)"
}
