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

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
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
import { sidecarEmbedBatch, sidecarBatchTimeoutMs } from '@papercusp/memory';
import { buildSidecarAwareEmbedder, resolveProcessSidecarUrl } from '../memory/embed-sidecar-wiring';
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
  type ProseProfileSelection,
} from './prose-vector-dims';
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

/**
 * Bound a promise that must not be allowed to hang forever.
 *
 * `label` names the phase in the thrown error. It exists because this helper is
 * now used for two different phases, and an `embed_timeout_after_…` message on
 * a hung *resolver* would misdirect the next investigator to the row loop.
 */
function withEmbedTimeout<T>(
  p: Promise<T>,
  ms = EMBED_ROW_TIMEOUT_MS,
  label = 'embed',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}_timeout_after_${ms}ms`)), ms);
      // Never hold the process open on this timer alone.
      (timer as unknown as { unref?: () => void }).unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

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
  try {
    const url = await resolveProcessSidecarUrl(undefined, [EMBED_SIDECAR_CAP_EMBED]);
    if (!url) return null;
    return async (texts: string[]) => {
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
  } catch {
    return null;
  }
}

export interface BackfillStats {
  table: string;
  scanned: number;
  embedded: number;
  errors: number;
  durationMs: number;
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
    buildLocal: () => buildSidecarAwareEmbedder('local', 'document'),
    // Prose backfill is STORAGE, so EmbeddingGemma gets the document prompt.
    buildGemma: () => buildSidecarAwareEmbedder('gemma', 'document'),
    // Required by the cascade seam since P-014 made harrier selectable; the
    // sweep itself never STORES harrier vectors (native 1024 ≠ PROSE_VECTOR_DIMS
    // — the dims guard in runBackfillSweep skips the whole sweep), but an
    // unresolvable preference must not throw and kill the periodic tick.
    // Stated as the CONSTANT, not a literal width: migration 727 moves the prose
    // columns 384 → 768 and this comment used to name 384, which would have read
    // as "harrier is excluded because it is not 384" — true of the old width and
    // wrong about the reason. Harrier is excluded because 1024 ≠ the prose width,
    // whatever that width currently is.
    buildHarrier: () => buildSidecarAwareEmbedder('harrier', 'document'),
  });
}

// Exported for embed-space-self-check.ts (WI-3644): the self-check picks a
// row from one of these SAME prose surfaces to re-embed and compare.
export interface BackfillTarget {
  table: string;
  embedCol: string;
  bodySql: string;
  /**
   * PRIMARY KEY column(s) used to target the row's UPDATE.
   *
   * cost-audit-2026-06-29: this was `idCol?: 'ctid'` for 3 of the 4 tables. `ctid` is a PHYSICAL
   * row pointer that CHANGES on any UPDATE or (auto)VACUUM, which caused two bugs: (1) if a row's
   * ctid drifted between the SELECT and the `UPDATE … WHERE ctid=$` the update matched NOTHING, the
   * embedding stayed NULL, and the row was RE-EMBEDDED every 5-min sweep forever (token burn); and
   * (2) a ctid reused by a different row could write one row's embedding onto another (corruption).
   * Keying by the real PRIMARY KEY (stable, unique) eliminates both. These are the actual PKs:
   * operator_turns(id) · harness_escalations(harness_slug,phase) · harness_brainstorm(harness_slug,
   * phase) · harness_decisions(harness_slug,line_hash).
   */
  keyCols: string[];
  /**
   * P-005 — FRESHEST-FIRST drain order (`ORDER BY` body, without the keyword).
   *
   * Omitted ⇒ unordered, which is what every target used to be, and which is the
   * mechanism behind the plan's most misread measurement. An unordered
   * `WHERE embedding IS NULL LIMIT n` samples the backlog ARBITRARILY, so while a
   * table is mostly unembedded a newly-written row's chance of being picked is
   * ~its share of the backlog — i.e. new rows are covered at roughly the table's
   * OVERALL coverage, not at 100%. That is why 24h-new-row coverage read 7% while
   * the sweep was in fact draining faster than the table was being written: the
   * low figure measured the ORDERING, not the drain rate.
   *
   * Ordering newest-first inverts it: fresh rows are embedded within one sweep of
   * being written (searchable in minutes), and the historical backlog drains
   * underneath them. This is the difference between "semantic search works for
   * what I did this morning" and "semantic search works once a 13-day backlog
   * clears".
   *
   * ⚠ Name a column the table has an INDEX on where one exists — this drives a
   * backward index scan. Measured 2026-08-03 on the live 421k-row session_turns:
   * `ingested_at DESC` plans as `Index Scan Backward using session_turns_ingested_idx`,
   * 36ms for a 64-row batch. Without an index this becomes a full sort of the
   * whole backlog on EVERY batch.
   */
  orderBySql?: string;
  /**
   * WI-7469 (P-008) — the column recording when a row was WRITTEN, used only by the
   * coverage detector's 24h-new-row signal.
   *
   * Deliberately NOT derived by parsing `orderBySql`. The two answer different
   * questions and only usually coincide: `orderBySql` names whatever column gives the
   * cheapest freshest-first index scan (for work_items that is `updated_ts`), while
   * this must be a CREATION time or the signal silently changes meaning — a row created
   * two weeks ago and touched today is not a new row, and counting it as one would let a
   * regression on genuinely-new rows hide behind ordinary edit churn.
   *
   * OPTIONAL because two surfaces genuinely have no write-time column at all
   * (harness_escalations, harness_decisions). Their recent-coverage reads NULL —
   * absent, never zero, so a missing signal can never be mistaken for a breach.
   */
  recencyCol?: string;
  /**
   * How to compare `recencyCol` to now(). Both shapes are live in this schema and they
   * are not interchangeable — VERIFIED by measuring max() on each column rather than by
   * reading its declared type: `work_items.created_ts`, `operator_turns.created_at` and
   * `harness_brainstorm.updated_at` are all bigint EPOCH-MILLISECONDS (not seconds —
   * checked, because the wrong scale here yields a well-formed, plausible, wrong answer
   * rather than an error), while the rest are timestamptz.
   */
  recencyColKind?: 'timestamptz' | 'epochMs';
  /**
   * P-026 / D-087 — the version of the TEXT RECIPE (`bodySql`) this target
   * currently embeds. Bump it in the SAME edit that changes `bodySql`.
   *
   * `<embedCol>_mode` answers "which embedder produced this vector"; it says
   * nothing about WHICH TEXT went in. So editing a `bodySql` used to mark
   * nothing stale — only rows embedded after the edit got the new recipe, and
   * the already-vectorised population kept the old one forever, two recipes in
   * one column and indistinguishable at query time. That made every index-side
   * expansion unshippable, because it would have improved only future rows.
   *
   * OMITTED (or 1) ⇒ exactly today's behaviour. That is the point: introducing
   * this discriminator must re-embed NOTHING. Only a deliberate bump to 2+ makes
   * the existing population stale, and the sweep then converges the surface onto
   * the new recipe and goes quiet — the same converge-then-quiesce shape WI-3616
   * gave the embedder space.
   *
   * ⚠ A bump is expensive and per-target: re-embedding is ~0.22s/text, so
   * work_items (36.5k) ≈ 2.2h, session_turn_chunks (121k) ≈ 7.4h and
   * session_turns (296k) ≈ 18.1h. Bump the surface you measured, not all of them.
   *
   * The version is stored in a SIBLING `<embedCol>_recipe` column, never folded
   * into `<embedCol>_mode` — see `recipeColOf`.
   */
  recipeVersion?: number;
}

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

/** The column (migration 530) recording which embedder produced a row's vector. */
export function modeColOf(target: BackfillTarget): string {
  return `${target.embedCol}_mode`;
}

/** The exact embedding-space identity column added by migration 1154. Kept a
 * sibling of the legacy mode and text-recipe columns: profile identity answers
 * which vector space the numbers inhabit; neither of the older fields does. */
export function profileColOf(target: BackfillTarget): string {
  return `${target.embedCol}_profile`;
}

/**
 * The column (migration 777) recording which TEXT RECIPE produced a row's vector.
 *
 * ⚠ SIBLING COLUMN, NEVER A WIDENED `<embedCol>_mode` — this is the whole ruling
 * of D-087 and it is not stylistic. Folding a recipe token into the mode column
 * (`gemma#r2`) needs no migration and is ~5 lines, and it was built and measured
 * UNSAFE: `*_mode` is not private to the sweep. Four query-time readers
 * EQUALITY-match it — work-items.ts:1256 and :1318 (the work_item semantic leg),
 * plans/semantic-leg.ts:77, doc-section-overlap.ts:179 and :213 — so a composite
 * token matches ZERO rows there. Not an error: the semantic leg returns empty and
 * the corpus leg silently degrades to lexical-only, invisible to types and tests.
 * Prefix-matching it back out is not a rescue either (non-sargable on hot
 * per-query filters — a silent outage traded for a silent index regression).
 *
 * Two independent axes get two columns, so a recipe bump is visible to the sweep
 * and invisible to every query-time consumer BY CONSTRUCTION.
 */
