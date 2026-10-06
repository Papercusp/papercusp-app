/**
 * computer:release_desktop — tear down a desktop (kill its X server + apps, free the
 * display). The inverse of computer:provision_desktop
 * (agent-multi-desktops-grid-2026-10-06 P-002, D-005/D-006).
 *
 *  - `desktop` → one desktop, by registry session id or by the name of one of YOUR
 *    desktops. Releasing another agent's desktop is refused (`desktop_not_owned`);
 *    operator sessions may release any workspace desktop by explicit id.
 *  - `pot` → the pot's shared desktop (a placement act, as before). pot:dissolve also
 *    releases it automatically.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { DESKTOP_AGENT_ROLES } from '../coordination/roles';
import {
  listDesktopLeases,
  releaseDesktop,
  releaseDesktopBySessionId,
  releaseHiveDesktop,
  type ReleaseHiveDesktopResult,
} from './desktop-lease';
import { getDesktopSession } from '../../desktop/desktop-session-registry';
import { activeWorkspaceId } from '../../workspace-registry';
import { DESKTOP_NAME_PATTERN } from './desktop-names';
import { desktopAccess, desktopCallerFromCtx, type DesktopCallerCtx } from './desktop-ownership';

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true } : {}),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noteFor(result: ReleaseHiveDesktopResult): string {
  return result.via === 'local'
    ? 'desktop torn down.'
    : result.via === 'registry'
      ? 'desktop torn down (it was provisioned by a sibling operator process — released via the cross-process registry handle).'
      : 'no such live desktop (no-op).';
}

export default defineTool({
  name: 'computer:release_desktop',
  profile: 'engineer',
  description:
    "Tear down a desktop (kill its X server + apps, free the display). Pass `desktop` (an id from computer:list_desktops, or the name of one of YOUR desktops) or `pot` (Queen/operator: a pot's shared desktop). Idempotent — a no-op when nothing is live.",
  guidance: {
    when: 'You are done with a desktop — free it so the machine has room for others. Also good hygiene after a demo.',
    notWhen: 'Tearing down a whole pot — pot:dissolve already releases its desktop.',
    chaining: 'computer:list_desktops { filter:"mine" } → computer:release_desktop { desktop }.',
    seeAlso: [
      'computer:list_desktops (see what is live first)',
      'computer:provision_desktop (start one back up)',
      'pot:dissolve (tears down the whole pot incl desktop)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: DESKTOP_AGENT_ROLES,
  args: z
    .object({
      desktop: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('The desktop to release: its desktopSessionId, or the name of one of your own desktops.'),
      pot: entityRef('pot', { soft: true, max: 120, describe: "Release this pot's shared desktop (Queen/operator)." }).optional(),
    })
    .strict(),
  async handler(args, ctx) {
    if (Boolean(args.desktop) === Boolean(args.pot)) {
      return text({ ok: false, error: 'invalid_args', reason: 'pass exactly one of `desktop` or `pot`.' }, true);
    }
    const caller = desktopCallerFromCtx(ctx as DesktopCallerCtx);

    if (args.pot) {
      const access = desktopAccess({ scope: 'pot', scopeRef: args.pot }, caller, 'release');
      if (!access.ok) return text({ ok: false, error: access.code, reason: access.reason }, true);
      const result = await releaseHiveDesktop(args.pot);
      return text({ ok: true, pot: args.pot, released: result.released, note: noteFor(result) });
    }

    const ref = args.desktop as string;
    if (UUID.test(ref)) {
      // Ownership is decided from the record — the local lease first (it is the
      // liveness authority), then the cross-process registry row.
      const local = listDesktopLeases().find((l) => l.sessionId === ref);
      const owner = local
        ? { scope: local.scope, scopeRef: local.scopeRef }
        : await getDesktopSession({ workspaceId: activeWorkspaceId(), id: ref }).catch(() => undefined);
      if (!owner) return text({ ok: true, desktop: ref, released: false, note: noteFor({ released: false, via: 'none' }) });
      const access = desktopAccess(owner, caller, 'release');
      if (!access.ok) return text({ ok: false, error: access.code, reason: access.reason, desktop: ref }, true);
      const result = await releaseDesktopBySessionId(ref);
      return text({ ok: true, desktop: ref, released: result.released, note: noteFor(result) });
    }

    // A name is always one of the CALLER's own desktops — there is no way to name
    // another agent's desktop, so no ownership check is needed beyond identity.
    if (!DESKTOP_NAME_PATTERN.test(ref)) {
      return text({ ok: false, error: 'invalid_args', reason: '`desktop` must be a desktopSessionId (uuid) or one of your desktop names.' }, true);
    }
    if (!caller.ownerId) {
      return text({ ok: false, error: 'identity_unresolved', reason: 'releasing by name needs your coordination identity; pass the desktopSessionId instead.' }, true);
    }
    const result = await releaseDesktop({ scope: 'agent', ownerId: caller.ownerId, name: ref });
    return text({ ok: true, desktop: ref, released: result.released, note: noteFor(result) });
  },
});
