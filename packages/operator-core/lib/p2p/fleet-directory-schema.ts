/**
 * p2p/fleet-directory-schema.ts — the typed FLEET DIRECTORY record and its canonical
 * signing surface (p2p-work-distribution-2026-07-02 P-101, D-006; migration 476).
 *
 * PURE: no I/O, no PG, no keychain (rollout-tiers.ts / offer-authorship.ts
 * discipline). SINGLE SOURCE OF TRUTH for the bytes the owner's device signs and a
 * remote projection verifies — the author (fleet-directory.ts putFleetRecord) and the
 * member-side projection (projections/fleet-directory.ts) BOTH derive the signed
 * bytes from {@link fleetDirectorySignedBytes}, so they can never drift.
 *
 * D-006: a fleet is a CHANNEL — exactly ONE accountable owner (numeric gh user id,
 * X9; logins are display-only) + an owner-signed delegated publisher set, browsable
 * hive-wide as a directory card. Baked amendments carried as record fields:
 *   H5  — no field needed: the record key (owner uid + fleet slug) IS the namespace,
 *         so every scope id (scope-repo.ts `fleet:<uid>/<slug>`) is owner-prefixed by
 *         construction; bare global aliases are post-v1.
 *   H10 — `successorGithubUserId` pre-designates who may take over an orphaned fleet;
 *         the hive owner's force-archive path is the projection's alternate verify.
 *   H16 — `offerRateCapPerHour` + `unclaimedOfferTtlSec` are the publisher-side rate
 *         cap and unclaimed-offer TTL knobs offers/budgets read per fleet.
 */

import { canonicalJson } from '../authority/authority-rpc-envelope';

/** The owner-signed fleet directory record — the hive-browsable card + the
 *  publisher-set source the P-102 offer-authorship chain resolves against. */
export interface FleetDirectoryRecord {
  /** Fleet slug (H5 owner-prefixed namespace; scope-repo `^[a-z0-9][a-z0-9-]*$`). */
  fleetSlug: string;
  /** The ONE accountable owner — a numeric GitHub user id (X9). */
  ownerGithubUserId: number;
  /** Directory-card display title. */
  title: string;
  /** Directory-card description. */
  description: string;
  /** Directory-card tags (hive-browse filtering). */
  tags: string[];
  /** The owner-delegated publisher set (numeric gh user ids; the owner is implicit
   *  and need not be listed). Changes are owner-signed like the whole record. */
  publisherGithubUserIds: number[];
  /** Billing default for the fleet's offers (D-009; a mode ref like 'host-pays').
   *  Display/routing like offer-budget.billedTo — never an authority input. */
  billingDefault: string;
  /** H10: the owner-pre-designated successor (numeric gh user id), or null. */
  successorGithubUserId: number | null;
  /** H16: publisher-side offer rate cap for this fleet (offers/hour), or null. */
  offerRateCapPerHour: number | null;
  /** H16: TTL for unclaimed offers in this fleet (seconds), or null. */
  unclaimedOfferTtlSec: number | null;
  /** Monotone version; bumps on each author (secondary order; fed_hlc is LWW). */
  recordVersion: number;
  /** Archived fleets stop resolving members / participating scopes. */
  archived: boolean;
}

/** D-009 mode (a) — the default billing mode when the author names none. */
export const DEFAULT_FLEET_BILLING = 'host-pays';

/**
 * Domain-separation tag for the signed message. Binds the signature to THIS protocol
 * + version so a fleet-directory signature can never be replayed as a different
 * signed artifact (a hive policy, an offer authorship, …).
 */
export const FLEET_DIRECTORY_SIG_DOMAIN = 'papercusp-fleet-directory-v1';

/** Mirrors scope-repo.ts SLUG_RE/SLUG_MAX — a directory record must only ever name
 *  fleets whose scope ids parse (fail-closed symmetry with parseScopeId). */
const FLEET_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const FLEET_SLUG_MAX = 100;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const TAGS_MAX = 32;
const TAG_MAX_LEN = 64;
const PUBLISHERS_MAX = 256;

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/**
 * Validate + accept an UNTRUSTED record input (authoring API body / a parsed remote
 * record). Unlike hive-policy's open document this is a CLOSED schema: membership and
 * rate knobs are security-adjacent, so an unknown or malformed field is a rejection,
 * never a passthrough. Optional knobs may be ABSENT on input (defaulted), but the
 * returned record is fully populated so its canonical form is stable.
 */
