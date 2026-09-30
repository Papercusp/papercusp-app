-- ⛔ PARKED — DO NOT RENAME TO `.sql` UNTIL THE 768 CODE IS DEPLOYED TO :3070.
--
-- Migration discovery is `filename.endsWith('.sql')` (migration-drift.ts:23, and
-- packages/operator-core/test/_pg-helpers.ts:200 for the integration-test path),
-- so this suffix is what keeps it from auto-applying on the next operator
-- restart — which on this box happens within the hour, routinely.
--
-- WHY IT IS PARKED. This migration and the code that emits 768 are MUTUALLY
-- BLOCKING, and applying them in the wrong order causes an outage of unbounded
-- length rather than a bounded one:
--   * migration first  -> all ~414k vectors are dropped, but the DEPLOYED code
--                         still emits 384, so every refill write fails and
--                         semantic search stays dead until the new code ships
--                         (gate-dependent, potentially many hours).
--   * code first       -> the code emits 768 into vector(384) columns; writes
--                         fail until this is applied, and the refill starts the
--                         instant it is. Self-healing, but see the tail below.
--
-- ⚠ THE CODE-FIRST TAIL IS NOT "A FEW MINUTES" — it is however long the GREEN
-- GATE takes, and that is not under your control. This header used to say the
-- writes "fail for the minutes until this is applied", which reads as a cost so
-- small it needs no monitoring. It is wrong in a way that matters: step 1 below
-- requires the 768 code to be DEPLOYED, and deployment requires green ->
-- main fast-forward -> deploy. A red gate therefore extends this window
-- arbitrarily.
-- MEASURED 2026-08-03 (EI-19389713448796977), with the gate at 9 consecutive
-- reds: the skew opened at 23:17:13Z the moment 768 reached the STAGING tree
-- (staging-tree hosts — bg-host routines, :3170, gateway :8788 — run tsx from
-- the working tree, so they pick up a new constant immediately, long before any
-- deploy), and 1h11m later had silently skipped 56 code_recipes embeds, 1
-- session_turn embed, and 12 code:run recipe captures, still accruing ~1 per 30s.
-- The ordering choice above is still CORRECT — code-first is genuinely the
-- lesser evil, and NONE of this is corruption: pgvector REJECTS a mismatched
-- write rather than coercing it, and every skipped row keeps `embedding IS NULL`,
-- which is exactly what the refill selects on. It all comes back.
-- What you should take from this: the window is OBSERVABLE and worth watching,
-- not a rounding error --
--   journalctl --user --since "1 hour ago" | grep "different vector dimensions"
-- and the failures are SWALLOWED (the log line says so), so nothing will tell
-- you it is still happening unless you look.
-- So: DEPLOY THE CODE, THEN rename this to `.sql` and apply it.
--
-- TO ENACT (plan P-006):
--   1. Confirm the 768 code is live:
--      dev:pipeline_position {
--        path: 'packages/operator-core/lib/search/prose-vector-dims.ts',
--        marker: 'PROSE_VECTOR_DIMS = 768'
--      }
--      -> require BOTH legs, in this order:
--           positionsMarker.deployed.present === true   (MY change is in the
--                                                        release checkout)
--           serving.startedSinceCodeChange   === true   (the process restarted
--                                                        since that checkout)
--
--      ⚠⚠ DO NOT GATE ON `serving.startedSinceCodeChange` ALONE — the original
--      version of this step did, and it is WRONG IN THE DANGEROUS DIRECTION.
--      The two legs answer DIFFERENT questions and only their conjunction means
--      "my code is live": startedSinceCodeChange says the serving process is
--      not stale relative to ITS OWN checkout — a statement about a PROCESS,
--      silent on whether YOUR change is in that checkout. So it reads TRUE for
--      a release checkout that does not contain this change at all, and alone
--      it green-lights precisely the migration-first ordering the header above
--      warns costs an outage of unbounded length.
--      (This does not contradict the repo guide's "is the running process
--      executing my code -> serving.startedSinceCodeChange" row: that row is
--      steering you away from the GIT-side `positions.deployed` boolean. The
--      marker leg used here, positionsMarker.deployed.present, is a different
--      and stronger read — it greps the deployed sha for YOUR marker.)
--      MEASURED 2026-08-02 19:41Z, both legs in the SAME tool result:
--        serving.startedSinceCodeChange = true
--        positionsMarker.deployed.present = false   <- 768 code NOT deployed
--      Following the old step 1 that morning would have applied this migration
--      with ~414k vectors dropped and the deployed code still emitting 384.
--      Only the marker leg answers "is MY code live"; it is also explicitly
--      corroborated ("a genuine miss, not a newer-commit artifact").
--
--   2. git mv this file to drop the .PENDING-CODE-DEPLOY suffix.
--   3. Apply via the RUNNER — the **`db:migrate` MCP TOOL**:
--        db:migrate { file: '<abs path to this file>', confirm: true }
--      ⚠ NOT `npm run db:migrate` (what the original step 3 said): that script
--      DOES NOT EXIST in this repo — the only migration-ish root scripts are
--      db:next-migration, lint:migrations, lint:migration-forward-compat, so
--      the command fails with a bare npm "Missing script" and reads like a
--      broken environment rather than a wrong instruction (plan P-006 D-006).
--      Either way NEVER `psql -f`: that leaves no schema_migrations row, so the
--      DDL re-runs on every deploy and a lock-contending re-run trips the
--      deploy's 15s lock_timeout and rolls it back.
--   4. node libs/papercusp/libs/db/scripts/pull-schema.mjs
--   5. Watch the backfill sweep refill (~414k vectors). Drive it with PARALLEL
--      WORKERS, never a batching loop (EI-19363253682489176); single-worker is
--      ~217 ms/doc ≈ 24h.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 727 — Widen every shared prose/registry embedding column from vector(384) to
-- vector(768), EmbeddingGemma-300m's NATIVE width.
--
-- Plan: prose-embedding-384-untrained-mrl-fix-2026-08-02, D-005 (enacting
-- D-004 route (ii) at 768 rather than 512). Root issue: EI-19301722864393687.
--
-- WHY. 384 was an UNTRAINED MRL cut of a 768-native model, chosen to fit
-- columns that already existed. Measured (D-003) it cost ~19-21% of prose
-- retrieval MRR: gemma@384 scores .2889 MRR against @512 .3435 and @768 .3492,
-- and the paired bootstrap vs @384 excludes zero for both (@768 +.0603,
-- CI [.0210,.1022]). 768 rather than 512 because the model runs a native-768
-- forward pass either way — so the two cost the SAME ~414k re-embeds — and at
-- the native width there is no truncation left to get wrong.
--
-- ⚠⚠ THIS DROPS EVERY STORED VECTOR IN THESE COLUMNS. pgvector cannot cast
-- between widths, so there is no in-place widening and no incremental path:
-- unlike a same-width MODEL swap, which migration 530's per-row
-- `<col>_mode` discriminator lets converge row-by-row, a WIDTH change is
-- necessarily all-at-once. ~414k vectors are discarded here and refilled by the
-- embed-backfill sweep at ~217 ms/doc (~24h single-worker, less in parallel).
-- Until it catches up the affected surfaces run LEXICAL-ONLY — degraded, not
-- broken: hybrid search keeps its full-text leg.
--
-- The `<col>_mode` discriminator makes that refill self-healing: the sweep's
-- predicate is "vector missing OR produced by a different embedder than the
-- active one", so every NULLed row is simply eligible again.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TWO CLASSES OF OBJECT BLOCK AN `ALTER COLUMN ... TYPE`, NOT ONE.
--
-- The first version of this migration handled only INDEXES and would have
-- failed on the very first table with a dependent view (EI-19364746461986832):
--
--   PostgresError: cannot alter type of a column used by a view or rule
--     detail: rule _RETURN on view harness_shared.harness_features_consolidated
--             depends on column "embedding"
--
-- Both classes now get identical treatment — DISCOVER (never hardcode), capture
-- the definition verbatim, drop, ALTER, recreate:
--
--   * INDEXES are discovered from pg_index by ATTNUM, not by matching the
--     column name inside indexdef text. The previous `indexdef ILIKE '%(' || c
--     || ' %'` form silently missed any index written without a trailing space
--     (e.g. a plain `(embedding)`), and an HNSW index is dimension-bound, so a
--     missed one fails the ALTER.
--
--   * VIEWS are discovered by a RECURSIVE walk of pg_depend/pg_rewrite, because
--     the dependency graph is neither shallow nor confined to this schema:
--         work_items.embedding
--           <- harness_shared.harness_features_consolidated   (rank 1)
--           <- harness_shared.work_items_claimable            (rank 1)
--                <- <every per-harness schema>.harness_features (rank 2)
--     That last rank is ~35 views TODAY (harness_papercusp, harness_oddsmith,
--     harness_quartermaster, ~25 harness_contract_test_* ...) and grows with
--     every new pot, so naming them literally is not an option. They are
--     dropped deepest-first and recreated shallowest-first, with owner, grants,
--     reloptions and comment restored.
--
-- Views need no width change of their own: a view's column simply reports the
-- base column's type, so recreating it after the ALTER yields vector(768) free.
--
-- ⚠ THE MISTAKE THAT PRODUCED THE ORIGINAL BUG, so it is not repeated: the
-- target list below was built from `pg_attribute` WITHOUT filtering
-- `relkind`, which silently mixes VIEWS in among the TABLES. Two of the
-- fourteen original entries — harness_features and harness_features_consolidated
-- — are relkind='v', and `ALTER TABLE ... ALTER COLUMN` against a view fails.
-- The list is now TABLES ONLY (relkind='r'), and a view appearing in it RAISES
-- rather than being skipped, because a silent skip is what leaves a surface at
-- vector(384) under 768-emitting code.
--
-- COLUMN LIST WAS ENUMERATED FROM pg_attribute (relkind='r'), NOT from the
-- migration files. Grepping migrations yields FIVE of these and silently misses
-- the rest (code_recipes, harness_brainstorm, harness_decisions,
-- harness_escalations, datatype_registry). A partial migration is the dangerous
-- outcome: the missed surfaces keep vector(384) while the code emits 768, so
-- every write to them fails inside a background sweep nobody is watching.
--
-- NOT INCLUDED, deliberately: memory_vec_local stays vector(384) (bge-small is
-- natively 384 with no MRL — it CANNOT emit 768, so `local` simply becomes
-- prose-ineligible, see D-005 §6) and memory_vec_harrier stays vector(1024).
-- Those are per-mode spaces, not the shared contract.
--
-- ⚠ THE TARGET COUNT DOES NOT MATCH A NAIVE pg_attribute RE-ENUMERATION, and
-- that is INTENTIONAL — do not "fix" it by adding the difference. An auditor
-- re-running the enumeration that built this list gets SIXTEEN vector(384)
-- columns on relkind='r' in harness_shared, against the TWELVE targets below.
-- The delta is 1 + 3, both accounted for:
--   * memory_vec_local  — the deliberate exclusion documented just above.
--   * THREE FROZEN SNAPSHOTS, inert by construction, left at vector(384):
--       _pot_backfill_649_dropped      (embedding,  ~103 rows)
--       bak_20260717_unify_work_items  (embedding, ~2301 rows)
--       bak_wi5720_retired_slug_plans  (embedding,   ~79 rows)
--     These are point-in-time backups taken by earlier migrations, NOT live
--     surfaces. Verified 2026-08-02 that they have no live write path: every
--     reference in the tree is (a) the migration that created them (649 / 656),
--     (b) identity-keyed-state-inventory.test.ts, or (c) auto-generated
--     schema.ts / generated.ts. Nothing writes them at runtime, so the
--     "a missed surface keeps vector(384) under 768-emitting code and every
--     write fails in a background sweep" hazard above CANNOT fire for them —
--     there is no write. Widening them would rewrite ~2.5k rows of frozen
--     backup to no purpose, and would corrupt their value as a snapshot of the
--     384 era.
--   16 enumerated − 1 documented exclusion − 3 inert snapshots = 12 targets. ✓
--   Cross-check on the other side: the dependent-view closure drops+recreates
--   37 views (34 per-harness harness_features + 3 in harness_shared), which is
--   exactly the count observed on WI-7106's clone run. Both sides balance; if
--   either number moves, something changed in the schema — re-derive, do not
--   assume.
--
-- Idempotent: every step is guarded on the column's CURRENT width, so a re-run
-- (or a run against a fresh DB already created at 768) is a no-op — and when
-- nothing needs widening it returns BEFORE touching a single view.

