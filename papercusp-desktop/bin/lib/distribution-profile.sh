# shellcheck shell=bash
# The build's DEFAULT distribution profile, derived from the tree being built.
#
# open-source-release-2026-09-29 D-005 / P-019: a build of the PUBLIC (ELv2) source cut
# must run the `public` profile, which switches off every Claude.ai subscription relay
# (account pooling, OAuth bundle sync, cross-device account honoring — see
# packages/operator-core/lib/anthropic-auth-policy.ts). The public export writes
# MANIFEST.json at the repo root with "target": "public", so the tree itself says which
# build it is: nobody building from the public repo has to remember an env var, and the
# private monorepo (no such MANIFEST) keeps its historical `dogfood` default.
#
# An explicit PAPERCUSP_DISTRIBUTION_PROFILE still wins; callers apply that themselves.

# default_distribution_profile <desktop-root>
default_distribution_profile() {
  local manifest="$1/../MANIFEST.json"
  if [[ -f "$manifest" ]] && grep -Eq '"target"[[:space:]]*:[[:space:]]*"public"' "$manifest"; then
    echo public
  else
    echo dogfood
  fi
}
