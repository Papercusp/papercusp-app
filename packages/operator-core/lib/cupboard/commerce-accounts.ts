/**
 * Buyer organizations, seats/installations, creator profiles and payout
 * references (P-011).
 *
 * P-010 (`./commerce-ledger`) defined WHO owes what: orders, entitlements,
 * refunds and payouts, keyed by opaque `buyerId` / `creatorId` strings. It
 * deliberately left those principals unstructured — a `buyerId` is equally a
 * person or a company, and a `creatorId` has nowhere to say where its money
 * should land. This module is purely ADDITIVE over that ledger (D-043): it
 * never re-exports or re-shapes a P-010 type, and the reducer keeps owning
 * money. What it adds is the identity and consumption layer above it:
 *
 *  - an ORGANIZATION owns entitlements on behalf of its members;
 *  - a SEAT is one member's claim on an org's entitlement;
 *  - an INSTALLATION is a seat actually in use somewhere;
 *  - a CREATOR PROFILE carries the PAYOUT REFERENCE that a P-010 `Payout`
 *    settles against.
 *
 * Seat revocation follows D-042 rather than inventing a second shape for the
 * same question. D-042 settled that a yanked release must not brick an install
 * already on disk: `authorizeDelivery` refuses `install`/`update` but still
 * permits `repair`. A revoked ENTITLEMENT is the commercial form of exactly
 * that event, so it resolves the same way — see `authorizeSeatIntent`. Two
 * mechanisms answering "your right to these bytes ended" differently is how a
 * refund would brick a running deployment while a yank would not.
 */

import type { Entitlement } from './commerce-ledger';
import { DELIVERY_INTENTS, type DeliveryIntent } from '../p2p/artifact-distribution';

export { DELIVERY_INTENTS, type DeliveryIntent };

// ---------------------------------------------------------------------------
// Organizations and membership
// ---------------------------------------------------------------------------

