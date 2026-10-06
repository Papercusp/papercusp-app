/**
 * Operator LLM transport — the concrete `LlmCallFn` (+ `isLlmAvailable`) seam
 * the generic `@papercusp/testing-shell/llm` runner is injected with via
 * `RunnerDeps` (Phase 7 P-073).
 *
 * Routes through the shared `runAgentChat` with `backend: 'anthropic-direct'`
 * — a stateless Anthropic-format round-trip DIRECT to api.anthropic.com with
 * the Claude OAuth session (~/.claude/.credentials.json). (The omp-era leg
 * via the local Meridian router at :3456 was retired 2026-06-12, EI-399.)
 *
 * Pricing + retry + auth + temperature-incompat all live in
 * `libs/papercusp-shared/src/agent/chat-stream.ts`'s `anthropic-direct` branch
 * so every consumer of the shared lib gets the same hardened path.
 *
 * The host-agnostic pieces — `MODEL_PRICES` / `estimateCost`, `tryParseJson`,
 * the `LlmCallOpts`/`LlmCallResult` shapes, and the typed `LlmCallError` — live
 * in `@papercusp/testing-shell/llm`. This module keeps only the operator-coupled
 * transport (`llmCall`, which imports the operator's agent-chat-stream) and the
 * operator-credentials availability check (`isLlmAvailable`).
 */

import { LlmCallError, tryParseJson, type LlmCallOpts, type LlmCallResult } from '@papercusp/testing-shell/llm';
import { costFromTokens, priceFor } from '@papercusp/model-pricing';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';

import {
  runAgentChat,
  classifyHttpError,
  ownerHeaders,
  probeStatelessTransport,
  type AgentBackend,
  type TurnError,
  type TurnProvider,
  type RunAgentChatOptions,
} from '../agent-chat-stream';
import { readCredentials } from '../credentials';
import { loopbackFetch } from '../loopback-fetch';
import { CODEX_LLM_DEFAULT_MODEL, codexWireModel, isCodexModel } from './codex-model-pricing';
import { captureSourceHash } from '@papercusp/eval-battery';
import { REQUIRE_OUTPUT_TOKEN_LIMIT_HEADER } from '../inference-gateway/provider-adapters';

const LLM_CLIENT_SOURCE_HASH = captureSourceHash(import.meta.url);

/** Provider label for classifying a backend's error message (labeling only — rate detection is
    status/regex-based, so this never changes the class). */
function providerForBackend(backend: AgentBackend): TurnProvider {
  return backend === 'codex' ? 'openai' : backend === 'omp' ? 'unknown' : 'anthropic';
}

/**
 * Backend for the sim-user + judge calls. A Codex model id is authoritative:
 * it always selects the Responses bridge, even when a stale process-wide
 * `LLM_TEST_BACKEND` still names a Claude transport. Non-Codex models retain
 * the historical explicit-backend override and otherwise use
 * `anthropic-direct`.
 */
const TEST_BACKEND = process.env.LLM_TEST_BACKEND as AgentBackend | undefined;
const CODEX_GATEWAY_AUTH = 'papercusp-gateway';
const ROUTED_ACCOUNT_HEADER = 'x-papercusp-routed-account';

export type LlmTransportDiagnostic = Parameters<NonNullable<Parameters<typeof runAgentChat>[0]['onTransportDiagnostic']>>[0];
/** The existing classified error with host transport evidence, when available. */
export type LlmTransportCallError = LlmCallError & {
  readonly transportDiagnostics: readonly LlmTransportDiagnostic[];
  readonly promptSha256: string;
};

// The routing + price rule lives in codex-model-pricing.ts so write-time seams
// (steering, pot overrides) apply the same rule this call path enforces (WI-10004526).
export { isCodexModel };

export function backendForLlmCall(
  model: string | undefined,
  explicitBackend: AgentBackend | undefined = TEST_BACKEND,
): AgentBackend {
  if (isCodexModel(model)) return 'codex';
  return explicitBackend ?? 'anthropic-direct';
}

/** Map Papercusp's Codex-facing aliases to the bare ids the Codex CLI accepts. */
export function modelForLlmCall(model: string | undefined, backend: AgentBackend): string | undefined {
  if (backend !== 'codex') return model;
  const trimmed = model?.trim();
  if (!trimmed) return model;
  return codexWireModel(trimmed);
}

