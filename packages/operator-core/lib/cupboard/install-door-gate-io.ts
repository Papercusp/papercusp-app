/**
 * install-door-gate-io — the production wiring the eight `agent-tools/cupboard/
 * install-*.ts` doors call to reach the release chain (D-045 §3a).
 *
 * `install-door-gate` holds the RULES and is pure; this module holds the I/O the
 * rules need — resolving the listing's commerce facts, and the seam a release
 * chain would arrive through. Splitting them is what lets every rule be tested
 * without a network, and lets this file be read as exactly "where the outside
 * world enters".
 *
 * WHAT IS DELIBERATELY NULL HERE
 * ------------------------------
 * `loadReleaseChain` returns null for every listing today, and that is a
 * measured fact rather than an oversight: nothing in production writes
 * distribution state (`reduceDistributionEvents` has no non-test caller), so
 * there is no chain to load. It is a NAMED seam rather than an absent one so
 * that P-016's persisted `p2p/commerce-events` stream has exactly one place to
 * land, instead of a ninth door being invented for it.
 *
 * Until then the gate's price split is the whole production behaviour, and it is
 * the fix for the hole D-045 found: a PAID listing can no longer be installed
 * without an entitlement check, because it is refused outright.
 */
import { pinModuleState } from '@papercusp/module-singleton';

import { createProviderRegistry } from '../p2p/artifact-package';
import { memoryArtifactStore } from './artifact-store';
import { loadDeliveryEntitlements } from './commerce-door-gate-io';
import {
  gateCupboardInstall,
  type DoorListingFacts,
  type DoorReleaseChain,
  type InstallDoorDecision,
  type InstallDoorGateDeps,
  type InstallDoorOperation,
} from './install-door-gate';
import { createOpenArtifactSeam, type PrivateArtifactAccess } from './install-open-artifact';
import { mergeEntitlementProjections } from './ledger-p2p-bridge';
import { resolveListingByKind } from './resolve-listing-by-kind';
import type { ListingKind } from './types';

export type DoorListingFactsResult =
  | { readonly ok: true; readonly listing: DoorListingFacts }
  | { readonly ok: false; readonly error: string; readonly status: number };

/**
 * What the gate's collaborators are built FOR — the recipient identity of this
 * one install. It is a parameter rather than process state because the
 * decrypt seam is addressed to a recipient (D-045 §3b): a wrapped key issued to
 * one buyer must not open under another's install.
 */
export interface InstallDoorContext {
  readonly subject: string;
}

export interface InstallDoorSources {
  /** Resolves the commerce facts the gate decides on. Defaults to `loadDoorListingFacts`. */
  readonly loadListingFacts?: (
    idOrRef: string,
    kind: ListingKind,
  ) => Promise<DoorListingFactsResult> | DoorListingFactsResult;
  /** Builds the gate's collaborators. Defaults to `installDoorGateDeps`. */
  readonly gateDeps?: (context: InstallDoorContext) => InstallDoorGateDeps;
  /**
   * Where a published release chain arrives from (P-035).
   *
   * Registering THIS rather than `gateDeps` is what keeps the entitlement
   * decision in production code: the chain a caller supplies carries
   * distribution facts (graph, signed package, installed set), and
   * `installDoorGateDeps` overlays the entitlement projection built by
   * `loadDeliveryEntitlements` on top of whatever `entitlements` it names. A
   * caller that replaces `gateDeps` wholesale owns that decision itself.
   */
  readonly loadReleaseChain?: (
    listing: DoorListingFacts,
    context: { readonly subject: string; readonly operation: InstallDoorOperation },
  ) => Promise<DoorReleaseChain | null> | DoorReleaseChain | null;
}

const installIoState = pinModuleState('@papercusp/operator-core.cupboard.install-door-io', () => ({
  sources: null as InstallDoorSources | null,
}));

/**
 * Register where this process's install doors read listings and entitlements.
 *
 * The commerce-side twin of `configureCommerceIo`, and it exists for the same
 * reason: `installDoorGateDeps()` builds REAL-but-empty collaborators (see its
 * header), so every install door's entitlement branch is unreachable in a test
 * that drives the door rather than the gate. Registering here lets P-012 run the
 * purchase -> entitlement -> install -> refund -> revoke -> install-refused
 * journey through the actual door handlers instead of re-implementing them.
 *
 * `null` restores the production default; a test teardown MUST pass it, because
 * the pin is process-wide.
 */
export function configureInstallDoorSources(sources: InstallDoorSources | null): void {
  installIoState.sources = sources;
}

/** The sources currently registered, or null when the default is in force. */
export function installDoorSources(): InstallDoorSources | null {
  return installIoState.sources;
}

/**
 * Read the commerce facts the gate decides on from the listing row.
 *
 * Reuses `resolveListingByKind` rather than adding a second listing fetch: that
 * resolver already owns the detail-then-scan order AND the kind guard that stops
 * one kind's installer being aimed at another kind's repo, and a parallel fetch
 * here would be a second copy of both.
 */
export async function loadDoorListingFacts(
  idOrRef: string,
  kind: ListingKind,
): Promise<DoorListingFactsResult> {
  const resolved = await resolveListingByKind(idOrRef, kind);
  if ('error' in resolved) {
    return { ok: false, error: resolved.error, status: resolved.status };
  }
  return {
    ok: true,
    listing: {
      listingKind: kind,
      listingRef: resolved.ref,
      ...(resolved.listingId ? { listingId: resolved.listingId } : {}),
      ...(resolved.priceModel !== undefined ? { priceModel: resolved.priceModel } : {}),
      ...(resolved.priceAmountMicros !== undefined
        ? { priceAmountMicros: resolved.priceAmountMicros }
        : {}),
      ...(resolved.releaseVersion !== undefined ? { releaseVersion: resolved.releaseVersion } : {}),
    },
  };
}

