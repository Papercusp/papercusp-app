/**
 * Operator host binding for `@papercusp/memory`.
 *
 * Wires the seams the store core needs: where the embedded-pg lives, the
 * LLM credentials for mem0's fact-extraction, the resolved embedder (the
 * operator owns the openai → local → disabled cascade and hands back a
 * pre-built embed fn), an explicit-mode embedder builder for the re-embed
 * pass, and the optional adaptive-instruction feed from the learning loop.
 *
 * Imported for its side-effect by `./index` and the deep-path shims
 * (`./mem0-client`, `./mem0-connection`, `./reembed`) so `configureMemory()`
 * runs before any store API is touched, regardless of entry point.
 *
 * The embedder cascade mirrors `lib/agent-tools/search/embedder.ts`
 * (search uses the same OpenAI-or-local resolution). They're deliberately
 * kept separate for now — search returns just `(text)=>number[]|null`,
 * while memory also needs the resolved `mode` to pick the per-model vec
 * table. A future share could lift the common core; not worth blocking
 * the extraction on it.
 *
 * Part of papercusp-systems-abstraction-2026-05-29 (P-021).
 */

import { operatorMemoryStoreDir } from './memory-store-dir';
import {
  configureMemory,
  registerMemoryBackend,
  HybridBackend,
  LexicalLegBackend,
  Mem0Backend,
  invalidateMemoryClient,
  dynamicImport,
  EMBEDDER_DIM_SPECS,
  type EmbedFn,
  type EmbedderMode,
  type ResolvedEmbedder,
} from '@papercusp/memory';
import { readCredentials } from '../credentials';
import { loadVoicePrefs } from '../voice-prefs';
import { buildSidecarAwareEmbedder } from './embed-sidecar-wiring';
import { embedAdmission, headersToRecord, EmbedBudgetExhaustedError } from './embed-admission';
import { clearEmbedExhaustionAlertIfActive, maybeEscalateEmbedExhaustion } from './embed-exhaustion-alert';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { buildLearningInstructions } from './learning';
import {
  currentMemoryBackendChoice,
  initMemoryBackendSelection,
} from './backend-selection';
import { getSessionExtractionLlm } from './session-extraction-llm';

/* NOTE: there is deliberately NO shared EMBEDDER_DIM constant here any more.
 * One number standing for "the width every mode emits" was true only by
 * coincidence, and it silently became a LIE the moment two modes differed
 * (D-005). Each branch below now reports its OWN declared targetDims — the
 * shape the harrier branch already used. */
const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';
const TRANSFORMERS_PACKAGE = '@huggingface/transformers';

// ── Embedder retry budget (watchdog-embed-resilience-and-dedup-2026-06-17 P-001) ──
// A sustained org-wide TPM 429 on text-embedding-3-small (1M TPM) hard-failed
// memory:remember/search FLEET-WIDE on 2026-06-17. We ride SHORT spikes out on the
// SAME embedder (no fallback) with a header-aware, JITTERED, budget-capped retry.
//
// ⚠ DEADLINE COUPLING (mem0-timeout-fix-2026-06-24): the budget MUST stay UNDER the
// memory-tool deadline (`memoryToolTimeoutMs`, op-deadline.ts — default 10_000ms).
// HISTORY: this budget was once ~50s ("just under the 60s transport cap"), but B1
// (infra-fail-fast-build-integrity-2026-06-19) later bounded every memory backend
// call at 10s WITHOUT re-coupling this budget — so a throttled embed rode its own 50s
// retry well past the 10s deadline and surfaced as `memory_timeout` (an opaque hang +
// the agent's "mem0 timed out, retrying…" narration) instead of a fast, clean
// degraded envelope. Keep `EMBED_TOTAL_BUDGET_MS` < the deadline so a 429/slow embed
// FAILS FAST and CLEAN. A guard test (configure.test.ts) asserts this invariant.
// SAFE for a multi-fact memory:remember because mem0 embeds facts in PARALLEL
// (Promise.all, mem0-client.ts embedBatch) — a call's embed phase is bounded by the
// SLOWEST single embed, not the sum.
// THUNDERING HERD: full jitter on the exponential path AND a widened jitter on the
// reset-header path (EMBED_RESET_JITTER_MS) so many clients waiting on the SAME reset
// window don't all re-fire at the exact same moment.
export const EMBED_MAX_ATTEMPTS = 12; // 1 try + 11 retries (the WALL-CLOCK budget stops it first)
// Overall wall-clock budget for ONE embed call (all attempts + backoff sleeps + the
// actual fetch time). Must be < memoryToolTimeoutMs (10_000) with headroom for the PG
// op + overhead so the embed gives up BEFORE the outer deadline fires. Env-tunable.
export const EMBED_TOTAL_BUDGET_MS = Number(process.env.PAPERCUSP_EMBED_TOTAL_BUDGET_MS) || 7_000;
// Per-attempt fetch abort: a single OpenAI embed RTT is ~200ms; a call exceeding this
// is a network/connection STALL, so abort it (a hung fetch must not eat the budget).
export const EMBED_FETCH_TIMEOUT_MS = Number(process.env.PAPERCUSP_EMBED_FETCH_TIMEOUT_MS) || 5_000;
const EMBED_MAX_TOTAL_WAIT_MS = EMBED_TOTAL_BUDGET_MS; // cumulative-backoff budget (≤ wall budget)
const EMBED_BACKOFF_BASE_MS = 500;
const EMBED_BACKOFF_CAP_MS = 3_000; // per-attempt ceiling (exponential / no-hint path)
const EMBED_RESET_JITTER_MS = 2_500; // spread post-reset retries across this window (anti-herd)

