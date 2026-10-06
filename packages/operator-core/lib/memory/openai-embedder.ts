import { EMBEDDER_DIM_SPECS, type EmbedFn } from '@papercusp/memory';
import { readCredentials } from '../credentials';
import { embedAdmission, EmbedBudgetExhaustedError, headersToRecord } from './embed-admission';

const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';

export const EMBED_MAX_ATTEMPTS = 12;
export const EMBED_TOTAL_BUDGET_MS = Number(process.env.PAPERCUSP_EMBED_TOTAL_BUDGET_MS) || 7_000;
export const EMBED_FETCH_TIMEOUT_MS = Number(process.env.PAPERCUSP_EMBED_FETCH_TIMEOUT_MS) || 5_000;
const EMBED_MAX_TOTAL_WAIT_MS = EMBED_TOTAL_BUDGET_MS;
const EMBED_BACKOFF_BASE_MS = 500;
const EMBED_BACKOFF_CAP_MS = 3_000;
const EMBED_RESET_JITTER_MS = 2_500;

export interface OpenAiEmbedderOpts {
  maxAttempts?: number;
  maxTotalWaitMs?: number;
  baseMs?: number;
  capMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  rand?: () => number;
}

export interface OpenAiEmbedderHooks {
  markFailure?: (now?: number, opts?: { hard?: boolean }) => void;
  clearAlert?: () => void | Promise<void>;
  maybeEscalate?: () => void | Promise<void>;
}

export async function resolveOpenAiKey(): Promise<string> {
  let key = process.env.OPENAI_API_KEY ?? '';
  try {
    const creds = await readCredentials();
    if (creds.openai_api_key) key = creds.openai_api_key;
  } catch {
    /* credentials may be unavailable in a standalone worker; keep the env fallback */
  }
  return key;
}

const realSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
  const abort = () => { cleanup(); reject(signal?.reason); };
  const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
});

/** OpenAI reset headers use compact durations; Retry-After may use seconds or an HTTP date. */
export function parseOpenAiDurationMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const s = v.trim();
  if (s === '') return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return matched ? Math.round(total) : null;
}

export function retryDelayFromHeaders(headers: Headers): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return (
    parseOpenAiDurationMs(headers.get('x-ratelimit-reset-tokens')) ??
    parseOpenAiDurationMs(headers.get('x-ratelimit-reset-requests'))
  );
}

export function nextEmbedBackoffMs(
  attempt: number,
  serverHintMs: number | null,
  waitedMs: number,
  opts: Pick<OpenAiEmbedderOpts, 'maxTotalWaitMs' | 'baseMs' | 'capMs' | 'rand'> = {},
): number | null {
  const maxTotal = opts.maxTotalWaitMs ?? EMBED_MAX_TOTAL_WAIT_MS;
  const base = opts.baseMs ?? EMBED_BACKOFF_BASE_MS;
  const cap = opts.capMs ?? EMBED_BACKOFF_CAP_MS;
  const rand = opts.rand ?? Math.random;
  const remaining = maxTotal - waitedMs;
  if (remaining <= 0) return null;
  let wait: number;
  if (serverHintMs != null && serverHintMs > 0) {
    if (serverHintMs > remaining) return null;
    wait = serverHintMs + Math.floor(rand() * EMBED_RESET_JITTER_MS);
  } else {
    const window = Math.min(cap, base * 2 ** attempt);
    wait = Math.max(base, Math.floor(rand() * window));
  }
  return Math.min(wait, remaining);
}

/** Shared OpenAI adapter. Host alert/cooldown effects are injected so standalone workers
 * can keep the same embedding contract without bundling the operator event graph. */
export function buildOpenAiEmbedderCore(
  apiKey: string,
  opts: OpenAiEmbedderOpts = {},
  hooks: OpenAiEmbedderHooks = {},
): EmbedFn {
  const maxAttempts = opts.maxAttempts ?? EMBED_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? realSleep;
  const totalBudgetMs = opts.maxTotalWaitMs ?? EMBED_TOTAL_BUDGET_MS;
  const markFailure = hooks.markFailure ?? (() => {});
  return async (text: string, signal?: AbortSignal): Promise<number[]> => {
    signal?.throwIfAborted();
    let lastErr: Error | null = null;
    let waitedMs = 0;
    const adm = embedAdmission();
    const embedDeadlineAt = Date.now() + totalBudgetMs;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      signal?.throwIfAborted();
      const remainingBudgetMs = embedDeadlineAt - Date.now();
      if (remainingBudgetMs <= 0) break;
      let serverHintMs: number | null = null;
      let slot;
      try {
        slot = await adm.acquire(text, 'memory');
      } catch (e) {
        if (e instanceof EmbedBudgetExhaustedError) markFailure();
        throw e;
      }
      try {
        signal?.throwIfAborted();
        const fetchBudgetMs = embedDeadlineAt - Date.now();
        if (fetchBudgetMs <= 0) throw new Error('openai_embed_budget_spent');
        const r = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: OPENAI_EMBEDDER_MODEL,
            input: text,
            dimensions: EMBEDDER_DIM_SPECS.openai.targetDims,
          }),
          signal: AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(Math.max(1, Math.min(EMBED_FETCH_TIMEOUT_MS, fetchBudgetMs))),
          ]),
        });
        signal?.throwIfAborted();
        adm.recordResponse(headersToRecord(r.headers));
        if (r.ok) {
          void hooks.clearAlert?.();
          const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
          signal?.throwIfAborted();
          return j.data[0].embedding;
        }
        const body = await r.text().catch(() => '');
        if (r.status === 429 && /insufficient_quota/.test(body)) {
          markFailure(Date.now(), { hard: true });
          void hooks.maybeEscalate?.();
          throw new Error(`openai_embed_quota_exhausted: ${body}`);
        }
        const err = new Error(`openai_embed_failed_${r.status}: ${body}`);
        if (r.status !== 429 && r.status < 500) throw err;
        serverHintMs = retryDelayFromHeaders(r.headers);
        if (r.status === 429) adm.penalize({ retryAfterMs: serverHintMs ?? undefined });
        lastErr = err;
      } catch (e) {
        signal?.throwIfAborted();
        if (
          e instanceof Error &&
          (/^openai_embed_failed_4(?!29)/.test(e.message) || /^openai_embed_quota_exhausted/.test(e.message))
        ) throw e;
        lastErr = e instanceof Error ? e : new Error(String(e));
      } finally {
        slot?.release();
      }
      if (attempt >= maxAttempts - 1) break;
      let waitMs = nextEmbedBackoffMs(attempt, serverHintMs, waitedMs, opts);
      if (waitMs == null) break;
      waitMs = Math.min(waitMs, embedDeadlineAt - Date.now());
      if (waitMs <= 0) break;
      waitedMs += waitMs;
      await sleep(waitMs, signal);
      signal?.throwIfAborted();
    }
    markFailure();
    void hooks.maybeEscalate?.();
    throw lastErr ?? new Error('openai_embed_failed: retries exhausted');
  };
}
