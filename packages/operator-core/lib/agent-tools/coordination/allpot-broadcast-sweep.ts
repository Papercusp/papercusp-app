/**
 * allpot-broadcast-sweep — the H5b DETECTOR for non-queen pot-wide broadcasts
 * (coord-authority-hardening-2026-07-11 P-010 / WI-4175, the EI-9501 class).
 *
 * PREVENTION already exists in layers: tools/send.ts down-scopes a fleeted
 * sender's bare `'*'` to `@fleet:<slug>` and refuses its allHive path for a
 * fleet-scoped authority; messages.ts enforces the audience⊆authority
 * invariant (H5a) at the one seam every writer passes. But every incident is
 * a DETECTOR failure too — a path the guards miss (a new verb, a federated
 * relay, a guard regression) must still be SEEN. This sweep is that detector:
 * it finds every persisted CONSCIOUSLY-CLAIMED pot-wide broadcast (the
 * `allHiveBroadcast` envelope stamp tools/send.ts persists for `allHive:true`
 * on a real `'*'` — ALLHIVE_BROADCAST_FIELD) whose sender was NOT the pot
 * queen, writes an audit row, and sends the owner a one-liner — detection +
 * visibility only, never a defang/retract (that's H5c, coord:retract).
 *
 * WHY THE FLAG, NOT THE WILDCARD: a NON-fleeted sender's bare `to:['*']`
 * legitimately stays literal (scope-broadcast only down-scopes fleeted
 * senders), so plain-'*' kind='message' delivery is ROUTINE solo-agent
 * traffic — live data at build time: 285 such rows/24h across a dozen
 * ordinary su sessions. Sweeping the wildcard would storm the owner with
 * hundreds of false alarms on the first tick and train them to ignore the
 * detector. The flag marks the OVERRIDE — the conscious "reach everyone"
 * claim that is the EI-9501 incident shape — which is rare by construction.
 *
 * WHAT COUNTS AS "QUEEN": the persisted cue-authority stamp
 * (`body->'cueAuthority'->>'authority' = 'hive-queen'`) — stamped server-side
 * at the send seam (messages.ts resolves it for every '*' kind='message'
 * broadcast; a forged stamp is rejected at read by readCueAuthority, and a
 * fleet-scoped stamp is refused OUTRIGHT there, so a surviving hive-queen
 * stamp is platform-verified). Everything else — an su (the owner sees their
 * own proxy's blasts too — accurate, cheap, self-documenting), a non-leader,
 * an unstamped sender — is flagged.
 *
 * (The `'hive-queen'` literal above is PERSISTED PLATFORM DATA — the
 * cueAuthority stamp coord-schema.ts/relay-provenance.ts write — not renamed
 * here; see scripts/lib/retired-tier-guidance.mjs's exemption for this file.)
 *
 * EXEMPT: platform principals (`from` starting with 'system') — watchdog
 * notices / reconcile sweeps are intentional platform behavior, not an agent
 * authority leak (and the exemption makes this sweep's own notices
 * structurally unable to self-detect).
 *
 * DATA MODEL (mirrors reply-deadline-sweep.ts): the owner notice itself IS
 * the idempotency marker — it's sent with `related_msg_id: <original msg_id>`
 * from THIS sweep's identity, so the NOT EXISTS dedupe (scoped to this
 * sweep's `from`, unlike reply-deadline's any-reply check — a genuine peer
 * REPLY to a broadcast must never suppress detection) selects each broadcast
 * at most once. No side-table, no watermark row.
 *
 * CHEAP BY CONSTRUCTION: the WHERE keeps the mig-576 PARTIAL index's exact
 * predicate (surface='messages' AND kind='message' AND to ∋ '*') so the tick
 * is an index range scan over the wildcard rows (tiny — lifecycle kinds like
 * plan_event broadcast '*' constantly but are excluded by kind), with the
 * flag + exemption clauses filtering that already-small candidate set.
 */

import { getOrgPg } from '@papercusp/db-org';
import { sendMessage } from './messages';
import { ALLHIVE_BROADCAST_FIELD } from './scope-broadcast';
import type { AgentIdentity } from './identity';

/** Sweep identity stamped on the audit trail + owner notices. The 'system'
 *  prefix ALSO makes it exempt from its own detection predicate. */
export const ALLPOT_SWEEP_OWNER = 'system:allpot-broadcast-sweep';