// ── Single-key exhaustion fallback (EI-3381) ─────────────────────────────────────────────────
// The org's shared OpenAI embed key/quota can be drained by load OUTSIDE this process (another
// machine/service on the same org key, or a genuine billing stop) — the retry loop above rides
// out a SHORT spike on the SAME embedder, but a SUSTAINED exhaustion (openai_embed_quota_exhausted,
// or the retry budget exhausting because the reset window is longer than we can wait) means every
// memory:remember/search call keeps hard-failing for as long as the drain lasts, even though a
// local (BGE-ONNX) embedder may be installed and perfectly able to serve the request. Track the
// most recent such failure and let the 'auto' cascade (resolveEmbedderWith) prefer local for a
// short cooldown window afterward, rather than repeatedly re-trying a key it just learned is dead.
// Bounded, disclosed tradeoff: memories embedded during a cooldown window land in the LOCAL vec
// table (mode='local'), so a search issued during that same window will not see older
// openai-embedded memories (they live in a different per-mode vec table) — reduced recall BREADTH
// for the outage's duration, never a hard failure. A full fix (one shared table / re-embed) is the
// larger follow-up this ticket's other options describe; this is the narrow, safe lever available
// without a data migration or new routing infra.
const OPENAI_EMBED_COOLDOWN_MS = Number(process.env.PAPERCUSP_EMBED_FALLBACK_COOLDOWN_MS) || 60_000;
let openAiEmbedCooldownUntilMs = 0;

// WI-3615: a HARD billing stop (insufficient_quota) fails IDENTICALLY on every retry until the
// key is fixed — the 60s cooldown above is for SOFT/possibly-transient exhaustion (our own daily
// spend cap, which self-clears at UTC rollover; a long-but-finite server reset window). Latching
// those to only 60s on a genuinely dead key thrashes forever: fail -> 60s local -> re-try the same
// dead key -> fail -> repeat, indefinitely (reproduced live: harness_shared.memory_vec_local held
// exactly the memories written inside successive 60s windows, evidence of the thrash). A hard stop
// instead sets this STICKY latch (no auto-expiry) so 'auto' keeps preferring local until something
// that could plausibly have fixed the key happens — clearOpenAiEmbedHardExhaustion() below, called
// when the openai_api_key credential is re-saved (setup:save_key / POST /credentials).
let openAiEmbedHardExhaustedSinceMs: number | null = null;

/** Record an OpenAI embed failure severe enough to prefer local for a while (a hard quota/billing
 *  stop, or the retry budget exhausting entirely). Exported as a seam for tests (GAP 4).
 *
 *  `hard: true` (WI-3615) — an `insufficient_quota` billing stop, known to fail identically
 *  forever until the key is fixed — latches the STICKY exhaustion flag (see
 *  `openAiEmbedHardExhaustedSinceMs` above) in addition to the short cooldown, so 'auto' doesn't
 *  keep re-trying a key it has already proven is dead. Omitted/false (the daily-spend-cap and
 *  retry-budget-exhausted call sites) only sets the short, self-expiring cooldown — those cases
 *  are not necessarily permanent.
 *
 *  EI-7279: the cascade decision (resolveEmbedderWith, above) is only EVALUATED when the mem0
 *  client is (re)built — and mem0-client.ts caches that client for a 1-HOUR TTL. Setting the
 *  cooldown flag alone left it inert for the rest of that hour: the already-built client kept
 *  routing every embed through the SAME dead OpenAI key (each call's own HTTP request still
 *  fails, but the 'auto' cascade that would have picked local never re-runs), so `auto` mode
 *  hard-failed identically to `openai` mode for up to an hour after the fallback should have
 *  engaged — reproduced live 2026-07-04 (two back-to-back memory:remember probes, both
 *  embed_quota_exhausted, well inside one client lifetime). Force a rebuild on the VERY NEXT
 *  call so the cooldown just recorded is actually consulted immediately, not up to an hour late. */
export function markOpenAiEmbedFailure(now: number = Date.now(), opts: { hard?: boolean } = {}): void {
  openAiEmbedCooldownUntilMs = now + OPENAI_EMBED_COOLDOWN_MS;
  if (opts.hard) openAiEmbedHardExhaustedSinceMs = now;
  invalidateMemoryClient();
}

/** Is OpenAI embedding in its post-failure cooldown (the 'auto' cascade should prefer local)?
 *  True during the short self-expiring cooldown OR while the WI-3615 sticky hard-exhaustion latch
 *  is set (no auto-expiry — cleared only by clearOpenAiEmbedHardExhaustion()).
 *  Exported as a seam for the `resolveEmbedder` cascade tests (GAP 4). */
