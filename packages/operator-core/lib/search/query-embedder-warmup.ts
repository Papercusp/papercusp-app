/**
 * Warm query-embedder selection for interactive search surfaces.
 *
 * The shared search engine resolves P-017 floors from the exact embedder
 * function object before either leg runs. A caller must therefore hand it the
 * stamped instance when one is warm, never a lazy wrapper that may eventually
 * resolve to that instance. Cold callers get a rejecting embedder instead:
 * lexical search can still complete immediately, while the semantic leg is
 * reported as blocked and one background warm-up prepares the next request.
 */
import type { Embedder } from '@papercusp/search';
import type { EmbedderProfileSpec } from '@papercusp/memory';

export interface ResolvedQueryEmbedder {
  mode: string;
  dims: number;
  /** Exact space contract. Optional only for legacy/test resolvers; consumers
   * that compare stored vectors must fail closed when it is absent. */
  profile?: Pick<EmbedderProfileSpec, 'profileId' | 'targetDims' | 'distanceMetric'>;
  embed: Embedder;
}

export type QueryEmbedderResolver<T extends ResolvedQueryEmbedder = ResolvedQueryEmbedder> = () => Promise<T | null>;

export interface QueryEmbedderRetry {
  token: string;
  afterMs: number;
  reason: 'query_embedder_warming';
}

export interface QueryEmbedderSelection<T extends ResolvedQueryEmbedder> {
  /** The exact resolved object, when warm; useful for mode-aware callers. */
  resolved: T | null;
  /** Always present: the stamped instance when warm, otherwise a throw-only signal. */
  embedder: Embedder;
  /** Present only while the first warm-up is still in flight. */
  retry?: QueryEmbedderRetry;
}

export interface QueryEmbedderWarmup<T extends ResolvedQueryEmbedder> {
  select(resolver?: QueryEmbedderResolver<T>): QueryEmbedderSelection<T>;
  warm(resolver?: QueryEmbedderResolver<T>): Promise<boolean>;
  reset(): void;
}

export function createQueryEmbedderWarmup<T extends ResolvedQueryEmbedder>(opts: {
  warmupText: string;
  retryTokenPrefix: string;
  resolve: QueryEmbedderResolver<T>;
  validate?: (resolved: T) => string | null;
  retryAfterMs?: number;
}): QueryEmbedderWarmup<T> {
  const retryAfterMs = opts.retryAfterMs ?? 1_000;
  let warmEmbedder: T | null = null;
  let warmupInFlight: Promise<void> | null = null;
  let warmupFailure: string | null = null;
  let warmupGeneration = 0;
  let warmupAttempt = 0;
  let warmupRetryToken: string | null = null;

  // This function is intentionally throw-only. It cannot produce a vector,
  // so handing it to the engine cannot create an unfloored semantic result;
  // the engine records the rejection in legs.semantic.blocked instead.
  const rejectingEmbedder: Embedder = async () => {
    throw new Error(
      warmupFailure ?? 'query embedder warming up (cold start; retry for semantic results)',
    );
  };

  const start = (resolver: QueryEmbedderResolver<T>): Promise<void> => {
    if (warmEmbedder) return Promise.resolve();
    if (warmupInFlight) return warmupInFlight;

    const generation = warmupGeneration;
    warmupRetryToken = `${opts.retryTokenPrefix}:${generation}:${++warmupAttempt}`;
    // Preserve a previous settled failure while a retry runs. That keeps the
    // response honest: a persistent outage is not mislabeled as a fresh
    // "warming up" state on every request.
    const started = (async () => {
      try {
        const resolved = await resolver();
        if (generation !== warmupGeneration) return;
        if (!resolved) {
          warmupFailure = 'no query embedder resolved (unavailable or disabled)';
          return;
        }
        const validationFailure = opts.validate?.(resolved);
        if (validationFailure) {
          warmupFailure = validationFailure;
          return;
        }

        // Resolution alone is not enough for a cold local model: the first
        // real embed can still pay model/session initialization. Pay it here,
        // outside the interactive request's critical path.
        await resolved.embed(opts.warmupText);
        if (generation === warmupGeneration) {
          warmEmbedder = resolved;
          warmupFailure = null;
        }
      } catch (err) {
        if (generation === warmupGeneration) {
          warmupFailure = `query embedder warmup failed: ${(err as Error)?.message ?? String(err)}`;
        }
      } finally {
        if (generation === warmupGeneration) {
          warmupInFlight = null;
          warmupRetryToken = null;
        }
      }
    })();
    warmupInFlight = started;
    return started;
  };

  return {
    select(resolver = opts.resolve): QueryEmbedderSelection<T> {
      if (warmEmbedder) {
        return { resolved: warmEmbedder, embedder: warmEmbedder.embed };
      }

      void start(resolver);
      const retry =
        warmupFailure === null && warmupRetryToken
          ? { token: warmupRetryToken, afterMs: retryAfterMs, reason: 'query_embedder_warming' as const }
          : undefined;
      return { resolved: null, embedder: rejectingEmbedder, ...(retry ? { retry } : {}) };
    },

    async warm(resolver = opts.resolve): Promise<boolean> {
      await start(resolver);
      return warmEmbedder !== null;
    },

    reset(): void {
      warmupGeneration += 1;
      warmEmbedder = null;
      warmupInFlight = null;
      warmupFailure = null;
      warmupRetryToken = null;
    },
  };
}
