/**
 * hive-beacon — the status-beacon wire schema (hive-network-surface-2026-06-11
 * P-005 / Brief B-06, CONTRACT OWNER C-2).
 *
 * A beacon is the compact, opt-in activity summary a Hive piggybacks onto its
 * directory re-announce so collaborators browsing the directory can see, at a
 * glance, what a foreign Hive is doing — without any directed channel or grant.
 * It is the DEGENERATE PUBLIC form of the future nested-Hive roll-up summary
 * (decisions D-002/D-003): this exact payload shape is RESERVED as the roll-up
 * `{status, capacity, blockers, focus}` summary — DO NOT add fields without a
 * plan edit (D-003).
 *
 * Trust posture (D-002/D-005): a beacon is best-effort GOSSIP, never a trust
 * surface. PUBLISH is owner-consent, default-OFF — the consent gate (the
 * `beacon-publish-consent` hive-setting; absent = OFF) lives in its own module
 * `beacon-consent.ts` (brief B-07; `getBeaconPublishConsent`), which this module
 * deliberately does NOT import (the schema stays IO-free). CONSUME is additive +
 * default-on: a peer renders whatever beacon another Hive published, clamping
 * anything oversize rather than rejecting the carrying announce — an
 * unpublished/garbled beacon costs the browser nothing, so the consumer is
 * maximally lenient.
 *
 * Signature binding: when an announce carries a beacon it is covered by the
 * announce signature via {@link canonicalBeaconForSigning} (a fixed-key-order
 * projection over the KNOWN v1 fields). Tampering a known field breaks the sig
 * (the announce is rejected as bad-signature); an unknown injected key is inert
 * (dropped from both the signed projection and {@link sanitizeBeacon}), in line
 * with the not-a-trust-surface posture.
 *
 * Pure module — no IO, no imports. The publisher (hive-beacon-publish.ts) sources
 * the live signals; the directory wires the wire-format in/out.
 */

/** The only beacon schema version (V1 is binary — all fields or no beacon, D-002). */
export const BEACON_VERSION = 1 as const;

/** Max length of the free-text beacon fields (`focus`, `lastCompleted`) — C-2 "≤120". */
export const BEACON_TEXT_MAX = 120;

/**
 * How long a received beacon stays "live" for the consumer before it should be
 * shown as stale. A Hive re-announces every ~5 min (DEFAULT_REANNOUNCE_MS), so
 * three missed re-announces (~15 min) means the source is gone/quiet. A renderer
 * uses {@link isBeaconStale}; the directory never drops the listing on staleness.
 */
export const DEFAULT_BEACON_STALE_MS = 15 * 60 * 1000;

/**
 * The C-2 beacon payload v1. ALSO the reserved nested-Hive roll-up summary shape
 * (D-003) — frozen; no new fields without a plan edit.
 */
export interface HiveStatusBeacon {
  /** Schema version — always {@link BEACON_VERSION}. */
  v: 1;
  /** Distinct live agents working the Hive right now (≥0). */
  liveAgents: number;
  /** Non-terminal work items queued/in-flight for the Hive (≥0). */
  queueDepth: number;
  /** A one-liner of what the Hive is actively working on (≤120 chars; '' when idle). */
  focus: string;
  /** A one-liner of the Hive's most recent completion (≤120 chars; '' when none). */
  lastCompleted: string;
  /** ISO-8601 build time of this beacon (the consumer's staleness key). */
  ts: string;
}

/** The raw signals a beacon summarizes, before clamping/normalization. */
export interface BeaconInput {
  liveAgents: number;
  queueDepth: number;
  focus: string;
  lastCompleted: string;
  /** ISO-8601 build time. */
  ts: string;
}

function clampText(s: string): string {
  return s.length > BEACON_TEXT_MAX ? s.slice(0, BEACON_TEXT_MAX) : s;
}

