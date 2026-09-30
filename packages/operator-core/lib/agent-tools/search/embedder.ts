/**
 * Query-embedding provider for `search:semantic` — the operator's
 * EmbedderProvider seam for `@papercusp/search`. Same cascade mem0 uses
 * (OpenAI when a key is configured, else local transformers), but lazy.
 * Returns null when no embedder is available — the engine then falls back
 * to BM25-only.
 *
 * Extracted out of search/semantic.ts per
 * papercusp-systems-abstraction-2026-05-29 (P-020).
 *
 * MODE RESOLUTION is delegated to `memory/configure.ts`'s `resolveEmbedderWith`
 * cascade (EI-8913) — this used to re-derive its own openai/local decision
 * independently (env override missed, OpenAI post-failure cooldown ignored),
 * which could silently pick a DIFFERENT embedder than memory for the exact
 * same text, desynchronizing query vectors from stored ones. Only the actual
 * embed-fn BODIES stay bespoke here (the admission-governed OpenAI fetch) —
 * the local leg now reuses `@papercusp/memory`'s `buildLocalEmbedder` (see
 * EI-9143 below) so there is exactly one local-transformers pipeline builder
 * in the codebase, shared with mem0.
 *
 * EI-9143 (2026-07-10): this file used to construct its OWN bare
 * `transformers.pipeline('feature-extraction', …)` call with no
 * `session_options`, independent of `libs/generic/memory`'s worker. ONNX
 * Runtime defaults intra-op threads to EVERY core and spin-waits them
 * (the same class of bug WI-3792 root-caused and fixed at the 3 pipeline
 * sites inside `libs/generic/memory` — this was an unfixed 4th site, since
 * it never routed through that package's capped/worker-isolated builder).
 * Every recipes:search / search:semantic call that fell through to the
 * local embedder (e.g. after an OpenAI quota/cooldown) could spin up an
 * uncapped, all-core spin-wait pool, explaining the ~5% recipes:search
 * timeouts (60s) tracked in EI-9143. Fixed by delegating to
 * `buildLocalEmbedder` (same model, same output shape — a drop-in
 * `Embedder` — but worker-thread isolated with `embedViaWorker` and,
 * on inline fallback, capped via `ORT_SESSION_OPTIONS`).
 */

import type { Embedder } from '@papercusp/search';
import { normalizeEmbeddingText, type EmbedderProfileSpec } from '@papercusp/memory';
import { buildSidecarAwareEmbedder, isLocalEmbedAcquisitionCheap } from '../../memory/embed-sidecar-wiring';
import { embedAdmission, headersToRecord, retryAfterMs } from '../../memory/embed-admission';
import {
  resolveEmbedderWith,
  readEmbedderPreference,
  proseSurfacePreference,
  resolveOpenAiKey,
  localAvailable,
  isOpenAiEmbedInCooldown,
} from '../../memory/configure';

// The prose column width contract — ONE source, not a restated `384` (D-005 §5).
// The QUERY vector must land in the same space as the STORED vectors, so this
// side is bound by the same contract as the backfill side.
import { modeTargetDims } from '../../search/prose-vector-dims';

const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';

function buildAdmissionGovernedOpenAiEmbedder(key: string): Embedder {
  return async (text: string) => {
    // BENCH lane of the shared embed-TPM admission governor
    // (watchdog-and-exposed-systems-improvement-2026-06-18 P-002). This is the high-volume
    // path that exhausted the org TPM and starved memory. Acquire a governed slot; a SHED
    // (null) throws — runHybridSearch try/catches the embedder → degrades to BM25 (P-008),
    // so the search still returns rather than hard-failing. The governor's concurrency + itpm
    // caps keep aggregate embed rate under the ceiling so prod memory keeps its headroom.
    const adm = embedAdmission();
    const slot = await adm.acquire(text, 'bench');
    if (slot === null) throw new Error('openai_embed_shed'); // admission shed → engine falls to BM25
    try {
      const r = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: OPENAI_EMBEDDER_MODEL,
          input: text,
          dimensions: modeTargetDims('openai'),
        }),
      });
      adm.recordResponse(headersToRecord(r.headers)); // learn the live limit / pause on remaining=0
      if (!r.ok) {
        if (r.status === 429) adm.penalize({ retryAfterMs: retryAfterMs(headersToRecord(r.headers)) });
        throw new Error(`openai_embed_${r.status}`);
      }
      const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
      return j.data[0].embedding;
    } finally {
      slot.release();
    }
  };
}

