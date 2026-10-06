#!/bin/sh
# Linux install parity with the macOS app (linux-chat-dock-parity-2026-06-27 +
# psu-on-path). Provisions the two things the mac install gives that the Linux
# .deb didn't:
#   (1) the `psu` / `ptool` launchers on the SYSTEM PATH so they work in ANY
#       terminal right after install (the mac app writes these per-user via
#       installPapercuspFiles; that path didn't run on Linux → `psu: command not
#       found`), and
#   (2) ghostty — the chat dock's host terminal: a maintainer-PPA package,
#       impractical to bundle (~108 shared-lib deps), so we install it on first
#       install.
# Everything is guarded so it can NEVER fail the package install.
set -e

# Only on a real install/upgrade configure.
[ "$1" = "configure" ] || exit 0

# This script is inherited by both Tauri products, but every side effect below
# belongs to the Server package: its user unit, bundled psu/ptool launchers,
# tutorial dispatcher and terminal dependency. The thin GUI carries only the
# SPA and must neither manufacture nor overwrite Server-owned files merely
# because its sibling happens to be installed.
[ "${DPKG_MAINTSCRIPT_PACKAGE:-}" = "papercusp-server" ] || exit 0

# The Linux Server is a real, package-owned systemd user service. Use Debian's
# standard package-wide user-unit helper rather than reaching into one logged-in
# user's HOME from this root maintainer script. A fresh install must call
# `enable`; an upgrade must preserve the administrator's existing choice via
# `was-enabled`, using `reenable` only when the unit was enabled. `update-state`
# remains the deliberately-disabled upgrade path.
#
# The first default.target migration accidentally called `enable` on an already
# installed unit. Debian deliberately makes that action first-install-only, so
# it updated helper state without creating the new link. The obsolete helper
# state file is therefore one-time evidence of an install stranded by that
# migration even when the obsolete real link has already disappeared. Once the
# current link is rebuilt, remove that exact stale state entry; a later explicit
# user disable then remains respected on future upgrades.
#
# This maintainer script is shared by the GUI and Server overlays. Gate on the
# binary package name so installing/upgrading the GUI cannot claim ownership of
# the Server unit merely because the sibling product is already on disk.
SERVER_USER_UNIT=papercusp-server.service
SERVER_USER_PATH="/usr/lib/systemd/user/$SERVER_USER_UNIT"
CURRENT_SERVER_USER_LINK="/etc/systemd/user/default.target.wants/$SERVER_USER_UNIT"
LEGACY_SERVER_USER_LINK="/etc/systemd/user/graphical-session.target.wants/$SERVER_USER_UNIT"
CURRENT_SERVER_USER_STATE="/var/lib/systemd/deb-systemd-user-helper-enabled/default.target.wants/$SERVER_USER_UNIT"
LEGACY_SERVER_USER_STATE="/var/lib/systemd/deb-systemd-user-helper-enabled/graphical-session.target.wants/$SERVER_USER_UNIT"

server_user_link_is_package_owned() {
  [ -L "$1" ] \
    && [ "$(readlink -f -- "$1" 2>/dev/null || true)" = "$SERVER_USER_PATH" ]
}

if [ -f "$SERVER_USER_PATH" ] \
  && [ -z "${DPKG_ROOT:-}" ] \
  && command -v deb-systemd-helper >/dev/null 2>&1; then
  deb-systemd-helper --user unmask "$SERVER_USER_UNIT" >/dev/null || true
  if ! deb-systemd-helper --quiet --user debian-installed "$SERVER_USER_UNIT"; then
    # The helper's `enable` action is intentionally first-install-only. It
    # applies the system preset and records the package-owned links.
    if ! deb-systemd-helper --user enable "$SERVER_USER_UNIT" >/dev/null; then
      echo "WARN: could not enable $SERVER_USER_UNIT on first install" >&2
    fi
  else
    SERVER_USER_WAS_ENABLED=0
    SERVER_USER_NEEDS_STATE_REPAIR=0
    if deb-systemd-helper --quiet --user was-enabled "$SERVER_USER_UNIT"; then
      SERVER_USER_WAS_ENABLED=1
    elif server_user_link_is_package_owned "$LEGACY_SERVER_USER_LINK"; then
      SERVER_USER_WAS_ENABLED=1
      SERVER_USER_NEEDS_STATE_REPAIR=1
    elif [ -f "$LEGACY_SERVER_USER_STATE" ]; then
      # One-time repair for the earlier state-only migration. This exact stale
      # package-helper entry is removed after the current link is proven.
      SERVER_USER_WAS_ENABLED=1
      SERVER_USER_NEEDS_STATE_REPAIR=1
    fi

    if [ "$SERVER_USER_WAS_ENABLED" = 1 ]; then
      if [ "$SERVER_USER_NEEDS_STATE_REPAIR" = 1 ]; then
        # make_systemd_links deliberately skips a link whose per-link state
        # stamp already exists. Remove only the exact CURRENT stamp stranded by
        # the old migration so reenable can recreate both link and stamp.
        rm -f -- "$CURRENT_SERVER_USER_STATE"
      fi
      if deb-systemd-helper --user reenable "$SERVER_USER_UNIT" >/dev/null; then
        if server_user_link_is_package_owned "$CURRENT_SERVER_USER_LINK"; then
          if server_user_link_is_package_owned "$LEGACY_SERVER_USER_LINK"; then
            rm -f -- "$LEGACY_SERVER_USER_LINK"
            rmdir "$(dirname "$LEGACY_SERVER_USER_LINK")" 2>/dev/null || true
          fi
          rm -f -- "$LEGACY_SERVER_USER_STATE"
          rmdir "$(dirname "$LEGACY_SERVER_USER_STATE")" 2>/dev/null || true
        else
          echo "WARN: reenable did not create $CURRENT_SERVER_USER_LINK; preserving recovery evidence" >&2
        fi
      else
        echo "WARN: could not reenable $SERVER_USER_UNIT; preserving existing links" >&2
      fi
    else
      deb-systemd-helper --user update-state "$SERVER_USER_UNIT" >/dev/null || true
    fi
  fi