/** Coerce to a non-negative integer; non-finite/negative → 0. */
function clampCount(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** Coerce an unknown to a non-negative integer, or undefined when not a number. */
function toCount(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.floor(v));
}

/**
 * Build a well-formed, clamped beacon from raw signals (the PUBLISHER path). The
 * text fields are clamped to {@link BEACON_TEXT_MAX}; counts floored to ≥0; the
 * version pinned. A well-behaved publisher therefore never emits an oversize
 * field — the consumer's clamp is defense against a buggy/older peer.
 */
export function makeBeacon(input: BeaconInput): HiveStatusBeacon {
  return {
    v: BEACON_VERSION,
    liveAgents: clampCount(input.liveAgents),
    queueDepth: clampCount(input.queueDepth),
    focus: clampText(input.focus ?? ''),
    lastCompleted: clampText(input.lastCompleted ?? ''),
    ts: input.ts,
  };
}

/**
 * The canonical signing projection of a beacon: the KNOWN v1 fields in a FIXED
 * key order, each copied as-is when present. Both the announce builder and the
 * verifier run this over `body.beacon`, so the signed bytes are order-independent
 * of the wire encoding (V8 preserves JSON key order, but we do not rely on it).
 *
 * Unknown keys are intentionally omitted — they are not part of the frozen
 * schema (D-003), so an injected unknown key cannot ride inside the signature.
 * Returns undefined for a non-object (then the announce signs no beacon at all).
 */
export function canonicalBeaconForSigning(beacon: unknown): Record<string, unknown> | undefined {
  if (!beacon || typeof beacon !== 'object') return undefined;
  const b = beacon as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (b.v !== undefined) out.v = b.v;
  if (b.liveAgents !== undefined) out.liveAgents = b.liveAgents;
  if (b.queueDepth !== undefined) out.queueDepth = b.queueDepth;
  if (b.focus !== undefined) out.focus = b.focus;
  if (b.lastCompleted !== undefined) out.lastCompleted = b.lastCompleted;
  if (b.ts !== undefined) out.ts = b.ts;
  return out;
}

/**
 * The CONSUMER-side sanitize: validate + clamp a received beacon into a safe
 * HiveStatusBeacon, or undefined when it is unusable. NEVER throws and never
 * signals "reject the announce" — a malformed/oversize beacon yields undefined
 * (the listing renders with no beacon) or a clamped value (oversize text), and
 * the carrying announce is always still listed (the directory calls this and
 * simply omits the beacon when it returns undefined).
 *
 * Rejects only a wrong/missing version, non-numeric counts, or a missing ts —
 * the minimum needed to render a coherent badge. Oversize text is sliced, not
 * rejected; unknown keys are ignored.
 */
export function sanitizeBeacon(raw: unknown): HiveStatusBeacon | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as Record<string, unknown>;
  if (b.v !== BEACON_VERSION) return undefined;
  const liveAgents = toCount(b.liveAgents);
  const queueDepth = toCount(b.queueDepth);
  const ts = typeof b.ts === 'string' ? b.ts : undefined;
  if (liveAgents === undefined || queueDepth === undefined || ts === undefined) return undefined;
  return {
    v: BEACON_VERSION,
    liveAgents,
    queueDepth,
    focus: clampText(typeof b.focus === 'string' ? b.focus : ''),
    lastCompleted: clampText(typeof b.lastCompleted === 'string' ? b.lastCompleted : ''),
    ts,
  };
}

/**
 * Whether a beacon is older than `ttlMs` (default {@link DEFAULT_BEACON_STALE_MS})
 * relative to `nowMs`. An unparseable ts is treated as stale. A renderer greys a
 * stale beacon; the directory never drops the listing on staleness alone.
 */
export function isBeaconStale(
  beacon: HiveStatusBeacon,
  nowMs: number,
  ttlMs: number = DEFAULT_BEACON_STALE_MS,
): boolean {
  const t = Date.parse(beacon.ts);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > ttlMs;
}
