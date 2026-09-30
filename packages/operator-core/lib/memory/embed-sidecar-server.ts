/**
 * Shared local embedding sidecar — HTTP server (P-002, plan
 * shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * ONE warm model per host instead of one per process: every operator process
 * that embeds locally (memories, backfill, agent-tools search) pays its own
 * model warm-load + worker thread today; this sidecar owns the warm pipeline
 * once and serves loopback HTTP per the plan's D-004 wire:
 *
 *   POST /embed   { model?, kind: 'query'|'document', texts: string[] }
 *              →  { vectors: number[][], dims, runtime, modelRev }
 *   POST /rerank  { model?, query: string, texts: string[] }
 *              →  { scores: number[], runtime, modelRev }
 *   GET  /healthz →  { ok, pid, uptimeMs, capabilities: string[],
 *                      models: { '<model>:<kind>': state },
 *                      rerankExecution: { device, dtype, why },
 *                      embedExecution: { device, dtype, verified, why },
 *                      embedExecutionHealth: { requested, active, pipelines,
 *                                              demotion, nvidiaDriverPresent,
 *                                              providerLibraries, gpuProviderAvailable,
 *                                              defaultBundledBackends, probe,
 *                                              sessionOptions },
 *                      workers: { embedder: state, reranker: state } }
 *
 * `capabilities` lists every route THIS BUILD serves ("POST /rerank", ...),
 * derived from the route table itself. A sidecar outlives the code that talks
 * to it, so a client must be able to ask what it can do BEFORE using it —
 * without that, a route added after the running bundle was built just 404s
 * forever and every caller's fail-safe silently swallows it
 * (EI-19314150478401738).
 *
 * /rerank serves cross-encoder rerankers for the same reason: one warm ~150M
 * model per host, not per process. It returns scores INDEX-ALIGNED with the
 * request's texts and never reorders — ordering, topN and thresholds stay in
 * @papercusp/rerank on the client, so ranking policy lives in one place.
 *
 * The SERVER owns the space-defining knobs (D-002): task prompts, MRL
 * truncation and ORT thread caps all live in the wrapped @papercusp/memory
 * builders (`buildGemmaEmbedder` / `buildLocalEmbedder`, WI-3792 caps included),
 * so sidecar vectors are BIT-IDENTICAL to in-process vectors — same model,
 * same runtime, same quantization ⇒ same embedding space, no re-embed on
 * adoption. Callers pass `kind`, never prompt text.
 *
 * Plain `node:http`, NOT hono: operator-core deliberately does not own hono
 * (endpoint-route: "the host owns Hono ... the package must not"), and the
 * spawner/substrate sidecar servers set the node-primitives precedent. Two
 * fixed routes don't need a router.
 *
 * It lives in operator-core (NOT the bin) so the SAME code starts two ways
 * without the esbuild trap an auto-running bin guard would spring (see
 * spawner-sidecar-server.ts):
 *   - DEV     : apps/operator/bin/embed-sidecar.ts (run via tsx) calls it.
 *   - PACKAGED: serve.ts / hono-host.ts divert under PAPERCUSP_EMBED_SIDECAR_MODE=1.
 *
 * No top-level side effects: importing this module never starts a server;
 * only runEmbedSidecarServer() does. Reached ONLY on hosts that opt in via
 * PAPERCUSP_EMBED_SIDECAR=1 (embed-sidecar-spawn.ts) or that run the bin
 * directly. Binds 127.0.0.1 ONLY — vectors of private text cross this wire.
 *
 * Availability contract (v2, WI-4021 — D-003 retired): hosts with a configured
 * sidecar REQUIRE it. The @papercusp/memory client seam (sidecar-embedder.ts)
 * retries briefly and then throws when this server is down — no in-process
 * failover. That makes THIS process's supervision the availability story:
 * run it under the papercup-embed-sidecar systemd unit (Restart=always,
 * resource limits, boot-warm via EMBED_SIDECAR_WARM_ENV), never ad-hoc.
 * Memory writes during an outage park in the write-ahead journal and
 * auto-recover (memory-write-journal-auto-recovery-2026-07-11).
 */
import * as http from 'node:http';
import {
  buildGemmaEmbedder,
  buildHarrierEmbedder,
  buildLocalEmbedder,
  GEMMA_MODEL,
  HARRIER_MODEL,
  LOCAL_EMBEDDER_MODEL,
  SIDECAR_MAX_TEXT_CHARS,
  normalizeEmbeddingText,
  embedExecutionHealth,
  embedExecutionTarget,
  ensureEmbedBackendsProbed,
  getWorkerState as getEmbedderWorkerState,
  shutdownLocalEmbedder,
  type GemmaEmbedKind,
} from '@papercusp/memory';
import {
  FAST_RERANKER_MODEL,
  LOCAL_RERANKER_MODEL,
  activeExecutionTarget,
  getRerankWorkerState,
  loadCrossEncoder,
  rerankExecutionHealth,
  scoreCrossEncoder,
  shutdownLocalReranker,
} from '@papercusp/rerank';
import {
  admissionContextFromEnvironment,
  runGovernedOperation,
  type GovernedOperationInput,
} from '../resource-governor/execution';
import type { AdmissionContext, ResourceDemand } from '../resource-governor/admission';
import { activeWorkspaceId } from '../workspace-registry';
import { loadEmbedDeviceSetting, type EmbedDeviceSettingLoad } from './embed-device-setting';

export const EMBED_SIDECAR_DEFAULT_PORT = 3384; // mnemonic: the 384-dim space it serves
export const EMBED_SIDECAR_PORT_ENV = 'PAPERCUSP_EMBED_SIDECAR_PORT';
/** Optional production FIFO window; the systemd sidecar config sets this to 6. */
export const EMBED_SIDECAR_CONCURRENCY_ENV = 'PAPERCUSP_EMBED_SIDECAR_CONCURRENCY';
/** Comma-separated models to warm at boot (e.g. "gemma,harrier,rerank");
 *  default gemma, and no reranker.
 *  A host whose live embedder mode is harrier should warm it here too — under
 *  Restart=always supervision every restart otherwise lazy-loads the model on
 *  the first real request, which is what turns a clean restart into a visible
 *  first-embed timeout (WI-4021). The same argument applies to a reranker on a
 *  host that serves search, which is why this one env carries both (see
 *  resolveWarmModels / resolveWarmRerankers). */
export const EMBED_SIDECAR_WARM_ENV = 'PAPERCUSP_EMBED_SIDECAR_WARM';
/** Printed to stdout once listening — the spawn-side handshake line. */
export const EMBED_SIDECAR_READY_LINE = 'PAPERCUSP_EMBED_SIDECAR_READY';

/** Batch/size guards: a runaway caller must not OOM the shared sidecar. */
export const MAX_TEXTS_PER_CALL = 256;
/** Single source of truth is the CLIENT (@papercusp/memory sidecar-embedder,
 *  EI-14101): the client truncates every text to this cap before it is ever
 *  sent, so this server-side check should only ever fire for a caller that
 *  bypasses the shared client seam — kept as defense in depth, not the
 *  primary enforcement point. */
export const MAX_TEXT_CHARS = SIDECAR_MAX_TEXT_CHARS;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** WI-4196: default cap for the text→vector LRU. A 1024-dim vector is ~8KB of
 *  JS numbers, so the default cap bounds the cache near ~8MB. */
export const EMBED_CACHE_MAX_DEFAULT = 1024;
/** Bounded durable-admission priorities. Query/rerank work is interactive;
 * document indexing and boot warm-up are background and must not starve it. */
export const EMBED_SIDECAR_INTERACTIVE_PRIORITY = 100;
export const EMBED_SIDECAR_BACKGROUND_PRIORITY = 0;
/** Serve at most this many queued interactive units while background work is
 * waiting. This bounds priority in both directions: fleet bursts cannot block
 * a live query, and a sustained live-query stream cannot starve recovery. */
export const EMBED_SIDECAR_PRIORITY_BURST_MAX = 4;

type EmbedFn = (text: string, signal?: AbortSignal) => Promise<number[]>;

