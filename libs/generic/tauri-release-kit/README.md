# @papercusp/tauri-release-kit

Provider-agnostic **Tauri desktop build + release** orchestration, shared by
papercusp and oddsmith. The kit owns the release *dance*; each app injects its
*sidecar build* and supplies a config. Mirrors `@papercusp/deployment-driver`'s
shape: a pure core + a `configure*()`/driver seam + everything-injected ports.

Design + rationale: `/internal/docs/build-system/tauri-release-kit-proposal`.
Plan: `tauri-release-kit-shared-build-2026-06-25`.

## The split that makes this work

- **Generic (this lib):** version bump, channel→tag resolution, `tauri build`
  target matrix, artifact classification, `latest.json` updater-manifest
  generation, `gh release` upload, Mac/Windows VM (SSH frame) orchestration.
- **Injected per app (the seam):** `buildSidecar(ctx)` — papercusp's ~1,070-line
  bundler vs oddsmith's ~42-line esbuild — plus app id/name/repo/targets/signing
  key/VM creds via `TauriReleaseConfig`.

```ts
import { defaultTagFor, buildLatestManifest, type TauriReleaseConfig } from '@papercusp/tauri-release-kit';

const config: TauriReleaseConfig = {
  appName: 'Papercusp',
  appId: 'com.papercusp.desktop',
  root: '/abs/path/to/papercusp-desktop',
  repo: { owner: 'Papercusp', name: 'papercusp-desktop' },
  version: '0.0.2',
  channel: 'stable',
  versionFiles: [
    { path: 'package.json', kind: 'json' },
    { path: 'src-tauri/tauri.conf.json', kind: 'json' },
    { path: 'src-tauri/Cargo.toml', kind: 'cargo-toml' },
  ],
  targets: ['linux-x86_64'],
  signing: { keyPath: '~/.papercusp/signing/papercusp.key', passwordEnv: 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD' },
  buildSidecar: async ({ root, ports }) => { await ports.exec.run('bash', [`${root}/bin/build-desktop-sidecar.sh`]); },
  latestJsonUrl: ({ tag, name }) => `https://github.com/Papercusp/papercusp-desktop/releases/download/${tag}/${name}`,
};
```

## Status

Pure core + side-effecting layers both landed and tested: version bump,
tag/channel, artifact classification, `latest.json` generation, the node
Exec/Fs ports, the per-target build drivers (Linux-local + Mac/Windows SSH
frame), the `gh` release driver, and the `runRelease()` orchestrator. A
standalone-CLI `bin/release` entry point is not wired yet — hosts call
`runRelease()` / `runIncrementalPublish()` directly. Until full parity is
proven against `bin/release-local.sh`, papercusp's existing release scripts
remain that app's source of truth.

### Incremental single-platform publish

`runIncrementalPublish()` (EI-18683062996592825, revising
EI-18111560213741904) ADDS one freshly-built platform's artifacts onto an
already-published manifest without touching (re-uploading, re-signing, or
re-dating) any other platform's entry — the durable fix for what used to be
hand-work every time a platform became ready later than the others (mirrors
`papercusp-desktop/bin/publish-platform-incremental.sh`, generified):

```ts
import { runIncrementalPublish, fetchHttpGetPort } from '@papercusp/tauri-release-kit';

const res = await runIncrementalPublish(config, 'macos-universal', ports, {
  liveManifestUrl: 'https://dl.example.com/<secret>/latest.json',
  http: fetchHttpGetPort, // or a fake HttpGetPort in tests
});
// res.manifest.platforms now has darwin-universal ADDED; every other
// already-live platform key (e.g. linux-x86_64) is carried through untouched.
```

The CLI-facing shape this is meant to sit behind —
`release-kit publish --platform <linux|darwin|windows> --incremental <version> <channel>`
— has its argv parsing in `cli.ts` (`parsePublishArgs`); a host wires that to
`runIncrementalPublish` plus its own upload step (R2 for papercusp, `gh
release upload --clobber` for oddsmith — upload/publish mechanics stay
host-specific, same split as the build-target driver registry).

## Modules

| Module | What | Side effects |
|---|---|---|
| `types.ts` | `TauriReleaseConfig`, ports, drivers, manifest | none |
| `tag.ts` | version/channel validation, `desktop-vX.Y.Z[-ch]` tags | none |
| `version.ts` | JSON + Cargo.toml version-bump transforms | none |
| `artifacts.ts` | bundle-path → `PlatformKey` classifier, sig path | none |
| `latest-json.ts` | `latest.json` updater manifest builder + `mergeLatestManifest` | none |
| `release.ts` | `runRelease()` orchestrator + `buildAndSignTargets()` | exec/fs/git/gh |
| `incremental-publish.ts` | `runIncrementalPublish()` — single-platform add-on-top publish | exec/fs + one HTTP GET |
| `cli.ts` | `parsePublishArgs()` — the `publish --platform … --incremental …` argv shape | none |
| `http.ts` | `fetchHttpGetPort` — real `HttpGetPort` backed by global `fetch` | network |

Zero runtime deps — borrowable standalone (`http.ts` uses the platform global
`fetch`, not a package).
