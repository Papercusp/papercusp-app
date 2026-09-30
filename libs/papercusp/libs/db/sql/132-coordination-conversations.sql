-- Migration 132 — coordination conversations: the question/discussion object.
--
-- Plan: coordination-conversations-2026-06-03 (Phase 1 — the first CONSUMER of
-- the coordination substrate, coordination-substrate-2026-06-03 mig 123/126).
--
-- A `conversation` is a Threadable + Taggable + Subscribable + Lifecycle object
-- (substrate capabilities, @papercusp/coordination) with two kinds:
--   question   — wants an answer; resolves when answered (the knowledge-first
--                "an agent has a question but doesn't know who to ask" case).
--   discussion — open-ended.
-- A question is just a conversation that can be answered; the broadcast-Q&A is
-- the special case (conversations plan, "What this is").
--
-- This table holds ONLY the conversation's OWN scalars (kind, asker, the seed
-- question/discussion text, Lifecycle state, the accepted answer). Everything
-- shared rides the substrate, NOT duplicated here:
--   • the reply/answer timeline  → coord_threads / coord_thread_posts (Threadable)
--   • topic tags                 → coord_links rel='tagged' (Taggable)
--   • who's following            → coord_entity_subscriptions (Subscribable)
-- Lifecycle is interface-only in the substrate (capabilities/types.ts) — the
-- domain object stores the scalar, so `state` lives here.
--
-- CLASSIFICATION (table-registry.ts): `coord_` prefix → WORKSPACE_OWNED_PREFIXES
-- → { key:'workspace-owned', sync:'none' }. v1 conversations are WORKSPACE-LOCAL,
-- NOT federated (substrate D-009 — the swarm binds per-harness; operator-scope
-- coord content stays per-machine in v1; harness-scoped conversation federation
-- is a deferred follow-on: re-home/register on the outbox drain then). No
-- table-registry edit needed; the classifyInventory prefix guard already covers
-- `coord_`.
--
-- NO substrate_outbox capture trigger (mirrors mig 123): a local-only object
-- delivers via the SYNCHRONOUS fanoutForObject() seam (fanout-projection.ts) that
-- the conversation tools call directly on open/post/answer/resolve — it resolves
-- topic + direct subscribers and honors delivery_mode without riding the outbox.
--
-- NO RLS (matches the coord_* family — coord_event_log / coord_topics / … are all
-- RLS-free; the coordination seam connects via the admin BYPASSRLS handle and
-- filters by workspace_id in-query, and SU coordination uses workspace_id='*').
--
-- Idempotent: CREATE … IF NOT EXISTS + guarded indexes/grants. Runs as
-- harness_admin; composes onto 000-baseline.sql for fresh / embedded-pg boots.

\set ON_ERROR_STOP on
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- coord_conversations — the question/discussion object (this plan's only table).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.coord_conversations (
    workspace_id     text DEFAULT 'default'::text NOT NULL,
    id               text NOT NULL,                          -- app-generated, msg-id style ('conv-<…>')
    kind             text NOT NULL,                          -- 'question' | 'discussion'
    scope            text DEFAULT 'operator'::text NOT NULL, -- 'operator' | 'harness'
    harness_slug     text,                                   -- set when scope='harness', else NULL
    asker_id         text NOT NULL,                          -- owner_id of the opener
    title            text,                                   -- short headline (list rendering)
    body             text DEFAULT ''::text NOT NULL,         -- the seed question / discussion text
    state            text DEFAULT 'open'::text NOT NULL,     -- Lifecycle: open | resolved | closed | expired
    accepted_answer  text,                                   -- the captured accepted answer (resolve)
    accepted_post_id bigint,                                 -- → coord_thread_posts.id of the accepted answer
    capture_target   text,                                   -- where the answer was written back (mem0|decision|insight)
    promoted_issue_id text,                                  -- engineer_issues 'EI-<n>' when promoted to an issue (D-005)
    created_at       timestamp with time zone DEFAULT now() NOT NULL,
    updated_at       timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at      timestamp with time zone,

    CONSTRAINT coord_conversations_pkey PRIMARY KEY (workspace_id, id),
    CONSTRAINT coord_conversations_kind_check  CHECK ((kind  = ANY (ARRAY['question'::text, 'discussion'::text]))),
    CONSTRAINT coord_conversations_scope_check CHECK ((scope = ANY (ARRAY['operator'::text, 'harness'::text]))),
    CONSTRAINT coord_conversations_state_check CHECK ((state = ANY (ARRAY['open'::text, 'resolved'::text, 'closed'::text, 'expired'::text]))),
    -- A harness-scoped conversation must name its harness; operator-scope must not.
    CONSTRAINT coord_conversations_scope_slug_check CHECK (
        (scope = 'harness'::text  AND harness_slug IS NOT NULL AND harness_slug <> ''::text)
     OR (scope = 'operator'::text AND harness_slug IS NULL)
    ),
    CONSTRAINT coord_conversations_id_nonempty        CHECK ((id <> ''::text)),
    CONSTRAINT coord_conversations_workspace_nonempty CHECK ((workspace_id <> ''::text))
);

COMMENT ON TABLE harness_shared.coord_conversations IS
  'Question/discussion objects on the coordination substrate (coordination-conversations-2026-06-03). kind question|discussion; Lifecycle state open|resolved|closed|expired (interface-only in the substrate — stored here). Thread/tags/subs ride coord_threads/_posts, coord_links, coord_entity_subscriptions. Workspace-local in v1 (not federated — substrate D-009).';

-- List open questions / a scope's conversations cheaply (the hot read paths).
CREATE INDEX IF NOT EXISTS coord_conversations_open_idx
  ON harness_shared.coord_conversations USING btree (workspace_id, kind, created_at DESC)
  WHERE (state = 'open'::text);

CREATE INDEX IF NOT EXISTS coord_conversations_scope_idx
  ON harness_shared.coord_conversations USING btree (workspace_id, scope, harness_slug, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants. Migration 109's ALTER DEFAULT PRIVILEGES already covers harness_admin
-- -created tables; grant explicitly too (idempotent). harness_zero is read-only
-- and may be absent on test rigs — tolerate.
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.coord_conversations TO harness_app;

DO $z$ BEGIN
  GRANT SELECT ON harness_shared.coord_conversations TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

COMMIT;
