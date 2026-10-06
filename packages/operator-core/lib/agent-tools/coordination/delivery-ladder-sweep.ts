/**
 * delivery-ladder-sweep — the coord-delivery ESCALATION LADDER
 * (coord-delivery-residual-gaps-2026-07-11 P-004, WI-4160).
 *
 * The residual gap this closes: a DIRECTED message (explicit `to:[ownerId]`)
 * sent WITHOUT a wake lands durably in the recipient's inbox, but a recipient
 * that is live-and-heads-down (the mid-long-exec deafness window, a hook-
 * enrollment drift, a non-enrolled runtime) never reads it — the sender
 * assumes delivery, the recipient never sees it, and nobody is paged. The
 * ladder is ONE server-side rule:
 *
 *   a directed message unread past TTL (recipient's lastInboxReadAt < msg.ts,
 *   recipient sessionState LIVE) auto-fires that recipient's standing
 *   inbox-wake (`coord:inbox-wake:<ownerId>`, always-armed at SessionStart).
 *
 * Ratified defaults (self-ratified under AUTO 2026-07-11, disclosed to the owner):
 *   - TTL 5 min (env PAPERCUSP_COORD_LADDER_TTL_MS, clamped >=60s).
 *   - "Directed" = explicit ownerId sends ONLY — never a broadcast or
 *     `@audience` selector (no `audience` stamp; mirrors unanswered-directed's
 *     definition), sender != recipient, and never a machine-authored sender
 *     (watchers/sweeps/system notices have their own delivery machinery and
 *     cannot receive a reply; the ladder's own marker must not re-trigger it).
 *   - Storm cap: 1 auto-wake per recipient per 10 min (env
 *     PAPERCUSP_COORD_LADDER_STORM_MS, clamped >=60s). The wake is never
 *     delivered MID-turn — wakeRecipients fires the standing await, which the
 *     harness delivers when the recipient's turn settles (and manual
 *     wake-mode STAGES it, honoring the hive pause gate).
 *   - Kill-switch flag `papercusp-coord-delivery-ladder`, DEFAULT ON —
 *     checked at the periodic tick (dbos/periodic-workflows.ts), not here.
 *
 * LIVE-only by design: a PARKED recipient's unread inject is the SENDER'S
 * choice (a plain inject means "seen next natural turn"); auto-waking parked
 * sessions would convert every inject into a delayed billable turn. A
 * deliberate must-land send already has `wake:'required'` with a loud
 * recipient_absent miss. The ladder only rescues mail the recipient WOULD be
 * reading if its delivery legs were working — i.e. a demonstrably live
 * session that is not reading.
 *
 * DATA MODEL (mirrors reply-deadline-sweep): the ladder's own marker message
 * (from `system:delivery-ladder`, directed to the recipient) is both the
 * audit trail the woken agent reads first AND the storm-cap record — the cap
 * query is "recipients this owner messaged within the window". No side-table.
 * The marker deliberately does NOT set `related_msg_id`: reply-deadline's
 * "does a reply exist" NOT-EXISTS check is author-agnostic, so relating the
 * marker to the unread message would silently suppress a legitimate
 * reply-deadline nudge on the same message.
 *
 * Termination: once woken, the recipient's next turn reads its inbox
 * (coord:orient / the coord hook) → lastInboxReadAt advances past every
 * pending message → the recipient stops classifying. A recipient that never
 * wakes is not `live` → skipped. So the ladder cannot loop forever, and the
 * storm cap bounds the worst case to 1 wake / 10 min while live+deaf.
 *
 * SQL is thin IO; the escalation verdict is a PURE function
 * (classifyLadderEscalations) so the boundary unit-tests without PG —
 * same split as inbox-read-freshness.ts (P-001) and unanswered-directed.ts.
 */

import { getOrgPg } from '@papercusp/db-org';
import { sendMessage } from './messages';
import { DELIVERY_LADDER_WAKE_SOURCE, wakeRecipients } from './inbox-wake';
import { lastInboxReadAtBatch } from './inbox-read-freshness';
import { fetchWakeability, type WakeabilitySignals } from './presence-wakeability';
import { coordHasPgFastPath } from './log';
import { fetchUnansweredDirected, type UnansweredDirectedSummary } from './unanswered-directed';
import type { AgentIdentity } from './identity';
import { isMachineAuthoredSender, MACHINE_SENDER_PATTERN } from './machine-authored';

