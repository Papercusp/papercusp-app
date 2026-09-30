/**
 * pot-git/gate/scheduling.ts — DG-3: shard scheduling for the distributed
 * test gate (cross-machine-coord-parity-and-trust-2026-07-01 Phase 8 P-046,
 * D-011).
 *
 * THE DEDUP FLOOR (the item's core): a shard is NEVER re-run when a
 * GATE-TRUSTED `pass` verdict already exists for its CURRENT (shardId,
 * inputsHash) — the DG-1 facts + DG-2 input hashes make the gate incremental.
 * `planShardRuns` is that floor as a pure function: it partitions the manifest
 * into needed / reusable (+ the DG-4 spot-check re-runs, which double-execute
 * a covered shard on purpose).
 *
 * CLAIMABLE UNITS — REUSE, don't reinvent: a planned run maps onto the
 * EXISTING work-item claim-lease machinery (`shardRunWorkItemSpecs` emits
 * work_items:create specs) rather than a parallel claim table:
 *   - the SKIP-LOCKED claim path (work_items:claim_next) already serializes
 *     competing idle machines — no double-claim by construction;
 *   - `dedupeKey` = gate-shard:<repoKey>:<shardId>@<inputsHash> keys the
 *     claim-time floor: one OPEN item per (repo, shard, inputs) no matter how
 *     many aggregation rounds re-plan while it is pending;
 *   - a SPOT-CHECK run carries redundancy 2 and rides the existing
 *     high-stakes replica machinery (work_items:claim_replica /
 *     record_replica_result) — the "randomized r% double-execution via the
 *     EXISTING work-item replica machinery" the P-047 design names.
 *
 * CAPABILITY TAGS: `shardRequiredTags` / `machineCanRunShard` define the
 * (platform, deps, DB) matching — unit shards need only a node toolchain;
 * integration shards additionally need docker+pg (testcontainers). Carrying a
 * machine's tag set in its session-presence row was the wiring half — LANDED
 * (WI-1546): `coord_presence.capability_tags` (mig 566) is populated by
 * `writePresence` via `detectMachineCapabilityTags`
 * (agent-tools/coordination/machine-capability-tags.ts, a real `docker info`
 * probe, memoized per operator process) — populate-once-then-keep, same
 * family as agent_role/pot_slug. `machineTagsFromPresence` below is the read
 * side for whenever a DG-3 consumer reads a `PresenceRecord` to place a shard;
 * until one exists, DEFAULT_MACHINE_TAGS remains the matcher's exercised
 * fallback (an empty/legacy `capabilityTags` reads as "use the default").
 *
 * PULL ORDER: `rankShardsForMachine` gives each idle machine a DETERMINISTIC,
 * device-keyed rendezvous order over the needed shards, so concurrent pullers
 * spread across the backlog instead of stampeding the same head — the claim
 * lease stays the correctness arbiter; this only reduces collision waste.
 *
 * Pure: node:crypto only. PG/work-item writes stay behind the emitted specs.
 */

import { createHash } from 'node:crypto';
import type { ShardLayer } from './shards';

/** Domain tag for the per-machine rendezvous pull ranking. */
export const SHARD_PULL_RANK_DOMAIN = 'papercusp-pot-git-gate-shard-pull-v1';

/** One (shard, current-inputs) target the aggregation round wants covered. */
export interface ShardRunTarget {
  shardId: string;
  /** The DG-2 inputsHash at the staging sha being gated. */
  inputsHash: string;
  layer: ShardLayer;
}

/** A stored DG-1 fact as the planner needs it (trust already resolved via
 *  DG-4 isGateTrustedDevice — the planner never reads stores itself). */
export interface KnownVerdictFact {
  shard_id: string;
  inputs_hash: string;
  verdict: 'pass' | 'fail';
  /** DG-4: does this fact's signer hold the owner's gate grant? */
  gateTrusted: boolean;
}

