/**
 * Agent-chats read/write API (non-streaming subset). Function-of-truth
 * for both the hono routes at /api/harness/:slug/agent-chats* and the
 * agent_chats:* MCP tools.
 *
 * The streaming POST (append message + SSE reply) stays in the hono
 * route file — bidirectional streams aren't projection-shaped.
 */

import { randomUUID } from 'node:crypto';
import { harnessQuery } from '@papercusp/db-org';
import {
  projectChatFailureTranscript,
  type ChatModelFailureCode,
} from './chat-model-failure';
import { getKnownRoles } from './known-roles';
import { activeWorkspaceId } from './workspace-registry';

export interface TranscriptToolCall {
  name: string;
  input?: unknown;
  /**
   * For interactive tools (chat:ask_choice etc.), the user's
   * response. Unified picks[] shape — length 1 for single-select,
   * ≥1 for multi-select. Mirrors operator_turns.tools so the same
   * React components render both surfaces.
   */
  answered?: {
    picks: Array<{ option_id: string; label: string }>;
    at: number;
  };
}

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
  /** Execution provenance for native-loop assistant turns. Optional for legacy
   * transcript rows written before the owned loop existed. */
  engine?: string;
  /** Exact resolved model spec, including any explicit effort suffix. */
  model?: string;
  /** Gateway route used for the turn: `auto`, `default`, or a pinned account. */
  account_route?: string;
  /** Account that actually served the turn, from the gateway response header.
   * Distinct from account_route, which records only the requested route. */
  account_served?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_cents?: number;
  /**
   * Tool calls that fired during this turn (e.g. chat:ask_choice).
   * Persisted inside the parent agent_chats.transcript jsonb column —
   * no schema migration needed since transcript was already jsonb.
   */
  tools?: TranscriptToolCall[];
  /**
   * Marks an assistant turn that FAILED (rate-limit, backend error, dispatch
   * error) instead of producing a reply. New rows keep a safe sentence in
   * `content`; actionable failure details use stable fields below.
   * Persisted so a reload / second viewer sees the failure instead of a silent
   * gap (the live sender also gets the inline error banner). jsonb — no migration.
   */
  error?: boolean;
  /** Stable viewer-safe failure classification; never raw backend prose. */
  code?: ChatModelFailureCode;
  /** Provider-named account reset instant, when known. */
  resetAt?: number;
  /** Backend retry delay, when known. */
  retryAfterMs?: number;
  /** Number of terminal usage frames whose cost/token fields were absent. */
  unreportedFrames?: number;
  /** Stable idempotency key for a server-to-server external turn (P-010). */
  source_id?: string;
  /** Origin of a server-to-server turn; never accepted from browser chat routes. */
  source?: 'phone-livekit' | 'su-session';
}

/**
 * Which dispatch policy a PUI conversation was CREATED under — its permanent home,
 * not its current live state (pui-su-session-runtime-correction-2026-08-27 P-011).
 *
 * `'su-session'` was created after the cutover, so the canonical SU-session host is
 * where its turns belong. `'legacy-owned-loop'` was created under the pre-cutover
 * PUI-owned agent loop (or while the kill-switch was OFF) and must never be
 * re-homed onto an SU session — that would change an existing conversation's
 * identity and backend, which is exactly what P-011 forbids.
 *
 * `null` means UNCLASSIFIED: a row written by a pre-cutover writer that migration
 * 1023 did not reach. Readers surface it as unknown; nobody assumes a policy.
 */
export type PuiSessionRuntimeClass = 'su-session' | 'legacy-owned-loop';

export const PUI_SESSION_RUNTIME_CLASSES: readonly PuiSessionRuntimeClass[] = [
  'su-session',
  'legacy-owned-loop',
];

/**
 * Narrow a stored `su_runtime_class` value. Anything not one of the two legal
 * classes — including an empty string a loose writer might leave behind — reads as
 * UNCLASSIFIED rather than being coerced into a plausible-looking policy.
 */
