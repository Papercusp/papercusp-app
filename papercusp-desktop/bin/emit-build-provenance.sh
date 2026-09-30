#!/usr/bin/env bash
# Emit build-provenance.json next to a set of release artifacts (EI-8914).
#
# WHY: an installer must be traceable back to the bytes it was built from. The
# operator self-reports ONE string (PAPERCUSP_BUILD_SHA at /api/health); this
# records the WHOLE provenance next to the artifacts — the shipped version, the
# baked sha, the git head + dirty state, and the sha256 of every artifact — so a
# reviewer/owner can verify a downloaded installer, and so a stale artifact
# can't masquerade as a fresh cut (the LABELED != PACKED failure class: the
# 0.0.5 win cut on 2026-07-09 shipped sha 1a161ab-wi3407 while its packed bytes
# were ecea544, ~10k lines apart).
#
# ONE emitter, ONE schema across all three legs (P-002 consolidation): the
# Linux + Mac legs of release-local.sh call this directly, and the Windows leg
# (bin/build-windows-on-vm.sh) now calls it too instead of its old inline
# duplicate. Leg-specific fields ride an optional env seam so a leg that doesn't
# need them gets byte-identical output:
#   PROVENANCE_PACKED_SRC_FINGERPRINT — Windows: a hash of the exact tree packed
#     to the VM (its strongest anti-LABELED!=PACKED signal; Mac/Linux have none).
#   PROVENANCE_SIGNED (true|false)    — Windows: whether Authenticode was configured.
#   PROVENANCE_SIDECAR_DIR            — the packed sidecar's directory. The emitter
#     reads THAT dir's own build-provenance.json and folds a compact `sidecar` record
#     (gitHead / builtAtUtc / serve.mjs sha256) in beside the Rust-layer fields, so the
#     artifact records WHICH sidecar it shipped and not merely which commit built the
#     binary. EI-20086238555902880 — the two halves refresh on different policies.
#   PROVENANCE_TOOLCHAIN (json)       — the build toolchain as a JSON object
#     (rustc/node/tauriCli), recorded by the leg whose emitter runs ON the builder
#     (the Linux leg: host == builder). P-014 reproducibility hygiene.
#   PROVENANCE_REPLACE_BUILD_SHA_FROM — compare-and-swap repair seam. When the
#     output already attests the exact same artifact bytes, changing buildSha is
#     refused unless this value exactly matches the existing buildSha. This keeps
#     metadata-only recovery from replacing the identity baked into /api/health.
#   PROVENANCE_REPLACE_VERSION_FROM   — the equivalent compare-and-swap seam for
#     the baked app version. Same-byte version rewrites are otherwise refused.
#   PROVENANCE_SOURCE_DIRTY_MANIFEST   — a JSON snapshot written by this script's
#     `--capture-source GIT_ROOT MANIFEST_OUT` mode at the same cut-start boundary
#     as PROVENANCE_SOURCE_GIT_HEAD / _DIRTY. It records the porcelain status set
#     and a sha256 for every dirty working-tree path, so a dirty build can answer
#     "did it contain these exact source bytes?" without pickaxe/mtime folklore.
#   PROVENANCE_SOURCE_REPAIR_ROLES    — actual Windows native build roles.
#     Must exactly match an explicit-role source repair; omission is GUI-only
#     compatibility for the legacy manifest, never inferred Server permission.
#
# Usage:
#   emit-build-provenance.sh OUT_DIR VERSION BUILD_SHA REUSED ARTIFACT...
#     OUT_DIR      dir to write build-provenance.json into
#     VERSION      shipped app version (PAPERCUSP_BUILD_VERSION)
#     BUILD_SHA    baked PAPERCUSP_BUILD_SHA (what /api/health self-reports)
#     REUSED       "true" | "false" — were these artifacts BUILT this cut, or
#                  SALVAGED from a prior one (PAPERCUSP_REUSE_MAC/WIN)? A reused
#                  set carries THIS cut's version/sha LABEL but was not built
#                  from the current source — so `reused:true` is the honest flag
#                  that its label may not match its bytes.
#     ARTIFACT...  the shipped files to fingerprint (globs pre-expanded by the
#                  caller; non-existent paths are skipped)
#
# Artifact `name` is the path RELATIVE TO OUT_DIR when the artifact lives under
# it (e.g. "deb/App_0.0.8_amd64.deb"), else the basename (WI-4243: basenames
# forced verify-provenance.sh consumers to build symlink stages for the
# linux/mac subdir layouts). Each artifact also records `sig`: whether a
# co-located minisign .sig existed AT EMIT TIME — the unambiguous per-artifact
# answer WI-4243 found missing (the top-level windows `signed` field means
# Authenticode, NOT minisign, and was being misread).
#
# The source git head/dirty normally come from PROVENANCE_GIT_ROOT (default:
# $PWD). A release orchestrator whose build mutates tracked staging files MUST
# capture the clean input state before those mutations and pass it through
# PROVENANCE_SOURCE_GIT_HEAD / PROVENANCE_SOURCE_GIT_DIRTY. The record keeps
# both moments: gitHead/gitDirty describe the source accepted at cut start,
# while gitHeadAtEmit/gitDirtyAtEmit describe the checkout when this file was
# emitted. Conflating those moments made every normal release look dirty after
# the cutter regenerated tracked env-sidecars (EI-20555742146560765).
set -euo pipefail

