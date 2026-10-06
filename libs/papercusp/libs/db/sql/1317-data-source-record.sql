-- 1317-data-source-record.sql
--
-- P-013 of enterprise-data-sources-2026-10-01, schema per that plan's D-010:
-- promote harness_shared.trigger_sources into the DATA-SOURCE record. The table is
-- extended in place (a rename to data_sources is a separate mechanical follow-up),
-- so every existing reader and writer keeps working unchanged. Triggers become one
-- consumer of a data source rather than its identity.
--
-- Existing columns keep their meaning: kind = connector type, credential_ref,
-- cursor = sync position, owner_user_id + provider_account_id = personal ownership.
-- New: sync_mode, backfill_status, scope, scope_ref, scope_mapping,
-- datatype_mappings, destination_policy, retention_policy, permission_mapping.
--
-- destination_policy can only name the natures record | document | event. WORK is
-- structurally unrepresentable here: nothing external becomes work implicitly
-- (D-001, D-004); work is admitted only by Phase 3's explicit admission rule.
--
-- FORWARD-COMPAT: the deployed release never reads the new columns, and its inserts omit sync_mode, which the BEFORE INSERT trigger below derives from kind before the NOT NULL check runs; the dropped constraints are only this migration's own, dropped so a re-run is idempotent.

