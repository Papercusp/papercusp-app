/**
 * canonical-vec-backfill.ts — give every RECALLABLE canonical memory row a
 * vector in the ACTIVE mode's vec table, so semantic recall can actually see it.
 *
 * WHY THIS EXISTS (EI-10405, federated half). mem0-cross-machine-federation-2026-07-10
 * federates memory TEXT only: the wire deliberately carries no vectors (EI-9308 —
 * "federate the memory TEXT ... and let each peer RE-EMBED LOCALLY", because two
 * hives can run different embedder modes and their vector spaces aren't
 * comparable). The receive side never built that re-embed leg:
 * `projections/p2p-memories.ts` writeToPg upserts `memory_canonical` with raw SQL,
 * bypassing `CanonicalVectorStore.insert` — the ONLY writer of `memory_vec_*`
 * rows. So a projected row arrives with canonical text and NO vector in any mode,
 * while recall's primary path (`CanonicalVectorStore.search`) JOINs
 * `memory_vec_<active>` and therefore can never return it.
 *
 * ⚠ SCOPE WAS WIDENED FROM FEDERATED-ONLY TO ALL ROWS — WI-7326. Read this before
 * re-narrowing it.
 *
 * This sweep used to filter `source_hive IS NOT NULL`. The stated reason was:
 * "Local rows missing a vector in the active mode are the residue of embedder-MODE
 * SWITCHES, and those belong to the user-initiated re-embed pass
 * (POST /api/user/memory/reembed) ... Federated rows have no such path — NOTHING
 * ELSE WILL EVER EMBED THEM."
 *
 * That last clause is the real discriminator, and migration 727 falsified it for
 * local rows. A pgvector column cannot be cast between widths, so the 384->768
 * widening necessarily discards every stored vector; for `memory_vec_gemma` /
 * `memory_vec_openai` — join tables whose row exists SOLELY to carry the vector,
 * with `vector` NOT NULL — the only expressible widening is to DELETE the rows and
 * let them be re-INSERTed (see 727's PASS 4 and EI-19404620261958999). That is a
 * SAME-MODE wipe, and no path repaired it:
 *
 *   - `reembedMemories` throws `reembed_noop_same_mode` when from === to, and
 *     otherwise selects `FROM memory_canonical JOIN <fromTable>` — it can only
 *     copy an EXISTING vector from another mode's table, never rebuild a mode
 *     from text alone.
 *   - `embed-backfill`'s TARGETS sweep only ever runs `UPDATE <table> SET <col>`
 *     over rows that already exist. 727 deleted the rows, so an empty vec table
 *     stays empty forever — a TARGETS entry here is structurally inexpressible.
 *   - this sweep matched `source_hive IS NOT NULL`, and the live corpus is
 *     32,641 rows with ZERO federated (measured 2026-08-03).
 *
 * ⚠ CORRECTION 2026-08-03: an earlier revision of this docblock concluded from the
 * above that "workspace semantic recall silently degraded to lexical-only." THAT
 * WAS FALSE and is retracted. 727 wiped `memory_vec_gemma` / `memory_vec_openai`,
 * but NEITHER is the active mode: recall runs on `harrier` (native-1024, the P-015
 * default), whose table held 32,772 vectors against 32,772 canonical rows — 0
 * missing, filling continuously since 2026-07-11. Recall never degraded, because
 * `activeVecTable()` reads and writes ONLY the active mode's table. A zero in a
 * NON-active mode's table is the correct, expected steady state and must not be
 * read as an outage (fact `memory-vec-gemma-zero-is-correct-not-a-failure`).
 *
 * The widening is still right, for the LATENT reason rather than an actual one:
 * 727 left gemma/openai not merely empty but STRUCTURALLY UNREBUILDABLE — per the
 * three bullets above, no path can refill an empty vec table from canonical text.
 * Under the old federated-only predicate, selecting either mode would have pointed
 * recall at a permanently empty space with nothing able to repair it. This sweep is
 * the only text-to-vector rebuild path there is, so it must not be scoped away from
 * local rows. That applies the exclusion's OWN criterion ("nothing else will ever
 * embed them") to a case its author had no reason to foresee, rather than
 * overriding the decision.
 *
 * ON THE QUOTA CONCERN the old scope existed to protect: it is real but small, and
 * it is bounded by BATCH rather than by which rows are eligible. The catch-up is
 * one-time and then converges to zero — steady state is an empty sweep. For a
 * local sidecar mode (gemma/local) the compute is free; for `openai` the whole
 * 3,854-row live backlog is ~200k tokens ≈ $0.004 at text-embedding-3-small
 * rates. The eager, progress-reporting /reembed route still exists for a user who
 * wants a mode switch completed NOW instead of over the next few ticks.
 *
 * SHAPE — mirrors the memory write-journal drain, which rides the same 5-min
 * embed-backfill tick (`search/embed-backfill.ts` runEmbedBackfillOnce): bounded
 * per pass, non-fatal, and SELF-HEALING — a row without a vector is simply picked
 * up again next tick, so an embedder outage (sidecar down, quota cooldown) delays
 * recall instead of losing it permanently.
 *
 * WHY NOT EMBED INLINE IN THE PROJECTION: writeToPg runs inside the hyperbee
 * apply loop. A per-row network embed (~100ms-6s, and the sidecar can be
 * down/quota-cooled) would stall the apply pipeline for EVERY federated table,
 * and a failed inline embed would leave that row permanently unrecallable with
 * nothing to retry it. The cost of doing it here instead: recall lags federation
 * by at most one tick.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeVecTable, embedAndUpsertVector } from '@papercusp/memory';

type Sql = ReturnType<typeof getOrgPg>['sql'];

/**
 * Rows embedded per pass — bounds embedder pressure (this sweep competes with
 * live traffic for the embedder), mirroring the journal drain's DRAIN_BATCH.
 *
 * 100, raised from 25 with the WI-7326 widening. 25 was sized for a federated
 * TRICKLE (a few projected rows per tick); the widened sweep must also absorb a
 * cold start — a width migration or a mode switch leaves the whole corpus
 * unvectored at once, and at 25/tick the live 3,854-row backlog would take ~13h
 * of lexical-only recall to clear. At ~217ms/doc (727's measured rate) 100
 * sequential embeds is ~22s of a 300s tick: under 8% duty cycle, still leaving
 * the embedder free for live traffic, and it clears that backlog in ~3.2h.
 * Sequential — see backfillCanonicalMemoryVectors.
 */