export function recipeColOf(target: BackfillTarget): string {
  return `${target.embedCol}_recipe`;
}

/**
 * The recipe version a row with a NULL `<embedCol>_recipe` is understood to hold.
 *
 * A row embedded before migration 777 records no recipe, but it is not of
 * UNKNOWN recipe — it was produced by the `bodySql` in force at that time, which
 * is recipe 1 by definition. Reading NULL as 1 (rather than as "distinct from
 * everything") is what makes INTRODUCING the discriminator a no-op: at version 1
 * nothing is stale, so no surface is re-embedded merely because the column now
 * exists. Get this wrong and deploying the column alone costs ~28h of sidecar
 * across the corpus for zero change in what is embedded.
 */
export const BASELINE_RECIPE_VERSION = 1;

/**
 * The recipe version to enforce for this target, or null for "no recipe term".
 *
 * Null on BOTH of the two independent ways this can be inapplicable: the target
 * declares no `recipeVersion` (it has not opted in), or the database has no
 * `<embedCol>_recipe` column (migration 777 has not run, or ran only for the
 * surfaces that opted in — it is deliberately per-table). Either way the sweep
 * falls back to exactly its pre-777 predicate rather than throwing, mirroring how
 * `spaceAware` degrades for a database without migration 530.
 */
export function activeRecipeVersion(
  target: BackfillTarget,
  recipeColPresent: boolean,
): number | null {
  if (!recipeColPresent) return null;
  return target.recipeVersion ?? null;
}

/**
 * The rows this target can EVER embed — P-027's eligibility predicate.
 *
 * This is the exact filter `backfillTable`'s SELECT applies, factored out so the
 * coverage detector can share it rather than restate it. Sharing is the whole point:
 * `session_turns`' bodySql returns '' for turns under 80 chars, so 18.4% of that table
 * is excluded BY DESIGN and can never be embedded. A coverage alarm whose denominator
 * is the raw row count is therefore UNSATISFIABLE for that surface — it would sit red
 * forever, get muted, and be useless by the time it had something to say. A restated
 * copy of this predicate would drift the moment anyone edited a bodySql, which is the
 * same failure arriving later and more confusingly.
 */
export function eligiblePredicateSql(target: BackfillTarget): string {
  return `length(${target.bodySql}) > 0`;
}

/**
 * The rows the sweep still OWES work on — see the long note in `backfillTable` for why
 * this is about the vector's SPACE, not merely its presence (WI-3616).
 *
 * Factored out for the same reason as `eligiblePredicateSql`: coverage means "the sweep
 * has nothing left to do here", which is `eligible AND NOT stale`. Measuring it as
 * `embedCol IS NOT NULL` instead would OVER-REPORT after an embedder-space change —
 * every row would look covered while every query ranked against a foreign space as
 * noise, i.e. the detector would be blindest in precisely the incident it exists to catch.
 *
 * `modeExpr` is the SQL expression holding the ACTIVE embedder mode — a bind placeholder
 * ('$2') on the sweep's parameterised path, or a quoted literal from `quoteModeLiteral`.
 *
 * `recipeExpr` (P-026 / D-087) is the same for the active TEXT RECIPE version, and null
 * when the recipe term does not apply — see `activeRecipeVersion`. It is a SECOND,
 * independent reason a row can be stale: same embedder space, different input text. NULL
 * is read as `BASELINE_RECIPE_VERSION`, so a target at version 1 matches nothing extra and
 * introducing the discriminator re-embeds nothing.
 *
 * ⚠ Any caller that ACTS on this predicate must re-assert THIS SAME expression in its
 * write guard — see the UPDATE in `backfillTable`, which builds it from here rather than
 * restating it. A guard narrower than the selector is not a cosmetic mismatch: the row is
 * selected as stale, the UPDATE's WHERE matches nothing, the row stays stale, and the next
 * pull re-selects and re-embeds it forever. That is the ctid bug of cost-audit-2026-06-29
 * re-created through a different door, and it costs tokens silently.
 */
export function stalePredicateSql(
  target: BackfillTarget,
  spaceAware: boolean,
  modeExpr: string,
  recipeExpr: string | null = null,
  profile?: { profileExpr: string; legacyModeCompatible: boolean },
): string {
  // Once the exact identity column exists it is authoritative. A NULL profile
  // is accepted only as a rolling-upgrade legacy row whose mode names the
  // requested mode AND whose requested profile is that mode's declared current
  // profile (computed before this SQL is built). An alternate profile with the
  // same mode therefore cannot inherit the legacy rows.
  const spaceTerm = profile
    ? profile.legacyModeCompatible && spaceAware
      ? `(${target.embedCol} IS NULL OR NOT (` +
        `${profileColOf(target)} IS NOT DISTINCT FROM ${profile.profileExpr} OR ` +
        `(${profileColOf(target)} IS NULL AND ${modeColOf(target)} IS NOT DISTINCT FROM ${modeExpr})))`
      : `(${target.embedCol} IS NULL OR ${profileColOf(target)} IS DISTINCT FROM ${profile.profileExpr})`
    : spaceAware
      ? `(${target.embedCol} IS NULL OR ${modeColOf(target)} IS DISTINCT FROM ${modeExpr})`
      : `${target.embedCol} IS NULL`;
  if (recipeExpr === null) return spaceTerm;
  return (
    `(${spaceTerm} OR coalesce(${recipeColOf(target)}, ${BASELINE_RECIPE_VERSION})` +
    ` IS DISTINCT FROM ${recipeExpr})`
  );
}