export function isOpenAiEmbedInCooldown(now: number = Date.now()): boolean {
  return now < openAiEmbedCooldownUntilMs || openAiEmbedHardExhaustedSinceMs !== null;
}

/** WI-3615: clear the sticky hard-exhaustion latch (does NOT touch the short cooldown) — call
 *  when there's a real reason to believe the key might work again, i.e. the `openai_api_key`
 *  credential was just re-saved. The very next 'auto' resolution re-tries OpenAI once; if it's
 *  still dead the next hard failure re-latches. A no-op if the latch wasn't set. */
export function clearOpenAiEmbedHardExhaustion(): void {
  openAiEmbedHardExhaustedSinceMs = null;
}

/** Test-only reset so cooldown state from one test can't leak into the next. */
export function __resetOpenAiEmbedCooldownForTest(): void {
  openAiEmbedCooldownUntilMs = 0;
  openAiEmbedHardExhaustedSinceMs = null;
}

// The optional-dependency import lives in ONE place now (@papercusp/memory's
// ./dynamic-import): it stays invisible to bundler static analysis AND works
// inside a VM realm that has no host dynamic-import callback. Six copies of the
// bare `new Function('return import(s)')` form used to answer "is it installed?"
// with a TypeError that a bare catch turned into `false` — see that module's
// header for what that cost {@link localAvailable} and the mem0 client.

/** Resolve the OpenAI key: operator credentials first, env fallback.
 *  Exported as a seam for the `resolveEmbedder` cascade tests (GAP 4). */
export async function resolveOpenAiKey(): Promise<string> {
  let key = process.env.OPENAI_API_KEY ?? '';
  try {
    const creds = await readCredentials();
    if (creds.openai_api_key) key = creds.openai_api_key;
  } catch {
    /* PG creds unavailable — fall back to env */
  }
  return key;
}

/** Tunable seams for the embedder retry loop (watchdog-embed-resilience-and-dedup
 *  -2026-06-17 P-001). Production passes none (defaults); tests inject a no-op
 *  `sleep` + deterministic `rand` to assert attempt counts without real delays. */
export interface OpenAiEmbedderOpts {
  maxAttempts?: number;
  maxTotalWaitMs?: number;
  baseMs?: number;
  capMs?: number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/** "2m59.56s" / "1.5s" / "6ms" / "150" (bare = seconds) → ms; null if unparseable.
 *  OpenAI's `x-ratelimit-reset-tokens`/`-requests` use the compact-duration form;
 *  `Retry-After` uses bare integer seconds. */
export function parseOpenAiDurationMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const s = v.trim();
  if (s === '') return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000); // bare seconds
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

/** The server's own "try again in N" hint from a 429/5xx response, in ms, or null.
 *  Prefers `Retry-After` (HTTP secs or an HTTP-date), then OpenAI's
 *  `x-ratelimit-reset-tokens`/`-requests` reset windows. */
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

/** Next backoff wait (ms) for `attempt` (0-based), honoring a server hint when
 *  present, with FULL jitter, clamped to the per-attempt cap AND the remaining
 *  total-wait budget. Returns null when the budget is spent → stop retrying. */
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
    // FAIL-FAST (mem0-timeout-fix-2026-06-24): when the server's reset window is LONGER
    // than our remaining budget, the reset will NOT arrive before we have to give up — so
    // sleeping the whole budget just to fail anyway is pure latency. Give up NOW (clean,
    // fast degraded envelope) rather than burning the budget on a doomed wait. This is the
    // case that hit memory:* during the org-wide 1M-TPM drain (reset ~15m ≫ 7s budget).
    if (serverHintMs > remaining) return null;
    // Otherwise honor the server's reset window + a WIDENED jitter so many clients waiting
    // on the SAME reset don't all re-fire at once (anti-thundering-herd).
    wait = serverHintMs + Math.floor(rand() * EMBED_RESET_JITTER_MS);
  } else {
    // Full jitter over an exponential window, with a small floor.
    const window = Math.min(cap, base * 2 ** attempt);
    wait = Math.max(base, Math.floor(rand() * window));
  }
  return Math.min(wait, remaining);
}

/** OpenAI text-embedding-3-small, reduced to 768 dims via the API's
 * `dimensions` parameter (was 384 — raised to track the prose column width so
 * this mode stays PROSE-ELIGIBLE alongside gemma; see `EMBEDDER_DIM_SPECS.openai`).
 * The reduction is server-side trained MRL + renormalization, not a hand-rolled
 * prefix, so any width is genuinely supported here.
 *
 * Resilient: a TRANSIENT failure (429 rate-limit, 5xx, network/fetch error) is
 * retried with HEADER-AWARE, jittered exponential backoff before giving up. A
 * burst of writes (knowledge-pack seeding fires concurrent batches) — or a
 * sustained org-wide TPM saturation (text-embedding-3-small, 1M TPM, which
 * hard-failed memory:remember/search FLEET-WIDE on 2026-06-17) — no longer fails
 * the moment OpenAI rate-limits. We ride it out on the SAME embedder (no
 * fallback): up to `maxAttempts` (8) across a capped ~30s budget, honoring the
 * server's own Retry-After / x-ratelimit-reset-tokens hint when present, with
 * full jitter to de-sync the post-unjam herd. A NON-retryable client error (401
 * bad/expired key, 400, 403) still fails fast — retrying won't help, fix the key.
 * (watchdog-embed-resilience-and-dedup-2026-06-17 P-001.)
 *
 * One 429 is NOT transient: `insufficient_quota` (the OpenAI account is out of credit
 * / hit its billing cap) fails identically on every retry regardless of load, so it is
 * classified as a HARD stop (fail fast, distinct `openai_embed_quota_exhausted` tag, no
 * shared-bucket penalty) rather than a rate-limit. (mem0-embed-insufficient-quota-classification.) */
