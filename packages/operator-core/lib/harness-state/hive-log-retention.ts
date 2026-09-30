/**
 * hive-log-retention — the per-kind STORAGE TIER + RETENTION CLASS registry for
 * everything that rides the hive peer log (plan shared-pot-dao-cupboard-v1-2026-09-04,
 * P-043; decisions D-057, D-058, D-059; bug WI-2147374).
 *
 * WHY THIS EXISTS. The Model-B peer log is an append-only Hypercore with no
 * eviction, truncation, or compaction code anywhere under
 * `lib/sync/hyperbee/` — so every op every admitted peer ever wrote is stored
 * forever by every member. Measured 2026-09-06 (D-057): the `papercusp` harness
 * store is 46 GB after 58 days on ONE machine, 61 GB across the box. Before a
 * hive of strangers is joinable, every kind that rides the log must declare
 * WHERE it belongs (the D-059 tier table) and HOW LONG it is kept.
 *
 * THE REGISTRY IS THE POLICY. `resolveTableSpec(table).sync === 'peer-log'`
 * decides WHETHER a table federates; this module decides WHERE it should live
 * and what its retention class is. `checkHiveLogRetentionCoverage()` asserts the
 * two stay in step, and `doc-claims/hive-log-retention-policy.test.ts` pins it —
 * so a new federated op kind cannot land without a retention class.
 *
 * ── THE AMPLIFICATION, EXPLAINED AND MEASURED (P-043 deliverable) ──────────
 *
 * D-057 recorded the gap as unexplained: ~0.8 GB/day of store growth against
 * "~66 MB/day of row content", a >10x factor. Three measurements close it, and
 * the third overturns D-057's stated cause.
 *
 * (a) A FRESH store does NOT amplify. Probe 2026-09-06 (fresh Corestore, 20,000
 *     single appends of 1,456 B — D-057's measured `coord_event_log` average):
 *     29.1 MB logical → 17.7 MB of SST (RocksDB compresses below 1:1) plus an
 *     un-flushed 51 MB WAL that a running process folds away. So the storage
 *     engine is not the multiplier; per-op overhead is not the multiplier.
 *
 * (b) THE "~66 MB/day" BASELINE WAS ~4x TOO LOW. It summed two tables' PG row
 *     content. The log carries the whole federated set, as wire ENVELOPES.
 *     Measured over `harness_shared.substrate_outbox`, 24h to 2026-09-06,
 *     workspace `papercusp-workspace` / harness `papercusp`: 257 MB/day of
 *     own-log appends across 15 producing tables.
 *
 * (c) THE REAL MULTIPLIER IS VERSION COUNT, NOT MESSAGE COUNT. An append-only
 *     log stores every VERSION of a row; PG stores the current one. Same
 *     measurement, appends ÷ distinct keys:
 *
 *       table                            appends/24h  keys  per key  avg B   MB/day
 *       harness_plans                          1,158    97    11.94  75,865      84
 *       harness_features_consolidated          8,032   250    32.13   9,498      73
 *       engineer_issues                       25,668 6,578     3.90   2,729      67
 *       coord_event_log                       12,597 12,595     1.00   1,416      17
 *       coord_thread_posts                     1,934 1,601     1.21   3,961       7
 *       harness_plan_parts                     4,825 1,695     2.85   1,364       6
 *
 *     Three tables of large, frequently-EDITED rows are 87% of the daily wire
 *     volume, purely because each edit re-appends the whole row. Keeping only
 *     the latest version of each key would cost 97×75,865 + 250×9,498 +
 *     6,578×2,729 ≈ 28 MB/day instead of 224 MB/day — an 87.6% cut ON THOSE
 *     THREE. Across the WHOLE federated set the version multiplier is 4.87x
 *     (79.5% of the day is superseded versions); the gap between the two figures
 *     is the insert-only kinds, which no rotation can compact. 79.5% is the
 *     number a rotation pass has to beat — `summarizeAmplification()` computes
 *     it, and the doc-claim test asserts the whole-set figure so the narrower
 *     87.6% is never quoted as a system-wide saving.
 *
 *     D-057 named "machine chatter — coordination messages, presence heartbeats,
 *     observation-lane work items" as the volume problem. Measured, coordination
 *     messages are 17 MB/day (6.6%) at exactly 1.00 appends per key: they are
 *     insert-only and are NOT the amplifier. That is why `coord_event_log` stays
 *     on the log below (durable directed mail an offline peer must still
 *     receive) while the high-multiplicity content tables carry `rotating`.
 *
 * The residual between 257 MB/day of OWN-log appends and ~0.8 GB/day of store
 * growth is the admitted set: a member stores every admitted peer's log, so
 * store growth is the sum over peers plus Hypercore's per-block merkle/oplog
 * overhead. `hive:store_breakdown` reports both halves so the ratio is read
 * from a measurement instead of inferred.
 *
 * PURE + SUBSTRATE-FREE, exactly like `table-registry.ts` and
 * `projection-engine.ts`: no PG, no Hyperbee, no fs. The agent tool and the
 * egress consumers import it; it imports only the registry.
 */