/**
 * A boolean fragment selecting rows WRITTEN within `hoursExpr` hours of now, or null
 * when the target carries no write-time column.
 *
 * `hoursExpr` is a SQL expression (a bind placeholder on the caller's path) — the window
 * is never string-interpolated from a number.
 */
export function recentPredicateSql(target: BackfillTarget, hoursExpr: string): string | null {
  if (!target.recencyCol) return null;
  return target.recencyColKind === 'epochMs'
    ? `${target.recencyCol} >= (extract(epoch from now()) * 1000)::bigint - (${hoursExpr}::bigint * 3600000)`
    : `${target.recencyCol} >= now() - make_interval(hours => ${hoursExpr}::int)`;
}

/**
 * Rows written inside a SETTLED window: older than `graceMinExpr` minutes (so the sweep
 * has had time to reach them) and newer than `hoursExpr` hours.
 *
 * WHY BOTH BOUNDS — measured on live session_turns 2026-08-03T08:45Z, and this corrects
 * a defect in the first cut of the coverage detector, which alarmed on a single 24h
 * aggregate. Coverage by ingest hour was:
 *
 *     last 13 consecutive hours ......... 100.0%   <- the write path, healthy
 *     15:00 Aug 2 ........................ 85.7%   <- the drain front
 *     14:00 Aug 2 and earlier ....... 5.7-10.9%   <- the starved historical band
 *
 * A 24h window spans all three, averages them to 67.5%, and reports "new writes are NOT
 * being indexed" — which was FLATLY FALSE; new writes were at 100%. The aggregate
 * describes neither population. The young bound matters for the opposite reason: a row
 * written 30s ago is legitimately unembedded, because the sweep runs on a 5-minute tick.
 *
 * ⚠ KNOWN LIMIT, stated rather than hidden: immediately after a drain-policy change the
 * front can sit INSIDE the window, and coverage then reads low for real-but-transient
 * reasons. It self-corrects as the front advances past the window. The window is
 * therefore kept short enough that this is hours, not a day — but it is not zero, and a
 * reader seeing one breach during an active backfill should check the hourly
 * distribution before believing it.
 */
export function settledPredicateSql(
  target: BackfillTarget,
  graceMinExpr: string,
  hoursExpr: string,
): string | null {
  if (!target.recencyCol) return null;
  const col = target.recencyCol;
  return target.recencyColKind === 'epochMs'
    ? `(${col} <= (extract(epoch from now()) * 1000)::bigint - (${graceMinExpr}::bigint * 60000)` +
        ` AND ${col} >= (extract(epoch from now()) * 1000)::bigint - (${hoursExpr}::bigint * 3600000))`
    : `(${col} <= now() - make_interval(mins => ${graceMinExpr}::int)` +
        ` AND ${col} >= now() - make_interval(hours => ${hoursExpr}::int))`;
}

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
        evidence: ['JOIN harness_shared.consult_state c', 'WITH best AS (${chunkAwareVectorLegSql(handle, {'],
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

/**
 * WI-2905 fairness cap: max rows one table may consume in ONE sweep. Without it
 * the per-table `while(true)` drains until the DAILY budget exhausts, so the
 * first backlogged table in the order eats the whole day's tokens and every
 * later table gets 0 — session_turns' 70k-row backlog sat at 1 embedded row
 * while operator_turns burned the cap every day. 4 batches/table/sweep at a
 * 5-min cadence still clears ~48×BATCH_SIZE rows/table/day, but no table can
 * starve another; the daily cap now spreads across ALL targets.
 */
const MAX_ROWS_PER_TARGET_PER_SWEEP = BATCH_SIZE * 4;

/** Exported for unit tests (the WI-2905 per-sweep cap); production callers go
 *  through runBackfillSweep, which supplies this from its own
 *  `maxRowsPerTarget` option — the fairness cap by default, or a bulk-refill
 *  ceiling when a width/model change has dropped every stored vector. Do not
 *  call this directly from production code just to raise the cap: going through
 *  the sweep is what applies the embedder-eligibility guard, the column probes
 *  and the overlap guard.
 *
 *  `mode` is the embedder that `embed` was built from. When the target carries a
 *  `<embedCol>_mode` column (migration 530), rows whose recorded space differs from
 *  `mode` are RE-EMBEDDED, not skipped — see the WI-3616 note on `spaceAware`.
 *  Pass `spaceAware: false` for a database where 530 hasn't been applied yet.
 *
 *  `opts.recipeColPresent` (P-026 / D-087) is the analogous probe result for
 *  migration 777's `<embedCol>_recipe`. It is the SCHEMA half only — the target's
 *  own `recipeVersion` is the other half, and both must hold before the recipe
 *  term applies (`activeRecipeVersion`). Defaults false, i.e. exactly the
 *  pre-777 behaviour, so no existing caller changes meaning. An options object
 *  rather than an eighth positional: this signature already carries six
 *  positional knobs and the next one would be past the point where call sites
 *  are readable. */
