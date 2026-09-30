/**
 * BrightDataProvider — STUB. The D-001 fallback egress vendor (`gateway-live-control-and-egress-plan
 * -2026-06-20`: "Bright Data is the fallback if Rayobyte pool reputation underperforms in verify").
 *
 * Not implemented — there is no live Bright Data account, no chosen API shape, and per the plan this
 * is only meant to be wired IF/WHEN Rayobyte's pool underperforms in the clean-IP gate
 * (`accounts:test-egress`). Registering the name here (rather than leaving `'brightdata'` unhandled)
 * means `egress:provision {provider:'brightdata'}` fails with a clear, actionable error instead of an
 * "unknown provider" dead end — and gives the eventual implementation a single, obvious file to land
 * in without touching the `EgressProviderName` union or the `egress:*` tool surface.
 */
import type { EgressAllocation, EgressHealth, EgressProvider } from './types';

const NOT_IMPLEMENTED =
  "egress: BrightDataProvider is a stub (D-001 fallback path) — not implemented. Wire it when the " +
  'Rayobyte pool underperforms in verify (accounts:test-egress) per gateway-live-control-and-egress-' +
  'plan-2026-06-20; until then use provider:"rayobyte" or provider:"static".';

export function createBrightDataProvider(): EgressProvider {
  return {
    name: 'brightdata',
    allocate(_accountId: string): Promise<EgressAllocation> {
      return Promise.reject(new Error(NOT_IMPLEMENTED));
    },
    release(_id: string): Promise<void> {
      return Promise.reject(new Error(NOT_IMPLEMENTED));
    },
    // Safe to answer truthfully even unimplemented: there is nothing provisioned, so an empty list is
    // correct (not a lie), and lets `egress:list {provider:'brightdata'}` be a harmless no-op probe.
    list(): Promise<EgressAllocation[]> {
      return Promise.resolve([]);
    },
    healthcheck(_id: string): Promise<EgressHealth> {
      return Promise.reject(new Error(NOT_IMPLEMENTED));
    },
  };
}
