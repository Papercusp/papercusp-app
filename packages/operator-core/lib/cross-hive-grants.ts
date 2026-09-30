/**
 * cross-hive-grants — owner-set capability grants for the cross-Hive boundary
 * (cross-hive-boundary-2026-06-08 P-002; hive-network-surface-2026-06-11 P-004 B-05).
 * Trust between sovereign Hives is per-peer-Hive + revocable, and now DIRECTED:
 *
 *   `in`  — which peer-Hive pubkeys may send which kinds INTO this Hive (admission;
 *           consumed by `admitCrossHiveEnvelope` on the receive path).
 *   `out` — which peer-Hive pubkeys THIS Hive may send which kinds TO (egress policy;
 *           consumed by `admitOutboundCrossHive` on the send path). Default-deny: the
 *           Queen cannot ask / request-work from a peer until the owner grants `out`.
 *
 * Stored as a single `hive_settings` value (federates to ALL of this Hive's Swarms over
 * the Hive peer-log, so every Swarm enforces the same policy) keyed by the Hive's home
 * slug. Absence of a grant is a hard reject in BOTH directions — the boundary is
 * allow-list (default-deny).
 *
 * Wire shape `{ in: { [peer]: kinds[] }, out: { [peer]: kinds[] } }`. BACK-COMPAT: a
 * legacy flat `{ [peer]: kinds[] }` value (written before B-05) reads as INBOUND grants
 * with no outbound — `{ in: <legacy>, out: {} }` — so existing admission policy is
 * unchanged until the owner adds an outbound grant.
 *
 * Written by the owner via `pot:cross_grant { direction }`.
 */
import type { Sql } from 'postgres';
import { getHiveSetting, setHiveSetting } from './hive-settings-store';
import {
  admitOutboundCrossHive,
  type CrossHiveAdmission,
  type CrossHiveGrant,
  type CrossHiveKind,
} from './cross-hive-boundary';

/** The single hive_settings key under which the directed grant map lives. */
export const CROSS_HIVE_GRANTS_KEY = 'xhive-capability-grants';

/** Grant direction: `in` = peers→us (admission); `out` = us→peers (egress). */
export type CrossHiveGrantDirection = 'in' | 'out';

/**
 * P-013 per-grant quota knobs (D-005 hardening). All optional — an absent field
 * falls back to the boundary's defaults (DEFAULT_CROSS_HIVE_MAX_PER_HOUR /
 * DEFAULT_CROSS_HIVE_MAX_BODY_BYTES; no default expiry).
 */
export interface CrossHiveGrantQuota {
  /** Max requests per rolling hour with this peer. */
  maxPerHour?: number;
  /** Max request `body` size in bytes. */
  maxBodyBytes?: number;
  /** Epoch-ms after which the grant is void. */
  expiresAt?: number;
}

/** One persisted grant entry: the kinds plus the P-013 quota knobs. */
interface GrantEntry extends CrossHiveGrantQuota {
  kinds: CrossHiveKind[];
}

/**
 * Wire shape of one direction: { [peerHivePubkey]: entry }. The entry is the
 * P-013 object form `{ kinds, maxPerHour?, maxBodyBytes?, expiresAt? }`; a bare
 * `CrossHiveKind[]` (written pre-P-013) reads as `{ kinds }` with no quotas set
 * (defaults apply at admission). New writes always persist the object form.
 */
type GrantMap = Record<string, GrantEntry>;

/** The full directed grant map persisted under {@link CROSS_HIVE_GRANTS_KEY}. */
export interface DirectedGrantMap {
  in: GrantMap;
  out: GrantMap;
}

/** Directed view of this Hive's grants as admission-ready arrays. */
export interface DirectedCrossHiveGrants {
  in: CrossHiveGrant[];
  out: CrossHiveGrant[];
}

const KINDS: readonly CrossHiveKind[] = ['ask', 'work-request'];
const isKind = (k: unknown): k is CrossHiveKind => KINDS.includes(k as CrossHiveKind);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A positive finite number, or undefined (quota fields tolerate junk). */
function posNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Parse one stored entry — either the pre-P-013 bare kinds array or the object
 * form `{ kinds, maxPerHour?, maxBodyBytes?, expiresAt? }` — into a clean
 * GrantEntry, or null when it grants nothing.
 */
