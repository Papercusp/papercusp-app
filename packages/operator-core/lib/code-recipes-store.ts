/**
 * code-recipes-store.ts — PG CRUD for agent-authored reusable code:run scripts
 * ("recipes": `harness_shared.code_recipes` + `harness_shared.code_recipe_runs`,
 * migration 349). Canonical store for the code-recipes-2026-06-21 feature; a
 * recipe is just a saved code:run script, captured on a successful run (D-002 /
 * D-012).
 *
 * Recipes are GLOBAL — a reusable capability like a tool DEFINITION, not scoped to
 * a workspace or hive (data-scoping-audit-2026-06-22 P-001, reversing the earlier
 * hive-scoping D-005: a good recipe should help every hive). `code_recipe_runs`
 * KEEPS workspace_id + pot_slug — that is USAGE (which hive ran it), the mirror of
 * tool_invocations being scoped while tool definitions are global.
 *
 * Transport-agnostic: every function takes the `sql` handle so the same code serves
 * the code:run capture path's `getOrgPg()` connection and the integration test's
 * testcontainer handle.
 *
 * Pure PG: no embedding-provider / search dependency here — the caller computes the
 * embedding (a `number[] | null`, 768-dim) and passes it in (Phase-2 dedup rides
 * @papercusp/search over the columns this store writes, D-009).
 *
 * Server-only.
 */
import type postgres from 'postgres';
import type { EmbedderMode } from '@papercusp/memory';
import type { NormalizedExecutionTrace } from './orchestration-trace';
import type { CapabilityManifestV1, RecipeBindingSchemaV1 } from './recipe-contract';
import type { ProseProfileSelection } from './search/prose-vector-dims';

