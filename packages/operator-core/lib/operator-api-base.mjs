/**
 * Runtime-neutral mirror of operator-api-base.ts for the plain ESM helpers.
 *
 * The shared Oracle/Delegate modules are loaded as .mjs by standalone MCP
 * processes, so they cannot import the TypeScript helper directly. Keep this
 * tiny mirror aligned with operator-api-base.ts: internal API calls target the
 * Hono operator, never the Vite SPA dev server.
 */
export function operatorApiBase() {
  return process.env.PAPERCUSP_OPERATOR_BASE
    ?? `http://localhost:${process.env.PAPERCUSP_HONO_PORT ?? '3070'}`;
}
