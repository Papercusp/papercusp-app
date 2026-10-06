/**
 * Embed-backfill worker for Plan 2B+C.
 *
 * Walks the prose surfaces (operator_turns, harness_escalations,
 * harness_brainstorm, harness_decisions, session_turns) and the work-item
 * ledger's base table (work_items — P-008,
 * shared-embedding-sidecar-and-enrichment-2026-07-10) looking for rows
 * that lack a vector IN THE ACTIVE EMBEDDING SPACE, and fills them in
 * batches using the same OpenAI/local cascade mem0 uses (so embeddings
 * live in the same 384-D space as memories — future cross-pollination
 * becomes possible).
 *
 * Cadence: one sweep at boot (instrumentation-node.ts), then idle.
 * New rows after boot are backfilled by the next boot. We don't add
 * a trigger-on-insert path because embeddings need network calls and
 * the writer should never block on them.
 *
 * Resumable: state is "where the row's embedding is missing OR was produced by a
 * DIFFERENT embedder than the active one" (migration 530's `<embedCol>_mode`
 * discriminator). Restart picks up naturally. Failure on a single row counts as
 * an error and skips forward; we don't poison the whole sweep.
 *
 * WI-3616: that predicate used to be plain `IS NULL`, which silently assumed a
 * vector, once written, stayed valid forever. It doesn't. `memoryEmbedderMode`
 * chooses the embedder at runtime and ALSO drives the query vector, so flipping it
 * strands every stored vector in a foreign 384-D space — same width, no error, pure
 * noise at query time — and the NULL-only predicate never revisited them, so the
 * column could never self-heal. Tagging each vector with its space lets the sweep
 * converge a switched column back onto one space.
 */

import { getOrgPg } from '@papercusp/db-org';
// The engine (selection, batching, guarded writes, round-robin sweep) lives in
// @papercusp/search per shared-vector-search-libraries-2026-09-29 D-004; this
// module keeps papercusp's targets and hooks.
import {
  BASELINE_RECIPE_VERSION,
  activeRecipeVersion,
  backfillTable as backfillTableCore,
  createBackfillSweepState,
  createBackfillSweeper,
  eligiblePredicateSql,
  inspectBackfillTarget as inspectBackfillTargetCore,
  modeColOf,
  profileColOf,
  recentPredicateSql,
  recipeColOf,
  settledPredicateSql,
  stalePredicateSql,
  type BackfillSql,
  type BackfillStats,
  type BackfillSweepState,
  type BackfillSweeperConfig,
  type BackfillTableOptions,
  type BackfillTarget,
  type BackfillTargetInspection,
} from '@papercusp/search';
import { pinModuleState } from '@papercusp/module-singleton';
import { getResourceProfile } from '../resource-profile';
import { embedAdmission, headersToRecord, retryAfterMs } from '../memory/embed-admission';
import {
  resolveEmbedderWith,
  readEmbedderPreference,
  proseSurfacePreference,
  resolveOpenAiKey,
  localAvailable,
  isOpenAiEmbedInCooldown,
} from '../memory/configure';
import type { EmbedFn, EmbedderProfileSpec, ResolvedEmbedder } from '@papercusp/memory';
import { SIDECAR_MAX_TEXT_CHARS, sidecarEmbedBatch, sidecarBatchTimeoutMs } from '@papercusp/memory';
import {
  buildDeferredSidecarAwareEmbedder,
  processSidecarConfigured,
  resolveProcessSidecarUrl,
} from '../memory/embed-sidecar-wiring';
import { EMBED_SIDECAR_CAP_EMBED } from '../memory/embed-sidecar-server';
// The prose column width contract — ONE source, not a restated `384`
// (D-005 §5). `fitsProseColumns` is the dims guard; `modeTargetDims` is what a
// mode declares it emits. A test asserts the two agree.
import {
  PROSE_VECTOR_DIMS,
  computeProseColumnWidthSkew,
  fitsProseColumns,
  modeTargetDims,
  resolveProseProfileSelection,
} from './prose-vector-dims';

export {
  BASELINE_RECIPE_VERSION,
  activeRecipeVersion,
  eligiblePredicateSql,
  modeColOf,
  profileColOf,
  recentPredicateSql,
  recipeColOf,
  settledPredicateSql,
  stalePredicateSql,
};
export type { BackfillStats, BackfillTarget, BackfillTargetInspection };
import { CHUNK_STORES, type ChunkStoreRegistration } from './chunks/registry';

const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';
// F-E5 (app-wide-load-traps § E): hardware-adaptive embed batch — a big host
// pushes bigger batches for throughput, a laptop keeps latency/memory down.
const BATCH_SIZE = getResourceProfile().embedBatchSize;

/**
 * How many texts go to the sidecar in ONE batch call. Deliberately much smaller
 * than BATCH_SIZE, and the gap is the point.
 *
 * `sidecarBatchTimeoutMs` scales the budget by text COUNT (15s + 2s/text after
 * the first), a
 * figure calibrated on 2026-08-03 against a sidecar measured at 59-75ms/row. The
 * sidecar's cost is dominated by per-text model latency, and under sustained
 * fleet load that is now far above the calibration: measured 2026-09-04 against
 * the live :3384 gemma sidecar with UNIQUE texts (identical texts hit the LRU and
 * report a ~350x-too-fast figure), 907ms/text at 200 chars and 2,503ms/text at
 * 2,000 chars — document embeds are BACKGROUND_PRIORITY, so they get roughly a
 * 1-in-5 share behind interactive queries.
 *
 * Handing the whole BATCH_SIZE (128) to one call makes a breach maximally
 * expensive: the budget is 142s, ALL of it is lost on abort because a batch is
 * all-or-nothing at the sidecar, the sweep then still pays the per-row path for
 * every row, and that single target can consume the whole 200s SWEEP_BUDGET_MS —
 * which is how one surface starved the other 15 (observed: `drain: 1 round(s) in
 * 351s (budget 200s) · drained 3/16 target(s)`).
 *
 * Chunking bounds a breach to ONE chunk and KEEPS what earlier chunks produced,
 * because `batchVectors[i] ?? per-row` below is per-INDEX: a null just sends that
 * one row down the per-row path. 16 keeps the amortised HTTP win while capping
 * the worst-case loss at a 45s budget instead of 269s (before the shared 180s
 * ceiling).
 */
const BATCH_EMBED_CHUNK_SIZE = 16;

/**
 * WI-7327: per-row embed deadline.
 *
 * A single embed is ~0.3-1.5s against the local :3384 sidecar even on a loaded
 * box, so 90s cannot fire on a merely-slow call — it fires only on a call that
 * is never coming back. Without it one wedged request pins the sweep's `running`
 * latch and silently disables ALL future backfill.
 */
const EMBED_ROW_TIMEOUT_MS = 90_000;

/** Slack added to the sidecar's own batch budget for the OUTER race, so the
 *  client's specific abort surfaces instead of being pre-empted by this
 *  process-side timeout (EI-19464574865993243). */
const EMBED_BATCH_OUTER_MARGIN_MS = 5_000;

/**
 * WI-7348: embedder-RESOLUTION deadline.
 *
 * The per-row deadline above cannot help here, because resolution happens
 * BEFORE any row is read — and before `getOrgPg()`, so a hang here leaves no
 * DB connection and no socket to observe. Measured 2026-08-03: a standalone
 * driver sat 55 MINUTES inside pass 1 at 0% CPU / WCHAN=ep_poll with zero inet
 * sockets, no `pg_stat_activity` row, and exactly one log line; on SIGTERM it
 * aborted with `Napi::Error`, i.e. it was blocked inside a NATIVE addon.
 *
 * Resolution touches a preference read, a native `localAvailable` probe and the
 * sidecar-aware builders. Which of them blocked is UNDETERMINED — and the fix
 * deliberately does not depend on knowing: one deadline around the whole
 * resolver covers every branch, including native code a JS-level per-call
 * wrapper cannot reach into.
 *
 * 60s is far above a healthy resolve (sub-second when the :3384 sidecar is up,
 * a few seconds for a cold in-process model load), so this fires only on a
 * resolve that is never coming back.
 */
const EMBEDDER_RESOLVE_TIMEOUT_MS = 60_000;

// Exported for embed-coverage.ts (WI-7469): the coverage metric must ask the SAME
// "is this row still stale?" question the sweep asks, which is mode-aware — so the
// mode type has to cross the module boundary with it.
export type ResolvedMode = 'openai' | 'local' | 'gemma' | 'harrier' | 'disabled';

