/**
 * POST /api/authority/rpc — the receiving endpoint for the per-harness lock
 * authority (Track B of distributed-coordination-shared-harness-2026-06-04).
 *
 * A peer that resolves a REMOTE authority for a harness routes its control op
 * (file-lock acquire/release/queue, plan-item claim lease) here via
 * HttpPeerRpcTransport. This route is the thin HTTP wrapper around the tested,
 * pure `handleAuthorityRpc` dispatch: it parses the {harnessSlug, kind, payload}
 * envelope, re-verifies THIS machine is actually the authority for that harness
 * (refusing a mis-routed op during a failover gap), runs the registered op
 * handler against the local store, and returns the result.
 *
 * auth: 'public' mirrors the sibling coord routes — the operator binds 127.0.0.1
 * by default and cross-machine access arrives over the authenticated mesh/tunnel
 * (the same posture as the lock hook POSTing to :3070). The verifyIsAuthority
 * guard is the app-level check that this machine should serialize the op at all.
 *
 * EI-322: the CALLER is now authenticated too. When the `papercusp-authority-rpc-signed`
 * flag is ON (default), the handler requires an Ed25519-signed envelope (`auth`):
 * `buildAuthorityCallerVerifier` proves the caller controls `device_pubkey`,
 * binds it to the op's `holderPubkey`, and refuses a revoked device — closing the
 * self-reported-holder hole that EI-284's revocation gate alone could not. The
 * transport always signs (transport-wiring), so enabling is safe single-box; the
 * flag is the cross-machine rollout lever. OFF = legacy (verifyIsAuthority +
 * EI-284 only). EI-322 supersedes EI-284 as the tracking item for this surface.
 *
 * Reachability only LIGHTS UP cross-machine once a PeerAddressResolver maps a
 * peer's device_pubkey to its operator URL (the mesh mapping) and a transport is
 * registered (setPeerRpcTransport) — until then no peer routes here. The dispatch
 * itself is verified by the loopback + two-instance authority tests.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { handleAuthorityRpc, type AuthorityRpcEnvelope } from '../../../authority/authority-op-registry';
import { lockAuthorityFor } from '../../../authority/lock-authority';
import { buildAuthorityCallerVerifier } from '../../../authority/verify-authority-caller';

export default defineTool({
  method: 'POST',
  path: '/authority/rpc',
  // PUBLIC by design (auth-tier Wave-1 named exception): peers route remote
  // authority ops here cross-machine via HttpPeerRpcTransport — a loopback
  // tier would break the federated lock authority. The verifyIsAuthority
  // check + the mesh transport are the transport-level perimeter; the
  // caller-authentication (EI-322, flag-gated) is the application-level one.
  auth: 'public',
  async handler(req) {
    let body: AuthorityRpcEnvelope;
    try {
      body = (await req.json()) as AuthorityRpcEnvelope;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    if (!body || typeof body.harnessSlug !== 'string' || typeof body.kind !== 'string') {
      return Response.json({ ok: false, error: 'invalid_envelope' }, { status: 400 });
    }
    // EI-322: require a valid signed caller envelope when enforcement is on.
    const requireSigned = await getFlag(FLAGS.AUTHORITY_RPC_SIGNED, 'system');
    const result = await handleAuthorityRpc(body, {
      verifyCaller: requireSigned ? buildAuthorityCallerVerifier() : undefined,
      // Refuse an op we shouldn't serialize: a peer may have routed here during a
      // failover gap when we are no longer the authority for this harness.
      verifyIsAuthority: async (harnessSlug) => {
        const r = await lockAuthorityFor(harnessSlug);
        return r.isSelf;
      },
    });
    return Response.json(result);
  },
});
