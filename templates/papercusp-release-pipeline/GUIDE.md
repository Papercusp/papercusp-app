# papercusp-release-pipeline — composition GUIDE

**Papercusp Official: Release Pipeline.** An **aspect** template: the desktop
release plane, as deepened guidance around ONE component —
`@papercusp/tauri-release-kit`. The kit owns the release *dance*; the app
injects its *sidecar build* and a config. That split is the whole design:

- **Generic (the kit):** version bump across the app's `versionFiles`,
  channel→tag resolution, the `tauri build` target matrix, artifact
  classification (dmg/deb/AppImage/msi/nsis + updater sigs), `latest.json`
  updater-manifest generation, `gh release` upload, and Mac/Windows VM
  orchestration over an SSH frame. Pure core; every side effect behind
  Exec/Fs/Log ports.
- **Injected per app (the seam):** `buildSidecar(ctx)` — however THIS app
  bundles its sidecar (worked instances range from ~42 lines of esbuild to
  a ~1,070-line bundler) — plus app id/name/repo/targets/signing via
  `TauriReleaseConfig`.

The `papercusp-tauri-desktop-shell` template already pins this kit at the same version —
composing both is pin-consistent by construction. Compose THIS aspect when the
app is going to ship for real and the release leg deserves first-class
decisions, not defaults.

## MUST — consult the live papercusp docs when this GUIDE is not enough

You are building ON a live papercusp install (we dogfood papercusp in
papercusp). If anything in this GUIDE is insufficient — a component's API, a
seam convention, a release step — do NOT guess:

- read the papercusp documentation served on your install at **`/internal/docs`**
  (start with the `agent-insights` section; this template's `template.yaml`
  `docs:` list names its canonical pages — including the kit's design doc at
  `build-system/tauri-release-kit-proposal`), and
- inspect the **operator app** itself — it is a running reference instance of
  every pattern these templates encode (its `bin/release.config.ts` is a live
  `TauriReleaseConfig`).

## MUST

- **Signing material never enters the repo.** `signing.keyPath` points at a
  key under the app home (keychain / 0600 keyfile); the password arrives via
  `signing.passwordEnv`. A committed key or password is a release-stopping
  incident, not a convenience.
- **The kit bumps versions — never by hand.** List every file that carries the
  version (`package.json`, `src-tauri/tauri.conf.json`, `Cargo.toml`) in
  `versionFiles`; a hand-bumped subset is how updaters serve stale builds.
- **Updater manifests are generated, not hand-rolled.** `latest.json` comes
  from the kit (`buildLatestManifest`) and `latestJsonUrl` points at the
  released asset — every channel gets its own feed.
- **Keep `buildSidecar()` the ONLY app-specific code path.** If you are
  patching the kit's dance for one app, you are forking the pipeline — extend
  the kit's config/driver seam instead (reuse-first).

## SHOULD

- Ship the pipeline from day one (the papercusp-app GUIDE says the same from the
  other side): a desktop app without signing/updater wiring is a prototype.
- Drive Linux targets locally and Mac/Windows through the kit's SSH-frame VM
  drivers; keep VM credentials in the config, out of the scripts.

## FREE

- Channel set and cadence, tag scheme, which targets are release-blocking,
  where releases are announced — all domain judgment.

## Decision points

| id | The question |
|---|---|
| `release-channels` | Which channels, what tag scheme, one updater feed per channel. |
| `release-targets` | The target matrix + local-vs-VM split + which targets block a release. |
| `signing-and-updater` | Key location + password env; `latestJsonUrl` per channel. |
| `sidecar-build` | What `buildSidecar(ctx)` does for THIS app — the one injected seam. |

## Checks

`checks/components-integrated.test.ts` — the composed app actually depends on
`@papercusp/tauri-release-kit` (config section: `components`). Config-driven,
verbatim-copied into composed apps; see `checks/README.md`.