const KNOWN_EFFORT_SUFFIXES = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * EI-13118: the `anthropic-direct` backend forwards `model` VERBATIM to
 * api.anthropic.com's `model` param (chat-stream.ts's anthropic-direct branch) —
 * unlike the `claude-code`/`omp` SUBPROCESS backends, it never goes through the
 * fleet CLI's own spec parsing (`[1m]` window marker, a trailing `:<effort>`
 * suffix, a `provider:` tier-menu prefix). A fleet-style spec that reaches here
 * (e.g. copy-pasted from a spawn command into a role's model config) 404s at the
 * raw API with no local signal — that silently killed organic scout ideation for
 * 2.3 days (07-14→07-16 2026) because the 404 got folded into an ordinary
 * "ran/no-ideas" cycle several layers up, invisible until a signal-score audit
 * caught it. Strip what's safely strippable (the `[1m]` marker; a trailing
 * RECOGNIZED effort suffix — `:effort` is consumed by the CLI as a separate
 * flag, never part of the raw API model id, and every anthropic-direct caller
 * already threads its own explicit `thinkingBudgetTokens`, so the suffix carries
 * no information once stripped) and THROW LOUDLY for anything that still doesn't
 * look like a raw Anthropic model id afterward — never forward an unresolvable
 * spec silently. A thrown Error here propagates through this module's per-call
 * try/catch chain (scout's runIdeators et al.) as a normal, VISIBLE call failure
 * — never swallowed as a benign empty result.
 */
export function canonicalizeAnthropicModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;
  let base = trimmed.replace(/\[1m\]/gi, '');
  const lastColon = base.lastIndexOf(':');
  if (lastColon > 0 && KNOWN_EFFORT_SUFFIXES.has(base.slice(lastColon + 1).toLowerCase())) {
    base = base.slice(0, lastColon);
  }
  // A real Anthropic model id never contains a colon — an UNRECOGNIZED colon
  // suffix (a typo'd effort word, a `provider:` prefix) is just as unresolvable
  // as a missing `claude-` prefix, so fold it into the same loud rejection
  // instead of forwarding a still-fleet-flavored string to the API.
  if (!/^claude-/i.test(base) || base.includes(':')) {
    throw new Error(
      `unresolvable model spec for the anthropic-direct backend: ${JSON.stringify(trimmed)} → ` +
        `${JSON.stringify(base)} is not a raw Anthropic model id. Fleet-spec syntax ([1m], :effort, ` +
        'provider: prefixes) belongs to fleet/model-tiers resolution, not this raw API call — pass a ' +
        "bare id like 'claude-sonnet-5' instead (EI-13118).",
    );
  }
  return base;
}

function codexGatewayUrl(): string {
  const port = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  const p = Number.isFinite(port) && port > 0 ? port : 8788;
  return `http://127.0.0.1:${p}/v1/responses`;
}

function extractResponsesText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const root = value as { output_text?: unknown; output?: unknown; content?: unknown };
  if (typeof root.output_text === 'string') return root.output_text;
  const parts: string[] = [];
  const visit = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as { type?: unknown; text?: unknown; content?: unknown; output_text?: unknown };
    if (typeof obj.output_text === 'string') parts.push(obj.output_text);
    if ((obj.type === 'output_text' || obj.type === 'text') && typeof obj.text === 'string') parts.push(obj.text);
    if (obj.content !== undefined) visit(obj.content);
  };
  visit(root.output);
  visit(root.content);
  return parts.join('\n');
}

