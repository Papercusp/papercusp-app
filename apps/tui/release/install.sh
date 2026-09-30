#!/bin/sh
# Install or update PUI from this unpacked release (pui-first-party-public-release
# P-011 / D-016). Needs only a POSIX shell and sha256sum or shasum — no Cargo,
# python, or source checkout. The real work is `bin/pui self install`, which
# verifies the release again, previews exactly what changes, and asks first.
#
#   ./install.sh             install, or update an existing install
#   ./install.sh --yes       skip the confirmation prompt
#   ./install.sh --dry-run   show what would change and change nothing
#
# Afterwards: `pui self status`, `pui self rollback`, `pui self uninstall`.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if command -v sha256sum >/dev/null 2>&1; then
  verify() { (cd "$here" && sha256sum -c --quiet CONTENTS.sha256); }
elif command -v shasum >/dev/null 2>&1; then
  verify() { (cd "$here" && shasum -a 256 -c --quiet CONTENTS.sha256); }
else
  echo "install.sh: sha256sum or shasum is required to verify this release" >&2
  exit 1
fi
if ! verify; then
  echo "install.sh: this release does not match CONTENTS.sha256 — it is damaged or was modified; download it again" >&2
  exit 1
fi

# Prove the binary starts here before anything is installed. The loader names a
# missing system library; ALSA (voice) is the one a minimal system may lack.
if ! probe=$("$here/bin/pui" --version 2>&1); then
  echo "install.sh: pui cannot start on this machine:" >&2
  echo "  $probe" >&2
  case "$probe" in
    *libasound*)
      echo "  repair: install the ALSA runtime library — Debian/Ubuntu/WSL2: sudo apt install libasound2t64 (libasound2 on older releases); Fedora: sudo dnf install alsa-lib" >&2
      ;;
  esac
  exit 1
fi

"$here/bin/pui" self install --from "$here" "$@"

for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && exit 0
done

# The installed files are verified; doctor then checks what the install cannot:
# stale panes and the operator endpoint. Its findings are guidance, unless it
# fails to confirm the installed release itself.
launcher="${PUI_BIN_DIR:-$HOME/.local/bin}/pui"
echo "→ checking the installation and the operator endpoint (pui doctor)…"
set +e
report=$("$launcher" doctor 2>&1)
status=$?
set -e
printf '%s\n' "$report"
case "$report" in
  *"PUI local install: OK"*) ;;
  *)
    echo "install.sh: pui doctor did not confirm the installed release" >&2
    exit 1
    ;;
esac
if [ "$status" -ne 0 ]; then
  echo "PUI is installed; doctor's notes above are setup guidance (with no operator yet, run \`pui\` to open setup)." >&2
fi
