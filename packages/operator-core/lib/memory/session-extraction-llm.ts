/**
 * SessionExtractionLlm — mem0's fact-extraction LLM riding the Claude
 * session (mem0-extraction-via-claude-session P-002/P-003/P-004).
 *
 * A custom mem0ai LLM implementation (the `ExtractionLlm` seam in
 * `@papercusp/memory`) that runs one-shot `claude-haiku-4-5` completions
 * on the `anthropic-direct` stateless transport: Claude Code's own OAuth
 * session from `~/.claude/.credentials.json`, direct to api.anthropic.com
 * — no API key, no router, no subprocess, $0 marginal on the Max
 * subscription (D-001). Rides `runAgentChat({ backend: 'anthropic-direct' })`
 * exactly like `runHaiku`, so the shared retry loop, rate governor and
 * usage telemetry (`emitStatelessUsage`) come for free — but with
 * RELIABILITY semantics, not runHaiku's best-effort-null (D-005):
 *
 *  - **Strict JSON enforcement**: when mem0 asks for `json_object`, the
 *    response is parsed strictly; malformed output gets ONE repair retry
 *    with a JSON-only nudge, then the adapter THROWS — the cascade
 *    (FallbackExtractionLlm) serves the call from the key rungs rather
 *    than handing mem0 unparseable text it would swallow into a silently
 *    dropped memory.
 *  - **401-driven OAuth refresh** (P-004/D-004): on an auth rejection the
 *    per-process token cache is invalidated, `~/.claude/.credentials.json`
 *    re-read (the claude CLI refreshes it), and the call retried once.
 *    Persistent auth failure marks the session rung DEAD for this process
 *    lifetime (re-probed next boot) and throws `ExtractionAuthError` — the
 *    cascade demotes loudly. The stillborn failure class (an auth error
 *    silently swallowed into no-op writes) is impossible by construction.
 *
 * The factory (`getSessionExtractionLlm`) is what the operator's memory
 * host wires into `MemoryHost.getExtractionLlm`: it gates on the env
 * escape hatch, the process-lifetime demotion flag, token presence, and
 * a cheap liveness probe (the models endpoint with the OAuth header —
 * no tokens billed, mirroring `anthropicKeyUsable`).
 */

import {
  readClaudeOauthToken,
  invalidateClaudeTokenCache,
  resolveAnthropicBaseUrl,
} from '@papercusp/papercusp-shared/agent';
import {
  ExtractionAuthError,
  type ExtractionLlm,
  type ExtractionLlmMessage,
  type ExtractionLlmResponse,
} from '@papercusp/memory';
import { runAgentChat } from '../agent-chat-stream';

const SESSION_EXTRACTION_MODEL =
  process.env.PAPERCUSP_MEM0_EXTRACTION_MODEL ?? 'claude-haiku-4-5';
/** Extraction outputs are fact lists — small, but give headroom for a
 *  busy conversation's worth of facts. */
const DEFAULT_MAX_TOKENS = 4096;
/** Wide enough for a cold-cache first call plus one 529 retry (the
 *  runHaiku rationale), narrow enough that a wedged call can't stall a
 *  remember() indefinitely. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** One completed turn on the stateless transport. */
export interface SessionTurnResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export type SessionTurnRunner = (args: {
  systemPromptText?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  timeoutMs: number;
}) => Promise<SessionTurnResult>;

/** Cumulative usage telemetry for the session extraction rung. The
 *  per-call numbers also flow through the shared stateless usage sink
 *  (`emitStatelessUsage`) — these counters exist so diagnostics (and the
 *  P-005 telemetry test) can see the rung's own totals. */
export interface SessionExtractionUsage {
  calls: number;
  failures: number;
  jsonRepairs: number;
  authRetries: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
}

const _usage: SessionExtractionUsage = {
  calls: 0,
  failures: 0,
  jsonRepairs: 0,
  authRetries: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  model: SESSION_EXTRACTION_MODEL,
};