-- ---------------------------------------------------------------------------
-- Validators (IMMUTABLE, used by CHECK constraints). CASE guards evaluation order
-- so a wrong-typed value returns false instead of raising inside jsonb_each.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION harness_shared.data_source_destination_policy_valid(policy jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN policy IS NULL OR jsonb_typeof(policy) <> 'object' THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_each(policy) e
       WHERE CASE
               WHEN btrim(e.key) = '' THEN true
               WHEN jsonb_typeof(e.value) <> 'array' THEN true
               WHEN jsonb_array_length(e.value) = 0 THEN true
               ELSE EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(e.value) n
                  WHERE jsonb_typeof(n) <> 'string'
                     OR (n #>> '{}') NOT IN ('record', 'document', 'event'))
             END)
  END
$$;

COMMENT ON FUNCTION harness_shared.data_source_destination_policy_valid(jsonb) IS
  'enterprise-data-sources D-010: a destination policy maps datatype -> non-empty array of natures drawn from record|document|event. work is deliberately not accepted (D-001/D-004).';

CREATE OR REPLACE FUNCTION harness_shared.data_source_datatype_mappings_valid(mappings jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN mappings IS NULL OR jsonb_typeof(mappings) <> 'object' THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_each(mappings) e
       WHERE btrim(e.key) = ''
          OR jsonb_typeof(e.value) <> 'string'
          OR btrim(e.value #>> '{}') = '')
  END
$$;

CREATE OR REPLACE FUNCTION harness_shared.data_source_retention_policy_valid(policy jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN policy IS NULL OR jsonb_typeof(policy) <> 'object' THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_each(policy) e
       WHERE CASE
               WHEN e.key NOT IN ('maxAgeDays', 'deliveryDedupeHorizonDays') THEN true
               WHEN jsonb_typeof(e.value) <> 'number' THEN true
               ELSE (e.value #>> '{}')::numeric <= 0
                 OR (e.value #>> '{}')::numeric <> trunc((e.value #>> '{}')::numeric)
             END)
  END
$$;

CREATE OR REPLACE FUNCTION harness_shared.data_source_permission_mapping_valid(mapping jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN mapping IS NULL OR jsonb_typeof(mapping) <> 'object' THEN false
    ELSE coalesce(mapping ->> 'mode', '') IN ('owner', 'source-acl', 'organization')
  END
$$;

-- Per-connector defaults, mirroring what each connector does today: the polled
-- Google connectors and socket-mode Slack deliver to the event bus (event) and the
-- personal vault (document). An unknown kind gets no implicit mapping.
CREATE OR REPLACE FUNCTION harness_shared.data_source_kind_defaults(
  p_kind text,
  OUT sync_mode text,
  OUT datatype_mappings jsonb,
  OUT destination_policy jsonb)
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    CASE p_kind
      WHEN 'gmail' THEN 'poll'
      WHEN 'gcal' THEN 'poll'
      WHEN 'contacts' THEN 'poll'
      WHEN 'slack' THEN 'socket'
      WHEN 'webhook' THEN 'webhook'
      ELSE 'manual'
    END,
    (CASE p_kind
      WHEN 'gmail' THEN '{"message":"email-message"}'
      WHEN 'gcal' THEN '{"event":"calendar-event"}'
      WHEN 'contacts' THEN '{"person":"contact"}'
      WHEN 'slack' THEN '{"message":"chat-message"}'
      WHEN 'webhook' THEN '{"payload":"webhook-payload"}'
      ELSE '{}'
    END)::jsonb,
    (CASE p_kind
      WHEN 'gmail' THEN '{"email-message":["document","event"]}'
      WHEN 'gcal' THEN '{"calendar-event":["document","event"]}'
      WHEN 'contacts' THEN '{"contact":["document","event"]}'
      WHEN 'slack' THEN '{"chat-message":["document","event"]}'
      WHEN 'webhook' THEN '{"webhook-payload":["event"]}'
      ELSE '{}'
    END)::jsonb
$$;

-- ---------------------------------------------------------------------------
-- Columns (expand)
-- ---------------------------------------------------------------------------

ALTER TABLE harness_shared.trigger_sources
  ADD COLUMN IF NOT EXISTS sync_mode text,
  ADD COLUMN IF NOT EXISTS backfill_status text NOT NULL DEFAULT 'not-requested',
  ADD COLUMN IF NOT EXISTS scope text,
  ADD COLUMN IF NOT EXISTS scope_ref text,
  ADD COLUMN IF NOT EXISTS scope_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS datatype_mappings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS destination_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS retention_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS permission_mapping jsonb NOT NULL DEFAULT '{"mode":"owner"}'::jsonb;

-- An insert that omits sync_mode / mappings / scope (every writer in the deployed
-- release) gets the connector's defaults; an omitted scope derives from ownership
-- exactly as the backfill below does (owned -> personal, unowned -> organization). Runs before the NOT NULL check on sync_mode.
CREATE OR REPLACE FUNCTION harness_shared.trigger_sources_apply_kind_defaults()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d record;
BEGIN
  SELECT * INTO d FROM harness_shared.data_source_kind_defaults(NEW.kind);
  IF NEW.sync_mode IS NULL THEN
    NEW.sync_mode := d.sync_mode;
  END IF;
  IF NEW.datatype_mappings IS NULL OR NEW.datatype_mappings = '{}'::jsonb THEN
    NEW.datatype_mappings := d.datatype_mappings;
  END IF;
  IF NEW.destination_policy IS NULL OR NEW.destination_policy = '{}'::jsonb THEN
    NEW.destination_policy := d.destination_policy;
  END IF;
  IF NEW.scope IS NULL THEN
    NEW.scope := CASE WHEN NEW.owner_user_id IS NULL THEN 'organization' ELSE 'personal' END;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trigger_sources_apply_kind_defaults ON harness_shared.trigger_sources;
CREATE TRIGGER trigger_sources_apply_kind_defaults
  BEFORE INSERT ON harness_shared.trigger_sources
  FOR EACH ROW EXECUTE FUNCTION harness_shared.trigger_sources_apply_kind_defaults();

-- Backfill existing rows. Unowned (workspace-level) sources are organization
-- scoped; permission_mapping stays at the most restrictive default (owner) until
-- P-014's organization corpus sets a source-acl mapping explicitly.
UPDATE harness_shared.trigger_sources
   SET sync_mode = coalesce(sync_mode, (harness_shared.data_source_kind_defaults(kind)).sync_mode),
       datatype_mappings = CASE WHEN datatype_mappings = '{}'::jsonb
                                THEN (harness_shared.data_source_kind_defaults(kind)).datatype_mappings
                                ELSE datatype_mappings END,
       destination_policy = CASE WHEN destination_policy = '{}'::jsonb
                                 THEN (harness_shared.data_source_kind_defaults(kind)).destination_policy
                                 ELSE destination_policy END,
       scope = coalesce(scope, CASE WHEN owner_user_id IS NULL THEN 'organization' ELSE 'personal' END)
 WHERE sync_mode IS NULL OR scope IS NULL;

ALTER TABLE harness_shared.trigger_sources ALTER COLUMN sync_mode SET NOT NULL;
ALTER TABLE harness_shared.trigger_sources ALTER COLUMN scope SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Constraints (idempotent: drop this migration's own names first)
-- ---------------------------------------------------------------------------

ALTER TABLE harness_shared.trigger_sources
  DROP CONSTRAINT IF EXISTS trigger_sources_sync_mode_chk,
  DROP CONSTRAINT IF EXISTS trigger_sources_backfill_status_chk,
  DROP CONSTRAINT IF EXISTS trigger_sources_scope_chk,
  DROP CONSTRAINT IF EXISTS trigger_sources_scope_ref_chk,
  DROP CONSTRAINT IF EXISTS trigger_sources_scope_mapping_chk,
  DROP CONSTRAINT IF EXISTS trigger_sources_datatype_mappings_chk,
  DROP CONSTRAINT IF EXISTS trigger_sources_destination_policy_chk,
  DROP CONSTRAINT IF EXISTS trigger_sources_retention_policy_chk,
  DROP CONSTRAINT IF EXISTS trigger_sources_permission_mapping_chk,
  DROP CONSTRAINT IF EXISTS trigger_sources_personal_owner_chk;

ALTER TABLE harness_shared.trigger_sources
  ADD CONSTRAINT trigger_sources_sync_mode_chk
    CHECK (sync_mode IN ('poll', 'webhook', 'socket', 'federated', 'manual')),
  ADD CONSTRAINT trigger_sources_backfill_status_chk
    CHECK (backfill_status IN ('not-requested', 'pending', 'running', 'complete', 'failed')),
  ADD CONSTRAINT trigger_sources_scope_chk
    CHECK (scope IN ('personal', 'organization', 'pot')),
  ADD CONSTRAINT trigger_sources_scope_ref_chk
    CHECK ((scope = 'pot') = (scope_ref IS NOT NULL AND btrim(scope_ref) <> '')),
  ADD CONSTRAINT trigger_sources_scope_mapping_chk
    CHECK (jsonb_typeof(scope_mapping) = 'object'),
  ADD CONSTRAINT trigger_sources_datatype_mappings_chk
    CHECK (harness_shared.data_source_datatype_mappings_valid(datatype_mappings)),
  ADD CONSTRAINT trigger_sources_destination_policy_chk
    CHECK (harness_shared.data_source_destination_policy_valid(destination_policy)),
  ADD CONSTRAINT trigger_sources_retention_policy_chk
    CHECK (harness_shared.data_source_retention_policy_valid(retention_policy)),
  ADD CONSTRAINT trigger_sources_permission_mapping_chk
    CHECK (harness_shared.data_source_permission_mapping_valid(permission_mapping)),
  -- A personal source belongs to someone (D-005: Personal Vault semantics carry over).
  ADD CONSTRAINT trigger_sources_personal_owner_chk
    CHECK (scope <> 'personal' OR owner_user_id IS NOT NULL);

COMMENT ON COLUMN harness_shared.trigger_sources.sync_mode IS
  'Data-source sync mode (D-010): poll | webhook | socket | federated (live search only, D-006) | manual. Derived from kind on insert when omitted.';
COMMENT ON COLUMN harness_shared.trigger_sources.backfill_status IS
  'Data-source historical backfill state (D-010): not-requested | pending | running | complete | failed.';
COMMENT ON COLUMN harness_shared.trigger_sources.scope IS
  'Corpus scope of what this source ingests (D-005/D-010): personal | organization | pot. scope_ref names the pot iff scope = pot; personal requires owner_user_id. Omitted on insert: derived from owner_user_id.';
COMMENT ON COLUMN harness_shared.trigger_sources.scope_mapping IS
  'Provider container (Slack channel, Asana project, ...) -> local scope (D-010).';
COMMENT ON COLUMN harness_shared.trigger_sources.datatype_mappings IS
  'Provider object type -> canonical datatype_registry name (D-002/D-010).';
COMMENT ON COLUMN harness_shared.trigger_sources.destination_policy IS
  'Canonical datatype -> natures it becomes, drawn from record | document | event. Never work (D-001/D-004/D-010).';
COMMENT ON COLUMN harness_shared.trigger_sources.retention_policy IS
  '{ maxAgeDays?, deliveryDedupeHorizonDays? } (D-010). deliveryDedupeHorizonDays is the trigger_deliveries dedupe horizon read by delivery GC; absent = keep.';
COMMENT ON COLUMN harness_shared.trigger_sources.permission_mapping IS
  '{ mode: owner | source-acl | organization, ... } (D-010). Provider identity never selects a principal (D-002).';
