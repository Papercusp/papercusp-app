/**
 * Next.js `maxDuration` recommendations for SSE routes.
 *
 * Next.js requires `export const maxDuration = <literal>;` at the route file
 * level — a library function can't set it. These constants exist so callers
 * import + re-export them, making the intent obvious + consistent.
 *
 * On Vercel: serverless plans cap maxDuration far below these values (~10s on
 * free, ~60s on hobby, 900s on enterprise). These constants are sized for the
 * desktop sidecar (a long-running Node process with no per-request cap).
 * For web deploys: use ACTION_MAX_DURATION_SEC if you must run on serverless,
 * but most SSE routes don't run there — they run on the desktop sidecar.
 */

/** Recommended for sync-style long-lived streams (24h). Desktop only. */
export const SYNC_MAX_DURATION_SEC = 86_400;

/** Recommended for bounded action streams (30 min). Works on serverless too. */
export const ACTION_MAX_DURATION_SEC = 1_800;
