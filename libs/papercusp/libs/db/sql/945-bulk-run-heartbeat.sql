-- 945 — P-007: resolver heartbeat on the generalized bulk-run row.
--
-- WHY A TIMESTAMP AND NOT A `stale` FLAG. The plan's Design is explicit that
-- "stale classification is DERIVED from the timestamp". A stored boolean would
-- need a writer to flip it, and the whole failure this addresses is a resolver
-- that stopped writing — so the flag would stay `false` in exactly the case it
-- exists to report. A timestamp degrades correctly: a resolver that dies simply
-- stops advancing it, and every reader can compute staleness against its own
-- clock without anyone having to notice the death first.
--
-- NULL is meaningful and is the correct default for the backfill: it means "this
-- run has never reported liveness", which is true of every row that predates this
-- column and of a freshly created run that has not yet started executing. Readers
-- must therefore distinguish "never beat" (NULL) from "beat, but long ago"
-- (old timestamp) — those warrant different owner-facing language, and collapsing
-- them into one `stale` bit is the same conflation this column avoids.
--
-- Additive and nullable, so the currently-deployed release (which never selects or
-- writes it) keeps working unchanged: no FORWARD-COMPAT acknowledgment is required.

ALTER TABLE harness_shared.attention_bulk_runs
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

COMMENT ON COLUMN harness_shared.attention_bulk_runs.heartbeat_at IS
  'Last liveness report from the resolver process owning this run. NULL = never reported (pre-945 row, or a run that has not begun executing). Written ONLY while the run is in an executing phase (pending/running); staleness is DERIVED by comparing this to now(), never stored, so a resolver that dies stops advancing it rather than having to flip a flag it can no longer reach.';

-- Partial index: staleness sweeps and the owner-facing diagnostics only ever ask
-- about runs that are still executing — a complete/failed run's heartbeat is
-- history, not a liveness question. Keeping the index to the executing phases
-- keeps it small and matches every query shape that reads this column.
CREATE INDEX IF NOT EXISTS attention_bulk_runs_executing_heartbeat_idx
  ON harness_shared.attention_bulk_runs (heartbeat_at)
  WHERE phase IN ('pending', 'running');
