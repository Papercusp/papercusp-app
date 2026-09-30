-- Migration 839 — interest_watches: push-interjection interest watches
-- (get-feedback-relevance-consults-2026-08-16 P-008 / WI-39500).
--
-- The PUSH half of the consult system: the relevance router (P-002) pulls
-- experts to a question; an interest watch pushes a peer's IN-FLIGHT work to a
-- standing interest. An agent registers a free-text interest via
-- watch:create { targetKind:'interest' }; the interest is embedded ONCE at
-- registration and stored here. A bounded sweep (interest-watch.ts, mirroring
-- predicate-watch.ts) then matches NEW harness_shared.session_turns rows —
-- peers' in-flight transcript turns, already continuously embedded — against
-- each active interest by cosine similarity, and above the per-row sim_floor
-- fires emitAwaitedEvent on the row's event_key ('interest:<id>'). One emit
-- serves both delivery modes: a paired event_awaits row (wake:true) and/or a
-- coord_entity_subscriptions target_kind='event' inject row (wake:false).
--
-- No embedding happens at match time: the sweep is pure SQL over stored
-- vectors on both sides.
--
-- pgvector leg — the embedding column + HNSW index are added ONLY when the
-- extension is installed (embedded-PG ships it; a bare dev PG may not).
-- Absent, registration fails loudly at INSERT (missing column) — the honest
-- degrade: an interest watch that can never match must refuse to register,
-- never register-and-silently-never-fire (same contract as 837).
--
-- Additive-only (expand): no destructive DDL, no FORWARD-COMPAT line needed.
-- Idempotent: IF NOT EXISTS everywhere; re-runnable. No top-level
-- BEGIN/COMMIT — the migration runner wraps each file in its own transaction.

CREATE TABLE IF NOT EXISTS harness_shared.interest_watches (
  id                 uuid PRIMARY KEY,
  workspace_id       text NOT NULL,
  owner_id           text NOT NULL,
  harness_slug       text,
  -- 'interest:<id>' — the synthetic event key the sweep fires; the await row
  -- (wake) and/or event-key subscription (inject) pair on it.
  event_key          text NOT NULL,
  -- The standing free-text interest, verbatim (the audit trail for what the
  -- stored embedding means — D-008 spirit: persisted, never recomputed).
  interest           text NOT NULL,
  -- Cosine-similarity floor a peer turn must clear to fire (precision-biased
  -- default lives in code: INTEREST_DEFAULT_SIM_FLOOR). Per-row so calibration
  -- has an audit trail.
  sim_floor          double precision NOT NULL,
  interval_sec       integer NOT NULL DEFAULT 120,
  once               boolean NOT NULL DEFAULT false,
  -- Only turns ingested strictly AFTER the watermark are candidates. Starts at
  -- registration time: an interest watches the future, not the archive.
  watermark          timestamptz NOT NULL DEFAULT now(),
  last_swept_at      timestamptz,
  last_match_count   integer,
  fire_count         integer NOT NULL DEFAULT 0,
  last_error         text,
  consecutive_errors integer NOT NULL DEFAULT 0,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS interest_watches_due_idx
  ON harness_shared.interest_watches (last_swept_at ASC NULLS FIRST)
  WHERE active;

DO $vec$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE harness_shared.interest_watches ADD COLUMN IF NOT EXISTS embedding vector(384)';
    -- No HNSW index here: the sweep iterates WATCHES (small table) and probes
    -- session_turns' existing hnsw index per watch — this side is the query
    -- vector, never the searched corpus.
  END IF;
END
$vec$;
