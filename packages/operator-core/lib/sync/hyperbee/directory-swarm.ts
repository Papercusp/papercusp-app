/**
 * directory-swarm.ts — the Hyperswarm transport for the P2P HIVE DIRECTORY
 * (p2p-hive-directory-2026-06-06 P-003 boot-join).
 *
 * The directory is GOSSIP, not log-replication: peers join directory topics
 * (derive-hive-topic.ts — the global topic + invite-scoped topics) and exchange
 * signed `SignedHiveAnnounce` frames over a dedicated Protomux protocol
 * (`papercusp/hive-directory`). Unlike the per-harness substrate
 * (joinHarnessSwarm — corestore.replicate + the `papercusp/announce`
 * log-binding channel), the directory does NO corestore replication: there is
 * nothing to replicate, just announces to gossip.
 *
 * As of cross-machine-coord-parity-and-trust-2026-07-01 P-004 (D-008) the
 * generic chassis lives in topic-gossip.ts (`createTopicGossip<Frame>`) — this
 * module pioneered the pattern and is now its announce INSTANTIATION
 * (presence-gossip is the second). Every load-bearing design note — one muxer
 * per Noise stream, per-(protocol,topic) channels, lazy-accept pairing,
 * existing-connection seeding (WI-647), the two-speed discovery-refresh loop
 * (the only driver that connects a standalone transport) — lives in
 * topic-gossip.ts verbatim. The public API here is unchanged: existing callers
 * (hive-directory-boot.ts) and tests are untouched.
 */

import type { HyperswarmLike } from './swarm';
import type { SignedHiveAnnounce } from './hive-announce';
import {
  createTopicGossip,
  type TopicGossipHandle,
  DEFAULT_REFRESH_MS,
  DEFAULT_FAST_WINDOW_MS,
  DEFAULT_SLOW_REFRESH_MS,
} from './topic-gossip';

/** Protomux protocol id for the hive-directory gossip exchange. */
export const HIVE_DIRECTORY_PROTOCOL = 'papercusp/hive-directory';

export { DEFAULT_REFRESH_MS, DEFAULT_FAST_WINDOW_MS, DEFAULT_SLOW_REFRESH_MS };

export type DirectoryGossipHandle = TopicGossipHandle<SignedHiveAnnounce>;

export interface CreateDirectoryGossipOpts {
  /** The shared process swarm (getSharedSwarm()); a fake in tests. */
  swarm: HyperswarmLike;
  /** Handle an inbound announce (→ HiveDirectory.ingestAnnounce). */
  onAnnounce: (frame: SignedHiveAnnounce) => void | Promise<unknown>;
  /** The announces to send a freshly-paired peer on ONE topic — scoped to that
   *  topic so a global-topic pair only ever receives PUBLIC hives and an
   *  invite-topic pair only that invite's hive(s). */
  getOwnAnnounces: (topicHex: string) => SignedHiveAnnounce[] | Promise<SignedHiveAnnounce[]>;
  /** FAST per-topic discovery-refresh cadence (ms). Default DEFAULT_REFRESH_MS; 0 disables refreshing entirely. */
  refreshMs?: number;
  /** How long the fast cadence runs after a join / last-peer loss (ms). Default DEFAULT_FAST_WINDOW_MS. */
  fastWindowMs?: number;
  /** Steady-state keepalive cadence once the fast window lapses (ms). Default DEFAULT_SLOW_REFRESH_MS. */
  slowRefreshMs?: number;
}

/**
 * Create the directory gossip over the shared swarm. One instance per process —
 * topics are joined/left through the handle.
 */
export function createDirectoryGossip(opts: CreateDirectoryGossipOpts): DirectoryGossipHandle {
  if (!opts.swarm) throw new Error('createDirectoryGossip: swarm required');
  return createTopicGossip<SignedHiveAnnounce>({
    swarm: opts.swarm,
    protocol: HIVE_DIRECTORY_PROTOCOL,
    onFrame: opts.onAnnounce,
    getHelloFrames: opts.getOwnAnnounces,
    name: 'createDirectoryGossip',
    refreshLabel: 'directory-swarm-refresh',
    refreshMs: opts.refreshMs,
    fastWindowMs: opts.fastWindowMs,
    slowRefreshMs: opts.slowRefreshMs,
  });
}
