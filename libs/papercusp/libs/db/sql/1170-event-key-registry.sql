-- 1170-event-key-registry.sql — identities-v1 P-029 half (a) / D-010, D-011, D-058
--
-- Events are independently useful with no rule anywhere: `events:await` is a
-- first-class agent primitive and gate declarations work on their own. So event
-- KEYS need a registry of their own, not a field hanging off a reaction rule.
--
-- The shape deliberately mirrors capability_class_registry (D-004, migration 1140)
-- rather than inventing a parallel discovery surface: curated identity + review
-- gating + tsv/embedding discovery, same workspace isolation, same grants.
--
-- WHAT THIS REPLACES: EVENT_CATALOG in
-- packages/operator-core/lib/events/await/catalog.ts is a HAND-AUTHORED code
-- constant (one declaration site, ~1795 lines, zero DB access). Its hand-maintained
-- `emitter`/`exists` fields are the derived-truth ladder's own cautionary example:
-- the system's most-fired key sat recorded as unregistered, and 14 awaits parked on
-- a key with no emitter anywhere.
--
-- THE LOAD-BEARING SPLIT (D-058 route (a)) — this table holds TWO populations and
-- they are governed differently:
--
--   CURATED (rung 4)  — genuine judgment a scan cannot produce: title, description,
--                       contributor, review status, and `status` (do we still INTEND
--                       this key). Written by hand, NOT NULL, defaults allowed.
--
--   DERIVED (rungs 1-3) — facts the code already owns: which site emits the key, and
--                       whether such a site exists at all. Every one is NULLABLE with
--                       NO DEFAULT, and NULL means NOT-YET-DERIVED. A `false` or `0`
--                       default here would itself be the hand-authored lie this item
--                       exists to prevent — it would read as "measured, and the answer
--                       is no" when nothing has measured anything. Values land only
--                       when the buildKey-derivation pass (parked plan) runs.
--
-- Keep `status` and `emitter_exists` distinct on purpose. "We retired this key" is a
-- DECISION; "no code emits it" is a MEASUREMENT. EVENT_CATALOG drifted precisely
-- because those two truths shared one hand-set field.

CREATE TABLE IF NOT EXISTS harness_shared.event_key_registry (
  workspace_id          TEXT NOT NULL,
  event_key             TEXT NOT NULL,

  -- ---- CURATED (rung 4) --------------------------------------------------
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  -- The key template as agents type it into events:await, when it differs from
  -- event_key (e.g. 'work-item:done:*' vs a concrete fired key). Curated because
  -- only a human/agent knows which segment is the variable one.
  key_pattern           TEXT,
  -- Provenance of the registration: 'core', 'plugin:<id>', 'blueprint:<id>'.
  contributor           TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  published             BOOLEAN NOT NULL DEFAULT FALSE,
  -- D-057: the `event` Cupboard listing kind publishes REVIEW-GATED `pending`.
  -- The most actuating listing kinds must not be the ones that auto-approve.
  review_status         TEXT NOT NULL DEFAULT 'none',
  tags                  TEXT[] NOT NULL DEFAULT '{}',

  -- ---- DERIVED (rungs 1-3): NULLABLE, NO DEFAULT, NULL = not-yet-derived ----
  -- Where the key is emitted from, as resolved by a code scan. Do NOT hand-write.
  emitter               TEXT,
  -- Whether ANY emit site exists. Three-valued on purpose: TRUE / FALSE / NULL,
  -- where NULL is "never measured" and is NOT the same claim as FALSE.
  emitter_exists        BOOLEAN,
  -- How many emit sites the scan found. NULL, never 0, until a scan has run:
  -- a 0 default is indistinguishable from "measured and found none".
  emit_site_count       INTEGER,
  -- When the derivation last ran, and against what (a commit sha / buildKey).
  -- NULL derived_at is the authoritative "no scan has ever run" signal.
  derived_at            TIMESTAMPTZ,
  derived_from          TEXT,

  title_tsv             TSVECTOR GENERATED ALWAYS AS (
                          to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, ''))
                        ) STORED,
  embedding             VECTOR(768),
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, event_key),
  CONSTRAINT event_key_registry_key_ck
    CHECK (length(btrim(event_key)) > 0),
  CONSTRAINT event_key_registry_status_ck
    CHECK (status IN ('active', 'retired', 'superseded')),
  CONSTRAINT event_key_registry_review_ck
    CHECK (review_status IN ('none', 'pending', 'approved', 'rejected')),
  -- Guards the split above: a row may not claim a derived READING without saying
  -- when it was derived. This makes "somebody hand-set emitter_exists" a write-time
  -- refusal instead of a silent drift nobody can date.
  CONSTRAINT event_key_registry_derived_dated_ck
    CHECK (
      derived_at IS NOT NULL
      OR (emitter IS NULL AND emitter_exists IS NULL AND emit_site_count IS NULL)
    ),
  CONSTRAINT event_key_registry_emit_count_ck
    CHECK (emit_site_count IS NULL OR emit_site_count >= 0)
);

