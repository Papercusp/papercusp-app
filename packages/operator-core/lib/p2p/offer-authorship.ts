/**
 * p2p/offer-authorship.ts — the WORK-OFFER AUTHORSHIP CHAIN
 * (p2p-work-distribution-2026-07-02 P-102).
 *
 * Item spec (the plan item is the spec, D-016):
 *   Signed work offers / authorship chain: offers device-signed (gate-verdict
 *   P-044 shape); RECEIVER verifies
 *     device-sig  →  device attested to a gh user (WI-1585 flow)
 *                 →  user in the owner-signed publisher set
 *                 →  owner anchored via GitHub auth.
 * Baked amendments:
 *   C5   — offers carry a min-runtime-version; a host lacking a required
 *          capability REFUSES loudly instead of launching UNCLAMPED (the live
 *          stale-VM-bundle precedent — half the plane silently did not exist).
 *   H7+X6 — spawn-class verification gates EPOCH-MONOTONIC: a high-water epoch
 *          per grantor (here the publisher-set OWNER), and a record whose epoch
 *          TRAILS the receiver's high-water is REFUSED. Mirrors grant-store.ts's
 *          checkP2pCapability spawn-class fence exactly (work-offer IS spawn-class,
 *          see capabilities.ts SPAWN_CLASS_CAPABILITIES).
 *   H8   — arrival-time freshness is ADVISORY only; the WALL CLOCK NEVER gates
 *          revocation (that is offer-budget.ts's TTL job). Authority is decided
 *          by the epoch, never by time.
 *
 * This is a PURE module (rollout-tiers.ts / offer-budget.ts discipline): no PG,
 * no IO, no clock, no keychain. The three things a real receiver resolves from
 * the world — the device→user ATTESTATION (identity/attest.ts + the gist flow),
 * the owner-signed PUBLISHER SET (P-101 fleet directory / grant-store.ts), and
 * the owner's high-water EPOCH (grant-store.ts p2p_grantor_epochs) — are PASSED
 * IN as already-resolved verdicts, so the whole chain stays a property-testable
 * set of pure functions. The only crypto edge used here is a stateless Ed25519
 * signature VERIFY over canonical bytes (identity/ed25519.ts).
 *
 * SECURITY POSTURE: the verdict's `authorizedGithubUserId` is the
 * CRYPTOGRAPHICALLY-PROVEN signer (device pubkey → attested user), NOT the
 * offer's self-claimed `publisherRef`. A host deciding authority MUST use the
 * proven id and treat `publisherRef` as display/routing only — a compromised or
 * lying publisher can put anything in `publisherRef`, but cannot forge the
 * device signature or the owner-signed set membership.
 */

import { verifyEd25519 } from '../identity/ed25519';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { WorkOffer } from './offer-budget';

/* ─────────────────────────────────────────────────────────────────────────
 * The signed authorship envelope that rides on an offer
 * ───────────────────────────────────────────────────────────────────────── */

export interface OfferAuthorship {
  /** The signing device's RAW 32-byte Ed25519 pubkey, base64 (identity/ed25519). */
  readonly devicePubkey: string;
  /** Ed25519 signature over offerAuthorshipSigningBytes(offer, epoch), base64. */
  readonly signatureByDevice: string;
  /**
   * The publisher-set OWNER's high-water epoch this offer was stamped at (X6).
   * A receiver refuses the offer once its own high-water for that owner exceeds
   * this value (a revoked publisher / re-keyed roster bumped the epoch).
   */
  readonly epoch: number;
}

/**
 * The canonical bytes the publisher device signs — the WHOLE offer plus the
 * stamped epoch, JCS-canonicalized so any field tamper (a widened budget, a
 * dropped isolationReq, a bumped priority) invalidates the signature. Both the
 * signer (publisher) and the verifier (receiver) call this — one source of truth.
 */
export function offerAuthorshipSigningBytes(offer: WorkOffer, epoch: number): Buffer {
  return Buffer.from(canonicalJson({ offer, epoch }), 'utf8');
}

/** Package a produced signature into the authorship envelope. The signing itself
 *  (keychain-bound, async — identity/sign-with-device-key.ts) stays OUT of this
 *  pure module; callers pass the raw signature they produced over the bytes above. */
