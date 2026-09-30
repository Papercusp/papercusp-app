# Desktop release runbook — cut + verify all three platforms

> **P-015 of `desktop-build-hardening-tri-platform-2026-07-11`.** The single
> documented path for cutting a Papercusp desktop release and proving it is
> honest, self-verifying, and installable — replacing the tribal knowledge that
> was scattered across checkpoints and insights. It ties together
> `bin/release-local.sh` (the cut), the Phase-1 provenance layer, and the Phase-3
> verify tools (`release:verify-provenance`, `release:vm-preflight`,
> `release:install-and-relaunch-verify`).

## ⛔ Releases are LOCAL-only — never publish to GitHub

**Owner directive 2026-07-08 (binding):** *"We are no longer using GitHub for our
releases — just build the installer locally and I will upload it to the right
spot."*

- Build the artifacts locally, then hand the owner the **local artifact paths +
  their sha256** (see [Hand-off](#5-hand-off)). The owner uploads them.
- **Do NOT** push a release, create a GitHub Release, or attach artifacts to one.
- ⚠ `bin/release-local.sh`'s own header comment and its steps 5–6 ("push tag to
  origin", "create GitHub Release with artifacts") are **superseded** by this
  directive — that header predates it. The *build/sign/provenance/verify* steps
  are current; the *publish-to-GitHub* steps are not. Treat the build output on
  disk as the deliverable.

---

## 0. Prerequisites

| Need | How |
|------|-----|
| Signing key | `~/.papercusp/signing/papercusp.key` present (`bin/setup-signing-key.sh`). Updater artifacts are minisign-signed with it on every platform. |
| macOS leg (optional) | the mac build VM up on SSH `:2222` — see `/internal/docs/build-system/vms`. Enable with `WITH_MAC=1`. |
| Windows leg (optional) | the Windows 11 build VM up on SSH `:2223`, distro `papercup-runtime`. Enable with `WITH_WINDOWS=1`. |
| Live operator (for verify) | a running operator whose `/api/health` reports the cut's `sha` (the dev `:3070`, or the VM's in-distro operator). |

---

## 1. Cut the build

⚠ **`bin/release-local.sh` now REQUIRES two env vars before any write** (P-016 /
EI-20505417131773854, EI-21007848170102877) — a bare invocation with no env
fails immediately with `ERROR: release source drift` / `ERROR: release cut
requires PAPERCUSP_RELEASE_OWNER_NAME`. `release:cut` (below) supplies both
for you; a manual invocation must too:

```bash
cd papercusp-desktop
# <version> <channel>  — channel ∈ stable | beta | alpha
PAPERCUSP_EXPECTED_SOURCE_SHA="$(git -C .. rev-parse HEAD)" \
PAPERCUSP_RELEASE_OWNER_NAME="<your name>" \
  bin/release-local.sh 0.0.8 alpha                 # Linux only
WITH_MAC=1 WITH_WINDOWS=1 \
PAPERCUSP_EXPECTED_SOURCE_SHA="$(git -C .. rev-parse HEAD)" \
PAPERCUSP_RELEASE_OWNER_NAME="<your name>" \
  bin/release-local.sh 0.0.8 alpha   # all three
```

**Agent lever (preferred): `release:cut`.** The `release:cut` MCP tool is the
orchestrator over this script — `op:preflight` (go/no-go: signing key + scripts
present, nothing in flight), `op:run` (fires the cut **detached** so a 35–60 min
build survives a compaction/relaunch; dry-run unless `confirm:true`; operator role;
audited), `op:status` (poll it), `op:handoff` (collect the version's signed artifacts
+ sha256 for the owner — §5). It always runs the cut LOCAL-only
(`PAPERCUSP_PUBLISH_GITHUB=0`), so it can never publish to GitHub.

What the cut does, and the guard behind each step (Phase 1 + Phase 2):

1. **Honest sha (P-003).** `BUILD_SHA` is derived once, centrally, and gets a
   `-dirty` suffix if the desktop tree *or* the sidecar source is dirty — so
   `/api/health` never claims a clean commit for a dirty/reused tree. Flows
   unchanged into all three legs.
2. **Provenance-parity fail-fast (P-016).** `bin/verify-provenance-parity.sh`
   runs at the top of the cut: all three legs must emit a `build-provenance.json`
   conforming to the one shared schema (one emitter — `bin/emit-build-provenance.sh`
   — no re-inlined `printf` emitters). Override (rarely):
   `PAPERCUSP_SKIP_PROVENANCE_PARITY_CHECK=1`.
3. **serve.mjs freshness — fail-closed (P-004 / D-003).** Before packing, the
   packed `serve.mjs` fingerprint must match a fresh `build-desktop-sidecar.sh`
   output. A stale bundle **aborts** the cut (no silent auto-rebuild). Override:
   `PAPERCUSP_ALLOW_STALE_SIDECAR=1`.
4. **Host-load protection (P-006 / D-005).** The local CPU-heavy legs run under
   `nice`/`ionice` and the cut sets `PC_HEAVY_BYPASS=1` so it is never denied by
   the WI-3821 admission gate and never holds a short-command slot. Disable the
   nice-ing with `PAPERCUSP_RELEASE_NICE=0`. *(The build was the victim of host
   load, not its cause — don't throttle it.)*
5. **VM build resilience (P-007 / P-008).** The mac leg carries the SSH keepalive
   parity fix and runs **detached** on the VM (poll-for-done, non-fatal SSH
   flaps — never re-invoke a 35-min build). The mac leg fails fast on a VM
   disk-OOM preflight (`PAPERCUSP_MAC_MIN_FREE_GB`, default 12) instead of
   OOM-ing 20 min in.
6. **Version-scoped collection (P-009).** Every artifact-collection glob is
   `*_<version>_*`; a cross-version count assertion trips if a stale-version
   artifact is about to be collected.
7. **Verifiable salvage (P-005).** If `PAPERCUSP_REUSE_MAC=1` / `REUSE_WIN=1`
   salvages a prior cut's bytes, the cut reads that cut's `build-provenance.json`
   and **fails loud** if its version differs (no silent re-label). Overrides:
   `PAPERCUSP_ALLOW_REUSE_UNVERIFIED=1` / `PAPERCUSP_ALLOW_REUSE_VERSION_MISMATCH=1`.
8. **Emit provenance + sign + `latest.json`.** Each leg writes a
   `build-provenance.json` (version, buildSha, gitDirty, per-artifact sha256,
   signed, toolchain) next to its artifacts; updater artifacts are minisign-signed;
   `latest.json` carries per-platform `url` + `signature`.

Reproducibility (P-014): `tauri-cli` is pinned (`PAPERCUSP_TAURI_CLI_VERSION`
override) and the build toolchain (rustc/node/tauri-cli) is recorded in
`build-provenance.json`.

---

## 2. Ship-gate: `bin/verify-provenance.sh` (P-010)

The executable form of "a bad build physically cannot ship." Run the canonical
script once per cut artifact directory before handing anything over:

```
bash bin/verify-provenance.sh <artifact-dir> --health-sha <sha> --require-signed
```

Given one cut artifact directory and its `build-provenance.json`, it asserts
(via `bin/verify-provenance.sh` + `bin/verify-tauri-signature.mjs`):

- `gitDirty == false`;
- `buildSha == the supplied live `/api/health` sha`;
- **each artifact's sha256** matches what provenance recorded;
- **D-004 signature dimension** — every co-located minisign `.sig` verifies against
  the embedded updater pubkey (Node Blake2b-512 + Ed25519, no external `minisign`).
  `--require-signed` requires signatures for the D-019 published suffix set in
  `bin/lib/release-artifacts.sh`; Windows DiskSpanning `.bin` slices are still
  SHA-256 checked but intentionally excluded because they are normalized into a
  published `.zip`, which remains signature-required. `latest.json`'s per-platform
  `url` + `signature` reference the *exact* artifact whose sha256 was verified.

A targeted single-dir check with explicit args:
`bash bin/verify-provenance.sh <artifact-dir> --health-sha <sha> [--require-signed]`.

**Green here is the ship gate.** Any FAIL → do not hand it over.

---

## 3. VM operator health: `bin/vm-preflight.sh` (P-011)

Before (and after) exercising an install on a VM, confirm the packaged operator
is genuinely alive — without misreading a healthy operator as dead (WI-3270):

```
bash bin/vm-preflight.sh --json
```

The WI-3270 triad: host VM process (`pgrep`) + app process in the VM (`tasklist`)
+ operator `/api/health` **probed from INSIDE the WSL distro** (the authoritative
signal). An inner-healthy / outer-failing split is reported as non-fatal
**`forward-degraded`** (repair the Windows→WSL forward, never kill the operator).
Direct: `bash bin/vm-preflight.sh --json`.

If the SSH leg cannot complete, the preflight also requests a host-side QEMU HMP
`screendump` through `~/windows-vm/qemu-monitor.sock` and records the PNG path in
the JSON verdict (`guestScreenPng`). This is diagnostic evidence for distinguishing
a bluescreen, boot/login screen, and hung guest; it does not turn the screenshot
into a health pass. Override the socket or artifact directory with
`--monitor-socket PATH` and `--screendump-dir DIR` when the VM uses a different
layout. A QEMU-owned hostfwd LISTEN socket is never treated as guest liveness.

---

## 4. Live update proof: `bin/install-and-relaunch-verify.sh` (P-012)

The EI-9002 / WI-3783 live proof that installing the new cut **actually replaces
the running operator, in place, keeping its address**:

```
bash bin/install-and-relaunch-verify.sh \
  --platform windows \
  --artifact <new-gui-installer> \
  --server-artifact <matching-server-installer> \
  --smoke-receipt-tag <desktop-vVERSION[-CHANNEL]>
```

Sequence: snapshot the running operator (`/api/health` sha+version + sticky port)
→ scp + install the matching GUI **and Server** cut (including every
provenance-listed Windows Inno span) → **relaunch WITHOUT terminating** (the app's
`serve --ensure` must replace the stale operator itself) → assert (a) the sha +
version **flip** old→new [EI-9002: not a silent no-op update] and (b) the operator
**sticky port holds** [WI-3783]. The target sha is the artifact's *own*
`build-provenance.json` sha (D-002 — rollback-safe).

On a PASS, `--smoke-receipt-tag` writes an atomic, content-bound receipt both
beside `build-provenance.json` (durable audit copy) and under `/tmp` beside the
tag's artifact ledger (publish hand-off). The receipt distinguishes artifacts
actually installed from provenance-bound sibling containers, hashes every row,
and names the build sha/version/platform. Both
`publish-platform-incremental.sh` and `upload-release.sh` recompute those hashes
and refuse a missing, copied, GUI-only, or stale receipt before publication.
Windows Server span zips are checked against the exact stub+slices exercised by
the verifier. Linux, macOS, and Windows all require the matching split Server
installer; a GUI-only pass cannot authorize Server bytes.

If platform hardware is genuinely unavailable, the only publication escape is
explicit and logged: set `PAPERCUSP_SKIP_PLATFORM_SMOKE=1` together with a
non-empty `PAPERCUSP_SKIP_PLATFORM_SMOKE_REASON`. The flag without a reason is
itself rejected. This is an exception record, not a smoke PASS.

**Each platform has its own VM endpoint (WI-10004052).** The verifier resolves
its SSH endpoint per platform, in the order `--ssh-*` flags > `VM_SSH_*` env >
platform default: `windows` → `127.0.0.1:2223` with `~/.ssh/papercup-vm-win`;
`mac` → `127.0.0.1:2222` with `~/.ssh/papercup-vm-mac` (`MAC_VM_SSH_HOST`
overrides the host); `linux` → the Linux clean-room VM, read from
`scripts/linux-test-vm/vmctl endpoint ${PAPERCUSP_LINUX_SMOKE_VM:-clean}`
(`tester@127.0.0.1:2224`, `~/.ssh/papercup-vm-linux`). Before this, the Linux
leg dialled the Windows endpoint, so every release reported "no Linux smoke VM"
even though the clean-room VM existed.

**The Linux leg manages its own VM.** When `release_artifacts_run_platform_smoke`
(`bin/lib/release-artifacts.sh`) runs the default verifier for `linux`, it:
takes `$TMPDIR/papercusp-linux-smoke-<vm>.lock`; refuses a VM that is already
running (it belongs to someone else's fresh-install or federation work);
`vmctl reset` → `up` → `wait-ssh`; installs the **previous release** as the
running baseline; starts `papercusp-server.service` and waits for
`/api/health`; runs the verifier against the vmctl endpoint; and **always**
`vmctl down`. The verifier proves an in-place update (the sha must flip), so a
pristine overlay alone has nothing to flip — give it the previous release's
debs:

```
source bin/lib/release-artifacts.sh
PAPERCUSP_LINUX_SMOKE_BASELINE_GUI=<previous GUI .deb> \
PAPERCUSP_LINUX_SMOKE_BASELINE_SERVER=<previous Server .deb> \
  release_artifacts_run_platform_smoke <tag> <version> linux <linux ledger rows>
```

`PAPERCUSP_LINUX_SMOKE_BASELINE_DIR` (a directory holding exactly one GUI and one
Server `.deb`) is the alternative. A baseline with the cut's own version is
refused. Every step is `timeout(1)`-bounded; budgets are
`PAPERCUSP_LINUX_SMOKE_{RESET,UP,SSH,BASELINE,BASELINE_START,VERIFY,DOWN}_TIMEOUT`.
`PAPERCUSP_LINUX_SMOKE_VM` picks another vmctl instance,
`PAPERCUSP_LINUX_SMOKE_RESET=0` boots the existing overlay without a reset or a
baseline install (it must already hold one), and
`PAPERCUSP_LINUX_SMOKE_VM_MANAGED=0` skips the lifecycle for a VM you prepared by
hand.

> ⚠ This **touches the VM** (scp + install + relaunch). Only run it when a build
> VM is genuinely free to be mutated. Validate the argument surface without VM
> contact with `bash bin/install-and-relaunch-verify.sh --help`; the script's
> mock `PC_SSH`/`PC_SCP` harness is the no-VM verification path.
> For a specific artifact / mac|linux / a different VM, call
> `bash bin/install-and-relaunch-verify.sh --platform <p> --artifact <path> [flags]`.
> On every desktop platform the script auto-resolves the exact-version Server
> installer beside the GUI artifact and fails closed unless its provenance
> matches. Windows additionally requires every provenance-listed span; use
> `--server-artifact PATH` only to override the auto-resolved location.
> For a disposable/reset VM whose host key is intentionally rotated, opt in to
> the transport overrides explicitly on both legs:
> `--ssh-option StrictHostKeyChecking=no --ssh-option UserKnownHostsFile=/dev/null
> --scp-option StrictHostKeyChecking=no --scp-option UserKnownHostsFile=/dev/null`.
> Host-key checking remains strict by default.

**In-app backstop (P-013):** every user's first launch after an update runs a
built-in self-check (`run_update_self_check` in `src-tauri/src/main.rs`): if the
running `/api/health` sha ≠ this build's own baked sha, the user gets a persistent
"Update did not fully apply — restart" toast. This turns EI-9002 from an
agent-noticed bug into an invariant the user sees, on every install and every
rollback.

---

## 5. Hand-off

1. Collect, per platform, the installer(s) + their `.sig` + `build-provenance.json`
   + `latest.json` from the cut output under `src-tauri/target/**/bundle/`.
2. Compute/confirm each artifact's **sha256** (verify-provenance already did).
3. Give the **owner** the local paths + sha256. The owner uploads them to the
   right spot. **Never** publish to GitHub (see the top of this runbook).

---

## Verification standard for the tooling itself (D-007)

The release scripts cannot be fully end-to-end'd without the VMs, so the Phase-3
tools are accepted on: `bash -n` + a functional/derivation test + an emitter/artifact
smoke-run against **real bytes** + a render of the exact remote command strings +
a mock ssh/scp responder covering every branch. No claim of "verified" rests on a
live VM run that did not happen.