function toGrantEntry(value: unknown): GrantEntry | null {
  const rawKinds = Array.isArray(value) ? value : isPlainObject(value) ? value.kinds : undefined;
  if (!Array.isArray(rawKinds)) return null;
  const kinds = [...new Set(rawKinds.filter(isKind))];
  if (kinds.length === 0) return null;
  const entry: GrantEntry = { kinds };
  if (isPlainObject(value)) {
    const maxPerHour = posNum(value.maxPerHour);
    const maxBodyBytes = posNum(value.maxBodyBytes);
    const expiresAt = posNum(value.expiresAt);
    if (maxPerHour != null) entry.maxPerHour = maxPerHour;
    if (maxBodyBytes != null) entry.maxBodyBytes = maxBodyBytes;
    if (expiresAt != null) entry.expiresAt = expiresAt;
  }
  return entry;
}

/** Parse one direction's stored value into a clean grant map (tolerant of junk). */
function toGrantMap(value: unknown): GrantMap {
  if (!isPlainObject(value)) return {};
  const out: GrantMap = {};
  for (const [peer, entry] of Object.entries(value)) {
    const clean = toGrantEntry(entry);
    if (clean) out[peer] = clean;
  }
  return out;
}

/**
 * Parse the stored setting value into a directed grant map. Detects the new directed
 * shape (an object carrying an `in` and/or `out` SUB-MAP) vs the legacy flat inbound
 * shape (an object whose values are kind arrays) and migrates the legacy form to
 * `{ in: <legacy>, out: {} }`. A peer literally named `in`/`out` in a legacy map carries
 * an array value (not a sub-map) so it is never mistaken for the directed shape.
 */
export function toDirectedGrantMap(value: unknown): DirectedGrantMap {
  if (!isPlainObject(value)) return { in: {}, out: {} };
  const hasIn = isPlainObject(value.in);
  const hasOut = isPlainObject(value.out);
  if (hasIn || hasOut) {
    return {
      in: toGrantMap(hasIn ? value.in : {}),
      out: toGrantMap(hasOut ? value.out : {}),
    };
  }
  // Legacy flat shape = INBOUND grants only.
  return { in: toGrantMap(value), out: {} };
}

function mapToGrants(map: GrantMap): CrossHiveGrant[] {
  return Object.entries(map).map(([peerHivePubkey, entry]) => ({
    peerHivePubkey,
    allowedKinds: entry.kinds,
    ...(entry.maxPerHour != null ? { maxPerHour: entry.maxPerHour } : {}),
    ...(entry.maxBodyBytes != null ? { maxBodyBytes: entry.maxBodyBytes } : {}),
    ...(entry.expiresAt != null ? { expiresAt: entry.expiresAt } : {}),
  }));
}

async function loadDirectedMap(workspaceId: string, potHomeSlug: string, sql?: Sql): Promise<DirectedGrantMap> {
  const rec = await getHiveSetting(workspaceId, potHomeSlug, CROSS_HIVE_GRANTS_KEY, sql);
  return toDirectedGrantMap(rec?.value);
}

/**
 * Load this Hive's INBOUND cross-Hive grants (the boundary's admission policy).
 * Unchanged contract: the receive path (`receiveCrossHive` → `admitCrossHiveEnvelope`)
 * consumes exactly these.
 */