DO $$
DECLARE
  -- TABLES ONLY (relkind='r'). Keep in sync with PROSE_VECTOR_COLUMNS in
  -- packages/operator-core/lib/search/prose-vector-dims.ts — the integration
  -- test compares that list against the live schema.
  targets text[][] := ARRAY[
    ARRAY['session_turns',       'text_embedding'],
    ARRAY['operator_turns',      'text_embedding'],
    ARRAY['work_items',          'embedding'],
    ARRAY['doc_sections',        'embedding'],
    ARRAY['harness_plans',       'embedding'],
    ARRAY['harness_escalations', 'body_embedding'],
    ARRAY['harness_brainstorm',  'content_embedding'],
    ARRAY['harness_decisions',   'body_embedding'],
    ARRAY['code_recipes',        'embedding'],
    ARRAY['datatype_registry',   'embedding'],
    -- The gemma memory space moves with gemma's target width.
    ARRAY['memory_vec_gemma',    'vector'],
    -- The openai memory space moves too: openai's targetDims goes 384 -> 768 so
    -- that it stays prose-eligible (continuous MRL, billed per token not per
    -- dimension, so the width is free).
    ARRAY['memory_vec_openai',   'vector']
  ];

  -- Parallel arrays rather than a 2-D array: plpgsql cannot append a row to a
  -- 2-D array, and these feed the closure query below as unnest(a, b).
  need_t text[] := ARRAY[]::text[];
  need_c text[] := ARRAY[]::text[];

  t text;
  c text;
  cur_dims int;
  col_notnull boolean;
  rk "char";
  idx record;
  v record;
  g record;
  stmt text;

  -- Captured DDL, replayed after the type change. Arrays, not temp tables: no
  -- ON COMMIT semantics to reason about and the statements are plain text.
  index_rebuild_stmts text[] := ARRAY[]::text[];
  view_drop_stmts     text[] := ARRAY[]::text[];
  view_rebuild_stmts  text[] := ARRAY[]::text[];
