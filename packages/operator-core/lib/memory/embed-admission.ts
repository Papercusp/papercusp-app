/**
 * Shared embed-TPM admission lane.
 *
 * watchdog-and-exposed-systems-improvement-2026-06-18 P-002 (D-007/D-008);
 * watchdog-embed-resilience-and-dedup-2026-06-17 D-003.
 *
 * ── ROOT CAUSE this cures ────────────────────────────────────────────────────────────────
 * The high-volume `search:semantic` / `work_items:search` embed path
 * (`agent-tools/search/embedder.ts`) fired UNGOVERNED OpenAI `text-embedding-3-small`
 * calls. Under the xbench benchmark fleet this burned the shared org 1M-TPM ceiling, 429ing
 * EVERY embed FLEET-WIDE — which hard-failed all `memory:*` too (`memory/configure.ts` uses
 * the SAME org quota). The P-001 header-aware retry only RIDES OUT a 429; it does not stop the
 * workload from exhausting the org in the first place.
 *
 * ── THE CURE (no-money, code-only) ──────────────────────────────────────────────────────────
 * The owner approach-choice (governor vs a separate paid OpenAI key) is resolved here to the
 * GOVERNOR — no money, reversible. ONE process-wide `RateLimitGovernor` (the domain-free
 * resilience primitive — reuse-first, not a new parallel system) that BOTH embed paths acquire
 * from before each call:
 *   - its `itpm` budget caps AGGREGATE embed token-rate UNDER the org ceiling (so prod memory
 *     always has guaranteed headroom), and
 *   - its `maxConcurrent` cap bounds the burst (the governor's own docs: "capping how many run
 *     at once is the real burst fix").
 * Two LANES give priority WITHOUT starvation, via asymmetric wait budgets:
 *   - `'bench'`  (search:semantic / work_items:search — the CAUSE): a SHORT wait, then SHED →
 *     the caller throws and the search engine degrades to BM25 (`libs/generic/search/hybrid.ts`
 *     already try/catches the embedder → BM25, so a shed is graceful). High-volume work yields
 *     FIRST so it can never exhaust the org.
 *   - `'memory'` (memory:remember / recall — must succeed, low volume): a longer wait, and on
 *     denial it PROCEEDS anyway (passthrough) so production recall never hard-fails on
 *     admission; the existing P-001 header-aware retry is its 429 backstop.
 * A 429 from either path feeds `penalize()` → the shared bucket pauses → bench sheds, memory
 * rides it out.
 *
 * Flag-gated (`FLAGS.EMBED_ADMISSION`, default ON) — OFF ⇒ a byte-identical passthrough.
 */

import { randomUUID } from 'node:crypto';

import { RateLimitGovernor } from '@papercusp/papercusp-shared/agent';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { maybeEscalateEmbedExhaustion } from './embed-exhaustion-alert';
import type { AdmissionContext, ResourceDemand } from '../resource-governor/admission';
import { beginGovernedExecution, governedExecutionRuntime, type GovernedExecution } from '../resource-governor/execution';
import { activeWorkspaceId } from '../workspace-registry';

export type EmbedLane = 'memory' | 'bench';

// Provider headers/429s remain useful feedback, but they are not a productive
// capacity authority.  The old ITPM and maxConcurrent seeds made this process-local
// governor a hidden cap; durable Governor admissions below now own the embedding
// start/queue lifecycle.  Keep an unbounded local bucket only to pace against live
// provider feedback while the canonical receipt carries the resource decision.
const EMBED_PROVIDER_FEEDBACK_MAX_CONCURRENT = Number.POSITIVE_INFINITY;

// ── Daily cumulative SPEND cap (cost-audit-2026-06-29) ────────────────────────────────────────
// The itpm/maxConcurrent caps above bound the embed RATE, not the cumulative spend — a run that
// stays UNDER the rate cap can still rack up a large bill over hours (the $58/mo audit: a bench /
// backfill loop re-embedding corpora). This HARD daily TOKEN budget is the spend backstop: once a
// UTC-day's estimated embed tokens exceed the cap, EVERY embed is DENIED (throws
// EmbedBudgetExhaustedError) until the next day — for BOTH lanes, regardless of the EMBED_ADMISSION
// flag (a spend ceiling must not be defeatable by the rate-governing toggle). Sized GENEROUSLY by
// default (~5M tok/day ≈ $0.10/day on text-embedding-3-small at $0.02/1M) so it NEVER trips in
// normal operation (measured ~<1M tok/MONTH) but stops a runaway before it can drain a
// low-balance key. Env-tunable; set to 0 to disable the cap entirely.
export const EMBED_DAILY_TOKEN_CAP = Math.max(0, Number(process.env.PAPERCUSP_EMBED_DAILY_TOKEN_CAP) || 5_000_000);
const MS_PER_DAY = 86_400_000;