/** Models this sidecar serves. 'gemma' and 'harrier' are asymmetric (kind
 *  selects the task prompt — harrier prefixes queries only, docs are raw);
 *  'local' (BGE-small) is symmetric — kind is accepted and ignored. */
export const EMBED_SIDECAR_MODELS = ['gemma', 'local', 'harrier'] as const;
export type EmbedSidecarModel = (typeof EMBED_SIDECAR_MODELS)[number];

export interface EmbedRequest {
  model: EmbedSidecarModel;
  kind: GemmaEmbedKind;
  texts: string[];
  /** EI-19323982006772080: serve every text from the model — no LRU read, no
   *  LRU write, no coalescing onto an in-flight identical text. For throughput
   *  probes, which otherwise have to nonce-suffix their inputs to defeat the
   *  cache and silently measure it whenever they forget. Do not trust the flag
   *  alone: `cache.inferred` in the response reports what actually happened. */
  bypassCache?: boolean;
}

/**
 * EI-19323982006772080: what population THIS response was computed over.
 *
 * The sidecar keeps a 1024-entry LRU keyed on the embed input, so a benchmark
 * that holds its texts constant across runs — the natural way to write one —
 * measures cache hits rather than inference. Measured 2026-08-02: the same
 * probe read 1ms/doc on repeated texts and 353ms/doc on unique ones, a ~350x
 * error in the OPTIMISTIC direction, with nothing in the response to say which
 * you got. The process-global counters on /healthz cannot answer it either:
 * they are cumulative across every caller, so they cannot attribute a hit to
 * the request that took it.
 *
 * The three counts PARTITION the request: `hits + coalesced + inferred` always
 * equals `texts.length`. That is what makes them an accounting rather than
 * three loose gauges — a caller can tell "nothing was cached" from "I did not
 * ask about the cache", which is the distinction the silent version destroyed.
 */
export interface EmbedCacheAccounting {
  /** Texts served from the LRU. No inference ran for these. */
  hits: number;
  /** Texts that joined an already-in-flight identical text. Not an LRU hit —
   *  the request self-deduplicated — but no ADDITIONAL inference ran either. */
  coalesced: number;
  /** Texts that actually reached the model during THIS request. The only
   *  count a throughput measurement may be divided by. */
  inferred: number;
}

export interface EmbedResponse {
  vectors: number[][];
  dims: number;
  runtime: string;
  modelRev: string;
  /** Per-request cache accounting — see {@link EmbedCacheAccounting}. Ask
   *  {@link embedResponseMeasuredModel} rather than reading it by hand. */
  cache: EmbedCacheAccounting;
}

/**
 * Did this response measure the MODEL, or the cache in front of it?
 *
 * The one place that question is answered, so a probe never re-derives it and
 * two probes cannot disagree. It refuses in the direction that costs nothing:
 *
 * - A response from a sidecar too old to report `cache` at all is
 *   **undecidable**, never ok. Rig hosts run installed sidecar bundles with no
 *   update path (EI-19330215508907244), so "the field is missing" is a live
 *   case, and a caller hand-writing `!body.cache?.hits` would read that absent
 *   field as a clean pass — the exact false green this item exists to kill.
 * - `inferred` is checked POSITIVELY against the text count rather than
 *   `hits === 0` being checked negatively, so a malformed or partial body
 *   fails instead of passing by omission.
 */
export type EmbedMeasuredVerdict =
  | { ok: true }
  | {
      ok: false;
      /**
       * WHY it is not a model measurement, as a discriminant, so a caller
       * branching on the two very different failures — "the response says it
       * came from the cache" versus "the response cannot say" — never has to
       * regex `reason` or re-parse `cache` itself. Re-parsing is how two
       * probes come to disagree, which is the thing this helper exists to
       * prevent.
       *
       * `'served-from-cache'` is the only code that positively establishes the
       * model was NOT run. Every other code means UNDECIDABLE: the response is
       * silent, malformed, or self-inconsistent, and the honest report is "not
       * proven", never "did not happen".
       */
      code: 'no-accounting' | 'malformed' | 'not-a-partition' | 'served-from-cache';
      reason: string;
    };

export function embedResponseMeasuredModel(
  body: Pick<EmbedResponse, 'cache'> | Record<string, unknown>,
  textCount: number,
): EmbedMeasuredVerdict {
  const cache = (body as { cache?: unknown }).cache;
  if (cache === undefined || cache === null) {
    return {
      ok: false,
      code: 'no-accounting',
      reason:
        'response carries no `cache` accounting — this sidecar predates EI-19323982006772080, so whether it served the model or its LRU is UNKNOWN. Do not report a throughput number from it.',
    };
  }
  const c = cache as Partial<EmbedCacheAccounting>;
  const nums = [c.hits, c.coalesced, c.inferred];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return { ok: false, code: 'malformed', reason: `malformed cache accounting: ${JSON.stringify(cache)}` };
  }
  const hits = c.hits as number;
  const coalesced = c.coalesced as number;
  const inferred = c.inferred as number;
  if (hits + coalesced + inferred !== textCount) {
    return {
      ok: false,
      code: 'not-a-partition',
      reason: `cache accounting does not partition the request: hits ${hits} + coalesced ${coalesced} + inferred ${inferred} != ${textCount} texts`,
    };
  }
  if (inferred !== textCount) {
    return {
      ok: false,
      code: 'served-from-cache',
      reason: `only ${inferred} of ${textCount} texts reached the model (${hits} served from the LRU, ${coalesced} coalesced onto an in-flight duplicate) — a throughput figure computed from this response measures the cache, not the model. Send unique texts, or set bypassCache:true.`,
    };
  }
  return { ok: true };
}

/** transformers.js ONNX in a worker thread — the space-defining runtime tag. */
export const EMBED_SIDECAR_RUNTIME = 'node-onnx-worker';

/**
 * Capability names — one per route, in the `"<METHOD> <path>"` shape /healthz
 * advertises. Exported so CLIENTS state what they need symbolically instead of
 * duplicating a wire string (EI-19314150478401738).
 */
export const EMBED_SIDECAR_CAP_HEALTHZ = 'GET /healthz';
export const EMBED_SIDECAR_CAP_EMBED = 'POST /embed';
export const EMBED_SIDECAR_CAP_RERANK = 'POST /rerank';
/**
 * Re-read the Settings embedding-device choice and apply it to this process
 * (plan memory-reduction-2026-09-24 D-008). The save route calls it right after
 * writing the row, so a change reaches the shared sidecar without a restart.
 * A client that gets 404 is talking to an older build: restart the sidecar.
 */
export const EMBED_SIDECAR_CAP_DEVICE_RELOAD = 'POST /embed-device/reload';
/** Bound on re-warming the boot-warm embedders after a device change. */
export const EMBED_DEVICE_REWARM_TIMEOUT_MS = 45_000;

/**
 * Resolve the optional production scheduler window.
 *
 * The explicit `concurrency` option remains a PG-free local scheduler seam for
 * deterministic tests. The environment setting is the production equivalent:
 * it enables the same bounded FIFO while retaining durable governor admission
 * for every unit that actually starts.
 */
export function resolveEmbedSidecarConcurrency(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[EMBED_SIDECAR_CONCURRENCY_ENV]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.max(1, Math.floor(parsed));
}

/**
 * What a sidecar that advertises NOTHING may be assumed to serve.
 *
 * A sidecar is a long-running process started from a BUILT BUNDLE, so one that
 * predates capability advertisement (any build before EI-19314150478401738)
 * answers /healthz 200 with no `capabilities` key at all. Refusing those
 * outright would break embedding on every host still running one — so instead
 * they are credited with exactly the routes that have existed since the
 * original D-004 wire, and nothing more.
 *
 * ⛔ NEVER ADD TO THIS LIST. It is a statement about HISTORY (what every build
 * that could ever be running already served), not a default capability set.
 * Adding a newer route here would re-create the exact silent-404 bug: an old
 * sidecar would be credited with a route it does not have.
 */
