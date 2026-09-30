/**
 * cross-hive-transport — the signed wire layer for the cross-Hive boundary
 * (cross-hive-boundary-2026-06-08 P-003/P-004). Sits OVER the boundary logic
 * (cross-hive-boundary.ts admit+translate) and UNDER the federation transport.
 *
 *   send:    construct + Ed25519-sign an envelope addressed to a peer Hive (by pubkey),
 *            hand it to the transport; on failure it stays in the store-and-forward
 *            OUTBOX for retry (peer Hives go offline).
 *   receive: verify the sender Hive's signature against the claimed `fromHivePubkey`,
 *            then DISPATCH — a request (ask / work-request) goes through the boundary
 *            (load grants → admit → translate into B's substrate); a reply
 *            (answer / decline) is correlated back to the originating ask.
 *
 * The actual point-to-point hyperdht delivery is the federation layer
 * ([[shared-hive-federation-2026-06-08]], whose Hive-pubkey topic transport is
 * P-011-proven across machines); it is injected here as a `CrossHiveTransport` PORT, so
 * this whole layer is unit-testable in-process. Signing is also a PORT (`CrossHiveSigner`
 * = `signWithHiveKey` in production) since the private key is keychain-held.
 */
import { verifyEd25519 } from './identity/ed25519';
import {
  routeCrossHiveEnvelope,
  type CrossHiveEnvelope,
  type CrossHiveGrant,
  type CrossHiveBoundaryPorts,
  type CrossHiveRouteResult,
} from './cross-hive-boundary';

/** Request kinds carried inbound through the boundary (grant-gated). */
export type CrossHiveRequestKind = 'ask' | 'work-request';
/** Reply kinds flowing back to the originating Hive (correlated, not grant-gated). */
export type CrossHiveReplyKind = 'answer' | 'decline';
export type CrossHiveWireKind = CrossHiveRequestKind | CrossHiveReplyKind;

const REQUEST_KINDS: readonly CrossHiveWireKind[] = ['ask', 'work-request'];
export function isRequestKind(k: CrossHiveWireKind): k is CrossHiveRequestKind {
  return REQUEST_KINDS.includes(k);
}

/** The unsigned body of a directed Hive→Hive envelope. */
export interface CrossHiveEnvelopeBody {
  /** Stable envelope id (for outbox dedup + reply correlation). */
  id: string;
  fromHivePubkey: string;
  toHivePubkey: string;
  kind: CrossHiveWireKind;
  subject: string;
  body: string;
  /** For a reply: the `id` of the request it answers. */
  correlationId?: string;
}

/** A signed wire envelope (body + base64 Ed25519 sig by the sending Hive's key). */
export interface CrossHiveWireEnvelope extends CrossHiveEnvelopeBody {
  sig: string;
}

/**
 * Deterministic signing bytes — JSON of the body fields in a FIXED order (sig excluded),
 * mirroring hiveAnnounceSigningBytes. Optional fields are included only when present so
 * the bytes are stable across versions. Sender + receiver must produce identical bytes.
 */
