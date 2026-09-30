/**
 * Harness-state projection engine (plan harness-state-storage-unification-2026-06-01, P-003).
 *
 * The ONE place that reasons about a table's cross-machine SYNC AUTHORITY by
 * its registry classification. P-003a (this file): the peer-log half is a thin
 * guard over the existing Model-B registry (`lib/sync/hyperbee`) — it keeps the
 * registry's `sync:'peer-log'` set and the hand-wired projections in lock-step
 * — plus a live-inventory coverage check. P-003b adds the git-export adapter;
 * P-003c folds both into a single router.
 *
 * Intentionally substrate-free: this module does NOT import `lib/sync/**`. The
 * boot caller passes the registered projection tags in (see `checkPeerLogConsistency`),
 * so harness-state never drags the Hyperbee/holepunch dep graph.
 */
import {
  PEER_LOG_TABLES,
  classifyInventory,
  resolveTableSpec,
  type SyncAuthority,
} from './table-registry';

/**
 * Hyperbee projection tag → PG table. Mirrors `lib/sync/hyperbee/projections/*`
 * (each projection's `tableTag` + its `INTO harness_shared.<table>`, verified
 * P-003a). The drift guard asserts this is bijective with the registry's
 * `sync:'peer-log'` set.
 */
export const PEER_LOG_TAG_TO_TABLE: Readonly<Record<string, string>> = {
  contributors: 'contributors',
  claims: 'feature_claims',
  queue: 'feature_queue',
  'working-set': 'feature_working_set',
  'features-by-id': 'harness_features_consolidated',
  'plans-by-slug': 'harness_plans',
  issues: 'harness_issues_consolidated',
  presence: 'shared_presence',
  usage: 'contributor_usage_events',
  // distributed-coordination-shared-harness-2026-06-04 (Track A): harness-scoped
  // coordination conversations (projections/coord-conversation.ts → coord_conversations).
  'coord-conversations': 'coord_conversations',
  // distributed-coordination-shared-harness-2026-06-04 (Track A, surface #1):
  // harness-scoped coord messages/handoffs/escalations (projections/coord-message.ts).
  'coord-messages': 'coord_event_log',
  // distributed-coordination-shared-harness-2026-06-04 (Track A): conversation
  // reply timeline — thread header + posts.
  'coord-threads': 'coord_threads',
  'coord-thread-posts': 'coord_thread_posts',
  // plan-item-assignment-claim-liveness-2026-06-04 (D-002): per-plan-item ASSIGNMENT
  // (projections/plan-item-assignments.ts → plan_item_assignments). The leased CLAIM
  // table is authority-mediated and is intentionally NOT a peer-log table.
  'item-assignments': 'plan_item_assignments',
  // shared-hive-federation-2026-06-08 (P-005): per-Hive settings federate over the
  // peer-log (projections/hive-settings.ts → hive_settings; tableTag 'hive-settings-by-key').
  'hive-settings-by-key': 'pot_settings',
  'bee-claim-specs': 'cup_claim_specs',
  // cross-machine-coord-parity-and-trust-2026-07-01 (P-044 DG-1): the distributed
  // test gate's device-signed shard-run verdict facts federate over the peer-log
  // (projections/gate-verdicts.ts → gate_verdicts; content-addressed, INSERT-only).
  'gate-verdicts': 'gate_verdicts',
  // shared-hive-federation-2026-06-08 (P-006): per-Hive admission federates over the
  // peer-log (projections/hive-members.ts → hive_members).
  'hive-members': 'pot_members',
  // shared-hive-owner-enforcement-2026-06-19 (EN-1): the owner-SIGNED Hive policy record
  // federates over the peer-log (projections/hive-policy.ts → hive_policy; tableTag
  // 'hive-policy'). SINGLETON per Hive, scoped to the Hive home; the projection verifies
  // the owner signature before applying.
  'hive-policy': 'pot_policy',
  // shared-hive-owner-enforcement-2026-06-19 (EN-3): the member→owner moderation report
  // queue + the approval-mode pending-join queue federate over the peer-log
  // (projections/hive-reports.ts → hive_reports; projections/hive-pending-joins.ts →
  // hive_pending_joins). Both hive-home-grained (scoped to the Hive home slug).
  'hive-reports': 'pot_reports',
  'hive-pending-joins': 'pot_pending_joins',
  // shared-hive-rekey-2026-06-19 (P-005): per-member WRAPPED epoch keys for the read-plane
  // re-key federate over the peer-log (projections/hive-epoch-keys.ts → hive_epoch_keys;
  // tableTag 'hive-epoch-keys'). Hive-home-grained (keyed workspace_id, harness_slug = the
  // Hive home, epoch, member_device_pubkey). DARK until papercusp-hive-rekey flips — the
  // boundary trigger + producer are flag-gated, so the table stays empty until then.
  'hive-epoch-keys': 'pot_epoch_keys',
  // fed-reanchor B5: the work-queue's issue/task family federates over the peer-log
  // (projections/engineer-issues.ts → engineer_issues; key == issue_id).
  'engineer-issues': 'engineer_issues',
  // plan-federation-regrain-2026-06-13 P-006: per-PART plan federation (tableTag
  // 'plan-parts'). Additive + DARK — receives nothing until papercusp-plan-part-federation
  // is on (capture is flag-gated) and its harness_plans recompose is itself flag-gated.
  'plan-parts': 'harness_plan_parts',
  // p2p-work-distribution-2026-07-02 P-001: P2P capability grants federate over the
  // peer-log (projections/p2p-peer-grants.ts → p2p_peer_grants; mig 463). Hive-home-
  // grained; the projection RECEIVER-ENFORCES author-attestation == grantor (M6/L9).
  'p2p-peer-grants': 'p2p_peer_grants',
  // p2p-work-distribution-2026-07-02 P-004: loud-refusal receipt facts (INSERT-only)
  // federate over the peer-log (projections/p2p-receipts.ts → p2p_receipts; mig 468).
  'p2p-receipts': 'p2p_receipts',
  // p2p-work-distribution-2026-07-02 P-101 / D-006: owner-signed fleet-directory
  // records federate over the peer-log (projections/fleet-directory.ts →
  // p2p_fleet_directory; mig 476).
  'p2p-fleet-directory': 'p2p_fleet_directory',
  // p2p-work-distribution-2026-07-02 P-102 store leg (WI-1935): the publisher-SIGNED
  // offer store federates over the peer-log (projections/work-offers.ts →
  // p2p_work_offers; mig 490). [Added by su-16e4c with the table-registry entry to
  // green the drift guards; flagged to the WI-1935 owner su-35c3b.]
  'p2p-work-offers': 'p2p_work_offers',
  // P-302 LIVE-2 seam 1 (WI-2001): fleet leader lease hints federate over the
  // peer-log (projections/fleet-leader-leases.ts → p2p_fleet_leader_leases; mig 518).
  'p2p-fleet-leader-leases': 'p2p_fleet_leader_leases',
  // federated-scout-gym-learning-2026-07-02 F1-1: shareable standing facts federate
  // over the peer-log (projections/agent-facts.ts → agent_facts; mig 461/462).
  // [Added by Lane A su-71623 with the table-registry entry to green the drift
  // guards; flagged to the F1-1 owner su-29e3d.]
  'agent-facts-by-key': 'agent_facts',
  // federated-scout-gym-learning-2026-07-02 F1-2/F1-5: federatable QD elites
  // federate over the peer-log (projections/gym-qd-elites.ts → gym_qd_archive
  // sender / gym_qd_foreign_elites receiver; migs 464/465).
  'gym-qd-elites-by-niche': 'gym_qd_archive',
  // mem0-cross-machine-federation-2026-07-10 (F1-1 mirror for memories, EI-9430 fix):
  // SHAREABLE memories federate over the peer-log (projections/p2p-memories.ts →
  // memory_canonical; migs 562-563). Registered tag is 'p2p-memories-by-id'
  // (register-all.ts) — this entry was omitted when the table-registry classification
  // landed (and named to a `p2p_memories` table that never actually existed — see the
  // table-registry.ts note), drifting the two out of lock-step (the exact class this
  // bijection guard exists to catch).
  'p2p-memories-by-id': 'memory_canonical',
};

