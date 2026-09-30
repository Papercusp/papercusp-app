/**
 * Hyperbee → PG projection for `harness_shared.coord_event_log` (the coordination
 * message rail).
 *
 * Plan: distributed-coordination-shared-harness-2026-06-04 (Track A, surface #1).
 * A HARNESS-SCOPED original coord_event_log row (surface messages|handoffs|
 * escalations, harness_slug set, NOT a fan-out delivery copy) federates over the
 * harness's peer-log. The per-harness Hyperbee key is the globally-unique
 * `msg_id`. On the remote machine the row lands in coord_event_log and the
 * recipient's coord:inbox read finds it by the envelope `to[]` — no separate
 * fan-out (fan-out delivery copies are local per-machine state, D-002, and are
 * excluded by the capture trigger's notify_kind filter).
 *
 * Federated fields = the row's CONTENT: surface, writer_key, the `body` envelope
 * (jsonb), the timestamp, harness_slug. NOT federated (machine-local): the
 * bigserial `id` (a fresh local id is assigned on apply) and `workspace_id` (the
 * local projection's bound workspace).
 *
 * `ts` is wired as epoch-ms (the op-key reshape converts the to_jsonb ISO string)
 * and written back via to_timestamp.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import {
  projectionAfterCommit,
  projectionFlush,
  projectionSql,
  type TableProjection,
  type ProvenanceContext,
} from '../projection';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';
import {
  tryConsumeFederatedWake,
  federatedWakeAllowance,
  recordFederatedWakeSpend,
} from '../federated-wake-rate';
import { resolveAuthorCommsTier } from '../comms-tier-gate';
import { quarantineCoordMessage, type QuarantineReason } from '../coord-quarantine-store';
import { tryConsumeMemberMessageRate } from '../member-rate-gate';
import { commsTierAtLeast, FALLBACK_COMMS_TIER, type CommsTier } from '../../../trust/comms-trust';
import { readExpectedLifecycleAck } from '../../../agent-tools/coordination/cue-authority';
import { readRelayProvenance } from '../../../agent-tools/coordination/relay-provenance';

/** The coord_event_log surfaces that federate (plan-events stay local — plans
 *  federate via harness_plans). */
const FEDERATED_SURFACES = new Set(['messages', 'handoffs', 'escalations']);

/** Wire-shape of a federated coord_event_log row. */
export interface CoordMessageRow {
  harness_slug: string;
  msg_id: string;
  surface: string;                  // 'messages' | 'handoffs' | 'escalations'
  writer_key: string | null;
  body: Record<string, unknown>;    // the CoordEnvelope
  ts: number;                       // epoch ms
  /** The CORRECTION that supersedes this message (EI-21467654382027859).
   *
   *  Without it a message corrected on one machine reads as CURRENT on every
   *  other — a peer acts on the original with no sign a correction exists,
   *  which is the exact failure the correction was sent to prevent.
   *
   *  OPTIONAL on the wire, deliberately: a peer running older code omits the
   *  key, and decodeValue DISCARDS a row the validator rejects, so a required
   *  field would drop that peer's messages entirely. Absent === not superseded. */
  superseded_by_msg_id?: string | null;
  /** epoch ms | null — when it was superseded. Optional, as above. */
  superseded_at?: number | null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isCoordMessageRow(input: unknown): input is CoordMessageRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.msg_id) || r.msg_id.length === 0) return false;
  if (!isString(r.surface) || !FEDERATED_SURFACES.has(r.surface)) return false;
  if (!isStringOrNull(r.writer_key)) return false;
  if (!r.body || typeof r.body !== 'object' || Array.isArray(r.body)) return false;
  // A fan-out delivery copy must never federate — defensive double of the
  // capture trigger's notify_kind filter.
  if ((r.body as Record<string, unknown>).notify_kind != null) return false;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return false;
  // `undefined` accepted on purpose — an older peer omits these keys entirely,
  // and rejecting that would drop the whole message. Loosened for ABSENT, not
  // for a wrong type.
  if (!(r.superseded_by_msg_id === undefined || isStringOrNull(r.superseded_by_msg_id))) return false;
  if (
    !(
      r.superseded_at === undefined ||
      r.superseded_at === null ||
      (typeof r.superseded_at === 'number' && Number.isFinite(r.superseded_at))
    )
  ) {
    return false;
  }
  return true;
}

