/**
 * Resolve the operator sidecar's own base URL for server-side self-fetches
 * (RSC pages calling local Hono routes, plugin action runners hitting
 * /api/plugins/invoke, etc.).
 *
 * Priority:
 *   1. PAPERCUSP_SELF_URL env var (explicit override, e.g. for CI)
 *   2. http://127.0.0.1:${PORT} where PORT is set by the runtime:
 *        - Tauri sidecar (papercusp-desktop): dynamic port assigned at spawn
 *        - bin/prod: defaults to 3070
 *        - bin/dev: defaults to 3055
 *   3. http://127.0.0.1:3055 final fallback (matches dev default).
 *
 * Why this matters: prior code hardcoded `http://localhost:3055` as the
 * fallback, which silently coupled prod (:3070) and the desktop sidecar
 * (dynamic port) to whatever happened to be listening on :3055 — usually
 * the dev server, sometimes nothing. On a clean user install, /harness/<slug>
 * RSC fetches went to ECONNREFUSED and 404'd. See diagnostic 2026-05-06.
 */
export function selfUrl(): string {
  const override = process.env.PAPERCUSP_SELF_URL;
  if (override) return override.replace(/\/$/, '');
  const port = process.env.PORT ?? '3055';
  return `http://127.0.0.1:${port}`;
}
