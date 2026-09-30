/**
 * Hyperbee → PG projection for `harness_shared.coord_conversations`.
 *
 * Plan: distributed-coordination-shared-harness-2026-06-04 (Track A — federate
 * coordination content). A HARNESS-SCOPED conversation (scope='harness')
 * federates as harness content over the same peer-log machinery as
 * features/issues/plans. The per-harness Hyperbee key is the conversation `id`
 * ('conv-<…>', globally unique).
 *
 * Federated fields = the conversation's shared scalars: kind, the seed
 * question/discussion text (title/body), Lifecycle `state`, the captured
 * `accepted_answer`, `capture_target`, `promoted_issue_id`, and the
 * created/updated/resolved timestamps. NOT federated (machine-local):
 *   • `workspace_id` — the LOCAL projection's bound workspace (a remote
 *     conversation lands in the workspace this harness is bound to here).
 *   • `accepted_post_id` — a LOCAL bigserial → coord_thread_posts.id; the post
 *     ids differ per machine, so the pointer is meaningless cross-machine. The
 *     accepted ANSWER TEXT (`accepted_answer`) carries the content; the pointer
 *     stays NULL on a remote apply.
 *   • the reply timeline (coord_thread_posts), tags (coord_links) and
 *     subscriptions (coord_entity_subscriptions) — separate surfaces / local
 *     delivery state (D-002).
 *
 * Timestamps are wired as epoch-ms NUMBERS (the op-key reshape converts the
 * `to_jsonb` ISO strings) and written back via `to_timestamp`, mirroring
 * features' taken_at/expires_at.
 *
 * decodeValue validates the CHECK-constrained enums (kind/scope/state) so a
 * malformed remote op is DROPPED rather than crashing the projection loop on a
 * constraint violation.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';

/** Wire-shape of a federated harness-scoped conversation. */
export interface CoordConversationRow {
  harness_slug: string;
  id: string;
  kind: string;        // 'question' | 'discussion'
  scope: string;       // always 'harness' for a federated row
  asker_id: string;
  title: string | null;
  body: string;
  state: string;       // 'open' | 'resolved' | 'closed'
  accepted_answer: string | null;
  capture_target: string | null;
  promoted_issue_id: string | null;
  /** The tool that opened it (EI-21462599108204160).
   *
   *  OPTIONAL on the wire, and that is load-bearing, not laziness. A peer still
   *  running pre-attribution code emits no `producer` key at all, so a REQUIRED
   *  string|null would make isCoordConversationRow reject the row — and
   *  decodeValue drops a failed row wholesale. Adding attribution would then
   *  cost the ENTIRE conversation between versions, which is strictly worse
   *  than the missing attribution it was meant to fix. Absent === unattributed. */
  producer?: string | null;
  /** The replacement conversation when this ask was retracted. OPTIONAL for the
   *  same wire-compat reason as `producer`: a peer on older code omits the key,
   *  and a required field would drop its rows entirely. */
  superseded_by?: string | null;
  /** epoch ms | null — when it was retracted. Optional, as above. */
  superseded_at?: number | null;
  created_at: number;          // epoch ms
  updated_at: number;          // epoch ms
  resolved_at: number | null;  // epoch ms | null
}

const KINDS = new Set(['question', 'discussion']);
// 'superseded' is FEDERATABLE (EI-21466427005733939). Its absence here was not a
// missing column but a dropped ROW: the local table has allowed the state since
// conversations-store.ts:490, so every retracted ask failed isCoordConversationRow
// and decodeValue discarded it wholesale — a retraction was invisible to peers,
// who could then answer a question that had been explicitly withdrawn.
const STATES = new Set(['open', 'resolved', 'closed', 'superseded']);

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isCoordConversationRow(input: unknown): input is CoordConversationRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.id) || r.id.length === 0) return false;
  if (!isString(r.kind) || !KINDS.has(r.kind)) return false;
  // A federated conversation is by definition harness-scoped.
  if (r.scope !== 'harness') return false;
  if (!isString(r.asker_id) || r.asker_id.length === 0) return false;
  if (!isStringOrNull(r.title)) return false;
  if (!isString(r.body)) return false;
  if (!isString(r.state) || !STATES.has(r.state)) return false;
  if (!isStringOrNull(r.accepted_answer)) return false;
  if (!isStringOrNull(r.capture_target)) return false;
  if (!isStringOrNull(r.promoted_issue_id)) return false;
  // `undefined` is ACCEPTED here on purpose — see CoordConversationRow.producer.
  // An older peer omits the key entirely; rejecting that would drop the whole row.
  if (!(r.producer === undefined || isStringOrNull(r.producer))) return false;
  if (!(r.superseded_by === undefined || isStringOrNull(r.superseded_by))) return false;
  if (!(r.superseded_at === undefined || r.superseded_at === null || isFiniteNumber(r.superseded_at))) return false;
  if (!isFiniteNumber(r.created_at)) return false;
  if (!isFiniteNumber(r.updated_at)) return false;
  if (!(r.resolved_at === null || isFiniteNumber(r.resolved_at))) return false;
  return true;
}

export interface CoordConversationProjectionOpts {
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
}

