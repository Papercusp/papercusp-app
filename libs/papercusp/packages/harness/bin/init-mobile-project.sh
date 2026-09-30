#!/usr/bin/env bash
# Initialize an Expo + TypeScript starter inside a freshly-scaffolded mobile-app
# coding harness directory. Run AFTER scaffold_harness has created SPEC.md +
# .papercusp/, so the planner has something concrete to iterate against.
#
# Usage: cd ~/<your-mobile-project-slug> && ~/autonomous-harness/bin/init-mobile-project.sh
#
# Idempotent: skips if app.json or app.config.* already exists.

set -uo pipefail

HARNESS_ROOT="${HARNESS_ROOT:-$PWD}"
cd "$HARNESS_ROOT" || { echo "Cannot cd to $HARNESS_ROOT"; exit 1; }

if [ -f "app.json" ] || [ -f "app.config.js" ] || [ -f "app.config.ts" ]; then
  echo "Expo project already initialized at $HARNESS_ROOT — skipping."
  exit 0
fi

if [ ! -f "SPEC.md" ]; then
  echo "ERROR: no SPEC.md at $HARNESS_ROOT — run scaffold_harness first."
  exit 1
fi

# Use slug from cwd basename
SLUG="$(basename "$HARNESS_ROOT")"

# Create-expo-app refuses to write into a non-empty dir. Stash our files OUTSIDE the harness root.
STASH="$(mktemp -d -t expo-stash-XXXXXX)"
mv SPEC.md GOAL.md .harness "$STASH/" 2>/dev/null || true

echo "Initializing Expo (TypeScript blank template)..."
npx --yes create-expo-app . --template blank-typescript --no-install || {
  echo "ERROR: create-expo-app failed."
  # Restore our files
  mv "$STASH"/* "$STASH"/.* . 2>/dev/null || true
  rmdir "$STASH" 2>/dev/null || true
  exit 1
}

# Restore our files (overwrites template's defaults if collision)
mv "$STASH"/* "$STASH"/.harness . 2>/dev/null || true
rmdir "$STASH" 2>/dev/null || true

# Write a minimal eas.json for cloud builds
cat > eas.json <<EOF
{
  "cli": { "version": ">= 5.0.0" },
  "build": {
    "preview": {
      "distribution": "internal",
      "ios": { "simulator": false },
      "android": { "buildType": "apk" }
    },
    "production": {
      "ios": { "simulator": false },
      "android": { "buildType": "aab" }
    }
  },
  "submit": {
    "production": {
      "ios": { "appleId": "set-via-secrets", "ascAppId": "set-via-secrets" },
      "android": { "serviceAccountKeyPath": "set-via-secrets" }
    }
  }
}
EOF

# Install npm deps
echo "Installing npm packages..."
npm install --silent || echo "WARN: npm install failed; finish manually."

echo ""
echo "✓ Expo project initialized at $HARNESS_ROOT"
echo "  Test locally: npm run start"
echo "  Build mobile: ~/autonomous-harness/bin/build-mobile.sh"
echo "  Submit to stores: ~/autonomous-harness/bin/store-submit.sh"
