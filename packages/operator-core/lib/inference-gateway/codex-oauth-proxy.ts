/**
 * codex-oauth-proxy.ts — the PURE, testable half of the codex ChatGPT-subscription
 * OAuth STREAMING proxy (WI-2198, owner-chosen Option B 2026-07-04).
 *
 * THE PROBLEM
 * -----------
 * A codex FLEET agent runs the real `codex` CLI configured with a custom
 * `model_provider` (papercusp-codex-gateway, `wire_api = "responses"`) pointed at
 * OUR gateway — so it STREAMS native Responses requests to `/v1/responses`. The
 * pre-existing bridge (`codex-cli-bridge.ts`) serves that by shelling out to
 * `codex exec` ONE-SHOT and REJECTS `stream:true` — fine for the low-volume
 * in-process scout/judge callers, useless for a streaming fleet agent.
 *
 * THE FIX (this module + `serveCodexOAuthProxy` in gateway.ts)
 * -----------------------------------------------------------
 * A TRANSPARENT reverse-proxy: forward the codex CLI's native Responses request
 * straight to the real ChatGPT backend (`chatgpt.com/backend-api/codex/responses`)
 * with the ChatGPT-subscription OAuth bearer injected from `~/.codex/auth.json`,
 * stream the SSE back untouched, and refresh the token on expiry/401. The codex
 * CLI keeps ALL of its own multi-turn / tool-call / session state — the gateway is
 * STATELESS per request; it only swaps auth in and meters/paces. This module owns
 * the auth + header + refresh logic (unit-tested here); gateway.ts owns the
 * streaming plumbing (reusing its stall-guards + AIMD + admission slot).
 *
 * REVERSE-ENGINEERED TRANSPORT (from ~/.codex/auth.json + the codex binary, 2026-07-04):
 *   auth.json  = { auth_mode:"chatgpt", tokens:{ access_token, refresh_token,
 *                  account_id, id_token }, last_refresh }
 *   backend    = https://chatgpt.com/backend-api/codex/responses
 *   refresh    = form-urlencoded POST https://auth.openai.com/oauth/token
 *                (grant_type=refresh_token, refresh_token, client_id)
 *   headers    = Authorization: Bearer <access_token>, ChatGPT-Account-Id,
 *                OpenAI-Beta: responses=experimental, originator: codex_cli_rs
 *
 * Every constant is env-overridable so a rotated client_id / moved endpoint is a
 * config change, not a redeploy (the OAuth transport is proprietary + unversioned).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseBridgeModel } from './codex-cli-bridge';
import { parseProviderReset } from './provider-reset';
import { CODEX_MODEL_REFUSAL_RE } from './codex-model-refusals';

/** The ChatGPT backend that serves codex Responses for ChatGPT-subscription auth. */
export const CODEX_CHATGPT_BACKEND_BASE =
  process.env.CODEX_CHATGPT_BACKEND_BASE || 'https://chatgpt.com/backend-api/codex';

/** OAuth token endpoint for the refresh_token grant. */
export const CODEX_OAUTH_TOKEN_URL = process.env.CODEX_OAUTH_TOKEN_URL || 'https://auth.openai.com/oauth/token';

/** The codex CLI's public OAuth client_id (from the codex binary; well-known).
 *  Env-overridable because OpenAI can rotate it and it is undocumented. */
export const CODEX_OAUTH_CLIENT_ID = process.env.CODEX_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';

/** codex stamps this originator on every ChatGPT-backend request. */
export const CODEX_ORIGINATOR = process.env.CODEX_ORIGINATOR || 'codex_cli_rs';

/** The OpenAI-Beta header value codex sends for the Responses backend. */
export const CODEX_OPENAI_BETA = process.env.CODEX_OPENAI_BETA || 'responses=experimental';

/** Public Luna model id and the ChatGPT-backend reserve tier that serves it.
 *
 * The subscription backend exposes a second, hidden model id (`gpt-reserve`) for
 * the base-model-inference reserve bucket.  A normal `gpt-5.6-luna` request can
 * therefore receive a premium-window 429 while the same account still has Luna
 * reserve capacity.  Keep these ids together at this transport seam; callers
 * should never expose the hidden id to downstream clients. */
export const CODEX_LUNA_MODEL = 'gpt-5.6-luna';
export const CODEX_LUNA_RESERVE_MODEL = 'gpt-reserve';

/** Refresh proactively when the access token expires within this window (ms). */
const EXPIRY_SKEW_MS = 60_000;

export interface CodexAuth {
  authMode: string | null;
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
  idToken: string | null;
  lastRefresh: string | null;
}

/** Absolute path to a codex home's auth.json. */
export function codexAuthPath(home: string): string {
  return path.join(home, 'auth.json');
}

/**
 * Resolve the CODEX_HOME whose ChatGPT credential a launch will use. A named
 * pool account points at its `codex-cli:<home>` credential; default routing
 * uses the local CLI home only when it has auth.json; gateway-routed accounts
 * have no local home to preflight. Resolution is deliberately fail-open: an
 * unavailable account registry must not turn a launch diagnostic into a
 * launch blocker.
 */
export async function resolveCodexPreflightHome(
  account: string | undefined,
  workspaceId: string,
): Promise<string | null> {
  try {
    const trimmed = account?.trim();
    if (!trimmed || trimmed === 'default') {
      const os = await import('node:os');
      const home = path.join(os.homedir(), '.codex');
      await fs.access(codexAuthPath(home));
      return home;
    }
    if (trimmed === 'auto') return null;
    const [{ loadAccountPool }, { parseCodexCliRef }] = await Promise.all([
      import('../deployment/account-pool-store'),
      import('./codex-cli-bridge'),
    ]);
    const row = (await loadAccountPool(workspaceId)).accounts.find((a) => a.id === trimmed);
    return row ? parseCodexCliRef(row.credentialRef ?? '') : null;
  } catch {
    return null;
  }
}

/** Read + validate a codex home's auth.json. Returns null if absent / malformed /
 *  not a usable ChatGPT-subscription credential (no access_token). */
