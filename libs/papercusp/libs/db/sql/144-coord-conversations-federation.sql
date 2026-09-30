-- Migration 144 — federate harness-scoped coord_conversations over the peer-log.
--
-- Plan: distributed-coordination-shared-harness-2026-06-04 (Track A — federate
-- coordination CONTENT). Conversations are the FIRST coord-content surface to
-- federate because, unlike messages/topics/threads, coord_conversations ALREADY
-- carries `harness_slug` + `scope` (mig 132) and its writers already populate
-- them for harness-scoped conversations — so federating it is PURELY ADDITIVE:
-- no change to any hot coordination write path the live fleet depends on.
--
-- What federates: a HARNESS-SCOPED conversation (scope='harness', so harness_slug
-- IS NOT NULL by the mig-132 constraint). Operator-scope conversations stay
-- LOCAL (substrate D-007/D-009: the swarm binds per-harness; operator-scope coord
-- content has no swarm to ride). The conversation's reply timeline
-- (coord_thread_posts), tags (coord_links) and subscriptions
-- (coord_entity_subscriptions) are SEPARATE surfaces — thread/post federation is
-- a follow-on; subscriptions stay LOCAL per-machine delivery state (D-002).
--
-- Mechanism (the established feature/issue/plan pattern, mig 102/114/125):
--   1. add `origin` (the echo-loop guard column the shared
--      capture_substrate_outbox() reads) + `author_pubkey` (provenance).
--   2. split capture triggers reusing harness_shared.capture_substrate_outbox('id'):
--      INSERT/DELETE unconditional within the harness-scope filter; UPDATE only
--      when the row actually changed (OLD.* IS DISTINCT FROM NEW.*). The WHEN
--      filter restricts capture to harness-scoped, local-origin rows so (a)
--      operator-scope conversations never enqueue, and (b) a remote-projected
--      row (origin='remote') never re-federates (belt-and-suspenders with the
--      function's own echo-guard).
--
-- Key for the peer-log: the conversation `id` (globally-unique, 'conv-<…>' msg-id
-- style) — the projection (projections/coord-conversation.ts) keys on it. The PK
-- (workspace_id, id) is the upsert conflict target; `accepted_post_id` (a LOCAL
-- bigserial → coord_thread_posts.id) is NOT federated (meaningless cross-machine).
--
-- NO RLS (matches the coord_* family). Idempotent (ADD COLUMN IF NOT EXISTS +
-- CREATE OR REPLACE TRIGGER); composes onto 000-baseline for fresh / embedded-pg
-- boots. Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Federation columns.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE harness_shared.coord_conversations
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'local';

ALTER TABLE harness_shared.coord_conversations
  ADD COLUMN IF NOT EXISTS author_pubkey text;

COMMENT ON COLUMN harness_shared.coord_conversations.origin IS
  'Echo-loop guard (federation): ''local'' for rows written here, ''remote'' for rows applied by the peer-log projection. capture_substrate_outbox() skips non-local rows so a projected op never re-federates.';
COMMENT ON COLUMN harness_shared.coord_conversations.author_pubkey IS
  'Provenance: the device_pubkey of the peer that authored the federated row (NULL for local-origin writes that predate federation).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Capture triggers — enqueue harness-scoped, local-origin rows into
--    substrate_outbox via the shared capture_substrate_outbox('id') function.
-- ─────────────────────────────────────────────────────────────────────────────

-- INSERT and DELETE get separate WHEN-filtered triggers (INSERT references NEW,
-- DELETE references OLD — they cannot share one trigger's WHEN clause). The
-- filter keeps operator-scope + remote-origin rows out of the outbox entirely.
CREATE OR REPLACE TRIGGER capture_coord_conversation_ins_trg
  AFTER INSERT ON harness_shared.coord_conversations
  FOR EACH ROW
  WHEN (NEW.scope = 'harness' AND NEW.harness_slug IS NOT NULL
        AND COALESCE(NEW.origin, 'local') = 'local')
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('id');

CREATE OR REPLACE TRIGGER capture_coord_conversation_del_trg
  AFTER DELETE ON harness_shared.coord_conversations
  FOR EACH ROW
  WHEN (OLD.scope = 'harness' AND OLD.harness_slug IS NOT NULL
        AND COALESCE(OLD.origin, 'local') = 'local')
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('id');

-- UPDATE: only when the row actually changed (terminates the intra-peer
-- re-merge self-amplification loop), and only for harness-scoped local rows.
CREATE OR REPLACE TRIGGER capture_coord_conversation_upd_trg
  AFTER UPDATE ON harness_shared.coord_conversations
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*
        AND NEW.scope = 'harness' AND NEW.harness_slug IS NOT NULL
        AND COALESCE(NEW.origin, 'local') = 'local')
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('id');

COMMIT;
