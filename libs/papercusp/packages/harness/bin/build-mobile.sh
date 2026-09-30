#!/usr/bin/env bash
# Mobile build smoke gate — runs from a coding harness root.
# Triggers EAS Build for both iOS + Android in preview profile (cloud-signed).
# Reads creds from ~/.restart-org/secrets/eas-token.txt (set via PUT /api/org/secrets/eas-token).
# Writes .papercusp/build-mobile-pass.md or .papercusp/build-mobile-fail.md.
#
# Exits 0 on success, 1 on fail. Intended for use as smoke-test gate or pre-commit hook.

set -uo pipefail

HARNESS_ROOT="${HARNESS_ROOT:-$PWD}"
STATE_DIR="$HARNESS_ROOT/.papercusp"
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
PASS_FILE="$STATE_DIR/build-mobile-pass.md"
FAIL_FILE="$STATE_DIR/build-mobile-fail.md"
LOG_DIR="$STATE_DIR/logs/build-mobile"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$TS.log"

write_fail() {
  rm -f "$PASS_FILE"
  cat > "$FAIL_FILE" <<EOF
# Mobile build FAILED at $TS

$1

Log: $LOG
EOF
  exit 1
}

# 1. Verify Expo project exists
if [ ! -f "$HARNESS_ROOT/app.json" ] && [ ! -f "$HARNESS_ROOT/app.config.js" ] && [ ! -f "$HARNESS_ROOT/app.config.ts" ]; then
  write_fail "No Expo app.json / app.config found at $HARNESS_ROOT. Run \`npx create-expo-app .\` first."
fi

# 2. Get EAS token. Canonical secrets path is ~/.papercusp/secrets/;
# legacy ~/.restart-org/secrets/ is honored for harnesses that pre-date
# the workspace migration.
EAS_TOKEN_FILE=""
for cand in "$HOME/.papercusp/secrets/eas-token.txt" "$HOME/.restart-org/secrets/eas-token.txt"; do
  if [ -f "$cand" ]; then EAS_TOKEN_FILE="$cand"; break; fi
done
if [ -z "$EAS_TOKEN_FILE" ]; then
  write_fail "Missing EAS token. Set via: curl -X PUT http://localhost:3055/api/org/secrets/eas-token -d '{\"value\":\"<your-eas-token>\"}' (canonical store: ~/.papercusp/secrets/eas-token.txt)"
fi
export EAS_NO_VCS=1
export EXPO_TOKEN="$(cat "$EAS_TOKEN_FILE")"

# 3. Build iOS preview (cloud)
echo "=== iOS preview build ===" | tee -a "$LOG"
if ! npx eas build --platform ios --profile preview --non-interactive --no-wait 2>&1 | tee -a "$LOG"; then
  write_fail "iOS build submission failed. See log."
fi

# 4. Build Android preview (cloud)
echo "=== Android preview build ===" | tee -a "$LOG"
if ! npx eas build --platform android --profile preview --non-interactive --no-wait 2>&1 | tee -a "$LOG"; then
  write_fail "Android build submission failed. See log."
fi

rm -f "$FAIL_FILE"
cat > "$PASS_FILE" <<EOF
# Mobile build SUBMITTED at $TS

iOS + Android preview builds submitted to EAS Build (cloud).
Watch progress at https://expo.dev/accounts/<your-account>/projects/

This script returns 0 once build submission succeeds. Actual build outcome
should be polled via EAS API or the Expo dashboard. Future round: poll
\`eas build:list --status finished --limit 1\` and gate on artifact URL.

Log: $LOG
EOF

exit 0
