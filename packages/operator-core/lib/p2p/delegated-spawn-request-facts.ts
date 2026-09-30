/**
 * WI-7042 — the PURE half of wiring `classifyDelegatedSpawnOutcome` into
 * `p2p:trace`: turn a stored `p2p_work_offers` row into the request facts the
 * classifier needs, and decide whether this host can see member evidence at all.
 *
 * Pure on purpose. The classifier reached 26/26 with no database precisely
 * because its inputs are plain data, and the two decisions that are easy to get
 * WRONG here — "is this a remote honor?" and "what does an unparseable record
 * mean?" — are exactly the ones worth pinning in unit tests rather than
 * discovering against live PG.
 *
 * The PG read that feeds this stays a thin caller (see `p2p:trace`), modelled on
 * `listP2pReceipts`.
 */
import { parseWorkOfferRecordJson } from './offer-store-schema';
import type { DelegatedSpawnRequestFacts } from './delegated-spawn-outcome';

/**
 * The subset of a `harness_shared.p2p_work_offers` row this mapper needs.
 *
 * Note the absence of `fleet_slug`: the column is a projection of the signed
 * record, and the closed-schema validator already REFUSES a `spawn_request`
 * whose record carries no fleetSlug — so a column fallback would be unreachable
 * by construction (proven: a fixture with `fleetSlug: null` fails to parse at
 * all rather than reaching any fallback). The signed record is the only source.
 */
export interface SpawnRequestOfferRow {
  offer_id: string;
  record_json: string;
}

export interface SpawnRequestFactsResult {
  /** Ready to hand to `classifyDelegatedSpawnOutcome({ request })`. */
  facts: DelegatedSpawnRequestFacts;
  /**
   * The seat offer this request targeted. THIS is what identifies the honoring
   * MACHINE: a seat offer id hashes the target device pubkey, so it names
   * exactly one machine's delegation. Resolve it to that seat row's
   * `signer_device_pubkey` and feed it to {@link memberEvidenceAvailableForHonor}.
   */
  targetOfferId: string;
  /**
   * The seat-offer publisher — an ACCOUNT, not a machine. Display/audit only.
   * ⚠ NEVER use this to decide local-vs-remote: see the warning on
   * {@link memberEvidenceAvailableForHonor}.
   */
  targetPublisherGithubUserId: number;
  /** The requesting session's coord owner id (advisory, for display). */
  requesterOwnerId: string;
  planSlug: string;
}

/**
 * Map one stored offer row to spawn-request facts, or `null` when the row is
 * not a usable spawn request.
 *
 * `null` covers unparseable JSON, a non-`spawn_request` kind, and a missing
 * payload — deliberately collapsed, because every one of them means the same
 * thing to the caller ("no request facts here") and none of them is an error
 * worth throwing over a row that merely belongs to another offer lifecycle.
 * `parseWorkOfferRecordJson` is reused rather than hand-parsing the TEXT column:
 * it is the same closed-schema validator the honor path itself runs, so a record
 * this accepts is one the honoring side would also have accepted.
 */
export function spawnRequestFactsFromRow(row: SpawnRequestOfferRow): SpawnRequestFactsResult | null {
  const record = parseWorkOfferRecordJson(row.record_json);
  if (!record || record.kind !== 'spawn_request' || !record.spawnRequest) return null;

  // A spawn_request always carries a non-null fleetSlug (offer-store-schema
  // enforces it, and the validator above rejects a record without one). The
  // guard stays because the FIELD's type is `string | null` for the seat kind —
  // and refusing beats inventing a fleet, since fleet is what member
  // attribution is scoped by: a guess would credit another fleet's members here.
  const fleetSlug = record.fleetSlug;
  if (!fleetSlug) return null;

  const p = record.spawnRequest;
  return {
    facts: {
      offerId: row.offer_id,
      fleetSlug,
      count: p.count,
      requestedAtMs: p.requestedAtMs,
    },
    targetOfferId: p.targetOfferId,
    targetPublisherGithubUserId: p.targetPublisherGithubUserId,
    requesterOwnerId: p.requesterOwnerId,
    planSlug: p.planSlug,
  };
}

