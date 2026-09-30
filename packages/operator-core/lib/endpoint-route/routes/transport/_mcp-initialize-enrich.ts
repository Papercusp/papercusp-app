/**
 * Per-session MCP `initialize.instructions` enrichment — the mechanics.
 *
 * Plan: memory-delivery-unification-2026-07-12 (P-001, decisions D-005/D-003).
 *
 * The SDK `Server` registers its own `initialize` request handler in its
 * constructor (`_oninitialize`), which returns the STATIC `instructions`
 * string given at construction. The original papercusp-su-memory-2026-05-25
 * P-003 work deferred per-session enrichment because overriding that handler
 * looked like re-implementing the protocol-version negotiation. This module
 * closes the gap WITHOUT re-implementing it: we take the SDK's already-stored
 * handler off the protocol's `_requestHandlers` map and DELEGATE to it — the
 * version negotiation and the `_clientCapabilities`/`_clientVersion` side
 * effects stay SDK-owned — then enrich ONLY the `instructions` field of the
 * result (session-start memory prelude: user + harness memories + the
 * agent-insights index, via `buildMcpPrelude`).
 *
 * Never-throws: any enrichment failure (or a null/empty enrichment) returns
 * the SDK's own result unchanged, so a broken memory backend can never break
 * session establishment. Pinned by
 * `__tests__/mcp-initialize-enrich.test.ts` — including against the REAL SDK
 * Server, so an SDK upgrade that changes the stored-handler shape or the
 * negotiation semantics fails the suite instead of silently dropping the
 * prelude (or worse, the negotiation).
 */

import { MAX_MCP_REQUEST_TRACE_ID_CHARS } from '../../../mcp-request-trace';

export type InitializeHandler = (req: unknown, extra: unknown) => Promise<unknown>;

export type ShouldEnrichInitialize = (req: unknown) => boolean;

export interface InitializeHandlerTiming {
  startedAtMs: number;
  sdkMs: number;
}

export type InitializeStageOutcome = 'timeout' | 'enriched' | 'base' | 'error';

export interface InitializeStageTelemetry {
  traceId: string;
  pid: number;
  outcome: 'timeout' | 'slow_enriched' | 'slow_base' | 'slow_error';
  stages: {
    sdkMs: number;
    spawnContextMs: number | null;
    userLookupMs: number | null;
    preludeMs: number | null;
    enrichmentMs: number;
    totalMs: number;
  };
}

/**
 * Privacy-bounded initialize telemetry gate. Fast requests are silent; a deadline is always
 * recorded. The result intentionally has no request, URL, header, client, args, tool, or payload
 * field, so callers can safely pass it to a structured log sink unchanged.
 */
export function buildInitializeStageTelemetry(input: {
  traceId: string;
  pid: number;
  outcome: InitializeStageOutcome;
  slowMs: number;
  stages: InitializeStageTelemetry['stages'];
}): InitializeStageTelemetry | null {
  if (!input.traceId || input.traceId.length > MAX_MCP_REQUEST_TRACE_ID_CHARS) return null;
  if (input.outcome !== 'timeout' && input.stages.totalMs < input.slowMs) return null;
  return {
    traceId: input.traceId,
    pid: input.pid,
    outcome: input.outcome === 'timeout' ? 'timeout' : `slow_${input.outcome}`,
    stages: { ...input.stages },
  };
}

/**
 * Fetch the SDK's stored `initialize` handler from the protocol's private
 * `_requestHandlers` map. Returns null when the shape is not what we expect
 * (e.g. an SDK upgrade moved the map) — the caller then leaves the SDK
 * handler in place and the session falls back to static instructions.
 *
 * Note the stored value is the protocol's WRAPPER (it re-parses the request
 * against the schema before calling `_oninitialize`), so calling it with an
 * already-parsed request is safe — the parse is idempotent.
 */
export function takeStoredInitializeHandler(server: unknown): InitializeHandler | null {
  const map = (server as { _requestHandlers?: Map<string, unknown> } | null | undefined)
    ?._requestHandlers;
  if (!map || typeof map.get !== 'function') return null;
  const handler = map.get('initialize');
  return typeof handler === 'function' ? (handler as InitializeHandler) : null;
}

/**
 * Native Codex and OMP clients mount MCP `initialize.instructions` into their
 * own model/tool context. Their native tool calls then carry that text back to
 * the model, so appending the per-session memory prelude here causes the
 * prelude to be re-injected on every native call. Keep the compact static
 * server instructions for discoverability, but deliver dynamic memory through
 * the normal turn-start path for these clients.
 *
 * Client names are deliberately matched by normalized tokens rather than an
 * exact-version allowlist: the wrappers and native protocol adapters use
 * names such as `codex-su`, `codex-cli`, `omp-su`, and `oh-my-pi (omp)` across
 * releases. Names that merely contain a partial token (for example
 * `codexish`) do not opt into the native budget guard.
 */
export function isNativeInstructionBudgetClient(req: unknown): boolean {
  if (!req || typeof req !== 'object') return false;
  const params = (req as { params?: unknown }).params;
  if (!params || typeof params !== 'object') return false;
  const clientInfo = (params as { clientInfo?: unknown }).clientInfo;
  if (!clientInfo || typeof clientInfo !== 'object') return false;
  const name = (clientInfo as { name?: unknown }).name;
  if (typeof name !== 'string' || !name.trim()) return false;

  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /(?:^|-)codex(?:-|$)/.test(normalized) || /(?:^|-)omp(?:-|$)/.test(normalized) || normalized.includes('oh-my-pi');
}

/**
 * Wrap the SDK initialize handler: delegate the whole request (negotiation +
 * client-info side effects), then best-effort enrich the `instructions`
 * field. `enrich` receives the SDK's own instructions string (the static
 * base) and the request `extra` (URL/headers live there); it returns the
 * REPLACEMENT instructions, or null/undefined to keep the base.
 */
export function wrapInitializeWithInstructions(
  original: InitializeHandler,
  enrich: (
    base: string | undefined,
    extra: unknown,
    timing: InitializeHandlerTiming,
    req: unknown,
  ) => Promise<string | null | undefined>,
  shouldEnrich: ShouldEnrichInitialize = () => true,
): InitializeHandler {
  return async (req, extra) => {
    const startedAtMs = Date.now();
    const base = (await original(req, extra)) as Record<string, unknown>;
    const sdkMs = Date.now() - startedAtMs;
    try {
      if (!shouldEnrich(req)) return base;
    } catch {
      // An optional client classifier is a budget guard, not a reason to make
      // initialize fail. Fail closed if a future classifier cannot inspect the
      // request shape.
      return base;
    }
    try {
      const baseInstructions = typeof base.instructions === 'string' ? base.instructions : undefined;
      const enriched = await enrich(baseInstructions, extra, { startedAtMs, sdkMs }, req);
      if (typeof enriched === 'string' && enriched.length > 0 && enriched !== baseInstructions) {
        return { ...base, instructions: enriched };
      }
    } catch {
      // Best-effort by contract: a failed enrichment must never break the
      // initialize response — fall through to the SDK's own result.
    }
    return base;
  };
}
