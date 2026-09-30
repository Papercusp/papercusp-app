/** Shared, side-effect-free MCP transport contract values. */

/**
 * Server capabilities declared in the MCP `initialize` response. Includes
 * the Papercusp typed-events extension so third-party MCP clients can
 * discover that this server emits `notifications/papercusp/event` frames
 * outside the JSON-RPC core spec.
 */
export const MCP_SERVER_CAPABILITIES = {
  // listChanged: true — this server grows a session's advertised tool set at
  // runtime (dynamic-tool-surface-2026-07-01). A seeded session expands on
  // intent via ctx.activateTools and receives tools/list_changed.
  tools: { listChanged: true },
  resources: {},
  prompts: {},
  experimental: {
    'papercusp/typedEvents': { version: '1' },
  },
} as const;