/**
 * Can THIS host see member evidence (presence / fleet membership) for the host
 * that honored this request?
 *
 * TRUE only when this host IS the honoring host. For a REMOTE honor the answer
 * is FALSE and the classifier must be told so, because the requesting host holds
 * no trace of the member at all — measured 2026-08-02: a member joined fleet
 * `fed-drill` on the Win rig at 08:11:25Z and the tower had NO `coord_presence`
 * row (reaped) and NOTHING in the append-only `fleet_membership_events` (the
 * fleet registry is machine-local). Passing `true` there makes an uninformative
 * absence read as a confident `no-response` — "nobody honored it" — for every
 * remote request, which is worse than silence because it reads as a finding.
 *
 * ⚠⚠ IT MUST BE THE DEVICE, NOT THE ACCOUNT — this is the trap, and it is not
 * hypothetical. The obvious discriminator is
 * `targetPublisherGithubUserId !== selfGithubUserId`, mirroring the honor path's
 * own self-check. It is WRONG here: every host in this deployment runs under ONE
 * GitHub account, so those ids are equal even for a genuinely remote honor.
 * Measured 2026-08-02 on the live tower→Win-rig request
 * (spawnreq-43e5a7ad370026f9): `publisherGithubUserId` and
 * `targetPublisherGithubUserId` are BOTH 279242982. That comparison would have
 * declared the remote honor local, passed `memberEvidenceAvailable: true`, and
 * produced the confident false `no-response` this whole module exists to prevent.
 *
 * The per-MACHINE identity is the device pubkey. A seat offer id hashes the
 * target device pubkey, so resolving the request's `targetOfferId` to that seat
 * row's `signer_device_pubkey` names exactly one machine — verified distinct per
 * host in the live data (the targeted seat's `nWXvaGiA…` vs this host's own
 * `IXfGu216…`).
 *
 * ⚠ Nor is the spawn-request row's `origin` column usable: `origin='local'`
 * merely means WE published the request, which is true of every remote request
 * too (verified: all live fed-drill spawn requests are origin='local').
 */
export function memberEvidenceAvailableForHonor(args: {
  /** `signer_device_pubkey` of the seat offer named by `targetOfferId`. */
  honoringDevicePubkey: string | null | undefined;
  /** This host's own device pubkey (`resolveDevicePubkey`, as the honor path uses). */
  selfDevicePubkey: string | null | undefined;
}): boolean {
  const honoring = args.honoringDevicePubkey?.trim();
  const self = args.selfDevicePubkey?.trim();
  // Either side unknown ⇒ we cannot claim visibility. Fail toward
  // "indeterminate", never toward a verdict we cannot support.
  if (!honoring || !self) return false;
  return honoring === self;
}

/**
 * Other spawn requests on the SAME fleet whose honor windows overlap this one.
 *
 * Presence rows carry no request id, so an overlapping request means a member
 * cannot be uniquely credited — the classifier downgrades attribution to
 * `ambiguous` and says so, instead of silently crediting a peer's member.
 */
export function countConcurrentRequests(args: {
  self: DelegatedSpawnRequestFacts;
  others: DelegatedSpawnRequestFacts[];
  honorWindowMs: number;
}): number {
  const { self, others, honorWindowMs } = args;
  const selfEnd = self.requestedAtMs + (self.honorWindowMs ?? honorWindowMs);
  return others.filter((o) => {
    if (o.offerId === self.offerId) return false;
    if (o.fleetSlug !== self.fleetSlug) return false;
    const end = o.requestedAtMs + (o.honorWindowMs ?? honorWindowMs);
    // Half-open overlap: touching endpoints do not contend.
    return o.requestedAtMs < selfEnd && self.requestedAtMs < end;
  }).length;
}
