#!/usr/bin/env bash
# lib/release-host.sh — the ONE loader for the baked update source (WI-4389).
#
# WHY THIS IS A SHARED LIB, AND NOT A LINE IN release-local.sh.
#
# main.rs resolves the update source with option_env!("PAPERCUSP_RELEASE_HOST"),
# which bakes AT COMPILE TIME from the environment of the CARGO PROCESS. A
# packaged install has no runtime env, so the baked value is the ONLY one that
# will ever exist in the field.
#
# Until now, only release-local.sh loaded ~/.papercusp/release-host.env. The
# PRODUCERS (build-linux-local.sh, build-windows-on-vm.sh) never loaded it — they
# relied on INHERITING the export from that one caller. Run a producer directly —
# an entirely normal thing to do, and exactly what a re-build or a one-leg retry
# does — and option_env! bakes an EMPTY STRING, the compile SUCCEEDS, nothing is
# red, and the shipped app polls nothing. The Tauri updater cannot distinguish a
# failed check from "no update available", so it renders it as "up to date" —
# FOREVER. That is the 0.0.8 defect: it cost a rebuild of every platform and a
# manual reinstall of every install.
#
#   A value the CALLER must remember to pass is a value some caller will forget.
#   So the loader lives with the PRODUCER, not with the caller.
#
# Same reasoning as assert-release-host-baked.sh (which proves the value actually
# landed in the bytes) and as the release-bundle audit gate. Loading is not
# proof — pair this with that gate. LABELED != PACKED.
#
# Usage:
#   source "$HERE/lib/release-host.sh"
#   load_release_host      # exports PAPERCUSP_RELEASE_HOST + PAPERCUSP_UPDATE_BASE_URL
#
# IDEMPOTENT + OVERRIDABLE: an already-exported PAPERCUSP_RELEASE_HOST always
# WINS and is never clobbered by the file. That matters — the value pushed across
# ssh into a build VM (mac) must not be overwritten by a stale/absent file on that
# box, and a test rig must be able to point a build at a throwaway host.
#
# ⛔ The value is PERMANENT once a build ships with it baked — see the header of
# ~/.papercusp/release-host.env for why rotating it silently strands every
# existing install. This loader only ever READS it.

# Double-source guard. Written as an explicit `if` (not `[[ … ]] && return`),
# because an AND-list whose test fails returns 1 — which aborts a caller running
# under `set -e`, and every producer here does.
if [[ -n "${__PAPERCUSP_RELEASE_HOST_LIB:-}" ]]; then return 0; fi
__PAPERCUSP_RELEASE_HOST_LIB=1

PAPERCUSP_RELEASE_HOST_ENV="${PAPERCUSP_RELEASE_HOST_ENV:-${HOME}/.papercusp/release-host.env}"

# load_release_host — resolve the update source into the environment cargo will see.
load_release_host() {
  # An already-set value wins. Only consult the file when the env is silent, so a
  # deliberate export (release-local.sh, an ssh-pushed VM build, a test override)
  # is never clobbered by whatever happens to sit on this box's disk.
  if [[ -z "${PAPERCUSP_RELEASE_HOST:-}" && -f "$PAPERCUSP_RELEASE_HOST_ENV" ]]; then
    # shellcheck source=/dev/null
    set -a; . "$PAPERCUSP_RELEASE_HOST_ENV"; set +a
  fi

  export PAPERCUSP_RELEASE_HOST="${PAPERCUSP_RELEASE_HOST:-}"
  # Separate knobs on purpose: only the MANIFEST location must be permanent. The
  # artifact urls live INSIDE latest.json and can move per release without an app
  # update, so the download base is allowed to differ from the baked host.
  export PAPERCUSP_UPDATE_BASE_URL="${PAPERCUSP_UPDATE_BASE_URL:-$PAPERCUSP_RELEASE_HOST}"

  if [[ -z "$PAPERCUSP_RELEASE_HOST" ]]; then
    echo "WARNING: no release host configured ($PAPERCUSP_RELEASE_HOST_ENV missing)."
    echo "         The build will ship WITHOUT an update source: an installed app polls,"
    echo "         gets nothing, and the Tauri updater reads that as 'up to date' FOREVER."
    echo "         latest.json's urls will be placeholders. Installers still work."
    echo "         See plan desktop-release-hosting-r2-2026-07-12."
    return 0
  fi

  # Log the AUTHORITY only. The secret lives in the PATH (release-host.env D-002),
  # and build logs are pasted into coord messages, plans and issues — so the path
  # must never be echoed, even on the box that owns it.
  local authority="${PAPERCUSP_RELEASE_HOST#*://}"
  authority="${authority%%/*}"
  echo "==> release host loaded: ${authority:-<unparsable>} (path redacted — it is the shared secret)"
}

