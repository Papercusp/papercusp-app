/**
 * MCP write idempotency / result replay (full-app-audit P-046 / EI-68).
 *
 * The problem: an MCP client that disconnects mid-call loses the result
 * FOREVER. The tool often already executed (the write committed); the
 * response then dies on the closed stream (hono-host swallows that
 * ERR_INVALID_STATE class by design — one disconnect must not crash the
 * host). The reconnecting caller cannot distinguish "ran, result
 * dropped" from "never ran" — so it either re-fires a write (double
 * execution) or gives up on a write that actually landed.
 *
 * The contract (opt-in, per call): pass `_meta.idempotencyKey` (any
 * caller-chosen string ≤200 chars, unique per logical write) on
 * tools/call. The transport then:
 *
 *   1. BEFORE executing — looks the key up here. A hit returns the
 *      stored result verbatim, tagged `_meta.replayed: true`, WITHOUT
 *      re-executing the tool.
 *   2. AFTER executing — persists the serialized result under the key,
 *      best-effort (a store failure never fails the call).
 *
 * Keys are scoped per caller (`ownerKey` = the stable session identity:
 * uiClientId for SU/power sessions, spawnId for signed spawns), so two
 * agents can use the same key string without collision.
 *
 * Storage: harness_shared.mcp_tool_results (mig 220), admin handle —
 * infra data, sweep-bounded (rows older than REPLAY_TTL are deleted
 * opportunistically on write, at most once a minute per process).
 *
 * Known limit (documented, accepted): the lookup→execute→store sequence
 * is not a distributed claim — two CONCURRENT calls with the same key
 * can both execute. The reconnect flow this exists for is sequential
 * (call → connection dies → re-call), where the window cannot occur.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { ToolResult } from '@papercusp/tooldef';

/**
 * Stored/replayed result — the serialized MCP tools/call result shape.
 *
 * `content` reuses `ToolResult['content']` rather than restating it as
 * `Array<Record<string, unknown>>`. The wider shape looked safer and was not:
 * `decodeStoredMcpResult` already reaches this type through a bare
 * `decoded as StoredMcpResult` cast on parsed JSON, so the widening bought no
 * validation — it only made a stored result UNASSIGNABLE to `ToolResult`.
 *
 * That is load-bearing because a tool handler may legitimately return a
 * replayed result straight out of this store (`harness:generate-from-repo`
 * does). With the wide shape such a handler infers
 * `Promise<StoredMcpResult>`, fails both tool overloads of `defineTool`, and
 * falls through to the ROUTE overload — surfacing as an opaque TS2769 that
 * names `Request`/`RouteContext` and points at `args`, nowhere near the real
 * cause. Keeping the two types structurally identical is what stops that
 * whole class, and a stored MCP result genuinely IS an MCP result.
 */
export interface StoredMcpResult {
  content: ToolResult['content'];
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
}

/** The marker stored while an idempotent write is executing asynchronously. */
export const PENDING_MCP_RESULT_STATE = 'pending';

export interface PendingMcpResultMarker {
  state: typeof PENDING_MCP_RESULT_STATE;
  tool: string;
  progressId: string;
  ownerKey: string;
  idempotencyKey: string;
  request: Record<string, unknown>;
}

export interface PendingMcpResultClaim {
  claimed: boolean;
  pending: boolean;
  result: StoredMcpResult | null;
}

/** Replay rows older than this are dead — the caller has long moved on. */
const REPLAY_TTL_MS = 60 * 60 * 1000;
/** Opportunistic sweep at most this often per process. */
const SWEEP_MIN_INTERVAL_MS = 60 * 1000;
let lastSweepAt = 0;

const KEY_MAX = 200;

/**
 * Above this many bytes of serialized result we SKIP persisting the replay row
 * (operator-scalability-event-loop P1-2 / app-wide-load-traps F-A1 "stacked
 * 4th stringify"). The store is a synchronous payload-sized `JSON.stringify` on
 * the serving event loop; for a large result that blocks long enough to drop
 * the very MCP/SSE connections this buffer exists to make resilient. The buffer
 * is opt-in and exists for WRITE idempotency — those results are small
 * confirmation payloads (`{ ok, created: 'WI-42' }`), comfortably under the
 * gate. A pathologically large result is exactly the one we must not block on;
 * skipping its row only forgoes replay for a write whose result was huge, while
 * the write itself still committed. Best-effort by contract, so a skip is safe.
 */
const REPLAY_STORE_MAX_BYTES = 256 * 1024;

/** Validate a caller-supplied idempotency key — non-empty string, bounded. */
export function validIdempotencyKey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const k = v.trim();
  if (k.length === 0 || k.length > KEY_MAX) return null;
  return k;
}

function decodeStoredMcpResult(result: unknown, isError: boolean): StoredMcpResult | null {
  const decoded =
    typeof result === 'string'
      ? (() => {
          try {
            return JSON.parse(result) as unknown;
          } catch {
            return null;
          }
        })()
      : result;
  if (!decoded || typeof decoded !== 'object') return null;
  const stored = decoded as StoredMcpResult;
  return {
    ...stored,
    ...(isError ? { isError: true } : {}),
  };
}

