# Shipping Papercusp Desktop

Local-build release flow — no GitHub Actions required.

## One-time setup

```sh
# 1. Generate the Tauri updater signing keypair (lives in ~/.papercusp/signing/)
bin/setup-signing-key.sh

# 2. (Optional) write the PostHog discovery file for feature-flag + telemetry
bin/setup-posthog.sh
```

After step 1, `src-tauri/tauri.conf.json`'s `pubkey` is updated to embed the new public key. Commit that change so released binaries verify against the right pubkey.

After step 2, restart the operator. The wizard's Step 12 will indicate when telemetry is fully live (requires user opt-in *and* `testingFeatures: true` in the discovery file).

## Cut a release

```sh
# Stable release (cuts tag `desktop-vX.Y.Z`)
bin/release-local.sh 0.0.2 stable

# Beta (cuts `desktop-vX.Y.Z-beta` + marks GH release as prerelease)
bin/release-local.sh 0.0.3 beta

# Alpha (cuts `desktop-vX.Y.Z-alpha`, dirty tree allowed for fast iteration)
bin/release-local.sh 0.0.4 alpha
```

The script:

1. Bumps `version` in `package.json`, `Cargo.toml`, `tauri.conf.json`
2. Builds the Node sidecar (`papercup/apps/operator` → `src-tauri/sidecar/`)
3. Runs `tauri build` with the Linux x86_64 target, signing each artifact
4. Generates `latest.json` for the auto-updater
5. Commits + tags + pushes via `git push origin HEAD <tag>`
6. Creates the GitHub Release via `gh release create` (no Actions involved)

The auto-updater route (`/api/updates/manifest` in the operator) reads from these releases by tag pattern.

## Build targets

| Target | Default | How to enable |
|---|---|---|
| Linux x86_64 | ✓ always | — |
| Linux arm64 | optional | `WITH_ARM64=1 bin/release-local.sh …` (needs `cross` set up) |
| Windows x86_64 | optional | `WITH_WINDOWS=1 bin/release-local.sh …` (builds natively on the local Windows VM) |
| macOS universal | optional | `WITH_MAC=1 bin/release-local.sh …` (builds natively on the local Mac VM) |

### Linux (single self-hosting bundle — NOT the Win/Mac two-bundle split)

On Linux the app ships as **ONE self-contained bundle** (`Papercusp GUI` .deb + .AppImage),
not the GUI-attaches-to-Server two-bundle split used on Windows/macOS. Rationale + the
verified fresh-install behavior: WI-2902 (2026-07-05).

- **Self-host.** The GUI, finding no separate "Papercusp Server" running, spawns + owns the
  operator sidecar itself (`main.rs` `spawn_self_hosted_sidecar`, Linux-gated) — so a single
  `apt install ./Papercusp\ GUI_*.deb` gives a fully working operator + embedded Postgres. (The
  two-bundle split has no clean Linux packaging analog: two debs collide on
  `/usr/bin/papercusp-desktop`, and `gtk-launch com.papercusp.server.desktop` can't resolve the
  productName-named desktop entry.)
- **`psu`/`ptool`/`papercusp` on PATH** come from `deb/postinstall.sh`, which resolves the
  installed sidecar dir by glob (`/usr/lib/Papercusp*/sidecar` — the productName has a space).
- **AppImage is built by `bin/build-appimage.sh`, NOT tauri's `appimage` target** (WI-2918).
  tauri's target runs linuxdeploy across the whole AppDir, which crashes ELF-scanning the large
  self-contained sidecar tree (`Failed to run ldd`). `build-appimage.sh` lets tauri create the
  complete AppDir (gtk/webkit libs deployed), then packages it with `appimagetool` directly.
  `release-local.sh` calls it after building `--bundles deb,rpm`.
- ⚠ **AppImage needs FUSE.** Ubuntu 24.04+ ships no `libfuse2` by default — end users must
  `sudo apt install libfuse2t64` (or run `./Papercusp*.AppImage --appimage-extract-and-run`).
  Say so in the Linux release notes. The `.deb` has no such requirement.

### Artifact discovery on the build host

`src-tauri/target` may be a symlink to the relocated Cargo target tree. A bare
`find "$ROOT/src-tauri/target" ...` does not descend a symlink supplied as its
starting path; it can return **zero rows with exit 0** even when the target contains
release artifacts. Never report an artifact as absent from that result alone.

