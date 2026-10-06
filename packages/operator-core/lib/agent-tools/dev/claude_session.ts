/**
 * dev:claude_session — find / search / read local Claude Code chat transcripts
 * (~/.claude/projects/<encoded-cwd>/<session-id>.jsonl). The Claude-Code analogue
 * of dev:omp_session (EI-4911): continuing a prior session used to mean
 * hand-grepping hundreds of JSONLs.
 *
 *   op='list'   → sessions newest-first (optionally filtered by cwd substring).
 *                 The reliable read — "which session for project X around date Y".
 *   op='search' → bounded content search; returns {sessionId, cwd, matchCount,
 *                 snippet, byteCapped} per match, plus top-level `truncated` +
 *                 `filesByteCapped` (EI-12890). LOSSY by nature (a final message
 *                 is often not persisted verbatim; markers match incidentally) —
 *                 treat a hit as a lead, not proof; the code + work-item/plan
 *                 ledger is the real source of truth. A byte-capped file reads
 *                 its TAIL (most recent turns), not its head — but a "no match"
 *                 on a `filesByteCapped` file is NOT authoritative: raise
 *                 perFileMaxBytes or fall back to a raw shell grep on that one
 *                 file before concluding the text doesn't exist.
 *   op='read'   → one session as a compact, bounded turn list (most-recent first-N).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import {
  listClaudeSessions,
  searchClaudeSessions,
  readClaudeSession,
  allClaudeSessionMetas,
  transcriptOwnerFromPath,
  readTranscriptFirstTs,
  type ClaudeSessionMeta,
} from '../../claude-sessions';
import { resolveAgentIdentity } from '../coordination/identity';
import { DisclosureRefused, disclosureRefusalData } from '../../personal-vault/disclosure-ledger';
import {
  emptyTally,
  loadTranscriptExclusion,
  withheldReceipt,
  type TranscriptTurnStamp,
  type WithheldTally,
  type WithholdReason,
} from '../../personal-vault/transcript-exclusion';

type IndexedClaudeTurn = {
  turn_idx: number;
  speaker: string;
  ts: string | null;
  owner: string | null;
  stamp_at: string | null;
  text: string;
};

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/** The caller's coord identity, or null (nothing is then the caller's own: fail closed). */
function callerOwnerOf(ctx: unknown): string | null {
  try {
    return resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId ?? null;
  } catch {
    return null;
  }
}

/**
 * Who recorded each raw transcript file: the isolation dir it sits in
 * (<base>/<owner>/projects/…) AND every owner the transcript index recorded
 * for its session id. A file is judged against ALL of them, so a path that
 * does not name its real recorder cannot launder a restricted transcript.
 * A file neither source attributes gets `[null]` — D-006 then treats its turns
 * as unattributed, the fail-closed reading.
 */
async function ownersOfTranscripts(
  sql: OrgSql,
  workspaceIdValue: string | undefined,
  files: Array<{ sessionId: string; filePath: string }>,
): Promise<Map<string, Array<string | null>>> {
  const owners = new Map<string, Array<string | null>>();
  if (files.length === 0) return owners;
  const workspaceId = workspaceIdValue ?? 'default';
  const rows = await sql<Array<{ session_id: string; owner: string }>>`
    SELECT DISTINCT session_id, owner
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
       AND source_kind = 'claude'
       AND session_id = ANY(${[...new Set(files.map((f) => f.sessionId))]}::text[])
       AND owner IS NOT NULL AND btrim(owner) <> ''`;
  const bySession = new Map<string, string[]>();
  for (const r of rows) bySession.set(r.session_id, [...(bySession.get(r.session_id) ?? []), r.owner]);
  for (const f of files) {
    const fromPath = transcriptOwnerFromPath(f.filePath);
    const all = [...new Set([...(fromPath ? [fromPath] : []), ...(bySession.get(f.sessionId) ?? [])])];
    owners.set(f.filePath, all.length > 0 ? all : [null]);
  }
  return owners;
}

function firstReason<T>(owners: ReadonlyArray<T>, decide: (owner: T) => WithholdReason | null): WithholdReason | null {
  for (const owner of owners) {
    const reason = decide(owner);
    if (reason !== null) return reason;
  }
  return null;
}

/**
 * D-006 for op=search: drop every candidate session another agent recorded
 * while it held restricted personal data BEFORE its content is grepped. The
 * decision and the count cover the whole scanned set, so neither depends on
 * the query (a per-hit count would confirm guesses about a withheld turn).
 */
