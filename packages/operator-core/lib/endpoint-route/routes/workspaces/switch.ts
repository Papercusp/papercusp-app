/**
 * POST /api/workspaces/switch — change the active workspace (webapp path).
 *
 * Updates registry.json's `current` field and fans the workspace-switch
 * hook so the leaving workspace's in-memory state is dropped. The desktop
 * shell uses the `workspaces_switch` Tauri command instead (it also kills
 * the sidecar + embedded-postgres-server first).
 *
 * Ported from app/api/workspaces/switch/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { existsSync } from 'node:fs';
import { readRegistry, workspacesRoot, writeRegistry } from '../../../workspace-registry';
import { join } from 'node:path';
import { dispatchWorkspaceSwitch } from '@papercusp/agent-mcp';
import { defineTool } from '@papercusp/agent-mcp';

// Resolved LAZILY (WI-40369). This module is imported for registration by
// endpoint-route/routes/index.ts, so it evaluates inside any suite that pulls
// in the route registry — including the many that install a PARTIAL
// `vi.mock('../workspace-registry', ...)`. Under vitest, reading an export the
// mock factory does not define is a HARD throw, so calling `workspacesRoot()`
// at module-eval time strands the ENTIRE unrelated suite file at import.
// Deferring the call means only a request that actually reaches the handler
// touches the seam.
const registryPath = () => join(workspacesRoot(), 'registry.json');

export default defineTool({
  method: 'POST',
  path: '/workspaces/switch',
  auth: 'loopback',
  async handler(req) {
    let body: { id?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    const id = String(body.id ?? '').trim();
    if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
      return Response.json({ ok: false, error: `invalid workspace id "${id}"` }, { status: 400 });
    }
    if (!existsSync(registryPath())) {
      return Response.json({ ok: false, error: 'no workspace registry on disk' }, { status: 404 });
    }
    const reg = readRegistry();
    if (!reg.workspaces.some((w) => w.id === id)) {
      return Response.json({ ok: false, error: `unknown workspace "${id}"` }, { status: 404 });
    }
    if (reg.current === id) {
      return Response.json({ ok: true, id, alreadyCurrent: true });
    }
    // Capture the leaving workspace before flipping `current` so the
    // workspace-switch hook can drop its in-memory state (replay buffers,
    // card-correlator PENDING entries, state-channel run snapshots).
    const leaving = reg.current;
    reg.current = id;
    writeRegistry(reg);
    // Fire-and-forget — cleanup is best-effort; a subscriber failure must
    // not break the switch. dispatchWorkspaceSwitch isolates throws.
    //
    // `reg.current` is optional, so `leaving` is undefined on the FIRST switch
    // of a registry that never had a current workspace. There is no departing
    // workspace to clean up in that case, and dispatching anyway would hand
    // every subscriber an undefined id to evict state under — so skip it
    // rather than widening the callee or casting the gap away.
    if (leaving !== undefined) {
      void dispatchWorkspaceSwitch(leaving).catch((e) => {
        console.warn('[workspaces/switch] dispatchWorkspaceSwitch failed:', e);
      });
    }
    return Response.json({ ok: true, id });
  },
});
