-- 1337-work-admissions.sql — enterprise-data-sources-2026-10-01 P-020 (WI-10005057), D-004, D-030
--
-- DATA becomes WORK only through an explicit admission (D-004): a per-data-source rule, or a person
-- calling work_items:admit. Two tables carry that:
--
--   admission_rules   per data source, a JSON match over the source's canonical payload, for
--                     example {"assignees":{"contains":"papercusp-agents"}} or
--                     {"container":{"eq":"acme/api"}} ("everything in project X"). A ticket that no
--                     enabled rule matches is never admitted automatically.
--   work_admissions   one row per admitted source: which work item it became, which rule or person
--                     admitted it, the source snapshot and its declared field authority.
--                     UNIQUE (workspace_id, source_kind, source_key) makes admission idempotent.
--
-- work_admissions deliberately has NO foreign key to the source rows (chat_messages, the record's
-- work_items row), to data_sources, or to admission_rules. It is attribution history: retention may
-- delete a chat message, a data source may be removed (cascading its rules), and the record of who
-- admitted what must outlive all of them. rule_id stays as a plain attribution uuid; a RESTRICT FK
-- there would make deleting any data source whose rule ever admitted something fail.
-- source_key is the provider identity (stable across re-ingest), never a row uuid.
--
-- FORWARD-COMPAT: additive only (two new tables, their indexes). The deployed release does not
-- read or write them.

CREATE TABLE IF NOT EXISTS harness_shared.admission_rules (
  workspace_id    text        NOT NULL,
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  data_source_id  uuid        NOT NULL,
  source_kind     text        NOT NULL DEFAULT 'record' CHECK (btrim(source_kind) <> ''),
  title           text        NOT NULL CHECK (btrim(title) <> ''),
  match           jsonb       NOT NULL CHECK (jsonb_typeof(match) = 'object' AND match <> '{}'::jsonb),
  harness_slug    text        NOT NULL CHECK (btrim(harness_slug) <> ''),
  work_kind       text        NOT NULL DEFAULT 'change' CHECK (btrim(work_kind) <> ''),
  enabled         boolean     NOT NULL DEFAULT true,
  created_by      text        NOT NULL CHECK (btrim(created_by) <> ''),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admission_rules_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT admission_rules_source_fk
    FOREIGN KEY (workspace_id, data_source_id)
    REFERENCES harness_shared.data_sources (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS admission_rules_source_idx
  ON harness_shared.admission_rules (workspace_id, data_source_id, source_kind)
  WHERE enabled;

COMMENT ON TABLE harness_shared.admission_rules IS
  'P-020 / D-004 / D-030: per-data-source rule admitting matching records into work. A source no enabled rule matches is never admitted automatically.';
COMMENT ON COLUMN harness_shared.admission_rules.match IS
  'Field -> condition over the canonical payload: {"eq": v} | {"in": [..]} | {"contains": v} (array field). All fields must match.';

CREATE TABLE IF NOT EXISTS harness_shared.work_admissions (
  workspace_id     text        NOT NULL,
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  work_item_id     text        NOT NULL CHECK (btrim(work_item_id) <> ''),
  harness_slug     text        NOT NULL CHECK (btrim(harness_slug) <> ''),
  data_source_id   uuid,
  source_kind      text        NOT NULL CHECK (btrim(source_kind) <> ''),
  source_key       text        NOT NULL CHECK (btrim(source_key) <> ''),
  source_ref       jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_ref) = 'object'),
  field_authority  jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(field_authority) = 'object'),
  admitted_via     text        NOT NULL CHECK (admitted_via IN ('person', 'rule')),
  admitted_by      text        NOT NULL CHECK (btrim(admitted_by) <> ''),
  rule_id          uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_admissions_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT work_admissions_source_key UNIQUE (workspace_id, source_kind, source_key),
  CONSTRAINT work_admissions_rule_chk CHECK ((admitted_via = 'rule') = (rule_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS work_admissions_work_item_idx
  ON harness_shared.work_admissions (workspace_id, work_item_id);

COMMENT ON TABLE harness_shared.work_admissions IS
  'P-020 / D-004 / D-030: one row per source admitted into work, attributable to a person or a rule. No FK to source rows: attribution outlives retention.';
