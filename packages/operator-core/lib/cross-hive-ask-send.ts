/**
 * cross-hive-ask-send — the front-door SEND composition behind `pot:ask` and
 * `pot:request_work` (hive-network-surface-2026-06-11 P-003, brief B-04).
 *
 * One initiating-side pipeline, shared by both tools (they differ only by
 * `kind`): outbound-grant check → resolve THIS Hive's live boundary → record the
 * ask in the C-1 ledger (`queued`) → sign + send the request envelope (durable
 * store-and-forward) → mark the ledger row `sent` on delivery. Insert-BEFORE-send
 * is deliberate: a crash between the ledger write and the wire send leaves a
 * `queued` row the outbox drain (B-01) can still deliver and mark sent — the
 * asking-side record is never lost.
 *
 * The returned `correlationId` is the join key the asking Queen awaits: a later
 * answer/decline from the peer comes back through the boot-wired boundary (B-03),
 * which transitions the ledger row and emits `cross-hive:answered:<correlationId>`
 * / `cross-hive:declined:<correlationId>` (contract C-4). So the Queen's loop is
 * send → `events:await` the answered key.
 *
 * Every collaborator is an injected PORT so this unit-tests without a swarm, PG,
 * or the grants store.
 */
import { randomUUID } from 'node:crypto';
import type { CrossHiveBoundaryWiring } from './cross-hive-wiring';
import { crossHiveReplyEventKey, type CrossHiveRequestKind } from './cross-hive-transport';
import type { CrossHiveAsksStore } from './cross-hive-asks-store-port';
import { trackDetached } from './detached-imports';

/**
 * Decide whether THIS Hive may send `kind` to `peerPubkey` (outbound grant — B-05;
 * P-013 adds `bodyBytes` so the grant's payload size cap is enforced pre-send).
 */
export type CheckOutboundGrant = (
  workspaceId: string,
  potSlug: string,
  peerPubkey: string,
  kind: CrossHiveRequestKind,
  bodyBytes?: number,
) => Promise<{ allowed: boolean; reason: string }>;

export interface SendCrossHiveAskDeps {
  /** Resolve this Hive's live, boot-wired boundary (the registry getter). */
  resolveBoundary: (
    workspaceId: string,
    potSlug: string,
  ) => CrossHiveBoundaryWiring | undefined | Promise<CrossHiveBoundaryWiring | undefined>;
  /** Outbound admission policy (B-05's assertOutboundGrant, adapted). */
  checkOutboundGrant: CheckOutboundGrant;
  /** The C-1 ledger store (B-02). */
  store: CrossHiveAsksStore;
  /** Correlation / envelope id generator (injected for deterministic tests). */
  newId?: () => string;
}

export interface SendCrossHiveAskInput {
  workspaceId: string;
  /** THIS (asking) Hive's home slug — grants, signer and boundary are scoped to it. */
  potSlug: string;
  /** The target peer Hive's pubkey (from `discovery:pots`). */
  peerPubkey: string;
  kind: CrossHiveRequestKind;
  subject: string;
  body: string;
  /** The coord ownerId of the initiating agent (hive-network-surface P-014 item 4).
   *  Stored on the C-1 row; the receive-side reply path fires the C-4 event with
   *  `to: [askedBy]` so a sleeping initiator is woken on the answer. Optional. */
  askedBy?: string;
}

export type SendCrossHiveAskResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      correlationId: string;
      kind: CrossHiveRequestKind;
      peerPubkey: string;
      /** `sent` = delivered now; `queued` = peer offline, durable outbox will retry. */
      state: 'sent' | 'queued';
      delivered: boolean;
      /** The event key to `events:await` for the peer's answer (contract C-4). */
      answeredEvent: string;
      /** The event key emitted if the peer declines (contract C-4). */
      declinedEvent: string;
    };

/**
 * Compose one outbound cross-Hive request. The signed envelope's id IS the
 * correlation id, so the peer's reply (whose `correlationId` echoes it)
 * correlates back to this ledger row.
 */
export async function sendCrossHiveAsk(
  input: SendCrossHiveAskInput,
  deps: SendCrossHiveAskDeps,
): Promise<SendCrossHiveAskResult> {
  const { workspaceId, potSlug, peerPubkey, kind, subject, body, askedBy } = input;

  // 1. Outbound admission: default-deny to peers this Hive hasn't been granted
  //    outbound (B-05), within the grant's P-013 quotas (expiry / size / rate —
  //    bodyBytes feeds the size cap). An over-quota or ungranted request is
  //    rejected before any side effect (no ledger row, no send).
  const grant = await deps.checkOutboundGrant(
    workspaceId,
    potSlug,
    peerPubkey,
    kind,
    Buffer.byteLength(body, 'utf8'),
  );
  if (!grant.allowed) {
    return { ok: false, reason: grant.reason };
  }

  // 2. Resolve the live boundary. A dark/unpublished/pre-boot Hive has none — we
  //    never construct a duplicate transport, so this is a hard, clear failure.
  const boundary = await deps.resolveBoundary(workspaceId, potSlug);
  if (!boundary) {
    return {
      ok: false,
      reason: `cross-Hive boundary for '${potSlug}' is not live — publish the Hive (only directory-published Hives wire a boundary) and ensure the operator has booted`,
    };
  }

  // 3. Record the outbound ask FIRST (durable, state `queued`) so the asking-side
  //    record survives a crash mid-send; the envelope id is the correlation id.
  const correlationId = (deps.newId ?? randomUUID)();
  await deps.store.insertQueued(workspaceId, potSlug, {
    peerPubkey,
    kind,
    correlationId,
    subject,
    body,
    direction: 'out',
    ...(askedBy ? { askedBy } : {}),
  });

  // 4. Sign + send (durable store-and-forward). On delivery, advance queued → sent.
  const sendResult = await boundary.send(peerPubkey, { id: correlationId, kind, subject, body });
  if (sendResult.delivered) {
    await deps.store.markSentByCorrelationId(workspaceId, potSlug, correlationId);
  }
  const state: 'sent' | 'queued' = sendResult.delivered ? 'sent' : 'queued';

  // Push the Network board's ask counts + the dossier ask log (lazy fire-and-
  // forget so this composition + its fake-deps tests never statically depend
  // on the SSE layer; a missing bus is a no-op).
  void trackDetached(import('./sync-sse'))
    .then((m) => {
      void m.notifySyncInvalidate('network.board').catch(() => {});
      void m.notifySyncInvalidate('network.hive.asks').catch(() => {});
      // P-009 (data-sync-push-completion): co-located with the other network.board
      // announce/ask/beacon push points so the directory browse + federation-status
      // panels also converge off their polls. Workspace-singleton, no-arg consumers.
      void m.notifySyncInvalidate('network.hiveDirectory').catch(() => {});
      void m.notifySyncInvalidate('network.federationStatus').catch(() => {});
    })
    .catch(() => {});

  return {
    ok: true,
    correlationId,
    kind,
    peerPubkey,
    state,
    delivered: sendResult.delivered,
    // C-4 keys via B-03's helper — single source of truth for the key format.
    answeredEvent: crossHiveReplyEventKey('answer', correlationId),
    declinedEvent: crossHiveReplyEventKey('decline', correlationId),
  };
}
