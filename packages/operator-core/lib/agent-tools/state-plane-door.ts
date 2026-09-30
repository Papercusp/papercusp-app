/**
 * Shared agent-tool adapter for registry-derived state-plane stamps.
 *
 * Audience construction belongs at the MCP boundary: the registry primitive knows
 * nothing about principals, while every agent-facing door receives the same dispatch
 * context. Keeping this here prevents each adopting door from growing a subtly
 * different fail-open/fail-closed interpretation of role, harness, and owner identity.
 */
import { listCells } from '../cell-registry';
import { stampStatePlane, type StatePlaneBlock } from '../state-plane-stamp';
import { resolveAgentIdentity } from './coordination/identity';

interface DoorContext {
  role?: string | null;
  harnessSlug?: string | null;
}

/**
 * Build a state-plane block for an agent-tool payload. Total: enrichment failure
 * always degrades to no block and never fails the read it decorates.
 */
export function statePlaneForDoor(
  payload: unknown,
  tool: string,
  args: Record<string, unknown>,
  ctx: unknown,
): StatePlaneBlock | null {
  try {
    const c = (ctx ?? {}) as DoorContext;
    let reader = {
      ownerId: '',
      roles: c.role ? [c.role] : [],
      harnessSlug: c.harnessSlug ?? undefined,
    };
    try {
      reader = { ...reader, ownerId: resolveAgentIdentity(c as never).ownerId };
    } catch {
      // `requirePrincipal:false` tools legitimately reach this path. Retain the
      // dispatch-known role/harness audience and fail closed on owner-scoped cells.
    }
    return stampStatePlane({
      payload,
      tool,
      args,
      cells: listCells(reader),
      reader,
    });
  } catch {
    return null;
  }
}
