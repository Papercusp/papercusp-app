/**
 * Hybrid Logical Clocks (HLC) — Kulkarni, Demirbas, Madappa, Avva, Leone 2014.
 * Plan: locks-correctness-hardening-2026-06-04 (D-003).
 *
 * Our TTL leases and federation LWW tie-breaks currently order events by an
 * independent WALL clock (PG `now()` / `Date.now()`). That is safe today (one
 * shared Postgres), but the moment embedded-pg-per-machine ships the winner of
 * a tie is decided by NTP skew/step rather than causality — a clock that jumps
 * backward can resurrect a stale write, and two machines' "same instant" is a
 * coin flip. An HLC is the software substitute for TrueTime: 8 bytes, no
 * hardware. It keeps a physical component (so values still track real time and
 * stay human-comparable) AND a logical counter that (a) never goes backwards
 * across an NTP correction and (b) carries happens-before causality across
 * machines when clocks are merged on receive.
 *
 * An HLC is `{ ms, count, node? }`:
 *   - `ms`    — max physical time witnessed (ms since epoch), monotone non-decreasing.
 *   - `count` — logical counter, bumped to break ties within one `ms` and to
 *               encode causal ordering when a remote HLC is merged in.
 *   - `node`  — the stamping clock's identity segment. Two INDEPENDENT clocks can
 *               mint the same `(ms, count)` — and after any recv-ratchet episode
 *               pins a fleet's wall components to one high-water mark they mint
 *               them in near-lockstep (WI-1672: every `>=` LWW guard then accepts
 *               the incoming op on BOTH peers and two honest peers stably SWAP
 *               winners). The node segment makes the order total BY CONSTRUCTION:
 *               a genuine full tie can only be the same stamp replayed, where
 *               tie-accept is the correct (idempotent) behavior. Optional only
 *               for legacy values — every clock-minted stamp carries one.
 *
 * Total order: compare `ms`, then `count`, then `node` (absent ⇒ '' — a legacy
 * stamp loses ties to any node-carrying stamp, identically on every peer).
 *
 * This module is PURE (no PG, no I/O) so it is exhaustively unit-testable and
 * can be embedded anywhere — the federation merge, the lease store, a peer log.
 */

export interface Hlc {
  /** Physical-time component, ms since epoch. Monotone non-decreasing. */
  ms: number;
  /** Logical counter within `ms` (and the causal-merge bump). 16-bit. */
  count: number;
  /**
   * Stamping clock's identity — {@link HLC_NODE_LEN} lowercase-hex chars (fixed
   * shape so PG TEXT collation, C locale, and JS UTF-16 compares all agree).
   * Absent/'' on legacy (pre-WI-1672) values.
   */
  node?: string;
}

/** Logical counter ceiling (16 bits). Overflow rolls `ms` forward by 1. */
export const HLC_MAX_COUNT = 0xffff;

export const HLC_ZERO: Hlc = { ms: 0, count: 0 };

/** Fixed width of a node-identity segment (lowercase hex). Fixed so every
 *  encoded HLC that carries a node has the identical string shape — the property
 *  that keeps PG TEXT-collation compares and JS string compares in agreement. */
export const HLC_NODE_LEN = 16;

/**
 * Normalize a caller-supplied node identity to the canonical segment: lowercase
 * hex, exactly {@link HLC_NODE_LEN} chars (longer inputs — e.g. a 64-hex log
 * key — are truncated; shorter ones zero-padded). '' (no node) stays ''.
 */
export function normalizeHlcNode(raw: string | null | undefined): string {
  const hex = (raw ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!hex) return '';
  return hex.length >= HLC_NODE_LEN ? hex.slice(0, HLC_NODE_LEN) : hex.padEnd(HLC_NODE_LEN, '0');
}