export async function readCodexAuth(home: string): Promise<CodexAuth | null> {
  let raw: string;
  try {
    raw = await fs.readFile(codexAuthPath(home), 'utf8');
  } catch {
    return null;
  }
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const obj = j as Record<string, unknown>;
  const tokens = (obj.tokens && typeof obj.tokens === 'object' ? obj.tokens : {}) as Record<string, unknown>;
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
  if (!accessToken) return null;
  return {
    authMode: typeof obj.auth_mode === 'string' ? obj.auth_mode : null,
    accessToken,
    refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
    accountId: typeof tokens.account_id === 'string' ? tokens.account_id : null,
    idToken: typeof tokens.id_token === 'string' ? tokens.id_token : null,
    lastRefresh: typeof obj.last_refresh === 'string' ? obj.last_refresh : null,
  };
}

/** Decode a JWT's `exp` (seconds since epoch) without verifying the signature.
 *  Returns null for a non-JWT / unparseable token (→ treat as never-proactively-expiring;
 *  the 401-retry backstop still covers a genuinely-expired token). */
export function jwtExpMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** True if the access token is expired or within EXPIRY_SKEW_MS of expiry. `nowMs`
 *  is injectable for tests. A token with no decodable exp is treated as NOT expired
 *  (the 401 backstop handles it) so we never refresh-spam an opaque token. */
export function accessTokenExpired(accessToken: string, nowMs: number): boolean {
  const exp = jwtExpMs(accessToken);
  if (exp === null) return false;
  return nowMs >= exp - EXPIRY_SKEW_MS;
}

/** The upstream URL for an incoming gateway Responses request: rewrite the codex
 *  CLI's `/v1/responses[...]` onto the ChatGPT backend base (which already ends in
 *  `/codex`), preserving any query string. `/v1/responses` → `<base>/responses`. */
export function codexBackendUrl(incomingUrl: string): string {
  const stripped = incomingUrl.replace(/^\/v1/, '');
  return `${CODEX_CHATGPT_BACKEND_BASE}${stripped}`;
}

/** Return the hidden reserve model when a request names public Luna (including
 * Papercusp aliases and effort suffixes), otherwise null. Pure. */
export function codexReserveModelFor(model: string | null | undefined): string | null {
  if (!model?.trim()) return null;
  return parseBridgeModel(model).id === CODEX_LUNA_MODEL ? CODEX_LUNA_RESERVE_MODEL : null;
}

/** Replace only the JSON Responses `model` field for a retry on a hidden
 * ChatGPT-subscription tier. Malformed/non-object bodies are returned unchanged
 * so this helper cannot turn a client error into a transport error. Pure. */
export function rewriteCodexRequestModel(bodyBuf: Buffer, upstreamModel: string): Buffer {
  if (!bodyBuf.length || !upstreamModel.trim()) return bodyBuf;
  try {
    const parsed = JSON.parse(bodyBuf.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyBuf;
    const body = parsed as Record<string, unknown>;
    if (typeof body.model !== 'string' || body.model === upstreamModel) return bodyBuf;
    body.model = upstreamModel;
    return Buffer.from(JSON.stringify(body), 'utf8');
  } catch {
    return bodyBuf;
  }
}

/**
 * Normalize public Responses API bodies for the proprietary ChatGPT subscription
 * backend, which accepts only the canonical input-item LIST, requires `store:false`,
 * and accepts a bare upstream model id rather than Papercusp's `:<effort>` spec.
 *
 * The public API defines a string as one user text message, so the expansion is
 * semantics-preserving. ChatGPT subscription requests cannot use API-side response
 * storage, so force that backend contract here instead of making every compatible
 * gateway client know it. Omitted model fields are resolved to the managed Codex
 * default, while bodies that already use a canonical model/list input and
 * `store:false` are returned byte-identically. Malformed or non-object bodies are
 * returned unchanged; an explicitly denied model is thrown so callers cannot
 * silently forward it. This belongs at
 * the ChatGPT OAuth seam (not the bearer OpenAI path): api.openai.com already accepts
 * the shorthand and its own storage semantics, while chatgpt.com rejects incompatible
 * bodies with `400 Input must be a list` / `400 Store must be set to false`.
 */
export function normalizeCodexChatGptResponsesBody(bodyBuf: Buffer): { body: Buffer; inputNormalized: boolean } {
  if (!bodyBuf.length) return { body: bodyBuf, inputNormalized: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyBuf.toString('utf8')) as unknown;
  } catch {
    return { body: bodyBuf, inputNormalized: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { body: bodyBuf, inputNormalized: false };
  }
  const body = parsed as Record<string, unknown>;
  const modelSpec = typeof body.model === 'string' ? body.model : null;
  // The gateway is a managed Codex boundary: an omitted model is resolved to
  // the same safe default as launch/config writers, while an explicit Spark
  // spelling throws before any upstream request or account work.
  const parsedModel = parseBridgeModel(modelSpec ?? undefined);
  const modelNormalized = modelSpec === null || parsedModel.id !== modelSpec;
  if (modelNormalized) {
    body.model = parsedModel.id;
    const reasoning =
      body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)
        ? (body.reasoning as Record<string, unknown>)
        : {};
    const existingEffort = typeof reasoning.effort === 'string' ? reasoning.effort.trim() : '';
    const existingEffortValid = /^(minimal|low|medium|high|xhigh|max)$/i.test(existingEffort);
    // A model suffix is authoritative (`model:high`), but callers may provide
    // reasoning.effort independently of the model. Preserve that explicit
    // value when the model was merely omitted/aliased; otherwise the default
    // model policy would silently downgrade a requested effort to medium.
    const modelCarriesEffort = typeof modelSpec === 'string' && /:(minimal|low|medium|high|xhigh|max)$/i.test(modelSpec.trim());
    body.reasoning = {
      ...reasoning,
      effort: modelCarriesEffort || !existingEffortValid ? parsedModel.effort : existingEffort.toLowerCase(),
    };
  }
  const maxOutputTokensNormalized = Object.prototype.hasOwnProperty.call(body, 'max_output_tokens');
  if (maxOutputTokensNormalized) delete body.max_output_tokens;
  const inputNormalized = typeof body.input === 'string';
  if (inputNormalized) {
    body.input = [{ role: 'user', content: [{ type: 'input_text', text: body.input }] }];
  }
  const storeNormalized = body.store !== false;
  if (storeNormalized) body.store = false;
  if (!modelNormalized && !maxOutputTokensNormalized && !inputNormalized && !storeNormalized) {
    return { body: bodyBuf, inputNormalized: false };
  }
  return { body: Buffer.from(JSON.stringify(body), 'utf8'), inputNormalized };
}

