/**
 * buildFederationStatus — the shared composition behind BOTH the
 * GET /api/discovery/federation-status endpoint AND the `network.federationStatus`
 * sync resolver (data-sync-push-completion P-009).
 *
 * Extracted from the endpoint handler so the push (sync) path and the legacy
 * loopback GET serve the IDENTICAL FedStatus payload — one composition, no drift
 * (the same pattern as buildNetworkBoard behind network.board + `network:board`).
 *
 * HONESTY CONTRACT (the surface's whole point is "the UI never lies"):
 *   - `hives[].reachablePeers` is `reachablePeersForHive` — peers on THIS hive's
 *     ANNOUNCE/discovery topic (who could find + join it), NOT content-replication
 *     peers. Owned + non-private only; a private hive never announces → 0.
 *   - `hives[].contentPeers` (EI-1599, composes onto Brief H/A-002) is
 *     `contentPeersForHive` — the TRUE per-hive content-replication peer count:
 *     peers whose content-announce channel is open on this hive's OWN content
 *     topic, i.e. actually syncing hive content right now. `hives[].lastContentSyncMs`
 *     is the ms-epoch of the last inbound announce seen on that topic (`null` =
 *     none yet) — a receive-side "still active" signal, NOT an admission/merge
 *     timestamp. Both are 0/null for a hive with no minted identity yet.
 *   - `substrate` is the install-wide local boot health (getInProcessSubstrateStatus),
 *     i.e. "is my federation infrastructure up", NOT a per-peer sync claim.
 *   - `substrate.drain` (EI-1618) is the install-wide SYNC-health signal: how many
 *     booted harnesses have content CAPTURED in `substrate_outbox` but not yet
 *     drained to the federation log (the EI-681 silent-stall class). It only ever
 *     reports a STALL, never a positive "synced" — that gap is what `hives[].contentPeers`
 *     / `lastContentSyncMs` above now fill in at the per-hive level (see findings-M).
 */
import { getOrgPg } from '@papercusp/db-org';
import { getHiveDirectory } from '../../../hive-directory-deps';
import { activeWorkspaceId } from '../../../workspace-registry';
import { listOwnedHiveMeta } from '../../../hive-directory-meta';
import { getInProcessSubstrateStatus } from '../../../sync/hyperbee/in-process-status';
import {
  loadSubstrateDrainStats,
  type SubstrateDrainStat,
} from '../../../sync/hyperbee/load-drain-stats';
import { probeSubstrateSidecar } from '../../../service-health';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Oldest-undrained age (ms) past which a harness's outbox counts as STALLED in
 * the install-wide drain summary. Mirrors `assessHarnessSubstrateHealth`'s
 * `drainStalledThresholdMs` default (60s) so the summary and the per-harness
 * verdict agree on what "stalled" means, and a few rows briefly undrained
 * between the capture and the next periodic drain tick are NOT flagged.
 */
const DRAIN_STALL_LAG_MS = 60_000;

export interface OwnedHiveStatusRow {
  potId: string;
  title: string;
  visibility: 'public' | 'invite' | 'private';
  /** Member harness count (display signal). */
  memberCount: number;
  /** Peers on this hive's announce topic (discovery reach). 0 for private/unwired. */
  reachablePeers: number;
  /** EI-1599: TRUE content-replication peer count on this hive's own content
   *  topic (not discovery). 0 for a hive with no minted identity yet. */
  contentPeers: number;
  /** EI-1599: ms-epoch of the last content-sync activity seen on this hive's
   *  content topic, or `null` if none yet / no minted identity. */
  lastContentSyncMs: number | null;
}

