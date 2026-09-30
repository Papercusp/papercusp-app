/**
 * The width of the SHARED prose embedding columns — one constant, imported by
 * every site that reads or writes them.
 *
 * WHY THIS FILE EXISTS. `384` used to be restated in SEVEN places
 * (embed-backfill, agent-tools/search/embedder, memory/configure, the plans /
 * docs / work-items semantic legs, and three scout legs). Six of them carried
 * a comment saying "= embed-backfill's EMBEDDER_DIM" and then wrote the number
 * out again — which is exactly the failure mode D-001 of
 * prose-embedding-384-untrained-mrl-fix-2026-08-02 names: "a declaration that
 * can drift from the code it describes is just a second docblock". D-001 fixed
 * the BUILDER side (the embedders derive their target from
 * `EMBEDDER_DIM_SPECS`); this fixes the STORAGE side.
 *
 * ⚠ THIS IS A STORAGE FACT, AND IT IS DELIBERATELY *NOT* DERIVED FROM
 * `EMBEDDER_DIM_SPECS`. It states what the database columns actually are, as
 * created by their migration. Deriving it from the embedder declaration would
 * be strictly worse than restating it: editing a model's `targetDims` would
 * silently move the code's idea of the column width with no migration behind
 * it, and the first symptom would be either a pgvector INSERT failure in a
 * background sweep or — worse — a dims guard that agrees with itself and skips
 * every surface, which looks exactly like "embedding is disabled".
 *
 * The two ARE required to agree; that agreement is asserted by
 * `prose-vector-dims.test.ts`, so a model width change WITHOUT its migration
 * reds a unit test instead of failing in production. That is the whole point:
 * the constant is independent, the agreement is enforced.
 *
 * TO CHANGE THIS WIDTH you need all three, together, in one change:
 *   1. the migration that ALTERs every column in `PROSE_VECTOR_COLUMNS`,
 *   2. this constant,
 *   3. the emitting mode's `targetDims` in `embedder-dims.ts`.
 * pgvector cannot cast between vector widths, so step 1 necessarily drops
 * every stored vector and the surfaces run lexical-only until the backfill
 * sweep refills them (~395k vectors, see D-005). It is not a cheap change.
 */

import {
  EMBEDDER_DIM_SPECS,
  pgvectorMetricSpec,
  type EmbedderMode,
  type EmbedderProfileSpec,
  type EmbeddingDistanceMetric,
  type EmbeddingProfileId,
  type PgvectorIndexOperatorClass,
} from '@papercusp/memory';
import type { Sql } from 'postgres';
import { chunkStoreVectorColumns } from './chunks/registry';

/**
 * Width of every shared prose embedding column, per migration 727.
 *
 * 768 = EmbeddingGemma-300m's NATIVE width. Previously 384, an UNTRAINED MRL
 * cut that measured ~19-21% worse on prose retrieval MRR (D-003). Native means
 * no truncation at all, so the untrained-cut bug class is structurally
 * impossible here rather than parked at a different trained point (D-005).
 */
export const PROSE_VECTOR_DIMS = 768;

/**
 * The embedder modes whose vectors may be STORED in the prose columns.
 *
 * A mode is prose-eligible iff it can emit exactly `PROSE_VECTOR_DIMS`. This
 * is not a preference list — it is a physical constraint, and the test asserts
 * it against each mode's declared `targetDims`.
 *
 * NOT eligible, and why:
 *  - `local`  — bge-small-en-v1.5 is natively 384 with `mrl:'none'`, so it
 *               CANNOT emit 768. It was eligible only while the columns
 *               happened to be 384 (D-005 §6). Under a `local` preference the
 *               prose surfaces now dims-guard off and run lexical-only, which
 *               is better than the previous behaviour of silently re-embedding
 *               the whole column into a weaker space on a fallback.
 *  - `harrier`— native 1024, no MRL at all (the pre-existing exclusion that
 *               `proseSurfacePreference` already maps around).
 */
export const PROSE_ELIGIBLE_MODES = ['gemma', 'openai'] as const satisfies readonly EmbedderMode[];

export type ProseEligibleMode = (typeof PROSE_ELIGIBLE_MODES)[number];

