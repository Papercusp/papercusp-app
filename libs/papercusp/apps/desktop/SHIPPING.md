# Shipping Papercusp Desktop

Cheat sheet for cutting + verifying a release.

## Cut a test build

```sh
git checkout feat/desktop-app
git tag desktop-v0.0.1-test<N>
git push origin desktop-v0.0.1-test<N>
```

This triggers `.github/workflows/desktop-release.yml` to matrix-build for macOS, Windows, and Linux in parallel. ~15-30 min later artifacts land on a draft GitHub Release at <https://github.com/Papercusp/papercup/releases>.

## Watch progress

```sh
gh run list -L 5                                # find the run id
gh run view <run-id>                            # high-level status
gh run view <run-id> --log-failed | head -2000  # diagnose failures
```

## Verify a build before promoting test → real release

Download the platform's installer from the draft Release, then:

### macOS — `.dmg`

1. Double-click the `.dmg`, drag Papercusp into `/Applications`.
2. **Right-click** Papercusp.app → **Open** (the first launch only — bypasses Gatekeeper for the unsigned build).
3. The app's bootstrap window should appear within ~2s.
4. The preflight checks should run; if Postgres / claude / bash isn't installed locally, the check list shows what's missing.
5. Once all checks pass, the window navigates to `/harness`.

If preflight stays stuck on "starting harness sidecar…", the Node sidecar failed to spawn. Open Console.app, filter on "papercusp" — the Rust shell logs everything to stdout/stderr.

### Windows — `.msi` or `.exe`

1. Run the installer; click **More info → Run anyway** when SmartScreen warns about the unsigned binary.
2. Launch from Start Menu.
3. Same flow as macOS — bootstrap → preflight → `/harness`.

If the sidecar fails to spawn, open Event Viewer → Windows Logs → Application and look for events with source "Papercusp".

### Linux — `.AppImage` (recommended)

```sh
chmod +x Papercusp_*.AppImage
./Papercusp_*.AppImage
```

For `.deb`: `sudo dpkg -i Papercusp_*.deb && papercusp`. For `.rpm`: `sudo rpm -i Papercusp_*.rpm`.

Logs go to stdout — run from terminal to see them.

## Promote test → release

When a `desktop-v0.0.1-test<N>` build looks good:

1. Edit the draft GitHub Release on github.com (no longer draft, version number stripped of `-test<N>`).
2. Update the release notes with what's new.
3. Click **Publish release**.

For now, all releases are unsigned. Code signing roadmap:

- **macOS:** Apple Developer ID (~$99/year) + notarization. Sets `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` + `APPLE_SIGNING_IDENTITY` + `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` GitHub secrets, `tauri-action` picks them up.
- **Windows:** OV/EV code-signing cert from a CA (~$200-500/year). Sets `WINDOWS_CERTIFICATE` + `WINDOWS_CERTIFICATE_PASSWORD` GitHub secrets.
- **Linux:** AppImage + deb don't need signing for typical install. Flathub publication is its own flow.

Once codesigned, also enable `bundle.createUpdaterArtifacts: true` in tauri.conf.json + add `tauri-plugin-updater` Rust dep + `[plugins.updater]` section. The bundler then produces signed `.tar.gz`/`.zip` artifacts the in-app updater consumes.

## Troubleshooting common CI failures

See `project_desktop_app_build.md` in auto-memory — it has the 8 pitfalls catalogued from initial bring-up. Most failures fall into one of those buckets.
