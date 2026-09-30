# Papercusp

Open standard + reference runtime for autonomous-harness frameworks. The substrate
constrains long-running agent missions to a small set of named roles, each invoked
with fresh context, handing off through structured artefacts in Postgres.

## Self-hosting

```bash
git clone --recurse-submodules git@github.com:papercupai/papercusp.git
cd papercusp
npm install --legacy-peer-deps
docker compose up -d            # postgres
npm run build
npm --workspace @papercusp/web run start
```

The web admin will be at `http://localhost:3055`. The marketplace API (this repo's
`apps/marketplace-api`) is intended for our hosted infra (papercuspai.com) only —
self-hosters typically don't need it.

## Layout

```
apps/
  web/              # local admin UI for whoever runs papercusp
  marketplace-api/  # backend for papercuspai.com (hosted by us)
  desktop/          # Tauri-packaged web admin for offline/desktop use
packages/
  cli/              # `papercusp publish` / `install` / `run` CLI
  harness/          # the substrate: run.sh, prompt templates, role definitions
libs/
  db/               # Drizzle schema for substrate state (Postgres)
```

External dependencies are git submodules under `external/` (none yet at this
extraction; the @papercusp/* shared libs come from sister repos).

## Status

Pre-1.0. Plugin SDK + plugin loader live in a separate repo (currently being built).

## Spec

See `docs/explanation.md` for the open-standard specification.