/**
 * P-005 — embed a WHOLE batch in one call. Returns one vector per input, in order.
 *
 * The single-text `EmbedFn` seam cannot express this, which is exactly why the
 * amortization went untaken for so long: `sidecarEmbedBatch` has always accepted
 * `texts[]` and its docstring already named embed-backfill as the intended
 * consumer, but every call site in the tree — including
 * `buildSidecarFirstEmbedder` itself and mem0's `embedBatch` (a `Promise.all` of
 * N single-text requests) — passed a 1-element array.
 */
export type EmbedManyFn = (texts: string[]) => Promise<number[][]>;

/**
 * Build a batch embedder for the resolved mode, or null when batching isn't
 * available (no sidecar configured, or the OpenAI leg, which is governed per-call
 * by the admission governor and must stay that way).
 *
 * Returning null is a normal outcome, not a failure: the caller keeps using the
 * per-row `embed` and the sweep behaves exactly as it did before.
 */
async function resolveBatchEmbed(mode: ResolvedMode): Promise<EmbedManyFn | null> {
  // Only the local sidecar-backed spaces batch. The OpenAI leg deliberately does
  // not: each call takes an admission slot (`bench` lane, daily spend cap), and a
  // batched call would take ONE slot for N texts, silently defeating the cost
  // governor the cost-audit added.
  if (mode !== 'gemma' && mode !== 'local' && mode !== 'harrier') return null;
  // D-050: decide batch capability WITHOUT ensuring the sidecar. This runs on every
  // 5-min sweep, including the drained ones that embed nothing, and resolving the
  // URL here ENSURED the sidecar (spawned it when down), so its idle exit never
  // held (P-532c). The URL is now resolved per batch, i.e. only once there are rows
  // to embed. A batch that finds no sidecar throws, and the drain falls back to the
  // per-row path, the same outcome the old null return produced.
  if (!processSidecarConfigured()) return null;
  return async (texts: string[]) => {
    const url = await resolveProcessSidecarUrl(undefined, [EMBED_SIDECAR_CAP_EMBED]);
    if (!url) throw new Error('no embed sidecar for this process; the drain uses the per-row path');
    // Prose backfill is STORAGE — the same 'document' side the per-row embedders
    // above resolve to. Asymmetric models embed a document differently from a
    // query, so this MUST match or the batch path would write vectors from a
    // different space than the per-row fallback (WI-3616's whole failure mode).
    // EXPLICIT, batch-scaled budget. Omitting it inherited the SINGLE-embed
    // default (15s) for the whole batch, which aborted every sweep on a
    // server-tier box (BATCH_SIZE 128 × ~0.22s/text ≈ 28s) — see
    // EI-19464574865993243. Derived from the shared helper so the outer
    // withEmbedTimeout race below cannot pick a different number.
    const res = await sidecarEmbedBatch(url, {
      model: mode,
      kind: 'document',
      texts,
      timeoutMs: sidecarBatchTimeoutMs(texts.length),
    });
    return res.vectors;
  };
}

function buildAdmissionGovernedOpenAiEmbedder(key: string): EmbedFn {
  return async (text: string): Promise<number[]> => {
    // Route the backfill through the SHARED embed-admission governor (cost-audit-2026-06-29).
    // This sweep previously fired RAW, UNGOVERNED OpenAI embeds every 5 min — the one embed path
    // that bypassed the governor, so neither the org-TPM rate cap NOR the daily spend cap applied
    // to it. Use the 'bench' lane (lowest priority): under rate contention it sheds first, and the
    // daily-budget cap throws EmbedBudgetExhaustedError → the per-row catch in backfillTable counts
    // it as an error and skips, so a runaway can't drain the key. A bench-lane SHED (null slot)
    // likewise skips the row; the next sweep retries.
    const adm = embedAdmission();
    const slot = await adm.acquire(text, 'bench'); // throws EmbedBudgetExhaustedError when over the daily cap
    if (slot === null) throw new Error('openai_embed_admission_shed');
    try {
      const r = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: OPENAI_EMBEDDER_MODEL,
          input: text,
          // What the openai mode DECLARES it emits. The prose-column contract
          // test asserts this equals PROSE_VECTOR_DIMS, so asking for the
          // declared width can never write a vector the column cannot hold.
          dimensions: modeTargetDims('openai'),
        }),
      });
      adm.recordResponse(headersToRecord(r.headers));
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

/**
 * Resolve BOTH which embedder to use AND build it, via the SAME cascade
 * mem0 uses (`memory/configure.ts`'s `resolveEmbedderWith`, EI-8913). This
 * sweep used to re-derive its own openai/local/disabled decision independently
 * (no OpenAI post-failure-cooldown awareness) — a desync here silently
 * strands freshly-backfilled rows in a DIFFERENT embedding space than a
 * concurrent memory:remember/search would pick, defeating the whole point of
 * migration 530's per-row mode discriminator. Only the embed-fn BODIES
 * (admission-governed OpenAI fetch, local-transformers pipeline) stay bespoke
 * to this backfill sweep.
 */
// Exported for embed-space-self-check.ts (WI-3644 / EI-8913 detector half):
// the self-check must resolve+build the embedder through the EXACT SAME
// governed cascade (admission-governed OpenAI fetch, cooldown-awareness) as
// the backfill sweep — duplicating buildAdmissionGovernedOpenAiEmbedder would
// recreate the ungoverned-OpenAI-call bug class this module's own comments
// already document being fixed once (cost-audit-2026-06-29).
export async function resolveBackfillEmbedder(): Promise<ResolvedEmbedder> {
  return resolveEmbedderWith({
    // P-015 harrier default flip: prose surfaces stay in the gemma space —
    // see proseSurfacePreference (memory/configure.ts) for the full rationale.
    readPreference: async () => proseSurfacePreference(await readEmbedderPreference()),
    resolveKey: resolveOpenAiKey,
    localInstalled: localAvailable,
    isOpenAiRecentlyExhausted: isOpenAiEmbedInCooldown,
    buildOpenAi: buildAdmissionGovernedOpenAiEmbedder,
    // Sidecar-first local legs (P-004): shared warm model when the host runs
    // the embed sidecar, bit-identical in-process fallback otherwise.
    // D-050: DEFERRED builders. This resolver runs on every 5-min sweep, and an
    // eager build ensures (spawns) the sidecar even when there is nothing to embed.
    buildLocal: async () => buildDeferredSidecarAwareEmbedder('local', 'document'),
    // Prose backfill is STORAGE, so EmbeddingGemma gets the document prompt.
    buildGemma: async () => buildDeferredSidecarAwareEmbedder('gemma', 'document'),
    // Required by the cascade seam since P-014 made harrier selectable; the
    // sweep itself never STORES harrier vectors (native 1024 ≠ PROSE_VECTOR_DIMS
    // — the dims guard in runBackfillSweep skips the whole sweep), but an
    // unresolvable preference must not throw and kill the periodic tick.
    // Stated as the CONSTANT, not a literal width: migration 727 moves the prose
    // columns 384 → 768 and this comment used to name 384, which would have read
    // as "harrier is excluded because it is not 384" — true of the old width and
    // wrong about the reason. Harrier is excluded because 1024 ≠ the prose width,
    // whatever that width currently is.
    buildHarrier: async () => buildDeferredSidecarAwareEmbedder('harrier', 'document'),
  });
}

/*
 * BackfillTarget is @papercusp/search's type (re-exported above). What papercusp's
 * TARGETS rely on, from the measurements that set each rule:
 *  - keyCols are real PRIMARY KEYs, never ctid (cost-audit-2026-06-29): a ctid moves on
 *    UPDATE or VACUUM, so a guarded write could match nothing (re-embed forever) or
 *    land on another row.
 *  - orderBySql is freshest-first on an INDEXED column (P-005). Unordered, new rows are
 *    covered only at the table's overall rate (24h coverage read 7% while the drain
 *    outpaced writes). session_turns `ingested_at DESC` plans as a backward index scan,
 *    36ms per 64-row batch (2026-08-03).
 *  - recencyCol is a CREATION time, not the orderBySql column (WI-7469): an edit is
 *    not a new row. work_items.created_ts, operator_turns.created_at and
 *    harness_brainstorm.updated_at are epoch MILLISECONDS; the rest are timestamptz.
 *  - recipeVersion bumps are per-target and costly (~0.22s/text: work_items ≈ 2.2h,
 *    session_turn_chunks ≈ 7.4h, session_turns ≈ 18.1h). Bump only what you measured
 *    (P-026 / D-087). The recipe lives in `<embedCol>_recipe`, never folded into
 *    `<embedCol>_mode`: four query-time readers equality-match the mode.
 * Exported for embed-space-self-check.ts (WI-3644), which re-embeds a row from one of
 * these same prose surfaces.
 */