const BATCH = (() => {
  const v = Number(process.env.PAPERCUSP_MEMORY_VEC_BACKFILL_BATCH);
  return Number.isFinite(v) && v > 0 ? v : 100;
})();

export interface CanonicalMemoryRow {
  id: string;
  data: string;
}

export interface CanonicalVecBackfillResult {
  scanned: number;
  embedded: number;
  failed: number;
  /** Set when the pass did no work BY CONSTRUCTION (embedding is off) — distinct
   *  from an honest empty sweep, which reports scanned:0 with no `skipped`. */
  skipped?: 'embedder-disabled';
  /**
   * The ACTIVE mode + table this pass resolved, whenever one resolved at all.
   *
   * Reported UNCONDITIONALLY (not just when work happened) because "which table
   * is this sweep actually maintaining?" is otherwise answerable only by reading
   * code — and getting it wrong is the documented failure mode: a zero in a
   * NON-active mode's table reads exactly like a dead subsystem (EI-19409840792445272,
   * and see fact `memory-vec-gemma-zero-is-correct-not-a-failure`).
   */
  mode?: string;
  table?: string;
  /**
   * Only computed on the ZERO-YIELD path (scanned === 0), where the counts alone
   * are ambiguous: an honest idle sweep and a predicate that matches nothing are
   * both {scanned:0, embedded:0, failed:0}. Two cheap EXISTS probes separate them.
   *
   * `vectorSpaceEmpty && canonicalHasRows` is the unambiguous total-failure state:
   * rows exist that SHOULD have vectors, and the space recall reads holds none.
   */
  zeroYield?: {
    vectorSpaceEmpty: boolean;
    canonicalHasRows: boolean;
  };
}

export interface CanonicalVecBackfillDeps {
  sql?: Sql;
  resolveVecTable?: typeof activeVecTable;
  selectRows?: (sql: Sql, schema: string, vecTable: string, limit: number) => Promise<CanonicalMemoryRow[]>;
  embed?: (memoryId: string, text: string) => Promise<boolean>;
  limit?: number;
  probeZeroYield?: typeof probeZeroYield;
}

/**
 * Canonical memory rows with no vector in the ACTIVE mode's vec table — i.e. the
 * rows semantic recall currently cannot see, whether they arrived by federation
 * or were written here.
 *
 * ⚠ There is deliberately NO `source_hive` predicate — see the module docblock
 * (WI-7326). Re-adding one silently strands every local row after any same-mode
 * vector wipe, with no error and no log line.
 *
 * Guards mirror the canonical store's own reads (`canonical-store.ts`
 * search/list): entity rows (mem0's linking rows, identified by `entityType`) and
 * archived rows are never memories to recall, and a row with empty text has
 * nothing to embed.
 *
 * `vecTable` comes from the memory lib's FIXED mode->table lookup (never caller
 * input), so interpolating it as an identifier is safe; `limit` is bound.
 */