export function isPendingMcpResult(result: StoredMcpResult | null | undefined): boolean {
  return result?._meta?.state === PENDING_MCP_RESULT_STATE;
}

export async function lookupStoredMcpResult(
  ownerKey: string,
  idempotencyKey: string,
): Promise<StoredMcpResult | null> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ result: unknown; is_error: boolean }>>`
    SELECT result, is_error
      FROM harness_shared.mcp_tool_results
     WHERE owner_key = ${ownerKey} AND idempotency_key = ${idempotencyKey}
       AND created_at > now() - make_interval(secs => ${REPLAY_TTL_MS / 1000})
  `;
  const row = rows[0];
  if (!row) return null;
  const stored = decodeStoredMcpResult(row.result, row.is_error);
  // Pending receipts are coordination state, not terminal tool results. The
  // MCP handler calls this before invoking the tool on a retry, so returning a
  // pending marker here would make the retry look like a completed write.
  if (!stored || isPendingMcpResult(stored)) return null;
  return {
    ...stored,
    // Tag the replay so the caller KNOWS this is the stored outcome of a
    // prior execution, not a fresh run.
    _meta: { ...(stored._meta ?? {}), replayed: true },
  };
}

/**
 * Atomically reserve an idempotency key for an asynchronous write.
 *
 * The transport stores the handler's returned result after dispatch. Inserting
 * the pending receipt before returning means that write is a harmless no-op
 * on the same key, while a retry can observe the pending row and avoid
 * starting a second background operation.
 */
export async function claimPendingMcpResult(args: {
  ownerKey: string;
  idempotencyKey: string;
  toolName: string;
  workspaceId: string;
  result: StoredMcpResult;
}): Promise<PendingMcpResultClaim> {
  const { sql } = getOrgPg();
  const resultJson = serializeStoredMcpResult(args.result);
  const inserted = await sql<Array<{ result: unknown; is_error: boolean }>>`
    INSERT INTO harness_shared.mcp_tool_results
      (owner_key, idempotency_key, tool_name, workspace_id, result, is_error)
    VALUES
      (${args.ownerKey}, ${args.idempotencyKey}, ${args.toolName},
       ${args.workspaceId}, ${resultJson}::text::jsonb, ${args.result.isError === true})
    ON CONFLICT (owner_key, idempotency_key) DO NOTHING
    RETURNING result, is_error
  `;
  if (inserted[0]) {
    return { claimed: true, pending: true, result: decodeStoredMcpResult(inserted[0].result, inserted[0].is_error) };
  }

  const existing = await sql<Array<{ result: unknown; is_error: boolean }>>`
    SELECT result, is_error
      FROM harness_shared.mcp_tool_results
     WHERE owner_key = ${args.ownerKey} AND idempotency_key = ${args.idempotencyKey}
  `;
  const current = existing[0]
    ? decodeStoredMcpResult(existing[0].result, existing[0].is_error)
    : null;
  return {
    claimed: false,
    pending: isPendingMcpResult(current),
    result: current,
  };
}

export function serializeStoredMcpResult(result: StoredMcpResult): string {
  const contentParts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item && typeof item === 'object') {
        const typed = item as Record<string, unknown>;
        if (typed.type === 'text' && typeof typed.text === 'string') {
          // JSON.stringify the text so a plain string is correctly quoted/escaped
          // (a bare `${typed.text}` produces invalid JSON for a non-JSON string, and
          // silently retypes a JSON-string value to an object — breaking replay
          // round-trip). Stringifying a single string is the cheap leg; the P1-4 win
          // is avoiding JSON.stringify on the WHOLE result/large content arrays.
          contentParts.push(`{"type":"text","text":${JSON.stringify(typed.text)}}`);
        } else {
          contentParts.push(JSON.stringify(item));
        }
      }
    }
  }
  // Build the body WITHOUT the closing brace, append isError/_meta, THEN close —
  // appending after a closed `{...}` produced `{...},"_meta":…` (trailing content
  // past the root object → "invalid input syntax for type json" on ::jsonb).
  let json = `{"content":[${contentParts.join(',')}]`;
  if (result.isError) json += ',"isError":true';
  if (result._meta) json += `,"_meta":${JSON.stringify(result._meta)}`;
  // EI-21508946450217911: a tool that declares an outputSchema (scheduler:get_next,
  // every object-rooted projected tool) MUST return structuredContent — the MCP
  // SDK's CLIENT-side check throws -32600 "has an output schema but did not return
  // structured content" otherwise. Dropping this field here made every idempotent
  // replay of such a tool schema-invalid, breaking the prescribed recovery path
  // itself: the caller retrying a timed-out call could never get a schema-valid
  // verdict back. Serialize it when present so a replay carries the same shape the
  // fresh response had.
  if (result.structuredContent !== undefined) {
    json += `,"structuredContent":${JSON.stringify(result.structuredContent)}`;
  }
  json += '}';
  return json;
}

