# Papercusp web app — public framework copy

> **Two-tree architecture (when read inside the `papercupai/papercup` monorepo).**
> This directory is the **public-face copy** of the framework's web app.
> Originally a `papercupai/papercusp` git submodule, it was vendored into
> the parent repo in commit `636c4219` when `papercupai/*` repos became
> unreachable; both trees now share the same git history.
>
> The active development tree for the same web app lives at `apps/papercusp/`
> in the parent monorepo — features land there first and get promoted here
> when stable.
>
> If this `libs/papercusp/` tree is ever re-extracted to a standalone repo
> (e.g. when `papercupai/*` becomes accessible again, or when we re-publish
> the framework), this `apps/web/` directory IS the canonical Papercusp web
> app. Both versions share the same npm package name (`@papercusp/web`).
>
> See `ARCHITECTURE.md` in the parent monorepo for the full architecture.

The open-source autonomous-harness framework — the hosted web app + marketplace API.

This app powers `papercuspai.com`. It serves:

- The marketing homepage at `/`
- A signup stub at `/signup`
- The harness marketplace at `/marketplace` (browse + install command)
- Settings at `/settings/*`:
  - **API keys** (`/settings/api-keys`) — writes `~/.papercusp/credentials.json`
  - **Profile** (`/settings/profile`) — writes `~/.papercusp/profile.json`
- Harness control panel at `/harness/*` (Stage 3 — currently redirects to the legacy admin)

## Prerequisites

- **Postgres 16+** running locally (or anywhere reachable). Quick start:

  ```sh
  docker compose -f docker-compose.papercusp.yml up -d postgres
  bin/papercusp-init-db.sh
  ```

  This creates the `papercusp` + `papercusp_test` databases, the
  `harness_app` / `harness_admin` roles, and applies the framework DDL plus
  the Papercup demo's extra DDL.

- **Claude Max subscription** (recommended) **OR** an Anthropic API key.
  The harness defaults to `omp -p` (oh-my-pi) which routes through
  Meridian + Claude Max OAuth — no API key needed if `claude login` has
  been run. Falls back to direct `claude -p` if `AGENT_BACKEND=claude-code`
  is set. API key slot lives at `/settings/api-keys`.

- **Node 22+**.

## Dev

```sh
# from repo root
npm install --legacy-peer-deps
npm run dev:papercusp        # port 3055
npm run dev:marketplace      # port 3057 — the catalog tarball server
npm run dev:papercup         # port 3061 — the first demo install
```

Or all at once via Overmind: `bin/overmind-all start`.

## Architecture

- `apps/papercusp/` — this app (the framework's web UI).
- `apps/papercusp-marketplace/` — Hono service backing `/api/marketplace/catalog`.
- `apps/papercup/` — Papercup demo, the first reference install of Papercusp.
- `packages/papercusp-harness/` — the harness substrate (`run.sh`, prompts, identity, templates).
- `packages/papercusp-plugin-sdk/` — TypeScript types for plugin authors.
- `libs/db-org/` — Postgres connection + Drizzle schema (framework tables).
- `libs/papercusp-db/` — Drizzle schema for Papercup-specific tables (`papercup_shared`).

See `PLAN.md` at the repo root for the staged migration roadmap.

## What stays local

API keys (`~/.papercusp/credentials.json`) and profile preferences
(`~/.papercusp/profile.json`) are written to disk on the user's machine,
mode 0600. Even when cloud sync ships, the API keys never leave your machine.