export async function backfillTable(
  sql: Sql,
  target: BackfillTarget,
  embed: (t: string) => Promise<number[]>,
  maxRows: number = MAX_ROWS_PER_TARGET_PER_SWEEP,
  mode: ResolvedMode = 'openai',
  spaceAware = true,
  embedMany?: EmbedManyFn,
  opts: {
    recipeColPresent?: boolean;
    profileColPresent?: boolean;
    profile?: Pick<EmbedderProfileSpec, 'profileId' | 'targetDims' | 'distanceMetric'>;
  } = {},
): Promise<BackfillStats> {
  const started = Date.now();
  const stats: BackfillStats = {
    table: target.table,
    scanned: 0,
    embedded: 0,
    errors: 0,
    durationMs: 0,
  };
  const keyCols = target.keyCols;
  // Select each PK column as k0, k1, … so the UPDATE can target the exact row by PK (not ctid).
  const keySelect = keyCols.map((c, i) => `${c} AS k${i}`).join(', ');
  const modeCol = modeColOf(target);
  let profileSelection: ProseProfileSelection | null = null;
  if (opts.profileColPresent) {
    if (!opts.profile) {
      throw new Error(
        `profile-aware prose target ${target.table}.${target.embedCol} requires an exact embedding profile`,
      );
    }
    profileSelection = resolveProseProfileSelection(mode, opts.profile);
    if (!profileSelection) {
      throw new Error(
        `profile ${opts.profile.profileId} is incompatible with shared prose storage; refusing ${target.table}.${target.embedCol}`,
      );
    }
  }
  const profileAware = profileSelection !== null;
  // P-026: the recipe version to enforce, or null when this target/database has no
  // recipe discriminator. Resolved ONCE — the SELECT, the UPDATE's SET and the UPDATE's
  // re-asserted guard must all agree on it or the sweep cannot converge.
  const recipeVersion = activeRecipeVersion(target, opts.recipeColPresent === true);
  const recipeAware = recipeVersion !== null;

  // Postgres derives a statement's parameter COUNT from the highest $n it references,
  // and rejects a Bind that supplies a parameter the statement never uses ("could not
  // determine data type of parameter $n"). So each optional discriminator's placeholder
  // — and therefore the PK offset after them — exists only when that discriminator is
  // live. Never bind a parameter without using it. Allocating positions here (rather
  // than writing literals like `$3`) is what keeps the two optional terms independent:
  // with two of them the fixed-offset form has four cases, and the two that appear only
  // on an un-probed database are exactly the ones no test would cover.
  //
  // SELECT layout: $1 batch size · [mode] · [profile] · [recipe] · failure offset.
  let sn = 1;
  const selModeExpr = spaceAware ? `$${++sn}` : 'NULL';
  const selProfileExpr = profileAware ? `$${++sn}` : null;
  const selRecipeExpr = recipeAware ? `$${++sn}` : null;
  const selOffsetExpr = `$${++sn}`;
  // UPDATE layout: $1 vector · [mode] · [profile] · [recipe] · PK columns.
  let un = 1;
  const updModeExpr = spaceAware ? `$${++un}` : 'NULL';
  const updProfileExpr = profileAware ? `$${++un}` : null;
  const updRecipeExpr = recipeAware ? `$${++un}` : null;
  const updateKeyOffset = un + 1;
  const whereKeys = keyCols.map((c, i) => `${c} = $${i + updateKeyOffset}`).join(' AND ');
  const setClauses = [`${target.embedCol} = $1::vector`];
  if (spaceAware) setClauses.push(`${modeCol} = ${updModeExpr}`);
  if (profileAware) setClauses.push(`${profileColOf(target)} = ${updProfileExpr}`);
  if (recipeAware) setClauses.push(`${recipeColOf(target)} = ${updRecipeExpr}`);
  // The write guard is BUILT FROM the staleness predicate, never a hand-restated copy of
  // it. A guard narrower than the selector silently un-converges the sweep: the row is
  // selected as stale, the UPDATE matches no row, the row stays stale, and every
  // subsequent pull re-selects and re-embeds it — burning tokens forever with nothing to
  // show in the stats. Sharing the builder makes that class unrepresentable.
  const updateSql =
    `UPDATE ${target.table}` +
    `\n   SET ${setClauses.join(', ')}` +
    `\n WHERE ${whereKeys}` +
    `\n   AND ${stalePredicateSql(
      target,
      spaceAware,
      updModeExpr,
      updRecipeExpr,
      profileAware
        ? {
            profileExpr: updProfileExpr!,
            legacyModeCompatible: profileSelection!.legacyMode === mode,
          }
        : undefined,
    )}`;
  const discriminatorParams = [
    ...(spaceAware ? [mode] : []),
    ...(profileAware ? [profileSelection!.profileId] : []),
    ...(recipeAware ? [recipeVersion] : []),
  ];

  /**
   * WI-3616 — "which rows still need embedding?" is a question about the vector's
   * SPACE, not merely its presence.
   *
   * This predicate used to be `embedCol IS NULL`. But `memoryEmbedderMode` picks the
   * embedder at runtime, and the same pref drives the QUERY vector. Flip it and every
   * previously-stored vector silently belongs to a foreign space: still 384-D, still
   * non-null, so the old predicate skipped them forever while queries ranked against
   * them as noise. A column that went mixed could never self-heal.
   *
   * Selecting `mode IS DISTINCT FROM <active>` (NULL-safe: pre-530 rows have mode NULL
   * ⇒ unknown ⇒ stale ⇒ re-embed) makes the sweep converge the whole column onto the
   * active space, then go quiet. `IS DISTINCT FROM` — not `<> ` — because `NULL <> 'local'`
   * is NULL, which would silently match nothing and reintroduce the original bug.
   */
  const stale = stalePredicateSql(
    target,
    spaceAware,
    selModeExpr,
    selRecipeExpr,
    profileAware
      ? {
          profileExpr: selProfileExpr!,
          legacyModeCompatible: profileSelection!.legacyMode === mode,
        }
      : undefined,
  );

  // Loop until nothing is stale — OR until a full batch makes ZERO progress (every row failed to
  // embed). Without the zero-progress break, a row whose embed PERSISTENTLY fails (e.g. every
  // request 429s during a quota outage, or an over-long body 400s) stays stale and is re-SELECTed
  // by the next `WHERE … LIMIT` pull, spinning this `while(true)` forever and re-burning
  // tokens. Breaking on no-progress bounds the sweep and lets the next 5-min tick retry. (cost-audit-2026-06-29.)
  // P-005: rows that FAIL to embed stay stale, so with a stable ORDER BY they sit
  // at the head of the next pull and get re-selected forever, re-burning a slot in
  // every batch. Successful rows need no cursor — embedding one removes it from the
  // `stale` predicate, so the queue self-advances. Only failures need skipping, and
  // OFFSET by the running failure count skips exactly them (stable order ⇒ the
  // failed rows are precisely the first `failedSoFar` still-matching rows).
  //
  // Deliberately NOT a value-cursor on the order column: session_turns' ordering
  // key has ties, and a `< lastSeen` cursor would silently skip every row sharing
  // the boundary timestamp on EVERY sweep — a permanent, invisible recall hole.
  // OFFSET cannot skip a row that is making progress.
  let failedSoFar = 0;
  // Once per target per call — a per-batch warning would be its own noise problem.
  let warnedBatchFallback = false;
  const orderBy = target.orderBySql ? ` ORDER BY ${target.orderBySql}` : '';
  while (stats.scanned < maxRows) {
    const wantRows = Math.min(BATCH_SIZE, maxRows - stats.scanned);
    // All PK columns here are text/uuid and the body is text → every selected value is a string.
    const batch = await sql.unsafe<Array<Record<string, string>>>(
      `SELECT ${keySelect}, (${target.bodySql}) AS body
         FROM ${target.table}
        WHERE ${stale}
          AND ${eligiblePredicateSql(target)}${orderBy}
        LIMIT $1 OFFSET ${selOffsetExpr}`,
      [wantRows, ...discriminatorParams, failedSoFar],
    );
    if (!batch.length) break;

    // P-005 THROUGHPUT: embed the whole batch in ONE sidecar call when the caller
    // supplied a batch embedder. The sidecar has always accepted `texts[]` (its own
    // `sidecarEmbedBatch` docstring names embed-backfill as the intended consumer),
    // but every call site in the tree passed a 1-element array, so the amortization
    // was never taken. Measured 2026-08-03 against the live :3384 gemma sidecar:
    // 75ms for a single-text request vs 59ms/row for a 32-text request — plus one
    // HTTP round-trip instead of BATCH_SIZE of them.
    //
    // Falls back to the per-row path on ANY batch failure rather than failing the
    // rows: a batch call is all-or-nothing at the sidecar, so one oversized/bad row
    // would otherwise take its whole batch down with it. The per-row retry isolates
    // the offender and lets the other 63 succeed.
    let batchVectors: Array<number[] | null> | null = null;
    if (embedMany && batch.length > 1) {
      // Chunked, NOT one call for the whole batch — see BATCH_EMBED_CHUNK_SIZE for
      // the measurement. Partial progress is retained per INDEX, so a chunk that
      // breaches costs only its own rows, which then take the per-row path below.
      const texts = batch.map((r) => r.body);
      const acc: Array<number[] | null> = new Array<number[] | null>(texts.length).fill(null);
      let anyChunkOk = false;
      for (let off = 0; off < texts.length; off += BATCH_EMBED_CHUNK_SIZE) {
        const slice = texts.slice(off, off + BATCH_EMBED_CHUNK_SIZE);
        // A lone trailing row IS the per-row path — batching it buys nothing and
        // would pay a second deadline for the same work.
        if (slice.length < 2) break;
        try {
          // The outer bound must never be TIGHTER than the sidecar client's own,
          // or it pre-empts the inner deadline and the specific error is lost.
          // That inversion is what hid EI-19464574865993243: this race was set to
          // a deliberate 90s and could never fire, because the client aborted at
          // its single-embed default of 15s first. Both now derive from
          // sidecarBatchTimeoutMs; the margin keeps the inner one firing first.
          // Both are sized for THIS CHUNK, so the two stay in step.
          const vecs = await withEmbedTimeout(
            embedMany(slice),
            sidecarBatchTimeoutMs(slice.length) + EMBED_BATCH_OUTER_MARGIN_MS,
            'embed_batch',
          );
          if (vecs.length !== slice.length) {
            // A length mismatch is a CONTRACT breach, not a transient failure, and
            // silently falling back would hide it forever.
            console.warn(
              `[embed-backfill] batch embed returned ${vecs.length} vectors for ` +
                `${slice.length} texts (${target.table}) — falling back to per-row`,
            );
            break;
          }
          for (let j = 0; j < vecs.length; j++) acc[off + j] = vecs[j];
          anyChunkOk = true;
        } catch (err) {
          // NEVER swallow this silently. A batch path that always throws and always
          // falls back is byte-identical, from the outside, to one that is working:
          // same rows embedded, same counts, just ~N× slower. That is precisely the
          // "two states are indistinguishable because one of them is silent" shape
          // this file has been burned by twice (WI-7327, WI-7348) — and it bit THIS
          // change during its own verification, where `batch-embed enabled` printed
          // while the per-row path did all the work.
          if (!warnedBatchFallback) {
            warnedBatchFallback = true;
            console.warn(
              `[embed-backfill] batch embed FAILED for ${target.table}, using the ` +
                `per-row path (slower). First error: ${(err as Error).message}`,
            );
          }
          // Stop batching for the REST of this pull. A breach means the sidecar is
          // currently slower than the budget allows, so the next chunk would buy an
          // identical timeout at the same price; the remaining rows fall through to
          // the per-row path, which has its own per-row deadline.
          break;
        }
      }
      // Only claim batch results if at least one chunk actually produced vectors —
      // an all-null array would otherwise read as "batching worked" while every row
      // silently took the per-row path.
      batchVectors = anyChunkOk ? acc : null;
    }

    let embeddedThisBatch = 0;
    let failedThisBatch = 0;
    for (const [i, row] of batch.entries()) {
      stats.scanned += 1;
      try {
        // WI-7327: BOUND the embed. This await is the one place a sweep can hang
        // forever — the embedder cascade ends in a `fetch` to the :3384 sidecar or an
        // HTTP API, and neither carries its own deadline here. A hang holds the
        // `running` latch (see runBackfillSweep) and wedges ALL future sweeps, which
        // is exactly how 451k rows sat unembedded for hours. Rejecting instead lets
        // the existing per-row catch count it as an error and move on.
        const vec = batchVectors?.[i] ?? (await withEmbedTimeout(embed(row.body)));
        if (!fitsProseColumns(vec.length)) {
          stats.errors += 1;
          failedThisBatch += 1;
          continue;
        }
        const keyVals = keyCols.map((_, i) => row[`k${i}`]);
        // Target by PRIMARY KEY + re-assert the staleness guard: a row a concurrent sweep
        // already brought into the active space is left alone, and we never clobber a row
        // that changed underneath us. The vector, its space and its text recipe are
        // written together, so a row can never claim a space or a recipe it isn't in.
        await sql.unsafe(updateSql, [`[${vec.join(',')}]`, ...discriminatorParams, ...keyVals]);
        stats.embedded += 1;
        embeddedThisBatch += 1;
      } catch {
        stats.errors += 1;
        failedThisBatch += 1;
      }
    }
    // Skip this batch's failures on the next pull (see the failedSoFar note above).
    failedSoFar += failedThisBatch;
    // No row in this batch embedded → the remaining stale rows are persistent failures. Stop, else
    // we re-SELECT and re-attempt the same stuck rows forever (and re-spend on each).
    if (embeddedThisBatch === 0) break;
  }

  stats.durationMs = Date.now() - started;
  return stats;
}

