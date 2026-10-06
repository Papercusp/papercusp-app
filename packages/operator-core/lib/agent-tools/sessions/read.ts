/**
 * sessions:read — bounded window read over one indexed session
 * (session-search-scope-2026-07-05 P-006). The navigation half of the
 * search→read composition: sessions:search finds the needle, this reads
 * around it. Reads the INDEX (session_turns), never a raw file dump —
 * per-turn text is already truncated+redacted at ingest.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import type { PapercuspUnifiedToolContext } from '../_tool-context';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  sessionSearchEnabled,
  disabledResult,
  SESSION_SOURCE_KINDS,
  SESSION_TURN_REF_PREFIX,
  formatSessionTurnRef,
  parseSessionSelector,
  parseTurnRef,
  refreshTargetSessionBeforeRead,
} from './_shared';
import { SESSION_TURN_TEXT_CAP } from '../../search/session-ingest';
import { DisclosureRefused, disclosureRefusalData } from '../../personal-vault/disclosure-ledger';
import { emptyTally, withheldReceipt, withholdRestrictedTurns } from '../../personal-vault/transcript-exclusion';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;
const SESSION_TURN_TEXT_CHUNK_CAP = 1_500;
const SESSION_TURN_TEXT_CHUNK_MAX = 4_000;
const SESSION_SELECTOR_CONSTRAINT = 'pass exactly one of `ref` or `session`';
const SESSION_REF_WINDOW_CONSTRAINT =
  '`ref` forbids source_kind/around/from_idx/to_idx; context, tail or limit/order and text_offset/text_limit remain allowed';
const SESSION_TAIL_CONSTRAINT =
  "`tail:N` already means `order:'desc', limit:N`; do not combine it with `order` or `limit`";

const readArgsSchema = z
  .object({
    ref: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Canonical session-turn reference from sessions:search/read: session_turn:<source-kind>:<full-session-id>:<turn-index>. Pass directly to retrieve that exact turn; add context for surrounding turns, and optionally use limit/order to choose a bounded side of that window.',
      ),
    session: z.string().min(1).max(200).optional().describe("Session id, '<source-kind>:<session-id>', or 'self' for the calling agent's current session."),
    source_kind: z.enum(SESSION_SOURCE_KINDS).optional().describe('Disambiguates when the same id exists under two sources; usually unnecessary.'),
    around: z.number().int().min(0).optional().describe('Center the window on this turn_idx.'),
    context: z.number().int().min(0).max(50).optional().describe('Turns each side of `around` or `ref` (around default 5; ref default 0 = exact turn).'),
    from_idx: z.number().int().min(0).optional(),
    to_idx: z.number().int().min(0).optional(),
    order: z
      .enum(['asc', 'desc'])
      .optional()
      .describe(
        "Which END of the range to return when it has more turns than `limit`: 'desc' (DEFAULT) = the TAIL (newest — where a session left off); 'asc' = the HEAD (from turn 0 — the kickoff prompt / launch context / loop goal, i.e. what the session was FOR). Output is chronological either way.",
      ),
    text_offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Character offset within each returned turn text; use a clipped turn’s readMore pointer for the next chunk.'),
    text_limit: z
      .number()
      .int()
      .min(1)
      .max(SESSION_TURN_TEXT_CHUNK_MAX)
      .optional()
      .describe(`Maximum ${SESSION_TURN_TEXT_CHUNK_MAX} characters per returned turn text chunk (default ${SESSION_TURN_TEXT_CHUNK_CAP}); clipped turns include a readMore continuation.`),
    tail: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Shorthand for the newest N turns (`order:'desc', limit:N`). Cannot be combined with `order` or `limit`."),
    limit: z.number().int().min(1).max(200).optional().describe('Max turns (default 40 for a session read; exact ref reads default to 1, or 2×context+1).'),
  })
  // `mode` and `query` belong to sessions:search. Keep this navigation tool
  // closed at the source schema too, so stale callers fail with a useful
  // unrecognized-key error before reaching the handler (EI-212937).
  .strict()
  .superRefine((args, ctx) => {
    if (Boolean(args.ref) === Boolean(args.session)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: SESSION_SELECTOR_CONSTRAINT });
    }
    if (args.ref && !args.ref.startsWith(SESSION_TURN_REF_PREFIX)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ref'], message: `ref must start with ${SESSION_TURN_REF_PREFIX}` });
    }
    if (args.ref && (args.source_kind || args.around != null || args.from_idx != null || args.to_idx != null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ref'],
        message: SESSION_REF_WINDOW_CONSTRAINT,
      });
    }
    if (args.tail != null && (args.order != null || args.limit != null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tail'],
        message: SESSION_TAIL_CONSTRAINT,
      });
    }
  })
  .meta({
    'x-papercusp-call-constraint': [
      SESSION_SELECTOR_CONSTRAINT,
      SESSION_REF_WINDOW_CONSTRAINT,
      SESSION_TAIL_CONSTRAINT,
    ].join('; '),
  });

export default defineTool({
  name: 'sessions:read',
  needsWorkspaceTx: true,
  crossWorkspace: true,
  capability: 'search:read',
  description:
    "Read indexed session turns. `tail:N` already means `order:'desc', limit:N`; do not combine `tail` with `order` or `limit`. `session:'self'` spans YOUR OWN respawn chain, including predecessor turns. If that window includes multiple native sessions, `session_id` is null, `session_ids` lists them, and each turn's `ref` identifies its source. Pass a `session_turn:…` ref, coordinates, from/to range, or tail. `query` and `mode` belong to sessions:search. " +
    `Turn text is returned in ${SESSION_TURN_TEXT_CHUNK_CAP}-character chunks by default; clipped turns carry text_truncated, text_full_chars, and a readMore continuation (text_offset/text_limit). A turn at the index cap also reports source_completeness (see returns). ` +
    "NOTE ON `turn_count` (EI-9970): this is the number of rows in THIS response's window (bounded by `limit`, default 40) — NOT the session's total turn count. It is a DIFFERENT quantity from sessions:list's `turns` field (that session's full indexed-text-turn total) despite the similar name; do not compare them. For the session total, use sessions:list.",
  guidance: {
    when:
      "Following a sessions:search hit: pass its `ref` directly (plus optional `context`). To read where a session left off, use `tail:N` (or explicit order:'desc' + limit); use order:'asc' for the opening turns.",
    notWhen:
      'Finding WHERE something was said — sessions:search (which owns `query` and `mode`). Raw un-indexed files — dev:claude_session op=read (being absorbed here).',
    chaining: 'sessions:search result.ref → sessions:read { ref, context?, limit?, order? }.',
    // EI-10882: the RESPONSE shape, stated up front. Arg schemas were published
    // but return shapes were not, so the only way to learn the shape was to call
    // once and introspect — one guaranteed wasted round-trip per tool, per agent.
    returns:
      '{ ok, session_id (null when a self window spans multiple native sessions), session_ids? (sessions represented in a self window), note?, turn_count (SIZE OF THIS WINDOW, not the session total), turns: [{ ref, turn_idx, speaker, owner?, ts, text, text_truncated?, text_full_chars?, source_completeness?, text_offset?, readMore? }] } — each turn ref identifies its source session; clipped text carries a directly runnable readMore pointer for the next character chunk. Capped index rows report source_completeness as complete after archive recovery or unknown when recovery is unavailable/untrusted. Turns are ALWAYS returned oldest→newest.',
    seeAlso: ['sessions:search', 'sessions:list', 'sessions:digest'],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 100 } },
  args: readArgsSchema,
  // Keep the lossless object available as MCP structuredContent for programmatic
  // callers (ptool / MCP clients that request `_meta.structured`). The text body
  // still goes through the ordinary result door for model-facing calls, but a
  // door-truncated JSON string is not a valid machine-readable response.
  result: z.object({
    ok: z.boolean(),
    // A self read can span multiple native transcripts after a carry-respawn.
    // In that case there is no single truthful session_id for the returned
    // turns; callers should use session_ids and each turn's canonical ref.
    session_id: z.string().nullable(),
    session_ids: z.array(z.object({
      source_kind: z.string(),
      session_id: z.string(),
    })).optional(),
    note: z.string().optional(),
    turn_count: z.number().int().nonnegative(),
    turns: z.array(
      z.object({
        ref: z.string(),
        turn_idx: z.number().int().nonnegative(),
        speaker: z.string(),
        owner: z.string().optional(),
        ts: z.string().optional(),
        text: z.string(),
        text_truncated: z.boolean().optional(),
        text_full_chars: z.number().int().nonnegative().optional(),
        source_completeness: z.enum(['complete', 'unknown']).optional(),
        text_offset: z.number().int().nonnegative().optional(),
        readMore: z.object({
          tool: z.string(),
          args: z.record(z.string(), z.unknown()),
        }).optional(),
      }),
    ),
  }),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const tx = ctx.tx!;
    if (!(await sessionSearchEnabled())) return disabledResult();
    const workspaceId = ctx.workspaceId ?? '';
    const parsedRef = args.ref ? parseTurnRef(args.ref) : null;
    if (args.ref && !parsedRef) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'invalid_session_turn_ref', ref: args.ref }) }],
        isError: true,
      };
    }
    const refContext = parsedRef ? (args.context ?? 0) : null;
    const limit = args.tail ?? args.limit ?? (parsedRef ? refContext! * 2 + 1 : 40);
    const textOffset = args.text_offset ?? 0;
    const textLimit = args.text_limit ?? SESSION_TURN_TEXT_CHUNK_CAP;

    let sessionId = parsedRef?.sessionId ?? args.session!;
    let sourceKind = parsedRef?.sourceKind ?? args.source_kind;
    if (!parsedRef) {
      const selector = parseSessionSelector(sessionId, sourceKind);
      sessionId = selector.sessionId;
      sourceKind = selector.sourceKind;
    }
    // The SQL predicate must use the same normalized id as refresh/archive and
    // response refs, never the caller's optional `codex:`/`claude:` prefix.
    let querySessionId: string | undefined = sessionId;
    let selfNote: string | undefined;
    const selfSession = sessionId === 'self';
    let ownerIds: string[] | undefined;
    if (selfSession) {
      // Keep `session:'self'` aligned with sessions:search: a cold carry-respawn
      // leaves the caller's turns across multiple native sessions, so the
      // current session id is only a response anchor, never the read filter.
      // resolveSearchFilters owns the caller/isolation-owner chain expansion
      // (including coord-id drift) and the current-transcript freshness tail.
      const callerOwnerId = resolveAgentIdentity(ctx).ownerId ?? '';
      const { resolveSearchFilters } = await import('../search/filters');
      const resolved = await resolveSearchFilters(
        tx,
        { session: 'self' },
        callerOwnerId,
        { workspaceId },
      );
      const self = resolved.selfSession;
      // `resolveSearchFilters` intentionally fails soft when the live
      // transcript cannot be pinned (for example, during a carry-respawn or
      // resolver timeout). Its owner filter still scopes the read across the
      // caller's indexed history, so do not turn a transient pin miss into a
      // hard read failure.
      ownerIds = resolved.filters?.owners ?? (callerOwnerId ? [callerOwnerId] : []);
      querySessionId = undefined;
      if (self) {
        sessionId = self.sessionId;
        sourceKind = self.sourceKind;
        selfNote = `resolved self → ${self.sourceKind}:${self.sessionId}`;
      } else {
        selfNote = 'self transcript could not be pinned; used owner-scoped session history';
      }
    } else {
      // Keep the historical/indexed read and archive fall-through unchanged;
      // the helper refreshes only an active target found in adv_sessions.
      try {
        await refreshTargetSessionBeforeRead(tx, sourceKind, sessionId);
      } catch {
        /* target freshness is best-effort; never make an indexed read fail */
      }
    }

    let lo: number | null = null;
    let hi: number | null = null;
    if (parsedRef) {
      lo = Math.max(0, parsedRef.turnIdx - refContext!);
      hi = parsedRef.turnIdx + refContext!;
    } else if (typeof args.around === 'number') {
      const c = args.context ?? 5;
      lo = Math.max(0, args.around - c);
      hi = args.around + c;
    } else if (typeof args.from_idx === 'number' || typeof args.to_idx === 'number') {
      lo = args.from_idx ?? 0;
      hi = args.to_idx ?? null;
    }

    // EI-10887: `order` selects WHICH END of the range survives `limit`.
    //   desc (default) → the TAIL  (newest turns — where the session left off)
    //   asc            → the HEAD  (turn 0 onward — the kickoff prompt / loop goal)
    // A self read is owner-scoped across the caller's entire carry-respawn
    // chain, so turn_idx is not a chronological key across the rows being read.
    // Use the source event time (falling back to ingest time for sources without
    // a turn timestamp) to select the head/tail, with a complete deterministic
    // tie-break. Explicit session/ref reads retain their historical per-session
    // turn_idx ordering. Output is ALWAYS re-normalised to chronological below,
    // so `order` only selects which slice survives `limit`.
    const asc = args.order === 'asc';
    const selfAscending = selfSession && asc;
    const selfDescending = selfSession && !asc;
    const namedAscending = !selfSession && asc;
    const namedDescending = !selfSession && !asc;
    const rows = await tx<Array<{
      source_kind: string;
      session_id: string;
      turn_idx: number;
      speaker: string;
      owner: string | null;
      ts: string | null;
      /** When the turn was recorded, for the D-006 window test: ts, else ingest time. */
      stamp_at?: string | null;
      text: string;
      text_full_chars: number;
      text_offset?: number;
      source_completeness?: 'complete' | 'unknown';
    }>>`
      SELECT source_kind, session_id, turn_idx, speaker, owner, ts::text AS ts,
             COALESCE(ts, ingested_at)::text AS stamp_at,
             length(text)::int AS text_full_chars,
             ${textOffset}::int AS text_offset,
             substring(text FROM ${textOffset + 1}::int FOR ${textLimit}::int) AS text
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
         AND (${querySessionId ?? null}::text IS NULL OR session_id = ${querySessionId ?? null})
         AND (${ownerIds ?? null}::text[] IS NULL OR owner = ANY(${ownerIds ?? null}::text[]))
         AND (${sourceKind ?? null}::text IS NULL OR source_kind = ${sourceKind ?? null})
         AND (${lo}::int IS NULL OR turn_idx >= ${lo})
         AND (${hi}::int IS NULL OR turn_idx <= ${hi})
    ORDER BY CASE WHEN ${selfAscending} THEN COALESCE(ts, ingested_at) END ASC NULLS LAST,
             CASE WHEN ${selfDescending} THEN COALESCE(ts, ingested_at) END DESC NULLS LAST,
             CASE WHEN ${selfAscending} THEN source_kind END ASC NULLS LAST,
             CASE WHEN ${selfDescending} THEN source_kind END DESC NULLS LAST,
             CASE WHEN ${selfAscending} THEN session_id END ASC NULLS LAST,
             CASE WHEN ${selfDescending} THEN session_id END DESC NULLS LAST,
             CASE WHEN ${selfAscending} THEN turn_idx END ASC NULLS LAST,
             CASE WHEN ${selfDescending} THEN turn_idx END DESC NULLS LAST,
             CASE WHEN ${namedAscending} THEN turn_idx END ASC NULLS LAST,
             CASE WHEN ${namedDescending} THEN turn_idx END DESC NULLS LAST
       LIMIT ${limit}
    `;
    // A desc (tail) fetch comes back newest-first; flip it so every response is
    // chronological. An asc (head) fetch is already chronological.
    if (!asc) rows.reverse();

    // A session_turns row at the parser cap cannot tell us whether the source
    // ended there. Recover only these exact turns from the byte-faithful
    // archive; the archive reader retains its decompression bounds and parser
    // redaction. A failed, partial, or mismatched archive leaves completeness
    // explicitly unknown while preserving the index chunk and its pagination.
    const cappedRows = rows.filter((row) => row.text_full_chars >= SESSION_TURN_TEXT_CAP);
    for (const row of cappedRows) row.source_completeness = 'unknown';
    const archiveBackedRows = cappedRows.filter((row) =>
      typeof row.session_id === 'string' && row.session_id.length > 0 &&
      (row.source_kind === 'claude' || row.source_kind === 'codex' || row.source_kind === 'omp'),
    );
    if (archiveBackedRows.length) {
      const groups = new Map<string, typeof archiveBackedRows>();
      for (const row of archiveBackedRows) {
        const key = `${row.source_kind}\u0000${row.session_id}`;
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
      }
      let readArchive: typeof import('../../session-archive-read').readArchivedSessionTurns | null = null;
      try {
        readArchive = (await import('../../session-archive-read')).readArchivedSessionTurns;
      } catch (error) {
        console.warn(`[sessions:read] capped-turn archive reader unavailable: ${(error as Error)?.message ?? error}`);
      }
      if (readArchive) {
        for (const group of groups.values()) {
          const first = group[0]!;
          let archived: Awaited<ReturnType<typeof readArchive>> = null;
          try {
            archived = await readArchive(
              first.session_id,
              first.source_kind as 'claude' | 'codex' | 'omp',
              undefined,
              { fullSource: true, turnIndices: group.map((row) => row.turn_idx) },
            );
          } catch (error) {
            console.warn(`[sessions:read] capped-turn archive recovery failed: ${(error as Error)?.message ?? error}`);
          }
          const archiveTurns = new Map((archived?.errors.length === 0 ? archived.turns : []).map((turn) => [turn.turn_idx, turn]));
          for (const row of group) {
            const turn = archiveTurns.get(row.turn_idx);
            const offset = row.text_offset ?? textOffset;
            const sameTimestamp = row.ts == null && turn?.ts == null ||
              row.ts != null && turn?.ts != null && Date.parse(row.ts) === Date.parse(turn.ts);
            const indexedChunkMatches = turn != null &&
              turn.speaker === row.speaker && sameTimestamp &&
              turn.text.slice(offset, offset + row.text.length) === row.text;
            if (turn && indexedChunkMatches) {
              row.text = turn.text;
              row.text_full_chars = turn.text.length;
              row.text_offset = undefined;
              row.source_completeness = 'complete';
            } else {
              row.source_completeness = 'unknown';
            }
          }
        }
      }
    }

    // `session:'self'` is owner-chain scoped, so the window may contain turns
    // from both the predecessor and successor native transcripts. Never label
    // that mixed window with the newest transcript's id: it makes the envelope
    // contradict the turn refs it just returned. For a one-session window,
    // report that session's id; with no rows, retain the requested/anchor id so
    // an empty read remains attributable.
    const returnedSessions: Array<{ source_kind: string; session_id: string }> = [];
    const returnedSessionKeys = new Set<string>();
    for (const row of rows) {
      if (typeof row.session_id !== 'string' || !row.session_id) continue;
      const key = `${row.source_kind}\u0000${row.session_id}`;
      if (returnedSessionKeys.has(key)) continue;
      returnedSessionKeys.add(key);
      returnedSessions.push({ source_kind: row.source_kind, session_id: row.session_id });
    }
    const responseSessionId =
      returnedSessions.length === 1
        ? returnedSessions[0].session_id
        : returnedSessions.length > 1
          ? null
          : sessionId;

    // Archive fall-through (session-db-archive-retire-dirs P-009): the index
    // prunes at 45d, but the session_archives blob store is permanent. A
    // session with NO index rows may still be readable — decompress, re-parse
    // with the ingest parsers, recover full redacted source text, and window
    // in JS. sessions:search stays index-bounded by design (D-001).
    let archiveNote: string | undefined;
    if (!rows.length && !selfSession) {
      try {
        const { readArchivedSessionTurns } = await import('../../session-archive-read');
        // WI-4301: the archive blob store is file-based and never covers
        // agent_chat (that source's sessions live in agent_chats_consolidated,
        // not a tailed file) — narrow it away rather than mistype it through;
        // undefined just means "try all archive-backed kinds", which is the
        // correct fallback when the caller asked for a kind the archive can't
        // serve anyway.
        const archiveSourceKind =
          sourceKind === 'claude' || sourceKind === 'omp' || sourceKind === 'codex'
            ? sourceKind
            : undefined;
        const arch = await readArchivedSessionTurns(sessionId, archiveSourceKind, undefined, { fullSource: true });
        if (arch) {
          let t = arch.turns;
          if (lo !== null || hi !== null) {
            t = t.filter((x) => (lo === null || x.turn_idx >= lo) && (hi === null || x.turn_idx <= hi));
          }
          // EI-10887: honour `order` on the archive path too, or a head read would
          // silently fall back to the tail for any session old enough to be pruned
          // from the index — exactly the sessions whose opening turns you most need.
          t = asc ? t.slice(0, limit) : t.slice(-limit);
          rows.push(
            ...t.map((x) => ({
              source_kind: x.source_kind,
              session_id: sessionId,
              turn_idx: x.turn_idx,
              speaker: x.speaker,
              owner: x.owner,
              ts: x.ts,
              text_full_chars: x.text.length,
              text_offset: textOffset,
              source_completeness: arch.errors.length === 0 ? 'complete' as const : 'unknown' as const,
              text: x.text.slice(textOffset, textOffset + textLimit),
            })),
          );
          archiveNote = `served from the permanent archive (index pruned/absent); source=${arch.sourceKind}`;
        }
      } catch (e) {
        console.warn(`[sessions:read] archive fall-through failed: ${(e as Error)?.message ?? e}`);
      }
    }

    // D-006 / P-013: turns another agent recorded inside its disclosure windows
    // are withheld from this caller and counted, after BOTH the index and the
    // archive paths so neither can serve them. A self read sees its own chain.
    let withheld = emptyTally();
    try {
      const callerOwnerId = resolveAgentIdentity(ctx).ownerId ?? null;
      const partitioned = await withholdRestrictedTurns(
        tx,
        { selfOwnerIds: [callerOwnerId, ...(ownerIds ?? [])] },
        rows,
        (row) => ({ owner: row.owner, at: row.stamp_at ?? row.ts }),
      );
      rows.splice(0, rows.length, ...partitioned.kept);
      withheld = partitioned.withheld;
    } catch (error) {
      if (error instanceof DisclosureRefused) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(disclosureRefusalData(error)) }], isError: true };
      }
      throw error;
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          session_id: responseSessionId,
          ...(selfSession ? { session_ids: returnedSessions } : {}),
          ...(selfNote ? { note: selfNote } : {}),
          ...(archiveNote ? { note: archiveNote } : {}),
          ...withheldReceipt(withheld),
          // EI-9970: this is the WINDOW size (rows returned here, capped by
          // `limit`), NOT the session's total turn count — see the tool
          // description. sessions:list's `turns` is the total; do not conflate.
          turn_count: rows.length,
          turns: rows.map((r: {
            source_kind: string;
            session_id?: string;
            turn_idx: number;
            speaker: string;
            owner: string | null;
            ts: string | null;
            text: string;
            text_full_chars?: number;
            text_offset?: number;
            source_completeness?: 'complete' | 'unknown';
          }) => {
            // The indexed query and archive path return a bounded chunk. A
            // test-shaped/future row without the explicit offset is treated as
            // full text and bounded here as a last-line defense.
            const rowOffset = typeof r.text_offset === 'number' ? r.text_offset : null;
            const offset = rowOffset ?? textOffset;
            const text = rowOffset == null
              ? r.text.slice(textOffset, textOffset + textLimit)
              : r.text.slice(0, textLimit);
            const fullChars = typeof r.text_full_chars === 'number' ? r.text_full_chars : r.text.length;
            const nextOffset = offset + text.length;
            const textTruncated = fullChars > nextOffset;
            // The indexed query always returns session_id; retain the requested
            // session as a defensive fallback for archive/test-shaped rows.
            const ref = formatSessionTurnRef(r.source_kind, r.session_id ?? sessionId, r.turn_idx);
            return {
              ref,
              turn_idx: r.turn_idx, speaker: r.speaker,
              ...(r.owner ? { owner: r.owner } : {}), ...(r.ts ? { ts: r.ts } : {}),
              ...(offset > 0 ? { text_offset: offset } : {}),
              ...(r.source_completeness ? { source_completeness: r.source_completeness } : {}),
              ...(textTruncated
                ? {
                    text_truncated: true,
                    text_full_chars: fullChars,
                    readMore: {
                      tool: 'sessions:read',
                      args: { ref, text_offset: nextOffset, text_limit: textLimit },
                    },
                  }
                : {}),
              text,
            };
          }),
        }),
      }],
    };
  },
});