/** Sender identity stamped on ladder marker messages + wake sources (audit). */
export const DELIVERY_LADDER_OWNER = DELIVERY_LADDER_WAKE_SOURCE;

/** Coord identity for the ladder's own marker write (mirrors
 *  RECONCILE_REPLY_DEADLINE_OWNER — a system principal, never a fleet agent). */
const LADDER_IDENTITY: AgentIdentity = {
  ownerId: DELIVERY_LADDER_OWNER,
  ownerLabel: 'system · delivery-ladder',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Default TTL: a directed message unread this long (recipient live) escalates. */
export const LADDER_TTL_MS_DEFAULT = 5 * 60_000;
/** Default storm cap: at most one ladder wake per recipient per this window. */
export const LADDER_STORM_MS_DEFAULT = 10 * 60_000;
/** Candidate scan horizon — bounds the JSONB scan; anything older was either
 *  read long ago or belongs to a session the liveness gate excludes anyway. */
export const LADDER_LOOKBACK_MS = 6 * 3600_000;
/** Max recipients escalated per sweep tick (safety bound, under MAX_WAKE_FANOUT). */
export const LADDER_SWEEP_BATCH_LIMIT = 50;

function envMs(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const raw = env[name];
  const n = raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.max(60_000, Math.round(n)); // clamp >=1min — sub-minute TTLs are wake storms
}

export function ladderTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env, 'PAPERCUSP_COORD_LADDER_TTL_MS', LADDER_TTL_MS_DEFAULT);
}

export function ladderStormMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env, 'PAPERCUSP_COORD_LADDER_STORM_MS', LADDER_STORM_MS_DEFAULT);
}

/** One aggregated row per (workspace, recipient) with >=1 directed message
 *  older than TTL inside the lookback window. Read-side unfiltered — the
 *  unread + liveness + storm-cap verdicts happen in the pure classifier. */
export interface LadderCandidateRow {
  workspace_id: string;
  recipient: string;
  cnt: string | number;
  oldest_ts_ms: string | number;
  newest_ts_ms: string | number;
  newest_from: string | null;
  newest_summary: string | null;
  /** EI-10551: the individual messages behind `cnt`/`oldest_ts_ms` (newest-first, capped).
   *  The aggregates above are computed BEFORE the read-watermark is known, so they describe
   *  the whole window — read mail included. The classifier needs the individual rows both to
   *  report what is ACTUALLY unread and to NAME it. Optional: a row without it (an older
   *  shape, or a test's stub fetchCandidates) degrades to the pre-EI-10551 newest-vs-lastRead
   *  gate rather than failing. */
  recent_msgs?: readonly LadderMsg[] | null;
}

/** One directed message in the ladder's window. */
export interface LadderMsg {
  ts: string | number;
  from: string | null;
  summary: string | null;
  /** Set when this message is a REPLY (coord `related_msg_id`). Directed + a reply ⇒ it is
   *  almost always ANSWERING something the recipient sent — i.e. an answer arriving, not a
   *  new ask waiting on them. Surfaced, never acted on: we mark it and let the agent judge. */
  replyTo: string | null;
  /** WI-6+ (self-nag loop, EI-18688610206822254): `extra.auto === true` on the envelope —
   *  the SAME machine-lifecycle flag `unanswered-directed.ts` already excludes (WI-4537a).
   *  A sender like `await-event` (park/degrade-to-inbox wake notifications) always stamps
   *  this but does NOT match {@link MACHINE_SENDER_PATTERN}, so without this check its
   *  wake notices counted as unread directed mail from a "real correspondent" forever —
   *  a self-sustaining nag loop (the ladder can't read/act on a reply from a machine
   *  sender any more than it can from one matching the sender pattern). Excluded at the
   *  SQL source (`findLadderCandidates`); this field lets the pure classifier apply the
   *  same rule to hand-built rows (tests, or any future non-SQL row source) without
   *  re-deriving the exclusion. */
  auto?: boolean | null;
}