/** Add the streaming wire bit used by the ChatGPT backend while keeping the public
 * non-stream request shape. The gateway consumes the resulting SSE and returns the
 * final `response.completed.response` object to the caller. */
export function makeCodexNonStreamUpstreamBody(bodyBuf: Buffer): Buffer | null {
  if (!bodyBuf.length) return null;
  try {
    const parsed = JSON.parse(bodyBuf.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const body = parsed as Record<string, unknown>;
    body.stream = true;
    body.store = false;
    return Buffer.from(JSON.stringify(body), 'utf8');
  } catch {
    return null;
  }
}

export type CodexNonStreamAggregateErrorCode = 'aborted' | 'timeout' | 'size' | 'invalid';

/** Typed failure from the bounded non-stream OAuth compatibility transport. */
export class CodexNonStreamAggregateError extends Error {
  constructor(
    readonly code: CodexNonStreamAggregateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CodexNonStreamAggregateError';
  }
}

export interface CodexNonStreamAggregateOpts {
  /** Upstream content type. `text/event-stream` selects SSE; JSON is the safe fallback. */
  contentType?: string | null;
  /** Hard cap on bytes read from the upstream response. */
  maxBytes: number;
  /** Hard wall-clock cap for reading and aggregating the response. */
  timeoutMs: number;
  /** Downstream cancellation / gateway request ceiling signal. */
  signal?: AbortSignal;
  /** Abort the active fetch when the aggregation deadline fires. */
  onTimeout?: () => void;
}

/**
 * Consume one ChatGPT Responses response without retaining an unbounded body.
 *
 * The OAuth backend speaks SSE even when the caller asked for `stream:false`.
 * We retain only the final `response.completed` object, return it as ordinary
 * Responses JSON, and reject malformed/incomplete streams. The production ChatGPT
 * endpoint has also been observed returning this SSE with NO Content-Type header
 * (WI-284159), so the parser sniffs the bounded opening bytes for `event:`/`data:`
 * instead of trusting the header alone. A JSON response is accepted too so a
 * backend rollout that ignores `stream:true` remains compatible.
 * The iterator is raced against both cancellation and a wall-clock deadline;
 * callers should use `onTimeout` to abort the underlying fetch as well.
 */
export async function aggregateCodexNonStreamResponse(
  source: AsyncIterable<Uint8Array>,
  opts: CodexNonStreamAggregateOpts,
): Promise<Buffer> {
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes));
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs));
  const iterator = source[Symbol.asyncIterator]();
  let totalBytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let stopped = false;

  const stopIterator = () => {
    if (stopped) return;
    stopped = true;
    try {
      void iterator.return?.();
    } catch {
      /* best-effort cancellation; the fetch signal is the hard stop */
    }
  };
  // The explicit type ANNOTATION on the binding (not just the `: never` return
  // type on the arrow) is what lets control-flow analysis treat a `fail(...)`
  // call as unreachable-after. Without it TS keeps `next` as the full
  // `'aborted' | 'timeout' | IteratorResult<...>` union past the guards below.
  const fail: (code: CodexNonStreamAggregateErrorCode, message: string) => never = (code, message) => {
    stopIterator();
    throw new CodexNonStreamAggregateError(code, message);
  };

  let timeoutResolve!: () => void;
  const timeout = new Promise<'timeout'>((resolve) => {
    // Wrap rather than aliasing `resolve` directly: the promise is
    // `Promise<'timeout'>`, so its resolver requires the value, while the
    // cleanup in `finally` calls `timeoutResolve()` with no argument. Aliasing
    // settled it with `undefined` — a value outside its own declared type.
    timeoutResolve = () => resolve('timeout');
    timer = setTimeout(() => {
      // Settle the race as 'timeout' BEFORE the transport hook runs: the gateway's onTimeout aborts
      // the request signal, which resolves the `aborted` racer, and with the hook first the race read
      // a DEADLINE as a client ABORT — the gateway then destroyed the socket silently (no 504, no
      // log) instead of answering the timeout it had itself declared (plan
      // codex-auto-route-all-walled-fail-fast-2026-09-05, P-004).
      resolve('timeout');
      opts.onTimeout?.();
    }, timeoutMs);
    timer.unref?.();
  });
  let abortResolve!: (value: 'aborted') => void;
  const aborted = new Promise<'aborted'>((resolve) => {
    abortResolve = resolve;
  });
  if (opts.signal) {
    abortListener = () => abortResolve('aborted');
    if (opts.signal.aborted) abortListener();
    else opts.signal.addEventListener('abort', abortListener, { once: true });
  }

  const contentType = (opts.contentType ?? '').toLowerCase();
  let responseKind: 'sse' | 'json' | 'unknown' = contentType.includes('text/event-stream')
    ? 'sse'
    : contentType.includes('application/json')
      ? 'json'
      : 'unknown';
  const decoder = new StringDecoder('utf8');
  let text = '';
  const sseData: string[] = [];
  let completed: Record<string, unknown> | undefined;
  const completedOutputItems = new Map<number, Record<string, unknown>>();
  let jsonChunks: Buffer[] = [];
  const sniffChunks: Buffer[] = [];
  let sniffBytes = 0;
  const SNIFF_LIMIT = 256;

  const consumeSseFrame = (data: string) => {
    const payload = data.trim();
    if (!payload || payload === '[DONE]') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      fail('invalid', 'codex OAuth non-stream response contained malformed SSE JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const event = parsed as { type?: unknown; response?: unknown; output_index?: unknown; item?: unknown };
    if (
      event.type === 'response.output_item.done' &&
      typeof event.output_index === 'number' &&
      Number.isInteger(event.output_index) &&
      event.output_index >= 0 &&
      event.item &&
      typeof event.item === 'object' &&
      !Array.isArray(event.item)
    ) {
      completedOutputItems.set(event.output_index, event.item as Record<string, unknown>);
    }
    if (
      event.type === 'response.completed' &&
      event.response &&
      typeof event.response === 'object' &&
      !Array.isArray(event.response)
    ) {
      const response = event.response as Record<string, unknown>;
      const responseOutput = Array.isArray(response.output) ? response.output : [];
      // The live ChatGPT backend sends each completed output item in its own SSE
      // event, then terminates with `response.completed.response.output: []`.
      // A streaming Codex client reconstructs that state itself; this non-stream
      // compatibility endpoint must do the same or it returns HTTP 200 with no
      // assistant text (the second half of WI-284159).
      const reconstructedOutput = [...completedOutputItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      const output = responseOutput.length > 0 ? responseOutput : reconstructedOutput;
      const outputText = output
        .flatMap((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
          const content = (item as { content?: unknown }).content;
          if (!Array.isArray(content)) return [];
          return content.flatMap((part) => {
            if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
            const typed = part as { type?: unknown; text?: unknown };
            return typed.type === 'output_text' && typeof typed.text === 'string' ? [typed.text] : [];
          });
        })
        .join('');
      completed = {
        ...response,
        output,
        ...(typeof response.output_text === 'string' || !outputText ? {} : { output_text: outputText }),
      };
    }
  };
  const consumeSseText = (chunk: string) => {
    text += chunk;
    const lines = text.split(/\r?\n/);
    text = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data:')) sseData.push(line.slice(5).replace(/^ /, ''));
      else if (line === '' && sseData.length) {
        consumeSseFrame(sseData.join('\n'));
        sseData.length = 0;
      }
    }
    if (completed) stopIterator();
  };

  try {
    while (!completed) {
      const next = await Promise.race([iterator.next(), timeout, aborted]);
      if (next === 'timeout') fail('timeout', `codex OAuth non-stream response timed out after ${timeoutMs}ms`);
      if (next === 'aborted') fail('aborted', 'codex OAuth non-stream response aggregation aborted');
      if (next.done) break;
      const chunk = next.value;
      const bytes = chunk instanceof Uint8Array ? chunk.byteLength : 0;
      totalBytes += bytes;
      if (totalBytes > maxBytes) fail('size', `codex OAuth non-stream response exceeded ${maxBytes}-byte limit`);
      const chunkBuffer = Buffer.from(chunk);
      if (responseKind === 'sse') {
        consumeSseText(decoder.write(chunkBuffer));
      } else {
        jsonChunks.push(chunkBuffer);
        // ChatGPT's live Responses endpoint can omit Content-Type entirely while
        // still sending canonical SSE beginning with `event:`. Retain at most a
        // tiny bounded prefix for detection; once promoted, replay every buffered
        // byte through the SSE decoder so a frame split across chunks is lossless.
        if (responseKind === 'unknown' && sniffBytes < SNIFF_LIMIT) {
          const remaining = SNIFF_LIMIT - sniffBytes;
          const prefixChunk = chunkBuffer.subarray(0, remaining);
          sniffChunks.push(prefixChunk);
          sniffBytes += prefixChunk.byteLength;
          const prefix = Buffer.concat(sniffChunks, sniffBytes).toString('utf8').trimStart();
          if (/^(?:event|data):/.test(prefix)) {
            responseKind = 'sse';
            const buffered = Buffer.concat(jsonChunks);
            jsonChunks = [];
            consumeSseText(decoder.write(buffered));
          } else if (prefix.startsWith('{') || prefix.startsWith('[')) {
            responseKind = 'json';
          }
        }
      }
    }
    if (responseKind === 'sse') {
      consumeSseText(decoder.end());
      if (sseData.length) consumeSseFrame(sseData.join('\n'));
      if (!completed) fail('invalid', 'codex OAuth non-stream SSE ended without response.completed');
      return Buffer.from(JSON.stringify(completed), 'utf8');
    }
    const body = Buffer.concat(jsonChunks);
    try {
      const parsed = JSON.parse(body.toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('invalid', 'codex OAuth non-stream response was not a JSON object');
      }
    } catch (error) {
      if (error instanceof CodexNonStreamAggregateError) throw error;
      fail('invalid', 'codex OAuth non-stream response was not valid JSON');
    }
    return body;
  } finally {
    if (timer) clearTimeout(timer);
    // Keep the promise settled and avoid retaining listeners after a completed response.
    timeoutResolve();
    if (opts.signal && abortListener) opts.signal.removeEventListener('abort', abortListener);
  }
}