export interface PeerLogConsistency {
  ok: boolean;
  /** peer-log tables in the registry with no projection tag (a new sync:'peer-log' table needs a projection). */
  missingProjection: string[];
  /** projection tags whose mapped table is NOT sync:'peer-log' in the registry (a projection lost its registry entry). */
  orphanTag: string[];
}

/**
 * Assert the registry's `sync:'peer-log'` set and the hand-wired projection
 * tags stay in lock-step. The caller passes `REGISTERED_PROJECTION_TAGS` from
 * `lib/sync/hyperbee/projections/register-all` so this module stays
 * substrate-free. Fails when the two drift apart in either direction.
 */
export function checkPeerLogConsistency(registeredTags: readonly string[]): PeerLogConsistency {
  const tagTables = new Set(
    registeredTags.map((t) => PEER_LOG_TAG_TO_TABLE[t]).filter((x): x is string => Boolean(x)),
  );
  const missingProjection = [...PEER_LOG_TABLES].filter((t) => !tagTables.has(t));
  const orphanTag = registeredTags.filter((t) => {
    const tbl = PEER_LOG_TAG_TO_TABLE[t];
    return !tbl || resolveTableSpec(tbl).sync !== 'peer-log';
  });
  return {
    ok: missingProjection.length === 0 && orphanTag.length === 0,
    missingProjection,
    orphanTag,
  };
}

