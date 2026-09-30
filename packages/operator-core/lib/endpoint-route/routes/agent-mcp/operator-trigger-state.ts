/**
 * GET /api/agent-mcp/operator-trigger-state — fingerprint poll for chrome scanner.
 * 1s in-process cache.
 * Ported from app/api/agent-mcp/operator-trigger-state/route.ts. `auth: 'public'`.
 */
import { fingerprint, readTriggerState, type TriggerState } from '../../../operator-trigger-state';
import { defineTool } from '@papercusp/agent-mcp';
import { pinModuleState } from '@papercusp/module-singleton';

interface CacheEntry { ts: number; payload: { fingerprint: string; state: TriggerState } }
const CACHE_TTL_MS = 1000;

// Module-scoped mutable state in a bundled package: pinned per the shared-lib
// singleton rule, so a second module record (tsx's CJS preflight, a bare vs
// relative specifier, a bundled copy beside source) cannot serve one caller a
// private 1s cache while another writes to a different one.
const cache = pinModuleState('@papercusp/operator-core.trigger-state-cache', () => ({
  entry: null as CacheEntry | null,
}));

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-trigger-state',
  auth: 'public',
  async handler() {
    try {
      const now = Date.now();
      const cached = cache.entry;
      if (cached && now - cached.ts < CACHE_TTL_MS) {
        return Response.json(cached.payload);
      }
      const state = await readTriggerState();
      const payload = { fingerprint: fingerprint(state), state };
      cache.entry = { ts: now, payload };
      return Response.json(payload);
    } catch (err) {
      return new Response(`trigger-state unavailable: ${err instanceof Error ? err.message : String(err)}`, {
        status: 503,
      });
    }
  },
});
