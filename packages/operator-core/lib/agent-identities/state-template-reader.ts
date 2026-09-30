/** Host adapter for identity templates: canonical cell visibility + normal tool authority. */
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { readCell } from '../cell-read';
import { resolveConcreteHarnessSlug } from '../agent-tools/_harness-scope';
import type { IdentityTemplateCellReader } from './state-template';

export interface IdentityTemplateWearer {
  ownerId: string;
  context: UnifiedToolContext;
  /** Live pot/role ceiling resolved by the host, never authored in the template. */
  capabilityCeiling: ReadonlySet<string>;
  workItems?: string[];
}

/** Resolve authority immediately before every read; a closure must not pin old grants
 * across invocations, detach, or recovery. The template contains no authority fields. */
export function createIdentityTemplateCellReader(input: {
  resolveWearer: () => Promise<IdentityTemplateWearer>;
  declaredNeeds: readonly string[];
}): IdentityTemplateCellReader {
  const needs = new Set(input.declaredNeeds);
  return async (reference, signal) => {
    const unavailable = () => ({ status: 'unknown' as const, cell: reference.cell,
      unknown: { code: 'not-measured' as const, detail: 'identity template wearer authority is unavailable' } });
    if (signal.aborted) return unavailable();
    const wearer = await input.resolveWearer();
    const ctx = wearer.context;
    if (signal.aborted || ctx.signal.aborted || !wearer.ownerId || !ctx.principal || !ctx.workspaceId || !ctx.role ||
        ctx.principal.workspaceId !== ctx.workspaceId) return unavailable();

    const sets = [ctx.principal.capabilities, needs, wearer.capabilityCeiling];
    const candidates = new Set(sets.flatMap((set) => [...set]));
    const capabilities = new Set([...candidates].filter((cap) =>
      sets.every((set) => set.has(cap) || set.has('*'))));
    const combinedSignal = AbortSignal.any([signal, ctx.signal]);
    const callerContext: UnifiedToolContext = {
      ...ctx, gateBypass: undefined, isSuperuser: false, signal: combinedSignal,
      principal: { ...ctx.principal, capabilities },
    };
    // A superuser context carries the '*' sentinel, which is truthy but names no
    // harness; resolve it to a concrete slug (or null) before it becomes identity.
    const harnessSlug = resolveConcreteHarnessSlug(undefined, ctx);
    return readCell(reference.cell, {
      ownerId: wearer.ownerId,
      roles: [ctx.role],
      ...(harnessSlug ? { harnessSlug } : {}),
      ...(wearer.workItems ? { workItems: wearer.workItems } : {}),
    }, {
      workspaceId: ctx.workspaceId, harnessSlug,
      role: ctx.role, callerContext, signal: combinedSignal,
    }, reference.subject);
  };
}
