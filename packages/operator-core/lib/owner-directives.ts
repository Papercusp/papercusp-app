/**
 * owner-directives — the first-class store + budgeted renderer for explicit
 * owner directives (EI-11484).
 *
 * ORIGIN: after the 2026-07-13 OOM logout the owner directed "resume all the
 * sessions active in the last half hour"; the agent demoted the order to
 * checkpoint prose and the armed loop's re-injected standing agenda buried it.
 * Priority inversion: loop agendas have a re-injection surface, fresh owner
 * directives don't. This module gives them one.
 *
 * MODEL (owner-ruled: "lets just have the agent record the directive. they
 * should decide what to keep" — agent-EXPLICIT recording, no auto-capture, no
 * imperative detection):
 *   - orders:record files the owner's words VERBATIM into
 *     harness_shared.owner_directives (migration 597);
 *   - OPEN rows (dispositioned_at IS NULL) render ABOVE the loop contract in
 *     every wake (loop-fire), every orient fold, and the compaction/cold
 *     anchor (carry-brief) until dispositioned;
 *   - orders:disposition { id, status: done|declined, note } closes one.
 *
 * RENDER (D-004 of owner-directive-delivery-redesign-2026-09-22): verbatim in
 * STORE, never cut in RENDER — a row up to OWNER_DIRECTIVE_VERBATIM_CAP renders
 * whole; a longer row renders its labelled agent summary (orders:summarize) or a
 * summary-pending note, plus an "[orders:get #id]" pointer. The whole block is
 * capped at BLOCK_CHAR_CAP by dropping whole rows into an overflow
 * "+N more — orders:list" line.
 *
 * SCOPE: rows key on (workspace_id, owner_id) — NOT on a session or loop — so
 * a directive survives the recording session's death and renders to successor
 * sessions in the same workspace. Rows carry recorded_by attribution so a
 * reader can tell "mine" from a peer's lane.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId, resolveConcreteWorkspaceId } from './workspace-registry';
import { agendaClearedExclusionSql } from './owner-directive-agenda';
import {
  alsoSentToNote,
  directiveDisplayText,
  directiveNeedsSummary,
  OWNER_DIRECTIVE_SUMMARY_MAX,
  OWNER_DIRECTIVE_VERBATIM_CAP,
  shortOwner,
} from './owner-directive-display';

export {
  alsoSentToNote,
  directiveDisplayText,
  directiveNeedsSummary,
  OWNER_DIRECTIVE_SUMMARY_MAX,
  OWNER_DIRECTIVE_VERBATIM_CAP,
} from './owner-directive-display';

// ── Shape ─────────────────────────────────────────────────────────────────────

export type OwnerDirectiveDisposition = 'done' | 'declined';

/**
 * The single LIFECYCLE state of a directive. Every owner turn is a directive
 * (D-001 of owner-directive-delivery-redesign-2026-09-22): a captured turn is
 * `open` the moment it lands, and it ends only as `done` or `declined` with a
 * reason. The former pending → promote/dismiss capture triage is gone; migration
 * 1198 folded pending rows into open and capture dismissals into declines, and a
 * BEFORE trigger keeps legacy writers inside this three-state space.
 */
export type OwnerDirectiveState = 'open' | 'done' | 'declined';

export const OWNER_DIRECTIVE_STATES: readonly OwnerDirectiveState[] = ['open', 'done', 'declined'] as const;

/** Derive the lifecycle state of one row. PURE; the SQL CASE in listOwnerDirectives mirrors it. */
export function ownerDirectiveState(row: {
  dispositionedAtMs: number | null;
  dispositionStatus: OwnerDirectiveDisposition | null;
}): OwnerDirectiveState {
  if (row.dispositionedAtMs != null) return row.dispositionStatus === 'declined' ? 'declined' : 'done';
  return 'open';
}

