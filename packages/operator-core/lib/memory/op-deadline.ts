/**
 * Shared deadline + degraded-latch for memory backend calls.
 *
 * B1 (infra-fail-fast-build-integrity-2026-06-19). The explicit memory TOOLS
 * (memory:search / remember / list / update / forget) called `backend.*()`
 * with NO deadline. When mem0 failed to load — the 2026-06-19 :3070 outage,
 * where papercup-release's better-sqlite3 native addon was built for the wrong
 * Node ABI — every memory-touching MCP/HTTP handler hung FOREVER while the
 * shallow health probe stayed green. A per-call deadline converts an infinite
 * (or 55s-transport-capped) hang into a bounded, legible degraded result the
 * caller can surface immediately.
 *
 * This primitive was previously private to `injection.ts` and only guarded the
 * pre-turn auto-injection (push) path. It now lives here so BOTH paths share
 * one process-level degraded latch: a backend-operation timeout quiets the hot
 * per-turn inject path immediately (it stops paying the deadline every turn), while the
 * explicit tools keep attempting under their own deadline so they recover once
 * the backend does. The latch resets on restart — the backend's own
 * poison-cache handles client-level recovery. A shared request budget expiring
 * says nothing about backend health and must not quiet unrelated future turns.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Thrown when a memory backend call exceeds its deadline. Distinct from
 *  `MemoryUnavailableError` (a clean "store is down" probe result) so callers
 *  can map a HANG to its own `memory_timeout` reason. */
export type MemoryTimeoutScope = 'backend-operation' | 'request-budget';

export class MemoryTimeoutError extends Error {
  constructor(message: string, readonly scope: MemoryTimeoutScope = 'backend-operation') {
    super(message);
    this.name = 'MemoryTimeoutError';
  }
}

/** Auto-inject (push) path per-op deadline — fast, because injection is a
 *  best-effort enhancement that `buildOperatorPrompt` awaits inline. */
export const MEMORY_INJECT_TIMEOUT_MS = 5_000;

/** Explicit-tool per-op deadline. More generous than the inject path (a cold
 *  embedder or a wide harness fan-out can legitimately take a few seconds) but
 *  well under the ~55–60s MCP dispatch/transport cap, so a wedged backend
 *  returns a degraded envelope instead of riding the transport timeout out to
 *  an apparent infinite hang. Env-tunable; evaluated at call time so tests can
 *  flip it per-test. */
