-- 366-coord-links-blocks-change-notify.sql
--
-- caching-layer-tag-eca-2026-06-22 — P-013 (+ the readiness slice of P-014 / D-008 / D-009).
--
-- WHY: feature->feature blocking moved off the dropped `blocked_by` column (mig 155) onto
-- the polymorphic edge table harness_shared.coord_links (rel='blocks'; src_ref=BLOCKER,
-- dst_ref=BLOCKED — see lib/dbos/feature-blockers-edges.ts). That table had NO change-notify
-- trigger, so adding/removing a blocker edge — the single most readiness-changing mutation —
-- emitted no `sync_invalidate`, leaving any readiness cache permanently stale. The adversarial
-- audit flagged this as a blocker.
--
-- This adds a SCOPED notify trigger that, unlike the generic emit_change_notify():
--   (1) fires ONLY for rel='blocks' edges — coord_links also backs tags/relates/duplicates/
--       fixes/... (high volume); we must NOT firehose `sync_invalidate` on every tag write;
--   (2) CARRIES the affected item refs (blocked_ref/blocker_ref) so a consumer can scope
--       invalidation to the blocked item + its dependents (the generic trigger carries no row
--       id — D-009 / P-014);
--   (3) reads the CORRECT workspace GUC `app.workspace_id` (the generic emit_change_notify
--       reads `papercusp.workspace_id`, which the runtime never sets -> always NULL — D-009).
--
-- Idempotent (CREATE OR REPLACE for both function and trigger). Adding a trigger takes a brief
-- lock only; no table rewrite.

CREATE OR REPLACE FUNCTION harness_shared.emit_blocks_edge_change_notify() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  rel_v   text;
  ws_id   text;
  payload jsonb;
BEGIN
  rel_v := COALESCE(NEW.rel, OLD.rel);

  -- Only blocking edges change readiness. Tagged/relates/duplicates/fixes/... are ignored
  -- (one cheap comparison on the hot tag-write path; no NOTIFY emitted).
  IF rel_v IS DISTINCT FROM 'blocks' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  ws_id := current_setting('app.workspace_id', true);

  payload := jsonb_build_object(
    'name', 'harness_shared.coord_links.blocks.changed',
    'args', jsonb_build_object(
      'workspace_id', ws_id,
      'op',           TG_OP,
      -- src=blocker, dst=BLOCKED (the item whose readiness flips when this edge is added/removed).
      'blocked_kind', COALESCE(NEW.dst_kind, OLD.dst_kind),
      'blocked_ref',  COALESCE(NEW.dst_ref,  OLD.dst_ref),
      'blocker_kind', COALESCE(NEW.src_kind, OLD.src_kind),
      'blocker_ref',  COALESCE(NEW.src_ref,  OLD.src_ref)
    )
  );

  PERFORM pg_notify('sync_invalidate', payload::text);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER emit_blocks_edge_change_notify_trg
    AFTER INSERT OR UPDATE OR DELETE ON harness_shared.coord_links
    FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_blocks_edge_change_notify();
