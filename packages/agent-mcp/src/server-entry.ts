#!/usr/bin/env node
/**
 * Standalone MCP server entrypoint.
 *
 * Spawned by:
 *   - pi sessions (per /api/agent-mcp/spawn-pi response)
 *   - external claude-code consumers
 *
 * Reads bearer from $AGENT_MCP_BEARER, talks MCP over stdio.
 * Tools self-register by importing `./bootstrap`.
 */

import './bootstrap';
import { registerHostPlatform } from '@papercusp/host-platform';
import { desktopHostPlatform } from '@papercusp/host-platform/desktop';
import { startServer } from './server';

// This stdio process always runs on the user's machine next to the operator —
// "desktop" for HostPlatform purposes. Without a registration every
// getHostPlatform() consumer (agent:role, operator:scanner, tool-manifest)
// throws at request time.
registerHostPlatform(desktopHostPlatform);

startServer({ stdio: true }).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[agent-mcp] server fatal:', err);
  process.exit(1);
});