After sourcing the shared release helper, resolve the root and follow links explicitly:

```bash
cd papercusp-desktop
source bin/lib/release-artifacts.sh
TARGET_ROOT="$(release_artifacts_resolve_root "$PWD/src-tauri/target")"
find -L "$TARGET_ROOT" -type f \( -name '*.AppImage' -o -name '*.deb' -o -name '*.dmg' \) -print
```

For a completed cut, prefer `release_artifacts_read <tag>`; it reads the builder's
single-source manifest and fails hard when the manifest is missing or resolves to no
existing files. If a manual scan returns zero, verify both the resolved root and the
expected artifact version before recording a negative finding.

### macOS (universal .dmg + updater .app.tar.gz, built on the Mac VM)

`WITH_MAC=1` drives a native build on the local QEMU macOS Sonoma VM
(SSH :2222) via `bin/mac-vm-build.sh`: SwiftTerm term-shim (universal
dylib) → sidecar (darwin binaries) → `tauri build --target
universal-apple-darwin`. The GUI binary is universal; the sidecar is
x86_64 and runs under Rosetta 2 on Apple silicon (one-time
`softwareupdate --install-rosetta` — say so in release notes). Plan +
decisions: `mac-desktop-release-readiness-2026-06-11` (esp. D-006).

VM prereqs (one-time, already on the VM): Xcode CLT, nvm Node 22,
`brew install libpq pgvector` (pg client tools + the vector extension —
the build FAILS without pgvector since a fresh DB cannot boot without
it). VM ops: `systemctl --user start papercup-vm-mac.service`;
recovery runbook: the `mac-vm-qmp-recovery` agent insight.

The bundle is NOT Apple-signed/notarized (alpha decision D-002): first
launch needs right-click → Open, or
`xattr -dr com.apple.quarantine /Applications/Papercusp.app`. Updater
payloads are still minisign-signed.

### Windows (Inno Setup, cross-compiled on Linux — no VM)

> **WI-5651 (2026-07-20) retired the QEMU Windows 11 VM leg** (`bin/build-windows-on-vm.sh`
> — fragile, slow, lease-contended; its VM heartbeat deaths caused 3 of WI-5600's failed
> builds). `WITH_WINDOWS=1` now drives `bin/build-windows-cross.sh`: a real cross-compile on
> THIS Linux box — `cargo-xwin` builds the MSVC target, Inno Setup 6.7.3 under `wine`
> (headless via `xvfb`) packs the installer — no VM, no SSH, no `x86_64-pc-windows-gnu` cross
> (that lane never worked; MSVC is Tauri's supported Windows story, same toolchain the VM
> used, minus the VM). Proven end-to-end 2026-07-20 (all four gates: cross-compile, Inno
> packing, Server-role disk-spanning, Authenticode signing). Plan + decisions:
> `windows-desktop-release-readiness-2026-06-11` (superseded by the WI-5651 cross-compile
> migration for the build mechanism; the feature-parity/uninstall findings below still hold).

Per-release prereqs (the script checks all of these and fails early):

1. **Cross toolchain installed** (one-time) — `rustup target add x86_64-pc-windows-msvc`,
   `cargo install cargo-xwin`, Inno Setup 6.7.3 + `wine` + `xvfb` on the host. The script
   fails early naming whatever's missing.
2. **Sidecar built** — `bin/build-desktop-sidecar.sh` (release-local.sh
   does this anyway).
3. **WSL rootfs tarball** — `scripts/build-rootfs.sh` (docker; ~250 MB
   output at `src-tauri/resources/papercup-runtime.tar.gz`, gitignored).
   The Windows app imports this as the `papercup-runtime` WSL2 distro on
   first run — an installer built without it cannot onboard.

The artifact is the Inno Setup `*-setup.exe` (+ `*-setup-N.bin` span slices for
the Server role, + minisign `.sig`) — NSIS is retired along with the VM; MSI is
still not built by default. Artifacts land in
`src-tauri/target/windows-vm/bundle/inno/` on the host (the `windows-vm` path
segment is kept only for `release-local.sh`'s collector compatibility — nothing
under it is VM-produced anymore). Authenticode signing (`osslsigncode`) is
cert-conditional: unset `WINDOWS_CERT_BASE64` ⇒ unsigned build (byte-identical
to current prod), same as before — SmartScreen will warn on install until the
owner supplies a code-signing cert (see the `windows-authenticode-signing-runbook`
agent insight).