export function crossHiveSigningBytes(body: CrossHiveEnvelopeBody): Buffer {
  const ordered: Record<string, unknown> = {
    id: body.id,
    fromHivePubkey: body.fromHivePubkey,
    toHivePubkey: body.toHivePubkey,
    kind: body.kind,
    subject: body.subject,
    body: body.body,
  };
  if (typeof body.correlationId === 'string') ordered.correlationId = body.correlationId;
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

/** Signs the canonical bytes. Production: `(b) => signWithHiveKey(ws, potSlug, b)`. */
export type CrossHiveSigner = (bytes: Buffer) => Promise<Buffer>;

/** Sign a body into a wire envelope. */
export async function signCrossHiveEnvelope(
  body: CrossHiveEnvelopeBody,
  signer: CrossHiveSigner,
): Promise<CrossHiveWireEnvelope> {
  const sig = await signer(crossHiveSigningBytes(body));
  return { ...body, sig: sig.toString('base64') };
}

/** Verify a wire envelope's signature against its claimed sending Hive pubkey. Never throws. */
export function verifyCrossHiveEnvelope(env: CrossHiveWireEnvelope): boolean {
  if (!env || typeof env.sig !== 'string' || env.sig.length === 0) return false;
  return verifyEd25519(crossHiveSigningBytes(env), env.fromHivePubkey, Buffer.from(env.sig, 'base64'));
}

/* ── Transport + store-and-forward ─────────────────────────────────────────────── */

/** The point-to-point delivery PORT (production: hyperdht dial-by-Hive-pubkey). */
export interface CrossHiveTransport {
  /** Deliver an envelope to the peer Hive. Rejects if the peer is unreachable. */
  send(toHivePubkey: string, env: CrossHiveWireEnvelope): Promise<void>;
  /** Register the inbound handler (the federation layer calls it per received envelope). */
  subscribe(handler: (env: CrossHiveWireEnvelope) => Promise<void>): void;
}

/** Store-and-forward outbox PORT — survives a peer being offline (production: a PG table). */
export interface CrossHiveOutbox {
  enqueue(env: CrossHiveWireEnvelope): Promise<void>;
  pending(): Promise<CrossHiveWireEnvelope[]>;
  markDelivered(id: string): Promise<void>;
}

/** A simple in-process outbox — the unit-test + single-process default. */
export class InMemoryCrossHiveOutbox implements CrossHiveOutbox {
  private readonly q = new Map<string, CrossHiveWireEnvelope>();
  async enqueue(env: CrossHiveWireEnvelope): Promise<void> {
    this.q.set(env.id, env);
  }
  async pending(): Promise<CrossHiveWireEnvelope[]> {
    return [...this.q.values()];
  }
  async markDelivered(id: string): Promise<void> {
    this.q.delete(id);
  }
}

export interface SendResult {
  delivered: boolean;
  /** Queued in the outbox for retry (peer unreachable). */
  queued: boolean;
}

/**
 * Send an envelope with store-and-forward: enqueue, attempt delivery, mark delivered on
 * success; on failure it stays queued for a later `flushCrossHiveOutbox`. Always durable
 * first (enqueue before send) so a crash mid-send never loses the message.
 */
export async function sendCrossHive(
  env: CrossHiveWireEnvelope,
  deps: { transport: CrossHiveTransport; outbox: CrossHiveOutbox },
): Promise<SendResult> {
  await deps.outbox.enqueue(env);
  try {
    await deps.transport.send(env.toHivePubkey, env);
    await deps.outbox.markDelivered(env.id);
    return { delivered: true, queued: false };
  } catch {
    return { delivered: false, queued: true };
  }
}

/** Retry every queued envelope. Returns how many delivered + how many remain pending. */
export async function flushCrossHiveOutbox(deps: {
  transport: CrossHiveTransport;
  outbox: CrossHiveOutbox;
}): Promise<{ delivered: number; pending: number }> {
  let delivered = 0;
  for (const env of await deps.outbox.pending()) {
    try {
      await deps.transport.send(env.toHivePubkey, env);
      await deps.outbox.markDelivered(env.id);
      delivered += 1;
    } catch {
      /* still unreachable — leave it queued */
    }
  }
  return { delivered, pending: (await deps.outbox.pending()).length };
}

/* ── Ask ledger (C-1) — the durable record of the ask lifecycle ───────────────── */

/** One `cross_hive_asks` row (hive-network-surface C-1, camelCase). The ASKING side's
 *  durable record of an outbound request and the reply that settled it. */
export interface CrossHiveAskRow {
  workspaceId: string;
  potSlug: string;
  id: string;
  peerPubkey: string;
  direction: 'out' | 'in';
  kind: CrossHiveRequestKind;
  subject: string;
  body: string;
  correlationId: string;
  state: 'queued' | 'sent' | 'answered' | 'declined' | 'expired';
  replyBody: string | null;
  replyTs: string | null;
  /** The ownerId that enqueued the ask (proposed C-1 amendment — populated by pot:ask
   *  when adopted; the receive side coord-notifies it on reply when present). */
  askedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RecordReplyResult =
  /** The row legally transitioned (queued|sent → answered|declined) — emit the C-4 event. */
  | { outcome: 'transitioned'; row: CrossHiveAskRow }
  /** Already answered/declined/expired — a dup delivery (the outbox redelivers); do NOT re-emit. */
  | { outcome: 'already-settled'; row: CrossHiveAskRow }
  /** No OUT row matches (correlation_id, peer_pubkey) — unsolicited/forged. NOTE: the
   *  production wiring emits the C-4 event ONLY on 'transitioned' (cross-hive-wiring
   *  persistAndEmitReply), so a not-found NEVER wakes the Queen — the old "synthetic
   *  payload" contract described here is retired (stale note fixed, P-024). */
  | { outcome: 'not-found' };

/** The receive side's ledger PORT (production: B-02's PG store over `cross_hive_asks`).
 *  `recordReply` persists an inbound answer/decline onto the originating OUT ask. */
export interface CrossHiveAskLedger {
  recordReply(input: {
    correlationId: string;
    replyKind: CrossHiveReplyKind;
    replyBody: string;
    /** The replying Hive — must match the asked peer (a third party cannot settle the ask). */
    peerPubkey: string;
  }): Promise<RecordReplyResult>;
}

/** A ledger that records nothing — the explicit "no ledger" choice for boundary
 *  compositions that don't track asks (tests, ephemeral deployments). Production
 *  defaults to the PG-backed ledger (cross-hive-wiring's pgCrossHiveAskLedger). */
export const NULL_CROSS_HIVE_ASK_LEDGER: CrossHiveAskLedger = {
  async recordReply() {
    return { outcome: 'not-found' };
  },
};

/** In-memory reference CrossHiveAskLedger with the C-1 legality guards — the
 *  unit-test + stub-first default (the InMemoryCrossHiveOutbox of the ask ledger). */
export class InMemoryCrossHiveAskLedger implements CrossHiveAskLedger {
  private readonly rows = new Map<string, CrossHiveAskRow>();

  /** Seed an outbound ask (state queued|sent) — what pot:ask's enqueue will do in PG. */
  seed(row: CrossHiveAskRow): void {
    this.rows.set(row.correlationId, row);
  }

  get(correlationId: string): CrossHiveAskRow | undefined {
    return this.rows.get(correlationId);
  }

  async recordReply(input: {
    correlationId: string;
    replyKind: CrossHiveReplyKind;
    replyBody: string;
    peerPubkey: string;
  }): Promise<RecordReplyResult> {
    const row = this.rows.get(input.correlationId);
    if (!row || row.direction !== 'out' || row.peerPubkey !== input.peerPubkey) {
      return { outcome: 'not-found' };
    }
    if (row.state !== 'queued' && row.state !== 'sent') {
      return { outcome: 'already-settled', row };
    }
    const now = new Date().toISOString();
    const updated: CrossHiveAskRow = {
      ...row,
      state: input.replyKind === 'answer' ? 'answered' : 'declined',
      replyBody: input.replyBody,
      replyTs: now,
      updatedAt: now,
    };
    this.rows.set(input.correlationId, updated);
    return { outcome: 'transitioned', row: updated };
  }
}

/* ── C-4 event keys ────────────────────────────────────────────────────────────── */

/**
 * The C-4 event key a reply fires (hive-network-surface C-4): the asking Queen
 * registers `events:await` on these right after sending (a decline unblocks as much
 * as an answer — await both). Consumers (pot:ask guidance) import these helpers
 * rather than re-templating the strings.
 */
export function crossHiveReplyEventKey(replyKind: CrossHiveReplyKind, correlationId: string): string {
  return replyKind === 'answer'
    ? `cross-hive:answered:${correlationId}`
    : `cross-hive:declined:${correlationId}`;
}

/* ── Receive ───────────────────────────────────────────────────────────────────── */

export type CrossHiveReceiveResult =
  | { ok: false; reason: string }
  | { kind: 'request'; route: CrossHiveRouteResult }
  | { kind: 'reply'; replyKind: CrossHiveReplyKind; correlationId: string | null; subject: string; body: string };

export interface ReceiveDeps {
  /** THIS Hive's pubkey — an envelope not addressed to us is rejected. */
  selfHivePubkey: string;
  /** Load this Hive's admission grants (production: `loadCrossHiveGrants(ws, potSlug)`). */
  loadGrants: () => Promise<readonly CrossHiveGrant[]>;
  /** Translate an admitted REQUEST into a B-side object (boundary ports). */
  requestPorts: CrossHiveBoundaryPorts;
  /**
   * P-013 rate-cap counter: requests admitted FROM this peer within the rolling
   * hour (production: the C-1 `in` ledger count). Called only for a VERIFIED
   * request envelope — a spoofer must not be able to consume a peer's quota.
   * Absent, or throwing, skips the rate check (fail-open on telemetry — the
   * grant allow-list itself never fails open).
   */
  countRecentFromPeer?: (peerPubkey: string) => Promise<number>;
  /** Clock for grant-expiry checks (P-013; default Date.now). */
  nowMs?: () => number;
}

/**
 * Handle one received wire envelope: verify the sender's signature, then dispatch. A
 * request (ask / work-request) goes through the boundary (admit via this Hive's grants →
 * translate). A reply (answer / decline) is surfaced for the originator to correlate to
 * its pending ask. A bad signature or an envelope not addressed to us is rejected before
 * any side effect.
 */
export async function receiveCrossHive(
  env: CrossHiveWireEnvelope,
  deps: ReceiveDeps,
): Promise<CrossHiveReceiveResult> {
  if (env.toHivePubkey !== deps.selfHivePubkey) {
    return { ok: false, reason: 'envelope not addressed to this Hive' };
  }
  if (!verifyCrossHiveEnvelope(env)) {
    return { ok: false, reason: 'signature verification failed' };
  }
  if (isRequestKind(env.kind)) {
    const grants = await deps.loadGrants();
    // P-013 rate-cap context — counted only AFTER signature verification (above)
    // so a forged sender can never consume a real peer's quota. A failing count
    // skips the rate check rather than inventing a zero.
    let recentFromPeerCount: number | undefined;
    if (deps.countRecentFromPeer) {
      try {
        recentFromPeerCount = await deps.countRecentFromPeer(env.fromHivePubkey);
      } catch {
        recentFromPeerCount = undefined;
      }
    }
    const request: CrossHiveEnvelope = {
      fromHivePubkey: env.fromHivePubkey,
      toHivePubkey: env.toHivePubkey,
      kind: env.kind,
      subject: env.subject,
      body: env.body,
      sig: env.sig,
    };
    const route = await routeCrossHiveEnvelope(
      request,
      {
        selfHivePubkey: deps.selfHivePubkey,
        grants,
        nowMs: (deps.nowMs ?? Date.now)(),
        ...(recentFromPeerCount != null ? { recentFromPeerCount } : {}),
      },
      deps.requestPorts,
    );
    return { kind: 'request', route };
  }
  return {
    kind: 'reply',
    replyKind: env.kind,
    correlationId: env.correlationId ?? null,
    subject: env.subject,
    body: env.body,
  };
}
