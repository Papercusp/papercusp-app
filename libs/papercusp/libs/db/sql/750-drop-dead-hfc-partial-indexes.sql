-- 750-drop-dead-hfc-partial-indexes.sql
--
-- Drop 5 never-scanned partial indexes on harness_shared.work_items.
-- Plan: db-performance-remediation-2026-07-26 (WI-8945).
--
-- WHY (measured 2026-08-03 against the live DB, pg_stat_database.stats_reset IS NULL,
-- so idx_scan=0 spans the database's entire lifetime):
--
--   index                          idx_scan   rows its predicate matches (of 35,723)
--   hfc_verifier_divergence_idx           0    0   (verifier_last_error          100% NULL)
--   hfc_created_by_idx                    0    0   (created_by_github_user_id    100% NULL)
--   hfc_assignee_rank_idx                 0    0   (taken_by AND assignee_rank   100% NULL)
--   hfc_working_users_active_idx          0    0   (working_users               100% empty)
--   hfc_verifier_pending_idx              0    1
--
-- These are not merely unused, they are EMPTY: the underlying columns are vestigial
-- `hfc_*` (harness_features_consolidated) schema predating work-item unification, and
-- are 100% unpopulated. Note the baseline creates them ON harness_features_consolidated;
-- that table was RENAMED to work_items and the indexes came with it, so the physical
-- indexes live on work_items today and `harness_features_consolidated` is now a VIEW
-- over it. Indexes are dropped by NAME, so the rename is immaterial here.
--
-- HONEST SCOPE OF THE WIN (do not let this get restated as more than it is):
-- combined size is 1072 kB of the table's 157 MB of indexes. The benefit is schema
-- hygiene plus 5 fewer of the table's 34 indexes for the planner to consider on the
-- fleet's hottest write table -- NOT bytes, and NOT write amplification. A partial
-- index matching zero rows inserts no entries, so it never paid per-write to begin
-- with; the correct cost model for this class is matched-rows x write-rate.
--
-- hfc_verifier_pending_idx additionally has a real D-029-class misalignment: its
-- intended consumer, selectVerifiableFeatures() in
-- packages/operator-core/lib/harness/completion-ref-verifier.ts, states
-- `completion_ref IS NOT NULL` but omits `verified_done_at_remote_ts IS NULL`, so the
-- planner cannot use it. That is deliberately NOT fixed here: the query matches zero
-- rows database-wide, and adding the missing term would change verifier SEMANTICS
-- (it would stop re-verifying already-verified rows) rather than merely optimise it.
-- Dropping the index is the correct resolution; if the verifier is ever given
-- resume-from-unverified semantics, recreate the index WITH that query change.
--
-- REVERSIBILITY: each index's exact definition is preserved in the comment beside its
-- drop. Recreating any of them is a one-line CREATE INDEX.
--
-- FORWARD-COMPAT: none of these five can be an ON CONFLICT arbiter for the still-running
-- older release, because every one is a plain non-UNIQUE btree (see the exact CREATE INDEX
-- preserved beside each DROP below) and ON CONFLICT requires a UNIQUE index or constraint.
-- The EI-18797473716313783 failure mode is therefore unreachable here by construction, not
-- merely unlikely. Nor can the deployed release depend on any of them for a query PLAN:
-- each matches ZERO rows (the underlying hfc_* columns are 100% NULL/empty) and each has
-- idx_scan = 0 across the database's entire lifetime (pg_stat_database.stats_reset IS NULL),
-- so no plan in any release has ever used one.

-- CREATE INDEX hfc_verifier_divergence_idx ON harness_shared.work_items USING btree (harness_slug, feature_id) WHERE (verifier_last_error IS NOT NULL);
DROP INDEX IF EXISTS harness_shared.hfc_verifier_divergence_idx;

-- CREATE INDEX hfc_created_by_idx ON harness_shared.work_items USING btree (harness_slug, created_by_github_user_id) WHERE (created_by_github_user_id IS NOT NULL);
DROP INDEX IF EXISTS harness_shared.hfc_created_by_idx;

-- CREATE INDEX hfc_assignee_rank_idx ON harness_shared.work_items USING btree (workspace_id, taken_by, assignee_rank) WHERE ((taken_by IS NOT NULL) AND (assignee_rank IS NOT NULL));
DROP INDEX IF EXISTS harness_shared.hfc_assignee_rank_idx;

-- CREATE INDEX hfc_working_users_active_idx ON harness_shared.work_items USING btree (harness_slug, status) WHERE (array_length(working_users, 1) IS NOT NULL);
DROP INDEX IF EXISTS harness_shared.hfc_working_users_active_idx;

-- CREATE INDEX hfc_verifier_pending_idx ON harness_shared.work_items USING btree (harness_slug, verifier_last_checked_at NULLS FIRST) WHERE ((completion_ref IS NOT NULL) AND (verified_done_at_remote_ts IS NULL));
DROP INDEX IF EXISTS harness_shared.hfc_verifier_pending_idx;

-- NOT DROPPED, deliberately: work_items_authority_proposed_idx. It is also never
-- scanned, but its predicate (authority = 'proposed') matches 19 live rows and the
-- authority='proposed' completion-integrity path is CURRENT functionality. Never-scanned
-- + live feature means either a young index awaiting its query or a misaligned consumer;
-- that needs triage, not a drop. Tracked on WI-8945.
