/**
 * p2p/spawn-request-publish.ts — the P-009 SPAWN-REQUEST author (fleet-owner
 * side of cross-machine launch, agent-allocation-framework-2026-07-03).
 *
 * The fleet owner (A) holds a federated seat-offer from a contributing host (B)
 * — "B's machine: N model·effort seats, fleet X" (D-005, offer-store-publish.ts)
 * — and asks B to SPEND some of those seats: spawn `count` members onto A's
 * fleet, working A's plan. The request is a SIGNED offer-store record
 * (kind 'spawn_request', offer-store-schema.ts) because it is authority-bearing:
 * B's honor path verifies the store signature chain before it will open a
 * single terminal, and A's cancel (a signed status flip) is as unforgeable as
 * the publish.
 *
 * What this module does NOT decide: whether B honors. That is B's side entirely
 * — the owner-authority ACCEPT_DELEGATED_SEATS gate + seat availability + the
 * freshness fence live in delegated-spawn-honor.ts on the target host. A
 * published request on a gate-OFF host just sits un-disposed (fail-closed);
 * the tool result says so loudly.
 *
 * Discipline mirrors offer-store-publish.ts: DI seams for scope/actor/signer,
 * benign skips vs loud errors, target re-validated here (defense-in-depth) so
 * every caller gets the same checks.
 */

import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { resolveWorkspaceHiveScope } from '../agent-tools/coordination/federation-scope';
import { resolveUsageActor } from '../harness/usage-actor';
import { resolveDeviceKeychainId } from '../identity/device-keychain-id';
import { loadOrGenerateDeviceKeypair } from '../identity/attest';
import { signWithDeviceKey } from '../identity/sign-with-device-key';
import {
  getWorkOffer,
  putWorkOffer,
  type OfferRecordSigner,
  type StoredWorkOffer,
} from './offer-store';
import type { SpawnRequestPayload, WorkOfferStoreRecord } from './offer-store-schema';

export type SpawnRequestPublishOutcome =
  /** The signed request is in the store (federates on the next sync tick). */
  | { ok: true; stored: StoredWorkOffer }
  /** Benign non-publish (no shared hive / no identity). */
  | { ok: false; skipped: string }
  /** A real refusal: bad target, cap breach, keychain fault, store refusal. */
  | { ok: false; error: string };

/** DI seams (offer-store-publish discipline) so unit tests run without
 *  PG/keychain/gh. */
export interface SpawnRequestPublishDeps {
  resolveScope?: typeof resolveWorkspaceHiveScope;
  resolveActor?: typeof resolveUsageActor;
  getRecord?: typeof getWorkOffer;
  putRecord?: typeof putWorkOffer;
  buildSigner?: (githubUserId: number) => Promise<OfferRecordSigner>;
  nowMs?: () => number;
}

async function defaultBuildSigner(githubUserId: number): Promise<OfferRecordSigner> {
  const keychainId = resolveDeviceKeychainId(githubUserId);
  const keypair = await loadOrGenerateDeviceKeypair(keychainId);
  return {
    pubkey: keypair.pubkeyBase64,
    sign: (bytes: Buffer) => signWithDeviceKey(keychainId, bytes),
  };
}

/**
 * Deterministic request id: unique per (target, plan, requester, instant,
 * requesting device) — a re-request is a NEW row (a second wave is legitimate),
 * while an accidental double-fire inside the same millisecond upserts.
 */
export function spawnRequestOfferId(args: {
  targetPublisherGithubUserId: number;
  targetOfferId: string;
  planSlug: string;
  requesterOwnerId: string;
  requestedAtMs: number;
  devicePubkey: string;
}): string {
  const digest = createHash('sha256')
    .update(
      [
        args.targetPublisherGithubUserId,
        args.targetOfferId,
        args.planSlug,
        args.requesterOwnerId,
        args.requestedAtMs,
        args.devicePubkey,
      ].join('|'),
      'utf8',
    )
    .digest('hex');
  return `spawnreq-${digest.slice(0, 16)}`;
}