export async function storeMcpResult(args: {
  ownerKey: string;
  idempotencyKey: string;
  toolName: string;
  workspaceId: string;
  result: StoredMcpResult;
}): Promise<void> {
  const { sql } = getOrgPg();
  // Size gate: skip storing pathologically large results (operator-scalability P1-2
  // / app-wide-load-traps F-A1). The store is synchronous on the event loop; large
  // results block long enough to drop MCP/SSE connections. Estimate size BEFORE
  // stringify to avoid the expensive JSON.stringify call on large content — reuse
  // the already-serialized text in content.text fields. Skipping the row forgoes
  // replay for that ONE huge result while the write itself still committed — best-
  // effort by contract, safe.
  let estimatedSize = 200; // baseline for metadata (_meta, isError, wrapper)
  if (Array.isArray(args.result.content)) {
    for (const item of args.result.content) {
      if (item && typeof item === 'object') {
        // Content items are {type: 'text', text: <serialized>}. Reuse the text
        // length instead of re-serializing it.
        const text = (item as { text?: unknown }).text;
        if (typeof text === 'string') {
          estimatedSize += text.length;
        }
      }
    }
  }
  // EI-21508946450217911: structuredContent is part of the stored payload now —
  // a large one must count toward the same event-loop gate the content does,
  // or the gate under-measures by exactly the field this exists to bound.
  if (args.result.structuredContent !== undefined) {
    estimatedSize += JSON.stringify(args.result.structuredContent).length;
  }
  if (estimatedSize > REPLAY_STORE_MAX_BYTES) {
    maybeSweep();
    return;
  }
  // jsonb bound as text::jsonb — the operator's postgres-js client throws
  // on bare-object jsonb params (agent-insights/postgres-js-jsonb-binding).
  // Reuse already-serialized text in content items to avoid the 4th stringify
  // (operator P1-4 / app-wide-load-traps F-A1-part2): build the JSON manually
  // from components instead of calling JSON.stringify on the whole result.
  const resultJson = serializeStoredMcpResult(args.result);
  // First write wins: if a concurrent same-key call already stored, keep
  // the original (both executed in that pathological case; the FIRST
  // stored result is the one every later replay sees — stable).
  await sql`
    INSERT INTO harness_shared.mcp_tool_results
      (owner_key, idempotency_key, tool_name, workspace_id, result, is_error)
    VALUES
      (${args.ownerKey}, ${args.idempotencyKey}, ${args.toolName},
       ${args.workspaceId}, ${resultJson}::text::jsonb, ${args.result.isError === true})
    ON CONFLICT (owner_key, idempotency_key) DO NOTHING
  `;
  maybeSweep();
}

/**
 * Replace a pending receipt with the terminal result of its background write.
 *
 * A terminal receipt is never overwritten: this preserves first-write-wins if
 * a recovery path races a completion callback. If the transport failed before
 * it persisted the pending row, the INSERT fallback still records the terminal
 * result so a later retry can replay it.
 */
export async function finalizePendingMcpResult(args: {
  ownerKey: string;
  idempotencyKey: string;
  toolName: string;
  workspaceId: string;
  result: StoredMcpResult;
}): Promise<boolean> {
  const { sql } = getOrgPg();
  const resultJson = serializeStoredMcpResult(args.result);
  const rows = await sql<Array<{ result: unknown }>>`
    INSERT INTO harness_shared.mcp_tool_results
      (owner_key, idempotency_key, tool_name, workspace_id, result, is_error)
    VALUES
      (${args.ownerKey}, ${args.idempotencyKey}, ${args.toolName},
       ${args.workspaceId}, ${resultJson}::text::jsonb, ${args.result.isError === true})
    ON CONFLICT (owner_key, idempotency_key) DO UPDATE
      SET tool_name = EXCLUDED.tool_name,
          workspace_id = EXCLUDED.workspace_id,
          result = EXCLUDED.result,
          is_error = EXCLUDED.is_error,
          created_at = now()
    WHERE mcp_tool_results.result->'_meta'->>'state' = ${PENDING_MCP_RESULT_STATE}
    RETURNING result
  `;
  maybeSweep();
  return rows.length > 0;
}

export async function sweepExpiredMcpResults(now = Date.now()): Promise<number> {
  const { sql } = getOrgPg();
  // ISO-string param, not a Date — this pool's serializer config rejects
  // Date instances (same constraint as the jsonb ::text::jsonb binding).
  const cutoff = new Date(now - REPLAY_TTL_MS).toISOString();
  const rows = await sql<Array<{ n: number }>>`
    WITH del AS (
      DELETE FROM harness_shared.mcp_tool_results
       WHERE created_at < ${cutoff}::timestamptz
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM del
  `;
  return Number(rows[0]?.n ?? 0);
}

function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt = now;
  void sweepExpiredMcpResults(now).catch(() => {
    /* best-effort janitor */
  });
}