export function memoryToolTimeoutMs(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

/**
 * Deadline for the EMBED-FREE lexical fallback memory:search attempts after
 * its semantic leg failed (timeout / embed failure — WI-4214). Deliberately
 * short and separate from the main tool deadline: by the time the fallback
 * runs the caller has already waited out one full tool deadline, so the
 * total (deadline + fallback) must stay well inside the ~55–60s MCP
 * transport cap — and the fallback is a plain PG token query that either
 * answers fast or isn't worth waiting for (a PG-wide wedge means the store
 * is down, not overloaded). Env-tunable; evaluated at call time for tests.
 */
export function memoryLexicalFallbackTimeoutMs(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_LEXICAL_FALLBACK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2_500;
}

/**
 * How long a memory timeout quiets the auto-inject path. SELF-HEALING: the latch
 * was previously a permanent boolean cleared only on restart — so ONE transient
 * timeout (a load spike, a client cold-init window) disabled memory auto-injection
 * for the whole process lifetime, even after the backend fully recovered. That
 * silently starved every later turn of injected memory context. Now the latch is a
 * timestamp: a timeout quiets injection for a COOLDOWN, after which the inject path
 * retries; if the backend recovered, injection resumes; if it is still wedged, the
 * next inject times out and re-arms the cooldown (so a sustained outage costs at most
 * one timed-out probe per cooldown, not one per turn). Env-tunable for tests/ops.
 */
export function memoryDegradedCooldownMs(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** Epoch ms until which the auto-inject path stays quiet (0 = not degraded). */
let memoryDegradedUntil = 0;

/** True while inside the post-timeout cooldown — the auto-inject path reads this to
 *  go quiet; the explicit tools do NOT (they keep attempting under their deadline so
 *  they recover). Self-clears once the cooldown elapses (no restart required). */
export function isMemoryDegraded(): boolean {
  return Date.now() < memoryDegradedUntil;
}

/** Test-only: clear the process-level degraded latch. */
export function resetMemoryDegradedForTest(): void {
  memoryDegradedUntil = 0;
}

interface MemoryDeadlineScope {
  pending: Set<Promise<unknown>>;
  closed: boolean;
  drained: Promise<void>;
  resolveDrained: () => void;
}

export type TrackedMemoryWork<T> = {
  outcome: { ok: true; value: T } | { ok: false; error: unknown };
  /** Null when every raw operation settled before the caller-facing work returned. */
  pending: Promise<void> | null;
};

const memoryDeadlineScope = new AsyncLocalStorage<MemoryDeadlineScope>();

function trackUnderlyingMemoryWork<T>(promise: Promise<T>): void {
  const scope = memoryDeadlineScope.getStore();
  if (!scope) return;
  scope.pending.add(promise);
  const settled = () => {
    scope.pending.delete(promise);
    if (scope.closed && scope.pending.size === 0) scope.resolveDrained();
  };
  void promise.then(settled, settled);
}

/**
 * Run one caller-facing memory operation while retaining a drain signal for
 * raw promises that outlive their deadline wrappers.
 *
 * `withMemoryTimeout` intentionally cannot cancel native/database work. A
 * caller that owns a concurrency lease can use `pending` to keep that lease
 * until the real work settles even though it returns its fail-soft result as
 * soon as the deadline fires.
 */
export async function runWithTrackedMemoryTimeouts<T>(run: () => Promise<T>): Promise<TrackedMemoryWork<T>> {
  let resolveDrained!: () => void;
  const scope: MemoryDeadlineScope = {
    pending: new Set(),
    closed: false,
    drained: new Promise<void>((resolve) => {
      resolveDrained = resolve;
    }),
    resolveDrained: () => resolveDrained(),
  };

  let outcome: TrackedMemoryWork<T>['outcome'];
  try {
    outcome = { ok: true, value: await memoryDeadlineScope.run(scope, run) };
  } catch (error) {
    outcome = { ok: false, error };
  }

  scope.closed = true;
  const pending = scope.pending.size > 0 ? scope.drained : null;
  if (!pending) scope.resolveDrained();
  return { outcome, pending };
}

/**
 * Race a memory backend promise against a deadline. Rejects with
 * `MemoryTimeoutError` if the deadline fires first. An optional controller
 * forwards expiry to cooperative work. Native/SQL operations may ignore it;
 * keep tracking their raw promise until settlement, never treat abort as exit.
 */
export function withMemoryTimeout<T>(
  p: Promise<T>, label: string, timeoutMs: number, controller?: AbortController,
  scope: MemoryTimeoutScope = 'backend-operation',
): Promise<T> {
  trackUnderlyingMemoryWork(p);
  return new Promise<T>((resolve, reject) => {
    const signal = controller?.signal;
    const onAbort = () => { cleanup(); reject(signal?.reason); };
    const timer = Number.isFinite(timeoutMs) ? setTimeout(() => {
      const error = new MemoryTimeoutError(`memory ${label} exceeded ${timeoutMs}ms`, scope);
      controller?.abort(error);
      reject(error);
    }, timeoutMs) : undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // Still observe the raw promise when already aborted: native work may
    // ignore cancellation and its drain signal must reflect actual settlement.
    if (signal?.aborted) { cleanup(); onAbort(); }
    p.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

/** One lifetime for queueing, retrieval and rendering; phases cannot renew it. */
export interface MemoryWorkDeadline {
  readonly signal: AbortSignal;
  run<T>(start: () => Promise<T>, label: string, capMs?: number): Promise<T>;
  /**
   * Milliseconds left before this deadline expires: 0 once it has expired or been
   * aborted, Infinity when it is unbounded. A step that sizes its own wait from
   * this (the Jev memory gate does) stops before the deadline cuts it off, so the
   * step's own timeout, not the deadline, is what its ledger records.
   */
  remainingMs(): number;
  close(): void;
}

export function createMemoryWorkDeadline(timeoutMs: number, parent?: AbortSignal): MemoryWorkDeadline {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  const expiresAt = Date.now() + timeoutMs;
  const expire = () => controller.abort(new MemoryTimeoutError(`memory block exceeded ${timeoutMs}ms`, 'request-budget'));
  const timer = Number.isFinite(timeoutMs) ? setTimeout(expire, timeoutMs) : undefined;
  return {
    signal: controller.signal,
    async run(start, label, capMs = timeoutMs) {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0 && !controller.signal.aborted) expire();
      controller.signal.throwIfAborted();
      // Only a shorter operation cap measures a backend-operation timeout.
      // Exhausting the shared lifetime also includes queueing/other phases;
      // cancellation remains local to this request, never a global health signal.
      return await withMemoryTimeout(start(), label, Math.min(remaining, capMs), controller,
        capMs < remaining ? 'backend-operation' : 'request-budget');
    },
    remainingMs() {
      // expiresAt is Infinity for an unbounded deadline, so this stays Infinity.
      return controller.signal.aborted ? 0 : Math.max(0, expiresAt - Date.now());
    },
    close() { if (timer !== undefined) clearTimeout(timer); parent?.removeEventListener('abort', onParentAbort); },
  };
}

/**
 * Wrap an explicit-tool backend call with the tool deadline. On timeout it
 * flips the process degraded latch (so the hot inject path goes quiet) and
 * rethrows `MemoryTimeoutError` for the caller to map onto its degraded
 * envelope.
 */
export function withMemoryToolTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return withMemoryTimeout(p, label, memoryToolTimeoutMs()).catch((err: unknown) => {
    noteMemoryFailure(err);
    throw err;
  });
}

/**
 * How many total attempts a memory WRITE gets under the tool deadline before a
 * timeout is surfaced. EI-6684: a single transient write-path stall (the mem0
 * sidecar / PG insert briefly wedged) previously dropped the fact SILENTLY on
 * the first `MemoryTimeoutError` — agents write-and-forget, so the durable fact
 * was lost with no second chance (the reported incident: two consecutive
 * memory:remember calls timed out within seconds). A bounded retry gives a
 * TRANSIENT blip another attempt. Env-tunable; default 2 (1 retry), clamped to
 * [1, 5]. Evaluated at call time so tests can flip it per-test.
 *
 * Kept SMALL on purpose: a write retry is ~2× the backend load on the (rare)
 * timeout path, so a large count risks AMPLIFYING a sustained wedge rather than
 * riding out a blip — and a sustained wedge is additionally skipped via the
 * process degraded latch (see `withMemoryWriteRetry`).
 */
export function memoryWriteMaxAttempts(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 5) : 2;
}

/** Backoff between memory-write retry attempts (ms). Short — the deadline
 *  already bounded the failed attempt; this is just a breather to let a
 *  momentary blip clear. Env-tunable; default 250ms. */
export function memoryWriteRetryBackoffMs(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_WRITE_RETRY_BACKOFF_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 250;
}

/**
 * Run a memory WRITE under the tool deadline, RETRYING on a timeout so a
 * TRANSIENT stall doesn't silently drop the fact (EI-6684). `attempt` is a
 * factory the caller re-invokes for each try (a fresh backend promise per
 * attempt — a settled promise can't be re-awaited).
 *
 * Retry policy — deliberately conservative to match this module's fail-fast,
 * degrade-under-load posture:
 *   - Retries ONLY on `MemoryTimeoutError`. A clean `MemoryUnavailableError`
 *     or a classified embed failure is DETERMINISTIC (store down / rate-limited
 *     / bad key) — retrying it just adds latency — so those propagate on the
 *     first attempt.
 *   - SKIPS the retry when the process was ALREADY in the degraded cooldown
 *     BEFORE this write (captured up front): a sustained / known-wedged backend
 *     should fail fast, not pile retries on. Only a FRESH (possibly transient)
 *     timeout is retried.
 *   - Bounded (`memoryWriteMaxAttempts`, default 2) with a short backoff, so the
 *     worst-case wait (attempts × deadline + backoffs) stays well under the
 *     ~55–60s MCP transport cap.
 *
 * TRADE-OFF (documented honestly): `withMemoryTimeout` does NOT cancel the
 * underlying work, so if a timed-out first attempt LATER commits, a retry can
 * create a DUPLICATE row. That is an accepted trade — a rare duplicate fact
 * (dedup-on-write is a separate, opt-in hygiene layer) is far less harmful than
 * a SILENTLY LOST one, which is the failure this fixes.
 */
export async function withMemoryWriteRetry<T>(
  attempt: () => Promise<T>,
  label: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Snapshot the degraded state BEFORE the first attempt — this write's own
  // timeout will arm the latch (via withMemoryToolTimeout), so reading it after
  // would always look degraded. A process that was already degraded when the
  // write STARTED is a sustained wedge → fail fast, no retry.
  const alreadyDegraded = isMemoryDegraded();
  const maxAttempts = memoryWriteMaxAttempts();
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await withMemoryToolTimeout(attempt(), label);
    } catch (err) {
      lastErr = err;
      const canRetry =
        err instanceof MemoryTimeoutError && !alreadyDegraded && i < maxAttempts - 1;
      if (!canRetry) throw err;
      const backoff = memoryWriteRetryBackoffMs();
      if (backoff > 0) await sleep(backoff);
    }
  }
  // Unreachable — the loop always returns or throws — but satisfies the type.
  throw lastErr;
}

