/**
 * host-capacity.ts — refuse a proc-mesh that cannot FIT on this host, BEFORE
 * spawning it.
 *
 * WHY THIS EXISTS (measured 2026-08-16, WI-39359):
 * The >64-peer `replication.sustained` ladder produced a convergence signal that
 * looked like a substrate mesh-formation defect and was NOT one. Each perf peer
 * child held ~430-550MB RSS (`childRssPeak` p50) AT THAT TIME, so an 80-peer mesh
 * needed ~38-42GB and a 96-peer mesh ~41-53GB of anonymous memory. On a shared box
 * already holding a large agent fleet, the run SELF-OVERSUBSCRIBED: one pass
 * began at loadavg 52 / PSI cpu some avg60 0.96% and ended at loadavg 265
 * (2.07x cpus) having moved 470,555 swap pages. Readers then miss the
 * convergence budget because they are SWAPPED, not because the mesh failed.
 *
 * The tell that this is not a capacity ceiling of the substrate: the per-config
 * failure pattern is NOT REPRODUCIBLE. Across two runs of the same four configs,
 * 96@100 went 22/95 -> 95/95 while 96@10 went 95/95 -> 51/95. A real ceiling
 * cannot invert. Failing readers cluster just under the budget (115-116s of
 * 120s) — deadline clipping of an across-the-board-slow distribution.
 *
 * The runner already owns an AFTER-THE-FACT host-health verdict (EI-8843 load
 * ratio, EI-9145 swap delta, EI-19301664378023382 PSI). That marks the number
 * uncertain once it has already been paid for, and it does not stop the run from
 * degrading the shared box for every other agent on it. This guard is the
 * BEFORE half: if the mesh provably cannot fit, refusing is strictly better than
 * emitting a verdict nobody may quote.
 *
 * This is the FOURTH time in this lane the instrument, not the substrate, was
 * the defect (serial per-reader deadline; convergence-budget drift; hyperswarm's
 * default `MAX_PEERS = 64`; now per-peer RSS vs host memory). Hence a guard
 * rather than a note: a note does not survive the next agent.
 *
 * ⚠ AND A FIFTH, 2026-08-22 (WI-40592) — THIS FILE ITSELF. The per-peer figure
 * below was calibrated pre-no-PG-loader and then went stale, so the guard refused
 * meshes the host could comfortably run and the refusal was being read as a
 * PRODUCT ceiling ("shared-pot p2p converges at 64 peers") in a public-release
 * GO/NO-GO. A guard is an instrument too. When this one's numbers and the
 * substrate disagree, re-measure THIS FILE before concluding anything about the
 * substrate — and see the measurement-envelope warning on `perPeerBytesFor`,
 * because the way to make it a SIXTH is to quote an extrapolation as a result.
 */

import { readFileSync } from 'node:fs';

/**
 * Per-peer resident memory is NOT a constant — it GROWS with the peer count,
 * because each child holds a live connection to every other peer. Measured
 * 2026-08-22 (WI-40592), post-no-PG-loader, `replication.sustained` at a fixed
 * workload (rate:10, count:200), every leg passing BOTH `sloPassed` and
 * `convergencePassed` so these are healthy-mesh numbers rather than degraded ones:
 *
 *     peers |  childRssPeak p50
 *        4  |  167.8 MB
 *       12  |  184.3 MB
 *       24  |  190.2 MB
 *       48  |  267.4 MB
 *       64  |  285.0 MB
 *
 * WHY THIS REPLACED A SCALAR (and why re-scalarising it would be a REGRESSION):
 * the previous model was `projectedBytes = peers x DEFAULT_PER_PEER_RSS_BYTES`,
 * which ASSUMES per-peer cost is independent of peer count. The table falsifies
 * that assumption, so the defect was the model's SHAPE, not merely its
 * coefficient. That distinction is load-bearing: the obvious "fix" — dropping the
 * stale 450MB to the freshly measured 285MB — would have permitted 137 peers on a
 * 39.3GB budget, a mesh that actually costs ~58.6GB. A naive recalibration makes
 * this guard MORE dangerous than the stale constant it replaces, because it newly
 * admits exactly the runs that swap. Anyone tempted to collapse this back to one
 * number should re-read that sentence.
 *
 * The old 450MB was measured PRE-loader (429/478/525/551MB across four >64-peer
 * configs). The no-PG loader (child-driver.ts, `!cfg.hivePubkey`) cut per-peer RSS
 * by ~144MB at 64 peers, and this file was never revisited — a stale constant, not
 * a substrate ceiling.
 *
 * COEFFICIENTS ARE DELIBERATELY CONSERVATIVE. A capacity guard must never
 * UNDER-estimate: under-estimating admits a mesh that then evicts other agents'
 * working set and swaps, which is the failure this whole file exists to prevent
 * (loadavg 52 -> 265, 470,555 swap pages moved). So these are not a least-squares
 * fit — a least-squares line runs BELOW the 48-peer point. They are chosen so the
 * model sits at or above every measured point (+2% to +14%).
 */
