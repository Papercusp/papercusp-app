/**
 * desktop-ownership.ts — who may release (and, from P-003, drive) which desktop
 * (agent-multi-desktops-grid-2026-10-06 D-005, D-013).
 *
 * The rule, in one place so every computer verb applies the same one:
 *  - an AGENT desktop belongs to the agent whose ownerId is its scope_ref; only that
 *    agent may act on it;
 *  - a POT desktop is the pot's shared desktop: a caller working in that pot may drive
 *    it, and releasing it is a placement act (QUEEN_PLACEMENT_ROLES), as it always was;
 *  - an operator session (superuser, or role 'operator') may act on any desktop in its
 *    workspace, but only by EXPLICIT id — the resolvers never pick another agent's
 *    desktop implicitly;
 *  - a workspace desktop is the product's own desktop and is never handed out here.
 *
 * Pure apart from reading the caller's identity, so the rule unit-tests in isolation.
 */
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { QUEEN_PLACEMENT_ROLES } from '../coordination/roles';
import type { DesktopScope } from '../../desktop/desktop-session-registry';

export type DesktopCallerCtx = ResolveIdentityCtx & { role?: string | null };

export interface DesktopCaller {
  /** The caller's coordination ownerId, or null when the call carries no attributable identity. */
  ownerId: string | null;
  harnessSlug: string | null;
  role: string | null;
  /** Superuser or operator role: may address any workspace desktop by explicit id. */
  isOperator: boolean;
  /** May equip / release a whole pot's shared desktop. A role-less call is an operator door. */
  mayManagePots: boolean;
}

export function desktopCallerFromCtx(ctx: DesktopCallerCtx | undefined): DesktopCaller {
  const c = ctx ?? {};
  let ownerId: string | null = null;
  try {
    ownerId = resolveAgentIdentity(c).ownerId;
  } catch {
    ownerId = null;
  }
  const role = c.role ?? null;
  const isOperator = c.isSuperuser === true || role === 'operator';
  return {
    ownerId,
    harnessSlug: c.harnessSlug ?? null,
    role,
    isOperator,
    mayManagePots: isOperator || role === null || (QUEEN_PLACEMENT_ROLES as readonly string[]).includes(role),
  };
}

export type DesktopAction = 'drive' | 'release';

export type DesktopAccess = { ok: true } | { ok: false; code: 'desktop_not_owned'; reason: string };

export function desktopAccess(
  desktop: { scope: DesktopScope; scopeRef: string },
  caller: DesktopCaller,
  action: DesktopAction,
): DesktopAccess {
  if (desktop.scope === 'workspace') {
    return caller.isOperator
      ? { ok: true }
      : { ok: false, code: 'desktop_not_owned', reason: "the workspace's own desktop is not an agent desktop" };
  }
  if (caller.isOperator) return { ok: true };
  if (desktop.scope === 'agent') {
    return caller.ownerId !== null && desktop.scopeRef === caller.ownerId
      ? { ok: true }
      : { ok: false, code: 'desktop_not_owned', reason: 'this desktop belongs to another agent' };
  }
  // scope 'pot'
  if (action === 'release') {
    return caller.mayManagePots
      ? { ok: true }
      : { ok: false, code: 'desktop_not_owned', reason: "releasing a pot's shared desktop is a placement act (Queen/operator roles)" };
  }
  return caller.harnessSlug !== null && desktop.scopeRef === caller.harnessSlug
    ? { ok: true }
    : { ok: false, code: 'desktop_not_owned', reason: "this is another pot's shared desktop" };
}