// Sweep state pinned to globalThis (perf rule A18, audit P-010): under tsx /
// dual-path imports a module can be instantiated more than once, and a
// module-scoped `running` flag then no longer dedupes concurrent sweeps.
interface SweepState {
  running: boolean;
  lastResult: BackfillStats[] | null;
  /** WI-2905: per-sweep rotation offset — which target leads THIS sweep. */
  sweepCounter: number;
  /**
   * WI-7327: when the in-flight sweep took the `running` latch, or null when idle.
   *
   * The latch used to be a bare boolean reset only in a `finally`. A sweep that
   * THROWS reaches that finally; a sweep that HANGS never does — and because the
   * state is pinned to globalThis, nothing would ever clear it. Stamping the start
   * time lets a later tick decide the holder is dead and take over.
   *
   * Calibrate against SWEEP_LATCH_STALE_MS's note: healthy sweeps really do run
   * 14-15 minutes, so "still running" is the normal case, not a fault.
   */
  startedAt: number | null;
}
/**
 * How long a sweep may hold the latch before another tick treats it as dead.
 *
 * ⚠ CALIBRATION MATTERS MORE THAN IT LOOKS — set this too low and the "recovery"
 * runs a SECOND sweep concurrently with a perfectly healthy one, which is the
 * exact double-embedding the latch exists to prevent. A HEALTHY full sweep here
 * is minutes, not seconds: measured 2026-08-03 on the real backlog, consecutive
 * successful sweeps took 873s (14.5min) and 918s (15.3min) — ten targets × up to
 * MAX_ROWS_PER_TARGET_PER_SWEEP rows × a ~0.3-4s local embed each. A 15-minute
 * ceiling would have fired on BOTH of those.
 *
 * So this is deliberately ~4× the slowest observed healthy sweep. It is a
 * dead-holder backstop, not a performance ceiling: a sweep still running at 60
 * minutes is not slow, it is gone.
 */
const SWEEP_LATCH_STALE_MS = 60 * 60 * 1000;
const __sweepState: SweepState = pinModuleState<SweepState>(
  '@papercusp/operator-core.embedBackfillSweepState',
  () => ({ running: false, lastResult: null, sweepCounter: 0, startedAt: null }),
);

