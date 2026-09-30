/**
 * lock-event-stream — the append-only lock-event stream on the peer-log, for
 * INSTANT lock-authority handover (P-015 of shared-hive-hardening-2026-06-13).
 *
 * # The gap this closes
 *
 * When the lock authority for a scope (harness / Hive) fails over — the previous
 * authority's presence went stale, so the next-lowest live peer is now the
 * authority by the deterministic D-005 selection — the NEW authority starts with
 * NO lock state. Today it rebuilds by waiting for holders to re-assert their TTL
 * heartbeats; that takes up to one heartbeat interval, during which contended
 * acquires fail open (D-004 — git is the backstop, so the gap costs merge churn,
 * never data). See {@link ./lock-set-reconstructor}.
 *
 * This module is the README's named "deferred enhancement": an append-only
 * stream of acquire/release EVENTS on the per-peer Hypercore log
 * (`sync/hyperbee` peer-log). The authority appends an event whenever it grants
 * or releases a file-claim lock; a new authority, on takeover, reads the merged
 * stream and folds it into the live lock set INSTANTLY — no heartbeat-interval
 * wait. If the stream is unavailable (no replica yet, not federating, or read
 * error) the reconstructor falls back to the heartbeat-reassert rebuild, so the
 * fail-open contract is preserved as the floor.
 *
 * # Shape of the design (seams, mirroring the rest of authority/)
 *
 *  - {@link LockEvent} — the acquire/release event + a pure {@link reconstructLockSet}
 *    fold (latest-per-path wins; an unexpired acquire is held, a release / expired
 *    acquire frees). Deterministic + injectable-clock — fully unit-testable.
 *  - {@link LockEventSink} — what the authority calls on grant/release. Default
 *    no-op; the boot wiring installs {@link PeerLogLockEventSink} (appends a
 *    `lock-event` op to the peer's OWN log) when the scope is federating.
 *  - {@link LockEventReader} — what a NEW authority reads on takeover. Default
 *    empty (→ heartbeat fallback); the boot wiring installs
 *    {@link PeerLogLockEventReader} (scans the admitted logs for `lock-event` ops).
 *
 * Both sinks/readers are module singletons set at boot, exactly like
 * {@link ./peer-rpc-transport}'s transport — so callers depend on a stable
 * `record(...)` / `readLockEvents(...)` surface and the live peer-log binding is
 * one injection. On a single box (no remote peers) the sink/reader stay the
 * no-op defaults and this whole module is dormant, like the rest of the
 * cross-machine layer.
 */

import type { PeerLogOp } from '../sync/hyperbee/peer-log';
import { CURRENT_SCHEMA_VERSION } from '../sync/hyperbee/schema-version';
import type { HeldLock } from './lock-set-reconstructor';

/** The peer-log table tag carrying lock-authority grant/release events. */
export const LOCK_EVENT_TABLE = 'lock-event';

/** A single acquire or release of a file-claim lock, as recorded by the authority. */
export interface LockEvent {
  kind: 'acquire' | 'release';
  /** The scope key the lock authority serializes (harness slug, or Hive slug). */
  scope: string;
  /** The locked path (the lock key — a coordination-domain repo path). */
  path: string;
  /** The lock holder (a coord ownerId). */
  owner: string;
  /** Absolute expiry epoch-ms for an `acquire` (the TTL); omitted on a `release`. */
  expiresAtMs?: number;
  /** G-0 (P-033) publish-then-release: the head sha the holder published before
   *  this `release` — lets a failover authority rebuild sha-token-registry
   *  state from the stream. Ignored by the lock-set fold. */
  publishedSha?: string;
  /** Event time, epoch-ms. The fold orders by this (latest wins). */
  ts: number;
}

/** Compose the peer-log hbKey for a lock-event: scope + path → one row per lock.
 *  The `\x00` separator can't appear in a slug or a repo path, so the two
 *  fields never collide. */
export function lockEventHbKey(scope: string, path: string): string {
  return `${scope}\x00${path}`;
}

/** Map a {@link LockEvent} to the {@link PeerLogOp} that carries it on the own log. */
export function lockEventToPeerLogOp(event: LockEvent, authorPubkey: string): PeerLogOp {
  return {
    type: 'put',
    table: LOCK_EVENT_TABLE,
    hbKey: lockEventHbKey(event.scope, event.path),
    value: event,
    ts: event.ts,
    schema_version: CURRENT_SCHEMA_VERSION,
    author_pubkey: authorPubkey,
  };
}

