#!/usr/bin/env bash
# Interactively write ~/.papercusp/posthog.json — the discovery file
# the operator reads at boot (see apps/operator/lib/posthog-config.ts
# in the papercup repo).
#
# Writing this file is what enables PostHog for feature flags + (if
# the user also opts in via the Setup Wizard's Step 12) telemetry
# forwarding.
#
# Privacy moat: an installed binary on a fresh machine has NO
# discovery file → testingFeatures false → no outbound PostHog
# calls regardless of any UI-level toggle. This script is for admin
# / dev machines.

set -euo pipefail

OUT="${HOME}/.papercusp/posthog.json"
mkdir -p "$(dirname "$OUT")"

echo "==> ~/.papercusp/posthog.json setup"
echo

if [[ -f "$OUT" ]]; then
  echo "Existing file at $OUT — current host: $(jq -r .host "$OUT" 2>/dev/null || echo '?')"
  read -r -p "Overwrite? Type 'yes' to confirm: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "aborted"
    exit 1
  fi
fi

read -r -p "PostHog host URL [https://flags.papercuspai.com]: " HOST
HOST="${HOST:-https://flags.papercuspai.com}"

read -r -p "PostHog project key (phc_…): " PROJECT_KEY
if [[ -z "$PROJECT_KEY" ]]; then
  echo "ERROR: project key required"
  exit 1
fi

read -r -p "PostHog personal API key (phx_…) [enter to skip — falls back to projectKey]: " PERSONAL_KEY
PERSONAL_KEY="${PERSONAL_KEY:-$PROJECT_KEY}"

read -r -p "Project ID (numeric, optional): " PROJECT_ID

read -r -p "Enable testingFeatures (live PostHog updates)? [y/N]: " TESTING
case "$TESTING" in
  y|Y|yes) TESTING_FEATURES=true ;;
  *) TESTING_FEATURES=false ;;
esac

# Build JSON. Use python to avoid quoting bugs.
python3 - "$OUT" "$HOST" "$PROJECT_KEY" "$PERSONAL_KEY" "$PROJECT_ID" "$TESTING_FEATURES" <<'PY'
import json, sys
out, host, project_key, personal_key, project_id, testing = sys.argv[1:7]
data = {
  "version": 1,
  "host": host,
  "projectKey": project_key,
  "personalApiKey": personal_key,
  "testingFeatures": testing == "true",
  "webhookSecret": "",
}
if project_id.strip():
  try:
    data["projectId"] = int(project_id)
  except ValueError:
    pass
with open(out, "w") as f:
  json.dump(data, f, indent=2)
  f.write("\n")
PY

chmod 600 "$OUT"

echo
echo "==> wrote $OUT (mode 0600)"
echo "    testingFeatures: $TESTING_FEATURES"
echo
echo "Restart the operator to pick up the new config."