export interface LadderEscalation {
  workspaceId: string;
  recipient: string;
  /** EI-10551: messages that landed AFTER the recipient's last inbox read — i.e. the
   *  mail they genuinely have not seen. This used to be the raw window count (read mail
   *  included), while the escalation text rendered it as "N message(s) ... you have not
   *  read" — so a leader who had read 17 of 19 was told all 19 were unread, oldest 88m,
   *  when the truth was 2, oldest 9m. The alarm was right to fire and wrong about why,
   *  which is the fastest way to teach a fleet to ignore it. */
  candidateCount: number;
  /** Age of the oldest UNREAD message (not the oldest message in the window). */
  oldestAgeMs: number;
  newestFrom?: string;
  newestSummary?: string;
  /** The unread mail ITSELF (newest-first, capped for the message body). A count + an age
   *  is not a signal a recipient can act on — it forces a coord:inbox round-trip and a
   *  manual cross-reference just to answer "is anyone actually blocked on me?". Carrying
   *  the senders + summaries makes the wake self-describing: the agent can triage from the
   *  wake alone and only open the inbox if something in it needs them. */
  unread: LadderMsg[];
  /** TRUE only when the recipient has NO coord:inbox/coord:orient invocation on record at
   *  all. This — and ONLY this — is evidence of a broken delivery hook. A recipient whose
   *  read is merely STALE has a working hook and is simply behind, so telling them "your
   *  hooks may be broken" sends them to debug a healthy subsystem (it sent me). */
  neverRead: boolean;
}

/** How many unread messages the escalation body names. Enough to triage from the wake
 *  alone; past this, opening the inbox is the right move anyway. */
export const LADDER_PREVIEW_LIMIT = 8;

/**
 * PURE: render the escalation an agent actually reads.
 *
 * EI-10551 / owner ask 2026-07-12 ("make the alarm clearer so the next agent doesn't get so
 * confused"). The old body gave a COUNT and an AGE and then said "read your inbox now" — so
 * every recipient had to spend a round-trip fetching the mail and cross-referencing it by
 * hand just to answer the only question that matters: *is anyone actually blocked on me?*
 * It also asserted "your coord delivery hooks may be broken" unconditionally, which sent at
 * least one agent (me) off debugging a perfectly healthy subsystem.
 *
 * So: NAME the mail, and diagnose only what we can actually see.
 *  - Carry sender + summary, so triage happens from the wake itself.
 *  - Mark replies (↩): a directed message that is a reply is almost always an ANSWER
 *    arriving, not a new ask waiting on you. Marked, never filtered — the agent judges.
 *  - Only mention broken hooks when `neverRead` — a stale read means the hook WORKS.
 */
export function renderLadderBody(
  e: Pick<LadderEscalation, 'candidateCount' | 'oldestAgeMs' | 'unread' | 'neverRead'>,
  opts: { ttlMin: number; stormMin: number },
): string {
  const oldestMin = Math.round(e.oldestAgeMs / 60_000);
  const lines: string[] = [
    `${e.candidateCount} directed coord message(s) landed after your last inbox read ` +
      `(oldest ~${oldestMin}m ago). They are listed below — you should not need to open your ` +
      `inbox to triage them.`,
    '',
  ];

  if (e.unread.length > 0) {
    for (const m of e.unread) {
      const agoMin = Math.max(0, Math.round((Date.now() - Number(m.ts)) / 60_000));
      const mark = m.replyTo ? '↩' : '•';
      lines.push(
        `  ${mark} ${m.from ?? 'unknown'} (~${agoMin}m ago): ${m.summary ?? '(no summary)'}`,
      );
    }
    if (e.candidateCount > e.unread.length) {
      lines.push(`  … and ${e.candidateCount - e.unread.length} more — coord:inbox for the rest.`);
    }
    lines.push('');
    lines.push(
      `↩ = a REPLY (it carries related_msg_id), so it is most likely ANSWERING something you ` +
        `sent rather than asking you for something. • = a message that is not a reply — those ` +
        `are the ones most likely to be waiting on you.`,
    );
    lines.push('');
  }

  lines.push(
    `WHAT THIS ALARM DOES AND DOES NOT MEAN. It means: mail arrived that you have not read, ` +
      `and your session is live enough to read it. It does NOT mean a peer is necessarily ` +
      `blocked on you — a stand-down ack and an urgent question look identical to the sweep. ` +
      `Read the list, answer anything awaiting you (coord:send), and carry on; if nothing in it ` +
      `needs you, nothing is required of you and this alarm is DISCHARGED — you do not have to ` +
      `justify it or hunt for a fault.`,
  );

  if (e.neverRead) {
    lines.push('');
    lines.push(
      `⚠ You have NO coord:inbox / coord:orient call on record at all — not merely a stale one. ` +
        `That is the signature of a broken delivery hook (a dropped ~/.claude/settings.json ` +
        `entry, a runtime with no injection leg). See the coord-mid-turn-delivery insight.`,
    );
  }

  lines.push('');
  lines.push(
    `(delivery-ladder: auto-fired when directed mail sits unread past ${opts.ttlMin}m; ` +
      `at most once per ${opts.stormMin}m per recipient. Reading your inbox — via coord:inbox ` +
      `OR coord:orient, both count — is what clears it.)`,
  );

  return lines.join('\n');
}

