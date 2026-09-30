# papercusp-data-layer — composition GUIDE

**Papercusp Official: Embedded Data Layer.** This aspect template gives a
composed app an OWNED data plane: an embedded Postgres that boots with the
app (no external database, no install-time infrastructure), generic
connection discovery, and the typed-contract write discipline. Two of the
three components are patterns you instantiate; the discovery lib is a plain
Tier A package.

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

Three legs:

1. **Embedded server** — the `embedded-postgres-server` pattern: the app
   boots its own Postgres under the app home (per-app data dir), runs
   migrations forward-only on boot, picks a free port PER BOOT, and writes a
   JSON discovery file so every other process can find it. (This file
   carries the PG CONNECTION info — it is DISTINCT from a host chassis's
   own `{port, pid}` discovery file; a composition carrying both writes TWO
   files, WI-2879.)
2. **Connection resolution** — `@papercusp/embedded-pg-discovery`
   (`resolvePgUrl`): env vars (in order; empty string = absent) → discovery
   file's `url` → fallback. Pure and zero-dependency; the app-specific
   config (which env vars, which file, which fallback) lives in the caller.
3. **Write discipline** — the `typed-contracts` pattern (**Tier B**): a
   dedicated contracts package owns the zod schemas for anything crossing a
   trust boundary into app tables; everything parses through ONE gate;
   rejects are surfaced as events, never silently dropped.

## MUST

- The app OWNS its Postgres — embedded, under the app home. Do NOT depend on
  a system/external database for a desktop app.
- NEVER hardcode the PG port or connection URL — the port rotates per boot.
  Always resolve through `resolvePgUrl` (decision point
  `connection-resolution`). Hardcoded ports are the classic
  wedged-on-second-boot bug.
- Use **postgres-js** (the `postgres` package) as the app's PG client, not
  node-postgres (`pg`): `@papercusp/search`'s `SearchSource` API types its
  handle as a postgres-js `Sql` tagged-template function (WI-2872) — a data
  layer wired with `pg` forces a second client library (or a nontrivial
  adapter) the moment the composition adds search.
- Migrations run on boot, forward-only — a desktop app has no ops window;
  a migration that needs a human is a defect.
- Every trust-boundary write (agent output, imported files, network
  payloads) goes through a single typed-contract parse gate. If the app
  composes `papercusp-ops-pots`, this is MANDATORY for the seam's down-leg.
- Declare every component package you keep as a real dependency — the
  `components-integrated` check fails a composition wired "on paper".

## SHOULD

- Keep the discovery file lifecycle with the host (`hono-host` writes it on
  boot and removes it on graceful shutdown — reuse that ordering: host close
  → sync stop → PG stop → discovery-file removal).
- Wire live table→UI streaming via the `papercusp-data-sync` template's PG
  NOTIFY bridge rather than inventing a polling loop here.

## FREE

- Schema shapes, query layer / ORM choice, pool sizing, data-dir layout, and
  whether the typed-contracts leg exists at all (drop it when nothing
  untrusted ever writes — decision point `contract-gates`).

## Checks

`checks/components-integrated.test.ts` — configure the `components` section of
your `TEMPLATE_CHECKS_CONFIG` with the package names you kept (e.g. your
embedded-PG server package + `@papercusp/embedded-pg-discovery` + your
contracts package). Unconfigured it skips; see `checks/README.md`.