# require_release_host — the CUT's rail. Use this instead of load_release_host in
# anything that PUBLISHES (release-local.sh), never in a plain producer.
#
# A WARNING IS THE WRONG CONTROL FOR A RELEASE (b0fbf, 2026-07-12). A hostless
# DEV build is legitimate — you get installers, you just get no auto-update, and
# load_release_host's warning says so. A hostless RELEASE is never legitimate: it
# ships an app that can NEVER be updated, and the defect is invisible (the Tauri
# updater renders the failed check as "up to date", forever), so the one person
# who could have caught it — the human watching the cut scroll past — is exactly
# the person the warning fails to stop. 0.0.8 proved a warning does not hold:
# it warned, and it shipped anyway, and it cost a rebuild of every platform plus
# a manual reinstall of every install.
#
# Escape hatch is EXPLICIT and LOUD, never silent: PAPERCUSP_ALLOW_HOSTLESS_RELEASE=1
# (same posture as PAPERCUSP_ALLOW_DEV_RESTART / PAPERCUSP_ALLOW_DB_MIGRATE — you
# must say the dangerous thing out loud to get it).
require_release_host() {
  load_release_host
  if [[ -n "${PAPERCUSP_RELEASE_HOST:-}" ]]; then return 0; fi

  if [[ "${PAPERCUSP_ALLOW_HOSTLESS_RELEASE:-0}" == "1" ]]; then
    echo ""
    echo "⚠ PAPERCUSP_ALLOW_HOSTLESS_RELEASE=1 — cutting a release with NO update source, deliberately."
    echo "  Every install from this cut will be un-updatable FOREVER and will report 'up to date'."
    echo "  latest.json's urls will be placeholders. Only do this for a throwaway/diagnostic build."
    echo ""
    return 0
  fi

  echo "" >&2
  echo "✗ REFUSING TO CUT: no release host configured." >&2
  echo "" >&2
  echo "  Expected PAPERCUSP_RELEASE_HOST in: $PAPERCUSP_RELEASE_HOST_ENV" >&2
  echo "" >&2
  echo "  A release cut without an update source ships an app that can NEVER reach the" >&2
  echo "  update manifest. It will not LOOK broken — the installer runs, the bundle is" >&2
  echo "  signed, latest.json validates — and the Tauri updater cannot distinguish a" >&2
  echo "  failed check from 'no update available', so it reports UP TO DATE, PERMANENTLY." >&2
  echo "  That is the 0.0.8 defect: a full rebuild of every platform and a manual" >&2
  echo "  reinstall of every install, because an auto-updater cannot deliver the fix to" >&2
  echo "  its own brokenness." >&2
  echo "" >&2
  echo "  FIX: restore ~/.papercusp/release-host.env (it is PERMANENT and must never be" >&2
  echo "  rotated — see its header). It is deliberately outside git, alongside the" >&2
  echo "  minisign signing key." >&2
  echo "" >&2
  echo "  If you genuinely want an un-updatable throwaway build, say so explicitly:" >&2
  echo "      PAPERCUSP_ALLOW_HOSTLESS_RELEASE=1 $0 …" >&2
  echo "" >&2
  exit 1
}