/** Quiet injection for a backend-operation timeout. Shared request-budget
 *  expiry and other failures stay local to the caller; they cannot establish
 *  a backend-wide hang. */
export function noteMemoryFailure(err: unknown): void {
  if (err instanceof MemoryTimeoutError && err.scope === 'backend-operation') {
    const wasDegraded = isMemoryDegraded();
    memoryDegradedUntil = Date.now() + memoryDegradedCooldownMs();
    // NODE_ENV guard mirrors injection.ts — the latch still arms; only the log
    // line is suppressed under vitest (the repo's fail-on-console treats any
    // console.warn as a test failure). Log only on the LEADING edge so a sustained
    // outage doesn't spam one line per re-arm.
    if (!wasDegraded && process.env.NODE_ENV !== 'test') {
      console.warn(
        `[memory] ${err.message} — auto-inject quieted for ${Math.round(memoryDegradedCooldownMs() / 1000)}s (will retry; explicit tools keep attempting)`,
      );
    }
  }
}

/**
 * Map an embedder failure to a CLEAN, actionable degraded reason for the memory tools —
 * or null if it isn't an embed failure (let those propagate to handler_error).
 *
 * mem0-timeout-fix-2026-06-24: a budget-exhausted embed (org-wide TPM 429 / 5xx /
 * connection stall) now FAILS FAST — the embedder budget (`EMBED_TOTAL_BUDGET_MS`,
 * configure.ts) is coupled UNDER this module's tool deadline. Surfacing the failure as a
 * recognized `reason` (rather than an opaque `handler_error`) lets the agent narrate
 * ACCURATELY ("memory embeddings are rate-limited") instead of the misleading "mem0 timed
 * out (backend slow), retrying…" that the old 10s-hang `memory_timeout` produced. Matches
 * the `openai_embed_failed_<status>` message thrown by `buildOpenAiEmbedder`.
 *
 * `embed_quota_exhausted` is the HARD-stop sibling of `embed_rate_limited`
 * (mem0-embed-insufficient-quota-classification): OpenAI returns 429 for BOTH a transient
 * rate-limit AND a permanent `insufficient_quota` billing condition. `buildOpenAiEmbedder`
 * distinguishes them and tags the billing stop `openai_embed_quota_exhausted` so this maps it
 * to its own reason — the agent narrates "OpenAI quota exhausted — check billing" (an OWNER
 * action, not a retry) instead of the misleading "rate-limited, retrying". Checked FIRST so the
 * generic `openai_embed_failed_429` branch can't shadow it.
 */