fi

# The Server's productName deterministically owns this root. Never glob across
# both siblings: after the thin-GUI split, /usr/lib/Papercusp GUI/sidecar has
# only the SPA, and choosing it first silently leaves psu/ptool unwired.
SC="/usr/lib/Papercusp Server/sidecar"

# ── (1) psu / ptool → /usr/bin (immediate, deterministic) ───────────────────
# Thin wrappers that exec the BUNDLED node + launcher (so they work even with no
# Node on the user's PATH — same rationale as the mac per-user shim). Written only
# when the bundled launcher + node are actually present.
for tool in psu ptool; do
  launcher="$SC/scripts/$tool.mjs"
  if [ -f "$launcher" ] && [ -x "$SC/bin/node" ]; then
    cat > "/usr/bin/$tool" <<WRAP
#!/usr/bin/env bash
# papercusp $tool launcher — managed by the Papercusp .deb (postinst). Do not edit.
exec "$SC/bin/node" "$launcher" "\$@"
WRAP
    chmod 755 "/usr/bin/$tool"
  fi
done

# ── (1b) `papercusp` dispatcher + the Papercusp Tutorial & Setup desktop icon ─
# (agent-first-onboarding-2026-07-03 P-014.) `papercusp setup` (alias `onboard`)
# runs the terminal concierge; `papercusp tutorial` re-opens the guided tutorial on
# an already-onboarded machine; `papercusp project-history` generates the portable
# project read model. The third .desktop entry sits beside the two
# Tauri-bundled icons (Papercusp Server + Papercusp GUI) and opens the same
# command in the user's terminal. Guarded like everything else — never fails
# the install.
if [ -f "$SC/scripts/onboard.mjs" ] && [ -x "$SC/bin/node" ]; then
  cat > /usr/bin/papercusp <<WRAP
#!/usr/bin/env bash
# papercusp CLI dispatcher — managed by the Papercusp .deb (postinst). Do not edit.
cmd="\${1:-}"
case "\$cmd" in
  setup)    shift; exec "$SC/bin/node" "$SC/scripts/onboard.mjs" --tab=setup "\$@" ;;
  tutorial) shift; exec "$SC/bin/node" "$SC/scripts/onboard.mjs" --tutorial "\$@" ;;
  onboard)  shift; exec "$SC/bin/node" "$SC/scripts/onboard.mjs" "\$@" ;;
  project-history) shift; exec "$SC/bin/node" "$SC/scripts/project-history.mjs" "\$@" ;;
  *) echo "usage: papercusp <setup|tutorial|project-history>"; echo "  setup     open the Tutorial & Setup shell on the Setup tab"; echo "  tutorial  open the Tutorial & Setup shell on the Tutorial tab"; echo "  project-history  generate a versioned project History artifact"; exit 2 ;;
esac
WRAP
  chmod 755 /usr/bin/papercusp

  # Third icon: reuse the Server-owned icon. Terminal=true → the DE opens its
  # default terminal emulator running the concierge.
  if [ -d /usr/share/applications ]; then
    cat > /usr/share/applications/papercusp-tutorial.desktop <<'DESK'
[Desktop Entry]
Type=Application
Name=Papercusp Tutorial & Setup
Comment=Open the guided Papercusp tutorial and setup (tabs for both)
Exec=/usr/bin/papercusp tutorial
Icon=papercusp-server
Terminal=true
Categories=Development;
DESK
    command -v update-desktop-database >/dev/null 2>&1 && \
      update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
  fi
