-- 720 — per-fire telemetry for the bash→tool substitution registry.
-- Plan `bash-substitution-reachable-ceiling-2026-08-01`, P-003.
--
-- WHY: the registry can currently answer "which rows exist" and "what verdict
-- did the audit give", but NOT "did this rule ever fire" or "did anyone comply".
-- Every iteration in that plan — the tier promotions of Phase 5, the before/after
-- of Phase 6, the auto-substitution of D-042 — is unmeasurable without it. The
-- existing `false_positive_count` column is not a substitute: it is 0 on every
-- row and is pinned at 0 BY CONSTRUCTION (D-042), because nothing ever
-- increments it. A counter nobody writes reads exactly like a clean bill of
-- health, which is worse than an absent one.
--
-- SHAPE: a hot counter pair on the row (cheap, always current) plus an append-only
-- event table (expensive, complete). Neither can replace the other — the counter
-- cannot tell you WHO fired or whether they complied, and scanning the event
-- table on every hook call to render a count would put an aggregate on the path
-- that runs once per shell command per agent.

-- ── the hot counters, on the row itself ───────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE harness_shared.bash_tool_substitutions
    ADD COLUMN IF NOT EXISTS match_count   bigint      NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_fired_at timestamptz;
EXCEPTION WHEN undefined_table THEN
  -- 665 has not run yet in this database; it creates the table and this
  -- migration will be re-applied in order.
  NULL;
END $$;

COMMENT ON COLUMN harness_shared.bash_tool_substitutions.match_count IS
  'Total times this row has CLAIMED an atom, across all sessions and tiers. Monotonic; never reset. A row at observe tier with match_count 0 after a long window is a dead pattern, which is a finding, not a gap.';
COMMENT ON COLUMN harness_shared.bash_tool_substitutions.last_fired_at IS
  'When this row last claimed an atom. Distinguishes "never fired" from "fired long ago" — a distinction match_count alone cannot make.';

-- ── the append-only fire log ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.bash_tool_substitution_fires (
  id            bigserial   PRIMARY KEY,
  workspace_id  text        NOT NULL,
  row_id        bigint      NOT NULL,
  intent_label  text        NOT NULL,   -- denormalised: survives a row delete/re-seed
  tool_name     text        NOT NULL,   -- ditto; the tool the advisory NAMED at fire time
  session_id    text,                   -- the agent session that ran the command
  command       text        NOT NULL,   -- the matched ATOM, not the whole line
  tier          text        NOT NULL,   -- observe | advise | deny, AS OF THIS FIRE
  -- NULL = not yet resolved. Resolution is necessarily deferred: compliance is
  -- "did this session's NEXT tool call use tool_name", and at fire time that call
  -- has not happened. A later pass fills it in; see resolve-compliance below.
  complied      boolean,
  resolved_at   timestamptz,
  fired_at      timestamptz NOT NULL DEFAULT now()
);

-- The compliance resolver's own query: unresolved fires, oldest first.
--
-- Keyed on resolved_at, NOT on `complied IS NULL`, because those are different
-- questions and collapsing them would fabricate a measurement. Three states must
-- stay distinguishable:
--   resolved_at IS NULL                  -> not yet looked at
--   resolved_at set, complied IS NULL    -> looked at, and the session made NO
--                                           subsequent tool call at all (it ended,
--                                           or died). That is an ABSENCE of
--                                           evidence about compliance.
--   resolved_at set, complied = t/f      -> a real measurement
-- Marking the middle case `false` to get it out of the queue would report a dead
-- session as a defiant agent, and every compliance rate computed afterwards would
-- be quietly wrong in the direction that flatters intervention.
CREATE INDEX IF NOT EXISTS bash_tool_substitution_fires_unresolved_idx
  ON harness_shared.bash_tool_substitution_fires (workspace_id, fired_at)
  WHERE resolved_at IS NULL;

-- The reporting query: per-row compliance over a window.
CREATE INDEX IF NOT EXISTS bash_tool_substitution_fires_row_idx
  ON harness_shared.bash_tool_substitution_fires (workspace_id, row_id, fired_at DESC);

-- The resolver joins a fire to the same session's subsequent tool calls.
CREATE INDEX IF NOT EXISTS bash_tool_substitution_fires_session_idx
  ON harness_shared.bash_tool_substitution_fires (session_id, fired_at)
  WHERE session_id IS NOT NULL;

COMMENT ON TABLE harness_shared.bash_tool_substitution_fires IS
  'One row per (registry row, matched atom) claim. Append-only. `tier` is recorded AS OF THE FIRE rather than read from the registry at analysis time, because a promotion observe->advise->deny is exactly the intervention being measured — reading the current tier would attribute every historical fire to the tier the row ended up at, and make every promotion look effective.';

COMMENT ON COLUMN harness_shared.bash_tool_substitution_fires.complied IS
  'Did the firing session use tool_name in its next tool call? NULL = unresolved (the default at insert; the next call had not happened yet). FALSE is a real measurement, not a missing one — do not treat NULL and FALSE alike.';
