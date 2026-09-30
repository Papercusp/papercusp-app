-- 080: dogfood-v5 collaboration columns on harness_features_consolidated.
--
-- Per papercusp-dogfood-v5 Phase 2 P-014 + P-015. Adds the columns the
-- shared-harness collaboration model needs:
--
--   completion_ref           JSONB        — {remote, branch, commit_sha,
--                                            pr_url, pr_number}; populated
--                                            when status flips to
--                                            pending_done or shipped.
--                                            Per v5 §15.1.
--   created_by_github_user_id BIGINT      — author identity (the human
--                                            who filed the feature).
--                                            Per v5 §7.1.
--   working_users             BIGINT[]    — array of github_user_ids
--                                            currently working on the
--                                            feature. Today size-1; the
--                                            schema supports future
--                                            multi-user. Per v5 §0.5.
--                                            (current_worker is DERIVED
--                                            as working_users[0]; not
--                                            stored, per D-016.)
--   worked_by_history         JSONB       — append-only audit of who
--                                            worked on it. Shape:
--                                            [{github_user_id, started_at,
--                                            ended_at, outcome}, ...].
--                                            Per v5 §7.1.
--
-- Issue-equivalent columns on harness_issues_consolidated are EXPLICITLY
-- NOT added in this migration — D-017 defers issue-collab schema until
-- the issue flow is specced. Today issues resolve via linkedFeatureId
-- → fix-feature linkage, which doesn't need these columns.
--
-- All ADDs are `IF NOT EXISTS` (PG 9.6+) so re-run is a no-op. The
-- backfill on existing rows uses each column's natural default:
--   completion_ref          → NULL (no PR yet; populated on next state
--                              transition by the worker run).
--   created_by_github_user_id→ NULL (legacy rows have no GitHub author;
--                              future writes populate; nullable on purpose).
--   working_users           → '{}' (empty array, the safe default).
--   worked_by_history       → '[]'::jsonb (empty array).
--
-- Idempotent. No dollar-quoted blocks here — pure ALTER TABLE statements
-- which postgres-js applies cleanly without the heredoc hazard.

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS completion_ref           JSONB;
ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS created_by_github_user_id BIGINT;
ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS working_users            BIGINT[] NOT NULL DEFAULT '{}';
ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS worked_by_history        JSONB    NOT NULL DEFAULT '[]'::jsonb;

-- Supporting indexes for the read patterns the dogfood UI needs:
--   §9.1 Features tab "available" filter (in_queue + no workers):
CREATE INDEX IF NOT EXISTS hfc_working_users_active_idx
  ON harness_shared.harness_features_consolidated (harness_slug, status)
  WHERE array_length(working_users, 1) IS NOT NULL;

--   §9.1 "mine" / "by author" lookups:
CREATE INDEX IF NOT EXISTS hfc_created_by_idx
  ON harness_shared.harness_features_consolidated (harness_slug, created_by_github_user_id)
  WHERE created_by_github_user_id IS NOT NULL;

--   §15.2 completion verification daemon (sweeps pending_done features):
CREATE INDEX IF NOT EXISTS hfc_pending_done_idx
  ON harness_shared.harness_features_consolidated (status)
  WHERE status = 'pending_done' AND completion_ref IS NOT NULL;