export interface OwnerDirectiveRow {
  id: number;
  workspaceId: string;
  ownerId: string;
  sessionRef: string | null;
  sourceTurnRef: string | null;
  verbatimText: string;
  recordedBy: string;
  createdAtMs: number;
  dispositionedAtMs: number | null;
  dispositionStatus: OwnerDirectiveDisposition | null;
  dispositionNote: string | null;
  dispositionedBy: string | null;
  /**
   * Agent-written summary (≤ OWNER_DIRECTIVE_SUMMARY_MAX chars) of a directive
   * whose verbatim text exceeds OWNER_DIRECTIVE_VERBATIM_CAP. It is what other
   * agents see for a long open directive (D-004); null until orders:summarize.
   */
  summaryText?: string | null;
  summaryBy?: string | null;
  summaryAtMs?: number | null;
  /**
   * True when the row came from the UserPromptSubmit provenance hook rather than an agent
   * calling orders:record.
   */
  capturedByHook?: boolean;
  /** Last orders:reopen (directive-ownership-clarity-2026-09-23 P-007); null = never reopened. */
  reopenedAtMs?: number | null;
  reopenedBy?: string | null;
  reopenReason?: string | null;
  /** The disposition the reopen cleared, kept so an undone wrong close stays auditable. */
  reopenedFrom?: string | null;
  /**
   * D-004(1) of directive-ownership-clarity-2026-09-23: how many OTHER sessions
   * hold an OPEN directive with this row's exact (trimmed) text. Computed by
   * listOwnerDirectives over the whole open set, never over the returned page;
   * undefined on reads that do not compute it (getOwnerDirective, writes).
   */
  otherSessionCopies?: number;
}

// ── Bounds ────────────────────────────────────────────────────────────────────

/** Hard cap on the rendered block (~1.5K tokens) — overflow rows collapse to a count line. */
export const OWNER_DIRECTIVES_BLOCK_CHAR_CAP = 6000;
/** Most rows any render fetches — beyond this, the "+N more" line covers the rest. */
export const OWNER_DIRECTIVES_RENDER_MAX_ROWS = 12;
/** Store-side sanity cap on verbatim_text (the store keeps it verbatim; render budgets). */
export const OWNER_DIRECTIVE_VERBATIM_MAX = 16000;

/** Single-owner system default for owner_id when the caller has no richer identity. */
export const OWNER_DIRECTIVE_DEFAULT_OWNER = 'owner';

// ── Store ─────────────────────────────────────────────────────────────────────

function db(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

function toMs(v: string | Date | null | undefined): number | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

interface RawRow {
  id: string | number;
  workspace_id: string;
  owner_id: string;
  session_ref: string | null;
  source_turn_ref: string | null;
  verbatim_text: string;
  recorded_by: string;
  created_at: string | Date;
  dispositioned_at: string | Date | null;
  disposition_status: string | null;
  disposition_note: string | null;
  dispositioned_by: string | null;
  summary_text: string | null;
  summary_by: string | null;
  summary_at: string | Date | null;
  captured_by_hook: boolean | null;
  // Optional: absent until migration 1201 applies (and in fixtures that predate it).
  reopened_at?: string | Date | null;
  reopened_by?: string | null;
  reopen_reason?: string | null;
  reopened_from?: string | null;
  // Only listOwnerDirectives selects it.
  other_session_copies?: string | number | null;
}

function rowOf(r: RawRow): OwnerDirectiveRow {
  return {
    id: Number(r.id),
    workspaceId: r.workspace_id,
    ownerId: r.owner_id,
    sessionRef: r.session_ref,
    sourceTurnRef: r.source_turn_ref,
    verbatimText: r.verbatim_text,
    recordedBy: r.recorded_by,
    createdAtMs: toMs(r.created_at) ?? 0,
    dispositionedAtMs: toMs(r.dispositioned_at),
    dispositionStatus:
      r.disposition_status === 'done' || r.disposition_status === 'declined' ? r.disposition_status : null,
    dispositionNote: r.disposition_note,
    dispositionedBy: r.dispositioned_by,
    summaryText: r.summary_text ?? null,
    summaryBy: r.summary_by ?? null,
    summaryAtMs: toMs(r.summary_at),
    capturedByHook: r.captured_by_hook === true,
    reopenedAtMs: toMs(r.reopened_at),
    reopenedBy: r.reopened_by ?? null,
    reopenReason: r.reopen_reason ?? null,
    reopenedFrom: r.reopened_from ?? null,
    ...(r.other_session_copies != null ? { otherSessionCopies: Number(r.other_session_copies) } : {}),
  };
}

export interface RecordOwnerDirectiveInput {
  workspaceId: string;
  /** The human owner the directive came from (single-owner default: 'owner'). */
  ownerId?: string;
  /** The recording agent's session pointer (native session id when known). */
  sessionRef?: string | null;
  /** Provenance pointer to the OWNER (interactive) turn (session id + turn ts / stamp tag). */
  sourceTurnRef?: string | null;
  /** The owner's words VERBATIM — never a paraphrase. */
  verbatimText: string;
  /** The recording agent (coord ownerId). */
  recordedBy: string;
  /** True only for the UserPromptSubmit hook's capture path. */
  capturedByHook?: boolean;
}

/**
 * A newer, hook-verified instruction that explicitly resumes all agents after
 * "the pause" lifts an earlier system-wide pause. Keep this matcher narrow:
 * ordinary resume requests and pauses for a single project/session must not
 * close unrelated owner directives.
 */
function explicitlyLiftsSystemWidePause(priorText: string, newerText: string): boolean {
  const normalize = (text: string) =>
    text.normalize('NFKC').toLowerCase().replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, ' ');
  const prior = normalize(priorText);
  const allAgents = /\b(?:all|every)\s+(?:the\s+)?agents?\b/;
  const systemWide = /\b(?:system|workspace|hive)[ -]wide\b/;
  const pauseWithWork = /\bpause(?:d|s|ing)?\b/.test(prior) && /\bwork\b/.test(prior);

  return (
    allAgents.test(prior) &&
    systemWide.test(prior) &&
    pauseWithWork &&
    isExplicitSystemWideResume(newerText)
  );
}

