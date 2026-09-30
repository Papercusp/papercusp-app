-- Migration 149 — federate harness-scoped coord_threads + coord_thread_posts.
--
-- Plan: distributed-coordination-shared-harness-2026-06-04 (Track A — federate
-- coordination CONTENT). Completes the conversation REPLY TIMELINE: a
-- harness-scoped conversation's thread + its posts federate, so the back-and-
-- forth discussion (not just the conversation header from mig 144) syncs across
-- machines.
--
-- WHAT FEDERATES: a thread / post whose harness_slug is set. The harness scope
-- is set by the writer (PgThreadStore.getOrCreateThread from the conversation's
-- harness; addPost INHERITS it from its thread via a subquery). Threads on
-- operator-scope conversations or on workspace-local engineer_issues carry no
-- harness_slug → stay local (D-007/D-009).
--
-- KEYS for the peer-log:
--   • coord_threads  → thread_id (app-generated 'thr-<…>', globally unique).
--   • coord_thread_posts → a NEW post_msg_id (newMsgId() at write). The table's
--     PK `id` is a machine-local bigserial — NOT federation-safe — so posts get a
--     global post_msg_id key, exactly like coord_event_log.msg_id. Existing posts
--     (NULL post_msg_id, NULL harness_slug) never federate.
--
-- Mechanism = the established pattern (mig 102/114/144/147): origin (echo guard) +
-- author_pubkey (provenance) + harness_slug (scope) + the global key, fed unique
-- indexes, and split WHEN-filtered capture triggers reusing
-- capture_substrate_outbox('<keycol>'). coord_threads UPDATEs (post_count /
-- last_post_at bumped on each addPost) federate the refreshed header — the remote
-- applies federated posts via the projection (which does not bump post_count), so
-- the count rides the federated header.
--
-- NO RLS (coord_* family). Idempotent; composes onto 000-baseline + mig 123 for
-- fresh / embedded-pg boots. Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Federation columns.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE harness_shared.coord_threads
  ADD COLUMN IF NOT EXISTS harness_slug text;
ALTER TABLE harness_shared.coord_threads
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'local';
ALTER TABLE harness_shared.coord_threads
  ADD COLUMN IF NOT EXISTS author_pubkey text;

ALTER TABLE harness_shared.coord_thread_posts
  ADD COLUMN IF NOT EXISTS harness_slug text;
ALTER TABLE harness_shared.coord_thread_posts
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'local';
ALTER TABLE harness_shared.coord_thread_posts
  ADD COLUMN IF NOT EXISTS author_pubkey text;
-- The global federation key for a post (the bigserial `id` is machine-local).
ALTER TABLE harness_shared.coord_thread_posts
  ADD COLUMN IF NOT EXISTS post_msg_id text;

COMMENT ON COLUMN harness_shared.coord_thread_posts.post_msg_id IS
  'Global federation key (newMsgId() at write) — the machine-local bigserial id is not federation-safe. NULL for pre-federation / operator-scope posts.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Federation upsert keys (partial — only the federated subset).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS coord_threads_fed_uq
  ON harness_shared.coord_threads (workspace_id, thread_id)
  WHERE harness_slug IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS coord_thread_posts_fed_uq
  ON harness_shared.coord_thread_posts (workspace_id, post_msg_id)
  WHERE harness_slug IS NOT NULL AND post_msg_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Capture triggers — coord_threads (key thread_id).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE TRIGGER capture_coord_thread_ins_trg
  AFTER INSERT ON harness_shared.coord_threads
  FOR EACH ROW
  WHEN (NEW.harness_slug IS NOT NULL AND COALESCE(NEW.origin, 'local') = 'local')
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('thread_id');

CREATE OR REPLACE TRIGGER capture_coord_thread_del_trg
  AFTER DELETE ON harness_shared.coord_threads
  FOR EACH ROW
  WHEN (OLD.harness_slug IS NOT NULL AND COALESCE(OLD.origin, 'local') = 'local')
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('thread_id');

CREATE OR REPLACE TRIGGER capture_coord_thread_upd_trg
  AFTER UPDATE ON harness_shared.coord_threads
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*
        AND NEW.harness_slug IS NOT NULL AND COALESCE(NEW.origin, 'local') = 'local')
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('thread_id');

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Capture triggers — coord_thread_posts (key post_msg_id). Posts are append-
--    only; an UPDATE trigger is included for completeness (body edits).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE TRIGGER capture_coord_thread_post_ins_trg
  AFTER INSERT ON harness_shared.coord_thread_posts
  FOR EACH ROW
  WHEN (NEW.harness_slug IS NOT NULL AND NEW.post_msg_id IS NOT NULL
        AND COALESCE(NEW.origin, 'local') = 'local')
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('post_msg_id');

CREATE OR REPLACE TRIGGER capture_coord_thread_post_del_trg
  AFTER DELETE ON harness_shared.coord_thread_posts
  FOR EACH ROW
  WHEN (OLD.harness_slug IS NOT NULL AND OLD.post_msg_id IS NOT NULL
        AND COALESCE(OLD.origin, 'local') = 'local')
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('post_msg_id');

CREATE OR REPLACE TRIGGER capture_coord_thread_post_upd_trg
  AFTER UPDATE ON harness_shared.coord_thread_posts
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*
        AND NEW.harness_slug IS NOT NULL AND NEW.post_msg_id IS NOT NULL
        AND COALESCE(NEW.origin, 'local') = 'local')
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('post_msg_id');

COMMIT;
