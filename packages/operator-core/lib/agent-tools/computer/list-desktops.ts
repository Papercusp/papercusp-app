/**
 * computer:list_desktops — observability for the per-hive sandbox-desktop leases held in
 * THIS operator process: which hives hold a desktop and on what display/geometry. Use to
 * verify a provision landed, to grab the display for a VNC view, or to find leaks.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { QUEEN_PLACEMENT_ROLES } from '../coordination/roles';
import { hiveDesktop, leasedHiveDesktops } from './desktop-lease';
import { activeWorkspaceId } from '../../workspace-registry';
import { listDesktopSessions, type DesktopCapabilities } from '../../desktop/desktop-session-registry';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'computer:list_desktops',
  profile: 'engineer',
  description:
    'List desktop sessions for this workspace from the registry — every kind (local Xvfb, frame slot, VM guest), with display/geometry, state, measured capabilities, and whether THIS process holds the live handle. Use to confirm computer:provision_desktop landed or to spot a leaked lease. Scope belongs to the outer operator envelope (for example ptool --workspace/--harness), not these tool args; pass {} as the tool arguments.',
  guidance: {
    when: 'Checking which desktops exist — after provisioning, before a VNC view, or auditing for leaks. Pass an empty tool-args object; provide workspace/harness through the outer operator envelope. liveHandleInThisProcess:false means the row is not backed here; it is not proof the desktop is dead.',
    notWhen: 'Driving a desktop (capability:computer) or standing one up (computer:provision_desktop).',
    chaining: 'computer:provision_desktop → computer:list_desktops (verify) → computer:release_desktop.',
    seeAlso: [
      'computer:provision_desktop (stand one up)',
      'computer:release_desktop (reclaim one)',
      'capability:computer (drive a desktop)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: QUEEN_PLACEMENT_ROLES,
  args: z.object({}).strict(),
  async handler() {
    // In-process leases: the LIVENESS authority (these hold the actual child).
    const localByPot = new Map(
      leasedHiveDesktops().map((hive) => [hive, hiveDesktop(hive)] as const),
    );

    // P-003 (D-004): the registry is the INVENTORY, so this enumerates EVERY kind —
    // frame slots and VM guests included — not just the sessions this one process
    // happens to hold in its Map.
    let registryRows: Awaited<ReturnType<typeof listDesktopSessions>> = [];
    let registryError: string | null = null;
    try {
      registryRows = await listDesktopSessions({ workspaceId: activeWorkspaceId() });
    } catch (e) {
      // Degrade to the local view rather than failing the call — but SAY SO, so a
      // short list is never silently mistaken for "no desktops exist".
      registryError = e instanceof Error ? e.message : String(e);
    }

    interface DesktopRow {
      id: string | null;
      kind: string;
      scope: string;
      scopeRef: string;
      pot: string | null;
      hostRef: string | null;
      display: string | null;
      width: number | null;
      height: number | null;
      captureWidth: number | null;
      captureHeight: number | null;
      state: string;
      capabilities: DesktopCapabilities;
      lastActiveAt: Date | null;
      liveHandleInThisProcess: boolean;
      registered: boolean;
    }

    const desktops: DesktopRow[] = registryRows.map((s): DesktopRow => {
      const local = s.scope === 'pot' ? localByPot.get(s.scopeRef) : undefined;
      return {
        id: s.id,
        kind: s.kind,
        scope: s.scope,
        scopeRef: s.scopeRef,
        pot: s.scope === 'pot' ? s.scopeRef : null,
        hostRef: s.hostRef,
        display: s.display,
        width: s.displayGeometry.width,
        height: s.displayGeometry.height,
        captureWidth: s.captureGeometry.width,
        captureHeight: s.captureGeometry.height,
        state: s.state,
        capabilities: s.capabilities,
        lastActiveAt: s.lastActiveAt,
        // ⚠ D-004's invariant made visible: a row is a CLAIM about a process, not
        // proof of one. `true` only when THIS process holds the handle; `false` on a
        // remote-owned or unreconciled row — never read a row alone as liveness.
        liveHandleInThisProcess: Boolean(local),
        registered: true,
      };
    });

    // Leases this process holds that the registry does not describe — a failed
    // best-effort write, a pre-migration lease, or simply no operator database
    // (a frame, or a unit test). These belong in the SAME list: a caller asking
    // "what desktops exist" must not have to union two arrays to find out, and
    // omitting them would make a locally-leased desktop invisible exactly when the
    // registry is unavailable. They carry registered:false rather than a separate
    // bucket, so the distinction survives without splitting the contract.
    const registeredPots = new Set(
      registryRows.filter((s) => s.scope === 'pot').map((s) => s.scopeRef),
    );
    for (const [hive, d] of localByPot) {
      if (registeredPots.has(hive)) continue;
      desktops.push({
        id: null,
        kind: 'xvfb-local',
        scope: 'pot',
        scopeRef: hive,
        pot: hive,
        hostRef: null,
        display: d?.display ?? null,
        width: d?.width ?? null,
        height: d?.height ?? null,
        captureWidth: null,
        captureHeight: null,
        state: 'ready',
        capabilities: {},
        lastActiveAt: null,
        liveHandleInThisProcess: true,
        registered: false,
      });
    }

    return text({
      ok: true,
      count: desktops.length,
      desktops,
      ...(registryError ? { registryError, degraded: 'local-only' } : {}),
    });
  },
});