import { PEER_LOG_TABLES } from './table-registry';

/**
 * WHERE a hive-side fact belongs — the D-059 tier table, routed by LIFETIME and
 * AUDIENCE rather than by "is it coordination".
 */
export type StorageTier =
  /** (1) Only this machine reads it. Local Postgres is the whole story; it must
   *  not carry the harness stamp that makes it federate. */
  | 'local-postgres'
  /** (2) Live state peers need NOW and nobody needs later: a stream over the
   *  existing hyperswarm connections with no persistence and hour-scale expiry.
   *  A joining peer gets the current snapshot, never the history. */
  | 'ephemeral-channel'
  /** (3) Durable shared facts on the append-only log. */
  | 'append-only-log'
  /** (4) Money and the commerce record — Worker D1 + local ledger, seller-signed,
   *  finality on chain (D-055). Never the hive log. */
  | 'worker-chain';

/**
 * HOW LONG a kind is kept where it lives.
 */
export type RetentionClass =
  /** Kept for the life of the hive. Per-human-action volume; rotation would buy
   *  nothing and a joiner needs the whole history to verify governance. */
  | 'permanent'
  /** Durable, but high-churn: closed keys older than `retainEpochs` epochs
   *  compact into a snapshot core and the superseded core is dropped
   *  (hypercore truncate/clear + sparse replication). */
  | 'rotating'
  /** Not persisted at all — carried on the tier-2 channel, expiring in
   *  `ttlSec`. The local projection is the only lasting trace. */
  | 'ephemeral'
  /** Does not ride the hive log at all (tier 1 or tier 4). */
  | 'off-log';

export interface RetentionSpec {
  tier: StorageTier;
  retention: RetentionClass;
  /** `rotating` only: epochs of closed keys retained before the core is dropped. */
  retainEpochs?: number;
  /** `ephemeral` only: channel expiry. */
  ttlSec?: number;
  /**
   * For a kind that has left (or must leave) the log: the transport that carries
   * it instead. Naming it is what makes an `off-log`/`ephemeral` class auditable
   * — a class with no alternative transport is a data-loss bug, not a policy.
   */
  carriedBy?: string;
  /** Why this class — decision ref + the measurement that supports it. */
  note: string;
}

/** Measured 24h append volume for a producing table (2026-09-06, P-043). */
export interface MeasuredAppendVolume {
  appends24h: number;
  distinctKeys: number;
  avgWireBytes: number;
}

/**
 * The measurement that classifies the high-multiplicity tables `rotating`.
 * Source: `harness_shared.substrate_outbox`, 24h window ending 2026-09-06T06:0Z,
 * workspace `papercusp-workspace`, harness `papercusp` (see the module header).
 * Recorded here so a later reader can re-run the same query and see whether the
 * shape that justified the policy still holds, rather than trusting the prose.
 */
