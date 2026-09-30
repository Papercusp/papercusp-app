/**
 * p2p/offer-store-schema.ts — the typed SIGNED-OFFER STORE record and its
 * canonical signing surface (p2p-work-distribution-2026-07-02 P-102 store leg,
 * WI-1935; agent-allocation-framework-2026-07-03 D-005 seat-offers ride it;
 * migration 490).
 *
 * PURE: no I/O, no PG, no keychain (fleet-directory-schema.ts discipline).
 * SINGLE SOURCE OF TRUTH for the bytes the publisher's device signs and a
 * remote projection verifies — the author (offer-store.ts putWorkOffer) and the
 * member-side projection (projections/work-offers.ts) BOTH derive the signed
 * bytes from {@link workOfferStoreSignedBytes}, so they can never drift.
 *
 * TWO OFFER KINDS in one store record (kind-discriminated):
 *   'seat' — a D-005 STANDING seat-offer: an agent_slot delegation advertised
 *            to the fleet owner ("this machine: N model·effort seats, fleet X").
 *            No inner envelope (there is no WorkOffer to claim); the outer store
 *            signature is the whole authenticity story. Per D-005/M19 the
 *            gateway ACCOUNT ID NEVER crosses the wire — the payload carries
 *            only accountScope 'auto'|'pinned' (the raw account string may feed
 *            the offerId HASH at the publish layer, never the record body).
 *   'spawn_request' — P-009 cross-machine launch: the FLEET OWNER's signed
 *            request that the host holding a specific seat-offer SPAWN bounded
 *            members from it. Authority-bearing ("spend a seat on my behalf"),
 *            which is exactly why it rides this signed store and not the coord
 *            message rail. The target seat-offer is named by (publisher uid,
 *            offerId) — per-machine unique by construction (the offer id hashes
 *            the device pubkey), and the honoring host re-derives its own seat
 *            ids to match, so the M19 account secret still never crosses the
 *            wire. Honoring is FAIL-CLOSED behind the host's owner-authority
 *            ACCEPT_DELEGATED_SEATS gate (p2p/accept-delegated-seats.ts) and
 *            time-fenced by requestedAtMs (a late gate flip must not fire a
 *            stale spawn). The host's honored/refused mark is the LOCAL
 *            disposition column (it cannot re-sign the owner's record); refusals
 *            federate back as p2p_receipts.
 *
 * The outer signature covers status + recordVersion, so a publisher's cancel is
 * as unforgeable as the publish. A HOST-side refusal (revocation-reaper P-106
 * deferred #2) never re-signs a foreign record — it is a LOCAL, non-federated
 * disposition column on the row (offer-store.setLocalOfferDisposition), outside
 * this signed schema on purpose.
 */

import { canonicalJson } from '../authority/authority-rpc-envelope';

/** Publisher-authoritative lifecycle. 'open' = claimable/live; 'paused' = kept
 *  but not claimable (a paused delegation); 'cancelled' = terminal, publisher-
 *  signed (a host-local refusal is the SEPARATE unsigned disposition column). */
export type OfferStoreStatus = 'open' | 'paused' | 'cancelled';
export const OFFER_STORE_STATUSES: readonly OfferStoreStatus[] = ['open', 'paused', 'cancelled'];

/** D-005: the standing seat-offer payload — capacity, never billing identity. */
export interface SeatOfferPayload {
  /** The model the seats run (D-002 trio axis). */
  model: string;
  /** Reasoning effort of the seats (the delegating store validated the vocab). */
  effort: string;
  /** Seat COUNT (mirrors mig-486's 1..1000 quantity cap). */
  count: number;
  /** 'auto' = gateway draws from the fleet's allocated accounts (D-003);
   *  'pinned' = the host pinned a specific account — WHICH one stays local (M19). */
  accountScope: 'auto' | 'pinned';
  /** Friendly host label for the fleet owner's board ("B's machine"), or null. */
  hostLabel: string | null;
  /** pot-seat-pools-prose-ux-2026-07-18 P-001/D-002: who in the record's potSlug
   *  may draw on this offer ('trusted-members' | 'whole-pot'). Required (non-
   *  null) iff the record is pot-scoped (potSlug set); null for a fleet-scoped
   *  seat offer — audience is a pot-scoped concept only. */
  audience: 'trusted-members' | 'whole-pot' | null;
}