export const ORG_ROLES = ['owner', 'admin', 'member'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export interface OrgMembership {
  readonly userId: string;
  readonly role: OrgRole;
  readonly addedAtMs: number;
}

export interface Organization {
  readonly orgId: string;
  readonly displayName: string;
  readonly memberships: readonly OrgMembership[];
}

/**
 * A P-010 `buyerId` is an opaque string that may name a person OR an org, and
 * nothing in the ledger distinguishes them. Resolving it explicitly is what
 * lets seat allocation ask "is this user entitled through this buyer?" without
 * the ledger having to care.
 */
export type BuyerPrincipal =
  | { readonly kind: 'individual'; readonly userId: string }
  | { readonly kind: 'organization'; readonly org: Organization };

export function resolveBuyerPrincipal(buyerId: string, orgs: ReadonlyMap<string, Organization>): BuyerPrincipal {
  const org = orgs.get(buyerId);
  return org ? { kind: 'organization', org } : { kind: 'individual', userId: buyerId };
}

export function membershipOf(org: Organization, userId: string): OrgMembership | null {
  return org.memberships.find((m) => m.userId === userId) ?? null;
}

/**
 * Whether `userId` may hold a seat purchased by `buyerId`. An individual buyer
 * is entitled only to themselves; an org entitles exactly its members, at any
 * role — role governs administration, not entitlement.
 */
export function principalEntitles(principal: BuyerPrincipal, userId: string): boolean {
  return principal.kind === 'individual' ? principal.userId === userId : membershipOf(principal.org, userId) !== null;
}

// ---------------------------------------------------------------------------
// Creator profile and payout reference
// ---------------------------------------------------------------------------

/**
 * Where a creator's money goes. `externalRef` is provider-scoped and opaque
 * here on purpose — this module never talks to a provider; P-010's `Payout`
 * carries the provider and its own ref for the settlement itself.
 */
export interface PayoutReference {
  readonly provider: string;
  readonly externalRef: string;
  /** Null until the provider confirms the destination can receive funds. */
  readonly verifiedAtMs: number | null;
}

export interface CreatorProfile {
  readonly creatorId: string;
  readonly displayName: string;
  readonly payout: PayoutReference | null;
}

export type PayoutReadinessCode = 'no-profile' | 'no-payout-reference' | 'payout-unverified';

export type PayoutReadiness =
  | { readonly ok: true; readonly reference: PayoutReference }
  | { readonly ok: false; readonly code: PayoutReadinessCode; readonly detail: string };

/**
 * Whether a `payout.created` for this creator could actually settle. Checked
 * BEFORE the ledger records an intent to pay, so an unpayable creator surfaces
 * as a missing destination rather than as a provider failure days later.
 */
export function payoutReadiness(creatorId: string, profiles: ReadonlyMap<string, CreatorProfile>): PayoutReadiness {
  const profile = profiles.get(creatorId);
  if (!profile) return { ok: false, code: 'no-profile', detail: `no creator profile for '${creatorId}'` };
  if (!profile.payout) {
    return { ok: false, code: 'no-payout-reference', detail: `creator '${creatorId}' has no payout reference on file` };
  }
  if (profile.payout.verifiedAtMs === null) {
    return {
      ok: false,
      code: 'payout-unverified',
      detail: `creator '${creatorId}' payout reference (${profile.payout.provider}) is not verified yet`,
    };
  }
  return { ok: true, reference: profile.payout };
}

// ---------------------------------------------------------------------------
// Seats and installations
// ---------------------------------------------------------------------------

/**
 * How many seats an offer confers. Keyed by `offerId` and owned HERE rather
 * than added to P-010's `Offer`, because P-011 must not change committed P-010
 * signatures (D-043). An offer with no policy is single-seat.
 */
export interface SeatPolicy {
  readonly offerId: string;
  readonly seats: number;
}

export const DEFAULT_SEATS = 1;

export function seatsForOffer(offerId: string, policies: ReadonlyMap<string, SeatPolicy>): number {
  const policy = policies.get(offerId);
  if (!policy || !Number.isSafeInteger(policy.seats) || policy.seats < 1) return DEFAULT_SEATS;
  return policy.seats;
}

export type InstallationState = 'active' | 'released';

export interface Installation {
  readonly installationId: string;
  readonly entitlementId: string;
  /** The member holding the seat — an org member, or the individual buyer. */
  readonly holderId: string;
  /** Opaque host/device reference; two installs on one device are two seats. */
  readonly deviceRef: string;
  readonly state: InstallationState;
  readonly allocatedAtMs: number;
  readonly releasedAtMs: number | null;
}

export type SeatRefusalCode =
  | 'entitlement-revoked'
  | 'not-entitled'
  | 'no-seats-available'
  | 'duplicate-installation'
  | 'unknown-installation';

export type SeatAllocation =
  | { readonly ok: true; readonly installation: Installation }
  | { readonly ok: false; readonly code: SeatRefusalCode; readonly detail: string };

export interface SeatUsage {
  readonly granted: number;
  readonly used: number;
  readonly available: number;
}

/** Only ACTIVE installations consume a seat; a released one frees it immediately. */
export function seatUsage(
  entitlementId: string,
  granted: number,
  installations: readonly Installation[],
): SeatUsage {
  const used = installations.filter((i) => i.entitlementId === entitlementId && i.state === 'active').length;
  return { granted, used, available: Math.max(0, granted - used) };
}

export interface AllocateSeatInput {
  readonly entitlement: Entitlement;
  readonly principal: BuyerPrincipal;
  readonly granted: number;
  readonly installations: readonly Installation[];
  readonly holderId: string;
  readonly deviceRef: string;
  readonly installationId: string;
  readonly nowMs: number;
}

/**
 * Claim one seat. Refusal order is deliberate: entitlement validity first (the
 * commercial fact), then membership (who is asking), then capacity (how many).
 * Reporting "no seats available" to someone who was never entitled would send
 * an admin to buy seats that would not have helped.
 */
export function allocateSeat(input: AllocateSeatInput): SeatAllocation {
  const { entitlement, principal, granted, installations, holderId, deviceRef, installationId, nowMs } = input;

  if (entitlement.state === 'revoked') {
    const reason = entitlement.revokeReason ? `: ${entitlement.revokeReason}` : '';
    return {
      ok: false,
      code: 'entitlement-revoked',
      detail:
        `entitlement ${entitlement.entitlementId} is revoked${reason} — no NEW seat can be taken. ` +
        `Installations already active keep working and may still 'repair' (D-042); see authorizeSeatIntent.`,
    };
  }

  if (!principalEntitles(principal, holderId)) {
    return {
      ok: false,
      code: 'not-entitled',
      detail:
        principal.kind === 'organization'
          ? `'${holderId}' is not a member of organization '${principal.org.orgId}'`
          : `entitlement belongs to '${principal.userId}', not '${holderId}'`,
    };
  }

  const duplicate = installations.find(
    (i) => i.entitlementId === entitlement.entitlementId && i.state === 'active' && i.holderId === holderId && i.deviceRef === deviceRef,
  );
  if (duplicate) {
    // Idempotent re-claim: returning the existing seat rather than minting a
    // second one is what stops a retried install from silently eating capacity.
    return { ok: true, installation: duplicate };
  }

  const usage = seatUsage(entitlement.entitlementId, granted, installations);
  if (usage.available < 1) {
    return {
      ok: false,
      code: 'no-seats-available',
      detail: `entitlement ${entitlement.entitlementId} grants ${usage.granted} seat(s), all in use — release one or raise the offer's seat policy`,
    };
  }

  if (installations.some((i) => i.installationId === installationId)) {
    return { ok: false, code: 'duplicate-installation', detail: `installation id '${installationId}' already exists` };
  }

  return {
    ok: true,
    installation: {
      installationId,
      entitlementId: entitlement.entitlementId,
      holderId,
      deviceRef,
      state: 'active',
      allocatedAtMs: nowMs,
      releasedAtMs: null,
    },
  };
}

export type SeatRelease =
  | { readonly ok: true; readonly installation: Installation; readonly alreadyReleased: boolean }
  | { readonly ok: false; readonly code: SeatRefusalCode; readonly detail: string };

/** Releasing frees the seat and is idempotent — a repeated release is not an error. */
export function releaseSeat(installationId: string, installations: readonly Installation[], nowMs: number): SeatRelease {
  const existing = installations.find((i) => i.installationId === installationId);
  if (!existing) return { ok: false, code: 'unknown-installation', detail: `no installation '${installationId}'` };
  if (existing.state === 'released') return { ok: true, installation: existing, alreadyReleased: true };
  return { ok: true, installation: { ...existing, state: 'released', releasedAtMs: nowMs }, alreadyReleased: false };
}

export type SeatIntentRefusalCode = 'entitlement-revoked' | 'installation-released';

export type SeatIntentVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SeatIntentRefusalCode; readonly detail: string };

