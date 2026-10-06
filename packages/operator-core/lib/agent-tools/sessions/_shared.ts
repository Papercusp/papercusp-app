/**
 * Shared helpers for the sessions:* tool group (session-search-scope-2026-07-05
 * P-005/P-006). The corpus is harness_shared.session_turns (see
 * search/session-ingest.ts); these tools are the NAVIGATION verbs over it —
 * search stays in search:* / sessions:search per D-001/D-002 (corpus vs filter
 * vs fused-composition taxonomy).
 */

import type { Sql } from 'postgres';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { withBoundedTimeout } from '../../bounded-timeout';

export const SESSION_SOURCE_KINDS = ['claude', 'omp', 'codex', 'agent_chat'] as const;
export const SESSION_TURN_REF_PREFIX = 'session_turn:';
/**
 * Keep read-time freshness below the MCP transport deadline. The ingest work
 * itself is not cancellable, but a slow refresh must never hold the indexed
 * read (or its archive fallback) hostage.
 */
export const SESSION_READ_REFRESH_TIMEOUT_MS = 5_000;
// Compatibility name retained for callers/tests that specifically exercise
// the explicit-target path.
export const SESSION_TARGET_REFRESH_TIMEOUT_MS = SESSION_READ_REFRESH_TIMEOUT_MS;
export type SessionSourceKind = (typeof SESSION_SOURCE_KINDS)[number];

export type SessionRefreshFailureReason =
  | 'owner_lookup_timeout'
  | 'owner_lookup_aborted'
  | 'owner_lookup_error'
  | 'resolve_timeout'
  | 'resolve_aborted'
  | 'resolve_error'
  | 'transcript_unavailable'
  | 'ingest_timeout'
  | 'ingest_aborted'
  | 'ingest_error';

export interface SessionRefreshReceipt {
  attempted: number;
  refreshed: number;
  /** Aggregated, anonymized failure categories; never includes owner/session ids or raw errors. */
  failureReasons?: Partial<Record<SessionRefreshFailureReason, number>>;
}

function failedSessionRefresh(reason: SessionRefreshFailureReason): SessionRefreshReceipt {
  return { attempted: 1, refreshed: 0, failureReasons: { [reason]: 1 } };
}

function boundedFailureReason(
  stage: 'owner_lookup' | 'resolve' | 'ingest',
  reason: 'timeout' | 'aborted' | 'error' | undefined,
): SessionRefreshFailureReason {
  return `${stage}_${reason ?? 'error'}` as SessionRefreshFailureReason;
}

export interface SessionSelector {
  sessionId: string;
  sourceKind?: SessionSourceKind;
}

/**
 * Resolve a session time-window bound at the tool boundary. Relative windows
 * are convenient for agents (for example, "45m" or "7d"), but PostgreSQL's
 * timestamptz parser only accepts absolute timestamps. Keep this shared so all
 * sessions:* readers apply the same contract before binding SQL values.
 */
const RELATIVE_WINDOW_RE = /^\s*(\d+)\s*([smhd])\s*$/i;
const RELATIVE_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function normalizeWindowBound(
  value: string | undefined,
  field: 'since' | 'until',
): { iso?: string; error?: string } {
  if (value === undefined) return {};
  const rel = RELATIVE_WINDOW_RE.exec(value);
  if (rel) {
    const ms = Number(rel[1]) * RELATIVE_UNIT_MS[rel[2].toLowerCase() as keyof typeof RELATIVE_UNIT_MS];
    return { iso: new Date(Date.now() - ms).toISOString() };
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return {
      error: `${field} must be an ISO-8601 timestamp or a relative window like "45m", "12h", "7d" (got ${JSON.stringify(value)})`,
    };
  }
  return { iso: d.toISOString() };
}

/**
 * Normalize the two session selector shapes exposed by sessions:list:
 * `session_id` on its own, or the convenient `<source_kind>:<session_id>`
 * form callers commonly build from a list row. A native session id may itself
 * contain colons, so only a known source-kind prefix is consumed.
 */
export function parseSessionSelector(
  sessionIdOrSelector: string,
  sourceKind?: SessionSourceKind,
): SessionSelector {
  const separator = sessionIdOrSelector.indexOf(':');
  if (separator > 0) {
    const prefix = sessionIdOrSelector.slice(0, separator);
    if ((SESSION_SOURCE_KINDS as readonly string[]).includes(prefix)) {
      const sessionId = sessionIdOrSelector.slice(separator + 1);
      if (sessionId) {
        return { sessionId, sourceKind: sourceKind ?? (prefix as SessionSourceKind) };
      }
    }
  }
  return { sessionId: sessionIdOrSelector, sourceKind };
}

