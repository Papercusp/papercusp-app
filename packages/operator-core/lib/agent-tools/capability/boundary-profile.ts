/**
 * Server-resolved trust profile for capability operation boundaries.
 *
 * A caller never supplies this value in tool args.  The host context and the
 * launch-declared session-confinement store are the only inputs, so omitting or
 * forging a request field cannot turn confined work into trusted owner work.
 */
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

import {
  ensureSessionConfinementsReady,
  sessionConfinementFor,
} from '../../capability-envelope/session-confinement-store';
import type { SessionToolConfinement } from '../../capability-envelope/session-confinement';
import {
  resolveAgentIdentity,
  type ResolveIdentityCtx,
} from '../coordination/identity';

export type OperationBoundaryProfile =
  | {
      kind: 'trusted';
      reason: 'superuser' | 'power-user' | 'system-operator' | 'legacy-su-context';
    }
  | {
      kind: 'confined';
      reason: 'session-confinement' | 'autonomous-caller' | 'unattributed-caller';
      confinement?: SessionToolConfinement;
    };

export type BoundaryContext = ResolveIdentityCtx & {
  role?: UnifiedToolContext['role'];
  isSuperuser?: boolean;
  isPowerUser?: boolean;
};

export interface BoundaryProfileDeps {
  declaredConfinement: (
    ctx: BoundaryContext,
  ) => Promise<SessionToolConfinement | null>;
}

const DEFAULT_DEPS: BoundaryProfileDeps = {
  async declaredConfinement(ctx) {
    await ensureSessionConfinementsReady();
    try {
      const ownerId = resolveAgentIdentity(ctx as ResolveIdentityCtx).ownerId;
      return sessionConfinementFor(ownerId);
    } catch {
      return null;
    }
  },
};

/**
 * Resolve whether a real operation may retain the historic raw-host behavior.
 *
 * Launch-declared confinement always wins, including for an su-tier directed
 * implementer.  Otherwise only an authenticated human/admin tier or the
 * in-process operator principal is trusted.  Every autonomous, signed-spawn,
 * role principal, or un-attributable context fails toward confinement.
 */
export async function resolveOperationBoundaryProfile(
  ctx: BoundaryContext,
  deps: BoundaryProfileDeps = DEFAULT_DEPS,
): Promise<OperationBoundaryProfile> {
  let declared: SessionToolConfinement | null;
  // Session-confinement declarations refuse population identities. Without a
  // per-session/verified-spawn identity there cannot be a legal row to find, so
  // skip the PG-backed cache prime entirely (also keeps pure unit callers pure).
  if (ctx.uiClientId || ctx.sigVerifiedSpawn) {
    try {
      declared = await deps.declaredConfinement(ctx);
    } catch {
      // A broken resolver must not silently widen an attributable caller.
      return { kind: 'confined', reason: 'unattributed-caller' };
    }
  } else {
    declared = null;
  }
  if (declared) {
    return { kind: 'confined', reason: 'session-confinement', confinement: declared };
  }

  if (ctx.isPowerUser === true) return { kind: 'trusted', reason: 'power-user' };
  if (ctx.isSuperuser === true) return { kind: 'trusted', reason: 'superuser' };

  // Compatibility for direct/in-process handler contexts used before the
  // transport grew `isSuperuser`: `su` is not an admitted AgentRole in signed
  // spawn URLs, so this cannot be asserted by an autonomous caller.
  if ((ctx.role as string | undefined) === 'su') {
    return { kind: 'trusted', reason: 'legacy-su-context' };
  }

  const principal = ctx.principal;
  if (
    principal?.kind === 'system' &&
    (principal.slug === 'system:operator' || principal.slug === 'operator')
  ) {
    return { kind: 'trusted', reason: 'system-operator' };
  }

  if (principal || ctx.role || ctx.sigVerifiedSpawn) {
    return { kind: 'confined', reason: 'autonomous-caller' };
  }
  return { kind: 'confined', reason: 'unattributed-caller' };
}
