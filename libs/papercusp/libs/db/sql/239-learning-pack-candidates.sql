-- 239-learning-pack-candidates.sql
--
-- Fleet→pack candidate staging (self-improvement-consume-edges-2026-06-12
-- P-032, brief B-11). The recurrence-escalation cross-scope promotion
-- (P-052 lite) today files only a kind=change capture proposing a shared
-- lesson; this table is the staging area for the next edge: a lesson
-- recurring across hives files ONE learning-pack item CANDIDATE here —
-- owner-reviewed, NEVER auto-published. Adoption (decideLearningPackCandidate,
-- lib/learning-packs/candidates.ts) materializes the item into the
-- fleet-lessons pack under the installed root and bumps the pack version, so
-- hives adopt it through the EXISTING install/upgrade conflict review (D-003
-- of learning-packs-2026-06-11) — this table never touches a hive pool.
--
-- Dedup is structural: UNIQUE (workspace_id, signature) — one candidate per
-- friction signature EVER, across all statuses, so a dismissed lesson never
-- re-nags on the next triage tick (the escalation cadence re-plans the same
-- signatures forever). The pending cap lives in the write seam (the same
-- split as cross_hive_asks' state machine, migration 231).
--
-- Idempotent; additive; fresh-migrate-safe.
\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS harness_shared.learning_pack_candidates (
    workspace_id     text NOT NULL,
    id               uuid NOT NULL DEFAULT gen_random_uuid(),
    -- The stable friction-signature this candidate was promoted from
    -- (digest.ts signatureRecurrence) — the dedup identity.
    signature        text NOT NULL,
    title            text NOT NULL,
    -- The draft learning body (owner edits before/at adoption; written
    -- verbatim as the pack item body on adopt).
    draft_text       text NOT NULL,
    kind             text NOT NULL DEFAULT 'feedback',
    applies_to       jsonb NOT NULL DEFAULT '["any"]'::jsonb,
    -- Provenance: the distinct scopes the signature recurred across, how
    -- often, and the improvement-item ids it was observed on.
    scopes           jsonb NOT NULL DEFAULT '[]'::jsonb,
    recurrence_count integer NOT NULL DEFAULT 0,
    source_item_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
    status           text NOT NULL DEFAULT 'pending',
    created_by       text NOT NULL DEFAULT 'recurrence-escalation',
    created_at       timestamptz NOT NULL DEFAULT now(),
    -- Owner decision record (adopt | dismiss).
    decided_at       timestamptz,
    decided_by       text,
    decision_note    text,
    -- Where adoption landed it: the pack + item id written into the pack dir.
    pack_id          text,
    pack_item_id     text,
    CONSTRAINT learning_pack_candidates_pkey PRIMARY KEY (id),
    CONSTRAINT learning_pack_candidates_workspace_nonempty CHECK (workspace_id <> ''),
    CONSTRAINT learning_pack_candidates_kind_check
      CHECK (kind IN ('user', 'feedback', 'project', 'reference')),
    CONSTRAINT learning_pack_candidates_status_check
      CHECK (status IN ('pending', 'adopted', 'dismissed')),
    CONSTRAINT learning_pack_candidates_signature_uniq UNIQUE (workspace_id, signature)
);

-- Listing order: the Learnings view + the candidates verb read
-- most-recent-first per workspace, usually filtered by status.
CREATE INDEX IF NOT EXISTS learning_pack_candidates_listing_idx
  ON harness_shared.learning_pack_candidates USING btree (workspace_id, status, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.learning_pack_candidates TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.learning_pack_candidates TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