export interface SessionTurnRef {
  sourceKind: SessionSourceKind;
  sessionId: string;
  turnIdx: number;
}

/** Canonical, directly-readable reference to one indexed transcript turn. */
export function formatSessionTurnRef(sourceKind: string, sessionId: string, turnIdx: number): string {
  return `${SESSION_TURN_REF_PREFIX}${sourceKind}:${sessionId}:${turnIdx}`;
}

/** Fail-open flag read — the flag's default is ON. */
export async function sessionSearchEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.SESSION_SEARCH, 'system:sessions-tools');
  } catch {
    return true;
  }
}

export function disabledResult(): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ ok: false, error: 'feature_disabled', note: 'SESSION_SEARCH flag is off.' }),
    }],
    isError: true,
  };
}

export interface WindowTurn {
  ref: string;
  turn_idx: number;
  speaker: string;
  ts: string | null;
  text: string;
}

interface LiveRefreshDeps {
  resolve?: (ownerId: string) => Promise<{ filePath: string; sessionId: string } | null>;
  ingest?: (filePath: string, opts: { owner: string; sessionId: string }) => Promise<unknown>;
}

interface TargetSessionRow {
  id: number;
  agent: string | null;
  owner: string | null;
  session_id: string | null;
  omp_thread_id: string | null;
}

interface TargetRefreshDeps {
  resolve?: (
    sourceKind: string,
    sessionId: string,
    row: TargetSessionRow,
  ) => Promise<{ filePath: string; sessionId: string } | null>;
  ingest?: (filePath: string, opts: { owner: string; sessionId: string }) => Promise<unknown>;
}

interface ResolvedTranscript {
  filePath: string;
  sessionId: string;
}

/**
 * Ingest one already-resolved transcript without allowing filesystem work to
 * hold a sessions read past its transport budget. The ingest promise is not
 * cancellable, so it may finish in the background; the caller proceeds with
 * the indexed/archive view and records the degraded refresh via the receipt.
 */
export async function refreshResolvedSessionBeforeRead(
  target: ResolvedTranscript,
  owner: string,
  deps: Pick<TargetRefreshDeps, 'ingest'> = {},
  label = 'sessions:live refresh',
): Promise<SessionRefreshReceipt> {
  const ingest = deps.ingest ?? (await import('../../search/session-ingest')).ingestFileNow;
  const refresh = await withBoundedTimeout(
    () => ingest(target.filePath, { owner, sessionId: target.sessionId }),
    {
      fallback: undefined,
      timeoutMs: SESSION_READ_REFRESH_TIMEOUT_MS,
      label,
    },
  );
  if (refresh.degraded) return failedSessionRefresh(boundedFailureReason('ingest', refresh.reason));
  return { attempted: 1, refreshed: 1 };
}

async function resolveTargetSessionTranscript(
  sourceKind: string,
  sessionId: string,
  row: TargetSessionRow,
): Promise<{ filePath: string; sessionId: string } | null> {
  if (!row.owner) return null;

  if (sourceKind === 'claude') {
    const { findSessionTranscript } = await import('../../claude-sessions');
    const filePath = await findSessionTranscript(sessionId, { owner: row.owner });
    return filePath ? { filePath, sessionId } : null;
  }

  if (sourceKind === 'omp') {
    const { findOmpSessionPath } = await import('../../session-transcript-resolvers');
    const threadId = row.omp_thread_id ?? sessionId;
    const filePath = await findOmpSessionPath(threadId, { sessionKey: row.id });
    return filePath ? { filePath, sessionId } : null;
  }

  if (sourceKind === 'codex') {
    const [{ findCodexRolloutPathByUuid }, { codexHomeForSessionKey }] = await Promise.all([
      import('../../session-transcript-resolvers'),
      import('@papercusp/orchestrator/session-launch-dirs'),
    ]);
    const filePath = await findCodexRolloutPathByUuid(sessionId, {
      homeOverride: codexHomeForSessionKey(row.id),
    });
    return filePath ? { filePath, sessionId } : null;
  }

  return null;
}

/**
 * Refresh one explicitly requested live session immediately before reading its
 * indexed turns. Historical sessions deliberately skip this path, leaving the
 * existing index/archive behavior unchanged. The active adv_sessions lookup is
 * tenant-independent for the same reason as the owner fallback in sessions:list:
 * adv_sessions is tenant-keyed while the transcript corpus is stored in the
 * shared/default namespace.
 */