export interface CodeRecipeRow {
  id: string;
  title: string;
  description: string;
  script: string;
  /** Versioned runtime-input contract for this exact script revision; null = legacy foreground recipe. */
  bindingSchema: RecipeBindingSchemaV1 | null;
  /** Declarative requirements only — authorization is always recomputed for the current caller. */
  capabilityManifest: CapabilityManifestV1 | null;
  /** The pot that authored the recipe (P-002 pot-scope-all-learnings); null = pre-pot legacy or context-less system author. */
  potSlug: string | null;
  authorRole: string | null;
  toolsUsed: string[];
  runCount: number;
  successCount: number;
  lastRunAt: string | null;
  status: string;
  promotedTool: string | null;
  mergedInto: string | null;
  tags: string[];
  /** True when an embedding is stored; the raw vector itself is not mapped back. */
  hasEmbedding: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A recipe row WITHOUT its `script` body — what every LIST read returns.
 *
 * The script is the single fattest column in the table (~2.3 KB/row measured over
 * the live 1,000-recipe corpus, 79% of the whole `codeRecipes` sync payload) and
 * NO list caller has ever used it: `recipes:list`, the learning-retain read, and
 * the `codeRecipes` sync resolver each project it straight back off. Selecting it
 * was pure waste on BOTH legs — Postgres→node and, for the sync read, node→client.
 * Fetch a body by id with {@link getRecipe}, which still returns the full row.
 */
export type CodeRecipeListRow = Omit<CodeRecipeRow, 'script' | 'bindingSchema' | 'capabilityManifest'>;

export interface UpsertCodeRecipeInput {
  /** Package registration must not overwrite a concurrently created recipe. */
  createOnly?: boolean;
  /** Stable kebab slug derived from the title (the PRIMARY KEY). */
  id: string;
  title: string;
  description: string;
  script: string;
  /** Omit/null for a legacy recipe. A non-null schema requires capabilityManifest. */
  bindingSchema?: RecipeBindingSchemaV1 | null;
  /** Omit/null for a legacy recipe. The contract is replaced, never inherited across script revisions. */
  capabilityManifest?: CapabilityManifestV1 | null;
  authorRole?: string | null;
  toolsUsed?: string[];
  /** title+description embedding (768-dim). null when the embedder was unavailable. */
  embedding?: number[] | null;
  /** Required whenever embedding is non-null: readable mode projection plus
   * the exact versioned space identity stored beside the vector. */
  embeddingMode?: EmbedderMode | null;
  embeddingProfile?: ProseProfileSelection | null;
  tags?: string[];
  /** The coord ownerId that authored the recipe (first-write attribution). */
  createdBy?: string | null;
  /**
   * The pot the authoring agent worked under — resolve via resolveLearningPotSlug
   * (learning/pot-scope.ts) at the caller. Required so no writer forgets the scope;
   * an explicit null means "genuinely context-less" (D-002), never "didn't look".
   * First-write attribution: an update never steals the pot from the original author.
   */
  potSlug: string | null;
}

export interface RecordRecipeRunInput {
  /** Null for an executed script that was not captured as / replayed from a recipe. */
  recipeId?: string | null;
  /** The workspace that RAN the recipe — USAGE, stored on code_recipe_runs (the
   *  recipe itself is global; this records which hive/workspace exercised it). */
  workspaceId: string;
  /** The hive that ran it — usage; null ⇒ workspace-level run. */
  potSlug: string | null;
  /** The coord ownerId that ran it (distinct-agent signal). */
  agentOwner?: string | null;
  agentRole?: string | null;
  success?: boolean;
  /** true when an existing recipe candidate was reused, either by recipes:run or
   *  by code:run capture dedup (exact fingerprint / near-similarity match). */
  reused?: boolean;
  /** Secret-free normalized P-013 trace. Its fingerprint is stored alongside it for indexed dedup. */
  executionTrace?: NormalizedExecutionTrace | null;
  /**
   * Preserve the existing recipe popularity semantics for failed and dry-run traces:
   * their execution row is durable, but the parent recipe counters do not move.
   * Defaults to true when recipeId is present.
   */
  countTowardRecipe?: boolean;
}

export interface ReviseRecipeSourceInput {
  id: string;
  script: string;
  toolsUsed: string[];
  /** Compare-and-swap token read from the current row. */
  expectedUpdatedAt: string;
}

export type ReviseRecipeSourceResult =
  | { status: 'updated'; row: CodeRecipeRow }
  | { status: 'not_found' }
  | { status: 'conflict'; current: CodeRecipeRow };

type DbRow = {
  id: string;
  title: string;
  description: string;
  script: string;
  binding_schema: RecipeBindingSchemaV1 | null;
  capability_manifest: CapabilityManifestV1 | null;
  pot_slug: string | null;
  author_role: string | null;
  tools_used: string[] | null;
  run_count: number | string;
  success_count: number | string;
  last_run_at: Date | string | null;
  status: string;
  promoted_tool: string | null;
  merged_into: string | null;
  tags: string[] | null;
  has_embedding: boolean;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const asIso = (v: Date | string): string => (typeof v === 'string' ? v : v.toISOString());
const asIsoOrNull = (v: Date | string | null): string | null => (v == null ? null : asIso(v));
const asInt = (v: number | string): number => (typeof v === 'number' ? v : parseInt(v, 10));

/** Map every column EXCEPT `script` — shared by {@link mapRow} and the list reads,
 *  so the two shapes can never drift apart. */
function mapListRow(r: Omit<DbRow, 'script' | 'binding_schema' | 'capability_manifest'>): CodeRecipeListRow {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    potSlug: r.pot_slug,
    authorRole: r.author_role,
    toolsUsed: r.tools_used ?? [],
    runCount: asInt(r.run_count),
    successCount: asInt(r.success_count),
    lastRunAt: asIsoOrNull(r.last_run_at),
    status: r.status,
    promotedTool: r.promoted_tool,
    mergedInto: r.merged_into,
    tags: r.tags ?? [],
    hasEmbedding: r.has_embedding,
    createdBy: r.created_by,
    createdAt: asIso(r.created_at),
    updatedAt: asIso(r.updated_at),
  };
}

function mapRow(r: DbRow): CodeRecipeRow {
  return {
    ...mapListRow(r),
    script: r.script,
    bindingSchema: r.binding_schema,
    capabilityManifest: r.capability_manifest,
  };
}

/** SELECT-list shared by every read so `has_embedding` is computed uniformly
 *  (the raw VECTOR is never serialized back into JS — only its presence).
 *  Accepts a plain Sql OR a TransactionSql so the merge transaction can reuse it. */
const LIST_SELECT_COLS = (sql: postgres.Sql | postgres.TransactionSql) => sql`
  id, title, description, pot_slug, author_role,
  tools_used, run_count, success_count, last_run_at, status, promoted_tool,
  merged_into, tags, (embedding IS NOT NULL) AS has_embedding,
  created_by, created_at, updated_at
`;

const SELECT_COLS = (sql: postgres.Sql | postgres.TransactionSql) => sql`
  script, binding_schema, capability_manifest, ${LIST_SELECT_COLS(sql)}
`;

/**
 * Insert a recipe, or update title/description/script/tools/embedding/tags in
 * place for an existing id (the kebab slug). updated_at bumps; run counters and
 * created_by/created_at are PRESERVED on update (they belong to the run-record /
 * first-write paths). Embedding is overwritten only when a non-null vector is
 * supplied — re-running without an available embedder must not WIPE a previously
 * computed embedding.
 */
export async function upsertRecipe(sql: postgres.Sql, input: UpsertCodeRecipeInput): Promise<CodeRecipeRow> {
  if (input.bindingSchema != null && input.capabilityManifest == null) {
    throw new Error('upsertRecipe: bindingSchema requires capabilityManifest');
  }
  // pgvector wants the textual `[1,2,3]` form; null leaves/keeps it unset.
  const embeddingLiteral = input.embedding && input.embedding.length > 0 ? `[${input.embedding.join(',')}]` : null;
  if (embeddingLiteral && (!input.embeddingMode || !input.embeddingProfile)) {
    throw new Error('upsertRecipe: a stored embedding requires exact mode and profile provenance');
  }
  const bindingSchemaJson = input.bindingSchema == null ? null : JSON.stringify(input.bindingSchema);
  const capabilityManifestJson = input.capabilityManifest == null ? null : JSON.stringify(input.capabilityManifest);
  const rows = await sql<DbRow[]>`
    INSERT INTO harness_shared.code_recipes
      (id, title, description, script, binding_schema, capability_manifest, pot_slug, author_role,
       tools_used, tags, embedding, embedding_mode, embedding_profile, created_by, updated_at)
    VALUES (
      ${input.id}, ${input.title},
      ${input.description}, ${input.script}, ${bindingSchemaJson}::jsonb, ${capabilityManifestJson}::jsonb,
      ${input.potSlug}, ${input.authorRole ?? null},
      ${input.toolsUsed ?? []}, ${input.tags ?? []},
      ${embeddingLiteral}::vector, ${input.embeddingMode ?? null},
      ${input.embeddingProfile?.profileId ?? null}, ${input.createdBy ?? null}, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      title       = EXCLUDED.title,
      description = EXCLUDED.description,
      script      = EXCLUDED.script,
      -- Both declarations belong to the exact script revision. An updater that
      -- does not supply them deliberately returns the row to legacy mode rather
      -- than inheriting stale requirements/bindings from different source.
      binding_schema = EXCLUDED.binding_schema,
      capability_manifest = EXCLUDED.capability_manifest,
      -- first-write pot attribution: a later update never steals the recipe from
      -- its authoring pot; a legacy NULL adopts the updater's pot (organic backfill)
      pot_slug    = COALESCE(harness_shared.code_recipes.pot_slug, EXCLUDED.pot_slug),
      author_role = EXCLUDED.author_role,
      tools_used  = EXCLUDED.tools_used,
      tags        = EXCLUDED.tags,
      -- keep the existing embedding when this write carries none (no embedder)
      embedding   = COALESCE(EXCLUDED.embedding, harness_shared.code_recipes.embedding),
      embedding_mode = CASE WHEN EXCLUDED.embedding IS NULL
        THEN harness_shared.code_recipes.embedding_mode ELSE EXCLUDED.embedding_mode END,
      embedding_profile = CASE WHEN EXCLUDED.embedding IS NULL
        THEN harness_shared.code_recipes.embedding_profile ELSE EXCLUDED.embedding_profile END,
      updated_at  = now()
    WHERE ${input.createOnly !== true}
    RETURNING ${SELECT_COLS(sql)}`;
  if (!rows.length) throw new Error('recipe already exists; create-only registration refused to overwrite it');
  return mapRow(rows[0]);
}

/**
 * Record one execution in `code_recipe_runs` AND (same transaction) bump the
 * denormalized counters on the parent `code_recipes` row: run_count +1,
 * success_count +1 when success, last_run_at = now(). The side-table is the
 * source of truth for the Phase-3 distinct-agent + frequency signals; the
 * counters are a cheap-read denormalization (migration 349 header). The RUN row
 * carries workspace_id + pot_slug (usage); the recipe itself is global.
 */
export async function recordRecipeRun(sql: postgres.Sql, input: RecordRecipeRunInput): Promise<void> {
  const recipeId = input.recipeId ?? null;
  const executionTrace = input.executionTrace ?? null;
  if (!recipeId && !executionTrace) {
    throw new Error('recordRecipeRun requires recipeId or executionTrace');
  }
  const success = input.success ?? true;
  const countTowardRecipe = input.countTowardRecipe ?? recipeId !== null;
  const traceJson = executionTrace ? JSON.stringify(executionTrace) : null;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO harness_shared.code_recipe_runs
        (recipe_id, workspace_id, pot_slug, agent_owner, agent_role, success, reused,
         execution_trace, structural_fingerprint)
      VALUES (
        ${recipeId}, ${input.workspaceId}, ${input.potSlug},
        ${input.agentOwner ?? null}, ${input.agentRole ?? null},
        ${success}, ${input.reused ?? false},
        ${traceJson}::text::jsonb, ${executionTrace?.structuralFingerprint ?? null}
      )`;
    if (recipeId && countTowardRecipe) {
      await tx`
        UPDATE harness_shared.code_recipes
           SET run_count     = run_count + 1,
               success_count = success_count + ${success ? 1 : 0},
               last_run_at   = now()
         WHERE id = ${recipeId}`;
    }
  });
}

/**
 * Replace only a saved recipe's executable source metadata, without recording an
 * execution or changing its popularity counters. The `updated_at` predicate is a
 * compare-and-swap rail: a caller that inspected an older revision can never
 * overwrite a concurrent edit silently.
 *
 * The versioned binding/capability contract is deliberately preserved. This
 * operation is for source corrections whose runtime-input contract is unchanged;
 * capture/upsert remains the authoring path for a different contract.
 */
export async function reviseRecipeSource(
  sql: postgres.Sql,
  input: ReviseRecipeSourceInput,
): Promise<ReviseRecipeSourceResult> {
  return sql.begin(async (tx) => {
    // Compare the same mapped timestamp representation the caller read. A raw
    // SQL timestamptz equality check is incorrect here because postgres.js maps
    // the value through Date (millisecond precision) while PG stores microseconds.
    const currentRows = await tx<DbRow[]>`
      SELECT ${SELECT_COLS(tx)}
        FROM harness_shared.code_recipes
       WHERE id = ${input.id}
       FOR UPDATE`;
    if (!currentRows[0]) return { status: 'not_found' };
    const current = mapRow(currentRows[0]);
    if (current.updatedAt !== input.expectedUpdatedAt) {
      return { status: 'conflict', current };
    }

    const rows = await tx<DbRow[]>`
      UPDATE harness_shared.code_recipes
         SET script = ${input.script},
             tools_used = ${input.toolsUsed},
             updated_at = now()
       WHERE id = ${input.id}
      RETURNING ${SELECT_COLS(tx)}`;
    return { status: 'updated', row: mapRow(rows[0]) };
  });
}

export interface MergeRecipesInput {
  /** The recipe every duplicate consolidates into. */
  survivorId: string;
  /** Near-duplicate recipe ids to fold into the survivor. */
  duplicateIds: string[];
}

export interface MergeRecipesResult {
  /** The updated survivor (with the duplicates' run/success counts added). */
  survivor: CodeRecipeRow;
  /** The ids actually merged (excludes the survivor itself + absent ids). */
  mergedIds: string[];
}

/**
 * Consolidate near-duplicate recipes into a SURVIVOR (the Queen's merge action
 * from her recipe-graduation review, D-015). In ONE transaction, for each
 * duplicate: set `status='merged'`, `merged_into=survivorId`, AND add its
 * run_count/success_count onto the survivor so the consolidated recipe reflects
 * total usage. Idempotent + reversible (a pure status/pointer flip + counter
 * folding); a recipe is NEVER merged into itself. Recipes are GLOBAL (P-001), so
 * the merge is keyed purely by id.
 *
 * Returns the updated survivor plus the ids that were actually merged. Throws if
 * the survivor does not exist (nothing to merge INTO).
 */
export async function mergeRecipes(sql: postgres.Sql, input: MergeRecipesInput): Promise<MergeRecipesResult> {
  const { survivorId } = input;
  // De-dupe the request + drop self-merge before touching the DB.
  const requested = [...new Set(input.duplicateIds)].filter((id) => id !== survivorId);

  // postgres-js types `begin`'s return loosely (UnwrapPromiseArray) — cast the
  // structured result back, mirroring agent-governor-pg-store.ts's transact().
  return (await sql.begin(async (tx) => {
    const survivorRows = await tx<DbRow[]>`
      SELECT ${SELECT_COLS(tx)} FROM harness_shared.code_recipes
       WHERE id = ${survivorId}
       FOR UPDATE`;
    if (!survivorRows[0]) {
      throw new Error(`mergeRecipes: survivor ${survivorId} not found`);
    }

    if (requested.length === 0) {
      return { survivor: mapRow(survivorRows[0]), mergedIds: [] };
    }

    // Mark each duplicate merged, pointing at the survivor, and harvest its
    // counters in the SAME statement. RETURNING the ids confirms which rows
    // actually existed (others are silently skipped).
    //
    // IDEMPOTENT: skip a duplicate ALREADY merged into THIS survivor — its
    // counters were folded on the first merge, so re-running must not re-add
    // them (a no-op replay). A duplicate merged into a DIFFERENT survivor, or
    // any non-merged status, is (re)pointed here and its counters folded once.
    const merged = await tx<{ id: string; run_count: number | string; success_count: number | string }[]>`
      UPDATE harness_shared.code_recipes
         SET status      = 'merged',
             merged_into = ${survivorId},
             updated_at  = now()
       WHERE id = ANY(${requested})
         AND id <> ${survivorId}
         AND NOT (status = 'merged' AND merged_into = ${survivorId})
       RETURNING id, run_count, success_count`;

    const mergedIds = merged.map((m) => m.id);
    const addRuns = merged.reduce((sum, m) => sum + asInt(m.run_count), 0);
    const addSuccess = merged.reduce((sum, m) => sum + asInt(m.success_count), 0);

    const updated = await tx<DbRow[]>`
      UPDATE harness_shared.code_recipes
         SET run_count     = run_count + ${addRuns},
             success_count = success_count + ${addSuccess},
             updated_at    = now()
       WHERE id = ${survivorId}
      RETURNING ${SELECT_COLS(tx)}`;

    return { survivor: mapRow(updated[0]), mergedIds };
  })) as unknown as MergeRecipesResult;
}

export interface SweepRecipesInput {
  /** Retire active recipes whose last_run_at is older than this (default 30). */
  staleDays?: number;
  /** Only one-offs: run_count at or below this (default 1 — nobody reused it). */
  maxRunCount?: number;
  /** Preview only — return the candidates WITHOUT changing anything (default false). */
  dryRun?: boolean;
  /**
   * TARGETED retire: exactly these recipe ids, instead of the staleness heuristic.
   *
   * The heuristic cannot express "retire THIS broken recipe" — it selects by age
   * and run-count only, so reaching one specific recipe means widening staleDays
   * until thousands of unrelated ones qualify. Explicit ids ARE the caller's
   * judgement, so they bypass staleDays/maxRunCount — but never the safety rails
   * (see `sweepRecipes`).
   */
  ids?: string[];
}

/** Why a requested id was NOT retired by a targeted (`ids`) sweep. */
export interface SweepRecipesSkip {
  id: string;
  reason: 'not_found' | 'promoted' | 'not_active';
  /** Present when the row exists — its current status. */
  status?: string;
}

export interface SweepRecipesResult {
  /** The swept (or, on a dryRun, would-be-swept) recipes. */
  swept: CodeRecipeRow[];
  dryRun: boolean;
  /**
   * Targeted (`ids`) sweeps only: the requested ids that were NOT retired, each
   * with a reason. A silently-short `swept` list is indistinguishable from a
   * typo'd id, so a targeted sweep reports its misses rather than dropping them.
   */
  skipped?: SweepRecipesSkip[];
}

/**
 * Retire the stale long-tail of never-reused one-off recipes (mirror
 * knowledge_packs:sweep). Selects ACTIVE recipes whose `last_run_at` is older than
 * `staleDays` AND `run_count <= maxRunCount` (a one-off nobody reused) and — on a
 * real run — flips them to `status='retired'`. A `dryRun` returns the candidates
 * without mutating. NEVER touches a hot recipe (run_count over the cap), a recipe
 * run recently, or a promoted/merged/already-retired one (the `status='active'`
 * filter), so hygiene can't strand a graduated or consolidated recipe. Reversible
 * (a status flip). Recipes are GLOBAL (P-001) — the sweep is fleet-wide.
 *
 * A recipe with a NULL last_run_at (saved, never run) is NOT swept here — it has
 * no staleness clock yet; it ages in only once it's been run and then idled.
 *
 * `ids` switches to a TARGETED retire of exactly those recipes (bypassing the
 * staleDays/run_count heuristic, keeping the active + non-promoted rails) and
 * reports every requested id it did not retire in `skipped`. Without it there is
 * no way to retire one known-broken recipe: the heuristic selects purely by age
 * and run-count, so reaching a single recent recipe means widening staleDays
 * until thousands of unrelated ones qualify (measured on this corpus: the 30-day
 * default matched 0 while staleDays:1 matched 9,544).
 */
export async function sweepRecipes(sql: postgres.Sql, input: SweepRecipesInput = {}): Promise<SweepRecipesResult> {
  const staleDays = input.staleDays ?? 30;
  const maxRunCount = input.maxRunCount ?? 1;
  const dryRun = input.dryRun ?? false;
  const ids = input.ids && input.ids.length > 0 ? [...new Set(input.ids)] : null;

  // TARGETED (`ids`) vs. the staleness HEURISTIC. Explicit ids are the caller's
  // judgement about specific recipes, so they bypass staleDays/maxRunCount — a
  // broken recipe is worth retiring at any age or run-count. They do NOT bypass
  // the safety rails: `status='active'` still excludes an already-retired or
  // merged row, and `promoted_tool IS NULL` is stated explicitly here because
  // targeting no longer has the run-count cap incidentally shielding a hot,
  // graduated recipe.
  const selector = ids
    ? sql`status = 'active' AND promoted_tool IS NULL AND id = ANY(${ids}::text[])`
    : sql`status = 'active'
         AND run_count <= ${maxRunCount}
         AND last_run_at IS NOT NULL
         AND last_run_at < now() - make_interval(days => ${staleDays})`;

  // A targeted sweep must explain a short result: an id that was a typo, already
  // retired, or promoted is otherwise silently absent from `swept` and reads as
  // "nothing matched", which is the same shape as a successful no-op.
  const skippedFor = async (retired: Set<string>): Promise<SweepRecipesSkip[]> => {
    if (!ids) return [];
    const present = await sql<{ id: string; status: string; promoted_tool: string | null }[]>`
      SELECT id, status, promoted_tool FROM harness_shared.code_recipes
       WHERE id = ANY(${ids}::text[])`;
    const byId = new Map(present.map((r) => [r.id, r]));
    return ids
      .filter((id) => !retired.has(id))
      .map((id): SweepRecipesSkip => {
        const row = byId.get(id);
        if (!row) return { id, reason: 'not_found' };
        if (row.promoted_tool != null) return { id, reason: 'promoted', status: row.status };
        return { id, reason: 'not_active', status: row.status };
      });
  };

  if (dryRun) {
    const rows = await sql<DbRow[]>`
      SELECT ${SELECT_COLS(sql)} FROM harness_shared.code_recipes
       WHERE ${selector}
       ORDER BY last_run_at ASC NULLS LAST, run_count ASC, id`;
    const swept = rows.map(mapRow);
    const skipped = await skippedFor(new Set(rows.map((r) => r.id)));
    return { swept, dryRun: true, ...(ids ? { skipped } : {}) };
  }

  // Real run: retire the candidates and RETURN the retired rows (single
  // statement — selection + mutation are atomic, no select-then-update race).
  const rows = await sql<DbRow[]>`
    UPDATE harness_shared.code_recipes
       SET status = 'retired', updated_at = now()
     WHERE ${selector}
    RETURNING ${SELECT_COLS(sql)}`;
  const swept = rows.map(mapRow);
  const skipped = await skippedFor(new Set(rows.map((r) => r.id)));
  return { swept, dryRun: false, ...(ids ? { skipped } : {}) };
}

/** Fetch one recipe by id (global). Null when absent. */
export async function getRecipe(sql: postgres.Sql, id: string): Promise<CodeRecipeRow | null> {
  const rows = await sql<DbRow[]>`
    SELECT ${SELECT_COLS(sql)} FROM harness_shared.code_recipes
     WHERE id = ${id}
     LIMIT 1`;
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Resolve the active recipe candidate already representing a normalized trace.
 *
 * Fingerprints live on the existing per-execution `code_recipe_runs` rail (P-013),
 * not on a second recipe index/table. When old capture behavior produced more than
 * one recipe for the same structure, prefer the most established active candidate
 * (run_count), then the most recently observed one, with id as the stable tie-break.
 * Trace-only rows have no recipe_id and therefore cannot be capture targets.
 */
export async function findActiveRecipeByStructuralFingerprint(
  sql: postgres.Sql,
  structuralFingerprint: string,
): Promise<CodeRecipeRow | null> {
  const rows = await sql<DbRow[]>`
    SELECT ${SELECT_COLS(sql)}
      FROM harness_shared.code_recipes r
     WHERE r.id = (
       SELECT run.recipe_id
         FROM harness_shared.code_recipe_runs run
         JOIN harness_shared.code_recipes candidate
           ON candidate.id = run.recipe_id
        WHERE run.structural_fingerprint = ${structuralFingerprint}
          AND run.recipe_id IS NOT NULL
          AND candidate.status = 'active'
        GROUP BY run.recipe_id, candidate.run_count, candidate.updated_at
        ORDER BY candidate.run_count DESC,
                 max(run.ts) DESC,
                 candidate.updated_at DESC,
                 run.recipe_id ASC
        LIMIT 1
     )
     LIMIT 1`;
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Default cap on a recipe list read — generous, so the whole corpus comes back,
 *  but bounded so a runaway store can't ship 50k rows to the desktop. Clamped to
 *  MAX_LIST_LIMIT. */
export const DEFAULT_LIST_LIMIT = 1000;
const MAX_LIST_LIMIT = 2000;

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit)));
}

/**
 * A "low-value" recipe is one not worth SURFACING for reuse: it batches ≤1 distinct tool
 * (a thin wrapper over the primitive — the candidate scorer's `trivial` class) OR carries
 * an AUTO-DERIVED fallback title ("recipe: <tools>", produced by deriveTitleDescription
 * only when the author gave no title). Such recipes still CAPTURE on every successful
 * code:run (D-012 unchanged); they are merely hidden from the code:run similarRecipes
 * nudge + the default recipes:list, and aged out by the weekly hygiene sweep
 * (recipes-reuse-activation-2026-06-22 P-004). Keep this predicate in lockstep with the
 * SQL filter in {@link listRecipes}.
 */
export function isLowValueRecipe(r: { toolsUsed?: string[] | null; title: string }): boolean {
  const toolCount = r.toolsUsed?.length ?? 0;
  return toolCount <= 1 || /^recipe:\s/i.test(r.title);
}

/**
 * List recipes (GLOBAL — recipes are a fleet-wide capability, P-001). Newest-run
 * first, then most-run, so the hot recipes surface (matches the run_count idx).
 *
 * By DEFAULT excludes low-value recipes (≤1-tool wrappers + auto-derived-title
 * throwaways — see {@link isLowValueRecipe}) so the browse stays signal-dense; pass
 * `includeTrivial: true` for the whole corpus (P-004). The SQL filter mirrors
 * isLowValueRecipe — keep them in lockstep.
 *
 * Capped at `limit` (default {@link DEFAULT_LIST_LIMIT}, clamped to
 * {@link MAX_LIST_LIMIT}) so a large corpus can't flood the sync transport; pair
 * with {@link countRecipes} for the true total (attachListMeta).
 *
 * Returns {@link CodeRecipeListRow} — every column EXCEPT the `script` body, which
 * no list caller has ever read and which was 79% of the `codeRecipes` sync payload
 * (WI-7085). Use {@link getRecipe} when you need one recipe's script.
 */
export async function listRecipes(
  sql: postgres.Sql,
  opts: { limit?: number; includeTrivial?: boolean } = {},
): Promise<CodeRecipeListRow[]> {
  const lim = clampLimit(opts.limit);
  const whereTrivial = opts.includeTrivial
    ? sql`TRUE`
    : sql`array_length(tools_used, 1) >= 2 AND title NOT ILIKE 'recipe: %'`;
  const rows = await sql<Omit<DbRow, 'script'>[]>`
    SELECT ${LIST_SELECT_COLS(sql)} FROM harness_shared.code_recipes
     WHERE ${whereTrivial}
     ORDER BY last_run_at DESC NULLS LAST, run_count DESC, id
     LIMIT ${lim}`;
  return rows.map(mapListRow);
}

/**
 * Count all recipes (the true total, independent of any list LIMIT). Cheap
 * `COUNT(*)` — pair with listRecipes + attachListMeta so the UI shows "N of
 * TOTAL". `includeTrivial: false` counts only the signal-dense subset the
 * default listRecipes / listRecipesActivityPage serve (same SQL filter).
 */
export async function countRecipes(sql: postgres.Sql, opts: { includeTrivial?: boolean } = {}): Promise<number> {
  const whereTrivial =
    (opts.includeTrivial ?? true) ? sql`TRUE` : sql`array_length(tools_used, 1) >= 2 AND title NOT ILIKE 'recipe: %'`;
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.code_recipes WHERE ${whereTrivial}`;
  return rows[0]?.n ?? 0;
}

/**
 * One keyset page of recipes by RECENT ACTIVITY — `ts` =
 * GREATEST(last_run_at, updated_at, created_at), ms-truncated — for the Retain
 * view's unified ledger (WI-39493). Excludes low-value recipes like the default
 * listRecipes (the 13.5k auto-captured corpus would otherwise be mostly ≤1-tool
 * wrappers); pass `includeTrivial: true` for everything.
 *
 * `before` is the exclusive keyset bound: rows with ts < before.ts, plus — when
 * `includeTies` — rows AT before.ts, or — when `idAfter` is set — rows at
 * before.ts whose id sorts after it in byte order. Matches the feed's
 * (ts DESC, id ASC) order; keep in lockstep with learning-retain-read's
 * inRetainLegWindow.
 */
export async function listRecipesActivityPage(
  sql: postgres.Sql,
  opts: {
    limit: number;
    before?: { ts: string; includeTies?: boolean; idAfter?: string | null } | null;
    includeTrivial?: boolean;
    /** Retain-ledger quick search over the row's id + title. */
    q?: string | null;
    /** Retain-ledger Title column substring filter. */
    title?: string | null;
  },
): Promise<Array<{ id: string; title: string; runCount: number; ts: string }>> {
  const lim = clampLimit(opts.limit);
  const whereTrivial = opts.includeTrivial
    ? sql`TRUE`
    : sql`array_length(tools_used, 1) >= 2 AND title NOT ILIKE 'recipe: %'`;
  const b = opts.before ?? null;
  const windowPred = !b
    ? sql`TRUE`
    : b.includeTies
      ? sql`x.ts <= ${b.ts}::timestamptz`
      : b.idAfter != null
        ? sql`(x.ts < ${b.ts}::timestamptz OR (x.ts = ${b.ts}::timestamptz AND x.id COLLATE "C" > ${b.idAfter}))`
        : sql`x.ts < ${b.ts}::timestamptz`;
  const likePattern = (value: string): string => `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const q = opts.q?.trim() ? likePattern(opts.q.trim()) : null;
  const title = opts.title?.trim() ? likePattern(opts.title.trim()) : null;
  const rows = await sql<Array<{ id: string; title: string; run_count: number | string; ts: Date | string }>>`
    SELECT * FROM (
      SELECT id, title, run_count,
             date_trunc('milliseconds',
               GREATEST(COALESCE(last_run_at, 'epoch'::timestamptz), updated_at, created_at)) AS ts
        FROM harness_shared.code_recipes
       WHERE ${whereTrivial}
    ) x
    WHERE ${windowPred}
      AND ${
        q ? sql`(COALESCE(x.id, '') ILIKE ${q} ESCAPE '\\' OR COALESCE(x.title, '') ILIKE ${q} ESCAPE '\\')` : sql`TRUE`
      }
      AND ${title ? sql`COALESCE(x.title, '') ILIKE ${title} ESCAPE '\\'` : sql`TRUE`}
    ORDER BY x.ts DESC, x.id COLLATE "C" ASC
    LIMIT ${lim}`;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    runCount: asInt(r.run_count),
    ts: asIso(r.ts),
  }));
}

/** Exact Retain-ledger recipe total + q/title matched count in one aggregate.
 * Recipe rows expose neither status nor lens; an active filter on either axis
 * is represented by `matchImpossible` and therefore matches zero without a
 * row scan while preserving the selected recipe corpus total. */
export async function summarizeRecipesActivity(
  sql: postgres.Sql,
  opts: {
    includeTrivial?: boolean;
    q?: string | null;
    title?: string | null;
    matchImpossible?: boolean;
  } = {},
): Promise<{ total: number; matched: number }> {
  const whereTrivial = opts.includeTrivial
    ? sql`TRUE`
    : sql`array_length(tools_used, 1) >= 2 AND title NOT ILIKE 'recipe: %'`;
  const likePattern = (value: string): string => `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const q = opts.q?.trim() ? likePattern(opts.q.trim()) : null;
  const title = opts.title?.trim() ? likePattern(opts.title.trim()) : null;
  const rows = await sql<Array<{ total: number | string; matched: number | string }>>`
    WITH scoped AS MATERIALIZED (
      SELECT id, title
        FROM harness_shared.code_recipes
       WHERE ${whereTrivial}
    )
    SELECT count(*)::int AS total,
           count(*) FILTER (
             WHERE ${opts.matchImpossible ? sql`FALSE` : sql`TRUE`}
               AND ${
                 q
                   ? sql`(COALESCE(id, '') ILIKE ${q} ESCAPE '\\' OR COALESCE(title, '') ILIKE ${q} ESCAPE '\\')`
                   : sql`TRUE`
               }
               AND ${title ? sql`COALESCE(title, '') ILIKE ${title} ESCAPE '\\'` : sql`TRUE`}
           )::int AS matched
      FROM scoped`;
  return {
    total: asInt(rows[0]?.total ?? 0),
    matched: asInt(rows[0]?.matched ?? 0),
  };
}
