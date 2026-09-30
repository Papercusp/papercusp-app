/**
 * Codex-CLI bridge — serve gateway `/v1/responses` requests by DRIVING THE
 * `codex` CLI on a ChatGPT-SUBSCRIPTION credential, instead of forwarding
 * HTTP to api.openai.com with an OpenAI API bearer.
 *
 * WHY (2026-07-01, owner: "the inference gateway should support all models"):
 * the gateway's codex provider could only consume OpenAI *API* bearers
 * (`sk-…`), while the fleet's actual OpenAI capacity is ownerhandle's ChatGPT
 * subscription (`~/.codex/auth.json`, `auth_mode:"chatgpt"`) — an OAuth login
 * to a DIFFERENT OpenAI backend that only the codex CLI speaks. Subprocess
 * agents (queen/bee/overwatch) already use it via `codex exec`; in-process
 * gateway callers (scout's `llmCallViaCodexGateway` → POST /v1/responses)
 * could not. This bridge closes that gap: a codex account registered with
 * `credentialRef: "codex-cli:<CODEX_HOME>"` is served by spawning
 * `codex exec --json` and translating its JSONL events into a
 * `/v1/responses`-shaped reply.
 *
 * Wire contract (verified live on codex 0.142.2, 2026-07-01):
 *   {"type":"item.completed","item":{"type":"agent_message","text":…}}   ← reply text
 *   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}} ← usage
 * (Same event shapes the orchestrator's codex-json stream parser consumes —
 * libs/papercusp/packages/orchestrator/src/invoke.ts `format === 'codex-json'`.)
 *
 * Tradeoff: one subprocess per completion (~1-5s overhead) — right for
 * low-volume in-process callers (scout ideation, judges). The nested CLI run
 * is buffered, but gateway.ts adapts its completed response back to Responses
 * SSE when a client sends `stream:true`; that compatibility path is what lets
 * gateway-routed Codex agent sessions use ChatGPT-subscription accounts too.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { resolveAgentBinarySync } from '../agent-bin-detect';
import { codexContextConfigArgs, resolveCodexModel, resolveCodexModelSelection } from '../model-context-budget.mjs';
import * as os from 'node:os';
import type { AccountEgress } from '../deployment/account-pool';

/** credentialRef scheme marking a ChatGPT-subscription codex account:
 *  `codex-cli:<CODEX_HOME>` (e.g. `codex-cli:~/.codex`). The path is the
 *  CODEX_HOME the CLI reads its `auth.json` from. */
export const CODEX_CLI_REF_PREFIX = 'codex-cli:';

export interface CodexCliAccount {
  accountId: string;
  /** CODEX_HOME dir holding the subscription auth.json. */
  home: string;
  /** Same per-account egress bindings supported by bearer/Claude accounts. OAuth remains resolved
   *  from `home`; these fields only select the outbound network path. */
  egress?: AccountEgress;
  egressPool?: AccountEgress[];
}

/** `codex-cli:<home>` → expanded home path, or null when `ref` is not a
 *  codex-cli credential (bearer refs fall through to the HTTP path). */
export function parseCodexCliRef(ref: string): string | null {
  if (!ref.startsWith(CODEX_CLI_REF_PREFIX)) return null;
  const raw = ref.slice(CODEX_CLI_REF_PREFIX.length).trim();
  if (!raw) return null;
  if (raw === '~') return os.homedir();
  return raw.startsWith('~/') ? `${os.homedir()}${raw.slice(1)}` : raw;
}