/** Decode a peer-log op back to a {@link LockEvent}, or null when it isn't a
 *  well-formed lock-event op (wrong table / malformed value). Never throws. */
export function peerLogOpToLockEvent(op: PeerLogOp | null | undefined): LockEvent | null {
  if (!op || op.table !== LOCK_EVENT_TABLE || !op.value || typeof op.value !== 'object') return null;
  const v = op.value as Partial<LockEvent>;
  if (
    (v.kind !== 'acquire' && v.kind !== 'release') ||
    typeof v.scope !== 'string' ||
    typeof v.path !== 'string' ||
    typeof v.owner !== 'string' ||
    typeof v.ts !== 'number'
  ) {
    return null;
  }
  return {
    kind: v.kind,
    scope: v.scope,
    path: v.path,
    owner: v.owner,
    expiresAtMs: typeof v.expiresAtMs === 'number' ? v.expiresAtMs : undefined,
    ts: v.ts,
  };
}

/**
 * PURE fold: replay an unordered set of lock-events into the live lock set as of
 * `nowMs`. Per (scope, path) the latest event wins (max `ts`; a `release` wins a
 * same-`ts` tie — free is the safe state, never resurrect a released lock under a
 * clock collision, and fail-open means an over-free only costs merge churn). An
 * `acquire` whose expiry is still in the future contributes a held lock; a
 * `release`, or an expired acquire, leaves the path free.
 *
 * Deterministic + injectable-clock — the instant-handover reconstruction core.
 */
export function reconstructLockSet(events: LockEvent[], nowMs: number): HeldLock[] {
  const latest = new Map<string, LockEvent>();
  for (const e of events) {
    const key = lockEventHbKey(e.scope, e.path);
    const prior = latest.get(key);
    if (!prior || e.ts > prior.ts || (e.ts === prior.ts && e.kind === 'release')) {
      latest.set(key, e);
    }
  }
  const held: HeldLock[] = [];
  for (const e of latest.values()) {
    if (e.kind !== 'acquire') continue;
    const expiresAtMs = e.expiresAtMs ?? 0;
    if (expiresAtMs > nowMs) held.push({ path: e.path, owner: e.owner, expiresAtMs });
  }
  return held;
}

// ── Sink seam (write side: the authority records grants/releases) ────────────

/**
 * The sink the lock authority calls to append a grant/release to the federated
 * lock-event stream. Default = the no-op sink (single box / not federating), so
 * recording is a free no-op until the peer-log sink is wired at boot.
 */
export interface LockEventSink {
  record(event: LockEvent): void | Promise<void>;
}

const NULL_LOCK_EVENT_SINK: LockEventSink = { record() {} };
let _sink: LockEventSink | null = null;

/** Install the lock-event sink. Boot wires {@link PeerLogLockEventSink}; pass
 *  null to reset to the no-op sink. */
export function setLockEventSink(sink: LockEventSink | null): void {
  _sink = sink;
}
/** The installed sink, or the no-op default. */
export function getLockEventSink(): LockEventSink {
  return _sink ?? NULL_LOCK_EVENT_SINK;
}
/** Test-only: reset the installed sink. */
export function __resetLockEventSinkForTests(): void {
  _sink = null;
}

/**
 * Fire a lock-event into the installed sink, NEVER throwing. Lock-event capture
 * is best-effort federation: a failed append (PG/Hypercore blip, not federating)
 * must never fail the lock op itself — the heartbeat-reassert path and git remain
 * the backstops (D-004). The authority op handlers call this fire-and-forget.
 */
export async function recordLockEvent(event: LockEvent): Promise<void> {
  try {
    await getLockEventSink().record(event);
  } catch {
    /* best-effort: a capture failure degrades to the heartbeat-reassert rebuild */
  }
}

// ── Reader seam (read side: a NEW authority hydrates on takeover) ─────────────

/**
 * Reads the lock-events for a scope from the federated peer-logs — the
 * instant-reconstruction source a NEW authority reads on takeover. Returns the
 * raw in-scope events; the caller folds them via {@link reconstructLockSet}.
 * Default = empty (→ the reconstructor falls back to the heartbeat-reassert
 * rebuild, the documented fail-open fallback when the stream is unavailable).
 */
export interface LockEventReader {
  readLockEvents(scope: string, nowMs: number): Promise<LockEvent[]>;
}

const NULL_LOCK_EVENT_READER: LockEventReader = {
  async readLockEvents() {
    return [];
  },
};
let _reader: LockEventReader | null = null;

