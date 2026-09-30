/**
 * network-board/build-board — compose the C-3 aggregate board from the four
 * data sources (hive-network-surface-2026-06-11, brief B-08, P-006):
 *
 *   tiers 1–2  pot:list           — own hives (home → tier 1, others → tier 2)
 *   tier 3     federated presence  — shared-Hive peer Swarms (grouped per device)
 *   tier 4     discovery + beacon  — foreign directory hives + our grants/asks
 *
 * Split into a PURE assembler (`assembleNetworkBoard` — pre-fetched inputs in,
 * rows out, no IO, unit-testable) and a thin IO wrapper (`buildNetworkBoard` —
 * fetches the four sources, then assembles), mirroring the describeHive /
 * liveAgentCountByHarness / mapSharedPresenceRow convention.
 *
 * The tier-4 enrichments all read live upstreams: C-1 asks (`cross_hive_asks`,
 * B-02), C-2 beacon (the `DiscoveredHive.beacon` field, B-06), and BOTH grant
 * directions (`loadDirectedCrossHiveGrants`, B-05 — `out` was a stub until B-05's
 * direction landed). Every read is best-effort: a missing/empty source omits its
 * field on the row (absent ⇒ the renderer hides the section), never fails the board.
 */

import type { CrossHiveKind } from '../cross-hive-boundary';
import type { PotDescriptor } from '../agent-tools/pot/_resolve';
import { listPots, liveAgentCountByHarness } from '../agent-tools/pot/_resolve';
import { listFleetAssignments, type FleetAssignmentRow } from '../fleet/assignments';
import type { UnifiedPresenceRecord } from '../agent-tools/coordination/federated-presence';
import { listFederatedPresence } from '../agent-tools/coordination/federated-presence';
import type { DiscoveredHive } from '../hive-directory';
import { getHiveDirectory } from '../hive-directory-deps';
import { loadDirectedCrossHiveGrants } from '../cross-hive-grants';
import { PgCrossHiveAsks } from '../cross-hive-asks-pg';
import { resolvePotHomeSlug } from '../pot/wake';
import { activeWorkspaceId } from '../workspace-registry';
import { classifyNetworkTier } from './tier-classifier';
import type { NetworkAsks, NetworkBoardRow } from './types';

export interface NetworkBoardInputs {
  /** This Swarm's home-hive slug → its row is tier 1; other own hives are tier 2. */
  homeSlug: string | null;
  /** Own `kind:'hive'` projects (pot:list). */
  hives: PotDescriptor[];
  /** Distinct live agents per hive home-slug (one batched fleet read). */
  liveAgentsBySlug: Map<string, number>;
  /**
   * Live bee owner IDs per hive slug, for the per-hive drill-in watch panes
   * (hive-network-surface P-014 item 1). Populated for tiers 2/3 only;
   * absent for tier 1 (this Swarm, no separate drill-in) and tier 4 (no roster).
   * B-10's hive_tab_kdl already tolerates a populated list — panes appear for free.
   */
  watchOwnersBySlug?: Map<string, string[]>;
  /** Federated (cross-machine) presence peers — the tier-3 source. */
  federatedPeers: UnifiedPresenceRecord[];
  /** Foreign directory hives (already filtered to non-private) — the tier-4 source.
   *  Each MAY carry an opt-in C-2 status beacon (DiscoveredHive.beacon, B-06). */
  discovered: DiscoveredHive[];
  /** Inbound cross-Hive grants keyed by peer pubkey-b64 (kinds we admit FROM them). */
  grantsByPeer: Map<string, CrossHiveKind[]>;
  /** Outbound grants keyed by peer pubkey-b64 (kinds we may send TO them; B-05). */
  outboundGrantsByPeer?: Map<string, CrossHiveKind[]>;
  /** C-1 ask-ledger summary keyed by peer pubkey-b64 (B-02). */
  asksByPeer?: Map<string, NetworkAsks>;
  /** Injectable clock (tests). Default Date.now. */
  now?: number;
}

/**
 * Pure: project the four pre-fetched inputs into the ordered C-3 row list
 * (tier 1 first … tier 4 last). No IO — the unit-test surface.
 */