export interface PlannedRun extends ShardRunTarget {
  /** A trusted FAIL exists at these exact inputs (red until a fixing change
   *  moves the inputsHash or a re-run passes) — useful for reporting. */
  hasTrustedFail: boolean;
}

export interface ShardRunPlan {
  /** No gate-trusted pass at the current inputs — must run. */
  needed: PlannedRun[];
  /** Covered by a gate-trusted pass at the current inputs — skip (the floor). */
  reusable: ShardRunTarget[];
  /** DG-4 spot checks: covered shards deliberately re-run to audit the peer.
   *  Always a subset of `reusable` — a needed shard runs anyway. */
  spotChecks: ShardRunTarget[];
}

/**
 * THE DEDUP FLOOR. Partition targets by existing trusted coverage:
 * reusable ⇔ some gateTrusted pass matches (shardId, inputsHash) exactly.
 * Untrusted verdicts NEVER cover (an unaudited peer can't green your gate);
 * a trusted fail doesn't cover either — it flags the run as a known-red.
 * Deterministic and total; duplicate targets collapse on (shardId, inputsHash).
 */
export function planShardRuns(input: {
  targets: readonly ShardRunTarget[];
  verdicts: readonly KnownVerdictFact[];
  /** DG-4 selectSpotChecks output for this round (shard ids). */
  spotCheckShardIds?: readonly string[];
}): ShardRunPlan {
  const trustedPass = new Set<string>();
  const trustedFail = new Set<string>();
  for (const v of input.verdicts) {
    if (!v.gateTrusted) continue;
    const key = `${v.shard_id}\x00${v.inputs_hash}`;
    if (v.verdict === 'pass') trustedPass.add(key);
    else trustedFail.add(key);
  }
  const spot = new Set(input.spotCheckShardIds ?? []);

  const seen = new Set<string>();
  const needed: PlannedRun[] = [];
  const reusable: ShardRunTarget[] = [];
  const spotChecks: ShardRunTarget[] = [];
  for (const t of input.targets) {
    const key = `${t.shardId}\x00${t.inputsHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (trustedPass.has(key)) {
      reusable.push(t);
      if (spot.has(t.shardId)) spotChecks.push(t);
    } else {
      needed.push({ ...t, hasTrustedFail: trustedFail.has(key) });
    }
  }
  const byId = (a: ShardRunTarget, b: ShardRunTarget): number => a.shardId.localeCompare(b.shardId);
  needed.sort(byId);
  reusable.sort(byId);
  spotChecks.sort(byId);
  return { needed, reusable, spotChecks };
}

/* ------------------------------------------------------------------------ *
 * Capability matching (platform, deps, DB)
 * ------------------------------------------------------------------------ */

/** Baseline tags every member dev box advertises until presence rows carry an
 *  explicit set (the follow-up wiring item). */
export const DEFAULT_MACHINE_TAGS: readonly string[] = ['node', 'docker', 'pg'];

/** What a shard needs from the machine that runs it. Unit = toolchain only;
 *  integration = real PG via testcontainers (docker) too. */
export function shardRequiredTags(shard: { layer: ShardLayer }): string[] {
  return shard.layer === 'integration' ? ['node', 'docker', 'pg'] : ['node'];
}

export function machineCanRunShard(
  machineTags: readonly string[],
  shard: { layer: ShardLayer },
): boolean {
  const have = new Set(machineTags);
  return shardRequiredTags(shard).every((t) => have.has(t));
}

/** The subset of a plan's runs this machine is capable of. */
export function eligibleShards<T extends { layer: ShardLayer }>(
  machineTags: readonly string[],
  targets: readonly T[],
): T[] {
  return targets.filter((t) => machineCanRunShard(machineTags, t));
}

/**
 * Resolve the tag set a DG-3 consumer should match against for a given
 * machine's presence row (WI-1546's read side): a populated
 * `capabilityTags` wins; an empty one (never detected, or a pre-mig-566 row)
 * falls back to `DEFAULT_MACHINE_TAGS` rather than making every shard
 * unschedulable on that machine.
 */
export function machineTagsFromPresence(capabilityTags: readonly string[] | null | undefined): readonly string[] {
  return capabilityTags && capabilityTags.length > 0 ? capabilityTags : DEFAULT_MACHINE_TAGS;
}

/* ------------------------------------------------------------------------ *
 * Claimable units — mapping onto the EXISTING work-item claim machinery
 * ------------------------------------------------------------------------ */

/** A work_items:create spec for one planned shard run. */
export interface ShardRunWorkItemSpec {
  kind: 'task';
  title: string;
  body: string;
  /** The claim-time dedup floor: one OPEN item per (repo, shard, inputs). */
  dedupeKey: string;
  /** Spot checks ride the high-stakes replica machinery (claim_replica). */
  redundancy?: number;
  /** Echoed run parameters for the claiming runner. */
  run: {
    repoKey: string;
    stagingSha: string;
    shardId: string;
    inputsHash: string;
    layer: ShardLayer;
    spotCheck: boolean;
  };
}

export function shardRunDedupeKey(repoKey: string, shardId: string, inputsHash: string): string {
  return `gate-shard:${repoKey}:${shardId}@${inputsHash}`;
}

/**
 * Map a plan to claimable work-item specs: every `needed` run, plus every
 * `spotChecks` run at redundancy 2 (the deliberate double-execution — one slot
 * for the local auditor, one spare so a third machine can corroborate a
 * mismatch). Deterministic; sorted by dedupeKey.
 */
export function shardRunWorkItemSpecs(
  plan: ShardRunPlan,
  ctx: { repoKey: string; stagingSha: string },
): ShardRunWorkItemSpec[] {
  const specs: ShardRunWorkItemSpec[] = [];
  const push = (t: ShardRunTarget, spotCheck: boolean): void => {
    const dedupeKey = shardRunDedupeKey(ctx.repoKey, t.shardId, t.inputsHash);
    specs.push({
      kind: 'task',
      title: `gate-shard${spotCheck ? ' [spot-check]' : ''}: ${t.shardId} @ ${t.inputsHash.slice(0, 12)}`,
      body:
        `Distributed test gate run (DG-3). Run shard ${t.shardId} (layer ${t.layer}) of repo ` +
        `${ctx.repoKey} from staging sha ${ctx.stagingSha}; sign + record a DG-1 verdict for ` +
        `inputsHash ${t.inputsHash}.${spotCheck ? ' SPOT CHECK: compare against the covering peer verdict (DG-4 compareSpotCheck) and surface a mismatch to the owner.' : ''}`,
      dedupeKey,
      ...(spotCheck ? { redundancy: 2 } : {}),
      run: {
        repoKey: ctx.repoKey,
        stagingSha: ctx.stagingSha,
        shardId: t.shardId,
        inputsHash: t.inputsHash,
        layer: t.layer,
        spotCheck,
      },
    });
  };
  for (const t of plan.needed) push(t, false);
  for (const t of plan.spotChecks) push(t, true);
  specs.sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey));
  return specs;
}

/* ------------------------------------------------------------------------ *
 * Pull order — device-keyed rendezvous ranking
 * ------------------------------------------------------------------------ */

/**
 * A deterministic, per-machine order over the runnable shards: rank =
 * sha256(domain \n devicePubkey \n dedupe-ish key). Different devices get
 * (generally) different orders, spreading concurrent pullers across the
 * backlog; the claim lease remains the only correctness arbiter.
 */
export function rankShardsForMachine<T extends { shardId: string; inputsHash: string }>(
  devicePubkeyBase64: string,
  targets: readonly T[],
): T[] {
  return [...targets]
    .map((t) => ({
      t,
      rank: createHash('sha256')
        .update(`${SHARD_PULL_RANK_DOMAIN}\n${devicePubkeyBase64}\n${t.shardId}@${t.inputsHash}`, 'utf8')
        .digest('hex'),
    }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((x) => x.t);
}