function isExplicitSystemWideResume(text: string): boolean {
  const newer = text.normalize('NFKC').toLowerCase().replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, ' ');
  return (
    /\b(?:all|every)\s+(?:the\s+)?agents?\b/.test(newer) &&
    /\bresume\b/.test(newer) &&
    /\b(?:before|lift(?:s|ed|ing)?|end(?:s|ed|ing)?|cancel(?:s|ed|ling)?|supersed(?:es|ed|ing)?)\b.{0,60}\bthe\s+pause\b/.test(
      newer,
    )
  );
}

/** How far back a hook capture looks for the OPEN twin a carry-respawn re-delivery would duplicate. */
export const OWNER_DIRECTIVE_CARRY_TWIN_WINDOW_HOURS = 24;

/**
 * WI-10003691: owner directives this agent lineage has already CLOSED
 * (done/declined), with their capture time. A carry document uses these to
 * stop re-delivering a message the ledger says was resolved, when a transcript
 * tail misreads the answer as missing. Bounded to recent captures.
 */
export async function listRecentlyClosedDirectives(
  input: { workspaceId: string; recordedBy: string; sinceHours?: number },
  sql?: Sql,
): Promise<Array<{ id: number; text: string; createdAtMs: number }>> {
  const ws = resolveConcreteWorkspaceId(input.workspaceId);
  const rows = await db(sql)<Array<{ id: string | number; verbatim_text: string; created_at: Date | string }>>`
    SELECT id, verbatim_text, created_at FROM harness_shared.owner_directives
     WHERE workspace_id = ${ws}
       AND recorded_by = ${input.recordedBy}
       AND dispositioned_at IS NOT NULL
       AND created_at > now() - make_interval(hours => ${input.sinceHours ?? OWNER_DIRECTIVE_CARRY_TWIN_WINDOW_HOURS})
     ORDER BY id DESC
     LIMIT 200
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    text: r.verbatim_text,
    createdAtMs: new Date(r.created_at).getTime(),
  }));
}

/**
 * Insert a directive, OPEN. Idempotent on (workspace, owner, source_turn_ref):
 * a retried capture of the same turn returns the row that already exists,
 * whatever state it has reached since, instead of failing.
 */
export async function recordOwnerDirective(
  input: RecordOwnerDirectiveInput,
  sql?: Sql,
): Promise<OwnerDirectiveRow> {
  const s = db(sql);
  const ws = resolveConcreteWorkspaceId(input.workspaceId);
  const text = input.verbatimText.slice(0, OWNER_DIRECTIVE_VERBATIM_MAX);
  const ownerId = input.ownerId ?? OWNER_DIRECTIVE_DEFAULT_OWNER;

  // Insertion and supersession share a transaction: once a verified owner
  // resume is visible to agents, its lifted pause must already read as closed.
  return await s.begin(async (tx) => {
    // WI-10003691: a carry-respawn re-delivers an OPEN owner message to the
    // successor as its first prompt, and that successor runs under a NEW native
    // session id — so the capture below keys it on a new source_turn_ref and
    // mints a second directive for one owner message (#806 → #816). Closing
    // either twin then leaves the other rendering as an open order. When the
    // SAME agent lineage (recorded_by survives a respawn) already holds an
    // OPEN hook-captured directive with the identical text from another
    // session, this capture is that message arriving again: return it. Open
    // rows only — an identical text after the earlier one was closed is a new
    // order and still mints (merging into an open twin is harmless either way).
    if (input.capturedByHook === true && input.sessionRef && input.recordedBy) {
      const carried = await tx<RawRow[]>`
        SELECT * FROM harness_shared.owner_directives
         WHERE workspace_id = ${ws}
           AND owner_id = ${ownerId}
           AND recorded_by = ${input.recordedBy}
           AND captured_by_hook = true
           AND dispositioned_at IS NULL
           AND session_ref IS DISTINCT FROM ${input.sessionRef}
           AND verbatim_text = ${text}
           AND created_at > now() - make_interval(hours => ${OWNER_DIRECTIVE_CARRY_TWIN_WINDOW_HOURS})
         ORDER BY id DESC
         LIMIT 1
      `;
      if (carried[0]) return rowOf(carried[0]);
    }

    const rows = await tx<RawRow[]>`
      INSERT INTO harness_shared.owner_directives
        (workspace_id, owner_id, session_ref, source_turn_ref, verbatim_text, recorded_by, captured_by_hook)
      SELECT ${ws}, ${ownerId}, ${input.sessionRef ?? null},
         ${input.sourceTurnRef ?? null}, ${text}, ${input.recordedBy}, ${input.capturedByHook === true}
      WHERE NOT EXISTS (
        SELECT 1 FROM harness_shared.owner_directives
         WHERE workspace_id = ${ws}
           AND owner_id = ${ownerId}
           AND source_turn_ref = ${input.sourceTurnRef ?? null}
      )
      RETURNING *
    `;
    if (!rows[0]) {
      const existing = await tx<RawRow[]>`
        SELECT * FROM harness_shared.owner_directives
         WHERE workspace_id = ${ws}
           AND owner_id = ${ownerId}
           AND source_turn_ref = ${input.sourceTurnRef ?? null}
         ORDER BY id DESC
         LIMIT 1
      `;
      if (existing[0]) return rowOf(existing[0]);
      throw new Error('owner_directive_insert_conflict');
    }

    const created = rows[0];
    if (input.capturedByHook === true && isExplicitSystemWideResume(text)) {
      const openRows = await tx<Array<{ id: string | number; verbatim_text: string }>>`
        SELECT id, verbatim_text
          FROM harness_shared.owner_directives
         WHERE workspace_id = ${ws}
           AND owner_id = ${ownerId}
           AND dispositioned_at IS NULL
           AND id < ${created.id}
         ORDER BY id ASC
         FOR UPDATE
      `;
      const matchingPauses = openRows.filter((prior) => explicitlyLiftsSystemWidePause(prior.verbatim_text, text));
      // The owner's words refer to "the pause" (singular), so bind the lift to
      // the most recent matching open state rather than closing older unrelated
      // pause episodes that happen to use the same broad wording.
      const superseded = matchingPauses[matchingPauses.length - 1];

      if (superseded) {
        const note =
          'Superseded by owner directive #' +
          created.id +
          ': a newer verified all-agents resume lifts this system-wide pause.';
        await tx`
          UPDATE harness_shared.owner_directives
             SET dispositioned_at = now(),
                 disposition_status = 'done',
                 disposition_note = ${note},
                 dispositioned_by = ${input.recordedBy}
           WHERE workspace_id = ${ws}
             AND id = ${superseded.id}
             AND dispositioned_at IS NULL
        `;
      }
    }

    return rowOf(created);
  });
}

/** Shortest hand-recorded quote that may match inside a captured turn (shorter = too generic). */
export const OWNER_DIRECTIVE_TWIN_MIN_QUOTE = 12;
/** How far back a hand-record looks for the hook's automatic capture of the same turn. */
export const OWNER_DIRECTIVE_TWIN_WINDOW_MIN = 30;

/**
 * directive-ownership-clarity-2026-09-23 P-004: the hook-captured row that a
 * hand orders:record would duplicate. The hook already records every owner turn
 * verbatim under the session's id; an agent that ALSO records the same message
 * (the whole turn, or a quote from it) produced a second row under a different
 * owner label and turn ref — #269/#271 and #270/#272 on 2026-09-23 — and only
 * one twin ever got closed. Same session, captured by the hook, recent, and the
 * recorded text equal to (or quoted from) the captured text.
 */
export async function findCapturedTwin(
  input: { workspaceId: string; recordedBy: string; verbatimText: string },
  sql?: Sql,
): Promise<OwnerDirectiveRow | null> {
  const quote = input.verbatimText.trim();
  if (quote.length < OWNER_DIRECTIVE_TWIN_MIN_QUOTE) return null;
  const ws = resolveConcreteWorkspaceId(input.workspaceId);
  const rows = await db(sql)<RawRow[]>`
    SELECT * FROM harness_shared.owner_directives
     WHERE workspace_id = ${ws}
       AND recorded_by = ${input.recordedBy}
       AND captured_by_hook = true
       AND created_at > now() - make_interval(mins => ${OWNER_DIRECTIVE_TWIN_WINDOW_MIN})
       AND strpos(verbatim_text, ${quote}) > 0
     ORDER BY id DESC
     LIMIT 1
  `;
  return rows[0] ? rowOf(rows[0]) : null;
}

export async function getOwnerDirective(id: number, sql?: Sql): Promise<OwnerDirectiveRow | null> {
  const rows = await db(sql)<RawRow[]>`
    SELECT * FROM harness_shared.owner_directives WHERE id = ${id}
  `;
  return rows[0] ? rowOf(rows[0]) : null;
}

export interface ListOwnerDirectivesOpts {
  workspaceId: string;
  /** true → only open rows; false → only dispositioned history; omitted → all. */
  open?: boolean;
  /**
   * Filter by exact lifecycle state(s) — the only way to separate `done` from
   * `declined`. Applied in SQL, BEFORE `limit`: filtering client-side on the
   * returned page silently drops matching rows that the limit already truncated
   * away, which reads as a real absence. Combined with `open`, both apply (AND).
   */
  state?: OwnerDirectiveState | readonly OwnerDirectiveState[];
  /**
   * P-008 / D-008: the session this list is being rendered FOR. When given,
   * directives that session has cleared off its own agenda are excluded — for
   * that session only, changing nothing for the addressee or any peer.
   *
   * Omitted = the LEDGER view (orders:list, the disposition audit trail), which
   * must keep showing rows a session has personally discharged. Only banner /
   * obligation render points pass it.
   */
  viewerOwnerId?: string | null;
  limit?: number;
}

export async function listOwnerDirectives(
  opts: ListOwnerDirectivesOpts,
  sql?: Sql,
): Promise<OwnerDirectiveRow[]> {
  const s = db(sql);
  const ws = resolveConcreteWorkspaceId(opts.workspaceId);
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  // 'default' is matched alongside the canonical workspace for the same reason
  // readHeldWorkItems does: legacy/unscoped writers land rows under 'default'.
  const states = opts.state == null ? null : [...(Array.isArray(opts.state) ? opts.state : [opts.state])];
  // other_session_copies (D-004(1) of directive-ownership-clarity-2026-09-23) is a
  // correlated count over the WHOLE open set, so it is exact however small `limit`
  // is. The outer table stays unaliased: agendaClearedExclusionSql names it as
  // harness_shared.owner_directives, which an alias would make unresolvable.
  const rows = await s<RawRow[]>`
    SELECT *,
           (SELECT count(DISTINCT sib.recorded_by)
              FROM harness_shared.owner_directives AS sib
             WHERE (sib.workspace_id = ${ws} OR sib.workspace_id = 'default')
               AND sib.dispositioned_at IS NULL
               AND sib.recorded_by IS DISTINCT FROM harness_shared.owner_directives.recorded_by
               AND btrim(sib.verbatim_text, E' \\t\\r\\n') = btrim(harness_shared.owner_directives.verbatim_text, E' \\t\\r\\n')
           ) AS other_session_copies
      FROM harness_shared.owner_directives
     WHERE (workspace_id = ${ws} OR workspace_id = 'default')
       ${opts.open === true ? s`AND dispositioned_at IS NULL` : opts.open === false ? s`AND dispositioned_at IS NOT NULL` : s``}
       ${agendaClearedExclusionSql(s, opts.viewerOwnerId)}
       ${
         states && states.length > 0
           ? // Mirrors ownerDirectiveState() exactly, in the same precedence order.
             // owner-directive-state-parity.test.ts asserts the two agree for every
             // state, so this CASE cannot silently drift from the TS derivation.
             s`AND CASE
                 WHEN dispositioned_at IS NOT NULL AND disposition_status = 'declined' THEN 'declined'
                 WHEN dispositioned_at IS NOT NULL THEN 'done'
                 ELSE 'open'
               END IN ${s(states)}`
           : s``
       }
     ORDER BY ${ownFirstOrderSql(s, opts.viewerOwnerId)} created_at ASC, id ASC
     LIMIT ${limit}
  `;
  return rows.map(rowOf);
}

/**
 * WI-10002888: a render point asks for the open set FOR one session, capped at a
 * small LIMIT, oldest first. Ordered purely by age, that window is workspace-wide:
 * with 12+ older open directives from other sessions, the viewer's OWN newest
 * directive falls outside it and is never fetched. The banner then shows only
 * other sessions' [FYI] rows and a "+N more", which hides the only row that
 * asks this session to act. That was measured live on 2026-09-24 (directive
 * #470). The "own first" ordering at render time cannot recover a row that was
 * never fetched, so the viewer's own rows are ordered first HERE, before LIMIT.
 * Without a viewer (the orders:list ledger view) the order stays oldest-first.
 */
function ownFirstOrderSql(s: Sql, viewerOwnerId: string | null | undefined) {
  if (!viewerOwnerId) return s``;
  return s`(recorded_by = ${viewerOwnerId}) DESC,`;
}

/**
 * The hot read every render point uses: open directives, OLDEST first.
 *
 * `viewerOwnerId` is the session the banner is being rendered FOR; passing it
 * drops the rows that session has cleared from its own agenda (P-008 / D-008).
 * It is the LAST parameter and optional, so a caller with no session in scope
 * keeps the workspace-wide view rather than accidentally rendering somebody
 * else's agenda.
 */
export async function listOpenOwnerDirectives(
  workspaceId: string,
  limit: number = OWNER_DIRECTIVES_RENDER_MAX_ROWS,
  sql?: Sql,
  viewerOwnerId?: string | null,
): Promise<OwnerDirectiveRow[]> {
  return listOwnerDirectives({ workspaceId, open: true, limit, viewerOwnerId }, sql);
}

export async function countOpenOwnerDirectives(
  workspaceId: string,
  sql?: Sql,
  viewerOwnerId?: string | null,
): Promise<number> {
  const s = db(sql);
  const ws = resolveConcreteWorkspaceId(workspaceId);
  // The count must apply the SAME exclusion as the list above, or a banner that
  // hides three cleared rows still announces "+3 more" and sends the reader to
  // orders:list looking for directives its own banner is deliberately hiding.
  const rows = await s<Array<{ n: string | number }>>`
    SELECT count(*) AS n FROM harness_shared.owner_directives
     WHERE (workspace_id = ${ws} OR workspace_id = 'default')
       AND dispositioned_at IS NULL
       ${agendaClearedExclusionSql(s, viewerOwnerId)}
  `;
  return Number(rows[0]?.n ?? 0);
}

export type DispositionOwnerDirectiveResult =
  | { ok: true; row: OwnerDirectiveRow }
  | { ok: false; error: 'not_found' | 'already_dispositioned'; row?: OwnerDirectiveRow };

export async function dispositionOwnerDirective(
  input: { id: number; status: OwnerDirectiveDisposition; note: string; dispositionedBy: string },
  sql?: Sql,
): Promise<DispositionOwnerDirectiveResult> {
  const s = db(sql);
  const rows = await s<RawRow[]>`
    UPDATE harness_shared.owner_directives
       SET dispositioned_at = now(),
           disposition_status = ${input.status},
           disposition_note = ${input.note},
           dispositioned_by = ${input.dispositionedBy}
     WHERE id = ${input.id}
       AND dispositioned_at IS NULL
     RETURNING *
  `;
  if (rows[0]) return { ok: true, row: rowOf(rows[0]) };
  const existing = await getOwnerDirective(input.id, sql);
  if (!existing) return { ok: false, error: 'not_found' };
  return { ok: false, error: 'already_dispositioned', row: existing };
}

export type ReopenOwnerDirectiveResult =
  | { ok: true; row: OwnerDirectiveRow }
  | { ok: false; error: 'not_found' | 'not_dispositioned'; row?: OwnerDirectiveRow };

/**
 * Undo a disposition (directive-ownership-clarity-2026-09-23 P-007). Clears the
 * four disposition columns so the directive is OPEN again, and records who
 * reopened it, why, and what close it undid — the audit trail a raw SQL
 * `UPDATE … SET disposition_status = NULL` (the only undo before this) never left.
 *
 * Authorization is the caller's job (orders:reopen); this is the store write.
 * A directive that is already open is reported, never silently "reopened".
 */
export async function reopenOwnerDirective(
  input: { id: number; workspaceId: string; reason: string; reopenedBy: string },
  sql?: Sql,
): Promise<ReopenOwnerDirectiveResult> {
  const s = db(sql);
  const rows = await s<RawRow[]>`
    UPDATE harness_shared.owner_directives
       SET reopened_from = disposition_status || ' by ' || coalesce(dispositioned_by, '?')
                           || ' at ' || to_char(dispositioned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                           || ': ' || coalesce(disposition_note, ''),
           reopened_at = now(),
           reopened_by = ${input.reopenedBy},
           reopen_reason = ${input.reason},
           dispositioned_at = NULL,
           disposition_status = NULL,
           disposition_note = NULL,
           dispositioned_by = NULL
     WHERE id = ${input.id}
       AND workspace_id = ${input.workspaceId}
       AND dispositioned_at IS NOT NULL
     RETURNING *
  `;
  if (rows[0]) return { ok: true, row: rowOf(rows[0]) };
  const existing = await getOwnerDirective(input.id, sql);
  if (!existing || existing.workspaceId !== input.workspaceId) return { ok: false, error: 'not_found' };
  return { ok: false, error: 'not_dispositioned', row: existing };
}

export type SummarizeOwnerDirectiveResult =
  | { ok: true; row: OwnerDirectiveRow }
  | {
      ok: false;
      error: 'not_found' | 'already_dispositioned' | 'summary_not_needed' | 'summary_too_long' | 'summary_empty';
      row?: OwnerDirectiveRow;
    };

/**
 * Write (or rewrite) the agent summary of an over-cap directive (D-004). The
 * summary is what every OTHER agent sees for a long open directive, so it is
 * refused for a directive short enough to render verbatim (a summary there
 * would only ever be a lossy duplicate) and for a closed one (closed
 * directives render nowhere, D-002). verbatim_text is never touched.
 */
export async function summarizeOwnerDirective(
  input: { id: number; summary: string; summarizedBy: string },
  sql?: Sql,
): Promise<SummarizeOwnerDirectiveResult> {
  const summary = input.summary.trim().replace(/\s+/g, ' ');
  if (!summary) return { ok: false, error: 'summary_empty' };
  if (summary.length > OWNER_DIRECTIVE_SUMMARY_MAX) return { ok: false, error: 'summary_too_long' };
  const existing = await getOwnerDirective(input.id, sql);
  if (!existing) return { ok: false, error: 'not_found' };
  if (!directiveNeedsSummary(existing)) return { ok: false, error: 'summary_not_needed', row: existing };
  const rows = await db(sql)<RawRow[]>`
    UPDATE harness_shared.owner_directives
       SET summary_text = ${summary},
           summary_by = ${input.summarizedBy},
           summary_at = now()
     WHERE id = ${input.id}
       AND dispositioned_at IS NULL
     RETURNING *
  `;
  if (rows[0]) return { ok: true, row: rowOf(rows[0]) };
  return { ok: false, error: 'already_dispositioned', row: existing };
}

// ── Renderer (pure) ───────────────────────────────────────────────────────────

function humanAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(min, 1)}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * One row, labeled for the session that is reading the block.
 *
 * recordedBy is the addressed agent identity: orders:record writes
 * identity.ownerId, and directiveActionVerdict checks recorded_by.
 * sessionRef points at the source transcript and is provenance, not the
 * viewer identity. Keep foreign rows visible, but never render their owner's
 * words as an action assignment for another session.
 */
export function renderOwnerDirectiveRow(
  row: OwnerDirectiveRow,
  nowMs: number = Date.now(),
  viewerOwnerId?: string | null,
): string {
  const age = humanAge(Math.max(0, nowMs - row.createdAtMs));
  if (!viewerOwnerId || row.recordedBy !== viewerOwnerId) {
    const sourceSession = row.sessionRef ? ` (source session ${shortOwner(row.sessionRef)})` : '';
    return (
      `  • #${row.id} [FYI] — recorded by ${shortOwner(row.recordedBy)}${sourceSession}; ` +
      `not an action assignment for this session. Full text: orders:get #${row.id}`
    );
  }
  return `  • #${row.id} [FOR THIS SESSION] — ${age} old, recorded by ${shortOwner(row.recordedBy)}: ${directiveDisplayText(row)}${alsoSentToNote(row.otherSessionCopies)}`;
}

