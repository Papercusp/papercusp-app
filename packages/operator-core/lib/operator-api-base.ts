/**
 * The local operator **API** base — the Hono host that serves `/api/*` routes
 * (`PAPERCUSP_HONO_PORT`, default `:3070`). NOT the Vite SPA dev server (`:3055`).
 *
 * Internal in-process loopback calls — agent dispatch via the `/invoke` route, the
 * marketplace/spawnable catalog reads, cross-harness `execute-action`, admin token
 * rotation, … — must target THIS, never `:3055`. The old `?? 'http://localhost:3055'`
 * default (duplicated across ~10 call sites) only worked in dev because Vite proxies
 * `/api → :3070`; on the RELEASE operator (which runs the routines + has no `:3055`)
 * those calls hit a dead port and threw "fetch failed". That silently broke the
 * merge-resolver auto-dispatch — caught by the P-011 live conflict drill
 * (git-sync-system-audit-2026-06-09 D-005). Deriving from `PAPERCUSP_HONO_PORT` is
 * correct on dev, the release operator (`:3070`), AND staging (`:3170`).
 *
 * `PAPERCUSP_OPERATOR_BASE` still overrides for any bespoke host wiring.
 */
export function operatorApiBase(): string {
  return process.env.PAPERCUSP_OPERATOR_BASE ?? `http://localhost:${process.env.PAPERCUSP_HONO_PORT ?? '3070'}`;
}