/**
 * generic-rag-chunking-2026-09-29 P-013 (R-31, EI-24609404813504679): one
 * query-time search site that READS a target's stored vector.
 *
 * Declared here because the sweep only ever writes vectors, so nothing forced a
 * target to have a reader. Three write-only vectors were found that way:
 * carry_notes.note_embedding (dropped by migration 1243, D-020),
 * harness_docs.embedding and coord_thread_posts.body_embedding (dropped by
 * migration 1249, D-025; the last carried 1.1M vectors and a 4.3 GB HNSW index
 * that no query touched). embed-target-readers.test.ts checks every entry
 * against the file it names.
 */
export interface EmbedVectorReader {
  /** Repo-relative path of the file holding the read. */
  file: string;
  /**
   * Literal substrings of that file which together ARE the read. At least one
   * must carry a pgvector distance operator; the others tie it to this target,
   * usually its FROM clause. If any of them disappears the guard fails, so
   * removing the reader flags the TARGET instead of leaving a vector nobody
   * reads.
   */
  evidence: readonly [string, ...string[]];
}

/**
 * A TARGETS entry: sweep mechanics plus the REQUIRED, non-empty list of search
 * sites that read the vector it fills. A vector with no reader gets no target;
 * drop the column instead (D-020, D-025). Standalone targets outside the shared
 * sweep, such as the personal vault's, keep the plain {@link BackfillTarget}.
 */
export interface SweepTarget extends BackfillTarget {
  readers: readonly [EmbedVectorReader, ...EmbedVectorReader[]];
}

/*
 * The selection predicates (modeColOf, profileColOf, recipeColOf, activeRecipeVersion,
 * eligiblePredicateSql, stalePredicateSql, recentPredicateSql, settledPredicateSql) are
 * @papercusp/search's, re-exported above so embed-coverage and the coverage gate ask
 * the sweep's exact question. Papercusp facts they encode:
 *  - session_turns' bodySql returns '' under 80 chars, so 18.4% of it is ineligible by
 *    design; a coverage denominator of raw rows would sit red forever (P-027).
 *  - coverage is `eligible AND NOT stale`; `IS NOT NULL` over-reports after an
 *    embedder-space change (WI-3616).
 *  - the settled window has both bounds because one 24h aggregate averaged 100% new-row
 *    coverage with a 5.7-10.9% historical band into a false 67.5% alarm (2026-08-03).
 */

/**
 * The embed-sweep target for one chunk store (generic-rag-chunking P-005).
 * Every chunk store carries `updated_at` and a `<table>_updated_idx`, so the
 * sweep walks it freshest-first by a backward index scan and a newly chunked
 * row is searchable within a tick. Chunk rows are replaced wholesale when
 * their parent changes, so `updated_at` IS the write time.
 */
export function chunkStoreBackfillTarget(store: ChunkStoreRegistration): SweepTarget {
  return {
    table: store.table,
    embedCol: store.embedCol,
    bodySql: store.embeddedTextSql,
    keyCols: [...store.keyCols],
    orderBySql: 'updated_at DESC',
    recencyCol: 'updated_at',
    recencyColKind: 'timestamptz',
    readers: [CHUNK_VECTOR_LEG_READER],
  };
}

/**
 * Every chunk store's vectors are read by one helper, the chunk-aware vector leg
 * (D-009): each chunk-backed search site calls it with its surface, and it
 * resolves the store's table and embedding column from the registry. Today
 * session_turn search calls it (search/sources.ts); the text_chunks collections
 * call it once they register (P-009..P-012).
 */
const CHUNK_VECTOR_LEG_READER: EmbedVectorReader = {
  file: 'libs/generic/search/src/chunks/vector-leg.ts',
  evidence: ['export function chunkAwareVectorLegSql(', '(${sql.unsafe(emb)} <=> ${q}::vector)'],
};

/** search:semantic's ranked prose sources (escalations, brainstorm, operator turns, decisions, work items). */
const SEARCH_SOURCES_FILE = 'packages/operator-core/lib/agent-tools/search/sources.ts';