export interface CaptureCoverage {
  ok: boolean;
  /**
   * `sync:'peer-log'` tables with NO producer — neither a CDC capture trigger
   * (`capturedTables`) nor a log-first append (`logFirstTables`) nor a
   * documented accepted-unfederated entry. THE EI-382 CLASS at the data layer:
   * a federated table whose local writes silently never reach the peer-log.
   * A non-empty list is a real bug — wire a producer (or, if it genuinely should
   * not federate, add it to the accepted-unfederated set with a reason).
   */
  uncaptured: string[];
  /**
   * Tables claimed by BOTH a CDC trigger AND a log-first append. A table must
   * have exactly one producer mechanism: a PG-first table's own-log op is a
   * replay of a row PG already authored (the EI-117 echo-storm shape), so a
   * table can't safely be both. A non-empty list is a wiring conflict.
   */
  doubleCaptured: string[];
  /**
   * Producer-set entries (CDC / log-first / accepted-unfederated) whose table is
   * NOT `sync:'peer-log'` in the registry — a producer for a table that should
   * not federate, or a stale entry left after a table was reclassified.
   */
  orphanProducer: string[];
}

/**
 * Assert that EVERY federated (`sync:'peer-log'`) table has exactly one capture
 * mechanism, and that no capture mechanism points at a non-federated table —
 * the write-side dual of `checkPeerLogConsistency` (which guards the read-side
 * projection tags). Pure + substrate-free: the caller passes the producer sets
 * from `lib/sync/hyperbee` (`capture-coverage.ts`), so this module never drags
 * the Hyperbee dep graph, exactly like `checkPeerLogConsistency`.
 *
 * Closes the EI-382 class at the data layer (shared-hive-hardening P-011): a new
 * `sync:'peer-log'` table added to the registry without wiring a capture trigger
 * or a log-first append would silently never federate. With this guard pinned by
 * a test, that omission fails CI instead of shipping a write path that drops on
 * the floor.
 *
 *   - `capturedTables`     — PG-first: a `substrate_outbox` CDC trigger captures
 *     local writes; the drain federates them (`CDC_CAPTURED_TABLES`).
 *   - `logFirstTables`     — the application appends the op directly to the own
 *     log (claims / queue / working-set / contributors / presence).
 *   - `acceptedUnfederated`— `sync:'peer-log'` in the registry but intentionally
 *     NOT produced (documented — e.g. a GitHub-derived per-machine cache).
 */
