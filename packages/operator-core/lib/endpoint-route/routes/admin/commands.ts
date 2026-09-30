/**
 * GET /api/admin/commands — list registered admin commands.
 *
 * Ported from app/api/admin/commands/route.ts. `auth: 'public'` —
 * faithful (no prior auth check). The Next `import 'server-only'`
 * poison-pill is dropped: a `defineTool` module is server-only by
 * construction (only the route registry imports it).
 */
import { listCommands } from '../../../admin-commands';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/admin/commands',
  // unverified-loopback: cookie-less desktop webview (EI-338) — the packaged
  // desktop app's AdminOps/PackagedBuildTab panes bare-fetch this route from
  // localhost with no session cookie, so it only ever resolves 'unverified-loopback'
  // trust. Read-only listing; mirrors dogfood-substrate-health.ts (EI-18834967602055309).
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  handler() {
    return Response.json({ commands: listCommands() });
  },
});
