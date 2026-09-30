/**
 * EI-7517 — resolve an omitted `scopeRef` from the CALLER's ctx for the
 * self-scoped fact scopes (owner=me, harness=this harness, role=my role), so an
 * agent asserting / listing / retracting a fact about "just me" needn't look up
 * and pass its own id (the recurring "scope 'owner' requires scope_ref"
 * structural error, watchdog-flagged).
 *
 * Identity is resolved ONLY when a default is actually needed — an explicit
 * scopeRef, or a scope with no ctx default (workspace / work_item), skips the
 * resolve entirely, so a read caller that passes an explicit ref is never
 * forced through attribution (resolveAgentIdentity throws on an unattributable
 * ctx). facts:assert resolves identity anyway (for createdBy) and calls the
 * pure {@link resolveFactScopeRef} directly.
 */
import { resolveFactScopeRef, type FactScope } from '../../agent-facts/store';
import type { ResolveIdentityCtx } from '../coordination/identity';

/**
 * EI-7371 — tolerate common MISNAMED scopeRef aliases instead of silently
 * dropping them. zod strips unrecognized keys before the handler ever sees
 * them, so a caller that typed `scope_ref` (snake_case), bare `ref`, or (for
 * scope:'harness') `harness` — all real, evidenced shapes from
 * harness_shared.tool_invocations, 2026-07-02..04, 13 identical structural
 * errors — got the ref-bearing arg thrown away and then hit "requires
 * scope_ref" despite having supplied a value. Each tool's zod schema must
 * declare these as optional passthrough fields for this to see them; an
 * explicit canonical `scopeRef` always wins over any alias.
 */
export interface ScopeRefAliasArgs {
  scopeRef?: string | null;
  scope_ref?: string | null;
  ref?: string | null;
  harness?: string | null;
}

export function resolveScopeRefAlias(scope: FactScope, args: ScopeRefAliasArgs): string | null | undefined {
  if ((args.scopeRef ?? '').trim()) return args.scopeRef;
  if ((args.scope_ref ?? '').trim()) return args.scope_ref;
  if ((args.ref ?? '').trim()) return args.ref;
  if (scope === 'harness' && (args.harness ?? '').trim()) return args.harness;
  return args.scopeRef;
}

export async function resolveScopeRefFromCtx(
  scope: FactScope,
  scopeRef: string | null | undefined,
  ctx: ResolveIdentityCtx,
): Promise<string | null | undefined> {
  const needsDefault =
    !(scopeRef ?? '').trim() && (scope === 'owner' || scope === 'harness' || scope === 'role');
  if (!needsDefault) return scopeRef;
  const { resolveAgentIdentity, deriveAgentRole } = await import('../coordination/identity');
  const identity = resolveAgentIdentity(ctx);
  return resolveFactScopeRef(scope, scopeRef, {
    ownerId: identity.ownerId,
    harnessSlug: ctx.harnessSlug,
    role: deriveAgentRole(identity),
  });
}
