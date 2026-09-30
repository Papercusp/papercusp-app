-- Migration 704 — re-scope the `harness:papercup` memory pool onto `harness:papercusp`
-- (plan context-injection-audit-2026-07-28, P-031 / F-A; owner-directed).
--
-- papercup and papercusp are the SAME project: the identity migration completed
-- 2026-06-20 (plan papercup-to-papercusp-migration-2026-06-20) and there is no
-- `papercup` entry in harness_registry. But the memory pool was never re-scoped,
-- so ~3.5 weeks of the project's own recorded knowledge sits under a scope the
-- auto-injector never queries. The data is intact and reachable by an explicit
-- pull — it is simply outside the injector's queried scope (correcting the plan's
-- D-006 gate 2, which called it "permanently unreachable").
--
-- ─── THE PAYLOAD IS THE SOLE SOURCE OF TRUTH; THE COLUMNS ARE GENERATED ───
--
-- Recall does NOT filter on the `user_id` COLUMN. CanonicalVectorStore.search
-- builds its predicate as `c.payload->>'<key>' = $n` (canonical-store.ts), so the
-- pool is selected by **payload->>'user_id'** — the trap migration 156's header
-- flagged ("mem0 stores its fields FLAT in payload ... filtering recall by
-- payload->>'user_id'").
--
-- Stronger than that, and the reason this migration is payload-only: `user_id` and
-- `workspace_id` are GENERATED ALWAYS columns —
--     user_id      GENERATED ALWAYS AS (payload ->> 'user_id')
--     workspace_id GENERATED ALWAYS AS (payload ->> 'workspace_id')
-- so they cannot be written at all (Postgres: "column can only be updated to
-- DEFAULT"), and they re-derive automatically the instant the payload changes.
-- A column-targeted re-scope is not merely ineffective here, it is impossible.
--
-- Fields carrying the stale identity, all inside `payload`:
--   1. `payload->>'user_id'`      — 'harness:papercup' → 'harness:papercusp'
--                                    (THE recall key; also regenerates user_id)
--   2. `payload->>'harness_slug'` — 'papercup' → 'papercusp'  (629 rows)
--   3. `payload->>'workspace_id'` — every row on the stale workspace 'papercup'
--                                    (no such workspace) → 'papercusp-workspace';
--                                    also regenerates the workspace_id column.
--                                    10 rows: 5 in the papercup harness pool and
--                                    5 in a per-USER pool. The user-pool ones were
--                                    found by this migration's own drain assertion
--                                    and are the more consequential half — see the
--                                    comment on step 3.
-- NOT rewritten: `payload->>'scope'`, which holds the KIND marker 'harness' (not a
-- pool id), and the `harness_slug` COLUMN, which is never 'papercup' here.
--
-- ─── SCOPE: 5,258 rows, but only 644 of them are MEMORIES ───
--
-- The pool splits by store kind. `storeKindCond` selects memory rows with
-- `NOT (payload ? 'entityType')` and entity rows with `payload ? 'entityType'`:
--   • 644 MEMORY rows   (498 active + 146 broken_anchor)  ← what recall injects
--   • 4,614 ENTITY rows (mem0's entity graph)             ← the entity-boost signal
-- BOTH are re-scoped: the entity graph is scoped by the same user_id, so migrating
-- only the memories would orphan the graph that boosts them.
-- This corrects the plan's D-009, which read the whole 5,258 as "memories" — the
-- NULL-workspace_id bulk it noticed is the entity graph, which carries no
-- workspace_id. (It also means P-031's original "638 / lands at 1,408" figures were
-- nearer the truth than D-009's restatement; the real memory-row total after this
-- migration is 644 + 798 = 1,442.)
--
-- ─── EMBEDDINGS: no re-embed needed (CONFIRMED, not assumed — P-031 req 2) ───
--
-- memory_vec_{gemma,harrier,local,openai} are (memory_id, vector, embedded_at)
-- with an FK on memory_id and NO scope/user_id column, so re-scoping by user_id
-- leaves every vector correctly attached. Nothing to re-embed.
--
-- ─── DEDUP: nothing to do for memories (P-031 req 3) ───
--
-- Measured before writing: of the 644 incoming MEMORY rows, exactly 0 duplicate an
-- existing papercusp memory by normalized text, and 0 duplicate each other. (The
-- 100 + 27 exact duplicates found across the raw pool are all ENTITY rows, where
-- repeated names are normal.) Residual NEAR-duplicates are already collapsed at
-- render time by collapseNearDuplicates (P-008), so no dedup pass is added here.
--
-- Durability: all 5,258 rows are origin='local', source_hive=NULL — none arrived by
-- federation, so this re-scope will not be re-injected from a peer.
--
-- Idempotent: predicated on the papercup identity, so a second run matches 0 rows.
-- On a fresh/embedded-pg boot there are no papercup rows and every statement is a
-- no-op. Composes onto 000-baseline. Runs as harness_admin.

-- The migration runner already opens a transaction, and the whole body is a single
-- atomic DO block, so this file deliberately carries no BEGIN/COMMIT of its own.
\set ON_ERROR_STOP on

DO $$
DECLARE
  n_payload  bigint := 0;
  n_hslug    bigint := 0;
  n_ws       bigint := 0;
  n_left     bigint := 0;
BEGIN
  IF to_regclass('harness_shared.memory_canonical') IS NULL THEN
    RAISE NOTICE '[704] memory_canonical absent — nothing to re-scope';
    RETURN;
  END IF;

  -- 1) THE RECALL KEY: payload->>'user_id'. This is the one that actually moves
  --    the memories into the injector's queried scope. The generated `user_id`
  --    column re-derives from it automatically.
  UPDATE harness_shared.memory_canonical
     SET payload    = jsonb_set(payload, '{user_id}', '"harness:papercusp"'::jsonb, true),
         updated_at = now()
   WHERE payload->>'user_id' = 'harness:papercup';
  GET DIAGNOSTICS n_payload = ROW_COUNT;

  -- 2) The payload's own harness_slug (629 rows), so no papercup identity survives
  --    on a row that now lives in the papercusp pool.
  UPDATE harness_shared.memory_canonical
     SET payload    = jsonb_set(payload, '{harness_slug}', '"papercusp"'::jsonb, true),
         updated_at = now()
   WHERE payload->>'harness_slug' = 'papercup'
     AND payload->>'user_id' = 'harness:papercusp';
  GET DIAGNOSTICS n_hslug = ROW_COUNT;

  -- 3) Stale workspace 'papercup' — no such workspace exists. Deliberately NOT
  --    restricted to the papercup pool: 5 of these rows live in a per-USER pool,
  --    and for those the stale tag is actively harmful. The user-pool workspace
  --    filter (keepUserPoolHitForWorkspace, data-scoping-audit D-004/D-012) DROPS a
  --    `project` hit tagged with a different workspace, so a row tagged 'papercup'
  --    is silently excluded from recall under 'papercusp-workspace' — the same
  --    class of defect F-A exists to fix, just in a different pool. Written through
  --    the payload; the generated workspace_id column follows.
  UPDATE harness_shared.memory_canonical
     SET payload    = jsonb_set(payload, '{workspace_id}', '"papercusp-workspace"'::jsonb, true),
         updated_at = now()
   WHERE payload->>'workspace_id' = 'papercup';
  GET DIAGNOSTICS n_ws = ROW_COUNT;

  -- 4) Assert the pool is fully drained — catches a partially-rewritten identity
  --    (the failure mode this migration's header exists to prevent). Covers the
  --    generated columns too, so a payload/column divergence would also trip it.
  SELECT count(*) INTO n_left
    FROM harness_shared.memory_canonical
   WHERE user_id = 'harness:papercup'
      OR payload->>'user_id' = 'harness:papercup'
      OR payload->>'harness_slug' = 'papercup'
      OR payload->>'workspace_id' = 'papercup';
  IF n_left > 0 THEN
    RAISE EXCEPTION '[704] % row(s) still carry a papercup identity after re-scope', n_left;
  END IF;

  RAISE NOTICE '[704] re-scoped papercup→papercusp: payload_user_id=%, payload_harness_slug=%, payload_workspace_id=%',
    n_payload, n_hslug, n_ws;
END $$;
