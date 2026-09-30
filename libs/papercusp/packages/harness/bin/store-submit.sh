#!/usr/bin/env bash
# Submit the most-recently-built mobile artifact to App Store + Play Store via
# EAS Submit. Run AFTER bin/build-mobile.sh has produced production builds.
#
# Requires:
#   ~/.restart-org/secrets/eas-token.txt
#   ~/.restart-org/secrets/google-play-service-account.json (for Android)
#   ~/.restart-org/secrets/apple-app-store-connect-key.txt (for iOS)
#   ~/.restart-org/secrets/apple-id.txt (Apple ID email)
#   ~/.restart-org/secrets/asc-app-id.txt (App Store Connect app id)

set -uo pipefail

HARNESS_ROOT="${HARNESS_ROOT:-$PWD}"
cd "$HARNESS_ROOT" || exit 1
STATE_DIR="$HARNESS_ROOT/.papercusp"
LOG_DIR="$STATE_DIR/logs/store-submit"
mkdir -p "$LOG_DIR"
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG="$LOG_DIR/$TS.log"

# Canonical secrets path is ~/.papercusp/secrets/; legacy
# ~/.restart-org/secrets/ honored for harnesses that pre-date the
# workspace migration.
if [ -d "$HOME/.papercusp/secrets" ]; then
  SECRETS="$HOME/.papercusp/secrets"
else
  SECRETS="$HOME/.restart-org/secrets"
fi

require_secret() {
  if [ ! -f "$SECRETS/$1.txt" ] && [ ! -f "$SECRETS/$1.json" ]; then
    echo "ERROR: missing secret '$1'. Set via: curl -X PUT http://localhost:3001/api/org/secrets/$1 ..."
    return 1
  fi
}

require_secret "eas-token" || exit 1
EXPO_TOKEN="$(cat "$SECRETS/eas-token.txt")"
export EXPO_TOKEN

# Android: requires service-account JSON
if [ -f "$SECRETS/google-play-service-account.json" ]; then
  echo "=== Submitting Android (Play Store) ===" | tee -a "$LOG"
  npx eas submit --platform android --profile production --non-interactive 2>&1 | tee -a "$LOG" || echo "Android submit failed (continuing to iOS)"
else
  echo "SKIP Android: no google-play-service-account.json secret."
fi

# iOS: requires apple-id + asc-app-id + ASC key
if [ -f "$SECRETS/apple-id.txt" ] && [ -f "$SECRETS/asc-app-id.txt" ] && [ -f "$SECRETS/apple-app-store-connect-key.txt" ]; then
  echo "=== Submitting iOS (App Store) ===" | tee -a "$LOG"
  APPLE_ID="$(cat "$SECRETS/apple-id.txt")"
  ASC_APP_ID="$(cat "$SECRETS/asc-app-id.txt")"
  export EXPO_APPLE_ID="$APPLE_ID"
  export EXPO_ASC_APP_ID="$ASC_APP_ID"
  npx eas submit --platform ios --profile production --non-interactive 2>&1 | tee -a "$LOG" || echo "iOS submit failed."
else
  echo "SKIP iOS: missing apple-id / asc-app-id / apple-app-store-connect-key secrets."
fi

echo ""
echo "Submit log: $LOG"