function composeKey(row: CoordConversationRow): string {
  // Per-harness Hyperbee → key is just the conversation id.
  return row.id;
}

function decodeValue(raw: unknown): CoordConversationRow | null {
  return isCoordConversationRow(raw) ? raw : null;
}

async function writeToPg(
  opts: CoordConversationProjectionOpts,
  row: CoordConversationRow,
  provenance: ProvenanceContext,
): Promise<void> {
  // WI-259 parity (shared-hive comms federation): own-slug applies; a CROSS-member conversation
  // applies iff its VERIFIED source-log device ∈ the hive's CURRENT members (the bare slug early-
  // return previously dropped every peer member's conversation). It lands under its AUTHORED slug
  // (the INSERT keys on row.harness_slug).
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  const memberDecision = await decideMemberContentOp(row.harness_slug, opts, sourceLogDevice);
  if (memberDecision !== 'apply') {
    if (memberDecision === 'defer' && sourceLogDevice && opts.pendingMemberContent) {
      opts.pendingMemberContent.defer(
        {
          authorDevice: sourceLogDevice,
          tableTag: 'coord-conversations',
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
          tableTag: 'coord-conversations',
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
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  // workspace_id is the LOCAL projection's bound workspace (not the sender's).
  // accepted_post_id is NOT federated (local bigserial) — NULL on insert,
  // preserved on update (the SET list omits it).
  await sql`
    INSERT INTO harness_shared.coord_conversations
      (workspace_id, id, kind, scope, harness_slug, asker_id, title, body, state,
       accepted_answer, capture_target, promoted_issue_id, producer,
       superseded_by, superseded_at,
       created_at, updated_at, resolved_at, origin, author_pubkey, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.id}, ${row.kind}, 'harness', ${row.harness_slug}, ${row.asker_id},
       ${row.title}, ${row.body}, ${row.state}, ${row.accepted_answer}, ${row.capture_target},
       ${row.promoted_issue_id}, ${row.producer ?? null},
       ${row.superseded_by ?? null},
       ${row.superseded_at == null ? null : sql`to_timestamp(${row.superseded_at} / 1000.0)`},
       to_timestamp(${row.created_at} / 1000.0),
       to_timestamp(${row.updated_at} / 1000.0),
       ${row.resolved_at === null ? null : sql`to_timestamp(${row.resolved_at} / 1000.0)`},
       ${origin}, ${authorPubkey}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, id) DO UPDATE SET
      kind              = EXCLUDED.kind,
      asker_id          = EXCLUDED.asker_id,
      title             = EXCLUDED.title,
      body              = EXCLUDED.body,
      state             = EXCLUDED.state,
      accepted_answer   = EXCLUDED.accepted_answer,
      capture_target    = EXCLUDED.capture_target,
      promoted_issue_id = EXCLUDED.promoted_issue_id,
      -- COALESCE, not a plain EXCLUDED overwrite: producer is written ONCE at
      -- open time and no code path ever changes it, so the only way EXCLUDED can
      -- differ is a peer running pre-attribution code sending NULL. Taking that
      -- NULL would ERASE a known producer on every federated echo of the row --
      -- silently re-opening EI-21462599108204160 across a mixed-version fleet.
      -- For an immutable field, preferring the non-null value is always correct.
      producer          = COALESCE(EXCLUDED.producer, coord_conversations.producer),
      -- State-gated, mirroring setState's own CASE in conversations-store.ts:311.
      -- Not a plain EXCLUDED and not a COALESCE: superseded_by legitimately goes
      -- null -> id AND back to null when the state moves off 'superseded', so
      -- COALESCE could never clear it, while a bare EXCLUDED would let a peer that
      -- omits the key silently UN-supersede a retracted ask. Gating on the state
      -- (which DOES federate) keeps the pair consistent with its own local rule.
      -- An older peer sends state='superseded' with no id: the row still lands
      -- retracted, just without the pointer — degraded, never wrong.
      superseded_by     = CASE WHEN EXCLUDED.state = 'superseded' THEN EXCLUDED.superseded_by ELSE NULL END,
      superseded_at     = CASE WHEN EXCLUDED.state = 'superseded' THEN EXCLUDED.superseded_at ELSE NULL END,
      updated_at        = EXCLUDED.updated_at,
      resolved_at       = EXCLUDED.resolved_at,
      origin            = EXCLUDED.origin,
      author_pubkey     = EXCLUDED.author_pubkey,
      fed_ts            = EXCLUDED.fed_ts,
      fed_hlc           = EXCLUDED.fed_hlc
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(coord_conversations.fed_hlc, coord_conversations.fed_ts)
  `;
}

async function deleteFromPg(
  opts: CoordConversationProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.coord_conversations
    WHERE workspace_id = ${opts.workspaceId}
      AND id = ${key}
      -- EI-79 step 2 + D-001: guard the delete by the SAME fed_order_key() order (EI-1698)
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildCoordConversationProjection(
  opts: CoordConversationProjectionOpts,
): TableProjection<CoordConversationRow> {
  return {
    tableTag: 'coord-conversations',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isCoordConversationRow,
};
