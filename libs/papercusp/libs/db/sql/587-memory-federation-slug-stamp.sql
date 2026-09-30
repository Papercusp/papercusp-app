-- 587-memory-federation-slug-stamp.sql — EI-10432. Give a shareable memory the
-- federation ROUTING KEY its outbox op needs, or it federates to nobody.
--
-- THE BUG ---------------------------------------------------------------------
-- memory_canonical.harness_slug (mig 564, "the Hive home slug — federation
-- identity carrier") was never written by ANY code path. The table's only local
-- writer is mem0's CanonicalVectorStore.insert (canonical-store.ts), which
-- inserts exactly (id, payload, created_at, updated_at) — the federation columns
-- are invisible to it. So on every locally-authored row the column is NULL, and:
--
--   1. mig 563's capture trigger fires WHEN (NEW.shareable = true) and enqueues
--      the op with harness_slug := canonical_harness_slug(row->>'harness_slug')
--      → NULL.
--   2. The drain selects `WHERE workspace_id = $ws AND harness_slug = $slug`
--      (outbox-drain.ts). `harness_slug = <anything>` is NEVER true for NULL,
--      so the op can never be picked up.
--   3. The backstop GC later reaps it as a row whose (workspace_id, harness_slug)
--      pair is absent from the registry → the op silently vanishes.
--
-- Net: `memory:remember { shareable: true }` federated NOTHING and errored
-- NOWHERE. agent_facts — the table this design explicitly mirrors (562/563/564
-- all cite mig 461) — refuses the identical hazard loudly in assertFact
-- ("captured then stranded … Refuse LOUDLY rather than silently strand") and
-- INSERTs the slug as a column. Memory copied the schema but not the writer.
--
-- WHY A TRIGGER, AND NOT A GENERATED COLUMN ------------------------------------
-- The tempting fix — make harness_slug GENERATED from payload, like
-- workspace_id/user_id/shareable already are — would BREAK the receive side. The
-- p2p-memories projection inserts harness_slug EXPLICITLY, and Postgres rejects
-- an explicit value for a generated column. That is not a hypothetical: the same
-- mistake on workspace_id threw on every federated write until P-007 caught it
-- (see the standing comment in projections/p2p-memories.ts).
--
-- The row itself must carry the key — the wire row IS to_jsonb(row), and the
-- receiving projection validates harness_slug is a non-empty string — so the
-- stamp has to be atomic with the INSERT. A BEFORE trigger is the only seam that
-- is both atomic and compatible with an explicit value:
--
--   * LOCAL write (mem0): harness_slug arrives NULL → stamped from the payload
--     key the operator resolved (remember.ts resolves the hive HOME slug via
--     resolveFactFederationSlug, and REFUSES a shareable write it cannot route).
--   * REMOTE write (projection): harness_slug arrives NON-NULL → left untouched.
--
-- Stamping on UPDATE too closes the flip path: a memory inserted private and
-- later flipped shareable would otherwise capture under a NULL slug and strand
-- exactly like an insert.
--
-- Idempotent. No BEGIN/COMMIT — the runner wraps each migration in its own
-- transaction (lint-migrations.test.ts fails the release gate on explicit
-- transaction control).

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION harness_shared.stamp_memory_federation_slug()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
    BEGIN
      -- Only ever FILL a missing key; never overwrite one the caller supplied.
      -- The receive-side projection supplies the authoritative slug for a remote
      -- row, and clobbering it would mis-route the peer's memory.
      IF NEW.harness_slug IS NULL THEN
        NEW.harness_slug := NULLIF(NEW.payload ->> 'fed_harness_slug', '');
      END IF;
      RETURN NEW;
    END;
    $function$;

COMMENT ON FUNCTION harness_shared.stamp_memory_federation_slug() IS
  'EI-10432: copies payload->>''fed_harness_slug'' onto memory_canonical.harness_slug when absent, so a shareable memory''s captured outbox op carries a drainable federation routing key. mem0''s insert writes only `payload`, so the payload is the only seam; an explicitly-supplied slug (the p2p projection''s remote applies) is never overwritten.';

CREATE OR REPLACE TRIGGER stamp_memory_federation_slug_ins_trg
  BEFORE INSERT ON harness_shared.memory_canonical
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.stamp_memory_federation_slug();

-- The flip path: a row stored private, later updated to shareable=true. Without
-- this it would capture under a NULL slug and strand exactly like an insert.
CREATE OR REPLACE TRIGGER stamp_memory_federation_slug_upd_trg
  BEFORE UPDATE ON harness_shared.memory_canonical
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.stamp_memory_federation_slug();