async function admitUnrestrictedSessions(
  sql: OrgSql,
  workspaceIdValue: string | undefined,
  caller: string | null,
  candidates: ClaudeSessionMeta[],
): Promise<{ admitted: ClaudeSessionMeta[]; withheld: WithheldTally }> {
  const withheld = emptyTally();
  if (candidates.length === 0) return { admitted: [], withheld };
  const owners = await ownersOfTranscripts(sql, workspaceIdValue, candidates);
  const ownersOf = (c: ClaudeSessionMeta) => owners.get(c.filePath) ?? [null];
  // Untimed stamps load every window of each owner (and, for an unattributed file, every other agent's).
  const exclusion = await loadTranscriptExclusion(sql, {
    selfOwnerIds: [caller],
    stamps: candidates.flatMap((c) => ownersOf(c).map((owner) => ({ owner, at: null }))),
  });
  const admitted: ClaudeSessionMeta[] = [];
  for (const c of candidates) {
    // Cheap first pass: no window overlaps anything up to the last write.
    if (firstReason(ownersOf(c), (owner) => exclusion.withholdsSpan({ owner, from: null, to: c.lastActivityMs })) === null) {
      admitted.push(c);
      continue;
    }
    // A window may have closed before the session started: place the start.
    const from = await readTranscriptFirstTs(c.filePath);
    const reason = firstReason(ownersOf(c), (owner) => exclusion.withholdsSpan({ owner, from, to: c.lastActivityMs }));
    if (reason === null) {
      admitted.push(c);
    } else {
      withheld.turns += 1;
      withheld.byReason[reason] += 1;
    }
  }
  return { admitted, withheld };
}

/**
 * D-006 for op=read (a positional read, so a per-turn count reveals nothing
 * about content): withhold each returned turn that ANY of its candidate
 * recorders captured inside one of their disclosure windows.
 */
async function withholdReadTurns<T>(
  sql: OrgSql,
  caller: string | null,
  turns: T[],
  stampsOf: (turn: T) => TranscriptTurnStamp[],
): Promise<{ kept: T[]; withheld: WithheldTally }> {
  const withheld = emptyTally();
  if (turns.length === 0) return { kept: [], withheld };
  const exclusion = await loadTranscriptExclusion(sql, { selfOwnerIds: [caller], stamps: turns.flatMap(stampsOf) });
  const kept: T[] = [];
  for (const turn of turns) {
    const reason = firstReason(stampsOf(turn), (stamp) => exclusion.withholds(stamp));
    if (reason === null) {
      kept.push(turn);
    } else {
      withheld.turns += 1;
      withheld.byReason[reason] += 1;
    }
  }
  return { kept, withheld };
}

function refusal(error: unknown) {
  if (error instanceof DisclosureRefused) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(disclosureRefusalData(error)) }], isError: true };
  }
  throw error;
}

/**
 * The raw JSONL transcript is intentionally disposable: the archive/reconciler
 * can remove it while the indexed `session_turns` rows remain readable. Keep
 * `dev:claude_session` useful for those sessions too instead of making its
 * session-id lookup disagree with `sessions:read`.
 */
async function readIndexedClaudeSession(
  workspaceIdValue: string | undefined,
  sessionId: string,
  limit: number | undefined,
  caller: string | null,
): Promise<{ result: ReturnType<typeof readClaudeSession> extends Promise<infer T> ? T : never; withheld: WithheldTally }> {
  const maxTurns = Math.min(Math.max(limit ?? 200, 1), 2000);
  const workspaceId = workspaceIdValue ?? 'default';
  const { sql } = getOrgPg();
  const rows = await sql<IndexedClaudeTurn[]>`
    SELECT turn_idx, speaker, ts::text AS ts, owner,
           COALESCE(ts, ingested_at)::text AS stamp_at, left(text, 2000) AS text
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
       AND source_kind = 'claude'
       AND session_id = ${sessionId}
  ORDER BY turn_idx DESC
     LIMIT ${maxTurns + 1}
  `;
  if (!rows.length) return { result: null as never, withheld: emptyTally() };

  const truncated = rows.length > maxTurns;
  // Positional read: the per-turn count cannot reveal anything about content.
  const partitioned = await withholdReadTurns(sql, caller, rows.slice(0, maxTurns), (r) => [{ owner: r.owner, at: r.stamp_at }]);
  const selected = partitioned.kept.reverse();
  const turns = selected
    .filter((row) => row.speaker === 'user' || row.speaker === 'assistant')
    .map((row, i) => ({
      i,
      type: row.speaker,
      role: row.speaker,
      ts: row.ts,
      text: row.text,
    }));
  const result = {
    sessionId,
    cwd: null,
    gitBranch: null,
    firstTs: selected[0]?.ts ?? null,
    lastTs: selected[selected.length - 1]?.ts ?? null,
    totalRecords: selected.length,
    turns,
    truncated,
  } as never;
  return { result, withheld: partitioned.withheld };
}

