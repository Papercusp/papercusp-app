/**
 * computer:provision_desktop — stand up a sandboxed GUI desktop that capability:computer
 * can drive (computer-tool-plan Gap A; agent-multi-desktops-grid-2026-10-06 P-002).
 *
 * Two doors on one verb (D-006):
 *  - no `pot` → a desktop for the CALLER. An agent may hold as many as it likes, each
 *    with its own `name` (default `desktop-<n>`); re-provisioning a name returns that
 *    desktop. Open to every desktop-owning role (D-013).
 *  - `pot` → the pot's ONE shared desktop, which bees in that pot resolve via
 *    ctx.harnessSlug. Equipping a pot is a placement act, so this door stays limited
 *    to QUEEN_PLACEMENT_ROLES inside the handler.
 *
 * Either way it stands up an isolated Xvfb/KasmVNC + openbox (+ any requested apps) on
 * a free display (NEVER host :0) IN THE OPERATOR PROCESS and records it in the lease
 * map and the desktop registry. `apps` launch only on the first provision. Tear down
 * with computer:release_desktop (or pot:dissolve for a pot desktop).
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { DESKTOP_AGENT_ROLES } from '../coordination/roles';
import {
  desktopSessionIdFor,
  ensureDesktop,
  leasedDesktop,
  listDesktopLeases,
  type DesktopLeaseTarget,
} from './desktop-lease';
import {
  DEFAULT_CAPTURE_GEOMETRY,
  listDesktopSessions,
  type DesktopSessionRecord,
} from '../../desktop/desktop-session-registry';
import { activeWorkspaceId } from '../../workspace-registry';
import { DESKTOP_NAME_PATTERN, nextDefaultDesktopName } from './desktop-names';
import { desktopCallerFromCtx, type DesktopCallerCtx } from './desktop-ownership';
import type { ProvisionOptions, SandboxDesktop } from './desktop-provisioner';
import { admissionRefusal, admitNewDesktop } from './desktop-headroom';

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true } : {}),
});

/** P-004 / D-007: a NEW desktop needs measured memory headroom. Reusing a lease never asks. */
async function refuseWithoutHeadroom(ownerId: string | null) {
  const result = await admitNewDesktop({ workspaceId: activeWorkspaceId(), ownerId });
  return result.verdict.admit ? null : text(admissionRefusal(result), true);
}

function geometry(d: SandboxDesktop) {
  return {
    display: d.display,
    width: d.width,
    height: d.height,
    // D-006: report BOTH geometries so the caller can see what the model will be
    // served — the whole point is that this differs from the screen size.
    captureWidth: d.capture?.width ?? DEFAULT_CAPTURE_GEOMETRY.width,
    captureHeight: d.capture?.height ?? DEFAULT_CAPTURE_GEOMETRY.height,
  };
}