/**
 * PURE: fold candidate rows + the recipients' last-inbox-read map + liveness
 * signals + the storm-capped set into the escalation list. Skip-toward-null:
 * missing/unparseable signals never escalate (a wake is a billable turn — only
 * fire on an affirmative live+unread read). Longest-waiting first.
 */
export function classifyLadderEscalations(input: {
  rows: readonly LadderCandidateRow[];
  /** ownerId → last coord:inbox/orient read (ISO), from lastInboxReadAtBatch. */
  lastReadByOwner: ReadonlyMap<string, string>;
  /** ownerId → wakeability signals; live := wakeable && liveTurn. */
  signals: ReadonlyMap<string, WakeabilitySignals>;
  /** Recipients already woken by the ladder inside the storm window. */
  capped: ReadonlySet<string>;
  nowMs: number;
}): LadderEscalation[] {
  const out: LadderEscalation[] = [];
  for (const r of input.rows) {
    if (!r.recipient || input.capped.has(r.recipient)) continue;
    const s = input.signals.get(r.recipient);
    if (!s || !s.wakeable || !s.liveTurn) continue; // LIVE sessions only (see module docstring)
    const newestMs = Number(r.newest_ts_ms);
    const oldestMs = Number(r.oldest_ts_ms);
    if (!Number.isFinite(newestMs)) continue;
    const lastReadRaw = input.lastReadByOwner.get(r.recipient);
    const lastReadMs = lastReadRaw ? Date.parse(lastReadRaw) : NaN;
    // Read since the newest candidate landed ⇒ every candidate is read — no
    // escalation. Never-read (no coord:inbox/orient invocation on record) ⇒
    // everything is unread ⇒ escalate (the wake is exactly what makes a live
    // non-reading session finally read).
    if (Number.isFinite(lastReadMs) && lastReadMs >= newestMs) continue;

    // EI-10551: we now KNOW there is unread mail — but not yet how much, or WHAT. `cnt` and
    // `oldest_ts_ms` are window-wide (computed before lastRead was known), so reporting
    // them verbatim tells a recipient who read 17 of 19 that all 19 are unread. Narrow to
    // the messages that actually post-date their last read; the escalation text ("N messages
    // you have not read, oldest ~Xm") is only true of THIS set.
    const sourceMsgs = r.recent_msgs ?? [];
    const msgs = sourceMsgs.filter(
      (m) => Number.isFinite(Number(m?.ts)) && !isMachineAuthoredSender(m.from) && m.auto !== true,
    );
    const unread = Number.isFinite(lastReadMs)
      ? msgs.filter((m) => Number(m.ts) > lastReadMs)
      : msgs;

    // EI-13286: watchdogs and system routines cannot read or act on a reply.
    // Their directed notices may be useful inbox context, but they must never
    // spend another agent turn through the delivery escalation ladder. The SQL
    // below filters them at source; this pure guard is defense-in-depth and
    // keeps injected/legacy row shapes honest too.
    if (sourceMsgs.length > 0 && unread.length === 0) continue;
    if (sourceMsgs.length === 0 && isMachineAuthoredSender(r.newest_from)) continue;

    // Degrade, don't lie: with no per-message rows (older row shape / stubbed IO) fall back
    // to the window aggregates — the same numbers as before this fix, never worse. A
    // correctness fix that dropped an escalation on an unexpected shape would trade a false
    // alarm for a MISSED one, which is strictly the worse failure.
    const cnt = Number(r.cnt);
    const fallbackCount = Number.isFinite(cnt) && cnt > 0 ? cnt : 1;
    const unreadCount = unread.length > 0 ? unread.length : fallbackCount;
    const oldestUnreadMs =
      unread.length > 0 ? Math.min(...unread.map((m) => Number(m.ts))) : oldestMs;

    out.push({
      workspaceId: r.workspace_id,
      recipient: r.recipient,
      candidateCount: unreadCount,
      oldestAgeMs: Number.isFinite(oldestUnreadMs)
        ? Math.max(0, input.nowMs - oldestUnreadMs)
        : 0,
      ...(unread[0]?.from
        ? { newestFrom: unread[0].from }
        : r.newest_from
          ? { newestFrom: r.newest_from }
          : {}),
      ...(unread[0]?.summary
        ? { newestSummary: unread[0].summary }
        : r.newest_summary
          ? { newestSummary: r.newest_summary }
          : {}),
      unread: unread.slice(0, LADDER_PREVIEW_LIMIT),
      // Never-read = no coord:inbox/orient invocation AT ALL. Only this is evidence of a
      // broken hook; a merely-stale read means the hook works and the agent is behind.
      neverRead: !Number.isFinite(lastReadMs),
    });
  }
  return out.sort((a, b) => b.oldestAgeMs - a.oldestAgeMs);
}

