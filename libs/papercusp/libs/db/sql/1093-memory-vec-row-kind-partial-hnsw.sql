-- 1093-memory-vec-row-kind-partial-hnsw.sql
--
-- P-003 of plan `memory-vector-entity-index-split-2026-09-02`, implementing D-004.
--
-- THE PROBLEM. `memory_canonical` holds two populations that share one table:
-- real memories and mem0 entity-graph nodes. Entities outnumber memories ~10:1
-- (measured 2026-09-02: 60,332 entity vs 5,931 memory). Each population's
-- vector lands in the SAME per-mode `memory_vec_<mode>` table, so the single
-- full HNSW index on `memory_vec_harrier` is ~91% entity vectors. Semantic
-- memory recall therefore walks an index whose neighbourhoods are dominated by
-- rows it will discard: P-002 measured 25,338 candidates / 147,178 buffers /
-- 453.6 ms for a topK=12 recall in the incident regime, against 23 / 1,172 /
-- 27.1 ms once the index contains ONLY memory vectors (1,102x fewer candidates,
-- 16.7x faster). That measurement is recorded as plan decision D-005.
--
-- THE FIX (D-004). `memory_canonical` already solves this for ITSELF with
-- `row_kind GENERATED ALWAYS AS (CASE WHEN payload ? 'entityType' THEN 'entity'
-- ELSE 'memory' END) STORED` plus the partial index
-- `memory_canonical_row_kind_memory_idx ... WHERE row_kind = 'memory'`. This
-- migration mirrors that proven pattern onto the vec tables. It CANNOT reuse a
-- generated column: a generated column may only reference columns of its own
-- row, and `payload` lives in `memory_canonical`, not in `memory_vec_*`. So the
-- vec-side discriminator is denormalized and maintained by triggers.
--
-- WHY TRIGGERS AND NOT AN APPLICATION WRITE. Four independent in-repo INSERT
-- sites write these tables (`vec-write.ts:76`, `canonical-store.ts:597`,
-- `canonical-store.ts:896`, `reembed.ts:154`) and NONE has the kind in scope --
-- every one writes `(memory_id, vector, embedded_at)` only. An
-- application-maintained column would have to be correct at all four, and at
-- every future writer, forever. This subsystem already documents what a stale
-- denormalized value costs here: `vec-write.ts:61-64` warns that a wrong
-- `MODE_DIMS` entry makes the width guard return false rather than throw, so a
-- mode left at the wrong width "simply stops writing vectors -- no error, no
-- log". A drifted `row_kind` has exactly that shape and is worse: it puts a real
-- memory on the wrong side of the partial index, so the row silently disappears
-- from recall. That is a CORRECTNESS regression produced by a performance fix.
--
-- D-004's OPEN RISK, NOW RESOLVED. D-004 left one question for this migration:
-- what does the trigger do for a vec row inserted BEFORE its canonical row
-- exists? Measured answer: that row cannot exist. Every `memory_vec_*` table
-- carries `FOREIGN KEY (memory_id) REFERENCES memory_canonical(id) ON DELETE
-- CASCADE`, declared WITHOUT `DEFERRABLE`, so the reference is checked at the
-- end of the inserting statement and a vec-before-canonical row can never
-- commit. The application agrees: `canonical-store.ts:590` orders the writes
-- explicitly -- "Upsert canonical first (vec table FKs to it), then vec row."
-- The stamping function below therefore RAISES rather than stamping NULL. It
-- turns a row that was already doomed into an immediately legible error instead
-- of a silently-unindexed vector, which is what D-004 asked for.
--
-- A SECOND DRIFT PATH D-004 DID NOT COVER. `row_kind` is DERIVED FROM
-- `payload`, so a canonical UPDATE can flip a row's kind while never touching
-- `memory_vec_*`. Two of the three payload writers are already guarded
-- (`canonical-store.ts` `updatePayload` and `invalidate` both carry
-- `AND NOT (payload ? 'entityType')`), and a `payload || patch` merge can only
-- ADD keys, so entity->memory is structurally impossible. But the mem0 text
-- update at `canonical-store.ts:890` merges an arbitrary payload UNGUARDED, so
-- memory->entity is reachable. Relying on those call-site guards staying
-- correct forever is the same fragility D-004 rejected for the insert path, so
-- the propagation trigger below closes it structurally instead. It fires only
-- when the kind actually changes, which is ~never, so it costs nothing.
--
-- WHY ONLY A MEMORY-SIDE PARTIAL INDEX, NOT "one per kind". D-004's sketch said
-- "a PARTIAL HNSW index per kind". Building an ENTITY partial index would
-- duplicate the existing full index almost exactly (60,331 of 66,262 rows;
-- measured index footprint 444 MB on an 808 MB table) and the migration runner
-- wraps each migration in a transaction, so `CREATE INDEX CONCURRENTLY` is
-- unavailable and that build would hold a write lock for its whole duration.
-- The existing full `memory_vec_*_hnsw_idx` is RETAINED and already serves
-- entity and unfiltered queries, so an entity partial index would buy nothing
-- it does not already have. Only the memory-side partial index is created here
-- (<=5,931 rows per table, ~40 MB); it is the half that carries the entire
-- measured win. Recorded as plan decision D-006.
--
-- BACKFILL COST. `ADD COLUMN ... DEFAULT <const>` is metadata-only in PG11+, so
-- defaulting to 'entity' (the 91% case) and correcting only the memory rows
-- turns a 66,262-row rewrite into a ~5,931-row one, and the rows it does
-- rewrite are exactly the ones the new partial index wants. The default is
-- DROPPED immediately afterwards so it can never mask a future unstamped
-- insert: with no default and NOT NULL, a write that dodges the trigger fails
-- loudly instead of silently landing on the entity side of the index.
--
-- Idempotent. No BEGIN/COMMIT -- the runner wraps each migration in its own
-- transaction (lint-migrations.test.ts fails the release gate on explicit
-- transaction control).

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The discriminator column, backfilled, on every per-mode vec table.
-- ---------------------------------------------------------------------------

