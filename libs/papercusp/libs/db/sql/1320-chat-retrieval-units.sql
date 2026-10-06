-- 1320-chat-retrieval-units.sql
--
-- P-015 of enterprise-data-sources-2026-10-01 (WI-10005051): chat retrieval units.
--
-- Raw chat messages are stored one row per provider message (chat_messages). The
-- INDEXED unit is not the message but a rollup (chat_retrieval_units): a thread, or
-- for messages outside any thread, a time-gap window inside one UTC day. Each unit is
-- rendered from its LIVE messages into the documents corpus (D-005), so:
--   - an edit updates the raw row and re-renders its unit;
--   - a delete TOMBSTONES the raw row (deleted_at) and the unit is re-rendered without
--     it, so deleted text stops being retrievable on the next rollup;
--   - retention (trigger_sources.retention_policy.maxAgeDays, D-010) purges old rows;
--   - a LEGAL HOLD on a data source (optionally one channel) keeps held content: the
--     triggers below refuse to delete a held message or erase its body, and an edit to
--     a held message keeps the superseded body in held_revisions. Holds are enforced in
--     the database, so no code path (including a cascade from deleting the data source)
--     can destroy held content.
--
-- Data sources are referenced by their current table name, trigger_sources (D-014: no
-- compatibility alias; the rename to data_sources is a later mechanical step).
--
-- All four tables are new; nothing in the deployed release reads or writes them.