/**
 * The physical contract shared by every column in {@link PROSE_VECTOR_COLUMNS}.
 *
 * These are STORAGE facts, deliberately literal and independent from
 * `EMBEDDER_DIM_SPECS`: changing an emitting profile must not silently change
 * what an unapplied database migration is assumed to accept. The compatibility
 * tests join the two declarations and fail on skew (D-001).
 */
export interface ProseVectorStorageProfile {
  readonly acceptedProfileIds: readonly EmbeddingProfileId[];
  readonly dimensions: number;
  readonly distanceMetric: EmbeddingDistanceMetric;
  readonly indexOperatorClass: PgvectorIndexOperatorClass;
}

export const PROSE_VECTOR_STORAGE_PROFILE: ProseVectorStorageProfile = Object.freeze({
  acceptedProfileIds: [
    'gemma-embeddinggemma-300m-768@v1',
    'openai-text-embedding-3-small-768@v1',
  ] as const,
  dimensions: PROSE_VECTOR_DIMS,
  distanceMetric: 'cosine',
  indexOperatorClass: 'vector_cosine_ops',
});

/** The exact row identity a prose query is allowed to select. `legacyMode` is
 * present only when a mode-only row can be interpreted without guessing: the
 * requested id must be that mode's declared CURRENT profile. */
export interface ProseProfileSelection {
  readonly profileId: EmbeddingProfileId;
  readonly legacyMode: ProseEligibleMode | null;
}

/** Validate desired embedder output against the independently declared shared
 * prose storage. Returning every problem keeps migration skew actionable. */
export function validateProseStorageCompatibility(
  profile: Pick<EmbedderProfileSpec, 'profileId' | 'targetDims' | 'distanceMetric'>,
): string[] {
  const problems: string[] = [];
  if (!PROSE_VECTOR_STORAGE_PROFILE.acceptedProfileIds.includes(profile.profileId)) {
    problems.push(
      `shared prose storage does not accept profile ${profile.profileId}; ` +
        `accepted=${PROSE_VECTOR_STORAGE_PROFILE.acceptedProfileIds.join(',') || '(none)'}`,
    );
  }
  if (profile.targetDims !== PROSE_VECTOR_STORAGE_PROFILE.dimensions) {
    problems.push(
      `shared prose storage has ${PROSE_VECTOR_STORAGE_PROFILE.dimensions} dimensions; ` +
        `profile ${profile.profileId} emits ${profile.targetDims}`,
    );
  }
  if (profile.distanceMetric !== PROSE_VECTOR_STORAGE_PROFILE.distanceMetric) {
    problems.push(
      `shared prose storage uses ${PROSE_VECTOR_STORAGE_PROFILE.distanceMetric}; ` +
        `profile ${profile.profileId} requires ${profile.distanceMetric}`,
    );
  }
  const metric = pgvectorMetricSpec(PROSE_VECTOR_STORAGE_PROFILE.distanceMetric);
  if (!metric) {
    problems.push(
      `shared prose storage has unsupported metric ${PROSE_VECTOR_STORAGE_PROFILE.distanceMetric}`,
    );
  } else if (metric.indexOperatorClass !== PROSE_VECTOR_STORAGE_PROFILE.indexOperatorClass) {
    problems.push(
      `shared prose storage index uses ${PROSE_VECTOR_STORAGE_PROFILE.indexOperatorClass}; ` +
        `${PROSE_VECTOR_STORAGE_PROFILE.distanceMetric} requires ${metric.indexOperatorClass}`,
    );
  }
  return problems;
}

/** Resolve an enabled embedder to an exact prose-row selection, or fail closed
 * when its complete profile is not accepted by the physical store. */
export function resolveProseProfileSelection(
  mode: string,
  profile: Pick<EmbedderProfileSpec, 'profileId' | 'targetDims' | 'distanceMetric'>,
): ProseProfileSelection | null {
  if (validateProseStorageCompatibility(profile).length > 0) return null;
  const legacyMode = (PROSE_ELIGIBLE_MODES as readonly string[]).includes(mode)
    && EMBEDDER_DIM_SPECS[mode as ProseEligibleMode].profileId === profile.profileId
      ? (mode as ProseEligibleMode)
      : null;
  return { profileId: profile.profileId, legacyMode };
}