/** Per-lane admission wait budget. memory > bench so under contention MEMORY wins the shared
 *  slot (it waits longer) while BENCH sheds fast → BM25. */
export const LANE_WAIT_MS: Record<EmbedLane, number> = {
  memory: Number(process.env.PAPERCUSP_EMBED_WAIT_MEMORY_MS) || 5_000,
  bench: Number(process.env.PAPERCUSP_EMBED_WAIT_BENCH_MS) || 2_500,
};

const FLAG_TTL_MS = 30_000;

/** ~4 chars/token for text-embedding-3-small — the `itpm` charge for one embed of `text`. */
export function estimateEmbedTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface EmbedSlot {
  /** Release the governed slot (idempotent). Always call in a `finally`. */
  release(): void;
}

const PASSTHROUGH: EmbedSlot = { release() {} };

/** Thrown by the BENCH embed fn when admission sheds — the search engine catches it → BM25. */
export class EmbedShedError extends Error {
  readonly lane: EmbedLane;
  constructor(lane: EmbedLane) {
    super(`embed_admission_shed:${lane}`);
    this.name = 'EmbedShedError';
    this.lane = lane;
  }
}

/** Thrown by `acquire()` when the DAILY token budget (EMBED_DAILY_TOKEN_CAP) is exhausted —
 *  a HARD spend stop for BOTH lanes. The search path's embedder try/catch degrades to BM25; the
 *  memory path maps it (op-deadline.embedFailureReason) to `embed_budget_exhausted` so the agent
 *  narrates "embedding daily spend cap hit" rather than retrying. Message carries `embed_daily_budget_exhausted`
 *  so message-matching callers (configure.ts non-retryable guard) recognize it. (cost-audit-2026-06-29.) */
export class EmbedBudgetExhaustedError extends Error {
  readonly lane: EmbedLane;
  constructor(lane: EmbedLane) {
    super(`embed_daily_budget_exhausted:${lane}`);
    this.name = 'EmbedBudgetExhaustedError';
    this.lane = lane;
  }
}

/** Live embed-spend usage for monitoring (cost-audit-2026-06-29). */
export interface EmbedUsage {
  /** UTC-day index (epoch-ms / 86.4M) the counter is currently accumulating into. */
  day: number;
  /** Estimated embed tokens charged so far this UTC day (across BOTH lanes). */
  dayTokens: number;
  /** The daily cap (0 = uncapped). */
  capTokens: number;
  /** True once dayTokens has reached the cap (further embeds are denied). */
  overBudget: boolean;
}

/** A fetch `Headers` → the plain record `recordResponse` wants (governor lowercases keys).
 *  Null-safe: a response with no/odd headers (mocked fetch, edge transports) yields `{}` rather
 *  than throwing on the embed hot path. */
export function headersToRecord(h: Headers | null | undefined): Record<string, string | undefined> {
  const o: Record<string, string | undefined> = {};
  if (h && typeof h.forEach === 'function') {
    h.forEach((v, k) => {
      o[k] = v;
    });
  }
  return o;
}