export function sessionExtractionUsage(): Readonly<SessionExtractionUsage> {
  return _usage;
}

/** Test hook — zero the cumulative counters. */
export function _resetSessionExtractionUsageForTest(): void {
  _usage.calls = 0;
  _usage.failures = 0;
  _usage.jsonRepairs = 0;
  _usage.authRetries = 0;
  _usage.tokensIn = 0;
  _usage.tokensOut = 0;
  _usage.costUsd = 0;
}

/**
 * Process-lifetime demotion flag (D-004): set when the session rung
 * auth-failed even after the refresh+retry. `getSessionExtractionLlm`
 * then resolves null so every later client (re)build lands on the key
 * rungs directly; the next operator boot re-probes.
 */
let _sessionRungDead = false;

export function markSessionExtractionDead(): void {
  _sessionRungDead = true;
}

export function isSessionExtractionDead(): boolean {
  return _sessionRungDead;
}

/** Test hook — revive the rung (a new process would). */
export function _resetSessionExtractionDeadForTest(): void {
  _sessionRungDead = false;
}

/** Does an error message look like an auth rejection from the transport?
 *  The anthropic-direct backend surfaces SDK APIErrors as `<status> <body>`. */
function isAuthRejection(message: string): boolean {
  return /\b40[13]\b|unauthorized|authentication_error|invalid bearer|oauth token|token expired|forbidden/i.test(
    message,
  );
}

/**
 * Extract the first balanced JSON object or array from a completion
 * (code fences and prose tolerated), parse it strictly, and return the
 * canonical JSON substring. Returns null when nothing parseable exists.
 */
export function extractStrictJson(text: string): string | null {
  const cleaned = text.replace(/```(?:\w+)?\n?([\s\S]*?)(?:```|$)/g, '$1').trim();
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    let start = cleaned.indexOf(open);
    while (start !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) {
            const candidate = cleaned.slice(start, i + 1);
            try {
              JSON.parse(candidate);
              return candidate;
            } catch {
              break; // unbalanced-in-content — try the next start
            }
          }
        }
      }
      start = cleaned.indexOf(open, start + 1);
    }
  }
  return null;
}

/** The default turn runner: one stateless Anthropic-format round-trip via
 *  the shared anthropic-direct backend. Throws on any error event —
 *  reliability semantics live in the caller. */
const defaultRunTurn: SessionTurnRunner = async ({
  systemPromptText,
  messages,
  maxTokens,
  timeoutMs,
}) => {
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), timeoutMs);
  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let errorMessage: string | null = null;
  try {
    for await (const ev of runAgentChat({
      backend: 'anthropic-direct',
      promptText: '',
      messages,
      ...(systemPromptText ? { systemPromptText } : {}),
      model: SESSION_EXTRACTION_MODEL,
      maxTokens,
      temperature: 0,
      signal: ac.signal,
      usageAttribution: { role: 'memory-extraction' },
    })) {
      if (ev.type === 'delta') text = ev.text;
      else if (ev.type === 'result') {
        text = ev.finalText || text;
        tokensIn = ev.tokensIn ?? 0;
        tokensOut = ev.tokensOut ?? 0;
        costUsd = ev.costUsd ?? 0;
      } else if (ev.type === 'error') {
        errorMessage = ev.message;
      }
    }
  } finally {
    clearTimeout(killer);
  }
  if (errorMessage) throw new Error(errorMessage);
  return { text, tokensIn, tokensOut, costUsd };
};

export interface SessionExtractionLlmOptions {
  maxTokens?: number;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to the live anthropic-direct turn. */
  runTurn?: SessionTurnRunner;
  /** Injectable for tests. Defaults to the chat-stream cache drop. */
  invalidateTokenCache?: () => void;
  /** Injectable for tests. Defaults to the module-level kill switch. */
  markDead?: () => void;
  warn?: (msg: string) => void;
}