export const OWNER_DIRECTIVES_BLOCK_HEADER =
  '📌 OPEN OWNER DIRECTIVES — workspace-wide visibility. Rows marked [FOR THIS SESSION] are this session\'s ' +
  'action obligations and outrank its loop agenda; [FYI] rows are context only, not action assignments. ' +
  'Only disposition a row marked [FOR THIS SESSION] with orders:disposition { id, status: done|declined, note }.';

/**
 * The block every render point injects. Returns null when there are no open
 * rows. `totalOpen` (when it exceeds rows.length) adds the "+N more" line even
 * if the char cap was not hit — the fetch itself is bounded.
 */
export function renderOwnerDirectivesBlock(
  rows: ReadonlyArray<OwnerDirectiveRow>,
  opts: { nowMs?: number; totalOpen?: number; viewerOwnerId?: string | null } = {},
): string | null {
  if (!rows.length) return null;
  const nowMs = opts.nowMs ?? Date.now();
  const totalOpen = Math.max(opts.totalOpen ?? rows.length, rows.length);
  const lines: string[] = [OWNER_DIRECTIVES_BLOCK_HEADER];
  let used = OWNER_DIRECTIVES_BLOCK_HEADER.length;
  let shown = 0;
  // WI-10002888: the viewer's own rows are its only action obligations, so they
  // render before any [FYI] row and are never the ones the char cap folds into
  // "+N more". Stable within each group, so the given (oldest-first) order holds.
  const viewer = opts.viewerOwnerId ?? null;
  const ordered = viewer
    ? [...rows.filter((r) => r.recordedBy === viewer), ...rows.filter((r) => r.recordedBy !== viewer)]
    : rows;
  for (const row of ordered) {
    const line = renderOwnerDirectiveRow(row, nowMs, opts.viewerOwnerId);
    if (used + line.length + 1 > OWNER_DIRECTIVES_BLOCK_CHAR_CAP) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const hidden = totalOpen - shown;
  if (hidden > 0) lines.push(`  +${hidden} more open — orders:list { open: true }`);
  return lines.join('\n');
}

/**
 * Convenience: fetch + render the open-directives block for a workspace.
 * Best-effort by contract — every caller is a prompt-assembly path that must
 * never fail because this read did; a miss renders nothing.
 */
export async function renderOpenOwnerDirectivesBlock(
  workspaceId: string | null | undefined,
  opts: { nowMs?: number; sql?: Sql; viewerOwnerId?: string | null } = {},
): Promise<string | null> {
  // A workspace-less caller (e.g. a loop routine armed without one) falls back
  // to the active workspace — an open owner directive must not be skippable by
  // a missing scope field.
  const ws = workspaceId || activeWorkspaceId();
  if (!ws) return null;
  try {
    const rows = await listOpenOwnerDirectives(ws, OWNER_DIRECTIVES_RENDER_MAX_ROWS, opts.sql, opts.viewerOwnerId);
    if (!rows.length) return null;
    const totalOpen =
      rows.length >= OWNER_DIRECTIVES_RENDER_MAX_ROWS
        ? await countOpenOwnerDirectives(ws, opts.sql, opts.viewerOwnerId).catch(() => rows.length)
        : rows.length;
    return renderOwnerDirectivesBlock(rows, {
      nowMs: opts.nowMs,
      totalOpen,
      viewerOwnerId: opts.viewerOwnerId,
    });
  } catch {
    return null;
  }
}