/** Resolve the declared CURRENT profile for a prose-eligible mode. This is for
 * mode-shaped operator inputs (diagnostic scans), not stored-row inference: an
 * unknown mode fails closed, and alternate/historical profiles must be passed
 * explicitly through {@link resolveProseProfileSelection}. */
export function resolveCurrentProseProfileSelection(mode: string): ProseProfileSelection | null {
  if (!(PROSE_ELIGIBLE_MODES as readonly string[]).includes(mode)) return null;
  const profile = EMBEDDER_DIM_SPECS[mode as ProseEligibleMode];
  return resolveProseProfileSelection(mode, profile);
}

/** Resolve provenance carried by a query embedder when the full profile object
 * is no longer in scope. The accepted-id registry remains the authority; the
 * legacy mode branch is granted only to that mode's declared current id. */
export function resolveProseProfileIdSelection(
  profileId: string,
  legacyMode: string | null | undefined,
): ProseProfileSelection | null {
  if (!(PROSE_VECTOR_STORAGE_PROFILE.acceptedProfileIds as readonly string[]).includes(profileId)) {
    return null;
  }
  const mode = (PROSE_ELIGIBLE_MODES as readonly string[]).includes(legacyMode ?? '')
    ? (legacyMode as ProseEligibleMode)
    : null;
  return {
    profileId: profileId as EmbeddingProfileId,
    legacyMode:
      mode !== null && EMBEDDER_DIM_SPECS[mode].profileId === profileId
        ? mode
        : null,
  };
}

/** Resolve an accepted profile id and grant its legacy-mode fallback only when
 * that id is the declared current profile for exactly one eligible mode. */
export function resolveAcceptedProseProfileSelection(profileId: string): ProseProfileSelection | null {
  const legacyMode = PROSE_ELIGIBLE_MODES.find(
    (mode) => EMBEDDER_DIM_SPECS[mode].profileId === profileId,
  ) ?? null;
  return resolveProseProfileIdSelection(profileId, legacyMode);
}

/** Compile the one canonical SQL predicate for a stored prose vector's exact
 * space. Column names are internal schema literals supplied by audited call
 * sites; profile values remain bound parameters. A missing/unknown selection
 * is SQL FALSE, never a mode-only fallback. */
export function proseProfilePredicateSql(
  sql: Sql,
  selection: ProseProfileSelection | null,
  profileColumn: string,
  modeColumn: string,
) {
  if (!selection) return sql`FALSE`;
  const profile = sql.unsafe(profileColumn);
  const mode = sql.unsafe(modeColumn);
  return selection.legacyMode !== null
    ? sql`(${profile} = ${selection.profileId} OR (${profile} IS NULL AND ${mode} = ${selection.legacyMode}))`
    : sql`${profile} = ${selection.profileId}`;
}

/** Compile a row's effective exact profile id for row↔row comparisons. Exact
 * stored ids win only when accepted by the physical storage contract; a NULL
 * profile may map through the closed current-mode registry. Unknown identities
 * become SQL NULL and therefore cannot establish comparability. */
export function effectiveStoredProseProfileIdSql(
  sql: Sql,
  profileColumn: string,
  modeColumn: string,
) {
  const profile = sql.unsafe(profileColumn);
  const mode = sql.unsafe(modeColumn);
  const accepted = [...PROSE_VECTOR_STORAGE_PROFILE.acceptedProfileIds];
  return sql`CASE
    WHEN ${profile} = ANY(${accepted}::text[]) THEN ${profile}
    WHEN ${profile} IS NULL THEN CASE
      WHEN ${mode} = 'gemma' THEN ${EMBEDDER_DIM_SPECS.gemma.profileId}
      WHEN ${mode} = 'openai' THEN ${EMBEDDER_DIM_SPECS.openai.profileId}
      ELSE NULL
    END
    ELSE NULL
  END`;
}

/** Pure row-level identity judgement used by tests and non-SQL consumers.
 * A present exact id always wins. A missing id may use the legacy mode tag only
 * for the mode registry's declared current profile — equal width or equal mode
 * never makes an alternate profile compatible. */
export function storedProseIdentityMatches(
  stored: { profileId?: string | null; mode?: string | null },
  selection: ProseProfileSelection,
): boolean {
  if (stored.profileId !== null && stored.profileId !== undefined) {
    return stored.profileId === selection.profileId;
  }
  return selection.legacyMode !== null && stored.mode === selection.legacyMode;
}

