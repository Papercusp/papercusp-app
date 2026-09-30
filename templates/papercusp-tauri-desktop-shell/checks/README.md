# checks/ — the acceptance suite (landed: plan app-templates-2026-07-04 P-007)

## `boot-e2e` (`boot-e2e.test.ts`) — native inputs exist and the composed app actually boots

The optional `nativeDesktop` config section runs a fast static preflight first:
the Rust manifest + committed lockfile + Tauri config + every explicitly
configured bundle icon must exist and be non-empty. This catches the otherwise
late `tauri::generate_context!` missing-icon panic before Cargo compilation.

The `boot` section pins the runtime chassis MUSTs end-to-end: sidecar spawns → discovery file
(`operator.json` analog) written → health returns 200 → SIGTERM → clean exit
within the grace window (the WI-2667 force-exit lesson) → discovery file
removed.

Portable + app-parameterized: self-contained (devDep: `vitest`; Node ≥18
fetch), driven by the **`TEMPLATE_CHECKS_CONFIG`** JSON (schema:
`@papercusp/template-kit` `TemplateChecksConfig`, section `boot`). Without
the env var it SKIPS.

**Two modes** — because the discovery file is a per-user singleton:

- **`spawn`** — boots a fresh sidecar (`command`, optional `buildCommand`)
  and asserts the FULL lifecycle including shutdown cleanup. Use in CI, the
  template gym, a fresh checkout. Never on a machine where the app is live —
  a second instance clobbers the live discovery file.

  `command` must invoke the REAL process — `node dist/…` or the direct
  binary `node_modules/.bin/tsx src/…` — **never `npx tsx …`**: the `npx`
  wrapper does not forward SIGTERM to the child, so the check's
  graceful-shutdown assertion fails even when the app's shutdown code is
  correct, and the orphaned sidecar (and its embedded PG) blocks the next
  run (WI-2867).
- **`attach`** — asserts against an ALREADY-RUNNING instance: discovery file
  readable, pid alive, health 200. Use on a dev machine with the app live.

```sh
TEMPLATE_CHECKS_CONFIG=/path/to/checks-config.json npx vitest run checks/
```

Worked example config:
`../../papercusp-app/reference/worked-example.checks-config.json`.
