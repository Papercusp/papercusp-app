/**
 * Resource-level authorization seam — RFC `tooldef-auth-rfc-2026-05-31`, Phase 1.
 *
 * The coarse gates already live in the dispatch stack (`dispatch-stack.ts`): the agent
 * `roleAllowlist`, the `capability` gate, `harness`, and `quota`. What the framework
 * lacks is the *fine-grained* layer: "can THIS principal act on THIS resource"
 * (ownership / ReBAC / ABAC). Today such a check has nowhere to go but a tool's handler
 * body.
 *
 * This module is that seam's CONTRACT. It is deliberately POLICY-AGNOSTIC: tooldef is
 * the PEP (enforcement point); the *decision* is supplied by the host — either as an
 * in-process closure or by delegating to an external PDP (OPA / Cedar / OpenFGA /
 * Cerbos / an AuthZEN-compliant engine). tooldef ships the contract + one trivial
 * owner-check helper and **no policy engine** (shipping one would be the
 * lowest-common-denominator trap).
 *
 * SCOPE — this is additive and changes no behavior. The dispatch-stack *enforcement*
 * step (a `DispatchStep` that runs a tool's `authorize` after the existing gates, fails
 * closed, and composes with `GateBypass`) is **Phase 1b**, gated on RFC decision **D-F**
 * (`GateBypass.policy`) and on the tooldef owner's review of where the step sits in the
 * stack. Until then, this module just lets hosts (and Restart) author `PolicyDecisionPoint`
 * implementations + `authorize`-shaped functions against a stable contract.
 *
 * Uses the CURRENT `Principal` (identity = `slug`); the generic `Principal<TKind>` /
 * `roles` / `attributes` evolution is RFC Phase 2 and orthogonal to this contract.
 */
import type { Principal } from './types';

/**
 * An authorization query, shaped after the OpenID AuthZEN model
 * ("can {subject} do {action} on {resource}?") so an AuthZEN/OPA/Cedar/OpenFGA PDP can
 * back it without reshaping (RFC D-C — wiring an external engine is deferred; the shape
 * is chosen now so it won't need to change then).
 */
export interface AuthzQuery {
  /** The resolved caller (current `Principal`; identity is `principal.slug`). */
  principal: Principal;
  /** The operation — typically the tool name, or a finer-grained verb. */
  action: string;
  /** The thing being acted on. Omit for actions with no specific resource. */
  resource?: {
    type: string;
    id?: string;
    attributes?: Readonly<Record<string, unknown>>;
  };
  /** Extra decision inputs (request/context attributes for ABAC). */
  context?: Readonly<Record<string, unknown>>;
}

/**
 * The decision. `reason` feeds the audit trail; `obligations` carry post-allow
 * constraints a handler must apply (e.g. a row filter), à la XACML/AuthZEN obligations.
 */
export interface AuthDecision {
  allow: boolean;
  reason?: string;
  obligations?: Readonly<Record<string, unknown>>;
}

/**
 * Policy Decision Point. The host implements this in-process (a closure) or adapts it to
 * an external engine. The framework *calls* it and never ships one — it stays
 * policy-agnostic, exactly as `GateBypass` keeps the engine ignorant of *why* a caller
 * is privileged.
 */
export interface PolicyDecisionPoint {
  decide(query: AuthzQuery): Promise<AuthDecision> | AuthDecision;
}

/**
 * A tool's resource-authorization hook (RFC Phase 1b). Returns an `AuthDecision` for
 * "can THIS principal perform THIS call". The dispatcher runs it AFTER the coarse gates
 * (role / capability / harness / quota) and BEFORE the handler, fails closed if it
 * throws, and audits every decision.
 *
 * It runs *in-process* with the tool's `ctx`, so — unlike an external PDP — it can load
 * the resource it needs to decide (the "authorize close to the data" pattern, RFC §8 G1):
 * extract an id from `input`, fetch via `ctx`, decide. For list endpoints, return a row
 * filter via `AuthDecision.obligations` rather than checking each row.
 *
 * `principal` is the dispatch-layer caller identity (`null`/`undefined` for an anonymous
 * call); a resource hook should treat the absent case as deny. It is the *narrow*
 * principal the dispatcher carries (identity = `slug`), not the rich route-layer
 * `Principal` — a hook that wants to query a full `PolicyDecisionPoint` builds an
 * `AuthzQuery` from what it knows. The host may close over a `PolicyDecisionPoint`
 * (in-proc or external engine) inside the hook — the framework neither ships nor assumes
 * one. `TCtx`/`TPrincipal` are the host's context + principal types (Papercusp binds its
 * `UnifiedToolContext`); kept generic so authz.ts imports no host types.
 */
export type Authorizer<TInput = unknown, TCtx = unknown, TPrincipal = unknown> = (args: {
  principal: TPrincipal;
  input: TInput;
  ctx: TCtx;
}) => AuthDecision | Promise<AuthDecision>;

/**
 * One authorization decision, for the audit trail. A first-class invariant of the RFC:
 * every allow AND deny is emitted (when the host wires an audit sink) — auditability is
 * one of the two hard parts of any capability/PDP system. `gate` records which layer
 * decided so denials are attributable.
 */
export interface AuthAuditEvent {
  /** epoch ms — stamped by the dispatcher when it emits the event. */
  ts: number;
  /**
   * The caller as the dispatcher knows it (slug + workspace), or `null` for an anonymous
   * call that still hit an `authorize` gate. Richer identity (kind/trust) is a route-layer
   * concept not carried into dispatch; a host that wants it enriches in its audit sink.
   */
  principal: { slug: string; workspaceId?: string } | null;
  tool: string;
  action: string;
  resource?: { type: string; id?: string };
  decision: 'allow' | 'deny';
  /** Which layer rendered the decision. */
  gate: 'role' | 'capability' | 'harness' | 'quota' | 'authorize' | 'precondition';
  reason?: string;
}

/**
 * The most common resource rule, as a ready-made `PolicyDecisionPoint`: allow iff the
 * principal owns the resource. `getOwnerId` extracts the owner id from the resource
 * (default: `resource.attributes.ownerId`); ownership is compared against
 * `principal.slug`. Hosts needing relationship/attribute rules supply their own PDP
 * instead — this is the floor, not the ceiling.
 */
export function ownerOnly(
  getOwnerId: (resource: NonNullable<AuthzQuery['resource']>) => string | undefined = (r) =>
    r.attributes?.ownerId as string | undefined,
): PolicyDecisionPoint {
  return {
    decide(q) {
      if (!q.resource) {
        return { allow: false, reason: 'ownerOnly: no resource to check ownership against' };
      }
      const owner = getOwnerId(q.resource);
      const allow = owner != null && owner === q.principal.slug;
      return allow
        ? { allow: true }
        : {
            allow: false,
            reason: `ownerOnly: principal "${q.principal.slug}" is not the owner (owner: ${owner ?? 'none'})`,
          };
    },
  };
}