/** P-009: a fleet owner's signed request that the host holding one seat-offer
 *  spawn members from it. The target is the SEAT-OFFER's key pair — never a
 *  seat template ref (that would leak the M19-local account segment). */
export interface SpawnRequestPayload {
  /** The seat-offer's publisher (the contributing host's X9 numeric gh id). */
  targetPublisherGithubUserId: number;
  /** The seat-offer's id (`seat-<hex16>`, per-machine unique — hashes the
   *  target device pubkey, so it names exactly one machine's delegation). */
  targetOfferId: string;
  /** Members to spawn (1..seat count; the host's resolveSeatLaunch +
   *  consumeSeatAtBoot re-enforce the cap regardless). */
  count: number;
  /** The plan the spawned members work (the owner fleet's plan). */
  planSlug: string;
  /** The requesting session's coord owner id — audit + the addressee for any
   *  host-side follow-up. Advisory data, never an authority claim. */
  requesterOwnerId: string;
  /** Publisher-clock ms of the request — the honor-window fence (a host must
   *  refuse a request older than its window; blocks the late-flag-flip spawn). */
  requestedAtMs: number;
  /** Optional per-fleet brief the host composes UNDER the member baseline, or
   *  null (members then get the baseline only). */
  launchContext: string | null;
}

/** The publisher-signed offer-store record — one per (publisher, offerId). */
export interface WorkOfferStoreRecord {
  /** Store row id, unique per publisher (the fed key namespaces it under the
   *  publisher uid, so cross-publisher squatting is impossible by construction). */
  offerId: string;
  /** The accountable publisher — a numeric GitHub user id (X9). */
  publisherGithubUserId: number;
  /** The fleet channel the offer targets (H5 owner-prefixed at the scope layer).
   *  For kind 'seat' this is nullable — exactly one of fleetSlug/potSlug is set
   *  (pot-seat-pools-prose-ux-2026-07-18 P-001). 'spawn_request' always carries
   *  a non-null fleetSlug (potSlug must be null for that kind). */
  fleetSlug: string | null;
  /** P-001: for kind 'seat', the pot-scoped grantee (the pot's hive topic —
   *  ANY fleet in the pot may spend it, audience-gated) instead of one named
   *  fleet. Null for 'spawn_request' and for a fleet-scoped seat offer. */
  potSlug: string | null;
  kind: 'seat' | 'spawn_request';
  status: OfferStoreStatus;
  /** Why a 'cancelled' record was cancelled (display/receipts), or null. */
  cancelReason: string | null;
  /** Retired v1 work-offer fields. Kept as typed nulls so the canonical JSON
   *  bytes for existing seat/spawn_request records do not change. */
  workOffer: null;
  authorship: null;
  /** kind 'seat': the D-005 payload. null otherwise. */
  seat: SeatOfferPayload | null;
  /** kind 'spawn_request': the P-009 payload. null otherwise. */
  spawnRequest: SpawnRequestPayload | null;
  /** Monotone version; bumps on each author (secondary order; fed_hlc is LWW). */
  recordVersion: number;
}

/**
 * Domain-separation tag for the OUTER store signature. Binds the signature to
 * THIS protocol + version so it can never be replayed as a different signed
 * artifact (a fleet-directory card, an inner offer authorship, …).
 */
export const WORK_OFFER_STORE_SIG_DOMAIN = 'papercusp-work-offer-store-v1';

/** Mirrors fleet-directory-schema's slug fence — an offer must only ever name
 *  fleets whose scope ids parse. Reused verbatim for potSlug (P-001): a pot
 *  slug is a shared-hive home slug, same shape as a fleet slug. */
const FLEET_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const FLEET_SLUG_MAX = 100;
/** No '/' (the fed key is `<uid>/<offerId>` and the projection's delete parses
 *  on the FIRST slash), no whitespace/newline (the signed message is
 *  newline-delimited). */
const OFFER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const OFFER_ID_MAX = 200;
const SEAT_FIELD_MAX = 64;
const HOST_LABEL_MAX = 120;
const CANCEL_REASON_MAX = 500;
const SEAT_COUNT_MAX = 1000;
/** Mirrors launch-on-plan's MAX_MEMBERS: >12 desktop windows in one honor is
 *  heavy + almost always a mistake — a bigger wave is several requests. */