// Exported for embed-space-self-check.ts (WI-3644): the canonical set of
// embedded prose surfaces, reused rather than re-listed so the self-check
// never drifts from what the backfill sweep actually maintains.
//
// Every entry names its `readers` (P-013, R-31): the search sites that query
// the vector it fills. embed-target-readers.test.ts checks each one against the
// file it names.
export const TARGETS: SweepTarget[] = [
  // EI-12967: these first four targets had NO char cap on their embed input — unlike
  // every other target below (session_turns/work_items/doc_sections/harness_plans all
  // `left(…, 2000)`). The sidecar hard-rejects any single text over 32000 chars
  // (sidecar_embed_400), and the deterministic 400 is UNRETRYABLE: the row stays
  // `embedCol IS NULL` forever, so the next 5-min sweep tick re-SELECTs and re-fails the
  // SAME oversized row again — a permanent retry-forever loop for that one row (live:
  // 392 operator_turns rows + 9 harness_escalations rows over 32000 chars, one re-failing
  // every ~5min since 2026-07-16). Capping the embed INPUT at the same 2000-char
  // convention used everywhere else in this file fixes it at the root — the embed call
  // never again submits more than the sidecar accepts, so the row succeeds and stops
  // being re-selected. The stored column itself is untouched; only what's HANDED to
  // embed() is capped.
  {
    table: 'harness_shared.harness_escalations',
    embedCol: 'body_embedding',
    bodySql: `left(COALESCE(escalation, ''), 2000) || E'\\n' || left(COALESCE(supervisor_notes, ''), 2000)`,
    keyCols: ['harness_slug', 'phase'],
    // No write-time column on this table at all — recent-coverage reads NULL (absent, not zero).
    readers: [{
      file: SEARCH_SOURCES_FILE,
      evidence: ['FROM harness_shared.harness_escalations', 'ORDER BY body_embedding <=> ${qVec}::vector'],
    }],
  },
  {
    table: 'harness_shared.harness_brainstorm',
    embedCol: 'content_embedding',
    bodySql: `left(content, 2000)`,
    keyCols: ['harness_slug', 'phase'],
    // Only an update-time column exists here; it is the best available write proxy.
    recencyCol: 'updated_at',
    recencyColKind: 'epochMs',
    readers: [{
      file: SEARCH_SOURCES_FILE,
      evidence: ['FROM harness_shared.harness_brainstorm', 'ORDER BY content_embedding <=> ${qVec}::vector'],
    }],
  },
  {
    table: 'harness_shared.operator_turns',
    embedCol: 'text_embedding',
    bodySql: `left(text, 2000)`,
    keyCols: ['id'],
    recencyCol: 'created_at',
    recencyColKind: 'epochMs',
    readers: [
      // search:semantic's turns source reads it as the chunk-aware leg's PARENT
      // vector (generic-rag-chunking P-010, D-017): the leg takes the parent
      // table and vector column from OPERATOR_TURNS_CHUNK_SURFACE.parentVector
      // (search/chunks/registry.ts), which registry.test.ts pins to this column.
      {
        file: SEARCH_SOURCES_FILE,
        evidence: ['surface: OPERATOR_TURNS_CHUNK_SURFACE', 'WITH best AS (${chunkAwareVectorLegSql(sql, {'],
      },
      {
        file: 'libs/generic/search/src/chunks/vector-leg.ts',
        evidence: ['(${sql.unsafe(parentVec)} <=> ${q}::vector) AS distance'],
      },
    ],
  },
  {
    table: 'harness_shared.harness_decisions',
    embedCol: 'body_embedding',
    // args is free-form (a tool call's JSON args) — cap it too (EI-12967 belt-and-braces;
    // observed max is small today, but nothing bounds it going forward).
    bodySql: `COALESCE(verb, '') || ' ' || left(COALESCE(args, ''), 2000)`,
    keyCols: ['harness_slug', 'line_hash'],
    // No write-time column on this table at all — recent-coverage reads NULL (absent, not zero).
    readers: [{
      file: SEARCH_SOURCES_FILE,
      evidence: ['FROM harness_shared.harness_decisions', 'ORDER BY body_embedding <=> ${qVec}::vector'],
    }],
  },
  // session-search-scope-2026-07-05: the episodic transcript index. Embed
  // SELECTIVELY — short acks are noise for semantic recall. The CASE returns ''
  // for skipped rows, which the `length(bodySql) > 0` guard in backfillTable
  // excludes from the sweep entirely, so skipped turns are never re-scanned.
  // Volume is governed by the shared embed-admission bench lane — a big backlog
  // fills progressively across 5-min ticks, never in one burst.
  //
  // P-028 (semantic-search-fingerprint-coverage-2026-08-03): the floor used to
  // be a flat `length(text) >= 80`, which dropped 71,026 rows (17.4%) — and the
  // justification for that ("short acks are noise; they stay BM25-searchable via
  // text_tsv") over-applied in one specific, owner-facing way: a short turn is
  // not necessarily an ACK. It is very often a terse OWNER QUESTION, which is
  // precisely what someone later searches for. Measured 2026-08-03, the dropped
  // set contained the literal turn "which one was about the theory of mind
  // work?" (44 chars) — the exact query class this plan was opened to fix.
  //
  // `speaker` is the discriminator, not length alone: among turns 20-79 chars,
  // 5.4% of USER turns are questions vs 0.19% of assistant turns — a 28x
  // difference, so admitting short user turns buys the questions without
  // re-admitting the assistant acks the floor was written for. Cost is +15,110
  // rows (+4.5% of the eligible corpus). The <20-char band stays excluded for
  // both speakers ("ok", "yes", "continue" are acks in either voice).
  //
  // The fallback the original rationale leaned on is also weaker than it looks:
  // the lexical leg ANDs every term (plainto_tsquery), so it decays to ZERO
  // hits on longer natural-language queries (EI-19447237774252790) — "it stays
  // BM25-searchable" is not the safety net it reads as.
  {
    table: 'harness_shared.session_turns',
    embedCol: 'text_embedding',
    bodySql: `CASE WHEN length(text) >= 80 OR (speaker = 'user' AND length(text) >= 20) THEN left(text, 2000) ELSE '' END`,
    keyCols: ['workspace_id', 'source_kind', 'session_id', 'turn_idx'],
    // Backed by session_turns_ingested_idx — a backward index scan, NOT a sort.
    // `ingested_at` rather than `ts`: `ts` is indexed only as (owner, ts), which a
    // global ordering cannot use.
    orderBySql: 'ingested_at DESC',
    recencyCol: 'ingested_at',
    recencyColKind: 'timestamptz',
    readers: [
      // session_turn search reads it as the chunk-aware leg's PARENT vector.
      // Since generic-rag-chunking P-007 the leg takes its parent table and
      // vector column from the session-turn registry entry
      // (search/turn-chunk-sync.ts SESSION_TURN_CHUNK_SURFACE.parentVector),
      // which chunks/derived-registrations.test.ts pins to this column.
      {
        file: SEARCH_SOURCES_FILE,
        evidence: ['surface: SESSION_TURN_CHUNK_SURFACE', 'WITH best AS (${chunkAwareVectorLegSql(sql, {'],
      },
      {
        file: 'libs/generic/search/src/chunks/vector-leg.ts',
        evidence: ['(${sql.unsafe(parentVec)} <=> ${q}::vector) AS distance'],
      },
      // events:await interest watches match new turns against a watch vector.
      {
        file: 'packages/operator-core/lib/events/await/interest-watch.ts',
        evidence: ['FROM harness_shared.session_turns', 'AND 1 - (text_embedding <=> ${qVec}::vector) >= ${row.simFloor}'],
      },
    ],
  },
  // The chunk stores: per-chunk vectors for rows longer than the 2,000-char
  // window their parent's entry embeds (session_turn_chunks, P-034 of
  // semantic-search-fingerprint-coverage-2026-08-03 / D-016; the shared
  // text_chunks, generic-rag-chunking-2026-09-29). DERIVED from
  // search/chunks/registry.ts CHUNK_STORES (generic-rag-chunking P-005), so a
  // new chunk store is one registry entry and never a hand-added target here.
  //
  // ⚠ Do NOT "simplify" chunking away by widening a parent's left(text, 2000)
  // instead. That was measured and REJECTED: a single 768-dim vector DILUTES as
  // its text grows, so the width sweep peaks and then DECLINES (at probe 3000,
  // width 8000 scores WORSE than width 4000), and the apparent optimum is just
  // the narrowest width containing the probe — moving the probe collapsed width
  // 4000 by 49%. Chunking was the only position-independent arm. D-016 of
  // semantic-search-fingerprint-coverage-2026-08-03 has the full table.
  ...CHUNK_STORES.map(chunkStoreBackfillTarget),
  // P-008 (shared-embedding-sidecar-and-enrichment-2026-07-10): the work-item
  // ledger — ONE base table (migration 374 unified issue + feature families
  // into harness_shared.work_items; engineer_issues / harness_features_
  // consolidated are compat views over it, so the migration-551 embedding
  // columns live HERE and one sweep covers every kind). Embeds title +
  // body/summary (truncated to 2k chars, mirroring session_turns) so
  // work_items:search gains a semantic leg and work_items:create can prescreen
  // a new title against OPEN items by cosine similarity — the 2026-07-10
  // 30-dupe bug-storm class (WI-3358..WI-3477) that lexical dedup missed.
  //
  // P-026 (D-086 §6.3 Tier 0) — INDEX-SIDE REF EXPANSION. A work-item body that says
  // "superseded by WI-4028" embeds the STRING "WI-4028", which carries no meaning in
  // vector space: a query about that item's TOPIC cannot reach this row. Resolving the
  // ref to its TITLE at index time bridges that hop once, at write time, instead of at
  // query time — the EI-10048 mechanism (`memory/ref-expand.ts`), which until now was
  // wired at exactly ONE call site (memory/remember.ts) and never reached the surfaces
  // the corpus leg actually retrieves, because those are embedded in pure SQL here.
  //
  // Expressible as a self-join, so there is no JS seam to add: the resolver is the same
  // table. Measured 2026-08-09 on the live 36,609-row table — 16,500 rows mention a ref,
  // 6,373 of 6,651 distinct refs resolve (95.8%), and the whole-table evaluation costs
  // 1.6s (the sweep pulls 64 rows at a time; only the coverage detector scans all of it).
  //
  // ⚠ The digit range is {2,20}, NOT ref-expand.ts's {2,5}. Modern EI ids on this box are
  // 17 digits (EI-19988500685566622), and `\y[0-9]{2,5}\y` cannot match one AT ALL — the
  // trailing boundary fails mid-number, so it matches nothing rather than truncating.
  // Widening covers 1,206 more rows (+7.9%). The JS path still carries the narrow form
  // and is correspondingly blind to those refs.
  //
  // ⚠ Scoped to the SAME harness. The PK is (harness_slug, feature_id), so the schema
  // explicitly permits two harnesses to hold the same id — an unscoped join would bind a
  // ref to a DIFFERENT tenant's item and embed a confidently wrong title. Same-harness is
  // the only sound reading whatever today's data happens to look like.
  //
  // The appendix format mirrors ref-expand.ts exactly (`\n\n[refs] ID: title; ...`, cap 6)
  // so a row enriched by this path and one enriched by the JS path are indistinguishable
  // to the embedder.
  {
    table: 'harness_shared.work_items',
    embedCol: 'embedding',
    bodySql:
      `COALESCE(title, '') || E'\\n' || left(COALESCE(summary, ''), 2000)` +
      ` || COALESCE((SELECT E'\\n\\n[refs] ' || string_agg(t.ref || ': ' || left(COALESCE(t.rtitle, ''), 200), '; ' ORDER BY t.ord)` +
      ` FROM (SELECT d.ref, d.ord, w2.title AS rtitle` +
      ` FROM (SELECT DISTINCT ON (mm.ref) mm.ref, mm.ord` +
      ` FROM (SELECT m.match[1] AS ref, m.ord` +
      ` FROM regexp_matches(COALESCE(work_items.title, '') || ' ' || COALESCE(work_items.summary, ''),` +
      ` '\\y((?:WI|EI|F|D)-[0-9]{2,20})\\y', 'g') WITH ORDINALITY AS m(match, ord)) mm` +
      ` ORDER BY mm.ref, mm.ord) d` +
      ` JOIN harness_shared.work_items w2` +
      ` ON w2.harness_slug = work_items.harness_slug AND w2.feature_id = d.ref` +
      ` ORDER BY d.ord LIMIT 6) t), '')`,
    // P-026: bumped from the implicit baseline 1 in the SAME edit that changed bodySql
    // above — that pairing IS the discriminator's contract. This is what makes the
    // ~36.6k already-vectorised rows stale and re-embeds them onto the new recipe
    // (~2.2h of sidecar); without it the expansion would improve only rows written
    // from now on, which is the exact defect P-026 exists to remove.
    recipeVersion: 2,
    keyCols: ['harness_slug', 'feature_id'],
    // P-006 (silent-intake-central-resolution-2026-09-01): the whole-corpus resolver
    // (work-items-admission-census.ts readCorpus) needs an embedding on every OPEN-LANE
    // row to compute its cosine edges — a row with no vector cannot be linked to any
    // twin by that leg at all, only by the lexical/condition-key nets. Missing coverage
    // there was measured at ~57% of open lane bugs at audit time, and a pure
    // `updated_ts DESC` order means an old, untouched-but-still-open item is starved
    // behind every recently-edited row in the 36k+ table-wide backlog — including rows
    // that are terminal/observation and irrelevant to dedup entirely.
    //
    // Boost exactly `corpusWhere`'s population (lane != observation AND not terminal —
    // the SAME predicate the census itself filters on, so this cannot drift from what
    // the resolver actually reads) ahead of the general recency order; ties (and every
    // row outside that population) fall back to the prior `updated_ts DESC` unchanged.
    // Backed by hfc_updated_idx (updated_ts DESC). bigint epoch-ms, not a timestamp.
    orderBySql:
      `(lane IS DISTINCT FROM 'observation' AND NOT harness_shared.work_item_status_is_terminal(status)) DESC,` +
      ` updated_ts DESC`,
    // NOT `updated_ts` — see recencyCol's doc. Ordering wants the cheapest index scan;
    // the 24h signal wants creation, or edit churn on old items masks a real regression.
    recencyCol: 'created_ts',
    recencyColKind: 'epochMs',
    readers: [
      // work_items:search's issue and feature legs and search:semantic's
      // work_item source read it as the chunk-aware leg's PARENT vector
      // (generic-rag-chunking P-011): the leg takes the vector column from
      // WORK_ITEMS_CHUNK_SURFACE.parentVector (search/chunks/registry.ts),
      // which registry.test.ts pins to this column.
      {
        file: 'packages/operator-core/lib/work-items.ts',
        evidence: ['WITH best AS (${chunkAwareVectorLegSql(handle, {', 'surface: { ...WORK_ITEMS_CHUNK_SURFACE, parent: opts.parent },'],
      },
      // search:semantic's work_item source reads the engineer_issues view over this table.
      {
        file: SEARCH_SOURCES_FILE,
        evidence: ['WITH best AS (${chunkAwareVectorLegSql(sql, {', 'surface: { ...WORK_ITEMS_CHUNK_SURFACE, parent: ENGINEER_ISSUES_CHUNK_PARENT },'],
      },
      {
        file: 'libs/generic/search/src/chunks/vector-leg.ts',
        evidence: ['(${sql.unsafe(parentVec)} <=> ${q}::vector) AS distance'],
      },
      // The duplicate guard compares whole items, so it stays on the parent
      // vector (D-005).
      {
        file: 'packages/operator-core/lib/agent-tools/work_items/semantic-dupe-guard.ts',
        evidence: ['ORDER BY embedding <=> ${vecLit}::vector'],
      },
    ],
  },
  // P-009 (shared-embedding-sidecar-and-enrichment-2026-07-10): documentation
  // sections. docs:search is filesystem-backed, so doc-embed-sync.ts mirrors
  // DocSource pages (the engineering tree incl. agent-insights runbooks,
  // project docs, harness docs) into migration 552's doc_sections — heading-
  // split, sha-keyed — and THIS entry vectorizes them so docs:search gains a
  // semantic leg. title carries "Page › Heading"; content is pre-capped at
  // sync time (the left() here is belt-and-braces).
  {
    table: 'harness_shared.doc_sections',
    embedCol: 'embedding',
    bodySql: `COALESCE(title, '') || E'\\n' || left(COALESCE(content, ''), 2000)`,
    keyCols: ['source_key', 'slug', 'anchor'],
    // No index on updated_at, but the table is ~6.4k rows — the sort is trivial.
    orderBySql: 'updated_at DESC',
    // doc_sections carries no created_at; rows are sha-keyed and re-synced, so
    // updated_at IS the write time for this surface.
    recencyCol: 'updated_at',
    recencyColKind: 'timestamptz',
    readers: [{
      file: 'packages/operator-core/lib/agent-tools/docs/semantic-leg.ts',
      evidence: ['FROM harness_shared.doc_sections', 'ORDER BY embedding <=> ${vecLit}::vector'],
    }],
  },
  // harness_shared.harness_docs is deliberately NOT a target: migration 1249
  // dropped its in-row embedding because nothing read it (generic-rag-chunking-
  // 2026-09-29 P-013 / D-025). Harness docs reach docs:search as doc_sections
  // rows under source_key harness:<slug> (D-007), synced on the sweep by
  // doc-embed-sync.ts, and are embedded by the doc_sections entry above.
  // P-010 (shared-embedding-sidecar-and-enrichment-2026-07-10): the plan
  // store (migration 553). plans:search gains a semantic leg and plans:new's
  // similar_exists token guard gains cosine confirmation — the token matcher
  // false-flagged topically-adjacent but distinct efforts.
  {
    table: 'harness_shared.harness_plans',
    embedCol: 'embedding',
    bodySql: `COALESCE(title, '') || E'\\n' || left(COALESCE(content, ''), 2000)`,
    keyCols: ['workspace_id', 'harness_slug', 'plan_slug'],
    recencyCol: 'created_at',
    recencyColKind: 'timestamptz',
    // The four readers D-026 (generic-rag-chunking-2026-09-29) measured.
    readers: [
      // plans:search reads it as the chunk-aware leg's PARENT vector (P-009):
      // the leg takes the parent table and vector column from
      // PLANS_CHUNK_SURFACE.parentVector (search/chunks/registry.ts), which
      // registry.test.ts pins to this column.
      {
        file: 'packages/operator-core/lib/agent-tools/plans/semantic-leg.ts',
        evidence: ['WITH best AS (${chunkAwareVectorLegSql(handle, {', 'AND (p.embedding <=> ${vecLit}::vector) <= b.distance + 1e-9)'],
      },
      {
        file: 'libs/generic/search/src/chunks/vector-leg.ts',
        evidence: ['(${sql.unsafe(parentVec)} <=> ${q}::vector) AS distance'],
      },
      // plans:new's duplicate guard and the two scout legs compare whole plans,
      // so they stay on the parent vector (D-005).
      {
        file: 'packages/operator-core/lib/agent-tools/plans/semantic-dedup.ts',
        evidence: ['SELECT plan_slug, 1 - (embedding <=> ${vecLit}::vector) AS similarity', 'FROM harness_shared.harness_plans'],
      },
      {
        file: 'packages/operator-core/lib/scout/semantic-novelty-leg.ts',
        evidence: ['SELECT plan_slug, 1 - (embedding <=> ${vecLit}::vector) AS similarity', 'FROM harness_shared.harness_plans'],
      },
      {
        file: 'packages/operator-core/lib/scout/intent-rank-leg.ts',
        evidence: ['SELECT plan_slug, 1 - (embedding <=> ${vecLit}::vector) AS similarity', 'FROM harness_shared.harness_plans'],
      },
    ],
  },
  // EI-19374072666153095: code_recipes and datatype_registry are BOTH in
  // PROSE_VECTOR_COLUMNS — so a width migration wipes them (`USING NULL`) — but
  // neither had a sweep entry here, and neither has any other re-embed path:
  // their only writers are UPSERTs using `COALESCE(EXCLUDED.embedding, <existing>)`
  // (code-recipes-store.ts / datatype-registry-store.ts), which store a vector
  // only when a caller supplies one. So the plan's "surfaces run lexical-only
  // until the sweep refills them" reasoning did NOT hold for these two: measured
  // 2026-08-02, migration 727 would have stranded 8,165 code_recipes vectors and
  // 8 datatype_registry vectors PERMANENTLY, degrading recipes:search's semantic
  // leg across its whole existing corpus rather than for the planned ~1h.
  //
  // Neither table has migration 530's `<embedCol>_mode` discriminator column.
  // That is handled, not ignored: runBackfillSweep probes information_schema per
  // target and passes `spaceAware: false` when the column is absent, so these
  // sweep correctly today. The cost is only that a FUTURE embedder-space change
  // cannot selectively re-embed them (WI-3616's concern) — tracked separately on
  // EI-19374072666153095 rather than bundled into a width migration.
  {
    table: 'harness_shared.code_recipes',
    embedCol: 'embedding',
    bodySql: `COALESCE(title, '') || E'\\n' || left(COALESCE(description, ''), 2000)`,
    keyCols: ['id'],
    // No index on created_at, but the table is ~9.1k rows — the sort is trivial.
    orderBySql: 'created_at DESC',
    recencyCol: 'created_at',
    recencyColKind: 'timestamptz',
    readers: [{
      file: 'packages/operator-core/lib/code-recipes-search.ts',
      evidence: ['FROM harness_shared.code_recipes', 'ORDER BY embedding <=> ${qVec}::vector'],
    }],
  },
  {
    table: 'harness_shared.datatype_registry',
    embedCol: 'embedding',
    bodySql: `COALESCE(title, '') || E'\\n' || left(COALESCE(description, ''), 2000)`,
    keyCols: ['workspace_id', 'id'],
    recencyCol: 'created_at',
    recencyColKind: 'timestamptz',
    readers: [{
      file: 'packages/operator-core/lib/datatype-registry-store.ts',
      evidence: ['FROM harness_shared.datatype_registry', '+ 0.6 * (1 - (embedding <=> ${embeddingLiteral}::vector)) END'],
    }],
  },
  // WI-39840 — the two columns migration 847 widened to the 768 prose contract.
  // They are in PROSE_VECTOR_COLUMNS, so a width migration WIPES them, and the
  // refill-coverage guard in prose-vector-dims.test.ts requires a target here.
  //
  // ⚠ THE "IT REFILLS ORGANICALLY" ARGUMENT IS ONLY HALF TRUE, WHICH IS WHY BOTH
  // ENTRIES EXIST. Both vectors are written once at row creation, so it is tempting
  // to conclude a wipe heals itself as rows churn. That holds for `interest_watches`
  // (a watch is short-lived and re-registered). It does NOT hold for `consult_state`:
  // the whole POINT of query_embedding is the ARCHIVE-FIRST lookup, which matches a
  // new question against PAST consults — and a past consult is never re-created, so a
  // wipe silently and permanently removes exactly the rows the column exists to serve.
  // The failure would present as "archive-first just never finds anything", with no
  // error anywhere. That is the guard's stated hazard, so it gets a real refill path.
  {
    table: 'harness_shared.consult_state',
    embedCol: 'query_embedding',
    // Same 2000-char convention as every other target (EI-12967): the sidecar
    // hard-rejects a single text over 32000 chars with an UNRETRYABLE 400, which
    // would re-select and re-fail the same row on every 5-minute tick forever.
    bodySql: `left(COALESCE(question, ''), 2000)`,
    keyCols: ['workspace_id', 'conversation_id'],
    recencyCol: 'created_at',
    recencyColKind: 'timestamptz',
    // generic-rag-chunking D-027: consult:get_feedback's archive-first serve ranks
    // by this vector alone (a duplicate decision); coord:orient's peersKnow fold
    // ranks by the nearer of this vector and the question's chunks (retrieve).
    readers: [
      {
        file: 'packages/operator-core/lib/consult/get-feedback-core.ts',
        evidence: ['FROM harness_shared.consult_state', 'ORDER BY query_embedding <=> ${qVecStr}::vector'],
      },
      {
        file: 'packages/operator-core/lib/consult/peers-know.ts',
        evidence: ['JOIN harness_shared.consult_state c', 'WITH best AS (${chunkAwareVectorLegSql(sql as unknown as PgHandle, {'],
      },
    ],
  },
  {
    table: 'harness_shared.interest_watches',
    embedCol: 'embedding',
    // A watch whose embedding is NULL cannot match at all — interest-watch.ts:369
    // throws rather than silently matching nothing — so refilling here also repairs
    // any watch left embedding-less by a widen, instead of leaving it permanently
    // inert until someone notices it never fires.
    bodySql: `left(COALESCE(interest, ''), 2000)`,
    keyCols: ['id'],
    recencyCol: 'created_at',
    recencyColKind: 'timestamptz',
    // The watch's own vector is the QUERY vector matched against new turns.
    readers: [{
      file: 'packages/operator-core/lib/events/await/interest-watch.ts',
      evidence: ['const qVec = row.embeddingText;', 'AND 1 - (text_embedding <=> ${qVec}::vector) >= ${row.simFloor}'],
    }],
  },
  // harness_shared.carry_notes is deliberately NOT a target: migration 1243
  // dropped note_embedding because nothing read it (generic-rag-chunking-2026-09-29
  // D-020). Carry notes are recovered by scope key and note_tsv. Re-add the column
  // and an entry here only together with a semantic reader.
  // harness_shared.coord_thread_posts is deliberately NOT a target either:
  // migration 1097 added body_embedding without wiring any query to it, and none
  // was ever added, so 1.1M vectors and a 4.3 GB HNSW index went unread.
  // Migration 1249 dropped them (generic-rag-chunking-2026-09-29 P-013 / D-025).
  // Thread posts stay findable lexically via body_tsv. As with carry notes,
  // re-add the column and an entry here only together with a reader.
];