export class SessionExtractionLlm implements ExtractionLlm {
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly runTurn: SessionTurnRunner;
  private readonly invalidateTokenCache: () => void;
  private readonly markDead: () => void;
  private readonly warn: (msg: string) => void;

  constructor(opts: SessionExtractionLlmOptions = {}) {
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runTurn = opts.runTurn ?? defaultRunTurn;
    this.invalidateTokenCache = opts.invalidateTokenCache ?? invalidateClaudeTokenCache;
    this.markDead = opts.markDead ?? markSessionExtractionDead;
    this.warn = opts.warn ?? ((m) => console.warn(`[mem0-session] ${m}`));
  }

  /** Split mem0's message array into the transport's system/user shape. */
  private splitMessages(messages: ExtractionLlmMessage[]): {
    systemPromptText?: string;
    turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    const systemParts: string[] = [];
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const m of messages) {
      if (m.role === 'system') systemParts.push(m.content);
      else turns.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
    if (turns.length === 0) turns.push({ role: 'user', content: '' });
    return {
      ...(systemParts.length ? { systemPromptText: systemParts.join('\n\n') } : {}),
      turns,
    };
  }

  /** One turn with the 401→invalidate→re-read→retry-once protocol (P-004). */
  private async turnWithAuthRefresh(args: {
    systemPromptText?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): Promise<SessionTurnResult> {
    const run = () =>
      this.runTurn({
        ...args,
        maxTokens: this.maxTokens,
        timeoutMs: this.timeoutMs,
      });
    try {
      return await run();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (!isAuthRejection(msg)) throw e;
      // Auth rejected: the cached token may be stale — the claude CLI
      // refreshes the credentials file under us. Drop the cache, re-read,
      // retry ONCE.
      _usage.authRetries++;
      this.invalidateTokenCache();
      this.warn(
        `anthropic-direct auth rejected (${msg.slice(0, 120)}) — re-reading ~/.claude/.credentials.json and retrying once`,
      );
      try {
        return await run();
      } catch (e2) {
        const msg2 = (e2 as Error).message ?? String(e2);
        if (isAuthRejection(msg2)) {
          // Persistently dead: kill the rung for this process lifetime
          // (re-probed next boot) and let the cascade demote LOUDLY.
          this.markDead();
          throw new ExtractionAuthError(
            `claude-session extraction auth-failed after token re-read (${msg2.slice(0, 160)})`,
          );
        }
        throw e2;
      }
    }
  }

  async generateResponse(
    messages: ExtractionLlmMessage[],
    responseFormat?: { type: string },
    tools?: unknown[],
  ): Promise<unknown> {
    if (tools && tools.length > 0) {
      // mem0's OSS additive-extraction path never passes tools; refuse
      // rather than silently ignore them (the cascade serves the call).
      throw new Error('SessionExtractionLlm does not support tool calls');
    }
    _usage.calls++;
    const { systemPromptText, turns } = this.splitMessages(messages);
    const wantsJson = !!responseFormat?.type && /json/i.test(responseFormat.type);
    try {
      const first = await this.turnWithAuthRefresh({
        ...(systemPromptText ? { systemPromptText } : {}),
        messages: turns,
      });
      this.record(first);
      if (!wantsJson) return first.text;

      const firstJson = extractStrictJson(first.text);
      if (firstJson !== null) return firstJson;

      // Malformed: ONE repair retry with a JSON-only nudge (D-005).
      _usage.jsonRepairs++;
      this.warn('extraction response was not valid JSON — one repair retry');
      const repair = await this.turnWithAuthRefresh({
        ...(systemPromptText ? { systemPromptText } : {}),
        messages: [
          ...turns,
          { role: 'assistant', content: first.text.slice(0, 4000) },
          {
            role: 'user',
            content:
              'Your previous reply was not valid JSON. Respond again with ONLY the JSON object — no prose, no code fences.',
          },
        ],
      });
      this.record(repair);
      const repairedJson = extractStrictJson(repair.text);
      if (repairedJson !== null) return repairedJson;
      throw new Error('extraction returned non-JSON output after a repair retry');
    } catch (e) {
      _usage.failures++;
      throw e;
    }
  }

  async generateChat(messages: ExtractionLlmMessage[]): Promise<ExtractionLlmResponse> {
    _usage.calls++;
    const { systemPromptText, turns } = this.splitMessages(messages);
    try {
      const r = await this.turnWithAuthRefresh({
        ...(systemPromptText ? { systemPromptText } : {}),
        messages: turns,
      });
      this.record(r);
      return { content: r.text, role: 'assistant' };
    } catch (e) {
      _usage.failures++;
      throw e;
    }
  }

  private record(r: SessionTurnResult): void {
    _usage.tokensIn += r.tokensIn;
    _usage.tokensOut += r.tokensOut;
    _usage.costUsd += r.costUsd;
  }
}

// ---------------------------------------------------------------------------
// The factory the memory host wires in (P-003): session present + cheap
// probe passes → the adapter; anything else → null (key rungs unchanged).
// ---------------------------------------------------------------------------

/**
 * Per-token probe cache — a rotation (new token string) re-probes; the
 * same token is never re-probed in this process. Mirrors
 * `anthropicKeyUsable` in @papercusp/memory: only an explicit 401/403
 * counts as unusable; network blips resolve usable so an offline box
 * doesn't lose its extractor over a hiccup.
 */
const _probeCache = new Map<string, boolean>();

/** Test hook — clear the probe cache. */
export function _resetSessionProbeCacheForTest(): void {
  _probeCache.clear();
}

async function sessionTokenUsable(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const cached = _probeCache.get(token);
  if (cached !== undefined) return cached;
  let usable = true;
  try {
    // Gateway-aware (EI-456): when the inference gateway is up it exports
    // ANTHROPIC_BASE_URL, so this usability probe takes the SAME egress path the
    // real extraction call (runAgentChat anthropic-direct) will use.
    const base = resolveAnthropicBaseUrl();
    const r = await fetchImpl(`${base}/v1/models?limit=1`, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    usable = !(r.status === 401 || r.status === 403);
  } catch {
    usable = true; // network blip — don't downgrade
  }
  _probeCache.set(token, usable);
  return usable;
}

let _singleton: SessionExtractionLlm | null = null;
const _seenFactoryWarnings = new Set<string>();
function warnOnceFactory(reason: string): void {
  if (_seenFactoryWarnings.has(reason)) return;
  _seenFactoryWarnings.add(reason);
  console.warn(`[mem0-session] ${reason}.`);
}

// ---------------------------------------------------------------------------
// Gateway egress for the extraction transport (EI-11042)
// ---------------------------------------------------------------------------
//
// The session rung runs `runAgentChat({ backend: 'anthropic-direct' })`, whose
// egress base URL is `resolveAnthropicBaseUrl()` (chat-stream.ts): it routes
// through the inference gateway's ACCOUNT POOL — which strips the incoming auth
// and re-auths to a bound pool account WITH cross-account 429 failover
// (gateway.ts STRIP_REQUEST + the injected pool-account OAuth) — but ONLY when
// `PAPERCUSP_ANTHROPIC_URL`/`ANTHROPIC_BASE_URL` is set in process.env. That env
// is NOT set globally; it is OPT-IN per in-process caller (scout
// `register-scout-action.ts`, the gym `autoloop-cycle.ts` each apply
// `gatewayLlmEnv`). The memory-extraction path never opted in, so it egressed on
// whatever happened to be in env: pooled in the live operator ONLY when scout/gym
// had already mutated the global env, and DIRECT to a SINGLE account in the bench
// subprocess (`setupBenchMemoryHost` is its own process; nothing applies the env)
// — so every `remember()` write probe failed extraction (0/N stored) during any
// window that one account was rate-limited (the EI-11042 flake).
//
// Fix: at the shared extraction chokepoint (`getSessionExtractionLlm`, called by
// the live operator, the bench, and the live probe), point the anthropic-direct
// egress at the gateway pool — the exact idiom scout/gym use. This preserves the
// $0 subscription intent (every gateway pool account is a Max-subscription OAuth
// credential) and adds the pool's failover. Gated on the existing
// INFERENCE_GATEWAY flag (OFF ⇒ unchanged direct egress — no new/dark flag).

/**
 * Idempotently apply the gateway egress env patch. PURE + injectable-env so it is
 * unit-testable without touching the real `process.env`. Sets a key only when it
 * is UNSET (mirrors `gatewayLlmEnv`'s own `if (!process.env[k])` idiom), so it is
 * a NO-OP wherever the egress is already pointed (the live operator, via scout/gym)
 * and only takes effect where it is not (the bench subprocess) — hence zero
 * live-extraction regression risk. Returns the keys it actually set.
 */
export function applyExtractionGatewayEgress(
  enabled: boolean,
  patch: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!enabled) return [];
  const setKeys: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!env[k]) {
      env[k] = v;
      setKeys.push(k);
    }
  }
  return setKeys;
}

