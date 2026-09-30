-- Migration 154 — rationale_index: the topic-keyed "why" projection
-- (plan docs-and-memory-as-projections-2026-06-05, P0 / D-003).
--
-- The PG-backed `ProjectionStore` for the generic `@papercusp/projection-index`
-- lib. It holds the event-maintained inverted index `topic → {decisions, work_items,
-- insights}`: an agent queries a subsystem-topic and gets the relevant rationale
-- WITHOUT a full search and WITHOUT any LLM-per-change re-summary. The index is
-- maintained incrementally by the event engine (a `plans:add-decision` /
-- work_items mutation / `topics:tag` reaction re-projects the source and diffs),
-- so it never drifts.
--
-- One row per persisted contribution, keyed by the projection-index identity
-- triple `(source_id, key, entry_id)`:
--   - source_id : the thing that produced the entry — `plan:<slug>` | `wi:<id>` |
--                 `insight:<slug>`. Re-projecting a source diffs against its rows.
--   - key       : the bucket the entry aggregates under — a topic slug.
--   - entry_id  : stable id of the entry within its source — `D-NNN` | the wi id |
--                 the insight slug.
-- `entry` is the compact projected payload (the agent-facing rendering); `kind`
-- discriminates decision|work_item|insight for query-time filtering; `sort_key`
-- orders entries within a topic (an ISO date, text-sortable).
--
-- Additive + idempotent. Composes onto 000-baseline.sql for fresh/embedded-pg
-- boots; safe additive on the native :5432 box. Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.rationale_index (
    -- The projection-index identity triple. `(source_id, key, entry_id)` is unique
    -- per contribution — re-projecting source_id replaces its same-identity rows
    -- and drops the ones it no longer produces (a removed/retagged entry vanishes).
    source_id   text NOT NULL,
    key         text NOT NULL,
    entry_id    text NOT NULL,
    -- decision | work_item | insight — for query-time `kinds` filtering.
    kind        text,
    -- The compact projected payload (RationaleEntry) — agent-facing, token-lean.
    entry       jsonb NOT NULL,
    -- Ordering signal within a key (ISO date or counter; text-sortable). NULLs sort
    -- last, matching the lib's InMemoryProjectionStore reference semantics.
    sort_key    text,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, key, entry_id)
);

COMMENT ON TABLE harness_shared.rationale_index IS
    'Topic-keyed "why" projection (docs-and-memory-as-projections D-003): the event-maintained inverted index topic→{decisions,work_items,insights}, backing @papercusp/projection-index. One row per (source_id,key,entry_id) contribution.';

-- The hot read path: every entry under a topic, newest first.
CREATE INDEX IF NOT EXISTS rationale_index_key_idx
    ON harness_shared.rationale_index (key, sort_key DESC);

-- Re-projection diff path: all contributions of one source.
CREATE INDEX IF NOT EXISTS rationale_index_source_idx
    ON harness_shared.rationale_index (source_id);

COMMIT;
