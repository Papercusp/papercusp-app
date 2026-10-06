-- 1318-datatype-nature.sql — enterprise-data-sources-2026-10-01 P-008 (WI-10005044)
--
-- Every datatype and every built-in item kind declares exactly one NATURE
-- (D-001): work | record | document | event. Work also declares an AUDIENCE
-- (agent | human) so human-decision work such as email-draft-proposal is never
-- agent-claimable. datatype_registry is the source of truth for nature (D-008);
-- P-010 stamps it onto work_items rows at mint, and P-009's single work
-- predicate reads that stamped column.
--
-- Classification: D-007 (owner) for the seven generic-kind datatypes; D-013
-- (self-imposed, overturnable) for the first-class and projection rows, the
-- built-in item kinds, and the legacy backfill rule.
--
-- FORWARD-COMPAT: SET NOT NULL does not break the currently deployed release,
-- whose registry writers omit nature, because the BEFORE INSERT/UPDATE trigger
-- below fills nature (and audience) from tier for any writer that omits it.
-- A later contract migration drops the trigger once every writer passes nature.

ALTER TABLE harness_shared.datatype_registry
  ADD COLUMN IF NOT EXISTS nature   text,
  ADD COLUMN IF NOT EXISTS audience text;

COMMENT ON COLUMN harness_shared.datatype_registry.nature IS
  'D-001: work | record | document | event. Source of truth for work_items.nature (stamped at mint, D-008).';
COMMENT ON COLUMN harness_shared.datatype_registry.audience IS
  'agent | human; set exactly when nature = work. human = never agent-claimable.';

-- ── Built-in item kinds (D-013 §1): work for agents, registered as first-class
-- rows (the work_items table is their native SQL backing). Mirrors the code
-- constant BUILTIN_WORK_ITEM_KIND_NATURES; a test pins the two together.
INSERT INTO harness_shared.datatype_registry
  (id, workspace_id, pot_slug, title, description, tier, work_item_kind,
   payload_schema, authoritative_writer, self_improvement, status, published,
   review_status, tags, created_by, nature, audience, updated_at)
VALUES
  ('feature', 'papercusp-workspace', NULL, 'Feature',
   'Built-in work item kind: a feature-pipeline unit of work (F-NNN).',
   'first-class', 'feature', NULL, 'papercusp', NULL, 'active', FALSE, 'none',
   ARRAY['built-in','work-item-kind'], 'enterprise-data-sources-2026-10-01', 'work', 'agent', now()),
  ('chunk', 'papercusp-workspace', NULL, 'Chunk',
   'Built-in work item kind, retired for new writes; historical rows only.',
   'first-class', 'chunk', NULL, 'papercusp', NULL, 'active', FALSE, 'none',
   ARRAY['built-in','work-item-kind','deprecated'], 'enterprise-data-sources-2026-10-01', 'work', 'agent', now()),
  ('bug', 'papercusp-workspace', NULL, 'Bug',
   'Built-in work item kind: broken code to fix.',
   'first-class', 'bug', NULL, 'papercusp', NULL, 'active', FALSE, 'none',
   ARRAY['built-in','work-item-kind'], 'enterprise-data-sources-2026-10-01', 'work', 'agent', now()),
  ('change', 'papercusp-workspace', NULL, 'Change',
   'Built-in work item kind: a code change.',
   'first-class', 'change', NULL, 'papercusp', NULL, 'active', FALSE, 'none',
   ARRAY['built-in','work-item-kind'], 'enterprise-data-sources-2026-10-01', 'work', 'agent', now()),
  ('task', 'papercusp-workspace', NULL, 'Task',
   'Built-in work item kind: non-code work.',
   'first-class', 'task', NULL, 'papercusp', NULL, 'active', FALSE, 'none',
   ARRAY['built-in','work-item-kind'], 'enterprise-data-sources-2026-10-01', 'work', 'agent', now())
ON CONFLICT (workspace_id, id) DO UPDATE SET
  nature = EXCLUDED.nature,
  audience = EXCLUDED.audience,
  updated_at = now();

-- ── Named classification (D-007 owner rows + D-013 §3–4), every workspace.
UPDATE harness_shared.datatype_registry d
   SET nature = c.nature, audience = c.audience
  FROM (VALUES
    ('pipeline-deal',         'record',   NULL),
    ('bet',                   'record',   NULL),
    ('wager',                 'record',   NULL),
    ('forecast',              'record',   NULL),
    ('calibration-record',    'record',   NULL),
    ('email-draft-proposal',  'work',     'human'),
    ('calendar-meeting-prep', 'work',     'agent'),
    ('contact',               'record',   NULL),
    ('plan-ref-list',         'record',   NULL),
    ('email-message',         'document', NULL),
    ('chat-message',          'document', NULL),
    ('social-post',           'document', NULL),
    ('calendar-event',        'event',    NULL),
    ('webhook-payload',       'event',    NULL),
    ('cash-balance',          'record',   NULL),
    ('order',                 'record',   NULL),
    ('position',              'record',   NULL),
    ('fill',                  'event',    NULL)
  ) AS c(id, nature, audience)
 WHERE d.id = c.id;

-- ── Legacy backfill (D-013 §5) for rows this migration does not name, e.g.
-- user-declared datatypes on other installs. generic-kind keeps today's claim
-- behaviour (work/agent); first-class and projection become records.
UPDATE harness_shared.datatype_registry
   SET nature   = CASE WHEN tier = 'generic-kind' THEN 'work' ELSE 'record' END,
       audience = CASE WHEN tier = 'generic-kind' THEN 'agent' ELSE NULL END
 WHERE nature IS NULL;

-- ── Expand-phase fill for writers that do not yet pass nature (the deployed
-- release). Same rule as the legacy backfill. Dropped by the contract migration.
CREATE OR REPLACE FUNCTION harness_shared.datatype_registry_fill_legacy_nature()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.nature IS NULL THEN
    NEW.nature   := CASE WHEN NEW.tier = 'generic-kind' THEN 'work' ELSE 'record' END;
    NEW.audience := CASE WHEN NEW.tier = 'generic-kind' THEN COALESCE(NEW.audience, 'agent') ELSE NULL END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS datatype_registry_fill_legacy_nature ON harness_shared.datatype_registry;
CREATE TRIGGER datatype_registry_fill_legacy_nature
  BEFORE INSERT OR UPDATE ON harness_shared.datatype_registry
  FOR EACH ROW EXECUTE FUNCTION harness_shared.datatype_registry_fill_legacy_nature();

ALTER TABLE harness_shared.datatype_registry
  ALTER COLUMN nature SET NOT NULL;

ALTER TABLE harness_shared.datatype_registry
  DROP CONSTRAINT IF EXISTS datatype_registry_nature_check;
ALTER TABLE harness_shared.datatype_registry
  ADD CONSTRAINT datatype_registry_nature_check
  CHECK (nature IN ('work', 'record', 'document', 'event'));

ALTER TABLE harness_shared.datatype_registry
  DROP CONSTRAINT IF EXISTS datatype_registry_audience_check;
ALTER TABLE harness_shared.datatype_registry
  ADD CONSTRAINT datatype_registry_audience_check
  CHECK (
    (audience IS NULL OR audience IN ('agent', 'human'))
    AND ((nature = 'work') = (audience IS NOT NULL))
  );