function decodeValue(raw: unknown): CoordMessageRow | null {
  return isCoordMessageRow(raw) ? raw : null;
}

export interface CoordMessageProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of the global getOrgPg().sql. */
  sql?: postgres.Sql;
  /** WI-259 parity (shared-hive comms federation): hive-home slug when this harness is a hive
   *  MEMBER — a cross-member coord op is membership-gated only when set. */
  potHomeSlug?: string;
  /** WI-259 parity: resolve an op's VERIFIED source-log device pubkey from sourceLogKeyHex. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** WI-259 P-004 parity: content-before-membership defer buffer. */
  pendingMemberContent?: PendingMembershipContent;
  /** P-013 test seam: resolve the author DEVICE's effective comms tier.
   *  Default binds comms-tier-gate (hive_members attestations → comms-trust).
   *  Only consulted when potHomeSlug is set (hive-bound projections). */
  resolveCommsTier?: (
    devicePubkey: string | null,
  ) => Promise<{ tier: CommsTier; githubUserId: number | null }>;
  /** P-015 test seam: spend one message-op from the member's policy-rate
   *  budget. Default binds member-rate-gate (hive_policy.rate). */
  consumeMessageRate?: (devicePubkey: string | null) => Promise<boolean>;
}

function composeKey(row: CoordMessageRow): string {
  return row.msg_id;
}

/**
 * WI-3914 (write-side twin of WI-3912's read-side backstop): `isCoordMessageRow`
 * validates the WIRE-LEVEL `msg_id`/`ts` (which become the row's own COLUMNS,
 * always present by construction) but never validated that the nested `body`
 * (the CoordEnvelope itself) independently carries its OWN `ts`/`msg_id` keys —
 * a peer can wire-validly send a `body` missing them (observed live: a
 * deliberate P-059 test probe, coord_event_log id 458510, did exactly this) and
 * it federates straight into storage. Every CoordEnvelope reader downstream
 * (feed.ts's compareByTsThenId) assumes those keys always exist. Normalize HERE,
 * at the write boundary — using the SAME already-validated wire fields the
 * column itself is stamped from — so a malformed remote envelope can no longer
 * reach storage at all (closes the class ahead of WI-3912's read-side backstop,
 * which stays as defense-in-depth for any row written before this landed).
 * Never overrides a value the body already carries.
 */
function normalizeBodyTsMsgId(row: CoordMessageRow): Record<string, unknown> {
  const hasTs = typeof row.body?.ts === 'string' && row.body.ts.length > 0;
  const hasMsgId = typeof row.body?.msg_id === 'string' && row.body.msg_id.length > 0;
  if (hasTs && hasMsgId) return row.body;
  return {
    ...row.body,
    ts: hasTs ? row.body.ts : new Date(row.ts).toISOString(),
    msg_id: hasMsgId ? row.body.msg_id : row.msg_id,
  };
}

