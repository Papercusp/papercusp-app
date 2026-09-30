-- 1157-work-items-keyless-title-identity-guard.sql
--
-- EI-22775699419447395 — improvements:capture can be retried after an admission
-- shed. Its exact normalized-title SELECT is advisory, so concurrent keyless
-- non-observation filings with the same title can both miss the first row and
-- mint duplicate open bugs.
--
-- The durable identity for this class is the server-authored
-- payload.admissionIdentity.titleKey already written by capture-core. A
-- watchdogKey is a stronger, separate identity and observations have their own
-- recurrence lane, so neither participates in this arbiter. The migration repairs
-- historical active rows before creating the partial unique index; terminal rows
-- remain historical and forced keyless filings intentionally omit admissionIdentity
-- so they can remain distinct.
--
-- Keep the base table quiescent while the census, backfill, repair, and index build
-- share one transaction. Without the lock, a concurrent insert could escape the
-- census and make the index build fail nondeterministically.
--
-- FORWARD-COMPAT: the deployed capture writer already persists the nullable
-- admissionIdentity payload and does not name this new index as an ON CONFLICT
-- arbiter. Rows written by the older writer remain valid because the partial
-- predicate excludes rows without this marker; adding the guard does not narrow an
-- existing arbiter or invalidate an older write shape.

LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260914_work_items_keyless_title_identity
  (LIKE harness_shared.work_items INCLUDING DEFAULTS);

CREATE UNIQUE INDEX IF NOT EXISTS bak_20260914_work_items_keyless_title_identity_uq
  ON harness_shared.bak_20260914_work_items_keyless_title_identity
    (workspace_id, harness_slug, feature_id);

CREATE TABLE IF NOT EXISTS harness_shared.bak_20260914_keyless_title_identity_repairs (
  workspace_id       text        NOT NULL,
  harness_slug       text        NOT NULL,
  title_key          text        NOT NULL,
  winner_id          text        NOT NULL,
  loser_id           text        NOT NULL,
  loser_status       text,
  loser_taken_by     text,
  repaired_at        timestamptz NOT NULL DEFAULT now(),
  repair_reason      text        NOT NULL,
  PRIMARY KEY (workspace_id, harness_slug, title_key, loser_id)
);