export function buildOpenAiEmbedder(apiKey: string, opts: OpenAiEmbedderOpts = {}): EmbedFn {
  const maxAttempts = opts.maxAttempts ?? EMBED_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? realSleep;
  const totalBudgetMs = opts.maxTotalWaitMs ?? EMBED_TOTAL_BUDGET_MS;
  return async (text: string): Promise<number[]> => {
    let lastErr: Error | null = null;
    let waitedMs = 0;
    const adm = embedAdmission();
    // Wall-clock deadline for the WHOLE embed (fetch time + backoff sleeps), so a stalled
    // fetch or a long retry chain can't overshoot the memory-tool deadline (B1, 10s) and
    // surface as `memory_timeout` (mem0-timeout-fix-2026-06-24). The per-attempt fetch is
    // additionally aborted at EMBED_FETCH_TIMEOUT_MS (or the remaining budget, whichever is
    // smaller) so one hung connection never eats the budget.
    const embedDeadlineAt = Date.now() + totalBudgetMs;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const remainingBudgetMs = embedDeadlineAt - Date.now();
      if (remainingBudgetMs <= 0) break; // budget spent → surface the failure now
      let serverHintMs: number | null = null;
      // MEMORY lane of the shared embed-TPM admission governor
      // (watchdog-and-exposed-systems-improvement-2026-06-18 P-002). Production recall must
      // succeed, so this lane PASSES THROUGH on a denial (acquire never returns null here) — it
      // only PACES against the shared window + feeds it headers/429s so the high-volume bench
      // path yields to memory rather than starving it. The retry loop below is the 429 backstop.
      let slot;
      try {
        slot = await adm.acquire(text, 'memory');
      } catch (e) {
        // EI-7596: our OWN daily spend cap (embed-admission's EmbedBudgetExhaustedError) tripped.
        // This is a SUSTAINED-exhaustion shape identical in kind to insufficient_quota — it will
        // fail IDENTICALLY on every embed until the UTC day rolls over, no retry helps — but unlike
        // insufficient_quota the local (BGE-ONNX) embedder is fully able to serve the request (it
        // costs nothing against the OpenAI budget the cap protects). Before this fix, the cap threw
        // HERE, before the retry loop's own markOpenAiEmbedFailure() calls (hard-billing-stop /
        // retry-budget-exhausted, below) were ever reached, so the EI-3381 local-fallback cooldown
        // never engaged and EVERY memory:remember/update hard-failed for the rest of the day even
        // though a working local embedder was available (EI-7596: reported blocking memory writes
        // fleet-wide during a heavy-load day). Mark the cooldown now so the NEXT resolveEmbedder()
        // call (a fresh memory:remember/search) routes to local instead of re-hitting this same cap.
        if (e instanceof EmbedBudgetExhaustedError) markOpenAiEmbedFailure();
        throw e;
      }
      try {
        const r = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: OPENAI_EMBEDDER_MODEL,
            input: text,
            dimensions: EMBEDDER_DIM_SPECS.openai.targetDims,
          }),
          // Abort a STALLED connection so it can't consume the whole embed budget; bound by
          // the remaining wall-clock budget so the abort never pushes past the deadline.
          signal: AbortSignal.timeout(Math.max(1, Math.min(EMBED_FETCH_TIMEOUT_MS, remainingBudgetMs))),
        });
        adm.recordResponse(headersToRecord(r.headers)); // learn the live limit / pause on remaining=0
        if (r.ok) {
          clearEmbedExhaustionAlertIfActive('openai_billing');
          const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
          return j.data[0].embedding;
        }
        const body = await r.text().catch(() => '');
        // INSUFFICIENT_QUOTA (mem0-embed-insufficient-quota-classification): OpenAI returns
        // HTTP 429 for TWO unrelated conditions — a transient `rate_limit_exceeded` (retry and
        // it clears) AND a hard `insufficient_quota` (the account is out of credit / hit its
        // billing cap). The latter is NOT load-related: it fails IDENTICALLY on every embed,
        // one request or a thousand, until billing is fixed — so lumping it in with rate-limits
        // (retry the budget, penalize the shared bucket, narrate "rate-limited, retrying") both
        // wastes the budget and MISDIAGNOSES the cause (this exact conflation sent a multi-hour
        // investigation down the throughput path when the real fix was "add OpenAI credit").
        // Treat it like a 401/403: fail FAST (one attempt), do NOT penalize the shared admission
        // bucket (there is no reset window to wait for), and tag it DISTINCTLY so the memory
        // tools narrate "OpenAI quota exhausted — check billing" instead of "rate-limited".
        if (r.status === 429 && /insufficient_quota/.test(body)) {
          // EI-3381 / WI-3615: a hard billing stop fails identically forever until fixed —
          // latch the STICKY local-preference (not just the 60s cooldown) so the NEXT
          // resolveEmbedder() call (a fresh memory:remember/search) doesn't keep re-trying a
          // key we just learned is dead, indefinitely, every 60s.
          markOpenAiEmbedFailure(Date.now(), { hard: true });
          maybeEscalateEmbedExhaustion('openai_billing');
          throw new Error(`openai_embed_quota_exhausted: ${body}`);
        }
        const err = new Error(`openai_embed_failed_${r.status}: ${body}`);
        // 429 (rate limit) + 5xx are transient → retry; other 4xx (401/400/403)
        // are a config/auth problem → fail fast (no point retrying a bad key).
        if (r.status !== 429 && r.status < 500) throw err;
        serverHintMs = retryDelayFromHeaders(r.headers);
        if (r.status === 429) adm.penalize({ retryAfterMs: serverHintMs ?? undefined }); // back the whole bucket off
        lastErr = err;
      } catch (e) {
        // A non-retryable failure propagates immediately: a 4xx that isn't 429 (bad/expired
        // key, malformed request — thrown above) OR a 429 that is actually a hard
        // `insufficient_quota` billing stop (openai_embed_quota_exhausted). A bare
        // network/fetch error is transient → retry until attempts/budget run out.
        if (
          e instanceof Error &&
          (/^openai_embed_failed_4(?!29)/.test(e.message) || /^openai_embed_quota_exhausted/.test(e.message))
        ) {
          throw e;
        }
        lastErr = e instanceof Error ? e : new Error(String(e));
      } finally {
        slot?.release();
      }
      if (attempt >= maxAttempts - 1) break; // out of attempts — surface the failure now
      let waitMs = nextEmbedBackoffMs(attempt, serverHintMs, waitedMs, opts);
      if (waitMs == null) break; // backoff budget spent / reset won't arrive in time
      // Clamp to the remaining WALL-CLOCK budget (fetch time already consumed counts) so the
      // sleep can't push the total embed past the memory-tool deadline.
      waitMs = Math.min(waitMs, embedDeadlineAt - Date.now());
      if (waitMs <= 0) break;
      waitedMs += waitMs;
      await sleep(waitMs);
    }
    // EI-3381: the retry budget is spent (attempts exhausted, or the server's reset window
    // is longer than we can wait — the exact sustained org-wide TPM-drain shape this ticket
    // reports) — a SUSTAINED exhaustion, not a short spike. Prefer local for a cooldown.
    markOpenAiEmbedFailure();
    // EI-7475: this is the OTHER sustained-exhaustion shape (retry budget exhausted rather
    // than a hard insufficient_quota) — escalate here too, not just on the hard-billing branch
    // above, so a fleet riding out a long reset window still tells the owner.
    maybeEscalateEmbedExhaustion('openai_billing');
    throw lastErr ?? new Error('openai_embed_failed: retries exhausted');
  };
}

