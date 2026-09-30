# papercusp-tauri-desktop-shell — composition GUIDE

**You are the building agent.** This aspect composes the **deterministic
chassis** of a desktop app: thin Tauri shell → Node/Hono sidecar → embedded
Postgres, plus the release pipeline. Everything here is **Tier A** — starting
points you may modify freely; the MUSTs below are about the *shape* that keeps
the chassis portable and bootable, not about sealed code. "Done" = this
template's `checks/` green (plus every composed template's — union rule).

Worked example: see `reference/README.md` + the worked checks-config it
names.

## MUST — consult the live papercusp docs when this GUIDE is not enough

You are building ON a live papercusp install (we dogfood papercusp in
papercusp). If anything in this GUIDE is insufficient — a component's API, a
seam convention, a release step — do NOT guess:

- read the papercusp documentation served on your install at **`/internal/docs`**
  (start with the `agent-insights` section; this template's `template.yaml`
  `docs:` list names its canonical pages), and
- inspect the **operator app** itself — it is a running reference instance of
  every pattern these templates encode.

## The construction (orientation)

The Rust shell is a **HOST, not the app**: it picks a free port, spawns the
Node sidecar, waits for readiness, opens a WebviewWindow, and SIGTERMs the
sidecar on close. Everything app-shaped lives in the SPA + sidecar. The
sidecar is a Hono app serving the SPA + `/api` routes, booting embedded
Postgres, and writing a discovery file so the shell/CLI can find it.

## MUST (shape invariants — the checks enforce these)

1. **Thin shell**: no domain logic in Rust. Packaged sidecar resolution =
   `resource_dir()/dist-sidecar` + vendored `bin/node` + `bundled_path_env`;
   dev = repo `dist-sidecar`. (Extraction into a reusable skeleton is P-003 —
   until then, copy the reference `main.rs` shape.)
2. **Native bundle inputs**: commit `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`,
   and every icon named by an explicit `bundle.icon` list. A missing default
   `icons/icon.png` otherwise fails late inside `tauri::generate_context!`.
   Wire these paths into the checks config's `nativeDesktop` section so the
   portable preflight catches missing/empty assets before Cargo compilation.
3. **Discovery file** (`operator.json` analog): port + pid written at boot to
   the app home, removed on shutdown — the shell polls it; the CLI reads it.
4. **Graceful shutdown ordering** on SIGTERM: host close → sync stop → PG stop
   → discovery-file removal — and a force-exit timer so a wedged component
   can't hang the process (the SIGTERM-wedge lesson, WI-2667).
   The FINAL step must be **synchronous** (`unlinkSync`, not `await rm`) —
   when the sidecar runs under a dev runtime like `tsx`, the runtime's own
   signal cleanup races your handler and can kill the process (raw exit 143)
   inside a trailing `await`, leaving the discovery file behind (the
   greenfield-snippets lesson, WI-2866).
5. **Embedded PG lifecycle**: boot/stop bound to the sidecar; migrations on
   boot; connection resolution via `@papercusp/embedded-pg-discovery`
   (env → discovery JSON → fallback). Use **portable initdb flags**
   (`--locale=C.UTF-8 --encoding=UTF8`) — host-locale initdb breaks on
   non-English machines (the WI-2649 lesson).
6. **Env-gated optional planes**: booting with no config changes nothing — an
   unset operator URL must mean "hive plane off", never a crash.

## SHOULD

- `@papercusp/tauri-release-kit` for build/release orchestration (channels,
  updater manifest, artifact classification) driven from a `bin/release.ts`.
- SSE streams for table-less moments; plain `/api` JSON otherwise.
- Ship features flag-ON; keep the sidecar buildable standalone (esbuild) so
  the packaged app carries a self-contained `dist-sidecar`.

## Decision points

| id | The question |
|---|---|
| `ui-shape` | What SPA surface does the deterministic plane need (grids, approval views, streams)? FREE — compose as judged best. |
| `app-identity` | App name, bundle identifier, app-home dir, release channels (feeds `tauri.conf` + release-kit config). |

## FREE

SPA framework, component library, route layout, table design, migration
tooling, dev ergonomics — the whole app plane. Two real apps chose
differently in places; the checks don't care.

## Composition walk (suggested order)

1. Answer `app-identity`; scaffold `src-tauri` from the reference `main.rs`
   shape + `tauri.conf`, copy the standard Tauri icon set as the initial asset,
   list it explicitly under `bundle.icon`, and commit the generated `Cargo.lock`.
2. Sidecar: Hono host + embedded PG + discovery file + graceful shutdown
   (MUSTs 2–5).
3. SPA per `ui-shape`; wire `/api`.
4. Release pipeline via tauri-release-kit.
5. Run `checks/boot-e2e.test.ts` (+ composed templates' checks) until green.