const SPAWN_REQUEST_COUNT_MAX = 12;
const PLAN_SLUG_MAX = 120;
const REQUESTER_OWNER_ID_MAX = 120;
/** A brief, not a book — the host composes it UNDER the member baseline. */
const LAUNCH_CONTEXT_MAX = 8000;

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/**
 * @param isPotScoped whether the OUTER record carries a non-null potSlug
 *   (P-001) — audience is required (non-null) iff true, and must be null
 *   otherwise (audience is a pot-scoped concept only).
 */
function coerceSeatPayload(
  raw: unknown,
  isPotScoped: boolean,
): { ok: true; seat: SeatOfferPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'record.seat must be a JSON object for kind \'seat\'' };
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.model !== 'string' || s.model.trim() === '' || s.model.length > SEAT_FIELD_MAX) {
    return { ok: false, error: `record.seat.model must be a non-empty string (≤${SEAT_FIELD_MAX} chars)` };
  }
  if (typeof s.effort !== 'string' || s.effort.trim() === '' || s.effort.length > SEAT_FIELD_MAX) {
    return { ok: false, error: `record.seat.effort must be a non-empty string (≤${SEAT_FIELD_MAX} chars)` };
  }
  if (!isPositiveInt(s.count) || s.count > SEAT_COUNT_MAX) {
    return { ok: false, error: `record.seat.count must be an integer 1..${SEAT_COUNT_MAX} (mig-486 quantity cap)` };
  }
  if (s.accountScope !== 'auto' && s.accountScope !== 'pinned') {
    return { ok: false, error: "record.seat.accountScope must be 'auto' or 'pinned' (the account ID itself never federates — D-005/M19)" };
  }
  const label = s.hostLabel === undefined ? null : s.hostLabel;
  if (label !== null && (typeof label !== 'string' || label.trim() === '' || label.length > HOST_LABEL_MAX)) {
    return { ok: false, error: `record.seat.hostLabel must be a non-empty string (≤${HOST_LABEL_MAX} chars) or null` };
  }
  const audience = s.audience === undefined ? null : s.audience;
  if (isPotScoped) {
    if (audience !== 'trusted-members' && audience !== 'whole-pot') {
      return { ok: false, error: "record.seat.audience must be 'trusted-members' or 'whole-pot' for a pot-scoped offer (P-001/D-002 — no silent default)" };
    }
  } else if (audience !== null) {
    return { ok: false, error: 'record.seat.audience must be absent/null for a fleet-scoped offer (audience is a pot-scoped concept only)' };
  }
  return {
    ok: true,
    seat: { model: s.model, effort: s.effort, count: s.count, accountScope: s.accountScope, hostLabel: label, audience },
  };
}

function coerceSpawnRequestPayload(
  raw: unknown,
): { ok: true; spawnRequest: SpawnRequestPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: "record.spawnRequest must be a JSON object for kind 'spawn_request'" };
  }
  const s = raw as Record<string, unknown>;
  if (!isPositiveInt(s.targetPublisherGithubUserId)) {
    return { ok: false, error: 'record.spawnRequest.targetPublisherGithubUserId must be a positive integer (X9: numeric id, never a login)' };
  }
  if (typeof s.targetOfferId !== 'string' || s.targetOfferId.length > OFFER_ID_MAX || !OFFER_ID_RE.test(s.targetOfferId)) {
    return { ok: false, error: `record.spawnRequest.targetOfferId must match ${OFFER_ID_RE} (≤${OFFER_ID_MAX} chars)` };
  }
  if (!isPositiveInt(s.count) || s.count > SPAWN_REQUEST_COUNT_MAX) {
    return { ok: false, error: `record.spawnRequest.count must be an integer 1..${SPAWN_REQUEST_COUNT_MAX} — a bigger wave is several requests` };
  }
  if (typeof s.planSlug !== 'string' || s.planSlug.length > PLAN_SLUG_MAX || !FLEET_SLUG_RE.test(s.planSlug)) {
    return { ok: false, error: `record.spawnRequest.planSlug must match ${FLEET_SLUG_RE} (≤${PLAN_SLUG_MAX} chars)` };
  }
  if (typeof s.requesterOwnerId !== 'string' || s.requesterOwnerId.length > REQUESTER_OWNER_ID_MAX || !OFFER_ID_RE.test(s.requesterOwnerId)) {
    return { ok: false, error: `record.spawnRequest.requesterOwnerId must match ${OFFER_ID_RE} (≤${REQUESTER_OWNER_ID_MAX} chars)` };
  }
  if (!isPositiveInt(s.requestedAtMs)) {
    return { ok: false, error: 'record.spawnRequest.requestedAtMs must be a positive integer (publisher-clock epoch ms)' };
  }
  const ctx = s.launchContext === undefined ? null : s.launchContext;
  if (ctx !== null && (typeof ctx !== 'string' || ctx.trim() === '' || ctx.length > LAUNCH_CONTEXT_MAX)) {
    return { ok: false, error: `record.spawnRequest.launchContext must be a non-empty string (≤${LAUNCH_CONTEXT_MAX} chars) or null` };
  }
  return {
    ok: true,
    spawnRequest: {
      targetPublisherGithubUserId: s.targetPublisherGithubUserId,
      targetOfferId: s.targetOfferId,
      count: s.count,
      planSlug: s.planSlug,
      requesterOwnerId: s.requesterOwnerId,
      requestedAtMs: s.requestedAtMs,
      launchContext: ctx,
    },
  };
}

