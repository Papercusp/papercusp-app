/**
 * network-board/tier-classifier — the ONE canonical map from a hive-context's
 * provenance to its capability tier + trust label (D-001, brief B-08 / C-3).
 *
 * Exported and shared: B-08 builds the aggregate board with it, and B-11
 * re-renders the HUD Hives tab with it so federated peers (tier 3, substrate-
 * verified) and foreign directory hives (tier 4, self-reported gossip) are
 * classified identically in both places — never a fork that lets the two
 * surfaces disagree on what "trusted" means (swarm protocol: B-11 shares this
 * classifier, no forks).
 *
 * Pure: a tagged provenance in, { tier, trust } out. No IO — unit-testable.
 */

import type { NetworkTier, NetworkTrust } from './types';

/**
 * Where a row's data came from — the only input that decides its tier. A local
 * `kind:'hive'` project is tier 1 IFF it is THIS Swarm's home hive (`isHome`),
 * else tier 2 (an own other hive on the same box). Federated presence peers are
 * tier 3; foreign directory hives are tier 4.
 */
export type NetworkSource =
  | { kind: 'local-hive'; isHome: boolean }
  | { kind: 'federated-peer' }
  | { kind: 'foreign-hive' };

export interface NetworkClassification {
  tier: NetworkTier;
  trust: NetworkTrust;
}

/**
 * Classify a hive-context into its capability tier + trust label. The trust is a
 * deterministic function of the tier (1→local, 2→admin, 3→federated, 4→gossip),
 * exposed on the row so renderers don't re-derive it.
 */
export function classifyNetworkTier(source: NetworkSource): NetworkClassification {
  switch (source.kind) {
    case 'local-hive':
      return source.isHome
        ? { tier: 1, trust: 'local' }
        : { tier: 2, trust: 'admin' };
    case 'federated-peer':
      return { tier: 3, trust: 'federated' };
    case 'foreign-hive':
      return { tier: 4, trust: 'gossip' };
  }
}

/** The trust label paired to a tier (the same mapping classifyNetworkTier uses).
 *  Handy for renderers that already know the tier and just need the badge. */
export function trustForTier(tier: NetworkTier): NetworkTrust {
  switch (tier) {
    case 1:
      return 'local';
    case 2:
      return 'admin';
    case 3:
      return 'federated';
    case 4:
      return 'gossip';
  }
}