/** The query embedder PLUS its resolved mode + dims. Consumers whose stored
 *  vectors carry a space discriminator (migration 530/551 `<col>_mode`) need
 *  the mode to filter `WHERE <col>_mode = <active>` — cosine against a
 *  foreign-space vector is meaningless (embedding-space-vs-dimension). */
export interface ResolvedQueryEmbedder {
  mode: 'openai' | 'local' | 'gemma' | 'harrier';
  dims: number;
  /** Exact query-space provenance; mode/width alone never establish compatibility. */
  profile: EmbedderProfileSpec;
  embed: Embedder;
}

/** Opt-in bound on the query-embedder ACQUISITION (the resolveEmbedderWith
 *  cascade: OpenAI-key resolve, or — when OpenAI embed quota is exhausted — the
 *  local sidecar spawn + ONNX pipeline cold-start that runs 15–30s the first
 *  time). `acquireBudgetMs` caps that wait: on timeout the acquisition resolves
 *  `null`, which is the SAME "no embedder → degrade to BM25" signal every caller
 *  already handles, so bounding it is backward-compatible (0/undefined ⇒ today's
 *  unbounded wait — background/batch callers keep it). This is the shared, central
 *  form of the bound WI-3860 first applied inline in
 *  endpoint-route/routes/adv/sessions.ts; see WI-3922. */
export interface QueryEmbedderAcquireOpts {
  acquireBudgetMs?: number;
  /** WI-3923: for an INTERACTIVE caller only. When true AND OpenAI embed is in
   *  its post-failure cooldown (isOpenAiEmbedInCooldown) AND the local
   *  acquisition is currently known-cold (!isLocalEmbedAcquisitionCheap —
   *  i.e. a host-local sidecar this process must spawn hasn't finished its
   *  ready handshake yet), skip attempting the acquisition for THIS call and
   *  degrade straight to BM25 (resolve null) — rather than paying the FULL
   *  `acquireBudgetMs` bound on every single query while cold, as
   *  `withAcquireBudget` otherwise always does (there is nothing for it to
   *  resolve early to). The acquisition is still fired in the background
   *  (fire-and-forget, errors swallowed) so the pipeline keeps warming for a
   *  later query — the exact same "losing acquisition keeps warming"
   *  behavior `withAcquireBudget` already has on a timeout, just entered
   *  without waiting first. Default false/undefined: zero behavior change
   *  for any caller that doesn't opt in (batch/background acquisitions that
   *  intentionally wait a long budget — e.g. transcript-search-warmup's 60s
   *  — must NOT set this). */
  skipAcquisitionWhenCold?: boolean;
}

/** Interactive default acquisition budget (ms) — env-overridable via
 *  PAPERCUSP_QUERY_EMBED_ACQUIRE_BUDGET_MS; ≤0 disables the bound. */
export function interactiveEmbedAcquireBudgetMs(): number {
  const v = Number(process.env.PAPERCUSP_QUERY_EMBED_ACQUIRE_BUDGET_MS);
  return Number.isFinite(v) && v > 0 ? v : 4000;
}

/** Race an acquisition against a time budget → resolve `null` on timeout. The
 *  losing acquisition is NOT cancelled (no cancel seam on the cascade); it runs
 *  on to warm the process-memoized pipeline for a later query, and its late
 *  settle is swallowed so it never surfaces as an unhandled rejection.
 *  Exported for unit test (embedder.test.ts) — internal otherwise. */
export async function withAcquireBudget<T>(p: Promise<T | null>, budgetMs: number): Promise<T | null> {
  if (!(budgetMs > 0)) return await p;
  return await new Promise<T | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (v: T | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(v);
    };
    timer = setTimeout(() => finish(null), budgetMs);
    p.then((v) => finish(v), () => finish(null));
  });
}