export const MEASURED_APPEND_VOLUME_2026_09_06: Readonly<Record<string, MeasuredAppendVolume>> = {
  harness_plans: { appends24h: 1158, distinctKeys: 97, avgWireBytes: 75865 },
  harness_features_consolidated: { appends24h: 8032, distinctKeys: 250, avgWireBytes: 9498 },
  engineer_issues: { appends24h: 25668, distinctKeys: 6578, avgWireBytes: 2729 },
  coord_event_log: { appends24h: 12597, distinctKeys: 12595, avgWireBytes: 1416 },
  coord_thread_posts: { appends24h: 1934, distinctKeys: 1601, avgWireBytes: 3961 },
  harness_plan_parts: { appends24h: 4825, distinctKeys: 1695, avgWireBytes: 1364 },
  coord_threads: { appends24h: 2652, distinctKeys: 1115, avgWireBytes: 616 },
  coord_conversations: { appends24h: 109, distinctKeys: 49, avgWireBytes: 2049 },
  contributor_usage_events: { appends24h: 268, distinctKeys: 268, avgWireBytes: 404 },
  pot_members: { appends24h: 32, distinctKeys: 1, avgWireBytes: 1713 },
  cup_claim_specs: { appends24h: 43, distinctKeys: 23, avgWireBytes: 1002 },
  pot_epoch_keys: { appends24h: 64, distinctKeys: 2, avgWireBytes: 604 },
  agent_facts: { appends24h: 9, distinctKeys: 9, avgWireBytes: 1639 },
  plan_item_assignments: { appends24h: 13, distinctKeys: 6, avgWireBytes: 665 },
  gate_verdicts: { appends24h: 8, distinctKeys: 8, avgWireBytes: 820 },
};

/** Default epochs of history a `rotating` kind keeps before its core is dropped. */
export const DEFAULT_RETAIN_EPOCHS = 2;

/** Default tier-2 channel expiry (hour-scale, per D-059). */
export const DEFAULT_EPHEMERAL_TTL_SEC = 3600;

const GOVERNANCE = (what: string): RetentionSpec => ({
  tier: 'append-only-log',
  retention: 'permanent',
  note:
    `D-057/D-059 tier 3: ${what} — per-human-action volume, and a joining peer must ` +
    `fold the whole history to verify the chain of admission. No rotation.`,
});

const DISTRIBUTION = (what: string): RetentionSpec => ({
  tier: 'append-only-log',
  retention: 'permanent',
  note:
    `D-055/D-059 tier 3: ${what} — distribution metadata stays authoritative on the ` +
    `log (D-055 keeps only COMMERCE behind the Worker). Per-listing volume.`,
});

const ROTATING = (what: string, measuredPerKey: string): RetentionSpec => ({
  tier: 'append-only-log',
  retention: 'rotating',
  retainEpochs: DEFAULT_RETAIN_EPOCHS,
  note:
    `D-059 tier 3 with epoch rotation: ${what}. Measured ${measuredPerKey} — the ` +
    `log stores every version, so closed keys older than ${DEFAULT_RETAIN_EPOCHS} ` +
    `epochs compact into a snapshot core and the superseded core is dropped.`,
});

/**
 * The policy. EVERY `PEER_LOG_TABLES` entry appears here exactly once; adding a
 * federated table without an entry fails `checkHiveLogRetentionCoverage()` and
 * the doc-claim test that pins it.
 */