/** OpenAI `retry-after` (seconds or HTTP-date) → ms, or undefined. */
export function retryAfterMs(headers: Record<string, string | undefined>): number | undefined {
  const ra = headers['retry-after'] ?? headers['Retry-After'];
  if (!ra) return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const dateMs = Date.parse(ra);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

export interface EmbedAdmissionDeps {
  governor: RateLimitGovernor;
  /** Resolve the flag (cached by the production singleton). */
  isEnabled: () => Promise<boolean>;
  /** Override per-lane wait budgets (tests). */
  laneWaitMs?: Record<EmbedLane, number>;
  /** Daily token spend cap (default EMBED_DAILY_TOKEN_CAP; 0 = uncapped). Injectable for tests. */
  dailyTokenCap?: number;
  /** Clock seam (default Date.now) so tests can drive the UTC-day rollover deterministically. */
  now?: () => number;
  /** Canonical durable admission seam. Production supplies this; unit tests may omit it. */
  beginExecution?: (input: {
    idempotencyKey: string;
    lane: EmbedLane;
    tokens: number;
    demand: ResourceDemand;
  }) => Promise<Pick<GovernedExecution, 'finish' | 'cancel'>>;
}

export interface EmbedAdmission {
  /** Acquire a governed slot for one embed of `text` on `lane`. Returns a release handle, or
   *  `null` ONLY for the bench lane when admission was denied within its wait budget (the caller
   *  then sheds → BM25). The memory lane never returns null (it passes through on denial).
   *  THROWS `EmbedBudgetExhaustedError` (both lanes) when the daily token budget is exhausted —
   *  a HARD spend stop that holds even with the EMBED_ADMISSION flag off. */
  acquire(text: string, lane: EmbedLane): Promise<EmbedSlot | null>;
  /** Feed an embed response's headers to the governor (learns the live limit; on remaining=0
   *  pauses to reset). Call on EVERY response (ok or 429). */
  recordResponse(headers: Record<string, string | undefined>): void;
  /** A 429: pause the shared bucket so every embed caller backs off. */
  penalize(opts: { retryAfterMs?: number; resetAt?: number }): void;
  /** Live daily embed-spend usage (monitoring). Rolls the UTC-day window on read. */
  usage(): EmbedUsage;
  readonly governor: RateLimitGovernor;
}

/**
 * Factory with an injected governor + flag so the lane/shed logic is unit-testable without real
 * network/credentials/flags. Production wires the process singleton via `embedAdmission()`.
 */
export function createEmbedAdmission(deps: EmbedAdmissionDeps): EmbedAdmission {
  const waits = deps.laneWaitMs ?? LANE_WAIT_MS;
  const cap = deps.dailyTokenCap ?? EMBED_DAILY_TOKEN_CAP;
  const now = deps.now ?? Date.now;
  // Daily cumulative-spend counter (cost-audit-2026-06-29). Per-instance so a test reset / a fresh
  // singleton starts clean. Rolls when the UTC-day index changes.
  let day = Math.floor(now() / MS_PER_DAY);
  let dayTokens = 0;
  let capLoggedDay = -1; // last UTC-day index we logged the cap-hit warning (warn-once-per-day)
  const rollDay = (): void => {
    const d = Math.floor(now() / MS_PER_DAY);
    if (d !== day) {
      day = d;
      dayTokens = 0;
    }
  };
  return {
    governor: deps.governor,
    async acquire(text: string, lane: EmbedLane): Promise<EmbedSlot | null> {
      const tokens = estimateEmbedTokens(text);
      // HARD daily SPEND cap FIRST — checked even when the rate-governing flag is off, so a spend
      // ceiling can't be defeated by toggling EMBED_ADMISSION. cap===0 disables the cap.
      rollDay();
      if (cap > 0 && dayTokens + tokens > cap) {
        // MONITORING: log loudly ONCE per UTC-day the cap binds, so a runaway is VISIBLE in logs
        // rather than only surfacing as per-call `embed_budget_exhausted` reasons. NODE_ENV guard
        // mirrors op-deadline.ts — the repo's fail-on-console rule treats console.warn as a test
        // failure, so suppress under vitest (the throw still happens; only the log is gated).
        if (capLoggedDay !== day && process.env.NODE_ENV !== 'test') {
          capLoggedDay = day;
          console.warn(
            `[embed-admission] DAILY embed spend cap hit (${dayTokens}/${cap} est tokens this UTC day) — ` +
              `further embeds DENIED until the day rolls over. This is the runaway backstop; if it's ` +
              `legitimate load, raise PAPERCUSP_EMBED_DAILY_TOKEN_CAP (current ${cap}).`,
          );
        }
        maybeEscalateEmbedExhaustion('daily_cap');
        throw new EmbedBudgetExhaustedError(lane);
      }
      // Flag off → no rate-governing (byte-identical passthrough), but the embed STILL counts
      // toward the daily cap (charge + proceed).
      let localRelease: (() => void) | undefined;
      if (!(await deps.isEnabled())) {
        dayTokens += tokens;
      } else {
        const release = await deps.governor.acquire({ inTok: tokens }, { maxWaitMs: waits[lane] });
        if (release) {
          dayTokens += tokens; // admitted → an embed will fire → charge the daily budget
          // Continue to the canonical receipt below; provider feedback is advisory only.
          localRelease = release;
        } else if (lane === 'bench') {
          // Denied within the lane budget: bench SHEDS (caller → BM25, no embed → no charge).
          return null;
        } else {
          // Memory PROCEEDS (its existing 429 retry is the backstop), while still
          // recording the estimated spend because an embed will fire.
          dayTokens += tokens;
        }
      }
      // The process-local governor above is deliberately feedback-only. Every
      // embedding start still gets a durable receipt and typed lineage when the
      // production seam is installed, including flag-off passthroughs.
      let execution: Pick<GovernedExecution, 'finish' | 'cancel'> | undefined;
      if (deps.beginExecution) {
        try {
          execution = await deps.beginExecution({
            idempotencyKey: `embedding:${lane}:${randomUUID()}`,
            lane,
            tokens,
            demand: { providerRequests: 1, networkBytes: tokens },
          });
        } catch (error) {
          localRelease?.();
          if (lane === 'bench') return null;
          throw error;
        }
      }
      if (!execution && !localRelease) return PASSTHROUGH;
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          localRelease?.();
          void execution?.finish({ providerRequests: 1, networkBytes: tokens }).catch(() => undefined);
        },
      };
    },
    recordResponse(headers: Record<string, string | undefined>): void {
      deps.governor.recordResponse(headers);
    },
    penalize(opts: { retryAfterMs?: number; resetAt?: number }): void {
      deps.governor.penalize({ rateLimited: true, ...opts });
    },
    usage(): EmbedUsage {
      rollDay();
      return { day, dayTokens, capTokens: cap, overBudget: cap > 0 && dayTokens >= cap };
    },
  };
}

