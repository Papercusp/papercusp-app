/**
 * pot-git/staging-advance.ts — signed, epoch-fenced staging advances (Phase 7
 * G-5d, cross-machine-coord-parity-and-trust-2026-07-01 / P-038; D-011 hole 2).
 *
 * F6/D-022: canonical authority is the single owning hive, not the locally
 * selected integrator or a membership epoch. V3 carries both the device's
 * scoped signature and the hive owner's countersignature. Receivers pin the
 * hive/repository identity, require that owner proof, then enforce accepted
 * store generation, publication term/sequence and fast-forward ancestry.
 *
 * The owner persists publication term/sequence in existing routine metadata.
 * Peers cannot authorize an advance by electing themselves at the same roster
 * epoch, inventing a higher term or replaying a device-only legacy envelope.
 * Legacy decoding remains explicit for migration tests; production disables it.
 * No partition-safe automatic ownership failover is claimed.
 *
 * This module is the PAYLOAD + ACCEPTANCE layer: `integrateMemberHeads` (G-5)
 * computes the sha, the announcement rail (G-3, leader-held) carries the signed
 * envelope built here, and receivers run `acceptStagingAdvance` (pure) or
 * `acceptStagingAdvanceFF` (adds the git ancestry check) before mirroring.
 *
 * Pure over ed25519.ts + storage.ts's RunGit seam — the sign/verify/accept core
 * has no I/O at all and unit-tests without git.
 */

import { verifyEd25519 } from '../../identity/ed25519';
import { type RunGit, defaultRunGit } from './storage';
import { requireHiveEffectAuthority, type HiveEffectAuthority } from './hive-effect-authority';
import {
  SIGNED_PROTOCOL_SCHEMA_VERSION,
  isSignedProtocolContext,
  signedProtocolContextMatches,
  type ExpectedSignedProtocolContext,
  storeGenerationOrdinal,
  type SignedProtocolContext,
} from './signed-context';

/** Wire schema version for the staging-advance envelope. */
export const STAGING_ADVANCE_SCHEMA_VERSION = 1;
export const STAGING_ADVANCE_SCHEMA_VERSION_CONTEXT = SIGNED_PROTOCOL_SCHEMA_VERSION;
/** F6: device signature plus the single owning hive's countersignature. */
export const STAGING_ADVANCE_SCHEMA_VERSION_AUTHORITY = 3;

/**
 * Domain-separation tag mixed into the signed bytes (the hive-policy idiom,
 * HIVE_POLICY_SIG_DOMAIN) so a staging-advance signature can never be replayed
 * as a different signed artifact (sigrefs blob, handoff token, …).
 */
export const STAGING_ADVANCE_SIG_DOMAIN = 'papercusp-pot-git-staging-advance-v1';

/** The hive-wide rendezvous key (P-009 rail, the ref-announce.ts idiom): the
 *  integrator tick (integrator-tick.ts, P-203) fires
 *  `events:emit { event: STAGING_ADVANCE_EVENT_KEY, scope: 'hive', payload: SignedStagingAdvance }`
 *  after a successful integration pass; every member's worktree-bridge driver
 *  (worktree-bridge.ts, P-204) holds an events:await on the same key. */
export const STAGING_ADVANCE_EVENT_KEY = 'pot-git:staging-advance';

/** A publication fence: owner term + per-term advance sequence (not roster epoch). */
export interface EpochSeq {
  /** Monotonic owner publication term; persisted separately from membership. */
  epoch: number;
  /** Monotonic per-epoch advance counter — bumps on every staging publish. */
  seq: number;
}

/** The signed staging-advance payload (fixed field order = the signing order). */
export interface StagingAdvancePayload extends EpochSeq {
  /** Wire schema version. */
  v: number;
  /** The integrator device's raw-32 Ed25519 pubkey (base64) — bound into the sig. */
  device_pubkey: string;
  /** The new staging head this advance publishes. */
  staging_sha: string;
  /** Advance time (epoch ms) — audit/freshness only, NOT part of the ordering. */
  ts: number;
  /** V2 stable signed identity tuple. Absent on legacy v1 envelopes. */
  hive_id?: string;
  repo_key?: string;
  store_generation?: string;
}

export interface SignedStagingAdvance extends StagingAdvancePayload {
  /** base64 Ed25519 signature over stagingAdvanceSigningBytes(payload). */
  sig: string;
  /** Required for v3, verified against the receiver's pinned hive identity. */
  hive_sig?: string;
}

function isNonNegInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
}

const SHA_RE = /^[0-9a-f]{40,64}$/;

function isStagingAdvancePayload(x: unknown): x is StagingAdvancePayload {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  const baseOk = (
    typeof s.v === 'number' &&
    typeof s.device_pubkey === 'string' &&
    isNonNegInt(s.epoch) &&
    isNonNegInt(s.seq) &&
    typeof s.staging_sha === 'string' &&
    SHA_RE.test(s.staging_sha) &&
    typeof s.ts === 'number' &&
    (s.v === STAGING_ADVANCE_SCHEMA_VERSION || s.v === STAGING_ADVANCE_SCHEMA_VERSION_CONTEXT ||
      s.v === STAGING_ADVANCE_SCHEMA_VERSION_AUTHORITY)
  );
  if (!baseOk) return false;
  return s.v === STAGING_ADVANCE_SCHEMA_VERSION || isSignedProtocolContext(s);
}

export function isSignedStagingAdvance(x: unknown): x is SignedStagingAdvance {
  return isStagingAdvancePayload(x) && typeof (x as unknown as Record<string, unknown>).sig === 'string';
}

/**
 * Canonical signing bytes: the domain tag, then the payload in FIXED field
 * order (`sig` excluded). Deterministic on both ends — the sigrefs idiom plus
 * domain separation.
 */
export function stagingAdvanceSigningBytes(payload: StagingAdvancePayload): Buffer {
  const ordered: Record<string, unknown> = {
    v: payload.v,
    device_pubkey: payload.device_pubkey,
    epoch: payload.epoch,
    seq: payload.seq,
    staging_sha: payload.staging_sha,
    ts: payload.ts,
  };
  if (payload.v >= STAGING_ADVANCE_SCHEMA_VERSION_CONTEXT) {
    ordered.hive_id = payload.hive_id;
    ordered.repo_key = payload.repo_key;
    ordered.store_generation = payload.store_generation;
  }
  return Buffer.from(`${STAGING_ADVANCE_SIG_DOMAIN}\n${JSON.stringify(ordered)}`, 'utf8');
}

/**
 * Build + sign a staging advance for the integrator device. `sign` is the
 * device signer seam (prod: `bytes => signWithDeviceKey(keychainId, bytes)`;
 * tests: `bytes => signWithPrivateKeyDer(der, bytes)`).
 */
export async function signStagingAdvance(
  fields: { devicePubkeyBase64: string; epoch: number; seq: number; stagingSha: string; nowMs: number; context?: SignedProtocolContext; authority?: HiveEffectAuthority },
  sign: (bytes: Buffer) => Promise<Buffer>,
): Promise<SignedStagingAdvance> {
  const payload: StagingAdvancePayload = {
    v: fields.authority ? STAGING_ADVANCE_SCHEMA_VERSION_AUTHORITY : fields.context ? STAGING_ADVANCE_SCHEMA_VERSION_CONTEXT : STAGING_ADVANCE_SCHEMA_VERSION,
    device_pubkey: fields.devicePubkeyBase64,
    epoch: fields.epoch,
    seq: fields.seq,
    staging_sha: fields.stagingSha,
    ts: fields.nowMs,
    ...(fields.context ?? {}),
  };
  if (!isStagingAdvancePayload(payload)) {
    throw new Error('pot-git: signStagingAdvance called with a malformed payload');
  }
  const sig = (await sign(stagingAdvanceSigningBytes(payload))).toString('base64');
  if (fields.authority) {
    if (!fields.context) throw new Error('pot-git: owner authorization requires signed context');
    await requireHiveEffectAuthority(fields.authority, fields.context, ['staging-announce', fields.stagingSha]);
    const signed = { ...payload, sig };
    const hive_sig = (await fields.authority.sign(stagingAuthoritySigningBytes(signed))).toString('base64');
    if (!verifyStagingAuthority({ ...signed, hive_sig }, fields.context.hive_id)) {
      throw new Error('pot-git: invalid owning hive countersignature');
    }
    return { ...signed, hive_sig };
  }
  return { ...payload, sig };
}

function stagingAuthoritySigningBytes(signed: SignedStagingAdvance): Buffer {
  return Buffer.concat([Buffer.from('papercusp-hive-staging-authority-v1\n'),
    stagingAdvanceSigningBytes(signed), Buffer.from('\n' + signed.sig)]);
}