-- These four ALTER TABLEs are written out LITERALLY rather than looped through
-- `EXECUTE format(...)` on purpose. A dynamic loop hides the table names behind a
-- `%I` placeholder, and repo tooling reads this directory as text:
-- `scripts/check-migration-forward-compat.mjs` pairs each added column with the
-- tables the migration ALTERs, and explicitly degrades to a column-name-only
-- match when it cannot parse one ("If no table could be parsed we fall back to
-- the column-only match"). Under the loop form it therefore matched every file
-- mentioning the ordinary word `row_kind` -- all of which mean the pre-existing
-- `memory_canonical.row_kind` -- and reported nine false dependencies. Spelling
-- the tables out keeps this migration greppable by table name, which is also how
-- a human finds "what touched memory_vec_harrier".

-- Metadata-only adds (constant default, PG11+): no table rewrite. Defaulting to
-- the 91% case means the backfill below rewrites ~5,931 rows instead of 66,262.
ALTER TABLE harness_shared.memory_vec_openai  ADD COLUMN IF NOT EXISTS row_kind text NOT NULL DEFAULT 'entity';
ALTER TABLE harness_shared.memory_vec_local   ADD COLUMN IF NOT EXISTS row_kind text NOT NULL DEFAULT 'entity';
ALTER TABLE harness_shared.memory_vec_gemma   ADD COLUMN IF NOT EXISTS row_kind text NOT NULL DEFAULT 'entity';
ALTER TABLE harness_shared.memory_vec_harrier ADD COLUMN IF NOT EXISTS row_kind text NOT NULL DEFAULT 'entity';

-- Correct the minority. `IS DISTINCT FROM` keeps a re-run a no-op.
UPDATE harness_shared.memory_vec_openai v SET row_kind = c.row_kind
  FROM harness_shared.memory_canonical c
 WHERE c.id = v.memory_id AND v.row_kind IS DISTINCT FROM c.row_kind;
UPDATE harness_shared.memory_vec_local v SET row_kind = c.row_kind
  FROM harness_shared.memory_canonical c
 WHERE c.id = v.memory_id AND v.row_kind IS DISTINCT FROM c.row_kind;
UPDATE harness_shared.memory_vec_gemma v SET row_kind = c.row_kind
  FROM harness_shared.memory_canonical c
 WHERE c.id = v.memory_id AND v.row_kind IS DISTINCT FROM c.row_kind;
UPDATE harness_shared.memory_vec_harrier v SET row_kind = c.row_kind
  FROM harness_shared.memory_canonical c
 WHERE c.id = v.memory_id AND v.row_kind IS DISTINCT FROM c.row_kind;

-- Drop the migration-time default: from here on the value must come from the
-- trigger, and an insert that evades the trigger must FAIL, not silently default
-- to the entity side of the index.
ALTER TABLE harness_shared.memory_vec_openai  ALTER COLUMN row_kind DROP DEFAULT;
ALTER TABLE harness_shared.memory_vec_local   ALTER COLUMN row_kind DROP DEFAULT;
ALTER TABLE harness_shared.memory_vec_gemma   ALTER COLUMN row_kind DROP DEFAULT;
ALTER TABLE harness_shared.memory_vec_harrier ALTER COLUMN row_kind DROP DEFAULT;

COMMENT ON COLUMN harness_shared.memory_vec_openai.row_kind IS
  'Denormalized mirror of memory_canonical.row_kind for THIS row''s memory_id (''memory'' | ''entity''), maintained by triggers -- never by an application write. Exists solely so the partial HNSW index can exclude entity vectors, which outnumber memory vectors ~10:1 and otherwise dominate every recall neighbourhood (plan memory-vector-entity-index-split-2026-09-02, D-004/D-005/D-006; migration 1093).';
COMMENT ON COLUMN harness_shared.memory_vec_local.row_kind IS
  'Denormalized mirror of memory_canonical.row_kind for THIS row''s memory_id (''memory'' | ''entity''), maintained by triggers -- never by an application write. Exists solely so the partial HNSW index can exclude entity vectors, which outnumber memory vectors ~10:1 and otherwise dominate every recall neighbourhood (plan memory-vector-entity-index-split-2026-09-02, D-004/D-005/D-006; migration 1093).';
COMMENT ON COLUMN harness_shared.memory_vec_gemma.row_kind IS
  'Denormalized mirror of memory_canonical.row_kind for THIS row''s memory_id (''memory'' | ''entity''), maintained by triggers -- never by an application write. Exists solely so the partial HNSW index can exclude entity vectors, which outnumber memory vectors ~10:1 and otherwise dominate every recall neighbourhood (plan memory-vector-entity-index-split-2026-09-02, D-004/D-005/D-006; migration 1093).';
COMMENT ON COLUMN harness_shared.memory_vec_harrier.row_kind IS
  'Denormalized mirror of memory_canonical.row_kind for THIS row''s memory_id (''memory'' | ''entity''), maintained by triggers -- never by an application write. Exists solely so the partial HNSW index can exclude entity vectors, which outnumber memory vectors ~10:1 and otherwise dominate every recall neighbourhood (plan memory-vector-entity-index-split-2026-09-02, D-004/D-005/D-006; migration 1093).';

-- Defense in depth: the value can only ever come from memory_canonical.row_kind,
-- whose own generation expression yields exactly these two literals.
--
-- Each ALTER TABLE below is spelled out literally INSIDE its guard rather than
-- built with `EXECUTE format('ALTER TABLE harness_shared.%I ...')`. The dynamic
-- form is what a loop would want, but it actively breaks
-- `scripts/check-migration-forward-compat.mjs`: its table regex reads
-- `ALTER TABLE harness_shared.%I` as targeting a table literally named
-- `harness_shared` (the `.%I` is not a parseable identifier), and that token
-- then matches essentially EVERY source file in the repo. The added-column scan
-- is qualified by those tokens, so the guard silently degrades to the bare
-- column-name flood its own comments say it exists to prevent -- reported here
-- as nine false dependencies on the ordinary word `row_kind`. Filed as
-- EI-22144711421464181.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vec_openai_row_kind_check'
                   AND conrelid = 'harness_shared.memory_vec_openai'::regclass) THEN
    ALTER TABLE harness_shared.memory_vec_openai
      ADD CONSTRAINT memory_vec_openai_row_kind_check CHECK (row_kind IN ('memory', 'entity'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vec_local_row_kind_check'
                   AND conrelid = 'harness_shared.memory_vec_local'::regclass) THEN
    ALTER TABLE harness_shared.memory_vec_local
      ADD CONSTRAINT memory_vec_local_row_kind_check CHECK (row_kind IN ('memory', 'entity'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vec_gemma_row_kind_check'
                   AND conrelid = 'harness_shared.memory_vec_gemma'::regclass) THEN
    ALTER TABLE harness_shared.memory_vec_gemma
      ADD CONSTRAINT memory_vec_gemma_row_kind_check CHECK (row_kind IN ('memory', 'entity'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vec_harrier_row_kind_check'
                   AND conrelid = 'harness_shared.memory_vec_harrier'::regclass) THEN
    ALTER TABLE harness_shared.memory_vec_harrier
      ADD CONSTRAINT memory_vec_harrier_row_kind_check CHECK (row_kind IN ('memory', 'entity'));
  END IF;
END
$do$;

-- ---------------------------------------------------------------------------
-- 2. Stamp the discriminator on every vec write.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION harness_shared.stamp_memory_vec_row_kind()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
    DECLARE
      kind text;
    BEGIN
      -- ALWAYS read from the canonical row; a caller-supplied value is ignored
      -- by construction, mirroring memory_canonical.row_kind's own
      -- "cannot be set by a writer" property.
      SELECT c.row_kind INTO kind
        FROM harness_shared.memory_canonical c
       WHERE c.id = NEW.memory_id;

      IF kind IS NULL THEN
        -- Unreachable through a committing path: the NOT DEFERRABLE FK on
        -- memory_id would reject this row at end of statement anyway. Raising
        -- here makes the cause legible at the point of failure instead of
        -- surfacing as a bare FK violation -- and guarantees a vector is never
        -- stored with an unknown kind, which would silently exclude it from the
        -- partial index below.
        RAISE EXCEPTION
          'memory_vec row_kind: no harness_shared.memory_canonical row for memory_id=% (table %)',
          NEW.memory_id, TG_TABLE_NAME
          USING ERRCODE = 'foreign_key_violation';
      END IF;

      NEW.row_kind := kind;
      RETURN NEW;
    END;
    $function$;

COMMENT ON FUNCTION harness_shared.stamp_memory_vec_row_kind() IS
  'Migration 1093 (plan memory-vector-entity-index-split-2026-09-02, D-004): copies memory_canonical.row_kind onto the vec row being written. The four in-repo vec INSERT sites all write only (memory_id, vector, embedded_at) and none has the kind in scope, so this is the only place the value can come from. Raises rather than stamping NULL: a vec row with no canonical row cannot commit (NOT DEFERRABLE FK), and a NULL kind would silently drop the vector out of the memory-only partial HNSW index.';

DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memory_vec_openai', 'memory_vec_local', 'memory_vec_gemma', 'memory_vec_harrier'
  ] LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER stamp_%s_row_kind_trg
         BEFORE INSERT OR UPDATE ON harness_shared.%I
         FOR EACH ROW
         EXECUTE FUNCTION harness_shared.stamp_memory_vec_row_kind()',
      t, t);
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------------------
-- 3. Propagate a canonical kind flip down to the vec tables.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION harness_shared.propagate_memory_row_kind()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
    BEGIN
      -- Fires only when the generated kind actually changed (see the trigger's
      -- WHEN clause), so this is a no-op in normal operation.
      UPDATE harness_shared.memory_vec_openai  SET row_kind = NEW.row_kind WHERE memory_id = NEW.id;
      UPDATE harness_shared.memory_vec_local   SET row_kind = NEW.row_kind WHERE memory_id = NEW.id;
      UPDATE harness_shared.memory_vec_gemma   SET row_kind = NEW.row_kind WHERE memory_id = NEW.id;
      UPDATE harness_shared.memory_vec_harrier SET row_kind = NEW.row_kind WHERE memory_id = NEW.id;
      RETURN NULL;
    END;
    $function$;

COMMENT ON FUNCTION harness_shared.propagate_memory_row_kind() IS
  'Migration 1093: memory_canonical.row_kind is GENERATED from payload, so a payload UPDATE can flip a row between ''memory'' and ''entity'' without touching memory_vec_*. The mem0 text-update path (canonical-store.ts:890) merges an arbitrary payload unguarded, so the flip is reachable. Without this, the denormalized vec-side copy would drift and the memory would vanish from recall silently. Fires only on an actual kind change.';

CREATE OR REPLACE TRIGGER propagate_memory_row_kind_trg
  AFTER UPDATE OF payload ON harness_shared.memory_canonical
  FOR EACH ROW
  WHEN (OLD.row_kind IS DISTINCT FROM NEW.row_kind)
  EXECUTE FUNCTION harness_shared.propagate_memory_row_kind();

-- ---------------------------------------------------------------------------
-- 4. The memory-only partial HNSW indexes -- the point of the whole exercise.
-- ---------------------------------------------------------------------------
--
-- The pre-existing full `memory_vec_*_hnsw_idx` is deliberately RETAINED (see
-- the header): it continues to serve entity and unfiltered queries, so nothing
-- regresses for them while memory recall gets a kind-pure structure to order
-- over. P-004 makes recall's query push the `row_kind = 'memory'` predicate down
-- so the planner can choose this index; until then this index is simply unused,
-- which is why this migration is safe to land on its own.

CREATE INDEX IF NOT EXISTS memory_vec_openai_hnsw_memory_idx
  ON harness_shared.memory_vec_openai USING hnsw (vector public.vector_cosine_ops)
  WHERE row_kind = 'memory';

CREATE INDEX IF NOT EXISTS memory_vec_local_hnsw_memory_idx
  ON harness_shared.memory_vec_local USING hnsw (vector public.vector_cosine_ops)
  WHERE row_kind = 'memory';

CREATE INDEX IF NOT EXISTS memory_vec_gemma_hnsw_memory_idx
  ON harness_shared.memory_vec_gemma USING hnsw (vector public.vector_cosine_ops)
  WHERE row_kind = 'memory';

CREATE INDEX IF NOT EXISTS memory_vec_harrier_hnsw_memory_idx
  ON harness_shared.memory_vec_harrier USING hnsw (vector public.vector_cosine_ops)
  WHERE row_kind = 'memory';
