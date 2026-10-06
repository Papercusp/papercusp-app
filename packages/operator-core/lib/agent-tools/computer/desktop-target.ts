/**
 * desktop-target.ts — which desktop a computer verb drives when the caller may own
 * several (agent-multi-desktops-grid-2026-10-06 P-003, D-005).
 *
 * Every computer verb (capability:computer, computer:observe, computer:click_element,
 * computer:record) takes an optional `desktop` arg: a desktopSessionId, or the name of
 * one of the caller's OWN agent desktops. This module turns that arg (or its absence)
 * into a concrete display, applying D-005's first two resolution steps:
 *
 *   1. an explicit `desktop` — resolved, then checked against the ownership rule
 *      (desktop-ownership.ts) BEFORE any input is sent; a desktop the caller may not
 *      drive is refused with `desktop_not_owned`, a missing one with `desktop_not_found`;
 *   2. no `desktop` — the caller's live agent desktops: exactly one → it, several → the
 *      one used most recently (registry `last_active_at`).
 *
 * Returning null hands the call back to the pre-existing chain in computer.ts
 * (pot lease → env display → registry pot fallback → the no-lease error), so a caller
 * with no agent desktops behaves exactly as before.
 *
 * Resolution reads the REGISTRY, not this process's lease map: the operator serving
 * :3070 is a multi-worker cluster and the lease that started a desktop may live in a
 * different worker. X displays are host-global, so the row's display is drivable from
 * any worker. The model still never names a display — only an id or its own name.
 *
 * Driving a desktop also keeps it alive: the row is touched (an `idle` desktop goes
 * back to `ready`) and a `frozen` one is thawed first, because input into a frozen
 * cgroup would queue silently and the call would time out instead of acting.
 */
import { activeWorkspaceId } from '../../workspace-registry';
import {
  getDesktopSession,
  listDesktopSessions,
  markDesktopThawed,
  touchDesktopSession,
  type DesktopSessionRecord,
} from '../../desktop/desktop-session-registry';
import { thawTask } from '../../task-manager/control';
import { desktopAccess, desktopCallerFromCtx, type DesktopCaller, type DesktopCallerCtx } from './desktop-ownership';

export type DesktopTargetErrorCode = 'desktop_not_owned' | 'desktop_not_found';

/** A refusal raised before any input reaches a display. The code leads the message so a model can branch on it. */
export class DesktopTargetError extends Error {
  readonly code: DesktopTargetErrorCode;
  constructor(code: DesktopTargetErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'DesktopTargetError';
    this.code = code;
  }
}

export interface ResolvedAgentDesktop {
  session: DesktopSessionRecord;
  /** How it was chosen, for the result line and for tests. */
  via: 'explicit' | 'only-agent-desktop' | 'most-recent-agent-desktop';
}

export interface DesktopTargetDeps {
  workspaceId?: () => string;
  getSession?: typeof getDesktopSession;
  listSessions?: typeof listDesktopSessions;
  touch?: typeof touchDesktopSession;
  thaw?: (taskId: string) => Promise<unknown>;
  markThawed?: typeof markDesktopThawed;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The caller's live, NAMED agent desktops (frame-allocator rows have no name and stay on the env path). */
async function callerAgentDesktops(
  caller: DesktopCaller,
  workspaceId: string,
  list: typeof listDesktopSessions,
): Promise<DesktopSessionRecord[]> {
  if (!caller.ownerId) return [];
  const rows = await list({ workspaceId, scope: 'agent', scopeRef: caller.ownerId });
  return rows.filter((r) => r.name !== null);
}

async function resolveExplicit(
  desktop: string,
  caller: DesktopCaller,
  workspaceId: string,
  deps: Required<Pick<DesktopTargetDeps, 'getSession' | 'listSessions'>>,
): Promise<DesktopSessionRecord> {
  let session: DesktopSessionRecord | undefined;
  if (UUID.test(desktop)) {
    session = await deps.getSession({ workspaceId, id: desktop });
  } else {
    // A name only ever addresses the caller's OWN desktops — names are unique per
    // agent, not per workspace, so another agent's name could never be unambiguous.
    session = (await callerAgentDesktops(caller, workspaceId, deps.listSessions)).find((r) => r.name === desktop);
  }
  if (!session) {
    throw new DesktopTargetError(
      'desktop_not_found',
      `no live desktop "${desktop}" ${UUID.test(desktop) ? 'in this workspace' : 'among your desktops'} — ` +
        'computer:list_desktops shows the ids and names you can use',
    );
  }
  const access = desktopAccess({ scope: session.scope, scopeRef: session.scopeRef }, caller, 'drive');
  if (!access.ok) throw new DesktopTargetError(access.code, `${access.reason} (desktop ${session.id})`);
  return session;
}

/**
 * Resolve the desktop a computer verb should drive, or null to fall back to the
 * pot/env chain. Throws DesktopTargetError for an explicit desktop that is missing
 * or not the caller's to drive.
 */
export async function resolveAgentDesktop(
  ctx: DesktopCallerCtx | undefined,
  desktop: string | undefined,
  deps: DesktopTargetDeps = {},
): Promise<ResolvedAgentDesktop | null> {
  const workspaceId = (deps.workspaceId ?? activeWorkspaceId)();
  const getSession = deps.getSession ?? getDesktopSession;
  const listSessions = deps.listSessions ?? listDesktopSessions;
  const caller = desktopCallerFromCtx(ctx);

  const wanted = desktop?.trim();
  if (wanted) {
    return { session: await resolveExplicit(wanted, caller, workspaceId, { getSession, listSessions }), via: 'explicit' };
  }

  const mine = await callerAgentDesktops(caller, workspaceId, listSessions);
  if (mine.length === 0) return null;
  if (mine.length === 1) return { session: mine[0], via: 'only-agent-desktop' };
  const latest = mine.reduce((a, b) => (b.lastActiveAt.getTime() > a.lastActiveAt.getTime() ? b : a));
  return { session: latest, via: 'most-recent-agent-desktop' };
}

/**
 * Mark a desktop as being driven: thaw it if the lifecycle froze it, then touch it.
 * Best-effort on the bookkeeping, but a frozen desktop whose thaw FAILED is reported,
 * since driving it would hang rather than fail.
 */
export async function prepareDesktopForDrive(
  session: DesktopSessionRecord,
  deps: DesktopTargetDeps = {},
): Promise<void> {
  if (session.state === 'frozen' && session.taskId) {
    const thaw = deps.thaw ?? thawTask;
    const markThawed = deps.markThawed ?? markDesktopThawed;
    try {
      await thaw(session.taskId);
      await markThawed(session.id);
    } catch (err) {
      console.warn(`[desktop-target] thawing frozen desktop ${session.id} before driving it failed: ${String(err)}`);
    }
  }
  try {
    await (deps.touch ?? touchDesktopSession)(session.id);
  } catch {
    /* last_active_at is bookkeeping; a missed touch only makes the desktop look idle sooner */
  }
}
