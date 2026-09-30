/**
 * wire-stats.ts — read the UDX wire counters off a Hyperswarm connection socket.
 *
 * Extracted from swarm.ts (which re-exports everything here, so its callers are
 * unchanged) so that LEAF consumers — topic-gossip.ts's severed-link liveness
 * predicate (P-203 / EI-22137294505377834) — can read a socket's inbound counters
 * without importing the whole swarm module graph (Corestore, pot-git serve/dial
 * wiring, resource profiles…). This file imports nothing.
 */

/**
 * EI-18682571591024156 — the UDX wire counters for one connection: the ONLY
 * evidence that the data path actually came up.
 *
 * The Noise handshake completes as a DHT RPC, so `secret-stream` attaches an
 * ALREADY-FINISHED session to a UDX stream that has carried ZERO bytes. A
 * connection that will send ~4.9KB, receive nothing, retransmit 10× and die on
 * RTO exhaustion 13s later is therefore indistinguishable at `connection` time
 * from one that works. `bytesReceived > 0` is what tells them apart.
 *
 * Same explicit-presence rule as swarm.ts's `PeerConnectionPath`: a
 * `bytesReceived: 0` synthesised for an unreadable stream would read as
 * "measured zero" — the exact confusion that makes this bug class expensive.
 */
export interface PeerWireStats {
  /** True only when the underlying raw stream exposed real counters. */
  present: boolean;
  bytesReceived?: number;
  bytesTransmitted?: number;
  packetsReceived?: number;
  rtoCount?: number;
  retransmits?: number;
}

/**
 * Read the UDX wire counters off a connection socket's raw stream (see
 * {@link PeerWireStats}). Never throws; `{ present: false }` when unreadable.
 */
export function readWireStats(socket: unknown): PeerWireStats {
  const raw = (socket as { rawStream?: Record<string, unknown> } | null | undefined)?.rawStream;
  if (!raw || typeof raw !== 'object') return { present: false };
  // Explicit per-field reads (no dynamic key write): a finite number is a real
  // reading and flips `present`; anything else stays ABSENT rather than 0.
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const bytesReceived = num(raw.bytesReceived);
  const bytesTransmitted = num(raw.bytesTransmitted);
  const packetsReceived = num(raw.packetsReceived);
  const rtoCount = num(raw.rtoCount);
  const retransmits = num(raw.retransmits);
  const present =
    bytesReceived !== undefined ||
    bytesTransmitted !== undefined ||
    packetsReceived !== undefined ||
    rtoCount !== undefined ||
    retransmits !== undefined;
  const out: PeerWireStats = { present };
  if (bytesReceived !== undefined) out.bytesReceived = bytesReceived;
  if (bytesTransmitted !== undefined) out.bytesTransmitted = bytesTransmitted;
  if (packetsReceived !== undefined) out.packetsReceived = packetsReceived;
  if (rtoCount !== undefined) out.rtoCount = rtoCount;
  if (retransmits !== undefined) out.retransmits = retransmits;
  return out;
}

/**
 * EI-18682571591024156 — has this connection DEMONSTRATED a working data path?
 *
 * `true` only on positive evidence (bytes actually received from the peer);
 * `false` on positive evidence of the opposite (readable counters, zero bytes
 * received); `null` when unknowable. Three states on purpose: collapsing
 * "unknown" into `false` would alarm on every test fake, and collapsing it into
 * `true` would re-create the overclaiming signal this fixes.
 */
export function dataPathProven(stats: PeerWireStats): boolean | null {
  if (!stats.present || stats.bytesReceived === undefined) return null;
  return stats.bytesReceived > 0;
}

