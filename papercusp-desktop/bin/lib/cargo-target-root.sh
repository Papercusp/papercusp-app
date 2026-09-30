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
  node - "$project" <<'JS'
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
// The caller already honored a non-empty explicit override. An exported empty
// value must not hide Cargo's configuration during this read-only resolution.
delete env.CARGO_TARGET_DIR;
try {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
    cwd: process.argv[2], env, encoding: 'utf8', timeout: 10000,
    maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  if (typeof metadata.target_directory !== 'string' || !path.isAbsolute(metadata.target_directory)) {
    throw new Error('Cargo metadata did not return an absolute target_directory');
  }
  process.stdout.write(metadata.target_directory);
} catch (error) {
  console.error(`ERROR: cannot resolve Cargo target directory for ${process.argv[2]} — refusing to guess a different filesystem: ${String(error.stderr || error.message).slice(0, 1200)}`);
  process.exit(1);
}
JS
}

papercusp_cargo_target_root() {
  if [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
    printf '%s' "$CARGO_TARGET_DIR"
    return 0
  fi
  papercusp_cargo_metadata_target_dir "${1:-}"
}