function verifyStagingAuthority(signed: SignedStagingAdvance, hiveId: string): boolean {
  try {
    return signed.v === STAGING_ADVANCE_SCHEMA_VERSION_AUTHORITY && typeof signed.hive_sig === 'string' &&
      verifyEd25519(stagingAuthoritySigningBytes(signed), hiveId, Buffer.from(signed.hive_sig, 'base64'));
  } catch { return false; }
}

/**
 * Verify a signed staging advance. When `expectedDevicePubkeyBase64` is given
 * the embedded device must equal it; otherwise the signature is verified
 * against the EMBEDDED device key and the caller MUST separately gate that
 * device (hive membership / current-authority check). Never throws.
 */
export function verifyStagingAdvance(
  signed: SignedStagingAdvance,
  expectedDevicePubkeyBase64?: string,
): boolean {
  if (!isSignedStagingAdvance(signed)) return false;
  if (expectedDevicePubkeyBase64 !== undefined && signed.device_pubkey !== expectedDevicePubkeyBase64) {
    return false;
  }
  try {
    const bytes = stagingAdvanceSigningBytes(signed);
    return verifyEd25519(bytes, signed.device_pubkey, Buffer.from(signed.sig, 'base64'));
  } catch {
    return false;
  }
}

/** Total order on fencing pairs: epoch first, then seq. -1 | 0 | 1. */
export function compareEpochSeq(a: EpochSeq, b: EpochSeq): number {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

export type StagingAdvanceAcceptance =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'malformed'
        | 'wrong-device'
        | 'bad-signature'
        | 'missing-hive-authority'
        | 'ungranted-epoch'
        | 'stale-epoch-seq'
        | 'non-fast-forward'
        | 'unknown-sha'
        | 'legacy-version'
        | 'context-mismatch'
        | 'unknown-generation'
        | 'stale-generation';
    };

export interface AcceptStagingAdvanceOpts {
  /** Pin the advance to ONE expected integrator device (strict mode). */
  expectedDevice?: string;
  /**
   * Or: the set of devices allowed to integrate (e.g. current hive members).
   * The embedded device must be in the set. Ignored when `expectedDevice` is
   * given. Neither given ⇒ signature self-consistency only — the caller MUST
   * gate the device itself.
   */
  allowedDevices?: readonly string[];
  /**
   * INSIDER-POISONING guard (WI-1560): the highest epoch the receiver believes
   * has been LEGITIMATELY GRANTED — i.e. the last verified G-0 handoff token's
   * `nextEpoch` (handoff-token.ts `adoptHandoffToken`), or the lock-authority
   * lease epoch. An advance claiming `epoch > maxGrantedEpoch` is rejected
   * `ungranted-epoch` even when its device passes the gate.
   *
   * WHY: with `allowedDevices` (a member SET, not one pinned authority), any
   * ADMITTED member could self-sign `epoch: 1e9` over the current sha — the
   * fence would accept it, poison the persisted watermark, and every future
   * legitimate advance would be rejected `stale-epoch-seq`, UNRECOVERABLY
   * (no grantable epoch exceeds 1e9 in practice). With the cap, an insider can
   * at worst poison the SEQ space WITHIN the current epoch — which the real
   * authority recovers from at the next epoch grant, since (epoch+1, 0) beats
   * (epoch, anySeq) in the lexicographic order. Receivers using
   * `allowedDevices` SHOULD set this; with `expectedDevice` (one pinned
   * authority) it is optional — only that authority can sign at all.
   */
  maxGrantedEpoch?: number;
  /** Expected context pins the owner key as well as the repository. */
  expectedContext?: ExpectedSignedProtocolContext;
  allowLegacy?: boolean;
  /** Generations already accepted through this device's signed snapshots. */
  knownStoreGenerations?: Readonly<Record<string, string>>;
}

/**
 * PURE acceptance for a fetched/announced staging advance (G-5d): signature +
 * device gate + STRICT (epoch, seq) monotonicity vs the last-accepted pair
 * (`prior`, null when none accepted yet). A lower/equal pair is rejected —
 * this is what fences a stale ex-authority's late advance and any replay.
 * The fast-forward leg needs git; use {@link acceptStagingAdvanceFF} for the
 * combined check. The caller persists acceptance by mirroring the ref and
 * storing the new (epoch, seq) watermark.
 */