export async function refreshTargetSessionBeforeRead(
  sql: Sql,
  sourceKind: string | null | undefined,
  sessionId: string,
  deps: TargetRefreshDeps = {},
): Promise<SessionRefreshReceipt> {
  if (!sessionId || sourceKind === 'agent_chat') return { attempted: 0, refreshed: 0 };

  const rows = await sql<TargetSessionRow[]>`
    SELECT id, agent, coord_owner_id AS owner, session_id, omp_thread_id
      FROM harness_shared.adv_sessions
     WHERE ended_at IS NULL
       AND coord_owner_id IS NOT NULL
       AND (${sourceKind ?? null}::text IS NULL OR agent = ${sourceKind ?? null})
       AND (
         session_id = ${sessionId}
         OR (agent = 'omp' AND omp_thread_id = ${sessionId})
       )
  ORDER BY started_at DESC
     LIMIT 1
  `;
  const row = rows[0];
  if (!row?.agent || !row.owner) return { attempted: 0, refreshed: 0 };

  const resolve = deps.resolve ?? resolveTargetSessionTranscript;
  const resolved = await withBoundedTimeout(
    () => resolve(row.agent!, sessionId, row),
    {
      fallback: null,
      timeoutMs: SESSION_READ_REFRESH_TIMEOUT_MS,
      label: 'sessions:read target resolve',
    },
  );
  if (resolved.degraded) return failedSessionRefresh(boundedFailureReason('resolve', resolved.reason));
  const target = resolved.value;
  if (!target) return failedSessionRefresh('transcript_unavailable');

  return refreshResolvedSessionBeforeRead(
    target,
    row.owner,
    { ingest: deps.ingest },
    'sessions:read target refresh',
  );
}

/**
 * Bring open Codex sessions into the indexed corpus immediately before a read.
 * Archive ingestion is intentionally not a freshness boundary: an active
 * session may not have reached either the periodic sweep or archive-at-death.
 * The owner set is bounded and refreshed concurrently to avoid a serial FS
 * walk on the unfiltered sessions:list path.
 */
export async function refreshLiveSessionsBeforeRead(
  sql: Sql,
  owners?: readonly string[] | null,
  deps: LiveRefreshDeps = {},
): Promise<SessionRefreshReceipt> {
  let ownerIds = [...new Set((owners ?? []).filter(Boolean))].slice(0, 20);
  let ownerLookupFailure: SessionRefreshFailureReason | undefined;
  if (ownerIds.length === 0) {
    const ownerRead = await withBoundedTimeout<Array<{ owner: string }>>(
      sql<Array<{ owner: string }>>`
        SELECT DISTINCT coord_owner_id AS owner
          FROM harness_shared.adv_sessions
         WHERE ended_at IS NULL
           AND agent = 'codex'
           AND coord_owner_id IS NOT NULL
         ORDER BY coord_owner_id
         LIMIT 20`,
      {
        fallback: [],
        timeoutMs: SESSION_READ_REFRESH_TIMEOUT_MS,
        label: 'sessions:live owner lookup',
      },
    );
    ownerIds = ownerRead.value.map((row) => row.owner);
    if (ownerRead.degraded) {
      ownerLookupFailure = boundedFailureReason('owner_lookup', ownerRead.reason);
    }
  }
  if (ownerIds.length === 0) {
    return ownerLookupFailure
      ? { attempted: 0, refreshed: 0, failureReasons: { [ownerLookupFailure]: 1 } }
      : { attempted: 0, refreshed: 0 };
  }

  const resolve = deps.resolve ?? (await import('../../search/self-session')).resolveSelfSession;
  const results = await Promise.all(ownerIds.map(async (owner): Promise<SessionRefreshReceipt> => {
    const resolved = await withBoundedTimeout(
      () => resolve(owner),
      {
        fallback: null,
        timeoutMs: SESSION_READ_REFRESH_TIMEOUT_MS,
        label: 'sessions:live resolve',
      },
    );
    if (resolved.degraded) return failedSessionRefresh(boundedFailureReason('resolve', resolved.reason));
    if (!resolved.value) return failedSessionRefresh('transcript_unavailable');
    return refreshResolvedSessionBeforeRead(
      resolved.value,
      owner,
      { ingest: deps.ingest },
      'sessions:live refresh',
    );
  }));
  const failureReasons: NonNullable<SessionRefreshReceipt['failureReasons']> = {};
  for (const result of results) {
    for (const [reason, count] of Object.entries(result.failureReasons ?? {})) {
      const key = reason as SessionRefreshFailureReason;
      failureReasons[key] = (failureReasons[key] ?? 0) + (count ?? 0);
    }
  }
  return {
    attempted: ownerIds.length,
    refreshed: results.reduce((total, result) => total + result.refreshed, 0),
    ...(Object.keys(failureReasons).length > 0 ? { failureReasons } : {}),
  };
}

