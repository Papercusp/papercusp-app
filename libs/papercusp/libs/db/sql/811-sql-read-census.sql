-- 811-sql-read-census.sql
--
-- The SQL-READ CENSUS (plan `sql-escape-tool-routing-2026-08-12`, P-008).
--
-- One row per (night, relation, claiming intent): how many DISTINCT AGENTS wrote
-- a plain single-relation read of that relation in the trailing window, how many
-- calls that was, which tool (if any) already covers it, and the verdict that
-- tool's audited pair carries.
--
-- ── WHY THIS TABLE EXISTS AT ALL ─────────────────────────────────────────────
-- The census could be recomputed from `harness_shared.tool_invocations` on
-- demand, and for two of its three alarms that would be enough. It is NOT enough
-- for the third, which is the one that matters most: "a cluster's traffic FAILED
-- TO FALL after its routing row shipped" — the alarm that tells you a fix did not
-- take.
--
-- `tool_invocations` is pruned to **14 days** (measured 2026-08-12: oldest row
-- 2026-07-29; the retention is stated in adv-sessions.ts and
-- dispatch-adoption-*.ts). A routing row that shipped more than a fortnight ago
-- therefore has NO pre-ship window left in the ledger, and the comparison is not
-- merely expensive to reconstruct — it is GONE. So the census writes every night,
-- crossing or not: the history IS the instrument.
--
-- The pre-existing baseline columns cannot stand in for it either.
-- `bash_tool_substitutions.baseline_calls` / `baseline_sessions` LOOK like a
-- frozen pre-ship baseline, but `seed.ts`'s ON CONFLICT overwrites both with the
-- current fixture's totals on every re-seed (only `observed_since` survives an
-- update). They are a re-measured present wearing a past's name.
--
-- ── WHY NOT `harness_shared.tool_usage_rollup` ───────────────────────────────
-- Three independent mismatches, each disqualifying alone:
--   1. its ON CONFLICT ACCUMULATES (`calls = calls + EXCLUDED.calls`) because its
--      writer is an incremental transcript ingester that never re-reads bytes. A
--      nightly re-read of a trailing 7-day window would inflate it ~7x.
--   2. its `session_id` is a TRANSCRIPT session; this census's unit is a coord
--      AGENT (`coord_owner_id`). Sharing the column would make
--      count(DISTINCT session_id) mean two different things by provenance.
--   3. it lives under the literal corpus workspace 'default' (report.ts calls
--      that out as a live trap), while this evidence is tenant-scoped.
--
-- Everything else IS reused: the corpus reader, the relation extractor, the pair
-- registry and its verdicts, the fires-ledger debounce, the escalation path, and
-- the durable-routine chassis.

CREATE TABLE IF NOT EXISTS harness_shared.sql_read_census (
  id              bigserial PRIMARY KEY,
  workspace_id    text        NOT NULL,

  -- The UTC date the census RAN. Not the date the traffic happened: a row
  -- summarises the trailing `window_days`, so two adjacent nights deliberately
  -- overlap. Comparing night-to-night is comparing two overlapping windows, which
  -- is what makes a trend readable from a noisy per-day count.
  ran_on          date        NOT NULL,
  window_days     integer     NOT NULL,

  -- The relation as the extractor resolved it (bare for a papercusp table,
  -- schema-qualified where the schema is the whole point, e.g.
  -- information_schema.columns). Lower-cased by the writer.
  relation        text        NOT NULL,

  -- The intent label of the pair that CLAIMED these atoms, or NULL when none did.
  -- A relation may carry several pairs narrowed by `sqlShape`, so "the relation is
  -- covered" and "this SHAPE is covered" are different facts; keying on the intent
  -- keeps them apart. `relation_has_pairs` below distinguishes the two NULLs:
  -- NULL + false  = no verb claims this relation at all
  -- NULL + true   = the relation is served, but not in this shape
  intent_label       text     NULL,
  relation_has_pairs boolean  NOT NULL DEFAULT false,

  -- The tool the claiming pair routes to, and the verdict that pair is RECORDED
  -- as carrying. Both NULL when nothing claimed the cluster.
  covering_tool       text    NULL,
  equivalence_verdict text    NULL,

  -- The measures. `distinct_agents` is the ranking unit (D-007): a call count can
  -- be one agent's polling loop, and a cluster's importance is how many
  -- INDEPENDENT agents reached for it.
  distinct_agents integer     NOT NULL,
  calls           integer     NOT NULL,

  -- RELATION-level totals, repeated on every row of the same relation-night.
  -- Deliberate denormalisation, for a reason the alternative cannot satisfy: the
  -- "did traffic fall after the row shipped" check is a RELATION-level question
  -- (before the row shipped there was no intent to group by), and summing
  -- `distinct_agents` across a relation's clusters would DOUBLE-COUNT every agent
  -- that wrote two shapes. Only a count taken across the whole relation before it
  -- is split into clusters is a true distinct count, so it is computed once and
  -- carried.
  relation_distinct_agents integer NOT NULL,
  relation_calls           integer NOT NULL,

  -- One IDENTITY-SCRUBBED exemplar query, so an escalation can show what the
  -- cluster actually looks like without a responder re-querying the ledger. Scrubbed
  -- because these are verbatim agent-written queries and a literal can carry a real
  -- home path — `lint:no-box-identity` has held main red over exactly that class.
  sample_atom     text        NULL,

  computed_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per cluster per night. The intent is COALESCEd because NULL never
-- equals NULL in a unique index, and an unclaimed cluster is exactly the row an
-- idempotent re-run must overwrite rather than duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS sql_read_census_night_cluster_idx
  ON harness_shared.sql_read_census (workspace_id, ran_on, relation, (COALESCE(intent_label, '')));

-- The history read: "this cluster, over time" — the (c) no-fall check walks it
-- backwards from tonight to find the night the covering tool appeared.
CREATE INDEX IF NOT EXISTS sql_read_census_cluster_history_idx
  ON harness_shared.sql_read_census (workspace_id, relation, ran_on DESC);

COMMENT ON TABLE harness_shared.sql_read_census IS
  'P-008 nightly SQL-read census: (night, relation, claiming intent) -> distinct agents, calls, covering tool, verdict. Written EVERY night, not only on an alarm, because tool_invocations is pruned to 14 days and the did-traffic-fall-after-ship check needs a measurement from before the row shipped.';

COMMENT ON COLUMN harness_shared.sql_read_census.ran_on IS
  'UTC date the census RAN. A row summarises the trailing window_days, so adjacent nights overlap by design.';

COMMENT ON COLUMN harness_shared.sql_read_census.relation_has_pairs IS
  'Disambiguates a NULL intent_label: false = no verb claims this relation at all; true = the relation is served but this query SHAPE is not.';

COMMENT ON COLUMN harness_shared.sql_read_census.distinct_agents IS
  'Distinct coord_owner_id (agents), NOT transcript sessions. The D-007 ranking unit: a call count can be one agent polling in a loop.';
