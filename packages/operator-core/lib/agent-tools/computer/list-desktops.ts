/**
 * computer:list_desktops — the desktop inventory for this workspace: every kind from
 * the registry (local sandboxes, frame slots, VM guests), plus any lease THIS process
 * holds that the registry does not describe. Use to verify a provision landed, to grab
 * a desktop id for release/viewing, or to find leaks.
 *
 * `filter` (agent-multi-desktops-grid-2026-10-06 P-002, D-006): 'mine' = the caller's
 * own agent desktops, 'pot' = the caller's pot's shared desktop, 'all' (default).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { DESKTOP_AGENT_ROLES } from '../coordination/roles';
import { listDesktopLeases, type DesktopLeaseInfo } from './desktop-lease';
import { activeWorkspaceId } from '../../workspace-registry';
import { listDesktopSessions, type DesktopCapabilities } from '../../desktop/desktop-session-registry';
import { desktopCallerFromCtx, type DesktopCallerCtx } from './desktop-ownership';

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true } : {}),
});

export default defineTool({
  name: 'computer:list_desktops',
  profile: 'engineer',
  description:
    'List desktop sessions for this workspace from the registry — every kind (local sandbox, frame slot, VM guest), with id, name, owner, display/geometry, state, measured capabilities, and whether THIS process holds the live handle. `filter`: "mine" (your desktops), "pot" (your pot\'s shared one), "all" (default). Workspace/harness scope belongs to the outer operator envelope, not these args.',
  guidance: {
    when: 'Checking which desktops exist — your own (filter:"mine"), after provisioning, before a live view, or auditing for leaks. liveHandleInThisProcess:false means the row is not backed here; it is not proof the desktop is dead.',
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
  agentRoles: DESKTOP_AGENT_ROLES,
  args: z
    .object({
      filter: z
        .enum(['mine', 'pot', 'all'])
        .optional()
        .describe('"mine" = your own desktops, "pot" = your pot\'s shared desktop, "all" (default) = every desktop in the workspace.'),
    })
    .strict(),
  async handler(args, ctx) {
    const filter = args.filter ?? 'all';
    const caller = desktopCallerFromCtx(ctx as DesktopCallerCtx);
    if (filter === 'mine' && !caller.ownerId) {
      return text({ ok: false, error: 'identity_unresolved', reason: 'filter "mine" needs your coordination identity, and this call carries none.' }, true);
    }
    if (filter === 'pot' && !caller.harnessSlug) {
      return text({ ok: true, filter, count: 0, desktops: [], note: 'this call carries no pot (harness), so there is no pot desktop to list.' });
    }
    const wanted = (d: { scope: string; scopeRef: string }): boolean =>
      filter === 'all' ||
      (filter === 'mine' && d.scope === 'agent' && d.scopeRef === caller.ownerId) ||
      (filter === 'pot' && d.scope === 'pot' && d.scopeRef === caller.harnessSlug);

    // In-process leases: the LIVENESS authority (these hold the actual child).
    const leases = listDesktopLeases().filter(wanted);
    const leaseBySession = new Map(leases.filter((l) => l.sessionId).map((l) => [l.sessionId as string, l]));
    const potLeaseBySlug = new Map(leases.filter((l) => l.scope === 'pot').map((l) => [l.scopeRef, l]));

    // P-003 (D-004): the registry is the INVENTORY, so this enumerates EVERY kind —
    // frame slots and VM guests included — not just the sessions this one process
    // happens to hold in its Map.
    let registryRows: Awaited<ReturnType<typeof listDesktopSessions>> = [];
    let registryError: string | null = null;
    try {
      registryRows = await listDesktopSessions({
        workspaceId: activeWorkspaceId(),
        ...(filter === 'mine' ? { scope: 'agent' as const, scopeRef: caller.ownerId as string } : {}),
        ...(filter === 'pot' ? { scope: 'pot' as const, scopeRef: caller.harnessSlug as string } : {}),
      });
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
      name: string | null;
      /** The owning agent's ownerId for an agent desktop; null otherwise. */
      ownerId: string | null;
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

    const matched = new Set<DesktopLeaseInfo>();
    const desktops: DesktopRow[] = registryRows.filter(wanted).map((s): DesktopRow => {
      const local = leaseBySession.get(s.id) ?? (s.scope === 'pot' ? potLeaseBySlug.get(s.scopeRef) : undefined);
      if (local) matched.add(local);
      return {
        id: s.id,
        kind: s.kind,
        scope: s.scope,
        scopeRef: s.scopeRef,
        name: s.name ?? null,
        ownerId: s.scope === 'agent' ? s.scopeRef : null,
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
    for (const l of leases) {
      if (matched.has(l)) continue;
      desktops.push({
        id: l.sessionId ?? null,
        kind: l.desktop.xServer === 'kasmvnc' ? 'kasmvnc' : 'xvfb-local',
        scope: l.scope,
        scopeRef: l.scopeRef,
        name: l.name,
        ownerId: l.scope === 'agent' ? l.scopeRef : null,
        pot: l.scope === 'pot' ? l.scopeRef : null,
        hostRef: null,
        display: l.desktop.display ?? null,
        width: l.desktop.width ?? null,
        height: l.desktop.height ?? null,
        captureWidth: l.desktop.capture?.width ?? null,
        captureHeight: l.desktop.capture?.height ?? null,
        state: 'ready',
        capabilities: {},
        lastActiveAt: null,
        liveHandleInThisProcess: true,
        registered: false,
      });
    }

    return text({
      ok: true,
      filter,
      count: desktops.length,
      desktops,
      ...(registryError ? { registryError, degraded: 'local-only' } : {}),
    });
  },
});
