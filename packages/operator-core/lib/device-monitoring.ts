/**
 * device-monitoring.ts — read-only monitoring producers for the phone's
 * "worth glancing at" surface (mobile-apps-revival-v2 Phase B, D-003).
 *
 * The phone is a MONITORING interface, never a work surface (plan guiding
 * principle: the desktop is where the owner works; the phone is where they
 * glance). So every producer here is READ-ONLY and FAIL-SOFT — a bad read
 * yields a `null` tile, never a thrown route. This mirrors the load-bearing
 * rule in pipeline-health.ts: a monitoring read that has a bad day must not
 * break the dashboard it decorates, and a detector with no evidence says
 * nothing rather than a cheerful "OK".
 *
 * Producers (each reuses an existing operator reader; each independently
 * fail-soft; all dependency-injectable so they unit-test without PG/git):
 *   - releaseGateTile   — P-009 release-pipeline tile  (reuses fetchOrientPipeline)
 *   - poolTile          — P-007 inference-pool health  (reuses accountStatus)
 *   - fleetsAndPotsTile — P-008 live Pots & Fleets      (reuses listPresence)
 *   - connectionTile    — P-010 this-device health      (reuses deviceConnectionSnapshot)
 *   - systemAlerts      — P-007 PURE composer: red-gate + pool-exhaustion → alerts
 *   - monitoringSnapshot— composes them all for the /device/monitoring route
 */
import {
  fetchOrientPipeline,
  type OrientPipeline,
} from './agent-tools/coordination/pipeline-health';
import {
  accountStatus,
  accountRoutingExhausted,
} from './deployment/account-pool-store';
import { listPresence } from './agent-tools/coordination/presence';
import { fetchPresenceFleet } from './agent-tools/coordination/presence-fleet';
import { deviceConnectionSnapshot } from './device-store';
import { mobileJwtSecretStatus } from './device-jwt';

// ── P-009 · release-pipeline tile ────────────────────────────────────────────

export interface ReleaseGateTile {
  gate: OrientPipeline['gate'];
  deploy: 'current' | 'behind';
  /** A genuine blocking red (red/stalled/wedged/conflict). NEVER true for a
   *  `stale-verdict` gate — that colour is UNKNOWN, not red (pipeline-health
   *  load-bearing silence: a stale verdict must not raise a phantom alarm). */
  red: boolean;
  consecutiveReds?: number;
  /** COUNT of failing files — the phone shows the number, not the file names
   *  (those are engineering detail the owner acts on from the desktop). */
  failingFileCount?: number;
  lastGreenAgoMs?: number;
  checkedAtMs: number;
}

const BLOCKING_RED = new Set(['red', 'stalled', 'wedged', 'conflict']);

export async function releaseGateTile(
  slug?: string,
  deps: { fetch?: typeof fetchOrientPipeline } = {},
): Promise<ReleaseGateTile | null> {
  try {
    const fetch = deps.fetch ?? fetchOrientPipeline;
    const p = await fetch(slug);
    if (!p) return null;
    const tile: ReleaseGateTile = {
      gate: p.gate,
      deploy: p.deploy,
      red: BLOCKING_RED.has(p.gate),
      checkedAtMs: p.checkedAtMs,
    };
    if (p.consecutiveReds != null) tile.consecutiveReds = p.consecutiveReds;
    if (p.failingFiles?.length) tile.failingFileCount = p.failingFiles.length;
    if (p.lastGreenAgoMs != null) tile.lastGreenAgoMs = p.lastGreenAgoMs;
    return tile;
  } catch {
    return null;
  }
}

// ── P-007 · inference-pool health tile ───────────────────────────────────────

export interface PoolAccountLite {
  id: string;
  provider: string;
  /** Can actually serve right now (pause-clear AND usage headroom). */
  available: boolean;
  /** Walled by an exhausted usage window — futile to retry until it resets. */
  usageWalled: boolean;
  /** Epoch ms the exhausted window resets, if known. */
  usageResetAt?: number;
}