// ⚠ These two shape upgrades MUST stay OUTSIDE the factory above. `pinModuleState`
// runs its factory only on FIRST create, so a state pinned by an older build (or by
// another module record mid-split) is handed back AS-IS — moving these inside the
// factory would silently stop upgrading exactly the stale shapes they exist for.
// Upgrade an older pinned shape (pre-WI-2905) in place.
if (typeof __sweepState.sweepCounter !== 'number') __sweepState.sweepCounter = 0;
// Upgrade a pre-WI-7327 pinned shape: an already-held latch has no start stamp,
// so date it now rather than leaving it immortal.
if (__sweepState.startedAt === undefined) {
  __sweepState.startedAt = __sweepState.running ? Date.now() : null;
}

/**
 * Test seams for the pinned sweep state.
 *
 * Do NOT reach for `globalThis[Symbol.for(...)]` in a test: that targets the storage
 * LOCATION rather than this module's state, so it keeps compiling and silently
 * reads/resets NOTHING the moment the state moves (EI-19479108855357092).
 */
export function __sweepStateForTest(): SweepState {
  return __sweepState;
}

export function resetSweepStateForTest(): void {
  __sweepState.running = false;
  __sweepState.lastResult = null;
  __sweepState.sweepCounter = 0; // WI-2905 rotation offset — deterministic order per test
  __sweepState.startedAt = null;
}

export function getLastBackfillResult(): BackfillStats[] | null {
  return __sweepState.lastResult;
}

/**
 * Run a single sweep across all 3 surfaces.
 *
 * Returns per-table stats. Safe to call repeatedly — the second call
 * exits immediately if a sweep is already in flight.
 */
/**
 * Options for a NON-ROUTINE sweep. The periodic scheduler always calls
 * `runBackfillSweep()` with no arguments and therefore keeps the WI-2905
 * fairness cap — nothing about the routine path changes.
 *
 * `maxRowsPerTarget` exists for BULK REFILL after a width/model change, which is
 * a fundamentally different job from the steady-state trickle. A migration that
 * changes the prose vector width necessarily drops every stored vector (pgvector
 * cannot cast between widths), so ~500k rows must be re-embedded ONCE, as fast as
 * the embedder allows — whereas the fairness cap is tuned to dribble a backlog out
 * over days without letting one table monopolize the shared budget. Applying the
 * routine cap to a refill makes it cap-bound at 2-5 DAYS for session_turns alone
 * (~413k rows at 4 batches/sweep on a 5-min cadence — EI-19375205903428632), with
 * semantic search degraded to lexical-only for the whole window.
 *
 * This is deliberately an OPTION on the existing sweep rather than a separate
 * bulk-refill driver: a standalone driver would have to re-implement embedder
 * resolution, the org pool, the vector-extension probe, the per-target column
 * probes, `spaceAware` detection and the per-target error isolation — i.e. fork
 * the whole sweep. Threading one number inherits all of it, including the
 * `__sweepState.running` guard that keeps a refill from overlapping the periodic
 * sweep, and the rotation that keeps progress fair across targets when a refill
 * is run as repeated passes.
 */
export interface BackfillSweepOptions {
  /**
   * Per-target row ceiling for THIS sweep. Defaults to the WI-2905 fairness cap.
   * The daily token budget still applies and is still shared, so this raises the
   * per-sweep ceiling — it does not buy extra budget. Safe for a LOCAL embedder
   * space (gemma on the :3384 sidecar), which costs wall time but no API tokens.
   */
  maxRowsPerTarget?: number;
  /**
   * P-005 — wall-clock budget for the whole round-robin drain (default
   * SWEEP_BUDGET_MS). This, not a row ceiling, is what bounds a routine sweep now.
   *
   * A TIME bound is the right shape because the thing actually being rationed is
   * shared embedder capacity, and a row ceiling expresses that only if you already
   * know the per-row cost — which varies by body length, model and host load. A
   * budget self-adjusts: a fast host drains more rows in the same window.
   */
  budgetMs?: number;
}

export interface BackfillTargetInspection {
  readonly exists: boolean;
  readonly spaceAware: boolean;
  readonly profileColPresent: boolean;
  readonly recipeColPresent: boolean;
  readonly widthSkew: ReturnType<typeof computeProseColumnWidthSkew>;
}

/** Read every schema fact the sweep needs in ONE catalog query. Extracted so
 * the live-width refusal is integration-testable against real PostgreSQL and
 * so the probe cannot drift into a second, subtly different query. */
export async function inspectBackfillTarget(
  sql: Pick<Sql, 'unsafe'>,
  target: BackfillTarget,
): Promise<BackfillTargetInspection> {
  const c = await sql.unsafe<Array<{ column_name: string; dims: number | null }>>(
    `SELECT col.column_name, a.atttypmod AS dims
       FROM information_schema.columns col
       LEFT JOIN pg_namespace n ON n.nspname = col.table_schema
       LEFT JOIN pg_class pc ON pc.relnamespace = n.oid AND pc.relname = col.table_name
       LEFT JOIN pg_attribute a
         ON a.attrelid = pc.oid AND a.attname = col.column_name AND NOT a.attisdropped
      WHERE col.table_schema = split_part($1, '.', 1)
        AND col.table_name   = split_part($1, '.', 2)
        AND col.column_name  IN ($2, $3, $4, $5)`,
    [target.table, target.embedCol, modeColOf(target), profileColOf(target), recipeColOf(target)],
  );
  const cols = new Set(c.map((r) => r.column_name));
  const liveDims = c.find((r) => r.column_name === target.embedCol)?.dims;
  return {
    exists: cols.has(target.embedCol),
    spaceAware: cols.has(modeColOf(target)),
    profileColPresent: cols.has(profileColOf(target)),
    recipeColPresent: cols.has(recipeColOf(target)),
    widthSkew:
      liveDims === null || liveDims === undefined
        ? []
        : computeProseColumnWidthSkew([
            { table: target.table, column: target.embedCol, dims: Number(liveDims) },
          ]),
  };
}

/**
 * Default wall-clock budget for one routine sweep.
 *
 * Sized to finish INSIDE the 5-minute DBOS tick so the cadence is clean and a
 * tick rarely finds the latch held. Measured 2026-08-03: the batched sidecar path
 * sustains ~8 rows/sec on REAL bodies, so a 200s budget moves ~1,600 rows/sweep —
 * well above the old 4-batch ceiling, and enough that session_turns' ~320k eligible
 * backlog drains in hours rather than the ~13 days the ceiling implied.
 *
 * ⚠ CORRECTED (plan D-008): an earlier revision of this comment said ~16 rows/sec.
 * That figure came from a synthetic probe on SHORT text and does not survive contact
 * with the corpus — embedding cost scales with body length (~100 chars 59ms · 386
 * chars 124ms · ~1,900 chars 431ms), and a real 32-row batch averages 386 chars at
 * 124 ms/row. Left in place because the mistake is instructive: throughput measured
 * on synthetic text is not throughput, and the error was optimistic by 2× in the one
 * direction that makes a backfill look affordable.
 *
 * ⚠ THIS IS A SOFT BUDGET and deliberately so: the deadline is checked BETWEEN
 * targets, never mid-batch, so a sweep can overrun by up to one `backfillTable`
 * call (≤ BATCH_SIZE rows). Measured on the first live run: a 90s budget returned
 * at 130s. Interrupting mid-batch would mean abandoning rows already embedded but
 * not yet written, so overrunning is the correct trade — the number just has to
 * leave room for it. 200s + a worst-case ~70s overrun still lands inside the
 * 300s tick; a tick that does arrive early is harmless (the latch makes it skip).
 */
