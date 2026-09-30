/**
 * authority-op-registry — the AUTHORITY (receiving) side of the lock-authority
 * RPC (Phase 2 of distributed-coordination-shared-harness-2026-06-04).
 *
 * When a peer routes a control op to a remote authority (routeToAuthority →
 * PeerRpcTransport), the authority's operator receives the {kind, payload}
 * envelope and must RUN the op against ITS local store (its own papercusp_su lock
 * store, or its claim store). This registry maps an op `kind` to the handler that
 * executes it locally. Producers register their handler at boot:
 *
 *   registerAuthorityOp('lock.acquire', async (payload, harness) => locks.acquire(payload));
 *   registerAuthorityOp('claim.lease',  async (payload, harness) => claims.lease(payload));
 *
 * `handleAuthorityRpc` is the pure dispatch the receiving endpoint wraps. Keeping
 * it pure (no HTTP) makes the whole remote leg testable over a loopback server
 * without the Hono host.
 *
 * SECURITY NOTE: a real cross-machine deployment must authenticate the caller
 * (the operator endpoints are bearer-gated + the mesh is authenticated) AND
 * re-verify that THIS machine is actually the elected authority for `harnessSlug`
 * before running the op (a peer could mis-route during a failover gap). The
 * `verifyIsAuthority` hook does the latter; pass it so the authority refuses ops
 * it shouldn't serialize.
 */

import type { AuthorityRpcAuth } from './authority-rpc-envelope';

export interface AuthorityRpcEnvelope {
  harnessSlug: string;
  kind: string;
  payload: unknown;
  /** EI-322: the optional Ed25519-signed caller-auth wrapper. Present when the
   *  sender signs (HttpPeerRpcTransport with a `signEnvelope`); verified by the
   *  receiving route's `verifyCaller`. Absent for in-process rigs that call
   *  `handleAuthorityRpc` directly without a verifyCaller hook. */
  auth?: AuthorityRpcAuth;
}

/** A handler that executes one op kind locally on the authority. */
export type AuthorityOpHandler = (payload: unknown, harnessSlug: string) => Promise<unknown>;

/** Per-op registration options. */
export interface RegisterAuthorityOpOpts {
  /**
   * The op is a PEER-TO-PEER op any peer answers, NOT an authority-only op — so
   * {@link handleAuthorityRpc} skips the `verifyIsAuthority` gate for it (P-016
   * `peer.probe`: a relay liveness query answerable by a non-authority peer).
   * The caller-signature gate (verifyCaller) still applies.
   */
  authorityExempt?: boolean;
}

const _handlers = new Map<string, AuthorityOpHandler>();
const _exempt = new Set<string>();

/** Register the handler for one op kind. Throws on a duplicate (a programming
 *  error — two producers claiming the same kind). */
export function registerAuthorityOp(
  kind: string,
  handler: AuthorityOpHandler,
  opts: RegisterAuthorityOpOpts = {},
): void {
  if (!kind) throw new Error('registerAuthorityOp: kind required');
  if (_handlers.has(kind)) throw new Error(`registerAuthorityOp: kind '${kind}' already registered`);
  _handlers.set(kind, handler);
  if (opts.authorityExempt) _exempt.add(kind);
}

/** The kinds currently registered (debug / tests). */
export function registeredAuthorityOpKinds(): string[] {
  return [..._handlers.keys()].sort();
}

/** The kinds registered as authority-exempt (peer-to-peer, skip verifyIsAuthority). */
export function getAuthorityExemptKinds(): ReadonlySet<string> {
  return _exempt;
}

/** Test-only: clear the registry. */
export function __resetAuthorityOpsForTests(): void {
  _handlers.clear();
  _exempt.clear();
}

export interface HandleAuthorityRpcResult {
  ok: boolean;
  result?: unknown;
  /** Set when ok is false — a machine-readable reason. */
  error?: 'unknown_kind' | 'not_authority' | 'handler_error' | 'unauthenticated';
  message?: string;
}

/** The verdict from a caller-auth check (EI-322). On success it returns the
 *  PROVEN device pubkey so callers can log / further-bind it. */
export type VerifyCallerResult = { ok: true; devicePubkey: string } | { ok: false; reason: string };

export interface HandleAuthorityRpcOpts {
  /** Re-verify THIS machine is the authority for the harness before running the
   *  op (refuses a mis-routed op during a failover gap). Default: allow. */
  verifyIsAuthority?: (harnessSlug: string) => Promise<boolean> | boolean;
  /**
   * EI-322: authenticate the CALLER before running the op. Verifies `env.auth`'s
   * Ed25519 signature + freshness, that the proven device is not revoked, and
   * that it matches the op's claimed holder. Runs BEFORE verifyIsAuthority (an
   * unauthenticated caller learns nothing about our authority status). Default:
   * skip (in-process rigs dispatch unauthenticated); the real route always wires
   * it (flag-gated).
   */
  verifyCaller?: (env: AuthorityRpcEnvelope) => Promise<VerifyCallerResult> | VerifyCallerResult;
  /**
   * Dispatch against these handlers instead of the process-global registry.
   * Lets a multi-instance rig (cross-machine E2E) give each simulated machine
   * its own handler set — a single process can only hold one global registry.
   */
  handlers?: Record<string, AuthorityOpHandler>;
  /**
   * Op kinds that skip the `verifyIsAuthority` gate (peer-to-peer ops any peer
   * answers — P-016 `peer.probe`). Defaults to the kinds registered with
   * `authorityExempt` ({@link getAuthorityExemptKinds}); a rig using `handlers`
   * passes its own set since it bypasses the global registry.
   */
  authorityExemptKinds?: ReadonlySet<string>;
}

/**
 * Dispatch one received RPC envelope to its registered handler. Pure (no HTTP) —
 * the receiving route/endpoint wraps this. Never throws: a handler error is
 * returned as `{ ok:false, error:'handler_error' }` so the transport surfaces a
 * clean result rather than a 500.
 */
export async function handleAuthorityRpc(
  env: AuthorityRpcEnvelope,
  opts: HandleAuthorityRpcOpts = {},
): Promise<HandleAuthorityRpcResult> {
  const handler = opts.handlers ? opts.handlers[env.kind] : _handlers.get(env.kind);
  if (!handler) return { ok: false, error: 'unknown_kind', message: `no handler for kind '${env.kind}'` };

  // EI-322: authenticate the caller FIRST — before we reveal anything (even our
  // authority status) to an unproven peer.
  if (opts.verifyCaller) {
    let verdict: VerifyCallerResult;
    try {
      verdict = await opts.verifyCaller(env);
    } catch (err) {
      verdict = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (!verdict.ok) {
      return { ok: false, error: 'unauthenticated', message: verdict.reason };
    }
  }

  // Authority-exempt kinds (peer-to-peer ops like `peer.probe`) skip the
  // authority gate — ANY peer answers them, not just the elected authority.
  const exemptKinds = opts.authorityExemptKinds ?? _exempt;
  if (opts.verifyIsAuthority && !exemptKinds.has(env.kind)) {
    let isAuth = false;
    try {
      isAuth = await opts.verifyIsAuthority(env.harnessSlug);
    } catch {
      isAuth = false;
    }
    if (!isAuth) {
      return { ok: false, error: 'not_authority', message: `this machine is not the authority for harness '${env.harnessSlug}'` };
    }
  }

  try {
    const result = await handler(env.payload, env.harnessSlug);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: 'handler_error', message: err instanceof Error ? err.message : String(err) };
  }
}
