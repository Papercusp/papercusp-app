/**
 * federation-probe-canary — the P-011 "stamped canary probe through the fed
 * pipeline" concrete instance, built on P-010's probe:emit apparatus
 * (fleet-reliability-verification-2026-07-10 P-011, after P-010/WI-3812).
 *
 * Scope (deliberately conservative): this canary proves the STAMPING +
 * PERSISTENCE apparatus itself — exactly the class of defect cause #10 was
 * (every prior probe was UNSTAMPED, so a probe silently proved nothing). It
 * emits a probe against a KNOWN-FEDERATED harness and confirms `stampProbe`
 * does not refuse and the stamped probe persists cleanly. It does NOT attempt
 * a live cross-machine round trip (that needs a real federated peer and is
 * out of reach of a periodic in-process canary) — a caller that also wants a
 * federation-health system signal supplies real outbox drain, merge-cursor,
 * and fresh remote-origin evidence separately as this canary's `systemGreen`
 * input to `runGateCanary`.
 */
import { stampProbe, type StampedProbe } from '../sync/pot-git/federation-probe';
import type { GateCanaryDef } from './canary';

export interface FederationProbeCanaryDeps {
  workspaceId: string;
  harnessSlug: string;
  emittedBy: string;
  /** Resolve whether `harnessSlug` is actually federated (isRegisteredHive at the call site). */
  harnessIsFederated: () => Promise<boolean>;
  /** Persist the stamped probe — injected so this canary is unit-testable without PG. */
  insertProbe: (stamped: StampedProbe) => Promise<unknown>;
  /** Injected clock seam for deterministic tests. Default Date.now. */
  nowMs?: () => number;
}

/** Build the GateCanaryDef — pass to `runGateCanary` / `runGateCanaries`. */
export function buildFederationProbeCanary(deps: FederationProbeCanaryDeps): GateCanaryDef {
  return {
    id: `federation-probe:${deps.harnessSlug}`,
    describe: `stamped canary probe through the fed-pipeline stamping apparatus (${deps.harnessSlug})`,
    run: async () => {
      const nowMs = (deps.nowMs ?? Date.now)();
      let harnessIsFederated: boolean;
      try {
        harnessIsFederated = await deps.harnessIsFederated();
      } catch (e) {
        return { ok: false, detail: `harness-federation lookup failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      const result = stampProbe({
        workspaceId: deps.workspaceId,
        harnessSlug: deps.harnessSlug,
        emittedBy: deps.emittedBy,
        harnessIsFederated,
        nowMs,
      });
      if (!result.ok) {
        return { ok: false, detail: `probe refused: ${result.reason} — ${result.detail}` };
      }
      try {
        await deps.insertProbe(result.stamped);
      } catch (e) {
        return { ok: false, detail: `probe stamped but persistence failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      return { ok: true, detail: `probe ${result.stamped.probeKey} stamped + persisted cleanly` };
    },
  };
}