#### Fast LOCAL Windows-cfg compile gate

The desktop's ~68 `#[cfg(windows)]` / `#[cfg(target_os = "windows")]` regions
(main.rs, wsl_setup.rs, native_console.rs, pty.rs, …) are invisible to a plain
`cargo check` on the Linux dev box — so a type/import/borrow error in a
Windows-only block used to surface only 15-25 min into the old VM build.
`bin/check-windows-cfg.sh` compiles that exact surface locally in
~40 s (~4 s warm) via `cargo xwin check --target x86_64-pc-windows-msvc`
(cargo-xwin shims the MSVC toolchain so the `ring`/C build scripts that block a
naive cross-`cargo check` resolve). One-time setup (the script prints the exact
command if any piece is missing): `rustup target add x86_64-pc-windows-msvc`,
`sudo apt-get install -y --no-install-recommends clang lld llvm`,
`cargo install cargo-xwin`. It is no longer wired as an automatic pre-flight
into either Windows producer (confirmed: neither `build-windows-cross.sh` nor
`release-local.sh` invokes it) — run it manually before a Windows cut to catch
a Windows-only compile error in ~40s instead of discovering it deep into the
real build. It is deliberately NOT in the green-checkpoint suite
(it needs the SDK). It is a compile check, not a build — the runnable `.exe` is
still `build-windows-cross.sh`'s job.

> **⚠ VM-era content below (per-release gate, feature-parity verification, and
> uninstall/reinstall semantics).** These were verified against the QEMU Windows
> VM that WI-5651 retired. The findings about the SHIPPED APP's behavior
> (two-bundle split, autostart, quit semantics, uninstall/reinstall handling)
> still describe the real app and haven't changed — only the *mechanism* that
> produced the artifact under test has (VM build → `build-windows-cross.sh`
> cross-build). The exact VM-specific verification STEPS below (qcow2 snapshot
> resets, `~/windows-vm/...` paths) are preserved for historical reference; no
> equivalent hands-off install-smoke procedure against the cross-built artifact
> has been documented yet as of this sweep (EI-18189710880191611) — someone
> doing a Windows release should re-verify by hand until one exists.

#### Windows per-release gate: install smoke + snapshot convention

Every Windows artifact gets one clean hands-off pass in the VM before it
ships (the P-012 shape): **wipe → install the candidate → ONE launch, zero
touches → WSL import + first-boot bootstrap + finalize restart + fresh
initdb/migrations → then `bin/vm-smoke-windows.sh` from the host = 9/9
green**. The smoke probes ssh → distro → app process → serve discovery →
`/api/health` → backups+kopia (the WSLENV-PATH regression guard) →
agent-tools loopback → zero PG ERROR lines → psu superuser shim + bundled
launcher present.

Resetting the VM between runs — two tiers:

- **In-guest wipe (default; fast, keeps the toolchain warm).** Close the
  app, then from ssh: `wsl --unregister papercup-runtime`, run the NSIS
  uninstaller (`"%LOCALAPPDATA%\Papercusp\uninstall.exe" /S`, or
  install-over for the reinstall test), delete leftovers
  (`%LOCALAPPDATA%\Papercusp`, `%USERPROFILE%\.papercusp`). Note
  `wsl --unregister` deletes the embedded-PG database with the distro
  (D-007) — that's the point of the wipe.
- **qcow2 snapshot restore (when the guest OS itself is suspect).**
  Internal snapshots on `~/windows-vm/windows_hdd.qcow2`, managed
  **offline only** — shut the VM down first; `qemu-img snapshot` on a
  live image corrupts it (and `savevm` via the monitor would write 32 GB
  of RAM state). `qemu-img snapshot -l|-c <name>|-a <name>
  windows_hdd.qcow2`. Convention: `pre-release-baseline` = provisioned
  toolchain (MSVC/rustc/Node/NSIS), no app installed — refresh it
  deliberately after toolchain upgrades, never casually; transient
  iteration snapshots are `pre-<tag>-<purpose>` and get deleted
  (`-d`) once the lane closes.

Agent-side recipe + sharp edges (schtasks launch, CDP into the webview,
inbox-WSL gotchas): `/internal/docs/agent-insights/windows-vm-desktop-testing-workflow`.

#### Windows feature-parity status (verified 2026-07-04, signed 0.0.2)