export interface FederationStatus {
  ok: boolean;
  substrate: {
    active: boolean;
    bootedHarnesses: number;
    healthy: number;
    booting: number;
    degraded: number;
    drain: {
      stalledHarnesses: number;
      worstUndrainedCount: number;
      worstOldestUndrainedAgeMs: number | null;
    };
    /**
     * WI-899 (A): SUBSTRATE_SIDECAR process liveness, install-wide (one sidecar owns
     * every booted harness's engine when the flag is ON). `true`/`false` = measured
     * (healthz answered / didn't); `null` = sidecar mode is off (nothing to probe —
     * every harness boots in-process, this field just doesn't apply). A `false` here
     * already forced every harness's verdict to `unhealthy` (see health.ts's
     * `sidecarLive` input) — this field is what lets the UI/caller explain WHY in one
     * glance instead of inferring it from a wall of individual harness reasons.
     */
    sidecarLive: boolean | null;
  };
  hives: OwnedHiveStatusRow[];
}

/** Compose the install's honest federation status (reach + substrate + drain). */
export async function buildFederationStatus(): Promise<FederationStatus> {
  const workspaceId = activeWorkspaceId();

  // Wire the directory so reachablePeersForHive reflects the owned hives'
  // announce topics. Idempotent + instant once wired; awaited so the FIRST read
  // already has accurate reach instead of a transient 0. Best-effort — a wire
  // failure degrades to reach 0, never throws the read.
  try {
    const { ensureHiveDirectoryWired } = await import('../../../hive-directory-boot');
    await ensureHiveDirectoryWired(workspaceId);
  } catch {
    /* unwired → reach reports 0 honestly; the UI converges via the next push/tick */
  }

  const dir = getHiveDirectory();
  let hives: OwnedHiveStatusRow[] = [];
  try {
    const owned = await listOwnedHiveMeta(workspaceId);
    hives = owned.map((h) => ({
      potId: h.potId,
      title: h.title,
      visibility: h.visibility,
      memberCount: h.memberTopics.length,
      // reachablePeersForHive: 0 for a private hive (never announced) or one not
      // yet registered in the directory — honest, not a hidden failure.
      reachablePeers: h.visibility === 'private' ? 0 : dir.reachablePeersForHive(h.potId),
      // EI-1599: content-replication reach is NOT gated on visibility — a
      // private hive still content-syncs with its members over its own topic,
      // it just never ANNOUNCES on the discovery topic (reachablePeers above).
      contentPeers: dir.contentPeersForHive(h.potId),
      lastContentSyncMs: dir.lastContentSyncAtForHive(h.potId),
    }));
  } catch {
    hives = [];
  }

  // EI-1618/EI-1599 — prefetch per-harness substrate-outbox drain stats so the
  // (sync) resolveDrainStats below can flip a stalled-outbox harness off
  // "healthy". Without this a captured-but-not-federating harness (EI-681 class)
  // reads "healthy" — the silent stall this surface exists to expose. Best-effort:
  // a PG failure degrades to zero drain (honest), never throws the read.
  let drainByKey = new Map<string, SubstrateDrainStat>();
  try {
    const { sql } = getOrgPg();
    const runQuery = async <T,>(query: string, params: unknown[]): Promise<T[]> =>
      (await sql.unsafe(query, params as never)) as unknown as T[];
    drainByKey = await loadSubstrateDrainStats({ runQuery });
  } catch {
    /* PG-less → zero drain, honest */
  }

  // WI-899 (A): prefetch SUBSTRATE_SIDECAR liveness so the (sync) resolveSidecarLive
  // below can flip EVERY booted harness's verdict to 'unhealthy' when the sidecar
  // that actually owns their replication is dead. `present === false` = sidecar mode
  // is off (nothing to probe) → null, never a fabricated verdict for the in-process
  // boot path. Best-effort: a probe failure degrades to "unknown" (null), never throws.
  let sidecarLive: boolean | null = null;
  try {
    const probe = await probeSubstrateSidecar();
    sidecarLive = probe.present === false ? null : probe.up;
  } catch {
    /* liveness unknown → null, honest */
  }

  // WI-5777: prefetch the EI-8892 isolated-DHT-bootstrap liveness probe's
  // staleness so (sync) resolveDhtBootstrapProbeStaleMs below can degrade a
  // harness whose 'never_connected' peers may actually be masking a wedged
  // substrate (see health.ts's doc comment). Only meaningful for a process
  // that is actually ON the isolated DHT (PAPERCUSP_DHT_BOOTSTRAP set) — a
  // public-DHT install has no such probe/state dir, and that's correctly
  // "not applicable", not "unhealthy". Best-effort: any read failure degrades
  // to null (unmeasured), never throws, mirrors the sidecarLive probe above.
  let dhtBootstrapProbeStaleMs: number | null = null;
  try {
    if (process.env.PAPERCUSP_DHT_BOOTSTRAP?.trim()) {
      const lastOkPath = path.join(os.homedir(), '.papercusp', 'dht-liveness', 'last-ok');
      const raw = fs.readFileSync(lastOkPath, 'utf8').trim();
      const lastOkS = Number.parseInt(raw, 10);
      if (Number.isFinite(lastOkS) && lastOkS > 0) {
        dhtBootstrapProbeStaleMs = Date.now() - lastOkS * 1000;
      }
    }
  } catch {
    /* isolated DHT not configured here, or probe has never run → null, honest */
  }

  // Install-wide substrate health (local boot state). substrateActive is constant
  // true at runtime; bootedCount + per-harness verdicts are the real signal. The
  // `drain` rollup is the honest install-wide SYNC-health signal: how many booted
  // harnesses have content captured-but-not-federating (a stall, never a positive
  // "synced" — see the honesty contract above).
  let substrate: FederationStatus['substrate'] = {
    active: true,
    bootedHarnesses: 0,
    healthy: 0,
    booting: 0,
    degraded: 0,
    drain: { stalledHarnesses: 0, worstUndrainedCount: 0, worstOldestUndrainedAgeMs: null },
    sidecarLive,
  };
  try {
    const status = getInProcessSubstrateStatus({
      // A stalled outbox flips this harness's verdict off 'healthy' AND feeds the
      // drain rollup below.
      resolveDrainStats: (ws, slug) =>
        drainByKey.get(`${ws}::${slug}`) ?? { undrainedCount: 0, oldestUndrainedAgeMs: null },
      // WI-899 (A): a dead sidecar forces every harness's verdict to 'unhealthy'.
      resolveSidecarLive: () => sidecarLive,
      // WI-5777: a stale isolated-DHT liveness probe degrades this harness's
      // verdict, closing the 'never_connected'-never-alarms observability gap.
      resolveDhtBootstrapProbeStaleMs: () => dhtBootstrapProbeStaleMs,
    });
    let healthy = 0;
    let booting = 0;
    let degraded = 0;
    let stalledHarnesses = 0;
    let worstUndrainedCount = 0;
    let worstOldestUndrainedAgeMs: number | null = null;
    for (const h of status.harnesses) {
      if (h.verdict === 'healthy') healthy += 1;
      else if (h.verdict === 'booting') booting += 1;
      else if (h.verdict === 'degraded' || h.verdict === 'unhealthy') degraded += 1;
      const d = h.drain;
      if (
        d &&
        d.undrainedCount > 0 &&
        d.oldestUndrainedAgeMs != null &&
        d.oldestUndrainedAgeMs >= DRAIN_STALL_LAG_MS
      ) {
        stalledHarnesses += 1;
        if (d.undrainedCount > worstUndrainedCount) worstUndrainedCount = d.undrainedCount;
        if (
          worstOldestUndrainedAgeMs == null ||
          d.oldestUndrainedAgeMs > worstOldestUndrainedAgeMs
        ) {
          worstOldestUndrainedAgeMs = d.oldestUndrainedAgeMs;
        }
      }
    }
    substrate = {
      active: status.substrateActive,
      bootedHarnesses: status.bootedCount,
      healthy,
      booting,
      degraded,
      drain: { stalledHarnesses, worstUndrainedCount, worstOldestUndrainedAgeMs },
      sidecarLive,
    };
  } catch {
    /* keep the conservative default */
  }

  return { ok: true, substrate, hives };
}