export function checkCaptureCoverage(
  peerLogTables: readonly string[],
  capturedTables: readonly string[],
  logFirstTables: readonly string[],
  acceptedUnfederated: readonly string[] = [],
): CaptureCoverage {
  const peerSet = new Set(peerLogTables);
  const cdc = new Set(capturedTables);
  const logFirst = new Set(logFirstTables);
  const accepted = new Set(acceptedUnfederated);

  const produced = new Set<string>([...cdc, ...logFirst, ...accepted]);
  const uncaptured = peerLogTables.filter((t) => !produced.has(t));
  const doubleCaptured = [...cdc].filter((t) => logFirst.has(t));
  const orphanProducer = [...produced].filter((t) => !peerSet.has(t));

  return {
    ok: uncaptured.length === 0 && doubleCaptured.length === 0 && orphanProducer.length === 0,
    uncaptured,
    doubleCaptured,
    orphanProducer,
  };
}

export interface InventoryCoverage {
  total: number;
  /** tables flagged NEEDS_REVIEW — must be empty (P-002 closed it). */
  unreviewed: string[];
  /** tables resolving to DEFAULT (slug-shared/none) — intentional, but surfaced so a NEW table can't hide. */
  defaulted: string[];
  byBucket: Record<string, number>;
}

/**
 * Coverage of a live table list (P-003a boot caller passes the
 * `information_schema` set). Surfaces unclassified + DEFAULT-fall-through so a
 * newly-added table can never silently inherit DEFAULT unseen.
 */
export function checkInventoryCoverage(liveTables: string[]): InventoryCoverage {
  const c = classifyInventory(liveTables);
  return { total: c.total, unreviewed: c.unreviewed, defaulted: c.defaulted, byBucket: c.byBucket };
}

/** Convenience: the sync authority for a table (strips a schema qualifier). */
export function syncAuthorityFor(table: string): SyncAuthority {
  return resolveTableSpec(table).sync;
}

/**
 * P-003c — the ONE router. Maps a table's registry sync authority to the single
 * adapter that owns its cross-machine projection, replacing the three hand-rolled
 * dogfood §7 bucket paths (HYPERBEE / GIT / LOCAL) with one registry-driven
 * decision:
 *   'git-export' → PG↔`.papercusp/state` files (lib/harness-state/git-export/*)
 *   'peer-log'   → PG↔Hyperbee/Model-B log (lib/sync/hyperbee/*)
 *   'local'      → no projection (sync:'none'); PG is the only copy
 * The adapters themselves stay in their modules; this is the dispatch seam they
 * (and the boot wiring) consult so "which mechanism" lives in exactly one place.
 */
export type ProjectionAdapter = 'git-export' | 'peer-log' | 'local';

export function projectionAdapterFor(table: string): ProjectionAdapter {
  switch (syncAuthorityFor(table)) {
    case 'git':
      return 'git-export';
    case 'peer-log':
      return 'peer-log';
    default:
      return 'local';
  }
}

export interface ProjectionRouting {
  /** tables routed to the git-export adapter. */
  gitExport: string[];
  /** tables routed to the peer-log adapter. */
  peerLog: string[];
  /** tables with no projection (PG-only). */
  local: string[];
  /** the peer-log registry↔projection-tag drift guard (P-003a). */
  peerLogConsistency: PeerLogConsistency;
  /** true iff every table routes to exactly one adapter AND peer-log is consistent. */
  ok: boolean;
}

/**
 * Route a live table inventory through the single router and fold in the
 * peer-log drift guard — the unified "the registry drives all three buckets
 * correctly" check (supersedes the per-adapter checks scattered at boot).
 * Partition is total + disjoint by construction (projectionAdapterFor returns
 * exactly one adapter per table), so `ok` reduces to the peer-log guard, but the
 * partitioned lists give the boot log a one-glance routing picture.
 */
export function routeProjection(
  liveTables: string[],
  registeredTags: readonly string[],
): ProjectionRouting {
  const gitExport: string[] = [];
  const peerLog: string[] = [];
  const local: string[] = [];
  for (const t of liveTables) {
    const adapter = projectionAdapterFor(t);
    (adapter === 'git-export' ? gitExport : adapter === 'peer-log' ? peerLog : local).push(t);
  }
  const peerLogConsistency = checkPeerLogConsistency(registeredTags);
  return { gitExport, peerLog, local, peerLogConsistency, ok: peerLogConsistency.ok };
}
