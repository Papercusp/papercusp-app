# The .AppImage leaks a clean source — the culprit is tauri's release resource-STAGING dir, not the AppDir
URL: /internal/docs/agent-insights/appimage-appdir-accumulates-stale-sidecar

A perfectly clean sidecar can still leak in the shipped .AppImage while the .deb of the SAME build is clean. tauri stages each `resources` glob into target/release/<name>/ next to the release binary and BUILDS THE APPIMAGE FROM THERE — that staging dir is copied-into-never-deleted, so it accumulates the union of every past cut (dropped code-server/meridian-host, pre-prune docs, old identity-baked SPA). Wiping the AppDir does NOT fix it (tauri just refills the AppDir from the stale staging dir). The deb is immune because dpkg archives fresh from the source. Fix: rm -rf target/release/{sidecar,seed,resources} before the tauri appimage build; a fail-closed --scan-dir gate on the assembled AppDir is the backstop.

> **Correction (2026-07-14):** an earlier revision of this note blamed the *AppDir*
> (`release/bundle/appimage/<product>.AppDir`) and prescribed `rm -rf "$APPIMG_DIR"/*.AppDir`.
> That was **wrong** — proven when a mtime-FRESH AppDir (built *after* that wipe) still leaked
> 339 files. The real accumulation point is one level up: tauri's **resource-staging** dir
> `target/release/<name>/`. This note now describes the correct cause + fix. The AppDir wipe is
> retained as a cheap belt-and-suspenders, but it is not the fix.

## Symptom

The 0.0.9 release cut passed every in-build privacy audit — `build-desktop-sidecar.sh`
pruned the internal-build-infra docs out of `src-tauri/sidecar` and its `--scan-dir`
gate reported the sidecar **CLEAN** — and the resulting **.deb was genuinely clean**.
Yet an independent scan of the assembled **`.AppImage` AppDir FAILED**: 339 files carrying
the mac-VM sudo/login credentials + build-box identity (the builder's home path, hostname,
build-box email) — a long-dropped `code-server` tree (\~447 MB), a `meridian-host` tree,
pre-prune `operator-docs`, a stale `seed/corestore/db/LOG`, and old identity-baked SPA assets. Same
build, same commit, same `sidecar/**/*` resources glob — one bundle clean, the other leaking.

## Why the two bundles differ despite one clean source

The tell: the leaking trees in the AppDir (`code-server`, `meridian-host`, the un-pruned
docs) were **absent from the current `src-tauri/sidecar`** — yet present in an AppDir whose
files had a **fresh (this-cut) mtime**. A fresh AppDir built from a clean source cannot
contain trees the source lacks. So the AppDir was *not* built from `src-tauri/sidecar`
directly. It was built from an intermediate.

Root cause: **tauri stages the bundle `resources` into a persistent per-profile directory
next to the release binary, and the AppImage is assembled FROM that staging dir.** For each
glob in `tauri.conf.json` `bundle.resources` (`sidecar/**`, `seed/**`, `resources/*`), the
build copies the current tree into `target/release/<name>/` (e.g. `~/.cargo-target/release/sidecar`).
That copy is **copy-into-never-delete** — it never removes files absent from the new set — so
each dir accumulates the **union of every past cut**:

* `code-server` / `meridian-host` from cuts *before* they were dropped (owner directive
  2026-07-07) → still there (observed: `code-server` mtime **2026-06-17**, a month stale, in a
  **11 GB** `release/sidecar` — vs a \~1.2 GB clean source);
* pre-prune internal docs from before the doc-prune existed → still there;
* a stale `seed/corestore/db/LOG` in `release/seed`; old identity-baked SPA in `release/resources`;
* all of it **coexisting** with the current cut's freshly-copied files (same dir, mixed mtimes).

The AppImage's AppDir is then populated from these stale staging dirs → it ships the union.

**The deb is immune** because `dpkg-deb` archives a **fresh** tree straight from the clean
`src-tauri/sidecar` each build — there is no persistent staging dir to accumulate into. That
asymmetry is the whole bug: deb reflects the clean source; AppImage silently does not.