/**
 * A window turn plus the two fields the D-006 transcript exclusion decides on
 * (personal-vault/transcript-exclusion.ts). `owner`/`at` are for that decision
 * only — strip them with `toWindowTurn` before a window leaves the tool.
 */
export interface StampedWindowTurn extends WindowTurn {
  owner: string | null;
  at: string | null;
}

export function toWindowTurn({ owner: _owner, at: _at, ...turn }: StampedWindowTurn): WindowTurn {
  return turn;
}

/** ±context turns around one hit (per-turn text bounded for token economy). */
export async function hydrateWindow(
  sql: Sql,
  workspaceId: string,
  sourceKind: string,
  sessionId: string,
  aroundIdx: number,
  context: number,
  perTurnChars = 700,
): Promise<StampedWindowTurn[]> {
  const lo = Math.max(0, aroundIdx - context);
  const hi = aroundIdx + context;
  const rows = await sql<Array<{ turn_idx: number; speaker: string; ts: string | null; text: string; owner: string | null; at: string | null }>>`
    SELECT turn_idx, speaker, ts::text AS ts, left(text, ${perTurnChars}) AS text,
           owner, COALESCE(ts, ingested_at)::text AS at
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
       AND source_kind = ${sourceKind} AND session_id = ${sessionId}
       AND turn_idx BETWEEN ${lo} AND ${hi}
  ORDER BY turn_idx
  `;
  return rows.map((row) => ({
    ref: formatSessionTurnRef(sourceKind, sessionId, row.turn_idx),
    ...row,
    owner: row.owner ?? null,
    at: row.at ?? row.ts ?? null,
  }));
}

/**
 * Owner and record time of specific indexed turns, keyed by
 * `formatSessionTurnRef`. Hybrid search hits carry neither, and the D-006
 * transcript exclusion needs both. A turn absent from the index is absent from
 * the map, which the exclusion treats as unattributed.
 */
export async function loadTurnStamps(
  sql: Sql,
  workspaceId: string,
  keys: ReadonlyArray<{ sourceKind: string; sessionId: string; turnIdx: number }>,
): Promise<Map<string, { owner: string | null; at: string | null }>> {
  const out = new Map<string, { owner: string | null; at: string | null }>();
  if (keys.length === 0) return out;
  const rows = await sql<Array<{ source_kind: string; session_id: string; turn_idx: number; owner: string | null; at: string | null }>>`
    SELECT t.source_kind, t.session_id, t.turn_idx, t.owner, COALESCE(t.ts, t.ingested_at)::text AS at
      FROM harness_shared.session_turns t
      JOIN unnest(${keys.map((k) => k.sourceKind)}::text[], ${keys.map((k) => k.sessionId)}::text[], ${keys.map((k) => k.turnIdx)}::int[])
           AS k(source_kind, session_id, turn_idx)
        ON t.source_kind = k.source_kind AND t.session_id = k.session_id AND t.turn_idx = k.turn_idx
     WHERE (t.workspace_id = ${workspaceId} OR t.workspace_id = 'default')
  `;
  for (const row of rows) {
    out.set(formatSessionTurnRef(row.source_kind, row.session_id, row.turn_idx), { owner: row.owner ?? null, at: row.at ?? null });
  }
  return out;
}

/**
 * Parse either the search engine's compact source_id
 * (`<source_kind>:<session_id>:<turn_idx>`) or the public canonical reference
 * (`session_turn:<source_kind>:<session_id>:<turn_idx>`). Session ids may
 * themselves contain `:`, so the first/last separators are load-bearing.
 */
export function parseTurnRef(sourceIdOrRef: string): SessionTurnRef | null {
  const sourceId = sourceIdOrRef.startsWith(SESSION_TURN_REF_PREFIX)
    ? sourceIdOrRef.slice(SESSION_TURN_REF_PREFIX.length)
    : sourceIdOrRef;
  const first = sourceId.indexOf(':');
  const last = sourceId.lastIndexOf(':');
  if (first < 0 || last <= first) return null;
  const turnIdx = Number(sourceId.slice(last + 1));
  const sourceKind = sourceId.slice(0, first);
  const sessionId = sourceId.slice(first + 1, last);
  if (!Number.isInteger(turnIdx) || turnIdx < 0 || !sessionId || !isSessionSourceKind(sourceKind)) {
    return null;
  }
  return { sourceKind, sessionId, turnIdx };
}

