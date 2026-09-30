/**
 * pot-git/gate/aggregator.ts — DG-5: the distributed test gate's AGGREGATION
 * verdict (cross-machine-coord-parity-and-trust-2026-07-01 Phase 8 P-048,
 * D-011).
 *
 * green(S) for a repo = EVERY shard in manifest(S) (DG-2 shards.ts) has a
 * `pass` verdict (DG-1 verdicts.ts) from a GATE-TRUSTED device whose
 * `inputs_hash` equals the shard's inputsHash AT S. The verdict's own
 * `staging_sha` may be OLDER — matching by (shard_id, inputs_hash) is the
 * incremental-gate contract: an unchanged shard's prior green is reused, never
 * re-run. ONE trusted fail at the current inputs_hash, one missing shard, or
 * unknown coverage ⇒ NOT green.
 *
 * FAIL-CLOSED VETOES (each surfaced with a reason, never silent):
 *   - `unreadableWorkspaces` non-empty ⇒ coverage UNKNOWN ⇒ not green (build
 *     the manifest with a SubmoduleRepoResolver to clear it — DG-2 contract);
 *   - an EMPTY manifest ⇒ not green (a gate over nothing proves nothing —
 *     empty almost always means discovery failed, and a vacuous green would
 *     read as "covered everything");
 *   - a shard with no inputsHash entry ⇒ not green (defective manifest input);
 *   - a trusted fail alongside a trusted pass at the SAME inputs_hash ⇒
 *     `conflict` ⇒ not green (a lying/flaky runner is a DG-4 spot-check
 *     matter, never something aggregation papers over).
 *
 * TRUST is INJECTED (`isGateTrusted`, DG-4 Lane D): storage admission already
 * verified signature + content address + hive MEMBERSHIP (the projection), but
 * membership ≠ gate trust — an admitted member without the `gate` grant can
 * store verdicts that simply never count. Signatures are RE-verified here
 * anyway (defense in depth — the aggregation must hold even over a tampered
 * store).
 *
 * OUTPUT feeds Lane B's release-promotion.ts: when green, `attestGreen` signs
 * a GreenAttestation with the green-bot identity — the proof `promoteRelease`
 * verifies + counts against the G-6 crefs threshold rule. Spot-check SELECTION
 * (DG-4 `selectSpotChecks`) is a scheduling-side concern; its re-run results
 * arrive here as ordinary additional verdicts.
 *
 * Pure: shards.ts + verdicts.ts + release-promotion.ts shapes only — no PG, no
 * git, no clock (callers pass `nowMs`).
 */

import type { ShardManifest } from './shards';
import { type GateVerdict, verifyGateVerdict } from './verdicts';
import { type GreenAttestation, signGreenAttestation } from '../release-promotion';

export type ShardGateStatus =
  /** A trusted, valid pass at the current inputsHash (and no trusted fail). */
  | 'pass'
  /** At least one trusted, valid fail at the current inputsHash — and no pass. */
  | 'fail'
  /** Trusted pass AND trusted fail at the same inputsHash — surfaced, vetoes green. */
  | 'conflict'
  /** No trusted verdict at the current inputsHash. */
  | 'missing'
  /** The manifest/inputsHash inputs were defective for this shard. */
  | 'no-inputs-hash';

export interface ShardGateReport {
  shardId: string;
  status: ShardGateStatus;
  /** Distinct trusted devices with a valid pass at the current inputsHash. */
  passDevices: string[];
  /** Distinct trusted devices with a valid fail at the current inputsHash. */
  failDevices: string[];
}

export interface GateAggregation {
  green: boolean;
  repoKey: string;
  stagingSha: string;
  shards: ShardGateReport[];
  /** Shard ids by veto class — convenience projections of `shards`. */
  failed: string[];
  missing: string[];
  conflicts: string[];
  /** DG-2's loudly-reported gitlink-shielded workspaces — coverage unknown. */
  coverageUnknown: { dir: string; reason: string }[];
  /** Human-readable veto reasons; EMPTY iff green. */
  reasons: string[];
}

export interface GateAggregationInput {
  /** The managed repo this gate covers (verdicts must match it). */
  repoKey: string;
  /** The staging sha being gated. */
  stagingSha: string;
  /** DG-2 manifest at `stagingSha`. */
  manifest: ShardManifest;
  /** DG-2 per-shard inputsHash at `stagingSha` (the reuse key). */
  inputsHashByShardId: Record<string, string>;
  /** The verdict pool (typically every PG row for (repoKey, shard set)). */
  verdicts: readonly GateVerdict[];
  /** DG-4 gate-trust seam: does this device's verdict COUNT? */
  isGateTrusted: (devicePubkeyBase64: string) => boolean;
}

