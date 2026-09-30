# checks/ — the acceptance suite (papercusp-web-host)

## `boot-e2e` (`boot-e2e.test.ts`) — the composed web app actually boots

The SAME portable check the papercusp-tauri-desktop-shell template ships (copied
verbatim — the web host adopts the identical discovery-file lifecycle):
host spawns → discovery file (`operator.json` analog) written → health
returns 200 → SIGTERM → clean exit within the grace window → discovery file
removed.

Portable + app-parameterized: self-contained (devDep: `vitest`; Node ≥18
fetch), driven by the **`TEMPLATE_CHECKS_CONFIG`** JSON (schema:
`@papercusp/template-kit` `TemplateChecksConfig`, section `boot`). Without
the env var it SKIPS.

Web-host specifics for the config:

- `buildCommand` — the standalone build leg (e.g.
  `["npm", "run", "build"]`), which must stage `.next/static` + `public/`
  into the standalone tree.
- `command` — the standalone start (e.g.
  `["node", ".next/standalone/apps/web/server.js"]`) with `env.PORT` set,
  NOT `next dev` — the check must prove the SHIPPED artifact boots. And
  never via an `npx` wrapper: `npx` does not forward SIGTERM to the child,
  so the graceful-shutdown assertion fails even when the app's shutdown
  code is correct (WI-2867).
- `healthPath` — a route the app serves unauthenticated (default
  `/api/health`); keep it outside the middleware auth gate's matcher.

**Two modes** — because the discovery file is a per-user singleton: `spawn`
(CI / gym / fresh checkout — full lifecycle incl. cleanup) and `attach`
(assert against an already-running instance).

```sh
TEMPLATE_CHECKS_CONFIG=/path/to/checks-config.json npx vitest run checks/
```
