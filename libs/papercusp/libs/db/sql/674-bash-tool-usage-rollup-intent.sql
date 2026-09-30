-- 674: add `intent_label` to the tool-usage rollup grain
-- (plan `bash-to-tool-substitution-2026-07-26`, P-002).
--
-- WHY THIS SUPERSEDES 672's "map verbs to buckets at READ time".
-- Migration 672 stored only the raw command VERB (`sed`, `psql`) and asserted the
-- intent bucket could be recovered at read time by matching that verb against
-- harness_shared.bash_tool_substitutions — so re-classifying history would be a
-- registry edit rather than a re-ingest. That is a nice property and it does not
-- work, because the two sides are at different grains:
--
--   a registry `bash_pattern` is an ANCHORED regex over a FULL atom
--     ^sed\s+-n\s+['"]?\d+,\d+p['"]?\s+\S
--   and the string `sed` cannot match it. Ever.
--
-- So the read-time mapping degrades to "verbs this pattern could START with",
-- which is an UPPER BOUND, not a count. Measured 2026-07-26 against the real
-- audit corpus (214,400 atoms / 88 sessions — the same population the frozen
-- fixtures' totalAtoms were drawn from), that bound is far too loose to report:
--
--   intent bucket             verb-atoms   pattern-atoms   precision
--   file-head-read                17,290             193        1.1%   <- 90x over-count
--   operator-db-describe           1,060              30        2.8%
--   operator-db-select             1,060              80        7.5%
--   unit-liveness-query              843             114       13.5%
--   file-tail-read                 7,709           2,068       26.8%
--   local-service-health-probe       464             138       29.7%
--   file-range-read                4,933           3,789       76.8%
--   file-whole-read                2,611           2,172       83.2%
--   listening-socket-query           166             149       89.8%
--   git-state-read                 3,706           3,357       90.6%
--   host-job-liveness-query        2,316           2,308       99.7%
--   TOTAL                         42,158          14,398       34.2%
--
-- `head` is the clearest case: the verb is overwhelmingly `... | head -20` used as
-- a PIPE FILTER, which is not a file read and has no `capability:read` form. A
-- report claiming 17,290 substitutable head-reads would be wrong by 90x, and P-029
-- would then "prove" a movement that is really just a shift in pipe-filter habits.
--
-- The bucket is therefore matched where the full command text still exists — at
-- INGEST — and stored. That also makes the metric and the ENFORCEMENT gate share
-- one matcher (`bash-substitution/match.ts`) rather than the metric re-deriving a
-- weaker approximation of it, which was the stated goal in the first place.
--
-- GRAIN: the existing empty-string sentinel convention is extended, not replaced:
--   verb = ''  AND intent_label = ''   -> the per-CALL row       (calls)
--   verb <> '' AND intent_label = ''   -> the per-ATOM verb row  (atoms)
--   verb = ''  AND intent_label <> ''  -> the per-ATOM BUCKET row (atoms)
-- Bucket rows are counted at ATOM grain (every matching atom), NOT at the
-- matcher's advisory grain (which dedupes to one hit per command so an agent is
-- not told the same thing twice). The frozen fixtures' `totalAtoms` — the P-029
-- before-number — were counted per atom, and a before/after pair measured at two
-- different grains would not be a comparison at all.
--
-- Verb rows are KEPT: they still answer "what is the shell actually being used
-- for" (the top-verbs view) and they remain re-classifiable without a re-ingest.
-- Only the bucket claim moves to ingest-time.

ALTER TABLE harness_shared.tool_usage_rollup
  ADD COLUMN IF NOT EXISTS intent_label text NOT NULL DEFAULT '';

-- Widen the PK to the new grain. Without this a bucket row and the per-call row
-- for the same (session, day, tool) collide on the old key and silently ADD their
-- counts together on conflict — turning the headline call count into call+bucket
-- garbage. Dropped/recreated rather than created alongside: two primary keys are
-- not a thing, and the old one is a strict prefix of the new.
ALTER TABLE harness_shared.tool_usage_rollup
  DROP CONSTRAINT IF EXISTS tool_usage_rollup_pkey;

ALTER TABLE harness_shared.tool_usage_rollup
  ADD CONSTRAINT tool_usage_rollup_pkey
  PRIMARY KEY (workspace_id, source_kind, session_id, day, tool_name, verb, intent_label);

-- The report's bucket access path: "every bucket row in this window", grouped by
-- intent. Partial, because bucket rows are a small minority of the table.
CREATE INDEX IF NOT EXISTS tool_usage_rollup_intent_idx
  ON harness_shared.tool_usage_rollup (workspace_id, day DESC, intent_label)
  WHERE intent_label <> '';
