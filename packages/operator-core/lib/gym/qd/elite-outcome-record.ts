/**
 * gym/qd/elite-outcome-record.ts — F1-6 / P-014 (federated-scout-gym,
 * D-005 hole 3): the DEVICE-SIGNED elite OUTCOME RECORD.
 *
 * D-005 (3) ELIGIBILITY: "sender-asserted outcomes are NOT a gate — device-signed
 * outcome records (reuse P-044 gate-verdict shape) WHERE VERIFIABLE." The current
 * elite gate is the sender-stamped `federatable` boolean (D-002: outcome=won OR
 * grade>=4). A malicious peer can stamp `federatable:true` on any garbage elite to
 * farm a locally-empty niche's novelty-gift bonus. This record makes the outcome
 * claim VERIFIABLE: the authoring device signs {niche, candidate, outcome, grade,
 * fitness} with its raw-32 Ed25519 key, and every receiver verifies the signature
 * OFFLINE against the embedded pubkey — the elite carries its own proof,
 * independent of which log relayed it.
 *
 * PROPERTIES (mirrors hive-git/gate/verdicts.ts, the P-044 idiom):
 *   - DEVICE-SIGNED, domain-separated (ed25519.ts): any peer verifies offline.
 *   - CONTENT-ADDRESSED: `eliteOutcomeRecordId` = sha256(signing bytes) covers
 *     every signed field, so a tampered replica re-addresses and can never
 *     overwrite the honest record; duplicate deliveries collapse by id.
 *   - ELIGIBILITY-BOUND: `federatableOutcome` re-checks the SIGNED outcome against
 *     the D-002 rule — a device cannot sign `graded:2` and claim eligibility. The
 *     crypto proves WHO said it; this proves WHAT they said clears the bar.
 *   - ELITE-BOUND: `verifyEliteOutcomeForElite` requires the record's
 *     (niche_key, candidate_id) to MATCH the elite it rides, and (anti-spoof) the
 *     signer device to equal the RECEIVER-STAMPED source of the federating log —
 *     so a valid record cannot be lifted from one elite and replayed onto another,
 *     nor signed by a device other than the one whose log carried it.
 *
 * "WHERE VERIFIABLE": absence of a record does NOT reject the elite (tier-1
 * hive-members admission stays backward-compatible); it marks the elite
 * outcome-UNVERIFIED so the reputation/weighting layer (P-009) can weight a
 * device-verified elite above a merely sender-asserted one. Storage admission ≠
 * gate trust (same split the gate verdict draws).
 *
 * Pure: node:crypto + ed25519.ts only — no PG, no network.
 */

import { createHash } from 'node:crypto';
import { verifyEd25519 } from '../../identity/ed25519';

/** Wire schema version for elite outcome records. */
export const ELITE_OUTCOME_SCHEMA_VERSION = 1;

/** Domain-separation tag for elite-outcome signatures. */
export const ELITE_OUTCOME_SIG_DOMAIN = 'papercusp-federated-elite-outcome-v1';

/** The eligibility basis the device attests (D-002: won OR grade>=4). */
export type EliteOutcomeBasis = 'won' | 'graded';

/** One authoring device's signed claim that a QD elite cleared the D-002
 *  federation-eligibility bar in its niche. */
export interface EliteOutcomeRecord {
  /** Wire schema version. */
  v: number;
  /** The niche this elite occupies (binds the record to the elite's niche). */
  niche_key: string;
  /** The specific candidate (binds the record to THIS elite, not just its niche). */
  candidate_id: string;
  /** The authoring hive home (audit; receiver-stamped source is the trust anchor). */
  source_hive: string;
  /** The eligibility basis (won OR graded). */
  outcome: EliteOutcomeBasis;
  /** The grade (0 when outcome='won' with no numeric grade; else the QD grade). */
  grade: number;
  /** The QD fitness — signed for integrity (a peer cannot inflate it in transit). */
  fitness: number;
  /** The authoring device's raw-32 Ed25519 pubkey (base64) — the signer. */
  device_pubkey: string;
  /** Signer's clock at signing (epoch ms) — freshness/audit. */
  ts: number;
  /** base64 Ed25519 signature over eliteOutcomeSigningBytes(payload). */
  sig: string;
}

/**
 * The D-002 eligibility rule applied to the SIGNED outcome. A device can sign any
 * record it likes; this asserts the record's own contents clear the federation
 * bar. (Mirrors agent-facts/store.ts `federatableElite`, but on the signed claim
 * — the two must agree, so the send seam signs only when federatableElite is true
 * and the receiver re-checks the signed values here.)
 */
export function federatableOutcome(r: Pick<EliteOutcomeRecord, 'outcome' | 'grade'>): boolean {
  return r.outcome === 'won' || (Number.isFinite(r.grade) && r.grade >= 4);
}

/** Shape guard — every field present + well-typed. Never throws. */
export function isEliteOutcomeRecord(x: unknown): x is EliteOutcomeRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.v === 'number' &&
    typeof r.niche_key === 'string' &&
    r.niche_key.length > 0 &&
    r.niche_key.length <= 200 &&
    typeof r.candidate_id === 'string' &&
    r.candidate_id.length > 0 &&
    r.candidate_id.length <= 200 &&
    typeof r.source_hive === 'string' &&
    (r.outcome === 'won' || r.outcome === 'graded') &&
    typeof r.grade === 'number' &&
    Number.isFinite(r.grade) &&
    typeof r.fitness === 'number' &&
    Number.isFinite(r.fitness) &&
    typeof r.device_pubkey === 'string' &&
    r.device_pubkey.length > 0 &&
    typeof r.ts === 'number' &&
    typeof r.sig === 'string' &&
    r.sig.length > 0
  );
}