/** A profile the prose storage can judge: the fields resolveProseProfileSelection reads. */
export type ProseBackfillProfile = Pick<EmbedderProfileSpec, 'profileId' | 'targetDims' | 'distanceMetric'>;

/**
 * Papercusp's settings for the shared backfill engine (D-004 hooks 11 and 12): the
 * resource-profile batch size, the prose column width and profile rules, the sidecar
 * text limit and the batch and row deadlines. One object, so a direct backfillTable
 * call and the sweep cannot drift apart.
 */
const PROSE_ENGINE_OPTIONS = {
  batchSize: BATCH_SIZE,
  acceptsWidth: fitsProseColumns,
  // The embedder's per-text limit (D-004 section 4). Every TARGETS bodySql already
  // caps free text with left(..., 2000), so this truncates nothing today; it stops a
  // future target without a cap from failing, and being retried, forever.
  maxInputChars: SIDECAR_MAX_TEXT_CHARS,
  resolveProfileSelection: (mode: string, profile: ProseBackfillProfile) =>
    resolveProseProfileSelection(mode, profile),
  batchChunkSize: BATCH_EMBED_CHUNK_SIZE,
  rowTimeoutMs: EMBED_ROW_TIMEOUT_MS,
  // The sidecar's own batch budget plus a margin, so the client's specific abort
  // surfaces before this outer race fires (EI-19464574865993243).
  batchTimeoutMs: (n: number) => sidecarBatchTimeoutMs(n) + EMBED_BATCH_OUTER_MARGIN_MS,
  logLabel: 'embed-backfill',
  storageLabel: 'shared prose storage',
} satisfies Partial<BackfillTableOptions<ProseBackfillProfile>>;