export const HIVE_LOG_RETENTION: Readonly<Record<string, RetentionSpec>> = {
  // ── Governance (D-057 (1)): members, admission, ratification, revocation ──
  pot_members: GOVERNANCE('per-hive member/device admission — a revocation must reach every peer'),
  pot_policy: GOVERNANCE('the owner-SIGNED hive policy singleton'),
  pot_pending_joins: GOVERNANCE('approval-mode join requests + the owner decision'),
  pot_reports: GOVERNANCE('the member→owner moderation queue'),
  pot_epoch_keys: GOVERNANCE('per-member WRAPPED read-plane epoch keys — dropping one locks a member out'),
  pot_settings: GOVERNANCE('per-hive settings'),
  contributors: GOVERNANCE('per-harness contributor/device admission'),
  p2p_peer_grants: GOVERNANCE('capability grants — a revocation must land on every machine'),

  // ── Distribution (D-057 (1)): manifests, offers, listing metadata ─────────
  p2p_fleet_directory: DISTRIBUTION('the owner-signed fleet directory record'),
  p2p_work_offers: DISTRIBUTION('the publisher-signed offer store'),

  // ── Operational receipts + immutable facts: insert-only, kept ─────────────
  p2p_receipts: {
    tier: 'append-only-log',
    retention: 'permanent',
    note:
      'D-055/D-057: operational p2p-receipts stay on the log (only COMMERCE receipts moved ' +
      'behind the Worker). Immutable INSERT-only facts; measured 0 rows/24h on the dev box.',
  },
  gate_verdicts: {
    tier: 'append-only-log',
    retention: 'permanent',
    note:
      'Immutable INSERT-only device-signed shard verdicts; measured 8 appends/24h over 8 keys ' +
      '(1.00 per key). The aggregator assembles green(S) from every runner, so history is the value.',
  },
  contributor_usage_events: {
    tier: 'append-only-log',
    retention: 'permanent',
    note: 'Insert-only usage facts; measured 268 appends/24h over 268 keys (1.00 per key), 106 kB/day.',
  },
  agent_facts: {
    tier: 'append-only-log',
    retention: 'permanent',
    note:
      'Shareable standing facts (shareable=true rows only, D-006 privacy); measured 9 appends/24h. ' +
      'Facts carry their own TTL/retraction in PG, so log volume is negligible.',
  },
  memory_canonical: {
    tier: 'append-only-log',
    retention: 'permanent',
    note:
      'Shareable memories (shareable=true only). No appends in the measured 24h window; the ' +
      'shareable predicate is what bounds it. Re-measure before relaxing that predicate.',
  },
  gym_qd_archive: {
    tier: 'append-only-log',
    retention: 'permanent',
    note: 'Federatable QD elites (outcome=won OR grade>=4, D-002). No appends in the measured window.',
  },

  // ── Durable mail: stays on the log because an OFFLINE peer must still get it ─
  coord_event_log: {
    tier: 'append-only-log',
    retention: 'rotating',
    retainEpochs: DEFAULT_RETAIN_EPOCHS,
    carriedBy: 'hive peer log (durable); presence/liveness rides presence-gossip instead',
    note:
      'D-059 tier 2 proposed moving directed mail to the ephemeral channel. REFUTED BY ' +
      'MEASUREMENT and kept on the log: 12,597 appends/24h over 12,595 keys is exactly 1.00 ' +
      'per key (insert-only) and only 17 MB/day — 6.6% of the 257 MB/day total, not the ' +
      'amplifier D-057 assumed. Directed mail must survive an offline peer, which a ' +
      'no-persistence channel cannot do. Rotation bounds the tail instead.',
  },
  coord_threads: ROTATING('conversation headers', '2,652 appends over 1,115 keys = 2.38 per key'),
  coord_thread_posts: ROTATING('conversation posts', '1,934 appends over 1,601 keys = 1.21 per key'),
  coord_conversations: ROTATING('harness-scoped conversations', '109 appends over 49 keys = 2.22 per key'),

  // ── The amplifiers: large rows re-appended in full on every edit ──────────
  harness_plans: ROTATING(
    'whole-plan federation — the single largest producer',
    '1,158 appends over 97 plans = 11.94 per key at 75,865 B avg = 84 MB/day',
  ),
  harness_plan_parts: ROTATING(
    'per-PART plan federation (the finer grain that replaces whole-plan rows)',
    '4,825 appends over 1,695 keys = 2.85 per key',
  ),
  harness_features_consolidated: ROTATING(
    'feature-family work rows',
    '8,032 appends over 250 keys = 32.13 per key at 9,498 B avg = 73 MB/day — the worst multiplicity measured',
  ),
  harness_issues_consolidated: ROTATING(
    'issue-family work rows (the consolidated read shape)',
    'no appends in the measured window; classified with its sibling because it shares the edit-churn shape',
  ),
  engineer_issues: ROTATING(
    'the issue/task work-queue family',
    '25,668 appends over 6,578 keys = 3.90 per key at 2,729 B avg = 67 MB/day',
  ),
  feature_claims: ROTATING('per-feature claims', 'no appends in the measured window; claims are short-lived by nature'),
  feature_queue: ROTATING('the feature queue', 'no appends in the measured window'),
  feature_working_set: ROTATING('the active-feature pointer', 'no appends in the measured window'),
  plan_item_assignments: ROTATING(
    'per-plan-item assignment (LWW on a small record)',
    '13 appends over 6 keys = 2.17 per key',
  ),
  cup_claim_specs: ROTATING('per-bee claim specs', '43 appends over 23 keys = 1.87 per key'),
  p2p_fleet_leader_leases: ROTATING(
    'the fleet-leader lease row — a liveness/anti-flap HINT, not authorization, so only the ' +
      'current lease has value',
    'no appends in the measured window; leases are re-written per leadership term by construction',
  ),

  // ── Ephemeral: live state nobody needs later ─────────────────────────────
  shared_presence: {
    tier: 'ephemeral-channel',
    retention: 'ephemeral',
    ttlSec: DEFAULT_EPHEMERAL_TTL_SEC,
    carriedBy:
      'sync/hyperbee/presence-gossip.ts (protomux `papercusp/hive-presence` over the SAME hive ' +
      'topic, device-signed, HELLO snapshot for a joiner) — the tier-2 transport D-059 asks for ' +
      'ALREADY EXISTS and needs no new platform surface. Its WRITER cutover is gated on ' +
      'FLAGS.PRESENCE_GOSSIP, which is still dark pending the 2-machine verify, so beats are ' +
      'still appended to the log until that flag flips.',
    note:
      'D-059 tier 2: a presence beat is a keep-alive every ~30s per device, and on the log every ' +
      'beat is an immortal append every peer folds forever. The TTL-windowed shared_presence ' +
      'projection in PG is the only trace that should persist.',
  },
};