-- ---------------------------------------------------------------------------
-- 1. Legal holds
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS harness_shared.data_source_legal_holds (
  workspace_id    text        NOT NULL,
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  data_source_id  uuid        NOT NULL,
  -- NULL holds the whole data source; otherwise one provider container (channel).
  channel_id      text        CHECK (channel_id IS NULL OR btrim(channel_id) <> ''),
  reason          text        NOT NULL CHECK (btrim(reason) <> ''),
  placed_by       text        NOT NULL CHECK (btrim(placed_by) <> ''),
  placed_at       timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  released_by     text,
  CONSTRAINT data_source_legal_holds_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT data_source_legal_holds_release_chk
    CHECK ((released_at IS NULL) = (released_by IS NULL)),
  -- RESTRICT: a data source with any hold row (live or released) cannot be deleted
  -- out from under its hold history.
  CONSTRAINT data_source_legal_holds_source_fk
    FOREIGN KEY (workspace_id, data_source_id)
    REFERENCES harness_shared.trigger_sources (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS data_source_legal_holds_active_idx
  ON harness_shared.data_source_legal_holds (workspace_id, data_source_id, channel_id)
  WHERE released_at IS NULL;

-- STABLE (reads a table): true when an active hold covers this source + channel.
CREATE OR REPLACE FUNCTION harness_shared.chat_message_under_hold(
  p_workspace_id text, p_data_source_id uuid, p_channel_id text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM harness_shared.data_source_legal_holds h
     WHERE h.workspace_id = p_workspace_id
       AND h.data_source_id = p_data_source_id
       AND h.released_at IS NULL
       AND (h.channel_id IS NULL OR h.channel_id = p_channel_id))
$$;

-- ---------------------------------------------------------------------------
-- 2. Raw chat messages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS harness_shared.chat_messages (
  workspace_id         text        NOT NULL,
  id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
  data_source_id       uuid        NOT NULL,
  channel_id           text        NOT NULL CHECK (btrim(channel_id) <> ''),
  provider_message_id  text        NOT NULL CHECK (btrim(provider_message_id) <> ''),
  -- The thread this message belongs to (Slack thread_ts, including the root once it
  -- has replies). NULL = a channel message outside any thread: it is rolled into a
  -- time-gap window instead.
  thread_key           text        CHECK (thread_key IS NULL OR btrim(thread_key) <> ''),
  author_ref           text,
  author_label         text,
  body                 text,
  posted_at            timestamptz NOT NULL,
  edited_at            timestamptz,
  -- Tombstone: set when the provider reports a delete. The body is erased at the same
  -- moment unless a legal hold covers the message, in which case it is kept (but never
  -- rendered into a retrieval unit) until the hold is released and a purge runs.
  deleted_at           timestamptz,
  raw                  jsonb,
  -- Bodies superseded by edits WHILE a legal hold was active (filled by the trigger).
  held_revisions       jsonb       NOT NULL DEFAULT '[]'::jsonb
                                   CHECK (jsonb_typeof(held_revisions) = 'array'),
  ingested_at          timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT chat_messages_provider_key
    UNIQUE (workspace_id, data_source_id, channel_id, provider_message_id),
  -- A live message has a body; only a tombstone may lack one.
  CONSTRAINT chat_messages_body_chk CHECK (deleted_at IS NOT NULL OR body IS NOT NULL),
  CONSTRAINT chat_messages_source_fk
    FOREIGN KEY (workspace_id, data_source_id)
    REFERENCES harness_shared.trigger_sources (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chat_messages_thread_idx
  ON harness_shared.chat_messages (workspace_id, data_source_id, channel_id, thread_key, posted_at)
  WHERE thread_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_messages_channel_time_idx
  ON harness_shared.chat_messages (workspace_id, data_source_id, channel_id, posted_at)
  WHERE thread_key IS NULL;
CREATE INDEX IF NOT EXISTS chat_messages_retention_idx
  ON harness_shared.chat_messages (workspace_id, data_source_id, posted_at);

-- Legal-hold enforcement. Runs for direct statements AND for the cascade from a
-- deleted data source, so a held message survives every delete path.
CREATE OR REPLACE FUNCTION harness_shared.chat_messages_enforce_legal_hold()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT harness_shared.chat_message_under_hold(OLD.workspace_id, OLD.data_source_id, OLD.channel_id) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chat_message_under_legal_hold: message % in channel % cannot be deleted',
      OLD.provider_message_id, OLD.channel_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.body IS NOT NULL AND NEW.body IS NULL THEN
    RAISE EXCEPTION 'chat_message_under_legal_hold: body of message % cannot be erased',
      OLD.provider_message_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.raw IS NOT NULL AND NEW.raw IS NULL THEN
    RAISE EXCEPTION 'chat_message_under_legal_hold: raw payload of message % cannot be erased',
      OLD.provider_message_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_array_length(NEW.held_revisions) < jsonb_array_length(OLD.held_revisions) THEN
    RAISE EXCEPTION 'chat_message_under_legal_hold: held revisions of message % cannot be removed',
      OLD.provider_message_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- An edit under hold keeps the superseded body.
  IF OLD.body IS NOT NULL AND NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.held_revisions := NEW.held_revisions || jsonb_build_array(jsonb_build_object(
      'body', OLD.body,
      'editedAt', OLD.edited_at,
      'supersededAt', now()));
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS chat_messages_enforce_legal_hold ON harness_shared.chat_messages;
CREATE TRIGGER chat_messages_enforce_legal_hold
  BEFORE UPDATE OR DELETE ON harness_shared.chat_messages
  FOR EACH ROW EXECUTE FUNCTION harness_shared.chat_messages_enforce_legal_hold();

-- ---------------------------------------------------------------------------
-- 3. Rollup queue: which buckets must be re-rendered
-- ---------------------------------------------------------------------------
-- bucket_kind = thread -> bucket_key is the thread_key (one unit).
-- bucket_kind = day    -> bucket_key is a UTC date (YYYY-MM-DD); every window of
--                         non-thread messages in that channel-day is recomputed.
-- Windows never cross a UTC day boundary, so a change only ever touches its own day.

CREATE TABLE IF NOT EXISTS harness_shared.chat_rollup_queue (
  workspace_id    text        NOT NULL,
  data_source_id  uuid        NOT NULL,
  channel_id      text        NOT NULL CHECK (btrim(channel_id) <> ''),
  bucket_kind     text        NOT NULL CHECK (bucket_kind IN ('thread', 'day')),
  bucket_key      text        NOT NULL CHECK (btrim(bucket_key) <> ''),
  queued_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_rollup_queue_pkey
    PRIMARY KEY (workspace_id, data_source_id, channel_id, bucket_kind, bucket_key),
  CONSTRAINT chat_rollup_queue_day_key_chk
    CHECK (bucket_kind <> 'day' OR bucket_key ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT chat_rollup_queue_source_fk
    FOREIGN KEY (workspace_id, data_source_id)
    REFERENCES harness_shared.trigger_sources (workspace_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 4. Retrieval units
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS harness_shared.chat_retrieval_units (
  workspace_id     text        NOT NULL,
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  data_source_id   uuid        NOT NULL,
  channel_id       text        NOT NULL CHECK (btrim(channel_id) <> ''),
  unit_kind        text        NOT NULL CHECK (unit_kind IN ('thread', 'window')),
  -- thread: the thread_key. window: the provider_message_id of the window's first message.
  unit_key         text        NOT NULL CHECK (btrim(unit_key) <> ''),
  -- The queue bucket this unit is recomputed from (thread_key, or the UTC day).
  bucket_key       text        NOT NULL CHECK (btrim(bucket_key) <> ''),
  first_posted_at  timestamptz NOT NULL,
  last_posted_at   timestamptz NOT NULL,
  message_count    integer     NOT NULL CHECK (message_count > 0),
  -- sha256 of the rendered text: a re-roll with an unchanged hash writes nothing.
  content_hash     text        NOT NULL,
  -- dedupe_key of the corpus row (personal_documents, scope organization), or NULL when
  -- the source's destination policy does not route chat messages to documents.
  document_dedupe_key text,
  rolled_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_retrieval_units_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT chat_retrieval_units_unit_key
    UNIQUE (workspace_id, data_source_id, channel_id, unit_kind, unit_key),
  CONSTRAINT chat_retrieval_units_span_chk CHECK (first_posted_at <= last_posted_at),
  CONSTRAINT chat_retrieval_units_source_fk
    FOREIGN KEY (workspace_id, data_source_id)
    REFERENCES harness_shared.trigger_sources (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chat_retrieval_units_bucket_idx
  ON harness_shared.chat_retrieval_units (workspace_id, data_source_id, channel_id, unit_kind, bucket_key);

-- ---------------------------------------------------------------------------
-- 5. Workspace isolation (same boundary as the documents corpus tables, 1316)
-- ---------------------------------------------------------------------------

ALTER TABLE harness_shared.data_source_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.chat_rollup_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.chat_retrieval_units ENABLE ROW LEVEL SECURITY;

DO $chat_retrieval_policies$
DECLARE
  tbl text;
  pol text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'data_source_legal_holds',
    'chat_messages',
    'chat_rollup_queue',
    'chat_retrieval_units'
  ]
  LOOP
    pol := tbl || '_workspace_isolation';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'harness_shared'
         AND tablename = tbl
         AND policyname = pol
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON harness_shared.%I FOR ALL TO public '
        || 'USING (workspace_id = current_setting(''app.workspace_id'', true)) '
        || 'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
        pol, tbl
      );
    END IF;
  END LOOP;
END
$chat_retrieval_policies$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.data_source_legal_holds TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.chat_messages TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.chat_rollup_queue TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.chat_retrieval_units TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.chat_messages IS
  'enterprise-data-sources P-015: raw chat messages, one row per provider message. Edits update in place; deletes tombstone (deleted_at). Not the indexed unit: see chat_retrieval_units. Legal holds are enforced by trigger chat_messages_enforce_legal_hold.';
COMMENT ON TABLE harness_shared.chat_retrieval_units IS
  'enterprise-data-sources P-015: the indexed chat unit. A thread, or a time-gap window of non-thread messages within one UTC day, rendered from live messages into the documents corpus.';
COMMENT ON TABLE harness_shared.chat_rollup_queue IS
  'enterprise-data-sources P-015: buckets (thread or channel-day) whose retrieval units must be re-rendered after a message write, tombstone or purge.';
COMMENT ON TABLE harness_shared.data_source_legal_holds IS
  'enterprise-data-sources P-015: legal holds on a data source (channel_id NULL) or one channel. While active, held chat messages cannot be deleted or have their body erased, and edits keep superseded bodies.';