/**
 * P-203 / EI-22137294505377834: the severed-link escalations' SOCKET LIVENESS
 * window (topic-gossip.ts AND swarm.ts). A peer socket that showed INBOUND
 * activity within this many ms — its UDX `bytesReceived` advanced between two
 * refresh ticks, or the caller noted activity (a gossip frame, a remote
 * pairing) — is SPARED by an escalation; only a socket with NO inbound evidence
 * for the whole window (a true zombie) is destroyed.
 *
 * `dataPathProven` above cannot serve this purpose: it reads a CUMULATIVE
 * counter, so it is `true` for every socket that ever completed a handshake,
 * a zombie included (WI-6324: br=988 pr=3 → "proven"). The escalating ladders
 * therefore evicted UNCONDITIONALLY (EI-13317/WI-5481), which destroyed a LIVE
 * socket whenever a peer merely stopped serving one topic — measured on the
 * two-machine rig 2026-09-02: the VM's topic-gossip killed its only tower
 * socket every 300s for two hive-directory topics the tower no longer gossips,
 * and the tower's swarm.ts escalation killed a socket at br=783878 pr=6667
 * ("role=escalating considered=1 evicted=1") for the pot topic that socket had
 * just lost. A RECENT DELTA is the honest signal: hyperdht keeps every live
 * connection alive with a 5s keepalive (`connectionKeepAlive: 5000`), so a
 * socket with no inbound bytes for two minutes is dead, and a dead socket
 * cannot fake a delta — the WI-5481 deadlock stays broken.
 *
 * Callers use `min(this, severedEscalationMs)`; `0` disables the predicate.
 */
export const DEFAULT_SOCKET_LIVENESS_WINDOW_MS = 120_000;

interface InboundRow {
  /** Last sampled UDX `bytesReceived` (undefined = no counter exposed). */
  lastBytesReceived: number | undefined;
  /** Last time inbound activity was OBSERVED; null = none observed yet. */
  lastInboundMs: number | null;
  /** True once at least one wire sample has been compared against the
   *  baseline taken at `track()` — before that there is no evidence either way. */
  sampled: boolean;
}

/**
 * Per-socket INBOUND-activity ledger behind the liveness predicate. One
 * instance per gossip/join instance; keyed weakly so a socket that closes
 * without `forget()` cannot leak.
 */
export class SocketInboundLedger {
  private readonly rows = new WeakMap<object, InboundRow>();

  /**
   * Start tracking `socket`, taking the wire-counter baseline now. With
   * `grace`, registration itself counts as inbound activity (a socket younger
   * than the window is then spared — it may be the very reconnect an
   * escalation is trying to provoke); without it the socket has no evidence
   * until its counter advances or `note()` is called.
   */
  track(socket: unknown, now: number, grace = false): void {
    if (!socket || typeof socket !== 'object') return;
    const existing = this.rows.get(socket);
    if (existing) {
      if (grace) existing.lastInboundMs = Math.max(existing.lastInboundMs ?? now, now);
      return;
    }
    this.rows.set(socket, {
      lastBytesReceived: readWireStats(socket).bytesReceived,
      lastInboundMs: grace ? now : null,
      sampled: false,
    });
  }

  /** Record OBSERVED inbound activity on `socket` (a frame, a remote pairing). */
  note(socket: unknown, now: number): void {
    if (!socket || typeof socket !== 'object') return;
    const row = this.rows.get(socket);
    if (!row) {
      this.track(socket, now, true);
      return;
    }
    row.lastInboundMs = Math.max(row.lastInboundMs ?? now, now);
  }

  /** One refresh tick's wire sample: a `bytesReceived` that advanced since the
   *  previous sample is inbound activity. One property read per socket. */
  sample(sockets: Iterable<unknown>, now: number): void {
    for (const socket of sockets) {
      if (!socket || typeof socket !== 'object') continue;
      const row = this.rows.get(socket);
      if (!row) continue;
      const bytesReceived = readWireStats(socket).bytesReceived;
      if (bytesReceived === undefined) continue;
      if (row.lastBytesReceived !== undefined && bytesReceived > row.lastBytesReceived) {
        row.lastInboundMs = now;
      }
      row.lastBytesReceived = bytesReceived;
      row.sampled = true;
    }
  }

  forget(socket: unknown): void {
    if (socket && typeof socket === 'object') this.rows.delete(socket);
  }

  /**
   * `true` = inbound activity observed within `windowMs`; `false` = tracked
   * and sampled, nothing within the window (a zombie); `null` = no evidence
   * either way (untracked, or tracked but never sampled or noted).
   * `windowMs <= 0` disables the predicate (always `false`).
   */
  recentlyLive(socket: unknown, now: number, windowMs: number): boolean | null {
    if (windowMs <= 0) return false;
    if (!socket || typeof socket !== 'object') return null;
    const row = this.rows.get(socket);
    if (!row) return null;
    if (row.lastInboundMs !== null && now - row.lastInboundMs < windowMs) return true;
    if (row.lastInboundMs === null && !row.sampled) return null;
    return false;
  }
}