/**
 * Kinds that must NOT reach the append-only log — the classes an egress guard
 * refuses. A kind is here iff its class is `off-log` OR its tier is not the log.
 * `shared_presence` qualifies by TIER (ephemeral-channel) but its move is gated
 * on FLAGS.PRESENCE_GOSSIP, so a caller must consult `carriedBy` before enforcing.
 */
export function tablesNotBelongingOnTheLog(): string[] {
  return Object.entries(HIVE_LOG_RETENTION)
    .filter(([, spec]) => spec.retention === 'off-log' || spec.tier !== 'append-only-log')
    .map(([table]) => table)
    .sort();
}

/** Federated tables whose class is `rotating` — what an epoch-rotation pass owns. */
export function rotatingTables(): string[] {
  return Object.entries(HIVE_LOG_RETENTION)
    .filter(([, spec]) => spec.retention === 'rotating')
    .map(([table]) => table)
    .sort();
}

/** The retention spec for a federated table, or null when it has none. */
export function retentionSpecFor(table: string): RetentionSpec | null {
  return HIVE_LOG_RETENTION[table] ?? null;
}

export interface RetentionCoverage {
  ok: boolean;
  /**
   * `sync:'peer-log'` tables with NO retention class — the P-043 gap: a new
   * federated op kind that would ride the append-only log forever with nobody
   * having decided how long it is kept. A non-empty list fails the doc-claim test.
   */
  unclassified: string[];
  /**
   * Policy entries for a table the registry does NOT classify `sync:'peer-log'`
   * — a stale entry left behind after a table was reclassified or renamed.
   */
  orphanPolicy: string[];
  /**
   * Entries whose class is internally inconsistent: `rotating` without
   * `retainEpochs`, `ephemeral` without `ttlSec`, or a non-log tier / `off-log`
   * class with no `carriedBy` transport named. The last one is the important
   * check — an off-log class with no alternative transport is silent data loss
   * dressed as a policy.
   */
  incoherent: string[];
}

/**
 * Assert that every federated table has a coherent retention class, and that no
 * class points at a table that does not federate. The write-side dual of
 * `checkCaptureCoverage` (which asserts every federated table has a PRODUCER);
 * this asserts every federated table has a documented END OF LIFE.
 *
 * Pure — pass the sets in. `checkHiveLogRetentionCoverage()` binds it to the
 * live registry.
 */
export function checkRetentionCoverage(
  peerLogTables: readonly string[],
  policy: Readonly<Record<string, RetentionSpec>>,
): RetentionCoverage {
  const peerSet = new Set(peerLogTables);
  const classified = Object.keys(policy);

  const unclassified = [...peerLogTables].filter((t) => !policy[t]).sort();
  const orphanPolicy = classified.filter((t) => !peerSet.has(t)).sort();

  const incoherent: string[] = [];
  for (const [table, spec] of Object.entries(policy)) {
    if (spec.retention === 'rotating' && !(spec.retainEpochs && spec.retainEpochs > 0)) {
      incoherent.push(`${table}: rotating without retainEpochs`);
    }
    if (spec.retention === 'ephemeral' && !(spec.ttlSec && spec.ttlSec > 0)) {
      incoherent.push(`${table}: ephemeral without ttlSec`);
    }
    const offTheLog = spec.retention === 'off-log' || spec.tier !== 'append-only-log';
    if (offTheLog && !spec.carriedBy) {
      incoherent.push(`${table}: ${spec.tier}/${spec.retention} names no carriedBy transport`);
    }
    if (!spec.note || spec.note.trim().length === 0) {
      incoherent.push(`${table}: no note (a class must record why)`);
    }
  }
  incoherent.sort();

  return {
    ok: unclassified.length === 0 && orphanPolicy.length === 0 && incoherent.length === 0,
    unclassified,
    orphanPolicy,
    incoherent,
  };
}