export function assembleNetworkBoard(input: NetworkBoardInputs): NetworkBoardRow[] {
  const rows: NetworkBoardRow[] = [];

  // ── Tiers 1–2: own hives. A `remote:true` descriptor is a joiner-side VIEW of
  //    someone else's hive (no identity, never announces) — not an OWNED Swarm,
  //    so it is excluded here (it surfaces at tier 4 if it's in the directory). ──
  for (const hv of input.hives) {
    if (hv.remote) continue;
    const isHome = input.homeSlug != null && hv.slug === input.homeSlug;
    const { tier, trust } = classifyNetworkTier({ kind: 'local-hive', isHome });
    const liveAgents = input.liveAgentsBySlug.get(hv.slug) ?? 0;
    const row: NetworkBoardRow = {
      tier,
      key: hv.slug,
      title: hv.slug,
      trust,
      liveAgents,
      wake: { active: hv.wake.active, nextFireAt: hv.wake.nextFireAt },
    };
    // Tier 2 (other own hive): populate watchOwners for the per-hive drill-in.
    // Tier 1 (home) is this Swarm — the drill-in would be a mirror, not useful.
    if (tier === 2) {
      const owners = input.watchOwnersBySlug?.get(hv.slug);
      if (owners && owners.length > 0) row.watchOwners = owners;
    }
    rows.push(row);
  }

  // ── Tier 3: shared-Hive peer Swarms. shared_presence is per (user, machine,
  //    harness); collapse to ONE row per peer DEVICE (a Swarm = a machine). ──
  const byDevice = new Map<string, UnifiedPresenceRecord[]>();
  for (const p of input.federatedPeers) {
    const key = p.devicePubkey || p.host || p.ownerId;
    let bucket = byDevice.get(key);
    if (!bucket) {
      bucket = [];
      byDevice.set(key, bucket);
    }
    bucket.push(p);
  }
  for (const [key, members] of byDevice) {
    const { tier, trust } = classifyNetworkTier({ kind: 'federated-peer' });
    const live = members.filter((m) => !m.stale);
    // Distinct live peer identities on the device (fed:<gh>@<machine>); a quiet
    // device still lists (like the HUD Hives tab) with liveAgents omitted.
    const liveAgents = new Set(live.map((m) => m.ownerId)).size;
    const focus = live.find((m) => m.intent && m.intent.trim())?.intent?.trim();
    const lastSeenMs = members.reduce(
      (max, m) => Math.max(max, Date.parse(m.heartbeatAt) || 0),
      0,
    );
    const title = members[0]?.host || members[0]?.ownerLabel || key;
    const row: NetworkBoardRow = { tier, key, title, trust };
    if (liveAgents > 0) row.liveAgents = liveAgents;
    if (focus) row.focus = focus;
    if (lastSeenMs > 0) row.lastSeen = new Date(lastSeenMs).toISOString();
    // Tier 3: per-device watch owners — distinct live agent owner IDs on this device.
    const deviceOwners = [...new Set(live.map((m) => m.ownerId).filter(Boolean))] as string[];
    if (deviceOwners.length > 0) row.watchOwners = deviceOwners;
    rows.push(row);
  }

  // ── Tier 4: foreign directory hives + beacon (C-2) + grants + asks (C-1). ──
  for (const h of input.discovered) {
    const { tier, trust } = classifyNetworkTier({ kind: 'foreign-hive' });
    const pubkey = h.hivePubkey || '';
    const row: NetworkBoardRow = {
      tier,
      key: pubkey || h.potId,
      title: h.title || h.potId,
      trust,
      lastSeen: new Date(h.lastSeenMs).toISOString(),
    };
    // UPSTREAM B-06 (C-2): live activity comes from the self-reported beacon.
    const beacon = h.beacon;
    if (beacon) {
      row.liveAgents = beacon.liveAgents;
      row.queueDepth = beacon.queueDepth;
      if (beacon.focus && beacon.focus.trim()) row.focus = beacon.focus.trim();
    }
    // Grants: include only when at least one kind is granted either direction
    // (absent ⇒ default-deny, the renderer hides the section).
    const inKinds = pubkey ? input.grantsByPeer.get(pubkey) : undefined;
    const outKinds = pubkey ? input.outboundGrantsByPeer?.get(pubkey) : undefined;
    if ((inKinds && inKinds.length) || (outKinds && outKinds.length)) {
      row.grants = { in: inKinds ? [...inKinds] : [], out: outKinds ? [...outKinds] : [] };
    }
    // UPSTREAM B-02 (C-1): ask-ledger summary for this peer.
    const asks = pubkey ? input.asksByPeer?.get(pubkey) : undefined;
    if (asks) row.asks = asks;
    rows.push(row);
  }

  // Tier-ascending, stable within a tier (the array's natural sort is stable in
  // V8) so the board always reads top-down 1→4 and consumers needn't re-sort.
  return rows.sort((a, b) => a.tier - b.tier);
}