-- Mirror digest.ts: dedupSignature strips a leading kind marker, lowercases,
-- replaces punctuation with spaces, drops tokens of length <=2, de-duplicates,
-- sorts, and joins with spaces. The fallback is the normalized raw title used
-- when every token is short. Existing valid v1 identities remain authoritative,
-- because a title may have been edited since its identity was first persisted.
CREATE TEMP TABLE repair_1157_keyless_title_population ON COMMIT DROP AS
WITH candidate AS (
  SELECT
    wi.workspace_id,
    wi.harness_slug,
    wi.feature_id,
    wi.status,
    wi.taken_by,
    wi.payload,
    wi.created_ts,
    wi.updated_ts,
    CASE
      WHEN wi.payload #>> '{admissionIdentity,schemaVersion}' = 'admission-identity-v1'
       AND NULLIF(btrim(wi.payload #>> '{admissionIdentity,titleKey}'), '') IS NOT NULL
        THEN btrim(wi.payload #>> '{admissionIdentity,titleKey}')
      ELSE
        'title:' || COALESCE(
          NULLIF((
            SELECT string_agg(DISTINCT split.token, ' ' ORDER BY split.token)
              FROM regexp_split_to_table(
                lower(regexp_replace(
                  regexp_replace(
                    COALESCE(wi.title, ''),
                    E'^\\s*\\[(bug|change|feature|research-task|chunk)\\]\\s*',
                    '',
                    'i'
                  ),
                  E'[^a-z0-9\\s]',
                  ' ',
                  'g'
                )),
                E'\\s+'
              ) AS split(token)
             WHERE length(split.token) > 2
          ), ''),
          NULLIF(
            btrim(regexp_replace(
              lower(regexp_replace(COALESCE(wi.title, ''), E'[^a-z0-9\\s]', ' ', 'g')),
              E'\\s+',
              ' ',
              'g'
            )),
            ''
          )
        )
    END AS title_key
  FROM harness_shared.work_items wi
  WHERE wi.item_kind IN ('bug', 'change', 'task')
    AND (wi.status IS NULL OR wi.status <> ALL (
      ARRAY['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']::text[]
    ))
    AND NULLIF(btrim(wi.payload ->> 'watchdogKey'), '') IS NULL
    AND COALESCE(wi.payload ->> 'lane', 'improvement') <> 'observation'
    AND btrim(COALESCE(wi.title, '')) <> ''
)
SELECT *
  FROM candidate
 WHERE title_key IS NOT NULL
   AND title_key <> 'title:';

CREATE TEMP TABLE repair_1157_keyless_title_identity ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    population.*,
    row_number() OVER (
      PARTITION BY workspace_id, harness_slug, title_key
      ORDER BY
        (taken_by IS NOT NULL) DESC,
        COALESCE(updated_ts, 0) DESC,
        COALESCE(created_ts, 0) ASC,
        feature_id ASC
    ) AS identity_rank,
    first_value(feature_id) OVER (
      PARTITION BY workspace_id, harness_slug, title_key
      ORDER BY
        (taken_by IS NOT NULL) DESC,
        COALESCE(updated_ts, 0) DESC,
        COALESCE(created_ts, 0) ASC,
        feature_id ASC
    ) AS winner_id
  FROM repair_1157_keyless_title_population population
)
SELECT
  workspace_id,
  harness_slug,
  title_key,
  winner_id,
  feature_id AS loser_id,
  status AS loser_status,
  taken_by AS loser_taken_by
FROM ranked
WHERE identity_rank > 1;

-- Snapshot every row that will be terminalized. The full row preserves claims,
-- payload, completion data, federation clocks, and provenance for recovery.
INSERT INTO harness_shared.bak_20260914_work_items_keyless_title_identity
SELECT wi.*
  FROM harness_shared.work_items wi
  JOIN repair_1157_keyless_title_identity repair
    ON repair.workspace_id = wi.workspace_id
   AND repair.harness_slug = wi.harness_slug
   AND repair.loser_id = wi.feature_id
ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;

INSERT INTO harness_shared.bak_20260914_keyless_title_identity_repairs
  (workspace_id, harness_slug, title_key, winner_id, loser_id,
   loser_status, loser_taken_by, repair_reason)
SELECT workspace_id, harness_slug, title_key, winner_id, loser_id,
       loser_status, loser_taken_by,
       '1157: duplicate active keyless title identity; winner retained, loser terminalized'
  FROM repair_1157_keyless_title_identity
ON CONFLICT (workspace_id, harness_slug, title_key, loser_id) DO NOTHING;

-- Payload backfill is additive and runs before terminalization so historical
-- losers retain the same machine-readable title identity as their winner. Keep
-- the normal trigger path live: this hot table's sync invalidation and CDC
-- projections must observe the repair, and payload-only writes do not justify
-- suppressing those readers.

UPDATE harness_shared.work_items wi
   SET payload = COALESCE(wi.payload, '{}'::jsonb) || jsonb_build_object(
     'admissionIdentity', jsonb_build_object(
       'schemaVersion', 'admission-identity-v1',
       'titleKey', population.title_key
     )
   )
  FROM repair_1157_keyless_title_population population
 WHERE wi.workspace_id = population.workspace_id
   AND wi.harness_slug = population.harness_slug
   AND wi.feature_id = population.feature_id
   AND NOT (
     wi.payload #>> '{admissionIdentity,schemaVersion}' = 'admission-identity-v1'
     AND NULLIF(btrim(wi.payload #>> '{admissionIdentity,titleKey}'), '') IS NOT NULL
   );

UPDATE harness_shared.work_items loser
   SET status = 'dropped',
       terminal_owner = COALESCE(loser.terminal_owner, 'system:migration-1157'),
       terminal_reason = COALESCE(loser.terminal_reason, 'duplicate-keyless-title-identity-1157'),
       terminal_completion_ref = COALESCE(
         loser.terminal_completion_ref,
         'migration-1157:duplicate-of:' || repair.winner_id
       ),
       closed_ts = COALESCE(
         loser.closed_ts,
         floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       ),
       payload = COALESCE(loser.payload, '{}'::jsonb) || jsonb_build_object(
         '_keylessTitleIdentityRepair', jsonb_build_object(
           'migration', 1157,
           'winnerId', repair.winner_id,
           'titleKey', repair.title_key,
           'priorStatus', repair.loser_status,
           'repairedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         )
       ),
       updated_ts = greatest(
         COALESCE(loser.updated_ts, 0),
         floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       )
  FROM repair_1157_keyless_title_identity repair
 WHERE loser.workspace_id = repair.workspace_id
   AND loser.harness_slug = repair.harness_slug
   AND loser.feature_id = repair.loser_id;

DO $verify_repair1157$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(loser_id, ', ' ORDER BY loser_id)
    INTO bad
    FROM repair_1157_keyless_title_identity repair
    JOIN harness_shared.work_items wi
      ON wi.workspace_id = repair.workspace_id
     AND wi.harness_slug = repair.harness_slug
     AND wi.feature_id = repair.loser_id
   WHERE wi.status IS DISTINCT FROM 'dropped'
      OR wi.payload #>> '{_keylessTitleIdentityRepair,migration}' IS DISTINCT FROM '1157'
      OR wi.payload #>> '{_keylessTitleIdentityRepair,winnerId}' IS DISTINCT FROM repair.winner_id;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '1157: duplicate keyless title repair post-condition failed for %', bad;
  END IF;

  SELECT string_agg(workspace_id || '/' || harness_slug || '/' || title_key,
                    ', ' ORDER BY workspace_id, harness_slug, title_key)
    INTO bad
    FROM (
      SELECT workspace_id,
             harness_slug,
             payload #>> '{admissionIdentity,titleKey}' AS title_key
        FROM harness_shared.work_items
       WHERE item_kind IN ('bug', 'change', 'task')
         AND (status IS NULL OR status <> ALL (
           ARRAY['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']::text[]
         ))
         AND NULLIF(btrim(payload ->> 'watchdogKey'), '') IS NULL
         AND COALESCE(payload ->> 'lane', 'improvement') <> 'observation'
         AND payload #>> '{admissionIdentity,schemaVersion}' = 'admission-identity-v1'
         AND NULLIF(btrim(payload #>> '{admissionIdentity,titleKey}'), '') IS NOT NULL
       GROUP BY workspace_id, harness_slug, payload #>> '{admissionIdentity,titleKey}'
      HAVING count(*) > 1
    ) duplicates;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '1157: active keyless title identities remain duplicated: %', bad;
  END IF;
END
$verify_repair1157$;

CREATE UNIQUE INDEX IF NOT EXISTS work_items_keyless_title_identity_uq
  ON harness_shared.work_items (
    workspace_id,
    harness_slug,
    (payload #>> '{admissionIdentity,titleKey}')
  )
  WHERE item_kind IN ('bug', 'change', 'task')
    AND (status IS NULL OR status <> ALL (
      ARRAY['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']::text[]
    ))
    AND NULLIF(btrim(payload ->> 'watchdogKey'), '') IS NULL
    AND COALESCE(payload ->> 'lane', 'improvement') <> 'observation'
    AND payload #>> '{admissionIdentity,schemaVersion}' = 'admission-identity-v1'
    AND NULLIF(btrim(payload #>> '{admissionIdentity,titleKey}'), '') IS NOT NULL;

COMMENT ON INDEX harness_shared.work_items_keyless_title_identity_uq IS
  'EI-22775699419447395 / migration 1157: one non-terminal, non-observation keyless issue-family title identity per workspace and Pot. Forced keyless captures omit admissionIdentity; capture-core coalesces the winner after a named 23505 race.';