/** Provider-authored completion evidence for an accepted Responses request.
 * OpenAI input_tokens includes its cached subset; keep that basis explicit so
 * completion does not compare it to the transcript's uncached input column. */
export interface CodexProviderCompletionEvidence {
  responseId: string;
  model: string;
  /** Optional provider echo. Absence leaves forwarded request effort as the
   * only evidence and must never be described as provider-observed effort. */
  providerEffort: string | null;
  usage: {
    inputTokens: number;
    inputTokenBasis: 'inclusive';
    outputTokens: number;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
  };
}

/** Incremental SSE/JSON decoder shared by the bearer and OAuth relays. It
 * accepts only a provider response.completed object, never a request model or
 * the cli-exec bridge's synthetic response. One frame is bounded independently
 * of the stream length, so long agent turns need no whole-stream buffer. */
export function createCodexProviderCompletionDecoder(contentType: string) {
  const sse = contentType.toLowerCase().includes('text/event-stream');
  if (!sse && !contentType.toLowerCase().includes('application/json')) {
    throw new Error('accepted Codex response has an unsupported content type');
  }
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let completed: CodexProviderCompletionEvidence | null = null;
  const maxBytes = sse ? 1_048_576 : 8_388_608;
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const readResponse = (value: unknown): CodexProviderCompletionEvidence => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('accepted Codex response has no provider completion object');
    }
    const response = value as Record<string, unknown>;
    const reasoning = response.reasoning && typeof response.reasoning === 'object' &&
      !Array.isArray(response.reasoning) ? response.reasoning as Record<string, unknown> : null;
    const rawEffort = reasoning?.effort;
    if (rawEffort !== undefined && rawEffort !== null &&
        (typeof rawEffort !== 'string' || !rawEffort.trim())) {
      throw new Error('accepted Codex response has invalid provider reasoning effort');
    }
    const providerEffort = typeof rawEffort === 'string' ? rawEffort.trim().toLowerCase() : null;
    const usage = response.usage && typeof response.usage === 'object' && !Array.isArray(response.usage)
      ? response.usage as Record<string, unknown> : null;
    const details = usage?.input_tokens_details && typeof usage.input_tokens_details === 'object' &&
      !Array.isArray(usage.input_tokens_details)
      ? usage.input_tokens_details as Record<string, unknown> : null;
    const input = count(usage?.input_tokens);
    const output = count(usage?.output_tokens);
    const cacheRead = count(details?.cached_tokens);
    const cacheWrite = count(details?.cache_write_tokens);
    if (typeof response.id !== 'string' || !response.id ||
        typeof response.model !== 'string' || !response.model || input === null || output === null ||
        (cacheRead !== null && cacheRead > input) ||
        (cacheRead !== null && cacheWrite !== null && cacheRead + cacheWrite > input)) {
      throw new Error('accepted Codex response lacks provider model or valid token usage');
    }
    return { responseId: response.id, model: response.model, providerEffort,
      usage: { inputTokens: input, inputTokenBasis: 'inclusive', outputTokens: output,
        cacheReadTokens: cacheRead, cacheCreationTokens: cacheWrite } };
  };
  const readFrame = (frame: string): CodexProviderCompletionEvidence | null => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n').trim();
    if (!data || data === '[DONE]') return null;
    let event: unknown;
    try { event = JSON.parse(data); } catch { throw new Error('accepted Codex response has malformed SSE JSON'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
    const typed = event as { type?: unknown; response?: unknown };
    return typed.type === 'response.completed' ? readResponse(typed.response) : null;
  };
  const push = (chunk: Uint8Array): CodexProviderCompletionEvidence | null => {
    carry += decoder.write(Buffer.from(chunk));
    if (!sse) {
      if (carry.length > maxBytes) throw new Error('accepted Codex response evidence frame exceeds its bound');
      return null;
    }
    const boundaries = /\r?\n\r?\n/g;
    let boundary: RegExpExecArray | null;
    let frameStart = 0;
    let newlyCompleted: CodexProviderCompletionEvidence | null = null;
    while ((boundary = boundaries.exec(carry))) {
      const frame = carry.slice(frameStart, boundary.index);
      frameStart = boundaries.lastIndex;
      if (frame.length > maxBytes) throw new Error('accepted Codex response evidence frame exceeds its bound');
      const evidence = readFrame(frame);
      if (evidence) {
        if (completed) throw new Error('accepted Codex response has duplicate completions');
        completed = evidence;
        newlyCompleted = evidence;
      }
    }
    carry = carry.slice(frameStart);
    if (carry.length > maxBytes) throw new Error('accepted Codex response evidence frame exceeds its bound');
    return newlyCompleted;
  };
  const finish = (): CodexProviderCompletionEvidence => {
    carry += decoder.end();
    if (carry.length > maxBytes) throw new Error('accepted Codex response evidence frame exceeds its bound');
    if (sse) {
      const tail = carry.trim();
      if (tail) {
        const evidence = readFrame(tail);
        if (evidence) {
          if (completed) throw new Error('accepted Codex response has duplicate completions');
          completed = evidence;
        }
      }
    } else {
      let body: unknown;
      try { body = JSON.parse(carry); } catch { throw new Error('accepted Codex response has malformed JSON'); }
      completed = readResponse(body);
    }
    if (!completed) throw new Error('accepted Codex response ended without provider completion');
    return completed;
  };
  return { push, finish };
}