/** Canonical signing bytes: domain tag + FIXED field order (`sig` excluded). */
export function eliteOutcomeSigningBytes(payload: Omit<EliteOutcomeRecord, 'sig'>): Buffer {
  const ordered = {
    v: payload.v,
    niche_key: payload.niche_key,
    candidate_id: payload.candidate_id,
    source_hive: payload.source_hive,
    outcome: payload.outcome,
    grade: payload.grade,
    fitness: payload.fitness,
    device_pubkey: payload.device_pubkey,
    ts: payload.ts,
  };
  return Buffer.from(`${ELITE_OUTCOME_SIG_DOMAIN}\n${JSON.stringify(ordered)}`, 'utf8');
}

/**
 * The record's CONTENT ADDRESS: sha256 (hex) of the signing bytes. Covers every
 * signed field (incl. signer + ts) and excludes the signature itself, so a
 * re-delivered identical record dedups while any tampered field re-addresses.
 */
export function eliteOutcomeRecordId(payload: Omit<EliteOutcomeRecord, 'sig'>): string {
  return createHash('sha256').update(eliteOutcomeSigningBytes(payload)).digest('hex');
}

/** Build + sign an outcome record (the authoring / SEND side). */
export async function signEliteOutcome(
  fields: {
    nicheKey: string;
    candidateId: string;
    sourceHive: string;
    outcome: EliteOutcomeBasis;
    grade: number;
    fitness: number;
    devicePubkeyBase64: string;
    nowMs: number;
  },
  sign: (bytes: Buffer) => Promise<Buffer>,
): Promise<EliteOutcomeRecord> {
  const payload: Omit<EliteOutcomeRecord, 'sig'> = {
    v: ELITE_OUTCOME_SCHEMA_VERSION,
    niche_key: fields.nicheKey,
    candidate_id: fields.candidateId,
    source_hive: fields.sourceHive,
    outcome: fields.outcome,
    grade: fields.grade,
    fitness: fields.fitness,
    device_pubkey: fields.devicePubkeyBase64,
    ts: fields.nowMs,
  };
  const sig = (await sign(eliteOutcomeSigningBytes(payload))).toString('base64');
  return { ...payload, sig };
}

/** Verify a record's signature against its EMBEDDED signer. Never throws. */
export function verifyEliteOutcome(record: EliteOutcomeRecord): boolean {
  if (!isEliteOutcomeRecord(record)) return false;
  try {
    return verifyEd25519(
      eliteOutcomeSigningBytes(record),
      record.device_pubkey,
      Buffer.from(record.sig, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Full RECEIVE-side eligibility check for an elite riding a federated op. ALL of:
 *   1. shape + signature valid (`verifyEliteOutcome`);
 *   2. the SIGNED outcome clears the D-002 bar (`federatableOutcome`);
 *   3. the record BINDS to this elite: niche_key + candidate_id match;
 *   4. ANTI-SPOOF (anti-lift): the signer device == the DEVICE that owns the
 *      relaying source log — so a record cannot be lifted off one peer's elite
 *      and replayed by another;
 *   5. MEMBERSHIP (optional seam, mirrors projections/gate-verdicts.ts): the
 *      signer device is an ADMITTED hive member — a valid signature from an
 *      un-admitted device is NOT eligibility.
 *
 * IDENTITY NOTE — the wiring MUST resolve the device, not pass the log key. The
 * substrate stamps a remote op's `provenance.authorPubkey` with the receiver-side
 * SOURCE LOG KEY (`sourceLogKeyHex`), which is the hypercore LOG key, NOT a device
 * identity. Resolve the signer device via boot.ts `admittedIdentities`:
 *   `expectedSignerDevice = admittedIdentities.get(sourceLogKeyHex)?.devicePubkey`
 * and pass THAT (the device that owns the relaying log). Passing the raw
 * `provenance.authorPubkey` (a log key) would compare a device key to a log key
 * and always fail. When the caller cannot resolve the device (diagnostics), omit
 * `expectedSignerDevice` to skip only check 4.
 *
 * Returns true ⇒ this elite's outcome is DEVICE-VERIFIED eligible.
 */
export function verifyEliteOutcomeForElite(
  record: unknown,
  expected: {
    nicheKey: string;
    candidateId: string;
    /**
     * The DEVICE pubkey that owns the relaying source log — resolved via
     * `admittedIdentities.get(sourceLogKeyHex).devicePubkey`, NOT the raw
     * `provenance.authorPubkey` (which is the LOG key). Omit to skip the anti-lift
     * check (diagnostics only).
     */
    expectedSignerDevice?: string;
    /**
     * Membership seam (mirrors gate-verdicts' `resolveMembership`): returns true
     * iff the signer device is an admitted hive member. When provided, a
     * non-member signer fails. Omit to skip the membership check (e.g. tier-1
     * pre-admission diagnostics).
     */
    isSignerAdmitted?: (devicePubkey: string) => boolean;
  },
): boolean {
  if (!isEliteOutcomeRecord(record)) return false;
  if (!verifyEliteOutcome(record)) return false;
  if (!federatableOutcome(record)) return false;
  if (record.niche_key !== expected.nicheKey) return false;
  if (record.candidate_id !== expected.candidateId) return false;
  if (expected.expectedSignerDevice !== undefined && record.device_pubkey !== expected.expectedSignerDevice) {
    return false;
  }
  if (expected.isSignerAdmitted !== undefined && !expected.isSignerAdmitted(record.device_pubkey)) {
    return false;
  }
  return true;
}