async function llmCallViaCodexGateway(
  opts: LlmCallOpts,
  model: string | undefined,
  promptText: string,
): Promise<LlmCallResult> {
  const pricedModel = model ?? CODEX_LLM_DEFAULT_MODEL;
  if (!priceFor(pricedModel)) throw new Error('Codex model has no registered usage price: ' + pricedModel);
  const input =
    opts.responseFormat === 'json' && !/\bjson\b/i.test(promptText)
      ? `${promptText}\n\nRespond with valid json.`
      : promptText;
  const body: Record<string, unknown> = {
    model: model ?? CODEX_LLM_DEFAULT_MODEL,
    input,
    stream: false,
  };
  if (opts.system?.trim()) body.instructions = opts.system;
  if (opts.maxTokens !== undefined) body.max_output_tokens = opts.maxTokens;
  // The Codex reasoning transport rejects sampling temperature, including 0.
  // Sim-user and judge calls share this adapter and supply it by default;
  // forwarding that logical knob prevents either role from producing a turn.
  // Keep it on the Anthropic path, which handles model-specific support.
  if (opts.responseFormat === 'json') body.text = { format: { type: 'json_object' } };

  const res = await loopbackFetch(
    codexGatewayUrl(),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CODEX_GATEWAY_AUTH}`,
        'content-type': 'application/json',
        ...ownerHeaders(opts.ownerId),
        // EI-315: an unlabeled llm-testing call used to default to 'scout' (tier 1 — WRONG
        // direction, falsely elevating batch test traffic ahead of real interactive/Queen
        // work) here, while the anthropic-direct path below fell to the map's bottom `default`
        // band (tier 5 — the actual starvation this item reported: 17/17 attempts 429-capped
        // over 7h). Both are fixed the same way: label unset test traffic 'llm-testing', which
        // DEFAULT_GATEWAY_PRIORITY_MAP now maps to tier 4 — the same batch band as `gym`/
        // `benchmark`, high enough to stop being first-shed but never ahead of real interactive
        // work.
        'x-papercusp-priority': opts.priority ?? 'llm-testing',
        ...(opts.requireOutputTokenLimit ? { [REQUIRE_OUTPUT_TOKEN_LIMIT_HEADER]: 'true' } : {}),
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    },
    // The OAuth bridge deliberately withholds response HEADERS until it has
    // aggregated response.completed. Global fetch's five-minute Undici headers
    // cap therefore kills a healthy long xhigh generation before the gateway's
    // own request ceiling. Reuse loopbackFetch's existing long-running dispatcher
    // (`launch` is its historical option name). Keep its retry ladder empty here:
    // the bulk-dedup caller already owns the bounded transient retry policy.
    { launch: true, backoffsMs: [] },
  );
  // The Codex bridge is non-streaming, so response headers arrive with the completed
  // response. Still surface the transport boundary for callers that use one shared seam.
  opts.onResponseStart?.();
  const text = await res.text();
  let raw: unknown = null;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = text;
  }
  if (!res.ok) {
    const message =
      raw && typeof raw === 'object' ? ((raw as { error?: { message?: string } }).error?.message ?? text) : text;
    const failure = new LlmCallError(classifyHttpError({ status: res.status, message }, providerForBackend('codex')));
    const refusal = raw && typeof raw === 'object' ? raw as { gateway?: unknown; error?: { code?: unknown } } : null;
    if (refusal?.gateway === true &&
        ((res.status === 422 && refusal.error?.code === 'output_token_limit_unsupported') ||
         (res.status === 400 && refusal.error?.code === 'output_token_limit_invalid'))) {
      // The gateway refused before inference. This is a known zero, unlike
      // missing usage on a request that may already have reached the provider.
      Object.assign(failure, { costUsd: 0 });
    }
    throw failure;
  }

  const finalText = extractResponsesText(raw);
  const usage =
    raw && typeof raw === 'object'
      ? (raw as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }).usage
      : undefined;
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  const cachedInput = usage?.input_tokens_details?.cached_tokens ?? 0;
  if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
      typeof outputTokens !== 'number' || !Number.isSafeInteger(outputTokens) || outputTokens < 0 ||
      !Number.isSafeInteger(cachedInput) || cachedInput < 0 || cachedInput > inputTokens)
    throw new Error('Codex response has missing or invalid usage; retain the admitted cost reservation');
  const costUsd = costFromTokens(pricedModel, {
    inputTokens: inputTokens - cachedInput, outputTokens, cacheReadTokens: cachedInput,
  }).usd;
  const json = opts.responseFormat === 'json' ? tryParseJson(finalText) : undefined;

  const servedAccount = res.headers.get(ROUTED_ACCOUNT_HEADER)?.trim() || undefined;
  return {
    text: finalText,
    json,
    inputTokens,
    outputTokens,
    costUsd,
    raw,
    execution: { model: pricedModel, codeHash: null,
      loadedCode: { llmClient: LLM_CLIENT_SOURCE_HASH },
      unresolved: ['gateway-runtime', 'http-client', 'model-routing', 'usage-pricing', 'response-parser'] },
    ...(servedAccount ? { servedAccount } : {}),
  };
}

/**
 * One-shot completion via the `anthropic-direct` backend — the operator's
 * concrete implementation of the lib's injected `LlmCallFn` seam.
 *
 * GOTCHA (agent-insights: max-oauth-first-system-block-must-be-claude-code-identity): on the inference
 * gateway every pool credential is a Claude MAX OAuth token, and Anthropic 429-shunts a request to a
 * stricter (opus-prone) bucket UNLESS its FIRST `system` block is the Claude Code identifier. This path
 * routes through `runAgentChat` → chat-stream `buildSystemParam`, which now ALWAYS prepends it — so
 * in-process calls here are framed automatically. If you add a NEW anthropic-direct path that bypasses
 * `buildSystemParam`, you MUST prepend `CLAUDE_CODE_IDENTIFIER` yourself or it will opus-429.
 */
export async function llmCall(
  opts: LlmCallOpts & Pick<RunAgentChatOptions, 'authorizeStatelessRequest'>,
): Promise<LlmCallResult> {
  if (opts.requireOutputTokenLimit || opts.authorizeStatelessRequest !== undefined) {
    opts = { ...opts, messages: opts.messages.map(message => ({ ...message })) };
  }
  const backend = backendForLlmCall(opts.model);
  if (opts.authorizeStatelessRequest !== undefined &&
      (typeof opts.authorizeStatelessRequest !== 'function' || backend !== 'anthropic-direct')) {
    throw Object.assign(new Error('Stateless request authorization requires the Anthropic HTTP backend'), { costUsd: 0 });
  }
  if (opts.requireOutputTokenLimit && (!Number.isSafeInteger(opts.maxTokens) || opts.maxTokens! <= 0)) {
    throw Object.assign(new RangeError('Required output token limit needs a positive integer maxTokens'), { costUsd: 0 });
  }
  if (opts.requireOutputTokenLimit && backend !== 'codex' && backend !== 'anthropic-direct') {
    throw Object.assign(new Error(`Required output token limit is not implemented for backend '${backend}'`), { costUsd: 0 });
  }
  let model = modelForLlmCall(opts.model, backend);
  // EI-13118: canonicalize / loudly reject fleet-spec syntax BEFORE it reaches the raw
  // anthropic-direct API call — see canonicalizeAnthropicModel's doc comment.
  if (backend === 'anthropic-direct' && model) {
    model = canonicalizeAnthropicModel(model);
  }
  let finalText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let reportedCostUsd: number | undefined;
  let costUsdMeasurementMissing = false;
  let unreportedFrames: number | undefined;
  let stopReason: string | null | undefined;
  let servedAccount: string | undefined;
  let lastErrMsg: string | undefined;
  let lastErrTurn: TurnError | undefined;
  let sawResult = false;

  // Subprocess backends (claude-code / omp / codex) ignore `messages` and use
  // ONLY `promptText` as the user turn, whereas `anthropic-direct` uses `messages`. To
  // work under either, flatten the (usually single-user) message list into a
  // promptText too — a lone user message passes through verbatim; a multi-turn
  // list is role-labelled.
  const promptText =
    opts.messages.length === 1 && opts.messages[0].role === 'user'
      ? opts.messages[0].content
      : opts.messages.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n');

  if (backend === 'codex') {
    return llmCallViaCodexGateway(opts, model, promptText);
  }

  // Reuse the shared runner's actual HTTP boundary, rather than inferring egress
  // from its backend label. Retain before failure, including SDK-internal retries.
  const transportDiagnostics: LlmTransportDiagnostic[] = [];
  const promptSha256 = createHash('sha256').update(JSON.stringify({
    system: opts.system ?? null, messages: opts.messages,
  })).digest('hex');

  try {
    for await (const ev of runAgentChat({
      backend,
      model,
      systemPromptText: opts.system,
      messages: opts.messages,
      promptText,
      maxTokens: opts.maxTokens,
      requireOutputTokenLimit: opts.requireOutputTokenLimit,
      authorizeStatelessRequest: opts.authorizeStatelessRequest,
      temperature: opts.temperature,
      thinkingBudgetTokens: opts.thinkingBudgetTokens,
      signal: opts.signal,
      // Inference-gateway admission-tier label (gateway-priority-tiers): attached as
      // the `x-papercusp-priority` header on the in-process anthropic-direct call so
      // the pacing gateway tiers this caller (e.g. 'scout' → tier 1) instead of the
      // first-shed default band. No-op for the subprocess backends.
      // EI-315: this used to pass `opts.priority` through UNDEFAULTED — every llm-testing
      // scenario run (sim-user + judge calls) is unlabeled, so it fell through tierOf()'s
      // fallback to the map's bottom `default` band (tier 5), the most aggressively AIMD-shed
      // tier under fleet load. That's the literal root cause of "17/17 attempts 429-capped over
      // 7h": llm-testing traffic was competing for gateway slots from the WORST possible
      // priority band. Defaulting to 'llm-testing' (mapped to tier 4, alongside `gym`/
      // `benchmark` — DEFAULT_GATEWAY_PRIORITY_MAP) gives it the same batch-lane floor those
      // callers already get, without a new dedicated account/quota (the original 2026-06-11
      // triage's proposed fix, gated on an owner capacity decision that predates this tier
      // system entirely — gateway-priority-tiers-2026-06-22 landed after this item was filed).
      priority: opts.priority ?? 'llm-testing',
      // WI-4475 / EI-11417: `governorMaxWaitMs` bounds the process-local governor;
      // `onAdmitted` observes that local permit, while `onResponseStart` fires only after the
      // request has also cleared the inference gateway and response headers arrive. A caller's
      // generation timer belongs on the latter boundary.
      governorMaxWaitMs: opts.governorMaxWaitMs,
      // WI-5391: bounds the anthropic-direct transient-retry LADDER (all attempts + backoff),
      // the layer governorMaxWaitMs (one admission wait) never covered.
      retryDeadlineMs: opts.retryDeadlineMs,
      onAdmitted: opts.onAdmitted,
      onResponseStart: opts.onResponseStart,
      onTransportDiagnostic: diagnostic => {
        if (transportDiagnostics.length === 64) transportDiagnostics.shift();
        transportDiagnostics.push(diagnostic);
        // Synchronous output survives callers that throw before writing a
        // successful-call receipt. No credentials, text, bodies or arbitrary headers.
        writeSync(1, `[llm-transport] ${JSON.stringify({ ...diagnostic, promptSha256,
          model, ownerId: opts.ownerId ?? null })}\n`);
      },
      ownerId: opts.ownerId,
      // Usage attribution: the priority label already names the caller ('gym',
      // 'scout'); reuse it so this client's header samples stop being anonymous.
      // WI-2144763: forward the caller's harness too. Every `source:'headers'` row left
      // harness_slug NULL (18,228 rows / ~$755, 0.00%) — not because the column or the
      // writer was missing it, but because the attribution TYPE had no field for it. Undefined
      // when the caller did not say, which the host binds as an honest NULL.
      usageAttribution: { role: opts.priority ?? 'llm-testing', harnessSlug: opts.harnessSlug },
      // Isolate subprocess-backend spawns (LLM_TEST_BACKEND=claude-code) from
      // the host ~/.claude. No-op for the default `anthropic-direct` backend (HTTP, no
      // subprocess). Without this, each sim-user/judge `claude` spawn does a
      // 13-server MCP init (context7/github/cloudflare plugins via npx +
      // papercusp-su + connectors) and runs the host SessionStart/PreToolUse
      // hooks — under a real run, sim + judge + brain spawn `claude`
      // concurrently and those heavy inits flake/exit-1, so the sim-user emits
      // unparseable output and gives up at turn 0 (turns=0). The clean config
      // dir cuts the init to 4 servers and drops the hooks → reliable JSON.
      isolateConfig: true,
    })) {
      if (ev.type === 'delta') {
        // Preserve every emitted text fragment. The terminal `result.finalText`
        // below remains authoritative when a backend supplies the complete text,
        // so accumulating deltas cannot double the final response.
        finalText += ev.text;
      } else if (ev.type === 'result') {
        sawResult = true;
        if (ev.finalText) finalText = ev.finalText;
        inputTokens = ev.tokensIn;
        outputTokens = ev.tokensOut;
        if (typeof ev.costUsd === 'number' && Number.isFinite(ev.costUsd) && ev.costUsd >= 0)
          reportedCostUsd = ev.costUsd;
        else costUsdMeasurementMissing = true;
        if (ev.unreportedFrames !== undefined) unreportedFrames = Math.max(unreportedFrames ?? 0, ev.unreportedFrames);
        stopReason = ev.stopReason;
        servedAccount = ev.servedAccount ?? servedAccount;
      } else if (ev.type === 'error') {
        // Fold the subprocess stderr tail into the message: the un-governed CLI path attaches
        // no classified turn, so a bare `<backend> exited 1` is undiagnosable — and the
        // fallback classifier below only sees the message string.
        lastErrMsg = ev.stderr?.trim() ? `${ev.message} — stderr: ${ev.stderr.trim()}` : ev.message;
        // Prefer the structured turn the governed path attaches; else classify the message so a
        // rate-limit is still detected on the un-governed path (RB-006).
        lastErrTurn = ev.turn;
        if (ev.costUsd !== undefined && Number.isFinite(ev.costUsd) && ev.costUsd >= 0) reportedCostUsd = ev.costUsd;
        if (ev.unreportedFrames !== undefined) unreportedFrames = Math.max(unreportedFrames ?? 0, ev.unreportedFrames);
      }
    }
  } catch (error) {
    if (reportedCostUsd !== undefined) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const existingCost = (failure as Error & { costUsd?: unknown }).costUsd;
      if (typeof existingCost !== 'number' || !Number.isFinite(existingCost) || existingCost < 0)
        Object.assign(failure, { costUsd: reportedCostUsd });
      if (unreportedFrames !== undefined && unreportedFrames > 0) Object.assign(failure, { unreportedFrames });
      if (costUsdMeasurementMissing) Object.assign(failure, { costUsdMeasurementMissing: true });
      throw failure;
    }
    throw error;
  }

  if (lastErrMsg !== undefined) {
    const turn = lastErrTurn ?? classifyHttpError({ message: lastErrMsg }, providerForBackend(backend));
    const error = new LlmCallError(turn);
    // Preserve the existing classified error identity/message while letting
    // Gym and the governed-attempt seam retain money spent before the failure.
    // Missing usage must stay absent rather than become an invented free call.
    if (reportedCostUsd !== undefined) Object.assign(error, { costUsd: reportedCostUsd });
    if (unreportedFrames !== undefined && unreportedFrames > 0) Object.assign(error, { unreportedFrames });
    if (costUsdMeasurementMissing) Object.assign(error, { costUsdMeasurementMissing: true });
    if (transportDiagnostics.length) Object.defineProperties(error, {
      transportDiagnostics: { value: Object.freeze([...transportDiagnostics]), enumerable: true },
      promptSha256: { value: promptSha256, enumerable: true },
    });
    // Keep the original classified turn and user-visible message intact.
    throw error;
  }
  if (!sawResult) throw new Error(`llmCall: ${backend} backend produced no result event`);

  let json: unknown;
  if (opts.responseFormat === 'json') {
    json = tryParseJson(finalText);
  }

  return {
    text: finalText,
    json,
    inputTokens,
    outputTokens,
    costUsd: reportedCostUsd ?? 0,
    ...(costUsdMeasurementMissing || reportedCostUsd === undefined || (unreportedFrames ?? 0) > 0
      ? { costUsdMeasurementMissing: true } : {}),
    ...(unreportedFrames === undefined ? {} : { unreportedFrames }),
    stopReason,
    raw: transportDiagnostics.length ? { transportDiagnostics, promptSha256 } : null,
    execution: { model: model ?? opts.model, codeHash: null,
      loadedCode: { llmClient: LLM_CLIENT_SOURCE_HASH },
      unresolved: ['agent-chat-runtime', 'transport-runtime', 'usage-pricing', 'response-parser'] },
    ...(servedAccount ? { servedAccount } : {}),
  };
}

/**
 * True when the framework can make LLM calls — rides the SAME transport
 * resolution the stateless call path uses (`probeStatelessTransport`: a live
 * Claude OAuth session → anthropic-direct), so availability can never
 * disagree with an actual call. Keeps the legacy ANTHROPIC_API_KEY / PG
 * credentials check as a fall-through so older deploys still work. (The
 * omp-token check this replaced probed a credential the stateless path no
 * longer uses — EI-399.)
 */
export async function isLlmAvailable(): Promise<boolean> {
  if (probeStatelessTransport().ok) return true;
  // Legacy: direct ANTHROPIC_API_KEY env / PG-stored credential
  const env = process.env.ANTHROPIC_API_KEY;
  if (env && env.trim()) return true;
  try {
    const creds = await readCredentials();
    return !!creds.anthropic_api_key?.trim();
  } catch {
    return false;
  }
}
