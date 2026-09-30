/**
 * EgressProvider — the pluggable-backend abstraction for PROGRAMMATIC egress-IP provisioning
 * (B-PROV, deferred residue of B-GW-ACCT / `gateway-live-control-and-egress-plan-2026-06-20` Phase 3,
 * WI-288).
 *
 * Context: per-account egress (each Claude Max subscription routed through its own outbound IP, so
 * Anthropic's per-IP opus throttle becomes per-ACCOUNT instead of pool-wide) is already fully wired —
 * see `inference-gateway-per-account-egress-ips.mdx`. Today the IPs themselves are provisioned
 * MANUALLY (an owner buys/rents them, then hand-runs `accounts:register{egress}`). This module is the
 * automation layer on top: a common interface so "get me a fresh egress IP for account X" can be
 * satisfied by different backends (a fixed owner-supplied list, a REST proxy-provider API, …) without
 * the caller (the `egress:*` agent tools, `agent-tools/egress/egress.ts`) caring which.
 *
 * Every implementation is READ/WRITE against the PROVIDER's own state (an IP inventory, a REST API's
 * resource list, …) — it does NOT itself touch the account pool. Wiring a fresh allocation onto an
 * account (so the gateway actually uses it) is the caller's job (`egress:provision`), which is also
 * why `accountId` only flows IN to `allocate` as a hint/label, never as the provider's source of truth
 * for "what account is this" — the account pool (`harness_shared.operator_account_pool`) stays THE
 * single source of truth for live routing (D-002 of the parent plan).
 */

/** One egress binding a provider has allocated (or could allocate) — the provider-native unit. */
export interface EgressAllocation {
  /** Provider-native identifier for this specific allocation — the `release`/`healthcheck` key. */
  id: string;
  /** http(s)/socks forward-proxy URL for this allocation, if it is a proxy-shaped binding. */
  proxyUrl?: string;
  /** Local source IP to bind to, if it is a bound-IP-shaped binding (mutually exclusive with proxyUrl
   *  in practice, but both are optional — a provider that returns neither produced no usable binding). */
  localAddress?: string;
  /** Which account currently holds this allocation, if any (undefined ⇒ free/unassigned). */
  accountId?: string;
  /** Provider-reported metadata (region, ASN, order id, …) — opaque passthrough for observability. */
  meta?: Record<string, unknown>;
}

/** The result of probing whether an allocation's binding is actually reachable right now. */
export interface EgressHealth {
  /** True iff a request routed through this binding's dispatcher got a response. */
  reachable: boolean;
  /** The exit IP an echo endpoint saw through this binding, when reachable. */
  exitIp?: string;
  /** Failure detail when !reachable (network error, timeout, provider lookup failure, …). */
  error?: string;
}

/**
 * The pluggable backend interface every `EgressProvider` implements: allocate/release/list/healthcheck.
 * Implementations: `StaticListProvider` (a fixed owner-supplied inventory — the realistic near-term
 * backend, since the 8 Rayobyte IPs in production today were provisioned exactly this way),
 * `RayobyteProvider` (REST-driven order/list/release against Rayobyte's API — D-001's primary
 * provider), `BrightDataProvider` (stub — the D-001 fallback path, wired when/if Rayobyte pool
 * reputation underperforms in verify; not yet implemented).
 */
export interface EgressProvider {
  /** Stable provider identity (matches the `provider` discriminator in `egress:*` tool args and the
   *  `AccountEgress.providerId` correlation field). */
  readonly name: string;
  /**
   * Allocate an egress binding for `accountId`. Implementations SHOULD be idempotent per accountId
   * where the backend allows it (a repeat call for an account that already holds an allocation returns
   * that SAME allocation rather than handing out a second one). Throws when the backend has no capacity
   * (pool exhausted / API rejected the order / …) — callers should surface that, not swallow it.
   */
  allocate(accountId: string): Promise<EgressAllocation>;
  /** Release an allocation back to the provider (frees it for reuse elsewhere). Idempotent: releasing
   *  an already-free or unknown id should not throw. */
  release(id: string): Promise<void>;
  /** List every allocation this provider currently knows about (assigned + free). */
  list(): Promise<EgressAllocation[]>;
  /** Liveness/reachability check for ONE allocation. Read-only — never mutates provider state. */
  healthcheck(id: string): Promise<EgressHealth>;
}
