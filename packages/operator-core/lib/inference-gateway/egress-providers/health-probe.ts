/**
 * Shared EgressProvider health probe (B-PROV) — builds the SAME undici dispatcher the gateway would
 * use for a binding and echoes the exit IP through it, reusing `egress-probe.ts`'s `fetchExitIp` so
 * this never drifts from the account-level clean-IP gate (`accounts:test-egress`). Every
 * `EgressProvider.healthcheck` implementation should route through this instead of hand-rolling a
 * second fetch-through-dispatcher path.
 */
import { fetchExitIp, type ProbeDeps } from '../egress-probe';
import type { EgressAllocation, EgressHealth } from './types';

export type HealthProbeDeps = ProbeDeps;

/** Probe one allocation's reachability: `{ reachable, exitIp }` on success, `{ reachable:false, error }`
 *  when the binding is missing, unreachable, or times out. Never throws. */
export async function probeAllocationHealth(
  allocation: Pick<EgressAllocation, 'proxyUrl' | 'localAddress'>,
  deps: HealthProbeDeps = {},
): Promise<EgressHealth> {
  if (!allocation.proxyUrl && !allocation.localAddress) {
    return { reachable: false, error: 'no_egress_binding' };
  }
  const { exitIp, error } = await fetchExitIp(
    { proxyUrl: allocation.proxyUrl, localAddress: allocation.localAddress },
    deps,
  );
  if (error || !exitIp) return { reachable: false, error: error ?? 'no_exit_ip' };
  return { reachable: true, exitIp };
}
