#!/bin/sh
# Remove the psu/ptool launchers the postinst wrote to /usr/bin (they are NOT
# dpkg-tracked files, so dpkg won't reap them on its own). ghostty is left
# installed — it's a normal apt package the user may want independently.
set -e

# The GUI inherits this maintainer script from the base Tauri config, but the
# manual launchers and tutorial entry are Server-owned. Removing or purging the
# GUI must be a no-op here so it cannot corrupt a still-installed Server.
[ "${DPKG_MAINTSCRIPT_PACKAGE:-}" = "papercusp-server" ] || exit 0

SERVER_USER_UNIT=papercusp-server.service

# prerm stops every live user manager before dpkg removes the executable.  Once
# the unit file is gone, reload those same managers so they discard the loaded
# fragment instead of retaining a stale, enabled unit until the next login.
# Ordinary remove still preserves deb-systemd-helper enablement state for a
# later reinstall; purge below remains the only path that deletes that state.
case "$1" in
  remove|purge)
    if [ -z "${DPKG_ROOT:-}" ] \
      && command -v deb-systemd-invoke >/dev/null 2>&1; then
      deb-systemd-invoke --user daemon-reload >/dev/null || true
    fi
    ;;
esac

# Match dh_installsystemduser's purge semantics for the Server-only user unit.
# `remove` intentionally preserves the administrator's enable/disable choice so
# a later reinstall restores it; `purge` removes the helper state and global
# default.target.wants link. The package-name gate matters because
# this postrm is shared with the independently installed GUI product.
if [ "$1" = "purge" ] \
  && [ -z "${DPKG_ROOT:-}" ] \
  && command -v deb-systemd-helper >/dev/null 2>&1; then
  deb-systemd-helper --user purge "$SERVER_USER_UNIT" >/dev/null || true
fi

case "$1" in
  remove|purge)
    rm -f /usr/bin/psu /usr/bin/ptool /usr/bin/papercusp
    rm -f /usr/share/applications/papercusp-tutorial.desktop
    command -v update-desktop-database >/dev/null 2>&1 && \
      update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
    # The postinst's bwrap userns grant (WI-10004618) exists only for the
    # Server's Codex agents: withdraw it with the package, but only when the
    # profile is ours (an administrator's own /etc/apparmor.d/bwrap stays).
    if [ -z "${DPKG_ROOT:-}" ] \
      && grep -qF '# Managed by the papercusp-server package (WI-10004618).' /etc/apparmor.d/bwrap 2>/dev/null; then
      command -v apparmor_parser >/dev/null 2>&1 && \
        apparmor_parser -R /etc/apparmor.d/bwrap >/dev/null 2>&1 || true
      rm -f /etc/apparmor.d/bwrap
    fi
    ;;
esac
exit 0