/** What a caller of papercusp's backfillTable supplies; PROSE_ENGINE_OPTIONS supplies the rest. */
export type ProseBackfillTableOptions = Omit<
  BackfillTableOptions<ProseBackfillProfile>,
  keyof typeof PROSE_ENGINE_OPTIONS | 'mode'
> & {
  /** The embedder that embed was built from; written to <embedCol>_mode. */
  mode: ResolvedMode;
};

/**
 * Backfill one target with papercusp's prose settings. maxRows defaults to four
 * batches (the WI-2905 per-call cap).
 *
 * Production goes through runBackfillSweep, which also applies the embedder
 * eligibility guard, the column probes and the overlap latch. Call this directly
 * only for a standalone target (the personal vault) or a test, never to raise a
 * sweep's row cap: pass maxRowsPerTarget to runBackfillSweep for that.
 */
export function backfillTable(
  sql: BackfillSql,
  target: BackfillTarget,
  options: ProseBackfillTableOptions,
): Promise<BackfillStats> {
  return backfillTableCore<ProseBackfillProfile>(sql, target, { ...PROSE_ENGINE_OPTIONS, ...options });
}

/**
 * How long a sweep may hold the latch before another tick treats it as dead.
 *
 * Deliberately about 4x the slowest HEALTHY sweep measured (873s and 918s on
 * 2026-08-03). Set it lower and the recovery runs a second sweep beside a healthy
 * one, which is the double-embedding the latch exists to prevent. It is a dead-holder
 * backstop, not a performance ceiling.
 */
const SWEEP_LATCH_STALE_MS = 60 * 60 * 1000;

