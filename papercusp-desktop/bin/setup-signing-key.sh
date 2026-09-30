#!/usr/bin/env bash
# Generate a fresh Tauri updater signing keypair, save it to
# ~/.papercusp/signing/, and update src-tauri/tauri.conf.json's
# `pubkey` to match. The private key never leaves your machine.
#
# After running this:
#   - Private key:  ~/.papercusp/signing/papercusp.key
#   - Public key:   ~/.papercusp/signing/papercusp.key.pub
#   - tauri.conf.json updated to embed the public key
#   - bin/release-local.sh picks the private key up automatically
#
# Re-running this generates a NEW pair. Existing signed binaries
# will fail signature verification against the new pubkey — so only
# regenerate if the old private key is compromised.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
KEY_DIR="${HOME}/.papercusp/signing"
KEY_FILE="${KEY_DIR}/papercusp.key"
PUB_FILE="${KEY_DIR}/papercusp.key.pub"
TAURI_CONF="${ROOT}/src-tauri/tauri.conf.json"

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

if [[ -f "$KEY_FILE" ]]; then
  echo "==> existing key found at $KEY_FILE"
  read -r -p "Overwrite? Type 'yes' to confirm: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "aborted"
    exit 1
  fi
fi

echo "==> generating Tauri updater keypair"
echo "    you'll be prompted for a passphrase — empty is OK for personal builds"
# Use the Tauri CLI which is exposed via npx; --write-keys to a path.
npx --yes -p @tauri-apps/cli@latest tauri signer generate -w "$KEY_FILE"

if [[ ! -f "$PUB_FILE" ]]; then
  echo "ERROR: expected pubkey at $PUB_FILE — keygen failed?"
  exit 1
fi

chmod 600 "$KEY_FILE"
chmod 644 "$PUB_FILE"

echo "==> updating tauri.conf.json pubkey"
# The tauri CLI writes the .pub file ALREADY base64-encoded (one line).
# Re-encoding it here double-encodes and the bundler later dies with
# "failed to decode pubkey: Missing encoded key in public key" — use the
# file content verbatim. (Guard: if a raw "untrusted comment:" minisign
# file shows up from an old CLI, encode it once.)
if head -1 "$PUB_FILE" | grep -q "^untrusted comment:"; then
  PUBKEY_B64="$(base64 -w0 < "$PUB_FILE")"
else
  PUBKEY_B64="$(tr -d '\n' < "$PUB_FILE")"
fi

python3 - "$TAURI_CONF" "$PUBKEY_B64" <<'PY'
import json, sys
path, pubkey = sys.argv[1], sys.argv[2]
with open(path) as f:
    conf = json.load(f)
conf.setdefault("plugins", {}).setdefault("updater", {})["pubkey"] = pubkey
with open(path, "w") as f:
    json.dump(conf, f, indent=2)
    f.write("\n")
print(f"updated {path}")
PY

echo
echo "==> done"
echo "    private key: $KEY_FILE  (keep this safe; never commit)"
echo "    public key:  $PUB_FILE"
echo "    tauri.conf.json pubkey: updated"
echo
echo "Next:"
echo "  - Commit + push the tauri.conf.json change."
echo "  - Run bin/release-local.sh to build + sign + upload a release."