/**
 * Whether an EXISTING installation may still act under `intent`.
 *
 * This is the commercial mirror of D-042's yank rule, and it exists so the two
 * cannot drift apart: a revoked entitlement refuses `install` and `update` but
 * still permits `repair`, exactly as a yanked release does. A refund therefore
 * stops a customer moving forward without bricking what is already running —
 * the same guarantee, reached through a different door.
 *
 * A RELEASED installation holds no seat at all, so nothing is authorized for
 * it; that is a stronger refusal than revocation and is checked first.
 */
export function authorizeSeatIntent(
  installation: Installation,
  entitlement: Entitlement,
  intent: DeliveryIntent,
): SeatIntentVerdict {
  if (installation.state === 'released') {
    return {
      ok: false,
      code: 'installation-released',
      detail: `installation ${installation.installationId} released its seat — re-allocate one before any '${intent}'`,
    };
  }
  if (entitlement.state === 'revoked' && intent !== 'repair') {
    const reason = entitlement.revokeReason ? `: ${entitlement.revokeReason}` : '';
    return {
      ok: false,
      code: 'entitlement-revoked',
      detail:
        `entitlement ${entitlement.entitlementId} is revoked${reason} — '${intent}' is refused, but this installation ` +
        `keeps running and 'repair' remains available (D-042: revocation must not brick what is already installed).`,
    };
  }
  return { ok: true };
}