let _singleton: EmbedAdmission | null = null;
let _flagCache: { value: boolean; at: number } | null = null;

/** Cached flag read — the hot path can't afford a PG/cache round-trip per embed. Defaults ON
 *  (and on a read failure) so embeds are never blocked by a flag-store hiccup. */
async function embedAdmissionEnabled(): Promise<boolean> {
  const now = Date.now();
  if (_flagCache && now - _flagCache.at < FLAG_TTL_MS) return _flagCache.value;
  let value = true;
  try {
    value = await getFlag(FLAGS.EMBED_ADMISSION, 'embed-admission');
  } catch {
    value = true; // default ON; never block embeds on a flag-read failure
  }
  _flagCache = { value, at: now };
  return value;
}

/** The process-wide embed admission lane (lazy singleton). BOTH embed paths share this so the
 *  governed budget spans search + memory in one window. */
export function embedAdmission(): EmbedAdmission {
  if (!_singleton) {
    const governor = new RateLimitGovernor({
      maxConcurrent: EMBED_PROVIDER_FEEDBACK_MAX_CONCURRENT,
    });
    const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID?.trim() || activeWorkspaceId();
    // Unit suites exercise the OpenAI retry/mode-selection path with fetch
    // doubles and deliberately have no Postgres fixture. Keep that test path
    // hermetic by omitting only the durable receipt writer; production (where
    // NODE_ENV is not `test`) always installs beginGovernedExecution and cannot
    // accept an embed without a persisted Governor receipt.
    const durableBeginExecution = process.env.NODE_ENV === 'test'
      ? undefined
      : async ({ idempotencyKey, lane, tokens, demand }: {
          idempotencyKey: string;
          lane: EmbedLane;
          tokens: number;
          demand: ResourceDemand;
        }) =>
          beginGovernedExecution(
            {
              idempotencyKey,
              admissionClass: 'embedding',
              demand,
              metadata: { lane, estimatedTokens: tokens },
            },
            { owner: `embed-admission:${process.pid}`, leaseTtlMs: 5 * 60_000 },
            governedExecutionRuntime(workspaceId, 'embedding'),
          );
    _singleton = createEmbedAdmission({
      governor,
      isEnabled: embedAdmissionEnabled,
      ...(durableBeginExecution ? { beginExecution: durableBeginExecution } : {}),
    });
  }
  return _singleton;
}

/** Test seam: drop the singleton + flag cache so each test starts clean. */
export function __resetEmbedAdmissionForTest(): void {
  _singleton = null;
  _flagCache = null;
}