/**
 * The seam a published release chain will arrive through.
 *
 * Returning null is the honest answer while no production writer publishes
 * distribution state; inventing a chain here would make the gate's managed path
 * look exercised in production when it is not.
 */
export const loadReleaseChain = async (
  _listing: DoorListingFacts,
  _context: { readonly subject: string; readonly operation: InstallDoorOperation },
): Promise<DoorReleaseChain | null> => null;

/**
 * Production dependencies for the gate.
 *
 * Both are REAL objects with nothing configured rather than throwing stubs: if a
 * chain ever reaches them before provider and publisher-key wiring lands, the
 * run refuses cleanly (`no-sources`, `signature-invalid`) instead of crashing a
 * door. Every default here is fail-closed — an empty provider registry serves no
 * bytes, and an unresolvable publisher key verifies nothing.
 */
/**
 * Resolve a release chain and give it the PRODUCTION entitlement view (P-035).
 *
 * The chain's own `entitlements` is folded from whatever commerce events its
 * publisher happened to see; `loadDeliveryEntitlements` folds the ledger and
 * the signed P2P stream this process sees. They are MERGED rather than one
 * replacing the other, because either side may hold a revocation the other has
 * not caught up on — and `mergeEntitlementProjections` makes revocation
 * terminal across sources, so the merge can only ever narrow delivery, never
 * widen it. That direction is the whole safety property: a refunded buyer
 * cannot regain the bytes because one of the two views is stale.
 */
export async function resolveReleaseChainWithEntitlements(
  listing: DoorListingFacts,
  context: { readonly subject: string; readonly operation: InstallDoorOperation },
): Promise<DoorReleaseChain | null> {
  const load = installIoState.sources?.loadReleaseChain ?? loadReleaseChain;
  const chain = await load(listing, context);
  if (!chain) return null;
  return {
    ...chain,
    entitlements: mergeEntitlementProjections(
      chain.entitlements,
      await loadDeliveryEntitlements(),
    ),
  };
}

export function installDoorGateDeps(context: InstallDoorContext): InstallDoorGateDeps {
  return {
    loadReleaseChain: resolveReleaseChainWithEntitlements,
    runner: {
      resolveDistribution: () => null,
      registry: createProviderRegistry(),
      apply: () => {
        throw new Error('no artifact apply is wired at the install door yet');
      },
      revert: () => undefined,
    },
    verify: {
      store: memoryArtifactStore(),
      // Fail-closed: no publisher-key resolution is wired to the door yet, so an
      // unexpected chain refuses as unverified rather than accepting bytes whose
      // signature nothing checked.
      verifySignature: () => false,
    },
    // D-045 §3b: the decrypt step for an ENCRYPTED release. Supplying it is what
    // gives `openRetrievedArtifact` a production caller — and it is supplied
    // unconditionally so the refusal an encrypted release meets is the real
    // crypto one (`not-entitled` / `key-revoked` / `no-wrapped-key`) rather than
    // the gate's generic "no seam configured" throw.
    openArtifact: createOpenArtifactSeam(defaultPrivateArtifactAccess(), context),
  };
}

/**
 * Production access for the encrypted-apply path.
 *
 * Every member is fail-closed for the same measured reason `loadReleaseChain`
 * returns null: no production writer publishes distribution state, so no key
 * provider is registered and no ciphertext is retrievable. Naming them here
 * rather than leaving the seam absent is what makes an encrypted install refuse
 * with the missing collaborator NAMED, instead of applying ciphertext or
 * crashing a door.
 */
export function defaultPrivateArtifactAccess(): PrivateArtifactAccess {
  return {
    wrapAdapter: null,
    deliveryAdapter: null,
    readCiphertext: () => null,
    applyPlaintext: () => {
      throw new Error('no artifact apply is wired at the install door yet');
    },
  };
}

export interface DoorGateRequest {
  /** The listing id or handle the caller asked for; absent ⇒ a direct repo install. */
  readonly idOrRef?: string | undefined;
  readonly kind: ListingKind;
  /** Buyer/org/seat identity the entitlement is looked up under. */
  readonly subject: string;
  readonly operation?: InstallDoorOperation;
}

/**
 * The single call an install door makes before delegating to its `*-io` core.
 *
 * A `false` decision is the door's refusal — return it to the caller and install
 * nothing. An `unmanaged` decision means the release chain did not apply and the
 * door proceeds exactly as it did before.
 */
export async function gateInstallDoor(request: DoorGateRequest): Promise<InstallDoorDecision> {
  const key = (request.idOrRef ?? '').trim();
  if (key === '') {
    return {
      ok: true,
      mode: 'unmanaged',
      detail: 'direct repo install — no listing to price or entitle',
    };
  }

  const facts = await (installIoState.sources?.loadListingFacts ?? loadDoorListingFacts)(
    key,
    request.kind,
  );
  if (!facts.ok) {
    // The listing could not be read, so its price is unknown. The door's own
    // `*-io` core resolves the SAME listing and fails on the same condition, so
    // returning `unmanaged` here hands the refusal to the door rather than
    // inventing a second, differently-worded one — and no bytes move either way.
    return {
      ok: true,
      mode: 'unmanaged',
      detail: `listing ${key} could not be resolved (${facts.status}: ${facts.error})`,
    };
  }

  return gateCupboardInstall((installIoState.sources?.gateDeps ?? installDoorGateDeps)({ subject: request.subject }), {
    listing: facts.listing,
    subject: request.subject,
    ...(request.operation ? { operation: request.operation } : {}),
  });
}