# One source-state oracle for both emission time and direct producers that must
# preserve their clean input before they generate tracked build state. Printing
# two newline-delimited scalars keeps the capture mode shell-safe without eval.
provenance_submodule_worktree_dirty() {
  local git_root="${1:?git root required}"
  local status_output line expected path sub_root actual top
  if ! status_output="$(git -C "$git_root" submodule status --recursive 2>/dev/null)"; then
    # An unreadable status is not evidence of a clean snapshot.
    return 0
  fi

  if [[ -z "$status_output" ]]; then
    # `submodule status` can be empty when the config/worktree is damaged. If
    # HEAD still contains a gitlink, fail closed rather than accepting it.
    if git -C "$git_root" ls-tree -r HEAD 2>/dev/null | grep -q '^160000 '; then
      return 0
    fi
    return 1
  fi

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    expected="${line#?}"
    expected="${expected%% *}"
    path="${line#?}"
    path="${path#"$expected"}"
    path="${path# }"
    path="${path%% *}"
    [[ -n "$expected" && -n "$path" ]] || return 0

    sub_root="$git_root/$path"
    [[ -d "$sub_root" ]] || return 0
    # A missing/empty submodule `.git` must not fall through to the parent
    # repository's HEAD. The top-level check makes that distinction explicit.
    top="$(git -C "$sub_root" rev-parse --show-toplevel 2>/dev/null || true)"
    [[ "$top" = "$sub_root" ]] || return 0
    actual="$(git -C "$sub_root" rev-parse HEAD 2>/dev/null || true)"
    [[ -n "$actual" && ( "$actual" = "$expected" || "$actual" = "$expected"* ) ]] || return 0
  done <<< "$status_output"

  return 1
}

capture_provenance_source() {
  local candidate="${1:?git root required}"
  local git_root status_output
  git_root="$(git -C "$candidate" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$candidate")"
  CAPTURED_PROVENANCE_GIT_HEAD="$(git -C "$git_root" rev-parse HEAD 2>/dev/null || echo unknown)"
  CAPTURED_PROVENANCE_GIT_DIRTY=true
  if status_output="$(git -C "$git_root" status --porcelain=v1 --untracked-files=all 2>/dev/null)" \
     && [[ -z "$status_output" ]] \
     && ! provenance_submodule_worktree_dirty "$git_root"; then
    CAPTURED_PROVENANCE_GIT_DIRTY=false
  fi
}

