/**
 * pot-git/gate/verdicts.ts — DG-1: the distributed test gate's VERDICT FACT
 * (cross-machine-coord-parity-and-trust-2026-07-01 Phase 8 P-044, D-011).
 *
 * A verdict is one runner device's signed, content-addressed claim:
 *   "shard `shard_id` of repo `repo_key`, whose inputs hashed to `inputs_hash`
 *    (DG-2), ran at staging sha `staging_sha` and PASSED/FAILED in
 *    `duration_ms` ms."
 *
 * PROPERTIES:
 *   - DEVICE-SIGNED (ed25519.ts idiom, domain-separated): any peer verifies the
 *     signature offline against the embedded raw-32 pubkey — the fact carries
 *     its own proof, independent of which log relayed it.
 *   - CONTENT-ADDRESSED: `gateVerdictId` = sha256(signing bytes). The id COVERS
 *     every signed field, so a tampered replica gets a DIFFERENT id and can
 *     never overwrite the honest fact; duplicate deliveries collapse by id
 *     (INSERT … ON CONFLICT DO NOTHING — verdict rows are immutable).
 *   - REUSABLE ACROSS SHAS: the aggregator (DG-5) matches verdicts by
 *     (shard_id, inputs_hash) — a pass recorded at an older staging sha still
 *     covers a newer sha whose shard inputs are unchanged (the DG-2
 *     incremental-gate contract). `staging_sha` stays in the fact for audit +
 *     spot-check targeting (DG-4).
 *
 * Federation is DATA-PLANE: the fact federates over the hive peer-log via the
 * `gate_verdicts` CDC table (mig 442) + projections/gate-verdicts.ts, which
 * verifies signature + content address + signer MEMBERSHIP on receive. Whether
 * a verdict COUNTS toward green is the aggregator's trust decision (DG-4/DG-5)
 * — storage admission ≠ gate trust.
 *
 * Pure: node:crypto + ed25519.ts only — no PG, no git, no network.
 */

import { createHash } from 'node:crypto';
import { verifyEd25519 } from '../../../identity/ed25519';

/** Wire schema version for gate verdicts. */
export const GATE_VERDICT_SCHEMA_VERSION = 1;

/** Domain-separation tag for verdict signatures (green-attestation idiom). */
export const GATE_VERDICT_SIG_DOMAIN = 'papercusp-pot-git-gate-verdict-v1';

export type GateVerdictOutcome = 'pass' | 'fail';

/** One device's signed shard-run verdict. */
export interface GateVerdict {
  /** Wire schema version. */
  v: number;
  /** The managed repo key within the hive (G-1b: one gate per (hive, repo)). */
  repo_key: string;
  /** The staging sha the shard ran at (audit + spot-check targeting). */
  staging_sha: string;
  /** DG-2 shard id (`<workspaceName>::<layer>`). */
  shard_id: string;
  /** DG-2 inputsHash the runner computed at staging_sha — the reuse key. */
  inputs_hash: string;
  verdict: GateVerdictOutcome;
  /** Wall-clock run duration (scheduling/telemetry; signed for integrity). */
  duration_ms: number;
  /** The RUNNER device's raw-32 Ed25519 pubkey (base64) — the signer. */
  device_pubkey: string;
  /** Signer's clock at signing (epoch ms) — freshness/audit. */
  ts: number;
  /** base64 Ed25519 signature over gateVerdictSigningBytes(payload). */
  sig: string;
}

const SHA_RE = /^[0-9a-f]{40,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export function isGateVerdict(x: unknown): x is GateVerdict {
  if (!x || typeof x !== 'object') return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.v === 'number' &&
    typeof v.repo_key === 'string' &&
    v.repo_key.length > 0 &&
    typeof v.staging_sha === 'string' &&
    SHA_RE.test(v.staging_sha) &&
    typeof v.shard_id === 'string' &&
    v.shard_id.length > 0 &&
    typeof v.inputs_hash === 'string' &&
    HASH_RE.test(v.inputs_hash) &&
    (v.verdict === 'pass' || v.verdict === 'fail') &&
    typeof v.duration_ms === 'number' &&
    Number.isFinite(v.duration_ms) &&
    typeof v.device_pubkey === 'string' &&
    v.device_pubkey.length > 0 &&
    typeof v.ts === 'number' &&
    typeof v.sig === 'string'
  );
}

/** Canonical signing bytes: domain tag + FIXED field order (`sig` excluded). */
export function gateVerdictSigningBytes(payload: Omit<GateVerdict, 'sig'>): Buffer {
  const ordered = {
    v: payload.v,
    repo_key: payload.repo_key,
    staging_sha: payload.staging_sha,
    shard_id: payload.shard_id,
    inputs_hash: payload.inputs_hash,
    verdict: payload.verdict,
    duration_ms: payload.duration_ms,
    device_pubkey: payload.device_pubkey,
    ts: payload.ts,
  };
  return Buffer.from(`${GATE_VERDICT_SIG_DOMAIN}\n${JSON.stringify(ordered)}`, 'utf8');
}

/**
 * The verdict's CONTENT ADDRESS: sha256 (hex) of the signing bytes. Covers
 * every signed field (incl. signer + ts) and excludes the signature itself, so
 * a re-delivered identical fact dedups while any tampered field re-addresses.
 */
export function gateVerdictId(payload: Omit<GateVerdict, 'sig'>): string {
  return createHash('sha256').update(gateVerdictSigningBytes(payload)).digest('hex');
}

/** Build + sign a verdict (the shard-runner side). */
export async function signGateVerdict(
  fields: {
    repoKey: string;
    stagingSha: string;
    shardId: string;
    inputsHash: string;
    verdict: GateVerdictOutcome;
    durationMs: number;
    devicePubkeyBase64: string;
    nowMs: number;
  },
  sign: (bytes: Buffer) => Promise<Buffer>,
): Promise<GateVerdict> {
  const payload: Omit<GateVerdict, 'sig'> = {
    v: GATE_VERDICT_SCHEMA_VERSION,
    repo_key: fields.repoKey,
    staging_sha: fields.stagingSha,
    shard_id: fields.shardId,
    inputs_hash: fields.inputsHash,
    verdict: fields.verdict,
    duration_ms: fields.durationMs,
    device_pubkey: fields.devicePubkeyBase64,
    ts: fields.nowMs,
  };
  const sig = (await sign(gateVerdictSigningBytes(payload))).toString('base64');
  return { ...payload, sig };
}

/** Verify a verdict's signature against its EMBEDDED signer. Never throws. */
export function verifyGateVerdict(verdict: GateVerdict): boolean {
  if (!isGateVerdict(verdict)) return false;
  try {
    return verifyEd25519(
      gateVerdictSigningBytes(verdict),
      verdict.device_pubkey,
      Buffer.from(verdict.sig, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Full receive-side integrity check: shape + signature + the claimed content
 * address matches the payload. The projection calls this before any PG write;
 * membership of the signer is checked separately (it needs hive state).
 */
export function verifyGateVerdictWithId(verdict: GateVerdict, claimedId: string): boolean {
  if (!verifyGateVerdict(verdict)) return false;
  return gateVerdictId(verdict) === claimedId;
}