/**
 * Default wall-clock budget for one routine sweep, sized to finish inside the
 * 5-minute DBOS tick. The batched sidecar path sustains about 8 rows/sec on real
 * bodies (D-008 corrected an earlier 16/sec figure measured on short synthetic
 * text), so about 1,600 rows per sweep.
 *
 * Soft on purpose: the deadline is checked between targets, never mid-batch, so a
 * sweep can overrun by up to one batch (a 90s budget returned at 130s). 200s plus a
 * worst-case ~70s overrun still lands inside the 300s tick.
 */
const SWEEP_BUDGET_MS = 200_000;

/**
 * The sweeper's latch state, pinned so a second module record (tsx's CJS preflight,
 * a relative-path import) shares ONE latch instead of running a concurrent sweep.
 * The library holds no module state; this is the only copy.
 */
const __sweepState: BackfillSweepState = pinModuleState<BackfillSweepState>(
  '@papercusp/operator-core.embedBackfillSweepState',
  createBackfillSweepState,
);

// These two shape upgrades MUST stay OUTSIDE the factory above. pinModuleState
// runs its factory only on FIRST create, so a state pinned by an older build (or by
// another module record mid-split) is handed back AS-IS; moving these inside the
// factory would silently stop upgrading exactly the stale shapes they exist for.
// Upgrade an older pinned shape (pre-WI-2905) in place.
if (typeof __sweepState.sweepCounter !== 'number') __sweepState.sweepCounter = 0;
// Upgrade a pre-WI-7327 pinned shape: an already-held latch has no start stamp,
// so date it now rather than leaving it immortal.
if (__sweepState.startedAt === undefined) {
  __sweepState.startedAt = __sweepState.running ? Date.now() : null;
}

/** Appended to the sweeper's width-skew refusal: what to fix in papercusp. */
const WIDTH_SKEW_HINT =
  'Cause is almost always a width migration that has not run (or ran partially) against ' +
  'THIS database; db:check_drift lists unapplied ones. Fix the SCHEMA; do NOT lower ' +
  'PROSE_VECTOR_DIMS to match, which would re-embed the corpus into a weaker space.';

/**
 * Papercusp's targets and hooks for the shared sweeper (D-004 sections 9-13). Exported
 * so the parity suite can drive the library sweeper directly with exactly this config;
 * production uses the one pinned sweeper below, through runBackfillSweep.
 */
export function proseBackfillSweeperConfig(
  state: BackfillSweepState,
): BackfillSweeperConfig<ProseBackfillProfile> {
  return {
    ...PROSE_ENGINE_OPTIONS,
    getTargets: () => TARGETS,
    getSql: () => getOrgPg().sql,
    resolveEmbedder: () => resolveBackfillEmbedder(),
    resolveBatchEmbed: (mode) => resolveBatchEmbed(mode as ResolvedMode),
    widthSkew: computeProseColumnWidthSkew,
    widthSkewHint: WIDTH_SKEW_HINT,
    budgetMs: SWEEP_BUDGET_MS,
    latchStaleMs: SWEEP_LATCH_STALE_MS,
    resolveTimeoutMs: EMBEDDER_RESOLVE_TIMEOUT_MS,
    state,
    // Read the clock through Date at call time, so fake timers in tests apply.
    now: () => Date.now(),
  };
}

const proseSweeper = createBackfillSweeper<ProseBackfillProfile>(proseBackfillSweeperConfig(__sweepState));

/**
 * Test seams for the pinned sweep state.
 *
 * Do NOT reach for globalThis[Symbol.for(...)] in a test: that targets the storage
 * LOCATION rather than this module's state, so it keeps compiling and silently
 * reads/resets NOTHING the moment the state moves (EI-19479108855357092).
 */
export function __sweepStateForTest(): BackfillSweepState {
  return __sweepState;
}

export function resetSweepStateForTest(): void {
  proseSweeper.resetForTest();
}

export function getLastBackfillResult(): BackfillStats[] | null {
  return proseSweeper.lastResult();
}

/** Options for a NON-ROUTINE sweep. The periodic scheduler passes none. */
export interface BackfillSweepOptions {
  /**
   * Per-target row ceiling for THIS sweep. Default: none; the time budget bounds a
   * routine sweep (P-005). It exists for BULK REFILL after a width or model change,
   * which drops every stored vector: about 500k rows re-embedded once, which the
   * routine shape would take 2-5 days to finish (EI-19375205903428632). An option
   * on the sweep, not a separate driver, so a refill inherits the embedder guard,
   * the column probes and the overlap latch. It does not buy extra token budget.
   */
  maxRowsPerTarget?: number;
  /** Wall-clock budget for the round-robin drain (default SWEEP_BUDGET_MS). */
  budgetMs?: number;
}

/**
 * Read every schema fact the sweep needs about one target in ONE catalog query,
 * judging its live width against the prose columns.
 */
export function inspectBackfillTarget(
  sql: BackfillSql,
  target: BackfillTarget,
): Promise<BackfillTargetInspection> {
  return inspectBackfillTargetCore(sql, target, computeProseColumnWidthSkew);
}

/**
 * Run one sweep across every target through the shared sweeper.
 *
 * Safe to call repeatedly: a call made while a sweep is in flight returns
 * { skipped: 'already_running' } and logs it (WI-7327: a silent skip made a healthy
 * mid-sweep skip and a wedged latch indistinguishable), and a latch held past
 * SWEEP_LATCH_STALE_MS is taken over.
 */
export async function runBackfillSweep(
  opts: BackfillSweepOptions = {},
): Promise<BackfillStats[] | { skipped: string }> {
  return proseSweeper.run(opts);
}

/**
 * Embed-backfill scheduling:
 *   - Initial sweep ~10s after boot (warm-up + catch any rows added
 *     while the process was down).
 *   - Periodic resweep on the DBOS schedule (periodic-workflows.ts,
 *     5 min). Each sweep scans `WHERE embedding IS NULL` so a write
 *     between sweeps is picked up on the next pass.
 *
 * We deliberately don't use LISTEN/NOTIFY for the streaming case: the
 * batch shape (BATCH_SIZE rows per pull) is hostile to per-row signals,
 * and the cadence here keeps embedder cost predictable.
 *
 * 5 min is fast enough that semantic search stays fresh for a
 * long-running server, slow enough that an empty sweep is cheap
 * (single SELECT per target table).
 */
async function _runSweepLogged(label: string): Promise<void> {
  // Step B2 (Tier-3 follow-up arc): battery-aware pause. Skip the
  // sweep when the device is on battery and below threshold; the
  // next periodic tick re-checks. Servers + AC-powered desktops
  // → always 'run'.
  try {
    const { shouldRun } = await import('./battery-policy');
    if (shouldRun() === 'pause') {
      console.log(
        `[embed-backfill] ${label} sweep skipped: on-battery + low-charge ` +
          `(set BATTERY_POLICY_OVERRIDE=always_run to disable, or lower ` +
          `BATTERY_POLICY_MIN_PCT)`,
      );
      return;
    }
  } catch {
    // battery-policy import failed — fall through to running the sweep.
  }

  try {
    const r = await runBackfillSweep();
    if (Array.isArray(r)) {
      const total = r.reduce((acc, s) => acc + s.embedded, 0);
      const scanned = r.reduce((acc, s) => acc + s.scanned, 0);
      const errors = r.reduce((acc, s) => acc + s.errors, 0);
      if (total > 0) {
        console.log(
          `[embed-backfill] ${label} sweep complete: ` +
            r.map((s) => `${s.table.split('.').pop()}=${s.embedded}/${s.scanned}`).join(' '),
        );
      } else if (scanned > 0 || errors > 0) {
        // WI-7327: a sweep that looked at rows and embedded NONE is a fault, not a
        // quiet success — it is what a code/schema width skew looks like (every
        // UPDATE rejected into the per-row catch). This used to print nothing, so
        // "healthy" and "totally broken" were byte-identical: silence.
        console.warn(
          `[embed-backfill] ${label} sweep embedded NOTHING (scanned=${scanned} errors=${errors}) — ` +
            r.filter((s) => s.scanned > 0 || s.errors > 0)
              .map((s) => `${s.table.split('.').pop()}=${s.embedded}/${s.scanned}(err${s.errors})`)
              .join(' '),
        );
      }
    } else if (r && typeof r === 'object' && 'skipped' in r) {
      // The skip path returns a non-array, which the branch above cannot log at all.
      console.log(`[embed-backfill] ${label} sweep skipped: ${r.skipped}`);
    }
  } catch (err) {
    console.warn(`[embed-backfill] ${label} sweep failed:`, (err as Error).message);
  }
}