export const EMBED_SIDECAR_LEGACY_CAPABILITIES: readonly string[] = [
  EMBED_SIDECAR_CAP_HEALTHZ,
  EMBED_SIDECAR_CAP_EMBED,
];

const MODEL_REVS: Record<EmbedSidecarModel, string> = {
  gemma: GEMMA_MODEL,
  local: LOCAL_EMBEDDER_MODEL,
  harrier: HARRIER_MODEL,
};

/**
 * Cross-encoder rerankers this sidecar serves, for the SAME reason it serves
 * embedders: one warm model per host instead of one per process. A reranker is
 * ~150M params and seconds to load, so a per-process copy is exactly the cost
 * this sidecar exists to remove.
 *
 * 'rerank' is the quality tier; 'rerank-fast' is ~7.5x cheaper per pair at a
 * real quality cost (measured — see the plan's D-001).
 */
export const RERANK_SIDECAR_MODELS = ['rerank', 'rerank-fast'] as const;
export type RerankSidecarModel = (typeof RERANK_SIDECAR_MODELS)[number];

const RERANK_MODEL_REVS: Record<RerankSidecarModel, string> = {
  rerank: LOCAL_RERANKER_MODEL,
  'rerank-fast': FAST_RERANKER_MODEL,
};

export interface RerankRequest {
  model: RerankSidecarModel;
  query: string;
  texts: string[];
}

export interface RerankResponse {
  /** Relevance scores index-aligned with the request's `texts`. */
  scores: number[];
  runtime: string;
  modelRev: string;
}

/**
 * Pure request validation for /rerank (unit-tested without a server).
 *
 * Note the asymmetry with /embed: a reranker scores a (query, text) PAIR, so
 * `query` is required and `kind` is meaningless here.
 */
export function validateRerankRequest(body: unknown): RerankRequest | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as { model?: unknown; query?: unknown; texts?: unknown };
  const model = b.model === undefined ? 'rerank' : b.model;
  if (!RERANK_SIDECAR_MODELS.includes(model as RerankSidecarModel)) {
    return { error: `unknown model '${String(model)}' — expected one of: ${RERANK_SIDECAR_MODELS.join(', ')}` };
  }
  if (typeof b.query !== 'string' || b.query.trim() === '') {
    return { error: 'query must be a non-empty string' };
  }
  if (b.query.length > MAX_TEXT_CHARS) {
    return { error: `query exceeds ${MAX_TEXT_CHARS} chars (got ${b.query.length}) — truncate before reranking` };
  }
  if (!Array.isArray(b.texts) || b.texts.length === 0) {
    return { error: 'texts must be a non-empty array of strings' };
  }
  if (b.texts.length > MAX_TEXTS_PER_CALL) {
    return { error: `texts exceeds the ${MAX_TEXTS_PER_CALL}-per-call cap (got ${b.texts.length}) — split the batch` };
  }
  for (let i = 0; i < b.texts.length; i++) {
    const t = b.texts[i];
    if (typeof t !== 'string') return { error: `texts[${i}] is not a string` };
    if (t.length > MAX_TEXT_CHARS) {
      return { error: `texts[${i}] exceeds ${MAX_TEXT_CHARS} chars (got ${t.length}) — truncate before reranking` };
    }
  }
  return { model: model as RerankSidecarModel, query: b.query, texts: b.texts as string[] };
}

/**
 * Pure request validation (unit-tested without a server). Returns the parsed
 * request or an error string suitable for a 400 body.
 */
export function validateEmbedRequest(body: unknown): EmbedRequest | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as { model?: unknown; kind?: unknown; texts?: unknown; bypassCache?: unknown };
  const model = b.model === undefined ? 'gemma' : b.model;
  if (!EMBED_SIDECAR_MODELS.includes(model as EmbedSidecarModel)) {
    return { error: `unknown model '${String(model)}' — expected one of: ${EMBED_SIDECAR_MODELS.join(', ')}` };
  }
  if (b.kind !== 'query' && b.kind !== 'document') {
    return { error: `kind must be 'query' or 'document' (got '${String(b.kind)}')` };
  }
  if (!Array.isArray(b.texts) || b.texts.length === 0) {
    return { error: 'texts must be a non-empty array of strings' };
  }
  if (b.texts.length > MAX_TEXTS_PER_CALL) {
    return { error: `texts exceeds the ${MAX_TEXTS_PER_CALL}-per-call cap (got ${b.texts.length}) — split the batch` };
  }
  for (let i = 0; i < b.texts.length; i++) {
    const t = b.texts[i];
    if (typeof t !== 'string') return { error: `texts[${i}] is not a string` };
    if (t.length > MAX_TEXT_CHARS) {
      return { error: `texts[${i}] exceeds ${MAX_TEXT_CHARS} chars (got ${t.length}) — truncate before embedding` };
    }
  }
  if (b.bypassCache !== undefined && typeof b.bypassCache !== 'boolean') {
    return { error: `bypassCache must be a boolean (got '${String(b.bypassCache)}')` };
  }
  return {
    model: model as EmbedSidecarModel,
    kind: b.kind,
    texts: b.texts as string[],
    bypassCache: b.bypassCache === true,
  };
}

type WarmState = 'cold' | 'warming' | 'warm' | 'failed';