CREATE INDEX IF NOT EXISTS event_key_registry_title_tsv_idx
  ON harness_shared.event_key_registry USING gin (title_tsv);
CREATE INDEX IF NOT EXISTS event_key_registry_tags_idx
  ON harness_shared.event_key_registry USING gin (tags);
CREATE INDEX IF NOT EXISTS event_key_registry_embedding_hnsw_idx
  ON harness_shared.event_key_registry USING hnsw (embedding public.vector_cosine_ops);
CREATE INDEX IF NOT EXISTS event_key_registry_review_pending_idx
  ON harness_shared.event_key_registry (review_status)
  WHERE review_status = 'pending';
-- The audit query this table exists to make cheap: registered keys that NO scan has
-- ever looked at, plus ones a scan proved have no emitter.
CREATE INDEX IF NOT EXISTS event_key_registry_underived_idx
  ON harness_shared.event_key_registry (workspace_id, status)
  WHERE derived_at IS NULL OR emitter_exists IS FALSE;

-- Rung-3 ATTESTATION is deliberately NOT stored as columns here.
--
-- harness_shared.event_key_fires (migration 632) already records real emissions,
-- keyed (workspace_id, event_key) — the same identity as this registry — with
-- first_fired_at / last_fired_at / last_fired_by / fire_count. Copying those into
-- this table would create a second copy of a truth another relation owns, which is
-- the exact failure mode this whole item exists to end. So attestation is a LIVE
-- JOIN, and this view is the read surface for it.
--
-- Read the NULLs carefully, they mean different things:
--   fire_count IS NULL    -> registered, never observed firing (a real measurement:
--                            the ledger has no row, which is evidence, not absence
--                            of evidence).
--   emitter_exists IS NULL-> nobody has ever scanned for an emit site.
CREATE OR REPLACE VIEW harness_shared.event_key_registry_attested AS
  SELECT
    r.workspace_id,
    r.event_key,
    r.title,
    r.description,
    r.key_pattern,
    r.contributor,
    r.status,
    r.published,
    r.review_status,
    r.tags,
    r.emitter,
    r.emitter_exists,
    r.emit_site_count,
    r.derived_at,
    r.derived_from,
    f.first_fired_at,
    f.last_fired_at,
    f.last_fired_by,
    f.fire_count,
    -- The reconciliation this view exists for: a key a scan says has no emitter,
    -- yet the ledger has watched fire. That contradiction is a finding to file,
    -- never something to paper over by trusting either side.
    (r.emitter_exists IS FALSE AND f.fire_count > 0) AS contradicts_scan,
    r.created_by,
    r.created_at,
    r.updated_at
  FROM harness_shared.event_key_registry r
  LEFT JOIN harness_shared.event_key_fires f
    ON f.workspace_id = r.workspace_id
   AND f.event_key = r.event_key;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.event_key_registry TO harness_app;
GRANT SELECT ON harness_shared.event_key_registry_attested TO harness_app;

DO $$ BEGIN
  GRANT SELECT ON harness_shared.event_key_registry TO harness_zero;
  GRANT SELECT ON harness_shared.event_key_registry_attested TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE harness_shared.event_key_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_key_registry_workspace_isolation
  ON harness_shared.event_key_registry;
CREATE POLICY event_key_registry_workspace_isolation
  ON harness_shared.event_key_registry
  FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- Same global-read seam as capability_class_registry: an APPROVED key is
-- discoverable across workspaces, since an event key is a public contract.
DROP POLICY IF EXISTS event_key_registry_approved_global_read
  ON harness_shared.event_key_registry;
CREATE POLICY event_key_registry_approved_global_read
  ON harness_shared.event_key_registry
  FOR SELECT
  USING (review_status = 'approved');