const SWEEP_BUDGET_MS = 200_000;

export async function runBackfillSweep(
  opts: BackfillSweepOptions = {},
): Promise<BackfillStats[] | { skipped: string }> {
  // P-005: NO row ceiling by default. The old default was the WI-2905 fairness cap
  // (4 batches/target/sweep), which is precisely the starvation this item removes —
  // fairness now comes from the round-robin rotation, and the bound is `budgetMs`.
  // An explicit `maxRowsPerTarget` still works, for a caller that genuinely wants a
  // row ceiling (bulk-refill sizing, tests).
  const maxRowsPerTarget = opts.maxRowsPerTarget ?? Number.MAX_SAFE_INTEGER;
  const budgetMs = opts.budgetMs ?? SWEEP_BUDGET_MS;
  // WI-7327: the latch is TIME-BOXED, and every refusal is LOUD.
  //
  // The LOUD half is the one that was actually costing us, and the story is
  // worth keeping because it burned an investigation. A healthy sweep here runs
  // for MINUTES (measured 14.5min and 15.3min on 2026-08-03), so the 5-min tick
  // legitimately finds one in flight and skips — correct, intended behaviour.
  // But the skip returned a non-array that `_runSweepLogged` could not log, so
  // it printed NOTHING. A healthy mid-sweep skip and a genuinely wedged latch
  // were therefore indistinguishable from the outside: both just silence and a
  // ~265ms tick. That ambiguity led to a wrong "the backfill is wedged"
  // diagnosis and an unnecessary bg-host restart. Saying which one is happening
  // costs one log line.
  //
  // The TIME-BOX is a backstop for the case that diagnosis wrongly assumed: a
  // sweep that hangs never reaches the `finally` that clears `running`, and the
  // state is pinned to globalThis, so nothing else would ever clear it.
  if (__sweepState.running) {
    const heldMs = __sweepState.startedAt === null ? 0 : Date.now() - __sweepState.startedAt;
    if (heldMs < SWEEP_LATCH_STALE_MS) {
      console.log(
        `[embed-backfill] skipped: a sweep has held the latch for ${Math.round(heldMs / 1000)}s ` +
          `(stale at ${SWEEP_LATCH_STALE_MS / 1000}s)`,
      );
      return { skipped: 'already_running' };
    }
    // Past the ceiling the holder is not slow, it is gone: no sweep legitimately
    // runs this long. Take the latch rather than defer to a corpse forever.
    console.warn(
      `[embed-backfill] STALE LATCH: previous sweep has held it for ${Math.round(heldMs / 1000)}s ` +
        `(> ${SWEEP_LATCH_STALE_MS / 1000}s) and is presumed hung — taking over. ` +
        `If this repeats, the per-row embed is hanging (WI-7327).`,
    );
  }
  __sweepState.running = true;
  __sweepState.startedAt = Date.now();
  try {
    // WI-7348: say we STARTED, before the first thing that can hang.
    //
    // WI-7327 removed the ambiguity for the SKIP path; this removes it for the
    // RUN path. Without this line a sweep that hangs in resolution is byte-for-byte
    // indistinguishable from one that was never called: both are silence. Elapsed
    // time cannot separate them either — a healthy sweep here legitimately runs
    // 14.5-15.3min (measured, WI-7327) — so silence was the only signal, and it
    // meant nothing.
    console.log('[embed-backfill] sweep starting: resolving embedder…');
    const resolved = await withEmbedTimeout(
      resolveBackfillEmbedder(),
      EMBEDDER_RESOLVE_TIMEOUT_MS,
      'embedder_resolve',
    );
    // `dims` lives only on the non-disabled arms of the union, and this line runs
    // BEFORE the `mode === 'disabled'` check narrows it — so probe for it rather
    // than assuming it. A disabled resolve legitimately has no width to report.
    console.log(
      `[embed-backfill] embedder resolved: mode=${resolved.mode} ` +
        `dims=${'dims' in resolved ? resolved.dims : 'n/a'}`,
    );
    // Skip entirely when disabled OR when the active embedder's dims don't fit
    // the prose columns. Without this guard an ineligible preference would burn
    // a full batch of embeds per table per tick just to count every row as a
    // dims-mismatch error.
    //
    // Who is ineligible (PROSE_ELIGIBLE_MODES): harrier, native 1024 with no
    // MRL — the long-standing case; and since D-005, `local` too — bge-small is
    // natively 384 and cannot emit the 768 the columns now hold. A `local`
    // preference therefore leaves prose lexical-only rather than re-embedding
    // the whole column into a weaker space, which is what used to happen.
    if (resolved.mode === 'disabled' || !fitsProseColumns(resolved.dims)) {
      __sweepState.lastResult = TARGETS.map((t) => ({
        table: t.table,
        scanned: 0,
        embedded: 0,
        errors: 0,
        durationMs: 0,
      }));
      return __sweepState.lastResult;
    }
    const mode: ResolvedMode = resolved.mode;
    const embed = resolved.embed;
    // P-005 throughput: one sidecar call per BATCH instead of one per ROW. Null is a
    // normal outcome (no sidecar, or the OpenAI leg) and simply keeps the per-row path.
    const embedMany = await resolveBatchEmbed(mode);
    if (embedMany) console.log(`[embed-backfill] batch-embed enabled (mode=${mode})`);
    // Shared org pool (audit P-010, EI-119/EI-80): the old shape opened a
    // fresh `pg.Client` per sweep — connection churn every 5 minutes, and the
    // `pg` dependency was the "require is not defined" failure mode that
    // silently stopped embeddings.
    const { sql } = getOrgPg();
    // Probe vector extension; if missing, exit silently.
    const ext = await sql.unsafe<Array<{ extname: string }>>(
      `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    );
    if (!ext.length) {
      __sweepState.lastResult = TARGETS.map((t) => ({
        table: t.table, scanned: 0, embedded: 0, errors: 0, durationMs: 0,
      }));
      return __sweepState.lastResult;
    }

    // WI-2905 fairness: ROTATE which target leads each sweep. Combined with the
    // per-target row cap, no single backlogged table can monopolize the shared
    // daily embed budget: if the budget exhausts mid-sweep, the table that paid
    // the price differs every tick, so every target drains over the day. Results
    // are re-ordered back to the canonical TARGETS order below for stable logs.
    const offset = __sweepState.sweepCounter % TARGETS.length;
    __sweepState.sweepCounter += 1;
    const rotated = [...TARGETS.slice(offset), ...TARGETS.slice(0, offset)];

    const byTable = new Map<string, BackfillStats>();
    // P-005: probe each target ONCE (schema facts don't change mid-sweep), then
    // drain round-robin below. The probe used to sit inside the same loop that did
    // the draining, which is what forced the drain to be "one target to completion,
    // then the next" — the shape that let the first backlogged table in the order
    // consume the whole sweep.
    const live: Array<{
      target: BackfillTarget;
      spaceAware: boolean;
      profileColPresent: boolean;
      recipeColPresent: boolean;
    }> = [];
    for (const target of rotated) {
      try {
        // Column existence probe; skip if migration 061 hasn't run. The same probe
        // reports whether migration 530's `<embedCol>_mode` discriminator exists —
        // without it the sweep must fall back to the legacy NULL-only predicate
        // (an older DB still backfills; it just can't self-heal a space switch) —
        // and, since P-026, whether migration 777's `<embedCol>_recipe` does. 777 is
        // deliberately per-table (only the surfaces that opted in have the column),
        // so "absent" here is the ORDINARY case, not a mis-migrated database: it
        // degrades that target to the pre-777 predicate rather than throwing.
        //
        // Widening this IN-list adds no round-trip. That matters more than it looks:
        // the note below explains why a separate probe call would have been the wrong
        // shape, and the same reasoning is why the recipe column rides along here.
        //
        // WI-7327: it ALSO returns each column's LIVE width (`pg_attribute.atttypmod`,
        // which for pgvector IS the dimension — no varchar-style +4). That is the
        // live-schema half of the width contract, and it is folded into THIS query
        // rather than a separate probe deliberately: an extra `sql.unsafe` call
        // ahead of an existing one silently shifts every positional mock in the
        // sibling test file, a trap this repo has paid for before.
        const inspection = await inspectBackfillTarget(sql, target);
        if (!inspection.exists) {
          byTable.set(target.table, { table: target.table, scanned: 0, embedded: 0, errors: 0, durationMs: 0 });
          continue;
        }
        // WI-7327: the column EXISTS but is the wrong width — the state that
        // caused 9.5h of silent total failure. `fitsProseColumns` above cannot
        // see it: it compares the embedder to the CONSTANT, and in this state
        // both agree. Every UPDATE here would be rejected by pgvector and
        // swallowed by the per-row catch, yielding a sweep that reports zero work
        // and logs nothing. Refuse the target LOUDLY instead of burning a batch
        // of embeds per tick to rediscover it.
        //
        // An UNMEASURED width (null — no matching pg_attribute row) is
        // unjudgeable, never skew: absence of evidence must not become a false
        // total-failure alarm.
        if (inspection.widthSkew.length > 0) {
          const s = inspection.widthSkew[0]!;
          console.error(
            `[embed-backfill] SCHEMA WIDTH SKEW — refusing ${s.table}.${s.column}: it is ` +
              `vector(${s.liveDims}) but this code emits ${s.declaredDims}. Every write would be ` +
              `rejected by pgvector and counted as a per-row error, so the sweep would report zero ` +
              `work and log nothing — the silent total-failure shape of WI-7327. Cause is almost ` +
              `always a width migration that has not run (or ran partially) against THIS database; ` +
              `db:check_drift lists unapplied ones. Fix the SCHEMA — do NOT lower PROSE_VECTOR_DIMS ` +
              `to match, which would re-embed the corpus into a weaker space.`,
          );
          byTable.set(target.table, { table: target.table, scanned: 0, embedded: 0, errors: 0, durationMs: 0 });
          continue;
        }
        live.push({
          target,
          spaceAware: inspection.spaceAware,
          profileColPresent: inspection.profileColPresent,
          recipeColPresent: inspection.recipeColPresent,
        });
        byTable.set(target.table, {
          table: target.table, scanned: 0, embedded: 0, errors: 0, durationMs: 0,
        });
      } catch (err) {
        byTable.set(target.table, {
          table: target.table,
          scanned: 0,
          embedded: 0,
          errors: 1,
          durationMs: 0,
        });
        console.warn(`[embed-backfill] ${target.table} failed: ${(err as Error).message}`);
      }
    }

    /*
     * P-005 ROUND-ROBIN DRAIN — the fairness cap is replaced by a TIME budget.
     *
     * The old shape gave each target a hard ceiling of 4 batches per sweep. That
     * ceiling was set without reference to any table's WRITE rate, so a table
     * written faster than 4×BATCH_SIZE per sweep could never converge, no matter
     * how much idle capacity the embedder had. session_turns is exactly that table.
     *
     * Round-robin instead: every live target gets ONE batch per round, and rounds
     * repeat until everything is drained or the budget expires. Fairness is now a
     * property of the ROTATION (no target waits more than one round for a turn)
     * rather than of a ceiling, so no table is capped below its own write rate
     * while the budget lasts, and a drained table simply drops out and stops
     * costing anything.
     *
     * A target that embeds ZERO rows in its round is treated as drained FOR THIS
     * SWEEP. That covers both "nothing left to do" and "everything left is a
     * persistent failure" — backfillTable's own zero-progress break already
     * distinguishes them, and re-attempting a persistently failing target every
     * round would burn the whole budget on rows that cannot succeed.
     */
    const deadline = Date.now() + budgetMs;
    const drained = new Set<string>();
    const consumed = new Map<string, number>();
    let rounds = 0;
    while (live.length > drained.size && Date.now() < deadline) {
      rounds += 1;
      for (const { target, spaceAware, profileColPresent, recipeColPresent } of live) {
        if (drained.has(target.table)) continue;
        if (Date.now() >= deadline) break;
        const used = consumed.get(target.table) ?? 0;
        if (used >= maxRowsPerTarget) {
          drained.add(target.table);
          continue;
        }
        try {
          const s = await backfillTable(
            sql,
            target,
            embed,
            Math.min(BATCH_SIZE, maxRowsPerTarget - used),
            mode,
            spaceAware,
            embedMany ?? undefined,
            { recipeColPresent, profileColPresent, profile: resolved.profile },
          );
          consumed.set(target.table, used + s.scanned);
          const acc = byTable.get(target.table)!;
          acc.scanned += s.scanned;
          acc.embedded += s.embedded;
          acc.errors += s.errors;
          acc.durationMs += s.durationMs;
          if (s.embedded === 0) drained.add(target.table);
        } catch (err) {
          const acc = byTable.get(target.table)!;
          acc.errors += 1;
          drained.add(target.table);
          console.warn(`[embed-backfill] ${target.table} failed: ${(err as Error).message}`);
        }
      }
    }
    if (rounds > 0) {
      const elapsed = Math.round((Date.now() - (deadline - budgetMs)) / 1000);
      console.log(
        `[embed-backfill] drain: ${rounds} round(s) in ${elapsed}s ` +
          `(budget ${Math.round(budgetMs / 1000)}s) · drained ${drained.size}/${live.length} target(s)` +
          (drained.size < live.length ? ' · budget expired with work remaining' : ''),
      );
    }
    // Canonical TARGETS order regardless of this sweep's rotation.
    const results: BackfillStats[] = TARGETS.map((t) => byTable.get(t.table)!);
    __sweepState.lastResult = results;
    return results;
  } finally {
    __sweepState.running = false;
    __sweepState.startedAt = null;
  }
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