const warmTokens = (env: NodeJS.ProcessEnv): string[] =>
  (env[EMBED_SIDECAR_WARM_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/**
 * The boot-warm EMBEDDER set: EMBED_SIDECAR_WARM_ENV comma-list filtered to
 * known embedders (unknown names dropped), deduped; empty/unset ⇒ ['gemma'].
 *
 * The env now also carries reranker ids (see resolveWarmRerankers), so "no
 * embedder named" no longer implies "the host forgot to configure this". A list
 * naming ONLY rerankers warms no embedder rather than silently loading gemma —
 * warming a ~300MB model the host did not ask for is the surprise to avoid. The
 * gemma default survives for the genuinely unconfigured cases: unset, blank, or
 * nothing recognized at all.
 */
export function resolveWarmModels(env: NodeJS.ProcessEnv = process.env): EmbedSidecarModel[] {
  const tokens = warmTokens(env);
  if (tokens.length === 0) return ['gemma'];
  const embedders = [
    ...new Set(tokens.filter((s): s is EmbedSidecarModel => (EMBED_SIDECAR_MODELS as readonly string[]).includes(s))),
  ];
  if (embedders.length > 0) return embedders;
  const namedAReranker = tokens.some((s) => (RERANK_SIDECAR_MODELS as readonly string[]).includes(s));
  return namedAReranker ? [] : ['gemma'];
}

/** The boot-warm RERANKER set from the same env. Default: none — a host opts in,
 *  because a reranker is only useful to hosts that actually serve search. */
export function resolveWarmRerankers(env: NodeJS.ProcessEnv = process.env): RerankSidecarModel[] {
  return [
    ...new Set(
      warmTokens(env).filter((s): s is RerankSidecarModel =>
        (RERANK_SIDECAR_MODELS as readonly string[]).includes(s),
      ),
    ),
  ];
}

/** Builder seam — tests inject fakes so no unit test loads a real ONNX model. */
export type EmbedderBuilders = {
  [M in EmbedSidecarModel]: (kind: GemmaEmbedKind) => Promise<EmbedFn>;
};

const defaultBuilders: EmbedderBuilders = {
  gemma: (kind) => Promise.resolve(buildGemmaEmbedder({ kind })),
  // BGE is symmetric: one embedder serves both kinds (buildLocalEmbedder has
  // no kind knob), so both registry slots resolve to the same closure.
  local: () => buildLocalEmbedder(),
  // harrier-oss-0.6b @ native-1024 (P-014): pooling+normalize live in the
  // ONNX graph itself; kind picks the instruct-vs-raw prompt.
  harrier: (kind) => Promise.resolve(buildHarrierEmbedder({ kind })),
};

/** Reranker equivalent of EmbedderBuilders — tests inject fakes so no unit test
 *  loads a real cross-encoder. */
export type RerankFn = (query: string, texts: string[]) => Promise<number[]>;
export type RerankerBuilders = {
  [M in RerankSidecarModel]: () => Promise<RerankFn>;
};

const buildSidecarReranker = (model: string) => async (): Promise<RerankFn> => {
  // Load eagerly so the builder's promise resolving MEANS the model is warm —
  // that is what makes the warm-state registry and /healthz honest.
  await loadCrossEncoder({ model });
  // scoreCrossEncoder THROWS on failure, deliberately: this server must report
  // a 500 (and flip the slot to 'failed') rather than quietly serve neutral
  // scores. The lib's fail-safe passthrough belongs on the CLIENT side, where
  // there is a retrieval order to degrade to.
  return (query, texts) => scoreCrossEncoder(query, texts, { model });
};

const defaultRerankBuilders: RerankerBuilders = {
  rerank: buildSidecarReranker(LOCAL_RERANKER_MODEL),
  'rerank-fast': buildSidecarReranker(FAST_RERANKER_MODEL),
};

export interface EmbedSidecarOptions {
  port?: number;
  builders?: EmbedderBuilders;
  /** Reranker builder seam — tests inject fakes (see `builders`). */
  rerankBuilders?: RerankerBuilders;
  /** Skip the boot warm-up (tests). Production warms gemma at boot. */
  warmAtBoot?: boolean;
  log?: (line: string) => void;
  /** Max entries in the text→vector LRU (0 disables caching; tests). */
  cacheMax?: number;
  /**
   * Explicit local scheduler window for tests only. Production admission is
   * handled by the canonical durable governor. Supplying this seam overrides
   * the production environment window and keeps deterministic FIFO tests
   * independent of Postgres.
   */
  concurrency?: number;
  /** Workspace used by the production durable governor (tests may inject one). */
  workspaceId?: string;
  /** Canonical governor runner; injectable so server tests need no database. */
  governedOperation?: typeof runGovernedOperation;
  /**
   * Worker-breaker readers for /healthz (WI-37696). Defaults to the real module
   * getters; a test injects distinguishable ones.
   *
   * A seam rather than a direct call because the two real states are STRUCTURALLY
   * IDENTICAL and both read cold under injected fake builders — so with direct
   * calls, wiring `reranker` to the embedder's getter passes every assertion that
   * can be written (measured: that exact mutant survived the suite). The seam is
   * what makes the embedder→embedder mis-mapping, and a tripped latch reaching
   * the wire, testable at all.
   */
  workerStates?: WorkerStateReaders;
  /**
   * The Settings device-choice loader (D-008). Production reads the PG row via
   * `loadEmbedDeviceSetting`, which is bounded, never throws, and recycles the
   * embed worker itself when the effective device changes. Applied at boot
   * BEFORE the warm-up (only when `warmAtBoot` is on) and on every
   * `POST /embed-device/reload`. Tests inject one so no PG is needed.
   */
  embedDevice?: { load: () => Promise<EmbedDeviceSettingLoad> };
}

/** What `POST /embed-device/reload` answers. */
export interface EmbedDeviceReloadResponse {
  ok: true;
  setting: EmbedDeviceSettingLoad['setting'];
  changed: boolean;
  readError: string | null;
  /** Present only when the device changed: the boot-warm embedders were rebuilt. */
  rewarm: { models: Record<string, string>; timedOut: boolean } | null;
  embedExecution: ReturnType<typeof embedExecutionTarget>;
  embedExecutionHealth: ReturnType<typeof embedExecutionHealth>;
}

/** The two worker breakers this process owns; shape-compatible with both modules' getters. */
export interface WorkerBreakerState {
  alive: boolean;
  /** Latched permanently after repeated failure ⇒ inline fallback forever. The alert field. */
  disabled: boolean;
  pendingCount: number;
  keepAlive: boolean;
}

export interface WorkerStateReaders {
  embedder: () => WorkerBreakerState;
  reranker: () => WorkerBreakerState;
}

/**
 * The PRODUCTION wiring — what /healthz reports when nothing is injected.
 *
 * Exported so it can be pinned by identity: an injected-reader test proves the
 * mapping GIVEN readers and therefore cannot see a default pointed at the wrong
 * module, which is the copy-paste this pair invites (both getters are named
 * alike, take no arguments, and return the same shape).
 */
export const defaultWorkerStates: WorkerStateReaders = {
  embedder: getEmbedderWorkerState,
  reranker: getRerankWorkerState,
};

export interface EmbedSidecarHandle {
  server: http.Server;
  /** Resolves once listening (port bound). */
  listening: Promise<number>;
  close: () => Promise<void>;
  /** Per-`model:kind` warm state — surfaced verbatim by /healthz. */
  warmStates: () => Record<string, WarmState>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

class SidecarRequestAbortedError extends Error {
  constructor() {
    super('request_aborted');
    this.name = 'AbortError';
  }
}

interface RequestCancellation {
  signal: AbortSignal;
  dispose: () => void;
}

/** Tie sidecar work to the response lifetime, without aborting after a response
 * has been fully written. A client timeout closes the response before the
 * inference finishes; that is the signal used to remove queued work. */
function trackRequestCancellation(req: http.IncomingMessage, res: http.ServerResponse): RequestCancellation {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  const onRequestAborted = (): void => abort();
  const onRequestClose = (): void => {
    if (!req.complete) abort();
  };
  const onResponseClose = (): void => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', onRequestAborted);
  req.once('close', onRequestClose);
  res.once('close', onResponseClose);
  return {
    signal: controller.signal,
    dispose: () => {
      req.off('aborted', onRequestAborted);
      req.off('close', onRequestClose);
      res.off('close', onResponseClose);
    },
  };
}

function readBody(req: http.IncomingMessage, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = <T>(fn: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = (): void => finish(reject, new SidecarRequestAbortedError());
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        finish(reject, new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    };
    const onEnd = (): void => finish(resolve, Buffer.concat(chunks).toString('utf8'));
    const onError = (error: Error): void => finish(reject, error);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create (but do not process-wire) the sidecar server. `runEmbedSidecarServer`
 * adds signal handling + the READY handshake on top; tests drive this directly
 * on an ephemeral port with injected builders.
 */
export function createEmbedSidecarServer(opts: EmbedSidecarOptions = {}): EmbedSidecarHandle {
  const builders = opts.builders ?? defaultBuilders;
  const rerankBuilders = opts.rerankBuilders ?? defaultRerankBuilders;
  const log = opts.log ?? ((line: string) => console.log(line));
  const workerStates = opts.workerStates ?? defaultWorkerStates;
  const port = opts.port ?? Number(process.env[EMBED_SIDECAR_PORT_ENV] ?? EMBED_SIDECAR_DEFAULT_PORT);
  const startedAt = Date.now();

  // Resolve which ONNX execution providers this build actually bundles, once,
  // in the background. /healthz reads the cached answer synchronously and
  // reports `gpuBundled: null` until this lands, so the endpoint is honest
  // about not yet knowing rather than guessing. Fire-and-forget by design:
  // ensureEmbedBackendsProbed() records its own failures as probe:'failed' and
  // never rejects, so a broken probe degrades the report instead of the sidecar.
  void ensureEmbedBackendsProbed();

  // One embedder per model:kind, built lazily and memoized. A failed build is
  // NOT memoized — the next request retries (a transient (dl/disk) fault must
  // not brick the slot for the process lifetime).
  const embedders = new Map<string, Promise<EmbedFn>>();
  const warm: Record<string, WarmState> = {};
  const getEmbedder = (model: EmbedSidecarModel, kind: GemmaEmbedKind): Promise<EmbedFn> => {
    const key = `${model}:${kind}`;
    let p = embedders.get(key);
    if (!p) {
      warm[key] = 'warming';
      p = builders[model](kind).then(
        (fn) => {
          warm[key] = 'warm';
          return fn;
        },
        (err) => {
          warm[key] = 'failed';
          embedders.delete(key);
          throw err;
        },
      );
      embedders.set(key, p);
    }
    return p;
  };

  // Rerankers share the SAME warm-state registry (so /healthz reports one
  // picture of what this host has loaded) and the same don't-memoize-failures
  // rule, for the same reason: a transient download fault must not brick the
  // slot for the process lifetime.
  const rerankers = new Map<RerankSidecarModel, Promise<RerankFn>>();
  const getReranker = (model: RerankSidecarModel): Promise<RerankFn> => {
    let p = rerankers.get(model);
    if (!p) {
      warm[model] = 'warming';
      p = rerankBuilders[model]().then(
        (fn) => {
          warm[model] = 'warm';
          return fn;
        },
        (err) => {
          warm[model] = 'failed';
          rerankers.delete(model);
          throw err;
        },
      );
      rerankers.set(model, p);
    }
    return p;
  };

  // Bounded-concurrency FIFO (P-004 memory-public-release-hardening): work
  // units (one TEXT each — see WI-4196 below) START in arrival order when the
  // explicit `concurrency` seam is supplied, or when the production
  // PAPERCUSP_EMBED_SIDECAR_CONCURRENCY window is configured. The explicit
  // option remains a PG-free test seam; the environment window still routes
  // every started unit through the durable governor below. Rejections stay
  // per-caller; a failed unit frees its scheduler slot via finally.
  //
  // Fairness is per REQUEST, not merely per text. A handler can receive a
  // 256-text batch and enqueue all of its units synchronously; a flat FIFO
  // would put every one of those units ahead of a later one-text request.
  // Queue batches as round-robin lanes instead: each drain turn starts at most
  // one waiting unit from a request, then moves that request behind its peers.
  // Each request still gets its texts in input order, while a large batch
  // cannot monopolize the sidecar after its first unit has started.
  const localScheduler = opts.concurrency !== undefined;
  const configuredConcurrency = opts.concurrency ?? resolveEmbedSidecarConcurrency();
  const concurrency = configuredConcurrency === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(configuredConcurrency));
  const workspaceId = opts.workspaceId?.trim() || (localScheduler ? undefined : activeWorkspaceId());
  const governed = opts.governedOperation ?? runGovernedOperation;
  const parentAdmission = admissionContextFromEnvironment(process.env.PAPERCUSP_ADMISSION_CONTEXT);
  const operationOwner = `embed-sidecar:${process.pid}`;

  /**
   * One sidecar resource unit. Production calls enter the canonical durable
   * Governor with an attributable admission class and measured demand; tests
   * opt into the local FIFO by supplying `concurrency`, so no database is
   * needed for deterministic scheduler tests.
   */
  const runSidecarUnit = <T>(input: {
    admissionClass: 'embedding' | 'inference';
    operation: 'embed' | 'rerank' | 'warmup';
    model: string;
    kind?: GemmaEmbedKind;
    priority: number;
    textChars: number;
    demand: ResourceDemand;
    signal?: AbortSignal;
    run: (signal?: AbortSignal) => Promise<T>;
  }): Promise<T> => {
    if (localScheduler) return input.run(input.signal);
    const operationInput: GovernedOperationInput<T> = {
      workspaceId: workspaceId!,
      namespace: 'embed-sidecar',
      owner: operationOwner,
      admissionClass: input.admissionClass,
      priority: input.priority,
      demand: input.demand,
      payloadRef: `embed-sidecar:${input.operation}:${input.model}`,
      ...(parentAdmission ? { parent: parentAdmission } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      metadata: {
        operation: input.operation,
        model: input.model,
        ...(input.kind ? { kind: input.kind } : {}),
        textChars: input.textChars,
        unit: 'single-text',
      },
    };
    return governed(operationInput, () => input.run(input.signal));
  };
  let active = 0;
  interface QueueTask<T> {
    promise: Promise<T>;
    signal: AbortSignal;
    abort: (reason?: unknown) => void;
    cancel: () => boolean;
  }
  interface QueueEntry<T> {
    started: boolean;
    settled: boolean;
    start: () => void;
    cancel: () => boolean;
  }
  interface QueueBatch {
    entries: Array<QueueEntry<unknown>>;
    queued: boolean;
    running: number;
    priority: number;
  }
  const waiting: QueueBatch[] = [];
  let queued = 0;
  let consecutivePriorityStarts = 0;
  const createQueueBatch = (priority = EMBED_SIDECAR_BACKGROUND_PRIORITY): QueueBatch => ({
    entries: [],
    queued: false,
    running: 0,
    priority,
  });
  const queueBatch = (batch: QueueBatch): void => {
    if (batch.entries.length === 0 || batch.queued) return;
    batch.queued = true;
    waiting.push(batch);
  };
  const startNext = (batch: QueueBatch): boolean => {
    const next = batch.entries.shift();
    if (!next) return false;
    queued--;
    next.start();
    return true;
  };
  const takeWaitingBatch = (): QueueBatch | undefined => {
    if (waiting.length === 0) return undefined;
    let bestIndex = 0;
    for (let i = 1; i < waiting.length; i++) {
      if (waiting[i].priority > waiting[bestIndex].priority) bestIndex = i;
    }
    const bestPriority = waiting[bestIndex].priority;
    const lowerIndex = waiting.findIndex((batch) => batch.priority < bestPriority);
    const selectedIndex =
      lowerIndex >= 0 && consecutivePriorityStarts >= EMBED_SIDECAR_PRIORITY_BURST_MAX
        ? lowerIndex
        : bestIndex;
    const selected = waiting.splice(selectedIndex, 1)[0];
    if (lowerIndex >= 0 && selectedIndex === bestIndex) consecutivePriorityStarts++;
    else consecutivePriorityStarts = 0;
    return selected;
  };
  function drainQueue(): void {
    while (active < concurrency && waiting.length > 0) {
      const batch = takeWaitingBatch()!;
      batch.queued = false;
      startNext(batch);
    }
  }
  // A client disconnect is delivered by the HTTP event loop, while a completed
  // inference releases its slot in a promise microtask. Yield before starting
  // the next waiter so a response-close cancellation can remove abandoned
  // queued work before it consumes a newly available slot.
  const scheduleDrain = (): void => {
    setTimeout(drainQueue, 5);
  };
  const enqueue = <T>(
    work: (signal: AbortSignal) => Promise<T>,
    batch: QueueBatch = createQueueBatch(),
  ): QueueTask<T> => {
    let resolveTask!: (value: T | PromiseLike<T>) => void;
    let rejectTask!: (reason?: unknown) => void;
    const controller = new AbortController();
    const promise = new Promise<T>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const entry: QueueEntry<T> = {
      started: false,
      settled: false,
      start: () => {
        if (entry.started || entry.settled) return;
        entry.started = true;
        active++;
        batch.running++;
        Promise.resolve()
          .then(() => work(controller.signal))
          .then(resolveTask, rejectTask)
          .finally(() => {
            active--;
            batch.running--;
            queueBatch(batch);
            scheduleDrain();
          });
      },
      cancel: () => {
        if (entry.started || entry.settled) return false;
        const index = batch.entries.indexOf(entry as QueueEntry<unknown>);
        if (index < 0) return false;
        batch.entries.splice(index, 1);
        queued--;
        entry.settled = true;
        rejectTask(new SidecarRequestAbortedError());
        return true;
      },
    };
    batch.entries.push(entry as QueueEntry<unknown>);
    queued++;
    // Start immediately only when no peer lane is already waiting. If this
    // batch is already running, its next unit can use another free slot; if a
    // peer is waiting, let the round-robin drain choose the next lane.
    if (active < concurrency && waiting.length === 0 && !batch.queued) {
      startNext(batch);
    } else {
      if (batch.running === 0) queueBatch(batch);
      drainQueue();
    }
    return {
      promise,
      signal: controller.signal,
      abort: (reason?: unknown): void => {
        if (!controller.signal.aborted) controller.abort(reason);
      },
      cancel: entry.cancel,
    };
  };

  // WI-4196: per-text coalescing + bounded LRU over the text→vector mapping.
  // mem0's per-scope fan-out embeds the SAME query text once per pool, and each
  // of those requests would pay a full serial inference (~2.5s) through the
  // FIFO above — enough to blow memory:search's budget on its own. A vector is
  // deterministic for a fixed model rev + kind + text, so joining concurrent
  // identical texts into ONE inference and caching results is semantically
  // free. The FIFO's unit of work becomes one TEXT (not a whole request
  // batch), which also delivers the fairness the FIFO exists for — a small
  // request no longer waits out a peer's giant batch.
  const cacheMax = opts.cacheMax ?? EMBED_CACHE_MAX_DEFAULT;
  const vecCache = new Map<string, number[]>(); // Map insertion order as LRU
  const inflight = new Map<string, { task: QueueTask<number[]>; consumers: number }>();
  let cacheHits = 0;
  let cacheMisses = 0;
  const cacheGet = (key: string): number[] | undefined => {
    const hit = vecCache.get(key);
    if (hit) {
      vecCache.delete(key);
      vecCache.set(key, hit); // refresh recency
    }
    return hit;
  };
  const cachePut = (key: string, vec: number[]): void => {
    if (cacheMax <= 0) return;
    vecCache.delete(key);
    vecCache.set(key, vec);
    while (vecCache.size > cacheMax) {
      const oldest = vecCache.keys().next().value;
      if (oldest === undefined) break;
      vecCache.delete(oldest);
    }
  };
  /** Cache + coalesce + enqueue one unit of ONNX work under `key`. Shared by
   *  /embed and /rerank so both get the same fairness and memory bounds, and
   *  neither can starve the other (one FIFO, not two competing ones). */
  const computeCached = (
    key: string,
    work: (signal: AbortSignal) => Promise<number[]>,
    signal: AbortSignal,
    batch: QueueBatch,
    // EI-19323982006772080: the per-request half of the accounting. The global
    // counters below feed /healthz and are cumulative across every caller, so
    // they can say the process has taken hits but never that THIS request did.
    // Both are incremented at the same three sites so the per-request view and
    // the process view cannot drift apart.
    tally?: EmbedCacheAccounting,
    bypassCache = false,
  ): Promise<number[]> => {
    if (signal.aborted) return Promise.reject(new SidecarRequestAbortedError());
    if (!bypassCache) {
      const cached = cacheGet(key);
      if (cached) {
        cacheHits++;
        if (tally) tally.hits++;
        return Promise.resolve(cached);
      }
    }
    // A bypassing request must not JOIN an in-flight duplicate either: the
    // point is to make every text pay real inference, and coalescing would
    // silently serve N texts from one forward pass — the same optimistic
    // reading, one layer down from the LRU.
    let entry = bypassCache ? undefined : inflight.get(key);
    if (entry) {
      cacheHits++;
      if (tally) tally.coalesced++;
    } else {
      cacheMisses++;
      if (tally) tally.inferred++;
      entry = { task: enqueue(work, batch), consumers: 0 };
      // Registering a bypassing unit would let a LATER ordinary request
      // coalesce onto it, and caching its result would poison the LRU the
      // caller asked to be left alone. It runs unshared, start to finish.
      if (!bypassCache) {
        inflight.set(key, entry);
        const owned = entry;
        void owned.task.promise
          .then(
            (value) => {
              if (owned.consumers > 0) cachePut(key, value);
            },
            () => {},
          )
          .finally(() => {
            if (inflight.get(key) === owned) inflight.delete(key);
          });
      }
    }
    const owned = entry;
    owned.consumers++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      owned.consumers--;
      if (owned.consumers === 0) {
        owned.task.abort(new SidecarRequestAbortedError());
        owned.task.cancel();
        // A started task may continue briefly when its model/worker ignores
        // AbortSignal. Do not let a later caller join that already-aborted
        // task; it needs a fresh durable admission instead.
        if (inflight.get(key) === owned) {
          inflight.delete(key);
        }
      }
    };
    return new Promise<number[]>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort);
        release();
        reject(new SidecarRequestAbortedError());
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      owned.task.promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          release();
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          release();
          reject(error);
        },
      );
    });
  };

  const embedOneCached = (
    model: EmbedSidecarModel,
    kind: GemmaEmbedKind,
    text: string,
    signal: AbortSignal,
    batch: QueueBatch,
    tally?: EmbedCacheAccounting,
    bypassCache = false,
  ): Promise<number[]> =>
    computeCached(
      `${model}:${kind}\0${normalizeEmbeddingText(text)}`,
      (taskSignal) =>
        runSidecarUnit({
          admissionClass: 'embedding',
          operation: 'embed',
          model,
          kind,
          priority:
            kind === 'query' ? EMBED_SIDECAR_INTERACTIVE_PRIORITY : EMBED_SIDECAR_BACKGROUND_PRIORITY,
          textChars: text.length,
          demand: {
            cpuWeight: 1,
            memoryBytes: Buffer.byteLength(text, 'utf8'),
          },
          signal: taskSignal,
          run: async (runSignal) => {
            const embed = await getEmbedder(model, kind);
            return embed(text, runSignal);
          },
        }),
      signal,
      batch,
      tally,
      bypassCache,
    );

  // One PAIR per unit, matching /embed's one-text-per-unit choice. A cross-
  // encoder could score a whole batch in one forward pass, but per-pair units
  // buy the same three properties the embed path documents — FIFO fairness (a
  // small rerank does not wait out a peer's 100-doc batch), coalescing of
  // concurrent identical pairs, and an LRU hit on repeat queries — and D-001
  // measured per-pair cost as flat in batch size, so batching would trade those
  // away for nothing. The score is boxed as a 1-element array to reuse the
  // vector cache; the model is in the key, so the namespaces cannot collide.
  const rerankOneCached = (
    model: RerankSidecarModel,
    query: string,
    text: string,
    signal: AbortSignal,
    batch: QueueBatch,
  ): Promise<number> =>
    computeCached(
      `${model}\0${normalizeEmbeddingText(query)}\0${normalizeEmbeddingText(text)}`,
      (taskSignal) =>
        runSidecarUnit({
          admissionClass: 'inference',
          operation: 'rerank',
          model,
          priority: EMBED_SIDECAR_INTERACTIVE_PRIORITY,
          textChars: query.length + text.length,
          demand: {
            cpuWeight: 1,
            memoryBytes: Buffer.byteLength(query, 'utf8') + Buffer.byteLength(text, 'utf8'),
          },
          signal: taskSignal,
          run: async () => {
            const rerankFn = await getReranker(model);
            const scores = await rerankFn(query, [text]);
            if (scores.length !== 1 || typeof scores[0] !== 'number' || !Number.isFinite(scores[0])) {
              throw new Error(`reranker returned a bad score for one pair: ${JSON.stringify(scores)}`);
            }
            return [scores[0]];
          },
        }),
      signal,
      batch,
    ).then((boxed) => boxed[0]);

  const handleEmbed = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    signal: AbortSignal,
  ): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req, signal));
    } catch (e) {
      if (signal.aborted || res.destroyed || res.writableEnded) return;
      json(res, 400, { error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const v = validateEmbedRequest(parsed);
    if ('error' in v) {
      json(res, 400, { error: v.error });
      return;
    }
    try {
      const batch = createQueueBatch(
        v.kind === 'query' ? EMBED_SIDECAR_INTERACTIVE_PRIORITY : EMBED_SIDECAR_BACKGROUND_PRIORITY,
      );
      // EI-19323982006772080: counted per request, so the answer to "did this
      // measure the model?" travels WITH the vectors it is about instead of
      // living in a process-global gauge the caller has to sample separately
      // and cannot attribute to itself.
      const tally: EmbedCacheAccounting = { hits: 0, coalesced: 0, inferred: 0 };
      const vectors = await Promise.all(
        v.texts.map((text) =>
          embedOneCached(v.model, v.kind, text, signal, batch, tally, v.bypassCache === true),
        ),
      );
      const body: EmbedResponse = {
        vectors,
        dims: vectors[0]?.length ?? 0,
        runtime: EMBED_SIDECAR_RUNTIME,
        modelRev: MODEL_REVS[v.model],
        cache: tally,
      };
      json(res, 200, body);
    } catch (e) {
      if (signal.aborted || res.destroyed || res.writableEnded) return;
      json(res, 500, { error: `embed_failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const handleRerank = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    signal: AbortSignal,
  ): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req, signal));
    } catch (e) {
      if (signal.aborted || res.destroyed || res.writableEnded) return;
      json(res, 400, { error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const v = validateRerankRequest(parsed);
    if ('error' in v) {
      json(res, 400, { error: v.error });
      return;
    }
    try {
      // Scores stay index-aligned with the request's texts; ordering, topN and
      // any threshold are the CLIENT's job. The server never reorders — that
      // keeps the ranking policy in one place (@papercusp/rerank) instead of
      // split across a wire.
      const batch = createQueueBatch(EMBED_SIDECAR_INTERACTIVE_PRIORITY);
      const scores = await Promise.all(
        v.texts.map((text) => rerankOneCached(v.model, v.query, text, signal, batch)),
      );
      const body: RerankResponse = {
        scores,
        runtime: EMBED_SIDECAR_RUNTIME,
        modelRev: RERANK_MODEL_REVS[v.model],
      };
      json(res, 200, body);
    } catch (e) {
      if (signal.aborted || res.destroyed || res.writableEnded) return;
      json(res, 500, { error: `rerank_failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const withRequestCancellation =
    (handler: (req: http.IncomingMessage, res: http.ServerResponse, signal: AbortSignal) => Promise<void>) =>
    (req: http.IncomingMessage, res: http.ServerResponse): void => {
      const cancellation = trackRequestCancellation(req, res);
      void handler(req, res, cancellation.signal).finally(cancellation.dispose);
    };

  // The route table is the ONE source for both dispatch and the capability
  // list /healthz advertises — a route cannot be added without being
  // advertised, because the advertisement is derived from these very keys.
  // That is the anti-drift property EI-19314150478401738 needed: a sidecar
  // must be able to say what it CANNOT do, so a client that outlived it can
  // tell "route absent" (version skew) from "request bad".
  const handlers: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void> = {
    [EMBED_SIDECAR_CAP_HEALTHZ]: (_req, res) => {
      json(res, 200, {
        ok: true,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        runtime: EMBED_SIDECAR_RUNTIME,
        // Everything this build can serve. A client compares its REQUIRED
        // capabilities against this before adopting the process.
        capabilities,
        models: { ...warm },
        // The (device, dtype) pair reranking is ACTUALLY running on — not the
        // one requested. A GPU host whose CUDA provider failed to load is
        // demoted to cpu/q8 silently as far as search is concerned (the engine
        // is fail-safe by design), so this is where that shows up. Before the
        // first load it reports the host's resolved target. See plan D-006.
        rerankExecution: activeExecutionTarget(),
        // ...and REQUESTED beside ACTIVE, because `rerankExecution` alone could
        // not express the very demotion the comment above promises it reveals:
        // a demoted host and a deliberate CPU host both rendered as plain
        // cpu/q8. `demoted` is the comparison nobody was making by hand.
        // `demoted: false` before the first load is honest-but-unproven — the
        // GPU session is only verified by constructing one.
        rerankExecutionHealth: rerankExecutionHealth(),
        // The same two fields for the EMBEDDERS, which had none until 2026-09-06.
        //
        // That asymmetry was expensive: between 2026-08-27 and 2026-09-06,
        // fourteen work-items were filed against embed latency (query embeds
        // blowing WORK_ITEM_EMBED_TIMEOUT_MS=4000, taking semantic recall and
        // work-item dedup down fleet-wide). Every one of them investigated the
        // request path — the scheduler below, its queue, the client-side query
        // cache — because the request path was the only thing this endpoint
        // could describe. A 14-probe discriminant refuted all three: latency
        // does not track queue depth (the three worst samples all dispatched at
        // depth 0; a saturated sample returned in 1543ms). The cause was the
        // execution target — no embedder requests a device, so forward passes
        // run on CPU at ~1.5-2.5s median with a tail past 8.5s — and proving it
        // meant reading /proc/<pid>/maps of this very process. These two fields
        // are so the fifteenth filing does not have to.
        //
        // `gpuProviderAvailable: null` means the async probe has not resolved,
        // so the question is UNKNOWN. It is deliberately not `false`: a detector
        // that answers from a measurement it never took is the failure this
        // replaces. Read `embedExecutionHealth.probe` before quoting the rest.
        //
        // ⚠ Read `providerLibraries` (what is on disk), NOT
        // `defaultBundledBackends[].bundled`, to judge whether a GPU is
        // reachable. Measured 2026-09-07: installing onnxruntime-node with
        // ONNXRUNTIME_NODE_INSTALL_CUDA=v12 makes CUDA sessions construct while
        // listSupportedBackends() still reports cuda:{bundled:false} — that flag
        // is publish-time packaging metadata, not a capability probe.
        embedExecution: embedExecutionTarget(),
        embedExecutionHealth: embedExecutionHealth(),
        // WI-37696: the two worker-thread crash-breakers THIS process owns.
        //
        // Both the embedder (@papercusp/memory) and the cross-encoder
        // (@papercusp/rerank) run their model in a persistent worker thread and
        // fall back to INLINE main-thread work when it is unavailable. Each has
        // a `disabled` latch that, once tripped, is permanent for the process —
        // and because the fallback returns identical values, tripping it emits
        // no error, no log line and no exit code. The sidecar keeps answering
        // 200 while the one thing it exists for (a warm model OFF the request
        // thread) is silently gone, and every /rerank then blocks this loop for
        // the duration of a forward pass.
        //
        // This is the correct process to report it from: the state is module-
        // global, these workers spawn HERE (not in the operator host), and the
        // getters are imported from the SAME bare specifier the embedders and
        // rerankers above use, so this reads the live module record rather than
        // a second, pristine copy. `disabled: true` is the field to alert on.
        //
        // Report-only — `ok` stays true. A fallen-back sidecar is degraded, not
        // down; it still returns correct vectors and scores, so failing the
        // health check would tell a supervisor to restart a process that is
        // serving every request correctly.
        workers: {
          embedder: workerStates.embedder(),
          reranker: workerStates.reranker(),
        },
        cache: { hits: cacheHits, misses: cacheMisses, size: vecCache.size },
        // `null` means no local capacity ceiling. A finite value comes from the
        // explicit PG-free test seam or the production environment window; in
        // the latter case durable governor admission still wraps every started
        // unit.
        concurrency: Number.isFinite(concurrency) ? concurrency : null,
        admission: {
          mode: localScheduler ? 'local-test-scheduler' : 'durable-governor',
          classes: ['embedding', 'inference'],
        },
        // EI-21341585960652821. The FIFO's REAL backlog. Until this existed,
        // /healthz could not express "up but not keeping up", and on 2026-08-24
        // that cost the fleet hours: the sidecar sat 100% slot-saturated with
        // every novel query embed queueing ~11.4s median (max 67.8s) against
        // caller budgets of 1200ms/4000ms, so semantic retrieval was dead
        // fleet-wide — while this endpoint answered 200 in 0.6ms with every
        // model `warm`. FIVE separate work-items were filed for that one cause
        // (EI-21304382115507204, EI-21340448199748146, EI-21339827924944774,
        // EI-21313833053692891, EI-21156482716733836), each correctly reporting
        // its own leg degraded, none able to see the shared queue.
        //
        // Why the pre-existing signal could not catch it: `workers.embedder.
        // pendingCount` READS like queue depth but is `_pending.size` — units
        // already HANDED TO the worker — so it is an OCCUPANCY gauge that says
        // nothing about what is still waiting. In steady state it simply equals
        // `active` and is therefore bounded by `concurrency` (measured: 6/6,
        // 5/5, 2/2), so pinned at the cap it is indistinguishable from "N in
        // flight, all well". That also defeats probing: at c=2 it is a constant,
        // and a discriminator correlating latency against a constant finds
        // nothing however carefully it is run.
        //
        // It is worse than merely capped — it is CONFLATED, and therefore
        // ambiguous in BOTH directions. Boot warm-up embeds bypass this FIFO,
        // so during warm-up `_pending` carries non-FIFO work too and the gauge
        // can EXCEED concurrency (measured 10 against concurrency 6 at ~12s
        // uptime). So a reading above the cap does not mean a backlog either.
        //
        // Measured 2026-08-24, ~29s after a restart, this endpoint reported
        // `pendingCount: 6` while the real backlog was **15**. That single pair
        // is the whole case for the field below.
        //
        // `depth` is the queue no one could see; `saturated` is the predicate a
        // health check should actually alert on (up AND keeping up).
        queue: {
          depth: queued,
          active,
          saturated: Number.isFinite(concurrency) && active >= concurrency,
        },
      });
    },
    [EMBED_SIDECAR_CAP_EMBED]: withRequestCancellation(handleEmbed),
    [EMBED_SIDECAR_CAP_RERANK]: withRequestCancellation(handleRerank),
    // Deliberately NOT tied to the request lifetime: once a device change has
    // recycled the worker, the re-warm must finish even if the caller gave up.
    // (`handleDeviceReload` is declared below; it is only invoked per request.)
    [EMBED_SIDECAR_CAP_DEVICE_RELOAD]: (req, res) => {
      void handleDeviceReload(req, res).catch((e) => {
        if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      });
    },
  };
  const capabilities = Object.keys(handlers);

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    const handle = handlers[`${req.method} ${url}`];
    if (handle) {
      handle(req, res);
      return;
    }
    json(res, 404, { error: `no route ${req.method} ${url}` });
  });

  const listening = new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 ONLY — never 0.0.0.0; embedded text crosses this wire.
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });

  // Warm the configured embedders (EMBED_SIDECAR_WARM_ENV, default gemma), one
  // governed background unit per model:kind slot. Each unit logs its own
  // outcome; the returned promise settles when every slot has, and never
  // rejects — a failed warm-up degrades that slot, it does not stop the others.
  const warmEmbedders = (): Promise<void> =>
    Promise.all(
      resolveWarmModels().flatMap((model) =>
        (['document', 'query'] as const).map((kind) =>
          runSidecarUnit({
            admissionClass: 'embedding',
            operation: 'warmup',
            model,
            kind,
            priority: EMBED_SIDECAR_BACKGROUND_PRIORITY,
            textChars: 'warm-up'.length,
            demand: { cpuWeight: 1, memoryBytes: Buffer.byteLength('warm-up', 'utf8') },
            run: async () => {
              const embed = await getEmbedder(model, kind);
              return embed('warm-up');
            },
          }).then(
            () => log(`[embed-sidecar] ${model}:${kind} warm`),
            (e) => log(`[embed-sidecar] ${model}:${kind} warm-up failed: ${e instanceof Error ? e.message : e}`),
          ),
        ),
      ),
    ).then(() => undefined);

  // Rerankers are opt-in via the same env (default: none) — a host that
  // does not serve search should not pay a ~150M-param load.
  const warmRerankers = (): Promise<void> =>
    Promise.all(
      resolveWarmRerankers().map((model) =>
        runSidecarUnit({
          admissionClass: 'inference',
          operation: 'warmup',
          model,
          priority: EMBED_SIDECAR_BACKGROUND_PRIORITY,
          textChars: 'warm-up'.length * 2,
          demand: { cpuWeight: 1, memoryBytes: Buffer.byteLength('warm-up', 'utf8') * 2 },
          run: async () => {
            const rerankFn = await getReranker(model);
            return rerankFn('warm-up', ['warm-up']);
          },
        }).then(
          () => log(`[embed-sidecar] ${model} warm`),
          (e) => log(`[embed-sidecar] ${model} warm-up failed: ${e instanceof Error ? e.message : e}`),
        ),
      ),
    ).then(() => undefined);

  // The Settings device choice (D-008). `loadEmbedDeviceSetting` is bounded and
  // never throws, but an injected loader might: a loader fault must degrade to
  // "keep the current device", never take the sidecar down.
  const embedDevice = opts.embedDevice ?? { load: () => loadEmbedDeviceSetting() };
  const applyEmbedDeviceSetting = async (when: 'boot' | 'reload'): Promise<EmbedDeviceSettingLoad> => {
    let result: EmbedDeviceSettingLoad;
    try {
      result = await embedDevice.load();
    } catch (e) {
      result = { setting: null, changed: false, readError: e instanceof Error ? e.message : String(e) };
    }
    log(
      `[embed-sidecar] embedding device setting (${when}): ${result.setting ?? 'none'}` +
        `${result.changed ? ' — device changed, worker recycled' : ''}` +
        `${result.readError ? ` — read failed: ${result.readError}` : ''}`,
    );
    return result;
  };

  // After a device change the embed worker was recycled, so the models it held
  // are gone. Drop the memoized embedders too — a closure's inline-fallback
  // pipeline was built on the OLD device — and re-warm the boot-warm set so the
  // first real request does not pay the load, bounded so a slow GPU session
  // construction cannot hold the save request open indefinitely.
  const rewarmAfterDeviceChange = async (): Promise<{ models: Record<string, string>; timedOut: boolean }> => {
    for (const key of [...embedders.keys()]) {
      embedders.delete(key);
      delete warm[key];
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      warmEmbedders().then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), EMBED_DEVICE_REWARM_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    return { models: { ...warm }, timedOut };
  };

  const handleDeviceReload = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    req.resume(); // no body is read; discard any so the socket is released
    const load = await applyEmbedDeviceSetting('reload');
    const rewarm = load.changed ? await rewarmAfterDeviceChange() : null;
    const body: EmbedDeviceReloadResponse = {
      ok: true,
      setting: load.setting,
      changed: load.changed,
      readError: load.readError,
      rewarm,
      embedExecution: embedExecutionTarget(),
      embedExecutionHealth: embedExecutionHealth(),
    };
    json(res, 200, body);
  };

  if (opts.warmAtBoot !== false) {
    // Warm AFTER listen is queued: the READY handshake must not wait out a
    // model load (can be 10s+ cold), and a request that races the warm-up
    // simply awaits the same promise. The device setting is applied FIRST, so
    // the boot warm-up builds on the chosen device instead of building on auto
    // and then recycling (the read is bounded at 5s and never throws).
    void listening.then(async () => {
      await applyEmbedDeviceSetting('boot');
      void warmEmbedders();
      void warmRerankers();
    });
  }

  return {
    server,
    listening,
    warmStates: () => ({ ...warm }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Start the sidecar and own the process lifecycle (SIGTERM/SIGINT → close).
 * Prints the PAPERCUSP_EMBED_SIDECAR_READY handshake once listening so the
 * parent spawnEmbedSidecar() handshake completes.
 */
export function runEmbedSidecarServer(): void {
  const handle = createEmbedSidecarServer();
  handle.listening.then(
    (port) => {
      console.log(`[embed-sidecar] listening on http://127.0.0.1:${port}`);
      console.log(`${EMBED_SIDECAR_READY_LINE} port=${port}`);
    },
    (err) => {
      console.error('[embed-sidecar] failed to listen:', err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
  const shutdown = (signal: string): void => {
    console.log(`[embed-sidecar] ${signal} received, shutting down gracefully`);
    // EI-19464316359123796: this process IS the "in-process embedding" host the
    // fallback-warning in embed-sidecar-spawn.ts tells OTHER callers to worry
    // about — buildLocalEmbedder/buildGemmaEmbedder/buildHarrierEmbedder above
    // all route through local-embedder-worker.ts's shared worker_thread, and
    // the reranker through its sibling module. A bare `process.exit(0)` skips
    // Node's `beforeExit` hook entirely (by design), so those workers' own
    // graceful-teardown listeners never fire and the ONNX native addon inside
    // them gets torn down mid-flight by the abrupt process exit — surfacing as
    // an unlabelled `terminate called after throwing an instance of
    // 'Napi::Error'` / SIGABRT (exit 134) on every restart of this systemd
    // unit (Restart=always), even though the shutdown was entirely graceful.
    // Await the SAME explicit teardown the module's own doc tells ad-hoc
    // scripts to call before their `process.exit()` — best-effort: a stuck
    // worker must never block a graceful shutdown indefinitely.
    void handle
      .close()
      .then(() => Promise.allSettled([shutdownLocalEmbedder(), shutdownLocalReranker()]))
      .then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