export default defineTool({
  name: 'computer:provision_desktop',
  profile: 'engineer',
  description:
    'Start a sandboxed GUI desktop (isolated X server + openbox, never host :0) that capability:computer drives. Omit `pot` to start one for YOURSELF — you may run many, each with its own `name`; pass `pot` (Queen/operator) to equip a pot with its shared desktop. Optionally launches GUI apps. Idempotent per name. Tear down with computer:release_desktop.',
  guidance: {
    when: 'You need a GUI to work in — a browser, a desktop app. Start one per parallel task (`name` each, e.g. "checkout-flow"); pass `apps` to pre-launch programs.',
    notWhen:
      'Scriptable work (files/CLIs/APIs) needs no desktop — use capability:bash. On a deployed desktop FRAME the per-slot Xvfb is leased by the frame bootstrap, not this tool.',
    chaining:
      'computer:provision_desktop { name } → capability:computer → computer:list_desktops { filter:"mine" } → computer:release_desktop { desktop } when done.',
    seeAlso: [
      'capability:computer (drive the desktop)',
      'computer:list_desktops (see your desktops)',
      'computer:release_desktop (free one when done)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: DESKTOP_AGENT_ROLES,
  args: z
    .object({
      pot: entityRef('pot', { soft: true, max: 120, describe: "Equip this pot (home-harness slug) with its ONE shared desktop. Omit to start a desktop for yourself." }).optional(),
      name: z
        .string()
        .regex(DESKTOP_NAME_PATTERN, 'lowercase letters, digits, ".", "_" or "-", starting with a letter or digit, ≤63 chars')
        .optional()
        .describe('Name of YOUR desktop (default desktop-<n>). Re-using a name returns that desktop.'),
      apps: z
        .array(z.array(z.string().min(1)).min(1).max(16))
        .max(16)
        .optional()
        .describe('GUI apps to launch on the desktop, each an argv array — e.g. [["firefox","--no-remote"],["soffice","--calc"]].'),
      width: z.number().int().positive().max(7680).optional().describe('Screen width in px (default 1024 — best computer-use grounding).'),
      height: z.number().int().positive().max(4320).optional().describe('Screen height in px (default 768).'),
      capture_width: z.number().int().positive().max(7680).optional().describe('Px width the AGENT is served (default 1024); the screen still runs at `width`.'),
      capture_height: z.number().int().positive().max(4320).optional().describe('Px height the AGENT is served (default 768). Larger costs proportionally more tokens.'),
    })
    .strict(),
  async handler(args, ctx) {
    const opts: ProvisionOptions = {
      ...(args.apps ? { apps: args.apps } : {}),
      ...(args.width ? { width: args.width } : {}),
      ...(args.height ? { height: args.height } : {}),
      ...(args.capture_width ? { captureWidth: args.capture_width } : {}),
      ...(args.capture_height ? { captureHeight: args.capture_height } : {}),
    };
    const caller = desktopCallerFromCtx(ctx as DesktopCallerCtx);

    if (args.pot) {
      if (args.name) {
        return text({ ok: false, error: 'name_with_pot', reason: 'a pot has ONE shared desktop; `name` is for your own desktops (omit `pot`).' }, true);
      }
      if (!caller.mayManagePots) {
        return text({ ok: false, error: 'pot_desktop_not_permitted', reason: "equipping a pot's shared desktop is a placement act (Queen/operator roles). Omit `pot` to start a desktop for yourself." }, true);
      }
      const target: DesktopLeaseTarget = { scope: 'pot', pot: args.pot };
      const already = leasedDesktop(target);
      if (!already) {
        const refused = await refuseWithoutHeadroom(caller.ownerId ?? null);
        if (refused) return refused;
      }
      const d = await ensureDesktop(target, opts);
      return text({
        ok: true,
        scope: 'pot',
        pot: args.pot,
        desktopSessionId: desktopSessionIdFor(target) ?? null,
        ...geometry(d),
        reused: !!already,
        note: already
          ? 'pot already had a desktop — returned the existing lease (apps NOT re-launched).'
          : 'capability:computer for bees in this pot now resolves this display (server-side, via ctx.harnessSlug).',
      });
    }

    if (!caller.ownerId) {
      return text({ ok: false, error: 'identity_unresolved', reason: 'an agent desktop is owned by your coordination identity, and this call carries none.' }, true);
    }
    const ownerId = caller.ownerId;

    // The registry is cross-process; the lease map is not. On a multi-worker operator
    // another worker may hold one of this agent's desktops, so both views decide which
    // names are taken and whether `name` already exists.
    let registryRows: DesktopSessionRecord[] = [];
    let registryError: string | null = null;
    try {
      registryRows = await listDesktopSessions({ workspaceId: activeWorkspaceId(), scope: 'agent', scopeRef: ownerId });
    } catch (e) {
      registryError = e instanceof Error ? e.message : String(e);
    }
    const localNames = listDesktopLeases()
      .filter((l) => l.scope === 'agent' && l.scopeRef === ownerId)
      .map((l) => l.name);
    const name =
      args.name ??
      nextDefaultDesktopName([...localNames, ...registryRows.map((r) => r.name)].filter((n): n is string => Boolean(n)));
    const target: DesktopLeaseTarget = { scope: 'agent', ownerId, name, harnessSlug: caller.harnessSlug };

    const already = leasedDesktop(target);
    if (!already) {
      // Held by a sibling operator process: return THAT desktop rather than start a
      // second one under the same name (the registry would refuse its row anyway).
      const elsewhere = registryRows.find((r) => r.name === name);
      if (elsewhere) {
        return text({
          ok: true,
          scope: 'agent',
          name,
          desktopSessionId: elsewhere.id,
          display: elsewhere.display,
          width: elsewhere.displayGeometry.width,
          height: elsewhere.displayGeometry.height,
          captureWidth: elsewhere.captureGeometry.width,
          captureHeight: elsewhere.captureGeometry.height,
          reused: true,
          liveHandleInThisProcess: false,
          note: 'you already have a desktop with this name (held by another operator process) — returned it; apps NOT launched.',
        });
      }
      const refused = await refuseWithoutHeadroom(ownerId);
      if (refused) return refused;
    }

    const d = await ensureDesktop(target, opts);
    const desktopSessionId = desktopSessionIdFor(target) ?? null;
    return text({
      ok: true,
      scope: 'agent',
      name,
      desktopSessionId,
      ...geometry(d),
      reused: !!already,
      note: already
        ? 'you already had a desktop with this name — returned it (apps NOT re-launched).'
        : `desktop "${name}" is up. Drive it with capability:computer; release it with computer:release_desktop { desktop: "${name}" }.`,
      ...(desktopSessionId ? {} : { registryWarning: 'the desktop works, but its registry row was not written yet, so viewers cannot list it until the next provision heals it.' }),
      ...(registryError ? { registryError } : {}),
    });
  },
});
