#!/usr/bin/env bash
# cargo-target-root.sh — the ONE answer to "where does Cargo write build output?"
#
# SOURCE this, then call:
#
#   papercusp_cargo_target_root <cargo-project-dir>
#       non-empty CARGO_TARGET_DIR if exported (Cargo honours it first), else
#       what Cargo itself reports for <cargo-project-dir>.
#   papercusp_cargo_metadata_target_dir <cargo-project-dir>
#       what Cargo reports, IGNORING an exported CARGO_TARGET_DIR (for callers
#       that have already handled an explicit override themselves).
#
# Both print an absolute path with no trailing newline, or return non-zero with
# a diagnostic on stderr. Neither ever GUESSES a directory.
#
# WHY THIS EXISTS (WI-10003499; same class as EI-22589688521091797)
# ~/.cargo/config.toml pins one shared `build.target-dir` for the box, and on
# 2026-09-03 (WI-212675) it moved from ~/.cargo-target to /mnt/data/cargo-target.
# Scripts that defaulted with `${CARGO_TARGET_DIR:-$HOME/.cargo-target}` kept
# looking in the OLD place. The build still succeeded — it wrote the .deb to the
# configured target — and the caller then reported "emitted no fresh .deb". Or
# worse, it picked up a stale package that happened to sit at the old path.
# Cargo's own `target_directory` already folds in CARGO_BUILD_TARGET_DIR,
# CARGO_HOME, and every project/user .cargo/config.toml. So ask Cargo, never a
# hard-coded name. test/cargo-target-root.test.js holds the class guard.

papercusp_cargo_metadata_target_dir() {
  local project="${1:-}"
  if [[ -z "$project" ]]; then
    echo "ERROR: papercusp_cargo_metadata_target_dir needs a Cargo project directory" >&2
    return 2
  fi
  # python3, not node (WI-10005239): build managers run these scripts with a
  # minimal PATH (/usr/bin:/bin). Callers add CARGO_HOME/bin for cargo itself,
  # but node lives outside /usr/bin on the build hosts, so a node helper died
  # with exit 127 before Cargo was ever asked. /usr/bin/python3 is present on
  # every Linux build host that sources this file.
  local py
  py="$(command -v python3 || true)"
  if [[ -z "$py" ]]; then
    echo "ERROR: cannot resolve Cargo target directory for $project — python3 not found on PATH ($PATH); refusing to guess a different filesystem" >&2
    return 1
  fi
  "$py" - "$project" <<'PY'
import json, os, subprocess, sys
project = sys.argv[1]
env = dict(os.environ)
# The caller already honored a non-empty explicit override. An exported empty
# value must not hide Cargo's configuration during this read-only resolution.
env.pop('CARGO_TARGET_DIR', None)
try:
    proc = subprocess.run(['cargo', 'metadata', '--no-deps', '--format-version', '1'],
                          cwd=project, env=env, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=10)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or f'cargo metadata exited {proc.returncode}')
    target = json.loads(proc.stdout).get('target_directory')
    if not isinstance(target, str) or not os.path.isabs(target):
        raise RuntimeError('Cargo metadata did not return an absolute target_directory')
    sys.stdout.write(target)
except Exception as error:  # noqa: BLE001 — every failure is a refusal, never a guess
    sys.stderr.write(f'ERROR: cannot resolve Cargo target directory for {project} — refusing to guess a different filesystem: {str(error)[:1200]}\n')
    sys.exit(1)
PY
}

papercusp_cargo_target_root() {
  if [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
    printf '%s' "$CARGO_TARGET_DIR"
    return 0
  fi
  papercusp_cargo_metadata_target_dir "${1:-}"
}