export interface PoolTile {
  /** No healthy routing capacity — the authoritative accountRoutingExhausted read. */
  exhausted: boolean;
  healthyCount: number;
  walledCount: number;
  totalCount: number;
  accounts: PoolAccountLite[];
}

export async function poolTile(
  ws?: string,
  deps: {
    status?: typeof accountStatus;
    exhausted?: typeof accountRoutingExhausted;
  } = {},
): Promise<PoolTile | null> {
  try {
    const status = deps.status ?? accountStatus;
    const exhaustedFn = deps.exhausted ?? accountRoutingExhausted;
    const [rows, exhausted] = await Promise.all([status(ws), exhaustedFn(ws)]);
    const accounts: PoolAccountLite[] = rows.map((r) => ({
      id: r.id,
      provider: String(r.provider),
      available: r.available,
      usageWalled: r.usageWalled,
      ...(r.usageResetAt != null ? { usageResetAt: r.usageResetAt } : {}),
    }));
    return {
      exhausted,
      healthyCount: accounts.filter((a) => a.available).length,
      walledCount: accounts.filter((a) => a.usageWalled).length,
      totalCount: accounts.length,
      accounts,
    };
  } catch {
    return null;
  }
}

// ── P-008 · live Pots & Fleets tile ──────────────────────────────────────────

export interface FleetSummary {
  fleetSlug: string;
  members: number;
  live: number;
  leader: string | null;
}
export interface PotSummary {
  potSlug: string;
  agents: number;
  live: number;
}
export interface FleetsAndPotsTile {
  agents: number;
  live: number;
  fleets: FleetSummary[];
  pots: PotSummary[];
}

export async function fleetsAndPotsTile(
  ws: string,
  deps: {
    list?: typeof listPresence;
    fleets?: typeof fetchPresenceFleet;
  } = {},
): Promise<FleetsAndPotsTile | null> {
  try {
    const list = deps.list ?? listPresence;
    const fleetsFn = deps.fleets ?? fetchPresenceFleet;
    const roster = await list({ workspaceId: ws });
    const fleetMap = await fleetsFn(roster.map((r) => r.ownerId));

    const fleetAgg = new Map<string, FleetSummary>();
    const potAgg = new Map<string, PotSummary>();
    let agents = 0;
    let live = 0;

    for (const r of roster) {
      const isLive = !r.stale && !r.revoked;
      agents++;
      if (isLive) live++;

      const fm = fleetMap.get(r.ownerId);
      if (fm?.fleetSlug) {
        const f =
          fleetAgg.get(fm.fleetSlug) ??
          { fleetSlug: fm.fleetSlug, members: 0, live: 0, leader: null };
        f.members++;
        if (isLive) f.live++;
        if (fm.fleetRole === 'leader') f.leader = r.ownerLabel ?? r.ownerId;
        fleetAgg.set(fm.fleetSlug, f);
      }

      if (r.potSlug) {
        const p = potAgg.get(r.potSlug) ?? { potSlug: r.potSlug, agents: 0, live: 0 };
        p.agents++;
        if (isLive) p.live++;
        potAgg.set(r.potSlug, p);
      }
    }

    const byLiveDesc = <T extends { live: number }>(a: T, b: T) => b.live - a.live;
    return {
      agents,
      live,
      fleets: [...fleetAgg.values()].sort(byLiveDesc),
      pots: [...potAgg.values()].sort(byLiveDesc),
    };
  } catch {
    return null;
  }
}

// ── P-010 · this-device connection-health tile ───────────────────────────────