export function coerceFleetDirectoryRecord(
  raw: unknown,
): { ok: true; record: FleetDirectoryRecord } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'record must be a JSON object' };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.fleetSlug !== 'string' || r.fleetSlug.length > FLEET_SLUG_MAX || !FLEET_SLUG_RE.test(r.fleetSlug)) {
    return { ok: false, error: `record.fleetSlug must match ${FLEET_SLUG_RE} (≤${FLEET_SLUG_MAX} chars)` };
  }
  if (!isPositiveInt(r.ownerGithubUserId)) {
    return { ok: false, error: 'record.ownerGithubUserId must be a positive integer (X9: numeric id, never a login)' };
  }
  if (typeof r.title !== 'string' || r.title.trim() === '' || r.title.length > TITLE_MAX) {
    return { ok: false, error: `record.title must be a non-empty string (≤${TITLE_MAX} chars)` };
  }
  if (typeof r.description !== 'string' || r.description.length > DESCRIPTION_MAX) {
    return { ok: false, error: `record.description must be a string (≤${DESCRIPTION_MAX} chars)` };
  }
  const tags = r.tags === undefined ? [] : r.tags;
  if (
    !Array.isArray(tags) ||
    tags.length > TAGS_MAX ||
    !tags.every((t) => typeof t === 'string' && t.trim() !== '' && t.length <= TAG_MAX_LEN)
  ) {
    return { ok: false, error: `record.tags must be ≤${TAGS_MAX} non-empty strings (≤${TAG_MAX_LEN} chars each)` };
  }
  const pubs = r.publisherGithubUserIds === undefined ? [] : r.publisherGithubUserIds;
  if (!Array.isArray(pubs) || pubs.length > PUBLISHERS_MAX || !pubs.every(isPositiveInt)) {
    return { ok: false, error: `record.publisherGithubUserIds must be ≤${PUBLISHERS_MAX} positive integers (X9)` };
  }
  if (new Set(pubs).size !== pubs.length) {
    return { ok: false, error: 'record.publisherGithubUserIds must not contain duplicates' };
  }
  const billing = r.billingDefault === undefined ? DEFAULT_FLEET_BILLING : r.billingDefault;
  if (typeof billing !== 'string' || billing.trim() === '') {
    return { ok: false, error: 'record.billingDefault must be a non-empty string' };
  }
  const successor = r.successorGithubUserId === undefined ? null : r.successorGithubUserId;
  if (successor !== null && !isPositiveInt(successor)) {
    return { ok: false, error: 'record.successorGithubUserId must be a positive integer or null (H10)' };
  }
  const rateCap = r.offerRateCapPerHour === undefined ? null : r.offerRateCapPerHour;
  if (rateCap !== null && (typeof rateCap !== 'number' || !Number.isFinite(rateCap) || rateCap <= 0)) {
    return { ok: false, error: 'record.offerRateCapPerHour must be a positive number or null (H16)' };
  }
  const ttl = r.unclaimedOfferTtlSec === undefined ? null : r.unclaimedOfferTtlSec;
  if (ttl !== null && !isPositiveInt(ttl)) {
    return { ok: false, error: 'record.unclaimedOfferTtlSec must be a positive integer or null (H16)' };
  }
  if (!isPositiveInt(r.recordVersion)) {
    return { ok: false, error: 'record.recordVersion must be a positive integer' };
  }
  if (typeof r.archived !== 'boolean') {
    return { ok: false, error: 'record.archived must be a boolean' };
  }
  return {
    ok: true,
    record: {
      fleetSlug: r.fleetSlug,
      ownerGithubUserId: r.ownerGithubUserId,
      title: r.title,
      description: r.description,
      tags: tags as string[],
      publisherGithubUserIds: pubs as number[],
      billingDefault: billing,
      successorGithubUserId: successor,
      offerRateCapPerHour: rateCap,
      unclaimedOfferTtlSec: ttl,
      recordVersion: r.recordVersion,
      archived: r.archived,
    },
  };
}

/**
 * The CANONICAL JSON string of a record — deterministic (JCS-style sorted keys via
 * authority/canonicalJson), single-line. This is what is STORED in `record_json` and
 * what the signature covers; verify never re-canonicalizes (the signature is over the
 * exact stored bytes), only the AUTHOR calls this.
 */
export function canonicalFleetRecordJson(record: FleetDirectoryRecord): string {
  return canonicalJson(record);
}

/**
 * The EXACT bytes the author's device signs and a remote projection verifies.
 * Newline-delimited and unambiguous (mirrors hivePolicySignedBytes): the domain tag,
 * workspace, hive-home slug and version can contain no newline, and the record JSON
 * is single-line canonical JSON. Binding workspace + hive + version prevents
 * cross-hive / cross-version signature replay.
 */
export function fleetDirectorySignedBytes(input: {
  workspaceId: string;
  potHomeSlug: string;
  recordVersion: number;
  /** The canonical record JSON string (the value stored in `record_json`). */
  canonicalRecordJson: string;
}): Buffer {
  const msg = [
    FLEET_DIRECTORY_SIG_DOMAIN,
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
 * null as a refusal — this feeds membership decisions, unlike hive-policy's
 * permissive parse).
 */
export function parseFleetRecordJson(recordJson: string | null | undefined): FleetDirectoryRecord | null {
  if (!recordJson) return null;
  let v: unknown;
  try {
    v = JSON.parse(recordJson);
  } catch {
    return null;
  }
  const c = coerceFleetDirectoryRecord(v);
  return c.ok ? c.record : null;
}

/** The one-column per-log federation key (matches migration 476's generated
 *  `fleet_dir_fed_key` and the projection's composeKey — keep all three in sync). */
export function fleetDirFedKey(ownerGithubUserId: number, fleetSlug: string): string {
  return `${ownerGithubUserId}/${fleetSlug}`;
}
