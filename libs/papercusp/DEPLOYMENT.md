# Papercusp deployment

## Self-hosted (open path)

For anyone running their own papercusp install. Stack:

- Postgres 15+
- Node 22+ (Restart uses v24.15.0)
- Optional: code-server, livekit (only for specific plugins that need them)

```bash
git clone --recurse-submodules git@github.com:papercupai/papercusp.git
cd papercusp
npm install --legacy-peer-deps
docker compose up -d
npx drizzle-kit migrate
npm run build
npm --workspace @papercusp/web run start
```

## papercuspai.com (our hosted infra only)

- Web admin: RETIRED 2026-06-10 — the legacy `apps/web` Next admin moved to `_retired/apps-web/` (superseded by the operator UI in the Tauri desktop shell)
- Marketplace API (apps/marketplace-api): Hono node server behind Cloudflare Tunnel as `api.papercuspai.com`
- R2 bucket for tarballs (planned)
- Postgres on managed infra (TBD: Neon / self-hosted)

## Versioning

Pre-1.0; expect breaking changes. Pin a SHA in your install.
