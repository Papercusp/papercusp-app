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
import {
  listClaudeSessions,
  searchClaudeSessions,
  readClaudeSession,
  allClaudeSessionMetas,
} from '../../claude-sessions';

type IndexedClaudeTurn = {
  turn_idx: number;
  speaker: string;
  ts: string | null;
  text: string;
};

/**
 * The raw JSONL transcript is intentionally disposable: the archive/reconciler
 * can remove it while the indexed `session_turns` rows remain readable. Keep
 * `dev:claude_session` useful for those sessions too instead of making its
 * session-id lookup disagree with `sessions:read`.
 */
async function readIndexedClaudeSession(
  ctx: { workspaceId?: string; tx?: <T>(...args: unknown[]) => Promise<T> },
  sessionId: string,
  limit: number | undefined,
): Promise<ReturnType<typeof readClaudeSession> extends Promise<infer T> ? T : never> {
  if (!ctx.tx) return null as never;
  const maxTurns = Math.min(Math.max(limit ?? 200, 1), 2000);
  const workspaceId = ctx.workspaceId ?? 'default';
  const rows = await ctx.tx<IndexedClaudeTurn[]>`
    SELECT turn_idx, speaker, ts::text AS ts, left(text, 2000) AS text
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
       AND source_kind = 'claude'
       AND session_id = ${sessionId}
  ORDER BY turn_idx DESC
     LIMIT ${maxTurns + 1}
  `;
  if (!rows.length) return null as never;

  const truncated = rows.length > maxTurns;
  const selected = rows.slice(0, maxTurns).reverse();
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
    totalRecords: selected.length,
    turns,
    truncated,
  } as never;
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
  needsWorkspaceTx: true,
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

    if (op === 'search') {
      if (!args.query) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'query required for op=search' }) }], isError: true };
      }
      const res = await searchClaudeSessions({
        query: args.query,
        ...(args.cwd ? { cwd: args.cwd } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.maxFilesScanned ? { maxFilesScanned: args.maxFilesScanned } : {}),
        ...(args.perFileMaxBytes ? { perFileMaxBytes: args.perFileMaxBytes } : {}),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] };
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
        const indexed = await readIndexedClaudeSession(ctx, args.sessionId, args.limit);
        if (indexed) return { content: [{ type: 'text' as const, text: JSON.stringify(indexed) }] };

        // The index is bounded; old sessions may only exist in the permanent
        // archive. This is best-effort because dev:claude_session remains a
        // local diagnostic surface and must retain its honest no-session error
        // when neither source can resolve the id.
        try {
          const { readArchivedSessionTurns } = await import('../../session-archive-read');
          const archived = await readArchivedSessionTurns(args.sessionId, 'claude');
          if (archived) {
            const result = archivedClaudeSession(args.sessionId, archived.turns, args.limit);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          }
        } catch {
          // Archive access is advisory; preserve the existing error envelope.
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'no session found', sessionId: args.sessionId }) }], isError: true };
      }
      filePath = found.filePath;
    }
    const res = await readClaudeSession({ filePath, ...(args.limit ? { limit: args.limit } : {}) });
    if (!res) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'unreadable session file', filePath }) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] };
  },
});