/**
 * Per-hive watch owner IDs for the per-hive drill-in watch panes
 * (hive-network-surface P-014 item 1). Extracts distinct live-bee owner IDs
 * from fleet assignment rows, grouped by harness_slug (own-hive tier 2 only;
 * tier 3 comes from federatedPeers directly). Excludes presence-only rows and
 * rows whose holder is not alive (orphaned/stale agents have no watch pane).
 */
export function watchOwnersByHarness(rows: FleetAssignmentRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.harnessSlug || !r.agentId || !r.holderAlive) continue;
    let owners = out.get(r.harnessSlug);
    if (!owners) {
      owners = [];
      out.set(r.harnessSlug, owners);
    }
    if (!owners.includes(r.agentId)) owners.push(r.agentId);
  }
  return out;
}

/**
 * C-1 ask-ledger summaries keyed by peer pubkey (B-02 `cross_hive_asks`): for our
 * OUTBOUND requests to each peer Hive, how many are still pending (queued|sent)
 * vs answered. One `list({direction:'out'})` read aggregated in memory — peers
 * with no ledger rows simply aren't in the map (their row omits `asks`).
 * Best-effort: a store error yields an empty map so the board still renders.
 */
async function readAsksByPeer(
  workspaceId: string,
  potSlug: string,
): Promise<Map<string, NetworkAsks>> {
  const out = new Map<string, NetworkAsks>();
  try {
    const rows = await new PgCrossHiveAsks(workspaceId, potSlug).list({ direction: 'out' });
    for (const r of rows) {
      let summary = out.get(r.peerPubkey);
      if (!summary) {
        summary = { pending: 0, answered: 0 };
        out.set(r.peerPubkey, summary);
      }
      if (r.state === 'queued' || r.state === 'sent') summary.pending += 1;
      else if (r.state === 'answered') summary.answered += 1;
      // declined / expired are resolved-but-not-answered — neither pending nor answered.
    }
  } catch {
    return new Map();
  }
  return out;
}

/** The foreign directory hives this peer has seen (non-private), best-effort. */
function readDiscovered(): DiscoveredHive[] {
  try {
    return getHiveDirectory()
      .listDiscoveredHives()
      .filter((h) => h.visibility !== 'private');
  } catch {
    return [];
  }
}

export interface BuildNetworkBoardOpts {
  workspaceId?: string;
  /** Override the home-hive slug (default: resolvePotHomeSlug() / env). */
  homeSlug?: string | null;
}

/**
 * Fetch the four sources and assemble the C-3 board. Every source is
 * best-effort (a failing source contributes nothing rather than failing the
 * whole board), so the Network tab always renders.
 */
export async function buildNetworkBoard(
  opts: BuildNetworkBoardOpts = {},
): Promise<NetworkBoardRow[]> {
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const homeSlug = opts.homeSlug !== undefined ? opts.homeSlug : resolvePotHomeSlug();

  const [hives, fleetRows, federatedPeers] = await Promise.all([
    listPots(ws).catch(() => [] as PotDescriptor[]),
    listFleetAssignments({ workspaceId: ws }).catch(() => []),
    listFederatedPresence({ workspaceId: ws }).catch(() => [] as UnifiedPresenceRecord[]),
  ]);
  const discovered = readDiscovered();
  const liveAgentsBySlug = liveAgentCountByHarness(fleetRows);
  const watchOwnersBySlug = watchOwnersByHarness(fleetRows);

  const grantsByPeer = new Map<string, CrossHiveKind[]>();
  const outboundGrantsByPeer = new Map<string, CrossHiveKind[]>();
  let asksByPeer = new Map<string, NetworkAsks>();
  if (homeSlug) {
    // One read → both grant directions (B-05's loadDirectedCrossHiveGrants is the
    // Network-board read path it documents): `in` = kinds we admit FROM a peer,
    // `out` = kinds we may send TO them.
    const directed = await loadDirectedCrossHiveGrants(ws, homeSlug).catch(() => ({ in: [], out: [] }));
    for (const g of directed.in) grantsByPeer.set(g.peerHivePubkey, [...g.allowedKinds]);
    for (const g of directed.out) outboundGrantsByPeer.set(g.peerHivePubkey, [...g.allowedKinds]);
    asksByPeer = await readAsksByPeer(ws, homeSlug);
  }

  return assembleNetworkBoard({
    homeSlug,
    hives,
    liveAgentsBySlug,
    watchOwnersBySlug,
    federatedPeers,
    discovered,
    grantsByPeer,
    outboundGrantsByPeer,
    asksByPeer,
  });
}