/** The bound coverage check for the live registry — what the doc-claim test pins. */
export function checkHiveLogRetentionCoverage(): RetentionCoverage {
  return checkRetentionCoverage(PEER_LOG_TABLES, HIVE_LOG_RETENTION);
}

export interface AppendVolumeProjection {
  table: string;
  appends24h: number;
  distinctKeys: number;
  avgWireBytes: number;
  /** appends ÷ distinct keys — the version multiplier this table pays. */
  appendsPerKey: number;
  /** What the table actually costs the log per day. */
  wireBytes24h: number;
  /** What it would cost if only the latest version of each key survived. */
  latestOnlyBytes24h: number;
  retention: RetentionClass;
}

/**
 * Project the measured append volume into the per-table version-multiplier view
 * the amplification explanation rests on — and that `hive:store_breakdown`
 * renders. Pure over the passed measurement so a caller can hand it a FRESH
 * measurement instead of the recorded one.
 */
export function projectAppendVolume(
  measured: Readonly<Record<string, MeasuredAppendVolume>> = MEASURED_APPEND_VOLUME_2026_09_06,
  policy: Readonly<Record<string, RetentionSpec>> = HIVE_LOG_RETENTION,
): AppendVolumeProjection[] {
  return Object.entries(measured)
    .map(([table, m]) => ({
      table,
      appends24h: m.appends24h,
      distinctKeys: m.distinctKeys,
      avgWireBytes: m.avgWireBytes,
      appendsPerKey: m.distinctKeys > 0 ? Number((m.appends24h / m.distinctKeys).toFixed(2)) : 0,
      wireBytes24h: m.appends24h * m.avgWireBytes,
      latestOnlyBytes24h: m.distinctKeys * m.avgWireBytes,
      retention: policy[table]?.retention ?? 'permanent',
    }))
    .sort((a, b) => b.wireBytes24h - a.wireBytes24h);
}

export interface AmplificationSummary {
  /** Daily own-log wire bytes across every producing table. */
  wireBytes24h: number;
  /** Daily bytes if only the latest version of each key survived. */
  latestOnlyBytes24h: number;
  /** wireBytes24h ÷ latestOnlyBytes24h — the version multiplier, the real amplifier. */
  versionMultiplier: number;
  /** Share of the daily volume paid by `rotating` kinds. */
  rotatingSharePct: number;
  /** The three tables paying the most, largest first. */
  topProducers: { table: string; wireBytes24h: number; appendsPerKey: number }[];
}

/**
 * The headline the amplification explanation reduces to: how much of the log's
 * daily volume is superseded versions rather than new facts.
 */
export function summarizeAmplification(
  rows: readonly AppendVolumeProjection[] = projectAppendVolume(),
): AmplificationSummary {
  const wireBytes24h = rows.reduce((n, r) => n + r.wireBytes24h, 0);
  const latestOnlyBytes24h = rows.reduce((n, r) => n + r.latestOnlyBytes24h, 0);
  const rotating = rows.filter((r) => r.retention === 'rotating').reduce((n, r) => n + r.wireBytes24h, 0);
  return {
    wireBytes24h,
    latestOnlyBytes24h,
    versionMultiplier:
      latestOnlyBytes24h > 0 ? Number((wireBytes24h / latestOnlyBytes24h).toFixed(2)) : 0,
    rotatingSharePct: wireBytes24h > 0 ? Number(((rotating / wireBytes24h) * 100).toFixed(1)) : 0,
    topProducers: rows.slice(0, 3).map((r) => ({
      table: r.table,
      wireBytes24h: r.wireBytes24h,
      appendsPerKey: r.appendsPerKey,
    })),
  };
}