/**
 * One periodic embed-backfill sweep (battery-aware + logged). Exposed for the
 * DBOS scheduled-workflow migration (dbos-durable-jobs-2026-05-31 Phase 2).
 */
export async function runEmbedBackfillOnce(): Promise<void> {
  // P-009: mirror doc sections into PG before the sweep so the doc_sections
  // target has rows to embed (once per process — see doc-embed-sync.ts).
  // Dynamic import keeps docs-engine out of this module's static graph.
  try {
    const { runDocSectionsSyncOnce } = await import('./doc-embed-sync');
    await runDocSectionsSyncOnce();
  } catch (err) {
    console.warn('[embed-backfill] doc-sections sync failed:', (err as Error).message);
  }
  // generic-rag-chunking P-013 (EI-24580496022910673): backfill every
  // registered harness's docs into doc_sections (source_key harness:<slug>) —
  // before this, only the write-time queue wrote them, so docs:search's
  // semantic leg had zero harness rows. Throttled inside; caught separately so
  // it can never cost the engineering sync or the sweep.
  try {
    const { runHarnessDocSectionsSweep } = await import('./doc-embed-sync');
    await runHarnessDocSectionsSweep();
  } catch (err) {
    console.warn('[embed-backfill] harness doc-sections sweep failed:', (err as Error).message);
  }
  // generic-rag-chunking P-004: derive chunk rows for every registered chunk
  // surface before the sweep, same reason — the chunk tables' targets need
  // rows to embed. That includes session turns since P-007 (their dedicated
  // session_turn_chunks store). Runs EVERY tick: its sources are
  // continuously-growing tables, not a process-lifetime memoized corpus.
  // Fail-open and independently caught, so a chunk-sync fault can never cost
  // the sweep its whole tick; it also logs and counts its own failures.
  try {
    const { runChunkSyncTick } = await import('./chunks/tick');
    await runChunkSyncTick();
  } catch (err) {
    console.warn('[embed-backfill] chunk sync failed:', (err as Error).message);
  }
  await _runSweepLogged('periodic');

  // Personal Vault D-001: a separate, bounded LOCAL-ONLY leg. It deliberately
  // rides this existing governed 5-minute tick instead of creating a scheduler,
  // but it never inherits the general prose embedder cascade (which can select
  // OpenAI). The personal module hard-pins EmbeddingGemma document mode and the
  // database rejects any non-gemma mode stamp.
  try {
    const { runPersonalVaultEmbedBackfillOnce } = await import('../personal-vault/embedding');
    const personal = await runPersonalVaultEmbedBackfillOnce();
    if ('embedded' in personal && personal.embedded > 0) {
      console.log(`[embed-backfill] personal vault=${personal.embedded}/${personal.scanned}`);
    }
  } catch (err) {
    console.warn('[embed-backfill] personal-vault sweep failed (non-fatal):', (err as Error).message);
  }

  // Memory write-journal drain (memory-write-journal-auto-recovery P-003):
  // replay memory writes parked during an embedder outage. Rides this tick
  // (plan D-002 — both drains want the embedder back). An on-battery pause
  // above only skips the SWEEP; the journal drain is small (≤25 rows/tick)
  // and deferring recovered facts is worse than the marginal battery cost.
  // Dynamic import keeps memory/ out of this module's static graph.
  try {
    const { drainMemoryWriteJournal } = await import('../memory/write-journal');
    const r = await drainMemoryWriteJournal();
    if (r.recovered > 0 || r.deduped > 0 || r.retriesExhausted > 0) {
      console.log(
        `[memory-journal] drain: recovered=${r.recovered} deduped=${r.deduped} ` +
          `exhausted=${r.retriesExhausted} stillPending=${r.stillPending}`,
      );
      // P-006 surfacing — recovery nudge + live settings-page refresh.
      const { notifyJournalRecovery } = await import('../memory/journal-surfacing');
      await notifyJournalRecovery(r);
    }
  } catch (err) {
    console.warn('[memory-journal] drain failed:', (err as Error).message);
  }

  // Canonical-memory vector backfill: a memory row with no vector in the ACTIVE
  // mode's table is invisible to semantic recall, and this is the only sweep that
  // can re-INSERT one from canonical text alone. Two ways a row gets here — a
  // memory projected from a peer hive lands as canonical TEXT with NO vector (the
  // wire carries none by design, EI-9308: "let each peer re-embed locally", and
  // the projection's raw-SQL upsert bypasses the only code that writes
  // memory_vec_* rows), and a vector WIPE — a width migration or a mode switch —
  // empties the active table for every row at once (WI-7326; the TARGETS sweep
  // above cannot help, it only UPDATEs rows that still exist). Rides this tick for
  // the same reason the journal drain does (both want the embedder back), with
  // the same bounded + non-fatal shape.
  try {
    const { backfillCanonicalMemoryVectors } = await import('../memory/canonical-vec-backfill');
    const r = await backfillCanonicalMemoryVectors();
    logMemoryVecOutcome(r);
  } catch (err) {
    console.warn('[memory-vec] backfill failed:', (err as Error).message);
  }
}

/** How often a HEALTHY idle sweep restates which table it is maintaining. */
export const MEMORY_VEC_IDLE_LOG_INTERVAL_MS = 60 * 60 * 1000;

let lastMemoryVecIdleLog: { at: number; target: string } = { at: 0, target: '' };

/** Test seam — reset the idle-log rate limiter. */
export function resetMemoryVecIdleLogState(): void {
  lastMemoryVecIdleLog = { at: 0, target: '' };
}

/**
 * Turn a memory-vec pass into an observable outcome.
 *
 * WHY THIS IS NOT JUST `if (embedded > 0)` (EI-19409840792445272): that condition
 * made THREE different states byte-identical and silent — healthy-idle, a predicate
 * matching nothing, and a disabled embedder. Only one of those is fine, and the
 * other two are total outages of semantic recall. Worse, no line anywhere named the
 * table being maintained, so "is this subsystem alive?" could not be answered from
 * logs at all; a zero in a NON-active mode's table reads exactly like a dead sweep,
 * which is precisely how it got misdiagnosed (twice) before this existed.
 *
 * The rules, in priority order:
 *  1. embedder disabled  -> LOUD, every tick. Recall reads no vector space at all.
 *  2. work happened      -> the normal line, now NAMING the target.
 *  3. zero yield + empty vector space + recallable rows exist -> LOUD, every tick.
 *     This cannot self-heal (the predicate matches nothing), so noise is correct.
 *  4. healthy idle       -> quiet, but restate the live target hourly AND
 *     immediately whenever it CHANGES — a mode switch is exactly when a human
 *     needs to know which table went live.
 */
export function logMemoryVecOutcome(
  r: import('../memory/canonical-vec-backfill').CanonicalVecBackfillResult,
  now: number = Date.now(),
  log: Pick<Console, 'log' | 'warn'> = console,
): void {
  if (r.skipped === 'embedder-disabled') {
    log.warn(
      '[memory-vec] DISABLED: no active embedder/vec table resolved — semantic memory recall ' +
        'is reading NO vector space, and nothing will backfill until an embedder is configured.',
    );
    return;
  }

  const target = r.table ? `${r.table} (mode=${r.mode})` : 'an unresolved target';

  if (r.embedded > 0 || r.failed > 0) {
    log.log(
      `[memory-vec] backfill: embedded=${r.embedded} failed=${r.failed} ` +
        `scanned=${r.scanned} into ${target} (failed rows retry next tick)`,
    );
    return;
  }

  if (r.zeroYield?.vectorSpaceEmpty && r.zeroYield.canonicalHasRows) {
    log.warn(
      `[memory-vec] TOTAL FAILURE: ${target} holds NO vectors while recallable canonical rows ` +
        'exist — semantic recall can return nothing. The backfill matched no rows, so this ' +
        'will NOT self-heal.',
    );
    return;
  }

  if (
    target !== lastMemoryVecIdleLog.target ||
    now - lastMemoryVecIdleLog.at >= MEMORY_VEC_IDLE_LOG_INTERVAL_MS
  ) {
    lastMemoryVecIdleLog = { at: now, target };
    log.log(`[memory-vec] idle: every recallable canonical row has a vector in ${target}`);
  }
}

// Legacy startEmbedBackfillWorker/stopEmbedBackfillWorker removed (consolidation
// P-005): DBOS owns the schedule (periodic-workflows.ts `embedBackfill`).
// `runEmbedBackfillOnce` above is the single-run tick that workflow calls.