export async function loadCrossHiveGrants(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<CrossHiveGrant[]> {
  return mapToGrants((await loadDirectedMap(workspaceId, potHomeSlug, sql)).in);
}

/**
 * Load this Hive's OUTBOUND cross-Hive grants (the send-path egress policy). Consumed by
 * `admitOutboundCrossHive` before a request (ask | work-request) is signed + sent.
 */
export async function loadOutboundCrossHiveGrants(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<CrossHiveGrant[]> {
  return mapToGrants((await loadDirectedMap(workspaceId, potHomeSlug, sql)).out);
}

/** Load both directions in one read (for `pot:cross_grant list` + the Network board). */
export async function loadDirectedCrossHiveGrants(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<DirectedCrossHiveGrants> {
  const directed = await loadDirectedMap(workspaceId, potHomeSlug, sql);
  return { in: mapToGrants(directed.in), out: mapToGrants(directed.out) };
}

/**
 * Grant (upsert) a peer-Hive the named kinds in the given direction. Empty kinds is
 * equivalent to a revoke of that peer in that direction. The OTHER direction is
 * preserved untouched.
 *
 * P-013 `quota` semantics: provided fields OVERWRITE, omitted fields PRESERVE the
 * peer's existing quota in that direction (so re-granting kinds never silently
 * wipes a tuned cap). To loosen back to the defaults, revoke + re-grant.
 */
export async function setCrossHiveGrant(
  workspaceId: string,
  potHomeSlug: string,
  peerHivePubkey: string,
  allowedKinds: readonly CrossHiveKind[],
  direction: CrossHiveGrantDirection,
  sql?: Sql,
  quota?: CrossHiveGrantQuota,
): Promise<void> {
  const directed = await loadDirectedMap(workspaceId, potHomeSlug, sql);
  const map = directed[direction];
  const clean = [...new Set(allowedKinds.filter(isKind))];
  if (clean.length === 0) delete map[peerHivePubkey];
  else {
    const prev = map[peerHivePubkey];
    const entry: GrantEntry = { kinds: clean };
    const maxPerHour = posNum(quota?.maxPerHour) ?? prev?.maxPerHour;
    const maxBodyBytes = posNum(quota?.maxBodyBytes) ?? prev?.maxBodyBytes;
    const expiresAt = posNum(quota?.expiresAt) ?? prev?.expiresAt;
    if (maxPerHour != null) entry.maxPerHour = maxPerHour;
    if (maxBodyBytes != null) entry.maxBodyBytes = maxBodyBytes;
    if (expiresAt != null) entry.expiresAt = expiresAt;
    map[peerHivePubkey] = entry;
  }
  await setHiveSetting(
    { workspaceId, potHomeSlug, settingKey: CROSS_HIVE_GRANTS_KEY, value: directed },
    sql,
  );
}

/** Revoke a peer-Hive's grant in the given direction (idempotent). */
export async function revokeCrossHiveGrant(
  workspaceId: string,
  potHomeSlug: string,
  peerHivePubkey: string,
  direction: CrossHiveGrantDirection,
  sql?: Sql,
): Promise<void> {
  const directed = await loadDirectedMap(workspaceId, potHomeSlug, sql);
  if (!(peerHivePubkey in directed[direction])) return;
  delete directed[direction][peerHivePubkey];
  await setHiveSetting(
    { workspaceId, potHomeSlug, settingKey: CROSS_HIVE_GRANTS_KEY, value: directed },
    sql,
  );
}

/** P-013 quota context for {@link assertOutboundGrant} — all optional. */
export interface AssertOutboundGrantOpts {
  /** The request body's UTF-8 byte size (size cap; absent = size check skipped). */
  bodyBytes?: number;
  /** Clock for expiry checks (default Date.now). */
  nowMs?: number;
  /**
   * Count requests sent to a peer within the rolling hour (rate cap). Default:
   * the C-1 `out` ledger. Injected for tests; a count failure SKIPS the rate
   * check (fail-open on telemetry, never on the allow-list).
   */
  countRecentToPeer?: (peerPubkey: string) => Promise<number>;
}

/**
 * Load this Hive's outbound grants and decide whether an outbound request to `toHivePubkey`
 * of `kind` is permitted. The convenience the front-door tools (`pot:ask` /
 * `pot:request_work`) call before composing a send — non-throwing, returns the admission
 * verdict + a reason to surface. Default-deny: an unknown peer is rejected. P-013:
 * also enforces the grant's expiry / size cap / rolling per-hour rate cap (counted
 * against the C-1 `out` ledger).
 */
export async function assertOutboundGrant(
  workspaceId: string,
  potHomeSlug: string,
  toHivePubkey: string,
  kind: CrossHiveKind,
  sql?: Sql,
  opts: AssertOutboundGrantOpts = {},
): Promise<CrossHiveAdmission> {
  const grants = await loadOutboundCrossHiveGrants(workspaceId, potHomeSlug, sql);
  const nowMs = opts.nowMs ?? Date.now();
  const countRecent =
    opts.countRecentToPeer ??
    (async (peer: string) => {
      const { PgCrossHiveAsks } = await import('./cross-hive-asks-pg');
      return new PgCrossHiveAsks(workspaceId, potHomeSlug, sql).countRecentByPeer(
        peer,
        'out',
        nowMs - 60 * 60 * 1000,
      );
    });
  let recentToPeerCount: number | undefined;
  try {
    recentToPeerCount = await countRecent(toHivePubkey);
  } catch {
    recentToPeerCount = undefined; // count unavailable → rate check skipped, never invented
  }
  return admitOutboundCrossHive(
    {
      toHivePubkey,
      kind,
      ...(opts.bodyBytes != null ? { bodyBytes: opts.bodyBytes } : {}),
    },
    {
      grants,
      nowMs,
      ...(recentToPeerCount != null ? { recentToPeerCount } : {}),
    },
  );
}