/** Coord identity for the sweep's own notice write (mirrors
 *  RECONCILE_IDENTITY in reply-deadline-sweep.ts — a system action runs
 *  in-process and attributes as a `principal`, never a real agent). */
const SWEEP_IDENTITY: AgentIdentity = {
  ownerId: ALLPOT_SWEEP_OWNER,
  ownerLabel: 'system · allpot-broadcast-sweep',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Max detections handled per tick — a safety bound; genuine pot-wide
 *  blasts are expected to be rare (mirrors REPLY_DEADLINE_SWEEP_BATCH_LIMIT). */
export const ALLPOT_SWEEP_BATCH_LIMIT = 50;

/** How far back a tick looks. Bounds the index range scan AND covers detector
 *  downtime (a broadcast landing while the sweep was down is still caught for
 *  a day — after that it's history, not an actionable incident). */
export const ALLPOT_SWEEP_LOOKBACK_MS = 24 * 60 * 60_000;

/** Audit action name (audit:list renders {ts, actor, action, subject}). */
export const ALLPOT_AUDIT_ACTION = 'coord.allpot_broadcast';

export interface DetectedAllPotBroadcast {
  workspaceId: string;
  msgId: string;
  from: string;
  summary?: string;
  /** The persisted cue-authority `authority` value, if any (never 'hive-queen'
   *  — those are excluded by the query). */
  authority?: string;
  /** Envelope send time (ISO), for the notice prose. */
  sentAt?: string;
}

interface DetectedRow {
  workspace_id: string;
  msg_id: string;
  from_id: string;
  summary: string | null;
  authority: string | null;
  sent_at: string | null;
}

/**
 * Every CONSCIOUSLY-CLAIMED pot-wide broadcast (the allHiveBroadcast stamp)
 * within the lookback window whose sender is neither hive-queen-stamped nor
 * a platform principal, and which THIS sweep has not already flagged (NOT
 * EXISTS a sibling notice from the sweep's own identity carrying
 * related_msg_id — scoped to our `from` so a genuine peer reply never
 * suppresses detection). The kind/to clauses are semantically implied by the
 * stamp but kept verbatim so the planner can use the mig-576 partial index.
 * Oldest first so a batch-limited tick drains in arrival order.
 */
async function findUnflaggedAllPotBroadcasts(
  nowMs: number,
  lookbackMs: number,
  limit: number,
): Promise<DetectedAllPotBroadcast[]> {
  const { sql } = getOrgPg();
  const sinceMs = nowMs - lookbackMs;
  const rows = await sql<DetectedRow[]>`
    SELECT e1.workspace_id,
           e1.msg_id,
           e1.body->>'from' AS from_id,
           e1.body->>'summary' AS summary,
           e1.body->'cueAuthority'->>'authority' AS authority,
           e1.body->>'ts' AS sent_at
      FROM harness_shared.coord_event_log e1
     WHERE e1.surface = 'messages'
       AND e1.body->>'kind' = 'message'
       AND e1.body->'to' @> '["*"]'::jsonb
       AND e1.body ? ${ALLHIVE_BROADCAST_FIELD}
       AND e1.ts >= to_timestamp(${sinceMs} / 1000.0)
       AND COALESCE(e1.body->'cueAuthority'->>'authority', '') <> 'hive-queen'
       AND COALESCE(e1.body->>'from', '') NOT LIKE 'system%'
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.coord_event_log e2
          WHERE e2.workspace_id = e1.workspace_id
            AND e2.surface = 'messages'
            -- Same reasoning as the kind/to clauses above, applied to the SUBQUERY:
            -- kept verbatim so the planner can use coord_event_log_related_msg_id_idx,
            -- which is PARTIAL: it is defined WHERE (body ? 'related_msg_id'). The
            -- clause is logically redundant with the equality below (body->>key is NULL
            -- when the key is absent and NULL never equals a msg_id), but without it the
            -- index cannot be proven to cover and the anti-join scans every messages row.
            -- Measured 2026-08-03 (EI-19448297390091252) on this query's sibling shape:
            -- 40,684 -> 721 buffers (56x), 156.9ms -> 8.96ms. Do not "simplify".
            AND e2.body ? 'related_msg_id'
            AND e2.body->>'related_msg_id' = e1.msg_id
            AND e2.body->>'from' = ${ALLPOT_SWEEP_OWNER}
       )
     ORDER BY e1.ts ASC
     LIMIT ${limit}
  `;
  return rows
    .filter((r) => typeof r.from_id === 'string' && r.from_id)
    .map((r) => ({
      workspaceId: r.workspace_id,
      msgId: r.msg_id,
      from: r.from_id,
      summary: r.summary ?? undefined,
      authority: r.authority ?? undefined,
      sentAt: r.sent_at ?? undefined,
    }));
}

/** One-line clamp for the offending summary quoted in the notice/audit. */
function clampSummary(s: string | undefined, max = 140): string {
  if (!s) return '(no summary)';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** Append the durable audit row (harness_shared.audit_log — the audit:list
 *  surface). Actor = the OFFENDING sender (who did the thing); subject = the
 *  broadcast's msg_id. Throws on failure so the caller counts it (the notice
 *  is the idempotency marker, so a failed audit retries next tick). */
async function writeAllPotAuditRow(d: DetectedAllPotBroadcast): Promise<void> {
  const { sql } = getOrgPg();
  const id = `ahb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const details = {
    summary: clampSummary(d.summary),
    authority: d.authority ?? null,
    sent_at: d.sentAt ?? null,
    detected_by: ALLPOT_SWEEP_OWNER,
  };
  // ${JSON.stringify(...)}::jsonb, NOT sql.json(): the org pool runs
  // postgres-js with prepare:false, which mis-binds sql.json() ("string
  // argument … Received an instance of Object") — the proven house pattern
  // (gym/store.ts, work-items.ts). Caught by
  // coord-authority-hardening.integration.test.ts; the unit mock's
  // `json: (v) => v` cannot see this.
  await sql`
    INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
    VALUES (${id}, ${Date.now()}, ${d.from}, ${ALLPOT_AUDIT_ACTION}, ${d.msgId},
            ${JSON.stringify(details)}::text::jsonb, ${d.workspaceId})
  `;
}

export interface AllPotSweepResult {
  /** Unflagged non-queen pot-wide broadcasts found this tick. */
  detected: number;
  /** Owner notices actually sent (each doubles as the dedupe marker). */
  notified: number;
  /** True when the backlog exceeded the batch limit (more next tick). */
  truncated: boolean;
}

/**
 * One sweep pass: find every unflagged non-queen pot-wide broadcast (up to
 * the batch limit), write the audit row, and send the owner a one-liner
 * (which doubles as the idempotency marker, see module docstring). Ordered
 * audit-then-notice: if the audit write fails the notice is NOT sent, so the
 * item stays selectable and both land together on the retry. Fully fail-soft
 * per item — one failure never aborts the pass.
 */
export async function runAllPotBroadcastSweepOnce(
  opts: { nowMs?: number; lookbackMs?: number; limit?: number } = {},
): Promise<AllPotSweepResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const lookbackMs = opts.lookbackMs ?? ALLPOT_SWEEP_LOOKBACK_MS;
  const limit = opts.limit ?? ALLPOT_SWEEP_BATCH_LIMIT;
  const detected = await findUnflaggedAllPotBroadcasts(nowMs, lookbackMs, limit + 1);
  const batch = detected.slice(0, limit);

  let notified = 0;
  for (const d of batch) {
    try {
      await writeAllPotAuditRow(d);
      await sendMessage(SWEEP_IDENTITY, {
        to: ['human'],
        summary: `📣 non-queen HIVE-WIDE broadcast by ${d.from}: "${clampSummary(d.summary)}" (${d.msgId})`,
        body:
          `Agent ${d.from} consciously broadcast to EVERY agent in the pot (allHive:true on to:['*'])` +
          `${d.authority ? ` carrying a '${d.authority}' authority stamp` : ' with no hive-queen authority stamp'}` +
          `${d.sentAt ? ` at ${d.sentAt}` : ''}. Only the hive queen (or a platform principal) is expected to ` +
          `blast the whole pot — this is the EI-9501 class the send-path guards down-scope/refuse, so either ` +
          `it rode a path the guards don't cover or a guard regressed. Audited as ${ALLPOT_AUDIT_ACTION} ` +
          `(subject ${d.msgId}, actor ${d.from}). Detection-only: nothing was blocked or retracted — ` +
          `use coord:retract if the message should be withdrawn.`,
        related_msg_id: d.msgId,
      });
      notified += 1;
    } catch (e) {
      // One item failing must never abort the sweep — it stays unflagged (no
      // marker landed), so the next tick retries it.
      console.warn(
        `[allpot-broadcast-sweep] flag for ${d.msgId} failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return { detected: detected.length, notified, truncated: detected.length > batch.length };
}