export function acceptStagingAdvance(
  incoming: SignedStagingAdvance,
  prior: EpochSeq | null,
  opts: AcceptStagingAdvanceOpts = {},
): StagingAdvanceAcceptance {
  if (!isSignedStagingAdvance(incoming)) return { ok: false, reason: 'malformed' };
  if (incoming.v === STAGING_ADVANCE_SCHEMA_VERSION &&
      (opts.allowLegacy !== true || opts.knownStoreGenerations?.[incoming.device_pubkey])) {
    return { ok: false, reason: 'legacy-version' };
  }
  if (incoming.v >= STAGING_ADVANCE_SCHEMA_VERSION_CONTEXT &&
      (!opts.expectedContext || !signedProtocolContextMatches(incoming, opts.expectedContext))) {
    return { ok: false, reason: 'context-mismatch' };
  }
  if (opts.expectedDevice !== undefined) {
    if (incoming.device_pubkey !== opts.expectedDevice) return { ok: false, reason: 'wrong-device' };
  } else if (opts.allowedDevices !== undefined && !opts.allowedDevices.includes(incoming.device_pubkey)) {
    return { ok: false, reason: 'wrong-device' };
  }
  if (!verifyStagingAdvance(incoming)) return { ok: false, reason: 'bad-signature' };
  // Legacy negotiation is explicit. Production never enables it; membership
  // alone cannot authorize canonical advances, even at a newer local epoch.
  if ((incoming.v === STAGING_ADVANCE_SCHEMA_VERSION_AUTHORITY || opts.allowLegacy !== true) &&
      (!opts.expectedContext || !verifyStagingAuthority(incoming, opts.expectedContext.hive_id))) {
    return { ok: false, reason: 'missing-hive-authority' };
  }
  if (incoming.v >= STAGING_ADVANCE_SCHEMA_VERSION_CONTEXT && opts.knownStoreGenerations) {
    const known = opts.knownStoreGenerations[incoming.device_pubkey];
    if (known !== incoming.store_generation) {
      const oldOrdinal = storeGenerationOrdinal(known);
      const newOrdinal = storeGenerationOrdinal(incoming.store_generation)!;
      return { ok: false, reason: oldOrdinal === null || newOrdinal > oldOrdinal ? 'unknown-generation' : 'stale-generation' };
    }
  }
  if (opts.maxGrantedEpoch !== undefined && incoming.epoch > opts.maxGrantedEpoch) {
    return { ok: false, reason: 'ungranted-epoch' };
  }
  if (prior !== null && compareEpochSeq(incoming, prior) <= 0) {
    return { ok: false, reason: 'stale-epoch-seq' };
  }
  return { ok: true };
}

/**
 * Full receiver-side acceptance: the pure G-5d check PLUS the fast-forward
 * invariant — `priorStagingSha` (the last accepted staging, null when none)
 * must be an ancestor of (or equal to) the incoming staging sha, and the
 * incoming sha must resolve to a commit already present locally (fetch the
 * namespace FIRST, then accept). Staging never rewinds and never moves
 * sideways, even within a valid higher epoch.
 */
export async function acceptStagingAdvanceFF(
  repoPath: string,
  incoming: SignedStagingAdvance,
  prior: EpochSeq | null,
  priorStagingSha: string | null,
  opts: AcceptStagingAdvanceOpts & { runGit?: RunGit } = {},
): Promise<StagingAdvanceAcceptance> {
  const pure = acceptStagingAdvance(incoming, prior, opts);
  if (!pure.ok) return pure;
  const runGit = opts.runGit ?? defaultRunGit;
  const exists = await runGit(['rev-parse', '--verify', '-q', `${incoming.staging_sha}^{commit}`], repoPath);
  if (exists.code !== 0) return { ok: false, reason: 'unknown-sha' };
  if (priorStagingSha !== null) {
    // merge-base --is-ancestor is reflexive: equal shas pass (a re-publish of
    // the same staging under a higher (epoch, seq) is a legal no-op advance).
    const ff = await runGit(['merge-base', '--is-ancestor', priorStagingSha, incoming.staging_sha], repoPath);
    if (ff.code !== 0) return { ok: false, reason: 'non-fast-forward' };
  }
  return { ok: true };
}