/**
 * Best-effort wiring of the real INFERENCE_GATEWAY flag + `gatewayLlmEnv` into the
 * pure applier above. Any failure (flag infra or the gateway module unavailable)
 * leaves egress exactly as before this fix. Inert under vitest so a unit test's
 * `process.env` is never mutated as a side effect — the pure applier is what the
 * unit tests exercise, and the live `session-extraction-live.ts` probe covers the
 * real end-to-end wiring.
 */
async function ensureExtractionGatewayEgress(): Promise<void> {
  if (process.env.VITEST) return;
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    if (!(await getFlag(FLAGS.INFERENCE_GATEWAY, 'system'))) return;
    const { gatewayLlmEnv } = await import('../inference-gateway/spawn-env');
    applyExtractionGatewayEgress(true, gatewayLlmEnv(true));
  } catch {
    /* best-effort: leave egress unchanged, exactly as before this fix */
  }
}

/**
 * Resolve the session-backed extraction LLM, or null when the rung is
 * unavailable (the key cascade then runs exactly as before):
 *
 *  - `PAPERCUSP_MEM0_SESSION_EXTRACTION=0` — explicit escape hatch.
 *  - the rung auth-died earlier this process (D-004).
 *  - no Claude session token on this box (the shipped-product case —
 *    silent, not a warning).
 *  - the liveness probe got an explicit 401/403 (warned once).
 *
 * Called by the memory host on every mem0 client (re)build.
 */
export async function getSessionExtractionLlm(deps?: {
  readToken?: () => string | null;
  probe?: (token: string) => Promise<boolean>;
  /** Injectable for tests. Points the anthropic-direct extraction egress at the
   *  gateway account pool (EI-11042). Runs regardless of which rung serves, so
   *  the fallback key rung benefits too — hence it is applied BEFORE the
   *  session-disabled escape hatch below. */
  ensureGatewayEgress?: () => Promise<void>;
}): Promise<ExtractionLlm | null> {
  await (deps?.ensureGatewayEgress ?? ensureExtractionGatewayEgress)();
  if (process.env.PAPERCUSP_MEM0_SESSION_EXTRACTION === '0') return null;
  if (_sessionRungDead) return null;
  const token = (deps?.readToken ?? readClaudeOauthToken)();
  if (!token) return null;
  const usable = await (deps?.probe ?? sessionTokenUsable)(token);
  if (!usable) {
    warnOnceFactory(
      'Claude session token present but auth-rejected by the probe — mem0 extraction uses the API-key rungs',
    );
    return null;
  }
  _singleton ??= new SessionExtractionLlm();
  return _singleton;
}
