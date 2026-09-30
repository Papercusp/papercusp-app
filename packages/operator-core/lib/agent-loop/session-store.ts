/**
 * session-store — PG-backed session state for the owned agent loop's
 * engine:'loop' agent-chats lane (P-009, own-tui-full-divorce-2026-08-24;
 * table: migration 936).
 *
 * WHY: agent_chats.transcript persists TEXT turns only — the tool detail of a
 * loop turn (tool_call / tool_result ModelMessage parts) is gone by the next
 * turn, so resume previously replayed a lossy text-only history
 * (chat-engine.ts transcriptToMessages). This store keeps the FULL
 * ModelMessage[] working set per chat: the next turn replays exactly what the
 * model saw, tool calls included. It doubles as the loop lane's invocation
 * ledger (turn_count / model / totals — nothing is spawned, so
 * spawned_agents never sees loop turns).
 *
 * FRESHNESS ANCHOR: `transcriptTurns` records the agent_chats.transcript
 * length this row was saved against (baseTranscript + the assistant turn the
 * route persists). On load, chat-engine compares it with the live transcript
 * length; a mismatch means another lane (legacy CLI-spawn) or a failed
 * route-persist advanced/diverged the chat, and the engine falls back to the
 * text rebuild instead of replaying a stale session. Degradation is
 * self-healing: the next successful loop turn re-anchors the row.
 *
 * COST HONESTY (@papercusp/model-pricing rule): a turn whose model has no
 * price row increments `unpricedTurns` instead of adding a fabricated $0 to
 * `costUsd` — a nonzero unpricedTurns marks the total as a floor, not a fact.
 *
 * Stored tool_result payloads are clamped (STORE_RESULT_MAX_CHARS) so one
 * monster tool output cannot balloon the row: the model already consumed the
 * full result live; on resume it sees a truncated preview marker — the same
 * degrade shape as the wire clamp (chat-engine.ts clampForWire).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { ModelMessage, ModelUsage } from './model-port';

/** Stored copy of one tool_result content is clamped at this many JSON chars. */
export const STORE_RESULT_MAX_CHARS = 16_384;

export interface LoopSessionTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Sum over PRICED turns only — see unpricedTurns. */
  costUsd: number;
  /** Turns whose model had no price row (cost unknown, never $0-guessed). */
  unpricedTurns: number;
}

export interface LoopSessionRow {
  workspaceId: string;
  chatId: string;
  /** The post-compaction ModelMessage working set the next turn replays. */
  messages: ModelMessage[];
  /** Summary of the `compactedCount` original messages folded out, if any. */
  summary: string | null;
  compactedCount: number;
  /** agent_chats.transcript length this row was saved against. */
  transcriptTurns: number;
  model: string | null;
  turnCount: number;
  totals: LoopSessionTotals;
}

export interface SaveLoopSessionTurnArgs {
  chatId: string;
  workspaceId: string;
  /** FULL working set after this turn (post-compaction) — replaces stored. */
  messages: ModelMessage[];
  /** Current cumulative summary (null/undefined = none). */
  summary?: string | null;
  /** Total original messages the summary now covers (absolute, not a delta). */
  compactedCount?: number;
  /** Expected agent_chats.transcript length after the route persists. */
  transcriptTurns: number;
  model: string;
  /** THIS turn's usage (accumulated into totals server-side). */
  usage: ModelUsage;
  /** False when the model had no price row — usage.costUsd is then ignored
   *  and the turn counts into unpriced_turn_count. */
  priced: boolean;
}

/** The injectable seam chat-engine consumes (PG default; tests fake it). */
export interface LoopSessionStore {
  load(args: { chatId: string; workspaceId: string }): Promise<LoopSessionRow | null>;
  saveTurn(args: SaveLoopSessionTurnArgs): Promise<void>;
}

function db(opts: { sql?: Sql }): Sql {
  return opts.sql ?? getOrgPg().sql;
}