export const PER_PEER_BASE_BYTES = 162_000_000;

/**
 * Marginal cost of each additional peer in the mesh, from the same measurement.
 * Kept separate from the base so a re-measurement can move one without the other.
 */
export const PER_PEER_GROWTH_BYTES_PER_PEER = 2_300_000;

/**
 * Projected resident memory for ONE child in a mesh of `peers` total processes.
 *
 * ⚠ MEASUREMENT ENVELOPE: anchored on 4-64 peers. Above 64 this EXTRAPOLATES, and
 * the extrapolation is explicitly not validated — the growth was non-monotonic in
 * the measured range (per-peer slopes 2.06, 0.49, 3.22, 1.10 MB/peer), so treat a
 * >64 projection as an engineering estimate rather than a result. It is quoted in
 * the refusal text for exactly that reason: so a caller can check it, not trust it.
 */
export function perPeerBytesFor(peers: number): number {
  return PER_PEER_BASE_BYTES + PER_PEER_GROWTH_BYTES_PER_PEER * peers;
}

/**
 * Fraction of `MemAvailable` a mesh may claim.
 *
 * NOT 1.0, and the reason is empirical rather than superstitious: `MemAvailable`
 * counts reclaimable page cache as available, but a mesh that claims it forces
 * the kernel to evict tens of GB of other agents' working set and then swap. At
 * the measured footprint this factor puts the fit boundary between 64 peers
 * (~29GB, the largest count that has ever produced a clean, reproducible result
 * here) and 80 peers (~36GB, the smallest that has not).
 */
export const DEFAULT_AVAILABLE_FRACTION = 0.5;

export interface MeshCapacityDecision {
  /** WI-41206: always true. Kept so callers compile unchanged, but memory never refuses a
   *  run any more — a caller must not reintroduce a `if (!ok) return` on this field. */
  ok: boolean;
  /** Human-readable ADVISORY, present when the mesh exceeds the RAM-only budget. Its presence
   *  means "this result may be unquotable if it swaps", NOT "the run was refused". */
  reason?: string;
  projectedBytes: number;
  budgetBytes: number;
}

/**
 * PURE fit decision — no `/proc`, no env, no clock, so it is unit-testable and
 * cannot silently pass because the host happened to be idle.
 *
 * `availableBytes === null` means "this host does not report available memory"
 * (non-Linux, or an unreadable /proc): the guard then ABSTAINS rather than
 * guessing. Abstaining restores exactly the old behaviour, which is the correct
 * failure mode for a guard that is not the thing under test.
 */