const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Normalize a request-body model spec to the bare id + reasoning effort the
 * codex CLI takes. Accepts `[provider/]<id>[:effort]` plus Papercusp's
 * user-facing `chatgpt:<n>` and bare `sol`/`terra`/`luna` aliases (mirrors the
 * shared `normalizeCodexCliModel` launch policy). Every recognized effort,
 * including `max`, is preserved exactly so the bridge cannot silently weaken an
 * owner request.
 * No/unknown effort suffix → `medium` (codex's own default).
 */
export function parseBridgeModel(model: string | undefined): { id: string; effort: string } {
  let m = (model ?? '').trim();
  const slash = m.indexOf('/');
  if (slash > 0) m = m.slice(slash + 1);
  // Resolve before splitting effort so omitted requests receive the managed
  // default and every explicit spelling crosses the Spark deny guard.
  const resolved = m
    ? resolveCodexModel(m)
    : resolveCodexModelSelection(undefined, { source: 'configured-default' }).model;
  let effort = 'medium';
  const colon = resolved.lastIndexOf(':');
  m = resolved;
  if (colon > 0) {
    const suffix = m
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    if (CODEX_EFFORTS.has(suffix)) {
      effort = suffix;
      m = m.slice(0, colon);
    }
  }
  return { id: m, effort };
}

export interface CodexCliRunOpts {
  /** CODEX_HOME holding the subscription auth.json. */
  home: string;
  /** Bare model id (`gpt-5.4`). */
  model: string;
  /** codex reasoning effort (`minimal|low|medium|high|xhigh`). */
  effort: string;
  /** The full prompt text (instructions already prepended by the caller). */
  prompt: string;
  /** Hard wall-clock cap; the whole process GROUP is killed past it. */
  timeoutMs: number;
  /** Abort (downstream hung up) — kills the process group. */
  signal?: AbortSignal;
  /** Test seam. */
  spawnFn?: typeof nodeSpawn;
  /** Test seam / PATH override. */
  codexBin?: string;
}

export interface CodexCliRunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** Parse `codex exec --json` JSONL stdout into reply text + usage. Exported for tests. */
export function parseCodexCliEvents(stdout: string): CodexCliRunResult {
  const parts: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // non-JSON banner/noise line
    }
    if (!obj || typeof obj !== 'object') continue;
    const ev = obj as {
      type?: string;
      item?: { type?: string; text?: unknown };
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
      parts.push(ev.item.text);
    }
    if (ev.type === 'turn.completed' && ev.usage) {
      if (typeof ev.usage.input_tokens === 'number') inputTokens = ev.usage.input_tokens;
      if (typeof ev.usage.output_tokens === 'number') outputTokens = ev.usage.output_tokens;
    }
  }
  return { text: parts.join('').trim(), inputTokens, outputTokens };
}

/**
 * Harvest a HUMAN-DIAGNOSABLE failure detail from a codex run.
 *
 * EI-21618978789879488: this used to report `stderr` alone, and codex writes its
 * tracing errors to the `--json` STDOUT stream — so a credential that cannot
 * authenticate produced exactly `codex-cli bridge: codex exited 1: ` with an
 * empty tail. An empty tail is not a small cosmetic loss: it is unfalsifiable,
 * so it was read fleet-wide as a quota wall for hours, and the proposed remedy
 * was to move ~20 model-bearing learning paths onto a MORE exhausted provider.
 * The actual message sitting unread in stdout named the cause outright:
 *   `failed to convert header to a str for header name 'authorization'`
 *
 * Precedence is most-specific-first, and the contract is that this NEVER
 * returns an empty string while either stream holds any content at all.
 */