/** Build the upstream request headers: start from the codex CLI's incoming headers
 *  (minus hop-by-hop / auth / host, which the caller strips), then inject the
 *  ChatGPT-subscription OAuth bearer + account + originator. Session/thread ids the
 *  codex CLI already sent as headers pass through untouched. */
export function buildCodexUpstreamHeaders(args: {
  base: Record<string, string>;
  accessToken: string;
  accountId: string | null;
}): Record<string, string> {
  const h: Record<string, string> = { ...args.base };
  h.authorization = `Bearer ${args.accessToken}`;
  if (args.accountId) h['chatgpt-account-id'] = args.accountId;
  // Only set the codex signatures the CLI didn't already provide (it usually does).
  if (!Object.keys(h).some((k) => k.toLowerCase() === 'originator')) h.originator = CODEX_ORIGINATOR;
  if (!Object.keys(h).some((k) => k.toLowerCase() === 'openai-beta')) h['openai-beta'] = CODEX_OPENAI_BETA;
  h['accept-encoding'] = 'identity';
  return h;
}

// Per-home in-flight refresh, so 10 fleet agents sharing one auth.json can't stampede
// the OAuth endpoint or clobber each other's write — concurrent callers await the same
// promise. Keyed by home; cleared when it settles.
const refreshInFlight = new Map<string, Promise<CodexAuth>>();

export interface RefreshOpts {
  clientId?: string;
  fetchImpl?: typeof fetch;
  /** Skip the atomic write-back to auth.json (tests). */
  noPersist?: boolean;
}

/** Refresh the access token via the refresh_token grant, persist the new tokens back
 *  to auth.json atomically, and return the fresh CodexAuth. Coalesced per home. Re-reads
 *  auth.json first so a token codex itself already refreshed is picked up without a call. */
export function refreshCodexToken(home: string, current: CodexAuth, opts: RefreshOpts = {}): Promise<CodexAuth> {
  const existing = refreshInFlight.get(home);
  if (existing) return existing;
  const p = doRefresh(home, current, opts).finally(() => {
    if (refreshInFlight.get(home) === p) refreshInFlight.delete(home);
  });
  refreshInFlight.set(home, p);
  return p;
}

async function doRefresh(home: string, current: CodexAuth, opts: RefreshOpts): Promise<CodexAuth> {
  // Someone (codex itself, or a peer) may have refreshed the shared file already.
  const onDisk = await readCodexAuth(home);
  if (onDisk && onDisk.accessToken !== current.accessToken && !accessTokenExpired(onDisk.accessToken, Date.now())) {
    return onDisk;
  }
  const refreshToken = (onDisk?.refreshToken ?? current.refreshToken) || '';
  if (!refreshToken) throw new Error('codex-oauth-proxy: no refresh_token in auth.json — re-login with `codex`');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const clientId = opts.clientId ?? CODEX_OAUTH_CLIENT_ID;
  const res = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`codex-oauth-proxy: token refresh failed ${res.status} ${detail.slice(0, 200)}`);
  }
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
  if (!body.access_token) throw new Error('codex-oauth-proxy: token refresh returned no access_token');
  const next: CodexAuth = {
    authMode: current.authMode ?? 'chatgpt',
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? refreshToken,
    accountId: onDisk?.accountId ?? current.accountId,
    idToken: body.id_token ?? onDisk?.idToken ?? current.idToken,
    lastRefresh: new Date().toISOString(),
  };
  if (!opts.noPersist) await persistCodexAuth(home, next);
  return next;
}