/**
 * Mint a fresh random node identity. Math.random-sourced (this module stays
 * dependency-free and browser-safe) — ~106 bits drawn across two calls, far
 * beyond what distinguishing the handful of writers in a hive needs. Uniqueness
 * per CLOCK INSTANCE is the requirement; stability across restarts is not
 * (stamps are minted once and persisted — a new id after a restart just means
 * new stamps sort under a new identity, which is still a total order).
 */
export function newHlcNodeId(): string {
  const a = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const b = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return normalizeHlcNode(a + b);
}

/** Total order on HLCs: -1 if a<b, 1 if a>b, 0 if equal. `node` breaks
 *  `(ms, count)` ties across writers (absent ⇒ '' — sorts below any node). */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.count !== b.count) return a.count < b.count ? -1 : 1;
  const na = a.node ?? '';
  const nb = b.node ?? '';
  if (na !== nb) return na < nb ? -1 : 1;
  return 0;
}

/** Bump a counter within an `ms`; roll `ms` forward on 16-bit overflow. */
function bumpCount(ms: number, count: number): Hlc {
  return count >= HLC_MAX_COUNT ? { ms: ms + 1, count: 0 } : { ms, count: count + 1 };
}

/**
 * Encode an HLC into a lexicographically-sortable string —
 * `"<15-digit ms>:<5-digit count>"`, plus `":<16-hex node>"` when the stamp
 * carries a node identity. String compare on the encoding equals compareHlc
 * (a node-less legacy string is a strict prefix of its node-carrying siblings,
 * so it loses the tie — same verdict compareHlc gives '' vs a node), so it can
 * be stored in a text column / JSON `ts` field and sorted directly. 15 digits
 * of ms covers epoch-ms well past year 30000.
 */
export function encodeHlc(h: Hlc): string {
  const base = `${String(h.ms).padStart(15, '0')}:${String(h.count).padStart(5, '0')}`;
  return h.node ? `${base}:${h.node}` : base;
}

/** Parse an `encodeHlc` string (either shape) back to an Hlc. Returns HLC_ZERO
 *  on a bad input. */
export function decodeHlc(s: string | null | undefined): Hlc {
  if (!s) return { ...HLC_ZERO };
  const i = s.indexOf(':');
  if (i < 0) return { ...HLC_ZERO };
  const j = s.indexOf(':', i + 1);
  const ms = Number(s.slice(0, i));
  const count = Number(j < 0 ? s.slice(i + 1) : s.slice(i + 1, j));
  if (!Number.isFinite(ms) || !Number.isFinite(count)) return { ...HLC_ZERO };
  const node = j < 0 ? '' : s.slice(j + 1);
  return node ? { ms, count, node } : { ms, count };
}

/** Pack into a single 64-bit unsigned BigInt (48-bit ms ‖ 16-bit count) — the
 *  "8 bytes" form for a binary column. ms is masked to 48 bits (good to ~8900 AD).
 *  ⚠ Drops the `node` segment — the packed form is NOT tie-safe across writers;
 *  use the encoded string wherever cross-writer LWW ordering matters (WI-1672). */
export function packHlc(h: Hlc): bigint {
  const ms = BigInt(h.ms) & ((1n << 48n) - 1n);
  const count = BigInt(h.count) & 0xffffn;
  return (ms << 16n) | count;
}

export function unpackHlc(packed: bigint): Hlc {
  return { ms: Number(packed >> 16n), count: Number(packed & 0xffffn) };
}

/**
 * A stateful HLC generator for one node. `send()`/`now()` stamp a local event;
 * `recv()` merges a remote HLC observed on receive so this node's clock advances
 * past the remote's causal frontier. Single-threaded JS makes the read-modify-
 * write of `last` atomic without locking.
 */