/** WI-4734: process-local QUERY-embed memo. The agents-pill search re-embeds
 *  the SAME query on every facet/recency-window re-query (each is a fresh
 *  server round-trip with an unchanged `q`), and repeat searches re-pay the
 *  full embed too — 40–150ms warm, seconds cold. Key includes mode+dims so a
 *  cascade flip (openai→local etc.) can never serve a foreign-space vector.
 *  In-flight promise is cached (dedupes concurrent identical queries);
 *  failures are evicted immediately so a transient embed error never sticks.
 *  NOTE: derived-data perf cache, not durable state — the storage-policy
 *  "no module-scoped TTL Maps" rule targets STATE; this is the same class as
 *  the process-memoized ONNX pipeline it sits in front of. */
const QUERY_EMBED_CACHE_MAX = 256;
const QUERY_EMBED_CACHE_TTL_MS = 10 * 60_000;
const queryEmbedCache = new Map<string, { at: number; p: Promise<number[]> }>();

/** Test seam: reset the query-embed memo between cases. */
export function _clearQueryEmbedCacheForTests(): void {
  queryEmbedCache.clear();
}

function cachedQueryEmbed(mode: string, dims: number, embed: Embedder): Embedder {
  const trim = (): void => {
    while (queryEmbedCache.size > QUERY_EMBED_CACHE_MAX) {
      const oldest = queryEmbedCache.keys().next().value;
      if (oldest === undefined) break;
      queryEmbedCache.delete(oldest);
    }
  };
  return (text: string, signal?: AbortSignal) => {
    const key = `${mode}:${dims}:${normalizeEmbeddingText(text)}`;
    const now = Date.now();
    const hit = queryEmbedCache.get(key);
    if (hit && now - hit.at < QUERY_EMBED_CACHE_TTL_MS) {
      // LRU bump: re-insert so iteration order tracks recency.
      queryEmbedCache.delete(key);
      queryEmbedCache.set(key, hit);
      return hit.p;
    }
    const p = embed(text, signal);
    if (signal) {
      // Never share an abortable in-flight promise: one short-budget caller
      // must not cancel work another caller still needs. Cache only the
      // completed deterministic vector, after its caller still owns it.
      return p.then((vector) => {
        const completed = Promise.resolve(vector);
        queryEmbedCache.set(key, { at: Date.now(), p: completed });
        trim();
        return vector;
      });
    }
    queryEmbedCache.set(key, { at: now, p });
    p.catch(() => {
      if (queryEmbedCache.get(key)?.p === p) queryEmbedCache.delete(key);
    }); // never cache a failure (without deleting a newer successful fill)
    trim();
    return p;
  };
}

/**
 * Embedder instance → the mode that built it (P-017).
 *
 * A cosine floor is only meaningful in the embedding space it was measured
 * in, so anything applying one must be able to tell "this is the embedder I
 * calibrated against" from "this is some other one". The mode used to be
 * available ONLY to callers that went through `buildQueryEmbedderResolved`
 * and kept the wrapper — `buildQueryEmbedder` throws it away, which is why
 * six of the eight search call sites could not floor even in principle.
 *
 * Binding it to the function instance fixes that centrally: every embedder
 * this module hands out carries its own provenance, so a policy can resolve
 * the right floor with no per-caller plumbing, and an UNRECOGNISED embedder
 * (a caller's own, from another space) simply misses — yielding no floor
 * rather than a threshold imported from a foreign space.
 *
 * ⚠ The registry itself lives in `search/embedder-mode-registry.ts`, NOT here.
 * The ranking policy has to READ it, and if it read it from this module it
 * would statically pull this whole resolution stack — which reaches
 * `memory/configure.ts` and its module-scope PG I/O — into every
 * `runHybridSearch` caller at import time. See that module's header for the
 * measurement. This module remains the only WRITER.
 */

/**
 * The mode of an embedder built by this module, or `undefined` for one it did
 * not build. Re-exported so existing importers keep working; the definition
 * (and the WeakMap) live in the leaf registry.
 */
