-- Migration 123 — coordination substrate: the universal subscribe→inject tables.
--
-- Plan: coordination-substrate-2026-06-03 (Phase 0 — Schema, additive/safe).
--
-- Five new tables under harness_shared that give the coordination layer the
-- shared capabilities a conversation / issue / feature / plan / topic all ride
-- (D-001 "Subscribable is a capability, not a table"). Each domain object keeps
-- its OWN table + workflow; these provide the shared substrate once:
--
--   coord_topics              — Taggable's vocabulary: tag + one-sentence desc (D-004)
--   coord_entity_subscriptions — Subscribable: follow a topic or an object, with a
--                                delivery mode (full|digest|mention) + TTL (D-005/D-006)
--   coord_threads / _posts     — Threadable: a comment timeline attachable to any object
--   coord_links                — Linkable: polymorphic edges (also backs Taggable: an
--                                object→topic edge IS a tag)
--
-- CLASSIFICATION (table-registry.ts): all `coord_` tables resolve via
-- WORKSPACE_OWNED_PREFIXES → { key:'workspace-owned', sync:'none' }. That is
-- exactly right for v1: subscriptions / topics / threads / links are LOCAL-ONLY,
-- NOT federated (D-009 — the swarm binds per-harness; workspace-global coord
-- content stays per-machine in v1). No table-registry edit is needed; the
-- classifyInventory drift guard already covers the prefix.
--
-- NO RLS, deliberately — matches the existing coord_* family (coord_event_log /
-- coord_subscriptions / coord_presence / coord_watermarks are all RLS-free). The
-- coordination seam connects via the admin (BYPASSRLS) handle and filters by
-- workspace_id in-query, and SU coordination uses workspace_id='*' as a
-- cross-workspace broadcast scope — a workspace-isolation RLS policy would break
-- that '*' semantics. Isolation here is the seam's job, not a row policy.
--
-- NO substrate_outbox capture trigger here (additive/safe, mirrors how mig 122
-- deferred harness_plans' capture to its federation stage). These tables are the
-- fan-out's ROUTING data, not federated content. The Phase-2 migration attaches a
-- local-capture trigger to coord_thread_posts (a post is a change its parent
-- object's subscribers want) once the fan-out projection is registered on the
-- existing drain, so the outbox never accumulates undrained rows.
--
-- Idempotent: CREATE ... IF NOT EXISTS + guarded constraints/indexes/grants. Runs
-- as harness_admin; composes onto 000-baseline.sql for fresh / embedded-pg boots
-- and applies cleanly on the native :5432 dev box.

\set ON_ERROR_STOP on
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- coord_topics — the topic vocabulary (Taggable's namespace). A topic is a
-- one-word(ish) slug + one-sentence description, agent-curated (D-004). Workspace
-- -local in v1. `merged_into` powers the cheap topics:merge/alias dedup (D-004)
-- without a creation-time gate: a merged topic redirects its subscribers to the
-- target.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.coord_topics (
    workspace_id text DEFAULT 'default'::text NOT NULL,
    slug text NOT NULL,                       -- the tag, e.g. 'federation'
    title text,                               -- optional short human title
    description text DEFAULT ''::text NOT NULL,-- one sentence (D-004)
    created_by text,                          -- owner_id of the creating agent
    merged_into text,                         -- alias target slug (topics:merge), NULL = live
    created_at timestamp with time zone DEFAULT now() NOT NULL,

    CONSTRAINT coord_topics_pkey PRIMARY KEY (workspace_id, slug),
    CONSTRAINT coord_topics_slug_nonempty CHECK ((slug <> ''::text)),
    CONSTRAINT coord_topics_workspace_nonempty CHECK ((workspace_id <> ''::text))
);

COMMENT ON TABLE harness_shared.coord_topics IS
  'Topic vocabulary for the coordination substrate (coordination-substrate-2026-06-03, D-004). slug = the tag, description = one sentence. Agent-curated, prefer-existing, no creation-time gate; merged_into aliases a near-duplicate to its target. Workspace-local in v1 (not federated, D-009).';

CREATE INDEX IF NOT EXISTS coord_topics_live_idx
  ON harness_shared.coord_topics USING btree (workspace_id, created_at DESC)
  WHERE (merged_into IS NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- coord_entity_subscriptions — Subscribable. A subscriber follows a target that
-- is EITHER a topic (standing interest in an area, D-005b) OR a specific object
-- (this thread is mine to contribute to, D-005a). Every subscription carries a
-- delivery_mode (full|digest|mention) and an optional TTL (D-006 — mandatory
-- noise control). Soft-cancel via cancelled_at (mirrors coord_subscriptions).
-- LOCAL-ONLY, never federated (D-009). A NEW table — NOT a reshape of the
-- path-glob coord_subscriptions (which the Phase-3 coord:watch retirement drops).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.coord_entity_subscriptions (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    workspace_id text DEFAULT 'default'::text NOT NULL,
    subscriber_id text NOT NULL,              -- owner_id of the following agent
    target_kind text NOT NULL,                -- 'topic' | 'object'
    target_ref text NOT NULL,                 -- topic slug, or '<objectKind>:<objectId>'
    delivery_mode text DEFAULT 'full'::text NOT NULL, -- full | digest | mention
    expires_ts timestamp with time zone,      -- TTL / auto-drop (D-006); NULL = standing
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cancelled_at timestamp with time zone,

    CONSTRAINT coord_entity_subscriptions_kind_check
      CHECK ((target_kind = ANY (ARRAY['topic'::text, 'object'::text]))),
    CONSTRAINT coord_entity_subscriptions_mode_check
      CHECK ((delivery_mode = ANY (ARRAY['full'::text, 'digest'::text, 'mention'::text]))),
    CONSTRAINT coord_entity_subscriptions_ref_nonempty CHECK ((target_ref <> ''::text)),
    CONSTRAINT coord_entity_subscriptions_workspace_nonempty CHECK ((workspace_id <> ''::text))
);

COMMENT ON TABLE harness_shared.coord_entity_subscriptions IS
  'Entity/topic subscriptions for subscribe→inject (coordination-substrate-2026-06-03, D-003/D-005). target_kind topic|object; delivery_mode full|digest|mention + expires_ts TTL (D-006). Local-only, never federated (D-009). The entity-shaped replacement for the retired path-glob coord_subscriptions.';

-- One active subscription per (subscriber, target). Re-subscribing updates mode;
-- the partial unique index lets a re-subscribe after cancel coexist with the old
-- cancelled row.
CREATE UNIQUE INDEX IF NOT EXISTS coord_entity_subscriptions_active_uq
  ON harness_shared.coord_entity_subscriptions
  USING btree (workspace_id, subscriber_id, target_kind, target_ref)
  WHERE (cancelled_at IS NULL);

-- The fan-out's hot path: resolve every active subscriber of a target.
CREATE INDEX IF NOT EXISTS coord_entity_subscriptions_target_idx
  ON harness_shared.coord_entity_subscriptions
  USING btree (workspace_id, target_kind, target_ref)
  WHERE (cancelled_at IS NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- coord_threads / coord_thread_posts — Threadable. A comment timeline attachable
-- to any object (issue/conversation/feature/plan/topic). One thread per object
-- (unique on parent); posts are an append-only timeline. Counters denormalized
-- for cheap list rendering.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.coord_threads (
    workspace_id text DEFAULT 'default'::text NOT NULL,
    thread_id text NOT NULL,                  -- app-generated id (msg-id style)
    parent_kind text NOT NULL,                -- object kind: issue|conversation|feature|plan|topic
    parent_ref text NOT NULL,                 -- object id
    title text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_post_at timestamp with time zone,
    post_count integer DEFAULT 0 NOT NULL,

    CONSTRAINT coord_threads_pkey PRIMARY KEY (workspace_id, thread_id),
    CONSTRAINT coord_threads_parent_nonempty CHECK ((parent_ref <> ''::text) AND (parent_kind <> ''::text)),
    CONSTRAINT coord_threads_workspace_nonempty CHECK ((workspace_id <> ''::text))
);

COMMENT ON TABLE harness_shared.coord_threads IS
  'Threadable: a comment timeline attached to any coordination object (coordination-substrate-2026-06-03). One thread per (parent_kind, parent_ref). Posts live in coord_thread_posts.';

CREATE UNIQUE INDEX IF NOT EXISTS coord_threads_parent_uq
  ON harness_shared.coord_threads USING btree (workspace_id, parent_kind, parent_ref);

CREATE TABLE IF NOT EXISTS harness_shared.coord_thread_posts (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    workspace_id text DEFAULT 'default'::text NOT NULL,
    thread_id text NOT NULL,                  -- → coord_threads.thread_id
    author_id text,                           -- owner_id of the posting agent
    body text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,

    CONSTRAINT coord_thread_posts_workspace_nonempty CHECK ((workspace_id <> ''::text))
);

COMMENT ON TABLE harness_shared.coord_thread_posts IS
  'Append-only posts for a Threadable timeline (coordination-substrate-2026-06-03). The Phase-2 fan-out attaches a local-capture trigger here so a new post notifies the parent object''s subscribers.';

CREATE INDEX IF NOT EXISTS coord_thread_posts_thread_idx
  ON harness_shared.coord_thread_posts USING btree (workspace_id, thread_id, id);

-- ─────────────────────────────────────────────────────────────────────────────
-- coord_links — Linkable. A polymorphic edge between two coordination objects
-- (src → dst) carrying a relationship. Backs Taggable (an object→topic edge with
-- rel='tagged' IS a tag) and engineer-issues' blocking edges (rel='blocks'), etc.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.coord_links (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    workspace_id text DEFAULT 'default'::text NOT NULL,
    src_kind text NOT NULL,
    src_ref text NOT NULL,
    dst_kind text NOT NULL,
    dst_ref text NOT NULL,
    rel text NOT NULL,                         -- 'tagged' | 'blocks' | 'relates' | 'duplicates' | 'fixes' | ...
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,

    CONSTRAINT coord_links_endpoints_nonempty
      CHECK ((src_kind <> ''::text) AND (src_ref <> ''::text) AND (dst_kind <> ''::text) AND (dst_ref <> ''::text)),
    CONSTRAINT coord_links_rel_nonempty CHECK ((rel <> ''::text)),
    CONSTRAINT coord_links_workspace_nonempty CHECK ((workspace_id <> ''::text))
);

COMMENT ON TABLE harness_shared.coord_links IS
  'Linkable: polymorphic edges between coordination objects (coordination-substrate-2026-06-03). Backs Taggable (object→topic edge, rel=tagged) and cross-object relations (blocks/relates/duplicates/fixes/...).';

-- One edge per (src, dst, rel).
CREATE UNIQUE INDEX IF NOT EXISTS coord_links_edge_uq
  ON harness_shared.coord_links USING btree (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel);

-- Forward (out-edges of an object) + reverse (in-edges, e.g. subscribers-of-topic
-- resolution + "what blocks me") lookups.
CREATE INDEX IF NOT EXISTS coord_links_src_idx
  ON harness_shared.coord_links USING btree (workspace_id, src_kind, src_ref);

CREATE INDEX IF NOT EXISTS coord_links_dst_idx
  ON harness_shared.coord_links USING btree (workspace_id, dst_kind, dst_ref);

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants. Migration 109's ALTER DEFAULT PRIVILEGES already covers tables created
-- by harness_admin; grant explicitly too (idempotent). harness_zero is read-only
-- and may be absent on test rigs — tolerate.
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.coord_topics TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.coord_entity_subscriptions TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.coord_threads TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.coord_thread_posts TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.coord_links TO harness_app;

DO $z$ BEGIN
  GRANT SELECT ON harness_shared.coord_topics TO harness_zero;
  GRANT SELECT ON harness_shared.coord_entity_subscriptions TO harness_zero;
  GRANT SELECT ON harness_shared.coord_threads TO harness_zero;
  GRANT SELECT ON harness_shared.coord_thread_posts TO harness_zero;
  GRANT SELECT ON harness_shared.coord_links TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

COMMIT;