export class HlcClock {
  private last: Hlc;
  private readonly physical: () => number;
  /** This clock's identity segment, stamped onto every value it returns
   *  (normalized; '' ⇒ node-less legacy stamps). */
  readonly node: string;
  /** ε bound on the recv ratchet (Kulkarni et al. §4): a remote `ms` more than
   *  this far ahead of our physical clock does NOT advance us — one absurd
   *  future stamp would otherwise pin the clock (and, re-propagated, the whole
   *  hive) years ahead (WI-1672 amplifier). 10min = 2× the announce-admission
   *  skew window, so every legitimately-admitted peer still ratchets us. */
  private readonly maxDriftMs: number;

  constructor(opts: { physical?: () => number; seed?: Hlc; node?: string; maxDriftMs?: number } = {}) {
    this.physical = opts.physical ?? (() => Date.now());
    this.node = normalizeHlcNode(opts.node);
    this.maxDriftMs = opts.maxDriftMs ?? 600_000;
    this.last = opts.seed ? { ...opts.seed } : { ...HLC_ZERO };
  }

  /** Stamp this clock's node identity onto an (ms, count) pair. The internal
   *  `last` state stays node-less — recv() merges only the causal components,
   *  and every RETURNED value carries OUR identity, never a remote's. */
  private stamped(h: Hlc): Hlc {
    return this.node ? { ms: h.ms, count: h.count, node: this.node } : { ms: h.ms, count: h.count };
  }

  /** The clock's current value without advancing it. */
  peek(): Hlc {
    return this.stamped(this.last);
  }

  /**
   * Stamp a LOCAL event. Returns an HLC strictly greater than every prior HLC
   * this clock produced AND ≥ the physical clock — monotone even if the
   * physical clock just stepped backward (NTP correction). `physicalNow`
   * overrides the wall clock for one call (e.g. to seed from an event's own
   * recorded ms).
   */
  send(physicalNow?: number): Hlc {
    const pt = physicalNow ?? this.physical();
    const last = this.last;
    this.last = pt > last.ms ? { ms: pt, count: 0 } : bumpCount(last.ms, last.count);
    return this.stamped(this.last);
  }

  /** Alias for {@link send} — a local event reads as "now". */
  now(physicalNow?: number): Hlc {
    return this.send(physicalNow);
  }

  /**
   * Merge a remote HLC observed on RECEIVE and advance the local clock past it.
   * Returns the new local HLC (≥ local, ≥ physical, and ≥ remote unless the
   * remote is past the ε drift bound) — this is what carries happens-before
   * across machines: any event stamped after recv() causally follows the
   * received one. A remote more than `maxDriftMs` ahead of the physical clock
   * is treated as absent (its stamp still applies to the DATA; it just doesn't
   * ratchet OUR clock — see maxDriftMs).
   */
  recv(remote: Hlc, physicalNow?: number): Hlc {
    const pt = physicalNow ?? this.physical();
    const l = this.last;
    if (remote.ms - pt > this.maxDriftMs) remote = { ms: 0, count: 0 };
    const ms = Math.max(l.ms, remote.ms, pt);
    let next: Hlc;
    if (ms === l.ms && ms === remote.ms) next = bumpCount(ms, Math.max(l.count, remote.count));
    else if (ms === l.ms) next = bumpCount(ms, l.count);
    else if (ms === remote.ms) next = bumpCount(ms, remote.count);
    else next = { ms, count: 0 };
    this.last = next;
    return this.stamped(this.last);
  }
}

/**
 * Process-wide HLC clock for the federation/lease surfaces. A single shared
 * generator per process keeps every locally-stamped op + lease monotone with
 * respect to each other. Tests construct their own HlcClock for isolation.
 *
 * Carries a fresh per-process node identity (WI-1672) so two processes that
 * mint the same `(ms, count)` still produce distinct, totally-ordered stamps.
 */
let _processClock: HlcClock | null = null;
export function processHlc(): HlcClock {
  if (!_processClock) _processClock = new HlcClock({ node: newHlcNodeId() });
  return _processClock;
}

/** Test seam — reset the process clock between tests. */
export function _resetProcessHlcForTests(): void {
  _processClock = null;
}