export interface ConnectionTile {
  /** Device row present + not revoked — the pairing is still valid. */
  paired: boolean;
  /** Tautologically true: the phone reached us to ask for this tile. Present
   *  so the phone can render a uniform "server reachable ✓" without inference. */
  serverReachable: true;
  /** At least one push token is registered for this device. */
  pushRegistered: boolean;
  pushPlatforms: Array<'apns' | 'fcm'>;
  lastSeenMs: number | null;
  pairedAtMs: number | null;
  /** The device-JWT signing secret is durable — else a server restart silently
   *  invalidates this device's token and it must re-pair (P-001). */
  secretDurable: boolean;
}

export async function connectionTile(
  deviceId: string,
  ws: string,
  deps: {
    snapshot?: typeof deviceConnectionSnapshot;
    secretStatus?: typeof mobileJwtSecretStatus;
  } = {},
): Promise<ConnectionTile | null> {
  try {
    const snapshot = deps.snapshot ?? deviceConnectionSnapshot;
    const secretStatus = deps.secretStatus ?? mobileJwtSecretStatus;
    const snap = await snapshot(deviceId, ws);
    return {
      paired: snap.exists && !snap.revoked,
      serverReachable: true,
      pushRegistered: snap.pushPlatforms.length > 0,
      pushPlatforms: snap.pushPlatforms,
      lastSeenMs: snap.lastSeen ? snap.lastSeen.getTime() : null,
      pairedAtMs: snap.pairedAt ? snap.pairedAt.getTime() : null,
      secretDurable: secretStatus().durable,
    };
  } catch {
    return null;
  }
}

// ── P-007 · system alerts (PURE composer) ────────────────────────────────────

export interface SystemAlert {
  id: string;
  kind: 'release-red-gate' | 'pool-exhaustion';
  severity: 'high' | 'medium';
  title: string;
  body: string;
}

/**
 * Compose owner-attention system alerts from the already-read tiles. PURE — no
 * I/O, so the exact alert conditions are unit-testable. Emits an alert ONLY
 * when the condition is genuinely active (a green gate / healthy pool produce
 * nothing), so this can be appended to the phone's attention feed without ever
 * adding noise.
 */
export function systemAlerts(input: {
  gate?: ReleaseGateTile | null;
  pool?: PoolTile | null;
}): SystemAlert[] {
  const out: SystemAlert[] = [];
  if (input.gate?.red) {
    const reds = input.gate.consecutiveReds
      ? ` (${input.gate.consecutiveReds} consecutive reds)`
      : '';
    out.push({
      id: 'system:release-red-gate',
      kind: 'release-red-gate',
      severity: 'high',
      title: 'Release gate is red',
      body: `The release pipeline gate is ${input.gate.gate}${reds} — merged changes will not reach production until it is green again.`,
    });
  }
  if (input.pool?.exhausted) {
    out.push({
      id: 'system:pool-exhaustion',
      kind: 'pool-exhaustion',
      severity: 'high',
      title: 'Inference pool exhausted',
      body: `${input.pool.walledCount}/${input.pool.totalCount} accounts are usage-walled with no healthy routing capacity — agents may stall until capacity resets.`,
    });
  }
  return out;
}

// ── Consolidated snapshot for GET /device/monitoring ─────────────────────────

export interface MonitoringSnapshot {
  releaseGate: ReleaseGateTile | null;
  pool: PoolTile | null;
  fleets: FleetsAndPotsTile | null;
  connection: ConnectionTile | null;
  alerts: SystemAlert[];
  generatedAtMs: number;
}

export async function monitoringSnapshot(opts: {
  deviceId: string;
  workspaceId: string;
  harnessSlug?: string;
}): Promise<MonitoringSnapshot> {
  const [releaseGate, pool, fleets, connection] = await Promise.all([
    releaseGateTile(opts.harnessSlug),
    poolTile(opts.workspaceId),
    fleetsAndPotsTile(opts.workspaceId),
    connectionTile(opts.deviceId, opts.workspaceId),
  ]);
  return {
    releaseGate,
    pool,
    fleets,
    connection,
    alerts: systemAlerts({ gate: releaseGate, pool }),
    generatedAtMs: Date.now(),
  };
}