export function toPuiSessionRuntimeClass(v: unknown): PuiSessionRuntimeClass | null {
  return typeof v === 'string' && (PUI_SESSION_RUNTIME_CLASSES as readonly string[]).includes(v)
    ? (v as PuiSessionRuntimeClass)
    : null;
}

export interface ChatRow {
  id: string;
  role: string;
  feature_id: string | null;
  title: string | null;
  /** @see PuiSessionRuntimeClass — null means unclassified, never "assume legacy". */
  su_runtime_class: PuiSessionRuntimeClass | null;
  /** Source chat for an explicit Continue-in-new-session operation. */
  continued_from_chat_id: string | null;
  /** Prefix length copied from that source; null on ordinary sessions. */
  continued_from_turn_count: number | null;
  transcript: TranscriptTurn[];
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd_cents: number;
  /** True only when every assistant turn supplied token and cost readings. */
  usage_complete: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/**
 * A list-row projection of ChatRow that OMITS the heavy `transcript` jsonb
 * body — a forever-growing per-chat blob — and carries only its length as
 * `turn_count`. The list never needs the bodies: the MCP `agent_chats:list`
 * tool directs transcript reads to `agent_chats:get`, and the cross-harness
 * fan-out in agents-list only reads role + updated_at. Selecting `turn_count`
 * server-side instead of every full transcript is the F-C1 "select needed
 * columns" fix (it mirrors the admin comms rollup's
 * `jsonb_array_length(transcript) AS turns`), and it matters most under the
 * F-C2 fan-out where this list is hit once per harness.
 */
export interface ChatSummary {
  id: string;
  role: string;
  feature_id: string | null;
  title: string | null;
  /** @see PuiSessionRuntimeClass — null means unclassified, never "assume legacy". */
  su_runtime_class: PuiSessionRuntimeClass | null;
  continued_from_chat_id: string | null;
  continued_from_turn_count: number | null;
  turn_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd_cents: number;
  /** True only when every assistant turn supplied token and cost readings. */
  usage_complete: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface FeatureLockState {
  taken_by: string | null;
  taken_at: string | null;
  expires_at: string | null;
  active: boolean;
}

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

const FEATURE_ID_RE = /^[A-Z][A-Z0-9_-]*[A-Z0-9]$/i;

export function isValidChatRole(role: string): boolean {
  return getKnownRoles().includes(role);
}

/**
 * Coerce an epoch-millisecond timestamp (bigint | number | numeric-string, as
 * postgres-js may return int8) to an ISO string, preserving the ChatRow API
 * contract. agent_chats consolidated stores bigint epoch-ms (the consolidation
 * standard); the per-harness timestamptz columns were retired in migration 116.
 */
function msToIso(v: unknown): string {
  if (v == null) return '';
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '';
  return new Date(n).toISOString();
}
function msToIsoNullable(v: unknown): string | null {
  if (v == null) return null;
  const iso = msToIso(v);
  return iso === '' ? null : iso;
}

export function rowToChat(r: Record<string, unknown>): ChatRow {
  const storedTranscript: TranscriptTurn[] =
    typeof r.transcript === 'string'
      ? JSON.parse(r.transcript)
      : ((r.transcript as TranscriptTurn[] | undefined) ?? []);
  const transcript = projectChatFailureTranscript(storedTranscript) as TranscriptTurn[];
  const usageComplete =
    typeof r.usage_complete === 'boolean'
      ? r.usage_complete
      : transcript.every((turn) =>
          turn.role !== 'assistant' ||
          (typeof turn.tokens_in === 'number' && Number.isFinite(turn.tokens_in) &&
            typeof turn.tokens_out === 'number' && Number.isFinite(turn.tokens_out) &&
            typeof turn.cost_cents === 'number' && Number.isFinite(turn.cost_cents) &&
            !(typeof turn.unreportedFrames === 'number' && turn.unreportedFrames > 0)),
        );
  return {
    id: r.id as string,
    role: r.role as string,
    feature_id: (r.feature_id as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    su_runtime_class: toPuiSessionRuntimeClass(r.su_runtime_class),
    continued_from_chat_id: (r.continued_from_chat_id as string | null) ?? null,
    continued_from_turn_count:
      r.continued_from_turn_count == null ? null : Number(r.continued_from_turn_count),
    transcript,
    total_input_tokens:
      typeof r.total_input_tokens === 'bigint'
        ? Number(r.total_input_tokens)
        : ((r.total_input_tokens as number | undefined) ?? 0),
    total_output_tokens:
      typeof r.total_output_tokens === 'bigint'
        ? Number(r.total_output_tokens)
        : ((r.total_output_tokens as number | undefined) ?? 0),
    total_cost_usd_cents:
      typeof r.total_cost_usd_cents === 'bigint'
        ? Number(r.total_cost_usd_cents)
        : ((r.total_cost_usd_cents as number | undefined) ?? 0),
    usage_complete: usageComplete,
    created_at: msToIso(r.created_at),
    updated_at: msToIso(r.updated_at),
    archived_at: msToIsoNullable(r.archived_at),
  };
}

/** Map a projected list row (no transcript body, a `turn_count` instead) to a
 *  ChatSummary. Reuses the same bigint/epoch-ms coercions as rowToChat. */
export function rowToChatSummary(r: Record<string, unknown>): ChatSummary {
  const toNum = (v: unknown): number =>
    typeof v === 'bigint' ? Number(v) : ((v as number | undefined) ?? 0);
  return {
    id: r.id as string,
    role: r.role as string,
    feature_id: (r.feature_id as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    su_runtime_class: toPuiSessionRuntimeClass(r.su_runtime_class),
    continued_from_chat_id: (r.continued_from_chat_id as string | null) ?? null,
    continued_from_turn_count:
      r.continued_from_turn_count == null ? null : toNum(r.continued_from_turn_count),
    turn_count: toNum(r.turn_count),
    total_input_tokens: toNum(r.total_input_tokens),
    total_output_tokens: toNum(r.total_output_tokens),
    total_cost_usd_cents: toNum(r.total_cost_usd_cents),
    usage_complete: r.usage_complete === true,
    created_at: msToIso(r.created_at),
    updated_at: msToIso(r.updated_at),
    archived_at: msToIsoNullable(r.archived_at),
  };
}

export async function readFeatureLockState(
  slug: string,
  featureId: string,
): Promise<FeatureLockState | null> {
  try {
    const rows = (await harnessQuery(slug, (sql) => sql.unsafe(
      'SELECT taken_by, taken_at, expires_at FROM harness_features WHERE harness_slug = $1 AND feature_id = $2 LIMIT 1',
      [slug, featureId],
    ))) as Array<{ taken_by: string | null; taken_at: string | null; expires_at: string | null }>;
    const row = rows[0];
    if (!row) return null;
    return {
      taken_by: row.taken_by,
      taken_at: row.taken_at,
      expires_at: row.expires_at,
      active: row.taken_by !== null,
    };
  } catch {
    return null;
  }
}

// ── reads ──────────────────────────────────────────────────────────

/** Default page size for listChats — agent_chats is a forever-growing table,
 *  so the query is always bounded. Matches the 1..100 clamp on sibling list
 *  tools (agents:list). Callers page via `offset`. */
export const LIST_CHATS_DEFAULT_LIMIT = 100;
export const LIST_CHATS_MAX_LIMIT = 100;

/** Columns listChats projects — everything EXCEPT the heavy `transcript` jsonb
 *  body, which is replaced by its length (`turn_count`). See ChatSummary. */
const LIST_CHATS_COLUMNS =
  'id, role, feature_id, title, su_runtime_class, continued_from_chat_id, continued_from_turn_count, ' +
  'total_input_tokens, total_output_tokens, total_cost_usd_cents, ' +
  `NOT jsonb_path_exists(COALESCE(transcript, '[]'::jsonb), ` +
  `'\$[*] ? (@.role == "assistant" && (!exists(@.tokens_in) || !exists(@.tokens_out) || ` +
  `!exists(@.cost_cents) || @.unreportedFrames > 0))') AS usage_complete, ` +
  'created_at, updated_at, archived_at, ' +
  "jsonb_array_length(COALESCE(transcript, '[]'::jsonb)) AS turn_count";

export interface ListChatsInput {
  slug: string;
  includeArchived?: boolean;
  /** Page size, clamped to 1..LIST_CHATS_MAX_LIMIT. Defaults to LIST_CHATS_DEFAULT_LIMIT. */
  limit?: number;
  /** Keyset offset (rows to skip, ordered by updated_at DESC). Defaults to 0. */
  offset?: number;
}

export async function listChats(input: ListChatsInput): Promise<Result<{ chats: ChatSummary[] }>> {
  try {
    const limit = Math.min(
      LIST_CHATS_MAX_LIMIT,
      Math.max(1, Math.trunc(input.limit ?? LIST_CHATS_DEFAULT_LIMIT)),
    );
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    // Workspace-scope the list (WI-5125). The per-harness `agent_chats` view
    // filters on harness_slug ALONE, so an unscoped list returns rows from EVERY
    // workspace that shares the slug. That is not cosmetic: openFeatureChat's
    // reuse-before-create picks an existing chat off this list, so a foreign
    // (e.g. 'default'-stamped) row would be handed to ChatPanel, whose
    // workspace-scoped detail read then matches nothing — the infinite
    // "loading chat…" spinner, reproduced even with a correct create path.
    // Scoping here keeps the list consistent with the agentChats.* resolvers.
    const ws = activeWorkspaceId();
    const sqlText = input.includeArchived
      ? `SELECT ${LIST_CHATS_COLUMNS} FROM agent_chats WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3`
      : `SELECT ${LIST_CHATS_COLUMNS} FROM agent_chats WHERE workspace_id = $1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT $2 OFFSET $3`;
    const rows = (await harnessQuery(input.slug, (sql) => sql.unsafe(sqlText, [ws, limit, offset]))) as Array<Record<string, unknown>>;
    return { ok: true, data: { chats: rows.map(rowToChatSummary) } };
  } catch (e) {
    return { ok: false, status: 500, error: `failed to list chats: ${(e as Error).message}` };
  }
}

export interface GetChatInput {
  slug: string;
  chatId: string;
}

export async function getChat(
  input: GetChatInput,
): Promise<Result<ChatRow & { feature_lock: FeatureLockState | null }>> {
  try {
    const rows = (await harnessQuery(input.slug, (sql) => sql.unsafe(
      'SELECT * FROM agent_chats WHERE id = $1',
      [input.chatId],
    ))) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return { ok: false, status: 404, error: 'chat not found' };
    const chat = rowToChat(row);
    const featureLock = chat.feature_id
      ? await readFeatureLockState(input.slug, chat.feature_id)
      : null;
    return { ok: true, data: { ...chat, feature_lock: featureLock } };
  } catch (e) {
    return { ok: false, status: 500, error: `failed to load chat: ${(e as Error).message}` };
  }
}

// ── writes ─────────────────────────────────────────────────────────

export interface CreateChatInput {
  slug: string;
  role: string;
  feature_id?: string;
  title?: string;
}

export async function createChat(
  input: CreateChatInput,
): Promise<Result<ChatRow & { feature_lock: FeatureLockState | null }>> {
  if (!input.role || !isValidChatRole(input.role)) {
    return {
      ok: false,
      status: 400,
      error: `role must be one of: ${getKnownRoles().join(', ')}`,
    };
  }
  if (input.feature_id && !FEATURE_ID_RE.test(input.feature_id)) {
    return { ok: false, status: 400, error: `invalid feature_id: ${input.feature_id}` };
  }

  const id = randomUUID();
  const title =
    input.title ?? (input.feature_id ? `${input.role} · ${input.feature_id}` : input.role);

  // P-013: every newly created PUI conversation is homed on the canonical
  // SU-session host. `legacy-owned-loop` remains a readable historical label for
  // rows created before the cutover; no runtime flag may create new legacy rows.
  const suRuntimeClass: PuiSessionRuntimeClass = 'su-session';

  try {
    // Stamp the LIVE workspace explicitly (WI-5125). The per-harness agent_chats
    // view used to carry `ALTER COLUMN workspace_id SET DEFAULT 'default'`, so
    // omitting the column here silently filed every chat under 'default' — while
    // the operator UI reads agent_chats_consolidated scoped to the active
    // workspace, which then matched ZERO rows and spun on "loading chat…"
    // forever. Migration 616 drops that literal default; this is the other half:
    // the workspace is only known in-process (the live registry / request ALS),
    // so the writer must pass it. Same pattern as harness_features' writers.
    // Both statements share ONE harnessQuery() call so they run against the
    // same connection / per-tx search_path under PgBouncer, matching the
    // original single-`db`-client behavior.
    const row = (await harnessQuery(input.slug, async (sql) => {
      await sql.unsafe(
        `INSERT INTO agent_chats (id, workspace_id, role, feature_id, title, transcript, su_runtime_class)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [id, activeWorkspaceId(), input.role, input.feature_id ?? null, title, '[]', suRuntimeClass],
      );
      const rows = (await sql.unsafe('SELECT * FROM agent_chats WHERE id = $1', [id])) as Array<
        Record<string, unknown>
      >;
      return rows[0];
    })) as Record<string, unknown>;
    const featureLock = input.feature_id
      ? await readFeatureLockState(input.slug, input.feature_id)
      : null;

    return { ok: true, data: { ...rowToChat(row), feature_lock: featureLock } };
  } catch (e) {
    return { ok: false, status: 500, error: `failed to create chat: ${(e as Error).message}` };
  }
}

export interface ArchiveChatInput {
  slug: string;
  chatId: string;
}

export interface RenameChatInput {
  slug: string;
  chatId: string;
  title: string;
}

/** Rename the displayed chat identity; blank/control-only titles are refused. */
export async function renameChat(input: RenameChatInput): Promise<Result<{ title: string }>> {
  const title = [...String(input.title ?? '')]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (ch === '\n' || ch === '\r' || ch === '\t') return ' ';
      return code >= 32 && code !== 127 ? ch : '';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trimEnd();
  if (!title) return { ok: false, status: 400, error: 'title must contain printable text' };
  try {
    const nowMs = Date.now();
    const rows = (await harnessQuery(input.slug, (sql) => sql.unsafe(
      `UPDATE agent_chats SET title = $1, updated_at = $2
        WHERE workspace_id = $3 AND id = $4 RETURNING title`,
      [title, nowMs, activeWorkspaceId(), input.chatId],
    ))) as Array<{ title: string }>;
    if (!rows[0]) return { ok: false, status: 404, error: 'chat not found' };
    return { ok: true, data: { title: rows[0].title } };
  } catch (e) {
    return { ok: false, status: 500, error: `failed to rename chat: ${(e as Error).message}` };
  }
}

export interface ContinueChatInput {
  slug: string;
  sourceChatId: string;
  title?: string;
}

/**
 * Snapshot read-only history into a fresh writable SU-session chat.
 *
 * The source row is only SELECTed.  The successor gets a new id and permanent
 * `su-session` class; inherited text remains visible, while usage counters
 * start at zero so prior provider spend is not attributed twice.
 */
export async function continueChat(
  input: ContinueChatInput,
): Promise<Result<ChatRow & { feature_lock: FeatureLockState | null }>> {
  const id = randomUUID();
  const workspaceId = activeWorkspaceId();
  try {
    const row = (await harnessQuery(input.slug, async (sql) => {
      const sources = (await sql.unsafe(
        `SELECT role, feature_id, title, transcript
           FROM agent_chats WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
        [workspaceId, input.sourceChatId],
      )) as Array<Record<string, unknown>>;
      const source = sources[0];
      if (!source) return null;
      const role = String(source.role ?? '');
      if (!isValidChatRole(role)) throw new Error(`source role is no longer launchable: ${role}`);
      const transcript = typeof source.transcript === 'string'
        ? JSON.parse(source.transcript)
        : (Array.isArray(source.transcript) ? source.transcript : []);
      const sourceTitle = String(source.title ?? role).trim() || role;
      const title = (input.title?.trim() || `${sourceTitle} · continued`).slice(0, 120).trimEnd();
      await sql.unsafe(
        `INSERT INTO agent_chats
           (id, workspace_id, role, feature_id, title, transcript, su_runtime_class,
            continued_from_chat_id, continued_from_turn_count)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'su-session', $7, $8)`,
        [
          id,
          workspaceId,
          role,
          source.feature_id ?? null,
          title,
          JSON.stringify(transcript),
          input.sourceChatId,
          transcript.length,
        ],
      );
      const created = (await sql.unsafe(
        'SELECT * FROM agent_chats WHERE workspace_id = $1 AND id = $2',
        [workspaceId, id],
      )) as Array<Record<string, unknown>>;
      return created[0] ?? null;
    })) as Record<string, unknown> | null;
    if (!row) return { ok: false, status: 404, error: 'source chat not found' };
    const chat = rowToChat(row);
    const featureLock = chat.feature_id
      ? await readFeatureLockState(input.slug, chat.feature_id)
      : null;
    return { ok: true, data: { ...chat, feature_lock: featureLock } };
  } catch (e) {
    return { ok: false, status: 500, error: `failed to continue chat: ${(e as Error).message}` };
  }
}

export async function archiveChat(input: ArchiveChatInput): Promise<Result<{ ok: true }>> {
  try {
    // NB: archive does NOT touch any feature lock. Feature locks live in
    // harness_features.taken_by (acquired/released by the work-item /
    // orchestrator claim path), not on the chat — getChat/createChat only
    // *read* lock state via readFeatureLockState. A chat is just a
    // conversation transcript; archiving it sets archived_at and nothing
    // else. (A `SELECT role, feature_id … AS pre` once lived here to drive
    // the experts "flipExpertEngaged off" side-effect; that wiring was
    // removed in the experts-rip-out refactor and the orphaned SELECT — a
    // wasted round-trip — is removed here too.)
    const nowMs = Date.now();
    await harnessQuery(input.slug, (sql) => sql.unsafe(
      'UPDATE agent_chats SET archived_at = $1, updated_at = $2 WHERE id = $3',
      [nowMs, nowMs, input.chatId],
    ));
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return { ok: false, status: 500, error: `failed to archive chat: ${(e as Error).message}` };
  }
}

export interface AppendExternalChatTurnInput {
  slug: string;
  chatId: string;
  role: Extract<TranscriptTurn['role'], 'user' | 'assistant'>;
  content: string;
  sourceId: string;
  source: 'phone-livekit';
  ts?: string;
}

/**
 * Append one trusted server-originated turn without starting an agent run.
 *
 * Phone speech is finalized by the LiveKit worker and arrives here through a
 * loopback-only route. The update is atomic and idempotent: PostgreSQL's row
 * lock serializes concurrent typed/voice writes, while the JSONB predicate
 * drops a retried `(room, seq)` source id instead of duplicating it.
 */
export async function appendExternalChatTurn(
  input: AppendExternalChatTurnInput,
): Promise<Result<{ appended: boolean }>> {
  const content = input.content.trim();
  const sourceId = input.sourceId.trim();
  if (!content) return { ok: false, status: 400, error: 'content is required' };
  if (!sourceId) return { ok: false, status: 400, error: 'sourceId is required' };
  if (input.role !== 'user' && input.role !== 'assistant') {
    return { ok: false, status: 400, error: 'role must be user or assistant' };
  }
  try {
    const ts = input.ts && Number.isFinite(Date.parse(input.ts))
      ? new Date(input.ts).toISOString()
      : new Date().toISOString();
    const turn: TranscriptTurn = {
      role: input.role,
      content,
      ts,
      source: input.source,
      source_id: sourceId,
    };
    // Both statements share ONE harnessQuery() call so they run against the
    // same connection / per-tx search_path under PgBouncer, matching the
    // original single-`db`-client behavior.
    const result = await harnessQuery(input.slug, async (sql) => {
      const updatedRows = (await sql.unsafe(
        `UPDATE agent_chats
            SET transcript = COALESCE(transcript, '[]'::jsonb) || $1::jsonb,
                updated_at = $2
          WHERE workspace_id = $3 AND id = $4
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(COALESCE(transcript, '[]'::jsonb)) AS turn
               WHERE turn->>'source_id' = $5
            )
          RETURNING id`,
        [JSON.stringify([turn]), Date.now(), activeWorkspaceId(), input.chatId, sourceId],
      )) as Array<{ id?: string }>;
      if (updatedRows[0]?.id) return { appended: true as const, exists: true };

      const existingRows = (await sql.unsafe(
        'SELECT id FROM agent_chats WHERE workspace_id = $1 AND id = $2 LIMIT 1',
        [activeWorkspaceId(), input.chatId],
      )) as Array<{ id?: string }>;
      return { appended: false as const, exists: !!existingRows[0]?.id };
    });

    if (result.appended) return { ok: true, data: { appended: true } };
    if (!result.exists) return { ok: false, status: 404, error: 'chat not found' };
    return { ok: true, data: { appended: false } };
  } catch (e) {
    return { ok: false, status: 500, error: `failed to append external turn: ${(e as Error).message}` };
  }
}

export interface DeleteExternalChatTurnsInput {
  slug: string;
  chatId: string;
  source: 'phone-livekit';
  /** The Phone room whose `(room, seq)` source ids were appended. */
  roomName: string;
}

/**
 * Remove every turn one Phone room mirrored into an agent chat (WI-10006406).
 *
 * Phone retention (D-022) deletes a call's transcript after 30 days, and an
 * owner can delete it sooner; both must also remove the copy that
 * `appendExternalChatTurn` placed here. Only turns carrying this exact
 * source AND a `<room>:` source-id prefix are removed, so typed turns, other
 * rooms and other sources keep their order. Idempotent: a second call
 * removes 0. A chat that no longer exists returns 404, which the Phone side
 * treats as already deleted.
 */
export async function deleteExternalChatTurns(
  input: DeleteExternalChatTurnsInput,
): Promise<Result<{ removed: number }>> {
  const roomName = input.roomName.trim();
  // A colon would let `a:` match room `a:b`'s ids, so it is refused outright.
  if (!roomName || roomName.length > 200 || roomName.includes(':')) {
    return { ok: false, status: 400, error: 'roomName is invalid' };
  }
  try {
    const rows = await harnessQuery(input.slug, async (sql) => (await sql.unsafe(
      `WITH target AS (
         SELECT id, COALESCE(transcript, '[]'::jsonb) AS transcript
           FROM agent_chats WHERE workspace_id = $1 AND id = $2 FOR UPDATE
       ), filtered AS (
         SELECT target.id,
                COALESCE(jsonb_agg(t.turn ORDER BY t.ord) FILTER (WHERE NOT (
                  t.turn->>'source' = $3 AND starts_with(COALESCE(t.turn->>'source_id', ''), $4)
                )), '[]'::jsonb) AS kept,
                count(t.turn) FILTER (WHERE
                  t.turn->>'source' = $3 AND starts_with(COALESCE(t.turn->>'source_id', ''), $4)
                ) AS removed
           FROM target
           LEFT JOIN LATERAL jsonb_array_elements(target.transcript) WITH ORDINALITY AS t(turn, ord) ON true
          GROUP BY target.id
       ), updated AS (
         UPDATE agent_chats c SET transcript = filtered.kept, updated_at = $5
           FROM filtered
          WHERE c.workspace_id = $1 AND c.id = filtered.id AND filtered.removed > 0
          RETURNING c.id
       )
       SELECT removed::int AS removed FROM filtered`,
      [activeWorkspaceId(), input.chatId, input.source, `${roomName}:`, Date.now()],
    )) as Array<{ removed?: number | string }>);
    if (!rows[0]) return { ok: false, status: 404, error: 'chat not found' };
    return { ok: true, data: { removed: Number(rows[0].removed ?? 0) } };
  } catch (e) {
    return { ok: false, status: 500, error: `failed to delete external turns: ${(e as Error).message}` };
  }
}
