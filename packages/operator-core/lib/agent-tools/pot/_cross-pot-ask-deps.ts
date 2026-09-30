/**
 * _cross-pot-ask-deps — the PRODUCTION wiring of the cross-Pot front-door tools
 * (hive-network-surface-2026-06-11 P-003, brief B-04). Binds the injectable ports
 * of `cross-hive-ask-send` to their live implementations:
 *
 *   - resolveBoundary    → the boot-wired boundary registry (B-01 registers).
 *   - checkOutboundGrant → B-05's directed-grant `assertOutboundGrant`, adapted to
 *                          the {allowed, reason} port shape (default-deny egress).
 *   - store              → B-02's PG `cross_hive_asks` ledger (C-1).
 *
 * Shared by ask.ts / request_work.ts / asks.ts so the three tools stay thin.
 */
import { getCrossHiveBoundary } from '../../cross-hive-boundary-registry';
import { pgCrossHiveAsksStore, type CrossHiveAsksStore } from '../../cross-hive-asks-store-port';
import { assertOutboundGrant } from '../../cross-hive-grants';
import type { CheckOutboundGrant, SendCrossHiveAskDeps } from '../../cross-hive-ask-send';

/**
 * Adapt B-05's `assertOutboundGrant` ({admitted, reason}) to the port's
 * {allowed, reason}. P-013: `bodyBytes` rides through so the grant's size cap
 * (and, inside assertOutboundGrant, the expiry + C-1-counted rate cap) gates
 * the send before any ledger row exists.
 */
const checkOutboundGrant: CheckOutboundGrant = async (ws, potSlug, peerPubkey, kind, bodyBytes) => {
  const verdict = await assertOutboundGrant(ws, potSlug, peerPubkey, kind, undefined, {
    ...(bodyBytes != null ? { bodyBytes } : {}),
  });
  return { allowed: verdict.admitted, reason: verdict.reason };
};

/**
 * Test override of the PG store + grant ports (the boundary always resolves from
 * the real registry). Lets the tool handlers be exercised without PG/a swarm —
 * the same explicit-seam pattern as __clearCrossPotBoundaryRegistry.
 */
let testOverride: { store?: CrossHiveAsksStore; checkOutboundGrant?: CheckOutboundGrant } | null = null;

/** TEST ONLY: substitute the store / grant ports (pass null to restore production). */
export function __setCrossPotAskTestDeps(
  o: { store?: CrossHiveAsksStore; checkOutboundGrant?: CheckOutboundGrant } | null,
): void {
  testOverride = o;
}

/** The live store — backs `pot:asks`. */
export function productionCrossPotAsksStore(): CrossHiveAsksStore {
  return testOverride?.store ?? pgCrossHiveAsksStore;
}

/** The live send deps — backs `pot:ask` / `pot:request_work`. */
export function productionSendCrossPotAskDeps(): SendCrossHiveAskDeps {
  return {
    resolveBoundary: getCrossHiveBoundary,
    checkOutboundGrant: testOverride?.checkOutboundGrant ?? checkOutboundGrant,
    store: testOverride?.store ?? pgCrossHiveAsksStore,
  };
}