/** Atomically write the refreshed tokens back to auth.json (tmp + rename) so a
 *  concurrent reader (codex CLI / a peer gateway) never sees a half-written file. */
export async function persistCodexAuth(home: string, auth: CodexAuth): Promise<void> {
  const target = codexAuthPath(home);
  // Preserve any unknown top-level fields codex may write.
  let prior: Record<string, unknown> = {};
  try {
    prior = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh / unreadable — write a minimal valid shape */
  }
  const merged = {
    ...prior,
    auth_mode: auth.authMode ?? 'chatgpt',
    tokens: {
      ...((prior.tokens && typeof prior.tokens === 'object' ? prior.tokens : {}) as Record<string, unknown>),
      access_token: auth.accessToken,
      refresh_token: auth.refreshToken,
      account_id: auth.accountId,
      id_token: auth.idToken,
    },
    last_refresh: auth.lastRefresh,
  };
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}

/** Resolve a usable access token for a home: read auth.json, refresh proactively if
 *  the token is expired/near-expiry. Returns { auth } or throws with a clear reason.
 *  The 401-on-request backstop (in gateway.ts) covers a token that expires between
 *  this check and the upstream call. */
export async function resolveCodexAccessToken(
  home: string,
  opts: RefreshOpts & { nowMs?: number } = {},
): Promise<CodexAuth> {
  const auth = await readCodexAuth(home);
  if (!auth) throw new Error(`codex-oauth-proxy: no usable auth.json at ${codexAuthPath(home)}`);
  if (accessTokenExpired(auth.accessToken, opts.nowMs ?? Date.now())) {
    return refreshCodexToken(home, auth, opts);
  }
  return auth;
}

/** Test-only: clear the per-home refresh coalescing map. */
export function __resetCodexRefreshState(): void {
  refreshInFlight.clear();
}

// ---------------------------------------------------------------------------
// Codex model preflight (EI-20362893066852316)
// ---------------------------------------------------------------------------

export type CodexModelPreflight =
  | { verdict: 'ok'; status: number }
  | { verdict: 'refused'; status: number; detail: string }
  | { verdict: 'unknown'; status?: number; detail: string };

/** Matches the ChatGPT backend's definitive model refusal, e.g.
 *  `"detail":"The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account."` */
const MODEL_REFUSAL_RE = CODEX_MODEL_REFUSAL_RE; // one detector for preflight + live failover (WI-10003306)

/**
 * EI-20362893066852316: ONE tiny streaming request against the ChatGPT codex backend to answer
 * "will this subscription actually serve `model`?" BEFORE a fleet wave opens N terminals onto a
 * per-turn refusal (burned a 4-member wave on bare 'gpt-5.6', 2026-08-13 — working ids are
 * family-suffixed, e.g. gpt-5.6-sol).
 *
 * FAIL-OPEN BY DESIGN: only a definitive 4xx whose body matches the model-refusal shape returns
 * `refused`; a transport error, 401/403 (auth), 429 (capacity), 5xx, or an unrecognized body
 * returns `unknown` and the caller should PROCEED (the preflight must never become a new way for
 * a healthy launch to fail). A 200 means the stream opened — we cancel it immediately.
 */
export async function preflightCodexModel(
  home: string,
  model: string,
  deps: {
    fetchImpl?: typeof fetch;
    resolveAuth?: (home: string) => Promise<{ accessToken: string; accountId: string | null }>;
    timeoutMs?: number;
  } = {},
): Promise<CodexModelPreflight> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 20_000;
  let accessToken: string;
  let accountId: string | null;
  try {
    const auth = await (deps.resolveAuth ?? resolveCodexAccessToken)(home);
    accessToken = auth.accessToken;
    accountId = auth.accountId ?? null;
  } catch (e) {
    return { verdict: 'unknown', detail: `oauth resolve failed: ${(e as Error).message}` };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('codex model preflight timeout')), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(`${CODEX_CHATGPT_BACKEND_BASE}/responses`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${accessToken}`,
        ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
        'openai-beta': CODEX_OPENAI_BETA,
        originator: CODEX_ORIGINATOR,
      },
      body: JSON.stringify({
        model,
        stream: true,
        store: false,
        instructions: 'You are a model preflight.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '.' }] }],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        reasoning: { effort: 'low' },
        include: [],
      }),
    } as RequestInit);
    if (res.ok) {
      // Model accepted — the stream opened. Cancel it; the reply is irrelevant.
      try {
        ac.abort();
      } catch {
        /* settled */
      }
      void res.body?.cancel().catch(() => undefined);
      return { verdict: 'ok', status: res.status };
    }
    const bodyText = await res.text().catch(() => '');
    if (
      res.status >= 400 &&
      res.status < 500 &&
      res.status !== 401 &&
      res.status !== 403 &&
      res.status !== 429 &&
      MODEL_REFUSAL_RE.test(bodyText)
    ) {
      return { verdict: 'refused', status: res.status, detail: bodyText.slice(0, 300) };
    }
    return { verdict: 'unknown', status: res.status, detail: bodyText.slice(0, 200) };
  } catch (e) {
    return { verdict: 'unknown', detail: `preflight transport: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Codex rate-limit header dialect (WI-38582)
// ---------------------------------------------------------------------------

/** The account-pool window projection shape (structurally = capacity-probe's `CapacityWindows`;
 *  declared here to keep this module dependency-free of gateway/probe). */
export interface CodexCapacityWindows {
  utilization?: number;
  windowResetAt?: number;
  utilization7d?: number;
  windowResetAt7d?: number;
  /** Which METER produced this reading (EI-22103680502746318). `premium` = the generic weekly/5h
   *  windows (`x-codex-*`) — the meter the account-pool projection (`rate.utilization[7d]`)
   *  describes. `base_model_inference` = the Luna reserve tier (`x-base-model-inference-*`) — a
   *  DIFFERENT meter with its own budget. Writing it into the premium slots un-walls a
   *  weekly-exhausted account (observed 2026-09-02: a `gpt-reserve` probe wrote 0.04 over a 1.00
   *  premium reading, the gateway readmitted the account, live codex traffic burned terminal 429s,
   *  and the next premium reading re-walled it — a burn-governor fact assert/retract + fleet-wide
   *  broadcast on every flip). Absent when no family parsed, so `{}` stays `{}`. */
  bucket?: CodexRateLimitBucket;
}

/** The upstream bucket selected for a Codex response. The backend currently
 * reports `premium` for the ordinary weekly window and
 * `base_model_inference` for the Luna reserve tier. */
export type CodexRateLimitBucket = 'premium' | 'base_model_inference' | 'unknown';

/** Identify the bucket before choosing a header family. Active-limit is the
 * authoritative discriminator when both families are present; the prefix-only
 * fallback keeps older responses usable. Pure. */
export function codexRateLimitBucket(h: Record<string, string | undefined>): CodexRateLimitBucket {
  const lower: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(h)) lower[key.toLowerCase()] = value;
  const active = (lower['x-codex-active-limit'] ?? '').trim().toLowerCase().replace(/-/g, '_');
  if (active === 'base_model_inference' || active === 'basemodelinference') return 'base_model_inference';
  if (active === 'premium') return 'premium';
  const hasReserve = Object.keys(lower).some((key) => key.startsWith('x-base-model-inference-'));
  const hasPremium = Object.keys(lower).some(
    (key) => key.startsWith('x-codex-primary-') || key.startsWith('x-codex-secondary-'),
  );
  if (hasReserve && !hasPremium) return 'base_model_inference';
  if (hasPremium) return 'premium';
  return 'unknown';
}

