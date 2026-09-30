/**
 * entitled-delivery — the P-009 delivery layer: entitlement-checked delivery,
 * signed package verification, dependency resolution, installer/update/rollback,
 * and yanked-version behavior.
 *
 * This module COMPOSES the layers already landed rather than adding a parallel
 * one (D-024/D-025):
 *
 *   P-006  listing-manifest.ts        → what a release IS (signed identity)
 *   P-007  artifact-store.ts          → where its bytes are (ArtifactStore seam)
 *   P-015  p2p/artifact-distribution  → whether/where it may be fetched
 *   P-016  p2p/commerce-events.ts     → the signed facts entitlements come from
 *
 * Two boundaries are load-bearing and deliberately not negotiable here:
 *
 * PROVIDER NEUTRALITY (D-025). Nothing in this file parses a URL, ranks a
 * locator, or names a blob provider. Source selection is delegated wholesale to
 * `resolveDistributionSources`, which orders by source CLASS. Swapping the
 * hosted store for IPFS changes the adapter and the provider references, never
 * this delivery logic.
 *
 * PROJECTION, NOT AUTHORITY (D-029). Entitlements here are a PROJECTION folded
 * from signed commerce events. This module never decides that someone paid — it
 * reads what the signed event stream already says and refuses when the stream
 * does not say it. It also never talks to a payment provider: a refund is
 * observed as a `refund`/`reversal` event, not asked about.
 */
import type { CommerceEvent } from '../p2p/commerce-events';
import type { Entitlement, LedgerState } from './commerce-ledger';
import {
  resolveDistributionSources,
  yankOutcome,
  type ArtifactDistributionState,
  type DistributionSource,
  type PinHealth,
} from '../p2p/artifact-distribution';
import {
  listingManifestDigest,
  listingManifestSigningBytes,
  unsignedListingManifest,
  validateListingManifest,
  type CupboardReleaseManifest,
} from './listing-manifest';
import { resolveReleaseArtifact, type ArtifactStore } from './artifact-store';

// ─────────────────────────────────────────────────────────────────────────────
// Release identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical key a release is entitled and installed under. Built from the
 * IMMUTABLE identity triple, never from a storage key or a URL, so the same
 * release keeps one ref across every storage backend it is ever served from.
 */
