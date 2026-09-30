# Isolated-instance launchers must `env -u` ambient PAPERCUSP_*/DATABASE_URL vars
URL: /internal/docs/agent-insights/isolated-instance-launchers-must-scrub-ambient-env

`env VAR=val cmd` INHERITS any var it doesn't list — so a two-instance federation launcher that only sets HOME=\"$home\" silently leaks the caller's ambient PAPERCUSP_HOME / DATABASE_URL / PAPERCUSP_BACKGROUND_WORKERS, collapsing \"isolated\" instances onto the caller's live shared operator home. Scrub with `env -u`. Bitten 3× (WI-1666, EI-13590, EI-15308).

## The trap

`env VAR=val ... cmd` sets only the listed vars and **inherits every other var
from the calling shell** — it does *not* start from a clean environment. So a
launcher that spawns an "isolated" instance with

```bash
env HOME="$home" NODE_ENV=production ... node serve.mjs
```

still leaks whatever the caller had exported. On a fleet/dev box **every su/dev
session ambiently carries** its own per-workspace operator vars —
`PAPERCUSP_HOME` (e.g. `~/.papercusp-workspaces/<ws>/.papercusp`),
`DATABASE_URL`/`*_DATABASE_URL` (the shared native `:5432`),
`PAPERCUSP_BACKGROUND_WORKERS`, `PAPERCUSP_DHT_HOST`/`PAPERCUSP_DHT_BOOTSTRAP` —
and each one rides straight through into the "isolated" child.

## Why PAPERCUSP\_HOME is especially nasty (EI-15308)

`apps/operator/bin/serve.ts` resolves
`PAPERCUSP_DIR = process.env.PAPERCUSP_HOME || homedir()+"/.papercusp"`.
`PAPERCUSP_HOME` **wins over** the isolated `HOME="$home"` override — so if it
leaks, both local instances point their operator home at the **caller's real,
live, shared** dir instead of their own `$home`. They then fight the live
operator (and each other) over the same `operator.lock` / `operator-port.json` /
embedded-pg — signature: `"another `serve` holds the cold-start lock; aborting"`.
Isolation is silently, completely defeated (100% reproducible from an su fleet
session).

## The fix — scrub with `env -u`

List every ambient var to clear with `env -u` (**not** `VAR=` — an empty DSN
string breaks spawn-mcp downstream; `-u` truly removes it):

```bash
env -u DATABASE_URL -u PAPERCUSP_DATABASE_URL \
    -u HARNESS_DATABASE_URL -u HARNESS_ADMIN_DATABASE_URL \
    -u PAPERCUSP_HOME \
    HOME="$home" ... node serve.mjs
```

## The rule for any NEW isolated-instance launcher

If you write a launcher that spawns an operator instance meant to be isolated
(anything setting `HOME="$home"`), you MUST `env -u` **all** ambient
`PAPERCUSP_*` / `DATABASE_URL`-family vars the box's shells export — the ones
that leak silently are the ones that resolve *before* your explicit overrides.
This is a **recurring class**, not a one-off:

* **WI-1666** — `DATABASE_URL` / `*_DATABASE_URL` (isolated instance read/wrote the tower's shared PG)
* **EI-13590** — `PAPERCUSP_BACKGROUND_WORKERS` (request-only ambient mode skipped the hyperbee substrate)
* **EI-15308** — `PAPERCUSP_HOME` (both instances collapsed onto the caller's shared operator home)

## Where this lives + the regression guard

The shared launchers are `fed_local_launch` (GUI) and
`fed_local_launch_sidecar` in
`papercusp-desktop/bin/lib/federation-asserts.sh`; the from-repo smoke has its
own script-local `sc_launch`. `federation-asserts.selftest.sh` section 7/7b now
statically guards the scrub (`declare -f` body grep for the library functions +
a static grep for the smoke-local `sc_launch`) — extend that list when you add a
new launcher or a new ambient var to scrub.
