# reference/ — worked examples

What every builder can rely on, wherever this template was cloned from:

- **Your papercusp install** — the operator app is the papercusp-native
  reference instance of a Next.js web host on a live install; the docs at
  `/internal/docs` (start with `agent-insights`) are the design record.
- **Origin / design of record**: this chassis was extracted from the first
  webapp built on papercusp — the audit at
  `/internal/docs/agent-insights/restart-webapp-audit-papercusp-webapp-template`
  records the extraction piece by piece: `next.config.js` (standalone +
  `outputFileTracingRoot` + `transpilePackages`), standalone build/start
  scripts, `middleware.ts` (auth gate stub), `auth-proxy.mjs` (basic-auth
  reverse proxy), the Dockerfile workspace-manifest COPY layer, the
  serial-PG vitest rig.
- **Sibling shape**: `../../papercusp-tauri-desktop-shell/` — the desktop twin; same
  discovery-file + graceful-shutdown lifecycle.
- **Docs**: `/internal/docs/agent-insights/templates-system-design` ·
  `templates-component-catalog` · `templates-template-yaml`.