export function buildOfferAuthorship(args: {
  devicePubkey: string;
  epoch: number;
  signature: Buffer;
}): OfferAuthorship {
  return { devicePubkey: args.devicePubkey, epoch: args.epoch, signatureByDevice: args.signature.toString('base64') };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Verification inputs — each already resolved by the receiver's IO edges
 * ───────────────────────────────────────────────────────────────────────── */

/** The fleet's owner-signed publisher set (P-101 directory / grant-store). */
export interface PublisherSet {
  /** The accountable ROOT owner — a numeric GitHub user id (X9; login is display-only). */
  readonly ownerGithubUserId: number;
  /** Is the owner anchored via GitHub auth (root identity proven)? */
  readonly ownerAnchored: boolean;
  /** Is the owner's signature over THIS publisher set valid (owner-SIGNED)? */
  readonly ownerSignatureValid: boolean;
  /** The numeric GitHub user ids in the owner-signed publisher set. */
  readonly memberGithubUserIds: readonly number[];
}

/** The host's runtime profile, for the C5 min-runtime + capability gates. */
export interface HostRuntimeProfile {
  /** Dotted-numeric runtime version, e.g. "1.4.2". */
  readonly runtimeVersion: string;
  /** Capabilities this host can satisfy (e.g. the C2 clamps it enforces). */
  readonly capabilities: readonly string[];
}

export interface AuthorshipVerifyInput {
  /** The offer as received. */
  readonly offer: WorkOffer;
  /** The signed authorship envelope that rode on it. */
  readonly authorship: OfferAuthorship;
  /**
   * The github user id the SIGNING DEVICE is attested to (WI-1585 flow /
   * identity attestation), or null when the device is unattested or its
   * attestation failed to verify. Resolved by the receiver's attestation verifier.
   */
  readonly attestedGithubUserId: number | null;
  /** The offer's fleet publisher set, owner-signed. */
  readonly publisherSet: PublisherSet;
  /**
   * X6: the receiver's CURRENT high-water epoch for this publisher set's owner.
   * Monotonic (grant-store.ts advanceGrantorHighWater). Never a wall clock.
   */
  readonly ownerHighWaterEpoch: number;
  /** The host's runtime + capabilities (C5). */
  readonly host: HostRuntimeProfile;
}

/* ─────────────────────────────────────────────────────────────────────────
 * The verdict
 * ───────────────────────────────────────────────────────────────────────── */

export type AuthorshipRefusalCode =
  | 'device_sig_invalid'
  | 'device_not_attested'
  | 'user_not_in_publisher_set'
  | 'owner_signature_invalid'
  | 'owner_unanchored'
  | 'epoch_stale'
  | 'runtime_too_old'
  | 'capability_unsatisfied';

export type AuthorshipVerdict =
  | {
      readonly ok: true;
      /** The CRYPTOGRAPHICALLY-PROVEN signer — the authority the host acts on. */
      readonly authorizedGithubUserId: number;
      readonly ownerGithubUserId: number;
      readonly epoch: number;
    }
  | {
      readonly ok: false;
      readonly code: AuthorshipRefusalCode;
      /** The exact link that failed — carried verbatim into a P-004 refusal receipt (D-004). */
      readonly detail: string;
    };

/* ─────────────────────────────────────────────────────────────────────────
 * C5 — min-runtime-version comparison (fail closed on malformed)
 * ───────────────────────────────────────────────────────────────────────── */

function parseDottedVersion(v: string): number[] | null {
  const parts = v.trim().split('.');
  if (parts.length === 0 || parts[0] === '') return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return nums;
}

/**
 * Does `hostVersion` satisfy `minRequired` (host >= min)? No requirement ⇒ true.
 * A MALFORMED version on either side returns FALSE — C5 fails CLOSED: a host that
 * cannot prove it meets the min-runtime REFUSES rather than launching unclamped.
 */
export function runtimeSatisfies(hostVersion: string, minRequired: string | undefined): boolean {
  if (minRequired == null || minRequired === '') return true;
  const host = parseDottedVersion(hostVersion);
  const min = parseDottedVersion(minRequired);
  if (!host || !min) return false;
  const len = Math.max(host.length, min.length);
  for (let i = 0; i < len; i++) {
    const a = host[i] ?? 0;
    const b = min[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true; // exactly equal
}

/* ─────────────────────────────────────────────────────────────────────────
 * THE receiver-side authorship chain verifier
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Verify the full authorship chain of a received offer, fail-closed at every
 * link (the order mirrors the item spec, walking device → user → set → owner,
 * then the X6 epoch and C5 host gates):
 *
 *   1. device signature verifies over the canonical offer+epoch bytes
 *   2. the signing device is attested to a github user
 *   3. that user is in the owner-signed publisher set
 *   4. the publisher set is validly owner-SIGNED
 *   5. the owner is anchored via GitHub auth (root of trust)
 *   6. X6: the stamped epoch is not stale vs the owner's high-water
 *   7. C5: the host meets the offer's min-runtime-version
 *   8. C5: the host satisfies the offer's isolation capability requirements
 *
 * Every refusal is structured + loud so a P-004 receipt can name the exact
 * missing link (no silent drops, D-004).
 */
export function verifyOfferAuthorship(input: AuthorshipVerifyInput): AuthorshipVerdict {
  const { offer, authorship, publisherSet, host } = input;

  // 1. Device signature over the canonical offer+epoch bytes.
  let sig: Buffer;
  try {
    sig = Buffer.from(authorship.signatureByDevice, 'base64');
  } catch {
    return { ok: false, code: 'device_sig_invalid', detail: 'authorship signature is not valid base64.' };
  }
  const bytes = offerAuthorshipSigningBytes(offer, authorship.epoch);
  if (!verifyEd25519(bytes, authorship.devicePubkey, sig)) {
    return {
      ok: false,
      code: 'device_sig_invalid',
      detail: `Ed25519 verify failed for device ${authorship.devicePubkey.slice(0, 12)}… over offer ${offer.offerId} (tampered offer or wrong key).`,
    };
  }

  // 2. The signing device is attested to a github user.
  if (input.attestedGithubUserId == null) {
    return {
      ok: false,
      code: 'device_not_attested',
      detail: `signing device ${authorship.devicePubkey.slice(0, 12)}… is not attested to any GitHub user (WI-1585 binding missing or invalid).`,
    };
  }
  const signerUserId = input.attestedGithubUserId;

  // 3. That user is in the publisher set.
  if (!publisherSet.memberGithubUserIds.includes(signerUserId)) {
    return {
      ok: false,
      code: 'user_not_in_publisher_set',
      detail: `signer gh user ${signerUserId} is not in fleet '${offer.fleetSlug}' publisher set (members: [${publisherSet.memberGithubUserIds.join(', ')}]).`,
    };
  }

  // 4. The publisher set is validly owner-SIGNED.
  if (!publisherSet.ownerSignatureValid) {
    return {
      ok: false,
      code: 'owner_signature_invalid',
      detail: `publisher set for fleet '${offer.fleetSlug}' is not validly signed by owner ${publisherSet.ownerGithubUserId}.`,
    };
  }

  // 5. The owner is anchored via GitHub auth (root of trust).
  if (!publisherSet.ownerAnchored) {
    return {
      ok: false,
      code: 'owner_unanchored',
      detail: `owner ${publisherSet.ownerGithubUserId} is not anchored via GitHub auth — no root of trust for fleet '${offer.fleetSlug}'.`,
    };
  }

  // 6. X6 epoch fence — spawn-class, epoch-monotonic. Wall clock never consulted (H8).
  if (authorship.epoch < input.ownerHighWaterEpoch) {
    return {
      ok: false,
      code: 'epoch_stale',
      detail: `offer epoch ${authorship.epoch} trails owner ${publisherSet.ownerGithubUserId}'s high-water ${input.ownerHighWaterEpoch} (X6) — refusing (a revoked/re-keyed publisher record replayed 'fresh' can never re-authorize).`,
    };
  }

  // 7. C5 min-runtime-version — refuse loudly rather than launch unclamped.
  if (!runtimeSatisfies(host.runtimeVersion, offer.minRuntimeVersion)) {
    return {
      ok: false,
      code: 'runtime_too_old',
      detail: `host runtime ${host.runtimeVersion} does not satisfy offer ${offer.offerId} min-runtime ${offer.minRuntimeVersion ?? '(none)'} (C5: refuse rather than launch unclamped).`,
    };
  }

  // 8. C5 isolation capability requirements.
  const hostCaps = new Set(host.capabilities);
  const missing = offer.isolationReqs.filter((r) => !hostCaps.has(r));
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'capability_unsatisfied',
      detail: `host lacks isolation capabilit${missing.length === 1 ? 'y' : 'ies'} [${missing.join(', ')}] required by offer ${offer.offerId} (C5: refuse rather than launch unclamped).`,
    };
  }

  return {
    ok: true,
    authorizedGithubUserId: signerUserId,
    ownerGithubUserId: publisherSet.ownerGithubUserId,
    epoch: authorship.epoch,
  };
}