/** Windows at/under this many minutes land in the SHORT (5h) projection slot; longer ones in the
 *  7d slot. The boundary only has to separate ~300min (5h) from ~10080min (weekly) cleanly. */
const CODEX_SHORT_WINDOW_MAX_MINUTES = 720;

function codexWindowSlot(
  h: Record<string, string | undefined>,
  prefix: string,
  nowMs: number,
): { short: boolean; utilization: number; resetAt?: number } | null {
  const usedRaw = h[`${prefix}-used-percent`];
  const minutesRaw = h[`${prefix}-window-minutes`];
  if (usedRaw === undefined || usedRaw === '') return null;
  const used = Number(usedRaw);
  const minutes = Number(minutesRaw ?? '');
  // A zero/absent window length marks an inactive slot (observed live: pro plans report
  // `x-codex-secondary-window-minutes: 0` with an empty reset — that is "no such window",
  // not a 0-minute window).
  if (!Number.isFinite(used) || !Number.isFinite(minutes) || minutes <= 0) return null;
  let resetAt: number | undefined;
  const resetAtSec = Number(h[`${prefix}-reset-at`] ?? '');
  const resetAfterSec = Number(h[`${prefix}-reset-after-seconds`] ?? h[`${prefix}-reset-after`] ?? '');
  if (Number.isFinite(resetAtSec) && resetAtSec > 0) resetAt = resetAtSec * 1000;
  else if (Number.isFinite(resetAfterSec) && resetAfterSec > 0) resetAt = nowMs + resetAfterSec * 1000;
  return { short: minutes <= CODEX_SHORT_WINDOW_MAX_MINUTES, utilization: Math.max(0, used) / 100, resetAt };
}

function parseCodexWindowFamily(
  h: Record<string, string | undefined>,
  prefixes: readonly string[],
  nowMs: number,
): CodexCapacityWindows {
  const out: CodexCapacityWindows = {};
  for (const prefix of prefixes) {
    const slot = codexWindowSlot(h, prefix, nowMs);
    if (!slot) continue;
    if (slot.short) {
      if (out.utilization === undefined) {
        out.utilization = slot.utilization;
        if (slot.resetAt !== undefined) out.windowResetAt = slot.resetAt;
      }
    } else if (out.utilization7d === undefined) {
      out.utilization7d = slot.utilization;
      if (slot.resetAt !== undefined) out.windowResetAt7d = slot.resetAt;
    }
  }
  return out;
}

/**
 * PURE: the ChatGPT codex backend's rate-limit response headers → the SAME account-pool window
 * projection the Anthropic unified-window parsers feed (WI-38582 — codex accounts read
 * `never-observed` forever because nothing ever parsed this dialect).
 *
 * Dialect (verified live against `chatgpt.com/backend-api/codex/responses`, 2026-08-13):
 *   x-codex-primary-used-percent: 0..100        x-codex-secondary-used-percent
 *   x-codex-primary-window-minutes: e.g. 300|10080 (0 ⇒ slot inactive)
 *   x-codex-primary-reset-at: epoch SECONDS      x-codex-primary-reset-after-seconds
 * Slots are classified by WINDOW LENGTH, not by primary/secondary position: a pro plan reports
 * its weekly window as PRIMARY (10080 min) with no secondary, while plus plans use primary=5h,
 * secondary=weekly. `used-percent` is 0..100 → recorded as a 0..1 fraction; `reset-at` seconds →
 * epoch ms. Returns {} when no codex rate-limit header is present.
 */
export function parseCodexRateLimitHeaders(
  h: Record<string, string | undefined>,
  nowMs: number = Date.now(),
): CodexCapacityWindows {
  const lower: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(h)) lower[key.toLowerCase()] = value;
  const generic = ['x-codex-primary', 'x-codex-secondary'] as const;
  const reserve = ['x-base-model-inference-primary', 'x-base-model-inference-secondary'] as const;
  const bucket = codexRateLimitBucket(lower);
  // When the backend tells us which meter is active, do not project a different
  // family that happens to be present on the same response. This is the key
  // guard against treating the generic weekly wall as Luna capacity (or vice
  // versa). With no active-limit marker, retain the historical generic-first
  // behavior and fall back to the reserve family when it is the only signal.
  const families =
    bucket === 'base_model_inference' ? [reserve] : bucket === 'premium' ? [generic] : [generic, reserve];
  for (const family of families) {
    const parsed = parseCodexWindowFamily(lower, family, nowMs);
    // Stamp the METER the reading came from so projection writers can refuse to write the Luna
    // reserve meter into the premium slots (EI-22103680502746318). Stamped only when a family
    // actually parsed — an empty result stays `{}` so "saw a rate header at all" checks hold.
    if (Object.keys(parsed).length > 0) {
      return { ...parsed, bucket: family === reserve ? 'base_model_inference' : 'premium' };
    }
  }
  return {};
}