/**
 * Validate + accept an UNTRUSTED record input (authoring API body / a parsed
 * remote record). CLOSED schema (fleet-directory-schema discipline): this feeds
 * authority + capacity decisions, so anything malformed is a rejection, never a
 * passthrough. The retired `work` kind is rejected; v1 delegation uses the
 * signed seat → spawn_request path exclusively.
 */
export function coerceWorkOfferStoreRecord(
  raw: unknown,
): { ok: true; record: WorkOfferStoreRecord } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'record must be a JSON object' };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.offerId !== 'string' || r.offerId.length > OFFER_ID_MAX || !OFFER_ID_RE.test(r.offerId)) {
    return { ok: false, error: `record.offerId must match ${OFFER_ID_RE} (≤${OFFER_ID_MAX} chars — no '/', no whitespace)` };
  }
  if (!isPositiveInt(r.publisherGithubUserId)) {
    return { ok: false, error: 'record.publisherGithubUserId must be a positive integer (X9: numeric id, never a login)' };
  }
  if (r.kind !== 'seat' && r.kind !== 'spawn_request') {
    return { ok: false, error: "record.kind must be 'seat' or 'spawn_request' (legacy 'work' intake is retired)" };
  }
  // P-001: the grantee. 'spawn_request' is always fleet-scoped
  // (fleetSlug required, potSlug must be absent) — unchanged pre-P-001
  // behavior. 'seat' generalizes to exactly one of fleetSlug/potSlug (a
  // standing seat-offer may target a whole pot instead of one fleet).
  const fleetSlugRaw = r.fleetSlug === undefined ? null : r.fleetSlug;
  const potSlugRaw = r.potSlug === undefined ? null : r.potSlug;
  const fleetSlugValid =
    fleetSlugRaw === null ||
    (typeof fleetSlugRaw === 'string' && fleetSlugRaw.length > 0 && fleetSlugRaw.length <= FLEET_SLUG_MAX && FLEET_SLUG_RE.test(fleetSlugRaw));
  const potSlugValid =
    potSlugRaw === null ||
    (typeof potSlugRaw === 'string' && potSlugRaw.length > 0 && potSlugRaw.length <= FLEET_SLUG_MAX && FLEET_SLUG_RE.test(potSlugRaw));
  if (r.kind !== 'seat') {
    if (typeof r.fleetSlug !== 'string' || r.fleetSlug.length > FLEET_SLUG_MAX || !FLEET_SLUG_RE.test(r.fleetSlug)) {
      return { ok: false, error: `record.fleetSlug must match ${FLEET_SLUG_RE} (≤${FLEET_SLUG_MAX} chars)` };
    }
    if (potSlugRaw !== null) {
      return { ok: false, error: `record.potSlug must be absent/null for kind '${r.kind}' (only a 'seat' offer may be pot-scoped, P-001)` };
    }
  } else {
    if (!fleetSlugValid || !potSlugValid) {
      return { ok: false, error: `record.fleetSlug/potSlug must each match ${FLEET_SLUG_RE} (≤${FLEET_SLUG_MAX} chars) when present` };
    }
    if ((fleetSlugRaw !== null) === (potSlugRaw !== null)) {
      return { ok: false, error: "exactly one of record.fleetSlug/record.potSlug is required for kind 'seat' (P-001)" };
    }
  }
  if (typeof r.status !== 'string' || !OFFER_STORE_STATUSES.includes(r.status as OfferStoreStatus)) {
    return { ok: false, error: `record.status must be one of ${OFFER_STORE_STATUSES.join('|')}` };
  }
  const cancelReason = r.cancelReason === undefined ? null : r.cancelReason;
  if (cancelReason !== null && (typeof cancelReason !== 'string' || cancelReason.length > CANCEL_REASON_MAX)) {
    return { ok: false, error: `record.cancelReason must be a string (≤${CANCEL_REASON_MAX} chars) or null` };
  }
  if (!isPositiveInt(r.recordVersion)) {
    return { ok: false, error: 'record.recordVersion must be a positive integer' };
  }

  const workOffer = null;
  const authorship = null;
  let seat: SeatOfferPayload | null = null;
  let spawnRequest: SpawnRequestPayload | null = null;

  if (r.kind === 'seat') {
    if (r.workOffer != null || r.authorship != null) {
      return { ok: false, error: "record.workOffer/authorship must be absent/null for kind 'seat'" };
    }
    if (r.spawnRequest != null) return { ok: false, error: "record.spawnRequest must be absent/null for kind 'seat'" };
    const s = coerceSeatPayload(r.seat, potSlugRaw !== null);
    if (!s.ok) return s;
    seat = s.seat;
  } else {
    if (r.workOffer != null || r.authorship != null) {
      return { ok: false, error: "record.workOffer/authorship must be absent/null for kind 'spawn_request'" };
    }
    if (r.seat != null) return { ok: false, error: "record.seat must be absent/null for kind 'spawn_request'" };
    const s = coerceSpawnRequestPayload(r.spawnRequest);
    if (!s.ok) return s;
    spawnRequest = s.spawnRequest;
  }

  return {
    ok: true,
    record: {
      offerId: r.offerId,
      publisherGithubUserId: r.publisherGithubUserId,
      fleetSlug: fleetSlugRaw as string | null,
      potSlug: potSlugRaw as string | null,
      kind: r.kind,
      status: r.status as OfferStoreStatus,
      cancelReason,
      workOffer,
      authorship,
      seat,
      spawnRequest,
      recordVersion: r.recordVersion,
    },
  };
}

