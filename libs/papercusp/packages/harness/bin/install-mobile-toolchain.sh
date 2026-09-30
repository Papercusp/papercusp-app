#!/usr/bin/env bash
# One-shot installer for the mobile-app coding harness toolchain.
# Idempotent: skips already-installed steps.
# Run once per machine; the installed tools are then available to every
# coding harness that scaffolded with the mobile-app template.

set -uo pipefail

OS="$(uname -s)"

green() { echo -e "\033[32m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }
red() { echo -e "\033[31m$*\033[0m"; }

# 1. Node.js (18+) — assumed already installed for the rest of the Restart stack
if ! command -v node >/dev/null 2>&1; then
  red "node not found. Install Node 18+ first (e.g. via nvm)."
  exit 1
fi
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 18 ]; then
  red "node $(node -v) is too old; need 18+."
  exit 1
fi
green "✓ node $(node -v)"

# 2. EAS CLI (cloud iOS/Android builds, no Mac needed)
if ! command -v eas >/dev/null 2>&1; then
  yellow "Installing EAS CLI globally (npm i -g eas-cli)..."
  npm install -g eas-cli || { red "EAS CLI install failed."; exit 1; }
fi
green "✓ eas $(eas --version 2>&1 | head -1)"

# 3. Expo CLI
if ! command -v expo >/dev/null 2>&1; then
  yellow "Installing Expo CLI globally (npm i -g expo)..."
  npm install -g expo || { red "Expo CLI install failed."; exit 1; }
fi
green "✓ expo $(expo --version 2>&1 | head -1)"

# 4. Maestro (E2E mobile UI tests)
if ! command -v maestro >/dev/null 2>&1; then
  yellow "Installing Maestro CLI..."
  curl -Ls "https://get.maestro.mobile.dev" | bash || { yellow "Maestro install failed (non-fatal — UI tests skipped)"; }
fi
if command -v maestro >/dev/null 2>&1; then
  green "✓ maestro $(maestro --version 2>&1 | head -1)"
else
  yellow "⚠ maestro not installed (UI smoke tests will be skipped)"
fi

# 5. Android SDK (only needed for local emulator smoke tests; cloud EAS Build works without)
if [ "$OS" = "Linux" ] || [ "$OS" = "Darwin" ]; then
  if [ -z "${ANDROID_HOME:-}" ] || [ ! -d "${ANDROID_HOME:-/nonexistent}" ]; then
    yellow "ANDROID_HOME not set. Local Android emulator smoke tests will be skipped."
    yellow "To enable: install Android Studio + set ANDROID_HOME to ~/Android/Sdk (Linux) or ~/Library/Android/sdk (macOS)."
    yellow "EAS Build (cloud) doesn't need this — only matters for emulator-based smoke tests."
  else
    green "✓ ANDROID_HOME=$ANDROID_HOME"
  fi
fi

# 6. Verify EAS auth
EAS_TOKEN_FILE="$HOME/.restart-org/secrets/eas-token.txt"
if [ -f "$EAS_TOKEN_FILE" ]; then
  green "✓ EAS token present at $EAS_TOKEN_FILE"
else
  yellow "⚠ EAS token not set. Get one from https://expo.dev/accounts/[username]/settings/access-tokens"
  yellow "  Then store via: curl -X PUT http://localhost:3001/api/org/secrets/eas-token -H 'content-type: application/json' -d '{\"value\":\"<token>\"}'"
fi

# 7. Apple Developer account (for iOS builds — EAS handles signing if you provide credentials)
APPLE_TOKEN_FILE="$HOME/.restart-org/secrets/apple-app-store-connect-key.txt"
if [ -f "$APPLE_TOKEN_FILE" ]; then
  green "✓ Apple App Store Connect key present"
else
  yellow "⚠ Apple App Store Connect key missing. Required for iOS submission (not for build itself)."
  yellow "  Apple Developer Program: \$99/yr at https://developer.apple.com/programs/"
fi

# 8. Google Play (for Android submission)
GOOGLE_TOKEN_FILE="$HOME/.restart-org/secrets/google-play-service-account.json"
if [ -f "$GOOGLE_TOKEN_FILE" ]; then
  green "✓ Google Play service account JSON present"
else
  yellow "⚠ Google Play service account missing. Required for Android Play Store submission."
  yellow "  Google Play Console: \$25 one-time at https://play.google.com/console/signup"
fi

green ""
green "=== Mobile toolchain status ==="
green "Required for EAS Build (cloud iOS/Android): Node 18+, eas-cli, expo, EAS token"
yellow "Optional for emulator smoke tests: Android SDK, Maestro"
yellow "Required for store submission: Apple cert + Google Play service account"