/**
 * Every BASE TABLE column the width contract applies to — the list a width
 * migration must ALTER, and the list `prose-vector-dims.integration.test.ts`
 * checks the live schema against so a NEW surface cannot quietly adopt a stale
 * width.
 *
 * ⚠ ENUMERATED FROM THE DATABASE (`pg_attribute.atttypmod` over every
 * `harness_shared` vector column), NOT from the migrations. Building it by
 * grepping migration files produced a list of FIVE and silently missed the
 * rest — `code_recipes`, `harness_brainstorm`, `harness_decisions`,
 * `harness_escalations`, `datatype_registry`. Migrating a subset leaves the
 * missed surfaces at the old width under new-width-emitting code, where every
 * write fails inside a background sweep nobody is watching.
 *
 * ⚠⚠ RE-DERIVE IT WITH `relkind = 'r'`. The first version of this list was
 * enumerated from `pg_attribute` WITHOUT filtering `relkind`, which mixes VIEWS
 * in among the TABLES: `harness_features` and `harness_features_consolidated`
 * are relkind='v' and were listed here as if a migration should ALTER them.
 * `ALTER TABLE ... ALTER COLUMN` against a view fails outright
 * (EI-19364746461986832). A view's column simply REPORTS its base column's
 * type, so views need no migration of their own — see
 * `PROSE_VECTOR_DEPENDENT_VIEWS` below.
 *
 * `memory_vec_*` are deliberately NOT here: they are per-mode spaces with their
 * own widths (local stays 384, harrier 1024), so they are not governed by the
 * shared prose contract — but gemma's and openai's DO have to move with it, and
 * migration 727 handles them alongside these. They are enumerated separately in
 * `PROSE_MEMORY_VEC_COLUMNS` below; `WIDTH_MIGRATION_WIPE_SET` is the union, and
 * is the list a refill-coverage guard must be written against (WI-7326).
 */
export const PROSE_VECTOR_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'harness_shared.session_turns', column: 'text_embedding' },
  // Every chunk store (session_turn_chunks, and migration 1242's shared
  // text_chunks for every registered collection past the 2,000-char window):
  // DERIVED from search/chunks/registry.ts CHUNK_STORES (generic-rag-chunking
  // P-005). Chunk vectors share the prose width by construction.
  ...chunkStoreVectorColumns(),
  { table: 'harness_shared.operator_turns', column: 'text_embedding' },
  { table: 'harness_shared.work_items', column: 'embedding' },
  { table: 'harness_shared.doc_sections', column: 'embedding' },
  // Migration 781 adds canonical doc content and its in-row semantic index.
  { table: 'harness_shared.harness_docs', column: 'embedding' },
  { table: 'harness_shared.harness_plans', column: 'embedding' },
  { table: 'harness_shared.harness_escalations', column: 'body_embedding' },
  { table: 'harness_shared.harness_brainstorm', column: 'content_embedding' },
  { table: 'harness_shared.harness_decisions', column: 'body_embedding' },
  { table: 'harness_shared.code_recipes', column: 'embedding' },
  { table: 'harness_shared.datatype_registry', column: 'embedding' },
  // Migration 874 adds the owner-local Personal Vault corpus. Its EmbeddingGemma
  // vector is still part of the 768-dim storage contract, so a future width
  // migration must include it, but its refill is deliberately kept off the
  // general TARGETS sweep: personal-vault/embedding.ts hard-pins the local-only
  // embedder and runs this target as a separate governed leg.
  { table: 'harness_shared.personal_documents', column: 'embedding' },
  // WI-39840. Both are QUERY vectors compared against `session_turns.text_embedding`,
  // so they are governed by the shared prose width — but both were created AFTER
  // migration 727 moved that width to 768 and each declared `vector(384)` anyway
  // (837-consult-query-embedding.sql:24, 839-interest-watches.sql:65). The result was
  // total, silent failure of every write AND every read on both columns: pgvector
  // raised `expected 384 dimensions, not 768`, which killed consult:get_feedback for
  // EVERY caller at the archive-first leg (get-feedback-core.ts:353) and with it the
  // non-force-waivable acceptance-rubric VETTING gate, i.e. every plan ship in the
  // workspace. Migration 847 widened them; these two entries are what stops the NEXT
  // width migration from skipping them the same way. This is exactly the failure the
  // `auditSurfaces` leg of prose-vector-dims.integration.test.ts already detects —
  // it never ran, because an integration test is not selected by a migration edit.
  { table: 'harness_shared.consult_state', column: 'query_embedding' },
  { table: 'harness_shared.interest_watches', column: 'embedding' },
  // Migration 1097 (WI-2142144): coord thread discussion posts, one of the two
  // continuity corpora that had neither an embedding nor a tsvector. Refilled by
  // its TARGETS entry. (The other, carry_notes.note_embedding, was dropped by
  // migration 1243: nothing read it, generic-rag-chunking-2026-09-29 D-020.)
  { table: 'harness_shared.coord_thread_posts', column: 'body_embedding' },
];