/**
 * The pure DG-5 aggregation. Deterministic over its inputs; never throws.
 */
export function aggregateGate(input: GateAggregationInput): GateAggregation {
  const reasons: string[] = [];
  const coverageUnknown = input.manifest.unreadableWorkspaces.map((u) => ({
    dir: u.dir,
    reason: u.reason,
  }));
  if (coverageUnknown.length > 0) {
    reasons.push(
      `coverage unknown: ${coverageUnknown.length} workspace(s) unreadable at the sha (build the manifest with a SubmoduleRepoResolver)`,
    );
  }
  if (input.manifest.shards.length === 0) {
    reasons.push('empty manifest: zero shards discovered — a vacuous gate never greens');
  }

  // Index the usable verdicts once: valid signature + trusted device + this repo.
  // (shard_id/inputs_hash matching happens per shard below; staging_sha is
  // deliberately NOT matched — reuse across shas is the incremental contract.)
  const byShardAndHash = new Map<string, { pass: Set<string>; fail: Set<string> }>();
  for (const v of input.verdicts) {
    if (v.repo_key !== input.repoKey) continue;
    if (!input.isGateTrusted(v.device_pubkey)) continue;
    if (!verifyGateVerdict(v)) continue;
    const key = `${v.shard_id}\x00${v.inputs_hash}`;
    let slot = byShardAndHash.get(key);
    if (!slot) {
      slot = { pass: new Set(), fail: new Set() };
      byShardAndHash.set(key, slot);
    }
    (v.verdict === 'pass' ? slot.pass : slot.fail).add(v.device_pubkey);
  }

  const shards: ShardGateReport[] = [];
  const failed: string[] = [];
  const missing: string[] = [];
  const conflicts: string[] = [];
  for (const shard of input.manifest.shards) {
    const inputsHash = input.inputsHashByShardId[shard.shardId];
    if (!inputsHash) {
      shards.push({ shardId: shard.shardId, status: 'no-inputs-hash', passDevices: [], failDevices: [] });
      reasons.push(`shard ${shard.shardId}: no inputsHash provided for the gated sha`);
      continue;
    }
    const slot = byShardAndHash.get(`${shard.shardId}\x00${inputsHash}`);
    const passDevices = slot ? [...slot.pass].sort() : [];
    const failDevices = slot ? [...slot.fail].sort() : [];
    let status: ShardGateStatus;
    if (passDevices.length > 0 && failDevices.length > 0) {
      status = 'conflict';
      conflicts.push(shard.shardId);
      reasons.push(
        `shard ${shard.shardId}: conflicting trusted verdicts at the same inputsHash (spot-check the runners)`,
      );
    } else if (failDevices.length > 0) {
      status = 'fail';
      failed.push(shard.shardId);
      reasons.push(`shard ${shard.shardId}: trusted fail`);
    } else if (passDevices.length > 0) {
      status = 'pass';
    } else {
      status = 'missing';
      missing.push(shard.shardId);
      reasons.push(`shard ${shard.shardId}: no trusted verdict at the current inputsHash`);
    }
    shards.push({ shardId: shard.shardId, status, passDevices, failDevices });
  }

  return {
    green: reasons.length === 0,
    repoKey: input.repoKey,
    stagingSha: input.stagingSha,
    shards,
    failed,
    missing,
    conflicts,
    coverageUnknown,
    reasons,
  };
}

/**
 * When (and only when) the aggregation is green, sign the green-bot
 * attestation over the gated sha — the proof Lane B's `promoteRelease` counts
 * against the crefs rule. Returns null on a non-green aggregation
 * (fail-closed; the caller surfaces `aggregation.reasons`).
 */
export async function attestGreen(
  aggregation: GateAggregation,
  signer: { devicePubkeyBase64: string; sign: (bytes: Buffer) => Promise<Buffer> },
  nowMs: number,
): Promise<GreenAttestation | null> {
  if (!aggregation.green) return null;
  // WI-1554: `aggregation.repoKey` was ALREADY in scope here but never threaded
  // into the signed payload — the live bug the WI reports (repo binding is
  // dropped at the one real call site that mints a GreenAttestation).
  return signGreenAttestation(
    {
      repoKey: aggregation.repoKey,
      stagingSha: aggregation.stagingSha,
      signerPubkeyBase64: signer.devicePubkeyBase64,
      nowMs,
    },
    signer.sign,
  );
}
