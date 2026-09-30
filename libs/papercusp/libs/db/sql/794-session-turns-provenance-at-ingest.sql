-- 794: Provenance stamped AT INGEST for harness_shared.session_turns.
--
-- Plan owner-visibility-provenance-2026-08-11, item P-004 (V-004), decision D-013.
--
-- WHY THIS EXISTS. The owner's chat pane rendered machine-injected turns as the
-- owner's own words (EI-20135573616431912). The turns are filed under
-- speaker='user' by the CLI, so every surface that wanted "is this the owner
-- speaking" re-matched the TEXT at display time, and D-003 proved that
-- display-side matching is unsolvable in general (owner speech and machine
-- speech collide as literal strings -- "Continue from where you left off." is
-- typed by both). The durable answer is to decide ONCE, at ingest, and store it.
--
-- WHY THREE COLUMNS AND NOT ONE (D-013). The classifier
-- (turn-provenance/turn-ref.ts classifyRecordedTurn) reaches its four verdicts
-- by two mechanisms with opposite durability:
--
--   * turn_origin        -- from the injector's own `turn-origin:<origin>`
--                           envelope. AUTHORED by the writing process, durable,
--                           immutable. This is the real provenance; it never
--                           needs recomputation.
--   * turn_origin_verdict -- includes the HEURISTIC verdicts, decided against a
--                           curated pattern catalogue. `owner-typed` is the
--                           RESIDUAL ("no rule matched"), NOT a positive
--                           identification of the owner.
--
-- The catalogue is the most volatile object in this plan -- it was created by
-- this plan's own P-003 and grows as new machine shapes are found. A verdict
-- frozen at ingest is therefore computed against the catalogue as it was that
-- minute; extend it tomorrow and every already-ingested row keeps a stale
-- verdict forever. Because `owner-typed` is the residual, the stale verdict is
-- specifically "owner-typed" -- i.e. a naive one-column freeze would durably
-- stamp machine turns as the owner's own words, re-creating the exact defect
-- this plan exists to kill, one layer down and with database authority behind
-- it. Hence:
--   * turn_origin_classifier_version -- the catalogue/classifier revision that
--                           produced the verdict, so stale rows stay FINDABLE
--                           (WHERE turn_origin_classifier_version < CURRENT)
--                           and a backfill sweep can correct them.
--
-- NULL IS LOAD-BEARING AND IS NOT 'unknown'. NULL = never classified (every row
-- that predates this migration, until backfilled). The string 'unknown' =
-- classified and undeterminable. Collapsing the two re-creates the
-- EI-13472/WI-37419 failure -- a genuine owner directive delivered via
-- AskUserQuestion is not turn-stamped, and reading its miss as "manufactured"
-- tells an agent a REAL owner directive is fake -- at ingest scale. Absence of a
-- signal is never evidence of its opposite.
--
-- SAFETY. Purely additive: three nullable columns and one partial index. No
-- destructive DDL, so nothing the currently-deployed release does can break --
-- it simply does not select these columns yet (expand now, contract never
-- needed). Existing rows read NULL, which every reader must already treat as
-- "not classified" rather than as any verdict.

ALTER TABLE harness_shared.session_turns
  ADD COLUMN IF NOT EXISTS turn_origin text,
  ADD COLUMN IF NOT EXISTS turn_origin_verdict text,
  ADD COLUMN IF NOT EXISTS turn_origin_classifier_version integer;

COMMENT ON COLUMN harness_shared.session_turns.turn_origin IS
  'The turn-origin envelope''s origin verbatim (loop-fire, wake-pump, self-compaction, fleet-kickoff, coord-inject:*, ...), or NULL when the turn carried no envelope. AUTHORED by the injecting process and immutable -- this is the one field here that is real provenance rather than inference, and the only one safe to treat as settled fact.';

COMMENT ON COLUMN harness_shared.session_turns.turn_origin_verdict IS
  'classifyRecordedTurn verdict: agent-injected | machine-surface | synthetic | owner-typed | unknown. NULL means NEVER CLASSIFIED (not yet backfilled) and is deliberately distinct from ''unknown'' (classified, undeterminable). NOTE: owner-typed is the RESIDUAL of a versioned deny-list, i.e. "no rule matched" -- it is NOT positive evidence of owner speech, and must never be read as such (D-013).';

COMMENT ON COLUMN harness_shared.session_turns.turn_origin_classifier_version IS
  'Revision of the classifier/machine-surface catalogue that produced turn_origin_verdict. Bumped when the catalogue changes so stale heuristic verdicts stay findable (WHERE turn_origin_classifier_version < CURRENT) and can be re-derived by a backfill sweep. turn_origin itself never needs this -- it is authored, not inferred.';

-- Backfill/repair lane. The sweep asks ONE question -- "which rows were not
-- classified by the CURRENT catalogue?" -- which covers both populations:
--   * turn_origin_classifier_version IS NULL  -> never classified (pre-794)
--   * turn_origin_classifier_version < N      -> classified by an older catalogue
--
-- Indexed on the version column alone, NOT as a partial index over
-- "IS NULL OR ...". A partial index cannot express "< the current version",
-- because that constant changes every time the catalogue is bumped and an index
-- predicate is fixed at CREATE time -- so a partial index would silently stop
-- serving the reclassification lane the first time a pattern is added, which is
-- the exact moment the sweep matters most. A plain btree indexes NULLs too, so
-- one index serves both halves for the life of the feature.
-- NOT CONCURRENTLY, deliberately: a plain CREATE INDEX holds a lock that blocks
-- WRITES for its duration, which on a hot table under a live fleet is a real
-- hazard worth checking rather than assuming. Measured before writing this:
-- 366,541 estimated rows, and this is a single narrow integer column, so the
-- build is ~a second. That matches the house pattern -- all 8 existing indexes
-- on this table were created non-concurrently in migrations 501/753 -- and
-- CONCURRENTLY cannot run inside the runner's transaction anyway. Revisit if
-- this table grows by an order of magnitude.
CREATE INDEX IF NOT EXISTS session_turns_provenance_version_idx
  ON harness_shared.session_turns (turn_origin_classifier_version);