export interface PublishSpawnRequestOpts {
  workspaceId: string | null | undefined;
  /** The owner fleet the members join (must be the target seat-offer's fleet). */
  fleetSlug: string;
  /** The target seat-offer's key pair — names exactly one machine's delegation. */
  targetPublisherGithubUserId: number;
  targetOfferId: string;
  /** Members requested (validated 1..seat count here AND re-enforced on B). */
  count: number;
  /** The plan the spawned members work. */
  planSlug: string;
  /** The requesting session's coord owner id (audit/addressing). */
  requesterOwnerId: string;
  /** P-004: the requester's pot (harness) slug — required to accept a
   *  POT-scoped seat-offer (fleetSlug=null, potSlug set). Ignored when the
   *  target offer is fleet-scoped. */
  requesterPotSlug?: string;
  /** Optional per-fleet brief text (composed under the member baseline on B). */
  launchContext?: string | null;
  /** WI-5211 multi-hive disambiguator: the shared-hive home slug to publish the
   *  spawn-request in when the workspace hosts MORE THAN ONE shared hive (mirror
   *  of offer-store-publish's `hiveOverride` and the seat-offer's own `hive`).
   *  Without it a multi-hive workspace resolves `scope.kind:'many'` and the
   *  publish silently skips (`no_single_shared_hive:many`) — so the signed
   *  request never federates to the target host. Validated against the
   *  workspace's real shared-hive set; a slug that isn't a shared hive here is
   *  refused (`hive_not_shared`). Ignored on a single-hive workspace. */
  hiveOverride?: string;
  sql?: Sql;
}

/**
 * Author + sign one spawn-request against a held seat-offer. The target is
 * re-validated against the LOCAL store copy (already signature-verified at
 * apply time): it must be an open, un-disposed 'seat' offer for the SAME fleet
 * with enough delegated seats — refusing here beats a request B can only refuse.
 */
