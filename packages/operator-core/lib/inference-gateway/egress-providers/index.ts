/**
 * EgressProvider factory (B-PROV) — picks a backend by name for `egress:*` (`agent-tools/egress/`)
 * and any other caller. See `types.ts` for the interface contract each backend implements.
 */
import { createStaticListProvider, type StaticListEntry } from './static-list-provider';
import { createRayobyteProvider } from './rayobyte-provider';
import { createBrightDataProvider } from './bright-data-provider';
import type { EgressProvider } from './types';

export type { EgressAllocation, EgressHealth, EgressProvider } from './types';
export { createStaticListProvider, type StaticListEntry, type StaticListProviderConfig } from './static-list-provider';
export { createRayobyteProvider, type RayobyteProviderConfig } from './rayobyte-provider';
export { createBrightDataProvider } from './bright-data-provider';
export { probeAllocationHealth, type HealthProbeDeps } from './health-probe';
export { resolveSecretRef } from './secret-ref';

export const EGRESS_PROVIDER_NAMES = ['static', 'rayobyte', 'brightdata'] as const;
export type EgressProviderName = (typeof EGRESS_PROVIDER_NAMES)[number];

/** Provider-specific configuration, merged with each backend's own defaults. `entries` is required
 *  (and validated non-empty) for `'static'`; `baseUrl`/`apiKeyRef` are optional overrides for
 *  `'rayobyte'` (env-var defaults apply); `'brightdata'` takes no config. */
export interface EgressProviderConfigInput {
  entries?: StaticListEntry[];
  baseUrl?: string;
  apiKeyRef?: string;
}

/** Build an `EgressProvider` by name. Throws for `'static'` with no/empty `entries`, or an unknown
 *  provider name. */
export function createEgressProvider(
  provider: EgressProviderName,
  config: EgressProviderConfigInput = {},
): EgressProvider {
  switch (provider) {
    case 'static':
      return createStaticListProvider({ entries: config.entries ?? [] });
    case 'rayobyte':
      return createRayobyteProvider({ baseUrl: config.baseUrl, apiKeyRef: config.apiKeyRef });
    case 'brightdata':
      return createBrightDataProvider();
    default: {
      const exhaustive: never = provider;
      throw new Error(`egress: unknown provider '${String(exhaustive)}' (expected one of: ${EGRESS_PROVIDER_NAMES.join(', ')})`);
    }
  }
}