export function releaseRef(release: {
  readonly listingKind: string;
  readonly listingRef: string;
  readonly releaseVersion: string;
}): string {
  return `${release.listingKind}:${release.listingRef}:${release.releaseVersion}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entitlement projection
// ─────────────────────────────────────────────────────────────────────────────

export interface EntitlementGrant {
  readonly entitlementId: string;
  /** Buyer/org/seat identity the grant is bound to. Opaque to this module. */
  readonly subject: string;
  /** `releaseRef()` of the entitled release. */
  readonly releaseRef: string;
  readonly grantedAtMs: number;
  /** null ⇒ perpetual. */
  readonly expiresAtMs: number | null;
  /** Key version for a private release; null ⇒ public. */
  readonly keyVersion: number | null;
  readonly revokedAtMs: number | null;
  readonly revokedReason: string | null;
}

export interface EntitlementProjection {
  /** Keyed by `grantKey(subject, releaseRef)`; read it with `lookupEntitlement`. */
  readonly grants: ReadonlyMap<string, EntitlementGrant>;
  /** Events that named a kind we project but could not be read as one. */
  readonly unusable: readonly { readonly eventId: string; readonly reason: string }[];
}

/**
 * The two product decisions required to cross the commerce/delivery boundary.
 *
 * The ledger deliberately knows only the catalog product and buyer identities;
 * delivery deliberately knows only immutable release refs and install subjects.
 * Keeping both resolvers explicit prevents a tempting but unsafe convention
 * (`productId === releaseRef` or `buyerId === subject`) from silently granting
 * the wrong bytes, especially when a buyer is an organization.
 */
export interface LedgerEntitlementBridge {
  readonly releaseRefForProduct: (
    productId: string,
    entitlement: Entitlement,
  ) => string | null;
  readonly subjectForBuyer: (buyerId: string, entitlement: Entitlement) => string | null;
}

export type LedgerEntitlementSource =
  | Pick<LedgerState, 'entitlements'>
  | ReadonlyMap<string, Entitlement>
  | readonly Entitlement[];

/**
 * Composite map key. A newline separator is deliberate: a subject or release ref
 * containing the separator would otherwise let two distinct pairs collide onto
 * one key, and both fields are opaque strings this module does not constrain.
 */
function grantKey(subject: string, ref: string): string {
  return `${subject}\n${ref}`;
}

function readString(payload: Readonly<Record<string, unknown>>, field: string): string | null {
  const value = payload[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(payload: Readonly<Record<string, unknown>>, field: string): number | null {
  const value = payload[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bridgeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function bridgeEntries(source: LedgerEntitlementSource): readonly Entitlement[] {
  if (Array.isArray(source)) return source;
  if ('entitlements' in source) return [...source.entitlements.values()];
  return [...source.values()];
}

function addBridgeIssue(
  unusable: Array<{ eventId: string; reason: string }>,
  eventId: string,
  reason: string,
): void {
  if (!unusable.some((entry) => entry.eventId === eventId)) unusable.push({ eventId, reason });
}

/**
 * Bridge the authoritative ledger entitlement view into the projection the
 * delivery gate consumes.
 *
 * This is an adapter, not a second ledger reducer: callers must pass the
 * `entitlements` map from `reduceLedger`, and this function carries its
 * active/revoked state across without inventing a signed P2P event. The
 * product→release and buyer→subject mappings are required inputs because D-048
 * leaves those product decisions explicit. Missing or contradictory mappings
 * are surfaced in `unusable` and produce no grant (fail closed).
 */
export function projectLedgerEntitlements(
  source: LedgerEntitlementSource,
  bridge: LedgerEntitlementBridge,
): EntitlementProjection {
  const grants = new Map<string, EntitlementGrant>();
  const unusable: { eventId: string; reason: string }[] = [];
  const conflictedKeys = new Set<string>();

  for (const entitlement of [...bridgeEntries(source)].sort((a, b) =>
    a.entitlementId.localeCompare(b.entitlementId),
  )) {
    const entitlementId = bridgeString(entitlement.entitlementId);
    const productId = bridgeString(entitlement.productId);
    const buyerId = bridgeString(entitlement.buyerId);
    if (!entitlementId || !productId || !buyerId) {
      addBridgeIssue(
        unusable,
        entitlementId ?? '(unknown entitlement)',
        'ledger entitlement needs entitlementId, productId and buyerId',
      );
      continue;
    }
    if (!Number.isFinite(entitlement.grantedAtMs)) {
      addBridgeIssue(
        unusable,
        entitlementId,
        `ledger entitlement ${entitlementId} has an invalid grantedAtMs`,
      );
      continue;
    }

    const ref = bridgeString(bridge.releaseRefForProduct(productId, entitlement));
    if (!ref) {
      addBridgeIssue(
        unusable,
        entitlementId,
        `no release mapping exists for product ${productId}`,
      );
      continue;
    }
    const subject = bridgeString(bridge.subjectForBuyer(buyerId, entitlement));
    if (!subject) {
      addBridgeIssue(
        unusable,
        entitlementId,
        `no delivery subject mapping exists for buyer ${buyerId}`,
      );
      continue;
    }

    let revokedAtMs: number | null;
    if (entitlement.state === 'active') {
      if (entitlement.revokedAtMs !== null) {
        addBridgeIssue(
          unusable,
          entitlementId,
          `active ledger entitlement ${entitlementId} carries a revokedAtMs`,
        );
        continue;
      }
      revokedAtMs = null;
    } else if (entitlement.state === 'revoked') {
      if (!Number.isFinite(entitlement.revokedAtMs)) {
        addBridgeIssue(
          unusable,
          entitlementId,
          `revoked ledger entitlement ${entitlementId} has no valid revokedAtMs`,
        );
        continue;
      }
      revokedAtMs = entitlement.revokedAtMs;
    } else {
      addBridgeIssue(
        unusable,
        entitlementId,
        `ledger entitlement ${entitlementId} has unsupported state ${String(entitlement.state)}`,
      );
      continue;
    }

    const key = grantKey(subject, ref);
    if (conflictedKeys.has(key)) {
      addBridgeIssue(
        unusable,
        entitlementId,
        `ledger entitlements collide on delivery key ${subject} + ${ref}`,
      );
      continue;
    }
    const existing = grants.get(key);
    if (existing) {
      grants.delete(key);
      conflictedKeys.add(key);
      addBridgeIssue(
        unusable,
        existing.entitlementId,
        `ledger entitlements collide on delivery key ${subject} + ${ref}`,
      );
      addBridgeIssue(
        unusable,
        entitlementId,
        `ledger entitlements collide on delivery key ${subject} + ${ref}`,
      );
      continue;
    }

    grants.set(key, {
      entitlementId,
      subject,
      releaseRef: ref,
      grantedAtMs: entitlement.grantedAtMs,
      expiresAtMs: null,
      keyVersion: null,
      revokedAtMs,
      revokedReason: entitlement.revokeReason,
    });
  }

  return { grants, unusable };
}

/** Alias named for callers that think in terms of the cross-layer bridge. */
export const bridgeLedgerEntitlements = projectLedgerEntitlements;

/**
 * Fold signed commerce events into the entitlement view delivery gates on.
 *
 * Input MUST be the `accepted` list from `reduceCommerceEvents` — that reducer
 * owns signature-shape validation, idempotency, and conflict quarantine, and
 * re-implementing any of it here would let a conflicting fact enter delivery
 * through a second, less careful door.
 *
 * Ordering: events are applied in (sequence, eventId) order so the fold is
 * deterministic regardless of arrival order, matching the reducer's contract.
 * A `refund` or `reversal` naming an entitlement REVOKES it; revocation is
 * terminal and a later grant event for the same entitlement cannot undo it,
 * because un-revoking on replay is how a refunded buyer keeps delivery.
 */
export function projectEntitlements(events: readonly CommerceEvent[]): EntitlementProjection {
  const grants = new Map<string, EntitlementGrant>();
  const keyByEntitlementId = new Map<string, string>();
  const unusable: { eventId: string; reason: string }[] = [];

  const ordered = [...events].sort(
    (a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId),
  );

  for (const event of ordered) {
    if (event.kind === 'entitlement') {
      const entitlementId = readString(event.payload, 'entitlementId');
      const subject = readString(event.payload, 'subject');
      const ref = readString(event.payload, 'releaseRef');
      if (!entitlementId || !subject || !ref) {
        unusable.push({
          eventId: event.eventId,
          reason: 'entitlement event needs entitlementId, subject and releaseRef',
        });
        continue;
      }
      const key = grantKey(subject, ref);
      const existing = grants.get(key);
      // Revocation is terminal: never resurrect a revoked grant on replay.
      if (existing?.revokedAtMs != null) continue;
      grants.set(key, {
        entitlementId,
        subject,
        releaseRef: ref,
        grantedAtMs: readNumber(event.payload, 'grantedAtMs') ?? event.occurredAtMs,
        expiresAtMs: readNumber(event.payload, 'expiresAtMs'),
        keyVersion: readNumber(event.payload, 'keyVersion'),
        revokedAtMs: null,
        revokedReason: null,
      });
      keyByEntitlementId.set(entitlementId, key);
      continue;
    }

    if (event.kind === 'refund' || event.kind === 'reversal') {
      const entitlementId = readString(event.payload, 'entitlementId');
      if (!entitlementId) {
        unusable.push({
          eventId: event.eventId,
          reason: `${event.kind} event needs entitlementId to revoke a grant`,
        });
        continue;
      }
      const key = keyByEntitlementId.get(entitlementId);
      const existing = key ? grants.get(key) : undefined;
      if (!key || !existing) {
        // A refund can legitimately arrive before its grant in a partial sync.
        // Recording it as unusable keeps the gap VISIBLE instead of silently
        // leaving the buyer entitled once the grant lands.
        unusable.push({
          eventId: event.eventId,
          reason: `${event.kind} names unknown entitlement ${entitlementId}`,
        });
        continue;
      }
      grants.set(key, {
        ...existing,
        revokedAtMs: readNumber(event.payload, 'revokedAtMs') ?? event.occurredAtMs,
        revokedReason: readString(event.payload, 'reason') ?? event.kind,
      });
    }
  }

  return { grants, unusable };
}

export function lookupEntitlement(
  projection: EntitlementProjection,
  subject: string,
  ref: string,
): EntitlementGrant | null {
  return projection.grants.get(grantKey(subject, ref)) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery authorization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHY the caller wants bytes. This is the field that makes yank behave
 * correctly, and getting it wrong is the single easiest way to break either
 * half of D-007's "yank/revoke disables new delivery without deleting audit
 * history":
 *
 *   install — a NEW acquisition. A yanked release is refused. This is the half
 *             a naive implementation gets right.
 *   update  — moving an existing install to a DIFFERENT version. Treated as an
 *             acquisition of the target, so a yanked target is refused.
 *   repair  — re-fetching bytes for a version ALREADY installed (an interrupted
 *             install, a corrupted cache, a rollback to a version this subject
 *             already had). A yank must NOT brick it: pinners retain bytes
 *             until `retainUntilMs` precisely so in-flight installs converge,
 *             and refusing here would turn a publisher's yank into remote
 *             breakage of software already on disk.
 *
 * Revocation is different from yank on purpose and is terminal for EVERY
 * intent: a yank is the publisher withdrawing a version, while a revocation
 * (entitlement or key) is the buyer's right to the bytes ending.
 */
// Re-exported, not redefined: the intent selects the yank rule, and that rule
// lives with the retention window it depends on, in artifact-distribution.
// A bare `export … from` re-exports without binding the name locally, so the
// import below is what lets this module's own signatures name DeliveryIntent.
import type { DeliveryIntent } from '../p2p/artifact-distribution';
export { DELIVERY_INTENTS, type DeliveryIntent } from '../p2p/artifact-distribution';

export type DeliveryRefusalCode =
  | 'no-entitlement'
  | 'entitlement-expired'
  | 'entitlement-revoked'
  | 'review-not-approved'
  | 'release-yanked'
  | 'yank-retention-expired'
  | 'key-revoked'
  | 'no-manifest'
  | 'no-sources'
  | 'offline-no-pin';

export interface DeliveryAuthorization {
  readonly deliverable: boolean;
  readonly code: 'ok' | DeliveryRefusalCode;
  readonly detail: string;
  /** Ordered best-first by source class; empty when refused. */
  readonly sources: readonly DistributionSource[];
  readonly pinHealth: PinHealth | null;
  /**
   * True when bytes are being served for an already-installed version of a
   * YANKED release. The caller should surface this — the install works, but the
   * version is withdrawn and must not be offered to anyone new.
   */
  readonly servingYankedForExistingInstall: boolean;
  /**
   * The entitlement key version this decision was made under, or `null` for a
   * refusal or a free release. Returned so a caller fetching the bytes passes
   * the SAME key version this authorization used, instead of looking the grant
   * up a second time and risking two answers.
   */
  readonly keyVersion: number | null;
}

export interface AuthorizeDeliveryInput {
  readonly subject: string;
  readonly manifest: CupboardReleaseManifest;
  readonly distribution: ArtifactDistributionState;
  readonly entitlements: EntitlementProjection;
  readonly intent: DeliveryIntent;
  readonly nowMs: number;
  readonly offline?: boolean;
  /**
   * Treat an unpriced/free release as needing no entitlement. Defaults to
   * FALSE: fail-closed, so a caller that forgets to say "this one is free"
   * refuses delivery rather than giving away a paid release.
   */
  readonly freeRelease?: boolean;
}

/**
 * Decide whether this subject may fetch this release right now, and from where.
 *
 * Order matters and is deliberately entitlement-first: a caller with no right
 * to the bytes learns nothing about the release's sources, pin health, or even
 * whether it exists.
 */
export function authorizeDelivery(input: AuthorizeDeliveryInput): DeliveryAuthorization {
  const { subject, manifest, distribution, entitlements, intent, nowMs, offline = false } = input;
  const ref = releaseRef(manifest);

  const refuse = (code: DeliveryRefusalCode, detail: string): DeliveryAuthorization => ({
    deliverable: false,
    code,
    detail,
    sources: [],
    pinHealth: null,
    servingYankedForExistingInstall: false,
    keyVersion: null,
  });

  // ── 1. Entitlement (fail-closed) ──────────────────────────────────────────
  const grant = lookupEntitlement(entitlements, subject, ref);
  if (!grant) {
    if (input.freeRelease !== true) {
      return refuse('no-entitlement', `${subject} holds no entitlement for ${ref}`);
    }
  } else {
    if (grant.revokedAtMs !== null) {
      return refuse(
        'entitlement-revoked',
        `entitlement ${grant.entitlementId} revoked at ${grant.revokedAtMs}: ${grant.revokedReason ?? 'no reason recorded'}`,
      );
    }
    if (grant.expiresAtMs !== null && grant.expiresAtMs <= nowMs) {
      return refuse(
        'entitlement-expired',
        `entitlement ${grant.entitlementId} expired at ${grant.expiresAtMs}`,
      );
    }
  }

  // ── 2. Review state ───────────────────────────────────────────────────────
  // A rejected or still-pending release is not deliverable to a consumer even
  // with a valid entitlement; the publisher's own views go through a different,
  // authenticated path.
  if (manifest.reviewStatus !== 'approved') {
    return refuse('review-not-approved', `release ${ref} is ${manifest.reviewStatus}, not approved`);
  }

  // ── 3. Sources — ONE decision point, intent included ──────────────────────
  // Deliverability, the yank rule and its retention window all live in
  // `resolveDistributionSources` (D-040 ruling 4). This layer supplies the
  // intent and reports the consequence; it keeps no second copy of the policy,
  // which is what previously let the two answers disagree — authorization
  // permitting a repair that the retrieval path, resolving again without an
  // intent, then refused.
  const resolution = resolveDistributionSources(distribution, {
    nowMs,
    offline,
    intent,
    ...(grant?.keyVersion != null ? { keyVersion: grant.keyVersion } : {}),
  });

  if (!resolution.deliverable) {
    const code: DeliveryRefusalCode =
      resolution.reason === 'no-manifest'
        ? 'no-manifest'
        : resolution.reason === 'key-revoked'
          ? 'key-revoked'
          : resolution.reason === 'offline-no-pin'
            ? 'offline-no-pin'
            : resolution.reason === 'yanked'
              ? 'release-yanked'
              : resolution.reason === 'yank-retention-expired'
                ? 'yank-retention-expired'
                : 'no-sources';
    const because =
      resolution.reason === 'yanked'
        ? `release ${ref} was yanked${yankOutcome(distribution).reason ? `: ${yankOutcome(distribution).reason}` : ''} — a ${intent} may not acquire it`
        : `distribution refused ${ref}: ${resolution.reason}`;
    return refuse(code, because);
  }

  // Deliverable AND yanked can only mean one thing: a repair inside the
  // retention window. The caller is told, because the install works while the
  // version is withdrawn and must not be offered to anyone new.
  const servingYanked = yankOutcome(distribution).yanked;

  return {
    deliverable: true,
    code: 'ok',
    detail: servingYanked
      ? `serving yanked release ${ref} for an existing install within its retention window`
      : 'ok',
    sources: resolution.sources,
    pinHealth: resolution.pinHealth,
    servingYankedForExistingInstall: servingYanked,
    keyVersion: grant?.keyVersion ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signed package verification
// ─────────────────────────────────────────────────────────────────────────────

export type PackageVerificationCode =
  | 'manifest-invalid'
  | 'signature-invalid'
  | 'release-identity-mismatch'
  | 'missing-artifact'
  | 'hash-mismatch'
  | 'size-mismatch'
  | 'ticket-expired';

export interface VerifySignedPackageDeps {
  readonly store: ArtifactStore;
  /**
   * Verify `signature` over `signingBytes` for this manifest's publisher.
   * Injected rather than imported so this module stays free of any particular
   * key format or crypto backend — the same reason the storage backend sits
   * behind a seam. Returning false (not throwing) is the refusal path.
   */
  readonly verifySignature: (input: {
    readonly signingBytes: Buffer;
    readonly signature: string;
    readonly manifest: CupboardReleaseManifest;
  }) => boolean | Promise<boolean>;
}

export interface VerifySignedPackageInput {
  /** The manifest as received — validated here, never trusted as pre-checked. */
  readonly manifest: unknown;
  /**
   * The release identity the caller ASKED for. Verifying the manifest alone is
   * not enough: a perfectly valid, correctly signed manifest for a DIFFERENT
   * release is exactly what a substitution attack delivers.
   */
  readonly expected: {
    readonly listingKind: string;
    readonly listingRef: string;
    readonly releaseVersion: string;
  };
  readonly expectedSizeBytes?: number;
}

export type VerifySignedPackageResult =
  | {
      readonly ok: true;
      readonly manifest: CupboardReleaseManifest;
      readonly manifestDigest: string;
      readonly storageKey: string;
      readonly providerId: string;
      readonly sizeBytes: number;
    }
  | { readonly ok: false; readonly code: PackageVerificationCode; readonly detail: string };

/**
 * Prove a package is the genuine bytes of the release that was asked for.
 *
 * Four independent things must hold, and each is checked because the others
 * cannot imply it: the manifest is well-formed; it names the release the caller
 * requested; its signature verifies; and the content hash it declares actually
 * resolves to stored bytes of the expected size.
 */
export async function verifySignedPackage(
  deps: VerifySignedPackageDeps,
  input: VerifySignedPackageInput,
): Promise<VerifySignedPackageResult> {
  const validated = validateListingManifest(input.manifest);
  if (!validated.ok) {
    return { ok: false, code: 'manifest-invalid', detail: `${validated.code}: ${validated.detail}` };
  }
  const manifest = validated.manifest;

  const wanted = releaseRef(input.expected);
  const got = releaseRef(manifest);
  if (wanted !== got) {
    return {
      ok: false,
      code: 'release-identity-mismatch',
      detail: `asked for ${wanted}, manifest describes ${got}`,
    };
  }

  const unsigned = unsignedListingManifest(manifest);
  const signatureOk = await deps.verifySignature({
    signingBytes: listingManifestSigningBytes(unsigned),
    signature: manifest.signature,
    manifest,
  });
  if (!signatureOk) {
    return {
      ok: false,
      code: 'signature-invalid',
      detail: `signature does not verify for ${got}`,
    };
  }

  const artifact = await resolveReleaseArtifact(
    { store: deps.store },
    manifest,
    input.expectedSizeBytes,
  );
  if (!artifact.ok) {
    return { ok: false, code: artifact.code, detail: artifact.detail };
  }

  return {
    ok: true,
    manifest,
    manifestDigest: listingManifestDigest(unsigned),
    storageKey: artifact.artifact.storageKey,
    providerId: artifact.providerId,
    sizeBytes: artifact.artifact.sizeBytes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency resolution
// ─────────────────────────────────────────────────────────────────────────────

export type DependencyResolutionCode = 'cycle' | 'missing';

export interface DependencyGraph {
  /** `releaseRef()` → the refs it directly depends on. */
  readonly edges: ReadonlyMap<string, readonly string[]>;
}

export type DependencyOrderResult =
  | { readonly ok: true; readonly order: readonly string[] }
  | {
      readonly ok: false;
      readonly code: DependencyResolutionCode;
      readonly detail: string;
      /** The exact chain that failed, root-first — the actionable part. */
      readonly path: readonly string[];
    };

/**
 * Deterministic install order: every dependency before the thing that needs it,
 * root LAST.
 *
 * Refuses a cycle rather than breaking it arbitrarily, and names the exact
 * chain. A resolver that silently drops a back-edge produces an install order
 * that works on the machine that computed it and fails elsewhere.
 *
 * Sibling dependencies are visited in sorted order so the result is stable
 * across runs and machines — an install order that varies between two hosts is
 * indistinguishable from a real dependency bug when one of them breaks.
 */
export function resolveDependencyOrder(root: string, graph: DependencyGraph): DependencyOrderResult {
  const order: string[] = [];
  const settled = new Set<string>();
  const onPath = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): DependencyOrderResult | null => {
    if (settled.has(node)) return null;
    if (onPath.has(node)) {
      const cycleStart = stack.indexOf(node);
      const path = [...stack.slice(cycleStart), node];
      return { ok: false, code: 'cycle', detail: `dependency cycle: ${path.join(' -> ')}`, path };
    }
    const deps = graph.edges.get(node);
    if (deps === undefined) {
      return {
        ok: false,
        code: 'missing',
        detail: `no manifest for dependency ${node}`,
        path: [...stack, node],
      };
    }
    onPath.add(node);
    stack.push(node);
    for (const dep of [...deps].sort()) {
      const failure = visit(dep);
      if (failure) return failure;
    }
    stack.pop();
    onPath.delete(node);
    settled.add(node);
    order.push(node);
    return null;
  };

  const failure = visit(root);
  if (failure) return failure;
  return { ok: true, order };
}

// ─────────────────────────────────────────────────────────────────────────────
// Install / update / rollback planning
// ─────────────────────────────────────────────────────────────────────────────

export interface InstalledRelease {
  readonly releaseRef: string;
  readonly installedAtMs: number;
  readonly contentHash: string;
}

export type InstallOperation = 'install' | 'update' | 'rollback' | 'no-op';

export interface InstallStep {
  readonly releaseRef: string;
  readonly intent: DeliveryIntent;
  /** True when this ref needs no fetch — already present at the wanted bytes. */
  readonly alreadySatisfied: boolean;
}

export type InstallPlanResult =
  | {
      readonly ok: true;
      readonly operation: InstallOperation;
      readonly steps: readonly InstallStep[];
      /** For an update/rollback: what to restore if a step fails. */
      readonly rollbackTo: InstalledRelease | null;
    }
  | {
      readonly ok: false;
      readonly code: DependencyResolutionCode | 'rollback-target-not-installed';
      readonly detail: string;
    };

export interface PlanInstallInput {
  readonly target: string;
  readonly graph: DependencyGraph;
  /** What this subject currently has, keyed by `releaseRef()`. */
  readonly installed: ReadonlyMap<string, InstalledRelease>;
  /** Content hash the target release declares, to detect a true no-op. */
  readonly targetContentHash?: string;
}

/**
 * Build the ordered steps for acquiring `target`, classifying the operation and
 * naming the rollback point BEFORE anything is fetched.
 *
 * The intent on each step is what carries yank semantics into
 * `authorizeDelivery`: a dependency the subject already has is a `repair`
 * (re-fetchable even if the publisher has since yanked it, so an unrelated
 * update cannot brick a working install), while anything genuinely new is an
 * `install` and a changed target is an `update` — both of which a yank refuses.
 */
export function planInstall(input: PlanInstallInput): InstallPlanResult {
  const resolved = resolveDependencyOrder(input.target, input.graph);
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, detail: resolved.detail };
  }

  const current = input.installed.get(input.target) ?? null;
  const targetSatisfied =
    current !== null &&
    input.targetContentHash !== undefined &&
    current.contentHash === input.targetContentHash;

  // An update REPLACES a different version of the SAME listing. That sibling —
  // not the exact target ref — is what distinguishes an update from a first
  // install, because the target version is by definition not yet installed in
  // either case.
  const priorOfSameListing = findInstalledSibling(input.target, input.installed);

  const steps: InstallStep[] = resolved.order.map((ref) => {
    const have = input.installed.get(ref);
    if (ref === input.target) {
      return {
        releaseRef: ref,
        intent: targetSatisfied
          ? ('repair' as const)
          : have || priorOfSameListing
            ? ('update' as const)
            : ('install' as const),
        alreadySatisfied: targetSatisfied,
      };
    }
    return {
      releaseRef: ref,
      intent: have ? ('repair' as const) : ('install' as const),
      alreadySatisfied: have !== undefined,
    };
  });

  if (steps.every((step) => step.alreadySatisfied)) {
    return { ok: true, operation: 'no-op', steps, rollbackTo: null };
  }

  const operation: InstallOperation = priorOfSameListing || current ? 'update' : 'install';
  return { ok: true, operation, steps, rollbackTo: priorOfSameListing ?? current };
}

/**
 * Plan a rollback to a version this subject PREVIOUSLY installed.
 *
 * The target must already be installed — that is what makes the step a
 * `repair` and therefore permitted even for a yanked version. Rolling "back" to
 * a version never installed here is an ordinary acquisition and must go through
 * `planInstall`, where a yanked target is correctly refused; conflating the two
 * is how a yanked release gets re-acquired through the rollback door.
 */
export function planRollback(input: {
  readonly target: string;
  readonly graph: DependencyGraph;
  readonly installed: ReadonlyMap<string, InstalledRelease>;
}): InstallPlanResult {
  const have = input.installed.get(input.target);
  if (!have) {
    return {
      ok: false,
      code: 'rollback-target-not-installed',
      detail: `${input.target} was never installed here — acquire it with planInstall, which enforces yank rules`,
    };
  }
  const resolved = resolveDependencyOrder(input.target, input.graph);
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, detail: resolved.detail };
  }
  const steps: InstallStep[] = resolved.order.map((ref) => ({
    releaseRef: ref,
    intent: 'repair' as const,
    alreadySatisfied: input.installed.has(ref) && ref !== input.target,
  }));
  return { ok: true, operation: 'rollback', steps, rollbackTo: have };
}

function findInstalledSibling(
  target: string,
  installed: ReadonlyMap<string, InstalledRelease>,
): InstalledRelease | null {
  const parts = target.split(':');
  if (parts.length < 3) return null;
  const prefix = `${parts[0]}:${parts[1]}:`;
  for (const [key, value] of installed) {
    if (key !== target && key.startsWith(prefix)) return value;
  }
  return null;
}
