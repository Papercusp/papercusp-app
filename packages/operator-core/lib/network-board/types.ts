/**
 * network-board/types — the C-3 network-board-row contract
 * (hive-network-surface-2026-06-11, brief B-08, CONTRACT OWNER C-3).
 *
 * One row per "another-hive context" on the dock Network tab's aggregate board,
 * over the capability-tier ladder (D-001): tier 1 local Swarm · tier 2 own other
 * hives (same box) · tier 3 shared-Hive peer Swarms (federated) · tier 4 foreign
 * Hives (directory + beacon + our grants/traffic). The row is a flat SUMMARY —
 * an absent optional field means "this tier lacks that data" and the renderer
 * hides the section (never renders a zero/blank). Per-hive depth opens on demand
 * via the frame-tab drill-in (B-10), not from this row.
 *
 * Consumers: B-09 (pui network-pane render) · B-10 (per-hive drill-in tab) ·
 * B-11 (HUD Hives-tab trust relabel — shares the tier classifier, never forks).
 * This shape is NORMATIVE: changing a field requires a plan edit + coord:send to
 * every consumer (swarm protocol §2), never a silent drift.
 */

import type { CrossHiveKind } from '../cross-hive-boundary';

export type { CrossHiveKind };

/** The capability-tier ladder rung (D-001). Strictly 1|2|3|4, never flattened. */
export type NetworkTier = 1 | 2 | 3 | 4;

/**
 * Trust provenance of the row's data, in lock-step with the tier:
 *   tier 1 → 'local'     (this Swarm — substrate-authoritative, live)
 *   tier 2 → 'admin'     (own other hive, same box — workspace-admin, full data)
 *   tier 3 → 'federated' (shared-Hive peer Swarm — substrate-verified, eventually consistent)
 *   tier 4 → 'gossip'    (foreign Hive — best-effort directory + self-reported beacon)
 * The 'federated' vs 'gossip' split is the visual distinction B-09/B-11 must keep
 * (substrate-verified vs self-reported), so it lives on the row, not in the renderer.
 */
export type NetworkTrust = 'local' | 'admin' | 'federated' | 'gossip';

/** A scheduled-wake summary (tiers 1–3: own hives + federated peers carry one). */
export interface NetworkWake {
  active: boolean;
  /** ISO-8601 next scheduled fire, or null when none is pending. */
  nextFireAt: string | null;
}

/**
 * Our cross-Hive capability grants vis-à-vis a tier-4 peer (C-1/C-5 boundary):
 *   in  — kinds we admit FROM the peer (inbound grants, cross-hive-grants today)
 *   out — kinds we are allowed to send TO the peer (outbound, B-05 / P-004)
 * Empty arrays mean "no grant in that direction" (default-deny both ways).
 */
export interface NetworkGrants {
  in: CrossHiveKind[];
  out: CrossHiveKind[];
}

/**
 * Tier-4 ask-ledger summary for a peer (C-1 `cross_hive_asks`, owned by B-02):
 * how many of our outbound requests to this peer are still pending vs answered.
 */
export interface NetworkAsks {
  pending: number;
  answered: number;
}

/**
 * C-3 — ONE network-board row. Required: tier, key, title, trust. Everything else
 * is tier-conditional: present only when that tier supplies it; absent ⇒ the
 * renderer hides the section. Never emit a field as 0/"" to mean "no data" —
 * omit it.
 */
export interface NetworkBoardRow {
  /** Capability-tier rung (D-001). */
  tier: NetworkTier;
  /** Stable identity: the hive home-slug (tiers 1–2), the peer device/identity key
   *  (tier 3), or the foreign Hive's pubkey-b64 / potId (tier 4). Unique per row. */
  key: string;
  /** Human label for the row (hive title / machine label / foreign-hive title). */
  title: string;
  /** Trust provenance, paired to the tier (see NetworkTrust). */
  trust: NetworkTrust;

  /** Distinct live agents in this context (tiers 1–3; from beacon at tier 4). */
  liveAgents?: number;
  /**
   * Per-bee live owner IDs for tiers 2–3 (hive-network-surface P-014 item 1).
   * Each entry is a coord ownerId (su-…) of a live bee on that hive/device.
   * Informational since hive-agent-tabs P-014 retired the `pui watch-pane`
   * surface (the TUI no longer panes these); kept as C-3 data for any board UI.
   * Absent on tiers 1 and 4 (tier 1 = this Swarm's own bees, irrelevant for
   * the per-hive tab; tier 4 = no roster).
   */
  watchOwners?: string[];
  /** Open work-item / backlog depth (beacon at tier 4; absent on tiers 1–3 in v1). */
  queueDepth?: number;
  /** One-line "what they're focused on" (federated intent at tier 3; beacon focus at tier 4). */
  focus?: string;
  /** ISO-8601 last-seen / last-heartbeat (tier 3 presence; tier 4 last-announce). */
  lastSeen?: string;
  /** Scheduled-wake summary (own hives + federated peers). */
  wake?: NetworkWake;
  /** Our grant posture toward a tier-4 peer. */
  grants?: NetworkGrants;
  /** Tier-4 outbound ask-ledger summary. */
  asks?: NetworkAsks;
}