export function codexCliFailureDetail(stdout: string, stderr: string, limit = 400): string {
  const errorLines: string[] = [];
  const otherLines: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      // codex's tracing output is NOT JSON and shares the stream with the
      // JSONL events — this is the branch that actually carried the auth error.
      if (/\bERROR\b|\bWARN\b/.test(line)) errorLines.push(line);
      else otherLines.push(line);
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const ev = obj as { type?: string; error?: unknown; message?: unknown };
    const asText = (v: unknown): string =>
      typeof v === 'string'
        ? v
        : v == null
          ? ''
          : (() => {
              try {
                return JSON.stringify(v);
              } catch {
                return String(v);
              }
            })();
    if (ev.error != null) errorLines.push(asText(ev.error));
    else if (typeof ev.type === 'string' && /error|failed/i.test(ev.type)) {
      errorLines.push(`${ev.type}: ${asText(ev.message)}`.trim().replace(/:\s*$/, ''));
    }
  }
  const stderrTail = stderr.trim();
  // Most specific first: an explicit error from either stream, then whatever
  // context remains. The last fallback exists so the caller can always say
  // SOMETHING about a non-zero exit.
  const picked = errorLines.join(' | ').trim() || stderrTail || otherLines.join(' | ').trim() || stdout.trim();
  // Codex tracing can include the rejected Authorization header's WHOLE bearer
  // value in this error. The diagnostic must preserve the cause without turning
  // a gateway log/error envelope into a credential exfiltration surface.
  const redacted = picked
    .replace(
      /(header name ['"]authorization['"][^\r\n]*?with value:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*')/gi,
      '$1"[REDACTED]"',
    )
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
  return redacted.slice(-limit);
}

/**
 * Is this failure the CREDENTIAL being unusable, rather than the account being
 * out of quota?
 *
 * The distinction is load-bearing for selection (EI-21618978789879488). An
 * account's `available` flag is a QUOTA statement only, so a codex home whose
 * `auth.json` cannot authenticate still advertises itself as available with
 * healthy headroom — and the OAuth proxy resolves credentials from CODEX_HOME
 * only AFTER selection, so nothing downstream can feed that back. A dead
 * credential is therefore re-selected ahead of healthy siblings on every
 * request, indefinitely. Quota exhaustion surfaces honestly (a 429 is plainly
 * visible); credential death does not. Classifying it here is what lets the
 * caller quarantine the account through the pool's ordinary exhaustion path.
 *
 * ⚠ Quota/rate wording is deliberately EXCLUDED: those already have their own
 * failover path, and mapping them here would relabel an exhausted-but-healthy
 * account as a dead credential.
 */
export function isCodexAuthFailure(detail: string): boolean {
  const text = detail.toLowerCase();
  if (!text.trim()) return false;
  // Quota/rate first — a usage wall is never credential death.
  if (/usage limit|rate.?limit|quota|too many requests|\b429\b/.test(text)) return false;
  return (
    // The 2026-08-27 clobber: codex rejects the bearer at the HTTP header layer
    // because the credential is not even header-legal.
    /header name 'authorization'|header name "authorization"/.test(text) ||
    /failed to convert header/.test(text) ||
    /\b401\b|unauthorized|invalid[_ ]api[_ ]key|invalid api key|incorrect api key/.test(text) ||
    /authentication (failed|error)|not authenticated|auth(entication)? required/.test(text) ||
    // codex-oauth-proxy's own refusals when the home has no usable credential.
    /no usable auth\.json|no refresh_token|refresh_token_reused|re-login with/.test(text) ||
    /please (run )?`?codex login`?|run `codex login`/.test(text)
  );
}

/** A nested codex run failed because provider capacity/quota was exhausted. */
export function isCodexRateLimitFailure(detail: string): boolean {
  const text = detail.toLowerCase().trim();
  if (!text) return false;
  return (
    /usage limit|session limit|rate.?limit|rate_limit|quota/.test(text) ||
    /too many requests|\b429\b|exceeded retry limit/.test(text)
  );
}

/**
 * One completion through the codex CLI on the subscription credential.
 * Flags mirror the PROVEN subprocess-agent invocation (harness-invoke-once /
 * the 2026-07-01 live verification) with two bridge-specific hardenings:
 * `-s read-only` (an LLM call needs no writes — the agent paths use the srt
 * wrap instead) and the prompt on STDIN via `-` (argv length safety for long
 * scout ideation prompts). Rejects with stderr context on any failure; the
 * caller maps that to a 502.
 */
export function runCodexCliCompletion(opts: CodexCliRunOpts): Promise<CodexCliRunResult> {
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  // Resolve to an ABSOLUTE path rather than handing `spawn` the bare name
  // (WI-39538). `env` below inherits the operator's PATH verbatim, and the
  // operator runs under systemd with a fixed PATH — not the owner's
  // login-shell PATH — so a bare `codex` ENOENTs on a box where codex is
  // installed and every agent session is driving it fine. The explicit
  // `codexBin` seam still wins; the bare name stays the last resort so an
  // unresolvable codex fails exactly as it did before.
  const bin = opts.codexBin ?? resolveAgentBinarySync('codex') ?? 'codex';
  const argv = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-s',
    'read-only',
    '-m',
    opts.model,
    '-c',
    `model_reasoning_effort="${opts.effort}"`,
    // Declare the exact extended-window opt-in (plan
    // codex-1m-context-window-2026-08-17 D-008). This bridge is single-turn, so
    // native compaction is not the concern here — the INPUT ceiling is: without
    // it a large bridged prompt is budgeted against codex's 272k default rather
    // than the measured 828,400 effective window. `[]` for a model with no
    // extended window.
    ...codexContextConfigArgs(opts.model),
    '-', // prompt from stdin
  ];
  return new Promise<CodexCliRunResult>((resolve, reject) => {
    const child = spawnFn(bin, argv, {
      cwd: os.tmpdir(),
      env: { ...process.env, CODEX_HOME: opts.home },
      // Group leader so the timeout/abort kill covers codex's vendor-binary child too.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* group already gone */
      }
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const killer = setTimeout(() => {
      killGroup();
      settle(() => reject(new Error(`codex-cli bridge: timed out after ${opts.timeoutMs}ms`)));
    }, opts.timeoutMs);
    (killer as { unref?: () => void }).unref?.();
    const onAbort = () => {
      killGroup();
      settle(() => reject(new Error('codex-cli bridge: request aborted')));
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => settle(() => reject(new Error(`codex-cli bridge: spawn failed: ${e.message}`))));
    child.on('close', (code) =>
      settle(() => {
        if (code !== 0) {
          reject(new Error(`codex-cli bridge: codex exited ${code}: ${codexCliFailureDetail(stdout, stderr)}`));
          return;
        }
        const r = parseCodexCliEvents(stdout);
        if (!r.text) {
          reject(
            new Error(
              `codex-cli bridge: no agent_message in codex output (${codexCliFailureDetail(stdout, stderr, 200)})`,
            ),
          );
          return;
        }
        resolve(r);
      }),
    );
    try {
      child.stdin?.end(opts.prompt);
    } catch {
      /* close/error path handles it */
    }
  });
}

export interface CodexCliSyntheticResponse extends Record<string, unknown> {
  id: string;
  output: [
    {
      id: string;
      type: 'message';
      status: 'completed';
      role: 'assistant';
      content: [{ type: 'output_text'; text: string; annotations: unknown[]; logprobs: unknown[] }];
    },
  ];
  usage: {
    input_tokens: number;
    input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
    output_tokens: number;
    output_tokens_details: { reasoning_tokens: number };
    total_tokens: number;
  };
}

/** Synthesize the schema-complete `/v1/responses` body a real Codex client expects. */
export function codexCliResponsesBody(args: {
  model: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
}): CodexCliSyntheticResponse {
  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  return {
    id: `resp_codexcli_${stamp}`,
    object: 'response',
    created_at: createdAt,
    completed_at: createdAt,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: args.model,
    output: [
      {
        id: `msg_codexcli_${stamp}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: args.text, annotations: [], logprobs: [] }],
      },
    ],
    output_text: args.text,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    // Codex's Responses client requires the aggregate on response.completed.
    // Omitting it leaves the upstream request recorded as HTTP 200 while the
    // client rejects the terminal event as an invalid ResponseCompleted.
    usage: {
      input_tokens: args.inputTokens,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: args.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: args.inputTokens + args.outputTokens,
    },
    user: null,
    metadata: {},
    /** Diagnostic marker: this reply came off the subscription CLI, not the API. */
    gateway_codex_cli: true,
  };
}

/**
 * Adapt a buffered CLI result onto the streaming Responses event contract.
 * `response.completed` alone records usage, but Codex materializes its
 * `agent_message` from the output-item/content event progression.
 */
export function codexCliResponsesCompletionSse(response: CodexCliSyntheticResponse): string {
  const item = response.output[0];
  const part = item.content[0];
  let sequenceNumber = 1;
  const event = (type: string, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload, sequence_number: sequenceNumber++ })}\n\n`;

  return (
    event('response.output_item.added', {
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    }) +
    event('response.content_part.added', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { ...part, text: '' },
    }) +
    event('response.output_text.delta', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: part.text,
      logprobs: [],
    }) +
    event('response.output_text.done', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: part.text,
      logprobs: [],
    }) +
    event('response.content_part.done', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part,
    }) +
    event('response.output_item.done', { output_index: 0, item }) +
    event('response.completed', { response }) +
    'data: [DONE]\n\n'
  );
}

/** Flatten a Responses-API `input` (string or structured item array) to prompt text. */
export function extractResponsesInputText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const it = item as { content?: unknown; text?: unknown };
    if (typeof it.text === 'string') {
      parts.push(it.text);
      continue;
    }
    if (Array.isArray(it.content)) {
      for (const c of it.content) {
        const cc = c as { type?: string; text?: unknown };
        if ((cc.type === 'input_text' || cc.type === 'text') && typeof cc.text === 'string') parts.push(cc.text);
      }
    }
  }
  return parts.join('\n');
}