# Write a content-addressed snapshot of every dirty path in one or more git
# repositories. Node is already a build prerequisite on every host that runs
# this emitter; using it here keeps NUL-delimited porcelain parsing, JSON string
# escaping, symlinks, and filenames with whitespace exact on both GNU/Linux and
# macOS (whose /bin/bash is still 3.2).
#
# Arguments after OUT are LABEL=GIT_ROOT. Labels, never absolute host paths, are
# written into the shipping manifest so local checkout locations do not leak.
capture_dirty_source_manifest() {
  local out="${1:?manifest output required}"
  shift
  [[ $# -gt 0 ]] || { echo "dirty-source capture requires at least one LABEL=GIT_ROOT" >&2; return 2; }
  command -v node >/dev/null 2>&1 || {
    echo "node is required to capture content-addressed dirty-source provenance" >&2
    return 2
  }
  node - "$out" "$@" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [out, ...specs] = process.argv.slice(2);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function git(root, args, encoding = 'buffer') {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : String(result.stderr || '');
    throw new Error(`git ${args.join(' ')} failed in ${root}: ${stderr.trim()}`);
  }
  return result.stdout;
}

function snapshotRepository(label, candidate, seen = new Set()) {
  const root = fs.realpathSync(candidate);
  if (seen.has(root)) throw new Error(`recursive repository provenance at ${root}`);
  const nextSeen = new Set(seen).add(root);
  const head = String(git(root, ['rev-parse', 'HEAD'], 'utf8')).trim() || 'unknown';
  const raw = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const fields = raw.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const files = [];

  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error(`malformed porcelain-v1 record in ${label}: ${JSON.stringify(record)}`);
    }
    const status = record.slice(0, 2);
    const relativePath = record.slice(3);
    let oldPath;
    // In porcelain v1 -z mode, rename/copy destinations precede their source
    // path and the two names are separated by NUL rather than " -> ".
    if (/[RC]/.test(status)) {
      i += 1;
      if (i >= fields.length) throw new Error(`rename/copy record lacks old path: ${relativePath}`);
      oldPath = fields[i];
    }

    const absolutePath = path.resolve(root, relativePath);
    const relativeCheck = path.relative(root, absolutePath);
    if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
      throw new Error(`dirty path escapes repository: ${relativePath}`);
    }

    const row = {
      status,
      path: relativePath,
      sha256: null,
      kind: 'missing',
      mtimeEpochSec: null,
      mtimeUtc: null,
    };
    if (oldPath !== undefined) row.oldPath = oldPath;
    try {
      const stat = fs.lstatSync(absolutePath);
      row.mtimeEpochSec = Math.floor(stat.mtimeMs / 1000);
      row.mtimeUtc = new Date(row.mtimeEpochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      if (stat.isSymbolicLink()) {
        row.kind = 'symlink';
        row.sha256 = sha256(Buffer.from(fs.readlinkSync(absolutePath)));
      } else if (stat.isFile()) {
        row.kind = 'file';
        row.sha256 = sha256(fs.readFileSync(absolutePath));
      } else if (stat.isDirectory()) {
        // A dirty submodule is one porcelain row. Hash its own content-addressed
        // snapshot rather than merely its HEAD, which would miss worktree edits.
        try {
          const nested = snapshotRepository('nested', absolutePath, nextSeen);
          row.kind = 'git-repository';
          row.sha256 = sha256(Buffer.from(JSON.stringify({
            gitHead: nested.gitHead,
            files: nested.files,
          })));
        } catch {
          row.kind = 'directory';
        }
      } else {
        row.kind = 'other';
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
    }
    files.push(row);
  }

  files.sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
  return { label, gitHead: head, files };
}

const repositories = specs.map((spec) => {
  const split = spec.indexOf('=');
  if (split <= 0 || split === spec.length - 1) {
    throw new Error(`repository spec must be LABEL=GIT_ROOT, got ${spec}`);
  }
  const label = spec.slice(0, split);
  const root = spec.slice(split + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error(`unsafe repository label: ${label}`);
  return snapshotRepository(label, root);
});

const manifest = {
  schemaVersion: 1,
  capturedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  status: 'captured',
  repositories,
};
const temporary = `${out}.tmp.${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
fs.renameSync(temporary, out);
NODE
}

if [[ "${1:-}" == "--capture-source" ]]; then
  [[ $# -eq 2 || $# -eq 3 ]] \
    || { echo "usage: $0 --capture-source GIT_ROOT [DIRTY_MANIFEST_OUT]" >&2; exit 2; }
  capture_provenance_source "$2"
  if [[ $# -eq 3 ]]; then
    capture_dirty_source_manifest "$3" "primary=$2"
  fi
  printf '%s\n%s\n' "$CAPTURED_PROVENANCE_GIT_HEAD" "$CAPTURED_PROVENANCE_GIT_DIRTY"
  exit 0
fi

if [[ "${1:-}" == "--capture-dirty-source" ]]; then
  [[ $# -ge 3 ]] \
    || { echo "usage: $0 --capture-dirty-source OUT LABEL=GIT_ROOT..." >&2; exit 2; }
  _dirty_out="$2"
  shift 2
  capture_dirty_source_manifest "$_dirty_out" "$@"
  exit 0
fi

if [[ $# -lt 4 ]]; then
  echo "usage: $0 OUT_DIR VERSION BUILD_SHA REUSED ARTIFACT..." >&2
  exit 2
fi
OUT_DIR="$1"; VERSION="$2"; BUILD_SHA="$3"; REUSED="$4"; shift 4
[[ "$REUSED" == "true" || "$REUSED" == "false" ]] || { echo "REUSED must be true|false, got '$REUSED'" >&2; exit 2; }
[[ -d "$OUT_DIR" ]] || { echo "OUT_DIR '$OUT_DIR' is not a directory" >&2; exit 2; }

GIT_ROOT="${PROVENANCE_GIT_ROOT:-$PWD}"
GIT_ROOT="$(git -C "$GIT_ROOT" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$GIT_ROOT")"
capture_provenance_source "$GIT_ROOT"
GIT_HEAD_AT_EMIT="$CAPTURED_PROVENANCE_GIT_HEAD"
GIT_DIRTY_AT_EMIT="$CAPTURED_PROVENANCE_GIT_DIRTY"

# The orchestrator is the only layer that can observe the release INPUT before
# it performs its own version/staging mutations. Direct emitter callers omit
# these seams and retain the conservative emit-time behavior. Values are
# validated rather than truthy-coerced so a typo cannot manufacture clean
# provenance.
GIT_HEAD="${PROVENANCE_SOURCE_GIT_HEAD:-$GIT_HEAD_AT_EMIT}"
GIT_DIRTY="${PROVENANCE_SOURCE_GIT_DIRTY:-$GIT_DIRTY_AT_EMIT}"
[[ "$GIT_HEAD" == "unknown" || "$GIT_HEAD" =~ ^[0-9a-fA-F]{7,64}$ ]] \
  || { echo "PROVENANCE_SOURCE_GIT_HEAD must be a git object id or 'unknown', got '$GIT_HEAD'" >&2; exit 2; }
[[ "$GIT_DIRTY" == "true" || "$GIT_DIRTY" == "false" ]] \
  || { echo "PROVENANCE_SOURCE_GIT_DIRTY must be true|false, got '$GIT_DIRTY'" >&2; exit 2; }

# Portable file size: GNU stat (-c, the Linux dev box) then BSD stat (-f).
_bytes() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }

# The artifact's own filesystem time is the relevant clock for containment.
# `builtAtUtc` below is the MANIFEST/run finish and can be later than an artifact
# whose compilation finished earlier. Keep the source epoch too, so consumers do
# not have to parse an ISO timestamp when making an exact comparison.
_mtime_epoch() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
_mtime_utc() {
  local epoch
  epoch="$(_mtime_epoch "$1")"
  date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -r "$epoch" +%Y-%m-%dT%H:%M:%SZ
}

# WI-37746 (closes the WI-37738 stranding class): the release host BAKED INTO
# THESE BINARIES, recorded as a SHA-256 FINGERPRINT — never the URL itself.
#
# WHY A FINGERPRINT AND NOT THE URL: this file ships NEXT TO the artifacts (and
# the release identity gate scans what ships), and the URL's path segment is the
# unguessable secret that keeps the bucket unlisted (D-002/D-003). A fingerprint
# still answers the only question publish time asks — "were these bytes built
# for the prefix we are about to upload to?" — while carrying nothing secret.
#
# WHY IT IS NEEDED AT ALL, given upload-release.sh already greps the artifacts:
# that check greps for the CURRENT host, so an artifact baked to a DIFFERENT
# HOST matches nothing, is skipped rather than counted, and lands in the "could
# not read a baked host" branch — a WARNING THAT SHIPS. Measured 2026-08-11 on
# fixtures: same-host/wrong-prefix BLOCKS correctly, a wholly different baked
# host WARNS AND SHIPS. Compressed artifacts (.tar.gz/.dmg) reach that same
# warning path for an unrelated reason. The bytes therefore cannot be the
# evidence; the BUILD is the only place the baked value is known for certain.
#
# `null` = no host was baked into this build. A MISSING key = emitted by a
# pre-WI-37746 build — a distinction upload-release.sh relies on.
_release_host_fp() {
  local h="${PAPERCUSP_RELEASE_HOST:-}"
  h="${h%/}"   # normalize: a trailing slash must not change the fingerprint
  if [[ -z "$h" ]]; then printf 'null'; return; fi
  printf '"%s"' "$(printf '%s' "$h" | sha256sum | cut -d' ' -f1)"
}

# EI-20086238555902880: WHICH SIDECAR IS PACKED INTO THESE BYTES.
#
# THE GAP THIS CLOSES: a desktop build compiles FRESH Rust but reuses whatever
# prebuilt sidecar bundle happens to be on disk — rebuilding it is a separate manual
# step. So the two halves of a shipped app can be hours apart in provenance, and the
# fields above describe only the Rust/orchestrator half. Measured on the 0.0.14
# Windows cut: installer built 15:45:18Z from gitHead c5d848155a, while its packed
# serve.mjs was baked 03:09:18Z — twelve and a half hours older — and a fix committed
# at 15:38:38Z was simply absent from the shipped payload.
#
# Why that is dangerous beyond the one missing fix: gitHead + gitDirty READ as a
# complete provenance claim, so a reviewer who checks this file — the right instinct,
# and exactly what the reporter did — concludes the artifact carries everything at that
# commit. TRUE of the Rust layer, FALSE of the sidecar, and nothing on the artifact
# surfaced the difference.
#
# THIS IS DELIBERATELY INFORMATION, NOT A BLOCKING STALENESS RULE. A
# "sidecar older than sources" assertion was already considered and REJECTED in writing
# in bin/lib/sidecar-freshness.js: one shared checkout, HEAD moving every few minutes,
# so such a rule fires on nearly every build for every agent and trains the bypass.
# Recording the fact has no false-positive rate; judging it has a large one. Anyone
# who needs a BLOCKING check still has the caller-declared
# PAPERCUSP_REQUIRE_SIDECAR_CONTAINS=<sha> assertion, which cannot cry wolf.
#
# Resolved HERE rather than at each call site on purpose: four legs hand-assembling
# the same record is how two lists drift apart (see the GLFALLBACK_SONAMES fix in
# build-appimage.sh for the same lesson). A leg names the directory; the shape lives once.
#
# `null` = the leg named no sidecar. `{"status":"absent"}` = it named one that carries
# no provenance file — which sidecar-freshness.js treats as UNDECIDABLE, never a pass,
# so the two must stay distinguishable here too. A MISSING key = a pre-EI-20086238555902880 emitter.
_sidecar_provenance() {
  local d="${PROVENANCE_SIDECAR_DIR:-}"
  if [[ -z "$d" ]]; then printf 'null'; return; fi
  local p="$d/build-provenance.json"
  if [[ ! -f "$p" ]]; then printf '{ "status": "absent" }'; return; fi
  # Parsed with sed, not python3/jq: this emitter also runs on the mac VM, whose
  # /bin/bash is 3.2 and whose interpreter set is not ours to assume. The input is
  # THIS script's own output format, so the shape is guaranteed, not hoped for.
  local _head _built _sha
  _head="$(sed -n 's/.*"gitHead"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$p" | head -1)"
  _built="$(sed -n 's/.*"builtAtUtc"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$p" | head -1)"
  # serve.mjs's own sha256 is the CONTENT identity of the packed half — the one field
  # that answers "are these the bytes I think they are" without trusting a timestamp.
  _sha="$(grep '"name": "serve.mjs"' "$p" | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  printf '{ "gitHead": "%s", "builtAtUtc": "%s", "serveMjsSha256": "%s" }' \
    "${_head:-unknown}" "${_built:-unknown}" "${_sha:-unknown}"
}

# Artifact name: relative to OUT_DIR when under it, else basename (see header).
_OUT_REAL="$(realpath "$OUT_DIR")"
_name() {
  local rp; rp="$(realpath "$1")"
  if [[ "$rp" == "$_OUT_REAL"/* ]]; then printf '%s' "${rp#"$_OUT_REAL"/}"; else basename "$1"; fi
}

PROV="$OUT_DIR/build-provenance.json"

# A metadata-only recovery must not silently relabel bytes that already have an
# attestation. That is how the 0.0.18 Windows recovery replaced the cutter's
# baked short SHA (2363b77a) with the full source commit: both values named the
# same commit, but only one was compiled into /api/health. Detect the strong
# case we can prove locally — the existing record names the exact same complete
# artifact set by path, byte count, and sha256 — and make identity changes an
# explicit compare-and-swap operation. A genuinely fresh build has different
# artifact bytes and remains free to replace an older record without a flag.
_existing_artifact_rows() {
  # Parse both this emitter's compact artifact lines and a jq-pretty-printed
  # record. The latter is the exact 0.0.18 recovery shape that exposed this
  # bug. Keep this POSIX-awk-only: the emitter also runs on the mac builder.
  awk '
    function string_field(line, key, value) {
      value = line
      sub("^.*\\\"" key "\\\"[[:space:]]*:[[:space:]]*\\\"", "", value)
      sub("\\\".*$", "", value)
      return value
    }
    function number_field(line, key, value) {
      value = line
      sub("^.*\\\"" key "\\\"[[:space:]]*:[[:space:]]*", "", value)
      sub("[^0-9].*$", "", value)
      return value
    }
    /"name"[[:space:]]*:/ { name = string_field($0, "name") }
    /"bytes"[[:space:]]*:/ { bytes = number_field($0, "bytes") }
    /"sha256"[[:space:]]*:/ { sha = string_field($0, "sha256") }
    /"sig"[[:space:]]*:/ {
      if (name != "" && bytes != "" && sha != "") print name "\t" bytes "\t" sha
      name = bytes = sha = ""
    }
  ' "$1"
}

_existing_artifacts_match() {
  [[ -f "$PROV" ]] || return 1
  local current_rows existing_rows f
  current_rows="$({
    for f in "$@"; do
      [[ -e "$f" ]] || continue
      printf '%s\t%s\t%s\n' \
        "$(_name "$f")" "$(_bytes "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"
    done
  } | LC_ALL=C sort)"
  existing_rows="$(_existing_artifact_rows "$PROV" | LC_ALL=C sort)"
  [[ -n "$current_rows" && "$existing_rows" == "$current_rows" ]]
}

_identity_only_repair=0
_existing_artifacts_same=0
if _existing_artifacts_match "$@"; then
  _existing_artifacts_same=1
  _existing_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PROV" | head -1)"
  _existing_build_sha="$(sed -n 's/.*"buildSha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PROV" | head -1)"
  [[ -n "$_existing_version" && -n "$_existing_build_sha" ]] || {
    echo "ERROR: existing $PROV matches the current artifact bytes but lacks version/buildSha; refusing to replace an unreadable baked identity" >&2
    exit 1
  }
  if [[ "$_existing_version" != "$VERSION" ]]; then
    [[ "${PROVENANCE_REPLACE_VERSION_FROM:-}" == "$_existing_version" ]] || {
      echo "ERROR: existing $PROV attests these exact artifact bytes as version $_existing_version; refusing to rewrite their baked version as $VERSION" >&2
      echo "       For a verified metadata repair, set PROVENANCE_REPLACE_VERSION_FROM=$_existing_version (compare-and-swap)." >&2
      exit 1
    }
    _identity_only_repair=1
  fi
  if [[ "$_existing_build_sha" != "$BUILD_SHA" ]]; then
    [[ "${PROVENANCE_REPLACE_BUILD_SHA_FROM:-}" == "$_existing_build_sha" ]] || {
      echo "ERROR: existing $PROV attests these exact artifact bytes as buildSha $_existing_build_sha; refusing to rewrite their baked identity as $BUILD_SHA" >&2
      echo "       Source-commit equivalence is insufficient: /api/health reports the exact compiled string." >&2
      echo "       For a verified metadata repair, set PROVENANCE_REPLACE_BUILD_SHA_FROM=$_existing_build_sha (compare-and-swap)." >&2
      exit 1
    }
    _identity_only_repair=1
  fi
fi

# Resolve the content-addressed source snapshot only after the identity-repair
# early return above: a metadata CAS repair must preserve the original record
# byte-for-byte except for its explicitly authorized identity field.
_dirty_source_tmp=""
_dirty_source_manifest="${PROVENANCE_SOURCE_DIRTY_MANIFEST:-}"
if [[ "$REUSED" == "true" && "$_existing_artifacts_same" == "1" ]]; then
  # Reused bytes belong to the prior build, never today's checkout. Preserve the
  # prior manifest when one exists; otherwise say unavailable rather than stamp
  # current-source hashes onto bytes they did not produce.
  _dirty_source_tmp="$(mktemp "${TMPDIR:-/tmp}/papercusp-dirty-source-reuse.XXXXXX")"
  if node - "$PROV" "$_dirty_source_tmp" <<'NODE'
const fs = require('node:fs');
const [input, output] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(input, 'utf8')).dirtySource;
if (!value || typeof value !== 'object' || Array.isArray(value)) process.exit(3);
fs.writeFileSync(output, `${JSON.stringify(value)}\n`);
NODE
  then
    _dirty_source_manifest="$_dirty_source_tmp"
  else
    printf '%s\n' '{"schemaVersion":1,"capturedAtUtc":null,"status":"unavailable","reason":"reused-provenance-had-no-dirty-source","repositories":[]}' >"$_dirty_source_tmp"
    _dirty_source_manifest="$_dirty_source_tmp"
  fi
elif [[ -z "$_dirty_source_manifest" && -z "${PROVENANCE_SOURCE_GIT_HEAD+x}" ]]; then
  # A direct emitter call has no earlier phase boundary. Capture honestly at
  # emit time and label that clock; canonical producers pass a cut-start file.
  _dirty_source_tmp="$(mktemp "${TMPDIR:-/tmp}/papercusp-dirty-source-emit.XXXXXX")"
  capture_dirty_source_manifest "$_dirty_source_tmp" "primary=$GIT_ROOT"
  _dirty_source_manifest="$_dirty_source_tmp"
elif [[ -z "$_dirty_source_manifest" ]]; then
  _dirty_source_tmp="$(mktemp "${TMPDIR:-/tmp}/papercusp-dirty-source-unavailable.XXXXXX")"
  printf '%s\n' '{"schemaVersion":1,"capturedAtUtc":null,"status":"unavailable","reason":"build-start-manifest-not-supplied","repositories":[]}' >"$_dirty_source_tmp"
  _dirty_source_manifest="$_dirty_source_tmp"
fi

[[ -r "$_dirty_source_manifest" ]] \
  || { echo "ERROR: dirty-source manifest is unreadable: $_dirty_source_manifest" >&2; exit 2; }
DIRTY_SOURCE_JSON="$(node - "$_dirty_source_manifest" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!value || typeof value !== 'object' || Array.isArray(value)) {
  throw new Error('dirty-source manifest must be a JSON object');
}
process.stdout.write(JSON.stringify(value));
NODE
)" || { echo "ERROR: invalid dirty-source manifest: $_dirty_source_manifest" >&2; exit 2; }

SOURCE_REPAIR_JSON=""
if [[ -n "${PROVENANCE_SOURCE_REPAIR_MANIFEST:-}" ]]; then
  SOURCE_REPAIR_JSON="$(node "$(dirname "${BASH_SOURCE[0]}")/lib/windows-source-repair.js" \
    attestation "$PROVENANCE_SOURCE_REPAIR_MANIFEST" "$GIT_ROOT" "$BUILD_SHA" "$GIT_HEAD" \
    "${PROVENANCE_SOURCE_REPAIR_ROLES:-}" "$VERSION")" \
    || { echo "ERROR: source repair does not describe the native source" >&2; exit 2; }
  # A base+patch is never attested as a clean original commit, even if a caller
  # inherited a clean-source override from its original all-platform cut.
  GIT_DIRTY=true
fi

# A compare-and-swap repair is intentionally NOT a re-emit. The existing record
# describes when/where the bytes were built; recomputing gitHeadAtEmit,
# gitDirtyAtEmit, builtAtUtc, host, or sidecar state now would replace history
# with the repair machine's state. Change only the explicitly authorized baked
# identity fields and preserve every other byte of the attestation.
if [[ "$_identity_only_repair" == "1" ]]; then
  [[ "$VERSION" =~ ^[A-Za-z0-9._+-]+$ && "$BUILD_SHA" =~ ^[A-Za-z0-9._+-]+$ ]] || {
    echo "ERROR: compare-and-swap identity repairs accept only safe version/buildSha characters" >&2
    exit 2
  }
  _repair_tmp="$PROV.repair.$$"
  trap 'rm -f "$_repair_tmp"' EXIT
  awk \
    -v replace_version="$([[ "$_existing_version" != "$VERSION" ]] && echo 1 || echo 0)" \
    -v replace_sha="$([[ "$_existing_build_sha" != "$BUILD_SHA" ]] && echo 1 || echo 0)" \
    -v new_version="$VERSION" \
    -v new_sha="$BUILD_SHA" '
      replace_version && /^[[:space:]]*"version"[[:space:]]*:/ {
        sub(/:[[:space:]]*"[^"]*"/, ": \"" new_version "\"")
        version_changes++
      }
      replace_sha && /^[[:space:]]*"buildSha"[[:space:]]*:/ {
        sub(/:[[:space:]]*"[^"]*"/, ": \"" new_sha "\"")
        sha_changes++
      }
      { print }
      END {
        if ((replace_version && version_changes != 1) || (replace_sha && sha_changes != 1)) exit 3
      }
    ' "$PROV" >"$_repair_tmp" \
    || { echo "ERROR: could not apply the identity compare-and-swap to $PROV" >&2; exit 1; }
  mv "$_repair_tmp" "$PROV"
  trap - EXIT
  echo "==> build provenance identity repaired in place: $PROV"
  cat "$PROV"
  exit 0
fi

# Publish through a fresh inode in the destination directory. Acceptance and
# release workflows deliberately hard-link large sidecar trees into private
# snapshots (`cp -al`) so they can replace one artifact without copying several
# GiB. Writing straight to `$PROV` would mutate every hard-linked peer's
# manifest in place, leaving the peer's old artifacts paired with our new
# hashes. A same-directory rename is atomic for readers and breaks that inode
# alias before the new record becomes visible.
_prov_tmp="$PROV.tmp.$$.$RANDOM"
[[ ! -e "$_prov_tmp" ]] \
  || { echo "ERROR: provenance staging path already exists: $_prov_tmp" >&2; exit 1; }
trap 'rm -f "$_prov_tmp"; [[ -z "$_dirty_source_tmp" ]] || rm -f "$_dirty_source_tmp"' EXIT
{
  printf '{\n'
  printf '  "version": "%s",\n'   "$VERSION"
  printf '  "buildSha": "%s",\n'  "$BUILD_SHA"
  printf '  "reused": %s,\n'      "$REUSED"
  printf '  "gitHead": "%s",\n'   "$GIT_HEAD"
  printf '  "gitDirty": %s,\n'    "$GIT_DIRTY"
  printf '  "dirtySource": %s,\n' "$DIRTY_SOURCE_JSON"
  if [[ -n "$SOURCE_REPAIR_JSON" ]]; then
    printf '  "sourceRepair": %s,\n' "$SOURCE_REPAIR_JSON"
  fi
  printf '  "gitHeadAtEmit": "%s",\n' "$GIT_HEAD_AT_EMIT"
  printf '  "gitDirtyAtEmit": %s,\n' "$GIT_DIRTY_AT_EMIT"
  # Optional leg-specific fields (P-002 consolidation) — emitted only when the
  # caller sets the env seam, so mac/linux output is byte-unchanged. The Windows
  # leg passes both: packedSrcFingerprint (a hash of the exact tree it packed to
  # the VM — its strongest anti-LABELED!=PACKED signal) and signed (Authenticode).
  if [[ -n "${PROVENANCE_PACKED_SRC_FINGERPRINT:-}" ]]; then
    printf '  "packedSrcFingerprint": "%s",\n' "$PROVENANCE_PACKED_SRC_FINGERPRINT"
  fi
  if [[ -n "${PROVENANCE_SIGNED:-}" ]]; then
    printf '  "signed": %s,\n' "$PROVENANCE_SIGNED"
  fi
  # P-014 (repro hygiene): the exact build toolchain, pre-formatted JSON. Populated
  # by a leg whose emitter runs ON the build machine (Linux: host == builder). The
  # mac/win legs build on a VM, so their host-side emit leaves this unset rather
  # than record a misleading HOST toolchain — VM-side capture is a followup.
  if [[ -n "${PROVENANCE_TOOLCHAIN:-}" ]]; then
    printf '  "toolchain": %s,\n' "$PROVENANCE_TOOLCHAIN"
  fi
  # WI-37746: always present (null when no host was baked), so a MISSING key
  # unambiguously means "a pre-WI-37746 emitter produced this" rather than
  # "nothing was baked" — upload-release.sh treats those two cases differently.
  printf '  "releaseHostSha256": %s,\n' "$(_release_host_fp)"
  # EI-20086238555902880: always present (null when the leg named no sidecar), so a
  # MISSING key means "a pre-EI-20086238555902880 emitter wrote this" rather than
  # "nothing was packed" — the same present-vs-missing distinction releaseHostSha256
  # relies on, and the reason neither is emitted only when non-empty.
  printf '  "sidecar": %s,\n' "$(_sidecar_provenance)"
  printf '  "builtAtUtc": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "artifacts": [\n'
  _first=1
  for f in "$@"; do
    [[ -e "$f" ]] || continue
    (( _first )) || printf ',\n'; _first=0
    printf '    { "name": "%s", "bytes": %s, "sha256": "%s", "sig": %s, "mtimeEpochSec": %s, "mtimeUtc": "%s", "completedAtUtc": "%s" }' \
      "$(_name "$f")" "$(_bytes "$f")" "$(sha256sum "$f" | cut -d' ' -f1)" \
      "$([[ -f "$f.sig" ]] && echo true || echo false)" "$(_mtime_epoch "$f")" "$(_mtime_utc "$f")" "$(_mtime_utc "$f")"
  done
  printf '\n  ]\n}\n'
} > "$_prov_tmp"
mv "$_prov_tmp" "$PROV"
[[ -z "$_dirty_source_tmp" ]] || rm -f "$_dirty_source_tmp"
trap - EXIT
echo "==> build provenance written: $PROV"
cat "$PROV"