function isSessionSourceKind(value: string): value is SessionSourceKind {
  return (SESSION_SOURCE_KINDS as readonly string[]).includes(value);
}

export interface SessionTurnRefResolution {
  ref: string;
  ok: boolean;
  source?: 'index' | 'archive';
  reason?: 'invalid_ref' | 'not_found';
}

interface ResolveTurnRefsDeps {
  refresh?: typeof refreshTargetSessionBeforeRead;
  readArchive?: (
    sessionId: string,
    sourceKind?: 'claude' | 'codex' | 'omp',
  ) => Promise<{
    sourceKind: 'claude' | 'codex' | 'omp';
    turns: Array<{ turn_idx: number }>;
  } | null>;
}

/**
 * Resolve canonical session-turn refs against the same two stores as
 * sessions:read: the bounded live index first, then the permanent archive.
 * Active sessions are refreshed best-effort before the index query. The audit
 * writer uses this at its write boundary so every persisted source ref is
 * directly readable rather than merely well-shaped.
 */
export async function resolveSessionTurnRefs(
  sql: Sql,
  workspaceId: string,
  refs: readonly string[],
  deps: ResolveTurnRefsDeps = {},
): Promise<SessionTurnRefResolution[]> {
  const uniqueRefs = [...new Set(refs)];
  const parsed = uniqueRefs.map((ref) => ({ ref, parsed: parseTurnRef(ref) }));
  const valid = parsed.filter(
    (entry): entry is { ref: string; parsed: SessionTurnRef } => entry.parsed !== null,
  );

  const refresh = deps.refresh ?? refreshTargetSessionBeforeRead;
  const sessions = new Map<string, SessionTurnRef>();
  for (const entry of valid) {
    sessions.set(`${entry.parsed.sourceKind}\u0000${entry.parsed.sessionId}`, entry.parsed);
  }
  await Promise.all(
    [...sessions.values()].map(async (target) => {
      try {
        await refresh(sql, target.sourceKind, target.sessionId);
      } catch {
        // Read-time freshness is best-effort, exactly as sessions:read; the
        // already-indexed row and archive fallback remain authoritative.
      }
    }),
  );

  const wanted = valid.map(({ ref, parsed: turn }) => ({
    ref,
    sourceKind: turn.sourceKind,
    sessionId: turn.sessionId,
    turnIdx: turn.turnIdx,
  }));
  const indexed = wanted.length === 0
    ? []
    : await sql<Array<{ ref: string }>>`
        WITH wanted AS (
          SELECT *
            FROM jsonb_to_recordset(${JSON.stringify(wanted)}::text::jsonb) AS w(
              ref text, "sourceKind" text, "sessionId" text, "turnIdx" integer
            )
        )
        SELECT w.ref
          FROM wanted w
         WHERE EXISTS (
           SELECT 1
             FROM harness_shared.session_turns t
            WHERE (t.workspace_id = ${workspaceId} OR t.workspace_id = 'default')
              AND t.source_kind = w."sourceKind"
              AND t.session_id = w."sessionId"
              AND t.turn_idx = w."turnIdx"
         )`;
  const found = new Map<string, 'index' | 'archive'>(
    indexed.map((row) => [row.ref, 'index' as const]),
  );

  const missingBySession = new Map<string, typeof wanted>();
  for (const entry of wanted) {
    if (found.has(entry.ref)) continue;
    const key = `${entry.sourceKind}\u0000${entry.sessionId}`;
    const group = missingBySession.get(key) ?? [];
    group.push(entry);
    missingBySession.set(key, group);
  }

  const readArchive = deps.readArchive ?? (await import('../../session-archive-read')).readArchivedSessionTurns;
  await Promise.all(
    [...missingBySession.values()].map(async (group) => {
      const first = group[0];
      if (!first || !['claude', 'codex', 'omp'].includes(first.sourceKind)) return;
      try {
        const archive = await readArchive(
          first.sessionId,
          first.sourceKind as 'claude' | 'codex' | 'omp',
        );
        if (!archive || archive.sourceKind !== first.sourceKind) return;
        const turns = new Set(archive.turns.map((turn) => turn.turn_idx));
        for (const entry of group) {
          if (turns.has(entry.turnIdx)) found.set(entry.ref, 'archive');
        }
      } catch {
        // Absence/unreadability is reported uniformly as not_found below.
      }
    }),
  );

  return parsed.map(({ ref, parsed: turn }) => {
    if (!turn) return { ref, ok: false, reason: 'invalid_ref' };
    const source = found.get(ref);
    return source
      ? { ref, ok: true, source }
      : { ref, ok: false, reason: 'not_found' };
  });
}
