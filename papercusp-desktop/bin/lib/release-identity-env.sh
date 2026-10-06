#!/usr/bin/env bash
# release-identity-env.sh — compatibility loader for historical owner identity inputs.
#
# WHY THIS EXISTS (WI-10004349)
# -----------------------------
# Older finished-byte audit and source-scrub paths treated owner name/email as release
# leaks and consumed PAPERCUSP_RELEASE_OWNER_NAME / _EMAIL. D-112 deliberately permits
# those values across the release bundle: a full-history seed legitimately carries
# authorship, while machine user/home/hostname and credentials remain forbidden.
#
# Measured 2026-09-30: every release:cut call over the previous five days passed a single
# hand-typed name and, with one exception, no email. The owner-provisioned
# ~/.papercusp/release-identity.env holds two names and two addresses. So 0.0.25 (published)
# and 0.0.26 (signed) both shipped six docs files carrying the SECOND name unscrubbed, while
# the audit printed "✓ CLEAN" beside a "PARTIAL COVERAGE: EMAIL not covered" caveat. A caller
# value that was merely INCOMPLETE silently shadowed the complete one.
#
# WHAT IT DOES
# ------------
# papercusp_union_release_identity_env  UNIONS the file's literals with whatever the
#   environment already carries. Union, not "fill the gap" (the rule loadOwnerIdentityEnv
#   uses for the record/gate CLIs): for a redaction list more literals are strictly safer,
#   and a partial explicit value must never hide the rest. Values are parsed with Node's
#   util.parseEnv, the same parser owner-identity-env.ts uses; the file is never executed.
# papercusp_require_release_owner_identity  remains as a successful compatibility
#   preflight so older release-local.sh callers do not break. It intentionally requires
#   nothing under D-112's machine-only policy.
#
# It prints counts only. Owner literals are never echoed, logged or written to a file:
# runtime-only is the rule that keeps the audit from manufacturing the leak it hunts.
#
# Path: $PAPERCUSP_RELEASE_IDENTITY_ENV, else $HOME/.papercusp/release-identity.env
# (the same override owner-identity-env.ts and workspace-host-release-cut-cli.ts honour).

# Split every argument on comma/semicolon (the audit's own separators: names contain
# spaces, so whitespace is NOT a separator), trim, drop empties, de-duplicate keeping the
# first occurrence, and print the result comma-joined. No globbing, no word splitting.
__pc_identity_union() {
  local out="" seen=$'\n' arg item
  local -a parts
  for arg in "$@"; do
    IFS=',;' read -r -a parts <<<"$arg"
    for item in "${parts[@]}"; do
      item="${item//$'\r'/}"
      item="${item#"${item%%[![:space:]]*}"}"
      item="${item%"${item##*[![:space:]]}"}"
      [[ -n "$item" ]] || continue
      case "$seen" in *$'\n'"$item"$'\n'*) continue ;; esac
      seen+="$item"$'\n'
      out+="${out:+,}$item"
    done
  done
  printf '%s' "$out"
}

# Number of literals in a comma-joined list (0 for empty).
__pc_identity_count() {
  local list="$1" commas
  [[ -n "$list" ]] || { printf '0'; return; }
  commas="${list//[^,]/}"
  printf '%s' "$(( ${#commas} + 1 ))"
}

# Print KEY's value from an env file using Node's util.parseEnv (never sourcing the file).
__pc_identity_file_value() {
  node -e '
    const fs = require("node:fs");
    const { parseEnv } = require("node:util");
    const parsed = parseEnv(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(parsed[process.argv[2]] ?? "").trim());
  ' "$1" "$2"
}

papercusp_release_identity_env_path() {
  printf '%s' "${PAPERCUSP_RELEASE_IDENTITY_ENV:-${HOME:-}/.papercusp/release-identity.env}"
}

papercusp_union_release_identity_env() {
  local file key from_file merged
  file="$(papercusp_release_identity_env_path)"
  if [[ ! -e "$file" ]]; then
    echo "[identity] no $file — owner identity comes from the environment alone" >&2
    return 0
  fi
  if [[ ! -r "$file" ]]; then
    echo "ERROR: $file exists but is not readable; refusing to cut with a partial owner identity." >&2
    return 2
  fi
  for key in PAPERCUSP_RELEASE_OWNER_NAME PAPERCUSP_RELEASE_OWNER_EMAIL; do
    if ! from_file="$(__pc_identity_file_value "$file" "$key")"; then
      echo "ERROR: could not parse $file; refusing to cut with a partial owner identity." >&2
      return 2
    fi
    merged="$(__pc_identity_union "${!key:-}" "$from_file")"
    export "$key=$merged"
  done
  echo "[identity] $file unioned: $(__pc_identity_count "$PAPERCUSP_RELEASE_OWNER_NAME") owner-name literal(s), $(__pc_identity_count "$PAPERCUSP_RELEASE_OWNER_EMAIL") owner-email literal(s)" >&2
}

papercusp_require_release_owner_identity() {
  # Compatibility surface only. Do not delete the function: release-local.sh and older
  # cutters call it before their first write. Owner values may still be unioned above for
  # callers that use them as metadata, but their absence is not a privacy failure.
  return 0
}