export { embedderModeOf, embedderProfileIdOf } from '../../search/embedder-mode-registry';
import { stampEmbedderMode } from '../../search/embedder-mode-registry';

export async function buildQueryEmbedderResolved(
  opts?: QueryEmbedderAcquireOpts,
): Promise<ResolvedQueryEmbedder | null> {
  try {
    const acquire = resolveEmbedderWith({
      // P-015 harrier default flip: the QUERY side must keep ranking in the
      // gemma space where the vector(768) prose vectors live, not dims-guard
      // off — see proseSurfacePreference (memory/configure.ts).
      readPreference: async () => proseSurfacePreference(await readEmbedderPreference()),
      resolveKey: resolveOpenAiKey,
      localInstalled: localAvailable,
      isOpenAiRecentlyExhausted: isOpenAiEmbedInCooldown,
      buildOpenAi: buildAdmissionGovernedOpenAiEmbedder,
      // Sidecar-first local legs (P-004): shared warm model when the host
      // runs the embed sidecar, bit-identical in-process fallback otherwise.
      buildLocal: () => buildSidecarAwareEmbedder('local', 'query'),
      // This is the QUERY embedder, so EmbeddingGemma gets the query prompt
      // (its dual-encoder is trained so query-prompt vectors match the
      // document-prompt vectors written on the storage side).
      buildGemma: () => buildSidecarAwareEmbedder('gemma', 'query'),
      // harrier-oss (P-014, selectable only): queries carry the instruct
      // prefix; documents embed raw. Native 1024 — a vector(768) surface
      // must check `dims` before ranking against it.
      buildHarrier: () => buildSidecarAwareEmbedder('harrier', 'query'),
    });
    if (opts?.skipAcquisitionWhenCold && isOpenAiEmbedInCooldown() && !isLocalEmbedAcquisitionCheap()) {
      // Never surfaces as an unhandled rejection; it exists purely to warm the
      // process-memoized pipeline for a LATER query (same contract as the
      // orphaned acquisition on a withAcquireBudget timeout, below).
      acquire.catch(() => {});
      return null;
    }
    const resolved = await withAcquireBudget(acquire, opts?.acquireBudgetMs ?? 0);
    if (resolved === null || resolved.mode === 'disabled') return null;
    // WI-4734: memoized per (mode, dims, query) — see queryEmbedCache above.
    const embed = cachedQueryEmbed(resolved.profile.profileId, resolved.dims, resolved.embed);
    // P-017: stamp the space onto the instance every caller will actually hold,
    // so the floor policy can recognise it without any caller passing a mode.
    stampEmbedderMode(embed, resolved.mode, resolved.profile.profileId);
    return { mode: resolved.mode, dims: resolved.dims, profile: resolved.profile, embed };
  } catch (err) {
    // Mirrors the prior local-mode behavior: a pipeline load failure (package missing,
    // model fetch failed, …) degrades to BM25-only rather than throwing.
    //
    // ⚠ This catch is deliberately broad, so it also swallows PROGRAMMING errors —
    // and a swallowed one disables semantic search for the whole process while every
    // caller reports a normal "no embedder available" degrade. That is exactly what
    // happened on 2026-08-04: a refactor moved the embedder-mode WeakMap out to
    // `search/embedder-mode-registry.ts` and deleted the local binding while leaving
    // the `embedderModes.set(...)` call behind, so EVERY build threw ReferenceError
    // here and `search:semantic` silently fell back to BM25-only with no signal at
    // all (it surfaced only as 8 red tests on the green gate, hours later).
    // Log it so the next such swallow is visible in the operator log at the moment
    // it happens. Control flow is unchanged — the degrade is still the behavior.
    console.warn(
      `[query-embedder] embedder acquisition failed — degrading to BM25-only: ${(err as Error)?.message ?? String(err)}`,
    );
    return null;
  }
}

export async function buildQueryEmbedder(opts?: QueryEmbedderAcquireOpts): Promise<Embedder | null> {
  const resolved = await buildQueryEmbedderResolved(opts);
  return resolved ? resolved.embed : null;
}