/**
 * The CANONICAL JSON string of a record — deterministic (JCS-style sorted keys),
 * single-line. This is what is STORED in `record_json` and what the outer
 * signature covers; verify never re-canonicalizes (the signature is over the
 * exact stored bytes), only the AUTHOR calls this.
 */
export function canonicalWorkOfferRecordJson(record: WorkOfferStoreRecord): string {
  return canonicalJson(record);
}

/**
 * The EXACT bytes the publisher's device signs and a remote projection verifies
 * (mirrors fleetDirectorySignedBytes): newline-delimited, unambiguous — the
 * domain tag, workspace, hive-home slug and version contain no newline, and the
 * record JSON is single-line canonical JSON. Binding workspace + hive + version
 * prevents cross-hive / cross-version signature replay.
 */
export function workOfferStoreSignedBytes(input: {
  workspaceId: string;
  potHomeSlug: string;
  recordVersion: number;
  /** The canonical record JSON string (the value stored in `record_json`). */
  canonicalRecordJson: string;
}): Buffer {
  const msg = [
    WORK_OFFER_STORE_SIG_DOMAIN,
    input.workspaceId,
    input.potHomeSlug,
    String(input.recordVersion),
    input.canonicalRecordJson,
  ].join('\n');
  return Buffer.from(msg, 'utf8');
}

/**
 * Parse a stored/received `record_json` TEXT into the typed record. Defensive +
 * fail-closed: anything malformed returns null (an enforcement caller must treat
 * null as a refusal — this feeds claim/capacity decisions).
 */
export function parseWorkOfferRecordJson(recordJson: string | null | undefined): WorkOfferStoreRecord | null {
  if (!recordJson) return null;
  let v: unknown;
  try {
    v = JSON.parse(recordJson);
  } catch {
    return null;
  }
  const c = coerceWorkOfferStoreRecord(v);
  return c.ok ? c.record : null;
}

/** The one-column per-log federation key (matches migration 490's generated
 *  `offer_fed_key` and the projection's composeKey — keep all three in sync). */
export function workOfferFedKey(publisherGithubUserId: number, offerId: string): string {
  return `${publisherGithubUserId}/${offerId}`;
}