Plan `windows-desktop-feature-parity-2026-07-02` — VM-live-verified on the
running signed 0.0.2 build (28/31 items done):

- **Two-bundle GUI/Server split** — distinct bundle identities
  (`com.papercusp.gui` / `com.papercusp.server`), distinct installed exes.
  GUI auto-launches the Server when none is running and attaches; the Server
  runs **headless** (tray only, no user window) and owns the WSL sidecar.
- **Single-instance** (`tauri-plugin-single-instance`, release-only) —
  per-bundle-identity lock: two GUIs (or two Servers) collide, a GUI + a
  Server coexist. Behavioral PASS_ALL on the VM.
- **Autostart** — Server registers an HKCU `Run` key (`Papercusp Server`),
  survives login.
- **Quit semantics** — closing the GUI window leaves the Server + sidecar
  **alive** (psu + agents keep working); tray "Quit Papercusp Server" →
  `app.exit(0)` → `kill_sidecar` SIGTERMs the WSL `serve` pid for a clean PG
  shutdown (`main.rs` `run()`/`kill_sidecar`).
- **Terminal launch / message injection / liveness / focus** — the operator
  + psu run **inside WSL2** (`process.platform === 'linux'` even on Windows),
  so most of these paths are the same POSIX code as Linux. Window enum/focus
  is the exception: it MUST run as native Session-1 Tauri commands
  (`native_console.rs`) — a Session-0 WSL-spawned powershell sees zero
  interactive windows.

Residuals (attended release-acceptance / minor, not code blockers): the
`Focus this session` button-click→foreground E2E and a live-credentialed-agent
functional click-through (both fold into the final attended gate); the
`wt.exe`-absent fallback (minor edge); and native named-pipe `endpoint-ipc`
(deferred to WI-1646 — the HTTP fallback carries all traffic today).

#### Windows uninstall/reinstall semantics (P-015 findings, verified 2026-06-12)

- **Uninstall** (`uninstall.exe /S`, per-user, no elevation, works headless):
  removes the app dir + registry uninstall key. It deliberately does **NOT**
  touch the WSL distro or any in-distro state — the embedded-PG database
  survives an uninstall. `wsl --unregister papercup-runtime` is the actual
  data-deletion step (D-007) and is left to the user.
- **Sharp edge:** if the WSL backend is still running (e.g. after an app
  crash — a hard kill orphans it), the distro holds the sidecar files open
  through `/mnt/c`, so their deletions go NTFS delete-pending and the tree
  only empties when the distro releases the handles (`wsl --terminate` or
  backend exit). The silent uninstaller reports nothing either way. A normal
  graceful app close (which SIGTERMs the backend) avoids this entirely.
- **Reinstall over existing** (same or newer version, `/S` over a live
  install dir): exit 0, and the next launch **reuses** the registered distro
  + database — no re-import, no initdb; boot is discovery-only (~25 s vs
  ~95 s for a true first run). Verified with a marker file + intact wizard
  state across the cycle.

## Verify a build

After `bin/release-local.sh` succeeds:

```sh
# Inspect what landed
gh release view desktop-v0.0.2-alpha --repo Papercusp/papercusp-desktop

# Test the auto-updater manifest end-to-end against your local operator
curl 'http://127.0.0.1:3055/api/updates/manifest?target=linux-x86_64&arch=x86_64&current_version=0.0.1'
```

The manifest endpoint resolves the channel (per the wizard's `update_channel`) and serves the right release.

## Disaster recovery

- **Signing key lost** → run `bin/setup-signing-key.sh` again. All previously-signed releases will fail signature verification on existing installs. Push a new release with the new pubkey baked in. Users on the old install can't auto-update; they need to reinstall.
- **Bad release published** → `gh release delete <tag>` + delete the tag (`git push origin :refs/tags/<tag>`). Cut a new patch version.
- **Manifest wrong on prod** → The manifest is generated at request time by the operator from the GH Release contents. There's no separate manifest file to fix; redeploy the operator if the route logic itself has a bug.

## What's NOT local

A few things still need real-world action:

- **macOS builds** — see above.
- **Production user devices** — these only get builds via `gh release upload` (which `release-local.sh` does for you).
- **PostHog deployment** — `~/.papercusp/posthog.json` is per-machine. End users don't need one; admins / devs do if they want feature flags or telemetry capture.
