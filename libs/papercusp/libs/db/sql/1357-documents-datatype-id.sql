-- 1357: documents.datatype_id + source-scoped Vault dedupe keys
-- (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
--  P-005 / WI-10006069, Decision D-010).
--
-- Vault ingestion and the app-row producer now route a document by its
-- canonical datatype instead of by an `ext:gmail:` / `ext:gcal:` key prefix or
-- a provider-named category map. The datatype is stamped at ingestion from the
-- canonical event's `datatypeId`; this migration adds the column and backfills
-- the rows written before that stamp existed.
--
-- It also re-keys source-bound rows so the stable key carries the source id.
-- Two providers (or two sources of one provider) that reuse the same native id
-- under the same account address previously collapsed onto one row; the new
-- key keeps them apart. Keys keep their optional `account:<sha256>:` prefix
-- (personal-vault/store.ts dedupeKeyFor), so the uniqueness domain
-- (workspace_id, user_id, source, dedupe_key) is unchanged.
--
-- Additive + data rewrite only: no DROP, RENAME or SET NOT NULL.
--
-- EXPAND WINDOW. This applies to the shared database as soon as any operator
-- built from staging boots, while the release on :3070 still runs the previous
-- code for as long as the green gate holds main. That release writes rows with
-- no datatype_id and with the legacy key shape. Left alone, every such write
-- would (a) be invisible to the datatype-keyed reconcile/status reads and
-- (b) insert a duplicate beside its re-keyed twin. A BEFORE INSERT trigger
-- (below) normalizes both on the way in. PostgreSQL fires BEFORE ROW INSERT
-- triggers before ON CONFLICT arbitration, so a legacy-shaped upsert conflicts
-- with the re-keyed row instead of minting a twin. The trigger is a no-op for
-- the new code, which always stamps datatype_id and the source-scoped key. It
-- is transitional and is dropped once no release writes the legacy shape
-- (tracked on the P-005 work-item's follow-up).

ALTER TABLE harness_shared.documents
  ADD COLUMN IF NOT EXISTS datatype_id text;

COMMENT ON COLUMN harness_shared.documents.datatype_id IS
  'Canonical datatype registry id (e.g. email-message, calendar-event) stamped at ingestion; routing key for Vault and app-row production (D-010).';

-- Backfill from (source, kind) for rows written before ingestion stamped it.
UPDATE harness_shared.documents
   SET datatype_id = CASE
         WHEN source = 'gmail'    AND kind = 'message' THEN 'email-message'
         WHEN source = 'calendar' AND kind = 'event'   THEN 'calendar-event'
         WHEN source = 'facebook'                      THEN 'social-post'
         WHEN source = 'contacts' AND kind = 'contact' THEN 'contact'
       END
 WHERE datatype_id IS NULL
   AND (   (source = 'gmail'    AND kind = 'message')
        OR (source = 'calendar' AND kind = 'event')
        OR  source = 'facebook'
        OR (source = 'contacts' AND kind = 'contact'));

CREATE INDEX IF NOT EXISTS documents_user_datatype_cursor_idx
  ON harness_shared.documents (workspace_id, user_id, datatype_id, (COALESCE(occurred_at, imported_at)), id);

-- Re-key source-bound mail and calendar rows:
--   [account:<hash>:]gmail:<native>          -> [account:<hash>:]gmail:<source_id>:<native>
--   [account:<hash>:]calendar:<native>       -> [account:<hash>:]calendar:<source_id>:<native>
--   [account:<hash>:]facebook:<type>:<native> -> [account:<hash>:]facebook:<source_id>:<type>:<native>
-- Only rows whose key is EXACTLY the legacy shape are touched, and a row is
-- skipped when its new key already exists in the same uniqueness domain (the
-- newer write wins; the stale twin is left for the next sync to supersede).
WITH legacy AS (
  SELECT d.id,
         d.workspace_id,
         d.user_id,
         d.source,
         COALESCE(substring(d.dedupe_key FROM '^(account:[0-9a-f]{64}:)'), '') AS prefix,
         d.source_id::text AS sid,
         d.external_id,
         d.kind,
         d.dedupe_key
    FROM harness_shared.documents d
   WHERE d.source_id IS NOT NULL
     AND d.external_id IS NOT NULL
     AND d.source IN ('gmail', 'calendar', 'facebook')
), candidates AS (
  SELECT id, workspace_id, user_id, source,
         CASE
           WHEN source = 'facebook' THEN prefix || 'facebook:' || sid || ':' || kind || ':' || external_id
           ELSE prefix || source || ':' || sid || ':' || external_id
         END AS new_key
    FROM legacy
   WHERE dedupe_key = CASE
           WHEN source = 'facebook' THEN prefix || 'facebook:' || kind || ':' || external_id
           ELSE prefix || source || ':' || external_id
         END
)
UPDATE harness_shared.documents d
   SET dedupe_key = c.new_key
  FROM candidates c
 WHERE d.id = c.id
   AND NOT EXISTS (
     SELECT 1 FROM harness_shared.documents x
      WHERE x.workspace_id = c.workspace_id
        AND x.user_id = c.user_id
        AND x.source = c.source
        AND x.dedupe_key = c.new_key
   );

-- Transitional expand-window normalizer (see header). Mirrors the backfill and
-- the re-key above for rows written by a release that predates D-010. Pure
-- function of the incoming row; touches nothing else.
CREATE OR REPLACE FUNCTION harness_shared.documents_normalize_legacy_routing()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  prefix text;
  legacy_key text;
BEGIN
  IF NEW.datatype_id IS NULL THEN
    NEW.datatype_id := CASE
      WHEN NEW.source = 'gmail'    AND NEW.kind = 'message' THEN 'email-message'
      WHEN NEW.source = 'calendar' AND NEW.kind = 'event'   THEN 'calendar-event'
      WHEN NEW.source = 'facebook'                          THEN 'social-post'
      WHEN NEW.source = 'contacts' AND NEW.kind = 'contact' THEN 'contact'
    END;
  END IF;

  IF NEW.source_id IS NOT NULL
     AND NEW.external_id IS NOT NULL
     AND NEW.source IN ('gmail', 'calendar', 'facebook') THEN
    prefix := COALESCE(substring(NEW.dedupe_key FROM '^(account:[0-9a-f]{64}:)'), '');
    legacy_key := CASE
      WHEN NEW.source = 'facebook' THEN prefix || 'facebook:' || NEW.kind || ':' || NEW.external_id
      ELSE prefix || NEW.source || ':' || NEW.external_id
    END;
    IF NEW.dedupe_key = legacy_key THEN
      NEW.dedupe_key := CASE
        WHEN NEW.source = 'facebook'
          THEN prefix || 'facebook:' || NEW.source_id::text || ':' || NEW.kind || ':' || NEW.external_id
        ELSE prefix || NEW.source || ':' || NEW.source_id::text || ':' || NEW.external_id
      END;
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION harness_shared.documents_normalize_legacy_routing() IS
  'TRANSITIONAL (1357, D-010): stamps datatype_id and source-scopes legacy Vault keys for rows written by a pre-D-010 release. Drop once no deployed release writes the legacy shape.';

DROP TRIGGER IF EXISTS documents_normalize_legacy_routing ON harness_shared.documents;
CREATE TRIGGER documents_normalize_legacy_routing
  BEFORE INSERT ON harness_shared.documents
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.documents_normalize_legacy_routing();
