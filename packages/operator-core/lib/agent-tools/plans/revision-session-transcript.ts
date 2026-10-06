/**
 * Read an ordinary SU/agent transcript recorded on a plan revision.
 *
 * Plan-run conversations have their own normalized `plan_run_turns` store.
 * Interactive Claude/OMP/Codex sessions already share the canonical bounded
 * `session_turns` index plus permanent archive fallback used by sessions:read;
 * this adapter projects that existing substrate into the same page shape as
 * `readPlanRunTranscript` so plans:revision-transcript has one response model.
 */

import { withWorkspace } from '@papercusp/db-org';
import { readArchivedSessionTurns } from '../../session-archive-read';
import { refreshTargetSessionBeforeRead } from '../sessions/_shared';
import {
  countRestrictedTurnsInScope,
  loadTranscriptExclusion,
  restrictedTurnSql,
  withheldReceipt,
} from '../../personal-vault/transcript-exclusion';
import {
  clampTranscriptLimit,
  escapeLikePattern,
  type PlanRunTranscriptPage,
  type ReadPlanRunTranscriptOpts,
} from './runs';
import type { PlanRevisionSessionKind } from './revisions';

export type IndexedAgentSessionKind = Extract<
  PlanRevisionSessionKind,
  'claude' | 'omp' | 'codex'
>;

export function isIndexedAgentSessionKind(
  kind: PlanRevisionSessionKind | null,
): kind is IndexedAgentSessionKind {
  return kind === 'claude' || kind === 'omp' || kind === 'codex';
}

/**
 * `readerOwnerIds` are the caller's identities. D-006: a turn another agent
 * recorded inside one of its disclosure windows is excluded before the query
 * filter and paging, so it never competes for a slot; the reported count covers
 * the whole session, independent of the query. No reader ids = fail closed.
 */
export async function readAgentSessionTranscript(
  workspaceId: string,
  sourceKind: IndexedAgentSessionKind,
  sessionId: string,
  opts: ReadPlanRunTranscriptOpts = {},
  readerOwnerIds: ReadonlyArray<string | null | undefined> = [],
): Promise<PlanRunTranscriptPage & ReturnType<typeof withheldReceipt>> {
  const limit = clampTranscriptLimit(opts.limit);
  const cursor =
    typeof opts.cursor === 'number' && Number.isFinite(opts.cursor)
      ? Math.floor(opts.cursor)
      : -1;
  const query = opts.query?.trim() ? opts.query.trim() : null;

  return withWorkspace(workspaceId, async (tx) => {
    try {
      await refreshTargetSessionBeforeRead(tx, sourceKind, sessionId);
    } catch {
      // Same fail-soft freshness contract as sessions:read: the existing index
      // and permanent archive remain authoritative when the live tail races.
    }

    const queryFilter = query
      ? tx`AND text ILIKE ${'%' + escapeLikePattern(query) + '%'} ESCAPE '\\'`
      : tx``;
    const beforeFilter =
      typeof opts.beforeTs === 'number' && Number.isFinite(opts.beforeTs)
        ? tx`AND ts <= to_timestamp(${Math.floor(opts.beforeTs)} / 1000.0)`
        : tx``;
    const rows = await tx<
      Array<{
        turn_idx: number;
        speaker: 'user' | 'assistant';
        text: string;
        created_at: number | string;
      }>
    >`
      SELECT turn_idx, speaker, left(text, 1500) AS text,
             COALESCE((extract(epoch FROM ts) * 1000)::bigint, 0) AS created_at
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
         AND source_kind = ${sourceKind}
         AND session_id = ${sessionId}
         AND speaker IN ('user', 'assistant')
         AND turn_idx > ${cursor}
         AND NOT ${restrictedTurnSql(tx, 'session_turns', readerOwnerIds)}
         ${queryFilter} ${beforeFilter}
       ORDER BY turn_idx ASC
       LIMIT ${limit + 1}`;

    if (rows.length > 0) {
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const scopeTally = await countRestrictedTurnsInScope(tx, {
        selfOwnerIds: readerOwnerIds,
        scope: tx`(st.workspace_id = ${workspaceId} OR st.workspace_id = 'default')
                  AND st.source_kind = ${sourceKind} AND st.session_id = ${sessionId}` as never,
      });
      return {
        turns: page.map((row) => ({
          seq: Number(row.turn_idx),
          role: row.speaker,
          content: row.text,
          createdAt: Number(row.created_at),
        })),
        nextCursor: hasMore ? Number(page[page.length - 1]!.turn_idx) : null,
        ...withheldReceipt(scopeTally),
      };
    }

    // Permanent archive fallback mirrors sessions:read. Filtering and paging
    // happen after the archive parser re-applies the index's redaction/caps.
    const archive = await readArchivedSessionTurns(sessionId, sourceKind);
    if (!archive || archive.sourceKind !== sourceKind) {
      return { turns: [], nextCursor: null };
    }
    // D-006 on the archive too, decided per session before the query filter.
    const exclusion = await loadTranscriptExclusion(tx, {
      selfOwnerIds: readerOwnerIds,
      stamps: archive.turns.map((turn) => ({ owner: turn.owner ?? archive.owner, at: turn.ts })),
    });
    const archiveTally = exclusion.partition(archive.turns, (turn) => ({ owner: turn.owner ?? archive.owner, at: turn.ts })).withheld;
    let turns = archive.turns.filter(
      (turn) =>
        exclusion.withholds({ owner: turn.owner ?? archive.owner, at: turn.ts }) === null
        && turn.turn_idx > cursor
        && (turn.speaker === 'user' || turn.speaker === 'assistant')
        && (!query || turn.text.toLowerCase().includes(query.toLowerCase()))
        && (
          typeof opts.beforeTs !== 'number'
          || !Number.isFinite(opts.beforeTs)
          || (turn.ts ? Date.parse(turn.ts) <= opts.beforeTs : true)
        ),
    );
    const hasMore = turns.length > limit;
    turns = turns.slice(0, limit);
    return {
      turns: turns.map((turn) => ({
        seq: turn.turn_idx,
        role: turn.speaker as 'user' | 'assistant',
        content: turn.text.slice(0, 1500),
        createdAt: turn.ts ? Date.parse(turn.ts) : 0,
      })),
      nextCursor: hasMore ? turns[turns.length - 1]!.turn_idx : null,
      ...withheldReceipt(archiveTally),
    };
  });
}