## Why wiping the AppDir does NOT fix it

The intuitive fix — `rm -rf "$APPIMG_DIR"/*.AppDir` before `tauri build --bundles appimage` —
**fails**, because after the wipe tauri rebuilds a *fresh* AppDir but **refills it from the
still-stale `target/release/<name>/` staging dir**, not from `src-tauri/sidecar`. Proven
2026-07-13/14: a cut whose AppDir was purged still produced a fresh-mtime AppDir carrying 339
leaking files. You must purge the **upstream** staging dir, not the downstream AppDir.

## Why the in-build audit missed it

`build-desktop-sidecar.sh`'s `--scan-dir` gate scans the freshly-assembled sidecar (a temp
`sidecar.tmp.<pid>` that is then atomically swapped into `src-tauri/sidecar`) — the **source**,
which was correctly pruned and genuinely clean. It never looked at tauri's `target/release/*`
staging dirs or the assembled AppDir. A gate that scans the source instead of the shipped
artifact reports green while the artifact leaks — the same lesson `audit-release-bundle.py`'s
header already states for `source.tar.zst` ("scan the artifact, not the repo").

## Fix

1. **Purge tauri's release resource-staging dirs before the appimage build** — the root-cause
   fix (`build-appimage.sh` step 0b):

   ```bash
   # $CT = cargo target dir (cargo metadata → target_directory)
   rm -rf "$CT/release/sidecar" "$CT/release/seed" "$CT/release/resources"
   ```

   tauri then restages **only** the current (pruned, clean) resources, so the AppDir's sidecar
   equals the clean deb sidecar. (Bonus: reclaims \~15 GB on a disk-pressured builder.) Verify
   tauri actually restages (the AppDir sidecar is non-empty) — the appimage bundle step copies
   resources at bundle time, so it does.

2. **A fail-closed `--scan-dir` gate on the assembled AppDir**, right before `appimagetool`
   packages it — scans *the bytes that ship*, so any future regression reds the build instead
   of shipping silently:

   ```bash
   python3 bin/audit-release-bundle.py --scan-dir "$APPDIR" || exit 1
   ```

   (Also relativize any absolute symlink whose target points inside the AppDir — `grep` never
   follows a symlink target, so `--scan-dir` cannot see a build-box path hidden in a `.DirIcon`
   / `.desktop` symlink; rewrite them relative.)

3. The pre-existing `rm -rf "$APPIMG_DIR"/*.AppDir` is kept as a cheap belt-and-suspenders, but
   it is NOT the fix — see "Why wiping the AppDir does NOT fix it" above.

## Generalize: the accumulator is often UPSTREAM of the artifact you're staring at

The bug is the shape "a persistent output directory that is **copied into** rather than
**rebuilt fresh**" — but the trap is that the *first* such dir you find (the AppDir) may be a
red herring for a *staging* dir feeding it. When a fresh-mtime artifact contains trees its
source lacks, walk UP the copy chain to find the dir that is never wiped. Audit every format:

* **deb** — dpkg archives fresh each build → structurally safe.
* **Windows** (`build-windows-cross.sh`, cross-compiled on Linux — WI-5651 retired the
  VM-based `build-windows-on-vm.sh` that used to own this) — explicitly wipes its
  `bundle/inno` output before packing and packs a freshly-tarred pruned sidecar →
  structurally safe.
* **AppImage** — the offender above; safe only after wiping `target/release/{sidecar,seed,resources}`.
* **macOS `.app`** — check whether `tauri build --bundles app` restages from a persistent
  `target/release/*` too. If a cut's `.app` looks clean only because a disk-reclaim happened to
  delete the staging dir first, that cleanliness is a side-effect, not a guarantee.

Rule of thumb: **prune/scan the assembled artifact that ships, and make sure the assembler —
and every staging dir it copies from — starts from empty.** A clean source tree is necessary
but not sufficient when an intermediate accumulates.