export function embedFailureReason(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  // Hit our OWN daily spend cap (embed-admission EmbedBudgetExhaustedError) — distinct from an
  // OpenAI-side failure: the embedder is healthy, we deliberately stopped spending. The agent
  // should narrate "embedding daily spend cap reached" (raise PAPERCUSP_EMBED_DAILY_TOKEN_CAP or
  // wait for the UTC-day reset), not "retrying". (cost-audit-2026-06-29.)
  if (/embed_daily_budget_exhausted/.test(msg)) return 'embed_budget_exhausted';
  if (/openai_embed_quota_exhausted/.test(msg)) return 'embed_quota_exhausted';
  if (/openai_embed_failed_429/.test(msg)) return 'embed_rate_limited';
  if (/openai_embed_failed/.test(msg)) return 'embed_unavailable';
  // WI-4183: a configured embed sidecar is REQUIRED (no in-process fallback, WI-4021 D-003
  // retired) — a dead/unreachable sidecar throws a plain Error whose message is prefixed
  // `sidecar_required_unavailable: …` (embed-sidecar-wiring.ts / libs/generic/memory's
  // buildSidecarFirstEmbedder). It is NOT a MemoryUnavailableError instance, so without this
  // branch it fell through every check here to the raw `throw err` in remember.ts/search.ts —
  // an opaque handler_error that hid the already-journaled write's reason/journal_id from the
  // caller. Map it to a clean reason exactly like every other embed-failure mode above.
  if (/sidecar_required_unavailable/.test(msg)) return 'sidecar_unavailable';
  // EI-21348316803580175: the query embed blew the caller's opt-in
  // SearchOptions.embedTimeoutMs (EmbedBudgetExceededError, thrown by
  // libs/generic/memory's Mem0Backend). The embedder is not broken — it is
  // SATURATED, and we deliberately stopped waiting on it.
  //
  // This branch is load-bearing, not cleanup: the budget only pays off because
  // the throw lands here and is classified, which is what routes the caller
  // into the embed-free lexical fallback (WI-4214). Unclassified it would fall
  // through to the raw `throw err` and surface as an opaque handler_error —
  // turning a slow-but-successful search into a failed one.
  if (/embed_budget_exceeded/.test(msg)) return 'embed_timeout';
  return null;
}