/**
 * IO: one aggregated scan for directed-message candidates older than TTL
 * (mirrors reply-deadline-sweep's cross-workspace admin-connection scan —
 * append-only `messages` surface, JSONB predicates). Directedness filters
 * live in SQL (cheap set math); the per-recipient verdicts live in the
 * classifier above.
 */
export async function findLadderCandidates(
  nowMs: number,
  ttlMs: number,
): Promise<LadderCandidateRow[]> {
  const { sql } = getOrgPg();
  const newestAllowedMs = nowMs - ttlMs;
  const sinceMs = nowMs - LADDER_LOOKBACK_MS;
  return sql<LadderCandidateRow[]>`
    WITH directed AS (
      SELECT
        e.workspace_id,
        r AS recipient,
        e.body->>'from' AS from_id,
        e.body->>'summary' AS summary,
        e.body->>'related_msg_id' AS reply_to,
        (e.body->>'auto') = 'true' AS auto,
        -- Envelope-derived FIRST (unchanged reporting semantics), falling back to
        -- the row's arrival time. The COALESCE is load-bearing since the window
        -- moved to the ts COLUMN (EI-19325333358401288): rows with a NULL
        -- body->>'ts' used to be dropped by the window itself, so ts_ms could
        -- never be NULL. Now they are correctly in scope -- and a NULL here would
        -- be actively DANGEROUS rather than merely untidy:
        --   * Number(r.newest_ts_ms) (classifyLadderEscalations) turns NULL into
        --     0, i.e. 1970 -- which reads as maximally-stale unread mail and can
        --     fire a spurious escalation WAKE at a real agent;
        --   * array_agg(... ORDER BY ts_ms DESC) puts NULLs FIRST in Postgres, so
        --     newest_from / newest_summary would report the wrong message.
        COALESCE(
          (extract(epoch FROM (e.body->>'ts')::timestamptz) * 1000)::bigint,
          (extract(epoch FROM e.ts) * 1000)::bigint
        ) AS ts_ms
        FROM harness_shared.coord_event_log e
        CROSS JOIN LATERAL jsonb_array_elements_text(e.body->'to') AS r
       WHERE e.surface = 'messages'
         AND (e.body->>'kind' IS NULL OR e.body->>'kind' = 'message')
         AND NOT (e.body ? 'audience')
         AND jsonb_typeof(e.body->'to') = 'array'
         AND e.body->>'from' IS DISTINCT FROM r
         -- Machine senders cannot receive or act on a reply. Keep their notices
         -- in the inbox, but never turn unread robot output into a billable wake.
         -- Shared with sendMessage/unanswered-directed so new watchdog names are
         -- covered automatically rather than by an ever-growing local allowlist.
         AND NOT (e.body->>'from' ~ ${MACHINE_SENDER_PATTERN})
         -- EI-18688610206822254: the SAME auto=true machine-lifecycle exclusion
         -- unanswered-directed.ts already applies (WI-4537a). A sender like
         -- await-event (event-wake park/degrade-to-inbox notices) always stamps
         -- this but doesn't match MACHINE_SENDER_PATTERN, so without this the
         -- ladder counted its own wake notifications as unread directed mail from
         -- a "real correspondent" forever -- a self-sustaining nag loop.
         AND (e.body->>'auto') IS DISTINCT FROM 'true'
         AND r NOT IN ('*', 'human', '')
         AND r NOT LIKE '@%'
         -- EI-19307165753805742: the recipient's exact threaded reply is a
         -- discharge signal, not another unread obligation. Match the same
         -- recipient-authored related_msg_id predicate used by unanswered-directed's
         -- open_asks query. There is deliberately no time bound: the canonical
         -- predicate treats the explicit thread link as authoritative.
         -- The presence clause is required for the partial related_msg_id index;
         -- without it this anti-join falls back to scanning every message row.
         AND NOT EXISTS (
           SELECT 1
             FROM harness_shared.coord_event_log reply
            WHERE reply.workspace_id = e.workspace_id
              AND reply.surface = 'messages'
              AND reply.body ? 'related_msg_id'
              AND reply.body->>'related_msg_id' = e.body->>'msg_id'
              AND reply.body->>'from' = r
         )
         -- WINDOW ON THE ts COLUMN, NEVER ON body->>'ts' (EI-19325333358401288).
         -- coord_event_log_messages_ts_idx is (workspace_id, ts, id) WHERE
         -- surface='messages', so a predicate over the JSONB EXTRACTION + CAST
         -- (body->>'ts')::timestamptz cannot use it -- this query was the single
         -- largest consumer of the whole table (100.6h of DB time across 299,921+
         -- calls, 863ms mean to return ONE aggregated row). Measured on the live
         -- box, same 24h window, identical row counts:
         --   (body->>'ts')::timestamptz -> Parallel Seq Scan, 37,148 buffers,
         --                                 3 extra workers launched, 107ms
         --   ts                         -> Index Only Scan,      95 buffers,
         --                                 0 extra workers,       3.2ms
         -- i.e. ~391x fewer buffers, and it stops launching 3 parallel workers per
         -- call on a box that is already the thing we are trying to unsaturate.
         --
         -- SAFE, and not merely "close enough" -- the two differ in exactly two
         -- ways, both measured across all 76,367 live message rows:
         --   1. 34 rows differ at all; max delta 49.44s, NONE over 60s. The window
         --      here is a 6h lookback with a 5m TTL edge, so a sub-minute skew
         --      cannot flip a verdict.
         --   2. 2 rows have a NULL body->>'ts'. They were silently DROPPED before
         --      ((NULL)::timestamptz >= x is NULL, not false); ts is NOT NULL so
         --      they are now correctly considered. That is a fix, not a regression:
         --      a message with no envelope ts still has a real arrival time. See
         --      the COALESCE on ts_ms above, which that inclusion made mandatory.
         -- ts_ms above deliberately KEEPS preferring body->>'ts', so every timestamp
         -- the classifier reports/renders stays envelope-derived exactly as before.
         -- Pinned by delivery-ladder-sweep.integration.test.ts.
         AND e.ts >= to_timestamp(${sinceMs}::double precision / 1000)
         AND e.ts <= to_timestamp(${newestAllowedMs}::double precision / 1000)
    )
    SELECT workspace_id,
           recipient,
           count(*) AS cnt,
           min(ts_ms) AS oldest_ts_ms,
           max(ts_ms) AS newest_ts_ms,
           (array_agg(from_id ORDER BY ts_ms DESC))[1] AS newest_from,
           (array_agg(summary ORDER BY ts_ms DESC))[1] AS newest_summary,
           -- EI-10551: the individual messages, newest-first, so the classifier can report
           -- what is ACTUALLY unread instead of the whole window — and NAME it, so the
           -- recipient can triage from the wake without a coord:inbox round-trip. Capped at
           -- 500: we only ever consume the UNREAD tail, and 500 unread directed messages is
           -- already far past "deaf" — truncating the ancient (already-read) head costs
           -- nothing. The newest-first ordering is what makes that cap safe.
           (array_agg(
              jsonb_build_object('ts', ts_ms, 'from', from_id, 'summary', summary, 'replyTo', reply_to, 'auto', auto)
              ORDER BY ts_ms DESC
            ))[1:500] AS recent_msgs
      FROM directed
     GROUP BY workspace_id, recipient
  `;
}