async function writeToPg(
  opts: CoordMessageProjectionOpts,
  row: CoordMessageRow,
  provenance: ProvenanceContext,
): Promise<void> {
  // WI-259 parity (shared-hive comms federation): own-slug applies; a CROSS-member message/handoff/
  // escalation applies iff its VERIFIED source-log device ∈ the hive's CURRENT members (the bare slug
  // early-return previously dropped every peer member's message — the highest-value coord surface).
  // It lands under its AUTHORED slug (the INSERT keys on row.harness_slug).
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  // ── P-013 (cross-machine-coord-parity-and-trust-2026-07-01): the COMMS-TIER
  // gate, receiver-side, hive-bound only. Resolve the VERIFIED author device's
  // effective tier (attestation chain → comms-trust: local override → signed
  // policy default → conservative fallback). BELOW 'message' ⇒ the row never
  // applies — QUARANTINED (visible + grantable), not dropped. A handoff below
  // 'steer' likewise. 'steer' passthrough when the projection isn't hive-bound
  // or the op is local — today's behavior, byte-identical.
  let authorTier: CommsTier = 'steer';
  let authorUserId: number | null = null;
  if (provenance.origin === 'remote' && opts.potHomeSlug) {
    const resolveTier =
      opts.resolveCommsTier ??
      (async (device: string | null) =>
        device
          ? resolveAuthorCommsTier({
              workspaceId: opts.workspaceId,
              potHomeSlug: opts.potHomeSlug!,
              devicePubkey: device,
            })
          : { tier: FALLBACK_COMMS_TIER, githubUserId: null });
    try {
      const gate = await resolveTier(sourceLogDevice);
      authorTier = gate.tier;
      authorUserId = gate.githubUserId;
    } catch {
      authorTier = FALLBACK_COMMS_TIER;
    }
    // M4 (audit D-013): CONTROL-PLANE rows — a federated event or a delivery
    // receipt (both ride `body.fed_event`, addressed to no member) — are NOT
    // member content, so they bypass the content quarantine. Their actual effect
    // (re-firing an await key) is separately tier-gated at the fed_event re-fire
    // below (`commsTierAtLeast(authorTier,'wake')`), so exempting the ROW just
    // lets a no-recipient control row persist — it can wake nothing on its own.
    // Without this, a receipt/event from a peer trusted below `message` was
    // quarantined here and the honesty loop silently broke (observe-tier peers).
    const isControlPlaneRow = (row.body as { fed_event?: unknown }).fed_event != null;
    let quarantineReason: QuarantineReason | null = isControlPlaneRow
      ? null
      : !commsTierAtLeast(authorTier, 'message')
        ? 'below-message-tier'
        : row.surface === 'handoffs' && !commsTierAtLeast(authorTier, 'steer')
          ? 'handoff-below-steer'
          : null;
    // P-015: the owner-signed policy.rate caps — the ATTENTION surface only
    // (coord messages); over-rate quarantines (never a silent drop). Checked
    // after the tier gate so a below-tier author doesn't also spend rate.
    if (quarantineReason === null) {
      try {
        const consumeRate =
          opts.consumeMessageRate ??
          (async (device: string | null) =>
            device
              ? tryConsumeMemberMessageRate({
                  workspaceId: opts.workspaceId,
                  potHomeSlug: opts.potHomeSlug!,
                  devicePubkey: device,
                })
              : true);
        if (!(await consumeRate(sourceLogDevice))) quarantineReason = 'rate-exceeded';
      } catch {
        /* fail-open: rate is throttling, not the allow-list */
      }
    }
    if (quarantineReason) {
      // P-537: this path writes on other connections (the quarantine row, a receipt row in
      // coord_event_log). Commit the merge's open batch first, so neither can wait on a row
      // lock the batch holds while the batch waits on this op. Rare: remote, hive-bound and
      // below tier or over rate.
      await projectionFlush();
      try {
        await quarantineCoordMessage(
          {
            workspaceId: opts.workspaceId,
            msgId: row.msg_id,
            harnessSlug: row.harness_slug,
            surface: row.surface,
            body: row.body,
            authorGithubUserId: authorUserId,
            authorDevicePubkey: sourceLogDevice ?? '',
            reason: quarantineReason,
            msgTs: row.ts,
          },
          opts.sql,
        );
      } catch (e) {
         
        console.warn(
          `[coord-message] quarantine write failed for ${row.msg_id} (message NOT applied either way):`,
          e instanceof Error ? e.message : String(e),
        );
      }
      // P-014: a receipt-requesting sender learns the truth — quarantined, not
      // delivered — via the same fed-event receipt rail.
      // M5b (audit D-013): budget-bound this emit. An admitted-but-untrusted
      // (below-message-tier) or over-rate member could otherwise flood
      // receipt-requesting directed messages and make us author one federated
      // receipt row per message. Spend one token from the SAME per-author-device
      // federated-wake budget as the apply-path fans (never a second limiter);
      // over budget ⇒ suppress the receipt emit (the quarantine itself already
      // landed above, so nothing is lost but the courtesy receipt, and the sender
      // learns the truth for the first budget-worth this window). Author key is
      // the verified source-log identity (provenance.authorPubkey), matching the
      // apply-path fans — never the spoofable body.from.
      const qb = row.body as { receipt?: unknown };
      // WI-7043: a courtesy receipt is AMBIENT — it must never spend the reserve
      // that keeps directed addressee wakes deliverable.
      if (
        qb.receipt === true &&
        tryConsumeFederatedWake(provenance?.authorPubkey ?? 'unknown', 1, Date.now(), 'ambient')
      ) {
        try {
          const { sendMessage } = await import('../../../agent-tools/coordination/messages');
          const { machineFingerprint } = await import('../../../identity/device-keychain-id');
          await sendMessage(
            {
              ownerId: 'fed-receipt',
              ownerLabel: 'fed-receipt',
              source: 'system',
              workspaceId: opts.workspaceId,
              userId: null,
            } as never,
            {
              msgId: `coord:receipt:${row.msg_id}`,
              to: [],
              summary: `[receipt] ${row.msg_id}`,
              harnessSlug: row.harness_slug,
              extra: {
                fed_event: {
                  key: `coord:receipt:${row.msg_id}`,
                  payload: {
                    msg_id: row.msg_id,
                    delivered: false,
                    quarantined: true,
                    reason: quarantineReason,
                    machine: machineFingerprint(),
                  },
                  source: 'fed-receipt',
                },
              },
            },
          );
        } catch {
          /* best-effort */
        }
      }
      return; // below tier — never applies
    }
  }

  const memberDecision = await decideMemberContentOp(row.harness_slug, opts, sourceLogDevice);
  if (memberDecision !== 'apply') {
    if (memberDecision === 'defer' && sourceLogDevice && opts.pendingMemberContent) {
      opts.pendingMemberContent.defer(
        {
          authorDevice: sourceLogDevice,
          tableTag: 'coord-messages',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => writeToPg(opts, row, provenance),
        },
        Date.now(),
      );
    }
    if (memberDecision === 'drop' && !sourceLogDevice && provenance?.authorPubkey && opts.pendingMemberContent) {
      opts.pendingMemberContent.deferUnresolvedSourceLog(
        {
          sourceLogKey: provenance.authorPubkey,
          tableTag: 'coord-messages',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => writeToPg(opts, row, provenance),
        },
        Date.now(),
      );
    }
    return;
  }
  const target = opts.sql ?? getOrgPg().sql;
  // P-537: the apply statement runs on the merge's batch transaction when there is one.
  const sql = await projectionSql(target);
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? row.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  // WI-3914: see normalizeBodyTsMsgId's doc-comment.
  const body = normalizeBodyTsMsgId(row);
  // workspace_id is the LOCAL projection's bound workspace; id is a fresh local
  // bigserial. ON CONFLICT targets the partial fed unique index (ws, msg_id)
  // over the federated subset — msg_id is globally unique so this updates the one
  // existing row (never violating the separate event_uq).
  const applied = await sql<{ inserted: boolean }[]>`
    INSERT INTO harness_shared.coord_event_log
      (workspace_id, surface, writer_key, msg_id, body, harness_slug,
       ts, superseded_by_msg_id, superseded_at, origin, author_pubkey, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.surface}, ${row.writer_key}, ${row.msg_id},
       ${JSON.stringify(body)}::text::jsonb, ${row.harness_slug},
       to_timestamp(${row.ts} / 1000.0),
       ${row.superseded_by_msg_id ?? null},
       ${row.superseded_at == null ? null : sql`to_timestamp(${row.superseded_at} / 1000.0)`},
       ${origin}, ${authorPubkey}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, msg_id)
      WHERE harness_slug IS NOT NULL AND (body->>'notify_kind') IS NULL
    DO UPDATE SET
      surface       = EXCLUDED.surface,
      writer_key    = EXCLUDED.writer_key,
      body          = EXCLUDED.body,
      ts            = EXCLUDED.ts,
      -- COALESCE, matching markSuperseded's OWN first-wins rule (messages.ts:1419,
      -- WHERE superseded_by_msg_id IS NULL -- idempotent and race-safe, and the
      -- marker is never cleared once set). So the local value must survive a peer
      -- that omits the key or has not seen the correction yet: taking EXCLUDED
      -- blindly would UN-correct an already-corrected message, telling readers the
      -- original is current again. Deliberately NOT the state-gated CASE used for
      -- coord_conversations.superseded_by, which legitimately clears; this one does not.
      superseded_by_msg_id = COALESCE(EXCLUDED.superseded_by_msg_id, coord_event_log.superseded_by_msg_id),
      superseded_at        = COALESCE(EXCLUDED.superseded_at, coord_event_log.superseded_at),
      origin        = EXCLUDED.origin,
      author_pubkey = EXCLUDED.author_pubkey,
      fed_ts        = EXCLUDED.fed_ts,
      fed_hlc       = EXCLUDED.fed_hlc
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    -- WI-2933 (extends mig 504 fed_apply_wins): the bare ">=" applied unconditionally
    -- on an EXACT clock tie, so two cells applying ops for the SAME msg_id in the
    -- same tick could symmetrically swap which body/surface won (composition-chaos
    -- P-002 class) -- unlikely given msg_id is generated globally-unique per send,
    -- but the guard should still converge deterministically rather than assume it
    -- never happens. fed_apply_wins breaks the tie by writer pubkey when both sides
    -- carry one and differ, else by the SYMMETRIC content digest.
    WHERE harness_shared.fed_apply_wins(
            EXCLUDED.fed_hlc, EXCLUDED.fed_ts, EXCLUDED.author_pubkey,
            md5(concat_ws('|', EXCLUDED.surface, EXCLUDED.writer_key, EXCLUDED.body::text, EXCLUDED.ts::text)),
            coord_event_log.fed_hlc, coord_event_log.fed_ts, coord_event_log.author_pubkey,
            md5(concat_ws('|', coord_event_log.surface, coord_event_log.writer_key,
                          coord_event_log.body::text, coord_event_log.ts::text)))
    -- xmax = 0 ⇔ this statement INSERTED a brand-new row (an ON CONFLICT
    -- update or LWW-rejected no-op returns inserted=false / no row) — the
    -- exactly-once gate for the EI-279 wake fan below.
    RETURNING (xmax = 0) AS inserted
  `;

  // ── EI-279: cross-instance deliver-and-wake ── coord:send {wake:true} fires
  // the recipients' inbox-wake keys on the SENDER's instance only; an agent
  // homed HERE slept through messages that arrived via federation. When a
  // REMOTE-origin row carrying the persisted wake intent (body.wake, set by
  // coord:send / coord:message-agent) lands as a FRESH insert, run the same
  // targeted fan locally:
  //   - origin gate: local sends already fanned at send time (and skipOwnOps
  //     keeps own-log replays out of here entirely);
  //   - fresh-INSERT gate: at-least-once re-applies / post-cursor-reset
  //     replays UPDATE the existing row → never re-wake (once per msg_id);
  //   - locality needs no map: a recipient homed elsewhere has no standing
  //     watch in THIS instance's await store, so its emit is a woken:0 no-op;
  //   - wakeRecipients brings the wake-mode (hive Pause) gate + '*'/'human'
  //     filtering for free.
  // Best-effort: a wake-fan failure must never fail the projection apply.
  if (origin !== 'remote' || applied.length === 0 || applied[0].inserted !== true) return;
  // P-537: inside the merge's batch the row stays invisible to other connections until
  // COMMIT, and every effect below makes a reader look for it (a woken agent, a re-fired
  // await, the sender's receipt). So they run once it is committed, on the plain handle.
  await projectionAfterCommit(async () => {
    const b = row.body as {
      wake?: unknown;
      to?: unknown;
      summary?: unknown;
      from?: unknown;
      related_msg_id?: unknown;
      fed_event?: unknown;
      receipt?: unknown;
    };
    const to = Array.isArray(b.to) ? b.to.filter((x): x is string => typeof x === 'string') : [];
    // P-008: the receipt (emitted below) reports whether the wake fan actually
    // re-invoked anyone here — woken stays null when the fan didn't run.
    let fanWoken: number | null = null;
    // WI-7043 fix #3: distinguish "the directed fan was never attempted" (wake
    // not requested, empty `to`, or below the wake comms-tier — none of which
    // is this machine's fault and none of which the sender should read as
    // absence) from "the fan WAS eligible to run and this machine's own
    // per-author budget suppressed it". Only the latter gets an honest
    // `suppressed:'rate-limit'` receipt below — everything else keeps M5a's
    // silence-means-not-applicable contract unchanged.
    let fanSuppressedByRate = false;
    // P-003: both fans below spend from the author DEVICE's hourly wake budget
    // (provenance authorPubkey — the verified source-log identity, never the
    // spoofable body.from). Over budget ⇒ the wake is suppressed but the message
    // is already applied — delivery is never dropped, only the re-invoke. The
    // addressee fan costs one token per addressee (each is a billable turn).
    const directedFanEligible = b.wake === true && to.length > 0 && commsTierAtLeast(authorTier, 'wake');
    if (
      directedFanEligible &&
      // WI-7043: DIRECTED — may draw on the whole cap, including the reserve that
      // ambient fed_event/receipt traffic is held out of.
      tryConsumeFederatedWake(authorPubkey ?? 'unknown', to.length, Date.now(), 'directed')
    ) {
      try {
        const { wakeRecipients } = await import('../../../agent-tools/coordination/inbox-wake');
        const relayProvenance = readRelayProvenance(row.body);
        const fan = await wakeRecipients(to, {
          ...(typeof b.summary === 'string' ? { summary: b.summary } : {}),
          ...(typeof b.from === 'string' ? { source: b.from } : {}),
          ...(relayProvenance ? { relayProvenance } : {}),
          workspaceId: opts.workspaceId,
        });
        fanWoken = typeof (fan as { woken?: unknown })?.woken === 'number' ? (fan as { woken: number }).woken : 0;
      } catch (e) {

        console.warn(
          `[coord-message] federated wake fan failed for ${row.msg_id} (message persisted; recipient sees it next turn):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    } else if (directedFanEligible) {
      // WI-7043 fix #3: the fan WAS eligible (wake requested, real addressees,
      // author cleared comms tier) but this machine's own per-author budget
      // suppressed it — as opposed to not being attempted at all. Record that so
      // a `receipt:true` sender gets an honest "suppressed by rate" answer below
      // instead of the silence that previously read identically to
      // recipient_absent (the exact false-negative this WI measured).
      fanSuppressedByRate = true;
    }

    // ── P-002 (cross-machine-coord-parity-and-trust-2026-07-01): the wake-on-reply
    // DUAL of the EI-279 fan. The sender-side reply-wake (tools/send.ts) fires on the
    // REPLIER's instance only — the original sender homed HERE slept through replies
    // that arrived via federation. When a fresh remote reply (body.related_msg_id)
    // lands, look the ORIGINAL up locally; if it persisted the wakeOnReply opt-in,
    // fire the original sender's inbox-wake key. Same gates as EI-279 (remote origin,
    // fresh insert = once per msg_id); never self-wakes (replier == original sender);
    // flag-gated to match the send side (COORD_WAKE_ON_REPLY, fail-safe ON). The
    // lookup uses the projection's OWN sql/workspace binding, not the coord seam —
    // this instance's coord_event_log is where the federated original landed.
    if (typeof b.related_msg_id === 'string' && b.related_msg_id.length > 0 && commsTierAtLeast(authorTier, 'wake')) {
      try {
        const { getFlag } = await import('@papercusp/flags/server');
        const { FLAGS } = await import('@papercusp/flags');
        const wakeOnReplyOn = await getFlag(FLAGS.COORD_WAKE_ON_REPLY, 'system').catch(() => true);
        if (wakeOnReplyOn) {
          const orig = await target<{ body: Record<string, unknown> }[]>`
            SELECT body FROM harness_shared.coord_event_log
            WHERE workspace_id = ${opts.workspaceId}
              AND msg_id = ${b.related_msg_id}
              AND (body->>'notify_kind') IS NULL
            ORDER BY id
            LIMIT 1
          `;
          const ob = orig[0]?.body as {
            wakeOnReply?: unknown;
            from?: unknown;
            expectedLifecycleAck?: unknown;
          } | undefined;
          const originalFrom = typeof ob?.from === 'string' ? ob.from : null;
          const expectedLifecycleAck = readExpectedLifecycleAck(ob ?? null);
          if (
            ob?.wakeOnReply === true &&
            originalFrom &&
            originalFrom !== b.from &&
            !expectedLifecycleAck &&
            // P-003: the reply-wake spends one token from the same author budget.
            // WI-7043: DIRECTED — it re-invokes a specific named local agent.
            tryConsumeFederatedWake(authorPubkey ?? 'unknown', 1, Date.now(), 'directed')
          ) {
            const { wakeRecipients } = await import('../../../agent-tools/coordination/inbox-wake');
            await wakeRecipients([originalFrom], {
              ...(typeof b.summary === 'string' ? { summary: b.summary } : {}),
              ...(typeof b.from === 'string' ? { source: b.from } : {}),
              workspaceId: opts.workspaceId,
            });
          }
        }
      } catch (e) {
         
        console.warn(
          `[coord-message] federated reply-wake failed for ${row.msg_id} (reply persisted; original sender sees it next turn):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    // ── P-009 (cross-machine-coord-parity-and-trust-2026-07-01): federated
    // EVENT keys. A no-recipient hive-scoped row carrying body.fed_event is an
    // events:emit { scope:'hive' } — re-fire the key into THIS machine's await
    // store so a remote peer's events:await wakes (rendezvous beyond
    // inbox-wake: lock grants, artifact-ready, staging-advanced). Targeted by
    // construction: emitAwaitedEvent fires only registered watchers (no
    // watchers = no-op), and the P-003 per-author budget bounds the spend an
    // admitted peer can trigger. Exactly-once via the same fresh-insert gate.
    const fe = b.fed_event as { key?: unknown; payload?: unknown; summary?: unknown; source?: unknown } | undefined;
    if (fe && typeof fe.key === 'string' && fe.key.length > 0 && commsTierAtLeast(authorTier, 'wake')) {
      try {
        // WI-7043: bill what this re-fire ACTUALLY woke, not the attempt. Most
        // federated events match no local watcher (`emitAwaitedEvent` fires only
        // registered awaits — no watchers = no-op), and charging those burned the
        // shared per-device budget on nothing: measured 33 fed_events against a
        // 30/hour cap in one hour on the tower↔Mac rig, starving the directed
        // addressee fan above so real cross-machine wakes were silently dropped.
        // Admission is now a free `allowance > 0` check at the AMBIENT ceiling
        // (which cannot touch the directed reserve), and the spend is recorded
        // afterwards from the emit's own `woken` count.
        if (federatedWakeAllowance(authorPubkey ?? 'unknown', 'ambient') > 0) {
          const { emitAwaitedEvent } = await import('../../../events/await/engine');
          const emitted = await emitAwaitedEvent({
            key: fe.key,
            ...(fe.payload !== undefined ? { payload: fe.payload } : {}),
            ...(typeof fe.summary === 'string' ? { summary: fe.summary } : {}),
            ...(typeof fe.source === 'string' ? { source: fe.source } : {}),
            workspaceId: opts.workspaceId,
          });
          recordFederatedWakeSpend(authorPubkey ?? 'unknown', emitted?.woken ?? 0, 'ambient');
        }
      } catch (e) {
         
        console.warn(
          `[coord-message] federated event re-fire failed for ${row.msg_id} (row persisted; local watchers miss this firing):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    // ── P-008 (cross-machine-coord-parity-and-trust-2026-07-01): DELIVERY
    // RECEIPT. The sender persisted body.receipt on a federated, directed,
    // required-wake message; this machine just APPLIED it, so answer with a
    // fed-event row `coord:receipt:<msg_id>` (payload: delivered + woken +
    // machine). It rides the P-009 rail back: the ORIGIN machine's projection
    // re-fires the key into its await store, waking the sender's events:await —
    // the cross-machine wake-honesty loop closes. The receipt row itself is
    // no-recipient, no-wake, no-receipt: it can trigger nothing further.
    // Exactly-once via the same fresh-insert gate; fully best-effort.
    // M5a (audit D-013): emit the delivered receipt ONLY from the machine that
    // actually woke a recipient (fanWoken > 0) — NOT from every peer that merely
    // applied the row. Before this, all N machines emitted `delivered:true`, so
    // the sender got 1 true delivery + N-1 FALSE `delivered:true, woken:0`
    // (the honesty contract returning false positives). A recipient that is
    // homed-but-asleep everywhere wakes nowhere → no receipt → the sender's
    // events:await times out to recipient_absent, which is the honest outcome.
    // WI-7043 fix #3: emit a receipt for a genuine budget suppression too, not
    // only for a confirmed wake — same M5a rule against a FALSE delivered:true
    // (this machine woke nobody in either case), but now the sender gets a
    // `suppressed:'rate-limit'` verdict instead of the silence that is
    // indistinguishable from `recipient_absent`. Every other not-attempted case
    // (wake not requested, no addressees, below wake tier) stays silent — that
    // silence is a correct "not applicable", not a hidden failure.
    if (b.receipt === true && to.length > 0 && ((fanWoken !== null && fanWoken > 0) || fanSuppressedByRate)) {
      try {
        const { sendMessage } = await import('../../../agent-tools/coordination/messages');
        const { machineFingerprint } = await import('../../../identity/device-keychain-id');
        await sendMessage(
          {
            ownerId: 'fed-receipt',
            ownerLabel: 'fed-receipt',
            source: 'system',
            workspaceId: opts.workspaceId,
            userId: null,
          } as never,
          {
            msgId: `coord:receipt:${row.msg_id}`,
            to: [],
            summary: `[receipt] ${row.msg_id}`,
            harnessSlug: row.harness_slug,
            extra: {
              fed_event: {
                key: `coord:receipt:${row.msg_id}`,
                payload: {
                  msg_id: row.msg_id,
                  delivered: fanWoken !== null && fanWoken > 0,
                  woken: fanWoken ?? 0,
                  machine: machineFingerprint(),
                  ...(fanSuppressedByRate ? { suppressed: 'rate-limit' as const } : {}),
                },
                source: 'fed-receipt',
              },
            },
          },
        );
      } catch (e) {

        console.warn(
          `[coord-message] delivery receipt failed for ${row.msg_id} (message applied; sender falls back to reply/inbox confirmation):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  });
}

async function deleteFromPg(
  opts: CoordMessageProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = await projectionSql(opts.sql ?? getOrgPg().sql);
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.coord_event_log
    WHERE workspace_id = ${opts.workspaceId}
      AND msg_id = ${key}
      -- WI-259 parity: msg_id is globally unique within the workspace (the fed unique index), so a
      -- cross-member delete must NOT be over-restricted by the receiver's own slug (that dropped a
      -- peer member's deletion just like the put-path bare guard dropped its writes).
      -- EI-79 step 2 + D-001: guard the delete by the SAME fed_order_key() order (EI-1698)
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildCoordMessageProjection(
  opts: CoordMessageProjectionOpts,
): TableProjection<CoordMessageRow> {
  return {
    tableTag: 'coord-messages',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    // P-537 (D-034 #2): both statements go through projectionSql and no transaction-local
    // state is set; the quarantine path commits the batch before writing elsewhere, and the
    // wake/event/receipt effects wait for the commit (projectionAfterCommit).
    batchable: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isCoordMessageRow,
  FEDERATED_SURFACES,
  normalizeBodyTsMsgId,
};
