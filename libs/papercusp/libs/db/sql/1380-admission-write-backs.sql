-- 1380-admission-write-backs.sql — linear-asana-task-sync-2026-10-05 P-002 (WI-10006362), D-004
--
-- One row per write the host made BACK to the source of an admitted work item: a comment
-- (`<datatype>.comment`) or a workflow move (`<datatype>.transition`), dispatched by capability
-- through the record's own data source.
--
-- update_id is the id the PROVIDER returned for the change it made, spelled the way that
-- provider's own sync later reports the same change (GitHub: `comment:<id>`). When the next sync
-- ingests that object, the lifecycle rules look it up here and recognise their own write instead
-- of treating it as an outside close, cancel or comment (echo suppression).
--
-- Why a table and not a column on work_admissions: an admission writes many times over its life,
-- and the echo lookup is by (data source, provider update id) at ingest time, which needs its own
-- index. Like work_admissions this is attribution history, so it has NO foreign keys: a data
-- source or work item may be deleted and the record of what Papercusp wrote must survive.
--
-- FORWARD-COMPAT: additive only (one new table and its indexes). The deployed release does not
-- read or write it.

CREATE TABLE IF NOT EXISTS harness_shared.admission_write_backs (
  workspace_id    text        NOT NULL,
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  admission_id    uuid        NOT NULL,
  work_item_id    text        NOT NULL CHECK (btrim(work_item_id) <> ''),
  data_source_id  uuid,
  action          text        NOT NULL CHECK (action IN ('comment', 'transition')),
  update_id       text        CHECK (update_id IS NULL OR btrim(update_id) <> ''),
  external_ref    text,
  detail          jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admission_write_backs_pkey PRIMARY KEY (workspace_id, id)
);

-- The echo lookup. A provider update id names one change on one source, so a second write
-- reporting the same id is the same change (a retried call), not a new one.
CREATE UNIQUE INDEX IF NOT EXISTS admission_write_backs_update_idx
  ON harness_shared.admission_write_backs (workspace_id, data_source_id, update_id)
  WHERE update_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS admission_write_backs_work_item_idx
  ON harness_shared.admission_write_backs (workspace_id, work_item_id, created_at DESC);

COMMENT ON TABLE harness_shared.admission_write_backs IS
  'linear-asana-task-sync P-002: writes the host made back to an admitted source (comment, transition). update_id is the provider''s own id for the change, used to recognise the change when sync ingests it again (echo suppression).';
COMMENT ON COLUMN harness_shared.admission_write_backs.action IS
  'Which write: comment (the source''s <datatype>.comment capability) or transition (<datatype>.transition).';
COMMENT ON COLUMN harness_shared.admission_write_backs.update_id IS
  'Provider-returned id of the change, in the form the provider''s sync reports it (nativeId). NULL when the provider returned none.';
COMMENT ON COLUMN harness_shared.admission_write_backs.detail IS
  'Capability-specific facts about the write, for example {"toCategory":"in-progress"} for a transition. Never the comment text.';