/** Install the lock-event reader. Boot wires {@link PeerLogLockEventReader}; pass
 *  null to reset to the empty default. */
export function setLockEventReader(reader: LockEventReader | null): void {
  _reader = reader;
}
/** The installed reader, or the empty default. */
export function getLockEventReader(): LockEventReader {
  return _reader ?? NULL_LOCK_EVENT_READER;
}
/** Test-only: reset the installed reader. */
export function __resetLockEventReaderForTests(): void {
  _reader = null;
}

// ── Peer-log adapters ─────────────────────────────────────────────────────────

/** Minimal own-log append surface (a subset of peer-log's `OwnLog`). */
export interface OwnLogAppender {
  append(op: PeerLogOp): Promise<void>;
}

/** Resolve the OWN writable log for a scope (harness / Hive slug), or null when
 *  the scope is not federating / not booted. Boot wires this to
 *  `getBootedHarness(...).ownLog`. */
export type OwnLogResolver = (scope: string) => OwnLogAppender | null | Promise<OwnLogAppender | null>;

export interface PeerLogLockEventSinkOpts {
  resolveOwnLog: OwnLogResolver;
  /** The local device pubkey stamped as the op author (diagnostic provenance;
   *  the lock HOLDER lives in the event value). Default ''. */
  authorPubkey?: string | (() => string);
}

/**
 * Appends each lock-event as a `lock-event` op on the peer's OWN single-writer
 * log. Resolving null for a scope (not federating / not booted) is a no-op — the
 * documented fallback. The own log is replicated to peers via the read-merge, so
 * a new authority's reader sees these events.
 */
export class PeerLogLockEventSink implements LockEventSink {
  private readonly resolveOwnLog: OwnLogResolver;
  private readonly authorPubkey: string | (() => string);

  constructor(opts: PeerLogLockEventSinkOpts) {
    this.resolveOwnLog = opts.resolveOwnLog;
    this.authorPubkey = opts.authorPubkey ?? '';
  }

  async record(event: LockEvent): Promise<void> {
    const log = await this.resolveOwnLog(event.scope);
    if (!log) return; // not federating this scope → nothing to append (fallback)
    const author = typeof this.authorPubkey === 'function' ? this.authorPubkey() : this.authorPubkey;
    await log.append(lockEventToPeerLogOp(event, author ?? ''));
  }
}

/** A readable peer-log (the subset of `OwnLog` / `RemoteLog` the reader scans). */
export interface ReadableLog {
  get(i: number): Promise<PeerLogOp | null>;
  readonly length: number;
  update?(): Promise<void>;
}

/** Resolve the logs (own + admitted) to scan for a scope's lock-events. Boot
 *  wires this to `getBootedHarness(...)`'s admitted set. */
export type AdmittedLogsResolver = (scope: string) => ReadableLog[] | Promise<ReadableLog[]>;

export interface PeerLogLockEventReaderOpts {
  resolveLogs: AdmittedLogsResolver;
  /** Max ops to scan back per log (the instant-handover bound; lock-events are a
   *  sparse slice, and this read happens only on takeover). Default 2000. */
  scanLimit?: number;
}

/**
 * Reads lock-events by scanning the tail of each admitted peer-log for
 * `lock-event` ops. Bounded by `scanLimit` per log so takeover stays cheap even
 * on a long history (a full PG projection of lock-events is the future
 * optimization; this scan is correct and self-contained). Never throws — a read
 * error on one log degrades to whatever the other logs yield (and ultimately to
 * the heartbeat fallback when nothing is read).
 */
export class PeerLogLockEventReader implements LockEventReader {
  private readonly resolveLogs: AdmittedLogsResolver;
  private readonly scanLimit: number;

  constructor(opts: PeerLogLockEventReaderOpts) {
    this.resolveLogs = opts.resolveLogs;
    this.scanLimit = opts.scanLimit ?? 2000;
  }

  async readLockEvents(scope: string, _nowMs: number): Promise<LockEvent[]> {
    let logs: ReadableLog[];
    try {
      logs = await this.resolveLogs(scope);
    } catch {
      return [];
    }
    const events: LockEvent[] = [];
    for (const log of logs) {
      try {
        if (log.update) await log.update();
        const len = log.length;
        const start = Math.max(0, len - this.scanLimit);
        for (let i = start; i < len; i++) {
          const ev = peerLogOpToLockEvent(await log.get(i));
          if (ev && ev.scope === scope) events.push(ev);
        }
      } catch {
        // a bad/partial log contributes nothing; keep scanning the rest
      }
    }
    return events;
  }
}
