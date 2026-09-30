-- 736-coord-event-log-hindsight-notify-idx.sql
--
-- EI-19323414462286091 (periodic >10s DB-backed MCP stalls) / EI-19325897270823423
-- (per-agent-turn hooks doing unbounded reads — #1 measured driver, ~35% of live DB
-- time) / EI-19314819320465915 (readInbox's PG fast path ships ~20k full message
-- bodies per call, #2 DB consumer overall).
--
-- operator-hindsight.ts's peekOperatorHindsight/drainOperatorHindsight deliberately
-- could NOT be converted to the bounded `window` mechanism (EI-19323045109346905):
-- their notify_kind='operator_hindsight' filter is SPARSE (0 of 126,425 rows match
-- today), which is the pathological input for a post-filter early-exit rule (it can
-- never fire, so `window` pays the FULL 25-page walk — strictly worse than the single
-- unbounded query it would replace). That left the two hottest callers of readInbox's
-- fast path (measured ~40 calls/min combined, ~35% of live DB time) doing the full
-- unbounded scan every single call: ~20,708 rows / ~10MB transferred and JSON-parsed
-- on the operator event loop, just to answer "is there a pending hindsight notify"
-- for a channel that has never once fired outside tests.
--
-- The actual fix (companion code change, same work item) pushes the notify_kind
-- filter into SQL instead of JS — safe here specifically because, unlike the generic
-- `kinds`/recipient filters EI-19323045109346905 found broadcasts blow through
-- (0.08% reduction), notify_kind='operator_hindsight' is genuinely selective by
-- design (a rare, specific system tag, not a recipient array almost every broadcast
-- satisfies). Retraction correctness is preserved by a small follow-up query scoped
-- to the (typically empty) candidate msg_id set, not by disabling it.
--
-- This partial index makes that pushed-down filter a genuine index scan over the
-- rare notify_kind='operator_hindsight' slice instead of relying on planner inference
-- from the existing coord_event_log_fanout_uq index (workspace_id, msg_id) WHERE
-- notify_kind IS NOT NULL, whose columns don't support the id-ordered LIMIT this
-- query needs and whose predicate is a broader IS-NOT-NULL over all notify_kinds,
-- not just this one — house pattern mirrors migration 576 (allhive-broadcast partial
-- index): a periodic caller with a static, highly-selective predicate gets its own
-- narrow partial index rather than scanning a broader one.
--
-- Built CONCURRENTLY out-of-band first (avoids locking this hot, continuously
-- written table under the live fleet's traffic — 126k+ rows, ~40 calls/min hitting
-- this exact predicate). A plain IF NOT EXISTS here is then a no-op on this box,
-- matching the established precedent (see 543/545/556-coord-event-log-*.sql) — this
-- idempotent form only actually builds on a fresh install, where the table is empty
-- and a blocking build is instant.
--
-- Idempotent (IF NOT EXISTS); no top-level BEGIN/COMMIT (the runner wraps each file
-- in its own transaction, per the lint-migrations enforced-era contract).

CREATE INDEX IF NOT EXISTS coord_event_log_hindsight_notify_idx
  ON harness_shared.coord_event_log (workspace_id, id DESC)
  WHERE surface = 'messages' AND (body ->> 'notify_kind') = 'operator_hindsight';

COMMENT ON INDEX harness_shared.coord_event_log_hindsight_notify_idx IS
  'peekOperatorHindsight/drainOperatorHindsight scoped read (EI-19323414462286091/EI-19325897270823423/EI-19314819320465915): partial index over the rare, static notify_kind=operator_hindsight predicate so the ~40-calls/min hot path is an index scan, not a 20k-row/10MB unbounded transfer (mig 736).';