export async function selectRowsMissingVectors(
  sql: Sql,
  schema: string,
  vecTable: string,
  limit: number,
): Promise<CanonicalMemoryRow[]> {
  const rows = await sql.unsafe(
    `SELECT c.id::text AS id, c.payload->>'data' AS data
       FROM ${schema}.memory_canonical c
      WHERE NOT (c.payload ? 'entityType')
        AND c.state != 'archived'
        AND coalesce(c.payload->>'data', '') != ''
        AND NOT EXISTS (
              SELECT 1 FROM ${schema}.${vecTable} v WHERE v.memory_id = c.id)
      ORDER BY c.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows as unknown as CanonicalMemoryRow[];
}

/**
 * Disambiguate a ZERO-YIELD sweep: is there genuinely nothing to do, or does the
 * predicate match nothing while recall reads an empty vector space?
 *
 * Both states report `{scanned:0, embedded:0, failed:0}`, so counts alone cannot
 * tell them apart — and the second is a total outage. Two EXISTS probes settle it:
 *
 *   - `vectorSpaceEmpty`   — the table recall JOINs holds NO rows at all.
 *   - `canonicalHasRows`   — rows exist that SHOULD have a vector. The guards
 *                            MIRROR `selectRowsMissingVectors` exactly (minus its
 *                            NOT EXISTS), so this means "recallable", not merely
 *                            "some row somewhere".
 *
 * Both true = unambiguous total failure. `EXISTS` short-circuits on the first row,
 * so neither probe scans the table, and this only runs on the zero-yield path.
 *
 * ⚠ Do NOT "simplify" either probe to `count(*)`: on a 32k-row table that turns a
 * free check into a full scan every idle tick, which is how a diagnostic gets
 * deleted for being expensive — and then the silence comes back.
 */
export async function probeZeroYield(
  sql: Sql,
  schema: string,
  vecTable: string,
): Promise<{ vectorSpaceEmpty: boolean; canonicalHasRows: boolean }> {
  const rows = await sql.unsafe(
    `SELECT NOT EXISTS (SELECT 1 FROM ${schema}.${vecTable}) AS vector_space_empty,
            EXISTS (
              SELECT 1 FROM ${schema}.memory_canonical c
               WHERE NOT (c.payload ? 'entityType')
                 AND c.state != 'archived'
                 AND coalesce(c.payload->>'data', '') != ''
            ) AS canonical_has_rows`,
  );
  const row = (rows as unknown as Array<{ vector_space_empty: boolean; canonical_has_rows: boolean }>)[0];
  return {
    vectorSpaceEmpty: Boolean(row?.vector_space_empty),
    canonicalHasRows: Boolean(row?.canonical_has_rows),
  };
}

/**
 * One bounded pass: embed memories that recall can't see yet.
 *
 * Sequential by design — the embedder sidecar is a shared, saturable resource
 * (a parallel burst is what starved it in the WI-4196 incident), and this is a
 * background pass with no latency budget.
 */
export async function backfillCanonicalMemoryVectors(
  deps: CanonicalVecBackfillDeps = {},
): Promise<CanonicalVecBackfillResult> {
  const resolveVecTable = deps.resolveVecTable ?? activeVecTable;
  const selectRows = deps.selectRows ?? selectRowsMissingVectors;
  const embed = deps.embed ?? embedAndUpsertVector;
  const limit = deps.limit ?? BATCH;

  // No active vec table = embedding is off. Recall reads no vector space at all,
  // so there is nothing to backfill INTO — skip rather than guess a table.
  const active = await resolveVecTable();
  if (!active) return { scanned: 0, embedded: 0, failed: 0, skipped: 'embedder-disabled' };

  const sql = deps.sql ?? getOrgPg().sql;
  const rows = await selectRows(sql, active.schema, active.table, limit);

  // Zero-yield is AMBIGUOUS by construction — an honest idle sweep and a
  // predicate that matches nothing are both scanned:0. Resolve it here, where
  // the schema/table are already known, so the caller can log the difference
  // instead of staying silent for both (EI-19409840792445272). Two EXISTS
  // probes, only on this path: free on a working system.
  if (rows.length === 0) {
    let zeroYield: CanonicalVecBackfillResult['zeroYield'];
    try {
      zeroYield = await (deps.probeZeroYield ?? probeZeroYield)(sql, active.schema, active.table);
    } catch {
      // A probe failure must never turn a healthy sweep into a failed one — the
      // caller simply loses the idle/failure distinction for this tick.
      zeroYield = undefined;
    }
    return {
      scanned: 0,
      embedded: 0,
      failed: 0,
      mode: active.mode,
      table: active.table,
      zeroYield,
    };
  }

  let embedded = 0;
  let failed = 0;
  for (const row of rows) {
    // embedAndUpsertVector is non-fatal BY CONTRACT (returns false, never
    // throws), but the seam is injectable — a throwing impl must not abort the
    // pass and strand the remaining rows. A failed row keeps its missing vector
    // and is retried on the next tick.
    let ok = false;
    try {
      ok = await embed(row.id, row.data);
    } catch {
      ok = false;
    }
    if (ok) embedded++;
    else failed++;
  }

  return { scanned: rows.length, embedded, failed, mode: active.mode, table: active.table };
}
