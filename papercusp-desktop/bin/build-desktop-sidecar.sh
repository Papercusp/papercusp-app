#!/usr/bin/env bash
# Build the Node sidecar that the Papercusp desktop app bundles.
#
# Strategy (post operator-vite migration, Phase F3/G4; entry swapped to
# `serve` by SP1 C5): the operator UI is the Vite SPA (apps/operator-vite),
# and the SPA + /api/* + /internal/docs/* are served by a single-process Hono
# host. The boot entry is `apps/operator/bin/serve.ts` — the headless
# operator orchestrator that ALSO owns embedded Postgres (start, migrations,
# ~/.papercusp/embedded-pg.json) and writes ~/.papercusp/operator.json
# discovery. This script `vite build`s the SPA and esbuild-bundles serve into
# papercusp-desktop/src-tauri/sidecar/, which Tauri's bundler picks up as a
# resource (declared in tauri.conf.json `resources`). Tauri main.rs spawns
# `node sidecar/serve.mjs --ensure`.
#
# The bundled sidecar is self-contained: serve.mjs has every inlinable module
# bundled in; only genuinely-native deps (node-pty, the holepunch stack) and
# the embedded-postgres-server package (PG binaries resolve off its real
# package dir) ship as node_modules.

set -euo pipefail

# Multi-repo layout (post phase-c split). The desktop bundle pulls from
# two sibling clones:
#
#   Papercusp/papercusp-desktop   ← this repo (HERE = bin/)
#   Papercusp/papercup            ← contains apps/operator (Next.js UI)
#                                    AND libs/papercusp/ (submodule with
#                                    embedded-postgres-server, zero-cache-server,
#                                    harness, papercusp-mcp-server,
#                                    cli, orchestrator). The submodule is the
#                                    canonical post-phase-c location for these
#                                    packages — the old sibling-repo
#                                    Papercusp/papercusp clone is no longer
#                                    used by this script.
#
# Override locations with REPO_ROOT / PAPERCUSP_ROOT if your layout
# differs (e.g. CI clones into a flat workspace dir).

HERE="$(cd "$(dirname "$0")" && pwd)"
# An exact-source cut runs this CURRENT producer while writing into the FROZEN
# desktop target. Helpers follow HERE; product inputs and outputs follow ROOT.
# Refuse a missing override rather than accidentally building the live checkout.
ROOT="$(cd "${PAPERCUSP_DESKTOP_TARGET_ROOT:-$HERE/..}" && pwd)"
# EI-21832562420831737: ONE repo root, resolved ONCE, honoured everywhere. This used to be
# a plain `${REPO_ROOT:-$ROOT/..}` while a SECOND, independent `REPO="$(cd "$ROOT/.." &&
# pwd)"` ~4,300 lines below silently ignored the override — so the documented
# `REPO_ROOT=<pinned> build-desktop-sidecar.sh` (the whole point of a pinned-source
# release cut) built its JavaScript from the pinned tree and its Rust from the live one,
# with nothing to notice. See lib/source-roots.sh for why that shape is worse than a
# crash, and keep `REPO` below assigned FROM this value rather than re-derived.
# Sourcing here is safe before the identity check: the helper defines a function and
# touches nothing but the candidate directory, and it never exits the caller.
# shellcheck source=lib/source-roots.sh
source "$HERE/lib/source-roots.sh"
# Same contract, one layer out: source-roots.sh answers "which tree do we read SOURCE from",
# pinned-deps.sh answers "and whose node_modules are we reading". Sourcing is likewise safe
# before the identity check — it only defines functions, and its script dispatcher is guarded
# on BASH_SOURCE so being sourced never runs anything.
# shellcheck source=lib/pinned-deps.sh
source "$HERE/lib/pinned-deps.sh"
# Same contract again: transformers-models.sh only defines functions and guards its own
# dispatcher on BASH_SOURCE, so sourcing it here runs nothing. It owns the step that gives a
# pristine-clone build the runtime-downloaded ONNX weights `npm ci` never fetches
# (EI-22077502575226404); it is inert unless PAPERCUSP_TRANSFORMERS_MODEL_CACHE is set.
# shellcheck source=lib/transformers-models.sh
source "$HERE/lib/transformers-models.sh"
REPO_ROOT="$(papercusp_repo_root "$ROOT")"
PAPERCUSP_ROOT="${PAPERCUSP_ROOT:-$REPO_ROOT/libs/papercusp}"
WEB_DIR="$REPO_ROOT/apps/operator"

# EI-20971912793028056: the final assembled-sidecar identity audit deliberately
# refuses to certify unless the owner's NAME is asserted at run time. Git cannot
# supply it: release builders use automation identities, and accepting those would
# turn a clean verdict into false evidence. This used to fail only after the entire
# sidecar had been assembled. Mirror audit-release-bundle.py's exact non-empty rule
# here (comma/semicolon-separated values, surrounding whitespace ignored) so a
# release-audited build fails before the first toolchain or dependency operation.
# Keep the value runtime-only — writing it into tracked source would create the
# identity leak this gate exists to prevent.
#
# ORDERING (must stay above the source-provenance capture below): this is a pure
# environment check with no I/O, while the capture shells out to git through
# REPO_ROOT and FAILS CLOSED to gitDirty=true when that root is absent or
# unreadable. Sitting after it, the clean-source-tree guard exited 1 on a missing
# REPO_ROOT before this rejection could ever be reached — contradicting the
# "fails before the first toolchain or dependency operation" contract above and
# breaking `rejects a missing owner name before toolchain work`, which asserts
# exit 2. A missing owner name is knowable from the environment alone, so it is
# decided here, before anything touches the filesystem.
_release_owner_name="${PAPERCUSP_RELEASE_OWNER_NAME:-}"
if [[ "${PAPERCUSP_RELEASE_AUDIT:-0}" == "1" \
   && -z "${_release_owner_name//[[:space:],;]/}" ]]; then
  echo "ERROR: PAPERCUSP_RELEASE_AUDIT=1 requires a non-empty PAPERCUSP_RELEASE_OWNER_NAME before building." >&2
  echo "       Export it at run time (never write it into a tracked file), then re-run." >&2
  echo "       Refusing now because the final identity audit cannot certify without it." >&2
  exit 2
elif [[ "${PAPERCUSP_RELEASE_AUDIT:-0}" != "1" ]]; then
  # EI-22084619262074810: this fail-late gap cost a full ~35min sidecar bake before
  # build-mac-cross.sh's downstream [sidecar-freshness:darwin] gate discovered the
  # missing attestation (build-mac-cross.sh:sidecar-freshness.js:release-audit-unattested).
  # Say so loudly, now, before any expensive work starts. NON-BLOCKING on purpose: an
  # unaudited dev/dogfood sidecar remains the correct default for ordinary local builds.
  echo "NOTE: building WITHOUT a release identity audit (PAPERCUSP_RELEASE_AUDIT is not 1)." >&2
  echo "      This sidecar will be REFUSED by build-mac-cross.sh's sidecar-freshness gate" >&2
  echo "      and by release cuts, which both require a releaseIdentityAudit attestation." >&2
  echo "      If this build feeds a cross-build or release cut, stop now and re-run with:" >&2
  echo "        PAPERCUSP_RELEASE_AUDIT=1 PAPERCUSP_RELEASE_OWNER_NAME=<name>" >&2
  echo "      (canonical supply: source ~/.papercusp/release-identity.env, set -a, at runtime)." >&2
fi
unset _release_owner_name

# D-043 / P-052: dogfood remains the historical source-rich developer bundle.
# vm-release is a separate fail-closed build profile whose final sidecar is
# pruned and audited below. Validate the profile before source capture so a
# misspelled knob or missing vm-release artifact identity cannot be masked by a
# missing/unreadable repo path.
# shellcheck source=lib/distribution-profile.sh
. "$HERE/lib/distribution-profile.sh"
DISTRIBUTION_PROFILE="${PAPERCUSP_DISTRIBUTION_PROFILE:-$(default_distribution_profile "$ROOT")}"
export PAPERCUSP_DISTRIBUTION_PROFILE="$DISTRIBUTION_PROFILE"
case "$DISTRIBUTION_PROFILE" in
  dogfood|public|vm-release) ;;
  *)
    echo "ERROR: PAPERCUSP_DISTRIBUTION_PROFILE must be dogfood, public or vm-release (got '$DISTRIBUTION_PROFILE')" >&2
    exit 2
    ;;
esac

# WI-41712 / WI-2024456: build-linux-local.sh supplies these two values, but
# this producer is also a supported direct entrypoint. A direct vm-release build
# once spent nearly two hours assembling the sidecar before the prune gate
# discovered both values were absent. Mirror audit-release-bundle.py's exact
# non-empty/known contract here, before source capture, toolchain, or dependency
# work, while retaining the final audit as the artifact-bound backstop.
_vm_release_build_sha="${PAPERCUSP_BUILD_SHA:-}"
_vm_release_desktop_version="${PAPERCUSP_DESKTOP_VERSION:-}"
if [[ "$DISTRIBUTION_PROFILE" == "vm-release" \
   && ( -z "${_vm_release_build_sha//[[:space:]]/}" \
     || -z "${_vm_release_desktop_version//[[:space:]]/}" \
     || "$_vm_release_desktop_version" =~ ^[[:space:]]*[Uu][Nn][Kk][Nn][Oo][Ww][Nn][[:space:]]*$ ) ]]; then
  echo "ERROR: PAPERCUSP_DISTRIBUTION_PROFILE=vm-release requires non-empty PAPERCUSP_BUILD_SHA and PAPERCUSP_DESKTOP_VERSION before building." >&2
  echo "       Pass the immutable source SHA and desktop version explicitly; refusing before toolchain work." >&2
  exit 2
fi

# Direct sidecar builds are release producers too. Preserve the source state at
# entry, before dependency generations/npm installs mutate tracked build state;
# emit-build-provenance.sh records the later checkout separately as *AtEmit.
# A release orchestrator that already captured the phase boundary supplies both
# seams, and remains authoritative.
if [[ "${PROVENANCE_SOURCE_GIT_HEAD+x}" != "${PROVENANCE_SOURCE_GIT_DIRTY+x}" ]]; then
  echo "ERROR: PROVENANCE_SOURCE_GIT_HEAD and PROVENANCE_SOURCE_GIT_DIRTY must be supplied together" >&2
  exit 2
fi
_OWN_PROVENANCE_SOURCE_DIRTY_MANIFEST=""
if [[ -z "${PROVENANCE_SOURCE_GIT_HEAD+x}" && -x "$HERE/emit-build-provenance.sh" ]]; then
  _OWN_PROVENANCE_SOURCE_DIRTY_MANIFEST="$(mktemp "${TMPDIR:-/tmp}/papercusp-sidecar-dirty-source.XXXXXX")"
  export PROVENANCE_SOURCE_DIRTY_MANIFEST="$_OWN_PROVENANCE_SOURCE_DIRTY_MANIFEST"
  _provenance_source_output="$(
    bash "$HERE/emit-build-provenance.sh" --capture-source \
      "$REPO_ROOT" "$PROVENANCE_SOURCE_DIRTY_MANIFEST"
  )" || {
    echo "ERROR: could not capture sidecar source provenance before build mutations" >&2
    exit 2
  }
  # EI-21687905052970165: NOT `mapfile -t` — that is a bash 4.0+ builtin and
  # macOS ships /bin/bash 3.2.57 system-wide, so it fails ~an hour into a mac VM
  # build (the recurrence this file's sibling comments and
  # scripts/check-mac-bash-portability.mjs exist to prevent). The while-read
  # accumulation below is exactly equivalent for a here-string: `<<<` always
  # supplies a trailing newline, so both forms yield the same element count for
  # 2-line, 1-line, empty, trailing-blank and whitespace-bearing input.
  _provenance_source_fields=()
  while IFS= read -r _provenance_source_line; do
    _provenance_source_fields+=("$_provenance_source_line")
  done <<< "$_provenance_source_output"
  if [[ "${#_provenance_source_fields[@]}" -ne 2 \
     || -z "${_provenance_source_fields[0]}" \
     || ( "${_provenance_source_fields[1]}" != "true" \
       && "${_provenance_source_fields[1]}" != "false" ) ]]; then
    echo "ERROR: invalid source-provenance capture from emit-build-provenance.sh" >&2
    exit 2
  fi
  export PROVENANCE_SOURCE_GIT_HEAD="${_provenance_source_fields[0]}"
  export PROVENANCE_SOURCE_GIT_DIRTY="${_provenance_source_fields[1]}"
  unset _provenance_source_output _provenance_source_fields _provenance_source_line
fi

# Release-audited cuts must start from a clean source snapshot. The provenance
# verifier already rejects gitDirty=true after the expensive build, but doing
# the same check here fails before dependency/toolchain work and prevents a
# dirty or partially-synced tree from producing a release-shaped artifact.
if [[ "${PAPERCUSP_RELEASE_AUDIT:-0}" == "1" \
   && "${PROVENANCE_SOURCE_GIT_DIRTY:-true}" != "false" ]]; then
  echo "ERROR: release-audited sidecar requires a clean source tree at cut start (gitDirty=${PROVENANCE_SOURCE_GIT_DIRTY:-unset})." >&2
  echo "       Wait for the source tree to settle and retry; refusing to build mixed-provenance bytes." >&2
  exit 1
fi

# EI-21832562420831737: having DEMANDED an immutable source sha above, refuse to read a tree
# that holds anything else. Nothing did: the release audit, SBOM and vulnerability gates all
# inspect the FINISHED bundle, so a cut taken on the shared checkout baked peers' uncommitted
# bytes into the sidecar while its stamp claimed the pin — and every artifact-side gate
# passed, because the artifact agreed with itself.
#
# The verdict is the flag captured at the phase boundary above, NOT a fresh git call: that
# capture is the authoritative seam (a release orchestrator may supply it directly), it was
# taken before any build mutation, and re-measuring here would answer a different question a
# few lines later. `:-true` fails closed if it is somehow unset. See lib/source-roots.sh for
# why this refuses rather than warns, why it is satisfiable today (a tracked-clean pinned
# worktree passes; the shared tree does not — the intended split), and why it deliberately
# does NOT also require HEAD to equal the pin. Same placement contract as the gate above:
# before any toolchain or dependency work.
if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
  # EI-21904084277182116 / D-186: a release cut does not consume the dependency
  # generation, so producing one is pure cost — and until now the ONLY thing
  # switching it off was each orchestrator remembering to export this variable.
  # Nothing set it here and nothing warned when it was missing, so a cut that
  # forgot did not fail or degrade: it silently walked every manifest and copied
  # every tree, and emitted a byte-identical artifact. A cost regression invisible
  # in its own output is one only a bystander can detect, which is exactly how
  # this was found — on 2026-08-30 a cut of mine omitted the export, spent 6m54s
  # copying 86 trees (11.3 GB read / 15.9 GB written), and a peer watching host
  # PSI opened an urgent escalation about the IO.
  #
  # Setting it HERE makes skipping a property of BEING a release cut rather than
  # of the caller having read D-186. `:-1` keeps the escape hatch honest: an
  # orchestrator that genuinely wants a generation exports 0 deliberately.
  #
  # Scope note: D-186's text says "a PINNED release cut", while its measured
  # rationale — zero consumers anywhere in the release path — is broader. This
  # enforces at the vm-release profile, slightly wider than D-186's literal
  # words; that widening is recorded as its own Decision rather than folded in
  # silently. Read it there before narrowing this back.
  export PAPERCUSP_SKIP_DEP_GENERATION="${PAPERCUSP_SKIP_DEP_GENERATION:-1}"

  if ! papercusp_assert_release_source_clean "${PROVENANCE_SOURCE_GIT_DIRTY:-true}" "$REPO_ROOT"; then
    echo "       Refusing to build a release-audited sidecar from a dirty source tree." >&2
    exit 2
  fi
  # EI-21832562420831737, the third part: SOURCE cleanliness is only half of what this build
  # reads. The other half is node_modules, and a pinned worktree has none of its own — so the
  # cut that shipped r15 overlay-mounted 86 dependency trees whose lower layer was the LIVE
  # shared checkout, which ~100 agents install into while the build reads it. That is how r14
  # died (D-187), and with dependency generation switched off (D-186) the only thing that
  # detected it is gone. Every artifact-side gate still passes, because a bundle built from
  # torn inputs agrees with itself.
  #
  # PAPERCUSP_PINNED_DEPS_SNAPSHOT_ROOT is how an orchestrator DECLARES the snapshot it took;
  # unset means "nothing outside this tree is allowed", which is the stricter reading and the
  # right default. Satisfiable today by construction — a tree holding its own node_modules
  # passes with no declaration at all. See lib/pinned-deps.sh for the snapshot that makes the
  # borrowed-storage case satisfiable too, and for why the lower layer is the thing that had
  # to move. Same placement contract as the gates above: before any toolchain work.
  if ! papercusp_assert_pinned_deps_decoupled "$REPO_ROOT" "${PAPERCUSP_PINNED_DEPS_SNAPSHOT_ROOT:-}"; then
    echo "       Refusing to build a release-audited sidecar from dependencies another tree owns." >&2
    exit 2
  fi
fi
unset _vm_release_build_sha _vm_release_desktop_version

# EI-20228051309163209: release builders are invoked from several environments
# (interactive shells, systemd user units, cron/routines). The systemd user
# manager can retain an OLD PATH for days: on 2026-08-12 it resolved NVM Node 22
# even though the repo's .nvmrc/engines require Node 25 and the host's current
# Linuxbrew runtime was Node 25. npm 10 under Node 22 then reported a successful
# scoped install while leaving 100+ direct operator dependencies un-extracted,
# producing a misleading dependency-resolution red after the build had started.
# Resolve the repo-pinned major here, before the first node/npm call. Prefer the
# caller's node when it satisfies the pin; otherwise use a matching common
# NVM/Homebrew/mise install and prepend ITS bin directory to PATH so `npm` uses
# the same runtime. If none exists, fail fast with the actual vs required major.
PAPERCUSP_REQUIRED_NODE_MAJOR="$(sed -nE 's/^[[:space:]]*v?([0-9]+).*$/\1/p' "$REPO_ROOT/.nvmrc" 2>/dev/null | sed -n 1p)"
# P-411 R1 (check-assert-integrity): this used to coerce an empty read to 25.
# An empty read means EITHER "the pin is unreadable/missing" OR "the parse
# failed" — it never means "the pin is 25". Coercing made an UNMEASURED probe
# score as the permissive case, and the consequence is not hypothetical: the
# moment the repo pins 26, an unreadable .nvmrc would still admit a Node 25
# build, and the `-ge` assert below would report a requirement it never read.
# That is precisely the failure this whole block was added to prevent
# (EI-20228051309163209), so fail closed — the pin is one cheap file read.
if ! [[ "$PAPERCUSP_REQUIRED_NODE_MAJOR" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not read the repo-pinned Node major from $REPO_ROOT/.nvmrc" >&2
  echo "       (parsed: '${PAPERCUSP_REQUIRED_NODE_MAJOR:-<empty>}')." >&2
  echo "       The runtime pin is load-bearing for this release build, so this" >&2
  echo "       script refuses to guess it. Restore/repair .nvmrc and re-run." >&2
  exit 1
fi
papercusp_node_major() {
  local candidate="$1"
  [ -x "$candidate" ] || return 1
  "$candidate" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || return 1
}
_current_node="$(command -v node 2>/dev/null || true)"
_brew_node=""
if command -v brew >/dev/null 2>&1; then
  _brew_node="$(brew --prefix node 2>/dev/null || true)/bin/node"
fi
_selected_node=""
for _node_candidate in \
  "$_current_node" \
  "$_brew_node" \
  /home/linuxbrew/.linuxbrew/bin/node \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  "$HOME"/.nvm/versions/node/v"$PAPERCUSP_REQUIRED_NODE_MAJOR"*/bin/node \
  "$HOME"/.local/share/mise/installs/node/"$PAPERCUSP_REQUIRED_NODE_MAJOR"*/bin/node; do
  [ -n "$_node_candidate" ] && [ -x "$_node_candidate" ] || continue
  _node_major="$(papercusp_node_major "$_node_candidate" || true)"
  if [[ "$_node_major" =~ ^[0-9]+$ ]] && [ "$_node_major" -ge "$PAPERCUSP_REQUIRED_NODE_MAJOR" ]; then
    _selected_node="$_node_candidate"
    break
  fi
done
if [ -z "$_selected_node" ]; then
  _current_version="$($_current_node -v 2>/dev/null || echo unavailable)"
  echo "ERROR: sidecar release build requires Node >=$PAPERCUSP_REQUIRED_NODE_MAJOR (.nvmrc), but PATH resolves ${_current_node:-no node} (${_current_version})." >&2
  echo "       Install/expose the pinned runtime (for example: nvm use $PAPERCUSP_REQUIRED_NODE_MAJOR) before building." >&2
  exit 1
fi
export PATH="$(dirname "$_selected_node"):$PATH"
hash -r
echo "→ using pinned Node runtime: $(command -v node) ($(node -v), required >=$PAPERCUSP_REQUIRED_NODE_MAJOR)"
unset _current_node _current_version _brew_node _selected_node _node_candidate _node_major

# WI-40008 / WI-6043: systemd user managers keep their own launch-time PATH and
# commonly omit Cargo's default install directory even when the owner has a
# healthy Rust toolchain at ~/.cargo/bin. The live federation gate exposed that
# exact split: this script resolved the pinned Node runtime above, spent the
# whole sidecar build, then died at the chat-dock `cargo metadata` / `cargo
# build` calls with `cargo: command not found`. Resolve the Rust entry point at
# the same early boundary as Node so every caller (interactive, systemd, cron)
# gets one deterministic toolchain view and a missing install fails before the
# expensive build. Honour relocated CARGO_HOME; only amend PATH when the caller
# did not already select a cargo binary.
_cargo_home="${CARGO_HOME:-$HOME/.cargo}"
if ! command -v cargo >/dev/null 2>&1 && [[ -x "$_cargo_home/bin/cargo" ]]; then
  export PATH="$_cargo_home/bin:$PATH"
  hash -r
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "ERROR: sidecar release build requires Cargo, but PATH has no cargo and $_cargo_home/bin/cargo is not executable." >&2
  echo "       Install/expose the Rust toolchain (systemd callers usually need CARGO_HOME/bin on PATH), then re-run." >&2
  exit 1
fi
echo "→ using Cargo toolchain: $(command -v cargo) ($(cargo --version))"
unset _cargo_home

# WI-5651: normally the sidecar is assembled + published at src-tauri/sidecar
# (where tauri build's bundle.resources glob reads it — a real release cut MUST
# use that). PAPERCUSP_SIDECAR_OUT redirects the WHOLE build (temp stage, lock,
# atomic publish) to a scratch dir so a cross-platform TEST bundle can be built
# and inspected WITHOUT clobbering the live host sidecar on this shared tree.
SIDECAR_DIR="${PAPERCUSP_SIDECAR_OUT:-$ROOT/src-tauri/sidecar}"

if [[ ! -d "$WEB_DIR" ]]; then
  echo "ERROR: papercup/apps/operator not found at $WEB_DIR"
  echo "       Set REPO_ROOT to the path of your Papercusp/papercup clone."
  exit 1
fi
if [[ ! -d "$PAPERCUSP_ROOT" ]]; then
  echo "ERROR: papercusp not found at $PAPERCUSP_ROOT"
  echo "       Set PAPERCUSP_ROOT to the path of your Papercusp/papercusp clone."
  exit 1
fi

# ── EI-1836 / WI-5695 class guard: fail FAST + NAMED on a committed git conflict
# marker, before spending minutes on npm install + the vite build. On 2026-06-20
# (EI-1836) and again on 2026-07-20 (WI-5695, a `git stash` mishap — see
# EI-18215743778965613) a git-sync auto-commit swept up `apps/operator/app/globals.css`
# mid-conflict, and this script's `vite build` then died on a cryptic
# `CssSyntaxError: Unknown word "Stashed"` with no named root — green-checkpoint
# already runs this same check (apps/operator/lib/release/green-checkpoint.ts) but
# this standalone sidecar-build path did not, so the SAME class recurred here
# undetected. scripts/check-conflict-markers.mjs is the single tested source of
# truth for the marker pattern (packages/operator-core/lib/__tests__/check-conflict-markers-guard.test.ts) — reuse it.
echo "→ checking for committed git conflict markers (EI-1836/WI-5695 class guard)"
if ! node "$REPO_ROOT/scripts/check-conflict-markers.mjs"; then
  echo "ERROR: committed git conflict marker(s) found in $REPO_ROOT — resolve before building (see above)."
  exit 1
fi

# ── WI-5651: cross-target sidecar (bake on Linux for mac/windows, retire the VMs) ─
# The sidecar's JS (serve.mjs, spa/, db-sql/) is platform-INDEPENDENT — only its
# BINARY payload differs per OS/arch: the vendored `node`, gh/zellij/pui, the
# embedded-postgres binaries, pgvector, and the native .node addons (node-pty,
# sharp, the bare/holepunch stack, onnxruntime-node). Historically this script
# built ONLY for its own host ($(uname)), so a mac/windows bundle had to be
# produced ON a mac/windows host (the fragile QEMU build VMs). WI-5651 retires
# those VMs by CROSS-baking every leg on this Linux box.
#   TARGET_OS   = linux | darwin | windows   (default: this host)
#   TARGET_ARCH = x64 | arm64                 (default: this host)
# Both DEFAULT to the host, so an UN-set invocation is byte-for-byte the same
# build as before — every existing linux/native caller is unchanged. The value
# flows into: target_os/target_arch (external-binary section), the native-addon
# prune (keeps the TARGET's prebuilds) + fetch (pulls the TARGET's per-platform
# optional pkgs npm won't install cross), embedded-postgres, and pgvector.
_host_os=""
case "$(uname -s)" in
  Linux*)               _host_os="linux" ;;
  Darwin*)              _host_os="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) _host_os="windows" ;;
  *)                    _host_os="$(uname -s)" ;;
esac
_host_arch=""
case "$(uname -m)" in
  x86_64|amd64)  _host_arch="x64" ;;
  arm64|aarch64) _host_arch="arm64" ;;
  *)             _host_arch="$(uname -m)" ;;
esac
TARGET_OS="${TARGET_OS:-$_host_os}"
TARGET_ARCH="${TARGET_ARCH:-$_host_arch}"
# GNU Make reserves TARGET_ARCH and appends it verbatim to its built-in compile
# rules.  A caller-supplied environment value keeps its exported attribute after
# the assignment above, so TARGET_ARCH=x64 made PostgreSQL invoke
# `gcc ... x64 -c ...` and fail every object build.  The sidecar builder itself
# still needs the normalized value, but subprocesses receive explicit target
# flags at their call sites; keep this control variable shell-local.
export -n TARGET_ARCH
CROSS_BUILD=0
if [[ "$TARGET_OS" != "$_host_os" || "$TARGET_ARCH" != "$_host_arch" ]]; then
  CROSS_BUILD=1
  echo "→ WI-5651 CROSS-baking sidecar for ${TARGET_OS}-${TARGET_ARCH} on a ${_host_os}-${_host_arch} host"
fi

# HOST-TOOL PREFLIGHT (EI-24668318952454860 follow-up, WI-10003960 R-15): several
# hard host-tool requirements used to be checked only at their point of use,
# thousands of lines in, so a fresh build host paid a full multi-minute run per
# missing tool and discovered them one at a time (a fresh-clone Linux build died
# on `kopia not found` only after the whole sidecar had been assembled). Decide
# every host tool that is knowable from the target alone HERE, before the first
# toolchain or dependency operation, and report ALL missing ones in one failure.
# The point-of-use checks stay as the authoritative guards; this only moves the
# discovery forward. Keep the conditions in lock-step with those call sites.
_missing_host_tools=()
# kopia: the bundled snapshot subsystem (packages/backup/src/workspace-backup.ts).
# Local builds copy the host binary; darwin cross-builds read the host version to
# fetch the matching release. Only vm-release consumes its own pinned build.
if [[ "${DISTRIBUTION_PROFILE:-}" != "vm-release" ]] \
   && ! command -v kopia >/dev/null 2>&1; then
  _missing_host_tools+=("kopia (snapshot subsystem — https://kopia.io/docs/installation/, apt/brew install kopia)")
fi
# ALSA dev headers: the chat-dock step natively `cargo build`s apps/tui, whose
# `pui-audio` bin pulls cpal → alsa-sys, and alsa-sys's build script needs
# `alsa.pc` via pkg-config on Linux. A fresh Ubuntu host without libasound2-dev
# died on it (exit 101) ~8 minutes in (WI-10003960 R-15 build5).
if [[ "$CROSS_BUILD" != "1" && "$TARGET_OS" == "linux" ]]; then
  if ! command -v pkg-config >/dev/null 2>&1; then
    _missing_host_tools+=("pkg-config (native Rust builds — apt install pkg-config)")
  elif ! pkg-config --exists alsa 2>/dev/null; then
    _missing_host_tools+=("ALSA development headers, alsa.pc (chat-dock pui audio — apt install libasound2-dev / dnf install alsa-lib-devel)")
  fi
fi
# Embedding models: the sidecar's fail-closed models guard (WI-5638 / D-178) needs the
# two contract-pinned transformers models, which `npm ci` never downloads. A host tree
# carries them only because live use filled the package's `.cache`; a fresh clone
# (WI-10003960 R-15 build6) died on the guard ~8 minutes in. Refuse here instead, and
# name the one command that produces them.
_tf_pkg="$REPO_ROOT/node_modules/@huggingface/transformers"
if [[ -z "${PAPERCUSP_TRANSFORMERS_MODEL_CACHE:-}" ]] \
   && ! papercusp_transformers_models_present "$_tf_pkg/.cache" \
   && ! papercusp_transformers_models_present "$_tf_pkg/models"; then
  _missing_host_tools+=("embedding models (harrier-oss + embeddinggemma, ~3.4GB) — run: bin/lib/transformers-models.sh fetch ~/.cache/papercusp-models && export PAPERCUSP_TRANSFORMERS_MODEL_CACHE=~/.cache/papercusp-models")
fi
unset _tf_pkg
if [[ "$CROSS_BUILD" == "1" && "$TARGET_OS" == "darwin" ]]; then
  for _t in file curl python3 rcodesign; do
    command -v "$_t" >/dev/null 2>&1 || _missing_host_tools+=("$_t (darwin cross-build vendoring/signing)")
  done
fi
if (( ${#_missing_host_tools[@]} > 0 )); then
  echo "ERROR: build host is missing required tool(s) — install them, then re-run:" >&2
  for _t in "${_missing_host_tools[@]}"; do echo "  - $_t" >&2; done
  exit 1
fi
unset _missing_host_tools _t

# WI-2644 / EI-18751304112302229: the packaged sidecar's serve.mjs runs
# standalone (no `npm run` context), so process.env.npm_package_version is
# unset at runtime and build-info.ts / serve.ts fall back to their (differing)
# hardcoded defaults — the installed app's /api/health + UI footer report a
# fake '0.0.0'/dev version instead of the real shipped one. tauri.conf.json's
# `version` is the authoritative shipped version (release.config.ts's
# versionFiles bumps package.json + tauri.conf.json + Cargo.toml together on
# every release), so read it here and bake it into the bundle via esbuild
# --define below.
#
# EI-18751304112302229: this used to bake ONLY
# --define:process.env.npm_package_version, but esbuild's --define is a
# SYNTACTIC rewrite of the exact member expression named. That correctly
# reaches a call site that writes the literal expression itself (e.g.
# endpoint-route/routes/desktop/onboarding-launch-context.ts's `appVersion:
# process.env.npm_package_version ?? …`), but build-info.ts never writes that
# literal — it reads through an injectable-seam alias (`const env = opts.env
# ?? process.env; env.npm_package_version`) — so for THAT consumer (the one
# WI-2644 was actually filed about: /api/health) the define had nothing to
# match and silently baked into nothing. Keep the original literal define for
# the former, and ALSO bake a dedicated global identifier — the same idiom
# __PAPERCUSP_BUNDLED_SIDECAR__ already uses below — that build-info.ts reads
# directly, so there is no alias left for esbuild to miss.
PAPERCUSP_DESKTOP_VERSION="$(node -e "try{process.stdout.write(require('$ROOT/src-tauri/tauri.conf.json').version||'')}catch(e){}" 2>/dev/null)"
# Built as an array (not a bare --define string) so the UNREADABLE case omits
# the flag ENTIRELY rather than baking an empty string: `?? '0.0.0'`-style
# fallbacks only trigger on undefined/null, so `--define:...="\"\""` would bake
# a WORSE empty-string version than today's unset-env fallback.
VERSION_DEFINE_ARGS=()
if [[ -n "$PAPERCUSP_DESKTOP_VERSION" ]]; then
  VERSION_DEFINE_ARGS=(
    --define:process.env.npm_package_version="\"${PAPERCUSP_DESKTOP_VERSION}\""
    --define:__PAPERCUSP_SIDECAR_VERSION__="\"${PAPERCUSP_DESKTOP_VERSION}\""
  )
else
  echo "WARN: could not read version from $ROOT/src-tauri/tauri.conf.json — sidecar will report its unstamped fallback version"
fi

# ── EI-160: no concurrent-build clobber (P-056) ─────────────────────────────
# Two builds racing into the same live SIDECAR_DIR used to interleave
# rm -rf/cp — a reader (a running `tauri dev`, the federation smoke rigs)
# caught mid-swap saw a half-written bundle, and a second builder could
# truncate binaries the first was still copying. Serialize whole builds on a
# BUILD-ONLY lock, build into a temp sibling, then take the reader-facing
# publication lock only for the final atomic rename. Readers therefore keep
# using the complete old tree while a long build/install/fingerprint runs and
# pause only for the short publish transaction.
#
# EI-200: this protects OTHER invocations of THIS script from each other —
# it does NOT protect a plain `cargo build`/`cargo check` under src-tauri
# from racing the publish step below. tauri.conf.json's `bundle.resources`
# glob (sidecar/**/*) is validated by `generate_context!` at COMPILE time,
# and the publish sequence briefly renames SIDECAR_FINAL_DIR OUT before
# renaming the new tree IN (a real, if narrow, "sidecar/ doesn't exist at
# all" window) — a cargo-build invocation whose glob validation lands there fails with
# a misleading "path not found" error. Use bin/cargo-build-safe.sh instead
# of a bare `cargo <args>` under src-tauri when building alongside active
# desktop-sidecar contention — it takes a SHARED flock on this same lock
# file, so it waits out an in-flight rebuild instead of racing it.
SIDECAR_FINAL_DIR="$SIDECAR_DIR"
SIDECAR_TMP_DIR="$SIDECAR_FINAL_DIR.tmp.$$"
mkdir -p "$(dirname "$SIDECAR_FINAL_DIR")"
# shellcheck source=lib/sidecar-lock-yield.sh
source "$HERE/lib/sidecar-lock-yield.sh"
SIDECAR_BUILD_LOCK="$SIDECAR_FINAL_DIR.build.lock"
SIDECAR_BUILD_LOCKDIR=""
SIDECAR_PUBLISH_LOCKDIR=""
# Split release legs may wait behind another platform's legitimate base-sidecar
# build. Keep that build-to-build budget separate from the reader-facing publish
# lock, whose default remains bounded by SIDECAR_LOCK_WAIT (60s).
SIDECAR_BUILD_LOCK_WAIT="${PAPERCUSP_SIDECAR_BUILD_LOCK_WAIT_SEC:-$SIDECAR_LOCK_WAIT}"
if ! [[ "$SIDECAR_BUILD_LOCK_WAIT" =~ ^[0-9]+$ ]]; then
  echo "FATAL: PAPERCUSP_SIDECAR_BUILD_LOCK_WAIT_SEC must be non-negative integer seconds" >&2
  exit 2
fi

# Build-to-build serialization must never reuse the reader-facing sidecar.lock:
# dependency generation and npm installs routinely take minutes, while Tauri only
# needs a stable already-published tree. A distinct lock keeps those readers live.
if command -v flock >/dev/null 2>&1; then
  exec 8>"$SIDECAR_BUILD_LOCK"
  if ! flock -w "$SIDECAR_BUILD_LOCK_WAIT" 8; then
    __pc_report_sidecar_lock_timeout "$SIDECAR_BUILD_LOCK" "" "$SIDECAR_BUILD_LOCK_WAIT"
    exit 5
  fi
else
  # macOS ships no flock(1) — serialize builders with a PID-stamped mkdir.
  SIDECAR_BUILD_LOCKDIR="$SIDECAR_FINAL_DIR.build.lockdir"
  __pc_build_lock_deadline=$(( $(date +%s) + SIDECAR_BUILD_LOCK_WAIT ))
  while ! mkdir "$SIDECAR_BUILD_LOCKDIR" 2>/dev/null; do
    holder="$(cat "$SIDECAR_BUILD_LOCKDIR/pid" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$SIDECAR_BUILD_LOCKDIR"
      continue
    fi
    if (( $(date +%s) >= __pc_build_lock_deadline )); then
      __pc_report_sidecar_lock_timeout "$SIDECAR_BUILD_LOCK" "$SIDECAR_BUILD_LOCKDIR" "$SIDECAR_BUILD_LOCK_WAIT"
      exit 5
    fi
    sleep 1
  done
  echo "$$" > "$SIDECAR_BUILD_LOCKDIR/pid"
fi

# Acquire/release the reader-facing lock only around the verified tree's final
# rename transaction. The helper retains its bounded cooperative-yield behavior
# for a Tauri reader that happens to be inside its tiny startup critical section.
__pc_acquire_sidecar_publish_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$SIDECAR_FINAL_DIR.lock"
    __pc_acquire_sidecar_flock "$SIDECAR_FINAL_DIR.lock"
    return $?
  fi

  SIDECAR_PUBLISH_LOCKDIR="$SIDECAR_FINAL_DIR.lockdir"
  if [[ -d "$SIDECAR_PUBLISH_LOCKDIR" ]]; then
    echo "→ sidecar publish lock is busy; allowing the current reader ${SIDECAR_READER_YIELD_AFTER}s before requesting a cooperative yield"
    ((SIDECAR_READER_YIELD_AFTER == 0)) || sleep "$SIDECAR_READER_YIELD_AFTER"
    __pc_request_cooperative_reader_yield "$SIDECAR_FINAL_DIR.lock" "$SIDECAR_PUBLISH_LOCKDIR"
  fi
  __pc_publish_lock_deadline=$(( $(date +%s) + SIDECAR_LOCK_WAIT ))
  while ! mkdir "$SIDECAR_PUBLISH_LOCKDIR" 2>/dev/null; do
    holder="$(cat "$SIDECAR_PUBLISH_LOCKDIR/pid" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$SIDECAR_PUBLISH_LOCKDIR"
      continue
    fi
    if (( $(date +%s) >= __pc_publish_lock_deadline )); then
      __pc_report_sidecar_lock_timeout "$SIDECAR_FINAL_DIR.lock" "$SIDECAR_PUBLISH_LOCKDIR"
      return 5
    fi
    sleep 1
  done
  echo "$$" > "$SIDECAR_PUBLISH_LOCKDIR/pid"
}

__pc_release_sidecar_publish_lock() {
  if command -v flock >/dev/null 2>&1; then
    flock -u 9 || true
    exec 9>&-
  elif [[ -n "$SIDECAR_PUBLISH_LOCKDIR" ]]; then
    rm -rf "$SIDECAR_PUBLISH_LOCKDIR"
    SIDECAR_PUBLISH_LOCKDIR=""
  fi
}

# EI-21830176050381484: build.rs may recreate the resource-glob placeholder in
# the tiny publish window even though real sidecar builders are serialized by
# sidecar.build.lock. Only that exact, closed placeholder shape is disposable.
# A directory carrying real output (or any unknown residue) belongs to another
# writer and must be preserved rather than silently rm -rf'd.
__pc_is_cargo_sidecar_placeholder() {
  local dir="$1" marker unexpected
  [[ -d "$dir" && ! -L "$dir" ]] || return 1
  [[ ! -e "$dir/serve.mjs" && ! -e "$dir/.sidecar-build-stamp" ]] || return 1
  [[ -d "$dir/db-sql" && ! -L "$dir/db-sql" ]] || return 1
  [[ -d "$dir/spa" && ! -L "$dir/spa" ]] || return 1

  for marker in \
    "$dir/PLACEHOLDER-README.txt" \
    "$dir/db-sql/PLACEHOLDER-README.txt" \
    "$dir/spa/PLACEHOLDER-README.txt"; do
    [[ -f "$marker" && ! -L "$marker" ]] || return 1
    grep -Fq 'Placeholder created by build.rs so the bundle.resources globs match' "$marker" || return 1
  done

  unexpected="$(find "$dir" -mindepth 1 \
    ! -path "$dir/PLACEHOLDER-README.txt" \
    ! -path "$dir/db-sql" \
    ! -path "$dir/db-sql/PLACEHOLDER-README.txt" \
    ! -path "$dir/spa" \
    ! -path "$dir/spa/PLACEHOLDER-README.txt" \
    -print -quit 2>/dev/null)"
  [[ -z "$unexpected" ]]
}
SIDECAR_DIR="$SIDECAR_TMP_DIR"

# EI-1869 + EI-21492557010868835: fetched runtime binaries and the expensive
# vm-release source-built trust toolchain live outside the per-build temporary
# sidecar.  Define the cache before embedded PostgreSQL is assembled (the old
# definition lived near Node, hundreds of lines too late for the pinned PG
# source path).  The helper owns its own cache lock, while the sidecar build lock
# above still serializes this assembled output tree.
SIDECAR_BIN_CACHE="${PAPERCUSP_SIDECAR_BIN_CACHE:-$HOME/.cache/papercusp-sidecar-bins}"
mkdir -p "$SIDECAR_BIN_CACHE"

# STALE STAGING SWEEP (WI-38368 / EI-18882950272344248) — reap residue the EXIT
# trap structurally CANNOT catch.
#
# The EXIT trap above already covers far more than it looks like it does:
# measured on this box, a bash EXIT trap DOES fire on SIGTERM and SIGINT, so
# `trap ... EXIT INT TERM` would add nothing. What no trap can ever catch is
# SIGKILL (also the OOM killer, a power loss, a hard reset) — the process is
# destroyed without running userspace. That is the ONLY way residue survives
# now, and it is how `sidecar.tmp.3992781` (1.4GB, owning pid long dead) came
# to sit here for over a day. A sweep is therefore not redundant with the
# trap; it is the only mechanism that can close the remaining class.
#
# Placed deliberately AFTER the build lock is held and BEFORE the disk preflight:
#   - holding the exclusive BUILD lock means no concurrent build is between
#     lock-acquire and lock-release, so anything matching here is by
#     construction not an in-flight peer's tree;
#   - sweeping before the preflight means reclaimed space COUNTS toward the
#     free-GB requirement, so a build that would have died on "not enough
#     space" now succeeds off its own garbage.
#
# ⚠ PID-CHECKED, NEVER BLANKET. This is a shared multi-agent tree and a
# blanket `rm -rf sidecar.tmp.*` would turn a latent race (a concurrent build
# finishing its atomic rename while STAGE2 tars src-tauri) into a reliable
# failure. `kill -0` ALONE is not enough either: pid wrap happens ~daily on
# this box under fleet load, so a recycled pid would otherwise protect dead
# residue forever. We require the pid to be alive AND to actually be a
# build-desktop-sidecar.sh process. Both checks failing open (skip, don't
# delete) is the safe direction — a missed reap costs disk, a wrong reap
# costs someone else's build.
__pc_pid_is_sidecar_builder() {
  local pid="$1" arg
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  while IFS= read -r -d '' arg; do
    case "$arg" in
      build-desktop-sidecar.sh|*/bin/build-desktop-sidecar.sh) return 0 ;;
    esac
  done < "/proc/$pid/cmdline"
  return 1
}

__pc_sweep_stale_staging() {
  local d pid base reaped=0 freed_kb=0 sz
  for d in "$SIDECAR_FINAL_DIR".tmp.* "$SIDECAR_FINAL_DIR".old.*; do
    [[ -d "$d" ]] || continue                 # unmatched glob expands to itself
    [[ "$d" == "$SIDECAR_TMP_DIR" ]] && continue   # never our own staging tree
    base="${d##*.}"
    pid="$base"
    # A non-numeric suffix is not a pid-stamped staging dir we own — leave it.
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    [[ "$pid" == "$$" ]] && continue
    if kill -0 "$pid" 2>/dev/null && __pc_pid_is_sidecar_builder "$pid"; then
      echo "[sweep] skip $(basename "$d") — pid $pid is a LIVE build"
      continue
    fi
    sz="$(du -sk "$d" 2>/dev/null | cut -f1)"
    [[ "$sz" =~ ^[0-9]+$ ]] || sz=0
    if rm -rf "$d" 2>/dev/null; then
      reaped=$((reaped + 1)); freed_kb=$((freed_kb + sz))
      echo "[sweep] reaped $(basename "$d") — owning pid $pid is dead ($((sz / 1024))MB)"
    else
      echo "[sweep] WARN could not remove $d" >&2
    fi
  done
  (( reaped > 0 )) && echo "[sweep] reclaimed $((freed_kb / 1024))MB from $reaped stale staging dir(s)"
  return 0
}
__pc_sweep_stale_staging

# DISK PREFLIGHT (EI-20090527288494606) — refuse now, not 3 minutes into the copy.
# This script stages a multi-GB tree (node_modules + the ~2.4GB sidecar payload)
# and, at publish time, briefly holds BOTH the old and new trees during the
# OLD_DIR swap — so the requirement is roughly twice the payload plus slack. On
# 2026-08-10 this ran with the root fs at 100% and died mid-`cp` with
# `No space left on device`, leaving a partially-staged tree that still looked
# valid to later steps. Measured against the dir we actually stage INTO, which is
# not necessarily $PWD.
# shellcheck source=lib/disk-preflight.sh
source "$HERE/lib/disk-preflight.sh"
papercusp_require_free_gb "$SIDECAR_DIR" "${PAPERCUSP_SIDECAR_MIN_FREE_GB:-8}" "sidecar staging" || exit $?

# Clean the temp tree (and the darwin lockdir) on any exit; after the
# publish rename the tmp half is a no-op.
#
# WI-6557: OLD_DIR is ALSO reaped here, even though `OLD_DIR` is not assigned
# until much later (the `mv "$SIDECAR_FINAL_DIR" "$OLD_DIR"` swap just before
# publish) — this trap string is single-quoted, so `${OLD_DIR:+...}` is
# re-expanded at FIRE time, by which point OLD_DIR is whatever the run has
# reached (unset/empty before the swap, the real path after it). `:+` never
# trips `set -u` for an unset var, so this is safe on every exit before the
# swap too. Before this fix, the ONLY reap of OLD_DIR was the explicit
# `rm -rf "$OLD_DIR"` on the success path — so ANY failure between the swap
# and that line (a `set -e` death, an explicit `exit 1` guard, e.g. the
# stray-runtime-.cache check) permanently stranded the ENTIRE outgoing
# sidecar tree (multiple GB) with no cleanup path at all. 11 orphaned
# `sidecar.old.<pid>` dirs — one per such death, one of them 2.5G — were
# found stranded on this box from exactly this gap. Safe to add
# unconditionally: on the success path OLD_DIR is already removed by the
# explicit `rm -rf` below by the time this trap fires, so `rm -rf` on an
# already-gone path is a silent no-op; the trap never fires MID-run (only at
# actual process exit), so it cannot race the overlay-preservation read that
# copies FROM OLD_DIR just after the swap.
trap 'rm -rf "$SIDECAR_TMP_DIR" ${SIDECAR_BUILD_LOCKDIR:+"$SIDECAR_BUILD_LOCKDIR"} ${SIDECAR_PUBLISH_LOCKDIR:+"$SIDECAR_PUBLISH_LOCKDIR"} ${OLD_DIR:+"$OLD_DIR"}; [[ -z "${_OWN_PROVENANCE_SOURCE_DIRTY_MANIFEST:-}" ]] || rm -f "$_OWN_PROVENANCE_SOURCE_DIRTY_MANIFEST"' EXIT

# ---------------------------------------------------------------------------
# operator-vite migration (Phase F3 / G4). The desktop UI is no longer a
# Next.js app — it is the Vite SPA (apps/operator-vite) served, together
# with /api/* and /internal/docs/*, by the single-process Hono host
# (apps/operator/bin/hono-host.ts). So instead of `next build` →
# `.next/standalone`, this section:
#
#   1. installs operator + operator-vite deps,
#   2. `vite build`s the SPA → apps/operator-vite/dist/,
#   3. esbuild-bundles the serve entry into one ESM file (sidecar/serve.mjs),
#   4. copies the SPA, the Starlight docs, operator prompts, and the
#      externalized native deps (node-pty, embedded-postgres-server, …)
#      into the sidecar.
#
# Why esbuild and not a node_modules copy: the monorepo hoists deps to the
# repo-root node_modules, so `cp apps/operator/node_modules` would miss
# them. `next build`'s standalone tracer used to resolve that; esbuild
# resolves it differently — it follows the host's import graph and *inlines*
# every module, hoisting and workspace symlinks alike. The result needs no
# node_modules except the handful that genuinely cannot be inlined.
#
# ┌─ BUNDLE STEP: VERIFIED 2026-05-21 ──────────────────────────────────┐
# │ The esbuild bundle step itself is verified — esbuild@0.25.0 bundles  │
# │ the full host import graph clean (17.5MB host.mjs, parses as valid   │
# │ ESM) with exactly the HOST_EXTERNALS below. node-pty is the only     │
# │ genuinely-native external. UNVERIFIED beyond bundling: whether the   │
# │ bundle RUNS correctly in the packaged desktop (needs a real          │
# │ `tauri build` + the embedded-PG sidecars). If a FUTURE host route    │
# │ adds a native (.node) or .wasm dep, esbuild will fail with "Could    │
# │ not resolve" — add that package to HOST_EXTERNALS and copy it into   │
# │ sidecar/node_modules alongside the node-pty copy below.              │
# └─────────────────────────────────────────────────────────────────────┘
# ---------------------------------------------------------------------------
echo "→ building operator-vite SPA + esbuild-bundling the Hono host"
VITE_DIR="$REPO_ROOT/apps/operator-vite"
if [[ ! -d "$VITE_DIR" ]]; then
  echo "ERROR: apps/operator-vite not found at $VITE_DIR"
  exit 1
fi
echo "→ installing operator + operator-vite deps (ONE combined workspace install)"
# ROOT-CAUSE FIX (2026-07-07, WI-3284): this USED to be two SEPARATE
# `(cd apps/operator && npm install)` then `(cd apps/operator-vite && npm install)`
# calls. Each such directory-scoped install reconciles the shared root
# node_modules against ONLY that one workspace's OWN declared dependency graph
# and PRUNES anything not in it — so the SECOND call (operator-vite) silently
# stripped packages the FIRST call (operator) had just hoisted for itself,
# because npm's dependency graph only follows package.json "dependencies"
# edges, not Vite's `@` alias (which treats apps/operator/app/** as literal
# operator-vite source, not a package boundary). Every package reachable ONLY
# through that alias — @glideapps/glide-data-grid's peers (lodash / marked /
# react-responsive-carousel), @papercusp/lexicon, @udecode/plate-markdown,
# dockview (via @papercusp/dock-workbench) — has repeatedly broken `vite
# build` with "Rolldown failed to resolve <pkg>" this way. Patching
# apps/operator-vite/package.json one missing package at a time (the old
# glide-data-grid fix) does not scale — a NEW alias-reachable import from
# apps/operator always reopens the same hole.
# FIX: install BOTH workspaces in ONE npm call so npm reconciles against the
# UNION of their declared dependency graphs — nothing either one needs gets
# pruned, regardless of which one the vite alias actually resolves through.
#
# ── `--prefer-offline` REMOVED (2026-07-25, WI-5769) — root cause of the
# whole "fix one missing dep, VM build finds another" saga ──────────────────
# On a fresh/remote VM (its npm cache never saw a just-declared package
# before), `npm install --prefer-offline --workspace=X --workspace=Y` prints
# "up to date" and EXITS WITHOUT ERROR while silently leaving that package
# missing from node_modules — the lockfile (and node_modules/.package-lock.json)
# both correctly list it as resolved, but the tarball is never actually
# extracted to disk. `npm ls <pkg>` then reports "(empty)". This is an npm
# workspace-scoped-install quirk, not flakiness: reproduced deterministically
# 3x — dropping just this one flag (keeping --legacy-peer-deps --no-audit
# --no-fund --ignore-scripts) made every one of 4 independently-diagnosed
# "missing dependency" bugs (@mantine/hooks, ajv-errors, slate,
# @anthropic-ai/sdk) resolve in the SAME single install, instead of needing
# 6+ separate full universal-arch rebuild retries (each tens of minutes) to
# discover them one at a time. Do not re-add `--prefer-offline` here without
# re-verifying against a VM whose npm cache is cold for the packages in
# question.
(cd "$REPO_ROOT" && node scripts/npm-install-safe.mjs install \
  --legacy-peer-deps --no-audit --no-fund --ignore-scripts \
  --workspace=@papercusp/web --workspace=@papercusp/operator-vite \
  --workspace=@papercusp/sse)

# POST-INSTALL RUNTIME BUILDS (EI-20505823617947029) -------------------------
# setup-release-checkout.sh builds these gitignored runtime entry points from
# the pinned release source before a cut starts. The scoped install above is a
# second dependency-reification boundary, though: npm can leave the workspace
# symlink and package.json intact while removing the generated dist/ behind it.
# That exact shape made `createRequire(...).resolve("@papercusp/sse")` fail in
# the D-026 stable cut even though the package was correctly installed.
#
# Rebuild from THIS REPO_ROOT after the install, never by copying an integration
# tree's dist/. The registry is intentionally explicit and is checked against
# every workspace with a gitignored bin/main/require/default target by
# setup-release-checkout-workspace-builds.test.ts.
RUNTIME_BUILD_WORKSPACES=(
  "@papercusp/omp"
  "@papercusp/sse"
)

build_runtime_workspace_outputs_after_install() {
  local workspace
  for workspace in "${RUNTIME_BUILD_WORKSPACES[@]}"; do
    echo "→ reifying build-time devDependencies for $workspace"
    if ! (cd "$REPO_ROOT" && node scripts/npm-install-safe.mjs install \
      --legacy-peer-deps --no-audit --no-fund \
      --ignore-scripts --include=dev --workspace="$workspace"); then
      echo "ERROR: could not reify build-time devDependencies for $workspace" >&2
      exit 1
    fi
    echo "→ verifying the resolved TypeScript toolchain for $workspace"
    if ! (cd "$REPO_ROOT" && npm --workspace="$workspace" exec -- node -e '
const manifest = require("./package.json");
const expectedApi = manifest.devDependencies?.typescript ?? "";
const expectedNative = manifest.devDependencies?.["@typescript/native"] ?? "";
if (!expectedApi && !expectedNative) {
  console.log(
    "  ✓ " + (process.env.npm_package_name ?? "runtime workspace") +
      ": no package-local TypeScript aliases declared; build command owns toolchain validation",
  );
  process.exit(0);
}
let actualApi = { name: "<unresolved>", version: "<unresolved>" };
let actualNative = { name: "<unresolved>", version: "<unresolved>" };
try {
  actualApi = require("typescript/package.json");
} catch {
  // The diagnostic below names the unresolved toolchain.
}
try {
  actualNative = require("@typescript/native/package.json");
} catch {
  // The diagnostic below names the unresolved toolchain.
}
const expectedApiMatch = /^npm:@typescript\/typescript6@(\d+\.\d+\.\d+)$/.exec(expectedApi);
const expectedNativeMatch = /^npm:typescript@(\d+\.\d+\.\d+)$/.exec(expectedNative);
const compatible =
  expectedApiMatch?.[1] === actualApi.version &&
  actualApi.name === "@typescript/typescript6" &&
  expectedNativeMatch?.[1] === actualNative.version &&
  actualNative.name === "typescript";
if (!compatible) {
  console.error(
    "FATAL: " + (process.env.npm_package_name ?? "runtime workspace") +
      " build toolchain mismatch: expected native CLI " +
      (expectedNative || "<missing>") + " + API compatibility " +
      (expectedApi || "<missing>") + "; resolved " +
      actualNative.name + "@" + actualNative.version + " + " +
      actualApi.name + "@" + actualApi.version + ".",
  );
  process.exit(1);
}
console.log(
  "  ✓ " + (process.env.npm_package_name ?? "runtime workspace") +
    ": native TypeScript " + actualNative.version +
    " + API compatibility " + actualApi.version + " satisfy their aliases",
);
'); then
      echo "ERROR: resolved TypeScript does not satisfy the workspace pin for $workspace" >&2
      exit 1
    fi
    # EI-21252365249211374: the shared root node_modules can still be in a
    # short extraction/visibility window immediately after npm exits (or a
    # queued, serialized install can begin as soon as our install releases the
    # mutex). The later dependency check already retries this exact class, but
    # runtime workspace builds happened BEFORE it and failed on the first
    # transient TS2688 missing-type read. Reify + rebuild up to three times at
    # the actual failure boundary; persistent failures still fail closed.
    local runtime_build_attempts=3
    local runtime_build_attempt
    local runtime_build_ok=0
    for runtime_build_attempt in $(seq 1 "$runtime_build_attempts"); do
      echo "→ rebuilding post-install runtime output for $workspace (attempt $runtime_build_attempt/$runtime_build_attempts)"
      if (cd "$REPO_ROOT" && npm --workspace "$workspace" run build); then
        runtime_build_ok=1
        break
      fi
      if [[ "$runtime_build_attempt" -lt "$runtime_build_attempts" ]]; then
        echo "runtime-build: $workspace attempt $runtime_build_attempt failed; reifying under npm-install-safe and retrying in 2s"
        sleep 2
        if ! (cd "$REPO_ROOT" && node scripts/npm-install-safe.mjs install \
          --legacy-peer-deps --no-audit --no-fund --ignore-scripts \
          --include=dev --workspace="$workspace"); then
          echo "runtime-build: dependency reify failed for $workspace on retry $runtime_build_attempt" >&2
        fi
      fi
    done
    if [[ "$runtime_build_ok" -ne 1 ]]; then
      echo "FATAL: runtime workspace build for $workspace failed after $runtime_build_attempts reify+build attempts — not a transient extraction race" >&2
      exit 1
    fi
  done
}
build_runtime_workspace_outputs_after_install
# END POST-INSTALL RUNTIME BUILDS ---------------------------------------------

echo "→ verifying workspace deps resolved"
echo "  apps/operator/node_modules/@restart/ contents:"
ls -la "$WEB_DIR/node_modules/@restart" 2>&1 | sed -n 1,10p || echo "(no @restart subdir)"
echo "  apps/operator/node_modules/@papercusp/ contents:"
ls -la "$WEB_DIR/node_modules/@papercusp" 2>&1 | sed -n 1,10p || echo "(no @papercusp subdir)"
# FAIL-FAST GUARD (2026-07-25, WI-5769): the two `ls` checks above are purely
# informational — neither fails the build, so the exact "npm said up to date
# but a declared dep never got extracted to node_modules" bug this whole
# section's header comment documents used to sail straight through this
# "verification" and only surface ~10 minutes later as a cryptic Rolldown
# "failed to resolve" error, and again ~45 minutes after THAT inside the
# 6+-minute-a-pop full universal-arch Rust/Swift build if the vite build step
# were ever skipped.
#
# SURGICAL, not `npm ls --all`: an earlier version of this guard shelled out to
# `npm ls --all --workspace=…` and failed on ANY "npm error missing:" line.
# That is too broad — under --legacy-peer-deps, `npm ls` reports every UNMET
# (non-optional) PEER dependency the same way, including transitive peers of
# packages that are test-only and never reach the vite bundle graph (concrete
# case: @papercusp/test-config → @nestjs/testing's REQUIRED peer @nestjs/core,
# which nothing in apps/operator/app or apps/operator-vite/src imports — a
# real false-positive that blocked a build for a dependency this build never
# needed). Check instead — and ONLY — that every package OUR OWN two
# workspaces directly declare in "dependencies" actually resolves on disk;
# that is the exact shape of the original bug (a declared dep silently
# un-extracted) without inheriting every third-party package's own optional
# peer graph.
#
# RETRY-WITH-DELAY (2026-07-26, WI-5769 retry8): a live mac-VM run hit this
# guard firing on a genuinely-transient miss — @restart/@papercusp missing
# immediately after "up to date in 19s" — that could NOT be reproduced by
# re-running the identical scoped install + immediate check twice afterward
# (both came back MISSING COUNT: 0 instantly). That is the signature of a
# filesystem-sync race (the VM's disk/extraction hadn't settled by the time
# this check ran), not a real un-extracted dependency — but the guard used to
# fail HARD on the very first check, turning a ~3-second race into a wasted
# 15-30min full universal-arch rebuild retry. Give the filesystem a few
# seconds to settle before declaring a real miss: retry the same check up to
# 3x with a short delay: a persistent miss across all 3 attempts (spanning 6s)
# is a real un-extracted dependency and still fails the build; a miss that
# clears on retry is the race, logged but non-fatal.
dep_check_attempts=3
dep_check_ok=0
for dep_check_attempt in $(seq 1 "$dep_check_attempts"); do
  if node -e '
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const repoRoot = process.argv[1];
const attempt = process.argv[2];
const pkgs = [
  "apps/operator/package.json",
  "apps/operator-vite/package.json",
  "packages/operator-core/package.json",
];
const missing = [];
const runtimeDetails = [];

for (const workspace of process.argv.slice(3)) {
  const packageRoot = path.join(repoRoot, "node_modules", workspace);
  const manifestPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(manifestPath)) {
    runtimeDetails.push(`${workspace}: package.json MISSING; TypeScript <unresolved>`);
    continue;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    runtimeDetails.push(
      `${workspace}: package.json unreadable (${error instanceof Error ? error.message : String(error)}); TypeScript <unresolved>`,
    );
    continue;
  }

  let tscApiVersion = "<unresolved>";
  let tscNativeVersion = "<unresolved>";
  try {
    tscApiVersion = createRequire(manifestPath).resolve("typescript/package.json");
    tscApiVersion = JSON.parse(fs.readFileSync(tscApiVersion, "utf8")).version;
    tscNativeVersion = createRequire(manifestPath).resolve("@typescript/native/package.json");
    tscNativeVersion = JSON.parse(fs.readFileSync(tscNativeVersion, "utf8")).version;
  } catch {
    // Keep the diagnostic explicit when the workspace-local/root compiler is absent.
  }

  const runtimeTargets = [];
  if (typeof manifest.main === "string") runtimeTargets.push(manifest.main);
  if (manifest.exports && typeof manifest.exports === "object") {
    for (const entry of Object.values(manifest.exports)) {
      if (typeof entry === "string") {
        runtimeTargets.push(entry);
      } else if (entry && typeof entry === "object") {
        for (const condition of ["require", "default"]) {
          if (typeof entry[condition] === "string") runtimeTargets.push(entry[condition]);
        }
      }
    }
  }
  const outputStatus = [...new Set(runtimeTargets)]
    .map((target) => {
      const outputPath = target.startsWith("./")
        ? path.resolve(packageRoot, target)
        : path.join(packageRoot, target);
      return `${target}=${fs.existsSync(outputPath) ? "present" : "MISSING"}`;
    })
    .join(", ") || "none declared";
  runtimeDetails.push(
    `${workspace}: native TypeScript ${tscNativeVersion} (pin ${manifest.devDependencies?.["@typescript/native"] ?? "<missing>"}); API compatibility ${tscApiVersion} (pin ${manifest.devDependencies?.typescript ?? "<missing>"}); runtime outputs ${outputStatus}`,
  );
}

for (const rel of pkgs) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
  for (const dep of Object.keys(pkg.dependencies || {})) {
    // Resolve the way Node/Rolldown would: workspace-local node_modules first,
    // falling back to the hoisted root node_modules.
    const candidates = [
      path.join(repoRoot, path.dirname(rel), "node_modules", dep),
      path.join(repoRoot, "node_modules", dep),
    ];
    if (!candidates.some((c) => fs.existsSync(c))) {
      missing.push(`${dep} (declared in ${rel})`);
    }
  }
}

// WI-38149: Vite follows file: workspace dependencies through their symlinks
// and resolves imports from each library realpath, not from the consuming app
// directory. A scoped npm install can therefore report both app workspaces
// complete while putting a runtime peer only beneath apps/operator/node_modules,
// where the linked library cannot see it. Validate the complete peer contract
// of DIRECT file: dependencies from the union installed above: each required
// peer must be declared by at least one installed app workspace and must
// resolve from the library realpath Vite uses. This stays narrower than the
// old npm-ls --all false-positive class because it never walks transitive peers.
const installDeclarations = new Set();
for (const rel of pkgs) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
  for (const dep of Object.keys(pkg.dependencies || {})) installDeclarations.add(dep);
  for (const dep of Object.keys(pkg.devDependencies || {})) installDeclarations.add(dep);
}
for (const rel of pkgs) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
  for (const [dep, spec] of Object.entries(pkg.dependencies || {})) {
    if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
    const workspaceRoot = path.resolve(repoRoot, path.dirname(rel), spec.slice("file:".length));
    const workspacePackagePath = path.join(workspaceRoot, "package.json");
    if (!fs.existsSync(workspacePackagePath)) continue;
    const workspacePackage = JSON.parse(fs.readFileSync(workspacePackagePath, "utf8"));
    const requireFromWorkspace = createRequire(workspacePackagePath);
    for (const peer of Object.keys(workspacePackage.peerDependencies || {})) {
      if (workspacePackage.peerDependenciesMeta?.[peer]?.optional) continue;
      if (!installDeclarations.has(peer)) {
        missing.push(`${peer} (required peer of ${dep}, but undeclared by the installed app workspaces)`);
        continue;
      }
      try {
        requireFromWorkspace.resolve(peer);
      } catch {
        missing.push(`${peer} (required peer of ${dep}, unresolved from ${path.relative(repoRoot, workspaceRoot)}/ realpath)`);
      }
    }
  }
}
if (missing.length > 0) {
  console.error(`dep-check attempt ${attempt}: post-install dependency resolution found missing DIRECTLY-DECLARED dependencies on disk. This is a real dependency-tree miss, not an npm "up to date" or extraction-class diagnosis; if it persists across all retries it is not a filesystem-sync race.`);
  for (const m of missing) console.error(`  - ${m}`);
  console.error("  runtime-build diagnostics (output targets + resolved TypeScript):");
  for (const detail of runtimeDetails) console.error(`  - ${detail}`);
  process.exit(1);
}
' "$REPO_ROOT" "$dep_check_attempt" "${RUNTIME_BUILD_WORKSPACES[@]}"; then
    dep_check_ok=1
    break
  fi
  if [[ "$dep_check_attempt" -lt "$dep_check_attempts" ]]; then
    echo "dep-check: retrying in 2s (attempt $dep_check_attempt/$dep_check_attempts missed — could be a filesystem-sync race; WI-5769)"
    sleep 2
  fi
done
if [[ "$dep_check_ok" -ne 1 ]]; then
  echo "FATAL: dependency-resolution check still failing after $dep_check_attempts attempts with delay — this is a REAL un-extracted dependency, not a transient race. See the dep-check output above for exactly which package(s)."
  exit 1
fi

# Prepare the sidecar staging root before the Vite build. The singleflight seam
# captures the completed SPA into this directory while its build lock is still
# held; later packaging steps consume that stable snapshot instead of rereading
# the shared live dist/ after another build can start.
rm -rf "$SIDECAR_DIR"
mkdir -p "$SIDECAR_DIR/spa" "$SIDECAR_DIR/node_modules/@lydell"

echo "→ building operator-vite SPA (vite build → locked sidecar snapshot)"
# PAPERCUSP_RETAIN_DIST_CHUNKS=0 — this is a PACKAGING build. The
# `VITE_BUILD_SNAPSHOT_DIR` handoff is captured by vite-build-singleflight while
# it holds the Vite build lock, so the SPA that ships is not invalidated by a
# concurrent build after this command exits. Retention (the default since
# `dist-chunk-retention-default-2026-07-26`) keeps old hashed chunks around to
# stop live windows 404-ing their pinned lazy imports — correct on a working
# tree, dead weight in a distributable. So this one caller opts out explicitly.
# Note the tradeoff this makes visible rather than introduces: the build runs in
# $REPO_ROOT (the shared tree), so it empties that tree's dist/ and any desktop
# window open against it will need a reload. Packaging is deliberate and rare.
(cd "$REPO_ROOT" && PAPERCUSP_RETAIN_DIST_CHUNKS=0 \
  VITE_BUILD_SNAPSHOT_DIR="$SIDECAR_DIR/spa" \
  npm --workspace @papercusp/operator-vite run build)
if [[ ! -f "$SIDECAR_DIR/spa/index.html" ]]; then
  echo "ERROR: expected locked Vite snapshot at $SIDECAR_DIR/spa/index.html after the build"
  exit 1
fi

echo "→ building sidecar into $SIDECAR_DIR (atomic publish to $SIDECAR_FINAL_DIR at the end)"
mkdir -p "$SIDECAR_DIR" "$SIDECAR_DIR/node_modules/@lydell"

echo "→ esbuild-bundling the serve entry (headless operator boot) → $SIDECAR_DIR/serve.mjs"
# SP1 C5 (operator-core-headless-serve-2026-06-04, Decision F): the sidecar
# entry is now `bin/serve.ts` — the self-contained operator boot that OWNS
# embedded-PG (start, migrations, embedded-pg.json) and writes operator.json
# discovery. The Rust embedder spawns `serve.mjs --ensure` instead of the old
# host.mjs + a separate embedded-postgres-server process. serve imports the
# full host graph (host-handler/host-bootstrap), so the bundle recipe is the
# same as the old host.mjs one.
#
# ESM output: the host's import graph contains `import.meta.url` (a CJS
# bundle rejects it). ESM has no `__dirname`/`__filename`/`require`, so the
# banner re-creates them — the standard esbuild-ESM-for-Node recipe — for
# the bundled code + the externalized CJS deps below.
#
# The banner, native-package list, and shared optional externals are sourced
# from the development-host recipe so a host-graph change cannot silently
# leave the packaged sidecar with a different esbuild boundary.
source "$WEB_DIR/bin/bundle-host-common.sh"
# bundle_host_workers is CALLED by this orchestrator script, so an older frozen target whose
# helper predates it must get the orchestrator's copy (EI-21078401508503033, WI-10003497).
# shellcheck source=lib/host-worker-bundler.sh
source "$HERE/lib/host-worker-bundler.sh"
papercusp_ensure_host_worker_bundler "$HERE/../../apps/operator/bin/bundle-host-common.sh" || exit 1
HOST_EXTERNALS=(
  "${HOST_COMMON_EXTERNALS[@]}"

  # @embedded-postgres/<platform> — `embedded-postgres/dist/binary.js` does
  # `import('@embedded-postgres/<plat>')` for EVERY platform, but only the host's
  # own (linux-x64) is installed, so esbuild can't resolve the others and the
  # bundle fails. Externalize ONLY the non-host platforms; linux-x64 MUST stay
  # bundled — host.mjs imports it at runtime (the operator's embedded-PG discovery
  # path), and externalizing it makes host.mjs crash at boot with
  # ERR_MODULE_NOT_FOUND (it's not resolvable next to the standalone host.mjs).
  --external:@embedded-postgres/darwin-arm64
  --external:@embedded-postgres/darwin-x64
  --external:@embedded-postgres/linux-arm
  --external:@embedded-postgres/linux-arm64
  --external:@embedded-postgres/linux-ia32
  --external:@embedded-postgres/linux-ppc64
  --external:@embedded-postgres/windows-x64
  --external:@papercusp/embedded-postgres-server
)
for np in "${NATIVE_PKGS[@]}"; do HOST_EXTERNALS+=( "--external:$np" ); done
# esbuild pinned to 0.25.x — the repo's hoisted esbuild is 0.17.x, which
# predates `with { type: 'json' }` import-attribute support (the host graph
# imports a plugin JSON schema that way). Verified 2026-05-21: 0.25.0
# bundles the full host graph clean (17.5MB host.mjs, valid ESM) with the
# externals below — esbuild inlines workspace + hoisted deps alike, so the
# monorepo dep-hoist is a non-issue.
# --define:__PAPERCUSP_BUNDLED_SIDECAR__=true (EI-650): in this single-file
# bundle EVERY inlined module shares ONE import.meta.url (serve.mjs's own),
# which equals process.argv[1] — so a library-CLI's naive self-exec guard
# (`import.meta.url === pathToFileURL(process.argv[1]).href` and the
# `file://${process.argv[1]}` / `fileURLToPath(import.meta.url) === argv[1]`
# spellings) fires for EVERY bundled CLI at boot, each running main()+
# process.exit() and killing the operator before it serves. The CJS
# `require.main === module` idiom is already neutralised by the dummy `module`
# in HOST_BANNER; this define is the symmetric fix for the ESM idiom — library
# CLIs guard with isCliEntry() (operator-core/lib/util/cli-entry.ts), which
# returns false when this define is present, so only the real entry (serve.ts,
# which does NOT use the helper) boots.
# --define:process.env.PAPERCUP_DOGFOOD_REPO_REF (clone-progress + version-pin):
# bake the release's monorepo ref so the shipped app's `papercusp` dogfood hive
# clones the EXACT version the binary was built from (bootstrap-papercusp-hive's
# dogfoodRef() reads process.env.PAPERCUP_DOGFOOD_REPO_REF). release-local.sh
# exports it (= the release tag) + tags the monorepo. Unset (a plain dev sidecar
# build) bakes "" → the bootstrap falls back to the remote default branch (main).
# VERSION_DEFINE_ARGS (WI-2644 / EI-18751304112302229) — TWO defines for the
# real shipped version (read from tauri.conf.json above): the literal
# --define:process.env.npm_package_version reaches any call site that writes
# that exact expression directly (e.g. onboarding-launch-context.ts's
# `appVersion`); --define:__PAPERCUSP_SIDECAR_VERSION__ reaches build-info.ts,
# which reads through an injectable-seam alias esbuild's syntactic --define
# cannot see through — so build-info.ts's health endpoint + serve.ts's own
# VERSION const (which reads getBuildInfo()) report the actual installed
# version instead of their unset-env fallback ('0.0.0'). Empty
# VERSION_DEFINE_ARGS when unreadable (plain dev run outside this script) →
# both call sites keep their existing
# npm_package_version / '0.0.0' fallback, unchanged from today.
# --minify-whitespace + --minify-syntax (deliberately NOT --minify-identifiers):
# strip comments/whitespace and apply safe syntax compaction on every bundle.
# We do NOT rename identifiers — DBOS registers workflows/steps by function name
# (fn.name) and some runtime lookups key on class/function names, so
# identifier-mangling risks breaking workflow registration/recovery. Whitespace +
# syntax alone cut serve.mjs ~49MB→~35MB with zero behaviour change
# (install-size-audit 2026-07-07, owner-directed). Full --minify would save a
# further ~6MB but is left out for that name-dependency risk.
MINIFY_ARGS=(--minify-whitespace --minify-syntax)
(cd "$WEB_DIR" && npx --yes esbuild@0.25.0 bin/serve.ts \
  --bundle --platform=node --format=esm --target=node22 \
  "${MINIFY_ARGS[@]}" \
  --outfile="$SIDECAR_DIR/serve.mjs" \
  --banner:js="$HOST_BANNER" \
  --define:__PAPERCUSP_BUNDLED_SIDECAR__=true \
  --define:process.env.PAPERCUP_DOGFOOD_REPO_REF="\"${PAPERCUP_DOGFOOD_REPO_REF:-}\"" \
  --define:process.env.PAPERCUP_DOGFOOD_POT_PUBKEY="\"${PAPERCUP_DOGFOOD_POT_PUBKEY:-${PAPERCUP_DOGFOOD_HIVE_PUBKEY:-}}\"" \
  --define:process.env.PAPERCUP_DOGFOOD_POT_INVITE_SECRET="\"${PAPERCUP_DOGFOOD_POT_INVITE_SECRET:-${PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET:-}}\"" \
  "${VERSION_DEFINE_ARGS[@]}" \
  "${HOST_EXTERNALS[@]}")
if [[ ! -f "$SIDECAR_DIR/serve.mjs" ]]; then
  echo "ERROR: esbuild did not produce $SIDECAR_DIR/serve.mjs"
  exit 1
fi

# git-ext-bridge.mjs — the pot-git `ext::` transport helper (fetch-transport.ts
# resolves it as a SIBLING of the running entry: dirname(import.meta.url), which
# in the bundled sidecar is serve.mjs's own dir). git execs it as an external
# on-disk node script, so it can never be inlined into the bundle — without this
# copy every packaged desktop's hive-git fetch (G-8 bootstrap / G-2 transport)
# dies "Cannot find module .../git-ext-bridge.mjs" (live-caught on the P-302
# rig, WI-3496). Pure node:net, no deps — a straight copy is the whole ship.
cp "$REPO_ROOT/packages/operator-core/lib/sync/pot-git/git-ext-bridge.mjs" "$SIDECAR_DIR/git-ext-bridge.mjs"
if [[ ! -f "$SIDECAR_DIR/git-ext-bridge.mjs" ]]; then
  echo "ERROR: failed to stage git-ext-bridge.mjs next to serve.mjs"
  exit 1
fi

# systemd-scope-env-runner.mjs — systemd-scope.ts resolves this dependency-free
# payload runner as a SIBLING of its executing module.  In the bundled desktop
# every operator-core module collapses into serve.mjs, so the path resolves to
# $SIDECAR_DIR/systemd-scope-env-runner.mjs rather than back into the source
# tree.  Missing it is not a slow fallback: every systemd-confined capability,
# task-manager and agent launch fails with MODULE_NOT_FOUND after systemd has
# already accepted the unit.  Stage it as a required runtime asset and fail the
# build if the source/copy is absent (EI-21306004866205635).
SYSTEMD_ENV_RUNNER_SRC="$REPO_ROOT/packages/operator-core/lib/systemd-scope-env-runner.mjs"
if [[ ! -f "$SYSTEMD_ENV_RUNNER_SRC" ]]; then
  echo "ERROR: systemd scope environment runner not found at $SYSTEMD_ENV_RUNNER_SRC"
  exit 1
fi
cp "$SYSTEMD_ENV_RUNNER_SRC" "$SIDECAR_DIR/systemd-scope-env-runner.mjs"
if [[ ! -f "$SIDECAR_DIR/systemd-scope-env-runner.mjs" ]]; then
  echo "ERROR: failed to stage systemd-scope-env-runner.mjs next to serve.mjs"
  exit 1
fi
echo "    ✓ staged systemd-scope-env-runner.mjs next to serve.mjs"

# Required workers are shared with the host and current-build rig.
bundle_host_workers "$REPO_ROOT" "$SIDECAR_DIR" || exit 1

# opusscript_native_wasm.wasm (EI-501) — the SAME dirname(import.meta.url)
# gotcha as git-ext-bridge.mjs above, one layer deeper: esbuild INLINES
# opusscript's JS shim (voice-node/codec.ts's lazy `import('opusscript')`) into
# serve.mjs like any other pure-JS dep, but that shim's Emscripten wasm loader
# reads its binary asset off `__dirname + "/opusscript_native_wasm.wasm"` at
# RUNTIME (node_modules/opusscript/build/opusscript_native_wasm.js) — and in
# this bundle every inlined module shares serve.mjs's own
# `__dirname`/`import.meta.url` (the HOST_BANNER above), so it looks for the
# .wasm right next to serve.mjs, not inside node_modules/opusscript/build/.
# esbuild has no way to see that runtime fs read (same reason rrule/luxon need
# an explicit copy below) — the .wasm is a pure BINARY ASSET, un-inlinable
# regardless. Without this copy the packaged app hard-aborts the moment
# anything touches the voice/Opus codec seam: "Aborted(Error: ENOENT: no such
# file or directory, open '.../sidecar/opusscript_native_wasm.wasm')".
echo "→ copying opusscript_native_wasm.wasm → $SIDECAR_DIR (EI-501)"
_opus_wasm=""
for base in "$WEB_DIR/node_modules" "$REPO_ROOT/node_modules" "$ROOT/node_modules"; do
  cand="$base/opusscript/build/opusscript_native_wasm.wasm"
  [[ -f "$cand" ]] && { _opus_wasm="$cand"; break; }
done
if [[ -z "$_opus_wasm" ]]; then
  echo "ERROR: opusscript_native_wasm.wasm not found in any node_modules — voice/Opus would hard-abort in the packaged app (EI-501)"
  exit 1
fi
cp "$_opus_wasm" "$SIDECAR_DIR/opusscript_native_wasm.wasm"
if [[ ! -f "$SIDECAR_DIR/opusscript_native_wasm.wasm" ]]; then
  echo "ERROR: failed to stage opusscript_native_wasm.wasm next to serve.mjs (EI-501)"
  exit 1
fi

echo "→ esbuild-bundling packaged MCP proxy → $SIDECAR_DIR/mcp-proxy.mjs"
(cd "$WEB_DIR" && npx --yes esbuild@0.25.0 bin/mcp-proxy.ts \
  --bundle --platform=node --format=esm --target=node22 \
  "${MINIFY_ARGS[@]}" \
  --outfile="$SIDECAR_DIR/mcp-proxy.mjs" \
  --banner:js="$HOST_BANNER")
if [[ ! -f "$SIDECAR_DIR/mcp-proxy.mjs" ]]; then
  echo "ERROR: esbuild did not produce $SIDECAR_DIR/mcp-proxy.mjs"
  exit 1
fi

# psu + ptool — the superuser CLI launcher and the defineTool CLI. Ship them in
# the runtime so an end user can open a superuser agent session from the app
# (psu-in-desktop-builds-2026-06-23 A1). esbuild-bundles each into a
# SELF-CONTAINED ESM file the SAME way serve.mjs is built: @inquirer/prompts
# (the picker) and @modelcontextprotocol/sdk (ptool's transport) are inlined, so
# the shipped runtime needs NO operator node_modules tree for them. node-pty is
# the only external — psu-pty-host.mjs `require()`s @lydell/node-pty LAZILY (only
# on the pty-host path), so it resolves from sidecar/node_modules at runtime just
# like serve.mjs, and the common launch path never touches it.
#
# Two deliberate differences from the serve.mjs recipe:
#   * NO --define:__PAPERCUSP_BUNDLED_SIDECAR__=true. That define makes
#     isCliEntry() return false to stop inlined library-CLIs self-exec'ing inside
#     serve.mjs. psu/ptool ARE the real entrypoints — they MUST run main() when
#     invoked, so the define must be absent.
#   * Only --external:@lydell/* (psu/ptool don't pull the holepunch native stack).
# The ~/.papercusp/bin/{psu,ptool} shims that `exec node` these are written on
# boot by installPapercuspFiles() (papercup CLAUDE.md desktop-install path; A2).
echo "→ esbuild-bundling psu + ptool + onboard + tutorial-runner + project-history → $SIDECAR_DIR/scripts/"
mkdir -p "$SIDECAR_DIR/scripts"
# pairs of <output-name>:<source-stem> (source lives at $WEB_DIR/scripts/<stem>.mjs)
# onboard = the onboarding/tutorial concierge (agent-first-onboarding P-014):
# shipped so the deb postinst can expose `papercusp onboard|tutorial` + the
# Papercusp Tutorial desktop icon.
# tutorial-runner = the DETERMINISTIC tutorial the concierge launches at handoff
# (deterministic-onboarding-tutorial-2026-07-04 P-006/P-008). MUST ship next to
# onboard.mjs: the concierge resolves it via `new URL('./tutorial-runner.mjs',
# import.meta.url)`, so the output name MUST stay `tutorial-runner`. Without it a
# packaged build silently falls back to the agentic tutor.
for _psu_cli in psu:psu-launcher ptool:ptool onboard:onboard-launcher tutorial-runner:tutorial-runner; do
  _psu_out="${_psu_cli%%:*}"
  _psu_src="${_psu_cli##*:}"
  if [[ ! -f "$WEB_DIR/scripts/$_psu_src.mjs" ]]; then
    echo "ERROR: $WEB_DIR/scripts/$_psu_src.mjs not found — psu cannot ship"
    exit 1
  fi
  (cd "$WEB_DIR" && npx --yes esbuild@0.25.0 "scripts/$_psu_src.mjs" \
    --bundle --platform=node --format=esm --target=node22 \
    "${MINIFY_ARGS[@]}" \
    --outfile="$SIDECAR_DIR/scripts/$_psu_out.mjs" \
    --banner:js="$HOST_BANNER" \
    "--external:@lydell/*")
  if [[ ! -f "$SIDECAR_DIR/scripts/$_psu_out.mjs" ]]; then
    echo "ERROR: esbuild did not produce $SIDECAR_DIR/scripts/$_psu_out.mjs"
    exit 1
  fi
done

# The bundled psu entrypoint loads these as runtime file URLs (not static
# imports), so esbuild cannot inline or trace them. Keep them adjacent to
# scripts/psu.mjs: resolveNativeMcpAssets() prefers this relocatable packaged
# layout and falls back to packages/omp-plugin/dist only in a source checkout.
NATIVE_MCP_DIST="$REPO_ROOT/packages/omp-plugin/dist"
for native_mcp_asset in native-client.cjs native-extension.mjs; do
  [[ -s "$NATIVE_MCP_DIST/$native_mcp_asset" ]] || {
    echo "ERROR: required OMP native MCP asset missing after runtime build: $NATIVE_MCP_DIST/$native_mcp_asset" >&2
    exit 1
  }
  cp -a "$NATIVE_MCP_DIST/$native_mcp_asset" "$SIDECAR_DIR/scripts/$native_mcp_asset"
  [[ -s "$SIDECAR_DIR/scripts/$native_mcp_asset" ]] || {
    echo "ERROR: failed to stage OMP native MCP asset: $SIDECAR_DIR/scripts/$native_mcp_asset" >&2
    exit 1
  }
done

# Project History is a Papercusp platform CLI, not an operator-host concern.
# Bundle its narrow entry directly from @papercusp/cli so installed projects can
# generate the versioned read model without a monorepo checkout or tsx. The
# shared ESM banner is load-bearing: plan-parser reaches yaml's CJS path, whose
# dynamic require otherwise fails only in the packaged bundle.
_project_history_src="$REPO_ROOT/libs/papercusp/packages/cli/src/project-history-entry.ts"
if [[ ! -f "$_project_history_src" ]]; then
  echo "ERROR: $_project_history_src not found — project-history cannot ship"
  exit 1
fi
(cd "$WEB_DIR" && npx --yes esbuild@0.25.0 "$_project_history_src" \
  --bundle --platform=node --format=esm --target=node22 \
  "${MINIFY_ARGS[@]}" \
  --outfile="$SIDECAR_DIR/scripts/project-history.mjs" \
  --banner:js="$HOST_BANNER")
if [[ ! -f "$SIDECAR_DIR/scripts/project-history.mjs" ]]; then
  echo "ERROR: esbuild did not produce $SIDECAR_DIR/scripts/project-history.mjs"
  exit 1
fi
echo "  bundled psu.mjs + ptool.mjs + OMP native MCP assets + onboard.mjs + tutorial-runner.mjs + project-history.mjs"

# Copy the externalized native deps. esbuild inlined everything else, so
# this is a tiny tree — node-pty + its platform-binary sub-package(s).
# Search every node_modules the monorepo might have hoisted them into.
echo "→ copying externalized native deps (node-pty) into the sidecar"
npt_count=0
for base in "$WEB_DIR/node_modules" "$REPO_ROOT/node_modules" "$ROOT/node_modules"; do
  for nptdir in "$base/@lydell"/node-pty*; do
    [[ -d "$nptdir" ]] || continue
    name="$(basename "$nptdir")"
    [[ -e "$SIDECAR_DIR/node_modules/@lydell/$name" ]] && continue
    cp -aL "$nptdir" "$SIDECAR_DIR/node_modules/@lydell/$name"
    npt_count=$((npt_count + 1))
  done
done
echo "  copied $npt_count node-pty package(s)"
if [[ "$npt_count" -eq 0 ]]; then
  echo "ERROR: node-pty not found in any node_modules — the pty terminal routes will crash"
  exit 1
fi

# Copy the externalized hypercore/holepunch native packages — WITH their full
# runtime dependency closure (require-addon, streamx, b4a, compact-encoding, …)
# — into the bundle. esbuild inlines the host's own JS, but the externalized
# native packages resolve their deps from node_modules at runtime, so the whole
# closure must be present or host.mjs crashes ("Cannot find module
# 'require-addon'"). BFS each native package's package.json `dependencies`.
echo "→ copying externalized native deps + their dependency closure into the sidecar"
nat_copied=0; nat_missing=0
# Visited-set keyed by RESOLVED SOURCE PATH, not package name. Different versions
# of one package legitimately coexist at different npm topology positions (for
# example top-level posthog-node@5.x and lost-pixel's nested posthog-node@3.5.0).
# A name-keyed set skips the nested manifest and therefore its unique runtime
# dependencies. Keep the delimiter-string shape instead of `declare -A`: macOS
# ships bash 3.2 (no associative arrays) and this script runs on the mac build VM.
_seen="|"
# The bare-*/holepunch native packages (bare-type, bare-fs, bare-os, …) ship
# npm-published prebuilds for EVERY platform they support — not just desktop
# (linux/darwin/win32) but android-{ia32,arm,arm64,x64} and ios-{arm64,x64}
# simulator variants too, each a real Android/iOS ELF/Mach-O binary. A plain
# `cp -a` brings all of them, which (a) bloats the sidecar ~13x over what one
# platform needs, and (b) breaks Linux AppImage bundling outright: linuxdeploy
# walks every ELF file under the AppDir resolving shared-library deps via ldd,
# and chokes on the Android prebuilds — `ERROR: Could not find dependency:
# libm.so` (Android's bionic libc has no standalone libm.so; the symbol is
# folded into libc.so) — which aborts the whole `tauri build --bundles
# appimage` (WI-807). Prune every closure-copied package's `prebuilds/`
# down to just this build host's platform-arch dir immediately after copying.
# WI-5651: prune to the TARGET platform-arch (default host), NOT $(uname) — so a
# cross-baked darwin/windows bundle KEEPS the target's prebuilds and drops this
# Linux host's. Prebuild dirs use node's process.platform spelling (`win32`), so
# map windows→win32 here (TARGET_OS uses the `windows` spelling elsewhere).
case "$TARGET_OS" in
  windows) _bare_node_platform="win32" ;;
  *)       _bare_node_platform="$TARGET_OS" ;;
esac
_bare_node_arch="$TARGET_ARCH"
# WI-5651: fetch a single per-platform npm package that npm WON'T install on this
# host because it is an optionalDependency scoped to a DIFFERENT platform (e.g.
# @img/sharp-darwin-x64 while building on linux). `npm pack` downloads the tarball
# for ANY platform regardless of the host, so a cross-baked darwin/windows sidecar
# can pull the exact @scope/pkg@version the target needs and unpack it where the
# closure/embedded-pg install would have placed it. ALWAYS pass an explicit
# @version (the `%@*` name-strip below assumes one). Idempotent; fails loud.
fetch_cross_npm_pkg() {
  local spec="$1" nm_dir="$2"
  local pkg_name="${spec%@*}"            # @img/sharp-darwin-x64@0.35.3 → @img/sharp-darwin-x64
  local dest="$nm_dir/$pkg_name"
  [[ -e "$dest/package.json" ]] && { echo "    ✓ $pkg_name already present — skip cross-fetch"; return 0; }
  local tmp; tmp="$(mktemp -d)"
  if ! ( cd "$tmp" && npm pack "$spec" --silent >/dev/null 2>&1 ); then
    echo "ERROR: npm pack '$spec' failed (cross-fetch of a per-platform pkg)"; rm -rf "$tmp"; return 1
  fi
  local tgz; tgz="$(ls "$tmp"/*.tgz 2>/dev/null | sed -n 1p)"
  [[ -f "$tgz" ]] || { echo "ERROR: npm pack '$spec' produced no tarball"; rm -rf "$tmp"; return 1; }
  mkdir -p "$dest"
  if ! tar -xzf "$tgz" -C "$dest" --strip-components=1; then
    echo "ERROR: extracting '$spec' tarball failed"; rm -rf "$tmp"; return 1
  fi
  rm -rf "$tmp"
  echo "    ✓ cross-fetched $pkg_name → ${dest#"$SIDECAR_DIR/"}"
}
# Read an exact pinned version from a package's optionalDependencies map (npm pins
# @img/* and @lydell/* platform packages to an EXACT version there, so we fetch the
# ABI-matched build instead of `latest`, which could drift ahead of the JS pkg).
opt_dep_version() {
  local pkg_json="$1" dep="$2"
  node -e "try{const d=require('$pkg_json').optionalDependencies||{};process.stdout.write(String(d['$dep']||''))}catch(e){}" 2>/dev/null
}
prune_foreign_prebuilds() {
  local pkg_dir="$1"
  [[ -d "$pkg_dir/prebuilds" && -n "$_bare_node_platform" && -n "$_bare_node_arch" ]] || return 0
  local keep="${_bare_node_platform}-${_bare_node_arch}"
  local pd pd_name pruned=0
  for pd in "$pkg_dir/prebuilds"/*/; do
    [[ -d "$pd" ]] || continue
    pd_name="$(basename "$pd")"
    [[ "$pd_name" == "$keep" ]] && continue
    rm -rf "$pd"
    pruned=$((pruned+1))
  done
  [[ $pruned -gt 0 ]] && echo "  ✂ $(basename "$pkg_dir"): pruned $pruned foreign-platform prebuilds/ dir(s), kept $keep"
}
# onnxruntime-node does NOT use the prebuilds/<platform>-<arch>/ convention above:
# it ships bin/napi-v6/<platform>/<arch>/{onnxruntime_binding.node,libonnxruntime.so}
# for all 5 platforms (211M). A plain closure-copy therefore (a) bloats the sidecar
# ~6x over what one platform needs, and (b) re-arms WI-807: linuxdeploy ldd-walks
# every ELF under the AppDir and chokes on the foreign-arch linux/arm64 .so, aborting
# `tauri build --bundles appimage`. Same remedy as prune_foreign_prebuilds, different
# layout. (P-009.)
prune_foreign_onnx_bins() {
  local pkg_dir="$1"
  [[ -d "$pkg_dir/bin/napi-v6" && -n "$_bare_node_platform" && -n "$_bare_node_arch" ]] || return 0
  local pd pd_name pruned=0
  for pd in "$pkg_dir/bin/napi-v6"/*/; do
    [[ -d "$pd" ]] || continue
    pd_name="$(basename "$pd")"
    if [[ "$pd_name" != "$_bare_node_platform" ]]; then
      rm -rf "$pd"; pruned=$((pruned+1)); continue
    fi
    # keep this platform, drop its foreign ARCH subdirs
    local ad ad_name
    for ad in "$pd"*/; do
      [[ -d "$ad" ]] || continue
      ad_name="$(basename "$ad")"
      [[ "$ad_name" == "$_bare_node_arch" ]] && continue
      rm -rf "$ad"; pruned=$((pruned+1))
    done
  done
  [[ $pruned -gt 0 ]] && echo "  ✂ $(basename "$pkg_dir"): pruned $pruned foreign onnx bin dir(s), kept ${_bare_node_platform}/${_bare_node_arch}"
  return 0
}
# The KEPT platform/arch dir from the prune above still ships ONNX Runtime's GPU
# EXECUTION PROVIDERS — and on linux/x64 that is the single largest file in the
# entire sidecar:
#     libonnxruntime_providers_cuda.so      301M   ← dead weight, on every install
#     libonnxruntime_providers_tensorrt.so  835K   ← same
#     libonnxruntime_providers_shared.so     14K   ← KEEP: the EP-registration shim
#
# Dead weight because nothing in this product ever constructs a GPU session, and
# that is a DECISION, not an oversight:
#   • the embedder is CPU-only ON PURPOSE (EI-19363236885307403). Shipping the
#     provider actively makes CUDA *look* available — it then fails at pipeline
#     construction on `libcudnn.so.9: cannot open shared object file`, because
#     cuDNN 9 is absent and Ubuntu's apt only offers cuDNN 8. See the long note in
#     libs/generic/memory/src/local-embedder-worker.script.mjs.
#   • the one component that CAN target a GPU — the local reranker — is opt-IN
#     (PAPERCUSP_RERANK_DEVICE) *and* verified-load: a provider that fails to
#     construct falls back to the CPU pair (libs/generic/rerank/src/local-engine.ts,
#     `_gpuUnusable` → CPU_EXECUTION_TARGET).
#
# So removing these .so files removes no capability. It swaps one failing provider
# load for another on the SAME already-exercised fallback path, and stops us
# shipping 301M to every user that could never execute on their machine. (WI-38682.)
prune_onnx_gpu_providers() {
  local pkg_dir="$1"
  [[ -d "$pkg_dir/bin/napi-v6" ]] || return 0
  local f freed_kb=0 pruned=0
  while IFS= read -r -d '' f; do
    freed_kb=$(( freed_kb + ( $(stat -c %s "$f" 2>/dev/null || echo 0) / 1024 ) ))
    rm -f "$f"
    pruned=$((pruned+1))
  done < <(find "$pkg_dir/bin/napi-v6" -type f \( \
             -name 'libonnxruntime_providers_cuda.*' -o \
             -name 'libonnxruntime_providers_tensorrt.*' \) -print0 2>/dev/null)
  [[ $pruned -gt 0 ]] && echo "  ✂ $(basename "$pkg_dir"): pruned $pruned GPU execution provider(s), $((freed_kb / 1024))MB (CPU-only by design, EI-19363236885307403)"
  return 0
}
# The backstop for the prune above. prune_onnx_gpu_providers runs PER PACKAGE inside
# the closure walk, so it only ever sees what that walk brought in. Anything that puts
# a GPU provider back into the assembled tree AFTERWARDS would ship hundreds of MB of
# dead weight with nothing failing and no line in the log — a new dependency vendoring
# its own onnxruntime copy, an onnxruntime-node bump adding a provider we do not know
# about, or the prune silently not running because its call site was dropped in a
# refactor. So this scans the ASSEMBLED tree and refuses to build.
#
# Deliberately an ALLOWLIST rather than a denylist of known-bad names: a provider
# nobody has seen before is exactly the case that must stop the line instead of
# shipping silently, and a denylist cannot catch one. libonnxruntime_providers_shared
# (14K) is the EP-registration shim and is REQUIRED — everything else is a GPU
# execution provider this product never constructs a session for. (WI-38682.)
assert_no_onnx_gpu_providers() {
  local root="$1"
  local _gpu_eps="" _ep
  [[ -d "$root" ]] || return 0
  while IFS= read -r -d '' _ep; do
    case "$(basename "$_ep")" in
      libonnxruntime_providers_shared.*) continue ;;
    esac
    _gpu_eps+="         $(( $(stat -c %s "$_ep" 2>/dev/null || echo 0) / 1048576 ))MB  ${_ep#"$root"/}"$'\n'
  done < <(find "$root" -type f -name 'libonnxruntime_providers_*' -print0 2>/dev/null)
  [[ -z "$_gpu_eps" ]] && return 0
  echo "ERROR: ONNX GPU execution provider(s) survived sidecar staging (WI-38682):" >&2
  printf '%s' "$_gpu_eps" >&2
  echo "       This product never constructs a GPU session, so these can never execute on a" >&2
  echo "       user's machine — they are pure install-size bloat. The embedder is CPU-only BY" >&2
  echo "       DESIGN (EI-19363236885307403) and the reranker's GPU path is opt-in AND" >&2
  echo "       verified-load with a CPU fallback, so nothing here is a capability regression." >&2
  echo "       • New provider from an onnxruntime-node bump? Add it to prune_onnx_gpu_providers()." >&2
  echo "       • Vendored by a new dependency? Prune it at the source, like the closure walk does." >&2
  echo "       • Genuinely intend to ship GPU execution? That is a real product decision — make" >&2
  echo "         it deliberately (and it needs the cuDNN 9 story solved first, see the note in" >&2
  echo "         libs/generic/memory/src/local-embedder-worker.script.mjs)." >&2
  return 1
}
# The two owner-confirmed transformers models are intentionally preserved above,
# but model downloaders can leave large `*.tmp.*`, `*.partial`, or `*.part`
# fragments beside the finished ONNX data files after an interrupted download.
# Those fragments are not model bytes and must never cross the assembled-sidecar
# boundary (EI-21121880496840788 / P-008).
# Takes the directory CONTAINING `onnx-community/`. Since D-178 that is the
# package's `models/` dir, not its `.cache/` — the layout beneath is identical,
# so this function is unchanged apart from what it is pointed at.
prune_transformers_model_fragments() {
  local models_root="$1"
  local model_dir
  [[ -d "$models_root/onnx-community" ]] || return 0
  for model_dir in \
    "$models_root/onnx-community/harrier-oss-v1-0.6b-ONNX" \
    "$models_root/onnx-community/embeddinggemma-300m-ONNX"; do
    [[ -d "$model_dir" ]] || continue
    find "$model_dir" -type f \( \
      -name '*.tmp.*' -o -name '*.partial' -o -name '*.part' \
    \) -delete
  done
  return 0
}
# Backstop the source prune by scanning the assembled model tree (the package's
# `models/` dir since D-178).  This is deliberately fail-closed: a future
# downloader/layout change must stop the build rather than silently shipping
# another multi-hundred-MiB fragment set.
assert_no_transformers_model_fragments() {
  local models_root="$1"
  local fragments
  [[ -d "$models_root" ]] || return 0
  if ! fragments="$(find "$models_root" -type f \( \
    -name '*.tmp.*' -o -name '*.partial' -o -name '*.part' \
  \) 2>/dev/null)"; then
    echo "FATAL: unable to inspect the preserved transformers models for download fragments (EI-21121880496840788)" >&2
    return 1
  fi
  [[ -z "$fragments" ]] && return 0
  echo "FATAL: transformers model download fragment(s) survived sidecar staging — these temporary files must never ship (EI-21121880496840788):" >&2
  echo "$fragments" >&2
  return 1
}
# ── Derived privacy/scratch excludes for the tree copiers (WI-4419, D-178) ────
#
# `bin/stage-source-tree.sh` does not hand-maintain its exclude list: it asks
# `audit-release-bundle.py --tar-excludes` for it, so THE EXCLUDE AND THE GATE
# THAT CATCHES A MISSED EXCLUDE COME FROM ONE RULE. The tree copiers below
# (harness, templates, rubrics, goal-packages) predate that principle and each
# hand-rolled two or three `find` prunes instead, which is how the r12 bundle
# shipped 14 findings the gate already had patterns for:
#
#   */.vite  */junit.xml  */.vitest-tmp  */*.test.ts  */sshcrypto.node
#
# Every one of those was ALREADY emitted by --tar-excludes. Nothing was missing
# from the staging allowlist; these copiers simply never consulted it. Worse,
# their `-not -path "./node_modules/*"` prune is anchored at the copied tree's
# ROOT, so a NESTED `templates/<tpl>/node_modules/` was never excluded at all.
#
# So route them through the SAME rule, in the SAME GNU-tar pattern dialect. Two
# properties are load-bearing and must survive any rewrite here:
#   1. `find -type f` — NOT `cp -a`/`tar` directory recursion. Symlinks are
#      skipped ON PURPOSE (the harness carries dev-time symlinks that dangle on
#      CI and break Tauri's resource bundler / `cp` on Windows).
#   2. `--no-recursion` — tar must archive exactly the enumerated files and not
#      re-expand a named directory, or property 1 is silently undone.
declare -a SIDECAR_TREE_EXCLUDES=()
load_sidecar_tree_excludes() {
  (( ${#SIDECAR_TREE_EXCLUDES[@]} > 0 )) && return 0
  local pat
  while IFS= read -r pat; do
    [[ -n "$pat" ]] && SIDECAR_TREE_EXCLUDES+=(--exclude="$pat")
  done < <(python3 "$HERE/audit-release-bundle.py" --tar-excludes)
  if (( ${#SIDECAR_TREE_EXCLUDES[@]} == 0 )); then
    echo "ERROR: audit-release-bundle.py --tar-excludes returned nothing — refusing to copy an UNFILTERED tree into the sidecar (WI-4419)" >&2
    exit 1
  fi
  # GNU tar REQUIRED: bsdtar's --exclude anchoring dialect differs subtly, which
  # would be a silent-content bug rather than a loud one (same reason
  # stage-source-tree.sh asserts this).
  if ! tar --version 2>/dev/null | sed -n 1p | grep -ci 'gnu tar' >/dev/null; then
    echo "ERROR: GNU tar required for filtered sidecar tree copies (macOS: brew install gnu-tar)" >&2
    exit 1
  fi
  echo "    tree-copy excludes: ${#SIDECAR_TREE_EXCLUDES[@]} patterns (derived from the gate's rules)"
}
# ⚠ THE EXCLUDE SET IS NOT UNIFORMLY APPLICABLE — one class needs an exemption.
#
# `--tar-excludes` emits raw globs; it does NOT encode the per-rule exemptions the
# auditor applies when it JUDGES a bundle. There is exactly one that matters here.
# `phase_a_paths()` skips a `test-files` hit when the member sits under
# VM_RELEASE_ASSET_ALLOWLIST:
#
#     if (rule == "test-files" and _vm_release_asset_allowed(...)): continue
#     # "Product templates intentionally ship their own source, checks and
#     #  fixtures: those are materialized into a NEW app…"
#
# So `templates/` and `rubrics/` legitimately SHIP their `*.test.ts` — a
# materialized app is supposed to arrive with its checks. Applying the test/spec
# patterns to those two trees would silently delete 26 product files the gate has
# no objection to (measured against the r12 member list). Pass `keep_product_tests`
# for a tree the auditor exempts; every other tree gets the full set, so an
# implementation test still cannot leak from harness/ or goal-packages/.
#
# This is the THIRD time in this release that a correct blanket rule turned out to
# be wrong for one deliberate case (the other two: the transformers `.cache/`
# models, D-177/D-178). Hence the drift guard below rather than a bare comment.
# ⚠ THE GUARD BELOW FIRED FOR REAL, AND ITS ORIGINAL PRESCRIPTION WAS THE WRONG
# REPAIR (WI-2147397). Recording why, because the next drift will look identical.
#
# P-309 moved `templates/` and `rubrics/` OUT of VM_RELEASE_ASSET_ALLOWLIST and INTO
# VM_RELEASE_CUPBOARD_CONTENT_ROOTS — those trees are now installed into persistent
# machine-local state by the Cupboard bundle before service start. The guard saw the
# allowlist miss, hard-exited, and told the reader to "drop keep_product_tests". That
# is a no-op for the audit and a regression for the product:
#
#   * A cupboard-content root is forbidden in the vm-release as a WHOLE root —
#     `_vm_release_residue_class()` returns "cupboard-content" BEFORE the test-files
#     rule is ever consulted. Dropping the exemption changes that verdict not at all.
#   * It deletes 26 real product files: every `templates/*/checks/*.test.ts`, i.e.
#     exactly the checks a materialized app is supposed to arrive with. (Measured
#     2026-09-11: 26 matches under templates/, 0 under rubrics/.)
#
# So a root in EITHER list keeps its tests. The drift actually worth failing on is a
# root that leaves BOTH — only then does the test-files rule judge its members, and
# only then must `keep_product_tests` go.
#
# Membership is read from the auditor's real tuples via `ast`, not grepped as text: a
# bare `grep -F '"templates",'` cannot tell the two lists apart (the allowlist spells
# roots WITH a trailing slash, the cupboard list WITHOUT), and would happily match any
# unrelated tuple that mentions the same word.
assert_vm_release_asset_allowed() {
  local root="$1"
  local known
  known="$(python3 - "$HERE/audit-release-bundle.py" <<'PY'
import ast, sys

tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
want = {"VM_RELEASE_ASSET_ALLOWLIST", "VM_RELEASE_CUPBOARD_CONTENT_ROOTS"}
out = []
for node in tree.body:
    if isinstance(node, ast.Assign) and any(
        isinstance(t, ast.Name) and t.id in want for t in node.targets
    ):
        out += [str(v).rstrip("/") for v in ast.literal_eval(node.value)]
print("\n".join(out))
PY
)"
  # An unreadable auditor must FAIL, never silently exempt: an empty answer here is
  # "I could not tell", and treating it as a pass is how the test/spec excludes would
  # get suppressed for a tree that genuinely needs them.
  if [[ -z "$known" ]]; then
    echo "ERROR: could not read VM_RELEASE_ASSET_ALLOWLIST / VM_RELEASE_CUPBOARD_CONTENT_ROOTS from $HERE/audit-release-bundle.py — refusing to guess whether '$root' is still test-exempt (D-178)" >&2
    exit 1
  fi
  if ! printf '%s\n' "$known" | grep -cxF "${root%/}" >/dev/null; then
    echo "ERROR: '$root' is in NEITHER the auditor's VM_RELEASE_ASSET_ALLOWLIST nor its VM_RELEASE_CUPBOARD_CONTENT_ROOTS, so the test-files rule now judges its members — drop keep_product_tests for this tree (D-178)" >&2
    exit 1
  fi
}
# copy_tree_filtered <src> <dst> [keep_product_tests|--] [extra find predicates...]
# Enumerates regular files under <src> (honouring any extra `find` predicates the
# caller needs), then copies them to <dst> with the derived excludes applied.
copy_tree_filtered() {
  local src="$1" dst="$2" mode="$3"
  shift 3
  load_sidecar_tree_excludes
  local -a excludes=("${SIDECAR_TREE_EXCLUDES[@]}")
  if [[ "$mode" == "keep_product_tests" ]]; then
    local -a kept=() e
    for e in "${excludes[@]}"; do
      # Drop ONLY the test/spec class; every other derived pattern still applies.
      [[ "$e" == *".test."* || "$e" == *".spec."* || "$e" == *"__tests__"* ]] && continue
      kept+=("$e")
    done
    excludes=("${kept[@]}")
  fi
  local list
  list="$(mktemp "${TMPDIR:-/tmp}/papercusp-tree-copy.XXXXXX")"
  ( cd "$src" && find . -type f "$@" ) > "$list"
  if [[ ! -s "$list" ]]; then
    echo "ERROR: copy_tree_filtered enumerated ZERO files under $src — refusing to continue with an empty copy" >&2
    rm -f "$list"
    exit 1
  fi
  mkdir -p "$dst"
  # ⚠ ARGUMENT ORDER IS LOAD-BEARING. GNU tar treats --exclude as POSITIONAL: it
  # affects only the arguments that FOLLOW it, so `-T "$list" "${excludes[@]}"`
  # makes every single exclude inert. tar says so ("--exclude ‘X’ has no effect",
  # once per pattern) and then exits non-zero — but the failure is easy to
  # misread, because a caller that also prunes via `find` still LOOKS filtered.
  # That is how it first went in here: the templates tree came out with zero
  # `.vite` files (the find predicate had removed them) while the harness tree
  # kept 5 leaks, and only the second tree revealed the excludes were doing
  # nothing at all. Keep every option BEFORE `-T`.
  tar -C "$src" "${excludes[@]}" --no-recursion -c -f - -T "$list" \
    | tar -C "$dst" -xf -
  rm -f "$list"
}
# node-gyp SCAFFOLDING carries the build box's absolute paths — and therefore the
# owner's identity — into the shipped bundle (WI-4419). A compiled native module
# needs only its addon binary at build/Release/*.node; everything else node-gyp
# leaves behind (Makefile, binding.Makefile, config.gypi, *.target.mk, the
# Release/.deps/*.o.d dependency lists, obj.target/ objects) embeds
# /home/<user>/... literally. That is what failed the 0.0.13 identity gate: 22
# files across cpu-features/ and ssh2/, every one of them build residue with no
# runtime role.
#
# Prune it at the SOURCE — which is exactly what the gate demands ("prune the
# leaking file from the sidecar copy … never add an exclude here"), because the
# scan deliberately honors no path-exclude list. Runs in EVERY build, not just a
# release: a dev sidecar that differs structurally from the shipped one is how
# this class of leak hides until the release gate. Safe against the dev tree —
# the sidecar holds real COPIES (the closure walker cp's each package), and
# `find -type d` never follows a symlink, so a symlinked package is skipped.
# Vendored TEST FIXTURES have no runtime role, and they are where HOSTILE archives
# live: tar-fs ships test/fixtures/invalid.tar, a tar whose links deliberately
# escape the extraction root (it exists precisely to prove tar-fs rejects it). The
# WI-4419 identity scan correctly refuses to report CLEAN on bytes it could not
# read, so that one vendored fixture failed the 0.0.14 release at minute 22 of a
# 22-minute cut (WI-37620). audit-release-bundle.py now reads tars member-wise and
# is no longer stoppable by such a member — this prune is the other half: the junk
# should not be in what ships at all.
#
# Prune at the SOURCE, per the same doctrine as prune_gyp_build_intermediates
# ("never add an exclude here" — the scan honors no path-exclude list), and in
# EVERY build, so a dev sidecar never differs structurally from the shipped one.
#
# Deliberately NARROW: only `<pkg>/test|tests/fixtures`. A blanket `-name test`
# would also match a legitimately-named PACKAGE (node_modules/test), and a wrong
# prune breaks the app at runtime for a beta tester — far worse than shipping junk.
prune_vendored_test_fixtures() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  local d pruned=0
  while IFS= read -r -d '' d; do
    rm -rf "$d"
    pruned=$((pruned+1))
  done < <(find "$root" -type d \( \
             -path '*/node_modules/*/test/fixtures'  -o \
             -path '*/node_modules/*/tests/fixtures' -o \
             -path '*/node_modules/*/test/fixture'   \) -print0 2>/dev/null)
  [[ $pruned -gt 0 ]] && echo "  ✂ pruned $pruned vendored test-fixture dir(s) (WI-37620: no runtime role, and they carry deliberately-hostile archives)"
  return 0
}
prune_gyp_build_intermediates() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  local bd pruned=0
  while IFS= read -r -d '' bd; do
    rm -rf "$bd/Release/.deps" "$bd/Release/obj.target" "$bd/Release/obj" "$bd/deps"
    rm -f  "$bd/Makefile" "$bd/binding.Makefile" "$bd/config.gypi" "$bd"/*.mk "$bd"/gyp-*-tool
    find "$bd" \( -name '*.target.mk' -o -name '*.o.d' -o -name '*.gypi' \) -type f -delete 2>/dev/null || true
    pruned=$((pruned+1))
  done < <(find "$root" -type d -name build -path '*/node_modules/*' -print0 2>/dev/null)
  [[ $pruned -gt 0 ]] && echo "  ✂ pruned node-gyp build scaffolding from $pruned native-module build/ dir(s) (WI-4419: they embed build-box paths)"
  # ssh2's OPTIONAL native crypto accelerator. The scaffolding prune above
  # deliberately PRESERVES compiled `build/Release/*.node` addons (better-sqlite3
  # has no JS fallback and MUST ship), but this ONE addon has to go: node-gyp
  # compiles it here and the compiler bakes the build-box home path into a
  # .rodata __FILE__ string via an assert() macro. That is a CONTENT leak the
  # stager cannot redact (its scrub skips binaries) and the audit cannot attribute
  # (binary member), so removal is the only mechanism that reaches it — the
  # auditor says exactly this and emits `*/sshcrypto.node` in --tar-excludes.
  # It reached the r12 bundle because packages arrive here via `cp -aL`, which
  # consults no exclude list at all.
  #
  # Safe to drop: ssh2 wraps `require('.../sshcrypto.node')` in try/catch and
  # falls back to pure-JS crypto when it is absent
  # (node_modules/ssh2/lib/protocol/crypto.js). Scoped BY NAME on purpose.
  #
  # The durable class fix — noted as a follow-up in the auditor and NOT done here
  # — is to compile native addons with -ffile-prefix-map (or a neutral node-gyp
  # cache dir) so __FILE__ never captures the box path for ANY addon.
  if ! grep -qF '"ssh2-native-crypto-addon"' "$HERE/audit-release-bundle.py"; then
    echo "ERROR: the auditor no longer carries the ssh2-native-crypto-addon rule — re-check whether this prune is still required (D-178)" >&2
    exit 1
  fi
  local addon_pruned=0 addon
  while IFS= read -r -d '' addon; do
    rm -f "$addon"
    addon_pruned=$((addon_pruned+1))
  done < <(find "$root" -type f -name 'sshcrypto.node' -print0 2>/dev/null)
  [[ $addon_pruned -gt 0 ]] && echo "  ✂ pruned $addon_pruned ssh2 native crypto addon(s) (WI-4419: __FILE__ embeds the build-box path; ssh2 falls back to pure-JS crypto)"
  return 0
}
# Walks a package's dependency closure and copies each package into the sidecar.
#
# ⚠ It follows BOTH `dependencies` AND `optionalDependencies`, and it must:
# napi/node-gyp packages ship their PLATFORM BINARIES as optionalDependencies —
# that is the convention, not an edge case. sharp is the worst offender:
#     sharp --(optional)--> @img/sharp-linux-x64 --(optional)--> @img/sharp-libvips-linux-x64
# Every hop is optional, so a copier that walks only `dependencies` copies sharp's
# JavaScript and NONE of its native code. The result INSTALLS cleanly and then dies
# at boot with `Could not load the "sharp" module using the linux-x64 runtime` — which
# is exactly how 0.0.9 shipped dead on all three platforms. It survived every check
# because on a dev box the desktop app falls back to a :3070 operator that a beta
# tester does not have; the only thing that sees it is a real install on a clean
# machine. (sharp reaches us transitively via @huggingface/transformers / the ONNX
# voice stack.) Note the musl-strip further down already spoke of "@img/sharp-linuxmusl-*"
# arriving "as optional deps" — it was stripping packages that never got copied.
#
# Resolve a dependency from the package that REQUESTED it, following Node's
# node_modules ancestor search. Falling back to a top-level package by name is not
# equivalent: lost-pixel depends on its nested posthog-node@3.5.0, while this repo
# also carries top-level posthog-node@5.x. The old name-only lookup read 5.x's
# manifest, missed 3.5.0's rusha dependency, and produced a signed Server bundle
# that installed successfully but died on clean-machine boot.
resolve_pkg_source() {
  local pkg="$1" requester="${2:-}" probe parent candidate base
  if [[ -n "$requester" ]]; then
    probe="$requester"
    while :; do
      # Node does not probe node_modules/node_modules while ascending.
      if [[ "$(basename "$probe")" != "node_modules" ]]; then
        candidate="$probe/node_modules/$pkg"
        [[ -d "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
      fi
      parent="$(dirname "$probe")"
      [[ "$parent" != "$probe" ]] || break
      probe="$parent"
    done
  fi
  # Entrypoints have no requester. These are the same three install roots the
  # original copier searched, in the same precedence order.
  for base in "$WEB_DIR/node_modules" "$REPO_ROOT/node_modules" "$ROOT/node_modules"; do
    [[ -d "$base/$pkg" ]] && { printf '%s\n' "$base/$pkg"; return 0; }
  done
  return 1
}

# Preserve the source node_modules topology in the sidecar. This lets top-level
# and nested versions coexist at the exact paths Node will search at runtime.
pkg_dest_for_source() {
  local src="$1" base rel
  for base in "$WEB_DIR/node_modules" "$REPO_ROOT/node_modules" "$ROOT/node_modules"; do
    case "$src" in
      "$base"/*)
        rel="${src#"$base/"}"
        printf '%s\n' "$SIDECAR_DIR/node_modules/$rel"
        return 0
        ;;
    esac
  done
  echo "ERROR: resolved package source is outside every known node_modules root: $src" >&2
  return 1
}

# A queued row carries name + requesting source + optionality in parallel arrays.
# For optionalDependencies, NOT FOUND is the expected, correct outcome — npm only
# installs the packages matching THIS platform, so @img/sharp-darwin-arm64 is
# legitimately absent on Linux. A missing REQUIRED dep still warns and counts;
# the assembled-tree guard below then fails closed with the complete referrer list.
copy_pkg_closure() {
  local queue_names=("$1")
  local queue_requesters=("")
  local queue_optional=(0)
  while [[ ${#queue_names[@]} -gt 0 ]]; do
    local cur="${queue_names[0]}"
    local requester_src="${queue_requesters[0]}"
    local optional="${queue_optional[0]}"
    queue_names=("${queue_names[@]:1}")
    queue_requesters=("${queue_requesters[@]:1}")
    queue_optional=("${queue_optional[@]:1}")
    local src=""
    if ! src="$(resolve_pkg_source "$cur" "$requester_src")"; then
      # An optionalDep for another platform is SUPPOSED to be absent here — not a defect.
      [[ "$optional" == 1 ]] && continue
      echo "  ⚠ closure dep '$cur' required by '${requester_src:-<entrypoint>}' not found in its Node resolution path"
      nat_missing=$((nat_missing+1))
      continue
    fi
    # A name-keyed seen-set suppresses distinct nested versions. Source-path
    # identity preserves both while still deduplicating repeat visits.
    case "$_seen" in *"|$src|"*) continue ;; esac
    _seen="${_seen}${src}|"

    local dest=""
    if ! dest="$(pkg_dest_for_source "$src")"; then
      nat_missing=$((nat_missing+1))
      continue
    fi
    # onnxruntime-web is a @huggingface/transformers dependency but is ONLY used
    # on the browser backend — the node path loads onnxruntime-node. A parent
    # package copy can bring its nested directory across before this queue row is
    # visited, so "continue" alone does not skip it: delete its exact mapped
    # destination and then stop traversal. Otherwise 134M of inert wasm/js ships,
    # and the final-tree dependency audit correctly sees its deliberately-omitted
    # browser dependencies as unresolved.
    if [[ "$cur" == "onnxruntime-web" ]]; then
      rm -rf "$dest"
      echo "  ⊘ skipping onnxruntime-web (browser-only backend; node uses onnxruntime-node)"
      continue
    fi
    # A parent `cp -aL` may already have brought a nested dependency directory
    # across. Do not copy it twice, but DO traverse its manifest: skipping the
    # traversal is the exact path by which nested posthog-node lost rusha.
    if [[ ! -e "$dest" ]]; then
      mkdir -p "$(dirname "$dest")"
      cp -aL "$src" "$dest"
      nat_copied=$((nat_copied+1))
    fi
    # WI-5638 (2026-07-20, revised 2026-07-27): strip runtime model-download
    # scratch — but NOT the two embedding models the desktop app actually
    # needs at runtime. @huggingface/transformers' DEFAULT cacheDir resolves
    # to a path INSIDE its own package dir (src/env.js: `DEFAULT_CACHE_DIR =
    # path.join(dirname__, '/.cache/')` when RUNNING_LOCALLY, which is always
    # true under Node) — there is no env.cacheDir/localModelPath override
    # anywhere in libs/generic/memory, so that in-bundle path is the ONLY
    # place the packaged app looks. A .deb installs its resources tree
    # root-owned/read-only for the running (non-root) user, so "models
    # re-download on first use" — the ORIGINAL assumption behind a blanket
    # `rm -rf .cache` here — does not hold: a stripped harrier/gemma cache
    # cannot be regenerated at runtime, it just breaks local embedding
    # silently. Per owner [owner 2026-07-20, recorded in memory]: the desktop
    # app runs a LIVE HYBRID of the harrier + embeddinggemma embedders (both
    # intentionally bundled, not dead weight) — keep BOTH. Only bge-small
    # (Xenova/bge-small-en-v1.5, 'local' mode) and any other/future scratch
    # under `.cache` is genuinely unused and safe to strip.
    #
    # D-178 (2026-08-29) REVISES the paragraph above on one point. It claimed
    # "there is no env.cacheDir/localModelPath override ... so that in-bundle
    # path is the ONLY place the packaged app looks." The models do NOT have to
    # live under `.cache/` for the runtime to find them, and no override is
    # needed to move them, because the library ships a SECOND resolution root
    # that is enabled by default:
    #
    #   env.cacheDir       -> <pkg>/.cache/   (the forbidden path)
    #   env.localModelPath -> <pkg>/models/   (NOT a .cache path)
    #   env.allowLocalModels = true
    #
    # Both roots take the SAME relative layout — `<repo_id>/<filename>`, with no
    # revision segment for the default revision 'main' (src/utils/hub.js:125-146)
    # — so relocating is a literal `mv`, not a re-layout. Resolution consults the
    # cache first and then falls through to localModelPath (hub.js:270-298), so a
    # bundle with NO `.cache/` at all resolves cleanly from `models/`.
    #
    # Measured on the shipped node build (dist/transformers.node.mjs) with the
    # .cache route neutralised and the network FORBIDDEN (allowRemoteModels=false,
    # so a silent re-download cannot masquerade as success):
    #   models at a non-.cache localModelPath -> full feature-extraction pipeline
    #     loaded, PROBE_FULL=OK dims=[1,768] l2norm=1.0000
    #   same config, empty localModelPath     -> PROBE_FULL=FAIL (correctly)
    # The positive arm ran the FULL pipeline on purpose: ONNX external data
    # (model.onnx_data, 1.2GB) is resolved by onnxruntime relative to the .onnx
    # file, NOT by the transformers hub layer, so a config-only probe would have
    # left the largest artifact untested.
    #
    # WHY THIS MATTERS: the release identity audit forbids `(^|/)\.cache/`
    # outright, on the premise that nothing in a .cache/ is needed to RUN the
    # tree. For this one path that premise was false, so the audit and this build
    # were in direct conflict — one demanding deletion, the other FATAL-ing on
    # absence. Relocating satisfies BOTH at full strength: `.cache/` stays
    # categorically forbidden with no auditor exception, and the weights still
    # ship at a path the runtime already resolves by default. WI-5638's intent is
    # unchanged — both models still ship, still behind a fail-closed guard; only
    # the directory changed.
    local _transformers_cache="$dest/.cache"
    local _transformers_models="$dest/models"
    if [[ "$cur" == "@huggingface/transformers" ]]; then
      if [[ -d "$_transformers_cache" ]]; then
        find "$_transformers_cache" -mindepth 1 -maxdepth 1 ! -name 'onnx-community' -exec rm -rf {} +
        if [[ -d "$_transformers_cache/onnx-community" ]]; then
          find "$_transformers_cache/onnx-community" -mindepth 1 -maxdepth 1 \
            ! -name 'harrier-oss-v1-0.6b-ONNX' ! -name 'embeddinggemma-300m-ONNX' -exec rm -rf {} +
          # Relocate the survivors OUT of .cache/ (D-178). Merge rather than
          # clobber: `models/` may already exist in a future package version.
          mkdir -p "$_transformers_models"
          if [[ -d "$_transformers_models/onnx-community" ]]; then
            echo "ERROR: $_transformers_models/onnx-community already exists — refusing to merge two model roots (D-178)" >&2
            exit 1
          fi
          mv "$_transformers_cache/onnx-community" "$_transformers_models/onnx-community" \
            || { echo "ERROR: failed to relocate transformers models out of .cache (D-178)" >&2; exit 1; }
        fi
      fi
      # EI-22077502575226404: everything above only MOVES weights that a runtime download
      # already put in `.cache/`. A pristine clone + `npm ci` has none — nothing fetches
      # them — so the relocation is a no-op and the fail-closed presence check near the end
      # of this script FATALs, which is how P-101 build #3 died (exit 5). This is the step
      # that can SOURCE them, and it is opt-in: it returns immediately when the models are
      # already staged (every host-tree build) or when PAPERCUSP_TRANSFORMERS_MODEL_CACHE
      # is unset, so the guard's fail-closed behaviour is unchanged for builds that do not
      # ask for it. The `.cache` condition deliberately no longer gates this — that was the
      # bug: with no `.cache` there was no code path at all.
      papercusp_stage_transformers_models "$_transformers_models" || exit 1
      prune_transformers_model_fragments "$_transformers_models"
    fi
    # `.cache/` is now unconditionally removed — including for
    # @huggingface/transformers, whose models were just relocated above. There is
    # no longer any package for which a shipped `.cache/` is legitimate.
    rm -rf "$dest/.cache"
    prune_foreign_prebuilds "$dest"
    prune_foreign_onnx_bins "$dest"
    prune_onnx_gpu_providers "$dest"

    local deps
    deps=$(node -e 'try { const p=require(process.argv[1]); const optional=new Set(Object.keys(p.optionalDependencies||{})); const required=Object.keys(p.dependencies||{}).filter((name)=>!optional.has(name)); const opt=[...optional].map((name)=>`?${name}`); process.stdout.write([...required,...opt].join(" ")); } catch {}' "$src/package.json" 2>/dev/null)
    local d dep_optional
    for d in $deps; do
      dep_optional=0
      if [[ "$d" == '?'* ]]; then dep_optional=1; d="${d#\?}"; fi
      queue_names+=("$d")
      queue_requesters+=("$src")
      queue_optional+=("$dep_optional")
    done
  done
}

# Class-level backstop: inspect every actual package in the ASSEMBLED sidecar and
# resolve every required dependency using only that tree. This does not replace
# the clean-root boot gate (which exercises the real artifact); it catches the
# dependency class immediately at staging time and names every broken referrer.
assert_runtime_dependency_closure() {
  local root="$1"
  [[ -d "$root/node_modules" ]] || {
    echo "ERROR: assembled sidecar has no node_modules directory" >&2
    return 1
  }
  node - "$root" <<'NODE'
  const fs = require('node:fs');
  const path = require('node:path');

  const root = path.resolve(process.argv[2]);
  const nodeModulesRoot = path.join(root, 'node_modules');
  const visited = new Set();
  const failures = new Set();
  // This package is deliberately deleted by copy_pkg_closure: the packaged
  // operator is Node-only and uses onnxruntime-node, while onnxruntime-web is a
  // browser backend whose 134M wasm payload cannot execute here. Keep the
  // exception exact; every other required dependency remains fail-closed.
  const intentionallyOmitted = new Set(['onnxruntime-web']);

  function isDirectory(candidate) {
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  }

  function isInsideRoot(candidate) {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
  }

  function dependencyDir(fromPackage, dependency) {
    let cursor = fromPackage;
    while (isInsideRoot(cursor)) {
      if (path.basename(cursor) !== 'node_modules') {
        const candidate = path.join(cursor, 'node_modules', ...dependency.split('/'));
        if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return null;
  }

  function visitPackage(packageDir) {
    const logicalDir = path.resolve(packageDir);
    if (visited.has(logicalDir)) return;
    visited.add(logicalDir);

    const manifestPath = path.join(logicalDir, 'package.json');
    if (!fs.existsSync(manifestPath)) return;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      failures.add(`${path.relative(nodeModulesRoot, logicalDir)} -> invalid package.json (${error.message})`);
      return;
    }

    const optional = new Set(Object.keys(manifest.optionalDependencies || {}));
    const required = Object.keys(manifest.dependencies || {}).filter(
      (dependency) => !optional.has(dependency) && !intentionallyOmitted.has(dependency),
    );
    const label = `${path.relative(nodeModulesRoot, logicalDir)}@${manifest.version || 'unknown'}`;
    for (const dependency of required) {
      if (!dependencyDir(logicalDir, dependency)) failures.add(`${label} -> ${dependency}`);
    }

    visitNodeModules(path.join(logicalDir, 'node_modules'));
  }

  function visitNodeModules(nodeModulesDir) {
    if (!isDirectory(nodeModulesDir)) return;
    for (const entry of fs.readdirSync(nodeModulesDir)) {
      if (entry === '.bin') continue;
      const entryPath = path.join(nodeModulesDir, entry);
      if (!isDirectory(entryPath)) continue;
      if (entry.startsWith('@')) {
        for (const scopedEntry of fs.readdirSync(entryPath)) {
          const scopedPath = path.join(entryPath, scopedEntry);
          if (isDirectory(scopedPath)) visitPackage(scopedPath);
        }
      } else {
        visitPackage(entryPath);
      }
    }
  }

  visitNodeModules(nodeModulesRoot);
  if (failures.size > 0) {
    console.error(`ERROR: ${failures.size} unresolved runtime dependencies in assembled sidecar:`);
    for (const failure of [...failures].slice(0, 100)) console.error(`  - ${failure}`);
    if (failures.size > 100) console.error(`  - ... ${failures.size - 100} more`);
    process.exit(1);
  }
  console.log(`  ✓ runtime dependency closure resolved inside sidecar (${visited.size} packages checked)`);
NODE
}
for np in "${NATIVE_PKGS[@]}"; do copy_pkg_closure "$np"; done
echo "  copied $nat_copied package(s) ($nat_missing missing)"

# rrule is loaded at runtime via `createRequire(import.meta.url)('rrule')` in
# operator-core/lib/harness/routines/schedule-next.ts (rrule's CJS build sets
# __esModule:true with NO `default`, so every static-import form diverges between
# the tsx dev host and the esbuild bundle — createRequire is the only form that
# works in both). esbuild can't see a dynamic createRequire, so it never inlines
# rrule, and it is pure-JS (not in NATIVE_PKGS) so it was never copied either —
# the bundled operator then crashed at boot with `Cannot find module 'rrule'`
# (EMBEDDED_PG_FAILED). Copy rrule + its dep closure (tslib) so the runtime
# createRequire('rrule') from sidecar/serve.mjs resolves.
echo "→ copying createRequire runtime dep rrule (+ closure) into the sidecar"
copy_pkg_closure rrule
echo "  rrule closure copied ($nat_copied total package(s), $nat_missing missing)"

# luxon — IDENTICAL createRequire gotcha as rrule above. schedule-next.ts loads
# `createRequire(import.meta.url)('luxon')` (DST-correct schedule math; landed
# 2026-06-17 in 5472dec3c, the scheduled-plans EI-1368/136 fixes — which did NOT
# add this copy line). esbuild can't see the dynamic createRequire, luxon is
# pure-JS (no deps, not in NATIVE_PKGS) so it was never copied → the packaged
# operator crashed at boot with `Cannot find module 'luxon'` (EMBEDDED_PG_FAILED),
# i.e. the .deb did not boot at all. Copy luxon so the runtime createRequire('luxon')
# from sidecar/serve.mjs resolves. (shared-pot-release-testing Lane A, A-001.)
echo "→ copying createRequire runtime dep luxon (+ closure) into the sidecar"
copy_pkg_closure luxon
echo "  luxon closure copied ($nat_copied total package(s), $nat_missing missing)"

# Design comparison loads these packages through createRequire so the same
# implementation works in the unbundled operator and the packaged sidecar.
# esbuild cannot see those runtime calls; copy the three package roots (a root
# copy also covers lost-pixel/package.json and lost-pixel/dist/* subpaths).
echo "→ copying createRequire runtime deps lost-pixel, pixelmatch, pngjs (+ closures) into the sidecar"
copy_pkg_closure lost-pixel
copy_pkg_closure pixelmatch
copy_pkg_closure pngjs
echo "  design-compare closures copied ($nat_copied total package(s), $nat_missing missing)"

# EI-19981394187273902 (2026-08-09) — IDENTICAL createRequire gotcha as rrule/luxon
# above, caught by the sidecar-createrequire-bundling.test.ts recurrence guard
# (EI-1589). device-push-dispatcher.ts loads BOTH
# `createRequire(import.meta.url)('google-auth-library')` (FCM push — signs a
# service-account JWT) AND `createRequire(import.meta.url)('jose')` (APNs push —
# signs the ES256 provider JWT). Both are pure-JS (not in NATIVE_PKGS), so esbuild
# can't see the dynamic createRequire and never inlined either — the packaged
# operator would crash at boot with `Cannot find module 'google-auth-library'` (or
# 'jose') the first time a push dispatch actually ran. Copy both (+ closures) so
# the runtime createRequire(...) calls from sidecar/serve.mjs resolve.
echo "→ copying createRequire runtime deps google-auth-library, jose (+ closures) into the sidecar"
copy_pkg_closure google-auth-library
copy_pkg_closure jose
echo "  google-auth-library/jose closures copied ($nat_copied total package(s), $nat_missing missing)"

# WI-5651: cross-bake the darwin native addons npm SKIPPED on this linux host.
# copy_pkg_closure silently drops foreign-platform optionalDeps (correct on a
# native build — npm never installed @img/sharp-darwin-* on linux). For a cross
# darwin bundle those ARE the addons the app loads at runtime, so fetch each one
# at the EXACT version its parent pins in optionalDependencies (ABI-matched, not
# `latest`). sharp/node-pty dying at boot ('Could not load the sharp module') is
# exactly the class that shipped 0.0.9 dead — so a resolve failure is fatal here.
if [[ "$CROSS_BUILD" == "1" && "$TARGET_OS" == "darwin" ]]; then
  echo "→ WI-5651 cross-fetching darwin native addons for darwin-${TARGET_ARCH} (npm skipped them on ${_host_os})"
  _xnm="$SIDECAR_DIR/node_modules"
  # node-pty: @lydell/node-pty pins @lydell/node-pty-darwin-<arch> in optionalDependencies.
  _npty_json="$_xnm/@lydell/node-pty/package.json"
  if [[ -f "$_npty_json" ]]; then
    _npty_dep="@lydell/node-pty-darwin-${TARGET_ARCH}"
    _npty_ver="$(opt_dep_version "$_npty_json" "$_npty_dep")"
    [[ -n "$_npty_ver" ]] || { echo "ERROR: cannot resolve $_npty_dep version from @lydell/node-pty optionalDependencies"; exit 1; }
    fetch_cross_npm_pkg "${_npty_dep}@${_npty_ver}" "$_xnm" || exit 1
  else
    echo "  ⚠ @lydell/node-pty not in the sidecar closure — no darwin node-pty addon to fetch"
  fi
  # sharp: sharp pins @img/sharp-darwin-<arch>, which in turn pins @img/sharp-libvips-darwin-<arch>.
  _sharp_json="$_xnm/sharp/package.json"
  if [[ -f "$_sharp_json" ]]; then
    _sharp_dep="@img/sharp-darwin-${TARGET_ARCH}"
    _sharp_ver="$(opt_dep_version "$_sharp_json" "$_sharp_dep")"
    [[ -n "$_sharp_ver" ]] || { echo "ERROR: cannot resolve $_sharp_dep version from sharp optionalDependencies"; exit 1; }
    fetch_cross_npm_pkg "${_sharp_dep}@${_sharp_ver}" "$_xnm" || exit 1
    _vips_dep="@img/sharp-libvips-darwin-${TARGET_ARCH}"
    _vips_ver="$(opt_dep_version "$_xnm/${_sharp_dep}/package.json" "$_vips_dep")"
    if [[ -n "$_vips_ver" ]]; then
      fetch_cross_npm_pkg "${_vips_dep}@${_vips_ver}" "$_xnm" || exit 1
    else
      echo "  ⚠ $_vips_dep not pinned by $_sharp_dep — assuming sharp bundles libvips internally"
    fi
  else
    echo "  ⚠ sharp not in the sidecar closure — no darwin sharp addon to fetch"
  fi
  echo "  ✓ darwin native addons cross-fetched"
fi

# Static payloads the host serves. host-spa.ts / host-docs.ts resolve these
# from the PAPERCUSP_SPA_DIST / PAPERCUSP_DOCS_ROOT env vars Tauri main.rs
# sets — see those files' root-resolution comments.
echo "→ using locked operator-vite snapshot → sidecar/spa"
if [[ ! -f "$SIDECAR_DIR/spa/index.html" ]]; then
  echo "ERROR: locked Vite SPA snapshot disappeared before packaging"
  exit 1
fi
# WI-3172 / WI-3063 — trim dead weight from the copied SPA so the Windows payload
# clears the NSIS 4GiB datablock cap WITHOUT dropping the offline seed. The Vite
# dist is a wholesale copy of web/public, which bundles the whole Starlight site
# under dist/internal/docs — but /internal/docs/* is served by the DEDICATED
# docsRoutes (bin/host-docs.ts, from PAPERCUSP_DOCS_ROOT = sidecar/internal-docs),
# registered BEFORE the SPA catch-all (bin/host-spa.ts is the final `*` fallback).
# So spa/internal/docs is NEVER served — it's a 147MB byte-for-byte duplicate of
# sidecar/internal-docs. It also carries any stale `<name>.old.<pid>` dir the
# docs-sync atomic-swap (operator-docs postbuild-copy.sh) left un-reaped in
# public/internal/ (found live 2026-07-06: spa/internal/docs.old.2116786 = 146MB
# of pure garbage). Drop the duplicate + purge stale swap leftovers (~293MB).
rm -rf "$SIDECAR_DIR/spa/internal/docs"
find "$SIDECAR_DIR/spa" -depth -type d -name '*.old.[0-9]*' -prune -exec rm -rf {} + 2>/dev/null || true
# ── ONNX Runtime wasm: prune dead backends + dedup the 3 identical copies ────
# (install-size-audit 2026-07-07, owner-directed). The SPA ships the ORT wasm
# runtime in THREE dirs — spa/ (STT/transformers), spa/wake-runtime/ (openwakeword,
# wasmPaths:'/wake-runtime/') and spa/vad-runtime/ (VAD) — each a full ~79MB set of
# FOUR backend builds (.wasm 12M + .jsep.wasm 24M + .asyncify.wasm 26M + .jspi.wasm
# 17M), copied wholesale by setup-{wake,vad}-runtime.sh (glob copy). ~237MB, almost
# all waste:
#   • DEAD BACKENDS: the bundled onnxruntime-web (ort.bundle.min.mjs) only ever
#     constructs the `.jsep` filename, and the app's own chunks reference only
#     `.jsep.mjs` + plain `.mjs` — NOTHING names `.asyncify` or `.jspi` (the
#     proxy-worker / JSPI-stack-switching builds this app never enables). So the
#     .asyncify + .jspi {wasm,mjs} are fetched by no code path → drop them.
#   • TRIPLICATION: the kept .jsep/.plain files (+ the silero .onnx models) are
#     BYTE-IDENTICAL across the three dirs. serve.mjs serves them read-only over
#     HTTP, so replacing the wake-/vad- copies with HARDLINKS to the spa-root copy
#     ships one physical copy with zero behaviour change (a hardlink IS the file,
#     served identically; no symlink-follow needed).
# Net: ~237MB → ~36MB. If a FUTURE change enables ORT proxy/JSPI/WebGPU-only
# builds, stop pruning the needed variant here.
echo "→ ONNX wasm: pruning dead backends (.asyncify/.jspi) + deduping the 3 runtime dirs"
_ort_pruned=0
_ort_linked=0
for _ort_dir in "$SIDECAR_DIR/spa" "$SIDECAR_DIR/spa/wake-runtime" "$SIDECAR_DIR/spa/vad-runtime"; do
  [[ -d "$_ort_dir" ]] || continue
  for _dead in "$_ort_dir"/ort-wasm-*.asyncify.* "$_ort_dir"/ort-wasm-*.jspi.*; do
    [[ -e "$_dead" ]] || continue
    rm -f "$_dead"
    _ort_pruned=$((_ort_pruned + 1))
  done
done
for _ort_sub in wake-runtime vad-runtime; do
  _ort_subdir="$SIDECAR_DIR/spa/$_ort_sub"
  [[ -d "$_ort_subdir" ]] || continue
  for _f in "$_ort_subdir"/*; do
    [[ -f "$_f" ]] || continue
    _canon="$SIDECAR_DIR/spa/$(basename "$_f")"
    [[ -f "$_canon" ]] || continue
    [[ "$_f" -ef "$_canon" ]] && continue          # already the same inode
    cmp -s "$_f" "$_canon" || continue             # only dedup byte-identical files
    if rm -f "$_f" && ln "$_canon" "$_f" 2>/dev/null; then
      _ort_linked=$((_ort_linked + 1))
    else
      cp -a "$_canon" "$_f"                         # FS without hardlink support — restore a copy
    fi
  done
done
echo "  ✓ ONNX wasm: pruned $_ort_pruned dead-backend file(s), hardlinked $_ort_linked duplicate(s)"
echo "→ copying Starlight docs → sidecar/internal-docs"
if [[ -d "$WEB_DIR/public/internal/docs" ]]; then
  # WI-1998: public/internal/docs is a live docs-sync deploy target
  # (apps/operator-docs/scripts/postbuild-copy.sh) that republishes via an
  # atomic rename-swap, not an in-place mutation — so the window this `cp -a`
  # can lose to has shrunk from "however long a delete+rewrite mirror takes"
  # to "this cp -a happened to start/traverse during someone else's rename
  # swap", which is rare but not impossible for a multi-second recursive copy
  # racing a swap that can land at any instant. A swapped-out old tree isn't
  # reaped for a couple minutes (see postbuild-copy.sh), so a short retry
  # picks up either the (still-intact) pre-swap tree a moment earlier or the
  # (now-published) post-swap tree a moment later — either is a valid
  # complete docs tree; only the fraction-of-a-second window mid-swap fails.
  _docs_cp_attempts=5
  _docs_cp_ok=0
  for _docs_cp_try in $(seq 1 "$_docs_cp_attempts"); do
    rm -rf "$SIDECAR_DIR/internal-docs"
    if cp -a "$WEB_DIR/public/internal/docs" "$SIDECAR_DIR/internal-docs" 2>/tmp/docs-cp-err.$$; then
      _docs_cp_ok=1
      break
    fi
    echo "  ⚠ Starlight docs copy attempt $_docs_cp_try/$_docs_cp_attempts hit a live docs-sync republish race — retrying"
    cat /tmp/docs-cp-err.$$ >&2 || true
    rm -f /tmp/docs-cp-err.$$
    sleep 1
  done
  rm -f /tmp/docs-cp-err.$$
  if [[ "$_docs_cp_ok" -ne 1 ]]; then
    echo "ERROR: Starlight docs copy failed $_docs_cp_attempts times (persistent docs-sync race or a real fault, not a one-off) — aborting rather than shipping a partial/missing docs tree"
    exit 1
  fi
else
  echo "  ⚠ $WEB_DIR/public/internal/docs not found — /internal/docs/* will 404 in the bundle"
fi

# docs-qa retrieval grounding (2026-07-05). The tutorial/palette "Ask a question"
# (packages/operator-core/.../desktop/docs-qa.ts → @papercusp/docs-engine searchDocs)
# reads the SOURCE Starlight .mdx tree via _repo-paths.DOCS_CONTENT_ROOT — NOT the
# rendered public/internal/docs copied above. In a packaged sidecar, findRepoRoot()
# walks up from cwd (= the sidecar dir), finds no repo, and falls back to cwd, so
# DOCS_CONTENT_ROOT resolves to <sidecar>/apps/operator-docs/src/content/docs. Ship the
# source tree THERE so retrieveDocsContext returns real blocks and the answer is grounded
# (cites /internal/docs/...) instead of hallucinating. Without this the retrieval returns
# zero blocks in EVERY packaged install → the deflecting "I can't define that" answers the
# owner hit on 2026-07-05.
_docs_src="$WEB_DIR/../operator-docs/src/content/docs"
if [[ -d "$_docs_src" ]]; then
  echo "→ copying Starlight docs SOURCE tree → sidecar/apps/operator-docs/src/content/docs (docs-qa grounding)"
  mkdir -p "$SIDECAR_DIR/apps/operator-docs/src/content"
  rm -rf "$SIDECAR_DIR/apps/operator-docs/src/content/docs"
  cp -a "$_docs_src" "$SIDECAR_DIR/apps/operator-docs/src/content/docs"
else
  echo "  ⚠ $_docs_src not found — docs-qa (tutorial/palette Ask) will be UNGROUNDED in the bundle"
fi

# ── Release privacy (WI-4419 follow-up). The two doc copies above pull from the
# LIVE monorepo tree, NOT the stager's source.tar.zst, so the in-build release
# audit (which scans source.tar.zst) is STRUCTURALLY BLIND to them: 0.0.9 shipped
# the mac VM's sudo/login passwords (macuser/maclogin) inside the sidecar docs
# while every leg's source audit passed CLEAN. Durable fix, co-located with the
# copy that creates the exposure:
#   (1) PRUNE the same internal-build-infra docs the release audit forbids, using
#       audit-release-bundle.py's own rule as the SINGLE source of truth (no drift).
#   (2) In a RELEASE build, IDENTITY-SCAN the assembled sidecar UNCONDITIONALLY
#       (honoring no path-exclude) and FAIL if any known-sensitive/build-box
#       identity survives on disk — the ultimate backstop the source.tar.zst scan
#       cannot be. Hard-fail is release-gated (PAPERCUSP_RELEASE_AUDIT=1) so a dev
#       sidecar on the build box — whose own identity legitimately pervades its
#       compiled binaries — still builds; the prune runs in every build regardless.
#   (3) PRUNE node-gyp build scaffolding from every native module in the sidecar.
#       Same exposure, different source: these are build residue (Makefile,
#       config.gypi, *.target.mk, .deps/*.o.d) that embed the build box's absolute
#       paths. Must run BEFORE the identity scan below, which is what catches them.
echo "→ pruning node-gyp build scaffolding from sidecar native modules (release-privacy, WI-4419)"
prune_gyp_build_intermediates "$SIDECAR_DIR"
echo "→ pruning vendored test fixtures from sidecar (release-privacy, WI-37620)"
prune_vendored_test_fixtures "$SIDECAR_DIR"

echo "→ verifying every required Node runtime dependency resolves inside the assembled sidecar"
assert_runtime_dependency_closure "$SIDECAR_DIR" || exit 1

echo "→ verifying no ONNX GPU execution providers survive in the sidecar (WI-38682)"
assert_no_onnx_gpu_providers "$SIDECAR_DIR" || exit 1

_audit_py="$HERE/audit-release-bundle.py"
if [[ -f "$_audit_py" ]]; then
  echo "→ pruning internal-build-infra docs from sidecar (release-privacy, WI-4419)"
  python3 "$_audit_py" --prune-docs \
    "$SIDECAR_DIR/internal-docs" \
    "$SIDECAR_DIR/apps/operator-docs/src/content/docs" \
    "$SIDECAR_DIR/spa/docs"
  # The prune above deletes by PATH; the gate below fails by CONTENT. A doc whose
  # path is not internal-build-infra but whose TEXT quotes this box's identity slips
  # between the two — 65 assembled files did exactly that on the 0.0.16 cut. Redact
  # the shipping doc TEXT from the same identity map --scrub-binaries uses, which is
  # the sidecar half of the redaction bin/stage-source-tree.sh already applies to
  # source.tar.zst. Must run BEFORE the scan below.
  echo "→ scrubbing build-box identity from sidecar text (release-privacy, WI-4419)"
  python3 "$_audit_py" --scrub-text \
    "$SIDECAR_DIR/internal-docs" \
    "$SIDECAR_DIR/apps/operator-docs/src/content/docs" \
    "$SIDECAR_DIR/serve.mjs" \
    "$SIDECAR_DIR/spa"
  # WI-37620: a build-box path baked into a COMPILED addon (.rodata assert string)
  # is reachable by neither of the gate's other remedies — `strip` leaves it and the
  # file is needed at runtime — so scrub it. Must run BEFORE the scan below.
  echo "→ scrubbing build-box identity from compiled native addons (release-privacy, WI-37620)"
  python3 "$_audit_py" --scrub-binaries "$SIDECAR_DIR/node_modules"
  # NOTE (EI-20304355477263736): the release identity SCAN used to run right here,
  # which made it a scan of a HALF-ASSEMBLED sidecar — 44 further cp/mkdir/cat
  # writes into $SIDECAR_DIR happen below this line (harness/**, prompts/**,
  # db-sql/**, sql/**, the vendored bin/** binaries, pui, provenance, across 112
  # $SIDECAR_DIR references in total). The two files that killed
  # 0.0.16-alpha attempt 5 were both written AFTER this point, so this position
  # could not have caught them however correct the scanner was. The scan now runs
  # at the END of this script (search: ASSEMBLED-SIDECAR IDENTITY SCAN). The
  # prune/scrub steps above stay here: they must precede the copies they rewrite.
elif [[ "${PAPERCUSP_RELEASE_AUDIT:-0}" == "1" ]]; then
  echo "ERROR: release build requires $_audit_py for sidecar privacy enforcement — aborting."
  exit 1
else
  echo "  ⚠ audit-release-bundle.py not found at $_audit_py — sidecar release-privacy NOT enforced (dev build)"
fi

# Operator prompts — some endpoint-route handlers read apps/operator/prompts/
# at runtime. esbuild doesn't trace runtime fs reads, so copy them explicitly.
if [[ -d "$WEB_DIR/prompts" ]]; then
  echo "→ copying operator prompts → sidecar/prompts"
  cp -a "$WEB_DIR/prompts" "$SIDECAR_DIR/prompts"
fi

# Desktop-install integration (Phase 1 of
# desktop-app-install-integration-2026-05-23) reads the OMP hook files at
# runtime and copies them into ~/.papercusp/. The playbook lives under prompts/
# (above), while the OMP files are under apps/operator/scripts/hooks/omp/.
# esbuild doesn't trace these fs.readFile paths, so copy every direct TypeScript
# sibling explicitly. This keeps the installed bundle loadable when an entrypoint
# gains a relative companion such as non-preempting-delivery.ts.
OMP_HOOK_SRC_DIR="$WEB_DIR/scripts/hooks/omp"
OMP_HOOK_DST_DIR="$SIDECAR_DIR/apps/operator/scripts/hooks/omp"
if [[ -d "$OMP_HOOK_SRC_DIR" ]]; then
  mkdir -p "$OMP_HOOK_DST_DIR"
  if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
    # P-052: these hooks are genuine runtime pieces, but their readable TS source
    # is not a runtime asset. Bundle each entry independently so coord and inject
    # keep their existing install/launch contracts without shipping the source or
    # its companion module. No sourcemap is emitted.
    echo "→ esbuild-bundling OMP runtime hooks for vm-release"
    for omp_hook_entry in coord-hook inject-hook; do
      [[ -f "$OMP_HOOK_SRC_DIR/$omp_hook_entry.ts" ]] || {
        echo "ERROR: vm-release requires OMP hook source $OMP_HOOK_SRC_DIR/$omp_hook_entry.ts" >&2
        exit 1
      }
      (cd "$WEB_DIR" && npx --yes esbuild@0.25.0 \
        "scripts/hooks/omp/$omp_hook_entry.ts" \
        --bundle --platform=node --format=esm --target=node20 \
        --outfile="$OMP_HOOK_DST_DIR/$omp_hook_entry.mjs")
      [[ -s "$OMP_HOOK_DST_DIR/$omp_hook_entry.mjs" ]] || {
        echo "ERROR: vm-release OMP bundle missing/empty: $OMP_HOOK_DST_DIR/$omp_hook_entry.mjs" >&2
        exit 1
      }
    done
  else
    echo "→ copying omp hook TypeScript bundle → sidecar/apps/operator/scripts/hooks/omp/"
    for omp_hook_src in "$OMP_HOOK_SRC_DIR"/*.ts; do
      [[ -f "$omp_hook_src" ]] || continue
      cp -a "$omp_hook_src" "$OMP_HOOK_DST_DIR/"
    done
  fi
fi

# Same reason again, for the CONTEXT-INJECTION pair
# (omp-context-injection-parity-2026-08-09 P-003): the shared dispatcher
# apps/operator/scripts/hooks/inject/** and the omp artifact
# apps/operator/scripts/hooks/omp/inject-hook.ts are read at runtime by
# lib/desktop-install/papercusp-files.ts, not imported, so esbuild does not
# trace them.
#
# ⚠ SHIP BOTH OR NEITHER. The artifact locates the dispatcher relative to
# itself; shipping the hook without the dispatcher yields a packaged app whose
# omp sessions load the hook, find nothing, and fail-silently inject NOTHING on
# every turn — indistinguishable from "no memories were relevant". That is the
# EI-8191 shape exactly: fail-open looks like success, so it stays invisible.
# The `.mjs` set is the dispatcher; adapters/ is a required subdirectory.
INJECT_SRC_DIR="$WEB_DIR/scripts/hooks/inject"
if [[ -d "$INJECT_SRC_DIR" && -f "$OMP_HOOK_SRC_DIR/inject-hook.ts" ]]; then
  INJECT_DST_DIR="$SIDECAR_DIR/apps/operator/scripts/hooks/inject"
  echo "→ copying context-injection dispatcher → sidecar/apps/operator/scripts/hooks/inject/"
  mkdir -p "$INJECT_DST_DIR/adapters" "$SIDECAR_DIR/apps/operator/scripts/hooks/omp"
  cp -a "$INJECT_SRC_DIR"/*.mjs "$INJECT_DST_DIR"/
  cp -a "$INJECT_SRC_DIR"/adapters/*.mjs "$INJECT_DST_DIR"/adapters/
fi

# Same reason: the Claude/Codex CC hooks (statusline-fleet + lock/coord/activity/
# lifecycle/objective-title/bash-gate/workitem-nudge) under
# apps/operator/scripts/hooks/cc/ are read at runtime by
# lib/desktop-install/papercusp-files.ts (installClaudeHooks → ~/.papercusp/hooks/cc/
# + merged into ~/.claude/settings.json). esbuild doesn't trace them, so copy the
# runtime scripts explicitly. Without them the packaged Mac/Windows app installs NO
# Claude statusline/lock/coord hooks (EI-8191: "blank bottom statusline", lock
# enforcement silently off). The *.sh scripts AND the *.py libs they import — skip
# __tests__/ and *.tmp scratch.
#
# WI-3665: `*.sh` alone is NOT enough. statusline-fleet.sh and posttooluse-objective-title.sh
# `import pc_tty` (resolved off their own dirname) to find the terminal they may write the
# fleet-identity title to. A sidecar missing pc_tty.py raises ImportError, the hooks fail
# OPEN, and the packaged app silently stops setting the terminal title — the same shape as
# EI-8191, and invisible because fail-open looks exactly like success.
CC_HOOK_SRC_DIR="$WEB_DIR/scripts/hooks/cc"
if [[ -d "$CC_HOOK_SRC_DIR" ]]; then
  CC_HOOK_DST_DIR="$SIDECAR_DIR/apps/operator/scripts/hooks/cc"
  echo "→ copying cc hooks → sidecar/apps/operator/scripts/hooks/cc/"
  mkdir -p "$CC_HOOK_DST_DIR"
  cp -a "$CC_HOOK_SRC_DIR"/*.sh "$CC_HOOK_DST_DIR"/
  # nullglob-safe: if a future refactor removes every .py, don't copy a literal '*.py'.
  for py in "$CC_HOOK_SRC_DIR"/*.py; do
    [[ -e "$py" ]] && cp -a "$py" "$CC_HOOK_DST_DIR"/
  done
  # EI-16981: guard-operator-desktop.mjs is a Node hook (not .sh/.py) — without
  # this the packaged app silently ships NO desktop-navigation guard, the exact
  # WI-3665/EI-8191 fail-open shape. nullglob-safe, same pattern as the .py loop.
  for mjs in "$CC_HOOK_SRC_DIR"/*.mjs; do
    [[ -e "$mjs" ]] && cp -a "$mjs" "$CC_HOOK_DST_DIR"/
  done
fi

# Same reason: lib/desktop-install/papercusp-files.ts resolves the
# playbook source via <operatorAppRoot>/prompts/papercusp-su.tools.md.
# In production the operator app root lives at sidecar/apps/operator/,
# so the playbook must be available there too (the sidecar/prompts/
# copy above is for other endpoint-route handlers with a different
# expectation).
PLAYBOOK_SRC="$WEB_DIR/prompts/papercusp-su.tools.md"
if [[ -f "$PLAYBOOK_SRC" ]]; then
  PLAYBOOK_DST="$SIDECAR_DIR/apps/operator/prompts/papercusp-su.tools.md"
  mkdir -p "$(dirname "$PLAYBOOK_DST")"
  cp -a "$PLAYBOOK_SRC" "$PLAYBOOK_DST"
fi

# Bundle the `papercup` CLI shim + greeting status script. Used by the
# native-console launcher (the "+" button in the chrome header) — the
# user's spawned terminal runs `papercup status` before exec'ing their
# shell. Next.js standalone build doesn't include apps/operator/scripts/
# (not imported by any route), so we copy them explicitly.
#
# Lives in `sidecar/bin/` so Tauri's existing PATH-prepend
# (sidecar/bin → child PATH) makes `papercup` discoverable without
# absolute paths in the launcher one-liner.
PAPERCUP_SCRIPTS_SRC="$WEB_DIR/scripts"
PAPERCUP_BIN_DST="$SIDECAR_DIR/bin"
if [[ -f "$PAPERCUP_SCRIPTS_SRC/papercup" && -f "$PAPERCUP_SCRIPTS_SRC/papercup-status.mjs" ]]; then
  echo "→ copying papercup CLI shim → $PAPERCUP_BIN_DST"
  mkdir -p "$PAPERCUP_BIN_DST"
  cp -a "$PAPERCUP_SCRIPTS_SRC/papercup" "$PAPERCUP_BIN_DST/papercup"
  cp -a "$PAPERCUP_SCRIPTS_SRC/papercup-status.mjs" "$PAPERCUP_BIN_DST/papercup-status.mjs"
  chmod +x "$PAPERCUP_BIN_DST/papercup"
else
  echo "  ⚠ papercup shim source not found at $PAPERCUP_SCRIPTS_SRC; native console greeting will degrade"
fi

# Bundle the harness package (run.sh, prompts, templates, identity, docs-viewer).
# At runtime, the sidecar reads PAPERCUSP_HARNESS_DIR (set by Tauri main.rs)
# to locate this. Without it, the harness loop has nothing to execute.
HARNESS_SRC="$PAPERCUSP_ROOT/packages/harness"
HARNESS_DST="$SIDECAR_DIR/harness"
echo "→ copying harness package from $HARNESS_SRC"
if [[ ! -d "$HARNESS_SRC" ]]; then
  echo "ERROR: harness package not found at $HARNESS_SRC"
  exit 1
fi
mkdir -p "$HARNESS_DST"
# Use `find -type f` enumeration instead of `cp -a` so we:
#  1. Skip symlinks entirely (find -type f doesn't match -type l). The harness
#     has dev-time symlinks like docs-viewer/src/content/docs/projects/restart
#     pointing at retired pre-split paths — those dangle on CI and
#     either cause Tauri's resource bundler to fail (Linux/mac) or `cp` itself
#     to fail (Windows can't create those symlinks).
#  2. Skip docs-viewer entirely. It's an Astro sub-project that needs its own
#     node_modules and isn't required by the harness loop. Phase 4 polish.
#  3. Skip node_modules — those would be re-installed at runtime if needed,
#     not bundled.
echo "→ enumerating harness files (skipping symlinks, docs-viewer, node_modules)"
# Full exclude set: `harness/` is NOT wholesale in the auditor's asset allowlist
# (only harness/blueprints, hooks, identity, knowledge-packs, templates are), so an
# implementation test here is forbidden — `harness/paths.test.ts` was one of the
# r12 findings, via its env-sidecars mirror.
copy_tree_filtered "$HARNESS_SRC" "$HARNESS_DST" -- \
  -not -path "./docs-viewer/*" \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*"

# Sanity-check the artifacts the orchestrator actually needs.
# (run.sh was retired — see harness commit 4b7e162 "retire run.sh — the TS
# orchestrator is the only driver"; the iteration driver is now
# @papercusp/orchestrator, so the legacy run.sh is no longer bundled.)
#
# The top-level `prompts/` dir was RETIRED by the deterministic-blueprints
# migration — role spawn prompts now live PER-BLUEPRINT at
# `blueprints/<bp>/prompts/<role>.md` (the `find -type f` copy above brings them
# over with the rest of `blueprints/`). So require `blueprints` (+ `templates`)
# and assert a representative role prompt actually landed, instead of the stale
# top-level `prompts/` dir.
for required in blueprints templates; do
  if [[ ! -e "$HARNESS_DST/$required" ]]; then
    echo "ERROR: harness bundle missing $required at $HARNESS_DST"
    exit 1
  fi
done
# Assert the base-blueprint prompt set actually landed. NOTE: the previous
# sentinel was the single file `blueprints/base/prompts/queen.md`, but the
# WI-2932 blueprint rename churn (2026-07-05) moved/renamed the queen prompts
# (queen.md → queen.base.md → relocated again mid-refactor), so a single-file
# sentinel red-pins this build on an unrelated in-flight rename. Guard the
# INVARIANT instead: a healthy base prompt dir carries dozens of role prompts —
# require a sane minimum so a broken copy (0/near-0 files) still fails loudly.
BASE_PROMPTS_COUNT=$(find "$HARNESS_DST/blueprints/base/prompts" -maxdepth 1 -name '*.md' -type f 2>/dev/null | wc -l)
if [[ "$BASE_PROMPTS_COUNT" -lt 10 ]]; then
  echo "ERROR: harness bundle base prompts look missing/empty ($BASE_PROMPTS_COUNT .md files under blueprints/base/prompts) at $HARNESS_DST"
  echo "  Role spawn prompts live under blueprints/<bp>/prompts/ — the harness copy did not bring them over."
  exit 1
fi
find "$HARNESS_DST/bin" -type f -name "*.sh" -exec chmod +x {} \; 2>/dev/null || true

# Bundle the first-party app-templates (local-first-party-template-bundling-2026-07-07).
# The `templates:*` verbs resolve the bundled first-party templates from this dir at
# runtime (packages/operator-core/lib/cupboard/template-store.ts). Tauri's main.rs sets
# PAPERCUSP_TEMPLATES_DIR -> <resources>/sidecar/templates; a dev checkout with no env
# falls back to the in-repo templates/ dir. Shipped via tauri.conf.json resources
# ("sidecar/**/*"). Content only — the per-template checks/*.test.ts are PORTABLE content
# copied into composed apps, never run in-repo (templates/ is excluded from test discovery).
TEMPLATES_SRC="$REPO_ROOT/templates"
TEMPLATES_DST="$SIDECAR_DIR/templates"
echo "→ copying first-party templates from $TEMPLATES_SRC"
if [[ ! -d "$TEMPLATES_SRC" ]]; then
  echo "ERROR: first-party templates dir not found at $TEMPLATES_SRC"
  exit 1
fi
mkdir -p "$TEMPLATES_DST"
# ⚠ The node_modules prune is `*/node_modules/*`, NOT `./node_modules/*`. The
# anchored form only ever matched a node_modules at the TEMPLATES ROOT, so every
# PER-TEMPLATE `templates/<tpl>/node_modules/` shipped — which is how
# `templates/papercusp-iphone-shell/node_modules/.vite/vitest/…` reached the r12
# bundle and red'd the release identity gate (6 of its 33 findings). `*/…` matches
# the root case too (`.` matches the leading `*`), so this is strictly wider.
assert_vm_release_asset_allowed "templates/"
copy_tree_filtered "$TEMPLATES_SRC" "$TEMPLATES_DST" keep_product_tests \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*"
# official-mobile-app-templates-2026-08-20 P-016: the generic copier above is
# deliberately future-proof, but a successful copy count cannot prove the five
# launch-critical mobile directories landed. Fail the release build on the exact
# self-describing entry files each templates:* path requires.
REQUIRED_MOBILE_TEMPLATES=(
  papercusp-mobile-base
  papercusp-android-shell
  papercusp-android-app
  papercusp-iphone-shell
  papercusp-iphone-app
)
for required in "${REQUIRED_MOBILE_TEMPLATES[@]}"; do
  for entry in listing.json template.yaml GUIDE.md; do
    if [[ ! -f "$TEMPLATES_DST/$required/$entry" ]]; then
      echo "ERROR: required official mobile template entry missing from sidecar: $required/$entry"
      exit 1
    fi
  done
done
# Sanity: the first-party set + their self-describing listing.json actually landed.
tmpl_count=$(find "$TEMPLATES_DST" -maxdepth 2 -name listing.json 2>/dev/null | wc -l)
if [[ "$tmpl_count" -lt 1 ]]; then
  echo "ERROR: no first-party template listing.json landed at $TEMPLATES_DST"
  exit 1
fi
echo "  ✓ $tmpl_count first-party templates bundled → $TEMPLATES_DST"

# Bundle the first-party rubrics (local-first-party-rubric-bundling-2026-07-07) —
# same design as the templates block above: self-describing dirs (listing.json +
# rubric.json + METHOD.md) resolved at runtime from the bundled layer via
# PAPERCUSP_RUBRICS_DIR (Tauri main.rs → <resources>/sidecar/rubrics; dev falls
# back to the in-repo rubrics/ dir) and SEEDED into the workspace rubric store on
# first use, so a fresh install has the standard rubrics on day one.
RUBRICS_SRC="$REPO_ROOT/rubrics"
RUBRICS_DST="$SIDECAR_DIR/rubrics"
echo "→ copying first-party rubrics from $RUBRICS_SRC"
if [[ ! -d "$RUBRICS_SRC" ]]; then
  echo "ERROR: first-party rubrics dir not found at $RUBRICS_SRC"
  exit 1
fi
mkdir -p "$RUBRICS_DST"
assert_vm_release_asset_allowed "rubrics/"
copy_tree_filtered "$RUBRICS_SRC" "$RUBRICS_DST" keep_product_tests \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*"
# Sanity: the first-party set + their self-describing listing.json actually landed.
rubric_count=$(find "$RUBRICS_DST" -maxdepth 2 -name listing.json 2>/dev/null | wc -l)
if [[ "$rubric_count" -lt 1 ]]; then
  echo "ERROR: no first-party rubric listing.json landed at $RUBRICS_DST"
  exit 1
fi
echo "  ✓ $rubric_count first-party rubrics bundled → $RUBRICS_DST"

# Bundle the first-party goal packages (work-on-everything-goal-2026-08-23 P-007) —
# same design as the rubrics block above: self-describing dirs (goal.json +
# listing.json) resolved at runtime from the bundled layer via
# PAPERCUSP_GOAL_PACKAGES_DIR (Tauri main.rs → <resources>/sidecar/goal-packages;
# dev falls back to the in-repo goal-packages/ dir), so a fresh install has the
# standing work-on-everything stewardship goal installable on day one.
GOAL_PACKAGES_SRC="$REPO_ROOT/goal-packages"
GOAL_PACKAGES_DST="$SIDECAR_DIR/goal-packages"
echo "→ copying first-party goal packages from $GOAL_PACKAGES_SRC"
if [[ ! -d "$GOAL_PACKAGES_SRC" ]]; then
  echo "ERROR: first-party goal-packages dir not found at $GOAL_PACKAGES_SRC"
  exit 1
fi
mkdir -p "$GOAL_PACKAGES_DST"
# Full exclude set: `goal-packages/` is not in the auditor's asset allowlist.
copy_tree_filtered "$GOAL_PACKAGES_SRC" "$GOAL_PACKAGES_DST" -- \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*"
# Sanity: the first-party set + their self-describing listing.json actually landed.
goal_pkg_count=$(find "$GOAL_PACKAGES_DST" -maxdepth 2 -name listing.json 2>/dev/null | wc -l)
if [[ "$goal_pkg_count" -lt 1 ]]; then
  echo "ERROR: no first-party goal-package listing.json landed at $GOAL_PACKAGES_DST"
  exit 1
fi
echo "  ✓ $goal_pkg_count first-party goal packages bundled → $GOAL_PACKAGES_DST"

# Bundle the @papercusp/orchestrator entry bins as self-contained esbuild .mjs,
# shipped as a SIBLING of harness/ (sidecar/orchestrator/bin/*.mjs) — the path
# harnessPath('../orchestrator/bin/...') + the preflight harness check resolve to.
# The DBOS orchestrator-runner spawns invoke-once as a SEPARATE `node` process;
# bundling it self-contained means no tsx + no node_modules dep tree on disk
# (mirrors the host.mjs approach). harness-paths.ts prefers the .mjs when present.
ORCH_SRC="$PAPERCUSP_ROOT/packages/orchestrator"
ORCH_DST="$SIDECAR_DIR/orchestrator"
echo "→ esbuild-bundling orchestrator bins from $ORCH_SRC"
if [[ ! -d "$ORCH_SRC/bin" ]]; then
  echo "ERROR: orchestrator package not found at $ORCH_SRC"
  exit 1
fi
mkdir -p "$ORCH_DST/bin"
for b in invoke-once run assemble-prompt get-plan-context; do
  if [[ -f "$ORCH_SRC/bin/$b.ts" ]]; then
    (cd "$WEB_DIR" && npx --yes esbuild@0.25.0 "$ORCH_SRC/bin/$b.ts" \
      --bundle --platform=node --format=esm --target=node22 \
      "${MINIFY_ARGS[@]}" \
      --outfile="$ORCH_DST/bin/$b.mjs")
  fi
done
# Minimal package.json so the dir is a resolvable @papercusp/orchestrator root.
cat > "$ORCH_DST/package.json" <<'JSON'
{ "name": "@papercusp/orchestrator", "version": "0.0.1", "private": true, "type": "module" }
JSON
if [[ ! -f "$ORCH_DST/bin/invoke-once.mjs" ]]; then
  echo "ERROR: orchestrator invoke-once.mjs not produced at $ORCH_DST/bin"
  exit 1
fi
echo "  ✓ orchestrator bins bundled → $ORCH_DST/bin"

# ── EI-21474474153847007 / D-110: the remote-initializer executable ──────────
# `WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT` (workspace-host-build-manifest.ts) declares the
# controller spawns `bin/papercusp-remote-initializer` on a workspace host, and
# `workspace-host-bootstrap.ts` pins the same path. Until this block existed NOTHING emitted that
# file: tauri.vm-release.conf.json globs `sidecar/bin/**/*`, so the package would have shipped
# whatever happened to be there — and the manifest check only validates a CALLER-SUPPLIED material
# record for the path, so the whole suite stayed green while a real VM bundle omitted the program
# and every initialization step failed remotely. That is the exact gap D-110 names.
#
# Bundled self-contained (same reasoning as the orchestrator bins above): the host runs this as a
# separate `node` process with no node_modules tree and no tsx, over an SSH invocation where a
# module-resolution failure surfaces as an opaque non-zero exit.
#
# FAIL-CLOSED. A missing or non-executable artifact exits non-zero here rather than producing a
# bundle that looks complete. `verify-sidecar-bundle.sh` re-checks the finished package and runs a
# real protocol cycle against it, so this is the producer half of a two-sided guard.
DEPLOY_DRIVER_SRC="$REPO_ROOT/libs/generic/deployment-driver"
mkdir -p "$SIDECAR_DIR/bin"
# ONE loop over BOTH controller-spawned programs, not two hand-written blocks. They fail the same
# invisible way, so a second copy of these checks would be a second place to forget the next one:
#   papercusp-remote-initializer — the initialization + credential-lifecycle protocol
#     (WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT).
#   papercusp-deliver-material   — credential-material delivery. Its OWN protocol, argv and
#     entrypoint, deliberately NOT on the initialization protocol
#     (WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT, D-215 point 1). Without it the `git` and
#     `agent` channels throw at bind on every real host, because bind only OBSERVES that the
#     material file exists and nothing else in the bundle writes it.
# Both are in WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS, so a bundle missing either is refused by
# the release gate — but only after it is built, which is why this fails closed here first.
for _wh_entrypoint in papercusp-remote-initializer papercusp-deliver-material; do
  _wh_src="$DEPLOY_DRIVER_SRC/bin/$_wh_entrypoint.ts"
  _wh_bin="$SIDECAR_DIR/bin/$_wh_entrypoint"
  echo "→ esbuild-bundling $_wh_entrypoint from $DEPLOY_DRIVER_SRC"
  if [[ ! -f "$_wh_src" ]]; then
    echo "ERROR: workspace-host entrypoint not found at $_wh_src" >&2
    echo "       D-103/D-110/D-215 require this executable in every workspace-host bundle; refusing to ship without it." >&2
    exit 1
  fi
  # Bundled self-contained (same reasoning as the orchestrator bins above): the host runs these as
  # separate `node` processes with no node_modules tree and no tsx, over an SSH invocation where a
  # module-resolution failure surfaces as an opaque non-zero exit.
  #
  # The TypeScript entrypoint owns its `#!/usr/bin/env node` line and esbuild preserves it. Do not
  # add the same text with `--banner:js`: that produces a second shebang on line 2, which Node
  # parses as JavaScript and rejects before the program can enforce argv or read its request.
  (cd "$WEB_DIR" && npx --yes esbuild@0.25.0 "$_wh_src" \
    --bundle --platform=node --format=esm --target=node22 \
    "${MINIFY_ARGS[@]}" \
    --outfile="$_wh_bin")
  chmod 755 "$_wh_bin"
  if [[ ! -s "$_wh_bin" ]]; then
    echo "ERROR: $_wh_bin was not produced (or is empty) by esbuild" >&2
    exit 1
  fi
  if [[ ! -x "$_wh_bin" ]]; then
    echo "ERROR: $_wh_bin is present but not executable — the host spawns it directly" >&2
    exit 1
  fi
  # Assert the shebang survived the bundle: the host spawns this file by path, so without a
  # shebang it is an ordinary data file with the executable bit set and exec() fails ENOEXEC.
  if ! head -c 2 "$_wh_bin" | grep -c '#!' >/dev/null; then
    echo "ERROR: $_wh_bin has no '#!' line — exec() on the host would fail ENOEXEC" >&2
    exit 1
  fi
  echo "  ✓ $_wh_entrypoint bundled → $_wh_bin ($(wc -c < "$_wh_bin") bytes)"
done
REMOTE_INIT_BIN="$SIDECAR_DIR/bin/papercusp-remote-initializer"

# D-363: self-contained worker; the optional pack copies only it and Node across
# the Unix identity boundary. No operator store, environment or node_modules grant.
DESKTOP_SESSION_BIN="$SIDECAR_DIR/bin/papercusp-desktop-session.cjs"
(cd "$WEB_DIR" && npx --yes esbuild@0.25.0 \
  "$REPO_ROOT/packages/operator-core/bin/workspace-desktop-session.ts" \
  --bundle --platform=node --format=cjs --target=node22 \
  "${MINIFY_ARGS[@]}" --outfile="$DESKTOP_SESSION_BIN")
chmod 755 "$DESKTOP_SESSION_BIN"
# Bundled Node is installed later. The finished-bundle verifier below executes
# this worker with that exact runtime and refuses a missing or broken bundle.

# Bundle the embedded-postgres-server package (real PG with logical
# replication enabled). This is the ONLY desktop DB — the legacy
# pglite-server fallback was removed 2026-06-01 (a failed embedded-PG must
# fail LOUD, not silently degrade to a WASM single-connection engine).
#
# SP1 C5: no longer spawned as its own process — serve.mjs imports
# `@papercusp/embedded-postgres-server` (externalized in the esbuild step
# above) and runs PG IN-PROCESS. Shipping it under sidecar/node_modules/
# makes the bare-specifier import resolve, and keeps the PG binary paths
# (computed from the package's own import.meta.url) correct.
EMBEDDED_PG_SRC="$PAPERCUSP_ROOT/packages/embedded-postgres-server"
EMBEDDED_PG_DST="$SIDECAR_DIR/node_modules/@papercusp/embedded-postgres-server"
echo "→ bundling embedded-postgres-server"
if [[ ! -d "$EMBEDDED_PG_SRC" ]]; then
  echo "ERROR: @restart/embedded-postgres-server not found at $EMBEDDED_PG_SRC"
  exit 1
fi
mkdir -p "$EMBEDDED_PG_DST"
cp "$EMBEDDED_PG_SRC/package.json" "$EMBEDDED_PG_DST/"
cp -a "$EMBEDDED_PG_SRC/src" "$EMBEDDED_PG_DST/"
cp -a "$EMBEDDED_PG_SRC/bin" "$EMBEDDED_PG_DST/"
chmod +x "$EMBEDDED_PG_DST/bin/embedded-postgres-server.mjs"
# Install embedded-postgres + postgres-js. embedded-postgres pulls platform
# binaries (~60-150MB per arch) — npm picks the right @embedded-postgres/<plat>
# package automatically based on the build host's platform. For
# cross-platform releases, run this script once per target platform.
echo "→ installing embedded-postgres-server runtime deps into the bundle (~60-150MB binary download)"
( cd "$EMBEDDED_PG_DST" && npm install --omit=dev --no-workspaces --legacy-peer-deps --silent ) || {
  echo "ERROR: failed to install embedded-postgres-server runtime deps"
  exit 1
}
# WI-5651: cross-swap the embedded-postgres binary pkg for a darwin build. npm
# resolved @embedded-postgres/<HOST> above (e.g. linux-x64 — it keys the optional
# binary pkg on the build host); for a cross darwin bundle that is dead weight AND
# wrong. Drop it and fetch the target's binary pkg at the SAME resolved version.
# The published @embedded-postgres/darwin-<arch> tarball SHIPS native/bin/{initdb,
# postgres,pg_ctl} as real Mach-O UNIVERSAL (fat x86_64+arm64) directly — no
# postinstall — so npm-pack+extract yields runnable binaries the assertion below
# accepts. (Proven on linux, WI-5651.)
if [[ "$CROSS_BUILD" == "1" && "$TARGET_OS" == "darwin" ]]; then
  _epg_root="$EMBEDDED_PG_DST/node_modules/@embedded-postgres"
  _epg_host="$(ls "$_epg_root" 2>/dev/null | sed -n 1p)"
  [[ -n "$_epg_host" ]] || { echo "ERROR: no @embedded-postgres/<host> pkg after npm install — cannot derive the cross version"; exit 1; }
  _epg_ver="$(node -e "console.log(require('$_epg_root/$_epg_host/package.json').version)" 2>/dev/null)"
  [[ -n "$_epg_ver" ]] || { echo "ERROR: could not read installed @embedded-postgres/$_epg_host version"; exit 1; }
  echo "→ WI-5651 cross-swapping embedded-postgres binary pkg: drop $_epg_host, fetch darwin-${TARGET_ARCH}@${_epg_ver}"
  rm -rf "${_epg_root:?}"/*
  fetch_cross_npm_pkg "@embedded-postgres/darwin-${TARGET_ARCH}@${_epg_ver}" "$EMBEDDED_PG_DST/node_modules" || exit 1
  # tar/umask can drop the exec bit on extract; the assertion below requires -x.
  chmod +x "$_epg_root/darwin-${TARGET_ARCH}/native/bin/"* 2>/dev/null || true
fi

# EI-21492557010868835: the npm platform packages lag PostgreSQL security
# releases (the newest Linux package was 18.4 while the current security floor
# is 18.6).  A vm-release must never silently inherit that stale binary or the
# build host's ambient Node/gh/Kopia.  Build the exact Linux x64 trust toolchain
# from checksum-pinned upstream inputs, then replace ONLY the installed
# @embedded-postgres platform package's native payload.  The package's tiny JS
# path-export shim remains the maintained embedded-postgres integration seam.
if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
  # shellcheck source=lib/vm-release-trust-toolchain.sh
  source "$HERE/lib/vm-release-trust-toolchain.sh"
  papercusp_prepare_vm_release_trust_toolchain \
    "${PAPERCUSP_VM_RELEASE_TRUST_CACHE_DIR:-$SIDECAR_BIN_CACHE/vm-release-trust}" \
    "$TARGET_OS" "$TARGET_ARCH"

  _epg_root="$EMBEDDED_PG_DST/node_modules/@embedded-postgres"
  _epg_platform_dir="$_epg_root/linux-x64"
  if [[ ! -d "$_epg_platform_dir" ]]; then
    echo "ERROR: vm-release expected the installed @embedded-postgres/linux-x64 package at $_epg_platform_dir" >&2
    exit 1
  fi
  rm -rf "$_epg_platform_dir/native"
  mkdir -p "$_epg_platform_dir/native"
  cp -a "$PAPERCUSP_VM_RELEASE_TRUST_ROOT/postgresql/." "$_epg_platform_dir/native/"
  node - "$_epg_platform_dir/package.json" "$PAPERCUSP_VM_RELEASE_TRUST_ROOT/manifest.json" <<'NODE'
const fs = require('node:fs');
const packagePath = process.argv[2];
const manifestPath = process.argv[3];
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
pkg.version = '18.6.0-papercusp.1';
pkg.papercuspVmRelease = {
  revision: manifest.revision,
  source: manifest.postgresql,
};
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
NODE
  mkdir -p "$SIDECAR_DIR/apps/operator/runtime"
  cp "$PAPERCUSP_VM_RELEASE_TRUST_ROOT/manifest.json" \
    "$SIDECAR_DIR/apps/operator/runtime/vm-release-trust-toolchain.json"
  echo "  ✓ replaced npm PostgreSQL payload with pinned PostgreSQL $PAPERCUSP_VM_POSTGRES_VERSION + OpenSSL $PAPERCUSP_VM_OPENSSL_VERSION"
fi
# Sanity check: must have at least one @embedded-postgres/<platform> binary pkg
if ! ls "$EMBEDDED_PG_DST/node_modules/@embedded-postgres" 2>/dev/null | grep -c . >/dev/null; then
  echo "ERROR: bundled embedded-postgres missing platform binary — node_modules install didn't include @embedded-postgres/*"
  exit 1
fi

# ── BUILD-TIME ASSERTION: the embedded-PG server binaries MUST be real ──────
# This is the guard for the 0-byte-binary bug (2026-06-01): a concurrent /
# interrupted build, a strip step, or a botched copy can leave initdb /
# postgres present-but-empty or non-executable in the bundle. The packaged
# app would then fail to initdb at runtime. With the pglite fallback gone,
# that's a hard, user-visible failure — so catch it HERE, at build time,
# before anything ships. We assert across EVERY bundled @embedded-postgres
# platform tree (cross-platform builds may have more than one).
echo "→ asserting embedded-postgres binaries are present, non-empty, and executable"
pg_bin_checked=0
for _pg_bin_dir in "$EMBEDDED_PG_DST/node_modules/@embedded-postgres"/*/native/bin; do
  [[ -d "$_pg_bin_dir" ]] || continue
  for _req_bin in initdb postgres; do
    _bin_path="$_pg_bin_dir/$_req_bin"
    if [[ ! -e "$_bin_path" ]]; then
      echo "ERROR: bundled embedded-PG binary missing: $_bin_path"
      echo "  The embedded-postgres npm install did not produce this binary."
      echo "  Refusing to ship a bundle whose Postgres cannot initdb."
      exit 1
    fi
    if [[ ! -s "$_bin_path" ]]; then
      echo "ERROR: bundled embedded-PG binary is 0 bytes: $_bin_path"
      echo "  An empty binary means an interrupted build or a botched copy"
      echo "  truncated it. (Concurrent builds are flock-serialized and publish"
      echo "  atomically since P-056, so a parallel build should no longer be"
      echo "  the cause.) Refusing to ship a broken Postgres."
      exit 1
    fi
    if [[ ! -x "$_bin_path" ]]; then
      echo "ERROR: bundled embedded-PG binary is not executable: $_bin_path"
      echo "  The executable bit was lost (cp without -a / mode-preservation)."
      echo "  Refusing to ship a Postgres binary the app cannot exec."
      exit 1
    fi
    _bin_size=$(stat -c %s "$_bin_path" 2>/dev/null || stat -f %z "$_bin_path" 2>/dev/null || echo 0)
    echo "  ✓ $_req_bin: ${_bin_size} bytes, executable ($_bin_path)"
    pg_bin_checked=$((pg_bin_checked + 1))
  done
done
if [[ "$pg_bin_checked" -eq 0 ]]; then
  echo "ERROR: no @embedded-postgres/*/native/bin/ tree found to assert against"
  echo "  Expected initdb + postgres under $EMBEDDED_PG_DST/node_modules/@embedded-postgres/*/native/bin/"
  exit 1
fi

# ── WI-5651: restore the darwin dylib compat symlinks the cross-fetch dropped ──
# The @embedded-postgres/darwin-<arch> server binaries (postgres/initdb/pg_ctl)
# reference dylibs by their SHORT soname via @loader_path/../lib/<name>
# (libzstd.1.dylib, liblz4.1.dylib, libz.1.dylib, libicui18n.dylib, …), but
# native/lib ships only the FULLY-versioned files (libzstd.1.5.7.dylib, …). A
# Homebrew keg carries the short→versioned compat symlinks; the npm-pack→extract
# cross-fetch above drops them. dyld then aborts the instant postgres is exec'd
# on macOS ("Library not loaded: @loader_path/../lib/libzstd.1.dylib") — a
# failure the linux-side verifier is blind to (it cannot run a Mach-O; caught
# only by executing on the mac VM, WI-5651). Re-create every referenced-but-
# missing name as a symlink to its versioned counterpart. Idempotent (ln -sf),
# a no-op where the package already ships the link. (libcurl.4.dylib — referenced
# only by libpq-oauth-18.dylib, the OAuth plugin embedded PG never dlopens under
# local/trust auth — has no bundled counterpart and is correctly skipped.)
_pg_otool="$(command -v llvm-otool-18 2>/dev/null || command -v otool 2>/dev/null || true)"
if [[ -n "$_pg_otool" ]]; then
  for _pg_native in "$EMBEDDED_PG_DST/node_modules/@embedded-postgres"/darwin-*/native; do
    [[ -d "$_pg_native/lib" ]] || continue
    _pg_made=0
    _pg_refs="$( { for _f in "$_pg_native/bin/"* "$_pg_native/lib/"*.dylib; do [[ -f "$_f" ]] && "$_pg_otool" -L "$_f" 2>/dev/null; done; } \
      | grep -oE '@loader_path/\.\./lib/[^ ]+\.dylib' | sed 's#.*/lib/##' | sort -u )"
    for _ref in $_pg_refs; do
      [[ -e "$_pg_native/lib/$_ref" ]] && continue
      # Versioned counterpart: libzstd.1.dylib → libzstd.1.<ver>.dylib. compgen -G
      # so a ref with NO bundled counterpart (e.g. libcurl.4.dylib — OAuth-only,
      # never dlopen'd) yields an EMPTY list and is SKIPPED. The prior
      # `ls "…${_ref%.dylib}."*.dylib | sed -n 1p` aborted the ENTIRE sidecar build on
      # such a ref: an unmatched glob makes `ls` exit 2, and under this script's
      # `set -euo pipefail` the failing command-substitution assignment tripped
      # errexit (exit 2, no error text) — invisible when the block is run
      # interactively without errexit, caught only by a clean in-script rebuild.
      # Portable equivalent of `mapfile -t` (avoid — macOS ships bash 3.2
      # system-wide (GPLv3 license cutoff after bash 3.2), which predates
      # `mapfile`/`readarray` (bash 4.0+); a remote build invoked over ssh
      # without an explicit Homebrew-bash PATH override resolves `bash` to
      # that ancient system one and dies here with "mapfile: command not
      # found" (WI-5769 — 5th independently-discovered missing-dependency-
      # class packaging bug, this one an interpreter-version bug not a
      # missing npm dep). `while read` is bash-3.2-safe.
      _pg_cands=()
      while IFS= read -r _pg_cand; do
        [[ -n "$_pg_cand" ]] && _pg_cands+=("$_pg_cand")
      done < <(compgen -G "$_pg_native/lib/${_ref%.dylib}.*.dylib" || true)
      [[ ${#_pg_cands[@]} -gt 0 ]] || continue
      ln -sf "$(basename "${_pg_cands[0]}")" "$_pg_native/lib/$_ref" && _pg_made=$((_pg_made + 1))
    done
    echo "  ✓ darwin PG dylib compat symlinks: ${_pg_made} restored in ${_pg_native#$SIDECAR_DIR/}/lib"
  done
fi

# Bundle pgvector into the embedded-postgres binary tree, per platform.
# Without this, mem0's vector store falls back to in-process memory
# (volatile across restarts). The embedded-postgres binaries from zonky
# ship server-only — no extensions beyond plpgsql — so we source pgvector
# from a system install on the build host and copy it into the bundle.
#
# Platform sources:
#   Linux (Ubuntu/Debian): apt install postgresql-18-pgvector
#                          → /usr/lib/postgresql/18/lib/vector.so
#                            /usr/share/postgresql/18/extension/vector*
#   macOS (Homebrew):      brew install pgvector (against postgresql@18)
#                          → $(brew --prefix)/lib/postgresql/vector.dylib
#                            $(brew --prefix)/share/postgresql@18/extension/vector*
#   Windows:               No automation yet; we warn and continue. mem0
#                          falls back to in-memory provider on Windows
#                          desktops until a vector.dll is bundled.
# WI-5651: shared OCI core for fetching a Homebrew bottle for a DARWIN target
# FROM this linux host (brew is absent here). Homebrew publishes bottles as OCI
# artifacts on ghcr; this pulls the darwin/<arch> bottle for <formula>@<ver> from
# ghcr repo <repo>, PREFERRING the macOS 14 (sonoma) build (proven ABI-matched to
# zonky's embedded PG18), falling back to the newest available. Extracts the
# tarball and echoes the extraction TMP root — the caller finds files under it and
# MUST rm -rf it when done. set -e is DISABLED inside (these fns are called via
# `||`), so every failure is checked by hand and returns non-zero.
_fetch_brew_bottle_raw() {
  local formula="$1" ver="$2" arch="$3" repo="$4"
  local brew_arch; case "$arch" in x64) brew_arch=amd64 ;; arm64) brew_arch=arm64 ;; *) echo "bottle($formula): unsupported arch $arch" >&2; return 1 ;; esac
  local token; token="$(curl -fsSL "https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' 2>/dev/null)"
  [[ -n "$token" ]] || { echo "bottle($formula): ghcr token fetch failed" >&2; return 1; }
  local idx; idx="$(curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/vnd.oci.image.index.v1+json" "https://ghcr.io/v2/${repo}/manifests/${ver}" 2>/dev/null)"
  [[ -n "$idx" ]] || { echo "bottle($formula): index manifest fetch failed (v${ver})" >&2; return 1; }
  local nested; nested="$(printf '%s' "$idx" | python3 -c '
import sys,json,re
idx=json.load(sys.stdin); want=sys.argv[1]
def mac(s):
    m=re.search(r"(\d+)", s or ""); return int(m.group(1)) if m else -1
cands=[]
for m in idx.get("manifests",[]):
    p=m.get("platform",{}) or {}
    if p.get("os")=="darwin" and p.get("architecture")==want:
        cands.append((mac(p.get("os.version","")), m.get("digest","")))
if not cands: sys.exit(1)
# prefer macOS 14 (sonoma, proven), else the newest available
sonoma=[c for c in cands if c[0]==14]
pick=sonoma[0] if sonoma else max(cands, key=lambda c:c[0])
print(pick[1])
' "$brew_arch" 2>/dev/null)"
  [[ -n "$nested" ]] || { echo "bottle($formula): no darwin/$brew_arch manifest in the index" >&2; return 1; }
  local man; man="$(curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/vnd.oci.image.manifest.v1+json" "https://ghcr.io/v2/${repo}/manifests/${nested}" 2>/dev/null)"
  local layer; layer="$(printf '%s' "$man" | python3 -c 'import sys,json;print(json.load(sys.stdin)["layers"][0]["digest"])' 2>/dev/null)"
  [[ -n "$layer" ]] || { echo "bottle($formula): could not read layer digest" >&2; return 1; }
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL -H "Authorization: Bearer $token" "https://ghcr.io/v2/${repo}/blobs/${layer}" -o "$tmp/bottle.tar.gz" 2>/dev/null || { echo "bottle($formula): blob download failed" >&2; rm -rf "$tmp"; return 1; }
  tar -xzf "$tmp/bottle.tar.gz" -C "$tmp" 2>/dev/null || { echo "bottle($formula): tar extract failed" >&2; rm -rf "$tmp"; return 1; }
  printf '%s\n' "$tmp"
}

# WI-5651: fetch <formula>@<ver> darwin bottle and copy its keg root (the dir
# directly containing bin/ lib/ share/) into <outdir>. Echoes <outdir>. Sources
# the darwin PostgreSQL client tools + libreadline on the linux cross host.
fetch_brew_keg() {
  local formula="$1" ver="$2" arch="$3" repo="$4" outdir="$5"
  local tmp; tmp="$(_fetch_brew_bottle_raw "$formula" "$ver" "$arch" "$repo")" || return 1
  local keg; keg="$(find "$tmp" -maxdepth 4 -type d \( -name bin -o -name lib \) 2>/dev/null | sed -n 1p)"
  [[ -n "$keg" ]] || { echo "bottle($formula): could not locate keg root (no bin/ or lib/)" >&2; rm -rf "$tmp"; return 1; }
  keg="$(dirname "$keg")"
  rm -rf "$outdir"; mkdir -p "$outdir"
  cp -a "$keg/." "$outdir/" || { echo "bottle($formula): keg copy failed" >&2; rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  printf '%s\n' "$outdir"
}

# WI-2039869 (2026-09-01): Homebrew has begun DROPPING darwin/amd64 (Intel-mac)
# bottles from formulae's newest versions — first measured hit: pcre2 10.48,
# whose ghcr index carries only darwin/arm64 + linux, which failed the P-101
# x86_64 cross-bake with "no darwin/amd64 manifest in the index". When the
# brew-API stable version ships no darwin/<arch> bottle, walk the ghcr tag list
# newest-first and return the newest version that DOES (10.47_1 for pcre2 —
# incl. the preferred sonoma build). ABI: these vendored dylibs keep their
# install-name/SOVERSION across patch/minor bumps (libpcre2-8.0.dylib,
# libintl.8.dylib, libreadline.8.dylib), the same contract the sonoma
# preference in _fetch_brew_bottle_raw already relies on. On any probe failure
# this echoes the original version unchanged so the real fetch reports the
# real error. Callers: postgresql@major, readline, git, pcre2/gettext.
_brew_ver_with_darwin_bottle() {
  local formula="$1" ver="$2" arch="$3" repo="$4"
  local brew_arch; case "$arch" in x64) brew_arch=amd64 ;; arm64) brew_arch=arm64 ;; *) printf '%s\n' "$ver"; return 0 ;; esac
  local token; token="$(curl -fsSL "https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' 2>/dev/null)"
  [[ -n "$token" ]] || { printf '%s\n' "$ver"; return 0; }
  _bvwdb_has_darwin() {
    curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/vnd.oci.image.index.v1+json" \
      "https://ghcr.io/v2/${repo}/manifests/$1" 2>/dev/null | python3 -c '
import sys,json
want=sys.argv[1]
try: idx=json.load(sys.stdin)
except Exception: sys.exit(1)
for m in idx.get("manifests",[]):
    p=m.get("platform",{}) or {}
    if p.get("os")=="darwin" and p.get("architecture")==want: sys.exit(0)
sys.exit(1)' "$brew_arch"
  }
  if _bvwdb_has_darwin "$ver"; then printf '%s\n' "$ver"; return 0; fi
  echo "  ⚠ bottle($formula): v$ver ships no darwin/$brew_arch bottle (Homebrew dropped Intel-mac bottles for it) — probing older tags" >&2
  local tags; tags="$(curl -fsSL -H "Authorization: Bearer $token" "https://ghcr.io/v2/${repo}/tags/list?n=100" 2>/dev/null | python3 -c 'import sys,json;print("\n".join(json.load(sys.stdin).get("tags",[])))' 2>/dev/null | grep -E '^[0-9]' | sort -rV)"
  local t probed=0
  while IFS= read -r t; do
    [[ -n "$t" && "$t" != "$ver" ]] || continue
    probed=$((probed+1)); [[ $probed -le 8 ]] || break
    if _bvwdb_has_darwin "$t"; then
      echo "  ⚠ bottle($formula): falling back to v$t — the newest tag with a darwin/$brew_arch bottle" >&2
      printf '%s\n' "$t"; return 0
    fi
  done <<< "$tags"
  printf '%s\n' "$ver"; return 0
}

# WI-5651: fetch the pgvector Homebrew bottle for a darwin target and normalize
# to <out>/vector.dylib + <out>/extension/ (from share/postgresql@18/extension).
fetch_pgvector_darwin_bottle() {
  local ver="$1" arch="$2"
  local tmp; tmp="$(_fetch_brew_bottle_raw pgvector "$ver" "$arch" homebrew/core/pgvector)" || return 1
  # The bottle carries BOTH share/postgresql@18/extension (the SQL + vector.control
  # we want) AND include/postgresql@18/server/extension (headers, no control) — so
  # target the share/ path EXPLICITLY, or a bare `-name extension` picks include/
  # (it sorts first) and the copy fails. NB: set -e is DISABLED inside this fn (it
  # is called via `||`), so every failure is checked by hand and returns non-zero.
  local dylib; dylib="$(find "$tmp" -type f -path '*/lib/postgresql@18/vector.dylib' | sed -n 1p)"
  [[ -z "$dylib" ]] && dylib="$(find "$tmp" -type f -name vector.dylib | sed -n 1p)"
  local extdir; extdir="$(find "$tmp" -type d -path '*/share/postgresql@18/extension' | sed -n 1p)"
  [[ -z "$extdir" ]] && extdir="$(dirname "$(find "$tmp" -type f -path '*/share/*' -name vector.control | sed -n 1p)")"
  [[ -f "$dylib" ]] || { echo "pgvector bottle: lib/postgresql@18/vector.dylib not found in bottle" >&2; rm -rf "$tmp"; return 1; }
  [[ -n "$extdir" && -f "$extdir/vector.control" ]] || { echo "pgvector bottle: share/postgresql@18/extension/vector.control not found in bottle" >&2; rm -rf "$tmp"; return 1; }
  local out; out="$(mktemp -d)"; mkdir -p "$out/extension"
  cp "$dylib" "$out/vector.dylib" || { echo "pgvector bottle: dylib copy failed" >&2; rm -rf "$tmp"; return 1; }
  cp "$extdir"/vector*.sql "$out/extension/" 2>/dev/null || true
  cp "$extdir"/vector.control "$out/extension/" || { echo "pgvector bottle: vector.control copy failed" >&2; rm -rf "$tmp"; return 1; }
  [[ -f "$out/vector.dylib" && -f "$out/extension/vector.control" ]] || { echo "pgvector bottle: normalized output incomplete" >&2; rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  printf '%s\n' "$out"
}
echo "→ bundling pgvector into embedded-postgres (per platform)"
pgvector_copied=0
# WI-5651: route pgvector's platform off TARGET_OS (default host), NOT uname — a
# cross darwin bundle must ship the darwin vector.dylib, not this linux host's .so.
# TARGET_OS is already spelled linux|darwin|windows, matching the branches below.
_pgv_os="$TARGET_OS"
case "$_pgv_os" in
  linux)
    pgv_lib_src="/usr/lib/postgresql/18/lib/vector.so"
    pgv_ext_src="/usr/share/postgresql/18/extension"
    pgv_lib_ext="so"
    ;;
  darwin)
    pgv_lib_ext="dylib"
    if [[ "$CROSS_BUILD" == "1" ]]; then
      # brew is absent on the linux cross host — fetch the darwin bottle from ghcr.
      _pgv_ver="$(curl -fsSL https://formulae.brew.sh/api/formula/pgvector.json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["versions"]["stable"])' 2>/dev/null)"
      [[ -n "$_pgv_ver" ]] || { echo "ERROR: could not resolve pgvector stable version from the brew formula api"; exit 1; }
      echo "  → cross: fetching pgvector ${_pgv_ver} darwin-${TARGET_ARCH} bottle from ghcr (no brew on ${_host_os})"
      _pgv_bottle="$(fetch_pgvector_darwin_bottle "$_pgv_ver" "$TARGET_ARCH")" || { echo "ERROR: pgvector darwin bottle fetch failed (see above)"; exit 1; }
      pgv_lib_src="$_pgv_bottle/vector.dylib"
      pgv_ext_src="$_pgv_bottle/extension"
    elif command -v brew >/dev/null 2>&1; then
      brew_prefix="$(brew --prefix 2>/dev/null)"
      pgv_lib_src="$brew_prefix/lib/postgresql/vector.dylib"
      pgv_ext_src="$brew_prefix/share/postgresql@18/extension"
      if [[ ! -f "$pgv_lib_src" ]] && pg_prefix=$(brew --prefix postgresql@18 2>/dev/null); then
        pgv_lib_src="$pg_prefix/lib/postgresql/vector.dylib"
        pgv_ext_src="$pg_prefix/share/postgresql@18/extension"
      fi
      # Modern pgvector keg layout: per-PG-version subdirs under the
      # pgvector keg itself (opt/pgvector/lib/postgresql@18/vector.dylib).
      if [[ ! -f "$pgv_lib_src" ]] && pgv_prefix=$(brew --prefix pgvector 2>/dev/null); then
        pgv_lib_src="$pgv_prefix/lib/postgresql@18/vector.dylib"
        pgv_ext_src="$pgv_prefix/share/postgresql@18/extension"
      fi
    fi
    ;;
  windows)
    echo "  ⚠ pgvector not bundled on Windows (no automated source); mem0 will use in-memory fallback on Windows desktops"
    pgv_lib_src=""
    ;;
esac

if [[ -n "${pgv_lib_src:-}" ]]; then
  if [[ -f "$pgv_lib_src" && -d "$pgv_ext_src" ]]; then
    for plat_dir in "$EMBEDDED_PG_DST/node_modules/@embedded-postgres"/*/native; do
      [[ -d "$plat_dir" ]] || continue
      # The upstream npm binaries use Debian's lib/postgresql +
      # share/postgresql/extension layout.  The pinned vm-release source build
      # uses PostgreSQL's relocatable prefix layout (lib + share/extension).
      # Select from the tree we actually assembled; never copy vector into a
      # second directory the running postmaster does not search.
      if [[ -f "$plat_dir/lib/pgcrypto.so" && -d "$plat_dir/share/extension" ]]; then
        _pgv_runtime_lib_dir="$plat_dir/lib"
        _pgv_runtime_ext_dir="$plat_dir/share/extension"
      else
        _pgv_runtime_lib_dir="$plat_dir/lib/postgresql"
        _pgv_runtime_ext_dir="$plat_dir/share/postgresql/extension"
      fi
      mkdir -p "$_pgv_runtime_lib_dir" "$_pgv_runtime_ext_dir"
      # cp -f, not GNU-only -u: BSD/macOS cp has no -u.
      cp -f "$pgv_lib_src" "$_pgv_runtime_lib_dir/"
      cp -f "$pgv_ext_src"/vector*.sql "$_pgv_runtime_ext_dir/"
      cp -f "$pgv_ext_src/vector.control" "$_pgv_runtime_ext_dir/"
      pgvector_copied=$((pgvector_copied + 1))
    done
    echo "  ✓ pgvector copied into $pgvector_copied embedded-postgres tree(s) (lib.${pgv_lib_ext} + sql + control)"
  else
    # HARD ERROR, not the old "mem0 in-memory fallback" warning: the
    # baseline schema CREATEs vector-typed columns, so a fresh-DB boot of a
    # bundle without pgvector dies fatally ('type "public.vector" does not
    # exist') — proven on the first mac DMG first-launch (2026-06-11).
    echo "ERROR: pgvector not found at $pgv_lib_src — a bundle without it cannot boot a fresh database"
    case "$_pgv_os" in
      linux)  echo "    Install: sudo apt install postgresql-18-pgvector" ;;
      darwin) echo "    Install: brew install pgvector  (requires postgresql@18 keg)" ;;
    esac
    exit 1
  fi
fi

# Fail loudly if pgvector ended up NOT bundled on a platform that requires it.
# The per-source HARD ERROR above only fires when a source was FOUND but
# incomplete (brew present, .dylib missing). It does NOT catch the SILENT-SKIP
# cases: on darwin `pgv_lib_src` is only set inside `if command -v brew`, so a
# build shell without `brew` on PATH (e.g. a NON-LOGIN shell that never ran
# path_helper, so /usr/local/bin is absent) leaves it empty → the whole block
# is skipped with no copy and no error → a bundle ships with no pgvector and
# dies on first fresh-DB boot ('type "public.vector" does not exist'). This
# backstop makes that a build failure instead. (Proven live 2026-06-30 on the
# mac VM: a nohup/non-login test build silently shipped a pgvector-less sidecar.)
if [[ "$_pgv_os" != "windows" && "${pgvector_copied:-0}" -eq 0 ]]; then
  echo "ERROR: pgvector was NOT bundled into any embedded-postgres tree on $_pgv_os."
  echo "       A fresh-DB boot will die fatally with 'type \"public.vector\" does not exist'."
  case "$_pgv_os" in
    linux)  echo "       Install: sudo apt install postgresql-18-pgvector" ;;
    darwin) echo "       Install: brew install pgvector  — AND ensure 'brew' is on PATH for the build shell"
            echo "                (a non-login shell may lack /usr/local/bin; run the build via 'bash -lc' or 'eval \$(/usr/local/bin/brew shellenv)')" ;;
  esac
  exit 1
fi

# Surface real pg_dump / psql to the sidecar's $PATH so the snapshot
# subsystem (packages/backup/src/hook.ts spawns `pg_dump` by bare name; the
# legacy libs/papercusp-export-state/src/pg-dump.ts is retired) finds them.
# NOTE hook.ts DEGRADES SOFTLY on spawn failure — a broken vendored tool means
# snapshots silently ship WITHOUT the PG dump, which is why the guards below
# hard-fail the build instead of trusting a runtime error to surface it.
# Replaces the legacy WASM-pg_dump path that went through pglite-server's
# /admin/pg-dump endpoint.
#
# IMPORTANT: zonky's embedded-postgres-binaries (what `embedded-postgres`
# wraps) ships SERVER-only — initdb, pg_ctl, postgres. Client tools
# (pg_dump, psql, pg_dumpall) are stripped to keep size small (~60MB
# instead of ~200MB). So we can't symlink from the embedded distribution
# alone; we have to source the client tools elsewhere. Strategy:
#   1. If an embedded copy exists for the tool → use it.
#   2. Otherwise, copy from the build host's system PATH.
#   3. If neither: HARD FAIL — snapshot capture would be broken on the
#      shipped bundle. Don't silently produce a broken release.
mkdir -p "$SIDECAR_DIR/bin"
EMBEDDED_PG_BIN_DIR=""
for plat in "$EMBEDDED_PG_DST/node_modules/@embedded-postgres"/*/native/bin; do
  if [[ -d "$plat" ]]; then
    EMBEDDED_PG_BIN_DIR="$plat"
    break
  fi
done
if [[ -z "$EMBEDDED_PG_BIN_DIR" ]]; then
  echo "ERROR: could not find native/bin directory inside @embedded-postgres/*"
  exit 1
fi
echo "→ wiring pg_dump / psql / pg_dumpall into $SIDECAR_DIR/bin/"
SOURCE_NOTE_FILE="$SIDECAR_DIR/bin/.pg-tools-source"
> "$SOURCE_NOTE_FILE"

# shellcheck source=lib/sidecar-source-note.sh
source "$HERE/lib/sidecar-source-note.sh"

# WI-4419: this note SHIPS inside the bundle, and the release identity scan reads the bytes that
# ship — it honours NO path-exclude list, by design. So an absolute build-box path written here is
# a build-box identity leak (`/home/<user>/...` names both the machine and its operator), and it
# fails the release build at the very END of a ~12-minute run, long after this line wrote it.
#
# The note's VALUE is provenance — WHICH source a tool came from — and that survives relativisation
# completely intact. So scrub the location rather than dropping the note, and never reach for an
# exclude: the scan ignores excludes by design, so excluding the path would not even work.
# The sourced helper also asserts this transformation at write time, so a future source-note
# caller fails at the producer instead of waiting for the terminal assembled-sidecar scan.
#
# WI-5651: cross-baking the darwin sidecar on THIS linux host. The client-tool
# wiring below needs a dedicated cross-darwin path — every host-source branch
# resolves LINUX binaries, and the darwin Mach-Os can't be exec'd here (so even
# the version/probe steps must avoid running them).
_cross_darwin=0
[[ "$CROSS_BUILD" == "1" && "$TARGET_OS" == "darwin" ]] && _cross_darwin=1
# The embedded server's major version — vendored client tools must match it
# (pg_dump cannot dump a server NEWER than itself, so distro-default clients —
# e.g. Ubuntu 24.04's v16 vs our embedded 18 — are not acceptable sources).
if [[ "$_cross_darwin" == "1" ]]; then
  # Can't exec the darwin `postgres` binary on this linux host — derive the major
  # from the installed @embedded-postgres/<platform> package version instead
  # (e.g. 18.3.0-beta.17 → 18). EMBEDDED_PG_BIN_DIR is <pkg>/native/bin.
  _epg_pkg_json="$(cd "$EMBEDDED_PG_BIN_DIR/../.." 2>/dev/null && pwd)/package.json"
  EMBEDDED_PG_MAJOR="$(node -e "console.log(String(require('$_epg_pkg_json').version).split('.')[0])" 2>/dev/null)"
else
  EMBEDDED_PG_MAJOR="$("$EMBEDDED_PG_BIN_DIR/postgres" --version 2>/dev/null | grep -oE '[0-9]+' | sed -n 1p)"
fi
if [[ -z "$EMBEDDED_PG_MAJOR" ]]; then
  echo "ERROR: could not determine embedded postgres major version from $EMBEDDED_PG_BIN_DIR/postgres"
  exit 1
fi

# vm-release consumes the pinned Kopia output independently of how the embedded
# PostgreSQL major was derived. Keeping this as a separate branch is load-bearing:
# making it an arm of the major-version branch leaves EMBEDDED_PG_MAJOR unset under
# `set -u` and aborts the release build before atomic sidecar publication.
if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
  [[ -n "${PAPERCUSP_VM_RELEASE_TRUST_ROOT:-}" \
     && -x "$PAPERCUSP_VM_RELEASE_TRUST_ROOT/bin/kopia" ]] || {
    echo "ERROR: vm-release pinned Kopia output is unavailable" >&2
    exit 1
  }
  cp "$PAPERCUSP_VM_RELEASE_TRUST_ROOT/bin/kopia" "$SIDECAR_DIR/bin/kopia"
  chmod 755 "$SIDECAR_DIR/bin/kopia"
  "$SIDECAR_DIR/bin/kopia" --version | grep -Fc "${PAPERCUSP_VM_KOPIA_VERSION}-papercusp.1" >/dev/null || {
    echo "ERROR: vm-release copied Kopia does not match the pinned patched build" >&2
    exit 1
  }
  echo "  kopia: pinned source build $PAPERCUSP_VM_KOPIA_VERSION-papercusp.1 ($PAPERCUSP_VM_KOPIA_COMMIT)"
  echo "kopia: pinned source build (${PAPERCUSP_VM_KOPIA_VERSION}-papercusp.1 $PAPERCUSP_VM_KOPIA_COMMIT)" >> "$SOURCE_NOTE_FILE"
fi

# WI-5651 cross-darwin: pre-fetch the darwin PostgreSQL client tools (Homebrew
# postgresql@<major> bottle) + the one dylib the embedded native/lib lacks
# (libreadline, psql's dep). The tool loop below sources from $_cross_darwin_pg_keg
# and rewrites keg-dylib refs via _cross_darwin_vendor_pg_tool. native/lib already
# ships libpq/libintl/libcrypto/liblz4/libzstd for the server, so we REUSE those
# and vendor ONLY readline — avoiding a duplicate multi-dylib closure in the app.
_cross_darwin_pg_keg=""
if [[ "$_cross_darwin" == "1" ]]; then
  _brew_pg_ver="$(curl -fsSL "https://formulae.brew.sh/api/formula/postgresql@${EMBEDDED_PG_MAJOR}.json" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["versions"]["stable"])' 2>/dev/null)"
  [[ -n "$_brew_pg_ver" ]] || { echo "ERROR: could not resolve postgresql@${EMBEDDED_PG_MAJOR} stable version from the brew formula api"; exit 1; }
  _brew_pg_ver="$(_brew_ver_with_darwin_bottle "postgresql@${EMBEDDED_PG_MAJOR}" "$_brew_pg_ver" "$TARGET_ARCH" "homebrew/core/postgresql/${EMBEDDED_PG_MAJOR}")"
  echo "  → cross: fetching postgresql@${EMBEDDED_PG_MAJOR} ${_brew_pg_ver} darwin-${TARGET_ARCH} client tools from ghcr (no brew on ${_host_os})"
  _cross_darwin_pg_keg="$(fetch_brew_keg "postgresql@${EMBEDDED_PG_MAJOR}" "$_brew_pg_ver" "$TARGET_ARCH" "homebrew/core/postgresql/${EMBEDDED_PG_MAJOR}" "$(mktemp -d)/pgkeg")" \
    || { echo "ERROR: postgresql@${EMBEDDED_PG_MAJOR} darwin bottle fetch failed (see above)"; exit 1; }
  # readline: psql's one non-system dep NOT already in native/lib. Vendor it into
  # bin/.pg-lib (its only dep, libncurses, is a macOS system lib — leave it).
  _brew_rl_ver="$(curl -fsSL "https://formulae.brew.sh/api/formula/readline.json" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["versions"]["stable"])' 2>/dev/null)"
  [[ -n "$_brew_rl_ver" ]] || { echo "ERROR: could not resolve readline stable version from the brew formula api"; exit 1; }
  _brew_rl_ver="$(_brew_ver_with_darwin_bottle readline "$_brew_rl_ver" "$TARGET_ARCH" "homebrew/core/readline")"
  echo "  → cross: fetching readline ${_brew_rl_ver} darwin-${TARGET_ARCH} bottle (libreadline.8 for psql)"
  _cross_rl_keg="$(fetch_brew_keg readline "$_brew_rl_ver" "$TARGET_ARCH" "homebrew/core/readline" "$(mktemp -d)/rlkeg")" \
    || { echo "ERROR: readline darwin bottle fetch failed (see above)"; exit 1; }
  mkdir -p "$SIDECAR_DIR/bin/.pg-lib"
  _rl_src="$(find "$_cross_rl_keg/lib" -maxdepth 1 -name 'libreadline.8.dylib' | sed -n 1p)"
  [[ -n "$_rl_src" ]] || _rl_src="$(find "$_cross_rl_keg/lib" -maxdepth 1 -name 'libreadline.8*.dylib' ! -type l | sed -n 1p)"
  [[ -n "$_rl_src" ]] || { echo "ERROR: libreadline.8.dylib not found in the readline bottle"; exit 1; }
  cp -L "$_rl_src" "$SIDECAR_DIR/bin/.pg-lib/libreadline.8.dylib"
  chmod 755 "$SIDECAR_DIR/bin/.pg-lib/libreadline.8.dylib"
  llvm-install-name-tool-18 -id "@executable_path/.pg-lib/libreadline.8.dylib" "$SIDECAR_DIR/bin/.pg-lib/libreadline.8.dylib"
  rcodesign sign "$SIDECAR_DIR/bin/.pg-lib/libreadline.8.dylib" >/dev/null 2>&1 \
    || { echo "ERROR: rcodesign ad-hoc sign failed for vendored libreadline.8.dylib"; exit 1; }
  echo "  ✓ cross: vendored + signed libreadline.8.dylib into bin/.pg-lib"
fi

# NEVER vendor a #!-script as a pg tool. On Debian/Ubuntu `command -v psql`
# resolves to postgresql-common's perl pg_wrapper DISPATCHER, not the real
# binary. It works on the build host (wrapper + versioned client both
# installed there) so every build-time probe passes — then dies on every
# clean machine (`Can't locate PgCommon.pm`). We shipped ALL FOUR tools as
# that broken 9.5K shim until 2026-07-07, which silently disabled the PG half
# of the snapshot subsystem in the packaged app (hook.ts degrades to a
# dump-less snapshot on spawn failure). Resolve the real binary or fail loud.
_is_script() { [[ "$(head -c 2 "$1" 2>/dev/null)" == "#!" ]]; }

# WI-3314 (darwin): brew-keg Mach-Os reference absolute /usr/local | /opt/homebrew
# dylib paths that exist only on Homebrew machines (masked on the build VM, dead
# on clean targets). Vendor the non-system dylib closure into bin/.pg-lib and
# rewrite every reference @executable_path-relative (@loader_path between
# dylibs), then ad-hoc re-sign each mutated Mach-O — install_name_tool
# invalidates the linker signature, and a stale signature can SIGKILL on load.
# The darwin twin of the Linux .pg-real/LD_LIBRARY_PATH wrapper above.
_darwin_vendor_keg_dylibs() {
  local target="$1" prefix="$2"
  local libdir="$SIDECAR_DIR/bin/.pg-lib"
  mkdir -p "$libdir"
  local dep base
  while IFS= read -r dep; do
    [[ -n "$dep" ]] || continue
    base="$(basename "$dep")"
    if [[ ! -e "$libdir/$base" ]]; then
      cp -L "$dep" "$libdir/$base"
      chmod 755 "$libdir/$base"
      install_name_tool -id "@loader_path/$base" "$libdir/$base"
      _darwin_vendor_keg_dylibs "$libdir/$base" "@loader_path"
    fi
    install_name_tool -change "$dep" "$prefix/$base" "$target"
  done < <(otool -L "$target" 2>/dev/null | awk 'NR>1{print $1}' | grep -E '^(/usr/local|/opt/homebrew)/' || true)
  codesign --force -s - "$target"
}

# WI-5651: the CROSS twin of _darwin_vendor_keg_dylibs — runs on THIS linux host
# with llvm-install-name-tool-18 + rcodesign (native otool/install_name_tool/
# codesign are macOS-only). The Homebrew bottle tools reference their dylibs via
# @@HOMEBREW_CELLAR@@ / @@HOMEBREW_PREFIX@@ placeholder TOKENS. Rewrite every
# non-system ref to REUSE the darwin native/lib already shipped for the embedded
# server (name-matched to the exact versioned filename present — the tree ships
# NO compat-name symlinks), or the caller's own vendored-lib dir (bin/.pg-lib by
# default; EI-3620 reuses this for git's bin/.git-lib via the 2nd arg — same
# placeholder-token mechanism, confirmed identical across every Homebrew bottle
# fetched via fetch_brew_keg/_fetch_brew_bottle_raw); then ad-hoc re-sign
# (rewriting the load commands invalidates the signature, and a stale one
# SIGKILLs on load). rcodesign's `verify` is buggy (exits 0 on error) — the sign
# step's exit code is the reliable signal.
# EI-3620: `vendor_dir` is an ABSOLUTE vendor-lib directory (was a bin/-relative
# subdir NAME, which silently assumed every $tool lives directly in
# $SIDECAR_DIR/bin/ — true for the flat pg_dump/psql/etc layout, but WRONG for
# git's nested bin/.git-vendor/{bin,libexec/git-core}/ tree, where two
# different real-Mach-O directories sit at two different depths relative to
# bin/). @executable_path is resolved by dyld relative to $tool's OWN
# directory at runtime, so the relative offset to nlibdir/vendor_dir is now
# computed PER TOOL via `python3 -c os.path.relpath(...)` instead of a single
# hardcoded "../" — this generalizes correctly to any nesting depth and is a
# no-op behavior change for the existing flat pg callers (relpath from
# $SIDECAR_DIR/bin/<tool> reduces to the same "../…"/".pg-lib" strings as
# before). Caught live on papercup-vm-mac (2026-07-26): the naive
# bin/-relative version shipped a `git` whose dyld load failed with "Library
# not loaded: @executable_path/.git-lib/libpcre2-8.0.dylib" because bin/git
# actually lived two directories deeper, under bin/.git-vendor/bin/.
_cross_darwin_vendor_pg_tool() {
  local tool="$1"
  local vendor_dir="${2:-$SIDECAR_DIR/bin/.pg-lib}"   # absolute vendor-lib dir
  local nlibdir="${EMBEDDED_PG_BIN_DIR%/bin}/lib"
  local tool_dir; tool_dir="$(cd "$(dirname "$tool")" && pwd)"
  local emb_lib_rel; emb_lib_rel="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$nlibdir" "$tool_dir")"
  local vendor_rel; vendor_rel="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$vendor_dir" "$tool_dir")"
  chmod +w "$tool"
  local dep base stem m tgt
  while IFS= read -r dep; do
    [[ -n "$dep" ]] || continue
    case "$dep" in /usr/lib/*|/System/*) continue ;; esac      # macOS system libs — always present
    base="$(basename "$dep")"
    tgt=""
    if [[ -e "$nlibdir/$base" ]]; then
      tgt="$base"                                              # exact (libpq.5, libintl.8, libcrypto.3)
    else
      stem="${base%.dylib}"
      m="$(ls "$nlibdir/$stem".*.dylib 2>/dev/null | sed -n 1p)" # compat→versioned (libzstd.1→libzstd.1.5.7)
      [[ -n "$m" ]] && tgt="$(basename "$m")"
    fi
    if [[ -n "$tgt" ]]; then
      llvm-install-name-tool-18 -change "$dep" "@executable_path/$emb_lib_rel/$tgt" "$tool"
    elif [[ -e "$vendor_dir/$base" ]]; then
      llvm-install-name-tool-18 -change "$dep" "@executable_path/$vendor_rel/$base" "$tool"
    else
      echo "ERROR: $(basename "$tool") links '$dep' ($base) — neither in the embedded darwin"
      echo "  native/lib ($nlibdir) nor vendored in $vendor_dir. It would dangle on a clean Mac."
      return 1
    fi
  done < <(llvm-otool-18 -L "$tool" 2>/dev/null | awk 'NR>1{print $1}' | grep -vE '^@(executable_path|loader_path|rpath)/' || true)
  rcodesign sign "$tool" >/dev/null 2>&1 || { echo "ERROR: rcodesign ad-hoc sign failed for $tool"; return 1; }
}

_pg_build_os="$(uname -s)"
for tool in pg_dump psql pg_dumpall pg_restore; do
  src=""
  method=""
  # WI-5651 cross-darwin: source from the fetched Homebrew postgresql bottle
  # (checked FIRST — every other branch below resolves this linux host's binaries).
  if [[ "$_cross_darwin" == "1" ]]; then
    if [[ -f "$_cross_darwin_pg_keg/bin/$tool" ]]; then
      src="$_cross_darwin_pg_keg/bin/$tool"
      method="copy (darwin postgresql@${EMBEDDED_PG_MAJOR} bottle)"
    else
      echo "ERROR: $tool not present in the darwin postgresql bottle ($_cross_darwin_pg_keg/bin)"
      exit 1
    fi
  fi
  if [[ -z "$src" ]] && [[ -x "$EMBEDDED_PG_BIN_DIR/$tool" ]] && ! _is_script "$EMBEDDED_PG_BIN_DIR/$tool"; then
    src="$EMBEDDED_PG_BIN_DIR/$tool"
    method="symlink (from embedded-postgres)"
  fi
  # Debian/Ubuntu: the REAL versioned binaries live under /usr/lib/postgresql/
  # (pgdg layout). Require the major to match the embedded server exactly.
  if [[ -z "$src" && "$_pg_build_os" == "Linux" && -x "/usr/lib/postgresql/$EMBEDDED_PG_MAJOR/bin/$tool" ]] \
      && ! _is_script "/usr/lib/postgresql/$EMBEDDED_PG_MAJOR/bin/$tool"; then
    src="/usr/lib/postgresql/$EMBEDDED_PG_MAJOR/bin/$tool"
    method="copy (real binary, pgdg /usr/lib/postgresql/$EMBEDDED_PG_MAJOR/bin)"
  fi
  # pg_config bindir (brew libpq keg, pgdg with pg_config on PATH, …).
  if [[ -z "$src" ]] && command -v pg_config >/dev/null 2>&1; then
    _pg_bindir="$(pg_config --bindir 2>/dev/null)"
    if [[ -n "$_pg_bindir" && -x "$_pg_bindir/$tool" ]] && ! _is_script "$_pg_bindir/$tool"; then
      src="$_pg_bindir/$tool"
      method="copy (pg_config bindir $_pg_bindir)"
    fi
  fi
  # Last resort: system PATH — but REJECT script shims instead of vendoring them.
  if [[ -z "$src" ]] && system_path=$(command -v "$tool" 2>/dev/null) && [[ -n "$system_path" ]]; then
    if _is_script "$system_path"; then
      echo "ERROR: $tool on PATH ($system_path) is a script shim (Debian pg_wrapper), not a"
      echo "  real binary. Vendoring it ships a tool that only runs on hosts with a full"
      echo "  PostgreSQL client install (the 2026-07-07 broken-psql bug class). Install the"
      echo "  real client matching the embedded server:"
      echo "    Ubuntu/Debian: apt-get install postgresql-client-$EMBEDDED_PG_MAJOR   (pgdg repo)"
      exit 1
    fi
    src="$system_path"
    method="copy (from system PATH)"
  fi
  if [[ -z "$src" ]]; then
    echo "ERROR: $tool not found in embedded-postgres distribution AND not on system PATH"
    echo "  embedded-postgres ships server-only (initdb, pg_ctl, postgres). The build"
    echo "  host needs PostgreSQL client tools (real binaries, major $EMBEDDED_PG_MAJOR)"
    echo "  for the snapshot subsystem to work in the bundled desktop app. Install via:"
    echo "    macOS:   brew install libpq && brew link --force libpq"
    echo "    Ubuntu:  apt-get install postgresql-client-$EMBEDDED_PG_MAJOR   (pgdg repo)"
    echo "    Windows: install PostgreSQL from postgresql.org"
    exit 1
  fi
  case "$method" in
    symlink*)
      # EI-21548386804468550: SIDECAR_DIR is sidecar.tmp.<pid> until the atomic
      # publish. An absolute link to $src passes every pre-publish probe and is
      # broken by the final rename. The embedded target is inside this same
      # tree, so make the link relative to bin/ and fail if that premise drifts.
      case "$src" in
        "$SIDECAR_DIR"/*)
          _pg_rel_src="${src#"$SIDECAR_DIR"/}"
          ln -sfn "../$_pg_rel_src" "$SIDECAR_DIR/bin/$tool"
          ;;
        *)
          echo "ERROR: refusing non-relocatable PostgreSQL client symlink outside the sidecar: $src" >&2
          exit 1
          ;;
      esac
      ;;
    copy*)
      if [[ "$_cross_darwin" == "1" ]]; then
        # WI-5651: cross-baking darwin ON linux — the build host IS Linux, so the
        # branches below would wrongly build the Linux .pg-real wrapper. Copy the
        # darwin bottle binary and rewrite its keg dylibs with the llvm/rcodesign
        # toolchain (native otool/install_name_tool/codesign are macOS-only).
        cp -L "$src" "$SIDECAR_DIR/bin/$tool"
        chmod 755 "$SIDECAR_DIR/bin/$tool"
        _cross_darwin_vendor_pg_tool "$SIDECAR_DIR/bin/$tool" || exit 1
      elif [[ "$_pg_build_os" == "Linux" ]]; then
        # Real pgdg binaries link libpq.so.5 (and psql libreadline.so.8) that a
        # clean target machine may not have. Ship the binary under bin/.pg-real/
        # fronted by a sh wrapper whose LD_LIBRARY_PATH points at (a) the
        # embedded-postgres lib dir — libpq.so.5 plus the openssl-1.1 it links,
        # already shipped for the server ($ORIGIN/../lib) — and (b) .pg-real/lib
        # for readline/tinfo copied off the build host. Remaining deps
        # (zstd/lz4/z/crypto3) are Ubuntu base-system libs.
        mkdir -p "$SIDECAR_DIR/bin/.pg-real/lib"
        cp -L "$src" "$SIDECAR_DIR/bin/.pg-real/$tool"
        chmod 755 "$SIDECAR_DIR/bin/.pg-real/$tool"
        _emb_lib_rel="${EMBEDDED_PG_BIN_DIR#"$SIDECAR_DIR"/}"   # node_modules/.../native/bin
        _emb_lib_rel="../${_emb_lib_rel%/bin}/lib"               # ../node_modules/.../native/lib (relative to bin/)
        cat > "$SIDECAR_DIR/bin/$tool" <<WRAP
#!/bin/sh
# Generated by build-desktop-sidecar.sh — vendored PostgreSQL client tool.
# Real binary in .pg-real/; libs resolved from the embedded-postgres lib dir
# (libpq + its openssl 1.1) and .pg-real/lib (readline/tinfo).
d=\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)
LD_LIBRARY_PATH="\$d/$_emb_lib_rel:\$d/.pg-real/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}" exec "\$d/.pg-real/$tool" "\$@"
WRAP
        chmod 755 "$SIDECAR_DIR/bin/$tool"
      else
        # chmod 755, not just +x: brew ships these 0555 (read-only) and
        # tauri-build's resource copy into target/<triple>/release/ then
        # EACCESes overwriting its own previous read-only copy on rebuild.
        cp -L "$src" "$SIDECAR_DIR/bin/$tool"
        chmod 755 "$SIDECAR_DIR/bin/$tool"
        if [[ "$_pg_build_os" == "Darwin" ]]; then
          _darwin_vendor_keg_dylibs "$SIDECAR_DIR/bin/$tool" "@executable_path/.pg-lib"
        fi
        # Windows: an .exe copied without its sibling DLLs (libpq.dll, ssl,
        # iconv/intl) still resolves them via PATH on the BUILD host — masked
        # — and breaks on clean machines (WI-3313). Ship the source dir's
        # DLLs beside the exes: the exe's own dir is first in the Windows
        # DLL search order, making the tools self-contained.
        case "$_pg_build_os" in
          MINGW*|MSYS*|CYGWIN*)
            cp -n "$(dirname "$src")"/*.dll "$SIDECAR_DIR/bin/" 2>/dev/null || true ;;
        esac
      fi
      ;;
  esac
  # Console keeps the real path (build log, not shipped); the NOTE is scrubbed (it ships).
  echo "  $tool: $method ($src)"
  papercusp_append_pg_tool_source_note "$SOURCE_NOTE_FILE" "$tool" "$method" "$src"
done

# Resolve an executable that may live in an admin-only system directory. Service
# managers commonly omit /usr/sbin and /sbin from PATH, but ldconfig is still the
# canonical way to locate the host's SONAMEs. Keep this as a helper rather than
# spelling a bare ldconfig invocation at each call site: under set -euo pipefail,
# a missing PATH entry otherwise exits the entire sidecar build before the
# missing-library diagnostic can run.
resolve_ldconfig() {
  local _ldconfig_candidate
  if _ldconfig_candidate="$(command -v ldconfig 2>/dev/null)" \
      && [[ -x "$_ldconfig_candidate" ]]; then
    printf '%s\n' "$_ldconfig_candidate"
    return 0
  fi
  for _ldconfig_candidate in /usr/sbin/ldconfig /sbin/ldconfig; do
    if [[ -x "$_ldconfig_candidate" ]]; then
      printf '%s\n' "$_ldconfig_candidate"
      return 0
    fi
  done
  echo "ERROR: ldconfig not found on PATH, /usr/sbin/ldconfig, or /sbin/ldconfig." >&2
  echo "       It is required to resolve PostgreSQL client libraries for bundled psql." >&2
  return 1
}

# Linux: psql needs readline+tinfo, which minimal images may lack — bundle them
# into .pg-real/lib (tiny; resolved via the wrapper's LD_LIBRARY_PATH).
if [[ "$_pg_build_os" == "Linux" && -d "$SIDECAR_DIR/bin/.pg-real" ]]; then
  _ldconfig="$(resolve_ldconfig)" || exit 1
  echo "  using ldconfig: $_ldconfig"
  for _lib in libreadline.so.8 libtinfo.so.6; do
    # No early `exit` in awk: under `set -o pipefail` an early-exiting consumer
    # SIGPIPEs `ldconfig -p` (~100KB of output) and the whole build dies with a
    # silent exit 141, depending on a scheduling race (fresh-clone build4, WI-10003960).
    _libpath="$("$_ldconfig" -p 2>/dev/null | awk -v l="$_lib" '$1==l && !f {print $NF; f=1}')"
    if [[ -n "$_libpath" && -e "$_libpath" ]]; then
      cp -L "$_libpath" "$SIDECAR_DIR/bin/.pg-real/lib/$_lib"
    else
      echo "ERROR: $_lib not found on build host (needed by vendored psql on clean targets)"
      exit 1
    fi
  done
fi

# Sanity-probe every bundled tool AS INSTALLED (i.e. through the wrapper on
# linux, so the bundled-libs path is what's exercised) — and assert none of
# them is still a #!-script (the pg_wrapper bug class shipping again).
for tool in pg_dump psql pg_dumpall pg_restore; do
  _final="$SIDECAR_DIR/bin/$tool"
  if [[ "$_pg_build_os" == "Linux" && -e "$SIDECAR_DIR/bin/.pg-real/$tool" ]] && _is_script "$SIDECAR_DIR/bin/.pg-real/$tool"; then
    echo "ERROR: vendored $tool (.pg-real) is a script shim — refusing to ship it"
    exit 1
  fi
  if [[ "$_pg_build_os" != "Linux" ]] && _is_script "$_final"; then
    echo "ERROR: bundled $tool is a script shim — refusing to ship it"
    exit 1
  fi
  if [[ "$_cross_darwin" == "1" ]]; then
    # WI-5651: can't exec a darwin Mach-O on this linux host — assert STRUCTURALLY
    # instead: no keg/absolute dylib refs remain, every @executable_path ref
    # resolves to a bundled file, and the Mach-O is ad-hoc signed (dyld SIGKILLs
    # an unsigned/stale-signed binary on load).
    _bad="$(llvm-otool-18 -L "$_final" 2>/dev/null | awk 'NR>1{print $1}' | grep -E '@@|/opt/|/Library/|/usr/local/' || true)"
    if [[ -n "$_bad" ]]; then
      echo "ERROR: cross-vendored $tool still references keg/absolute dylib paths (would dangle on a clean Mac):"
      echo "$_bad" | sed 's/^/    /'
      exit 1
    fi
    while IFS= read -r _ref; do
      [[ -n "$_ref" ]] || continue
      _res="${_ref/@executable_path/$SIDECAR_DIR/bin}"
      [[ -e "$_res" ]] || { echo "ERROR: cross-vendored $tool references a missing bundled lib: $_ref"; exit 1; }
    done < <(llvm-otool-18 -L "$_final" 2>/dev/null | awk 'NR>1{print $1}' | grep -E '^@executable_path' || true)
    if ! rcodesign print-signature-info "$_final" 2>/dev/null | grep -c 'CodeDirectory' >/dev/null; then
      echo "ERROR: cross-vendored $tool is not ad-hoc signed (dyld would SIGKILL it on load)"
      exit 1
    fi
    echo "  $tool probe: cross-darwin structural OK (no dangling refs, bundled libs resolve, signed)"
    continue
  fi
  if ! _probe_out="$("$_final" --version 2>&1)"; then
    echo "ERROR: bundled $tool fails --version probe; not loadable as installed:"
    echo "  $_probe_out"
    echo "  This usually means dynamic library mismatch (e.g. libpq from a different"
    echo "  PG major version). Build on a host with real PG $EMBEDDED_PG_MAJOR client tools."
    exit 1
  fi
  echo "  $tool probe: $_probe_out"
done
# Linux: assert the vendored binaries' NEEDED libs all resolve using ONLY the
# wrapper's lib path + system dirs — catches a dep that exists on the build
# host but would never ship (masked-on-build-host bug class).
if [[ "$_pg_build_os" == "Linux" && -d "$SIDECAR_DIR/bin/.pg-real" ]]; then
  _emb_lib_dir="${EMBEDDED_PG_BIN_DIR%/bin}/lib"
  for tool in pg_dump psql pg_dumpall pg_restore; do
    _missing="$(LD_LIBRARY_PATH="$_emb_lib_dir:$SIDECAR_DIR/bin/.pg-real/lib" ldd "$SIDECAR_DIR/bin/.pg-real/$tool" 2>/dev/null | grep 'not found' || true)"
    if [[ -n "$_missing" ]]; then
      echo "ERROR: vendored $tool has unresolved shared libs:"
      echo "$_missing"
      exit 1
    fi
  done
fi

# ── kopia (snapshot subsystem, WI-3312) ─────────────────────────────────────
# packages/backup/src/workspace-backup.ts spawns bare `kopia` (KOPIA_BIN ??
# 'kopia') with sidecar/bin on the operator PATH. It was never bundled: dev
# boxes have a system kopia so everything worked there, while clean installs
# got `spawn kopia ENOENT` and every snapshot silently shipped without a
# kopia backup — same masked-dependency class as the pg_wrapper bug above.
# kopia is a single fully-static Go binary (Apache-2.0) — vendor it.
if [[ "$_cross_darwin" == "1" ]]; then
  # WI-5651: fetch the DARWIN kopia (Go static binary — links only macOS system
  # libs, so no dylib rewrite needed) matching the build host's kopia version. A
  # copied linux kopia would be an ELF the mac can't exec → silently dump-less
  # snapshots, and the host `--version` probe below CAN'T catch it (it runs the
  # ELF on linux, where it passes). Just fetch, copy, ad-hoc sign.
  _kopia_ver="$(kopia --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sed -n 1p)"
  [[ -n "$_kopia_ver" ]] || { echo "ERROR: could not determine build-host kopia version to match the darwin download"; exit 1; }
  case "$TARGET_ARCH" in x64) _kopia_arch=x64 ;; arm64) _kopia_arch=arm64 ;; *) echo "ERROR: unsupported kopia target arch $TARGET_ARCH"; exit 1 ;; esac
  _kopia_url="https://github.com/kopia/kopia/releases/download/v${_kopia_ver}/kopia-${_kopia_ver}-macOS-${_kopia_arch}.tar.gz"
  echo "  → cross: fetching darwin kopia ${_kopia_ver} (${_kopia_arch}) from github releases"
  _kopia_tmp="$(mktemp -d)"
  curl -fsSL "$_kopia_url" -o "$_kopia_tmp/kopia.tgz" || { echo "ERROR: darwin kopia download failed: $_kopia_url"; rm -rf "$_kopia_tmp"; exit 1; }
  tar -xzf "$_kopia_tmp/kopia.tgz" -C "$_kopia_tmp" || { echo "ERROR: darwin kopia extract failed"; rm -rf "$_kopia_tmp"; exit 1; }
  _kopia_bin="$(find "$_kopia_tmp" -type f -name kopia | sed -n 1p)"
  [[ -n "$_kopia_bin" ]] || { echo "ERROR: kopia binary not found in the darwin tarball"; rm -rf "$_kopia_tmp"; exit 1; }
  cp -L "$_kopia_bin" "$SIDECAR_DIR/bin/kopia"
  chmod 755 "$SIDECAR_DIR/bin/kopia"
  rcodesign sign "$SIDECAR_DIR/bin/kopia" >/dev/null 2>&1 || { echo "ERROR: rcodesign ad-hoc sign failed for darwin kopia"; rm -rf "$_kopia_tmp"; exit 1; }
  rm -rf "$_kopia_tmp"
  echo "  kopia: cross-fetched darwin ${_kopia_ver} (${_kopia_arch}), ad-hoc signed"
  echo "kopia: cross-fetch (darwin ${_kopia_ver} ${_kopia_arch} github release)" >> "$SOURCE_NOTE_FILE"
elif [[ -x "$SIDECAR_DIR/bin/kopia" ]] && "$SIDECAR_DIR/bin/kopia" --version >/dev/null 2>&1; then
  echo "  kopia: already bundled ($("$SIDECAR_DIR/bin/kopia" --version 2>/dev/null | sed -n 1p))"
else
  _kopia_src="$(command -v kopia 2>/dev/null || true)"
  if [[ -z "$_kopia_src" ]]; then
    echo "ERROR: kopia not found on the build host — required for the bundled snapshot"
    echo "  subsystem (packages/backup/src/workspace-backup.ts). Install the static"
    echo "  binary: https://kopia.io/docs/installation/  (apt/brew install kopia)"
    exit 1
  fi
  if _is_script "$_kopia_src"; then
    echo "ERROR: kopia on PATH ($_kopia_src) is a script shim — refusing to vendor it"
    exit 1
  fi
  cp -L "$_kopia_src" "$SIDECAR_DIR/bin/kopia"
  chmod 755 "$SIDECAR_DIR/bin/kopia"
  if ! "$SIDECAR_DIR/bin/kopia" --version >/dev/null 2>&1; then
    echo "ERROR: bundled kopia fails --version probe as installed"
    exit 1
  fi
  echo "  kopia: copy ($_kopia_src) → $("$SIDECAR_DIR/bin/kopia" --version 2>/dev/null | sed -n 1p)"
  papercusp_append_pg_tool_source_note \
    "$SOURCE_NOTE_FILE" "kopia" "copy (from system PATH)" "$_kopia_src"
fi

# NOTE: zero-cache-server is no longer bundled (SP1 C5, 2026-06-06). The
# legacy opt-in spawn (PAPERCUSP_USE_ZERO_CACHE=1) was removed from the Rust
# embedder along with the rest of its PG/sidecar process management — the
# operator's /api/zero-harness/sse path (PG LISTEN/NOTIFY) replaced the Zero
# WS transport on desktop back on 2026-05-07. Saves ~50MB of bundle.

# NOTE: the legacy pglite-server is no longer bundled (removed 2026-06-01).
# embedded-postgres-server is the only desktop DB. A failed embedded-PG must
# fail LOUD (see Tauri main.rs) rather than silently degrade to a WASM
# single-connection engine with limited LISTEN/NOTIFY.

# Bundle the papercusp MCP server. Auto-registered into ~/.omp/agent/mcp.json
# on first pi spawn (pty.ts:ensurePapercuspMcpRegistered) so the LLM sees
# mcp_papercusp_* tools out of the box.
MCP_SRC="$PAPERCUSP_ROOT/packages/papercusp-mcp-server"
MCP_DST="$SIDECAR_DIR/papercusp-mcp-server"
echo "→ bundling papercusp-mcp-server"
if [[ -d "$MCP_SRC" ]]; then
  mkdir -p "$MCP_DST"
  cp "$MCP_SRC/package.json" "$MCP_DST/"
  cp -a "$MCP_SRC/src" "$MCP_DST/"
  cp -a "$MCP_SRC/bin" "$MCP_DST/"
  chmod +x "$MCP_DST/bin/papercusp-mcp-server.mjs"
  ( cd "$MCP_DST" && npm install --omit=dev --silent ) || {
    echo "WARN: failed to install MCP server deps; users won't see mcp_papercusp_* tools"
  }
fi

# node-pty's prebuilt native bindings live in
# `node_modules/@lydell/node-pty-<platform>/prebuilds/<arch>/pty.node`
# and are loaded via dynamic require — Next.js's standalone tracer
# doesn't follow that, so the .node files aren't copied. We copy them
# explicitly from the source workspace's node_modules into whichever
# platform packages exist in the bundled tree.
echo "→ patching @lydell/node-pty prebuilts (native bindings)"
# Next's tracer copies @lydell/node-pty-<plat>/lib but not the
# prebuilds/<arch>/pty.node native binary (it's loaded via dynamic
# require, see next.config.js outputFileTracingIncludes for the
# half-fix that covers /api/[[...route]]/**). We backfill from the
# operator workspace's node_modules — that's where npm actually
# installed @lydell/* — rather than the desktop repo root, which
# only depends on @tauri-apps/cli.
for pkg in $SIDECAR_DIR/node_modules/@lydell/node-pty-*/; do
  [[ -d "$pkg" ]] || continue
  pkg_name="$(basename "$pkg")"
  # WI-5651: a CROSS-FETCHED per-platform package (e.g. node-pty-darwin-x64 pulled
  # by fetch_cross_npm_pkg) ALREADY ships its prebuilds/<plat>/pty.node — and the
  # host has no source for a foreign platform anyway. If they're already present,
  # keep them (the native path still backfills the host's own package, whose
  # prebuilds Next's tracer strips — that's why the host-source copy exists).
  if find "$pkg/prebuilds" -name '*.node' 2>/dev/null | grep -c . >/dev/null; then
    echo "  ✓ $pkg_name: prebuilds already present ($(find "$pkg/prebuilds" -name '*.node' | wc -l) .node file(s)) — cross-fetched pkg"
    continue
  fi
  src_prebuilds=""
  for cand in \
    "$WEB_DIR/node_modules/@lydell/$pkg_name/prebuilds" \
    "$REPO_ROOT/node_modules/@lydell/$pkg_name/prebuilds" \
    "$ROOT/node_modules/@lydell/$pkg_name/prebuilds"; do
    if [[ -d "$cand" ]]; then
      src_prebuilds="$cand"
      break
    fi
  done
  if [[ -n "$src_prebuilds" ]]; then
    cp -a "$src_prebuilds" "$pkg/"
    echo "  ✓ $pkg_name ← $src_prebuilds → $(find "$pkg/prebuilds" -name '*.node' | wc -l) .node file(s)"
  elif [[ "$CROSS_BUILD" == "1" ]]; then
    # A cross bundle whose TARGET pty binding is missing would 500 on every agent
    # spawn on a clean target — fail loud rather than ship it silently broken.
    echo "ERROR: $pkg_name: no prebuilds present in the cross-fetched package AND none on the host — the target's node-pty native binding would be missing (agent PTYs 500 at module load)"
    exit 1
  else
    echo "  ⚠ $pkg_name: no prebuilds source found in any candidate path; the catch-all /api route will 500 at module load"
  fi
done

# Bundle the framework DDL files so embedded-PG first-boot init can find
# them at runtime. The Tauri main passes this dir to serve.mjs
# (PAPERCUSP_PG_SQL_DIR) which applies the schema on first boot.
echo "→ bundling framework DDL"
rm -rf "$SIDECAR_DIR/db-sql"
mkdir -p "$SIDECAR_DIR/db-sql"
cp "$PAPERCUSP_ROOT/libs/db/sql/"*.sql "$SIDECAR_DIR/db-sql/"

# WI-4419 D-004 (copy-point identity scrub): db-sql/ is a SECOND path (besides
# source.tar.zst) by which must-ship canonical source leaves the tree VERBATIM —
# the migration SQL is copied byte-for-byte, so an [owner:owner] provenance header
# (e.g. migrations 630/631) survives to disk and is caught by this build's own
# release-privacy --scan-dir audit below (and the AppImage AppDir scan). Unlike
# the compiled .ts source (esbuild strips comments), these .sql comments ship as-
# is. Redact the SHIPPED COPY in place — NEVER the canonical working-tree source
# (that would rewrite the owner's committed authorship AND break test fixtures
# that assert on these literals) — using the gate's ONE rule
# (audit-release-bundle.py --identity-literals) as the single source of truth so
# the scrub cannot drift from what the audit later fails on. Filenames + count are
# preserved, so the WI-3047 tree-match guard below still holds. Opt out with
# PAPERCUSP_STAGE_SCRUB=0 (mirrors stage-source-tree.sh).
if [[ "${PAPERCUSP_STAGE_SCRUB:-1}" == "1" && -f "$HERE/audit-release-bundle.py" ]]; then
  declare -a _dbsql_sed=()
  # Column 4 is audit-release-bundle.py's ready-to-use portable case-folded ERE.
  # Consume it directly so this shipped-copy scrub cannot drift from the final
  # scan's case rule. Columns 1-3 remain a compatibility fallback for an older
  # audit script that does not emit the pattern yet.
  while IFS=$'\t' read -r _val _red _wb _pat; do
    [[ -z "$_val" ]] && continue
    _r="$(printf '%s' "$_red" | sed 's/[&/\]/\\&/g')"
    if [[ -n "$_pat" ]]; then
      _dbsql_sed+=(-e "s/${_pat}/${_r}/g")
    else
      _p="$(printf '%s' "$_val" | sed 's/[][\.^$*+?(){}|/]/\\&/g')"
      if [[ "$_wb" == "1" ]]; then _dbsql_sed+=(-e "s/\\b${_p}\\b/${_r}/g"); else _dbsql_sed+=(-e "s/${_p}/${_r}/g"); fi
    fi
  done < <(python3 "$HERE/audit-release-bundle.py" --identity-literals)
  _scrub_sidecar_db_sql() {
    local _scope="$1"
    shift
    (( ${#_dbsql_sed[@]} > 0 )) || return 0
    local -a _roots=()
    local _root _f
    for _root in "$@"; do
      [[ -d "$_root" ]] && _roots+=("$_root")
    done
    (( ${#_roots[@]} > 0 )) || return 0
    local _dbsql_scrubbed=0
    while IFS= read -r -d '' _f; do
      sed -E "${_dbsql_sed[@]}" "$_f" | cmp -s - "$_f" && continue
      # sed -i replaces the inode rather than mutating a preserved hardlink in
      # place, so cleaning an env overlay cannot rewrite its primary sibling.
      sed -E -i "${_dbsql_sed[@]}" "$_f"
      _dbsql_scrubbed=$((_dbsql_scrubbed+1))
    done < <(find "${_roots[@]}" -type f -name '*.sql' -print0)
    echo "    identity scrub: redacted $_dbsql_scrubbed shipped db-sql file(s) in $_scope (WI-4419 D-004)"
  }
  _scrub_sidecar_db_sql "primary sidecar" "$SIDECAR_DIR/db-sql"
fi

# WI-3047 guard: assert the exact migration FILENAME SET, not only count + highest.
# Run it twice: the first call catches a partial copy before the expensive seed build;
# the second catches any later profile-prune regression before the payload is certified.
# The second call is load-bearing: EI-22447063248857569 measured vm-release pruning 17
# production migrations whose filenames contained `test` or `spec`, AFTER the seed build
# had successfully validated the complete set. Count/highest were never re-read, so a
# signed bundle differed from the schema that its own green build had exercised.
assert_sidecar_db_sql_matches_source() {
  local phase="$1"
  local source_names shipped_names source_count shipped_count source_max shipped_max
  source_names="$(find "$PAPERCUSP_ROOT/libs/db/sql" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort)"
  shipped_names="$(find "$SIDECAR_DIR/db-sql" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort)"
  source_count="$(printf '%s\n' "$source_names" | sed '/^$/d' | wc -l | tr -d ' ')"
  shipped_count="$(printf '%s\n' "$shipped_names" | sed '/^$/d' | wc -l | tr -d ' ')"
  source_max="$(printf '%s\n' "$source_names" | grep -oE '^[0-9]+' | sort -n | tail -1)"
  shipped_max="$(printf '%s\n' "$shipped_names" | grep -oE '^[0-9]+' | sort -n | tail -1)"
  if [[ -z "$source_names" || "$source_names" != "$shipped_names" ]]; then
    echo "ERROR: shipped sidecar/db-sql/ differs from source during $phase"
    echo "       shipped highest=$shipped_max count=$shipped_count; source highest=$source_max count=$source_count"
    echo "       missing from shipped payload:"
    comm -23 <(printf '%s\n' "$source_names") <(printf '%s\n' "$shipped_names") | sed 's/^/         - /'
    echo "       unexpected in shipped payload:"
    comm -13 <(printf '%s\n' "$source_names") <(printf '%s\n' "$shipped_names") | sed 's/^/         + /'
    echo "       refusing a runtime schema that differs from the set this build claims to ship."
    exit 1
  fi
  echo "    ✓ shipped db-sql/ exact filename set matches source during $phase (highest migration $source_max, $source_count files)"
}
assert_sidecar_db_sql_matches_source "pre-seed copy"

# ── Pre-migrated LOGICAL seed (desktop first-boot fast path) ────────────────
# Boot the JUST-BUNDLED embedded-PG ONCE at build time (initdb + apply every
# migration in db-sql/), pg_dump the migrated database into db-seed.dump, then
# stop. On a FRESH install the Server runs its OWN initdb (unique cluster
# system_identifier), restores the logical dump, and applies only migration
# deltas. This retains the fast path without cloning build-cluster identity into
# every install (WI-39304). It also gates that the full migration set applies.
# Skip with PAPERCUSP_BUILD_PG_SEED=0 (first boot falls back to initdb+replay —
# correct, just slower).
if [[ "$CROSS_BUILD" == "1" ]]; then
  # WI-5651: the seed is built by BOOTING the just-bundled embedded-PG — which is
  # the TARGET's binary, impossible to exec on this ${_host_os} cross host (the
  # cross-swap also dropped the host's @embedded-postgres pkg). The new logical
  # format removes the identity hazard, but no cross-host build path is yet
  # verified against the target's exact PG major/client tools. Skip rather than
  # silently build an unverified seed; target first boot remains correct.
  echo "→ WI-5651 skipping logical seed (cross ${TARGET_OS}-${TARGET_ARCH} bundle — can't boot the target's PG on a ${_host_os} host); first boot will initdb + replay migrations on the target"
elif [[ "${PAPERCUSP_BUILD_PG_SEED:-1}" == "1" ]]; then
  echo "→ building pre-migrated logical seed (unique-cluster first-boot fast path)"
  _seed_tmp="$(mktemp -d)"
  # Never let a stale physical seed survive an incremental staging directory:
  # a launcher prefers the new dump, but a missing dump must not fall through to
  # a freshly-produced identity-cloning tar from an earlier build.
  rm -f "$SIDECAR_DIR/db-seed.tar.gz" "$SIDECAR_DIR/db-seed.dump"
  if node "$EMBEDDED_PG_DST/bin/build-seed.mjs" \
       --data "$_seed_tmp/pgdata" \
       --sql "$SIDECAR_DIR/db-sql" \
       --out "$SIDECAR_DIR/db-seed.dump" \
       --pg-dump "$SIDECAR_DIR/bin/pg_dump" \
       --port "${PAPERCUSP_BUILD_PG_SEED_PORT:-5549}"; then
    echo "→ db-seed.dump staged ($(du -h "$SIDECAR_DIR/db-seed.dump" | cut -f1))"
  else
    echo "ERROR: pre-migrated logical seed build failed — refusing to ship a bundle without a verified schema."
    echo "  (Set PAPERCUSP_BUILD_PG_SEED=0 to intentionally ship without the first-boot fast path.)"
    rm -f "$SIDECAR_DIR/db-seed.dump" "$SIDECAR_DIR/db-seed.tar.gz"
    rm -rf "$_seed_tmp"
    exit 1
  fi
  rm -rf "$_seed_tmp"
else
  rm -f "$SIDECAR_DIR/db-seed.dump" "$SIDECAR_DIR/db-seed.tar.gz"
  echo "→ skipping logical seed (PAPERCUSP_BUILD_PG_SEED=0) — first boot will initdb + replay migrations"
fi

# Bundle the @papercusp/locks (papercusp_su side-DB) migrations. EI-2669:
# @papercusp/locks is esbuild-BUNDLED into serve.mjs (not externalized), so its
# su-lock-store resolves SQL_DIR = dirname(import.meta.url)/sql = <sidecar>/sql.
# esbuild inlines only JS, never the package's sibling src/sql/*.sql, so without
# this copy the packaged git-sync lock infra ENOENTs on scandir '<sidecar>/sql'
# and git-sync (repo-content sync for hive members) is degraded on EVERY hive.
# These are the LOCK schema (001-bootstrap … 015-…), a distinct set from the
# framework DDL above — they must land at sidecar/sql/, NOT db-sql/.
echo "→ bundling @papercusp/locks DDL"
mkdir -p "$SIDECAR_DIR/sql"
cp "$PAPERCUSP_ROOT/packages/locks/src/sql/"*.sql "$SIDECAR_DIR/sql/"

# Bundle the sidecar preload script. Loaded via `node --require` before
# server.js to strip Node 22+'s partial localStorage stub (see file
# header for full reasoning).
echo "→ bundling sidecar preload"
cp "$ROOT/bin/sidecar-preload.js" "$SIDECAR_DIR/sidecar-preload.js"

# ---------------------------------------------------------------------------
# Bundle external binaries — node + gh.
#
# omp (Pi) is NO LONGER bundled (owner directive 2026-07-07): the desktop app
# uses the omp installed on the USER's machine. There is a first-run install
# procedure for it (setup-pty-commands buildFrameworkInstallSpec lands omp at
# ~/.papercusp/bin/omp; the onboarding wizard drives it), and both detection
# (preflight-binaries detectOmp) and launch (psu spawns bare `omp`, resolved
# via the terminal's PATH which prepends ~/.papercusp/bin + ~/.local/bin) find
# that local install. Bundling a second 485MB copy just shadowed the user's own
# and bloated the installer.
#
# code-server is NO LONGER bundled either (owner directive 2026-07-07): the app
# no longer uses the vscode-in-the-browser panel, so the ~447MB code-server
# tarball is dead weight. Its Tauri spawn is removed in main.rs.
#
# What remains bundled here: node (the sidecar runtime) + gh (git ops). We pick
# the binary matching the target platform/arch the build host is running on. CI
# runs the desktop build under `tauri build` on a matrix of macos-{14,13},
# ubuntu-22.04, and windows-2022, so each matrix leg picks the right asset.
# ---------------------------------------------------------------------------
# WI-5651: target_os/target_arch now come from the TARGET_OS/TARGET_ARCH resolved
# at the top of this script (default = host $(uname), so an un-set invocation is
# unchanged). Cross-baking a mac/windows bundle on Linux sets them; the darwin/win
# node + gh + zellij + pui fetches below already switch on these vars.
target_os="$TARGET_OS"
target_arch="$TARGET_ARCH"
echo "→ bundling external binaries for $target_os-$target_arch$([[ "$CROSS_BUILD" == "1" ]] && echo " (cross-baked on ${_host_os}-${_host_arch})")"

# BIN_DIR (historically OMP_DIR) — destination for bundled CLIs (node, gh).
# Tauri prepends this dir to the sidecar's PATH on spawn (see main.rs PATH
# munging) so the sidecar finds them without a user-side install. Hoisted here
# from below because the Node download block referenced it before its old
# in-place definition under `set -u`, killing the build with 'OMP_DIR: unbound
# variable'. Name kept as OMP_DIR to avoid churning the node/gh copy lines.
OMP_DIR="$SIDECAR_DIR/bin"
mkdir -p "$OMP_DIR"

# EI-1869: SIDECAR_BIN_CACHE is initialized before assembly, above.  Keep the
# Node/GH slots below version+platform keyed; a pin change naturally misses the
# old slot without deleting another build's cache.

# Node.js — vendor a known-good runtime so users don't need Node on PATH.
# Tauri main spawns the sidecar + embedded-postgres-server with this binary
# explicitly (see resolve_node_bin in main.rs). Bare `node` only — we don't need npm
# at runtime, the standalone bundle has its dependencies pre-installed.
NODE_VERSION="${NODE_VERSION:-v24.18.1}"
node_dst=""
case "$target_os" in
  linux)   node_archive="node-${NODE_VERSION}-linux-${target_arch}.tar.xz" ;;
  darwin)  case "$target_arch" in
             x64)   node_archive="node-${NODE_VERSION}-darwin-x64.tar.gz" ;;
             arm64) node_archive="node-${NODE_VERSION}-darwin-arm64.tar.gz" ;;
           esac ;;
  windows) node_archive="node-${NODE_VERSION}-win-x64.zip" ;;
esac
if [[ -n "${node_archive:-}" ]]; then
  # EI-1869: cache slot keyed by version+platform (a version/arch bump ⇒ a new
  # slot ⇒ correctly re-downloads; nothing else invalidates it).
  node_cache_bin="node"
  [[ "$target_os" == "windows" ]] && node_cache_bin="node.exe"
  node_cache_dir="$SIDECAR_BIN_CACHE/node-${NODE_VERSION}-${target_os}-${target_arch}"
  if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
    [[ "$NODE_VERSION" == "$PAPERCUSP_VM_NODE_VERSION" ]] || {
      echo "ERROR: vm-release Node override $NODE_VERSION differs from pinned $PAPERCUSP_VM_NODE_VERSION" >&2
      exit 1
    }
    [[ -x "$PAPERCUSP_VM_RELEASE_TRUST_ROOT/bin/node" ]] || {
      echo "ERROR: vm-release pinned Node output is unavailable" >&2
      exit 1
    }
    cp "$PAPERCUSP_VM_RELEASE_TRUST_ROOT/bin/node" "$OMP_DIR/node"
    chmod 755 "$OMP_DIR/node"
    node_dst="$OMP_DIR/node"
    [[ "$("$node_dst" --version)" == "$PAPERCUSP_VM_NODE_VERSION" ]] || {
      echo "ERROR: vm-release copied Node does not match $PAPERCUSP_VM_NODE_VERSION" >&2
      exit 1
    }
    echo "  ✓ node $PAPERCUSP_VM_NODE_VERSION from checksum-pinned vm-release trust toolchain"
  elif [[ -f "$node_cache_dir/$node_cache_bin" ]]; then
    cp "$node_cache_dir/$node_cache_bin" "$OMP_DIR/$node_cache_bin"
    chmod +x "$OMP_DIR/$node_cache_bin"
    node_dst="$OMP_DIR/$node_cache_bin"
    echo "  ✓ node $NODE_VERSION cached → $node_dst ($(du -h "$node_dst" | awk '{print $1}')) — skipped download"
  else
    echo "→ downloading Node $NODE_VERSION → $node_archive"
    node_tarball="/tmp/$node_archive"
    if curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${node_archive}" -o "$node_tarball"; then
      tmp_node_dir=$(mktemp -d)
      case "$node_archive" in
        *.tar.xz) tar -xJf "$node_tarball" -C "$tmp_node_dir" --strip-components=1 ;;
        *.tar.gz) tar -xzf "$node_tarball" -C "$tmp_node_dir" --strip-components=1 ;;
        *.zip)    unzip -q "$node_tarball" -d "$tmp_node_dir" && \
                   inner=$(find "$tmp_node_dir" -maxdepth 1 -mindepth 1 -type d | sed -n 1p) && \
                   mv "$inner"/* "$tmp_node_dir/" 2>/dev/null || true ;;
      esac
      if [[ -f "$tmp_node_dir/bin/node" ]]; then
        cp "$tmp_node_dir/bin/node" "$OMP_DIR/node"
        chmod +x "$OMP_DIR/node"
        node_dst="$OMP_DIR/node"
      elif [[ -f "$tmp_node_dir/node.exe" ]]; then
        cp "$tmp_node_dir/node.exe" "$OMP_DIR/node.exe"
        node_dst="$OMP_DIR/node.exe"
      fi
      rm -rf "$tmp_node_dir" "$node_tarball"
      if [[ -n "$node_dst" ]]; then
        echo "  ✓ node at $node_dst ($(du -h "$node_dst" | awk '{print $1}'))"
        # Seed the cache (best-effort; a seed failure never fails the build —
        # the next build just re-downloads).
        mkdir -p "$node_cache_dir" && cp "$node_dst" "$node_cache_dir/$node_cache_bin" 2>/dev/null || true
      else
        echo "  ⚠ node tarball extracted but no node binary found at expected path; sidecar will fall back to system node"
      fi
    else
      echo "  ⚠ failed to download Node; sidecar will fall back to system node"
    fi
  fi
fi

# gh (GitHub CLI) — single Go binary, used by harness flows that
# create/comment on GitHub PRs. cli/cli releases ship per-platform
# tarballs; we extract just `bin/gh[.exe]` into our sidecar/bin/.
GH_VERSION="${GH_VERSION:-2.98.0}"
gh_archive=""
gh_inner_dir=""
case "$target_os" in
  # gh names its linux x86_64 asset "amd64" (not "x64") — x64 404s silently.
  linux)   _gh_arch="$target_arch"; [[ "$target_arch" == "x64" ]] && _gh_arch="amd64"
           gh_archive="gh_${GH_VERSION}_linux_${_gh_arch}.tar.gz";  gh_inner_dir="gh_${GH_VERSION}_linux_${_gh_arch}" ;;
  darwin)  case "$target_arch" in
             x64)   gh_archive="gh_${GH_VERSION}_macOS_amd64.zip";   gh_inner_dir="gh_${GH_VERSION}_macOS_amd64" ;;
             arm64) gh_archive="gh_${GH_VERSION}_macOS_arm64.zip";   gh_inner_dir="gh_${GH_VERSION}_macOS_arm64" ;;
           esac ;;
  windows) gh_archive="gh_${GH_VERSION}_windows_amd64.zip";          gh_inner_dir="gh_${GH_VERSION}_windows_amd64" ;;
esac
if [[ -n "$gh_archive" ]]; then
  # EI-1869: same version-keyed cache as Node, above.
  gh_cache_bin="gh"
  [[ "$target_os" == "windows" ]] && gh_cache_bin="gh.exe"
  gh_cache_dir="$SIDECAR_BIN_CACHE/gh-${GH_VERSION}-${target_os}-${target_arch}"
  if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
    [[ "$GH_VERSION" == "$PAPERCUSP_VM_GH_VERSION" ]] || {
      echo "ERROR: vm-release GitHub CLI override $GH_VERSION differs from pinned $PAPERCUSP_VM_GH_VERSION" >&2
      exit 1
    }
    [[ -x "$PAPERCUSP_VM_RELEASE_TRUST_ROOT/bin/gh" ]] || {
      echo "ERROR: vm-release pinned GitHub CLI output is unavailable" >&2
      exit 1
    }
    gh_dst="$OMP_DIR/gh"
    cp "$PAPERCUSP_VM_RELEASE_TRUST_ROOT/bin/gh" "$gh_dst"
    chmod 755 "$gh_dst"
    "$gh_dst" --version | sed -n 1p | grep -Fc "gh version ${PAPERCUSP_VM_GH_VERSION}-papercusp.1" >/dev/null || {
      echo "ERROR: vm-release copied GitHub CLI does not match the pinned patched build" >&2
      exit 1
    }
    echo "  ✓ gh $PAPERCUSP_VM_GH_VERSION-papercusp.1 from checksum-pinned release source"
  elif [[ -f "$gh_cache_dir/$gh_cache_bin" ]]; then
    gh_dst="$OMP_DIR/$gh_cache_bin"
    cp "$gh_cache_dir/$gh_cache_bin" "$gh_dst"
    chmod +x "$gh_dst"
    echo "  ✓ gh $GH_VERSION cached → $gh_dst ($(du -h "$gh_dst" | awk '{print $1}')) — skipped download"
  else
    echo "→ downloading gh $GH_VERSION → $gh_archive"
    gh_tarball="/tmp/$gh_archive"
    if curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh_archive}" -o "$gh_tarball"; then
      gh_tmp=$(mktemp -d)
      case "$gh_archive" in
        *.tar.gz) tar -xzf "$gh_tarball" -C "$gh_tmp" ;;
        *.zip)    unzip -q "$gh_tarball" -d "$gh_tmp" ;;
      esac
      # Find the gh binary regardless of inner dir naming quirks
      gh_src=$(find "$gh_tmp" -name "gh" -o -name "gh.exe" 2>/dev/null | sed -n 1p)
      if [[ -n "$gh_src" && -f "$gh_src" ]]; then
        gh_dst="$OMP_DIR/$(basename "$gh_src")"
        cp "$gh_src" "$gh_dst"
        chmod +x "$gh_dst"
        echo "  ✓ gh at $gh_dst ($(du -h "$gh_dst" | awk '{print $1}'))"
        # Seed the cache (best-effort; never fails the build).
        mkdir -p "$gh_cache_dir" && cp "$gh_dst" "$gh_cache_dir/$(basename "$gh_dst")" 2>/dev/null || true
      else
        echo "  ⚠ gh archive extracted but no gh binary found"
      fi
      rm -rf "$gh_tmp" "$gh_tarball"
    else
      echo "  ⚠ failed to download gh; harness GitHub-integration flows will fall back to user-installed gh"
    fi
  fi
fi

# ── better-sqlite3 target-Node ABI alignment (EI-22764638031916839) ─────────
# npm install/build runs under the host Node, but the finished sidecar runs the
# separately vendored NODE_VERSION above. For node-gyp addons that is a real ABI
# boundary: the host can leave better_sqlite3.node at ABI 141 while bundled
# Node 24.18.1 requires ABI 137. A JS-only require() does not dlopen that addon,
# so the mismatch can survive assembly and only fail when a database is opened.
#
# Refresh the addon AFTER the bundled Node version is known, and pass the target
# explicitly. This is also the cross-darwin path that previously lived here;
# keeping one helper makes native Linux and cross-darwin builds obey the same
# target-ABI contract. If a matching prebuild is unavailable, npm's normal
# node-gyp fallback is attempted with the same target before failing closed.
align_better_sqlite3_native() {
  local bsq_dir="$SIDECAR_DIR/node_modules/better-sqlite3"
  local target_version="${NODE_VERSION#v}"
  [[ -d "$bsq_dir" ]] || {
    echo "  ⚠ better-sqlite3 not in the sidecar closure — no ABI alignment needed"
    return 0
  }

  echo "→ aligning better-sqlite3 native addon for ${TARGET_OS}-${TARGET_ARCH}, Node ${NODE_VERSION} (target ABI)"
  rm -f "$bsq_dir"/build/Release/*.node
  if ! (
    cd "$bsq_dir" &&
    npx --yes prebuild-install \
      --platform="$TARGET_OS" \
      --arch="$TARGET_ARCH" \
      --target="$target_version" \
      --runtime=node \
      --tag-prefix=v
  ); then
    echo "  ⚠ no better-sqlite3 prebuild for Node ${NODE_VERSION}; rebuilding from source for that target"
    ( cd "$bsq_dir" && npm rebuild --runtime=node --target="$target_version" --build-from-source better-sqlite3 ) \
      || {
        echo "ERROR: better-sqlite3 could not be aligned with bundled Node ${NODE_VERSION} (prebuild-install + target rebuild failed)." >&2
        return 1
      }
  fi

  local bsq_node
  bsq_node="$(find "$bsq_dir" -type f -name '*.node' 2>/dev/null | sed -n 1p)"
  [[ -n "$bsq_node" ]] || {
    echo "ERROR: better-sqlite3: no *.node present after target-ABI alignment" >&2
    return 1
  }
  echo "  ✓ better-sqlite3 target binding → ${bsq_node#"$SIDECAR_DIR"/}"
}

# Windows packaging consumes the Linux sidecar through WSL, so its native
# addon remains the Linux target and the Windows package is not repaired here.
# Native Linux, native macOS, and cross-darwin builds all need the explicit
# alignment above.
if [[ "$TARGET_OS" == "linux" || "$TARGET_OS" == "darwin" ]]; then
  align_better_sqlite3_native || exit 1
fi

# EI-3620 (darwin, cross-build only): vendor a relocatable git for the macOS
# sidecar. A fresh, Xcode-CLT-less Mac has only the `/usr/bin/git` STUB, which
# on non-interactive invocation prints "xcode-select: no developer tools were
# found …" and exits non-zero — so the dogfood `git clone` fails ("Setting up
# Papercusp workspace failed", found on an owner Mac VM 2026-06-25). Until this
# shipped, the wizard's only mitigations were (a) prepending /opt/homebrew/bin
# to the sidecar PATH (tool-path.ts) to find a Homebrew git, and (b) an
# actionable "run `xcode-select --install`" hint when git is genuinely absent
# (clone-github.ts git_missing) — both stay in place as the fallback for a
# native (non-cross) macOS build, which this block does not yet cover.
#
# Mechanism (verified empirically 2026-07-26 on papercup-vm-mac, see EI-3620
# thread): Homebrew's darwin git bottle (+ its only two REAL, non-
# uses_from_macos deps — pcre2 and gettext/libintl; curl+expat are
# uses_from_macos, i.e. system-provided) ships every dylib load command as a
# literal `@@HOMEBREW_PREFIX@@`/`@@HOMEBREW_CELLAR@@` placeholder TOKEN string
# (brew's own `pour` step does the substitution at real-install time) — NOT a
# baked absolute path — so the SAME WI-3314 token-rewrite mechanism already
# proven for postgresql/readline (_cross_darwin_vendor_pg_tool, generalized
# above to take a vendor-subdir arg) applies directly, reusing embedded-pg's
# already-shipped libintl when its exact/compat filename matches and falling
# back to a dedicated bin/.git-lib vendor otherwise.
#
# git's own libexec/git-core/ is Homebrew's busybox-style multi-call layout —
# ~150 of its ~183 entries are plain symlinks (mostly to ../../bin/git, a few
# to ../../bin/{git-shell,git-cvsserver,scalar}, one same-dir git-remote-https
# -> git-remote-http) — so the whole upstream bin/+libexec/git-core/+
# share/git-core/templates/ tree is copied VERBATIM (cp -a preserves the
# relative symlinks byte-identical, still valid since we preserve the same
# relative nesting depth), then every REAL (non-symlink) Mach-O anywhere in
# that copy is rewritten + ad-hoc re-signed in place; the ~30 real files that
# are shell/perl/python scripts are left untouched — gated via `file -b`
# reporting a `Mach-O` prefix, NOT `llvm-otool-18`'s own exit code: verified
# empirically that `llvm-otool-18 -h` exits 0 on a non-Mach-O input too (it
# only differs in printing "is not an object file" to stdout), so exit-code
# gating silently let a script reach rcodesign and fail the whole build.
#
# git --exec-path compiles to a hardcoded absolute Homebrew path (this bottle
# was not built with RUNTIME_PREFIX) regardless of which relocation mechanism
# is used for the dylibs, so GIT_EXEC_PATH + GIT_TEMPLATE_DIR must be set as
# env vars at spawn time — wired process-wide in tool-path.ts's
# ensureToolPathEnv() (inherited by every child spawn that doesn't override
# `env`) rather than patched into each of the ~80 individual git spawn call
# sites in the codebase.
_cross_darwin_git_keg=""
if [[ "$_cross_darwin" == "1" ]]; then
  # `file -b` gates which vendored files get Mach-O rewrite+sign below — if it's
  # missing, that gate silently degrades to "nothing looks like Mach-O" instead
  # of erroring, which would ship git's real binaries with dangling
  # @@HOMEBREW_PREFIX@@ tokens. Hard-fail now rather than discover it at runtime
  # on a clean Mac.
  command -v file >/dev/null 2>&1 || { echo "ERROR: 'file' not found on the build host — required to distinguish Mach-O binaries from scripts while vendoring git (EI-3620)"; exit 1; }
  _brew_git_ver="$(curl -fsSL "https://formulae.brew.sh/api/formula/git.json" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["versions"]["stable"])' 2>/dev/null)"
  [[ -n "$_brew_git_ver" ]] || { echo "ERROR: could not resolve git stable version from the brew formula api"; exit 1; }
  _brew_git_ver="$(_brew_ver_with_darwin_bottle git "$_brew_git_ver" "$TARGET_ARCH" "homebrew/core/git")"
  echo "  → cross: fetching git ${_brew_git_ver} darwin-${TARGET_ARCH} bottle from ghcr (no brew on ${_host_os})"
  _cross_darwin_git_keg="$(fetch_brew_keg git "$_brew_git_ver" "$TARGET_ARCH" "homebrew/core/git" "$(mktemp -d)/gitkeg")" \
    || { echo "ERROR: git darwin bottle fetch failed (see above)"; exit 1; }
  [[ -f "$_cross_darwin_git_keg/bin/git" && -d "$_cross_darwin_git_keg/libexec/git-core" ]] \
    || { echo "ERROR: git bottle keg missing bin/git or libexec/git-core ($_cross_darwin_git_keg)"; exit 1; }

  mkdir -p "$SIDECAR_DIR/bin/.git-lib"
  # pcre2 + gettext: git's only two non-uses_from_macos deps (confirmed via
  # llvm-otool-18 --dylibs-used across every Mach-O in the bottle — identical
  # dep set for git/git-shell/scalar and every libexec/git-core/* helper).
  # Vendored via the SAME readline-style -id rewrite + sign pattern used above
  # for libreadline: both dylibs' own non-system deps are libSystem/libiconv/
  # CoreFoundation/CoreServices only (all system-provided), so no recursive
  # dep-rewrite is needed — just fix each dylib's own self-reference.
  for _gd_formula in pcre2 gettext; do
    case "$_gd_formula" in
      pcre2)   _gd_expect_base="libpcre2-8.0.dylib" ;;
      gettext) _gd_expect_base="libintl.8.dylib" ;;
    esac
    # Reuse-check FIRST — cheap, and skips a whole bottle fetch when embedded-pg
    # already ships a compatible libintl (native/lib) for the server.
    if [[ -e "$SIDECAR_DIR/bin/.git-lib/$_gd_expect_base" || -e "${EMBEDDED_PG_BIN_DIR%/bin}/lib/$_gd_expect_base" ]]; then
      echo "  ✓ cross: $_gd_expect_base already available (embedded-pg native/lib or bin/.git-lib) — reusing, no fetch needed"
      continue
    fi
    _gd_ver="$(curl -fsSL "https://formulae.brew.sh/api/formula/${_gd_formula}.json" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["versions"]["stable"])' 2>/dev/null)"
    [[ -n "$_gd_ver" ]] || { echo "ERROR: could not resolve $_gd_formula stable version from the brew formula api"; exit 1; }
    _gd_ver="$(_brew_ver_with_darwin_bottle "$_gd_formula" "$_gd_ver" "$TARGET_ARCH" "homebrew/core/$_gd_formula")"
    echo "  → cross: fetching $_gd_formula ${_gd_ver} darwin-${TARGET_ARCH} bottle (git dep)"
    _gd_keg="$(fetch_brew_keg "$_gd_formula" "$_gd_ver" "$TARGET_ARCH" "homebrew/core/$_gd_formula" "$(mktemp -d)/${_gd_formula}keg")" \
      || { echo "ERROR: $_gd_formula darwin bottle fetch failed (see above)"; exit 1; }
    _gd_src="$(find "$_gd_keg/lib" -maxdepth 1 -name "$_gd_expect_base" ! -type l | sed -n 1p)"
    [[ -n "$_gd_src" && -f "$_gd_src" ]] || { echo "ERROR: $_gd_expect_base not found in the $_gd_formula bottle ($_gd_keg/lib)"; exit 1; }
    cp -L "$_gd_src" "$SIDECAR_DIR/bin/.git-lib/$_gd_expect_base"
    chmod 755 "$SIDECAR_DIR/bin/.git-lib/$_gd_expect_base"
    llvm-install-name-tool-18 -id "@executable_path/.git-lib/$_gd_expect_base" "$SIDECAR_DIR/bin/.git-lib/$_gd_expect_base"
    rcodesign sign "$SIDECAR_DIR/bin/.git-lib/$_gd_expect_base" >/dev/null 2>&1 \
      || { echo "ERROR: rcodesign ad-hoc sign failed for vendored $_gd_expect_base"; exit 1; }
    echo "  ✓ cross: vendored + signed $_gd_expect_base into bin/.git-lib"
  done

  echo "→ vendoring git ${_brew_git_ver} (darwin-${TARGET_ARCH}) into bin/.git-vendor"
  rm -rf "$SIDECAR_DIR/bin/.git-vendor"
  mkdir -p "$SIDECAR_DIR/bin/.git-vendor/libexec" "$SIDECAR_DIR/bin/.git-vendor/share/git-core"
  cp -a "$_cross_darwin_git_keg/bin" "$SIDECAR_DIR/bin/.git-vendor/bin"
  cp -a "$_cross_darwin_git_keg/libexec/git-core" "$SIDECAR_DIR/bin/.git-vendor/libexec/git-core"
  if [[ -d "$_cross_darwin_git_keg/share/git-core/templates" ]]; then
    cp -a "$_cross_darwin_git_keg/share/git-core/templates" "$SIDECAR_DIR/bin/.git-vendor/share/git-core/templates"
  fi

  # EI-21020567880673280: Homebrew's git bottle includes the optional
  # `git instaweb` web-UI helper. Papercusp never invokes it, but the helper is
  # a 22 KiB shell script containing MIME-table text that trips the mandatory
  # assembled-bundle identity scan (the 0.0.18-alpha macOS leg failed on its
  # `.owner` entries). Do not weaken or exclude the scan: prune this non-runtime
  # helper from the shipping copy immediately after the verbatim keg copy and
  # before Mach-O rewrite/signing walks the vendor tree.
  rm -f "$SIDECAR_DIR/bin/.git-vendor/libexec/git-core/git-instaweb"
  [[ ! -e "$SIDECAR_DIR/bin/.git-vendor/libexec/git-core/git-instaweb" ]] \
    || { echo "ERROR: optional git-instaweb helper survived the sidecar prune"; exit 1; }

  _git_vendor_count=0
  while IFS= read -r -d '' _gv_file; do
    if file -b "$_gv_file" 2>/dev/null | grep -c '^Mach-O' >/dev/null; then
      _cross_darwin_vendor_pg_tool "$_gv_file" "$SIDECAR_DIR/bin/.git-lib" || exit 1
      _git_vendor_count=$((_git_vendor_count + 1))
    fi
  done < <(find "$SIDECAR_DIR/bin/.git-vendor" -type f -print0)
  echo "  ✓ cross: rewrote + signed $_git_vendor_count Mach-O binaries under bin/.git-vendor"

  # A clean Mac must find `git` on PATH without knowing the vendor layout —
  # bin/ is already the sidecar's PATH-priority dir (tool-path.ts composeToolPath
  # puts PAPERCUSP_SIDECAR_BIN first), so a plain symlink at bin/git is enough;
  # GIT_EXEC_PATH/GIT_TEMPLATE_DIR (set in tool-path.ts) point INTO .git-vendor.
  ln -sfn ".git-vendor/bin/git" "$SIDECAR_DIR/bin/git"
  [[ -e "$SIDECAR_DIR/bin/git" ]] || { echo "ERROR: bin/git symlink to .git-vendor/bin/git did not resolve"; exit 1; }
  echo "  ✓ cross: vendored git ${_brew_git_ver} — bin/git -> .git-vendor/bin/git"
fi

# MinGit-busybox (Windows only) — provides BOTH `git.exe` and a busybox-
# backed `bash.exe`, plus the small POSIX util set the harness scripts
# expect (sed, grep, sort, …). Tauri main prepends `git/cmd` and `git/usr/bin`
# to PATH on Windows so all bundled tools resolve by name.
#
# Linux ships git via the distro, so we skip vendoring there — only Windows
# (MinGit, below) and macOS (EI-3620, above) lack a reliable system git.
#
# We pin to the busybox flavor of MinGit (vs. the full MinGit) because it
# includes the POSIX shell + utils the harness needs; the regular MinGit
# strips them.
if [[ "$target_os" == "windows" ]]; then
  MINGIT_VERSION="${MINGIT_VERSION:-2.54.0}"
  MINGIT_TAG="${MINGIT_TAG:-v${MINGIT_VERSION}.windows.1}"
  mingit_asset="MinGit-${MINGIT_VERSION}-busybox-64-bit.zip"
  GIT_DIR="$SIDECAR_DIR/git"
  echo "→ downloading MinGit-busybox $MINGIT_VERSION (provides git.exe + bash.exe + POSIX utils on Windows)"
  mingit_zip="/tmp/$mingit_asset"
  if curl -fsSL "https://github.com/git-for-windows/git/releases/download/${MINGIT_TAG}/${mingit_asset}" -o "$mingit_zip"; then
    rm -rf "$GIT_DIR"
    mkdir -p "$GIT_DIR"
    unzip -q "$mingit_zip" -d "$GIT_DIR"
    rm -f "$mingit_zip"
    # MinGit-busybox bundles busybox.exe but no bash.exe — busybox
    # dispatches by argv[0], so a copy named bash.exe routes to its
    # built-in shell. The harness `run.sh` shebang and several scripts
    # need bash on PATH; this is how we satisfy that on Windows.
    if [[ -f "$GIT_DIR/mingw64/bin/busybox.exe" ]]; then
      cp "$GIT_DIR/mingw64/bin/busybox.exe" "$GIT_DIR/mingw64/bin/bash.exe"
    fi
    if [[ -f "$GIT_DIR/cmd/git.exe" && -f "$GIT_DIR/mingw64/bin/bash.exe" ]]; then
      echo "  ✓ MinGit at $GIT_DIR ($(du -sh "$GIT_DIR" | awk '{print $1}'))"
    else
      echo "  ⚠ MinGit zip extracted but cmd/git.exe + mingw64/bin/bash.exe not at expected paths"
      rm -rf "$GIT_DIR"
    fi
  else
    echo "  ⚠ failed to download MinGit; Windows builds will require user-installed Git for Windows"
  fi
fi

# omp (Pi) is NOT bundled — the desktop app uses the user's locally-installed
# omp (owner directive 2026-07-07). See the header comment above for the
# detection + launch path that finds it. meridian was decommissioned earlier
# (2026-07-06, WI-3180) for the same "use the local install, not a bundled
# copy" reason.

# code-server is NOT bundled — the vscode-in-the-browser panel is retired
# (owner directive 2026-07-07). The Tauri spawn is removed in main.rs; nothing
# reads sidecar/code-server anymore.

# Strip embedded-postgres language extensions that link to system libs we
# don't ship (libpython3.6, libperl5.26, libtcl). These are PL/Python,
# PL/Perl, PL/Tcl — none of which Papercusp uses. linuxdeploy walks every
# ELF in the sidecar during AppImage bundling and bails on missing libs.
# IMPORTANT: only strip plperl/plpython/pltcl — DO NOT strip plpgsql,
# which is the default procedural language and required for ANY pgdata
# initdb (FATAL: extension "plpgsql" is not available).
# NOTE: the glob is a SUBSTRING match (*plpython*, not plpython*) — contrib
# "bridge" extensions like ltree_plpython3.so / hstore_plperl.so / jsonb_
# plpython3.so link libpython/libperl too but are PREFIXED with the data-type
# name, not the language, so a prefix-only glob (plpython*) misses them. A
# missed one still crashes AppImage bundling the same way (WI-807 live repro:
# `ERROR: Could not find dependency: libpython3.6m.so.1.0` from
# ltree_plpython3.so, only surfaced after the plpython*-prefixed files were
# already stripped). plpgsql is safe under substring matching too — it
# contains none of plperl/plpython/pltcl as a substring.
echo "→ stripping unused PL/* extensions (plperl, plpython, pltcl) from embedded-postgres"
pl_count=0
for ext_dir in "$EMBEDDED_PG_DST/node_modules/@embedded-postgres"/*/native/share/postgresql/extension; do
  [[ -d "$ext_dir" ]] || continue
  for f in "$ext_dir"/*plperl* "$ext_dir"/*plpython* "$ext_dir"/*pltcl*; do
    [[ -e "$f" ]] || continue
    rm -f "$f"
    pl_count=$((pl_count + 1))
  done
done
for lib_dir in "$EMBEDDED_PG_DST/node_modules/@embedded-postgres"/*/native/lib/postgresql; do
  [[ -d "$lib_dir" ]] || continue
  for f in "$lib_dir"/*plperl* "$lib_dir"/*plpython* "$lib_dir"/*pltcl*; do
    [[ -e "$f" ]] || continue
    rm -f "$f"
    pl_count=$((pl_count + 1))
  done
done
echo "  removed $pl_count PL/* extension files (plpgsql preserved)"

# Strip musl-libc native binary variants. npm pulls these in as optional
# deps (e.g. @img/sharp-linuxmusl-*, @lydell/node-pty-linuxmusl-*) alongside
# the glibc variants, intended for Alpine. Our AppImage targets glibc, so
# these are dead weight AND they break linuxdeploy: it walks every ELF and
# tries to resolve its deps, but `libc.musl-x86_64.so.1` doesn't exist on
# the glibc runner, so AppImage bundling aborts with:
#   ERROR: Could not find dependency: libc.musl-x86_64.so.1
#   ERROR: Failed to deploy dependencies for existing files
#   Error [tauri_cli] failed to bundle project
# Documented in the AppImage debug arc 2026-05-01.
# NOTE: publishers spell the musl variant TWO different ways — the
# `-linuxmusl-<arch>` node-gyp-build convention (@lydell/node-pty,
# @img/sharp) AND the `linux-<arch>-musl` napi-rs convention (e.g.
# @libsql/linux-x64-musl, pulled in transitively via meridian-host's
# node_modules). A pattern that only matches the first form misses the
# second and still crashes linuxdeploy on `libc.musl-x86_64.so.1` (WI-807
# live repro: meridian-host/node_modules/@libsql/linux-x64-musl/index.node
# — "Failed to run ldd: exited with code 1"). Match "musl" anywhere in the
# dir name so both conventions (and any future variant) are caught.
echo "→ stripping musl-libc native binary variants (incompatible with glibc AppImage)"
musl_dirs=$(find "$SIDECAR_DIR" -type d -iname "*musl*" 2>/dev/null)
if [[ -n "$musl_dirs" ]]; then
  while IFS= read -r d; do
    echo "  ✗ removing $d"
    rm -rf "$d"
  done <<< "$musl_dirs"
else
  echo "  (none found)"
fi

# Seed-dump bake REMOVED — the mechanism it fed no longer exists (EI-19455334533123459).
#
# This block used to pg_dump into $SIDECAR_DIR/seed.dump, and when no dump was
# present it printed "bundle will boot empty". NOTHING has consumed seed.dump
# since the restore path was retired in self-contained-migration-baseline-2026-06-02
# (D-004), so that line described a defect that could not occur — and it had
# already misdiagnosed the seed twice by the time this was removed.
#
# Verified at removal (2026-08-03), so a future reader need not re-derive it:
#   • src-tauri/src/ contains NO seed.dump detection and NO pg_restore — the
#     comment here previously asserted the Rust main did both. It did not.
#   • startEmbeddedPostgresServer() accepts no seedDumpPath/pgRestoreBin; the
#     tombstone is at embedded-postgres-server/src/index.js:499.
#
# A fresh install now builds its schema by applying 000-baseline.sql + migrations
# directly, so an empty first boot is the DESIGNED path, not a missing seed.
# Re-introducing a build-time data seed means restoring the consumer FIRST.

# ── chat dock: pui + companion wasm + zellij 0.44.3 (cross-platform) ─────────
# The desktop chat dock runs `pui chat` (zellij hosting the pui-companion plugin).
# This was mac-ONLY (in bin/mac-vm-build.sh), so a packaged LINUX app shipped NONE
# of these → the dock was a blank pane (the pui/zellij binaries simply weren't
# bundled). Bundling them here (the shared sidecar builder, run by every platform's
# build) — OS-aware on the zellij triple — gives Linux parity. native_terminal.rs's
# cross-platform dock-env prep then puts sidecar/bin on PATH + points
# PUI_COMPANION_WASM at the bundled plugin. (linux-chat-dock-parity-2026-06-27.)
echo "→ chat dock: pui + companion wasm + zellij 0.44.3"
# EI-21832562420831737: take the ONE root resolved at the top of this script — never
# re-derive it here. This line used to be `REPO="$(cd "$ROOT/.." && pwd)"`, which ignored
# the REPO_ROOT override that the rest of the build honours, so a pinned-source cut built
# everything below (apps/tui, apps/pui-zellij-plugin, the pui build sha, its dirty probe,
# and the --remap-path-prefix that scrubs build paths out of the shipped binaries) from
# the LIVE tree while the stamp claimed the pin. Mixed provenance, no error.
REPO="$REPO_ROOT"
mkdir -p "$SIDECAR_DIR/bin"
# Resolve cargo's REAL target dir (honors CARGO_TARGET_DIR + ~/.cargo/config.toml
# `[build] target-dir` — this box redirects ALL builds to ~/.cargo-target, so the
# built binaries are NOT under <crate>/target/. Same resolution release-local.sh
# uses; empty string on failure → the standard in-crate paths below still match).
if ! CARGO_TGT="$(
  cd "$REPO/apps/tui" \
    && cargo metadata --no-deps --format-version 1 \
      | python3 -c 'import sys,json;print(json.load(sys.stdin).get("target_directory",""))'
)"; then
  # WI-40008: this probe was documented as fail-soft (the standard in-crate /
  # workspace target candidates below are valid fallbacks), but `set -e` plus
  # `pipefail` made a transient cargo-metadata error abort the ENTIRE sidecar
  # build here, with both stderr streams suppressed. Two live federation builds
  # ended exactly at the chat-dock banner as a result. Keep the failure loud,
  # then take the fallback the surrounding code has always promised.
  echo "    WARN: cargo metadata could not resolve the pui target directory — falling back to standard crate/workspace target paths" >&2
  CARGO_TGT=""
fi
# EI-20094260886633250 / WI-4736 / EI-11730 — REMAP BUILD PATHS OUT OF THE BINARIES.
# rustc bakes ABSOLUTE build paths into .rodata (panic locations, file!(), and the
# std/registry paths behind them). On 2026-08-10 that made the shipped chat-dock
# payload carry the build-box identity: `pui` held the builder's $HOME path 544
# times and pui-companion.wasm 40 times, and the AppImage identity gate correctly
# REFUSED to package (FATAL, LINUX_EXIT=1) — blocking the 0.0.14 Linux recut.
#
# `strip` DOES NOT FIX THIS, and it is the obvious wrong turn: measured on a copy,
# `strip --strip-all` removed 3MB of DWARF and left ALL 59 matching lines intact,
# because these strings live in .rodata, not in debug info. The only fix that works
# is to never bake the path — hence --remap-path-prefix at COMPILE time, applied to
# every pui/companion cargo invocation below (native, darwin-cross, and wasm).
#
# $REPO first: it is a prefix UNDER $HOME, and rustc takes the first match in order.
# Safe to set RUSTFLAGS here — no cargo config on this box sets rustflags (only
# [build] target-dir), so this overrides nothing.
_PUI_REMAP="--remap-path-prefix=$REPO=/papercusp --remap-path-prefix=$HOME=/build"
# A native release producer may carry the cc-driver-only LLD selector in its
# ambient RUSTFLAGS. Keep it for the native pui build, but never pass it to
# rust-lld's wasm flavor (EI-21079215899748395).
# shellcheck source=lib/rust-path-remap.sh
source "$HERE/lib/rust-path-remap.sh"
_PUI_WASM_RUSTFLAGS="$(papercusp_rustflags_without_native_lld "${RUSTFLAGS:-} $_PUI_REMAP")"
case "$_PUI_WASM_RUSTFLAGS" in
  *-fuse-ld=lld*) echo "ERROR: native LLD cc-driver flag leaked into wasm32-wasip1 RUSTFLAGS" >&2; exit 1 ;;
esac

# One release generation must stamp BOTH artifacts. Prefer the immutable cut pin
# because this shared checkout can advance while the build is running; the
# captured source provenance is the fallback for a direct dogfood build.
_PUI_BUILD_SHA="${PAPERCUSP_BUILD_SHA:-${PROVENANCE_SOURCE_GIT_HEAD:-}}"
if [[ -z "${_PUI_BUILD_SHA//[[:space:]]/}" ]]; then
  _PUI_BUILD_SHA="$(git -C "$REPO" rev-parse HEAD)"
fi
case "${PROVENANCE_SOURCE_GIT_DIRTY:-}" in
  false) _PUI_BUILD_DIRTY=0 ;;
  true)  _PUI_BUILD_DIRTY=1 ;;
  *)
    if [[ -n "$(git -C "$REPO" status --porcelain --untracked-files=normal -- apps/tui apps/pui-zellij-plugin apps/pui-companion-proto)" ]]; then
      _PUI_BUILD_DIRTY=1
    else
      _PUI_BUILD_DIRTY=0
    fi
    ;;
esac
_PUI_BUILD_EPOCH="${SOURCE_DATE_EPOCH:-$(date +%s)}"
[[ "$_PUI_BUILD_EPOCH" =~ ^[0-9]+$ && "$_PUI_BUILD_EPOCH" -gt 0 ]] \
  || { echo "ERROR: PUI build epoch is not a positive integer: $_PUI_BUILD_EPOCH" >&2; exit 1; }

# 1. companion zellij plugin (wasm32-wasip1). Build it FIRST so the native
# binary can embed the exact companion digest rather than `unknown`.
rustup target add wasm32-wasip1 >/dev/null 2>&1 || true
( exec 8>&- 9>&-; cd "$REPO/apps/pui-zellij-plugin" && \
  PUI_BUILD_SHA="$_PUI_BUILD_SHA" \
  PUI_BUILD_DIRTY="$_PUI_BUILD_DIRTY" \
  PUI_BUILD_EPOCH="$_PUI_BUILD_EPOCH" \
  RUSTFLAGS="$_PUI_WASM_RUSTFLAGS" \
  cargo build --release --target wasm32-wasip1 )
WASM=""
for _c in "$CARGO_TGT/wasm32-wasip1/release/pui_companion.wasm" "$REPO/apps/pui-zellij-plugin/target/wasm32-wasip1/release/pui_companion.wasm" "$REPO/target/wasm32-wasip1/release/pui_companion.wasm"; do
  [[ -f "$_c" ]] && WASM="$_c" && break
done
[[ -n "$WASM" ]] || { echo "ERROR: companion .wasm not found after build"; exit 1; }
cp "$WASM" "$SIDECAR_DIR/pui-companion.wasm"
# shellcheck source=lib/portable-sha256.sh
source "$HERE/lib/portable-sha256.sh"
_PUI_COMPANION_SHA256="$(papercusp_portable_sha256 "$SIDECAR_DIR/pui-companion.wasm")"
[[ "$_PUI_COMPANION_SHA256" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "ERROR: could not hash the built pui companion" >&2; exit 1; }
echo "    ✓ companion → sidecar/pui-companion.wasm ($WASM)"

# 2. pui (apps/tui) — release build for the TARGET triple, stamped with the
# same source/epoch and the just-built companion digest.
# Close both lock fds in the cargo subtree. RUSTC_WRAPPER may start the
# long-lived sccache server; if that daemon inherits the build-lock fd 8 it
# keeps later builders wedged after this shell exits. fd 9 is closed too for
# compatibility with the publish-lock protocol (it is normally unopened here).
# WI-5651: for a cross darwin bundle, pui is a native binary — build it with
# `cargo zigbuild --target <triple>` (same zig+SDK toolchain the tauri binary
# uses), NOT the host `cargo build`, or the dock would ship a linux ELF `pui`.
_pui_rust_arch="$TARGET_ARCH"
case "$_pui_rust_arch" in x64) _pui_rust_arch="x86_64" ;; arm64) _pui_rust_arch="aarch64" ;; esac
if [[ "$CROSS_BUILD" == "1" && "$TARGET_OS" == "darwin" ]]; then
  _pui_triple="${_pui_rust_arch}-apple-darwin"
  echo "    → cross: cargo zigbuild pui for ${_pui_triple}"
  rustup target add "$_pui_triple" >/dev/null 2>&1 || true
  # WI-37553: zig lives at a PERSISTENT path now. This call site used to hardcode
  # the EPHEMERAL /tmp/zig. build-mac-cross.sh was fixed to prefer
  # ~/.papercusp/zig, but THIS site was not — so the mac leg kept dying with the
  # opaque `Failed to find zig / cannot find binary path` even after zig had been
  # installed and the "fix" was believed to be in. Resolve identically, honour the
  # same env override, and FAIL LOUDLY naming the path so the next occurrence is
  # self-diagnosing rather than a cargo-zigbuild riddle.
  _zig_dir="${PAPERCUSP_ZIG_DIR:-$HOME/.papercusp/zig}"
  [ -x "$_zig_dir/zig" ] || { [ -x /tmp/zig/zig ] && _zig_dir=/tmp/zig; }
  [ -x "$_zig_dir/zig" ] || {
    echo "    ✗ zig not found at $_zig_dir/zig (set PAPERCUSP_ZIG_DIR, or install:" >&2
    echo "      curl -sSL https://ziglang.org/download/0.13.0/zig-linux-x86_64-0.13.0.tar.xz | tar -xJ -C \"\$HOME/.papercusp\" && mv \"\$HOME/.papercusp/zig-linux-x86_64-0.13.0\" \"\$HOME/.papercusp/zig\")" >&2
    exit 1
  }
  ( exec 8>&- 9>&-; cd "$REPO/apps/tui" && \
    PATH="$_zig_dir:$PATH" \
    SDKROOT="$HOME/.papercusp/macos-sdk/MacOSX.sdk" \
    PUI_BUILD_SHA="$_PUI_BUILD_SHA" \
    PUI_BUILD_DIRTY="$_PUI_BUILD_DIRTY" \
    PUI_BUILD_EPOCH="$_PUI_BUILD_EPOCH" \
    PUI_COMPANION_SHA256="$_PUI_COMPANION_SHA256" \
    RUSTFLAGS="${RUSTFLAGS:-} $_PUI_REMAP" \
    cargo zigbuild --release --target "$_pui_triple" )
  _pui_target_sub="$_pui_triple/release/pui"
else
  ( exec 8>&- 9>&-; cd "$REPO/apps/tui" && \
    PUI_BUILD_SHA="$_PUI_BUILD_SHA" \
    PUI_BUILD_DIRTY="$_PUI_BUILD_DIRTY" \
    PUI_BUILD_EPOCH="$_PUI_BUILD_EPOCH" \
    PUI_COMPANION_SHA256="$_PUI_COMPANION_SHA256" \
    RUSTFLAGS="${RUSTFLAGS:-} $_PUI_REMAP" \
    cargo build --release )
  _pui_target_sub="release/pui"
fi
# Existence-checked candidates (NOT `find` over a maybe-missing dir — under
# `set -eo pipefail` a missing path arg makes find non-zero → exit). The resolved
# CARGO_TGT comes first (covers the target-dir redirect); then the standard
# in-crate / workspace target dirs (non-redirected boxes, e.g. the mac VM).
PUI_BIN=""
for _c in "$CARGO_TGT/$_pui_target_sub" "$REPO/apps/tui/target/$_pui_target_sub" "$REPO/target/$_pui_target_sub"; do
  [[ -f "$_c" ]] && PUI_BIN="$_c" && break
done
[[ -n "$PUI_BIN" ]] || { echo "ERROR: pui binary not found after build"; exit 1; }
cp "$PUI_BIN" "$SIDECAR_DIR/bin/pui"; chmod 755 "$SIDECAR_DIR/bin/pui"
echo "    ✓ pui → sidecar/bin/pui ($PUI_BIN)"

# The same internal writer the P-021 local install/update command uses emits a
# release-relative manifest. The signed bundle may move from a staging dir to
# /opt/papercusp/runtime/releases/<version> without invalidating its paths.
python3 "$REPO/apps/tui/scripts/write-install-manifest.py" write \
  --manifest "$SIDECAR_DIR/pui-install.json" \
  --source-sha "$_PUI_BUILD_SHA" \
  --source-dirty "$_PUI_BUILD_DIRTY" \
  --built-at-epoch "$_PUI_BUILD_EPOCH" \
  --binary "$SIDECAR_DIR/bin/pui" \
  --companion "$SIDECAR_DIR/pui-companion.wasm" \
  --relative-paths
echo "    ✓ generation manifest → sidecar/pui-install.json"
# 3. zellij 0.44.3 — the plugin API is version-coupled; must match EXACTLY.
#    OS-aware triple: Linux uses the STATIC musl build (libc-independent → portable
#    across distros); macOS uses apple-darwin (matching bin/mac-vm-build.sh).
ZJ_VER=0.44.3
# WI-5651: OS/arch off TARGET_* (default host) so a cross darwin bundle fetches the
# apple-darwin zellij, not this linux host's musl build.
case "$TARGET_ARCH" in arm64) ZJ_ARCH=aarch64 ;; *) ZJ_ARCH=x86_64 ;; esac
case "$TARGET_OS" in
  linux)   ZJ_TRIPLE="${ZJ_ARCH}-unknown-linux-musl" ;;
  darwin)  ZJ_TRIPLE="${ZJ_ARCH}-apple-darwin" ;;
  *)       echo "ERROR: zellij bundling: unsupported target OS $TARGET_OS"; exit 1 ;;
esac
# The "already present" fast-path RUNS the binary (`--version`), which only works
# when the bundled zellij matches THIS host — so never trust it for a cross build
# (a stale host-platform zellij would masquerade as up-to-date and ride into the
# wrong-OS bundle). Force a fresh fetch when cross-baking.
if [[ "$CROSS_BUILD" == "0" && -x "$SIDECAR_DIR/bin/zellij" ]] && "$SIDECAR_DIR/bin/zellij" --version 2>/dev/null | grep -c "$ZJ_VER" >/dev/null; then
  echo "    ✓ zellij ${ZJ_VER} already present — skipping download"
else
  curl -fsSL "https://github.com/zellij-org/zellij/releases/download/v${ZJ_VER}/zellij-${ZJ_TRIPLE}.tar.gz" | tar -xz -C "$SIDECAR_DIR/bin"
  [[ -x "$SIDECAR_DIR/bin/zellij" ]] || { echo "ERROR: zellij ${ZJ_VER} (${ZJ_TRIPLE}) not fetched"; exit 1; }
  chmod 755 "$SIDECAR_DIR/bin/zellij"
  echo "    ✓ zellij ${ZJ_VER} (${ZJ_TRIPLE}) → sidecar/bin/zellij"
fi

# ── strip debug symbols from bundled native binaries ────────────────────────
# (install-size-audit 2026-07-07, owner-directed). The vendored Node ships
# UNSTRIPPED with debug_info (~117MB → ~100MB stripped, i.e. ~17MB of symbol
# table + debug_info the runtime never needs — node stack traces come from JS,
# not the C++ symbol table). gh/kopia/zellij already ship stripped by their
# release process (0 change — the pass is a no-op for them but future-proofs a
# future unstripped drop-in). Strip each in place SAFELY: back it up, strip, then
# re-probe it still runs `--version`; if the probe regresses, restore the
# unstripped copy. (pui is deliberately NOT in the list — it has no `--version`,
# so its probe can't confirm runnability; leave it untouched rather than guess.)
# Only the current build host's OS — a linux build can't strip a Mach-O and
# Windows ships no strip; the desktop is built per-platform so each platform
# strips its OWN binaries. macOS uses `-S` (debug entries only — a full strip can
# drop dyld-needed symbols) and the result is re-signed by the later
# `tauri build` bundling step (strip-then-sign).
_strip_os="$(uname -s)"
# WI-5651: a cross bundle's native binaries are for a DIFFERENT OS, so this host's
# `strip` can't touch them (a GNU strip on a Mach-O just fails; the re-probe then
# restores the unstripped copy — pure wasted churn). Skip the pass; node ships
# ~17MB unstripped and gh/kopia/zellij are already stripped by their release.
if [[ "$CROSS_BUILD" == "1" ]]; then
  echo "→ WI-5651 skipping native-binary strip pass (cross ${TARGET_OS}-${TARGET_ARCH} bundle; host strip can't strip foreign binaries)"
fi
if [[ "$CROSS_BUILD" == "0" ]] && command -v strip >/dev/null 2>&1 && [[ "$_strip_os" == "Linux" || "$_strip_os" == "Darwin" ]]; then
  _strip_flags=(); [[ "$_strip_os" == "Darwin" ]] && _strip_flags=(-S)
  echo "→ stripping debug symbols from bundled native binaries ($_strip_os)"
  _strip_saved=0
  for _sb in node gh kopia zellij; do
    _sbp="$SIDECAR_DIR/bin/$_sb"
    [[ -f "$_sbp" ]] || continue
    # Skip anything that isn't a real native executable (a wrapper/script).
    if command -v file >/dev/null 2>&1; then
      case "$(file -b "$_sbp" 2>/dev/null)" in *ELF*|*Mach-O*) ;; *) continue ;; esac
    fi
    _before=$(wc -c < "$_sbp")
    cp -a "$_sbp" "$_sbp.prestrip" || continue
    if strip "${_strip_flags[@]}" "$_sbp" 2>/dev/null && "$_sbp" --version >/dev/null 2>&1; then
      _after=$(wc -c < "$_sbp")
      _strip_saved=$((_strip_saved + _before - _after))
      rm -f "$_sbp.prestrip"
      echo "    ✓ $_sb: $((_before/1048576))MB → $((_after/1048576))MB"
    else
      # strip failed OR the stripped binary no longer runs — restore the original.
      mv -f "$_sbp.prestrip" "$_sbp"
      echo "    ⚠ $_sb: strip skipped (probe regressed) — kept unstripped"
    fi
  done
  echo "  ✓ strip pass reclaimed ~$((_strip_saved/1048576))MB"
fi

# ── D-105 workspace-host bootstrap entrypoints ─────────────────────────────
# The provider-neutral bootstrap executes eleven fixed paths. Node and the
# remote initializer are real binaries/bundles; the remaining nine are thin
# wrappers over this sidecar's existing Server and psu surfaces. Emit them only
# for the immutable Server profile, after every delegate exists and before the
# runtime-only prune/verifier. The helper is also the one-shot overlay used to
# qualify an already-built immutable sidecar without rebuilding it.
if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
  echo "→ emitting workspace-host bootstrap entrypoints"
  bash "$HERE/install-workspace-host-entrypoints.sh" --release-root "$SIDECAR_DIR"
fi

# ── D-043/P-052 immutable runtime-only profile ──────────────────────────────
# Run after every sidecar copy/overlay step and before the runtime verifier and
# atomic publish. The Python gate owns both the prune predicate and the audit
# predicate, so a new residue class cannot be deleted by one list while escaping
# the other. Dogfood does not enter this block and retains its source/templates/
# multi-environment behavior unchanged.
if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
  echo "→ pruning vm-release sidecar to the runtime-only allowlist (D-043/P-052)"
  python3 "$HERE/audit-release-bundle.py" --prune-vm-release "$SIDECAR_DIR"
  assert_sidecar_db_sql_matches_source "after vm-release prune"
  echo "→ auditing vm-release payload + root/cloud-owner threat boundary"
  python3 "$HERE/audit-release-bundle.py" --audit-vm-release "$SIDECAR_DIR"
fi

# ── release-bundle dependency verifier (WI-3315) ────────────────────────────
# Verifies the bundle against its RUNTIME CONTRACT (manifest of spawned tools,
# no script shims, linkage closure over bundle libs + base allowlist) BEFORE
# the atomic publish — a bundle that fails never replaces the last good one.
# The point: build-host probes are masked (the host has the dev deps), which
# is exactly how the pg_wrapper psql (WI-3311) and unbundled kopia (WI-3312)
# shipped broken. See the verifier's header before touching its allowlists.
"$ROOT/bin/verify-sidecar-bundle.sh" "$SIDECAR_DIR" --target-os "$TARGET_OS" --target-arch "$TARGET_ARCH"

# EI-21492557010868835: dependency/runtime verification is necessary but not a
# security verdict.  Generate a real CycloneDX SBOM of the finished temporary
# sidecar, scan it with the current valid Grype DB, and refuse every High or
# Critical match BEFORE the atomic publish lock is taken.  Evidence lives
# outside the scanned tree to avoid self-referential SBOMs; the audit writes a
# small digest-bound green attestation into the tree only after a clean verdict.
if [[ "$DISTRIBUTION_PROFILE" == "vm-release" ]]; then
  VM_RELEASE_TRUST_OUTPUT_DIR="${PAPERCUSP_VM_RELEASE_TRUST_OUTPUT_DIR:-$SIDECAR_DIR.release-trust}"
  echo "→ generating vm-release SBOM + fail-closed High/Critical vulnerability verdict"
  # The audit pins GRYPE_DB_AUTO_UPDATE=false so the DB cannot change MID-scan, and refuses a DB
  # older than VM_RELEASE_GRYPE_DB_MAX_AGE_HOURS. Nothing else on the build host refreshes it, so
  # a cut run >3 days after the last manual refresh died HERE after a full sidecar build (P-318
  # r40, 2026-09-23: "grype DB is 92.6h old; maximum is 72h"). Refresh BEFORE the scan: `grype db
  # update` is a no-op on a current DB, and a failed refresh is not fatal here — the audit's own
  # fail-closed freshness check still decides, so this can never admit a stale DB.
  if command -v grype >/dev/null 2>&1; then
    GRYPE_CHECK_FOR_APP_UPDATE=false grype db update \
      || echo "  ⚠ grype db update failed — the audit's freshness check decides" >&2
  fi
  python3 "$HERE/audit-release-bundle.py" --audit-vulnerabilities \
    "$SIDECAR_DIR" "$VM_RELEASE_TRUST_OUTPUT_DIR"
  echo "  ✓ vm-release vulnerability evidence: $VM_RELEASE_TRUST_OUTPUT_DIR"
fi

# ── EI-160: atomic publish (P-056) ──────────────────────────────────────────
# The minutes-long build above held only sidecar.build.lock. Take the
# reader-facing lock now, after the staged bundle is complete and verified.
__pc_acquire_sidecar_publish_lock || exit $?

# Retire the old bundle via rename, rename the temp build into place, then
# delete the retired tree. Renames on one filesystem are atomic, so a
# concurrent reader sees only complete-old or complete-new — never the
# half-written dir the old in-place rm -rf/cp produced.
# Normalize owner-write on the whole tree: sources copied from brew kegs
# (libpq tools, pgvector dylib) arrive 0444/0555, and tauri-build's
# per-target resource copy then EACCESes overwriting its own previous
# read-only copy on every REBUILD (whack-a-mole class: pg_dumpall, then
# vector.dylib — kill it wholesale).
chmod -R u+w "$SIDECAR_DIR"

# NB: plain `mv src dst` (no GNU-only -T; BSD/macOS mv lacks it) — safe ONLY
# while the destination is absent; if it exists, mv falls into
# move-INTO-directory mode. The publish below re-checks for that (see the
# squatter guard) because "absent" is NOT guaranteed under concurrency.
OLD_DIR="$SIDECAR_FINAL_DIR.old.$$"
if [[ -d "$SIDECAR_FINAL_DIR" ]]; then
  mv "$SIDECAR_FINAL_DIR" "$OLD_DIR"
fi
# ── Preserve release-staged OVERLAY artifacts across a republish (WI-3346) ──
# stage-source-tree.sh (sidecar/source.tar.zst — the all-5-buttons dev-source
# tree) and stage-env-sidecars.sh (sidecar/env-sidecars/) add files ON TOP of a
# completed sidecar build; this script does NOT produce them. A concurrent dev
# `npm run tauri dev` (→ beforeDevCommand → this script) atomically republished
# the sidecar BETWEEN a release's stage-*.sh and its Linux tauri/appimage
# resource read, wiping source.tar.zst → the 0.0.3-alpha Linux leg died with
# "resource path 'sidecar/source.tar.zst' doesn't exist". Since this build
# didn't create the overlays, carry any present in the OUTGOING tree into the
# new one so a republish can never clobber a release mid-build. (A slim build
# that wants them gone: `rm -rf src-tauri/sidecar` first — a fresh tree has no
# OLD_DIR, so nothing is preserved.)
if [[ -d "$OLD_DIR" ]]; then
  for _overlay in source.tar.zst env-sidecars; do
    if [[ -e "$OLD_DIR/$_overlay" && ! -e "$SIDECAR_TMP_DIR/$_overlay" ]]; then
      cp -a "$OLD_DIR/$_overlay" "$SIDECAR_TMP_DIR/$_overlay" \
        && echo "→ preserved release overlay across republish: $_overlay"
    fi
  done
fi
# The preserved env overlays are copied AFTER the primary db-sql scrub above.
# They carry their own db-sql trees (and may preserve hardlinks), so scrub every
# restored environment copy at this actual copy point before stamping/publishing.
# This closes EI-20588742052141621's second path instead of relying on the late
# assembled scan to rediscover it after the expensive build has finished.
if declare -F _scrub_sidecar_db_sql >/dev/null 2>&1; then
  _scrub_sidecar_db_sql \
    "preserved env sidecars" \
    "$SIDECAR_TMP_DIR"/env-sidecars/*/db-sql
fi
# Preserved env overlays also carry serve.mjs + compiled SPA text. Scrub them at
# the actual restore point; the earlier primary-sidecar scrub cannot see bytes
# copied later from OLD_DIR.
if [[ "${PAPERCUSP_STAGE_SCRUB:-1}" == "1" && -f "$HERE/audit-release-bundle.py" \
      && -d "$SIDECAR_TMP_DIR/env-sidecars" ]]; then
  python3 "$HERE/audit-release-bundle.py" --scrub-text \
    "$SIDECAR_TMP_DIR/env-sidecars"
fi
# ── P-004 (desktop-build-hardening-tri-platform-2026-07-11): sidecar freshness
# stamp ─────────────────────────────────────────────────────────────────────
# build-windows-on-vm.sh PACKS sidecar/serve.mjs AS-IS (it never rebuilds the
# sidecar), so a stale serve.mjs — left from an older operator build — could
# ship none of the operator fixes while the cut still looked green (the
# artifact-level LABELED!=PACKED class this plan eradicates). Stamp the tree the
# packers verify against: the sha256 of the serve.mjs (+ mcp-proxy.mjs) we
# ACTUALLY built, when, and from which monorepo HEAD. Written into the TMP tree
# so the atomic publish below ships it WITH the bundle it describes. Cheap (two
# sha256 over the just-built .mjs). The Windows leg's fail-closed guard reads it
# (P-004 / D-003).
# PORTABLE hashing (WI-4223, 0.0.8 mac cut): macOS ships NO sha256sum — only
# `shasum` — and under this script's `set -eo pipefail` the bare
# `sha256sum|cut` pipeline exited 127 and killed the ENTIRE publish, silently
# (the 2>/dev/null ate bash's "command not found"), right after
# verify-sidecar-bundle: OK. A metadata stamp must NEVER kill a verified
# build: prefer sha256sum (linux), fall back to shasum -a 256 (macOS
# built-in), and yield "" (visible in the stamp JSON) rather than a death if
# neither/no file exists. EI-9905: the helper now lives in
# bin/lib/portable-sha256.sh so any OTHER script that gains a darwin
# execution path can reuse it instead of re-deriving this fix.
# shellcheck source=lib/portable-sha256.sh
source "$HERE/lib/portable-sha256.sh"
# EI-21826568874232796: the stamp's gitHead must record the sha this build was CUT
# FROM, not whatever HEAD happens to be by the time this line runs. This is a long
# build on a shared checkout, and git-sync commits peers' work on a schedule, so a
# live read here stamps provenance the published bytes were never built from — and
# it fails silently, because a plausible-looking sha is indistinguishable from the
# right one after the fact. Prefer the immutable PAPERCUSP_BUILD_SHA pin; fall back
# to the live checkout only when there is no pin. Extracted to
# bin/lib/stamp-git-head.sh so the HEAD-moved-mid-build case is reachable by a test
# (packages/operator-core/lib/sidecar-stamp-git-head-pin.test.ts).
#
# ⚠ Deliberately NOT shared with the release-audit HEAD-move guard further down
# (the PAPERCUSP_RELEASE_AUDIT block before the publish rename). That guard must
# keep reading LIVE HEAD: its whole job is to observe the world independently and
# disagree with the pin. Route it through this prefer-the-pin helper and its
# comparison becomes pin != pin — always false — so it would keep passing while
# having been made incapable of failing.
# shellcheck source=lib/stamp-git-head.sh
source "$HERE/lib/stamp-git-head.sh"
_stamp_serve_sha="$(papercusp_portable_sha256 "$SIDECAR_TMP_DIR/serve.mjs")"
_stamp_proxy_sha="$(papercusp_portable_sha256 "$SIDECAR_TMP_DIR/mcp-proxy.mjs")"
_stamp_git_head="$(papercusp_stamp_git_head "$REPO_ROOT")"
{
  printf '{\n'
  printf '  "serveSha256": "%s",\n'    "${_stamp_serve_sha:-}"
  printf '  "mcpProxySha256": "%s",\n' "${_stamp_proxy_sha:-}"
  printf '  "builtAtUtc": "%s",\n'     "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "epochSec": %s,\n'         "$(date +%s)"
  printf '  "gitHead": "%s"\n'         "$_stamp_git_head"
  printf '}\n'
} > "$SIDECAR_TMP_DIR/.sidecar-build-stamp"
echo "→ wrote sidecar freshness stamp (serve.mjs ${_stamp_serve_sha:0:12}…, P-004)"

# WI-5638 recurrence guard (revised 2026-07-27 — see the copy_pkg_closure
# comment above for why the strip is no longer blanket): every runtime
# download-scratch `.cache` dir must still never reach the .deb from any
# OTHER path (a new closure entry point, the embedded-postgres/node-pty
# copies, a future package, …) — that class-level backstop stays absolute.
#
# Since D-178 it is absolute with NO exception at all. The transformers
# package's `.cache` used to be carved out because it carried the two
# owner-confirmed live embedding models; those models now live at
# <transformers>/models/onnx-community/, so a `.cache/` anywhere under the
# staged node_modules is unambiguously scratch again. The allowlist that used
# to protect them moved to the models guard below, at equal strength.
# D-178: there is NO LONGER AN EXPECTED CACHE. The two live embedding models are
# relocated to <transformers>/models/onnx-community/ during package staging, so
# every `.cache/` under the staged node_modules is now scratch without exception,
# and this guard is absolute again.
#
# ⚠ The `| { grep -v -F -x "$_expected_cache" || true; }` filter that used to
# carve out the exception is GONE, and so is the trap it carried
# (EI-18885442084466501): `grep -v` exits 1 when it filters out every line, and
# under `set -euo pipefail` that killed the build on the HEALTHY path — after the
# destructive `mv "$SIDECAR_FINAL_DIR" "$OLD_DIR"` had already run and with the
# EXIT trap then deleting the staged tree, so each run moved the previous sidecar
# aside, built a complete bundle, verified it, and then left the tree with NO
# sidecar at all. The last line printed was success-shaped. 11 orphaned
# sidecar.old.<pid> dirs were the only visible symptom, and they had been filed
# as a cleanup omission (EI-18882950272344248) — they were not.
# If you ever reintroduce a filter here, it needs `|| true` for that reason.
# The `|| true` is the SAME load-bearing escape the old grep needed, for the same
# reason one level down: `find` exits non-zero when its root is missing, and under
# `set -euo pipefail` a command substitution that fails kills the build HERE —
# after the destructive `mv`, with no message at all. Removing the grep retired
# the old instance of this shape and momentarily reintroduced it; the guard's
# own test caught it (a missing-models fixture exited 1 with empty stderr, which
# looks exactly like the guard firing correctly). Keep the escape: this block must
# only ever fail LOUDLY, via its explicit echo+exit paths below.
_stray_caches=$(find "$SIDECAR_DIR/node_modules" -type d -name ".cache" 2>/dev/null || true)
if [[ -n "$_stray_caches" ]]; then
  echo "FATAL: runtime .cache dir(s) found in staged sidecar node_modules — these are download scratch that must never ship (WI-5638), and since D-178 there is no exception: the live embedding models belong at <transformers>/models/onnx-community/:" >&2
  echo "$_stray_caches" >&2
  exit 1
fi
# The allowlisting job the block above used to do MOVES HERE, unchanged in
# strength: exactly the two owner-confirmed models, at the relocated path, and
# nothing else. Fail-closed in BOTH directions — a missing model is as fatal as
# an unexpected one, because "models silently absent" is the failure mode that
# ships a product whose local embedding is quietly broken (WI-5638).
_expected_models="$SIDECAR_DIR/node_modules/@huggingface/transformers/models/onnx-community"
if [[ ! -d "$_expected_models" ]]; then
  echo "FATAL: relocated transformers models missing at $_expected_models — the desktop app runs a live hybrid of harrier-oss + embeddinggemma and cannot regenerate them at runtime (WI-5638 / D-178)" >&2
  exit 1
fi
for _required_model in harrier-oss-v1-0.6b-ONNX embeddinggemma-300m-ONNX; do
  if [[ ! -d "$_expected_models/$_required_model" ]]; then
    echo "FATAL: required embedding model missing after relocation: $_expected_models/$_required_model (WI-5638 / D-178)" >&2
    exit 1
  fi
done
_unexpected_model_entries=$(find "$_expected_models" -mindepth 1 -maxdepth 1 \
  ! -name 'harrier-oss-v1-0.6b-ONNX' ! -name 'embeddinggemma-300m-ONNX' 2>/dev/null)
if [[ -n "$_unexpected_model_entries" ]]; then
  echo "FATAL: unexpected entries beside the relocated models — only harrier-oss + embeddinggemma are owner-confirmed live (WI-5638 / D-178):" >&2
  echo "$_unexpected_model_entries" >&2
  exit 1
fi
assert_no_transformers_model_fragments "$SIDECAR_DIR/node_modules/@huggingface/transformers/models" || exit 1

# EI-200 epilogue (2026-07-18, gate run 20260718-000508): the destination is
# NOT guaranteed absent here — a concurrent bare `cargo build` (tauri-dev
# shells don't go through cargo-build-safe.sh) can run build.rs in the long
# window since the OLD_DIR rename (overlay cp + two sha256 stamps) and
# recreate $SIDECAR_FINAL_DIR as a placeholder skeleton. Plain mv then
# publishes sidecar/sidecar.tmp.<pid>/ NESTED inside it — a silently-corrupt
# tree the federation gate repacked into a .deb and burned a content-matrix
# RED on. EI-21830176050381484 narrows the old unconditional rm -rf: only the
# exact build.rs placeholder is disposable. Any real/unknown sidecar is a
# second-writer violation and is preserved while this build fails loudly.
if [[ -d "$SIDECAR_FINAL_DIR" ]]; then
  if __pc_is_cargo_sidecar_placeholder "$SIDECAR_FINAL_DIR"; then
    echo "→ WARN: verified cargo build.rs placeholder reappeared at $SIDECAR_FINAL_DIR — evicting it before the publish rename"
    rm -rf "$SIDECAR_FINAL_DIR"
  else
    echo "FATAL: $SIDECAR_FINAL_DIR reappeared mid-publish and is NOT the exact cargo build.rs placeholder; refusing to delete another writer's output." >&2
    echo "       Preserved the unexpected sidecar in place. Re-run after the competing writer exits." >&2
    exit 6
  fi
fi
# A clean source can still move while this long build runs (for example when
# git-sync commits a peer's change). Refuse to publish bytes whose source HEAD
# no longer matches the snapshot captured at cut start. This check is release-
# audit-only: developer builds retain their existing iterative behavior.
if [[ "${PAPERCUSP_RELEASE_AUDIT:-0}" == "1" ]]; then
  _provenance_current_head="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"
  if [[ -z "${PROVENANCE_SOURCE_GIT_HEAD:-}" \
     || "$_provenance_current_head" != "$PROVENANCE_SOURCE_GIT_HEAD" ]]; then
    echo "ERROR: release-audited sidecar source HEAD moved during build (start=${PROVENANCE_SOURCE_GIT_HEAD:-unset}, current=$_provenance_current_head); refusing publish." >&2
    echo "       Re-run from a clean stable source snapshot; no mixed-provenance sidecar was published." >&2
    exit 1
  fi
  unset _provenance_current_head
fi
mv "$SIDECAR_TMP_DIR" "$SIDECAR_FINAL_DIR"
_tmp_base="$(basename "$SIDECAR_TMP_DIR")"
if [[ -d "$SIDECAR_FINAL_DIR/$_tmp_base" ]]; then
  _squat_dir="$SIDECAR_FINAL_DIR.squat.$$"
  mv "$SIDECAR_FINAL_DIR" "$_squat_dir"
  mv "$_squat_dir/$_tmp_base" "$SIDECAR_FINAL_DIR"
  if __pc_is_cargo_sidecar_placeholder "$_squat_dir"; then
    rm -rf "$_squat_dir"
    echo "→ repaired nested publish after a verified cargo build.rs placeholder raced the final rename"
  else
    mv "$SIDECAR_FINAL_DIR" "$SIDECAR_TMP_DIR"
    mv "$_squat_dir" "$SIDECAR_FINAL_DIR"
    echo "FATAL: a non-placeholder sidecar raced the final publish rename; restored and preserved that writer's output instead of deleting it." >&2
    echo "       This staged build was not published. Re-run after the competing writer exits." >&2
    exit 6
  fi
fi
[[ -f "$SIDECAR_FINAL_DIR/serve.mjs" ]] || { echo "FATAL: published sidecar has no serve.mjs — publish corrupted, refusing to report success" >&2; exit 1; }
SIDECAR_DIR="$SIDECAR_FINAL_DIR"

# EI-21548386804468550: the pre-publish verifier observes the staged pathname.
# Path-sensitive defects (most notably an absolute symlink into sidecar.tmp.PID)
# can therefore pass and become broken only after the atomic rename. Reuse the
# exact verifier against the reader-visible final path while the publish lock is
# still held. Keep OLD_DIR until this verdict; on red, preserve the bad tree and
# atomically restore the prior published sidecar rather than stranding readers.
echo "→ re-verifying atomically published sidecar at its final path"
if ! "$ROOT/bin/verify-sidecar-bundle.sh" "$SIDECAR_DIR" --target-os "$TARGET_OS" --target-arch "$TARGET_ARCH"; then
  _failed_publish="$SIDECAR_FINAL_DIR.failed-post-publish.$$"
  mv "$SIDECAR_FINAL_DIR" "$_failed_publish"
  if [[ -d "$OLD_DIR" ]]; then
    mv "$OLD_DIR" "$SIDECAR_FINAL_DIR"
    echo "FATAL: final-path sidecar verification failed; restored prior sidecar and preserved failed bytes at $_failed_publish" >&2
  else
    echo "FATAL: final-path sidecar verification failed; preserved failed bytes at $_failed_publish (no prior sidecar existed)" >&2
  fi
  exit 1
fi
rm -rf "$OLD_DIR"

# ── Provenance (EI-19446480107603858) ────────────────────────────────────────
# Record WHAT SOURCE this sidecar was baked from, using the SAME shared emitter
# and schema as the mac/windows/linux release legs (bin/emit-build-provenance.sh)
# — no second provenance shape, so verify-provenance-parity.sh stays satisfied.
#
# WHY: the cross-build legs CONSUME a sidecar they did not build, and gated it on
# existence + arch only. Both guards are loud when it is MISSING and silent when
# it is STALE — and stale is the common case, because rebuilding it is a separate
# manual step. On 2026-08-03 (WI-3307) that shipped a bundle carrying a 9-hour-old
# operator while the bundle's OTHER half (the rsync'd source tree) was current, so
# the acceptance criteria all passed on the fresh half. Without this file the
# staleness is not merely unguarded, it is UNKNOWABLE — nothing on disk records
# when the sidecar was baked or from which commit.
#
# Non-fatal by design: a metadata emit must never kill a fully-built, verified
# sidecar (the EI-9899 lesson that produced bin/lib/portable-sha256.sh). Consumers
# treat an absent file as "cannot judge", never as a pass.
if [[ -x "$HERE/emit-build-provenance.sh" ]]; then
  PROVENANCE_GIT_ROOT="$REPO_ROOT" \
    bash "$HERE/emit-build-provenance.sh" \
      "$SIDECAR_DIR" \
      "${PAPERCUSP_DESKTOP_VERSION:-unknown}" \
      "${PAPERCUSP_BUILD_SHA:-}" \
      false \
      "$SIDECAR_DIR/serve.mjs" \
      "$SIDECAR_DIR/bin/node" \
      >/dev/null \
    || echo "→ WARN: sidecar provenance emit failed (non-fatal; consumers will report 'cannot judge')"
  # Explicit `if`, not `[[ ... ]] && echo` — a trailing AND-list leaves the block's
  # exit status at 1 when the test fails, which is a set -e footgun in a script that
  # has already done 20 minutes of work.
  if [[ -f "$SIDECAR_DIR/build-provenance.json" ]]; then
    echo "→ provenance recorded at $SIDECAR_DIR/build-provenance.json"
  fi
fi

# ── ASSEMBLED-SIDECAR IDENTITY SCAN (WI-4419, repositioned by EI-20304355477263736)
# The ultimate backstop the source.tar.zst audit structurally cannot be: it reads
# the assembled bytes that actually ship and honors NO path-exclude. It lives HERE,
# at the very end, because a scan is only as good as its position — every earlier
# position leaves whatever is copied afterwards unscanned, and 0.0.16-alpha attempt
# 5 died on exactly that (two files written after the scrub block ~2100 lines above,
# caught ~40 minutes later by the per-leg AppDir gate instead). Anything added to
# the sidecar in the future is therefore covered by construction, with no second
# place to remember to update.
#
# Release-gated (PAPERCUSP_RELEASE_AUDIT=1) exactly as before: a dev sidecar on the
# build box — whose own identity legitimately pervades its compiled binaries —
# still builds. The prune/scrub steps stay where they are, upstream of the copies
# they rewrite. Pinned by packages/operator-core/lib/release-identity-gate-ordering.test.ts.
if [[ "${PAPERCUSP_RELEASE_AUDIT:-0}" == "1" && -f "$HERE/audit-release-bundle.py" ]]; then
  echo "→ identity-scanning assembled sidecar (release gate, honors NO path-exclude)"
  if ! python3 "$HERE/audit-release-bundle.py" --scan-dir "$SIDECAR_DIR"; then
    echo "ERROR: assembled sidecar carries a sensitive/build-box identity — refusing to ship (WI-4419)."
    exit 1
  fi
  # EI-20588742052141621: the direct cross-builders consume an already-built
  # sidecar and used to have no proof that THIS final scan ever ran. Record the
  # attestation only after success. This is the sole post-scan sidecar write: it
  # rewrites one fixed-schema metadata document with no copied/input-derived text,
  # so it cannot introduce the identity-bearing payload class the scan polices.
  _release_audit_stamp="$SIDECAR_DIR/.sidecar-build-stamp"
  node - "$_release_audit_stamp" <<'NODE'
const fs = require('node:fs');
const stampPath = process.argv[2];
const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
stamp.releaseIdentityAudit = {
  schemaVersion: 1,
  passed: true,
  scanner: 'audit-release-bundle.py --scan-dir',
  passedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
};
const tmpPath = `${stampPath}.audit-attestation.tmp`;
fs.writeFileSync(tmpPath, `${JSON.stringify(stamp, null, 2)}\n`);
fs.renameSync(tmpPath, stampPath);
NODE
  echo "→ recorded release identity-audit attestation in .sidecar-build-stamp"
fi

# Publication and its final metadata writes are complete. Release readers
# before the non-mutating size/report epilogue.
__pc_release_sidecar_publish_lock

# Compute size
total_size=$(du -sh "$SIDECAR_DIR" 2>/dev/null | awk '{print $1}')
echo "✓ sidecar built at $SIDECAR_DIR ($total_size)"