/**
 * The `memory_vec_<mode>` columns a prose width migration ALSO wipes.
 *
 * DERIVED from `PROSE_ELIGIBLE_MODES` on purpose: a mode becomes prose-eligible
 * exactly when it emits `PROSE_VECTOR_DIMS`, and at that moment its vec column
 * necessarily moves with the shared width too. Hand-listing them is what let
 * WI-7326 happen — 727's target list included these two and the refill-coverage
 * guard was written against `PROSE_VECTOR_COLUMNS`, which by design does not.
 *
 * ⚠ THESE ARE NOT REFILLED BY `embed-backfill`'s TARGETS SWEEP, and cannot be.
 * That sweep only ever runs `UPDATE <table> SET <col>` over rows that already
 * exist. `memory_vec_*` are join tables whose row exists SOLELY to carry the
 * vector, with `vector` NOT NULL — so the only expressible widening DELETEs the
 * rows, leaving an empty table that no UPDATE can ever repopulate. Their refill
 * path is the canonical memory sweep (`memory/canonical-vec-backfill.ts`), which
 * selects on row ABSENCE and re-INSERTs from `memory_canonical` text.
 */
export const PROSE_MEMORY_VEC_COLUMNS: ReadonlyArray<{ table: string; column: string }> =
  PROSE_ELIGIBLE_MODES.map((mode) => ({
    table: `harness_shared.memory_vec_${mode}`,
    column: 'vector',
  }));

/**
 * Everything a prose width migration wipes — the set that must be fully covered
 * by SOME refill path, asserted by `prose-vector-dims.test.ts`.
 *
 * The two halves have DIFFERENT refill mechanisms (TARGETS sweep vs the canonical
 * memory sweep), which is precisely why a guard written against either half alone
 * reads as complete coverage while leaving the other half silently unrefilled.
 */
export const WIDTH_MIGRATION_WIPE_SET: ReadonlyArray<{ table: string; column: string }> = [
  ...PROSE_VECTOR_COLUMNS,
  ...PROSE_MEMORY_VEC_COLUMNS,
];

/**
 * VIEWS that expose a prose vector column. They are NOT migration targets —
 * they inherit their width from the base column — but they DO block the ALTER
 * and must be dropped and recreated around it, and they are worth asserting
 * against the live schema because a view left behind at the old width is the
 * visible symptom of a half-applied width migration.
 *
 * ⚠ THIS LIST IS NOT EXHAUSTIVE AT RUNTIME, BY DESIGN. `harness_features` is
 * re-created in EVERY per-harness schema (`harness_papercusp`,
 * `harness_oddsmith`, one per contract-test pot, ...), so the true dependent set
 * grows with every pot created — 37 in the live DB when 727 was written, 244 in
 * a full schema clone. That is why migration 727 DISCOVERS the closure with a
 * recursive `pg_depend`/`pg_rewrite` walk instead of naming views literally, and
 * why any future width migration must do the same. These are only the
 * `harness_shared` ones, listed so the integration test has a fixed set to
 * assert on.
 */
export const PROSE_VECTOR_DEPENDENT_VIEWS: ReadonlyArray<{ view: string; column: string }> = [
  { view: 'harness_shared.harness_features', column: 'embedding' },
  { view: 'harness_shared.harness_features_consolidated', column: 'embedding' },
  { view: 'harness_shared.work_items_claimable', column: 'embedding' },
  // Migration 776 (P-005) — the `work_item` SearchSource's embedding leg reads
  // its vector THROUGH this view, so a view stranded at the old width would
  // break search, not just look wrong.
  { view: 'harness_shared.engineer_issues', column: 'embedding' },
];