/** A window at/over this utilization is EXHAUSTED — the meter that produced the 429. Matches the
 *  Claude selector's `u >= 0.99` disqualification bound so the two lanes agree on "walled". */
const CODEX_EXHAUSTED_UTILIZATION = 0.99;

/**
 * WI-2038027 (codex 429 recovery P1): the CODEX-dialect analogue of gateway.ts's `parseRateReset`
 * — an upstream 429's headers → the instant this ACCOUNT can serve again, for `AccountPool.
 * onExhausted` parking and for the retry-after the gateway hands the caller.
 *
 * Why it exists: the codex kernel adapters were wired to `parseRateReset`, which reads the
 * ANTHROPIC `anthropic-ratelimit-*` dialect (plus a bare numeric `retry-after`) — headers the
 * ChatGPT codex backend never sends. So a weekly-walled codex account was parked only the generic
 * 15s failover backoff, rejoined rotation still walled, and re-burned an upstream 429 on nearly
 * every subsequent request — the same class of bug the Claude pool fixed in 2026-06 ("the
 * 5h-exhaustion failover never fired"). This parser reads the dialect the backend actually
 * speaks (`x-codex-*` / `x-base-model-inference-*`, WI-38582) via `parseCodexRateLimitHeaders`.
 *
 * Semantics:
 *  - resetAt = the LATEST reset among EXHAUSTED windows (util ≥ 0.99): if both the 5h and the
 *    weekly meter are walled, the account cannot serve until BOTH reset; a non-exhausted window
 *    never parks (its reset is routine pacing, not a wall).
 *  - A `retry-after` (numeric seconds — the only form observed from this backend) fills in when
 *    no window is exhausted, and also floors a window-derived reset (trust the larger signal).
 *  - A reset at/before `nowMs` is DROPPED, never returned: `createFailoverPool.onExhausted`
 *    treats a past resetAt as "no reset" and parks FIVE HOURS — a clock-skewed just-past header
 *    must degrade to the caller's short failover backoff instead.
 *  - `transient` = a 429 with NO exhausted window (a burst/pacing throttle — capacity exists),
 *    the codex analogue of the Claude lane's bare-burst-vs-usage-cap split. Callers that shape a
 *    terminal 429 use it to pick between "retry soon" and "walled until reset".
 */
export function parseCodexRateReset(
  h: Record<string, string | undefined>,
  nowMs: number = Date.now(),
): { resetAt: number | null; retryAfterMs: number | null; transient: boolean } {
  const lower: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(h)) lower[key.toLowerCase()] = value;
  let retryAfterMs: number | null = null;
  const retryAfterAt = parseProviderReset(lower['retry-after'], nowMs);
  if (retryAfterAt !== undefined && retryAfterAt > nowMs) retryAfterMs = retryAfterAt - nowMs;

  const windows = parseCodexRateLimitHeaders(lower, nowMs);
  let walledResetAt: number | null = null;
  let sawExhausted = false;
  const consider = (utilization?: number, resetAt?: number) => {
    if (utilization === undefined || utilization < CODEX_EXHAUSTED_UTILIZATION) return;
    sawExhausted = true;
    if (resetAt !== undefined && resetAt > nowMs) {
      walledResetAt = walledResetAt === null ? resetAt : Math.max(walledResetAt, resetAt);
    }
  };
  consider(windows.utilization, windows.windowResetAt);
  consider(windows.utilization7d, windows.windowResetAt7d);

  // api.openai.com's bearer lane speaks the generic OpenAI dialect rather than
  // the ChatGPT subscription's x-codex-* windows. Reset values are durations
  // (`1s`, `6m0s`, `250ms`) and a zero remaining meter names the exhausted
  // window. As above, if both request and token meters are exhausted, the
  // account is not serviceable until BOTH clear, so the later reset wins.
  let transientResetAt: number | null = null;
  const considerOpenAi = (remainingRaw: string | undefined, resetRaw: string | undefined) => {
    const remainingText = remainingRaw?.trim();
    const remaining = remainingText && /^-?\d+(?:\.\d+)?$/.test(remainingText) ? Number(remainingText) : null;
    const resetAt = parseProviderReset(resetRaw, nowMs);
    if (remaining !== null && Number.isFinite(remaining) && remaining <= 0) {
      sawExhausted = true;
      if (resetAt !== undefined && resetAt > nowMs) {
        walledResetAt = walledResetAt === null ? resetAt : Math.max(walledResetAt, resetAt);
      }
      return;
    }
    // A 429 without a zero-remaining marker is a pacing/burst throttle. Preserve
    // its real boundary for the bounded-wait rung without relabelling it a wall.
    if (resetAt !== undefined && resetAt > nowMs) {
      transientResetAt = transientResetAt === null ? resetAt : Math.max(transientResetAt, resetAt);
    }
  };
  considerOpenAi(lower['x-ratelimit-remaining-requests'], lower['x-ratelimit-reset-requests']);
  considerOpenAi(lower['x-ratelimit-remaining-tokens'], lower['x-ratelimit-reset-tokens']);
  const genericResetAt = parseProviderReset(lower['x-ratelimit-reset'], nowMs);
  if (genericResetAt !== undefined && genericResetAt > nowMs) {
    transientResetAt = transientResetAt === null ? genericResetAt : Math.max(transientResetAt, genericResetAt);
  }

  let resetAt: number | null = walledResetAt ?? transientResetAt;
  if (retryAfterMs !== null) {
    const fromRetryAfter = nowMs + retryAfterMs;
    resetAt = resetAt === null ? fromRetryAfter : Math.max(resetAt, fromRetryAfter);
  }
  if (resetAt !== null && resetAt <= nowMs) resetAt = null;
  return { resetAt, retryAfterMs, transient: !sawExhausted };
}