fi

# ── Codex system skills root — inert, removes an idle CPU drain ─────────────
# Codex's skills watcher watches /etc/codex/skills; when that dir is missing it
# watches /etc itself with IN_OPEN, so every process start on the host (each
# opens /etc/ld.so.cache) wakes every Codex agent session the Server runs
# (EI-21417256075155406, measured 2026-10-01: ~5-30% of a core per idle session
# under agent load, 0.1% once the dir existed). An empty dir is inert: Codex
# loads no skills from it.
mkdir -p "${DPKG_ROOT:-}/etc/codex/skills" >/dev/null 2>&1 || true

# ── Codex sandbox on AppArmor-restricted hosts (WI-10004618) ────────────────
# Ubuntu 23.10+ ships kernel.apparmor_restrict_unprivileged_userns=1. Codex's
# Linux sandbox runs /usr/bin/bwrap, which then cannot create a user namespace
# unless an AppArmor profile grants it `userns`. Without one, EVERY command a
# Codex agent runs fails inside the sandbox while the run still reports
# success (measured 2026-10-01 on stock Ubuntu 24.04: 0 of 4 recorded commands
# executed). Grant exactly /usr/bin/bwrap that permission — the scoped fix the
# Codex community uses (github.com/makash/codex-ubuntu24-bubblewrap-fix); the
# global restriction stays on for every other binary. Ubuntu's own
# bwrap-userns-restrict is NOT a substitute: it strips capabilities from
# bwrap's children, which breaks bwrap's loopback setup (openai/codex#12572).
# Never overwrite a profile another package or the administrator owns, and
# remove ours again if the parser rejects it (an AppArmor without `userns`
# rules), so an unloadable profile can never fail apparmor.service at boot.
# Arguments exist so the behaviour is testable against a temp dir.
papercusp_install_bwrap_userns_profile() {
  aa_dir="$1"; restrict_sysctl="$2"; bwrap_bin="$3"
  marker='# Managed by the papercusp-server package (WI-10004618).'
  profile="$aa_dir/bwrap"
  # Only kernels that HAVE the restriction need (or can parse) the grant.
  [ -e "$restrict_sysctl" ] || return 0
  [ -x "$bwrap_bin" ] || return 0
  [ -d "$aa_dir" ] || return 0
  command -v apparmor_parser >/dev/null 2>&1 || return 0
  if [ -e "$profile" ] && ! grep -qF "$marker" "$profile" 2>/dev/null; then
    return 0  # someone else's /etc/apparmor.d/bwrap — leave it alone
  fi
  for other in "$aa_dir"/*; do
    [ -f "$other" ] && [ "$other" != "$profile" ] || continue
    if grep -qE "^[[:space:]]*(profile[[:space:]]+[^[:space:]]+[[:space:]]+)?$bwrap_bin[[:space:]]+(flags=|\{)" "$other" 2>/dev/null; then
      return 0  # another profile already attaches to bwrap
    fi
  done
  cat > "$profile" <<PROFILE || { rm -f "$profile"; return 0; }
$marker Removed with the package.
abi <abi/4.0>,
include <tunables/global>

profile bwrap $bwrap_bin flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
PROFILE
  if ! apparmor_parser -r "$profile" >/dev/null 2>&1; then
    rm -f "$profile"
    echo "WARN: AppArmor rejected the bwrap userns profile; Codex sandboxed commands may fail on this host" >&2
  fi
  return 0
}
if [ -z "${DPKG_ROOT:-}" ]; then
  papercusp_install_bwrap_userns_profile /etc/apparmor.d \
    /proc/sys/kernel/apparmor_restrict_unprivileged_userns /usr/bin/bwrap || true
fi

# ── (2) ghostty — deferred, best-effort ─────────────────────────────────────
# A postinst CANNOT call apt directly (dpkg holds the apt lock for THIS
# transaction → deadlock), so defer the PPA-add + install to a detached worker
# that waits for the lock to free. Best-effort; never blocks or fails the install.
if ! command -v ghostty >/dev/null 2>&1; then
  setsid sh -c '
    i=0
    while [ "$i" -lt 90 ]; do
      command -v fuser >/dev/null 2>&1 || break
      fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break
      i=$((i + 1)); sleep 2
    done
    export DEBIAN_FRONTEND=noninteractive
    command -v add-apt-repository >/dev/null 2>&1 || \
      apt-get install -y software-properties-common >/dev/null 2>&1 || true
    add-apt-repository -y ppa:mkasberg/ghostty-ubuntu >/dev/null 2>&1 || true
    apt-get update -y >/dev/null 2>&1 || true
    apt-get install -y ghostty >/dev/null 2>&1 || true
  ' </dev/null >/dev/null 2>&1 &
fi

exit 0