/**
 * Does a resolved embedder's output fit the prose columns?
 *
 * The dims guard every prose reader/writer already performs, as one named
 * predicate rather than six copies of `resolved.dims !== EMBED_DIM`. Callers
 * return null / skip the sweep when this is false.
 *
 * ⚠ WHAT THIS DOES **NOT** CHECK, AND WHY THAT MATTERS (WI-7327).
 *
 * It compares the EMBEDDER's width against the DECLARED constant. It never
 * looks at the database. So it answers "does the emitter agree with the code's
 * belief about the columns" — NOT "does the emitter fit the columns".
 *
 * Those come apart on exactly one axis, and it is the dangerous one: when the
 * constant has moved but the migration has not. Then `PROSE_VECTOR_DIMS` and
 * `resolved.dims` are BOTH the new width, this predicate returns true, and the
 * guard sails through while every write to a still-old column fails. That is
 * the file docblock's "a dims guard that agrees with itself" hazard, and it is
 * not hypothetical: shipping the 768 constant while the columns were still
 * vector(384) produced 9.5 hours of total, SILENT embed failure — every UPDATE
 * rejected by pgvector, swallowed by a per-row catch, zero rows written, zero
 * log output.
 *
 * This function is deliberately left pure and synchronous — it is called
 * per-query on hot read paths (semantic legs, dupe guards, novelty legs), where
 * a database round-trip would be wrong. The live-schema half of the contract is
 * `computeProseColumnWidthSkew` below, which the backfill sweep runs ONCE per
 * sweep. Keep both: this one is cheap and catches an ineligible EMBEDDER, that
 * one is authoritative and catches a skewed SCHEMA. Neither subsumes the other.
 */
export function fitsProseColumns(dims: number): boolean {
  return dims === PROSE_VECTOR_DIMS;
}

/**
 * A prose column whose LIVE width disagrees with `PROSE_VECTOR_DIMS` — i.e. the
 * code is emitting vectors the database cannot store.
 */
export interface ProseColumnWidthSkew {
  table: string;
  column: string;
  /** The width the column ACTUALLY has, measured from the live catalog. */
  liveDims: number;
  /** The width the code believes it has (`PROSE_VECTOR_DIMS`). */
  declaredDims: number;
}

/**
 * Pure core of the live-schema width check — exported for tests, and pure so
 * that the module every hot path imports stays free of a database dependency.
 * The caller measures; this classifies. (Same split as `computeContentDrift` in
 * migration-drift.ts, and for the same reason: the judgement is the part worth
 * testing exhaustively, and it should not need a database to test.)
 *
 * ⚠ `dims` MUST come from `pg_attribute.atttypmod`. For pgvector that column
 * holds the dimension DIRECTLY — there is no varchar-style `+4` offset.
 * Verified against the live catalog 2026-08-03: atttypmod 768 renders as
 * `vector(768)`, 384 as `vector(384)`, 1024 as `vector(1024)`. Passing a
 * `+4`-adjusted number here would make every column read as skewed.
 *
 * Skips, deliberately: a column absent from the measurement. Absence of
 * evidence is not skew — a table that has not been created yet, or was not
 * covered by the caller's query, is UNJUDGEABLE rather than broken. Reporting
 * it would turn "this DB predates the surface" into a false total-failure
 * alarm.
 */
export function computeProseColumnWidthSkew(
  measured: ReadonlyArray<{ table: string; column: string; dims: number }>,
): ProseColumnWidthSkew[] {
  const skewed: ProseColumnWidthSkew[] = [];
  for (const m of measured) {
    if (!Number.isFinite(m.dims) || m.dims <= 0) continue; // unjudgeable, not skewed
    if (m.dims !== PROSE_VECTOR_DIMS) {
      skewed.push({
        table: m.table,
        column: m.column,
        liveDims: m.dims,
        declaredDims: PROSE_VECTOR_DIMS,
      });
    }
  }
  return skewed.sort(
    (a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column),
  );
}

/** The declared target width for a mode — the emitting side of the contract. */
export function modeTargetDims(mode: EmbedderMode): number {
  return EMBEDDER_DIM_SPECS[mode].targetDims;
}