/** Clamp tool_result parts for the STORED copy only (row-size guard). Pure. */
export function clampMessagesForStore(
  messages: ModelMessage[],
  maxChars: number = STORE_RESULT_MAX_CHARS,
): ModelMessage[] {
  return messages.map((m) => ({
    ...m,
    content: m.content.map((p) => {
      if (p.type !== 'tool_result') return p;
      let json: string;
      try {
        json = JSON.stringify(p.content) ?? 'null';
      } catch {
        json = String(p.content);
      }
      if (json.length <= maxChars) return p;
      return {
        ...p,
        content: { truncated: true, fullChars: json.length, preview: json.slice(0, maxChars) },
      };
    }),
  }));
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export async function loadLoopSession(
  args: { chatId: string; workspaceId: string },
  opts: { sql?: Sql } = {},
): Promise<LoopSessionRow | null> {
  const sql = db(opts);
  const rows = await sql<
    Array<{
      workspace_id: string;
      chat_id: string;
      messages: unknown;
      summary: string | null;
      compacted_count: number;
      transcript_turns: number;
      model: string | null;
      turn_count: number;
      total_input_tokens: string | number;
      total_output_tokens: string | number;
      total_cache_read_tokens: string | number;
      total_cache_creation_tokens: string | number;
      total_cost_usd: string | number;
      unpriced_turn_count: number;
    }>
  >`
    SELECT workspace_id, chat_id, messages, summary, compacted_count,
           transcript_turns, model, turn_count,
           total_input_tokens, total_output_tokens,
           total_cache_read_tokens, total_cache_creation_tokens,
           total_cost_usd, unpriced_turn_count
      FROM harness_shared.agent_loop_sessions
     WHERE workspace_id = ${args.workspaceId}
       AND chat_id = ${args.chatId}`;
  const r = rows[0];
  if (!r) return null;
  const messages = Array.isArray(r.messages)
    ? (r.messages as ModelMessage[])
    : typeof r.messages === 'string'
      ? (JSON.parse(r.messages) as ModelMessage[])
      : [];
  return {
    workspaceId: r.workspace_id,
    chatId: r.chat_id,
    messages,
    summary: r.summary,
    compactedCount: r.compacted_count,
    transcriptTurns: r.transcript_turns,
    model: r.model,
    turnCount: r.turn_count,
    totals: {
      inputTokens: num(r.total_input_tokens),
      outputTokens: num(r.total_output_tokens),
      cacheReadTokens: num(r.total_cache_read_tokens),
      cacheCreationTokens: num(r.total_cache_creation_tokens),
      costUsd: num(r.total_cost_usd),
      unpricedTurns: r.unpriced_turn_count,
    },
  };
}

/**
 * Upsert one turn: messages/summary/anchor REPLACE, usage totals ACCUMULATE,
 * turn_count increments. Stored messages are clamped (row-size guard).
 */
export async function saveLoopSessionTurn(
  args: SaveLoopSessionTurnArgs,
  opts: { sql?: Sql } = {},
): Promise<void> {
  const sql = db(opts);
  let messagesJson: string;
  try {
    messagesJson = JSON.stringify(clampMessagesForStore(args.messages)) ?? '[]';
  } catch {
    // A non-serializable part slipped past the loop's own toResultContent
    // guard: degrade to an empty working set (next load's rebuild path
    // recovers from the text transcript) rather than failing the save.
    messagesJson = '[]';
  }
  const u = args.usage;
  const pricedCost = args.priced ? (u.costUsd ?? 0) : 0;
  const unpricedDelta = args.priced ? 0 : 1;
  await sql`
    INSERT INTO harness_shared.agent_loop_sessions
      (workspace_id, chat_id, messages, message_count, summary, compacted_count,
       transcript_turns, model, turn_count,
       total_input_tokens, total_output_tokens,
       total_cache_read_tokens, total_cache_creation_tokens,
       total_cost_usd, unpriced_turn_count, updated_at)
    VALUES
      (${args.workspaceId}, ${args.chatId}, ${messagesJson}::jsonb,
       ${args.messages.length}, ${args.summary ?? null}, ${args.compactedCount ?? 0},
       ${args.transcriptTurns}, ${args.model}, 1,
       ${u.inputTokens}, ${u.outputTokens},
       ${u.cacheReadTokens ?? 0}, ${u.cacheCreationTokens ?? 0},
       ${pricedCost}, ${unpricedDelta}, now())
    ON CONFLICT (workspace_id, chat_id) DO UPDATE SET
      messages                    = EXCLUDED.messages,
      message_count               = EXCLUDED.message_count,
      summary                     = EXCLUDED.summary,
      compacted_count             = EXCLUDED.compacted_count,
      transcript_turns            = EXCLUDED.transcript_turns,
      model                       = EXCLUDED.model,
      turn_count                  = harness_shared.agent_loop_sessions.turn_count + 1,
      total_input_tokens          = harness_shared.agent_loop_sessions.total_input_tokens + EXCLUDED.total_input_tokens,
      total_output_tokens         = harness_shared.agent_loop_sessions.total_output_tokens + EXCLUDED.total_output_tokens,
      total_cache_read_tokens     = harness_shared.agent_loop_sessions.total_cache_read_tokens + EXCLUDED.total_cache_read_tokens,
      total_cache_creation_tokens = harness_shared.agent_loop_sessions.total_cache_creation_tokens + EXCLUDED.total_cache_creation_tokens,
      total_cost_usd              = harness_shared.agent_loop_sessions.total_cost_usd + EXCLUDED.total_cost_usd,
      unpriced_turn_count         = harness_shared.agent_loop_sessions.unpriced_turn_count + EXCLUDED.unpriced_turn_count,
      updated_at                  = now()`;
}

/** The default PG-backed store chat-engine wires when none is injected. */
export function pgLoopSessionStore(opts: { sql?: Sql } = {}): LoopSessionStore {
  return {
    load: (args) => loadLoopSession(args, opts),
    saveTurn: (args) => saveLoopSessionTurn(args, opts),
  };
}

/** Test-only — drop every session row (isolate suites sharing this table). */
export async function __resetLoopSessions(opts: { sql?: Sql } = {}): Promise<void> {
  try {
    await db(opts)`DELETE FROM harness_shared.agent_loop_sessions`;
  } catch {
    /* best-effort test helper */
  }
}
