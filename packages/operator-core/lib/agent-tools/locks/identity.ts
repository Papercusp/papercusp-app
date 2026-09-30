/**
 * Resolve the calling SU agent's identity for lock ownership.
 *
 * As of agent-coordination-architecture-v2 (Phase A), L1 identity is
 * owned by the coordination layer's `resolveAgentIdentity` primitive
 * — see `apps/operator/lib/agent-tools/coordination/identity.ts`. The
 * locks subsystem uses the *same* primitive so a held lock and a
 * coordination message authored by the same agent share an `ownerId`.
 *
 * `readIdentity` here is a thin adapter that:
 *   1. Delegates to `resolveAgentIdentity`.
 *   2. Projects the result into the legacy `SuAgentIdentity` shape
 *      (the locks callers destructure `{ ownerId, ownerLabel,
 *      coordinationDomain }` and don't need source / userId).
 *   3. Substitutes `'default'` for a null coordinationDomain — the locks
 *      schema's `coordination_domain` column is NOT NULL.
 *
 * Behaviour notes vs. the historical readIdentity (pre-refactor):
 *
 *   - Labels follow the coordination convention (`omp · pus-…`,
 *     `su · sess-…`, `principal · slug`) — labels are display-only,
 *     never keyed on; this is an intentional unification.
 *
 *   - Power-user callers are now first-class. Pre-refactor they fell
 *     through to the superuser branch (ctx.isSuperuser is also true on
 *     the power-user route); post-refactor they hit the dedicated
 *     `power-user-token` branch in resolveAgentIdentity. ownerId is
 *     identical in both cases (= ctx.uiClientId = auth_session_id).
 */

import {
  resolveAgentIdentity,
  type ResolveIdentityCtx,
} from '../coordination/identity';
import { fileLockCoordinationDomain, lockCoordinationDomain } from './coordination-domain';

/**
 * Loose ctx type — read-only access to the fields we need. Wraps the
 * coordination's `ResolveIdentityCtx`; kept as a re-export so existing
 * imports (`from './identity'`) still compile.
 */
export type IdentityCtx = ResolveIdentityCtx;

export interface SuAgentIdentity {
  /** Stable durable identity — used as the `owner` column. */
  ownerId: string;
  /** Human-readable label — used as the `owner_label` column. */
  ownerLabel: string;
  /**
   * File-lock coordination domain — the canonical repo root (NOT the workspace).
   * File locking is a physical-file concern, so it must be workspace-INDEPENDENT
   * (D-015): two workspaces importing the same harness, or an SU agent and a
   * worker, editing the same file must serialize on the same key. See
   * `lockCoordinationDomain()`.
   */
  coordinationDomain: string;
}

/**
 * Read identity from the agent's tool context. Adapter around
 * `resolveAgentIdentity` — see the file header.
 *
 * `coordinationDomain` is deliberately the repo root, NOT `workspaceId`: keying
 * file locks by workspace silently split the same physical file across namespaces
 * for the (in-spec) multi-workspace-same-harness case → no serialization → clobber
 * (D-015). The owner identity still flows from the coordination layer.
 */
export function readIdentity(ctx: IdentityCtx): SuAgentIdentity {
  const id = resolveAgentIdentity(ctx);
  return {
    ownerId: id.ownerId,
    ownerLabel: id.ownerLabel,
    coordinationDomain: lockCoordinationDomain(),
  };
}

/**
 * Identity for a FILE-lock operation — identical to {@link readIdentity} except
 * that `coordinationDomain` is the tree agents EDIT
 * ({@link fileLockCoordinationDomain}) rather than the tree the operator process
 * is RUNNING ({@link lockCoordinationDomain}).
 *
 * WI-38252: those two are the same directory on a dev operator launched from the
 * staging tree, and DIFFERENT on `:3070`, which serves every SU agent while
 * running from the release checkout. Defaulting a file lock to the running
 * tree put every deliberate agent lock in a namespace the PreToolUse guard
 * never reads — `locks:acquire` granted paths a live peer held, and the
 * holder's own `locks:release` could not see the lock being enforced against
 * them.
 *
 * Every surface that touches the FILE-lock store must resolve its default
 * domain through THIS function, so the verb's verdict and the guard's verdict
 * are computed from one authority and cannot disagree again. RESOURCE locks
 * keep {@link readIdentity} — re-keying them would orphan live holds (see
 * `hostGlobalLockDomain`).
 */
export function readFileLockIdentity(ctx: IdentityCtx): SuAgentIdentity {
  const id = resolveAgentIdentity(ctx);
  return {
    ownerId: id.ownerId,
    ownerLabel: id.ownerLabel,
    coordinationDomain: fileLockCoordinationDomain(),
  };
}
