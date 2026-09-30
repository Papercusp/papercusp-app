-- 772-context-injection-coverage.sql
--
-- Per-(client, port) context-injection coverage counters.
-- Plan: codex-context-injection-parity-2026-08-09, P-005 / D-005 §3b.
--
-- ── WHY THIS EXISTS ──
-- The gap this plan closes was invisible for months because nothing
-- distinguished "injected nothing" from "was never asked". P-005 added
-- memory_recall_stats.client, which answers that for a recall that RAN. It
-- cannot answer it for the case in the middle: the hook fired, reached the
-- endpoint, and the server declined to derive a query. That case writes
-- nothing at all today, so from the outside it is indistinguishable from "the
-- hook never fired" — the exact ambiguity that made codex/omp mid-turn look
-- like a client problem when it was a server one (D-005 §1).
--
-- ── WHY NOT A COLUMN ON memory_recall_stats (this is the load-bearing part) ──
-- The obvious move is a `derive_miss` column on memory_recall_stats and a row
-- per miss. That is WRONG here, and quietly so. Every row in that table today
-- means "a recall was performed", and its readers depend on that:
--   recall-stats.ts:706   (SELECT count(*) FROM scoped WHERE hit_count = 0) AS zero_hits
--   recall-stats.ts:1174  count(*) FILTER (WHERE s.hit_count = 0)  AS zero_hits
-- A derive-miss row necessarily carries hit_count = 0, so inserting misses
-- would inflate `zero_hits` — a HEALTH metric — and make "the hook fired but
-- no query was derived" read as "recall is returning nothing". The detector
-- would corrupt the signal it exists to protect, which is D-005 §3's own
-- false-alarm argument one level up. Every existing reader would have to learn
-- to filter the new rows, and the one that forgot would be silently wrong.
--
-- So the counters live in their own table. memory_recall_stats keeps its
-- invariant ("one row = one recall") intact and unqualified.
--
-- ── SHAPE ──
-- Deliberately an AGGREGATE, not a log. Codex has no batch hook event, so its
-- mid-turn port fires PER TOOL CALL (P-003); claude alone already writes ~49.8k
-- mid-turn rows/7d. A row-per-call trace would be the largest table on the box
-- within days to answer a question that only ever needs counts. Upserting into
-- (day, workspace, client, port, outcome, tool) bounds this to at most a few
-- hundred rows/day regardless of traffic.
--
-- `tool` is part of the key ONLY so an 'unknown-tool' outcome can name the tool
-- that was unmapped — that name is the entire actionable content of a drift
-- alarm ("codex started emitting `foo` and we do not read it"). Outcomes that
-- are not tool-specific store ''.
--
-- Additive DDL only (CREATE TABLE / CREATE INDEX), so no FORWARD-COMPAT
-- acknowledgment is required: the currently-deployed release simply does not
-- reference this table.

CREATE TABLE IF NOT EXISTS harness_shared.context_injection_coverage (
  -- UTC day bucket. Coverage questions are always "is this client being served
  -- TODAY / this week", never "at 14:03:11".
  day           date        NOT NULL,
  workspace_id  text        NOT NULL DEFAULT '',
  -- 'claude' | 'codex' | 'omp'. '' = the caller sent no client, which is a real
  -- and distinct reading (a host without the P-005 threading), not a default.
  client        text        NOT NULL DEFAULT '',
  -- 'turn-start' | 'mid-turn'. Matches memory_recall_stats.surface vocabulary.
  port          text        NOT NULL,
  -- 'recalled'      the injection ran and returned context
  -- 'no-recall'     it ran, found nothing relevant  (healthy quiet)
  -- 'no-signal'     reached the endpoint; a KNOWN tool carried no query signal
  -- 'unknown-tool'  reached the endpoint; the tool is absent from the shared
  --                 vocabulary — i.e. drift, and the only actionable outcome
  outcome       text        NOT NULL,
  -- The unmapped/quiet tool name for tool-specific outcomes; '' otherwise.
  tool          text        NOT NULL DEFAULT '',
  n             bigint      NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, workspace_id, client, port, outcome, tool)
);

-- The alarm's read is "recent rows for every (client, port)", and the retention
-- prune's is "everything older than N days" — both are day-leading.
CREATE INDEX IF NOT EXISTS context_injection_coverage_day_idx
  ON harness_shared.context_injection_coverage (day DESC);

COMMENT ON TABLE harness_shared.context_injection_coverage IS
  'Per-(client,port) context-injection coverage counters (P-005/D-005). Separate from memory_recall_stats ON PURPOSE: every row there means a recall RAN, and its zero_hits health reads would be corrupted by derive-miss rows. See the migration header.';