export async function publishSpawnRequest(
  opts: PublishSpawnRequestOpts,
  deps: SpawnRequestPublishDeps = {},
): Promise<SpawnRequestPublishOutcome> {
  const resolveScope = deps.resolveScope ?? resolveWorkspaceHiveScope;
  const resolveActor = deps.resolveActor ?? resolveUsageActor;
  const getRecord = deps.getRecord ?? getWorkOffer;
  const putRecord = deps.putRecord ?? putWorkOffer;
  const buildSigner = deps.buildSigner ?? defaultBuildSigner;
  const nowMs = deps.nowMs ?? Date.now;

  if (!opts.workspaceId) return { ok: false, skipped: 'no_workspace' };
  const scope = await resolveScope(opts.workspaceId);
  // Resolve WHICH shared hive to publish the request in. Default: the sole shared
  // hive. WI-5211: on a multi-hive workspace the caller MUST disambiguate via
  // `hiveOverride` — validated against the workspace's real shared-hive set so a
  // request can never be published to a private/absent hive.
  const sharedHomeSlugs =
    scope.kind === 'one' ? [scope.homeSlug] : scope.kind === 'many' ? scope.candidates : [];
  let homeSlug: string;
  if (opts.hiveOverride) {
    if (!sharedHomeSlugs.includes(opts.hiveOverride)) {
      return { ok: false, skipped: `hive_not_shared:${opts.hiveOverride}` };
    }
    homeSlug = opts.hiveOverride;
  } else if (scope.kind === 'one') {
    homeSlug = scope.homeSlug;
  } else {
    return { ok: false, skipped: `no_single_shared_hive:${scope.kind}` };
  }
  const actor = await resolveActor();
  if (!actor) return { ok: false, skipped: 'no_github_identity' };

  // Target checks against the local (verified-at-apply) copy of the seat-offer.
  const target = await getRecord(
    opts.workspaceId,
    homeSlug,
    opts.targetPublisherGithubUserId,
    opts.targetOfferId,
    opts.sql,
  );
  if (!target) {
    return { ok: false, error: `no seat-offer ${opts.targetPublisherGithubUserId}/${opts.targetOfferId} in this hive's offer store — list kind:'seat' offers for the fleet first` };
  }
  if (!target.record || target.record.kind !== 'seat' || !target.record.seat) {
    return { ok: false, error: `offer ${opts.targetOfferId} is not a well-formed seat-offer (kind=${target.record?.kind ?? 'unparseable'})` };
  }
  if (target.status !== 'open') {
    return { ok: false, error: `seat-offer ${opts.targetOfferId} is '${target.status}', not open — the delegation was paused or revoked` };
  }
  if (target.localDisposition) {
    return { ok: false, error: `seat-offer ${opts.targetOfferId} is locally refused here (${target.localDisposition})` };
  }
  const isFleetMatch = target.record.fleetSlug === opts.fleetSlug;
  const isPotMatch =
    target.record.fleetSlug === null &&
    !!target.record.potSlug &&
    !!opts.requesterPotSlug &&
    target.record.potSlug === opts.requesterPotSlug;
  if (!isFleetMatch && !isPotMatch) {
    if (target.record.fleetSlug === null) {
      return {
        ok: false,
        error: `seat-offer ${opts.targetOfferId} delegates to pot '${target.record.potSlug}', not requester pot '${opts.requesterPotSlug ?? '(unresolved)'}'`,
      };
    }
    return { ok: false, error: `seat-offer ${opts.targetOfferId} delegates to fleet '${target.record.fleetSlug}', not '${opts.fleetSlug}'` };
  }
  if (!Number.isSafeInteger(opts.count) || opts.count < 1 || opts.count > target.record.seat.count) {
    return { ok: false, error: `count must be 1..${target.record.seat.count} (the seat-offer's delegated count), got ${opts.count}` };
  }

  let signer: OfferRecordSigner;
  try {
    signer = await buildSigner(actor.githubUserId);
  } catch (e) {
    return { ok: false, error: `device signer unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Self-target guard: the honor hook only fires on REMOTE apply (skipOwnOps),
  // so a request against THIS machine's own seat-offer would sit forever.
  if (opts.targetPublisherGithubUserId === actor.githubUserId && target.signerDevicePubkey === signer.pubkey) {
    return {
      ok: false,
      error: `seat-offer ${opts.targetOfferId} is this machine's OWN delegation — spawn locally instead (fleet:launch-on-plan consumes local seats directly)`,
    };
  }

  const requestedAtMs = nowMs();
  const spawnRequest: SpawnRequestPayload = {
    targetPublisherGithubUserId: opts.targetPublisherGithubUserId,
    targetOfferId: opts.targetOfferId,
    count: opts.count,
    planSlug: opts.planSlug,
    requesterOwnerId: opts.requesterOwnerId,
    requestedAtMs,
    launchContext: opts.launchContext?.trim() ? opts.launchContext.trim() : null,
  };
  const offerId = spawnRequestOfferId({
    targetPublisherGithubUserId: opts.targetPublisherGithubUserId,
    targetOfferId: opts.targetOfferId,
    planSlug: opts.planSlug,
    requesterOwnerId: opts.requesterOwnerId,
    requestedAtMs,
    devicePubkey: signer.pubkey,
  });
  const existing = await getRecord(opts.workspaceId, homeSlug, actor.githubUserId, offerId, opts.sql);
  const record: WorkOfferStoreRecord = {
    offerId,
    publisherGithubUserId: actor.githubUserId,
    fleetSlug: opts.fleetSlug,
    potSlug: null,
    kind: 'spawn_request',
    status: 'open',
    cancelReason: null,
    workOffer: null,
    authorship: null,
    seat: null,
    spawnRequest,
    recordVersion: (existing?.recordVersion ?? 0) + 1,
  };

  const res = await putRecord({
    workspaceId: opts.workspaceId,
    potHomeSlug: homeSlug,
    selfGithubUserId: actor.githubUserId,
    record,
    signer,
    sql: opts.sql,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, stored: res.stored };
}