/** Is the local transformers package installed?
 *  Exported as a seam for the `resolveEmbedder` cascade tests (GAP 4). */
export async function localAvailable(): Promise<boolean> {
  try {
    await dynamicImport(TRANSFORMERS_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

/** Every embedder preference, in ONE place: the env parser, the return type,
 *  and tests all derive from this. A hand-copied subset drifts the moment a
 *  leg is added or a default flips (it did, when 'gemma' became the default). */
export const EMBEDDER_PREFERENCES = ['auto', 'openai', 'local', 'gemma', 'harrier', 'disabled'] as const;
export type EmbedderPreference = (typeof EMBEDDER_PREFERENCES)[number];

const isEmbedderPreference = (v: string | undefined): v is EmbedderPreference =>
  !!v && (EMBEDDER_PREFERENCES as readonly string[]).includes(v);

/**
 * Map the MEMORY preference to the PROSE/SEARCH-surface preference.
 *
 * Some memory-side embedders cannot physically write the shared prose columns,
 * and under those preferences the prose surfaces would dims-guard OFF entirely
 * (backfill sweep skips, query legs degrade to lexical-only). Rather than lose
 * prose search, the search side stays in the gemma space the ~414k stored
 * vectors live in. Used by `resolveBackfillEmbedder` and
 * `buildQueryEmbedderResolved`; the mem0 memory side deliberately does NOT
 * apply it — memory has a per-mode table per space, so it has no such problem.
 *
 * Who gets remapped, and why:
 *  - `harrier` (P-015 default flip + the P-006 verdict) — native 1024 with no
 *    MRL, and harrier@384's rejection margin collapses (.0705 vs gemma .1576).
 *  - `local` (NEW, D-005 §6) — bge-small is natively 384 with `mrl:'none'`, so
 *    it cannot emit the 768 the columns now hold. This is the SAME situation
 *    harrier has always been in, so it gets the same answer. Note `local` is
 *    also what `readEmbedderPreference` falls back to for an unrecognized
 *    stored pref, which makes remapping it here load-bearing: without it, a
 *    single unknown-pref read would silently turn prose search lexical-only.
 *    Cost of the remap is nil — gemma loads through the same transformers
 *    package `local` does, so anywhere `local` resolves, gemma can too.
 */
export function proseSurfacePreference(p: EmbedderPreference): EmbedderPreference {
  return p === 'harrier' || p === 'local' ? 'gemma' : p;
}

/** Read the live embedder preference (env override → persisted voice pref →
 *  'auto'). Exported as a seam for the `resolveEmbedder` cascade tests (GAP 4). */
export async function readEmbedderPreference(): Promise<EmbedderPreference> {
  // Env override first (memory-backend-improve-and-hybrid P-004b): lets the
  // bench force one leg (e.g. PAPERCUSP_MEMORY_EMBEDDER=local to measure the
  // BGE-ONNX leg, or =gemma for EmbeddingGemma) without flipping the live
  // operator preference in PG.
  if (isEmbedderPreference(process.env.PAPERCUSP_MEMORY_EMBEDDER)) {
    return process.env.PAPERCUSP_MEMORY_EMBEDDER;
  }
  try {
    const prefs = await loadVoicePrefs();
    const stored: string = prefs.memoryEmbedderMode;
    if (isEmbedderPreference(stored)) return stored;
    // A stored pref THIS build doesn't know — written by NEWER code (live
    // 2026-07-10: frozen pre-gemma dist-host bundles read the freshly-flipped
    // 'gemma' pref, fell through the cascade's 'auto' tail, and re-tried the
    // out-of-credit OpenAI key on every worker restart — an alert storm; with
    // credit it would have been silent PAID embeddings in a foreign vector
    // space). An unknown mode is always a deliberate move to some newer
    // embedder, so the safe reading is 'local': free, on-box, and its writes
    // land in memory_vec_local where a re-embed sweep can recover them.
    return 'local';
  } catch {
    return 'auto';
  }
}

/**
 * Build an embedder for an explicit mode. Throws if that mode's
 * credentials/packages aren't available (the re-embed pass surfaces it).
 */
async function buildEmbedderForMode(mode: 'openai' | 'local' | 'gemma' | 'harrier'): Promise<EmbedFn> {
  if (mode === 'openai') {
    const key = await resolveOpenAiKey();
    if (!key) throw new Error('openai_api_key not configured');
    return buildOpenAiEmbedder(key);
  }
  if (mode === 'gemma') {
    // EmbeddingGemma-300m @ NATIVE 768 (no MRL truncation at all — D-005
    // removed it; the former 384 cut was untrained and cost ~19-21% prose MRR).
    // Storage / the re-embed pass use the
    // document prompt (search's query embedder uses the query prompt).
    // Sidecar-first (P-004): shared warm model when the host runs the embed
    // sidecar; bit-identical in-process fallback otherwise (D-002/D-003).
    return buildSidecarAwareEmbedder('gemma', 'document');
  }
  if (mode === 'harrier') {
    // harrier-oss-0.6b @ native-1024 (P-014) — selectable, never in the
    // 'auto' tail; documents embed raw (only queries carry the instruct
    // prefix), same sidecar-first seam.
    return buildSidecarAwareEmbedder('harrier', 'document');
  }
  // local — BGE-small, worker-thread isolated, inline fallback; sidecar-first
  // under the same P-004 seam.
  return buildSidecarAwareEmbedder('local', 'document');
}

/**
 * Injectable seams for the embedder cascade — the pure core
 * (`resolveEmbedderWith`) takes these so the four-way cascade can be
 * table-tested without real network/credential/package I/O (GAP 4). The
 * production `resolveEmbedder` wires the real implementations.
 */
export interface ResolveEmbedderDeps {
  readPreference: () => Promise<'auto' | 'openai' | 'local' | 'gemma' | 'harrier' | 'disabled'>;
  resolveKey: () => Promise<string>;
  localInstalled: () => Promise<boolean>;
  buildOpenAi: (key: string) => EmbedFn;
  buildLocal: () => Promise<EmbedFn>;
  /** EmbeddingGemma-300m @ native 768 (the default local embedder). Gated by the
   *  same `localInstalled` (shares the @huggingface/transformers package). */
  buildGemma: () => Promise<EmbedFn>;
  /** harrier-oss-0.6b @ native-1024 (P-014, selectable only — never the
   *  'auto' tail). Gated by the same `localInstalled`. */
  buildHarrier: () => Promise<EmbedFn>;
  /** EI-3381: is OpenAI embedding in its post-failure cooldown (a recent hard quota/billing
   *  stop, or a fully-exhausted retry budget)? Only consulted by the 'auto' cascade — a
   *  user-FORCED 'openai' preference still tries the key regardless (that's an explicit
   *  override, not a "pick the best available" decision). Sync + cheap (in-memory only), so
   *  it's checked on every 'auto' resolution with no extra I/O. */
  isOpenAiRecentlyExhausted: () => boolean;
}

/** Build the enabled resolved shape from the ONE production profile registry.
 * Keeping `dims` for existing callers is intentional compatibility; deriving it
 * here prevents that legacy projection from drifting away from the exact
 * profile carried beside it. */
function resolvedEmbedder(mode: EmbedderMode, embed: EmbedFn): ResolvedEmbedder {
  const profile = EMBEDDER_DIM_SPECS[mode];
  return { mode, dims: profile.targetDims, profile, embed };
}

/**
 * Pure cascade core. 'disabled' is a hard stop; 'openai'/'local' are forced
 * (fall to disabled with a specific reason if their dependency is missing);
 * 'auto' cascades openai → local → disabled, EXCEPT while OpenAI is in its
 * post-failure cooldown (EI-3381), when it cascades local → openai → disabled
 * instead — a sustained single-key exhaustion (org-wide TPM drain from another
 * process, or a billing stop) no longer hard-fails memory:* when a local
 * embedder is installed; it degrades to local until the cooldown lapses.
 */
export async function resolveEmbedderWith(deps: ResolveEmbedderDeps): Promise<ResolvedEmbedder> {
  // Normalize here too, not just in readEmbedderPreference: the seam's TS type
  // can't stop a live value from being a mode this build has never heard of
  // (the readPreference wiring differs per consumer), and the fallthrough cost
  // is asymmetric — the 'auto' tail below reaches a PAID cloud embedder in a
  // foreign vector space, while 'local' is free and recoverable by re-embed.
  const rawPreference: string = await deps.readPreference();
  const preference: EmbedderPreference = isEmbedderPreference(rawPreference) ? rawPreference : 'local';
  if (preference === 'disabled') {
    return { mode: 'disabled', reason: 'user_disabled' };
  }

  const key = await deps.resolveKey();

  if (preference === 'openai') {
    if (key) return resolvedEmbedder('openai', deps.buildOpenAi(key));
    return { mode: 'disabled', reason: 'openai_forced_but_no_key' };
  }

  if (preference === 'local') {
    if (await deps.localInstalled()) {
      return resolvedEmbedder('local', await deps.buildLocal());
    }
    return { mode: 'disabled', reason: 'local_forced_but_not_installed' };
  }

  if (preference === 'gemma') {
    // EmbeddingGemma uses the same @huggingface/transformers package as BGE, so
    // localInstalled() gates it. Its OWN space (native 768, mode 'gemma' →
    // memory_vec_gemma) so its vectors never mix with BGE ('local') or OpenAI.
    if (await deps.localInstalled()) {
      return resolvedEmbedder('gemma', await deps.buildGemma());
    }
    return { mode: 'disabled', reason: 'gemma_forced_but_transformers_not_installed' };
  }

  if (preference === 'harrier') {
    // harrier-oss-0.6b (P-014): explicit selection only — the 'auto' tail
    // below never reaches it. Its OWN space at NATIVE 1024 dims (mode
    // 'harrier' → memory_vec_harrier, migration 547). Same transformers gate.
    if (await deps.localInstalled()) {
      return resolvedEmbedder('harrier', await deps.buildHarrier());
    }
    return { mode: 'disabled', reason: 'harrier_forced_but_transformers_not_installed' };
  }

  // 'auto': prefer local while OpenAI is in its post-failure cooldown (EI-3381) — a sustained
  // single-key exhaustion must not keep re-trying a key we just learned is unusable when a
  // local embedder can serve the request instead.
  if (deps.isOpenAiRecentlyExhausted() && (await deps.localInstalled())) {
    return resolvedEmbedder('local', await deps.buildLocal());
  }
  // 'auto' — openai first, then local, then disabled.
  if (key) return resolvedEmbedder('openai', deps.buildOpenAi(key));
  if (await deps.localInstalled()) {
    return resolvedEmbedder('local', await deps.buildLocal());
  }
  return { mode: 'disabled', reason: 'no_openai_key_and_local_not_installed' };
}

/**
 * Resolve the embedder for the current user preference. 'disabled' is a
 * hard stop; 'auto' cascades openai → local → disabled (or local → openai
 * while OpenAI is in its EI-3381 post-failure cooldown). Thin production
 * wrapper over `resolveEmbedderWith` with the real seams.
 */
async function resolveEmbedder(): Promise<ResolvedEmbedder> {
  return resolveEmbedderWith({
    readPreference: readEmbedderPreference,
    resolveKey: resolveOpenAiKey,
    localInstalled: localAvailable,
    buildOpenAi: buildOpenAiEmbedder,
    // Sidecar-first local legs (P-004) — shared warm model when available,
    // bit-identical in-process fallback otherwise.
    buildLocal: () => buildSidecarAwareEmbedder('local', 'document'),
    // Storage/mem0 embed with the document prompt (search uses the query prompt).
    buildGemma: () => buildSidecarAwareEmbedder('gemma', 'document'),
    buildHarrier: () => buildSidecarAwareEmbedder('harrier', 'document'),
    isOpenAiRecentlyExhausted: isOpenAiEmbedInCooldown,
  });
}

// ─── RETIRED: the two ~/.claude-backed backends ────────────────────────────
// `claude-file` (the Claude Code topic-file bridge) and `hybrid` (that file
// store fused with the mem0 cosine leg) are NO LONGER REGISTERED, and therefore
// no longer selectable — memory-declaude-and-defaults-2026-07-28 P-004, owner
// directive: the live memory system must not depend on Claude at all.
//
// They were already dead weight, not merely disfavored. The ~/.claude topic
// files stopped being load-bearing on 2026-07-13
// (memory-pg-lexical-own-injection-2026-07-13): all 1,806 of them were imported
// into `harness_shared.memory_canonical`, `MEMORY.md` was replaced by a pointer
// stub, and the SessionStart hook that regenerated it was retired. Selecting
// either backend after that pointed live memory at a frozen file store —
// available in the dropdown, silently wrong if chosen.
//
// `hybrid-pg` below is the Claude-free replacement for `hybrid`: same fusion,
// but BOTH legs over the one canonical PG table. It measured 98% recall@10 vs
// the old hybrid's 55% on the live 40-pair A/B, so nothing of value was lost.
//
// ⚠ A persisted `memory_backend` setting (or PAPERCUSP_MEMORY_BACKEND) still
// naming a retired backend would otherwise make getMemoryBackend() throw
// `unknown memory backend` on EVERY memory call. ./backend-selection coerces
// those names to the default instead — see RETIRED_MEMORY_BACKENDS there.
//
// `ClaudeFileMemoryBackend` itself remains exported from @papercusp/memory (D-001):
// the offline bench constructs it DIRECTLY (never via this registry) to reproduce
// the historical A/B measurements. Unreachable from the product, still measurable.

// hybrid-pg (memory-pg-lexical-own-injection-2026-07-13 P-003): the
// SELF-OWNED hybrid — BOTH legs over the one canonical PG store, no
// ~/.claude dependency. The lexical leg is canonical-store lexicalSearch
// (field-weighted token match, P-002 parity with the claude-file scoring
// that benched best on exact-identifier recall) presented as a backend via
// LexicalLegBackend; the cosine leg is the same SHARED Mem0Backend. The
// adapter's remember() is a no-op, so the hybrid write-through cannot
// double-write the shared table; fusion dedupes on the shared canonical
// ids. Select with PAPERCUSP_MEMORY_BACKEND=hybrid-pg or the live settings
// flip (the P-007 cutover is exactly that persisted switch).
registerMemoryBackend('hybrid-pg', () => {
  const mem0 = new Mem0Backend();
  // `name` MUST be passed (P-003): the class defaults to 'hybrid', and a
  // hybrid-pg that reports itself as 'hybrid' defeats the recall canary's
  // backend-flip reseed guard, which compares exactly this string.
  return new HybridBackend(new LexicalLegBackend(mem0), mem0, { name: 'hybrid-pg' });
});

configureMemory({
  getAdminUrl: getHarnessAdminUrl,
  // The operator's memory tables live in the harness_shared schema
  // (migration 081); the embedded-pg database is `papercusp`; the SQLite
  // event-history log persists in the operator's state directory.
  schema: 'harness_shared',
  defaultDbName: 'papercusp',
  localStoreDir: operatorMemoryStoreDir,
  // The swappable-store selector (generalize-memory-backend-swappable
  // D-004): which MemoryBackend getMemoryBackend() serves. A LIVE thunk
  // (mem0-revive-or-retire / Brief 30) reading the persisted operator
  // setting → PAPERCUSP_MEMORY_BACKEND → 'mem0', re-evaluated every call
  // so a UI flip on the settings memory page takes effect with no
  // restart. An unknown name fails loud at first use.
  backend: () => currentMemoryBackendChoice(),
  getCredentials: async () => {
    const c = await readCredentials();
    return { openai_api_key: c.openai_api_key, anthropic_api_key: c.anthropic_api_key };
  },
  // Fact-extraction cascade rung #1 (mem0-extraction-via-claude-session
  // D-001/D-002): Haiku on the Claude-session anthropic-direct transport —
  // no API key to rot, $0 marginal on the subscription. Resolves null
  // (key rungs unchanged) when there's no session, the probe fails, the
  // rung auth-died this process, or PAPERCUSP_MEM0_SESSION_EXTRACTION=0.
  getExtractionLlm: () => getSessionExtractionLlm(),
  resolveEmbedder,
  buildEmbedderForMode,
  // Optional: adaptive extraction instructions from the operator's
  // learning loop. Best-effort — the package treats it as a black box.
  getLearningInstructions: async () => (await buildLearningInstructions()) ?? undefined,
});

// Best-effort: hydrate the persisted memory-backend selection into the
// in-process cache so getMemoryBackend()'s thunk reflects it. Until this
// resolves (or if PG isn't up), the thunk falls back to the env/default.
// A UI write (writeMemoryBackendChoice) also updates the cache live.
void initMemoryBackendSelection();