export function decideMeshCapacity(input: {
  /** Total peer processes to be spawned, INCLUDING the writer. */
  peers: number;
  availableBytes: number | null;
  perPeerBytes?: number;
  availableFraction?: number;
}): MeshCapacityDecision {
  // An explicit override stays SCALAR: an operator saying "my peers cost X" is
  // asserting a flat figure, and silently applying growth on top of it would
  // quietly refuse the run they deliberately asked for.
  const perPeer = input.perPeerBytes ?? perPeerBytesFor(input.peers);
  const fraction = input.availableFraction ?? DEFAULT_AVAILABLE_FRACTION;
  const projectedBytes = input.peers * perPeer;

  if (input.availableBytes === null) {
    return { ok: true, projectedBytes, budgetBytes: Number.POSITIVE_INFINITY };
  }

  const budgetBytes = input.availableBytes * fraction;
  if (projectedBytes <= budgetBytes) return { ok: true, projectedBytes, budgetBytes };

  const gb = (b: number) => `${(b / 1e9).toFixed(1)}GB`;
  // WI-41206 / remove-memory-derived-work-refusals-2026-08-24: ADVISORY, never a refusal.
  //
  // This guard used to return ok:false here. Its own header already recorded that a stale
  // calibration made it refuse meshes the host could comfortably run, and that the refusal
  // was then misread as a substrate bug — the failure mode of a memory guard that says NO is
  // that people debug the wrong thing. The caller decides; we only tell it what we measured.
  //
  // The warning below is still worth printing, and is a genuinely different claim from the
  // launch clamp's: a perf mesh that swaps produces an UNQUOTABLE convergence number, so the
  // risk here is a worthless RESULT, not a dead process. That is a reason to distrust the
  // verdict, not a reason to withhold the run.
  return {
    ok: true,
    projectedBytes,
    budgetBytes,
    reason:
      `ADVISORY (not a refusal — the run proceeds): a ${input.peers}-peer proc mesh needs ` +
      `~${gb(projectedBytes)} (${input.peers} x ~${gb(perPeer)}/peer at this peer count${
        input.perPeerBytes === undefined && input.peers > 64 ? ', EXTRAPOLATED past the 64-peer measurement envelope' : ''
      }) but only ` +
      `${gb(budgetBytes)} is within the RAM-only budget (${(fraction * 100).toFixed(0)}% of ` +
      `MemAvailable ${gb(input.availableBytes)}; swap is not counted). If this mesh swaps, a ` +
      `swapped reader can miss the convergence budget for reasons that have NOTHING to do ` +
      `with this substrate — so treat a MISS from this run as suspect rather than as a ` +
      `substrate verdict, and re-run on a quieter/larger host before quoting it. Tune with ` +
      `PERF_MESH_AVAILABLE_FRACTION / PERF_MESH_PER_PEER_BYTES.`,
  };
}

/** Parse `MemAvailable` (kB) out of /proc/meminfo text. Pure, so it is testable. */
export function parseMemAvailableBytes(meminfo: string): number | null {
  const line = meminfo.split('\n').find((l) => l.startsWith('MemAvailable:'));
  if (!line) return null;
  const kb = Number(line.replace(/[^0-9]/g, ''));
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
}

/** Read MemAvailable, or null on any host that does not report it. */
export function readMemAvailableBytes(): number | null {
  try {
    return parseMemAvailableBytes(readFileSync('/proc/meminfo', 'utf8'));
  } catch {
    return null;
  }
}

/** Env overrides, so a deliberate operator can still force a run. */
export function capacityOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): {
  perPeerBytes?: number;
  availableFraction?: number;
} {
  const num = (v: string | undefined): number | undefined => {
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    perPeerBytes: num(env.PERF_MESH_PER_PEER_BYTES),
    availableFraction: num(env.PERF_MESH_AVAILABLE_FRACTION),
  };
}

/**
 * Thrown by `spawnProcMesh` when the mesh provably does not fit. Deliberately
 * NOT a `MeshFormationError`: that type means "the mesh was attempted and did
 * not form", which netem folds into a `did-not-form` MEASUREMENT. This never ran
 * at all, so recording it as an outcome of the profile would be a false datum.
 */
export class HostCapacityError extends Error {
  constructor(
    message: string,
    readonly decision: MeshCapacityDecision,
  ) {
    super(message);
    this.name = 'HostCapacityError';
  }
}