/** IO: recipients the ladder already woke inside the storm window — the
 *  marker messages ARE the record (see module docstring).
 *  Exported (with findLadderCandidates) ONLY so the real SQL is reachable from
 *  delivery-ladder-sweep.integration.test.ts — the unit suite DI's both away via
 *  `io`, so before that test the window predicates had no coverage at all, which
 *  is precisely how the EI-19325333358401288 index-miss survived. */
export async function findStormCappedRecipients(
  nowMs: number,
  stormMs: number,
): Promise<Set<string>> {
  const { sql } = getOrgPg();
  const sinceMs = nowMs - stormMs;
  const rows = await sql<{ recipient: string }[]>`
    SELECT DISTINCT r AS recipient
      FROM harness_shared.coord_event_log e
      CROSS JOIN LATERAL jsonb_array_elements_text(e.body->'to') AS r
     WHERE e.surface = 'messages'
       AND e.body->>'from' = ${DELIVERY_LADDER_OWNER}
       -- Same index-miss as findLadderCandidates above (EI-19325333358401288) --
       -- see the long note there for the measurement and the two semantic
       -- differences. Cheaper per call than that one (the from predicate is
       -- selective), but it runs on the SAME tick, so leaving it on the JSONB cast
       -- would keep paying a seq scan of the whole messages surface every sweep.
       AND e.ts >= to_timestamp(${sinceMs}::double precision / 1000)
  `;
  return new Set(rows.map((r) => r.recipient));
}