/** Convert permanent archived turns to the same compact shape as raw reads. */
function archivedClaudeSession(
  sessionId: string,
  rows: Array<{ ts: string | null; speaker: string; text: string }>,
  limit: number | undefined,
) {
  const maxTurns = Math.min(Math.max(limit ?? 200, 1), 2000);
  const truncated = rows.length > maxTurns;
  const selected = rows.slice(-maxTurns);
  const turns = selected
    .filter((row) => row.speaker === 'user' || row.speaker === 'assistant')
    .map((row, i) => ({
      i,
      type: row.speaker,
      role: row.speaker,
      ts: row.ts,
      text: row.text,
    }));
  return {
    sessionId,
    cwd: null,
    gitBranch: null,
    firstTs: selected[0]?.ts ?? null,
    lastTs: selected[selected.length - 1]?.ts ?? null,
    totalRecords: rows.length,
    turns,
    truncated,
  };
}

export default defineTool({
  name: 'dev:claude_session',
  // Transcript enumeration/search is filesystem work and may scan many roots.
  // Do not retain an ambient workspace transaction across it: idle transactions
  // are killed after 60s and surface to the caller as CONNECTION_CLOSED. The one
  // indexed fallback below uses its own short-lived OrgPg query handle.
  skipWorkspaceTx: true,
  profile: 'engineer',
  description:
    'Find / search / read local Claude Code chat transcripts — the Claude-Code analogue of dev:omp_session. Scans BOTH ~/.claude/projects AND the per-session isolation dirs ~/.papercusp/session-claude/<owner>/projects, so psu/su CONSOLE sessions are found too. op=list (sessions by cwd + recency, the reliable read), op=search (RAW substring grep — lossy; for ranked cross-client content search prefer sessions:search), op=read (one session as a compact bounded turn list). Pass filePath or sessionId to read.',
  capability: 'intel:read',
  guidance: {
    when: 'op=list by cwd to pin "the operator-vite session from ~06-29"; op=read to see where a session left off. For CONTENT search prefer sessions:search (indexed, ranked, cross-client, returns surrounding turns) — op=search here is a raw-file substring grep, for the un-indexed pre-window tail or when the session index is off.',
    notWhen:
      'Content search → sessions:search / search:* (the indexed episodic corpus), not op=search. For PRODUCTION agent runs the orchestrator owns sessions (dev:sessions / dev:session_detail). For OMP CLI sessions use omp:sessions. To reconstruct "where they left off" the transcript is a LOSSY secondary — prefer the durable artifacts (git per-file history + the work-item/plan ledger), which are canonical.',
    chaining: 'dev:claude_session { op:"list", cwd } → { op:"read", sessionId }. Content search → sessions:search { query } (indexed), not op:"search".',
    seeAlso: [
      'sessions:search (indexed cross-client content search — prefer for CONTENT)',
      'sessions:list (unified enumeration)',
      'dev:sessions (production orchestrator sessions)',
      'dev:omp_session (OMP CLI session inspector)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    op: z.enum(['list', 'search', 'read']).optional().describe('Defaults: read if filePath/sessionId given, else search if query given, else list.'),
    query: z.string().min(1).optional().describe('Content to search for (op=search). Case-insensitive substring.'),
    cwd: z.string().min(1).optional().describe('Filter to sessions whose cwd contains this substring (op=list/search).'),
    sessionId: z.string().min(1).optional().describe('Session id (the .jsonl basename) to read.'),
    filePath: z.string().min(1).optional().describe('Absolute transcript path to read (alternative to sessionId).'),
    limit: z.number().int().positive().max(2000).optional().describe('Max rows/turns (list/search default 30/20, read default 200).'),
    maxFilesScanned: z.number().int().positive().max(2000).optional().describe('op=search: cap files scanned, newest-first (default 400).'),
    perFileMaxBytes: z.number().int().positive().max(5_000_000).optional().describe('op=search: cap bytes read per file (default 1_000_000). When a file exceeds this, its TAIL (most recent bytes) is read, not its head, and its sessionId is listed in the result\'s filesByteCapped — a "no match" for a byte-capped file is not authoritative.'),
  }),
  async handler(args, ctx) {
    const op = args.op ?? (args.filePath || args.sessionId ? 'read' : args.query ? 'search' : 'list');

    if (op === 'list') {
      const res = await listClaudeSessions({ ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.limit ? { limit: args.limit } : {}) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] };
    }

    const caller = callerOwnerOf(ctx);

    if (op === 'search') {
      if (!args.query) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'query required for op=search' }) }], isError: true };
      }
      const { sql } = getOrgPg();
      let withheldSessions = emptyTally();
      try {
        const res = await searchClaudeSessions({
          query: args.query,
          ...(args.cwd ? { cwd: args.cwd } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.maxFilesScanned ? { maxFilesScanned: args.maxFilesScanned } : {}),
          ...(args.perFileMaxBytes ? { perFileMaxBytes: args.perFileMaxBytes } : {}),
          admit: async (candidates) => {
            const decided = await admitUnrestrictedSessions(sql, ctx.workspaceId, caller, candidates);
            withheldSessions = decided.withheld;
            return decided.admitted;
          },
        });
        const receipt = withheldReceipt(withheldSessions, { restricted_sessions: withheldSessions.turns });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...res, ...receipt }) }] };
      } catch (error) {
        return refusal(error);
      }
    }

    // op === 'read'
    let filePath = args.filePath;
    if (!filePath) {
      if (!args.sessionId) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'sessionId or filePath required for op=read' }) }], isError: true };
      }
      const all = await allClaudeSessionMetas({});
      const found = all.find((m) => m.sessionId === args.sessionId);
      if (!found) {
        let indexed: Awaited<ReturnType<typeof readIndexedClaudeSession>>;
        try {
          indexed = await readIndexedClaudeSession(ctx.workspaceId, args.sessionId, args.limit, caller);
        } catch (error) {
          return refusal(error);
        }
        if (indexed.result) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ...(indexed.result as object), ...withheldReceipt(indexed.withheld) }) }] };
        }

        // The index is bounded; old sessions may only exist in the permanent
        // archive. This is best-effort because dev:claude_session remains a
        // local diagnostic surface and must retain its honest no-session error
        // when neither source can resolve the id.
        let archived: Awaited<ReturnType<typeof import('../../session-archive-read')['readArchivedSessionTurns']>> | null = null;
        try {
          const { readArchivedSessionTurns } = await import('../../session-archive-read');
          archived = await readArchivedSessionTurns(args.sessionId, 'claude');
        } catch {
          // Archive access is advisory; preserve the existing error envelope.
        }
        if (archived) {
          // D-006 applies to the archive too; a ledger failure refuses rather than serving it unfiltered.
          try {
            const { sql } = getOrgPg();
            const archivedOwner = archived.owner;
            const partitioned = await withholdReadTurns(sql, caller, archived.turns, (t) => [{ owner: t.owner ?? archivedOwner, at: t.ts }]);
            const result = archivedClaudeSession(args.sessionId, partitioned.kept, args.limit);
            return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, ...withheldReceipt(partitioned.withheld) }) }] };
          } catch (error) {
            return refusal(error);
          }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'no session found', sessionId: args.sessionId }) }], isError: true };
      }
      filePath = found.filePath;
    }
    const res = await readClaudeSession({ filePath, ...(args.limit ? { limit: args.limit } : {}) });
    if (!res) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'unreadable session file', filePath }) }], isError: true };
    }
    // D-006: a raw file read is a positional read of ONE session — withhold its
    // turns that fall inside the recording agent's disclosure windows.
    try {
      const { sql } = getOrgPg();
      const owners = await ownersOfTranscripts(sql, ctx.workspaceId, [{ sessionId: res.sessionId, filePath }]);
      const recorders = owners.get(filePath) ?? [null];
      const partitioned = await withholdReadTurns(sql, caller, res.turns, (t) => recorders.map((owner) => ({ owner, at: t.ts })));
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ...res, turns: partitioned.kept, ...withheldReceipt(partitioned.withheld) }),
        }],
      };
    } catch (error) {
      return refusal(error);
    }
  },
});