BEGIN
  -- pgvector must be present; every column below is already a vector type, so
  -- if the extension is missing this DB has no embedding columns to widen.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE NOTICE '727: pgvector not installed — nothing to widen';
    RETURN;
  END IF;

  -- ── PASS 1 ── Decide what actually needs widening, and validate the list. ──
  FOR i IN 1 .. array_length(targets, 1) LOOP
    t := targets[i][1];
    c := targets[i][2];

    SELECT cl.relkind INTO rk
      FROM pg_class cl
      JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = 'harness_shared' AND cl.relname = t;

    -- A deployment that simply does not have this table yet.
    IF rk IS NULL THEN
      RAISE NOTICE '727: harness_shared.% absent — skipped', t;
      CONTINUE;
    END IF;

    -- A view in the TARGET list is a list bug, not a runtime condition: it can
    -- never be ALTERed, and skipping it quietly is how a surface gets stranded
    -- at vector(384) under 768-emitting code. Fail loudly instead.
    IF rk <> 'r' THEN
      RAISE EXCEPTION
        '727: harness_shared.% is relkind ''%'', not a table. A VIEW must not be listed as a target — it inherits its width from the base column and is dropped/recreated automatically by the closure below. (This shipped once: the list was built from pg_attribute without filtering relkind.)',
        t, rk;
    END IF;

    SELECT a.atttypmod INTO cur_dims
      FROM pg_attribute a
      JOIN pg_class cl ON cl.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_type ty ON ty.oid = a.atttypid
     WHERE n.nspname = 'harness_shared'
       AND cl.relname = t
       AND a.attname = c
       AND ty.typname = 'vector'
       AND a.attnum > 0
       AND NOT a.attisdropped;

    IF cur_dims IS NULL THEN
      RAISE NOTICE '727: harness_shared.%.% is not a vector column — skipped', t, c;
      CONTINUE;
    END IF;

    IF cur_dims = 768 THEN
      RAISE NOTICE '727: harness_shared.%.% already vector(768) — skipped', t, c;
      CONTINUE;
    END IF;

    need_t := need_t || t;
    need_c := need_c || c;
  END LOOP;

  -- Re-run / fresh-DB case: return BEFORE dropping any view.
  IF array_length(need_t, 1) IS NULL THEN
    RAISE NOTICE '727: every target already vector(768) — no-op';
    RETURN;
  END IF;

  RAISE NOTICE '727: % column(s) to widen', array_length(need_t, 1);

  -- ── PASS 2 ── Capture the transitive closure of dependent views. ───────────
  -- Ordered shallowest-first (topological rank = LONGEST path from a target, so
  -- a view always sorts after everything it reads). Rebuilds replay in this
  -- order; drops are accumulated in reverse by prepending.
  FOR v IN
    WITH RECURSIVE tgt AS (
      SELECT cl.oid, a.attnum
        FROM unnest(need_t, need_c) AS u(tname, cname)
        JOIN pg_class cl ON cl.relname = u.tname AND cl.relkind = 'r'
        JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'harness_shared'
        JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attname = u.cname
                           AND a.attnum > 0 AND NOT a.attisdropped
    ),
    dep(view_oid, depth) AS (
      -- Views whose rewrite rule references one of the target COLUMNS.
      -- refobjsubid is the column: a view reading other columns of the same
      -- table does NOT block the ALTER and must not be dropped.
      SELECT r.ev_class, 1
        FROM pg_depend d
        JOIN pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
       WHERE d.refclassid = 'pg_class'::regclass
         AND (d.refobjid, d.refobjsubid) IN (SELECT oid, attnum FROM tgt)
         AND r.ev_class <> d.refobjid
      UNION
      -- ...and views built on THOSE views, to any depth.
      SELECT r.ev_class, dep.depth + 1
        FROM dep
        JOIN pg_depend d ON d.refobjid = dep.view_oid AND d.refclassid = 'pg_class'::regclass
        JOIN pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
       WHERE r.ev_class <> dep.view_oid AND dep.depth < 20
    )
    SELECT dep.view_oid                              AS oid,
           max(dep.depth)                            AS topo,
           nv.nspname                                AS nsp,
           cv.relname                                AS rel,
           cv.relkind                                AS kind,
           pg_get_viewdef(dep.view_oid, true)        AS def,
           pg_get_userbyid(cv.relowner)              AS owner,
           cv.relacl                                 AS acl,
           cv.reloptions                             AS opts,
           obj_description(dep.view_oid, 'pg_class') AS cmt
      FROM dep
      JOIN pg_class cv ON cv.oid = dep.view_oid
      JOIN pg_namespace nv ON nv.oid = cv.relnamespace
     GROUP BY dep.view_oid, nv.nspname, cv.relname, cv.relkind,
              cv.relowner, cv.relacl, cv.reloptions
     ORDER BY max(dep.depth) ASC, nv.nspname, cv.relname
  LOOP
    -- A materialized view would additionally need its data repopulated and its
    -- own indexes rebuilt. None exist today; refuse rather than guess.
    IF v.kind <> 'v' THEN
      RAISE EXCEPTION
        '727: dependent relation %.% is relkind ''%'' — this migration only knows how to drop and recreate plain VIEWs. Refusing rather than silently mishandling it.',
        v.nsp, v.rel, v.kind;
    END IF;

    -- Deepest-first drop order, built by prepending as we walk shallowest-first.
    -- No CASCADE: if the closure ever misses a dependent, the DROP must fail
    -- loudly and roll the migration back rather than destroy an object we
    -- captured no definition for.
    view_drop_stmts := ARRAY[format('DROP VIEW %I.%I', v.nsp, v.rel)] || view_drop_stmts;

    view_rebuild_stmts := view_rebuild_stmts
      || format('CREATE VIEW %I.%I AS %s', v.nsp, v.rel, v.def);

    -- Recreated objects are owned by whoever runs the migration; restore the
    -- original owner explicitly so a runner role change cannot silently
    -- re-home these views.
    view_rebuild_stmts := view_rebuild_stmts
      || format('ALTER VIEW %I.%I OWNER TO %I', v.nsp, v.rel, v.owner);

    IF v.opts IS NOT NULL THEN
      view_rebuild_stmts := view_rebuild_stmts
        || format('ALTER VIEW %I.%I SET (%s)', v.nsp, v.rel, array_to_string(v.opts, ', '));
    END IF;

    -- DROP discards grants, so replay them from the captured ACL. A NULL acl
    -- means defaults-only (owner privileges), which the ALTER ... OWNER above
    -- already restores.
    IF v.acl IS NOT NULL THEN
      FOR g IN
        SELECT ae.privilege_type AS priv,
               CASE WHEN ae.grantee = 0 THEN 'PUBLIC'
                    ELSE quote_ident(pg_get_userbyid(ae.grantee)) END AS grantee
          FROM aclexplode(v.acl) ae
      LOOP
        view_rebuild_stmts := view_rebuild_stmts
          || format('GRANT %s ON %I.%I TO %s', g.priv, v.nsp, v.rel, g.grantee);
      END LOOP;
    END IF;

    IF v.cmt IS NOT NULL THEN
      view_rebuild_stmts := view_rebuild_stmts
        || format('COMMENT ON VIEW %I.%I IS %L', v.nsp, v.rel, v.cmt);
    END IF;
  END LOOP;

  IF array_length(view_drop_stmts, 1) IS NULL THEN
    RAISE NOTICE '727: no dependent views';
  ELSE
    RAISE NOTICE '727: % dependent view(s) to drop and recreate', array_length(view_drop_stmts, 1);
  END IF;

  -- ── PASS 3 ── Drop the views (deepest dependents first). ───────────────────
  FOREACH stmt IN ARRAY view_drop_stmts LOOP
    RAISE NOTICE '727: %', stmt;
    EXECUTE stmt;
  END LOOP;

  -- ── PASS 4 ── Drop dependent indexes, widen, reset the mode discriminator. ─
  FOR i IN 1 .. array_length(need_t, 1) LOOP
    t := need_t[i];
    c := need_c[i];

    -- Discovered from pg_index BY ATTNUM. An HNSW/IVFFlat index is bound to the
    -- column's dimensionality so it must be dropped before the type change and
    -- rebuilt after; pg_get_indexdef gives back opclass, operator class options
    -- and any WHERE clause verbatim, so nothing has to be re-guessed.
    FOR idx IN
      SELECT ci.relname AS indexname,
             pg_get_indexdef(ix.indexrelid) AS indexdef,
             ix.indisprimary OR ix.indisunique OR ix.indisexclusion AS constraint_backed
        FROM pg_index ix
        JOIN pg_class ci ON ci.oid = ix.indexrelid
        JOIN pg_class ct ON ct.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = ct.relnamespace
        JOIN pg_attribute a ON a.attrelid = ct.oid AND a.attname = c
       WHERE n.nspname = 'harness_shared'
         AND ct.relname = t
         AND a.attnum = ANY (ix.indkey::smallint[])
    LOOP
      -- FORWARD-COMPAT: these DROP INDEXes cannot break the deployed release.
      -- The EI-18797473716313783 hazard is dropping an index the running code
      -- infers as an ON CONFLICT arbiter — and an arbiter must be a UNIQUE,
      -- PRIMARY KEY or EXCLUSION index. This loop REFUSES to drop any of those:
      -- `constraint_backed` (line above) is exactly
      -- `indisprimary OR indisunique OR indisexclusion`, and the guard below
      -- RAISEs instead of dropping. So the only indexes this can drop are
      -- non-unique ones — here the HNSW/ivfflat vector indexes on the columns
      -- being widened, which no ON CONFLICT can ever name. Each one is also
      -- rebuilt from its own `pg_get_indexdef` in this SAME transaction
      -- (`index_rebuild_stmts`), so the deployed release never observes a
      -- window without it; the HNSW graphs then refill incrementally as the
      -- backfill sweep restores the vectors. This is a genuine "the deployed
      -- release does not use this" case, NOT an expand/contract deferral.
      --
      -- Dropping a constraint-backing index needs ALTER TABLE ... DROP
      -- CONSTRAINT and would silently drop the constraint with it.
      IF idx.constraint_backed THEN
        RAISE EXCEPTION
          '727: index % on harness_shared.%.% backs a constraint — refusing to drop it blindly.',
          idx.indexname, t, c;
      END IF;

      RAISE NOTICE '727: dropping % to widen %.%', idx.indexname, t, c;
      index_rebuild_stmts := index_rebuild_stmts || idx.indexdef;
      EXECUTE format('DROP INDEX IF EXISTS harness_shared.%I', idx.indexname);
    END LOOP;

    -- ── A NOT NULL column cannot be widened with USING NULL. ─────────────────
    -- `USING NULL` sets every row to NULL, which a NOT NULL column rejects:
    --   column "vector" of relation "memory_vec_gemma" contains null values
    -- Both memory_vec_gemma.vector and memory_vec_openai.vector are NOT NULL,
    -- so this aborted the whole migration and left it PERMANENTLY pending. That
    -- is worse than one broken migration: release:checkpoint-run preflights with
    -- applyPendingMigrationsNow() and refuses on `failed.length > 0`, so a
    -- permanently-failing 727 took the fleet's only manual gate lever down for
    -- everyone, with a message that reads like the caller's problem
    -- (EI-19404620261958999).
    --
    -- ⚠⚠ DO NOT "FIX" THIS BY DROPPING THE NOT NULL. That applies cleanly, looks
    -- successful, and PERMANENTLY STRANDS every vector in the table — a far worse
    -- outcome than the loud failure it replaces, because nothing reports it.
    -- BOTH refill paths select on ROW ABSENCE, never on a NULL vector:
    --   * packages/operator-core/lib/memory/federated-vec-backfill.ts
    --       selectFederatedRowsMissingVectors:
    --       NOT EXISTS (SELECT 1 FROM <vecTable> v WHERE v.memory_id = c.id)
    --   * libs/generic/memory/src/reembed.ts:
    --       NOT EXISTS (SELECT 1 FROM <toTable> t WHERE t.memory_id = c.id)
    -- A surviving NULL-vector row therefore satisfies EXISTS, is never selected,
    -- and never gets a vector again: semantic recall for that mode degrades to
    -- nothing, with no error and no log line. (vec-write.ts documents the same
    -- silent-failure shape for a stale MODE_DIMS entry.)
    --
    -- DELETE is the correct treatment, and ONLY for a pure vector-join table
    -- whose row exists solely to carry the vector. memory_vec_* is
    -- (memory_id PK -> memory_canonical, vector, embedded_at): the TEXT survives
    -- in memory_canonical, and the row is rebuilt by vec-write.ts's
    -- `ON CONFLICT (memory_id) DO UPDATE` upsert. So this is the SAME data loss
    -- the header already describes for every other column here — expressed the
    -- only way this table shape permits, and self-healing by the same sweep.
    SELECT a.attnotnull INTO col_notnull
      FROM pg_attribute a
      JOIN pg_class cl ON cl.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND cl.relname = t
       AND a.attname = c
       AND a.attnum > 0
       AND NOT a.attisdropped;

    IF col_notnull THEN
      -- Narrow BY CONSTRUCTION: only the per-mode vector-join tables. Any other
      -- NOT NULL vector column belongs to a table whose rows carry content, so
      -- deleting them would destroy data the widening was never meant to touch —
      -- and dropping the NOT NULL would strand them per the note above. Neither
      -- is safe, so refuse loudly: the same rule as the relkind, materialized-view
      -- and constraint-backed-index checks elsewhere in this migration.
      IF left(t, 11) = 'memory_vec_' THEN
        RAISE NOTICE
          '727: harness_shared.%.% is NOT NULL — deleting rows so the widening can proceed (refill re-INSERTs them; see comment above)',
          t, c;
        EXECUTE format('DELETE FROM harness_shared.%I', t);
      ELSE
        RAISE EXCEPTION
          '727: harness_shared.%.% is NOT NULL and is not a memory_vec_* join table. USING NULL cannot satisfy it; dropping the NOT NULL would strand every row (both refill paths select on row ABSENCE, not on a NULL vector) and deleting rows would destroy content. Refusing rather than guessing.',
          t, c;
      END IF;
    END IF;

    -- The widening itself. USING NULL because no cast exists between vector
    -- widths — this is the all-at-once data loss the header describes.
    RAISE NOTICE '727: widening harness_shared.%.% to vector(768)', t, c;
    EXECUTE format(
      'ALTER TABLE harness_shared.%I ALTER COLUMN %I TYPE public.vector(768) USING NULL',
      t, c
    );

    -- Force the backfill sweep to treat every row as needing work. The vector
    -- is now NULL; clearing the space tag too keeps the pair consistent, since
    -- "has a mode but no vector" is a state no writer ever produces.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = t AND column_name = c || '_mode'
    ) THEN
      EXECUTE format('UPDATE harness_shared.%I SET %I = NULL WHERE %I IS NOT NULL',
                     t, c || '_mode', c || '_mode');
    END IF;
  END LOOP;

  -- ── PASS 5 ── Rebuild indexes. ─────────────────────────────────────────────
  -- Cheap here: the columns are now all-NULL, so each build is near-instant and
  -- HNSW fills in incrementally as the backfill sweep refills the vectors.
  FOREACH stmt IN ARRAY index_rebuild_stmts LOOP
    RAISE NOTICE '727: rebuilding index: %', left(stmt, 80);
    EXECUTE stmt;
  END LOOP;

  -- ── PASS 6 ── Recreate the views (shallowest first), with owner/grants. ────
  FOREACH stmt IN ARRAY view_rebuild_stmts LOOP
    EXECUTE stmt;
  END LOOP;

  RAISE NOTICE '727: done — % column(s) widened, % view statement(s) replayed',
    array_length(need_t, 1), coalesce(array_length(view_rebuild_stmts, 1), 0);
END $$;