export interface DeliveryLadderSweepResult {
  /** (workspace, recipient) candidate groups seen this pass (pre-filter). */
  candidates: number;
  /** Recipients that classified live+unread+uncapped. */
  escalations: number;
  /** Recipients actually woken (marker sent + wake fired without error). */
  woken: number;
  /** True when escalations exceeded the batch limit (more next tick). */
  truncated: boolean;
}

/**
 * One sweep pass. Injectable IO seams (`io`) so the whole pass unit-tests
 * without PG (same DI convention as decorateCoordDeafness's fetcher);
 * production callers pass nothing. Fully fail-soft per recipient — one bad
 * escalation never aborts the pass; the next tick retries (still unread,
 * still selectable) under the storm cap.
 */
export async function runDeliveryLadderSweepOnce(
  opts: {
    nowMs?: number;
    ttlMs?: number;
    stormMs?: number;
    limit?: number;
    io?: {
      fetchCandidates?: (nowMs: number, ttlMs: number) => Promise<LadderCandidateRow[]>;
      fetchReads?: (ownerIds: string[]) => Promise<Map<string, string>>;
      fetchSignals?: (ownerIds: string[]) => Promise<Map<string, WakeabilitySignals>>;
      fetchCapped?: (nowMs: number, stormMs: number) => Promise<Set<string>>;
      /** An absent owner in a successful map means measured zero unanswered asks. */
      fetchUnanswered?: (
        ownerIds: string[],
        workspaceId: string,
      ) => Promise<Map<string, UnansweredDirectedSummary>>;
      hasPgFastPath?: () => boolean;
      send?: typeof sendMessage;
      wake?: typeof wakeRecipients;
    };
  } = {},
): Promise<DeliveryLadderSweepResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const ttl = opts.ttlMs ?? ladderTtlMs();
  const storm = opts.stormMs ?? ladderStormMs();
  const limit = opts.limit ?? LADDER_SWEEP_BATCH_LIMIT;
  const io = opts.io ?? {};

  const rows = await (io.fetchCandidates ?? findLadderCandidates)(nowMs, ttl);
  if (rows.length === 0) return { candidates: 0, escalations: 0, woken: 0, truncated: false };

  const recipients = [...new Set(rows.map((r) => r.recipient))];
  // The ladder's unread candidate set includes FYIs and stale asks. Only an
  // authoritative unanswered-directed read can distinguish those from work
  // waiting on the recipient. The helper returns an empty map both for a
  // measured zero and when its PG fast path is unavailable, so check the path
  // first and preserve the legacy escalation behavior on any unavailable read.
  const unansweredByWorkspacePromise = (async (): Promise<
    Map<string, Map<string, UnansweredDirectedSummary> | null> | null
  > => {
    let available: boolean;
    try {
      available = (io.hasPgFastPath ?? coordHasPgFastPath)();
    } catch (err) {
      console.warn(
        `[delivery-ladder] unanswered lookup availability failed; preserving candidates: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
    if (!available) return null;

    const recipientsByWorkspace = new Map<string, Set<string>>();
    for (const row of rows) {
      const owners = recipientsByWorkspace.get(row.workspace_id) ?? new Set<string>();
      owners.add(row.recipient);
      recipientsByWorkspace.set(row.workspace_id, owners);
    }
    const fetchUnanswered = io.fetchUnanswered ?? ((ownerIds, workspaceId) =>
      fetchUnansweredDirected(ownerIds, { workspaceId }));
    const reads = await Promise.all(
      [...recipientsByWorkspace].map(async ([workspaceId, ownerIds]) => {
        try {
          return [workspaceId, await fetchUnanswered([...ownerIds], workspaceId)] as const;
        } catch (err) {
          console.warn(
            `[delivery-ladder] unanswered lookup for workspace ${workspaceId} failed; preserving candidates: ${err instanceof Error ? err.message : err}`,
          );
          return [workspaceId, null] as const;
        }
      }),
    );
    return new Map(reads);
  })();
  const [lastReadByOwner, signals, capped, unansweredByWorkspace] = await Promise.all([
    (io.fetchReads ?? lastInboxReadAtBatch)(recipients),
    (io.fetchSignals ?? fetchWakeability)(recipients),
    (io.fetchCapped ?? findStormCappedRecipients)(nowMs, storm),
    unansweredByWorkspacePromise,
  ]);

  const actionableRows = unansweredByWorkspace
    ? rows.filter((row) => {
        const unansweredByOwner = unansweredByWorkspace.get(row.workspace_id);
        if (!unansweredByOwner) return true; // that workspace's read failed; fail open
        const summary = unansweredByOwner.get(row.recipient);
        if (!summary) return false; // successful reads omit measured zeroes by contract
        return !Number.isSafeInteger(summary.count) || summary.count < 0 || summary.count > 0;
      })
    : rows;
  const escalations = classifyLadderEscalations({
    rows: actionableRows,
    lastReadByOwner,
    signals,
    capped,
    nowMs,
  });
  const batch = escalations.slice(0, limit);

  const send = io.send ?? sendMessage;
  const wake = io.wake ?? wakeRecipients;
  const ttlMin = Math.round(ttl / 60_000);
  let woken = 0;
  for (const e of batch) {
    const oldestMin = Math.round(e.oldestAgeMs / 60_000);
    try {
      await send(LADDER_IDENTITY, {
        to: [e.recipient],
        summary:
          `📬 delivery-ladder: ${e.candidateCount} directed message(s) you have not read ` +
          `(oldest ~${oldestMin}m${e.newestFrom ? `, newest from ${e.newestFrom}` : ''})`,
        body: renderLadderBody(e, { ttlMin, stormMin: Math.round(storm / 60_000) }),
      });
      try {
        await wake([e.recipient], {
          summary: `delivery-ladder: directed mail unread past ${ttlMin}m (oldest ~${oldestMin}m)`,
          source: DELIVERY_LADDER_OWNER,
          workspaceId: e.workspaceId,
        });
        woken += 1;
      } catch (err) {
        console.warn(
          `[delivery-ladder] wake ${e.recipient} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    } catch (err) {
      // Marker send failed ⇒ no storm-cap record either ⇒ next tick retries.
      console.warn(
        `[delivery-ladder] escalation for ${e.recipient} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return {
    candidates: rows.length,
    escalations: escalations.length,
    woken,
    truncated: escalations.length > batch.length,
  };
}
